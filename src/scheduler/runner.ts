/**
 * scheduler/runner.ts —— 任务程序执行器（起独立 Node 进程 + stdout 解析 + 三结局映射）。
 *
 * 唯一权威设计文档：《感知层详细设计（dsh-ia 插件）》 v0.7。
 *
 * 职责（§5「执行模型」/ AC-5「独立 Node 进程、无 bindings 白名单」/ AC-7「返回值契约」）：
 * 任务程序对定时层是**黑盒**——runner 对任务内容一无所知，只负责「起独立进程 →
 * 捕获 stdout 最后一行 JSON → 解析为结果 → 映射三结局」。任务程序是 agent 生成的一段
 * 动态 TS/JS，跑在独立 Node 进程，可自由 import（不注入任何 bindings 白名单）。
 *
 * 用户已拍板的关键决策（不可改）：
 *   1. **stdout 解析**：按换行切分，取**最后一个非空行** `JSON.parse`（任务可能输出多
 *      行日志，中间日志行忽略，只认最后非空行作为结果 JSON，尾随空行跳过）。
 *   2. **三结局结构**：返回 types.ts 的 {@link TaskRunOutcome} 联合（非自定义结构）。
 *   3. **执行方式**：runner 只管执行 + 解析，不做依赖安装（loader 职责，由上层 scheduler
 *      编排 loader→runner 顺序）。
 *
 * 超时语义：`taskTimeoutMs`（默认 60s，可注入覆盖）到点 `kill('SIGTERM')` 强杀，
 * 归因 `failed`（`failureKind='exec'`）。时序上吸取 loader 教训：单一 `settled` 守卫
 * + `timedOut` 标志，确保「超时 timer 一旦触发，进程后续任何退出都归因超时」，不落回
 * 「正常退出」。
 *
 * stdout 上限语义（防 OOM）：`maxStdoutBytes`（默认 {@link DEFAULT_MAX_STDOUT_BYTES} =
 * 1 MiB，可注入覆盖）。任务程序是 agent 生成的动态代码（不可信输入），stdout 后端为
 * pipe（无背压刹车）。若失控输出，runner 累积缓冲会无上限增长 → 宿主主进程 OOM。
 * 故累积到上限即**封顶缓冲**（{@link accumulateStdout} 保证 `stdoutBuf` 不越界）+
 * `kill('SIGTERM')` 强杀 + 归 `failed`（`failureKind='exec'`，与超时强杀对称）。同样以
 * `overflowed` 标志 + 单一 `settled` 守卫保证「超限结算后，进程后续退出/流 close 不改结局」。
 *
 * 退出感知：types.ts 的 {@link TaskProcess} 契约暴露 stdout/stderr（`NodeJS.ReadableStream`）、
 * exitCode（getter）、kill 与 onClose（可靠退出信号订阅，可选）。runner 以 {@link TaskProcess.onClose}
 * 作为「进程结束（exit + 全部 stdio 已关闭）→ 可读 exitCode」的可靠信号：对应 child_process
 * 的 `close` 事件，晚于 `exit`，此时 exitCode 已确定。**不要**用 stdout 流的 `close` 事件驱动
 * 结局判定——真实 Node 下 stdout `close` 与进程 `exit` 是竞争的，不保证 close 晚于 exit，
 * 读到 exitCode 可能仍是 `null`。mocks 未实现 onClose 时，runner 回退 stdout close（测试可驱动）。
 * 真实 `createNodeSpawner` 必须走 onClose（`child.on('close', ...)`）。
 *
 * 可注入设计（对齐 types.ts 的 Spawner/TaskProcess）：
 *   - **spawner 可注入**：复用 types.ts 的 {@link Spawner}，默认用真实 `node` spawn；
 *     测试注入 mock 验证「stdout 解析 / 三结局映射 / 超时强杀」，不必真跑 node。
 *   - **计时预算可注入**：超时判定依赖 {@link TimeBudget} 抽象（`setTimeout`/`clearTimeout`），
 *     测试用 vitest fake timers 驱动真实超时时序。
 *
 * 纯 TS，不 import dsh/cordis API。
 */

import { spawn as nodeSpawn } from 'node:child_process'

import type {
  Spawner,
  TaskProcess,
  TaskRunOutcome,
  TaskScriptResult,
} from './types.js'
import {
  createTaskLog,
  type TaskLogCollector,
  type TaskLogOptions,
} from '../log/task-log.js'

