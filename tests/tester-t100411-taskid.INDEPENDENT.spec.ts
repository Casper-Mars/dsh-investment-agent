/**
 * tester 独立验证 —— t100411「调度契约携带 taskId + 去反查」。
 *
 * 本文件由 Tester 独立自建（不读取 / 不依赖 Developer 的 t100411-taskid-contract.spec.ts
 * 的断言），用「真实 Scheduler / 真实 applyScheduler 装配 + 替身周边」两条链路，
 * 独立复核：
 *   A. 契约层：scheduler.fire 是否把「触发任务自己的 id」透传给 runner（同 path 两任务不串扰，
 *      且链式自调度（rescheduleAfterFire）的第二代仍携带正确 id）。
 *   B. 编排层：orchestratedRunner.run(taskId, taskPath) 是否真正「不再 store.list 反查」——
 *      store 空 / store 里同 path 是另一个 id，均应按入参 taskId 执行与投递。
 *
 * 关键差异（相对 Developer 用例）：B4 构造「store 里存在同 task_path 但 id 不同」的场景，
 * 若实现仍在反查，必然投递到 store 中那个 id；只有真正按入参投递才会命中 'b'。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

import type {
  Clock,
  TaskDef,
  TaskRunOutcome,
  Timer,
  TimerHandle,
} from '../src/scheduler/types.js'

// ---------------------------------------------------------------------------
// vi.hoisted：本次装配可替换的 loader/runner/waker 替身 + 捕获 createScheduler 入参
// ---------------------------------------------------------------------------
const H = vi.hoisted(() => ({
  loader: { value: null as unknown },
  runner: { value: null as unknown },
  waker: { value: null as unknown },
  cap: { options: null as unknown, scheduler: null as unknown, financeHome: '' },
}))

vi.mock('../src/paths.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/paths.js')>()
  return {
    ...actual,
    resolveFinanceHomeDir: () => H.cap.financeHome,
    // 任务定义目录跟着 mock 后的 finance home 走（隔离真实 ~/.dsh-ia）。
    resolveAssetsTasksDir: () => `${H.cap.financeHome}/assets/tasks`,
  }
})

vi.mock('../src/scheduler/loader.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/scheduler/loader.js')>()
  return {
    ...actual,
    createTaskLoader: (opts?: unknown) =>
      H.loader.value ?? actual.createTaskLoader(opts as never),
  }
})
vi.mock('../src/scheduler/runner.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/scheduler/runner.js')>()
  return {
    ...actual,
    createTaskRunner: (opts?: unknown) =>
      H.runner.value ?? actual.createTaskRunner(opts as never),
  }
})
vi.mock('../src/scheduler/wake.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/scheduler/wake.js')>()
  return {
    ...actual,
    createWaker: (opts?: unknown) => H.waker.value ?? actual.createWaker(opts as never),
  }
})
vi.mock('../src/scheduler/scheduler.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/scheduler/scheduler.js')>()
  return {
    ...actual,
    createScheduler: (options: any) => {
      const s = actual.createScheduler(options)
      H.cap.options = options
      H.cap.scheduler = s
      return s
    },
  }
})

import { createScheduler } from '../src/scheduler/scheduler.js'
import { applyScheduler } from '../src/scheduler/index.js'

// ===========================================================================
// A. 契约层（真实 Scheduler + 记录型 runner 替身）
// ===========================================================================
class IdPathStore {
  constructor(public tasks: TaskDef[]) {}
  list() {
    return { tasks: this.tasks.slice(), corrupted: [] as string[] }
  }
}
class DueTimer implements Timer {
  entries: { at: number; cb: () => void }[] = []
  setTimer(delayMs: number, cb: () => void): TimerHandle {
    this.entries.push({ at: this.clock.now().getTime() + delayMs, cb })
    return (this.entries.length as unknown) as TimerHandle
  }
  clearTimer(): void {
    /* noop：由 fire/rebuild 逻辑自行管理 */
  }
  constructor(private clock: Clock) {}
  fireDue(nowMs: number): void {
    const due = this.entries.filter((e) => e.at <= nowMs).sort((a, b) => a.at - b.at)
    this.entries = this.entries.filter((e) => e.at > nowMs)
    for (const e of due) e.cb()
  }
  pendingAt(): number[] {
    return this.entries.map((e) => e.at)
  }
}
class FakeClock implements Clock {
  constructor(private d: Date) {}
  now(): Date {
    return this.d
  }
  set(d: Date): void {
    this.d = d
  }
}
/** 独立记录 (taskId, taskPath) —— 不去重、不折叠，保留调用序列。 */
class SpyRunner {
  calls: Array<{ id: string | undefined; path: string | undefined }> = []
  run(taskId: string, taskPath: string): Promise<TaskRunOutcome> {
    this.calls.push({ id: taskId, path: taskPath })
    return Promise.resolve({ kind: 'quiet', reason: 'ok' })
  }
}

