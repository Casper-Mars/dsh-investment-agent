/**
 * 独立运行时边界验证（Tester 补充测试，独立于 Developer 的 quotes/providers 用例）。
 *
 * 用「可控 mock provider」从外部独立验证抽象层的运行时行为，重点：
 *   验收点 1  type 路由正确性（etf/stock 分离 + 159/588 前缀）
 *   验收点 2  降级链完整性（primary 恒失败、无缓存 → unavailable 且不抛异常；
 *             有缓存 → source=cache）
 *   验收点 2  重试次数（第 N 次才成功 / 每次失败调用次数 = retries）
 *   验收点 3  停牌/涨跌停状态透传
 *   验收点 4  isTradingDay + nextTradingDay（独立 mock HolidayProvider）
 *   验收点 5  任意 symbol（000858 / 300750 走通路由）
 *
 * 全部使用注入 mock，不产生任何真实网络请求。
 */
import { describe, it, expect } from 'vitest'
import type { AssetType, Quote, QuoteProvider } from '../src/lib/quote-types.js'
import { QuoteClient } from '../src/lib/quotes.js'
import { inferAssetType, inferMarket } from '../src/lib/quote-types.js'
import { TradingCalendar, isWeekend, dateKey } from '../src/lib/trading-calendar.js'
import type { HolidayProvider } from '../src/lib/trading-calendar.js'

function quote(
  type: AssetType,
  source: string,
  symbol: string,
  overrides: Partial<Quote> = {},
): Quote {
  return {
    symbol,
    name: 'x',
    type,
    price: 1.0,
    open: 1.0,
    high: 1.0,
    low: 1.0,
    prevClose: 1.0,
    volume: 1000,
    amount: 1000,
    ts: Date.now(),
    status: 'trading',
    source,
    ...overrides,
  }
}

function provider(
  type: AssetType,
  name: string,
  fn: (symbol: string) => Promise<Quote>,
): QuoteProvider {
  return {
    type,
    name,
    realtime: fn,
    intraday: async (s) => [await fn(s)],
    history: async (s) => [await fn(s)],
  }
}

describe('验收点 1：type 路由正确性（独立验证）', () => {
  it('588000 路由到 etf provider，600519 路由到 stock provider，159xxx 路由到 etf', async () => {
    const client = new QuoteClient({ retries: 0, cacheEnabled: false })

    // 记录每个 provider 被调用的调用数
    let etfCalls = 0
    let stockCalls = 0

    const etf = provider('etf', 'p-etf', async (s) => {
      etfCalls++
      return quote('etf', 'p-etf', s)
    })
    const stock = provider('stock', 'p-stock', async (s) => {
      stockCalls++
      return quote('stock', 'p-stock', s)
    })

    client.setChain('etf', etf)
    client.setChain('stock', stock)

    const q1 = await client.realtime('588000') // 5 开头 → etf
    expect(q1.source).toBe('p-etf')

    const q2 = await client.realtime('600519') // 6 开头 → stock
    expect(q2.source).toBe('p-stock')

    const q3 = await client.realtime('159915') // 1 开头 → etf（深 ETF）
    expect(q3.source).toBe('p-etf')

    expect(etfCalls).toBe(2) // 588000 + 159915
    expect(stockCalls).toBe(1) // 600519
  })

  it('inferAssetType 对 159 前缀判为 etf（深市 ETF）', () => {
    expect(inferAssetType('159915')).toBe('etf')
    expect(inferAssetType('588000')).toBe('etf')
    expect(inferAssetType('600519')).toBe('stock')
    expect(inferMarket('159915')).toBe(0)
  })
})

describe('验收点 2：降级链完整性（独立验证）', () => {
  it('primary 恒失败 + fallback 也失败 + 无缓存 → unavailable，且不抛异常', async () => {
    const client = new QuoteClient({ retries: 0, baseDelayMs: 1, cacheEnabled: false })
    const bad = provider('etf', 'bad', async () => {
      throw new Error('boom')
    })
    client.setChain('etf', bad, bad)

    // 必须 resolves（不 reject）
    await expect(client.realtime('588000')).resolves.toBeTruthy()
    const q = await client.realtime('588000')
    expect(q.status).toBe('unavailable')
    expect(q.source).toBe('unavailable')
    expect(q.symbol).toBe('588000')
    expect(q.type).toBe('etf')
  })

  it('primary 失败但存在缓存 → source=cache', async () => {
    const client = new QuoteClient({ retries: 0, baseDelayMs: 1, cacheEnabled: true })
    let down = false
    const p = provider('stock', 'mock', async (s) => {
      if (down) throw new Error('down')
      return quote('stock', 'mock', s)
    })
    client.setChain('stock', p)

    await client.realtime('600519') // 成功后写缓存
    down = true
    const q = await client.realtime('600519') // 失败读缓存

    expect(q.source).toBe('cache')
    expect(q.symbol).toBe('600519')
    expect(q.price).toBe(1.0) // 缓存内容完整
  })
})

