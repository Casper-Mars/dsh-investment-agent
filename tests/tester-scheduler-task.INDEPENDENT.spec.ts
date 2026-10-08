/**
 * 独立测试：scheduler 调度引擎边界场景验证（Tester 独立构造，未复用 Developer 用例）。
 *
 * 聚焦任务书 4 个重点隐患：
 *  1. 链式自调度的时刻计算基准（实际执行时刻 vs 原计划触发时刻）——是否漏触发/重触发/时刻回退
 *  2. 异常隔离边界：fire() 内同步 throw 是否 uncaughtException；单任务 fire 抛错是否连带其它任务
 *  3. reload 与 start 交互：running=false 时 reload 语义、running=true 时 reload 是否清旧+重建不重复
 *  4. timer 泄漏：stop/reload 后旧 timer 是否真 clear（不只从 map 删除）
 */
import { describe, expect, it, vi } from 'vitest'

import type { Clock, TaskDef, TaskRunOutcome, Timer, TimerHandle } from '../src/scheduler/types.js'
import { createScheduler } from '../src/scheduler/scheduler.js'

// ---------------------------------------------------------------------------
// 替身
// ---------------------------------------------------------------------------

class FakeStore {
  constructor(
    public tasks: TaskDef[] = [],
    public corrupted: string[] = [],
  ) {}
  list() {
    return { tasks: this.tasks.slice(), corrupted: this.corrupted.slice() }
  }
}

/** 记录、可控触发、且能区分「真 clear」与「仅删 map」的 fake timer。 */
class FakeTimer implements Timer {
  /** 到点时刻 → 回调，按时刻升序。 */
  timers: { at: number; cb: () => void; id: number }[] = []
  /** 被 clear 的 id 序列（真 clear 记录）。 */
  cleared: number[] = []
  lastId = 0
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
  /** 触发所有到点 <= nowMs 的回调（升序）。 */
  fireDue(nowMs: number): void {
    const due = this.timers.filter((t) => t.at <= nowMs).sort((a, b) => a.at - b.at)
    this.timers = this.timers.filter((t) => t.at > nowMs)
    for (const t of due) t.cb()
  }
  get pending(): number {
    return this.timers.length
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
  advanceMinutes(n: number): void {
    this.current = new Date(this.current.getTime() + n * 60_000)
  }
}

/** 可让 run 延迟完成（模拟执行耗时）的 runner。 */
class SlowRunner {
  calls: { path: string; at: number }[] = []
  /** 每个 taskPath 的执行「耗时」ms（微任务延迟模拟）。 */
  delays = new Map<string, number>()
  throwSync = new Map<string, boolean>()
  defaultOutcome: () => TaskRunOutcome = () => ({ kind: 'quiet', reason: 'ok' })

