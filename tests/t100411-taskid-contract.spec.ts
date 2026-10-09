/**
 * t100411 —— 调度契约携带 taskId（`TaskRunnerLike.run(taskId, taskPath)`）回归测试。
 *
 * 缺陷（修复前）：
 *   `TaskRunnerLike.run(taskPath)` 只带 taskPath，丢弃了 scheduler 在
 *   `fire(id, schedule, taskPath)` 中**已持有**的 taskId。编排层（src/scheduler/index.ts
 *   的 orchestratedRunner）每次触发都要 `store.list().find(t => t.task_path === taskPath)`
 *   反查 taskId → ① 冗余（每次 fire 一次全量目录读 + 解析）；② 潜在歧义：两个任务共用同一
 *   task_path 时 `find` 只取第一个 → 唤醒（冷却 / 投递）按错误 taskId 串扰。
 *
 * 修复：
 *   1) 契约收紧为 `run(taskId, taskPath)`，scheduler 直接透传 `fire` 的 id；
 *   2) 编排层删除 `store.list()` 反查（含「未找到 → skipped」分支），直接用入参 taskId。
 *
 * 本文件覆盖：
 *   A. 契约层：scheduler → runner 传递的 taskId 与触发任务严格一致
 *      （同 task_path 两任务各自携带自己的 id，不再一律取「首个同 path」）。
 *   B. 编排层：不再按 task_path 反查 taskId；同 task_path 两任务唤醒各自按自身 id 投递，
 *      不串扰；即便 store 中查无该路径，也直接采用传入 id（证明反查已移除）。
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
// vi.hoisted：可变替身 + 装配捕获（供 vi.mock 工厂读取，避免 TDZ）
// ---------------------------------------------------------------------------
const H = vi.hoisted(() => ({
  loaderImpl: { value: null as unknown },
  runnerImpl: { value: null as unknown },
  wakerImpl: { value: null as unknown },
  cap: { scheduler: null as unknown, options: null as unknown },
}))

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
    createWaker: (opts?: unknown) =>
      H.wakerImpl.value ?? actual.createWaker(opts as never),
  }
})
vi.mock('../src/scheduler/scheduler.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/scheduler/scheduler.js')>()
  return {
    ...actual,
    createScheduler: (options: any) => {
      const s: any = actual.createScheduler(options)
      H.cap.scheduler = s
      H.cap.options = options
      return s
    },
  }
})

import { createScheduler } from '../src/scheduler/scheduler.js'
import { applyScheduler } from '../src/scheduler/index.js'

// ===========================================================================
// A. 契约层：scheduler → runner 携带正确 taskId（同 task_path，各自 id）
// ===========================================================================
class FakeStore {
  constructor(public tasks: TaskDef[] = [], public corrupted: string[] = []) {}
  list() {
    return { tasks: this.tasks.slice(), corrupted: this.corrupted.slice() }
  }
}
class FakeTimer implements Timer {
  timers: { at: number; cb: () => void; id: number }[] = []
  lastId = 0
  constructor(private clock: Clock) {}
  setTimer(delayMs: number, cb: () => void): TimerHandle {
    const id = ++this.lastId
    this.timers.push({ at: this.clock.now().getTime() + delayMs, cb, id })
    return id as unknown as TimerHandle
  }
  clearTimer(): void {
    /* noop */
  }
  fireDue(nowMs: number): void {
    const due = this.timers.filter((t) => t.at <= nowMs).sort((a, b) => a.at - b.at)
    this.timers = this.timers.filter((t) => t.at > nowMs)
    for (const t of due) t.cb()
  }
}
class FakeClock implements Clock {
  constructor(private current: Date) {}
  now(): Date {
    return this.current
  }
  set(d: Date): void {
    this.current = d
  }
}
/** 记录 (taskId, taskPath) 二元组的 runner 替身。 */
class RecordingRunner {
  calls: Array<{ id: string; path: string }> = []
  run(taskId: string, taskPath: string): Promise<TaskRunOutcome> {
    this.calls.push({ id: taskId, path: taskPath })
    return Promise.resolve({ kind: 'quiet', reason: 'ok' })
  }
}

const SHARED_PATH = '/tasks/shared/task.ts'
function makeTask(id: string, overrides: Partial<TaskDef> = {}): TaskDef {
  return {
    id,
    name: `任务-${id}`,
    cron: '* * * * *',
    task_path: SHARED_PATH, // 两个任务共用同一 task_path（旧实现反查必串）
    enabled: true,
    ...overrides,
  }
}

describe('t100411-A 契约：scheduler 透传触发任务自己的 taskId', () => {
  const BASE = new Date('2026-10-08T08:00:00Z')

  it('两个任务共用同一 task_path → runner 分别收到各自 taskId（不再一律取首个）', async () => {
    const store = new FakeStore([makeTask('a'), makeTask('b')])
    const runner = new RecordingRunner()
    const clock = new FakeClock(BASE)
    const timer = new FakeTimer(clock)
    const s = createScheduler({ store, runner, timer, clock })
    s.start()

    // 两个任务同 cron，同一时刻到点；推进到最早到点并触发。
    const earliest = timer.timers.reduce(
      (min, t) => (t.at < min ? t.at : min),
      Number.POSITIVE_INFINITY,
    )
    clock.set(new Date(earliest))
    timer.fireDue(earliest)
    await vi.waitFor(() => expect(runner.calls).toHaveLength(2))

    // 关键断言：两次触发的 task_path 相同，但 taskId 各自独立、无串扰。
    expect(new Set(runner.calls.map((c) => c.path))).toEqual(new Set([SHARED_PATH]))
    expect(new Set(runner.calls.map((c) => c.id))).toEqual(new Set(['a', 'b']))

    s.stop()
  })
})