// ---------------------------------------------------------------------------
// 可注入类型契约（最小结构，对齐 types.ts 可注入风格）
// ---------------------------------------------------------------------------

/**
 * 计时预算（可注入）——runner 的超时 timer 抽象。
 *
 * 对齐 types.ts 的 {@link Timer} 风格：runner 用一次性 `setTimeout` 到点触发超时强杀，
 * `clearTimeout` 在进程正常退出时清空已排定 timer（无泄漏）。注入该抽象使单测可用
 * vitest fake timers 驱动真实超时时序。
 */
export interface TimeBudget {
  /** 安排一次性定时，`delayMs` 毫秒后回调 `cb`，返回可被取消的句柄。 */
  setTimeout(cb: () => void, delayMs: number): ReturnType<typeof setTimeout>
  /** 取消一个已排定的定时句柄。 */
  clearTimeout(handle: ReturnType<typeof setTimeout>): void
}

/**
 * runner 的依赖注入配置（工厂参数，对齐 types.ts 可注入风格）。
 */
export interface RunnerOptions {
  /** 进程生成器；缺省用 {@link createNodeSpawner}（真实 `child_process.spawn('node')`）。 */
  readonly spawner?: Spawner
  /** 计时预算；缺省用 {@link createNodeTimeBudget}（真实 `setTimeout`/`clearTimeout`）。 */
  readonly timeBudget?: TimeBudget
  /**
   * 任务进程日志采集选项（M3）；仅在 {@link TaskRunner.run} 携带 taskId 时生效。
   * 缺省走真实实现（`~/.dsh-ia/logs/tasks/<taskId>/`）。
   */
  readonly taskLog?: TaskLogOptions
  /** 任务执行超时上限（毫秒），默认 60s。§9.3 */
  readonly taskTimeoutMs?: number
  /**
   * stdout 累积上限（近似按 UTF-16 码元/字节计），默认 {@link DEFAULT_MAX_STDOUT_BYTES}
   * （1 MiB = 1_048_576）。可注入以便单测用小上限驱动超限分支。
   *
   * 任务程序是 agent 生成的动态代码（不可信输入），stdout 后端为 pipe（`on('data')`
   * 持续 flowing，无背压刹车）。失控输出（如死循环 console.log）在超时窗口内可增长
   * 到数百 MB/GB → 宿主主进程 OOM。超限即封顶缓冲 + SIGTERM 强杀 + 归 failed/exec。
   */
  readonly maxStdoutBytes?: number
}

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/**
 * 默认任务执行超时（60 秒）。§9.3
 */
export const DEFAULT_TASK_TIMEOUT_MS = 60_000

/**
 * 默认 stdout 累积上限（1 MiB = 1_048_576）。
 *
 * 任务程序是 agent 生成的动态代码（不可信输入），stdout 后端为 pipe（`on('data')`
 * 持续 flowing，无背压刹车）。若任务失控输出（如死循环 console.log），在 60s 超时
 * 窗口内可增长到数百 MB/GB → 宿主主进程 OOM。此处设硬上限：累积到上限即封顶缓冲、
 * SIGTERM 强杀并归 failed（`failureKind='exec'`），立即止损（对齐超时强杀语义）。
 */
export const DEFAULT_MAX_STDOUT_BYTES = 1_048_576

/** {@link TaskRunner.run} 的调用级选项（M3）。 */
export interface TaskRunOptions {
  /**
   * 任务 id（对应 `TaskDef.id`）。
   *
   * 携带时启用「任务进程日志独立采集」（M3）：stdout 非末行内容 + 全部 stderr 落盘到
   * `<logDir>/tasks/<taskId>/<ts>-<pid>.log`。**缺失时不产生任何副作用**（既有
   * `run(taskPath)` / `run(taskPath, args)` 调用零影响）。
   */
  readonly taskId?: string
}

/** 执行任务程序的 node 可执行名（真实 `child_process.spawn` 的 command）。§4.3 */
const NODE_BIN = 'node'

// ---------------------------------------------------------------------------
// 真实实现（node:child_process / 全局 setTimeout），仅在工厂缺省路径下被加载
// ---------------------------------------------------------------------------

