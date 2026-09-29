/**
 * Task 6-rev 独立复验（Tester 独立编写；**不**复用 Developer 的 tests/runner-*.test.ts，
 * 也不依赖 tests/tester-runner-task6.INDEPENDENT.spec.ts）。
 *
 * 被测：scheduler 调度参数调整
 *   1. 盘中脉冲步长 5 分钟 → 30 秒（PULSE_STEP_SECONDS === 30，30 秒对齐、严格未来）
 *   2. 盘后复盘 15:05 → 18:30（REVIEW_MINUTE === 18*60+30 === 1110）
 *
 * 逐条对应本次 4 项验收：
 *   AC1 PULSE_STEP_SECONDS===30 + nextPulseInstant 30 秒对齐/严格未来
 *   AC2 9 个秒粒度窗口边界点（含毫秒）
 *   AC3 REVIEW_MINUTE===1110，复盘触发在 18:30（交易日）
 *   AC4 窗口/时区/盘前 9:25/挡板/stop/top-inject 均不变（回归）
 *
 * 全部走 mock / 注入，不依赖真实网络与真实子进程。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
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
  PULSE_WINDOWS,
  REVIEW_MINUTE,
  PREP_MINUTE,
  type SchedulerOptions,
} from '../src/runner/scheduler.js'
import { inject as topLevelInject } from '../src/plugin.js'

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))

/** 构造带 +08:00 偏移的 Asia/Shanghai 时刻（无歧义）。 */
function sh(iso: string): Date {
  return new Date(iso)
}
/** 断言结果时刻的「精确 Instant」与墙钟分量（沪）均等于期望。 */
function expectInstant(actual: Date, expected: Date): void {
  // 1) 精确毫秒相等（最强断言）
  expect(actual.getTime()).toBe(expected.getTime())
  // 2) 墙钟分量核对（防时区实现漂移）
  const a = shanghaiParts(actual)
  const e = shanghaiParts(expected)
  expect([a.year, a.month, a.day, a.hour, a.minute, a.second]).toEqual([
    e.year,
    e.month,
    e.day,
    e.hour,
    e.minute,
    e.second,
  ])
}

/* ================================================================== *
 * AC1：常量 + 30 秒对齐 + 严格未来
 * ================================================================== */

describe('[rev-AC1] PULSE_STEP_SECONDS === 30 且 nextPulseInstant 30 秒对齐、严格未来', () => {
  it('常量：PULSE_STEP_SECONDS=30，时区锁 Asia/Shanghai，窗口仍为 [570,690]/[780,900]', () => {
    expect(PULSE_STEP_SECONDS).toBe(30)
    expect(SHANGHAI_TIME_ZONE).toBe('Asia/Shanghai')
    expect(PULSE_WINDOWS).toEqual([
      [9 * 60 + 30, 11 * 60 + 30],
      [13 * 60, 15 * 60],
    ])
    // 不再是旧的 5 分钟常量语义硬编，改动已落地
    expect(PULSE_STEP_SECONDS).not.toBe(5 * 60)
  })

  it('窗口内任意时刻 → 结果毫秒为 0 且秒 ∈ {0,30}（30 秒对齐）', () => {
    const probes = [
      '2026-09-29T09:30:00.123+08:00',
      '2026-09-29T09:30:29.999+08:00',
      '2026-09-29T10:00:07.500+08:00',
      '2026-09-29T11:30:00.000+08:00',
      '2026-09-29T13:45:12.250+08:00',
      '2026-09-29T14:59:59.001+08:00',
    ]
    for (const iso of probes) {
      const at = nextPulseInstant(sh(iso))
      const p = shanghaiParts(at)
      expect([0, 30], `${iso} 秒对齐`).toContain(p.second)
      expect(at.getUTCMilliseconds(), `${iso} 毫秒归零`).toBe(0)
      expect(at.getTime(), `${iso} 严格未来`).toBeGreaterThan(sh(iso).getTime())
    }
  })

  it('严格未来：整点窗口边界不返回自身（09:30:00 → 09:30:30，非 09:30:00）', () => {
    const at = nextPulseInstant(sh('2026-09-29T09:30:00+08:00'))
    expect(at.getTime()).toBeGreaterThan(sh('2026-09-29T09:30:00+08:00').getTime())
    expect(shanghaiParts(at).second).toBe(30)
  })
})

/* ================================================================== *
 * AC2：9 个秒粒度窗口边界点（精确 Instant）
 * ================================================================== */

