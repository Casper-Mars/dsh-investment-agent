/**
 * Task 6 独立验收测试（Tester 独立编写，不复用 Developer 的 tests/runner-*.test.ts）。
 *
 * 被测：`src/runner/**`（感知脚本执行层 + 自持调度）与 `src/plugin.ts` 顶层契约。
 *
 * 逐条对应 t100358 的 6 个验收点，外加任务书指定的 11 项独立运行时验证：
 *   1. sensor-runner 读 sense_registry.current() 取 code，组装只读 bindings 后调
 *      ctx.ptcRuntime.run({program, bindings, sandboxPolicy})
 *   2. bindings 仅暴露 5 个只读方法，无任何写方法
 *   3. shouldWake:true → 投递唤醒；false → 静默结束
 *   4. scheduler 原生 setTimeout 链式自调度，零第三方 cron 依赖
 *   5. 时间窗判定（09:30-11:30 / 13:00-15:00 Asia/Shanghai）+ isTradingDay 挡板
 *   6. apply 启动调度、stop() 清空 timer（无泄漏）
 *
 * 全部使用 mock / 注入，不依赖真实网络与真实 ptc-runtime 子进程。
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { applyRunner } from '../src/runner/index.js'
import {
  createSensorBindings,
  SENSOR_BINDING_GLOBALS,
  SENSOR_READONLY_METHODS,
  DEFAULT_HISTORY_DAYS,
  type SensorBindingSources,
} from '../src/runner/bindings.js'
import { createSensorRunner, parseSensorResult } from '../src/runner/sensor-runner.js'
import {
  createAgentWaker,
  resolveWakeTarget,
  buildWakeMessage,
  boundSummary,
  PLUGIN_SOURCE_NAME,
  WAKE_SUMMARY_MAX_CHARS,
} from '../src/runner/wake.js'
import { toJsonValue } from '../src/runner/json.js'
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
import { PINNED_SESSION_ID } from '../src/session.js'
import type {
  PtcBindingNamespace,
  PtcRunRequest,
  PtcRunResult,
  PtcRunSpec,
  PtcRuntimeLike,
  SensorWakePayload,
} from '../src/runner/types.js'

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))

/* ================================================================== *
 * 公共夹具
 * ================================================================== */

const LEDGER_SYMBOLS = [
  { symbol: '588000', type: 'etf', name: '科创50ETF', qty: 1000, avgCost: 1.5 },
  { symbol: '000001', type: 'stock', qty: 200, avgCost: 10.25 }, // 无 name（测 undefined 清洗）
]

const SCRIPT_CODE =
  'return { shouldWake: true, symbol: "588000", summary: "偏离均线 3.2%", metrics: { ma: 1.6 } }'

function makeRegistry(code = SCRIPT_CODE, version = 'v002') {
  return {
    current: vi.fn(() => ({
      version,
      changeType: 'patch' as const,
      ts: '2026-09-29T00:00:00.000Z',
    })),
    read: vi.fn((v: string) => ({
      meta: { version: v, changeType: 'patch' as const, ts: '2026-09-29T00:00:00.000Z' },
      rationale: 'r',
      code,
    })),
  }
}

function makeLedger() {
  return {
    list: vi.fn(() => LEDGER_SYMBOLS),
    query: vi.fn((symbol: string) => ({
      symbol,
      type: 'etf',
      name: '科创50ETF',
      qty: 1000,
      avgCost: 1.5,
      cash: 100,
      realizedPnl: 0,
      floatPnl: 12.5,
    })),
  }
}

function makeQuotes() {
  return {
    realtime: vi.fn(async (symbol: string, type?: string) => ({ symbol, type, price: 1.66 })),
    intraday: vi.fn(async (symbol: string) => [{ symbol, price: 1.6 }]),
    history: vi.fn(async (symbol: string, days: number) => [{ symbol, price: 1.5, days }]),
  }
}

/** 记录调用顺序与入参的 mock 运行时。 */
function makeRuntime(outcome: PtcRunResult | ((spec: PtcRunSpec) => PtcRunResult)) {
  const calls: string[] = []
  const requests: PtcRunRequest[] = []
  const specs: PtcRunSpec[] = []
  const runtime: PtcRuntimeLike = {
    resolve(request: PtcRunRequest): PtcRunSpec {
      calls.push('resolve')
      requests.push(request)
      return { ...request, cwd: request.cwd ?? '/tmp/x', timeoutMs: request.timeoutMs ?? 1000 }
    },
    async run(spec: PtcRunSpec): Promise<PtcRunResult> {
      calls.push('run')
      specs.push(spec)
      return typeof outcome === 'function' ? outcome(spec) : outcome
    },
  }
  return { runtime, calls, requests, specs }
}

function makeRunner(over: Partial<Parameters<typeof createSensorRunner>[0]> = {}) {
  const waker = vi.fn((_p: SensorWakePayload) => 1)
  const bundle = makeRuntime({
    logs: [],
    value: { shouldWake: true, symbol: '588000', summary: '偏离均线 3.2%', metrics: { ma: 1.6 } },
  })
  const runner = createSensorRunner({
    senseRegistry: makeRegistry(),
    ledger: makeLedger(),
    quotes: makeQuotes(),
    ptcRuntime: bundle.runtime,
    dataRoot: '/data/root',
    logger: () => {},
    waker,
    wakeCooldownMs: 0,
    ...over,
  })
  return { runner, waker, bundle }
}

