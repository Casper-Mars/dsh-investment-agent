/**
 * scheduler/scheduler.ts 单元测试。
 *
 * 唯一权威设计文档：《感知层详细设计（dsh-ia 插件）》 v0.7。
 *
 * 覆盖任务卡验收点（AC-2 多任务模型 / AC-9 调度 / §7 调度器设计）：
 * - 幂等：start 两次不双份 timer；stop 两次不抛错；running 只读反映状态
 * - 独立 timer：每个 enabled 任务独立 cron next 计算，互不阻塞
 * - 链式自调度：任务触发后正确重算并重设下次 timer（fake timer 驱动连续触发 N 次）
 * - 异常隔离：runner reject / 抛错不中断调度链，且该任务仍重设 timer
 * - reload 全量重建：新增启用任务被调度、删除任务 timer 被清除、cron 变更按新 cron 重算
 * - cron 非法 / task_path 缺失 → 跳过该任务继续其它
 * - 停止无泄漏：stop 后所有 timer 被 clear
 * - 全可注入：store / runner / cron / timer / clock
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { Clock, TaskDef, TaskRunOutcome, Timer, TimerHandle } from '../src/scheduler/types.js'
import { createScheduler, Scheduler } from '../src/scheduler/scheduler.js'

// ---------------------------------------------------------------------------
// 可注入测试替身
// ---------------------------------------------------------------------------

/** 内存任务清单 source（可编程 tasks / corrupted）。 */
class FakeStore {
  constructor(
    public tasks: TaskDef[] = [],
    public corrupted: string[] = [],
  ) {}
  list() {
    return { tasks: this.tasks.slice(), corrupted: this.corrupted.slice() }
  }
}

/** 内存 fake timer（不用 vitest fake timers，直接可控）。 */
class FakeTimer implements Timer {
  /** 已排定的「到点时刻 → 回调」队列（按时刻升序）。 */
  timers: { at: number; cb: () => void; id: number }[] = []
  cleared: number[] = []
  lastId = 0
  /** 时钟引用（取当前时刻以把相对 delay 换算成绝对到点时刻）。 */
  constructor(private clock: Clock) {}

  setTimer(delayMs: number, cb: () => void): TimerHandle {
    const id = ++this.lastId
    this.timers.push({ at: this.clock.now().getTime() + delayMs, cb, id })
    return id as unknown as TimerHandle
  }
  clearTimer(handle: TimerHandle): void {
    const id = handle as unknown as number
    this.cleared.push(id)
    this.timers = this.timers.filter((t) => t.id !== id)
  }
  /** 触发到点时间 <= nowMs 的所有回调（模拟真实时钟推进）。 */
  fireDue(nowMs: number): void {
    const due = this.timers.filter((t) => t.at <= nowMs).sort((a, b) => a.at - b.at)
    this.timers = this.timers.filter((t) => t.at > nowMs)
    for (const t of due) t.cb()
  }
  /** 剩余未触发 timer 数。 */
  get pending(): number {
    return this.timers.length
  }
}

/** 可控时钟。 */
class FakeClock implements Clock {
  constructor(private current: Date) {}
  now(): Date {
    return this.current
  }
  set(d: Date): void {
    this.current = d
  }
  advanceMinutes(n: number): void {
    this.current = new Date(this.current.getTime() + n * 60_000)
  }
}

/** 记录 runner.run 调用并按任务 id 返回指定结局/异常的 runner 替身。 */
class FakeRunner {
  calls: string[] = []
  /** 按 taskPath（或含 id 的路径）返回结局；缺省走 defaultOutcome。 */
  outcomes = new Map<string, () => TaskRunOutcome | Promise<TaskRunOutcome>>()
  defaultOutcome: () => TaskRunOutcome = () => ({ kind: 'quiet', reason: 'ok' })

  run(taskId: string, taskPath: string): Promise<TaskRunOutcome> {
    this.calls.push(taskPath)
    const fn = this.outcomes.get(taskPath)
    const result = fn ? fn() : this.defaultOutcome()
    return Promise.resolve(result)
  }
}