/**
 * 真实 spawner：基于 `node:child_process.spawn('node', [taskPath, ...args])`。
 *
 * **独立 Node 进程 + 无 bindings 白名单**（AC-5）：spawn 真实 `node` 执行任务入口，
 * 不注入任何 `--import`/bindings 限制，任务程序可自由 import。stdout/stderr 均为
 * `pipe` 供 runner 捕获；任务内容对 runner 是黑盒。
 */
function createNodeSpawner(): Spawner {
  return {
    spawn(taskPath: string, args?: readonly string[]): TaskProcess {
      const child = nodeSpawn(NODE_BIN, [taskPath, ...(args ?? [])], {
        stdio: ['ignore', 'pipe', 'pipe'],
      })

      return {
        stdout: child.stdout,
        stderr: child.stderr,
        pid: child.pid,
        get exitCode() {
          return child.exitCode
        },
        kill(signal?: NodeJS.Signals) {
          child.kill(signal)
        },
        // 可靠退出信号：child_process 的 'close' 事件晚于 'exit'（进程退出且全部
        // stdio 关闭后触发），此时 child.exitCode 已确定。相对 stdout 流的 'close'
        // 事件（与 'exit' 竞争），这是 runner 判定退出码的可靠信号。
        onClose(cb: () => void) {
          child.on('close', cb)
        },
      }
    },
  }
}

/**
 * 真实计时预算：基于全局 `setTimeout` / `clearTimeout`。
 */
function createNodeTimeBudget(): TimeBudget {
  return {
    setTimeout(cb, delayMs) {
      return setTimeout(cb, delayMs)
    },
    clearTimeout(handle) {
      clearTimeout(handle)
    },
  }
}

// ---------------------------------------------------------------------------
// 内部：stdout 解析（最后非空行 + 严格契约校验）
// ---------------------------------------------------------------------------

/**
 * 从累积的 stdout 文本中取「最后一个非空行」并解析为 {@link TaskScriptResult}。
 *
 * 规则（用户拍板决策 1 / §5.3 / §9）：
 *   - 按 `\n` 切分；`trim()` 后为空的行（纯空白、尾随空行）跳过。
 *   - 只在**最后一个 trim 非空的行**上 `JSON.parse`。
 *   - 无任何非空行 / JSON 解析失败 / 结果非对象 / `shouldWake` 非 boolean →
 *     返回 `null`（调用方映射为 `failed`，`failureKind='parse'` 违约语义）。
 *   - `shouldWake===true` 但 `data` 非 string → 返回 `null`（契约违约）。
 *   - `shouldWake===true` 且 `data` 是 string → 返回 `{ shouldWake:true, data }`。
 *   - `shouldWake===false`（不管多余字段）→ 返回 `{ shouldWake:false }`。
 */
export function parseLastJsonLine(stdout: string): TaskScriptResult | null {
  const lines = stdout.split('\n')
  // 从末尾向前找第一个 trim 后非空的行（跳过尾随空行与纯空白行）。
  let lastLine: string | null = null
  for (let i = lines.length - 1; i >= 0; i--) {
    const trimmed = lines[i].trim()
    if (trimmed.length > 0) {
      lastLine = trimmed
      break
    }
  }
  if (lastLine === null) return null

  let parsed: unknown
  try {
    parsed = JSON.parse(lastLine)
  } catch {
    return null
  }

  // §9：解析结果必须为普通对象，且 `shouldWake` 必须为 boolean。
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
  const record = parsed as Record<string, unknown>
  if (typeof record['shouldWake'] !== 'boolean') return null

  if (record['shouldWake'] === true) {
    // 唤醒分支：data 必须为 string，否则契约违约。
    if (typeof record['data'] !== 'string') return null
    return { shouldWake: true, data: record['data'] }
  }

  // 静默分支：shouldWake === false。
  return { shouldWake: false }
}

// ---------------------------------------------------------------------------
// 内部：stdout 封顶累积（防 OOM）
// ---------------------------------------------------------------------------

/** {@link accumulateStdout} 的结果：封顶后的缓冲 + 是否已越限。 */
export interface StdoutAccumulation {
  /** 累积后的 stdout 文本（长度不会超过 `maxBytes`）。 */
  readonly buffer: string
  /** 本次追加是否导致越限（越限后调用方应立即止损：强杀 + 结算 failed）。 */
  readonly overflowed: boolean
}