// ===========================================================================
// B. 编排层：不再按 task_path 反查 taskId
// ===========================================================================
interface FakeCtx {
  injects: Array<{ deps: string[]; cb: (ctx: any) => void }>
  effects: Array<{ label?: string; dispose: () => void }>
  get(name: string): unknown
  inject(deps: string[], cb: (ctx: any) => void): () => void
  effect(body: () => void | (() => void), label?: string): () => void
}
function makeCtx(): FakeCtx {
  const injects: FakeCtx['injects'] = []
  const effects: FakeCtx['effects'] = []
  return {
    injects,
    effects,
    get: () => undefined,
    inject(deps, cb) {
      injects.push({ deps, cb })
      return () => {}
    },
    effect(body, label) {
      const d = body()
      const dispose = typeof d === 'function' ? d : () => {}
      effects.push({ label, dispose })
      return dispose
    },
  }
}

const tmpDirs: string[] = []
function mkTmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'dsh-t100411-'))
  tmpDirs.push(d)
  return d
}
/** 写任务清单记录（可选补齐入口文件）。 */
function writeTaskDef(dataRoot: string, def: Record<string, unknown>, withEntry: boolean): void {
  const dir = join(dataRoot, 'tasks')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${String(def.id)}.json`), JSON.stringify(def), 'utf8')
  if (withEntry) {
    const abs = resolve(dataRoot, String(def.task_path))
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, '// entry\n', 'utf8')
  }
}

let activeCtx: FakeCtx | null = null
function disposeCtx(ctx: FakeCtx | null): void {
  if (!ctx) return
  for (const e of ctx.effects) {
    try {
      e.dispose()
    } catch {
      /* ignore */
    }
  }
}
function boot(dataRoot: string): FakeCtx {
  disposeCtx(activeCtx)
  const ctx = makeCtx()
  activeCtx = ctx
  applyScheduler(ctx, { dataRoot, logger: () => {} })
  // 触发 agents 动态注入 → 令编排层 waker 就绪（H.wakerImpl 替身）。
  ctx.injects[0]?.cb({ get: () => ({ get: () => ({ id: 'investment-advisor', followup() {} }) }) })
  return ctx
}
function orch(): { run: (taskId: string, taskPath: string) => Promise<any> } {
  return (H.cap.options as { runner: any }).runner
}

describe('t100411-B 编排层不再按 task_path 反查 taskId', () => {
  beforeEach(() => {
    H.loaderImpl.value = { installTaskDeps: vi.fn(async () => {}) }
    H.runnerImpl.value = {
      run: vi.fn(async () => ({ kind: 'woke', reason: 'w', data: 'SIG', targets: [] })),
    }
  })
  afterEach(() => {
    disposeCtx(activeCtx)
    activeCtx = null
    H.loaderImpl.value = null
    H.runnerImpl.value = null
    H.wakerImpl.value = null
    H.cap.options = null
    for (const d of tmpDirs.splice(0)) {
      try {
        rmSync(d, { recursive: true, force: true })
      } catch {
        /* ignore */
      }
    }
  })

  it('B1 同 task_path 两任务：按传入 taskId 各自投递，不串扰（wake 收到 ' +
    'b 而非首个 a）', async () => {
    const dataRoot = mkTmp()
    // a、b 共用同一 task_path；a 的清单文件名在前（store 读取顺序 a 先于 b）。
    writeTaskDef(dataRoot, { id: 'a', name: 'A', cron: '0 9 * * *', task_path: 'tasks/shared/task.ts', enabled: true }, true)
    writeTaskDef(dataRoot, { id: 'b', name: 'B', cron: '0 9 * * *', task_path: 'tasks/shared/task.ts', enabled: true }, true)

    const wake = vi.fn((id: string, _data: unknown) => ({
      delivered: true,
      count: 1,
      targets: ['investment-advisor'],
      reason: 'ok',
    }))
    H.wakerImpl.value = { wake }

    boot(dataRoot)
    const out = await orch().run('b', 'tasks/shared/task.ts')

    expect(out.kind).toBe('woke')
    // 关键：投递按传入的 taskId='b'，而非旧实现反查得到的首个同 path 任务 'a'。
    expect(wake).toHaveBeenCalledTimes(1)
    expect(wake.mock.calls[0][0]).toBe('b')
  })

  it('B2 store 中查无该路径：直接采用传入 taskId 执行（证明反查已移除）', async () => {
    const dataRoot = mkTmp()
    // 清单为空（不含任何任务），但入口文件存在。
    mkdirSync(join(dataRoot, 'tasks'), { recursive: true })
    const abs = resolve(dataRoot, 'tasks/only-by-arg/task.ts')
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, '// entry\n', 'utf8')

    const wake = vi.fn((id: string, _data: unknown) => ({
      delivered: true,
      count: 1,
      targets: ['investment-advisor'],
      reason: 'ok',
    }))
    H.wakerImpl.value = { wake }

    boot(dataRoot)
    // 旧实现会因 store.list() 反查不到 → skipped；新实现直接用入参 id 跑通并投递。
    const out = await orch().run('only-by-arg', 'tasks/only-by-arg/task.ts')

    expect(out.kind).toBe('woke')
    expect(wake.mock.calls[0][0]).toBe('only-by-arg')
  })
})
