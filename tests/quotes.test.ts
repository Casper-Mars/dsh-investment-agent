/**
 * lib/quotes.ts 单元测试。
 * 覆盖验收点 1/2/3/5：
 *   1. realtime/intraday/history 返回统一 Quote，按 type 正确路由
 *   2. 数据源失败：重试 N 次 + 降级缓存/标记 unavailable，不抛未捕获异常
 *   3. 停牌/涨跌停返回带状态标记的 Quote
 *   5. 任意 symbol，不写死 588000
 *
 * 网络部分用注入 mock provider（不依赖真实网络）。
 */
import { describe, it, expect, vi } from 'vitest'
import type {
  Quote,
  QuoteProvider,
  AssetType,
} from '../src/lib/quote-types.js'
import { QuoteClient } from '../src/lib/quotes.js'
import { inferAssetType, inferMarket } from '../src/lib/quote-types.js'

/** 构造一个可编程的 mock provider。 */
function mockProvider(
  type: AssetType,
  name: string,
  hooks?: {
    realtime?: (symbol: string) => Quote
    intraday?: (symbol: string) => Quote[]
    history?: (symbol: string, days: number) => Quote[]
  },
): QuoteProvider {
  return {
    type,
    name,
    realtime: hooks?.realtime ?? (() => Promise.resolve(makeQuote(type, name))),
    intraday:
      hooks?.intraday ?? ((s) => Promise.resolve([makeQuote(type, name, s)])),
    history:
      hooks?.history ??
      ((s) => Promise.resolve([makeQuote(type, name, s)])),
  }
}

function makeQuote(
  type: AssetType,
  source: string,
  symbol = '588000',
  overrides: Partial<Quote> = {},
): Quote {
  return {
    symbol,
    name: type === 'etf' ? '科创50ETF' : '平安银行',
    type,
    price: 1.657,
    open: 1.642,
    high: 1.665,
    low: 1.636,
    prevClose: 1.643,
    volume: 36478079,
    amount: 6021782656,
    ts: Date.now(),
    status: 'trading',
    source,
    ...overrides,
  }
}

describe('QuoteClient 路由（验收点 1/5）', () => {
  it('realtime 按 type 路由到正确 provider', async () => {
    const client = new QuoteClient({ retries: 0, cacheEnabled: false })
    const etf = mockProvider('etf', 'mock-etf')
    const stock = mockProvider('stock', 'mock-stock')
    client.setChain('etf', etf)
    client.setChain('stock', stock)

    const qEtf = await client.realtime('588000')
    const qStock = await client.realtime('000001')

    expect(qEtf.source).toBe('mock-etf')
    expect(qEtf.type).toBe('etf')
    expect(qStock.source).toBe('mock-stock')
    expect(qStock.type).toBe('stock')
  })

  it('三个方法均支持任意 symbol，不写死 588000', async () => {
    const client = new QuoteClient({ retries: 0, cacheEnabled: false })
    const seen: string[] = []
    const p = mockProvider('stock', 'mock-stock', {
      realtime: (s) => {
        seen.push(s)
        return makeQuote('stock', 'mock-stock', s)
      },
      intraday: (s) => {
        seen.push(s)
        return [makeQuote('stock', 'mock-stock', s)]
      },
      history: (s) => {
        seen.push(s)
        return [makeQuote('stock', 'mock-stock', s)]
      },
    })
    client.setChain('stock', p)

    await client.realtime('600519')
    await client.intraday('300750')
    await client.history('000858', 5)

    expect(seen).toEqual(['600519', '300750', '000858'])
  })

  it('realtime/intraday/history 返回统一 Quote 结构（字段一致）', async () => {
    const client = new QuoteClient({ retries: 0, cacheEnabled: false })
    client.setChain('etf', mockProvider('etf', 'mock-etf'))

    const rt = await client.realtime('588000')
    const id = await client.intraday('588000')
    const h = await client.history('588000', 5)

    const keys = [
      'symbol',
      'name',
      'type',
      'price',
      'open',
      'high',
      'low',
      'prevClose',
      'volume',
      'amount',
      'ts',
      'status',
      'source',
    ]
    for (const k of keys) {
      expect(rt).toHaveProperty(k)
      expect(id[0]).toHaveProperty(k)
      expect(h[0]).toHaveProperty(k)
    }
  })
})