/**
 * 将 `chunk` 追加到 `prev`，并**保证返回值长度不超过 `maxBytes`**（防 OOM 竞态）。
 *
 * 任务程序 stdout 可能无上限疯长；若先无界拼接再判断，则单次超大 chunk（或高频小
 * chunk 累积）仍会在判断前撑爆内存。故这里在**拼接前**先判断：越限时只保留「到上限
 * 为止的前缀」，绝不把超限部分写入缓冲。
 *
 * 计量方式：近似按 UTF-16 码元（`String.length`）计——防 OOM 为主，无需精确 UTF-8
 * 字节（多字节字符可能使真实字节数略高于上限，但已有硬上限兜底，量级安全）。
 *
 * @param prev     已累积的文本。
 * @param chunk    本次新增文本（已由调用方按 UTF-8 解码）。
 * @param maxBytes 上限（近似按码元计）。
 * @returns 封顶后的缓冲 + 是否越限。
 */
export function accumulateStdout(
  prev: string,
  chunk: string,
  maxBytes: number,
): StdoutAccumulation {
  // 已达上限：不再累积（返回越限，让调用方立即止损）。
  if (prev.length >= maxBytes) {
    return { buffer: prev, overflowed: true }
  }
  // 加上本 chunk 会越限：只收下到上限为止的前缀，绝不越过上限。
  if (prev.length + chunk.length > maxBytes) {
    const room = maxBytes - prev.length
    return { buffer: prev + chunk.slice(0, room), overflowed: true }
  }
  return { buffer: prev + chunk, overflowed: false }
}

// ---------------------------------------------------------------------------
// Runner 主体
// ---------------------------------------------------------------------------

/**
 * 任务程序执行器。
 *
 * 通过 {@link createTaskRunner} 创建（依赖可注入），亦可用 `new TaskRunner(options)`。
 * 职责单一：对单个任务入口起独立 Node 进程，捕获 stdout 最后一行 JSON，映射为
 * {@link TaskRunOutcome} 三结局（quiet / woke / failed）。不含依赖安装（loader 职责）。
 */
export class TaskRunner {
  /** 进程生成器（注入）。 */
  private readonly spawner: Spawner
  /** 计时预算（注入）。 */
  private readonly timeBudget: TimeBudget
  /** 任务执行超时（毫秒）。 */
  private readonly taskTimeoutMs: number
  /** stdout 累积上限（近似按 UTF-16 码元/字节计，见 {@link DEFAULT_MAX_STDOUT_BYTES}）。 */
  private readonly maxStdoutBytes: number
  /** 任务进程日志采集选项（M3）。 */
  private readonly taskLogOptions: TaskLogOptions | undefined

  constructor(options: RunnerOptions = {}) {
    this.spawner = options.spawner ?? createNodeSpawner()
    this.timeBudget = options.timeBudget ?? createNodeTimeBudget()
    this.taskTimeoutMs = options.taskTimeoutMs ?? DEFAULT_TASK_TIMEOUT_MS
    this.maxStdoutBytes = options.maxStdoutBytes ?? DEFAULT_MAX_STDOUT_BYTES
    this.taskLogOptions = options.taskLog
  }

