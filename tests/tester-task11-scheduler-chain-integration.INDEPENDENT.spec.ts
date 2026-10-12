/**
 * T11 跨模块集成 + 契约测试（二）：`applyScheduler` 全链路
 * `loader → runner → scheduler → wake`（真实编排 runner，注入 mock 外设）。
 *
 * 唯一权威设计文档：《感知层详细设计（dsh-finance 插件）》 v0.7。
 *
 * 既有覆盖的边界：
 *   - `tester-task9-scheduler-index.INDEPENDENT.spec.ts` 的 T9-C 用 **mock runner**
 *     验证编排 runner 的 loader/runner/waker 接线；T9-G 用 **mock runner + 真实 store**
 *     验证 fake timer 触发链。二者都**没有**让「真实 TaskRunner + 真实 TaskLoader」
 *     与注入的 mock `Spawner` / mock `InstallSpawner` 一同跑完 §4.3 全链路。
 *   - 本文件补齐：`applyScheduler` 的真实编排 runner + **真实 TaskLoader（注入 mock
 *     InstallSpawner）** + **真实 TaskRunner（注入 mock Spawner）** + **真实 Waker
 *     （mock agents）**，用 **假 clock/timer** 驱动「到点 → 依赖就绪 → 独立执行 →
 *     解析 stdout → shouldWake=true → 定点投递 → 链式重设」。
 *
 * 另补一组**契约矩阵**：TaskRunOutcome 四结局在各失败场景的 failureKind 归因
 * （install / spawn / exec / parse / wake），全部走真实模块 + 注入替身。
 *
 * 全部依赖注入替身，不依赖真实网络 / 真实 pnpm / 真实 node 子进程 / 长时等待；
 * 无任何 `src/**` 改动（仅测试）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { PassThrough } from 'node:stream'

// ---------------------------------------------------------------------------
// vi.hoisted：可变替身 + 装配捕获（供 vi.mock 工厂读取，避免 TDZ）
// ---------------------------------------------------------------------------

const H = vi.hoisted(() => ({
  /** 覆盖 loader 工厂返回值；null → 真实 createTaskLoader。 */
  loaderImpl: { value: null as unknown },
  /** 覆盖 runner 工厂返回值；null → 真实 createTaskRunner。 */
  runnerImpl: { value: null as unknown },
  /** 覆盖 waker 工厂返回值；null → 真实 createWaker。 */
  wakerImpl: { value: null as unknown },
  /** applyScheduler 内部 createScheduler 的入参捕获（取编排 runner）。 */
  cap: { options: null as unknown, financeHome: '' },
}))

vi.mock('../src/paths.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/paths.js')>()
  return {
    ...actual,
    resolveFinanceHomeDir: () => H.cap.financeHome,
  }
})

vi.mock('../src/scheduler/loader.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/scheduler/loader.js')>()
  return {
    ...actual,
    createTaskLoader: (opts?: unknown) =>
      H.loaderImpl.value ?? actual.createTaskLoader(opts as never),
  }
})

vi.mock('../src/scheduler/runner.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/scheduler/runner.js')>()
  return {
    ...actual,
    createTaskRunner: (opts?: unknown) =>
      H.runnerImpl.value ?? actual.createTaskRunner(opts as never),
  }
})

vi.mock('../src/scheduler/wake.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/scheduler/wake.js')>()
  return {
    ...actual,
    createWaker: (opts?: unknown) => H.wakerImpl.value ?? actual.createWaker(opts as never),
  }
})

vi.mock('../src/scheduler/scheduler.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/scheduler/scheduler.js')>()
  return {
    ...actual,
    createScheduler: (options: any) => {
      // 保留真实 Scheduler 行为（多 timer / 幂等启停 / 链式自调度），仅捕获入参。
      H.cap.options = options
      return actual.createScheduler(options)
    },
  }
})