/** 记录并数 timer 的 observer（配合真实 setTimeout 校验 clear 被调 —— 用 fake timer 替代）。 */

/** 构造一个合法 TaskDef。 */
function makeTask(id: string, overrides: Partial<TaskDef> = {}): TaskDef {
  return {
    id,
    name: `任务-${id}`,
    cron: '0 9 * * *',
    task_path: `/assets/programs/${id}/task.ts`,
    enabled: true,
    ...overrides,
  }
}

/** 基准「当前」时刻：2026-10-08 08:00:00 UTC = 16:00 Asia/Shanghai。 */
const BASE = new Date('2026-10-08T08:00:00Z')

// ---------------------------------------------------------------------------
// 测试
// ---------------------------------------------------------------------------

describe('Scheduler 生命周期与幂等', () => {
  let store: FakeStore
  let runner: FakeRunner
  let timer: FakeTimer
  let clock: FakeClock

  beforeEach(() => {
    store = new FakeStore()
    runner = new FakeRunner()
    clock = new FakeClock(BASE)
    timer = new FakeTimer(clock)
  })

  it('start 后 running 为 true，未 start 为 false', () => {
    const s = createScheduler({ store, runner, timer, clock })
    expect(s.running).toBe(false)
    s.start()
    expect(s.running).toBe(true)
  })

  it('start 幂等：两次 start 不产生双份 timer', () => {
    store.tasks = [makeTask('a'), makeTask('b')]
    const s = createScheduler({ store, runner, timer, clock })

    s.start()
    const afterFirst = timer.pending
    s.start() // 第二次 start 应空操作
    expect(timer.pending).toBe(afterFirst)
    expect(afterFirst).toBe(2)
  })

  it('stop 幂等：两次 stop 不抛错，running 变 false', () => {
    store.tasks = [makeTask('a')]
    const s = createScheduler({ store, runner, timer, clock })

    s.start()
    s.stop()
    expect(s.running).toBe(false)
    expect(() => s.stop()).not.toThrow()
    expect(s.running).toBe(false)
  })

  it('stop 清空所有 timer（无泄漏）', () => {
    store.tasks = [makeTask('a'), makeTask('b'), makeTask('c')]
    const s = createScheduler({ store, runner, timer, clock })

    s.start()
    expect(timer.pending).toBe(3)

    s.stop()
    expect(timer.pending).toBe(0)
  })

  it('running 是只读 getter（无 setter）', () => {
    const s = createScheduler({ store, runner, timer, clock })
    const proto = Object.getPrototypeOf(s)
    const desc = Object.getOwnPropertyDescriptor(proto, 'running')
    expect(desc?.get).toBeDefined()
    expect(desc?.set).toBeUndefined()
  })
})