describe('[rev-AC2] 窗口边界（秒粒度，逐点精确 Instant）', () => {
  const CASES: Array<[string, string, string]> = [
    ['09:30:00 → 09:30:30', '2026-09-29T09:30:00+08:00', '2026-09-29T09:30:30+08:00'],
    ['09:30:30 → 09:31:00', '2026-09-29T09:30:30+08:00', '2026-09-29T09:31:00+08:00'],
    ['11:30:00 → 13:00:00（跨午休）', '2026-09-29T11:30:00+08:00', '2026-09-29T13:00:00+08:00'],
    ['11:30:30 → 13:00:00（越界顺延）', '2026-09-29T11:30:30+08:00', '2026-09-29T13:00:00+08:00'],
    ['12:59:59 → 13:00:00', '2026-09-29T12:59:59+08:00', '2026-09-29T13:00:00+08:00'],
    ['13:00:00 → 13:00:30', '2026-09-29T13:00:00+08:00', '2026-09-29T13:00:30+08:00'],
    ['15:00:00 → 次日 09:30:00（跨日）', '2026-09-29T15:00:00+08:00', '2026-09-30T09:30:00+08:00'],
    ['15:00:30 → 次日 09:30:00（跨日）', '2026-09-29T15:00:30+08:00', '2026-09-30T09:30:00+08:00'],
    ['09:30:07 → 09:30:30', '2026-09-29T09:30:07+08:00', '2026-09-29T09:30:30+08:00'],
  ]

  for (const [label, nowIso, expectedIso] of CASES) {
    it(label, () => {
      expectInstant(nextPulseInstant(sh(nowIso)), sh(expectedIso))
    })
  }

  it('毫秒同界：09:30:30.000 归 09:31:00，09:30:29.999 归 09:30:30（含毫秒严格未来）', () => {
    expectInstant(nextPulseInstant(sh('2026-09-29T09:30:30.000+08:00')), sh('2026-09-29T09:31:00.000+08:00'))
    expectInstant(nextPulseInstant(sh('2026-09-29T09:30:29.999+08:00')), sh('2026-09-29T09:30:30.000+08:00'))
  })
})

/* ================================================================== *
 * AC1/AC2：连续 30 秒脉冲
 * ================================================================== */

describe('[rev-AC1/AC2] 连续 30 秒脉冲（09:30:00 起连续 3 次）', () => {
  it('09:30:00 → 09:30:30 → 09:31:00 → 09:31:30', () => {
    const first = nextPulseInstant(sh('2026-09-29T09:30:00+08:00'))
    expectInstant(first, sh('2026-09-29T09:30:30+08:00'))
    const second = nextPulseInstant(first)
    expectInstant(second, sh('2026-09-29T09:31:00+08:00'))
    const third = nextPulseInstant(second)
    expectInstant(third, sh('2026-09-29T09:31:30+08:00'))
    // 每次真实间隔恒为 30_000ms
    expect(second.getTime() - first.getTime()).toBe(30_000)
    expect(third.getTime() - second.getTime()).toBe(30_000)
  })
})

/* ================================================================== *
 * AC3：REVIEW_MINUTE === 1110 + nextDailyInstant
 * ================================================================== */

describe('[rev-AC3] REVIEW_MINUTE === 18*60+30 === 1110；复盘时刻正确顺延', () => {
  it('常量：REVIEW_MINUTE=1110（=18:30），PREP_MINUTE 仍为 9:25=565', () => {
    expect(REVIEW_MINUTE).toBe(18 * 60 + 30)
    expect(REVIEW_MINUTE).toBe(1110)
    expect(PREP_MINUTE).toBe(9 * 60 + 25)
    expect(PREP_MINUTE).toBe(565)
  })

  it('nextDailyInstant(now, REVIEW_MINUTE)：今日未到即今日 18:30', () => {
    for (const iso of [
      '2026-09-29T09:00:00+08:00',
      '2026-09-29T15:30:00+08:00',
      '2026-09-29T18:29:00+08:00',
    ]) {
      expectInstant(nextDailyInstant(sh(iso), REVIEW_MINUTE), sh('2026-09-29T18:30:00+08:00'))
    }
  })

  it('nextDailyInstant(now, REVIEW_MINUTE)：已到/已过即次日 18:30', () => {
    // 18:30:00 整（diff=0）按「已过」处理 → 次日
    expectInstant(nextDailyInstant(sh('2026-09-29T18:30:00+08:00'), REVIEW_MINUTE), sh('2026-09-30T18:30:00+08:00'))
    // 20:00 已过 → 次日
    expectInstant(nextDailyInstant(sh('2026-09-29T20:00:00+08:00'), REVIEW_MINUTE), sh('2026-09-30T18:30:00+08:00'))
  })
})