import { applyScheduler } from '../src/scheduler/index.js'
import {
  createTaskLoader,
  type InstallSpawner,
  type InstallSpawnResult,
  type LoaderFs,
} from '../src/scheduler/loader.js'
import { createTaskRunner } from '../src/scheduler/runner.js'
import type { Spawner, TaskProcess } from '../src/scheduler/types.js'

// ---------------------------------------------------------------------------
// 常量 / 辅助
// ---------------------------------------------------------------------------

const noopLog = (): void => {}

interface FakeCtx {
  services: Record<string, unknown>
  effects: Array<{ label?: string; dispose: () => void; body: () => unknown }>
  injects: Array<{ deps: readonly string[]; cb: (c: any) => void }>
  get: (name: string) => unknown
  inject: (deps: string[], cb: (c: any) => void) => () => void
  effect: (body: () => unknown, label?: string) => () => void
}

/** 最小结构 ctx 替身（仅 applyScheduler 用到的 get / inject / effect）。 */
function makeCtx(services: Record<string, unknown> = {}): FakeCtx {
  const effects: FakeCtx['effects'] = []
  const injects: FakeCtx['injects'] = []
  return {
    services,
    effects,
    injects,
    get: (name) => services[name],
    inject(deps, cb) {
      injects.push({ deps, cb })
      return () => {}
    },
    effect(body, label) {
      const d = body()
      const dispose = typeof d === 'function' ? (d as () => void) : () => {}
      effects.push({ label, dispose, body })
      return dispose
    },
  }
}

const tmpDirs: string[] = []
function mkTmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'dsh-t11-chain-'))
  tmpDirs.push(d)
  const home = mkdtempSync(join(tmpdir(), 'dsh-t11-chain-home-'))
  tmpDirs.push(home)
  H.cap.financeHome = home
  return d
}