/* UTC 助手：Asia/Shanghai = UTC+8（无夏令时） */
function utc(iso: string): Date {
  return new Date(iso)
}
function shanghaiMinuteOfDay(iso: string): number {
  return shanghaiParts(utc(iso)).minuteOfDay
}

/* ================================================================== *
 * 验收点 5（时间窗边界）——独立运行时验证 #1：注入 now 到纯函数
 * ================================================================== */

describe('[AC5·1] 时间窗边界（09:29/09:30/11:30/11:31/12:59/13:00/15:00/15:01）', () => {
  const cases: Array<[string, number, boolean]> = [
    ['09:29', 9 * 60 + 29, false],
    ['09:30', 9 * 60 + 30, true],
    ['11:30', 11 * 60 + 30, true],
    ['11:31', 11 * 60 + 31, false],
    ['12:59', 12 * 60 + 59, false],
    ['13:00', 13 * 60, true],
    ['15:00', 15 * 60, true],
    ['15:01', 15 * 60 + 1, false],
  ]

  for (const [label, minuteOfDay, expected] of cases) {
    it(`${label}（minuteOfDay=${minuteOfDay}）→ ${expected ? '在窗口' : '非窗口'}`, () => {
      expect(isPulseMinute(minuteOfDay)).toBe(expected)
      // isInPulseWindow 走 shanghaiParts，构造对应 UTC（沪 = UTC+8）。
      const hh = String(Math.floor(minuteOfDay / 60)).padStart(2, '0')
      const mm = String(minuteOfDay % 60).padStart(2, '0')
      expect(isInPulseWindow(utc(`2026-09-29T${hh}:${mm}:00+08:00`))).toBe(expected)
    })
  }

  it('PULSE_WINDOWS 恰为 [570,690] 与 [780,900]，步长 30 秒，时区锁定 Asia/Shanghai', () => {
    expect(PULSE_WINDOWS).toEqual([
      [570, 690],
      [780, 900],
    ])
    expect(PULSE_STEP_SECONDS).toBe(30)
    expect(SHANGHAI_TIME_ZONE).toBe('Asia/Shanghai')
    // 窗口端点即 09:30-11:30 / 13:00-15:00
    expect(PULSE_WINDOWS[0]).toEqual([9 * 60 + 30, 11 * 60 + 30])
    expect(PULSE_WINDOWS[1]).toEqual([13 * 60, 15 * 60])
    expect(REVIEW_MINUTE).toBe(18 * 60 + 30)
    expect(PREP_MINUTE).toBe(9 * 60 + 25)
  })

  it('shanghaiParts 锁时区：UTC 01:29 → 上海 09:29', () => {
    const p = shanghaiParts(utc('2026-09-29T01:29:00Z'))
    expect(p.hour).toBe(9)
    expect(p.minute).toBe(29)
    expect(p.minuteOfDay).toBe(9 * 60 + 29)
  })

  it('nextPulseInstant 严格未来 + 30 秒对齐（窗口内）', () => {
    // 09:29:00（窗口外）→ 09:30:00
    expect(shanghaiMinuteOfDay('2026-09-29T01:29:00Z')).toBe(569)
    let p = shanghaiParts(nextPulseInstant(utc('2026-09-29T01:29:00Z')))
    expect(p.minuteOfDay).toBe(9 * 60 + 30)
    expect(p.second).toBe(0)
    // 09:30:00 整 → 09:30:30（不含自身）
    p = shanghaiParts(nextPulseInstant(utc('2026-09-29T01:30:00Z')))
    expect(p.minuteOfDay).toBe(9 * 60 + 30)
    expect(p.second).toBe(30)
    // 09:30:30.000 整 → 09:31:00
    p = shanghaiParts(nextPulseInstant(utc('2026-09-29T01:30:30Z')))
    expect(p.minuteOfDay).toBe(9 * 60 + 31)
    expect(p.second).toBe(0)
    // 09:31:07 → 09:31:30
    p = shanghaiParts(nextPulseInstant(utc('2026-09-29T01:31:07Z')))
    expect(p.minuteOfDay).toBe(9 * 60 + 31)
    expect(p.second).toBe(30)
    // 11:30:00 整 → 13:00:00（11:30:30 越界）
    p = shanghaiParts(nextPulseInstant(utc('2026-09-29T03:30:00Z')))
    expect(p.minuteOfDay).toBe(13 * 60)
    expect(p.second).toBe(0)
    // 13:00:00 → 13:00:30
    p = shanghaiParts(nextPulseInstant(utc('2026-09-29T05:00:00Z')))
    expect(p.minuteOfDay).toBe(13 * 60)
    expect(p.second).toBe(30)
  })

  it('nextPulseInstant 跨午休顺延：11:30 → 13:00', () => {
    expect(shanghaiParts(nextPulseInstant(utc('2026-09-29T03:30:00Z'))).minuteOfDay).toBe(13 * 60)
    // 11:31 / 12:00 / 12:59 均顺延到 13:00
    for (const iso of ['2026-09-29T03:31:00Z', '2026-09-29T04:00:00Z', '2026-09-29T04:59:00Z']) {
      expect(shanghaiParts(nextPulseInstant(utc(iso))).minuteOfDay).toBe(13 * 60)
    }
  })

  it('nextPulseInstant 跨日顺延：收盘后与盘前均指向次日/当日 09:30', () => {
    // 15:00 整 → 次日 09:30
    const afterClose = nextPulseInstant(utc('2026-09-29T07:00:00Z'))
    expect(shanghaiParts(afterClose).minuteOfDay).toBe(9 * 60 + 30)
    expect(shanghaiParts(afterClose).day).toBe(30)
    // 15:01 → 次日 09:30
    expect(shanghaiParts(nextPulseInstant(utc('2026-09-29T07:01:00Z'))).day).toBe(30)
    // 08:00 → 当日 09:30
    const preOpen = nextPulseInstant(utc('2026-09-29T00:00:00Z'))
    expect(shanghaiParts(preOpen).minuteOfDay).toBe(9 * 60 + 30)
    expect(shanghaiParts(preOpen).day).toBe(29)
  })

  it('nextDailyInstant：当日未到即当日，已过即次日', () => {
    expect(shanghaiParts(nextDailyInstant(utc('2026-09-29T01:00:00Z'), REVIEW_MINUTE)).minuteOfDay).toBe(REVIEW_MINUTE)
    const past = nextDailyInstant(utc('2026-09-29T12:00:00Z'), REVIEW_MINUTE) // 20:00（已过 18:30）
    expect(shanghaiParts(past).day).toBe(30)
    expect(shanghaiParts(past).minuteOfDay).toBe(REVIEW_MINUTE)
    expect(shanghaiParts(nextDailyInstant(utc('2026-09-29T01:00:00Z'), PREP_MINUTE)).minuteOfDay).toBe(PREP_MINUTE)
  })
})