/* ================================================================== *
 * 调度器整合（fake timers）：脉冲 / 复盘 / 挡板
 * ================================================================== */

describe('[rev-集成] 调度器：09:30:30 触发 onPulse、18:30 触发 onReview、非交易日跳过', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('09:30:00 启动 → 推进 30s 在 09:30:30 触发 onPulse（间隔 30 秒）', async () => {
    vi.setSystemTime(sh('2026-09-29T09:30:00+08:00'))
    const onPulse = vi.fn()
    const sched = createScheduler({ onPulse, onReview: vi.fn(), isTradingDay: () => true, logger: () => {} })
    sched.start()
    expect(sched.running).toBe(true)
    expect(vi.getTimerCount()).toBe(1)

    await vi.advanceTimersByTimeAsync(30_000)
    expect(onPulse).toHaveBeenCalledTimes(1)
    expectInstant(onPulse.mock.calls[0]![0] as Date, sh('2026-09-29T09:30:30+08:00'))

    // 再推进 30s → 09:31:00
    await vi.advanceTimersByTimeAsync(30_000)
    expect(onPulse).toHaveBeenCalledTimes(2)
    expectInstant(onPulse.mock.calls[1]![0] as Date, sh('2026-09-29T09:31:00+08:00'))
    sched.stop()
  })

  it('18:20 启动 → 推进 10min 在 18:30 触发 onReview（窗口外无脉冲）', async () => {
    vi.setSystemTime(sh('2026-09-29T18:20:00+08:00'))
    const onPulse = vi.fn()
    const onReview = vi.fn()
    const sched = createScheduler({ onPulse, onReview, isTradingDay: () => true, logger: () => {} })
    sched.start()
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(onPulse).toHaveBeenCalledTimes(0)
    expect(onReview).toHaveBeenCalledTimes(1)
    expectInstant(onReview.mock.calls[0]![0] as Date, sh('2026-09-29T18:30:00+08:00'))
    sched.stop()
  })

  it('isTradingDay=false → 脉冲与复盘均跳过（链条不断）', async () => {
    vi.setSystemTime(sh('2026-09-29T09:30:00+08:00'))
    const onPulse = vi.fn()
    const isTradingDay = vi.fn(() => false)
    const sched = createScheduler({ onPulse, onReview: vi.fn(), isTradingDay, logger: () => {} })
    sched.start()
    await vi.advanceTimersByTimeAsync(5 * 60_000) // 覆盖多个脉冲点
    expect(onPulse).toHaveBeenCalledTimes(0)
    expect(isTradingDay).toHaveBeenCalled()
    expect(sched.running).toBe(true)
    sched.stop()
  })

  it('非交易日复盘 18:30 跳过', async () => {
    vi.setSystemTime(sh('2026-09-29T18:20:00+08:00'))
    const onReview = vi.fn()
    const sched = createScheduler({ onPulse: vi.fn(), onReview, isTradingDay: () => false, logger: () => {} })
    sched.start()
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(onReview).toHaveBeenCalledTimes(0)
    sched.stop()
  })

  it('stop() 清空 timer：vi.getTimerCount()===0 且后续不再触发', async () => {
    vi.setSystemTime(sh('2026-09-29T09:30:00+08:00'))
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

  it('注入 setTimer：arm 布置的是「数值毫秒延迟」而非 cron 表达式（原生 setTimeout 语义）', () => {
    const setTimer = vi.fn((_h: () => void, _d: number) => 0)
    const clearTimer = vi.fn()
    const opts: SchedulerOptions = {
      onPulse: vi.fn(),
      onReview: vi.fn(),
      isTradingDay: () => true,
      now: () => sh('2026-09-29T09:30:00+08:00'),
      setTimer: setTimer as unknown as SchedulerOptions['setTimer'],
      clearTimer: clearTimer as unknown as SchedulerOptions['clearTimer'],
      logger: () => {},
    }
    const sched = createScheduler(opts)
    sched.start()
    expect(setTimer).toHaveBeenCalledTimes(1)
    // 09:30:00 下一候选即脉冲 09:30:30 → 延迟恰 30_000ms
    expect(setTimer.mock.calls[0]![1]).toBe(30_000)
    sched.stop()
    expect(clearTimer).toHaveBeenCalledTimes(1)
  })
})

/* ================================================================== *
 * AC4：回归 —— 窗口 / 时区 / 分钟粒度 isPulseMinute / 盘前 9:25 / top-inject / 无 cron
 * ================================================================== */

describe('[rev-AC4] 回归：窗口/时区/isPulseMinute/盘前 9:25 均不变', () => {
  it('isPulseMinute（分钟粒度，供 classify）边界不变：09:29 F / 09:30 T / 11:30 T / 11:31 F / 12:59 F / 13:00 T / 15:00 T / 15:01 F', () => {
    expect(isPulseMinute(9 * 60 + 29)).toBe(false)
    expect(isPulseMinute(9 * 60 + 30)).toBe(true)
    expect(isPulseMinute(11 * 60 + 30)).toBe(true)
    expect(isPulseMinute(11 * 60 + 31)).toBe(false)
    expect(isPulseMinute(12 * 60 + 59)).toBe(false)
    expect(isPulseMinute(13 * 60)).toBe(true)
    expect(isPulseMinute(15 * 60)).toBe(true)
    expect(isPulseMinute(15 * 60 + 1)).toBe(false)
  })

  it('isInPulseWindow 锁时区（UTC 输入 → 上海判定）', () => {
    expect(isInPulseWindow(sh('2026-09-29T01:29:00Z'))).toBe(false) // 09:29
    expect(isInPulseWindow(sh('2026-09-29T01:30:00Z'))).toBe(true) // 09:30
    expect(isInPulseWindow(sh('2026-09-29T05:00:00Z'))).toBe(true) // 13:00
    expect(isInPulseWindow(sh('2026-09-29T07:00:00Z'))).toBe(true) // 15:00
    expect(isInPulseWindow(sh('2026-09-29T07:00:30Z'))).toBe(true) // 15:00:30 仍按分钟在窗口
    expect(isInPulseWindow(sh('2026-09-29T07:01:00Z'))).toBe(false) // 15:01
  })

  it('shanghaiParts 锁 Asia/Shanghai：UTC 01:31 → 上海 09:31', () => {
    const p = shanghaiParts(sh('2026-09-29T01:31:00Z'))
    expect(p.hour).toBe(9)
    expect(p.minute).toBe(31)
    expect(p.minuteOfDay).toBe(9 * 60 + 31)
  })

  it('盘前 9:25 顺延不变：09:00 → 当日 9:25；09:30 → 次日 9:25', () => {
    expectInstant(nextDailyInstant(sh('2026-09-29T09:00:00+08:00'), PREP_MINUTE), sh('2026-09-29T09:25:00+08:00'))
    expectInstant(nextDailyInstant(sh('2026-09-29T09:30:00+08:00'), PREP_MINUTE), sh('2026-09-30T09:25:00+08:00'))
  })
})

describe('[rev-AC4] 顶层 inject 严格不变 + 零第三方 cron', () => {
  it("plugin.ts 顶层 inject 严格 = ['tools','skills','ptcRuntime','fs']", () => {
    expect(topLevelInject).toEqual(['tools', 'skills', 'ptcRuntime', 'fs'])
    expect(topLevelInject.length).toBe(4)
    expect(topLevelInject).not.toContain('agents')
    expect(topLevelInject).not.toContain('systemPrompt')
  })

  it('package.json 无任何第三方 cron 依赖', () => {
    const forbidden = [
      'node-cron',
      'node-schedule',
      'croner',
      'cron',
      'cron-parser',
      'bree',
      'agenda',
      'toad-scheduler',
      'later',
      'node-crontab',
    ]
    const pkg = JSON.parse(readFileSync(`${REPO_ROOT}/package.json`, 'utf8')) as Record<string, unknown>
    const buckets = ['dependencies', 'devDependencies', 'peerDependencies'] as const
    const names = new Set<string>()
    for (const b of buckets) {
      const obj = pkg[b] as Record<string, string> | undefined
      if (obj) for (const n of Object.keys(obj)) names.add(n)
    }
    for (const bad of forbidden) {
      expect(names.has(bad), `不应依赖 ${bad}`).toBe(false)
    }
  })

  it('src/runner/scheduler.ts 无 cron 类库 import（仅原生 setTimeout 链式自调度）', () => {
    const src = readFileSync(`${REPO_ROOT}/src/runner/scheduler.ts`, 'utf8')
    const imports = [...src.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]!)
    expect(imports).toEqual([])
    expect(src).toContain('setTimeout')
  })

  it('README 文档同步为 30 秒脉冲 / 18:30 复盘', () => {
    const readme = readFileSync(`${REPO_ROOT}/src/runner/README.md`, 'utf8')
    expect(readme).toMatch(/30\s*秒|30s/)
    expect(readme).toContain('18:30')
  })
})
