/**
 * scheduler/loader.ts —— 任务目录依赖安装（按任务隔离）。
 *
 * 唯一权威设计文档：《感知层详细设计（dsh-ia 插件）》 v0.7。
 *
 * 职责（§9.1「依赖安装」/ AC-6「依赖隔离」）：任务程序是 agent 生成的一段动态代码，
 * 每个任务有自己的目录（含 package.json），依赖**按任务隔离安装**。loader 对任务内容
 * 一无所知，只负责「确保任务目录的依赖就绪」——在任务目录内执行 `pnpm install`。
 *
 * 用户已拍板的关键决策（不可改）：
 *   1. **无需「是否已安装」判断**：无脑先执行 `pnpm install`（pnpm 内容寻址缓存，
 *      重复 install 代价低、幂等）。
 *   2. **包管理器**：`pnpm install`，在任务目录内执行。
 *   3. **失败/超时语义**：按 `failureKind='install'` 抛错（`[loader] ...` 风格）。
 *
 * 超时语义：`installTimeoutMs`（默认 120s，可注入覆盖）到点先 SIGTERM 再 SIGKILL
 * 强杀子进程，抛超时错误（`failureKind='install'`）。
 *
 * 可注入设计（对齐 types.ts 的 Clock/Timer/Spawner 风格）：
 *   - **spawner 可注入**：不直接 import `child_process`，而是注入 {@link InstallSpawner}。
 *     测试用 mock 验证「命令 / cwd / 超时强杀」行为，不必真跑 pnpm。
 *   - **fs 可注入**：判断任务目录 / package.json 存在等文件操作，注入最小 fs 抽象
 *     {@link LoaderFs}，便于测试。
 *   - **时钟/计时可注入**：超时判定直接依赖 spawner 返回的进程 kill 信号与 Promise
 *     结算（退出 / 错误），无额外 timer 依赖。
 *
 * 纯 TS，不 import dsh/cordis API。
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { TaskRunFailureKind } from './types.js'

// ---------------------------------------------------------------------------
// 失败语义 —— failureKind='install' 的错误类型
// ---------------------------------------------------------------------------

/**
 * 依赖安装失败错误（`failureKind='install'`）。
 *
 * 对齐 types.ts 的 {@link TaskRunFailureKind}（`'install'`）。所有安装阶段的失败
 * （spawn 失败 / 非零退出码 / 超时强杀）都统一收敛为 {@link LoaderError}，
 * 让上层 runner / scheduler 能按 `failureKind` 走降级链路。
 */
export class LoaderError extends Error {
  /** 降级链路的失败分类，恒为 `'install'`。§9.1 */
  readonly failureKind: TaskRunFailureKind = 'install'

  constructor(message: string) {
    super(message)
    this.name = 'LoaderError'
  }
}

// ---------------------------------------------------------------------------
// 可注入类型契约（最小结构）
// ---------------------------------------------------------------------------

/**
 * 被 spawn 的安装子进程句柄（最小结构，对齐 types.ts 的 TaskProcess 风格）。
 *
 * 供 loader 感知进程退出（`exitCode`）与超时强杀（`kill` / `killed` 标记）。
 */
export interface InstallChildProcess {
  /** 进程退出码（`null` 表示尚未退出）。 */
  readonly exitCode: number | null
  /** 是否已被强杀（SIGTERM/SIGKILL）触发的「退出」——用于区分「超时强杀」与「正常退出」。 */
  readonly killed: boolean
  /** 强制终止进程（用于超时强杀），传 `'SIGTERM'` / `'SIGKILL'`。 */
  kill(signal?: NodeJS.Signals): void
}

/**
 * 安装进程的结算结果（由 spawner 在进程结算后 resolve）。
 */
export interface InstallSpawnResult {
  /** 退出码（`0` 表示成功）。 */
  readonly exitCode: number | null
  /** 进程是否被强杀（超时场景）。 */
  readonly killed: boolean
  /** 结算原因（正常退出 / 超时 / spawn 失败），用于错误信息。 */
  readonly reason: 'exit' | 'timeout' | 'spawn-error'
}

/**
 * 安装 spawner（可注入）——在指定 cwd 内执行依赖安装命令。
 *
 * 与 types.ts 的 {@link Spawner}（`spawn(taskPath, args)`，跑任务脚本）不同，
 * 这里需要「命令 + 工作目录 + 超时强杀」三要素，故定义更精确的注入类型。
 *
 * 返回的 `install()` 在 spawn 后开启内部超时计时（`timeoutMs`），到点主动
 * SIGTERM → SIGKILL 强杀并 resolve `{ reason: 'timeout' }`；进程自行退出则
 * resolve `{ reason: 'exit' }`；spawn 本身失败 resolve `{ reason: 'spawn-error' }`。
 */