/* ================================================================== *
 * 验收点 5（isTradingDay 挡板）—— #2
 * 验收点 6（stop 清 timer）—— #3
 * ================================================================== */

describe('[AC5·2] isTradingDay 挡板', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('isTradingDay=false → 到点不触发 onPulse（且链条不断）', async () => {
    vi.setSystemTime(utc('2026-09-29T01:31:00Z')) // 周二 09:31
    const onPulse = vi.fn()
    const isTradingDay = vi.fn(() => false)
    const sched = createScheduler({ onPulse, onReview: vi.fn(), isTradingDay, logger: () => {} })
    sched.start()
    await vi.advanceTimersByTimeAsync(10 * 60_000) // 覆盖 09:35 / 09:40
    expect(onPulse).toHaveBeenCalledTimes(0)
    expect(isTradingDay).toHaveBeenCalled()
    expect(sched.running).toBe(true)
    sched.stop()
  })

  it('isTradingDay=true → 到点触发 onPulse', async () => {
    vi.setSystemTime(utc('2026-09-29T01:31:00Z'))
    const onPulse = vi.fn()
    const sched = createScheduler({ onPulse, onReview: vi.fn(), isTradingDay: () => true, logger: () => {} })
    sched.start()
    await vi.advanceTimersByTimeAsync(30_000) // → 09:31:30
    expect(onPulse).toHaveBeenCalledTimes(1)
    const p = shanghaiParts(onPulse.mock.calls[0][0] as Date)
    expect(p.minuteOfDay).toBe(9 * 60 + 31)
    expect(p.second).toBe(30)
    sched.stop()
  })

  it('盘后复盘 / 盘前准备同样受交易日挡板约束（review 18:30）', async () => {
    vi.setSystemTime(utc('2026-09-29T10:20:00Z')) // 18:20
    const onReview = vi.fn()
    const sched = createScheduler({
      onPulse: vi.fn(),
      onReview,
      isTradingDay: () => false,
      logger: () => {},
    })
    sched.start()
    await vi.advanceTimersByTimeAsync(10 * 60_000) // → 18:30
    expect(onReview).toHaveBeenCalledTimes(0)
    sched.stop()
  })
})

