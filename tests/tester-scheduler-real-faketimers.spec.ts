/**
 * 真 Node 定时器语义验证（vi.useFakeTimers + 注入 fake clock + native timer 对齐）：
 * fire() 内同步 throw 不 uncaughtException，任务仍重设 timer（下一周期继续）。
 *
 * 关键：vi.advanceTimersByTime 不 flush 微任务，reschedule 在 .finally 微任务里，
 * 故推进后需 await 微任务（用 vi.advanceTimersByTimeAsync 或 flush microtask）再断言计数。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createScheduler } from '../src/scheduler/scheduler.js'
import type { Clock, TaskDef, TaskRunOutcome, Timer, TimerHandle } from '../src/scheduler/types.js'

function makeTask(id: string, cron = '* * * * *'): TaskDef {
  return { id, name: `任务-${id}`, cron, task_path: `/assets/programs/${id}/task.ts`, enabled: true }
}

class FakeClock implements Clock {
  constructor(private t: number) {}
  now(): Date { return new Date(this.t) }
  set(ms: number): void { this.t = ms }
}

const nativeTimer: Timer = {
  setTimer(delayMs, cb) {
    return setTimeout(cb, delayMs) as unknown as TimerHandle
  },
  clearTimer(handle) {
    clearTimeout(handle as unknown as ReturnType<typeof setTimeout>)
  },
}

const START = new Date('2026-10-08T08:00:00Z').getTime()

describe('真 Node 定时器：同步 throw 不 uncaughtException、仍重设 timer', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(START)
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('runner.run 同步 throw → 不 uncaughtException，任务仍重设 timer', async () => {
    const runner = {
      run(_taskId: string, _taskPath: string): Promise<TaskRunOutcome> {
        throw new Error('sync-throw')
      },
    }
    const store = {
      list() {
        return { tasks: [makeTask('a')], corrupted: [] }
      },
    }
    const clock = new FakeClock(START)
    const s = createScheduler({ store, runner, timer: nativeTimer, clock })

    s.start()
    expect(vi.getTimerCount()).toBe(1)

    // 用 advanceTimersByTimeAsync（会 flush 微任务），同步 throw 不抛。
    await vi.advanceTimersByTimeAsync(60_000)

    // 任务已重设 timer（下一周期）。
    expect(vi.getTimerCount()).toBe(1)

    // 连续触发多次，每次同步 throw 均被隔离并重设。
    for (let i = 0; i < 5; i++) {
      await vi.advanceTimersByTimeAsync(60_000)
    }
    expect(vi.getTimerCount()).toBe(1)

    s.stop()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('多任务中一个同步 throw，另一个正常连续触发（互不连累、各自 timer 独立）', async () => {
    const aCalls: number[] = []
    const bCalls: number[] = []
    const runner = {
      run(taskId: string, taskPath: string): Promise<TaskRunOutcome> {
        if (taskPath.endsWith('/a/task.ts')) {
          aCalls.push(1)
          throw new Error('sync-throw-a')
        }
        bCalls.push(1)
        return Promise.resolve({ kind: 'quiet', reason: 'ok' } as TaskRunOutcome)
      },
    }
    const store = {
      list() {
        return { tasks: [makeTask('a'), makeTask('b')], corrupted: [] }
      },
    }
    const clock = new FakeClock(START)
    const s = createScheduler({ store, runner, timer: nativeTimer, clock })

    s.start()
    expect(vi.getTimerCount()).toBe(2)

    await vi.advanceTimersByTimeAsync(60_000)

    expect(aCalls).toHaveLength(1) // a 触发一次（同步 throw 被隔离）
    expect(bCalls).toHaveLength(1) // b 触发一次（正常）
    // 两任务都重设了 timer。
    expect(vi.getTimerCount()).toBe(2)

    s.stop()
    expect(vi.getTimerCount()).toBe(0)
  })
})