/** 写一条任务清单记录到 `<dataRoot>/tasks/<id>.json`（并补齐任务入口文件）。 */
function writeTask(dataRoot: string, def: Record<string, unknown>): void {
  const dir = join(dataRoot, 'tasks')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${String(def.id)}.json`), JSON.stringify(def), 'utf8')
  // §9.1：编排 runner 会校验任务程序入口文件存在性；默认补齐入口文件，避免被误判为
  // skipped（内容无关，真实 TaskRunner 已由 mock Spawner 接管）。
  const abs = resolve(H.cap.financeHome, String(def.task_path))
  mkdirSync(dirname(abs), { recursive: true })
  writeFileSync(abs, '// test task entry\n', 'utf8')
}

let activeCtx: FakeCtx | null = null

function disposeCtx(ctx: FakeCtx | null): void {
  if (!ctx) return
  for (const e of ctx.effects ?? []) {
    try {
      e.dispose()
    } catch {
      /* ignore */
    }
  }
}

/** 装配 applyScheduler（登记 activeCtx 供 afterEach 卸载；重复 boot 先卸前者）。 */
function boot(dataRoot: string, services: Record<string, unknown> = {}): FakeCtx {
  disposeCtx(activeCtx)
  const ctx = makeCtx(services)
  activeCtx = ctx
  applyScheduler(ctx, { dataRoot, logger: noopLog })
  return ctx
}

/** 抓取 applyScheduler 内部构造的「编排 runner」。 */
function orch(): { run: (taskId: string, taskPath: string) => Promise<any> } {
  return (H.cap.options as { runner: any }).runner
}

// ---------------------------------------------------------------------------
// 注入替身：mock 进程 / mock spawner / mock install spawner / mock agents
// ---------------------------------------------------------------------------

/** 用 PassThrough 模拟任务子进程（stdout 可编程；无 onClose → runner 回退 stdout close）。 */
class FakeProcess implements TaskProcess {
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  exitCode: number | null = null
  killed: NodeJS.Signals[] = []
  kill(signal?: NodeJS.Signals): void {
    if (signal) this.killed.push(signal)
  }
  writeStdout(text: string): void {
    this.stdout.write(text)
  }
  /** 以给定退出码结束 stdout/stderr（触发 close → runner 判读）。 */
  end(exitCode: number | null): void {
    this.exitCode = exitCode
    this.stdout.end()
    this.stderr.end()
  }
}

/** 构造真实 TaskRunner 用的 mock Spawner：spawn 后经微任务投递 stdout + 退出。 */
function makeSpawner(program: (p: FakeProcess) => void, throwOnSpawn = false) {
  const spawn = vi.fn((_taskPath: string) => {
    if (throwOnSpawn) throw new Error('spawn boom')
    const proc = new FakeProcess()
    queueMicrotask(() => program(proc))
    return proc
  })
  return { spawner: { spawn } as Spawner, spawn }
}

/** 构造真实 TaskLoader 用的 mock InstallSpawner。 */
function makeInstallSpawner(result: InstallSpawnResult) {
  const install = vi.fn(async (_cwd: string, _timeoutMs: number) => result)
  return { spawner: { install } as InstallSpawner, install }
}

/** 目录 / package.json 均存在的 mock fs（隔离 loader 前置校验）。 */
const realFs: LoaderFs = { dirExists: () => true, packageJsonExists: () => true }

/** 命中固定会话的 mock agents 注册表（real Waker 定点取 investment-advisor）。 */
function makeAgents(followup: (m: unknown) => void) {
  return {
    get: (id: string) =>
      id === 'investment-advisor' ? { id, followup } : undefined,
  }
}

afterEach(() => {
  disposeCtx(activeCtx)
  activeCtx = null
  H.loaderImpl.value = null
  H.runnerImpl.value = null
  H.wakerImpl.value = null
  H.cap.financeHome = ''
  for (const d of tmpDirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  }
})

// ===========================================================================
// A. 全链路：到点 → 依赖就绪 → 独立执行 → shouldWake=true → 定点投递 → 链式重设
// ===========================================================================

describe('T11-I2 全链路（真实 loader/runner/waker + mock spawner + 假 timer）', () => {
  it('到点触发：install → spawn → woke → waker 定点投递；链式重设（第二次因冷却不重复投递）', async () => {
    vi.useFakeTimers()
    try {
      const dataRoot = mkTmp()
      writeTask(dataRoot, {
        id: 'alpha',
        name: 'A',
        cron: '* * * * *',
        task_path: 'tasks/alpha/task.mjs',
        enabled: true,
      })

      const inst = makeInstallSpawner({ exitCode: 0, killed: false, reason: 'exit' })
      const sp = makeSpawner((p) => {
        p.writeStdout('doing work\n{"shouldWake":true,"data":"BUY 600519"}\n')
        p.end(0)
      })
      // 真实 TaskLoader / TaskRunner，注入 mock 外设。
      H.loaderImpl.value = createTaskLoader({ spawner: inst.spawner, fs: realFs })
      H.runnerImpl.value = createTaskRunner({ spawner: sp.spawner })

      const followup = vi.fn()
      H.wakerImpl.value = null // 由 index 用真实 createWaker（mock agents）

      const ctx = boot(dataRoot)
      // 模拟 agents 服务就绪 → index 构造真实 Waker（定点 investment-advisor）。
      expect(ctx.injects[0].deps).toEqual(['agents'])
      ctx.injects[0].cb({ get: (n: string) => (n === 'agents' ? makeAgents(followup) : undefined) })

      // 推进到下一分钟触发点。
      await vi.advanceTimersByTimeAsync(61_000)

      // 依赖就绪：真实 loader 被调用，cwd = 任务目录。
      expect(inst.install).toHaveBeenCalledTimes(1)
      expect(inst.install.mock.calls[0][0]).toBe(resolve(H.cap.financeHome, 'tasks/alpha'))
      // 独立执行：真实 runner 起进程，路径 = 任务入口绝对路径。
      expect(sp.spawn).toHaveBeenCalledTimes(1)
      expect(sp.spawn.mock.calls[0][0]).toBe(resolve(H.cap.financeHome, 'tasks/alpha/task.mjs'))
      // 唤醒投递：定点到固定会话，正文 = data 原文 + 合规声明。
      expect(followup).toHaveBeenCalledTimes(1)
      const msg = JSON.stringify(followup.mock.calls[0][0])
      expect(msg).toContain('BUY 600519')
      expect(msg).toContain('本内容不构成投资建议')

      // 链式自调度：再推进一周期 → 第二次安装+执行（唤醒因 5min 冷却被去重）。
      await vi.advanceTimersByTimeAsync(61_000)
      expect(inst.install).toHaveBeenCalledTimes(2)
      expect(sp.spawn).toHaveBeenCalledTimes(2)
      expect(followup).toHaveBeenCalledTimes(1) // 冷却窗口内不重复投递
    } finally {
      vi.useRealTimers()
    }
  })

  it('enabled=false 的任务不被调度（同批仅 enabled 任务触发）', async () => {
    vi.useFakeTimers()
    try {
      const dataRoot = mkTmp()
      writeTask(dataRoot, {
        id: 'on',
        name: 'ON',
        cron: '* * * * *',
        task_path: 'tasks/on/task.mjs',
        enabled: true,
      })
      writeTask(dataRoot, {
        id: 'off',
        name: 'OFF',
        cron: '* * * * *',
        task_path: 'tasks/off/task.mjs',
        enabled: false,
      })

      const inst = makeInstallSpawner({ exitCode: 0, killed: false, reason: 'exit' })
      const sp = makeSpawner((p) => {
        p.writeStdout('{"shouldWake":false}\n')
        p.end(0)
      })
      H.loaderImpl.value = createTaskLoader({ spawner: inst.spawner, fs: realFs })
      H.runnerImpl.value = createTaskRunner({ spawner: sp.spawner })

      boot(dataRoot)
      await vi.advanceTimersByTimeAsync(61_000)

      const spawned = sp.spawn.mock.calls.map((c) => c[0])
      expect(spawned).toContain(resolve(H.cap.financeHome, 'tasks/on/task.mjs'))
      expect(spawned).not.toContain(resolve(H.cap.financeHome, 'tasks/off/task.mjs'))
    } finally {
      vi.useRealTimers()
    }
  })

  it('多任务同刻并发触发：各自独立执行、互不阻塞', async () => {
    vi.useFakeTimers()
    try {
      const dataRoot = mkTmp()
      for (const id of ['m1', 'm2', 'm3']) {
        writeTask(dataRoot, {
          id,
          name: id,
          cron: '* * * * *',
          task_path: `tasks/${id}/task.mjs`,
          enabled: true,
        })
      }

      const inst = makeInstallSpawner({ exitCode: 0, killed: false, reason: 'exit' })
      const sp = makeSpawner((p) => {
        p.writeStdout('{"shouldWake":false}\n')
        p.end(0)
      })
      H.loaderImpl.value = createTaskLoader({ spawner: inst.spawner, fs: realFs })
      H.runnerImpl.value = createTaskRunner({ spawner: sp.spawner })

      boot(dataRoot)
      await vi.advanceTimersByTimeAsync(61_000)

      // 三个任务同刻触发，各自 install + spawn 一次。
      expect(sp.spawn).toHaveBeenCalledTimes(3)
      const paths = new Set(sp.spawn.mock.calls.map((c) => c[0]))
      expect(paths.size).toBe(3)
      expect(inst.install).toHaveBeenCalledTimes(3)
    } finally {
      vi.useRealTimers()
    }
  })

  it('卸载（effect dispose → scheduler.stop）后不再触发', async () => {
    vi.useFakeTimers()
    try {
      const dataRoot = mkTmp()
      writeTask(dataRoot, {
        id: 'stopme',
        name: 'S',
        cron: '* * * * *',
        task_path: 'tasks/stopme/task.mjs',
        enabled: true,
      })

      const inst = makeInstallSpawner({ exitCode: 0, killed: false, reason: 'exit' })
      const sp = makeSpawner((p) => {
        p.writeStdout('{"shouldWake":false}\n')
        p.end(0)
      })
      H.loaderImpl.value = createTaskLoader({ spawner: inst.spawner, fs: realFs })
      H.runnerImpl.value = createTaskRunner({ spawner: sp.spawner })

      const ctx = boot(dataRoot)
      disposeCtx(ctx)
      activeCtx = null

      await vi.advanceTimersByTimeAsync(180_000)
      expect(sp.spawn).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })
})

// ===========================================================================
// B. 契约矩阵：TaskRunOutcome 四结局 × failureKind 归因（install/spawn/exec/parse/wake）
// ===========================================================================

describe('T11-C2 契约：failureKind 归因矩阵（真实 runner/loader + 注入替身）', () => {
  const TASK_PATH = 'tasks/alpha/task.mjs'

  function setupTask(): string {
    const dataRoot = mkTmp()
    writeTask(dataRoot, {
      id: 'alpha',
      name: 'A',
      cron: '0 9 * * *',
      task_path: TASK_PATH,
      enabled: true,
    })
    return dataRoot
  }

  it('install：依赖安装非零退出 → failed / failureKind=install，且不执行 runner', async () => {
    const dataRoot = setupTask()
    const inst = makeInstallSpawner({ exitCode: 1, killed: false, reason: 'exit' })
    const sp = makeSpawner((p) => {
      p.writeStdout('{"shouldWake":false}\n')
      p.end(0)
    })
    H.loaderImpl.value = createTaskLoader({ spawner: inst.spawner, fs: realFs })
    H.runnerImpl.value = createTaskRunner({ spawner: sp.spawner })

    boot(dataRoot)
    const out = await orch().run('alpha', TASK_PATH)
    expect(out.kind).toBe('failed')
    expect(out.failureKind).toBe('install')
    expect(sp.spawn).not.toHaveBeenCalled()
  })

  it('install：安装超时强杀 → failed / failureKind=install', async () => {
    const dataRoot = setupTask()
    const inst = makeInstallSpawner({ exitCode: null, killed: true, reason: 'timeout' })
    const sp = makeSpawner((p) => p.end(0))
    H.loaderImpl.value = createTaskLoader({ spawner: inst.spawner, fs: realFs })
    H.runnerImpl.value = createTaskRunner({ spawner: sp.spawner })

    boot(dataRoot)
    const out = await orch().run('alpha', TASK_PATH)
    expect(out.kind).toBe('failed')
    expect(out.failureKind).toBe('install')
    expect(sp.spawn).not.toHaveBeenCalled()
  })

  it('spawn：进程生成失败（spawner.spawn 抛错）→ failed / failureKind=spawn', async () => {
    const dataRoot = setupTask()
    const inst = makeInstallSpawner({ exitCode: 0, killed: false, reason: 'exit' })
    const sp = makeSpawner(() => {}, /* throwOnSpawn */ true)
    H.loaderImpl.value = createTaskLoader({ spawner: inst.spawner, fs: realFs })
    H.runnerImpl.value = createTaskRunner({ spawner: sp.spawner })

    boot(dataRoot)
    const out = await orch().run('alpha', TASK_PATH)
    expect(out.kind).toBe('failed')
    expect(out.failureKind).toBe('spawn')
  })

  it('exec：子进程非零退出 → failed / failureKind=exec', async () => {
    const dataRoot = setupTask()
    const inst = makeInstallSpawner({ exitCode: 0, killed: false, reason: 'exit' })
    const sp = makeSpawner((p) => {
      p.writeStdout('partial\n')
      p.end(3)
    })
    H.loaderImpl.value = createTaskLoader({ spawner: inst.spawner, fs: realFs })
    H.runnerImpl.value = createTaskRunner({ spawner: sp.spawner })

    boot(dataRoot)
    const out = await orch().run('alpha', TASK_PATH)
    expect(out.kind).toBe('failed')
    expect(out.failureKind).toBe('exec')
  })

  it('parse：stdout 末行无有效 JSON（契约违约）→ failed / failureKind=parse', async () => {
    const dataRoot = setupTask()
    const inst = makeInstallSpawner({ exitCode: 0, killed: false, reason: 'exit' })
    const sp = makeSpawner((p) => {
      p.writeStdout('not-json-line\n\n')
      p.end(0)
    })
    H.loaderImpl.value = createTaskLoader({ spawner: inst.spawner, fs: realFs })
    H.runnerImpl.value = createTaskRunner({ spawner: sp.spawner })

    boot(dataRoot)
    const out = await orch().run('alpha', TASK_PATH)
    expect(out.kind).toBe('failed')
    expect(out.failureKind).toBe('parse')
  })

  it('parse：shouldWake 非 boolean（契约违约）→ failed / failureKind=parse', async () => {
    const dataRoot = setupTask()
    const inst = makeInstallSpawner({ exitCode: 0, killed: false, reason: 'exit' })
    const sp = makeSpawner((p) => {
      p.writeStdout('{"shouldWake":"yes","data":"x"}\n')
      p.end(0)
    })
    H.loaderImpl.value = createTaskLoader({ spawner: inst.spawner, fs: realFs })
    H.runnerImpl.value = createTaskRunner({ spawner: sp.spawner })

    boot(dataRoot)
    const out = await orch().run('alpha', TASK_PATH)
    expect(out.kind).toBe('failed')
    expect(out.failureKind).toBe('parse')
  })

  it('wake：waker 未就绪（agents 不可用）→ skipped（不中断调度链）', async () => {
    const dataRoot = setupTask()
    const inst = makeInstallSpawner({ exitCode: 0, killed: false, reason: 'exit' })
    const sp = makeSpawner((p) => {
      p.writeStdout('{"shouldWake":true,"data":"SIGNAL"}\n')
      p.end(0)
    })
    H.loaderImpl.value = createTaskLoader({ spawner: inst.spawner, fs: realFs })
    H.runnerImpl.value = createTaskRunner({ spawner: sp.spawner })
    H.wakerImpl.value = null

    boot(dataRoot)
    // 不触发 agents 动态注入 → 内部 waker 保持 undefined。
    const out = await orch().run('alpha', TASK_PATH)
    expect(out.kind).toBe('skipped')
    expect(String(out.reason)).toMatch(/waker|agents|降级/)
  })

  it('wake：固定会话投递异常 → skipped（真实 Waker 兜底降级）', async () => {
    const dataRoot = setupTask()
    const inst = makeInstallSpawner({ exitCode: 0, killed: false, reason: 'exit' })
    const sp = makeSpawner((p) => {
      p.writeStdout('{"shouldWake":true,"data":"SIGNAL"}\n')
      p.end(0)
    })
    H.loaderImpl.value = createTaskLoader({ spawner: inst.spawner, fs: realFs })
    H.runnerImpl.value = createTaskRunner({ spawner: sp.spawner })
    H.wakerImpl.value = null

    const ctx = boot(dataRoot)
    // followup 抛异常 → 真实 Waker 内部降级 delivered:false → 编排层 skipped。
    ctx.injects[0].cb({
      get: (n: string) =>
        n === 'agents'
          ? makeAgents(() => {
              throw new Error('followup boom')
            })
          : undefined,
    })

    const out = await orch().run('alpha', TASK_PATH)
    expect(out.kind).toBe('skipped')
  })
})