describe('多 timer 独立调度', () => {
  let store: FakeStore
  let runner: FakeRunner
  let timer: FakeTimer
  let clock: FakeClock

  beforeEach(() => {
    store = new FakeStore()
    runner = new FakeRunner()
    clock = new FakeClock(BASE)
    timer = new FakeTimer(clock)
  })

  it('每个 enabled 任务独立 timer（数量 = enabled 任务数）', () => {
    store.tasks = [
      makeTask('a'),
      makeTask('b'),
      makeTask('c', { enabled: false }), // 禁用跳过
    ]
    const s = createScheduler({ store, runner, timer, clock })
    s.start()
    expect(timer.pending).toBe(2)
  })

  it('每个任务按各自 cron 计算不同下次触发（独立 next）', () => {
    store.tasks = [
      makeTask('a', { cron: '0 9 * * *' }), // 明天 09:00
      makeTask('b', { cron: '30 10 * * *' }), // 明天 10:30
    ]
    const s = createScheduler({ store, runner, timer, clock })
    s.start()

    // 两个 timer 的到点时刻应不同。
    const times = timer.timers.map((t) => t.at).sort((x, y) => x - y)
    expect(times).toHaveLength(2)
    expect(times[0]).not.toBe(times[1])
  })

  it('一个任务触发不影响另一个任务的 timer', async () => {
    store.tasks = [
      makeTask('a', { cron: '0 9 * * *' }),
      makeTask('b', { cron: '30 10 * * *' }),
    ]
    const s = createScheduler({ store, runner, timer, clock })
    s.start()

    expect(timer.pending).toBe(2)

    // a 的到点时刻早于 b。记录 b 的到点时刻，并触发 a。
    const aEntry = timer.timers.reduce((min, t) => (t.at < min.at ? t : min))
    const bEntry = timer.timers.reduce((max, t) => (t.at > max.at ? t : max))
    clock.set(new Date(aEntry.at))
    timer.fireDue(aEntry.at)

    // a 触发后重设了自己的 timer（下一周期，微任务内），b 的 timer 未被清除。
    await vi.waitFor(() => expect(timer.pending).toBe(2))
    // b 的原到点时刻未被触发（仍存在一个到点时刻 = bEntry.at）。
    expect(timer.timers.some((t) => t.at === bEntry.at)).toBe(true)
  })
})

describe('链式自调度（fake timer 驱动连续触发）', () => {
  let store: FakeStore
  let runner: FakeRunner
  let timer: FakeTimer
  let clock: FakeClock

  beforeEach(() => {
    store = new FakeStore()
    runner = new FakeRunner()
    clock = new FakeClock(BASE)
    timer = new FakeTimer(clock)
  })

  it('一个任务能连续触发 N 次（每次触发后重设下次 timer）', async () => {
    // 每分钟触发一次（`* * * * *` = 每分钟）。
    store.tasks = [makeTask('a', { cron: '* * * * *' })]
    const s = createScheduler({ store, runner, timer, clock })
    s.start()

    // start 时 next(now) 严格大于 now，故首次触发在 BASE 的下一分钟整点。
    // 用 fake timer：反复推进时钟到「当前最早到点时刻」并触发，每次触发后等微任务重设。
    const N = 3
    for (let i = 0; i < N; i++) {
      expect(timer.timers.length).toBeGreaterThan(0)
      const earliest = timer.timers.reduce(
        (min, t) => (t.at < min ? t.at : min),
        Number.POSITIVE_INFINITY,
      )
      expect(earliest).not.toBe(Number.POSITIVE_INFINITY)
      // 推进时钟到 earliest 并触发。
      clock.set(new Date(earliest))
      timer.fireDue(earliest)
      // 等 runner 的 then/finally 微任务把下一次 timer 重建出来。
      await vi.waitFor(() => expect(timer.timers.length).toBeGreaterThan(0))
    }

    // 连续触发 3 次 → runner.run 被调用 3 次。
    expect(runner.calls.filter((p) => p.endsWith('/a/task.ts'))).toHaveLength(N)
  })

  it('触发后下一次触发时刻大于当前时刻（严格递增）', async () => {
    store.tasks = [makeTask('a', { cron: '*/5 * * * *' })] // 每 5 分钟
    const s = createScheduler({ store, runner, timer, clock })
    s.start()

    expect(timer.timers).toHaveLength(1)
    const firstAt = timer.timers[0].at
    // 触发第一次：推进时钟到 firstAt。
    clock.set(new Date(firstAt))
    timer.fireDue(firstAt)
    // 应重设出新的 timer（微任务内）。
    await vi.waitFor(() => expect(timer.timers).toHaveLength(1))
    const secondAt = timer.timers[0].at
    expect(secondAt).toBeGreaterThan(firstAt)
  })
})

