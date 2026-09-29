/**
 * 数据源适配层解析测试（mock fetch，不依赖真实网络）。
 * 覆盖东财 / 腾讯字段映射、停牌/涨跌停状态判定、GBK 解码。
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import { EastmoneyProvider } from '../src/lib/providers/eastmoney.js'
import { TencentProvider } from '../src/lib/providers/tencent.js'

afterEach(() => {
  vi.unstubAllGlobals()
})

/** mock fetch：返回给定 JSON 文本的 Response。 */
function mockFetchJson(text: string) {
  return vi.fn(async () => ({
    ok: true,
    status: 200,
    arrayBuffer: async () => new TextEncoder().encode(text).buffer as ArrayBuffer,
  })) as unknown as typeof fetch
}

describe('EastmoneyProvider.realtime（字段映射 + 状态）', () => {
  it('正常行情：映射价格/成交量/状态为 trading', async () => {
    const body = JSON.stringify({
      rc: 0,
      data: {
        f43: 1657,
        f44: 1665,
        f45: 1636,
        f46: 1642,
        f47: 36478079,
        f48: 6021782656,
        f57: '588000',
        f58: '科创50ETF华夏',
        f60: 1643,
        f170: 85,
      },
    })
    vi.stubGlobal('fetch', mockFetchJson(body))

    const p = new EastmoneyProvider('etf')
    const q = await p.realtime('588000')

    expect(q.symbol).toBe('588000')
    expect(q.name).toBe('科创50ETF华夏')
    expect(q.price).toBeCloseTo(16.57, 2)
    expect(q.open).toBeCloseTo(16.42, 2)
    expect(q.high).toBeCloseTo(16.65, 2)
    expect(q.low).toBeCloseTo(16.36, 2)
    expect(q.prevClose).toBeCloseTo(16.43, 2)
    expect(q.volume).toBe(36478079 * 100) // 手 → 股
    expect(q.amount).toBe(6021782656)
    expect(q.status).toBe('trading')
    expect(q.source).toBe('eastmoney')
  })

  it('停牌：无价格 → status suspended', async () => {
    const body = JSON.stringify({
      rc: 0,
      data: { f43: 0, f57: '000001', f58: '平安银行', f47: 0 },
    })
    vi.stubGlobal('fetch', mockFetchJson(body))

    const p = new EastmoneyProvider('stock')
    const q = await p.realtime('000001')
    expect(q.status).toBe('suspended')
    expect(q.price).toBe(0)
  })

  it('涨跌停：价格存在但成交量为 0 且涨幅逼近涨停 → limit_up', async () => {
    const body = JSON.stringify({
      rc: 0,
      data: {
        f43: 1100,
        f47: 0,
        f57: '000001',
        f58: '平安银行',
        f60: 1000,
        f170: 1000, // +10%
      },
    })
    vi.stubGlobal('fetch', mockFetchJson(body))

    const p = new EastmoneyProvider('stock')
    const q = await p.realtime('000001')
    expect(q.status).toBe('limit_up')
  })

  it('HTTP 异常抛错（由上层重试/降级）', async () => {
    const failFetch = vi.fn(async () => ({
      ok: false,
      status: 500,
      arrayBuffer: async () => new Uint8Array().buffer as ArrayBuffer,
    })) as unknown as typeof fetch
    vi.stubGlobal('fetch', failFetch)

    const p = new EastmoneyProvider('etf')
    await expect(p.realtime('588000')).rejects.toThrow()
  })
})

describe('EastmoneyProvider.history（K线映射）', () => {
  it('解析 klines 为升序 Quote[]，价格正确，prevClose 链式推导', async () => {
    const body = JSON.stringify({
      data: {
        code: '588000',
        name: '科创50ETF华夏',
        preKPrice: 1.77,
        klines: [
          '2026-09-28,1.702,1.643,1.705,1.636,45675024,7578263060.000,4.03',
          '2026-09-29,1.642,1.657,1.665,1.636,36478079,6021782656.000,1.77',
        ],
      },
    })
    vi.stubGlobal('fetch', mockFetchJson(body))

    const p = new EastmoneyProvider('etf')
    const list = await p.history('588000', 5)

    expect(list).toHaveLength(2)
    expect(list[0].ts).toBeLessThan(list[1].ts)
    expect(list[1].price).toBeCloseTo(1.657, 3)
    expect(list[1].open).toBeCloseTo(1.642, 3)
    expect(list[1].prevClose).toBeCloseTo(1.643, 3) // 前一条收盘价
    expect(list[0].prevClose).toBeCloseTo(1.77, 3) // meta preKPrice
  })
})

describe('TencentProvider.realtime（GBK 解码 + ~ 分隔解析）', () => {
  it('解析字段并正确映射', async () => {
    // 按腾讯真实字段位置（~分隔，索引从 0）构造精确 fixture：
    // [1]名称 [2]代码 [3]最新价 [4]昨收 [5]今开 [6]成交量(手) [30]时间 [31]涨跌额
    // [32]涨跌幅 [33]最高 [34]最低 [37]成交额(万)
    const f: string[] = new Array(40).fill('')
    f[0] = '1'
    f[1] = '科创50ETF华夏'
    f[2] = '588000'
    f[3] = '1.657'
    f[4] = '1.643'
    f[5] = '1.642'
    f[6] = '36478079'
    f[30] = '20260929161438'
    f[31] = '0.014'
    f[32] = '0.85'
    f[33] = '1.665'
    f[34] = '1.636'
    f[37] = '602178' // 万元
    const gbkText = `v_sh588000="${f.join('~')}";`

    vi.stubGlobal('fetch', mockFetchJson(gbkText))

    const p = new TencentProvider('etf')
    const q = await p.realtime('588000')

    expect(q.symbol).toBe('588000')
    expect(q.price).toBeCloseTo(1.657, 3)
    expect(q.prevClose).toBeCloseTo(1.643, 3)
    expect(q.open).toBeCloseTo(1.642, 3)
    expect(q.high).toBeCloseTo(1.665, 3)
    expect(q.low).toBeCloseTo(1.636, 3)
    expect(q.volume).toBe(36478079 * 100)
    expect(q.amount).toBe(602178 * 10000) // 万元 → 元
    expect(q.status).toBe('trading')
    expect(q.source).toBe('tencent')
  })

  it('腾讯不提供分时/K线，返回空序列（交由上层降级）', async () => {
    const p = new TencentProvider('etf')
    expect(await p.intraday('588000')).toEqual([])
    expect(await p.history('588000', 5)).toEqual([])
  })
})