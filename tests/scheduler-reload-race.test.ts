/**
 * scheduler/scheduler.ts —— 「reload 与正在执行的 fire 竞态」回归测试（P1）。
 *
 * 缺陷（修复前）：
 *   任务 fire() 开头即 `this.scheduled.delete(id)`，随后 `runner.run(id, taskPath)`
 *   异步执行（后台进程可达数十秒）。执行期间若调用 reload()（agent 调 task_update /
 *   create / enable 等写类工具即触发）→ clearAll() + rebuildFromStore() → 为同 id
 *   装 timer A 并 `scheduled.set(id, A)`；旧 fire 的 finally 又调 rescheduleAfterFire()
 *   装 timer B 并覆盖 map —— **timer A 未被清理** → 同 id 两个活跃 timer → 双份触发 +
 *   timer 泄漏（随每次 reload 指数增长）。
 *
 * 修复：采用「代际 / epoch」方案（见 scheduler.ts 内 `epoch` 字段说明）。fire() 记录
 *   触发代际，rescheduleAfterFire() 仅在代际未变（执行期间未 stop/reload）时才补 timer；
 *   clearAll()（stop / reload 均经此）令代际自增，使旧 fire 的补 timer 失效。
 *
 * 本文件覆盖：
 *   1. 【核心】fire 执行中 reload → 旧 fire 不再补 timer：仅 1 个活跃 timer，无泄漏、不双份。
 *   2. reload 竞态后链式自调度未被破坏：后续每周期精确触发 1 次（非 2 次）。
 *   3. fire 执行中 reload 将任务禁用 → 旧 fire 不复活该任务（epoch 方案对边缘的覆盖）。
 *   4. 无 reload 时正常链式调度不受代际守卫影响（连续触发 N 次）。
 *
 * 计时用可控 FakeTimer（非 vi.useFakeTimers），runner 用可手动放行的挂起 Promise，
 * 精确复现「执行中 reload」窗口；微任务链用 `flush()`（让出一个宏任务）确定性跑完。
 */
import { beforeEach, describe, expect, it } from 'vitest'

import type { Clock, TaskDef, TaskRunOutcome, Timer, TimerHandle } from '../src/scheduler/types.js'
import { createScheduler } from '../src/scheduler/scheduler.js'

// ---------------------------------------------------------------------------
// 可控测试替身
// ---------------------------------------------------------------------------

/** 内存任务清单 source。 */
class FakeStore {
  constructor(public tasks: TaskDef[] = []) {}
  list() {
    return { tasks: this.tasks.slice(), corrupted: [] as string[] }
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
}

/** 内存 fake timer（相对 delay 按当前时钟换算为绝对到点时刻）。 */
class FakeTimer implements Timer {
  timers: { at: number; cb: () => void; id: number }[] = []
  cleared: number[] = []
  private lastId = 0
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
  /** 触发到点时间 <= nowMs 的所有回调。 */
  fireDue(nowMs: number): void {
    const due = this.timers.filter((t) => t.at <= nowMs).sort((a, b) => a.at - b.at)
    this.timers = this.timers.filter((t) => t.at > nowMs)
    for (const t of due) t.cb()
  }
  /** 剩余未触发 timer 数（= 活跃 timer 数）。 */
  get pending(): number {
    return this.timers.length
  }
}

/**
 * runner 替身：`run()` 返回「可手动放行」的挂起 Promise，用于模拟长耗时后台执行；
 * 在放行之前 fire 一直处于 in-flight，正好构造「执行中 reload」的竞态窗口。
 */
class DeferredRunner {
  calls: string[] = []
  private pending: Array<(o: TaskRunOutcome) => void> = []

  run(taskId: string, taskPath: string): Promise<TaskRunOutcome> {
    this.calls.push(taskPath)
    return new Promise<TaskRunOutcome>((resolve) => {
      this.pending.push(resolve)
    })
  }

  /** 放行最早一个挂起的执行（默认返回 quiet）。 */
  release(outcome: TaskRunOutcome = { kind: 'quiet', reason: 'ok' }): void {
    const resolve = this.pending.shift()
    if (!resolve) throw new Error('无挂起的 run 可放行')
    resolve(outcome)
  }

