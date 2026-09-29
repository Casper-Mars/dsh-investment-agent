/**
 * runner/scheduler.ts 单元测试（验收点 4 / 5 / 6）。
 *
 * 覆盖：
 *   - Asia/Shanghai 墙钟分解（锁时区，与本机时区无关）；
 *   - 脉冲窗口边界（9:30-11:30 / 13:00-15:00 含端点）；
 *   - nextPulseInstant / nextDailyInstant 的正确顺延（跨午休 / 跨日）；
 *   - 原生 setTimeout 链式自调度：apply 启动、到点触发；
 *   - 非交易日经 isTradingDay 跳过；
 *   - stop() 清空所有 timer（vi.getTimerCount() === 0）；
 *   - 复盘 18:30 / 盘前 9:25 触发。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  shanghaiParts,
  isPulseMinute,
  isInPulseWindow,
  nextPulseInstant,
  nextDailyInstant,
  createScheduler,
  SHANGHAI_TIME_ZONE,
  PULSE_STEP_SECONDS,
  REVIEW_MINUTE,
  PREP_MINUTE,
} from '../src/runner/scheduler.js'

/** 构造 UTC 时刻（Asia/Shanghai = UTC+8）。 */
function utc(iso: string): Date {
  return new Date(iso)
}

describe('时区与窗口纯函数', () => {
  it('锁 Asia/Shanghai：UTC 01:31 → 上海 09:31', () => {
    const parts = shanghaiParts(utc('2026-09-29T01:31:00Z'))
    expect(parts.hour).toBe(9)
    expect(parts.minute).toBe(31)
    expect(parts.minuteOfDay).toBe(9 * 60 + 31)
    expect(SHANGHAI_TIME_ZONE).toBe('Asia/Shanghai')
  })

  it('PULSE_STEP_SECONDS 为 30（零第三方 cron，仅原生 setTimeout）', () => {
    expect(PULSE_STEP_SECONDS).toBe(30)
  })

  it('脉冲窗口边界（含端点）', () => {
    expect(isPulseMinute(9 * 60 + 29)).toBe(false)
    expect(isPulseMinute(9 * 60 + 30)).toBe(true)
    expect(isPulseMinute(11 * 60 + 30)).toBe(true)
    expect(isPulseMinute(11 * 60 + 31)).toBe(false)
    expect(isPulseMinute(12 * 60 + 59)).toBe(false)
    expect(isPulseMinute(13 * 60)).toBe(true)
    expect(isPulseMinute(15 * 60)).toBe(true)
    expect(isPulseMinute(15 * 60 + 1)).toBe(false)
  })

  it('isInPulseWindow 对应具体时刻', () => {
    expect(isInPulseWindow(utc('2026-09-29T01:29:00Z'))).toBe(false) // 09:29
    expect(isInPulseWindow(utc('2026-09-29T01:30:00Z'))).toBe(true) // 09:30
    expect(isInPulseWindow(utc('2026-09-29T03:30:00Z'))).toBe(true) // 11:30
    expect(isInPulseWindow(utc('2026-09-29T03:31:00Z'))).toBe(false) // 11:31
    expect(isInPulseWindow(utc('2026-09-29T04:59:00Z'))).toBe(false) // 12:59
    expect(isInPulseWindow(utc('2026-09-29T05:00:00Z'))).toBe(true) // 13:00
    expect(isInPulseWindow(utc('2026-09-29T07:00:00Z'))).toBe(true) // 15:00
    expect(isInPulseWindow(utc('2026-09-29T07:01:00Z'))).toBe(false) // 15:01
  })

  it('nextPulseInstant 对齐到下一个 30 秒窗口内时刻（严格未来、含端点）', () => {
    // 09:31:00 → 09:31:30
    let p = shanghaiParts(nextPulseInstant(utc('2026-09-29T01:31:00Z')))
    expect(p.minuteOfDay).toBe(9 * 60 + 31)
    expect(p.second).toBe(30)
    // 09:30:00 整 → 09:30:30（严格未来）
    p = shanghaiParts(nextPulseInstant(utc('2026-09-29T01:30:00Z')))
    expect(p.minuteOfDay).toBe(9 * 60 + 30)
    expect(p.second).toBe(30)
    // 09:30:07 → 09:30:30
    p = shanghaiParts(nextPulseInstant(utc('2026-09-29T01:30:07Z')))
    expect(p.minuteOfDay).toBe(9 * 60 + 30)
    expect(p.second).toBe(30)
    // 09:30:30.000 整 → 09:31:00（不含自身）
    p = shanghaiParts(nextPulseInstant(utc('2026-09-29T01:30:30Z')))
    expect(p.minuteOfDay).toBe(9 * 60 + 31)
    expect(p.second).toBe(0)
    // 11:30:00 整 → 13:00:00（跨午休；11:30:30 越界）
    p = shanghaiParts(nextPulseInstant(utc('2026-09-29T03:30:00Z')))
    expect(p.minuteOfDay).toBe(13 * 60)
    expect(p.second).toBe(0)
    // 12:00 → 13:00:00
    p = shanghaiParts(nextPulseInstant(utc('2026-09-29T04:00:00Z')))
    expect(p.minuteOfDay).toBe(13 * 60)
    expect(p.second).toBe(0)
    // 08:00 → 09:30:00
    p = shanghaiParts(nextPulseInstant(utc('2026-09-29T00:00:00Z')))
    expect(p.minuteOfDay).toBe(9 * 60 + 30)
    expect(p.second).toBe(0)
  })

  it('nextPulseInstant 收盘后顺延到次日 9:30:00', () => {
    const next = nextPulseInstant(utc('2026-09-29T07:00:00Z')) // 15:00:00 整
    const parts = shanghaiParts(next)
    expect(parts.minuteOfDay).toBe(9 * 60 + 30)
    expect(parts.second).toBe(0)
    expect(parts.day).toBe(30) // 次日
  })

  it('nextDailyInstant 命中当日 / 次日', () => {
    // 09:00 → 当日 18:30
    expect(shanghaiParts(nextDailyInstant(utc('2026-09-29T01:00:00Z'), REVIEW_MINUTE)).minuteOfDay).toBe(REVIEW_MINUTE)
    // 20:00 → 次日 18:30
    const next = nextDailyInstant(utc('2026-09-29T12:00:00Z'), REVIEW_MINUTE)
    expect(shanghaiParts(next).day).toBe(30)
    expect(shanghaiParts(next).minuteOfDay).toBe(REVIEW_MINUTE)
    // 盘前 9:25
    expect(shanghaiParts(nextDailyInstant(utc('2026-09-29T01:00:00Z'), PREP_MINUTE)).minuteOfDay).toBe(PREP_MINUTE)
  })
})