  /**
   * 执行任务程序并判读结局。
   *
   * 流程：spawn（失败 → failed/spawn）→ 累积 stdout（超限即封顶强杀）→ 等退出（onClose）
   * 或超时/超限强杀 → 解析最后非空行 → 映射结局（woke / quiet / failed）。
   *
   * @param taskPath 任务入口文件绝对路径（对应 `TaskDef.task_path`）。
   * @param args     传给 `node` 的额外参数（可空）。
   * @param options  调用级选项（M3）：`taskId` 携带时启用任务进程日志采集。
   * @returns 单次运行结局（quiet / woke / failed）。
   */
  run(
    taskPath: string,
    args?: readonly string[],
    options?: TaskRunOptions,
  ): Promise<TaskRunOutcome> {
    return new Promise<TaskRunOutcome>((resolve) => {
      // 单一 settled 守卫：三结局互斥，一旦结算，后续任何事件（exit/超时）都被挡掉。
      let settled = false
      // 任务进程日志采集器（M3）；未携带 taskId 时保持 undefined（零副作用）。
      let taskLog: TaskLogCollector | undefined
      const finish = (outcome: TaskRunOutcome): void => {
        if (settled) return
        settled = true
        // 收尾任务日志：丢弃末行结果 JSON（“延迟一行”策略的最终丢弃）。
        try {
          taskLog?.close()
        } catch {
          /* 日志收尾绝不影响结局判定。 */
        }
        resolve(outcome)
      }

      let proc: TaskProcess
      try {
        proc = this.spawner.spawn(taskPath, args)
      } catch {
        finish({
          kind: 'failed',
          reason: `[runner] 无法启动任务进程: ${taskPath}`,
          failureKind: 'spawn',
        } as TaskRunOutcome)
        return
      }

      // ---- M3：任务进程日志独立采集（旁路，仅携带 taskId 时启用） ----
      // 不改变任何三结局/超时/超限语义：日志器任何异常均内部降级，绝不影响结局判定。
      const taskId = options?.taskId
      if (typeof taskId === 'string' && taskId.trim() !== '') {
        try {
          taskLog = createTaskLog({ taskId, pid: proc.pid }, this.taskLogOptions)
        } catch {
          taskLog = undefined
        }
      }

      // 超时一旦触发，进程后续任何退出都归因超时（吸取 loader 教训）。
      let timedOut = false
      // stdout 超限标志：一旦置 true，后续 data 不再累积，且 onDone 不得改变结局。
      let overflowed = false
      let stdoutBuf = ''

      // stdout：逐个 data chunk 拼接（UTF-8 自动按流解码，天然处理分片与无尾随换行）。
      //
      // 防 OOM：累积前先用 accumulateStdout 封顶（保证 stdoutBuf 长度不超过上限）；
      // 一旦越限立即 SIGTERM 强杀并结算 failed/exec，与超时强杀语义对称。
      if (proc.stdout) {
        proc.stdout.on('data', (chunk: Buffer | string) => {
          const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8')
          // M3 旁路：stdout 非末行内容落盘（“延迟一行”）。先于超限判定，保证诊断完整。
          try {
            taskLog?.writeStdoutChunk(text)
          } catch {
            /* 日志旁路绝不打断 stdout 主流程。 */
          }
          // 已越限：停止处理后续 chunk（finish 已结算，settled 守卫会挡掉，但显式返回更省）。
          if (overflowed) return
          const acc = accumulateStdout(stdoutBuf, text, this.maxStdoutBytes)
          stdoutBuf = acc.buffer
          if (!acc.overflowed) return

          // 越限：置标志 → SIGTERM 强杀 → 结算 failed（exec）。
          overflowed = true
          try {
            proc.kill('SIGTERM')
          } catch {
            /* 忽略 kill 抛错；onDone 会因 overflowed 归因超限，不落回正常解析 */
          }
          finish({
            kind: 'failed',
            reason: `[runner] 任务 stdout 超过上限（${this.maxStdoutBytes} 字节），已 SIGTERM 强杀: ${taskPath}`,
            detail: `输出上限 ${this.maxStdoutBytes} 字节`,
            failureKind: 'exec',
          } as TaskRunOutcome)
        })
      }
      // stderr 仅作诊断，runner 不消费其内容（任务对 runner 是黑盒）。
      // M3：携带任务日志时，全部 stderr 落盘；否则仅排空（保持既有行为）。
      if (proc.stderr) {
        if (taskLog) {
          try {
            proc.stderr.on('data', (chunk: Buffer | string) => {
              const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8')
              try {
                taskLog?.writeStderrChunk(text)
              } catch {
                /* 日志旁路绝不打断 stderr 排空。 */
              }
            })
          } catch {
            /* 某些 mock stderr 无 on；退回 resume 排空。 */
            try {
              proc.stderr.resume()
            } catch {
              /* 忽略。 */
            }
          }
        } else {
          try {
            proc.stderr.resume()
          } catch {
            /* 忽略：某些 mock stderr 无 resume。 */
          }
        }
      }

      // 单一超时 timer：到点先置 timedOut，再 SIGTERM 强杀，并结算 failed（exec）。
      //
      // 时序关键：`timedOut` 一旦置 true，即便进程响应 SIGTERM 快速退出、随后 stdout
      // close 触发 onDone，匿名谐归因「超时/failed」，绝不落回「正常退出 / 尝试解析」。
      const timeoutHandle = this.timeBudget.setTimeout(() => {
        timedOut = true
        try {
          proc.kill('SIGTERM')
        } catch {
          /* 忽略 kill 抛错；后续 onDone 会因 timedOut 归因超时 */
        }
        finish({
          kind: 'failed',
          reason: `[runner] 任务执行超时（${this.taskTimeoutMs}ms），已 SIGTERM 强杀: ${taskPath}`,
          failureKind: 'exec',
        } as TaskRunOutcome)
      }, this.taskTimeoutMs)

      // 进程结束（stdout 流 close，此时 exitCode 已确定）——唯一入口做解析与三结局映射。
      const onDone = (): void => {
        this.timeBudget.clearTimeout(timeoutHandle)

        // stdout 已超限结算：进程后续退出/流 close 不得改变结局（settled 守卫的显式兜底）。
        // 强杀后进程通常以非零/信号退出，若不在此拦截会落入下方「异常退出」分支。
        if (overflowed) return

        // 超时已触发：无论退出码如何，归因 failed（exec）。
        if (timedOut) {
          finish({
            kind: 'failed',
            reason: `[runner] 任务执行超时（${this.taskTimeoutMs}ms），已强杀: ${taskPath}`,
            failureKind: 'exec',
          } as TaskRunOutcome)
          return
        }

        // 非零退出码 / 崩溃（exitCode 为 null 或非 0）→ failed（exec）。
        const code = proc.exitCode
        if (code !== 0) {
          finish({
            kind: 'failed',
            reason: `[runner] 任务进程异常退出${code === null ? '（崩溃）' : `（exitCode=${code}）`}: ${taskPath}`,
            detail: code === null ? '进程崩溃（无退出码）' : `退出码 ${code}`,
            failureKind: 'exec',
          } as TaskRunOutcome)
          return
        }

        // 退出码 0：解析 stdout 最后非空行 → 映射结局。
        // §9.1「执行结果：输出不可解析 → failed」+ §4.4：exit 0 但末行无有效
        // `{shouldWake,data?}` JSON（或结构非法）→ failed，failureKind='parse'
        //（不再归 skipped；skipped 仅用于编排层「读任务程序 / 唤醒投递」等降级分支）。
        // 注：runner 自身不持有 logger，只产出 outcome；解析失败的可诊断日志由
        // 调度层 fire 统一记录（outcome.kind==='failed' → log('error', reason + detail)）。
        const parsed = parseLastJsonLine(stdoutBuf)
        if (parsed === null) {
          finish({
            kind: 'failed',
            reason: `[runner] 任务输出不可解析（无有效结果 JSON）: ${taskPath}`,
            detail:
              'stdout 最后非空行无有效 `{shouldWake,data?}` 单行 JSON（或 shouldWake 非 boolean / data 非 string）',
            failureKind: 'parse',
          } as TaskRunOutcome)
          return
        }

        if (parsed.shouldWake) {
          finish({
            kind: 'woke',
            reason: `[runner] 任务唤醒: ${taskPath}`,
            data: parsed.data,
            targets: [],
          } as TaskRunOutcome)
          return
        }

        finish({
          kind: 'quiet',
          reason: `[runner] 任务完成，未唤醒: ${taskPath}`,
        } as TaskRunOutcome)
      }

      // 退出感知：优先用 taskProcess.onClose 的可靠退出信号（退出 + stdio 已关闭，
      // exitCode 已确定）。若实现未提供 onClose（可选成员，纯 mock 省略），回退到
      // stdout 流 close（存在与 exit 竞争的缺陷，但至少能驱动结算）。
      // 若两者皆缺（异常契约实现），仅靠超时 timer 兜底（避免永久挂起）。
      if (proc.onClose) {
        proc.onClose(onDone)
      } else if (proc.stdout) {
        proc.stdout.on('close', onDone)
      } else if (proc.stderr) {
        proc.stderr.on('close', onDone)
      }
      // 若既无 onClose 也无任何流（异常契约实现），仅靠超时 timer 兜底。
    })
  }
}

/**
 * 创建任务执行器的工厂函数（无副作用工厂，对齐 types.ts 可注入风格）。
 *
 * @param options 依赖注入配置（spawner / timeBudget / timeout / maxStdoutBytes）。缺省用真实 node 实现。
 * @returns 就绪的 {@link TaskRunner} 实例。
 */
export function createTaskRunner(options: RunnerOptions = {}): TaskRunner {
  return new TaskRunner(options)
}