  /** 当前挂起（in-flight）的 run 数。 */
  get pendingCount(): number {
    return this.pending.length
  }
}

/** 构造合法 TaskDef。 */
function makeTask(id: string, overrides: Partial<TaskDef> = {}): TaskDef {
  return {
    id,
    name: `任务-${id}`,
    cron: '* * * * *', // 每分钟
    task_path: `/tasks/${id}/task.ts`,
    enabled: true,
    ...overrides,
  }
}

/**
 * 让出一个宏任务，确保 fire 的 Promise 链（then/catch/finally）微任务全部跑完。
 * FakeTimer 为自实现类，未启用 vi.useFakeTimers，故原生 setTimeout 可用。
 */
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

/** 基准「现在」：2026-10-08 08:00:00 UTC = 16:00 Asia/Shanghai。 */
const BASE = new Date('2026-10-08T08:00:00Z')

// ---------------------------------------------------------------------------
// 竞态回归
// ---------------------------------------------------------------------------

describe('reload 与 in-flight fire 竞态（P1 回归）', () => {
  let store: FakeStore
  let runner: DeferredRunner
  let timer: FakeTimer
  let clock: FakeClock

  beforeEach(() => {
    store = new FakeStore([makeTask('a')])
    runner = new DeferredRunner()
    clock = new FakeClock(BASE)
    timer = new FakeTimer(clock)
  })

  it('【核心】fire 挂起期间 reload → 旧 fire 不再补 timer：仅 1 个活跃 timer，无泄漏、不双份', async () => {
    const s = createScheduler({ store, runner, timer, clock })
    s.start()
    expect(timer.pending).toBe(1) // 启动时装了该任务的首个 timer

    // —— 触发首次 fire（runner 挂起，模拟长耗时后台执行）——
    const firstAt = timer.timers[0].at
    clock.set(new Date(firstAt))
    timer.fireDue(firstAt)

    expect(runner.calls).toHaveLength(1) // runner 已被调用
    expect(runner.pendingCount).toBe(1) // 且挂起未完成（in-flight）
    // fire() 开头已 scheduled.delete(id) → 此刻该任务无活跃 timer。
    expect(timer.pending).toBe(0)

    // —— in-flight 期间 reload（模拟 agent 调写类工具）——
    s.reload()
    expect(timer.pending).toBe(1) // reload 全量重建：为该任务装了 timer A
    const timerAId = timer.timers[0].id

    // —— 放行旧 fire 的 runner，等其 finally（rescheduleAfterFire）跑完 ——
    runner.release()
    await flush()

    // ★ 关键断言：旧 fire 未补第二个 timer。
    //   修复前：旧 fire finally 会再装 timer B → 此处为 2（泄漏 + 后续双份触发）。
    expect(timer.pending).toBe(1)
    // 活跃 timer 仍是 reload 装的那一个（A），未被旧 fire 的 B 覆盖。
    expect(timer.timers.map((t) => t.id)).toEqual([timerAId])
  })

  it('reload 竞态后链式自调度未被破坏：后续每周期仅触发 1 次', async () => {
    const s = createScheduler({ store, runner, timer, clock })
    s.start()

    // 首次触发 + 挂起
    const firstAt = timer.timers[0].at
    clock.set(new Date(firstAt))
    timer.fireDue(firstAt)
    expect(runner.calls).toHaveLength(1)

    // in-flight 期间 reload
    s.reload()
    // 放行旧 fire
    runner.release()
    await flush()
    expect(timer.pending).toBe(1) // 仅 reload 装的 1 个 timer

    // 推进到该 timer 的到点时刻触发：应精确触发 1 次（若双份则会 +2）。
    const secondAt = timer.timers[0].at
    expect(secondAt).toBeGreaterThan(firstAt)
    clock.set(new Date(secondAt))
    timer.fireDue(secondAt)
    expect(runner.calls).toHaveLength(2) // 精确 +1（非 +2）—— 无双份触发
    expect(runner.pendingCount).toBe(1)

    // 放行 → 正常链式重设下一次 timer（链未被破坏）。
    runner.release()
    await flush()
    expect(timer.pending).toBe(1)
    expect(runner.calls).toHaveLength(2)

    // 再推进一个周期，继续正常触发。
    const thirdAt = timer.timers[0].at
    clock.set(new Date(thirdAt))
    timer.fireDue(thirdAt)
    expect(runner.calls).toHaveLength(3)
  })

  it('fire 执行中 reload 将该任务禁用 → 旧 fire 不复活该任务（不补 timer）', async () => {
    const s = createScheduler({ store, runner, timer, clock })
    s.start()

    const firstAt = timer.timers[0].at
    clock.set(new Date(firstAt))
    timer.fireDue(firstAt)
    expect(runner.calls).toHaveLength(1)

    // reload 时该任务被禁用：rebuild 跳过它，不装 timer。
    store.tasks = [makeTask('a', { enabled: false })]
    s.reload()
    expect(timer.pending).toBe(0)

    runner.release()
    await flush()

    // 旧 fire 不得为一个已禁用任务重新装 timer（epoch 方案对边缘的覆盖；
    // 若仅做「has(id) 检查」则此处 has=false，会错误复活该任务）。
    expect(timer.pending).toBe(0)
  })

  it('无 reload 时正常链式调度不受代际守卫影响（连续触发 N 次）', async () => {
    const s = createScheduler({ store, runner, timer, clock })
    s.start()

    const N = 3
    for (let i = 0; i < N; i++) {
      const at = timer.timers[0].at
      clock.set(new Date(at))
      timer.fireDue(at)
      // 触发后该任务无活跃 timer（fire 已 delete）。
      expect(timer.pending).toBe(0)
      // 放行 → 链式重设出 1 个 timer（无 reload，代际未变，不误伤）。
      runner.release()
      await flush()
      expect(timer.pending).toBe(1)
    }
    expect(runner.calls).toHaveLength(N)
  })
})