describe('验收点 2（重试次数）：独立验证调用计数', () => {
  it('primary 每次失败：调用次数 = 初次 + retries 次重试', async () => {
    const retries = 4
    let calls = 0
    const client = new QuoteClient({ retries, baseDelayMs: 1, cacheEnabled: false })
    const p = provider('etf', 'always-fail', async () => {
      calls++
      throw new Error('boom')
    })
    // fallback 也指向同一 provider，避免备用源改变计数
    client.setChain('etf', p, p)

    await client.realtime('588000')
    // 初次 + retries 次重试 = retries + 1 次（primary），
    // 之后 fallback（同一实例）又触发一轮同等次数。
    // 因 primary === fallback，providers 数组会去重为单一实例。
    expect(calls).toBe(retries + 1)
  })

  it('第 3 次才成功：确实进行了重试后返回结果', async () => {
    const client = new QuoteClient({ retries: 5, baseDelayMs: 1, cacheEnabled: false })
    let calls = 0
    const p = provider('etf', 'flaky', async (s) => {
      calls++
      if (calls < 3) throw new Error('not yet')
      return quote('etf', 'flaky', s)
    })
    client.setChain('etf', p)

    const q = await client.realtime('588000')
    expect(q.source).toBe('flaky')
    expect(calls).toBe(3) // 第 3 次成功
  })
})

describe('验收点 3：停牌/涨跌停状态标记透传', () => {
  it('suspended / limit_up / limit_down 原样透传，感知层可识别', async () => {
    const client = new QuoteClient({ retries: 0, cacheEnabled: false })

    const cases: Array<[string, Quote['status']]> = [
      ['suspended', 'suspended'],
      ['limit_up', 'limit_up'],
      ['limit_down', 'limit_down'],
    ]
    const p = provider('stock', 'stub', async (s) => {
      const hit = cases.find((c) => c[0] === s)
      return quote('stock', 'stub', '600519', {
        status: hit ? hit[1] : 'trading',
      })
    })
    client.setChain('stock', p)

    const q1 = await client.realtime('suspended')
    expect(q1.status).toBe('suspended')

    const q2 = await client.realtime('limit_up')
    expect(q2.status).toBe('limit_up')

    const q3 = await client.realtime('limit_down')
    expect(q3.status).toBe('limit_down')
  })
})

describe('验收点 4：isTradingDay + nextTradingDay（独立 mock）', () => {
  const mkCal = (holidays: Set<string>, fail = false): TradingCalendar => {
    const providerImpl: HolidayProvider = {
      name: 'tester-holiday',
      holidays: async () => {
        if (fail) throw new Error('down')
        return holidays
      },
    }
    return new TradingCalendar(providerImpl)
  }

  it('周六/周日 → false', async () => {
    const cal = mkCal(new Set())
    expect(await cal.isTradingDay(new Date(2026, 8, 26))).toBe(false) // 周六
    expect(await cal.isTradingDay(new Date(2026, 8, 27))).toBe(false) // 周日
  })

  it('工作日命中节假日 → false', async () => {
    const cal = mkCal(new Set(['2026-10-01']))
    expect(await cal.isTradingDay(new Date(2026, 9, 1))).toBe(false) // 周四休市
    expect(await cal.isTradingDay(new Date(2026, 9, 2))).toBe(true) // 非节假日
  })

  it('provider 抛异常 → 降级为工作日 true（不抛异常）', async () => {
    const cal = mkCal(new Set(), true) // fail=true
    await expect(cal.isTradingDay(new Date(2026, 8, 29))).resolves.toBe(true)
    expect(await cal.isTradingDay(new Date(2026, 8, 26))).toBe(false) // 周末仍 false
  })

  it('nextTradingDay：周五 → 周一（跨周末顺延）', async () => {
    const cal = mkCal(new Set())
    // 2026-10-02 周五 → 10-03/04 周末 → 10-05 周一
    const next = await cal.nextTradingDay(new Date(2026, 9, 2))
    expect(dateKey(next)).toBe('2026-10-05')
    expect(isWeekend(new Date(2026, 9, 3))).toBe(true)
    expect(isWeekend(new Date(2026, 9, 4))).toBe(true)
  })
})

describe('验收点 5：任意 symbol 不写死（独立验证）', () => {
  it('000858 / 300750 走通路由不报错', async () => {
    const client = new QuoteClient({ retries: 0, cacheEnabled: false })
    const seen: string[] = []
    const p = provider('stock', 'mock', async (s) => {
      seen.push(s)
      return quote('stock', 'mock', s)
    })
    client.setChain('stock', p)

    await expect(client.realtime('000858')).resolves.toBeTruthy()
    await expect(client.realtime('300750')).resolves.toBeTruthy()
    expect(seen).toEqual(['000858', '300750'])
  })
})