describe('[AC6] stop() 清空所有 timer（无泄漏）+ 幂等', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('start 后有且仅有 1 个定时器；stop 后归 0；再 stop 幂等', async () => {
    vi.setSystemTime(utc('2026-09-29T01:31:00Z'))
    const onPulse = vi.fn()
    const sched = createScheduler({ onPulse, onReview: vi.fn(), isTradingDay: () => true, logger: () => {} })
    sched.start()
    expect(vi.getTimerCount()).toBe(1)
    sched.stop()
    expect(sched.running).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
    // 幂等：二次 stop 不抛、仍为 0
    expect(() => sched.stop()).not.toThrow()
    expect(vi.getTimerCount()).toBe(0)
    // 推进任意时长均不再触发
    await vi.advanceTimersByTimeAsync(120 * 60_000)
    expect(onPulse).toHaveBeenCalledTimes(0)
  })

  it('start 幂等：重复 start 不叠加定时器', async () => {
    vi.setSystemTime(utc('2026-09-29T01:31:00Z'))
    const sched = createScheduler({
      onPulse: vi.fn(),
      onReview: vi.fn(),
      isTradingDay: () => true,
      logger: () => {},
    })
    sched.start()
    sched.start()
    expect(vi.getTimerCount()).toBe(1)
    sched.stop()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('注入 setTimer/clearTimer：pending 计数器 start=1 / stop=0（不依赖宿主计时器实现）', () => {
    let nextId = 1
    const live = new Set<number>()
    const setTimer = vi.fn((_h: () => void, _d: number) => {
      const id = nextId++
      live.add(id)
      return id
    })
    const clearTimer = vi.fn((h: number) => {
      live.delete(h)
    })
    const opts: SchedulerOptions = {
      onPulse: vi.fn(),
      onReview: vi.fn(),
      isTradingDay: () => true,
      now: () => utc('2026-09-29T01:31:00Z'),
      setTimer: setTimer as unknown as SchedulerOptions['setTimer'],
      clearTimer: clearTimer as unknown as SchedulerOptions['clearTimer'],
      logger: () => {},
    }
    const sched = createScheduler(opts)
    sched.start()
    expect(setTimer).toHaveBeenCalledTimes(1)
    expect(live.size).toBe(1)
    sched.stop()
    expect(clearTimer).toHaveBeenCalledTimes(1)
    expect(live.size).toBe(0)
    sched.stop() // 幂等，不再调用 clearTimer
    expect(clearTimer).toHaveBeenCalledTimes(1)
    expect(live.size).toBe(0)
  })
})

/* ================================================================== *
 * 验收点 5（调度层窗口过滤）
 * ================================================================== */

describe('[AC5·3] 调度层：午休/收盘后不触发，进入窗口才触发', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('11:31 启动 → 午休区间不触发，13:00 触发', async () => {
    vi.setSystemTime(utc('2026-09-29T03:31:00Z')) // 11:31
    const onPulse = vi.fn()
    const sched = createScheduler({ onPulse, onReview: vi.fn(), isTradingDay: () => true, logger: () => {} })
    sched.start()
    await vi.advanceTimersByTimeAsync(88 * 60_000) // → 12:59
    expect(onPulse).toHaveBeenCalledTimes(0)
    await vi.advanceTimersByTimeAsync(60_000) // → 13:00
    expect(onPulse).toHaveBeenCalledTimes(1)
    expect(shanghaiParts(onPulse.mock.calls[0][0] as Date).minuteOfDay).toBe(13 * 60)
    sched.stop()
  })

  it('盘中连续脉冲：9:30:00 起每 30 秒触发', async () => {
    vi.setSystemTime(utc('2026-09-29T01:30:00Z')) // 09:30:00
    const onPulse = vi.fn()
    const sched = createScheduler({ onPulse, onReview: vi.fn(), isTradingDay: () => true, logger: () => {} })
    sched.start()
    await vi.advanceTimersByTimeAsync(90_000) // → 09:31:30，覆盖 09:30:30 / 09:31:00 / 09:31:30
    expect(onPulse).toHaveBeenCalledTimes(3)
    const stamps = onPulse.mock.calls.map((c) => {
      const p = shanghaiParts(c[0] as Date)
      return p.minuteOfDay * 60 + p.second
    })
    expect(stamps).toEqual([9 * 3600 + 30 * 60 + 30, 9 * 3600 + 31 * 60, 9 * 3600 + 31 * 60 + 30])
    sched.stop()
  })

  it('复盘 / 盘前 9:25（可选）在窗口外按时刻触发', async () => {
    vi.setSystemTime(utc('2026-09-29T01:20:00Z')) // 09:20
    const onPrep = vi.fn()
    const onReview = vi.fn()
    const sched = createScheduler({
      onPulse: vi.fn(),
      onReview,
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
})

/* ================================================================== *
 * 验收点 4 / 9：零第三方 cron 依赖，原生 setTimeout 链式自调度
 * ================================================================== */

describe('[AC4/AC9] 零第三方 cron 依赖', () => {
  const FORBIDDEN = [
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

  it('package.json 的 dependencies / devDependencies / peerDependencies 均无 cron 类库', () => {
    const pkg = JSON.parse(readFileSync(`${REPO_ROOT}/package.json`, 'utf8')) as {
      dependencies?: Record<string, string>
      devDependencies?: Record<string, string>
      peerDependencies?: Record<string, string>
    }
    const all = {
      ...(pkg.dependencies ?? {}),
      ...(pkg.devDependencies ?? {}),
      ...(pkg.peerDependencies ?? {}),
    }
    const names = Object.keys(all)
    for (const bad of FORBIDDEN) {
      expect(names, `不应依赖 ${bad}`).not.toContain(bad)
    }
  })

  it('src/runner 源码不导入任何 cron 类库', () => {
    const files = [
      'types',
      'json',
      'bindings',
      'wake',
      'sensor-runner',
      'scheduler',
      'index',
    ]
    for (const f of files) {
      const src = readFileSync(`${REPO_ROOT}/src/runner/${f}.ts`, 'utf8')
      const imports = [...src.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]!)
      for (const spec of imports) {
        for (const bad of FORBIDDEN) {
          expect(spec, `${f}.ts 不应导入 ${spec}`).not.toBe(bad)
        }
      }
    }
  })

  it('scheduler 经注入 setTimer 布置定时器（原生 setTimeout 语义），无 cron 抽象', () => {
    const setTimer = vi.fn((_h: () => void, _d: number) => 0)
    const clearTimer = vi.fn()
    const sched = createScheduler({
      onPulse: vi.fn(),
      onReview: vi.fn(),
      isTradingDay: () => true,
      now: () => utc('2026-09-29T01:31:00Z'),
      setTimer: setTimer as unknown as SchedulerOptions['setTimer'],
      clearTimer: clearTimer as unknown as SchedulerOptions['clearTimer'],
      logger: () => {},
    })
    sched.start()
    // 链式自调度：布置的是「下一个候选时刻」的延迟毫秒（数），而非 cron 表达式。
    expect(setTimer).toHaveBeenCalledTimes(1)
    const delay = setTimer.mock.calls[0]![1]
    expect(typeof delay).toBe('number')
    expect(delay).toBeGreaterThan(0)
    sched.stop()
  })
})

/* ================================================================== *
 * 验收点 2（bindings 只读面）—— #4
 * ================================================================== */

function makeSources(): SensorBindingSources {
  const ledger = {
    list: vi.fn(() => LEDGER_SYMBOLS),
    query: vi.fn((symbol: string) => ({
      symbol,
      type: 'etf',
      name: '科创50ETF',
      qty: 1000,
      avgCost: 1.5,
      cash: 100,
      realizedPnl: 0,
      floatPnl: 12.5,
    })),
  }
  const quotes = {
    realtime: vi.fn(async (symbol: string, type?: string) => ({ symbol, type, price: 1.66 })),
    intraday: vi.fn(async (symbol: string) => [{ symbol, price: 1.6 }]),
    history: vi.fn(async (symbol: string, days: number) => [{ symbol, price: 1.5, days }]),
  }
  return { ledger, quotes } as unknown as SensorBindingSources
}

function ns(bindings: PtcBindingNamespace[], global: string): PtcBindingNamespace {
  const found = bindings.find((b) => b.global === global)
  if (!found) throw new Error(`missing namespace ${global}`)
  return found
}

describe('[AC2/#4] bindings 只读面严格等于 5 方法，无任何写方法', () => {
  it('恰有 3 个命名空间：symbols / quote / ledger', () => {
    const bindings = createSensorBindings(makeSources())
    expect(bindings.length).toBe(3)
    expect(bindings.map((b) => b.global)).toEqual([...SENSOR_BINDING_GLOBALS])
    expect([...SENSOR_BINDING_GLOBALS]).toEqual(['symbols', 'quote', 'ledger'])
  })

  it('方法名集合严格等于 {symbols.list, quote.realtime, quote.intraday, quote.history, ledger.get}', () => {
    const bindings = createSensorBindings(makeSources())
    const methods = bindings.flatMap((b) =>
      Object.keys(b.functions).map((name) => `${b.global}.${name}`),
    )
    expect(new Set(methods)).toEqual(new Set(SENSOR_READONLY_METHODS))
    expect(SENSOR_READONLY_METHODS).toEqual([
      'symbols.list',
      'quote.realtime',
      'quote.intraday',
      'quote.history',
      'ledger.get',
    ])
    // 严格：无遗漏、无多余
    expect(methods.length).toBe(SENSOR_READONLY_METHODS.length)
  })

  it('无任何写 / 交易 / 提交方法（逐命名空间核查）', () => {
    const bindings = createSensorBindings(makeSources())
    const quoteFns = Object.keys(ns(bindings, 'quote').functions)
    expect(quoteFns.sort()).toEqual(['history', 'intraday', 'realtime'])
    expect(Object.keys(ns(bindings, 'symbols').functions)).toEqual(['list'])
    expect(Object.keys(ns(bindings, 'ledger').functions)).toEqual(['get'])
    for (const b of bindings) {
      for (const [name, fn] of Object.entries(b.functions)) {
        expect(typeof fn, `${b.global}.${name} 应为函数`).toBe('function')
        // 单参数契约（PTC 绑定成员为单参数）
        expect(fn.length, `${b.global}.${name} 参数应 <=1 个`).toBeLessThanOrEqual(1)
      }
      // 命名空间对象仅含 global / functions（无 errorClass / 无额外键）
      expect(Object.keys(b).sort()).toEqual(['functions', 'global'])
    }
  })

  it('每个方法返回值均为无损 JSON', async () => {
    const bindings = createSensorBindings(makeSources())
    const calls: Array<[string, string, unknown]> = [
      ['symbols', 'list', undefined],
      ['quote', 'realtime', '588000'],
      ['quote', 'intraday', '588000'],
      ['quote', 'history', '588000'],
      ['ledger', 'get', '588000'],
    ]
    for (const [g, n, args] of calls) {
      const fn = ns(bindings, g).functions[n]!
      const value = await fn(args)
      expect(JSON.parse(JSON.stringify(value))).toEqual(value)
    }
  })

  it('quote.* 类型路由：显式 type > ledger 回查 > undefined（前缀推断）', async () => {
    const s = makeSources()
    const bindings = createSensorBindings(s)
    await ns(bindings, 'quote').functions.realtime!('588000')
    expect((s.quotes.realtime as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]).toEqual(['588000', 'etf'])
    await ns(bindings, 'quote').functions.realtime!({ symbol: '999999', type: 'stock' })
    expect((s.quotes.realtime as unknown as { mock: { calls: unknown[][] } }).mock.calls[1]).toEqual(['999999', 'stock'])
  })

  it('quote.history days 解析：默认 / 数组 / 对象', async () => {
    const s = makeSources()
    const bindings = createSensorBindings(s)
    const history = ns(bindings, 'quote').functions.history!
    const hc = (s.quotes.history as unknown as { mock: { calls: unknown[][] } }).mock
    await history('588000')
    expect(hc.calls[0]![1]).toBe(DEFAULT_HISTORY_DAYS)
    await history(['588000', 30])
    expect(hc.calls[1]![1]).toBe(30)
    await history({ symbol: '588000', days: 5 })
    expect(hc.calls[2]![1]).toBe(5)
  })

  it('缺 symbol 时拒绝', async () => {
    const bindings = createSensorBindings(makeSources())
    await expect(ns(bindings, 'quote').functions.realtime!(undefined)).rejects.toThrow(/symbol/)
    await expect(ns(bindings, 'ledger').functions.get!({})).rejects.toThrow(/symbol/)
  })
})

/* ================================================================== *
 * 验收点 1 / 3 —— #5 #6 #7 #10 #11
 * ================================================================== */

describe('[AC1/#7] sensor-runner 取 code 并 resolve→run（只读沙箱）', () => {
  it('先 current() 取版本、read(version).code 作 program，随后 resolve(request) → run(spec)', async () => {
    const registry = makeRegistry()
    const { runner, bundle } = makeRunner({ senseRegistry: registry })
    await runner.run('pulse')
    expect(registry.current).toHaveBeenCalledTimes(1)
    expect(registry.read).toHaveBeenCalledWith('v002')
    expect(bundle.calls).toEqual(['resolve', 'run'])
    expect(bundle.requests[0]!.program).toBe(SCRIPT_CODE)
    expect(bundle.requests[0]!.bindings.map((b) => b.global)).toEqual(['symbols', 'quote', 'ledger'])
    expect(bundle.requests[0]!.sandboxPolicy).toEqual({ mode: 'read-only', workspaceRoot: '/data/root' })
    expect(bundle.specs[0]!.sandboxPolicy!.mode).toBe('read-only')
    expect(bundle.specs[0]!.cwd).toBe('/data/root')
  })
})

describe('[AC3/#5] shouldWake 真 / 假两条路径', () => {
  it('shouldWake=true → 投递唤醒，payload 含 symbol/summary/version，outcome=woke', async () => {
    const { runner, waker } = makeRunner()
    const outcome = await runner.run('pulse')
    expect(outcome.kind).toBe('woke')
    if (outcome.kind !== 'woke') throw new Error('expected woke')
    expect(outcome.symbol).toBe('588000')
    expect(outcome.targets).toBe(1)
    expect(waker).toHaveBeenCalledTimes(1)
    const payload = waker.mock.calls[0]![0]
    expect(payload.symbol).toBe('588000')
    expect(payload.summary).toBe('偏离均线 3.2%')
    expect(payload.version).toBe('v002')
    expect(payload.metrics).toEqual({ ma: 1.6 })
  })

  it('shouldWake=false → 静默结束（quiet，不投递）', async () => {
    const { runtime } = makeRuntime({ logs: [], value: { shouldWake: false } })
    const waker = vi.fn((_p: SensorWakePayload) => 1)
    const runner = createSensorRunner({
      senseRegistry: makeRegistry(),
      ledger: makeLedger(),
      quotes: makeQuotes(),
      ptcRuntime: runtime,
      dataRoot: '/data/root',
      logger: () => {},
      waker,
      wakeCooldownMs: 0,
    })
    const outcome = await runner.run('pulse')
    expect(outcome.kind).toBe('quiet')
    expect(waker).not.toHaveBeenCalled()
  })

  it('脚本返回值非法（缺 shouldWake）→ skipped，不投递', async () => {
    const { runtime } = makeRuntime({ logs: [], value: { nope: 1 } })
    const waker = vi.fn((_p: SensorWakePayload) => 1)
    const runner = createSensorRunner({
      senseRegistry: makeRegistry(),
      ledger: makeLedger(),
      quotes: makeQuotes(),
      ptcRuntime: runtime,
      dataRoot: '/data/root',
      logger: () => {},
      waker,
      wakeCooldownMs: 0,
    })
    expect((await runner.run('pulse')).kind).toBe('skipped')
    expect(waker).not.toHaveBeenCalled()
  })
})

describe('[AC3/#6] 错误路径：不抛、以结构化 outcome 表达', () => {
  it('run 返回 error 字段 → outcome=failed，failureKind 透传，不 reject', async () => {
    const { runtime } = makeRuntime({
      logs: ['boom'],
      error: { kind: 'exception', message: '脚本运行时异常' },
    })
    const runner = createSensorRunner({
      senseRegistry: makeRegistry(),
      ledger: makeLedger(),
      quotes: makeQuotes(),
      ptcRuntime: runtime,
      dataRoot: '/data/root',
      logger: () => {},
      wakeCooldownMs: 0,
    })
    const outcome = await runner.run('pulse')
    expect(outcome.kind).toBe('failed')
    if (outcome.kind !== 'failed') throw new Error('expected failed')
    expect(outcome.failureKind).toBe('exception')
    expect(outcome.detail).toContain('脚本运行时异常')
  })

  it('ptcRuntime.resolve 抛错 → outcome=failed，不 reject', async () => {
    const runtime: PtcRuntimeLike = {
      resolve: () => {
        throw new Error('resolve failed')
      },
      run: async () => ({ logs: [] }),
    }
    const runner = createSensorRunner({
      senseRegistry: makeRegistry(),
      ledger: makeLedger(),
      quotes: makeQuotes(),
      ptcRuntime: runtime,
      dataRoot: '/data/root',
      logger: () => {},
      wakeCooldownMs: 0,
    })
    const outcome = await runner.run('pulse')
    expect(outcome.kind).toBe('failed')
  })

  it('无 waker（未配置通道）→ skipped，不抛异常', async () => {
    const { runner, waker } = makeRunner({ waker: undefined })
    const outcome = await runner.run('pulse')
    expect(outcome.kind).toBe('skipped')
    expect(waker).not.toHaveBeenCalled()
  })

  it('无 current 感知脚本 → skipped，不抛异常', async () => {
    const { runner } = makeRunner({
      senseRegistry: { current: () => null, read: vi.fn() },
    })
    const outcome = await runner.run('pulse')
    expect(outcome.kind).toBe('skipped')
  })

  it('senseRegistry.read 抛错 → skipped，不抛异常', async () => {
    const { runner } = makeRunner({
      senseRegistry: {
        current: () => ({ version: 'v1', changeType: 'patch', ts: 'x' }),
        read: () => {
          throw new Error('disk error')
        },
      } as unknown as Parameters<typeof createSensorRunner>[0]['senseRegistry'],
    })
    const outcome = await runner.run('pulse')
    expect(outcome.kind).toBe('skipped')
  })
})

describe('[#10] 唤醒冷却（同一 symbol 连续两次 → 第二次 skipped）', () => {
  it('冷却期内不重复唤醒，冷却结束后可再次唤醒', async () => {
    let clock = 1_000_000
    const waker = vi.fn((_p: SensorWakePayload) => 1)
    const { runtime } = makeRuntime({
      logs: [],
      value: { shouldWake: true, symbol: '588000', summary: 's' },
    })
    const runner = createSensorRunner({
      senseRegistry: makeRegistry(),
      ledger: makeLedger(),
      quotes: makeQuotes(),
      ptcRuntime: runtime,
      dataRoot: '/r',
      logger: () => {},
      waker,
      wakeCooldownMs: 10 * 60_000,
      now: () => clock,
    })
    expect((await runner.run('pulse')).kind).toBe('woke')
    clock += 60_000
    const second = await runner.run('pulse')
    expect(second.kind).toBe('skipped')
    if (second.kind !== 'skipped') throw new Error('expected skipped')
    expect(second.detail).toContain('冷却')
    expect(waker).toHaveBeenCalledTimes(1)
    clock += 10 * 60_000
    expect((await runner.run('pulse')).kind).toBe('woke')
    expect(waker).toHaveBeenCalledTimes(2)
  })

  it('wakeCooldownMs=0 关闭冷却 → 每次都唤醒', async () => {
    const waker = vi.fn((_p: SensorWakePayload) => 1)
    const { runtime } = makeRuntime({ logs: [], value: { shouldWake: true, symbol: 'x', summary: 's' } })
    const runner = createSensorRunner({
      senseRegistry: makeRegistry(),
      ledger: makeLedger(),
      quotes: makeQuotes(),
      ptcRuntime: runtime,
      dataRoot: '/r',
      logger: () => {},
      waker,
      wakeCooldownMs: 0,
    })
    expect((await runner.run('pulse')).kind).toBe('woke')
    expect((await runner.run('pulse')).kind).toBe('woke')
    expect(waker).toHaveBeenCalledTimes(2)
  })
})

describe('[#11] 唤醒降级：无当前会话 → waker 返回 0、告警、不抛', () => {
  it('createAgentWaker 在固定会话不可达下返回 0 且记录告警', () => {
    const logs: string[] = []
    const waker = createAgentWaker({ get: () => undefined }, PINNED_SESSION_ID, (m) => logs.push(m))
    const n = waker({ reason: 'pulse', symbol: '588000', summary: 's' })
    expect(n).toBe(0)
    expect(logs.join('\n')).toMatch(/固定会话不可达|跳过唤醒/)
  })

  it('registry 抛错时 waker 返回 0（不抛异常）', () => {
    const logs: string[] = []
    const waker = createAgentWaker(
      {
        get: () => {
          throw new Error('registry down')
        },
      },
      PINNED_SESSION_ID,
      (m) => logs.push(m),
    )
    expect(() => waker({ reason: 'pulse', symbol: 'x', summary: 's' })).not.toThrow()
    expect(waker({ reason: 'pulse', symbol: 'x', summary: 's' })).toBe(0)
  })

  it('runner 层：有通道但固定会话不可达 → outcome=skipped，不抛异常', async () => {
    const waker = createAgentWaker({ get: () => undefined }, PINNED_SESSION_ID, () => {})
    const { runner } = makeRunner({ waker })
    const outcome = await runner.run('pulse')
    expect(outcome.kind).toBe('skipped')
    if (outcome.kind !== 'skipped') throw new Error('expected skipped')
    expect(outcome.detail).toContain('跳过唤醒')
  })

  it('resolveWakeTarget：定点解析固定会话，过滤无 followup / 未命中的 agent', () => {
    const pinned = { id: PINNED_SESSION_ID, followup: vi.fn() }
    const other = { id: 'other', followup: vi.fn() }
    const bad = { id: PINNED_SESSION_ID } // 无 followup
    expect(
      resolveWakeTarget(
        { get: (id: string) => (id === PINNED_SESSION_ID ? pinned : other) },
        PINNED_SESSION_ID,
      )?.id,
    ).toBe(PINNED_SESSION_ID)
    expect(resolveWakeTarget({ get: () => bad }, PINNED_SESSION_ID)).toBeUndefined()
    expect(resolveWakeTarget({ get: () => undefined }, PINNED_SESSION_ID)).toBeUndefined()
  })
})

/* ================================================================== *
 * 验收点 8：顶层 inject 严格不变
 * ================================================================== */

describe('[AC8/#8] plugin.ts 顶层 inject 严格 = [tools, skills, ptcRuntime, fs]', () => {
  it('inject 数组逐项相等且顺序一致', () => {
    expect(topLevelInject).toEqual(['tools', 'skills', 'ptcRuntime', 'fs'])
    expect(topLevelInject.length).toBe(4)
  })

  it('不含 systemPrompt / agents 等动态依赖（它们经 ctx.inject 动态声明）', () => {
    expect(topLevelInject).not.toContain('systemPrompt')
    expect(topLevelInject).not.toContain('agents')
  })
})

/* ================================================================== *
 * 附加：runReview / runPrep、json、wake 消息结构
 * ================================================================== */

describe('[附加] 复盘 / 盘前固定唤醒', () => {
  it('runReview → reason=review, symbol=*，metrics.symbols 为台账标的', async () => {
    const { runner, waker } = makeRunner()
    const outcome = await runner.runReview()
    expect(outcome.kind).toBe('woke')
    expect(waker.mock.calls[0]![0].reason).toBe('review')
    expect(waker.mock.calls[0]![0].symbol).toBe('*')
    expect(waker.mock.calls[0]![0].metrics).toEqual({ symbols: ['588000', '000001'] })
  })

  it('runPrep → reason=prep, symbol=*', async () => {
    const { runner, waker } = makeRunner()
    const outcome = await runner.runPrep()
    expect(outcome.kind).toBe('woke')
    expect(waker.mock.calls[0]![0].reason).toBe('prep')
  })
})

describe('[附加] 唤醒消息结构与摘要上限', () => {
  it('producer-owned kind（dsh-finance，非 plugin）+ notice 形态 + 正文含 symbol + 摘要 <= 120', () => {
    const msg = buildWakeMessage({ reason: 'pulse', symbol: '588000', summary: 'x'.repeat(200) })
    expect(msg.role).toBe('user')
    expect(msg.source.kind).toBe('dsh-finance')
    expect(msg.source.kind).toBe(PLUGIN_SOURCE_NAME)
    expect(msg.source.kind).not.toBe('plugin')
    expect(msg.source.kind.length).toBeGreaterThan(0)
    expect(msg.source.form).toBe('notice')
    expect(msg.source.summary.length).toBeLessThanOrEqual(WAKE_SUMMARY_MAX_CHARS)
    expect(msg.content[0]!.type).toBe('text')
    expect(msg.content[0]!.text).toContain('588000')
    expect(typeof msg.id).toBe('string')
    expect(msg.id.length).toBeGreaterThan(0)
    expect('plugin' in msg.source).toBe(false)
    expect(boundSummary('短', 5)).toBe('短')
  })
})

describe('[附加] toJsonValue 无损清洗', () => {
  it('NaN/Infinity → null；bigint → 字符串；Date → ISO；undefined 键跳过', () => {
    expect(toJsonValue(NaN)).toBeNull()
    expect(toJsonValue(Infinity)).toBeNull()
    expect(toJsonValue(10n)).toBe('10')
    expect(toJsonValue(new Date('2026-09-29T00:00:00.000Z'))).toBe('2026-09-29T00:00:00.000Z')
    expect(toJsonValue({ a: 1, b: undefined, c: null })).toEqual({ a: 1, c: null })
    expect(toJsonValue([1, undefined, NaN])).toEqual([1, null, null])
    expect(toJsonValue(undefined)).toBeNull()
  })
})

/* ================================================================== *
 * 验收点 6（集成）：applyRunner 装配 —— apply 即启动调度，effect 卸载 stop() 清 timer
 * ================================================================== */

describe('[AC6·集成] applyRunner：apply 即启动调度，effect 卸载 stop() 清空 timer', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('applyRunner → 安排 1 个定时器；调用 effect 注销器 → 归 0（无泄漏）', () => {
    vi.setSystemTime(utc('2026-09-29T01:31:00Z')) // 周二 09:31
    const tmp = mkdtempSync(join(tmpdir(), 'dsh-runner-'))
    const disposers: Array<() => void> = []
    const services: Record<string, unknown> = {
      ptcRuntime: {
        resolve: (r: unknown) => r,
        run: async () => ({ logs: [], value: { shouldWake: false } }),
      },
    }
    const ctx = {
      get: (k: string) => services[k],
      inject: (_deps: string[], cb: (c: unknown) => void) => cb({ get: () => undefined }),
      effect: (cb: () => void | (() => void)) => {
        const d = cb()
        if (typeof d === 'function') disposers.push(d)
      },
    } as unknown as Context

    applyRunner(ctx, {
      toolContextOptions: { dataRoot: tmp },
      isTradingDay: () => true,
      quotes: {
        realtime: async () => ({}),
        intraday: async () => [],
        history: async () => [],
      } as unknown as Parameters<typeof applyRunner>[1]['quotes'],
      logger: () => {},
    })

    expect(vi.getTimerCount()).toBe(1)
    expect(disposers.length).toBeGreaterThan(0)
    for (const d of disposers) d()
    expect(vi.getTimerCount()).toBe(0)
    rmSync(tmp, { recursive: true, force: true })
  })

  it('ptcRuntime 不可用（软取失败）→ 不启动调度、不抛异常', () => {
    const ctx = {
      get: () => undefined,
      inject: () => {},
      effect: () => {},
    } as unknown as Context
    expect(() => applyRunner(ctx, { logger: () => {} })).not.toThrow()
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('[附加] parseSensorResult 形态校验', () => {
  it('接受合法、拒绝非法', () => {
    expect(parseSensorResult({ shouldWake: false })).toEqual({ shouldWake: false })
    expect(parseSensorResult({ shouldWake: true, symbol: 'x', summary: 'y' })).toMatchObject({
      shouldWake: true,
      symbol: 'x',
    })
    expect(parseSensorResult({})).toBeNull()
    expect(parseSensorResult([])).toBeNull()
    expect(parseSensorResult(null)).toBeNull()
    expect(parseSensorResult(42)).toBeNull()
  })
})