const SHARED = 'assets/programs/shared/task.ts'
function def(id: string, overrides: Partial<TaskDef> = {}): TaskDef {
  return {
    id,
    name: `T-${id}`,
    cron: '* * * * *',
    task_path: SHARED,
    enabled: true,
    ...overrides,
  }
}

describe('tester-t100411-A 契约层：fire 透传触发任务自己的 taskId', () => {
  const BASE = new Date('2026-10-08T08:00:00Z')

  it('A1 同 path 两任务首次触发：runner 分别收到 a / b（非同一 id）', async () => {
    const store = new IdPathStore([def('a'), def('b')])
    const runner = new SpyRunner()
    const clock = new FakeClock(BASE)
    const timer = new DueTimer(clock)
    const s = createScheduler({ store, runner, timer, clock } as any)
    s.start()

    const earliest = Math.min(...timer.pendingAt())
    clock.set(new Date(earliest))
    timer.fireDue(earliest)
    await vi.waitFor(() => expect(runner.calls).toHaveLength(2))

    expect(runner.calls.map((c) => c.path)).toEqual([SHARED, SHARED])
    expect(new Set(runner.calls.map((c) => c.id))).toEqual(new Set(['a', 'b']))
    // 反向：绝不允许出现「id 被当作 path / path 被当作 id」的错位。
    expect(runner.calls.every((c) => c.path === SHARED)).toBe(true)
    expect(runner.calls.every((c) => c.id === 'a' || c.id === 'b')).toBe(true)

    s.stop()
  })

  it('A2 链式自调度第二代：rescheduleAfterFire 重新 fire 仍携带各自 id', async () => {
    const store = new IdPathStore([def('a'), def('b')])
    const runner = new SpyRunner()
    const clock = new FakeClock(BASE)
    const timer = new DueTimer(clock)
    const s = createScheduler({ store, runner, timer, clock } as any)
    s.start()

    // 第一代
    const t1 = Math.min(...timer.pendingAt())
    clock.set(new Date(t1))
    timer.fireDue(t1)
    await vi.waitFor(() => expect(runner.calls).toHaveLength(2))
    // rescheduleAfterFire 在 finally（微任务）里补 timer，等它落定。
    await vi.waitFor(() => expect(timer.pendingAt()).toHaveLength(2))

    // 第二代：推进 1 分钟（cron '* * * * *'），触发 rescheduleAfterFire 重新装配的 timer。
    const t2 = Math.min(...timer.pendingAt())
    expect(Number.isFinite(t2)).toBe(true)
    clock.set(new Date(t2))
    timer.fireDue(t2)
    await vi.waitFor(() => expect(runner.calls).toHaveLength(4))

    const ids = runner.calls.map((c) => c.id)
    // 两代都应各含 a、b 一次，且 path 恒为 SHARED（id 未被错配）。
    expect(ids.filter((x) => x === 'a')).toHaveLength(2)
    expect(ids.filter((x) => x === 'b')).toHaveLength(2)
    expect(runner.calls.every((c) => c.path === SHARED)).toBe(true)

    s.stop()
  })

  it('A3 单任务：runner 收到 (id, path) 且顺序为 id 在前（防签名错位回归）', async () => {
    const store = new IdPathStore([def('solo')])
    const runner = new SpyRunner()
    const clock = new FakeClock(BASE)
    const timer = new DueTimer(clock)
    const s = createScheduler({ store, runner, timer, clock } as any)
    s.start()

    const t = Math.min(...timer.pendingAt())
    clock.set(new Date(t))
    timer.fireDue(t)
    await vi.waitFor(() => expect(runner.calls).toHaveLength(1))

    expect(runner.calls[0]).toEqual({ id: 'solo', path: SHARED })
    s.stop()
  })
})