export interface InstallSpawner {
  /**
   * 在 `cwd` 内启动 `pnpm install` 并结算其结果。
   * @param cwd      任务目录（安装命令的工作目录）。
   * @param timeoutMs 超时上限（毫秒）；到点强杀子进程。
   * @returns 安装结束结果（退出 / 超时 / spawn 失败）。
   */
  install(cwd: string, timeoutMs: number): Promise<InstallSpawnResult>
}

/**
 * 最小 fs 抽象（可注入）——仅覆盖 loader 需要的文件操作，便于测试。
 *
 * 不直接 import `node:fs`，而是注入该抽象，使单测可 mock「目录不存在 / package.json
 * 缺失」等场景而不落盘。
 */
export interface LoaderFs {
  /** 判断任务目录是否存在（用于前置校验）。 */
  dirExists(dirPath: string): boolean
  /** 判断任务目录内 `package.json` 是否存在（用于前置校验）。 */
  packageJsonExists(dirPath: string): boolean
}

/**
 * loader 的依赖注入配置（工厂参数，对齐 types.ts 的可注入风格）。
 */
export interface LoaderOptions {
  /** 安装 spawner；缺省用 {@link createNodeInstallSpawner}（真实 `child_process.spawn('pnpm', ['install'])`）。 */
  readonly spawner?: InstallSpawner
  /** fs 抽象；缺省用 {@link createNodeLoaderFs}（真实 `node:fs`）。 */
  readonly fs?: LoaderFs
  /** 安装超时上限（毫秒），默认 120s。 */
  readonly installTimeoutMs?: number
}

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/** 默认安装超时（120 秒）。§9.3 */
export const DEFAULT_INSTALL_TIMEOUT_MS = 120_000

/** 安装命令（pnpm）。用户拍板。 */
const INSTALL_COMMAND = 'pnpm'
/** 安装命令参数。 */
const INSTALL_ARGS = ['install'] as const

// ---------------------------------------------------------------------------
// 真实实现（node:child_process / node:fs），仅在工厂缺省路径下被加载
// ---------------------------------------------------------------------------

/**
 * 真实安装 spawner：基于 `node:child_process.spawn('pnpm', ['install'], { cwd })`。
 *
 * 内部实现超时强杀：到点先 `kill('SIGTERM')`，宽限后再 `kill('SIGKILL')`，确保
 * 卡死的 pnpm 一定被清理（§9.3）。settle 为 Promise：进程退出 / 超时 / spawn 失败
 * 三类结局都收敛为 {@link InstallSpawnResult}。
 */
function createNodeInstallSpawner(): InstallSpawner {
  return {
    install(cwd: string, timeoutMs: number): Promise<InstallSpawnResult> {
      return realInstall(cwd, timeoutMs)
    },
  }
}

/**
 * 真实 `pnpm install` 执行（供 `createNodeInstallSpawner.install` 调用）。
 *
 * 用单个 `settled` 守卫 + 单个超时 timer 收敛为一条清晰流程：
 *   1. spawn 抛错 → 立即结算 `{ reason: 'spawn-error' }`。
 *   2. 到点（`timeoutMs`）→ 置 `timedOut`，先 `SIGTERM`，宽限约 1s 再 `SIGKILL`。
 *      `timedOut` 一旦置 true，「进程后续任何退出（无论 SIGTERM/SIGKILL）」都归因
 *      为超时，结算 `{ reason: 'timeout', killed: true }`。
 *   3. 进程在超时前自行 exit → 清 timer 并结算 `{ reason: 'exit', exitCode }`。
 * 三类结局互斥，`settled` 守卫 + `timedOut` 标志确保「超时一旦触发，结局恒为 timeout」。
 */
function realInstall(cwd: string, timeoutMs: number): Promise<InstallSpawnResult> {
  return new Promise<InstallSpawnResult>((resolve) => {
    let settled = false
    const finish = (result: InstallSpawnResult): void => {
      if (settled) return
      settled = true
      resolve(result)
    }

    let child: ReturnType<typeof spawn>
    try {
      child = spawn(INSTALL_COMMAND, INSTALL_ARGS, {
        cwd,
        stdio: 'ignore', // 安装输出不进主进程 stdout（loader 不消费任务内容）
      })
    } catch {
      finish({ exitCode: null, killed: false, reason: 'spawn-error' })
      return
    }

    // 一旦超时 timer 先行触发，「进程后续任何退出」都归因于超时（而非自行退出）。
    let timedOut = false

    // 单一超时 timer：到点先置 timedOut 标志，再 SIGTERM，宽限约 1s 后 SIGKILL。
    const timeoutTimer = setTimeout(() => {
      timedOut = true
      try {
        child.kill('SIGTERM')
      } catch {
        /* 忽略 kill 抛错，宽限后 SIGKILL 兜底 */
      }
      setTimeout(() => {
        try {
          child.kill('SIGKILL')
        } catch {
          /* 忽略 */
        }
        finish({ exitCode: null, killed: true, reason: 'timeout' })
      }, 1000)
    }, timeoutMs)

    child.on('error', () => {
      clearTimeout(timeoutTimer)
      finish({ exitCode: null, killed: false, reason: 'spawn-error' })
    })

    child.on('exit', (code) => {
      if (timedOut) {
        // 超时已触发，进程的退出归因于超时（无论 SIGTERM/SIGKILL）。
        finish({ exitCode: null, killed: true, reason: 'timeout' })
        return
      }
      // 进程在超时前自行退出。
      clearTimeout(timeoutTimer)
      finish({ exitCode: code, killed: false, reason: 'exit' })
    })
  })
}