describe('异常隔离', () => {
  let store: FakeStore
  let runner: FakeRunner
  let timer: FakeTimer
  let clock: FakeClock

  beforeEach(() => {
    store = new FakeStore()
    runner = new FakeRunner()
    clock = new FakeClock(BASE)
    timer = new FakeTimer(clock)
  })

  it('runner.run 返回 rejected Promise → 不抛出，且该任务仍重设 timer', async () => {
    store.tasks = [
      makeTask('a', { cron: '* * * * *' }),
      makeTask('b', { cron: '* * * * *' }),
    ]
    // a 会 reject。
    runner.outcomes.set('/assets/programs/a/task.ts', () => Promise.reject(new Error('boom')))
    const s = createScheduler({ store, runner, timer, clock })
    s.start()

    const before = timer.pending
    expect(before).toBe(2)

    // 推进到首次触发。
    const earliest = timer.timers.reduce(
      (min, t) => (t.at < min ? t.at : min),
      Number.POSITIVE_INFINITY,
    )
    clock.set(new Date(earliest))
    timer.fireDue(earliest)

    // 让微任务（reject 的 catch + finally）跑完。
    await vi.waitFor(() => {
      expect(runner.calls).toContain('/assets/programs/a/task.ts')
    })

    // 两个任务都应重设 timer（a 的 reject 被隔离，仍重设）。
    await vi.waitFor(() => expect(timer.pending).toBe(2))
  })

  it('runner.run 同步抛错（Promise 内 reject）不影响其它任务触发', async () => {
    store.tasks = [
      makeTask('a', { cron: '* * * * *' }),
      makeTask('b', { cron: '* * * * *' }),
    ]
    runner.outcomes.set('/assets/programs/a/task.ts', () => {
      throw new Error('sync boom')
    })
    const s = createScheduler({ store, runner, timer, clock })
    s.start()

    const earliest = timer.timers.reduce(
      (min, t) => (t.at < min ? t.at : min),
      Number.POSITIVE_INFINITY,
    )
    clock.set(new Date(earliest))
    timer.fireDue(earliest)

    // 同步抛错被隔离：两个任务都应触发（b 也触发）、且都重设 timer。
    await vi.waitFor(() => {
      expect(runner.calls).toContain('/assets/programs/b/task.ts')
    })
    await vi.waitFor(() => expect(timer.pending).toBe(2))
  })

  it('cron 非法 → 跳过该任务继续其它', () => {
    store.tasks = [
      makeTask('bad', { cron: 'not-a-cron' }),
      makeTask('good', { cron: '0 9 * * *' }),
    ]
    const s = createScheduler({ store, runner, timer, clock })
    s.start()

    expect(timer.pending).toBe(1) // 只有 good。
  })

  it('task_path 缺失 → 跳过该任务继续其它', () => {
    store.tasks = [
      makeTask('nopath', { task_path: '   ' }),
      makeTask('good', { cron: '0 9 * * *' }),
    ]
    const s = createScheduler({ store, runner, timer, clock })
    s.start()

    expect(timer.pending).toBe(1)
  })

  it('corrupted 清单被忽略（store 返回的 corrupted 不影响装配）', () => {
    store.tasks = [makeTask('good')]
    store.corrupted = ['broken1', 'broken2']
    const s = createScheduler({ store, runner, timer, clock })
    s.start()

    expect(timer.pending).toBe(1)
  })

  it('store.list 抛错 → 保持 running=true 但不装配（不崩溃）', () => {
    const badStore = {
      list() {
        throw new Error('store boom')
      },
    }
    const s = createScheduler({
      store: badStore as never,
      runner,
      timer,
      clock,
    })
    expect(() => s.start()).not.toThrow()
    expect(s.running).toBe(true)
    expect(timer.pending).toBe(0)
  })
})