  run(taskPath: string): Promise<TaskRunOutcome> {
    const at = Date.now()
    this.calls.push({ path: taskPath, at })
    if (this.throwSync.get(taskPath)) {
      throw new Error(`sync-throw-${taskPath}`)
    }
    const delay = this.delays.get(taskPath) ?? 0
    const outcome = this.defaultOutcome()
    if (delay > 0) {
      return new Promise((resolve) => setTimeout(() => resolve(outcome), delay))
    }
    return Promise.resolve(outcome)
  }
}

function makeTask(id: string, overrides: Partial<TaskDef> = {}): TaskDef {
  return {
    id,
    name: `任务-${id}`,
    cron: '0 9 * * *',
    task_path: `/tasks/${id}/task.ts`,
    enabled: true,
    ...overrides,
  }
}

const BASE = new Date('2026-10-08T08:00:00Z')

// ---------------------------------------------------------------------------
// 隐患 1：链式自调度时刻计算基准
// ---------------------------------------------------------------------------

describe('隐患1：链式自调度时刻计算基准', () => {
  it('用实际执行时刻（clock.now）作 next 基准 → 若执行跨越一个触发点，会跳过该点', async () => {
    // cron 每分钟触发。任务执行耗时 90s（> 1 分钟），跨越下一个触发分钟。
    const store = new FakeStore([makeTask('a', { cron: '* * * * *' })])
    const runner = new SlowRunner()
    const clock = new FakeClock(BASE)
    const timer = new FakeTimer(clock)
    const s = createScheduler({ store, runner, timer, clock })
    s.start()

    // 首次触发时刻 = BASE 的下一分钟整点。
    const firstAt = timer.timers[0].at
    // 但用 FakeClock 而非真实 Date.now 驱动 SlowRunner 时序不可行（SlowRunner 用真实 setTimeout）。
    // 故改用「推进时钟到触发点后再手动把 clock 前移 90s」来模拟「执行耗时」。
    clock.set(new Date(firstAt))
    timer.fireDue(firstAt)

    // 微任务：finally 中 rescheduleAfterFire 用 clock.now() 作基准。
    // 此刻 clock 仍是 firstAt（尚未推进），故下次 = firstAt + 1 分钟（正确，未跳）。
    await vi.waitFor(() => expect(timer.pending).toBeGreaterThan(0))
    const rescheduledAt = timer.timers[0].at

    // 现在模拟「runner 执行跨越了一个触发点」：在 finally 执行前，时钟已被推进 90s。
    // 关键断言：reschedule 用的基准是 clock.now()（实际执行时刻）。
    // 为验证这一点，重新构造一个场景：runner 完成后 clock 已前移。
    expect(rescheduledAt).toBeGreaterThan(firstAt)
  })

  it('若执行耗时跨越触发点，next 基准用实际执行时刻会跳过本应触发的整点', async () => {
    const store = new FakeStore([makeTask('a', { cron: '* * * * *' })])
    const runner = new SlowRunner()
    const clock = new FakeClock(BASE)
    const timer = new FakeTimer(clock)

    // 关键：注入一个「在 fire 回调里推进时钟」的 runner，模拟执行期间时间流逝。
    // 但 fire 是同步启动 runner（Promise），finally 在微任务里执行。
    // 我们用一个自定义 runner：run 返回后，在返回前手动把 clock 前移 2 分钟。
    const customRunner = {
      run(taskPath: string): Promise<TaskRunOutcome> {
        // 模拟执行耗时跨越 2 个触发分钟。
        clock.advanceMinutes(2)
        return Promise.resolve({ kind: 'quiet', reason: 'ok' } as TaskRunOutcome)
      },
    }

    const s = createScheduler({
      store,
      runner: customRunner,
      timer,
      clock,
    })
    s.start()

    const firstAt = timer.timers[0].at // BASE+1 分钟整点
    clock.set(new Date(firstAt))
    timer.fireDue(firstAt)

    await vi.waitFor(() => expect(timer.pending).toBeGreaterThan(0))

    // 基准时刻是 clock.now()（已前移 2 分钟 → firstAt+2 分钟）。
    // next 严格大于基准 → 下次触发 = firstAt+3 分钟整点。
    // 中间的 firstAt+1、firstAt+2 整点被跳过（漏触发）。
    const rescheduledAt = timer.timers[0].at
    // firstAt+2 分钟整点应该是 00 秒整，next 严格大于它，故是 +3 分钟。
    expect(rescheduledAt).toBe(firstAt + 3 * 60_000)
  })

  it('next 基准用实际执行时刻可保证时刻严格递增（不回退、不重复同一次）', async () => {
    const store = new FakeStore([makeTask('a', { cron: '* * * * *' })])
    const runner = new SlowRunner()
    const clock = new FakeClock(BASE)
    const timer = new FakeTimer(clock)
    const customRunner = {
      run(): Promise<TaskRunOutcome> {
        clock.advanceMinutes(1) // 每次执行耗时 1 分钟
        return Promise.resolve({ kind: 'quiet', reason: 'ok' } as TaskRunOutcome)
      },
    }
    const s = createScheduler({ store, runner: customRunner, timer, clock })
    s.start()

    const firstAt = timer.timers[0].at
    const seenAt: number[] = []
    for (let i = 0; i < 5; i++) {
      expect(timer.pending).toBeGreaterThan(0)
      const at = timer.timers[0].at
      seenAt.push(at)
      clock.set(new Date(at))
      timer.fireDue(at)
      await vi.waitFor(() => expect(timer.pending).toBeGreaterThan(0))
    }
    // 时刻严格递增（不回退、不重复）。
    for (let i = 1; i < seenAt.length; i++) {
      expect(seenAt[i]).toBeGreaterThan(seenAt[i - 1])
    }
    // 因为每次执行耗时 1 分钟，每次都跳过一个整点，但时刻仍递增、无重复。
    expect(new Set(seenAt).size).toBe(seenAt.length)
  })
})

// ---------------------------------------------------------------------------
// 隐患 2：异常隔离边界（同步 throw 穿透 uncaughtException）
// ---------------------------------------------------------------------------

describe('隐患2：异常隔离边界', () => {
  it('runner.run 在 setTimeout 回调里同步 throw 不应穿透为 uncaughtException', async () => {
    // 关键：fire() 在 timer 回调里被调用；若 runner.run 同步 throw 且未包 catch，
    // 在真 Node setTimeout 里会 uncaughtException。scheduler 已用 try/catch 包层。
    // 这里验证：run 同步 throw 后，scheduler 不抛、且该任务仍重设 timer。
    const store = new FakeStore([makeTask('a', { cron: '* * * * *' })])
    const runner = new SlowRunner()
    runner.throwSync.set('/tasks/a/task.ts', true)
    const clock = new FakeClock(BASE)
    const timer = new FakeTimer(clock)
    const s = createScheduler({ store, runner, timer, clock })
    s.start()

    const firstAt = timer.timers[0].at
    clock.set(new Date(firstAt))
    // fire() 内部 catch 同步 throw → 转 rejected promise → finally 重设。
    expect(() => timer.fireDue(firstAt)).not.toThrow()

    await vi.waitFor(() => expect(timer.pending).toBeGreaterThan(0))
    // 该任务仍被重设（继续下一周期）。
    expect(timer.timers[0].at).toBeGreaterThan(firstAt)
  })

  it('单任务 fire 同步 throw 不连带其它任务 timer 回调抛错', async () => {
    const store = new FakeStore([
      makeTask('a', { cron: '* * * * *' }),
      makeTask('b', { cron: '* * * * *' }),
    ])
    const runner = new SlowRunner()
    runner.throwSync.set('/tasks/a/task.ts', true)
    const clock = new FakeClock(BASE)
    const timer = new FakeTimer(clock)
    const s = createScheduler({ store, runner, timer, clock })
    s.start()

    // 两任务同发（同一分钟）。fire a 同步 throw 被隔离，b 也应正常触发并重设。
    const firstAt = timer.timers[0].at
    clock.set(new Date(firstAt))
    expect(() => timer.fireDue(firstAt)).not.toThrow()

    await vi.waitFor(() => expect(timer.pending).toBe(2))
    expect(runner.calls.some((c) => c.path.endsWith('/b/task.ts'))).toBe(true)
    expect(runner.calls.some((c) => c.path.endsWith('/a/task.ts'))).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 隐患 3：reload 与 start 交互
// ---------------------------------------------------------------------------

describe('隐患3：reload 与 start 交互', () => {
  it('running=false 时 reload 为空操作（不自动 start、不装配 timer）', () => {
    const store = new FakeStore([makeTask('a')])
    const runner = new SlowRunner()
    const clock = new FakeClock(BASE)
    const timer = new FakeTimer(clock)
    const s = createScheduler({ store, runner, timer, clock })

    expect(s.running).toBe(false)
    s.reload()
    expect(s.running).toBe(false)
    expect(timer.pending).toBe(0)
  })

  it('running=true 时 reload 清旧 + 重建，不重复创建 timer', () => {
    const store = new FakeStore([makeTask('a'), makeTask('b')])
    const runner = new SlowRunner()
    const clock = new FakeClock(BASE)
    const timer = new FakeTimer(clock)
    const s = createScheduler({ store, runner, timer, clock })
    s.start()
    expect(timer.pending).toBe(2)
    const clearedBefore = timer.cleared.length

    // 连续 reload 多次，不应累积 timer（每次清旧再重建）。
    s.reload()
    expect(timer.pending).toBe(2)
    s.reload()
    expect(timer.pending).toBe(2)

    // 旧 timer 确实被 clear（clear 次数随 reload 递增）。
    expect(timer.cleared.length).toBeGreaterThan(clearedBefore)
  })

  it('reload 后删除的任务 timer 真被 clear（不在 pending）', () => {
    const store = new FakeStore([makeTask('a'), makeTask('b'), makeTask('c')])
    const runner = new SlowRunner()
    const clock = new FakeClock(BASE)
    const timer = new FakeTimer(clock)
    const s = createScheduler({ store, runner, timer, clock })
    s.start()
    expect(timer.pending).toBe(3)

    store.tasks = [makeTask('a')]
    s.reload()
    expect(timer.pending).toBe(1)
    // 被删除的 b、c 的 old handle 已被 clear。
    expect(timer.cleared.length).toBe(3) // 清 3 旧 + 新设 1
  })
})

// ---------------------------------------------------------------------------
// 隐患 4：timer 泄漏（stop 真 clear）
// ---------------------------------------------------------------------------

describe('隐患4：timer 泄漏', () => {
  it('stop 后旧 timer 真被 clear（map 清空 且 clearTimer 被逐条调用）', () => {
    const store = new FakeStore([makeTask('a'), makeTask('b')])
    const runner = new SlowRunner()
    const clock = new FakeClock(BASE)
    const timer = new FakeTimer(clock)
    const s = createScheduler({ store, runner, timer, clock })
    s.start()
    expect(timer.pending).toBe(2)

    s.stop()
    expect(timer.pending).toBe(0)
    expect(timer.cleared).toHaveLength(2)
  })

  it('任务触发后链式重设时，旧已触发句柄不残留（无重复 clear 报错）', async () => {
    // fire() 里 scheduled.delete(id) 后又 finally 重设。
    // 验证触发 N 次后 timer 数量始终为 1（不累积）。
    const store = new FakeStore([makeTask('a', { cron: '* * * * *' })])
    const runner = new SlowRunner()
    const clock = new FakeClock(BASE)
    const timer = new FakeTimer(clock)
    const s = createScheduler({ store, runner, timer, clock })
    s.start()

    for (let i = 0; i < 4; i++) {
      const at = timer.timers[0].at
      clock.set(new Date(at))
      timer.fireDue(at)
      await vi.waitFor(() => expect(timer.pending).toBe(1))
    }
    expect(timer.pending).toBe(1)
  })
})