/**
 * 真实 fs 抽象：基于 `node:fs` 的 `existsSync`。
 */
function createNodeLoaderFs(): LoaderFs {
  return {
    dirExists(dirPath: string): boolean {
      return existsSync(dirPath)
    },
    packageJsonExists(dirPath: string): boolean {
      return existsSync(join(dirPath, 'package.json'))
    },
  }
}

// ---------------------------------------------------------------------------
// Loader 主体
// ---------------------------------------------------------------------------

/**
 * 任务依赖加载器（按任务隔离）。
 *
 * 通过 {@link createTaskLoader} 创建（依赖可注入），亦可用 `new TaskLoader(options)`。
 * 职责单一：对单个任务目录执行 `pnpm install`，成功 = 依赖就绪，失败/超时抛
 * `failureKind='install'` 的 {@link LoaderError}。
 */
export class TaskLoader {
  /** 安装 spawner（注入）。 */
  private readonly spawner: InstallSpawner
  /** fs 抽象（注入）。 */
  private readonly fs: LoaderFs
  /** 安装超时（毫秒）。 */
  private readonly installTimeoutMs: number

  constructor(options: LoaderOptions = {}) {
    this.spawner = options.spawner ?? createNodeInstallSpawner()
    this.fs = options.fs ?? createNodeLoaderFs()
    this.installTimeoutMs = options.installTimeoutMs ?? DEFAULT_INSTALL_TIMEOUT_MS
  }

  /**
   * 确保单个任务目录的依赖就绪：在任务目录内执行 `pnpm install`。
   *
   * 无脑执行（不做 node_modules 是否已安装的判断，pnpm 幂等）。
   *
   * @param taskId  任务 id（用于错误信息）。
   * @param taskDir 任务目录绝对路径（含 package.json，作为 `pnpm install` 的 cwd）。
   * @returns 安装成功（exit code 0）时 resolve（void）。
   * @throws 目录/package.json 缺失、spawn 失败、非零退出码、超时强杀时抛
   *         {@link LoaderError}（`failureKind='install'`）。
   */
  async installTaskDeps(taskId: string, taskDir: string): Promise<void> {
    // 前置校验：任务目录及其 package.json 必须存在（否则无法安装，归为 install 失败）。
    if (!this.fs.dirExists(taskDir)) {
      throw new LoaderError(`[loader] ${taskId} 依赖安装失败: 任务目录不存在 ${taskDir}`)
    }
    if (!this.fs.packageJsonExists(taskDir)) {
      throw new LoaderError(
        `[loader] ${taskId} 依赖安装失败: 任务目录缺少 package.json ${taskDir}`,
      )
    }

    const result = await this.spawner.install(taskDir, this.installTimeoutMs)

    switch (result.reason) {
      case 'exit':
        if (result.exitCode === 0) return // 成功：依赖就绪
        throw new LoaderError(
          `[loader] ${taskId} 依赖安装失败: pnpm install 退出码 ${result.exitCode}`,
        )
      case 'timeout':
        throw new LoaderError(
          `[loader] ${taskId} 依赖安装失败: 超过 ${this.installTimeoutMs}ms 未完成（已强杀）`,
        )
      case 'spawn-error':
        throw new LoaderError(
          `[loader] ${taskId} 依赖安装失败: 无法启动 pnpm install`,
        )
      default: {
        // 穷尽性守卫：未来新增 reason 不应静默吞掉。
        const _exhaustive: never = result.reason
        throw new LoaderError(`[loader] ${taskId} 依赖安装失败: 未知结局 ${_exhaustive}`)
      }
    }
  }
}

/**
 * loader 的别名入口（语义更直观的对外命名）。等价于 {@link TaskLoader#installTaskDeps}。
 * 供上级 scheduler 直接调用，保持与任务卡命名一致。
 */
export function ensureTaskDeps(
  options: LoaderOptions,
  taskId: string,
  taskDir: string,
): Promise<void> {
  return new TaskLoader(options).installTaskDeps(taskId, taskDir)
}

/**
 * 创建任务依赖 loader 的工厂函数（无副作用工厂，对齐 types.ts 可注入风格）。
 *
 * @param options 依赖注入配置（spawner / fs / timeout）。缺省用真实 node 实现。
 * @returns 就绪的 {@link TaskLoader} 实例。
 */
export function createTaskLoader(options: LoaderOptions = {}): TaskLoader {
  return new TaskLoader(options)
}

export type { TaskRunFailureKind }