describe('reload 全量重建', () => {
  let store: FakeStore
  let runner: FakeRunner
  let timer: FakeTimer
  let clock: FakeClock

  beforeEach(() => {
    store = new FakeStore()
    runner = new FakeRunner()
    clock = new FakeClock(BASE)
    timer = new FakeTimer(clock)
  })

  it('reload 新增 enabled 任务被调度', () => {
    store.tasks = [makeTask('a')]
    const s = createScheduler({ store, runner, timer, clock })
    s.start()
    expect(timer.pending).toBe(1)

    store.tasks = [makeTask('a'), makeTask('b')]
    s.reload()
    expect(timer.pending).toBe(2)
  })

  it('reload 删除的任务 timer 被清除', () => {
    store.tasks = [makeTask('a'), makeTask('b')]
    const s = createScheduler({ store, runner, timer, clock })
    s.start()
    expect(timer.pending).toBe(2)

    store.tasks = [makeTask('a')]
    s.reload()
    expect(timer.pending).toBe(1)
  })

  it('reload cron 变更 → 按新 cron 重算（到点时刻变化）', () => {
    store.tasks = [makeTask('a', { cron: '0 9 * * *' })]
    const s = createScheduler({ store, runner, timer, clock })
    s.start()
    const beforeAt = timer.timers[0].at

    store.tasks = [makeTask('a', { cron: '30 11 * * *' })]
    s.reload()
    expect(timer.pending).toBe(1)
    expect(timer.timers[0].at).not.toBe(beforeAt)
  })

  it('reload 未 start 时为空操作（不抛错，running 仍 false）', () => {
    store.tasks = [makeTask('a')]
    const s = createScheduler({ store, runner, timer, clock })
    expect(s.running).toBe(false)
    expect(() => s.reload()).not.toThrow()
    expect(s.running).toBe(false)
    expect(timer.pending).toBe(0)
  })
})

describe('stop 无泄漏（clear 被调）', () => {
  let store: FakeStore
  let runner: FakeRunner
  let timer: FakeTimer
  let clock: FakeClock

  beforeEach(() => {
    store = new FakeStore()
    runner = new FakeRunner()
    clock = new FakeClock(BASE)
    timer = new FakeTimer(clock)
  })

  it('stop 后 clearTimer 对每个已排定 timer 调用一次', () => {
    store.tasks = [makeTask('a'), makeTask('b'), makeTask('c')]
    const s = createScheduler({ store, runner, timer, clock })
    s.start()
    expect(timer.timers).toHaveLength(3)

    s.stop()
    expect(timer.cleared).toHaveLength(3)
    expect(timer.pending).toBe(0)
  })

  it('reload 时旧 timer 被 clear', () => {
    store.tasks = [makeTask('a'), makeTask('b')]
    const s = createScheduler({ store, runner, timer, clock })
    s.start()
    const clearedBefore = timer.cleared.length

    store.tasks = [makeTask('a')]
    s.reload()
    // reload 全量重建：清的旧 timer + 新设的 timer。
    expect(timer.pending).toBe(1)
    expect(timer.cleared.length).toBeGreaterThan(clearedBefore)
  })
})