describe('调度器生命周期与触发', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('启动后到下一个脉冲时刻触发 onPulse（原生 setTimeout 链式）', async () => {
    vi.setSystemTime(utc('2026-09-29T01:31:00Z')) // 周二 09:31:00
    const onPulse = vi.fn()
    const onReview = vi.fn()
    const sched = createScheduler({
      onPulse,
      onReview,
      isTradingDay: () => true,
      logger: () => {},
    })
    sched.start()
    expect(sched.running).toBe(true)
    expect(vi.getTimerCount()).toBe(1)

    await vi.advanceTimersByTimeAsync(30_000) // → 09:31:30
    expect(onPulse).toHaveBeenCalledTimes(1)
    const p = shanghaiParts(onPulse.mock.calls[0][0] as Date)
    expect(p.minuteOfDay).toBe(9 * 60 + 31)
    expect(p.second).toBe(30)
    sched.stop()
  })

  it('窗口外（午休 12:00 起）不触发，直到 13:00', async () => {
    vi.setSystemTime(utc('2026-09-29T04:00:00Z')) // 12:00
    const onPulse = vi.fn()
    const sched = createScheduler({ onPulse, onReview: vi.fn(), isTradingDay: () => true, logger: () => {} })
    sched.start()
    await vi.advanceTimersByTimeAsync(30 * 60_000) // → 12:30，无触发
    expect(onPulse).toHaveBeenCalledTimes(0)
    await vi.advanceTimersByTimeAsync(30 * 60_000) // → 13:00，触发
    expect(onPulse).toHaveBeenCalledTimes(1)
    expect(shanghaiParts(onPulse.mock.calls[0][0] as Date).minuteOfDay).toBe(13 * 60)
    sched.stop()
  })

  it('非交易日经 isTradingDay 跳过（链条不断）', async () => {
    vi.setSystemTime(utc('2026-09-29T01:31:00Z'))
    const onPulse = vi.fn()
    const isTradingDay = vi.fn(() => false)
    const sched = createScheduler({ onPulse, onReview: vi.fn(), isTradingDay, logger: () => {} })
    sched.start()
    await vi.advanceTimersByTimeAsync(10 * 60_000) // 两个脉冲窗口点
    expect(onPulse).toHaveBeenCalledTimes(0)
    expect(isTradingDay).toHaveBeenCalled()
    expect(sched.running).toBe(true) // 链条仍在
    sched.stop()
  })

  it('stop() 清空所有 timer', async () => {
    vi.setSystemTime(utc('2026-09-29T01:31:00Z'))
    const onPulse = vi.fn()
    const sched = createScheduler({ onPulse, onReview: vi.fn(), isTradingDay: () => true, logger: () => {} })
    sched.start()
    expect(vi.getTimerCount()).toBe(1)
    sched.stop()
    expect(sched.running).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(120 * 60_000)
    expect(onPulse).toHaveBeenCalledTimes(0)
  })

  it('盘后复盘 18:30 触发', async () => {
    vi.setSystemTime(utc('2026-09-29T10:20:00Z')) // 18:20
    const onPulse = vi.fn()
    const onReview = vi.fn()
    const sched = createScheduler({ onPulse, onReview, isTradingDay: () => true, logger: () => {} })
    sched.start()
    await vi.advanceTimersByTimeAsync(10 * 60_000) // → 18:30 复盘（窗口外，无脉冲）
    expect(onPulse).toHaveBeenCalledTimes(0)
    expect(onReview).toHaveBeenCalledTimes(1)
    expect(shanghaiParts(onReview.mock.calls[0][0] as Date).minuteOfDay).toBe(REVIEW_MINUTE)
    sched.stop()
  })

  it('盘前准备 9:25 触发（可选）', async () => {
    vi.setSystemTime(utc('2026-09-29T01:20:00Z')) // 09:20
    const onPrep = vi.fn()
    const sched = createScheduler({
      onPulse: vi.fn(),
      onReview: vi.fn(),
      onPrep,
      isTradingDay: () => true,
      logger: () => {},
    })
    sched.start()
    await vi.advanceTimersByTimeAsync(5 * 60_000) // → 09:25
    expect(onPrep).toHaveBeenCalledTimes(1)
    expect(shanghaiParts(onPrep.mock.calls[0][0] as Date).minuteOfDay).toBe(PREP_MINUTE)
    sched.stop()
  })

  it('回调异常不中断链条', async () => {
    vi.setSystemTime(utc('2026-09-29T01:31:00Z'))
    const onPulse = vi.fn(() => {
      throw new Error('boom')
    })
    const sched = createScheduler({ onPulse, onReview: vi.fn(), isTradingDay: () => true, logger: () => {} })
    sched.start()
    await vi.advanceTimersByTimeAsync(30_000) // 09:31:30 抛错
    await vi.advanceTimersByTimeAsync(30_000) // 09:32:00 仍触发
    expect(onPulse).toHaveBeenCalledTimes(2)
    expect(sched.running).toBe(true)
    sched.stop()
  })
})