// ===========================================================================
// B. 编排层（真实 applyScheduler + 真实 store，周边替身）
// ===========================================================================
interface Ctx {
  injects: Array<{ deps: string[]; cb: (ctx: any) => void }>
  get(name: string): unknown
  inject(deps: string[], cb: (ctx: any) => void): () => void
  effect(body: () => void | (() => void), label?: string): () => void
}
function mkCtx(): Ctx {
  return {
    injects: [],
    get: () => undefined,
    inject(deps, cb) {
      this.injects.push({ deps, cb })
      return () => {}
    },
    effect(body) {
      const d = body()
      return typeof d === 'function' ? d : () => {}
    },
  }
}

const tmps: string[] = []
function mkTmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'tester-t100411-'))
  tmps.push(d)
  const home = mkdtempSync(join(tmpdir(), 'tester-t100411-home-'))
  tmps.push(home)
  H.cap.financeHome = home
  return d
}
function putTask(dataRoot: string, t: TaskDef, entry: boolean): void {
  const dir = join(H.cap.financeHome, 'assets', 'tasks')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${t.id}.json`), JSON.stringify(t), 'utf8')
  if (entry) {
    const abs = resolve(H.cap.financeHome, t.task_path)
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, '// independent entry\n', 'utf8')
  }
}
/** 只写入口文件、不写清单（用于「清单为空」场景）。 */
function putEntryOnly(_dataRoot: string, relPath: string): void {
  const abs = resolve(H.cap.financeHome, relPath)
  mkdirSync(dirname(abs), { recursive: true })
  writeFileSync(abs, '// independent entry\n', 'utf8')
}

let liveCtx: Ctx | null = null
function boot(dataRoot: string): Ctx {
  const ctx = mkCtx()
  liveCtx = ctx
  applyScheduler(ctx, { dataRoot, logger: () => {} } as any)
  // 触发 agents 注入 → waker 就绪（H.waker 替身）。
  ctx.injects[0]?.cb({ get: () => ({ get: () => ({ id: 'investment-advisor', followup() {} }) }) })
  return ctx
}
function orch(): { run: (taskId: string, taskPath: string) => Promise<TaskRunOutcome> } {
  return (H.cap.options as { runner: any }).runner
}
function okWake(id: string, _data: unknown) {
  return { delivered: true, count: 1, targets: ['investment-advisor'], reason: 'ok' }
}

describe('tester-t100411-B 编排层：run 直用入参 taskId，不再 store.list 反查', () => {
  beforeEach(() => {
    H.runner.value = {
      run: vi.fn(async () => ({ kind: 'woke', reason: 'w', data: 'SIG', targets: [] })),
    }
  })
  afterEach(() => {
    liveCtx = null
    H.loader.value = null
    H.runner.value = null
    H.waker.value = null
    H.cap.options = null
    H.cap.financeHome = ''
    for (const d of tmps.splice(0)) {
      try {
        rmSync(d, { recursive: true, force: true })
      } catch {
        /* ignore */
      }
    }
  })

  it('B1 loader 收到入参 taskId（依赖安装按传入 id，不反查）', async () => {
    const dataRoot = mkTmp()
    // 清单里根本没有该任务，但入口在 → 旧实现反查失败会 skipped，新实现应正常跑。
    putEntryOnly(dataRoot, 'assets/programs/standalone/task.ts')
    const install = vi.fn(async () => {})
    H.loader.value = { installTaskDeps: install }
    H.waker.value = { wake: vi.fn(okWake) }

    boot(dataRoot)
    const out = await orch().run('standalone', 'assets/programs/standalone/task.ts')

    expect(out.kind).toBe('woke')
    // loader 依赖安装以入参 id 调用（旧实现此处是 store 反查到的 id 或根本不调用）。
    expect(install).toHaveBeenCalledTimes(1)
    expect(install.mock.calls[0][0]).toBe('standalone')
    expect(install.mock.calls[0][1]).toBe(resolve(H.cap.financeHome, 'assets/programs/standalone'))
  })

  it('B2 清单为空 + 入口存在 → 直接按入参 id 执行并投递（证明反查已移除）', async () => {
    const dataRoot = mkTmp()
    putEntryOnly(dataRoot, 'assets/programs/onlyarg/task.ts')
    H.loader.value = { installTaskDeps: vi.fn(async () => {}) }
    const wake = vi.fn(okWake)
    H.waker.value = { wake }

    boot(dataRoot)
    const out = await orch().run('onlyarg', 'assets/programs/onlyarg/task.ts')

    expect(out.kind).toBe('woke')
    expect(wake).toHaveBeenCalledTimes(1)
    expect(wake.mock.calls[0][0]).toBe('onlyarg')
  })

  it('B3 同 path 两任务：run("b", path) 必须投递到 b（旧实现会投到首个 a）', async () => {
    const dataRoot = mkTmp()
    putTask(dataRoot, def('a', { task_path: 'assets/programs/shared/task.ts' }), true)
    putTask(dataRoot, def('b', { task_path: 'assets/programs/shared/task.ts' }), true)
    H.loader.value = { installTaskDeps: vi.fn(async () => {}) }
    const wake = vi.fn(okWake)
    H.waker.value = { wake }

    boot(dataRoot)
    const out = await orch().run('b', 'assets/programs/shared/task.ts')

    expect(out.kind).toBe('woke')
    expect(wake).toHaveBeenCalledTimes(1)
    expect(wake.mock.calls[0][0]).toBe('b')
    expect(wake.mock.calls[0][0]).not.toBe('a')
  })

  it('B4 store 同 path 却是另一个 id("x")：按入参 "b" 投递，而非反查到的 "x"', async () => {
    const dataRoot = mkTmp()
    // 清单只有 x，其 task_path 恰好等于我们要跑的 path；但我们以 "b" 触发。
    putTask(dataRoot, def('x', { task_path: 'assets/programs/shared/task.ts' }), true)
    H.loader.value = { installTaskDeps: vi.fn(async () => {}) }
    const wake = vi.fn(okWake)
    H.waker.value = { wake }

    boot(dataRoot)
    const out = await orch().run('b', 'assets/programs/shared/task.ts')

    expect(out.kind).toBe('woke')
    // 若仍在反查 → 会命中 store 里的 x；只有直用入参才会是 b。
    expect(wake.mock.calls[0][0]).toBe('b')
    expect(wake.mock.calls[0][0]).not.toBe('x')
  })

  it('B5 入口缺失 → skipped（去反查不影响 §9.1 门禁）且不触达 loader/runner', async () => {
    const dataRoot = mkTmp()
    mkdirSync(join(H.cap.financeHome, 'assets', 'tasks'), { recursive: true })
    const install = vi.fn(async () => {})
    const run = vi.fn(async () => ({ kind: 'quiet', reason: 'x' }))
    H.loader.value = { installTaskDeps: install }
    H.runner.value = { run }
    H.waker.value = { wake: vi.fn(okWake) }

    boot(dataRoot)
    const out = await orch().run('ghost', 'assets/programs/ghost/task.ts')

    expect(out.kind).toBe('skipped')
    expect(install).not.toHaveBeenCalled()
    expect(run).not.toHaveBeenCalled()
  })
})