describe('依赖注入（全可注入）', () => {
  it('cron 引擎可注入（可测替身替代真实 cron）', () => {
    const store: FakeStore = new FakeStore([makeTask('a', { cron: 'whatever' })])
    const runner = new FakeRunner()
    const clock = new FakeClock(BASE)
    const timer = new FakeTimer(clock)

    const fakeCron = {
      parseCron: vi.fn(() => ({}) as never),
      next: vi.fn(() => new Date(BASE.getTime() + 60_000)),
    }

    const s = createScheduler({
      store,
      runner,
      timer,
      clock,
      cron: fakeCron as never,
    })
    s.start()

    expect(fakeCron.parseCron).toHaveBeenCalledWith('whatever')
    expect(fakeCron.next).toHaveBeenCalled()
    expect(timer.pending).toBe(1)
  })

  it('默认 cron/timer/clock 缺省可用（factory 不注入也能运转）', () => {
    // 真实 cron（'0 9 * * *'）+ 真实 clock + 原生 timer 集成冒烟：
    // 仅验证 start 不抛错且 running=true（timer 数 ≥1，用真实 setTimeout 会残留，
    // 故这里仅验证状态与不抛错后立刻 stop 清理）。
    const store = new FakeStore([makeTask('a')])
    const runner = new FakeRunner()
    const s = createScheduler({ store, runner })
    s.start()
    expect(s.running).toBe(true)
    s.stop()
    expect(s.running).toBe(false)
  })

  it('log 钩子可注入并在 wiki/诊断路径被调用', () => {
    const store = new FakeStore([makeTask('bad', { cron: 'not-a-cron' })])
    const runner = new FakeRunner()
    const clock = new FakeClock(BASE)
    const timer = new FakeTimer(clock)
    const log = vi.fn()

    const s = createScheduler({ store, runner, timer, clock, log })
    s.start()
    expect(log).toHaveBeenCalled()
  })

  it('解析失败（failureKind=parse）流经 fire 时输出可诊断错误日志（含任务 id + reason/detail）', async () => {
    // §9.1：runner 产出 failed/parse 结局，日志由调度层 fire 统一记录。
    // 兜底断言：解析失败必须可诊断（任务标识 + 具体违约 + 入口路径），而非仅靠代码审查。
    const store = new FakeStore([makeTask('t')])
    const runner = new FakeRunner()
    const clock = new FakeClock(BASE)
    const timer = new FakeTimer(clock)
    const log = vi.fn()

    const reason = '[runner] 任务输出不可解析（无有效结果 JSON）: /assets/programs/t/task.ts'
    const detail =
      'stdout 最后非空行无有效 `{shouldWake,data?}` 单行 JSON（或 shouldWake 非 boolean / data 非 string）'
    runner.defaultOutcome = () => ({
      kind: 'failed',
      failureKind: 'parse',
      reason,
      detail,
    } as TaskRunOutcome)

    const s = createScheduler({ store, runner, timer, clock, log })
    s.start()

    // 推进时钟触发 fire，让 failed/parse 结局流经调度层日志分支。
    const earliest = timer.timers.reduce(
      (min, t) => (t.at < min ? t.at : min),
      Number.POSITIVE_INFINITY,
    )
    clock.set(new Date(earliest))
    timer.fireDue(earliest)

    // runner.run 为 Promise 化的 fire → 等待异步日志落地。
    await vi.waitFor(() => {
      expect(runner.calls).toContain('/assets/programs/t/task.ts')
    })

    // 断言：调度层以 error 级记录失败，内容含任务 id 与 reason/detail 关键片段。
    const errorCalls = log.mock.calls.filter(([level]) => level === 'error')
    expect(errorCalls.length).toBeGreaterThan(0)

    const messages = errorCalls.map(([, msg]) => String(msg))
    const parseMsg = messages.find((m) => m.includes('执行失败'))
    expect(parseMsg).toBeDefined()

    // 任务标识（id）可诊断。
    expect(parseMsg).toContain('任务 t')
    expect(parseMsg).toContain('执行失败')
    // reason 关键片段（含入口路径）。
    expect(parseMsg).toContain('/assets/programs/t/task.ts')
    expect(parseMsg).toContain('无有效结果 JSON')
    // detail 关键片段（区分三种具体违约）。
    expect(parseMsg).toContain('shouldWake 非 boolean')
    expect(parseMsg).toContain('data 非 string')
  })
})

describe('Scheduler 导出形状', () => {
  it('导出 Scheduler 类 + createScheduler 工厂', () => {
    expect(typeof Scheduler).toBe('function')
    expect(typeof createScheduler).toBe('function')
  })

  it('createScheduler 返回 Scheduler 实例', () => {
    const store = new FakeStore()
    const runner = new FakeRunner()
    expect(createScheduler({ store, runner })).toBeInstanceOf(Scheduler)
  })

  it('Scheduler 具备 Scheduler 接口形状（start/stop/reload/running）', () => {
    const s = createScheduler({ store: new FakeStore(), runner: new FakeRunner() })
    expect(typeof s.start).toBe('function')
    expect(typeof s.stop).toBe('function')
    expect(typeof s.reload).toBe('function')
    expect(typeof s.running).toBe('boolean')
  })
})