describe('QuoteClient 失败降级（验收点 2）', () => {
  it('主源失败后切换到备用源', async () => {
    const alerts: string[] = []
    const client = new QuoteClient({
      retries: 0,
      cacheEnabled: false,
      onAlert: (m) => alerts.push(m),
    })

    const primary = mockProvider('etf', 'mock-primary', {
      realtime: () => Promise.reject(new Error('primary down')),
    })
    const fallback = mockProvider('etf', 'mock-fallback')
    client.setChain('etf', primary, fallback)

    const q = await client.realtime('588000')
    expect(q.source).toBe('mock-fallback')
    expect(q.status).not.toBe('unavailable')
  })

  it('主源重试 N 次后再降级（不抛异常）', async () => {
    const retries = 3
    let attempts = 0
    const client = new QuoteClient({
      retries,
      baseDelayMs: 1,
      cacheEnabled: false,
    })

    const primary = mockProvider('etf', 'mock-primary', {
      realtime: () => {
        attempts++
        return Promise.reject(new Error('boom'))
      },
    })
    const fallback = mockProvider('etf', 'mock-fallback')
    client.setChain('etf', primary, fallback)

    await expect(client.realtime('588000')).resolves.toBeTruthy()
    // 初次 + retries 次重试 = retries + 1 次调用主源。
    expect(attempts).toBe(retries + 1)
  })

  it('全部源失败且无缓存时返回 unavailable 占位，绝不抛未捕获异常', async () => {
    const client = new QuoteClient({
      retries: 0,
      baseDelayMs: 1,
      cacheEnabled: false,
    })
    const primary = mockProvider('etf', 'mock-primary', {
      realtime: () => Promise.reject(new Error('x')),
    })
    // 备用源 = 主源（无独立备用），全部失败。
    client.setChain('etf', primary)

    const q = await client.realtime('588000')
    expect(q.status).toBe('unavailable')
    expect(q.source).toBe('unavailable')
    expect(q.symbol).toBe('588000')
  })

  it('失败后有缓存时降级返回缓存（source=cache）', async () => {
    const client = new QuoteClient({
      retries: 0,
      baseDelayMs: 1,
      cacheEnabled: true,
    })
    let fail = false
    const p = mockProvider('etf', 'mock', {
      realtime: () =>
        fail ? Promise.reject(new Error('down')) : Promise.resolve(makeQuote('etf', 'mock')),
    })
    client.setChain('etf', p)

    await client.realtime('588000') // 成功，写缓存
    fail = true
    const q = await client.realtime('588000') // 失败，读缓存

    expect(q.source).toBe('cache')
    expect(q.symbol).toBe('588000')
  })
})

describe('停牌/涨跌停状态标记（验收点 3）', () => {
  it('provider 返回的状态标记原样透传（感知层可识别无有效行情）', async () => {
    const client = new QuoteClient({ retries: 0, cacheEnabled: false })
    const p = mockProvider('stock', 'mock-stock', {
      realtime: () =>
        Promise.resolve(
          makeQuote('stock', 'mock-stock', '000001', { status: 'suspended' }),
        ),
    })
    client.setChain('stock', p)

    const q = await client.realtime('000001')
    expect(q.status).toBe('suspended')
  })
})

describe('market/type 推断', () => {
  it('inferMarket 正确识别沪深', () => {
    expect(inferMarket('588000')).toBe(1) // 沪 ETF
    expect(inferMarket('600519')).toBe(1) // 沪 stock
    expect(inferMarket('000001')).toBe(0) // 深 stock
    expect(inferMarket('300750')).toBe(0) // 深创业板
    expect(inferMarket('12345')).toBe(null)
  })

  it('inferAssetType 正确识别 ETF/stock', () => {
    expect(inferAssetType('588000')).toBe('etf')
    expect(inferAssetType('159915')).toBe('etf') // 深 ETF
    expect(inferAssetType('600519')).toBe('stock')
    expect(inferAssetType('000001')).toBe('stock')
  })
})