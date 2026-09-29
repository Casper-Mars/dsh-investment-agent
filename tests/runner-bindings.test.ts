/**
 * runner/bindings.ts 单元测试（验收点 2）。
 *
 * 覆盖：
 *   - 仅暴露 3 个命名空间 / 5 个只读方法，无任何写方法；
 *   - symbols.list 返回标的清单（含 type）；
 *   - quote.* 按 type 路由（显式 type > ledger 回查 > 前缀推断）；
 *   - quote.history 的 days 解析（字符串 / 数组 / 对象 / 默认值）；
 *   - ledger.get 只读查询；
 *   - 出入参均为无损 JSON；
 *   - 缺 symbol 时拒绝。
 */
import { describe, it, expect, vi } from 'vitest'
import {
  createSensorBindings,
  SENSOR_BINDING_GLOBALS,
  SENSOR_READONLY_METHODS,
  DEFAULT_HISTORY_DAYS,
  type SensorBindingSources,
} from '../src/runner/bindings.js'
import type { PtcBindingNamespace } from '../src/runner/types.js'

const SYMBOLS = [
  { symbol: '588000', type: 'etf', name: '科创50ETF', qty: 1000, avgCost: 1.5 },
  { symbol: '000001', type: 'stock', qty: 200, avgCost: 10.25 }, // name 缺失
]

function makeSources() {
  const ledger = {
    list: vi.fn(() => SYMBOLS),
    query: vi.fn((symbol: string) => {
      if (symbol !== '588000') throw new Error(`[ledger] 标的 ${symbol} 不存在`)
      return {
        symbol,
        type: 'etf',
        name: '科创50ETF',
        qty: 1000,
        avgCost: 1.5,
        cash: 100,
        realizedPnl: 0,
        floatPnl: 12.5,
      }
    }),
  }
  const quotes = {
    realtime: vi.fn(async (symbol: string, type?: string) => ({
      symbol,
      type: type ?? 'etf',
      price: 1.66,
      status: 'trading',
      source: 'mock',
    })),
    intraday: vi.fn(async (symbol: string) => [{ symbol, price: 1.6, ts: 1 }]),
    history: vi.fn(async (symbol: string, days: number) => [
      { symbol, price: 1.5, ts: days },
    ]),
  }
  return { ledger, quotes } as unknown as SensorBindingSources
}

function namespace(bindings: PtcBindingNamespace[], global: string): PtcBindingNamespace {
  const found = bindings.find((b) => b.global === global)
  if (!found) throw new Error(`missing namespace ${global}`)
  return found
}

function member(
  bindings: PtcBindingNamespace[],
  global: string,
  name: string,
): (args: unknown) => Promise<unknown> {
  const fn = namespace(bindings, global).functions[name]
  if (!fn) throw new Error(`missing member ${global}.${name}`)
  return fn as (args: unknown) => Promise<unknown>
}

describe('bindings 命名空间与只读面', () => {
  it('只暴露 symbols / quote / ledger 三个命名空间', () => {
    const bindings = createSensorBindings(makeSources())
    expect(bindings.map((b) => b.global)).toEqual([...SENSOR_BINDING_GLOBALS])
  })

  it('仅暴露 5 个只读方法，且无任何写方法', () => {
    const bindings = createSensorBindings(makeSources())
    const methods = bindings.flatMap((b) =>
      Object.keys(b.functions).map((name) => `${b.global}.${name}`),
    )
    expect(new Set(methods)).toEqual(new Set(SENSOR_READONLY_METHODS))
    // 明确没有写 / 交易类方法
    for (const forbidden of ['symbols.trade', 'ledger.trade', 'ledger.init', 'quote.commit', 'sense.commit']) {
      expect(methods).not.toContain(forbidden)
    }
    // 命名空间对象上不得存在除 functions/global/errorClass 之外的键
    for (const b of bindings) {
      expect(Object.keys(b).sort()).toEqual(['functions', 'global'])
    }
  })
})

describe('symbols.list', () => {
  it('返回标的清单（含 type），并清理 undefined 字段', async () => {
    const bindings = createSensorBindings(makeSources())
    const list = (await member(bindings, 'symbols', 'list')(undefined)) as Array<Record<string, unknown>>
    expect(list.map((s) => s.symbol)).toEqual(['588000', '000001'])
    expect(list[0]).toMatchObject({ symbol: '588000', type: 'etf' })
    // 第二条无 name：序列化后不应出现 name 键
    expect(Object.prototype.hasOwnProperty.call(list[1], 'name')).toBe(false)
  })
})

describe('quote.* 的 type 路由', () => {
  it('脚本传字符串 symbol 时回查 ledger 得到 type', async () => {
    const sources = makeSources()
    const bindings = createSensorBindings(sources)
    await member(bindings, 'quote', 'realtime')('588000')
    expect((sources.quotes.realtime as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]).toEqual(['588000', 'etf'])
  })

  it('显式 type 优先于 ledger 回查', async () => {
    const sources = makeSources()
    const bindings = createSensorBindings(sources)
    await member(bindings, 'quote', 'realtime')({ symbol: '999999', type: 'stock' })
    expect((sources.quotes.realtime as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]).toEqual(['999999', 'stock'])
  })

  it('ledger 未收录时 type 为 undefined（交由 QuoteClient 前缀推断）', async () => {
    const sources = makeSources()
    const bindings = createSensorBindings(sources)
    await member(bindings, 'quote', 'realtime')('510300')
    expect((sources.quotes.realtime as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]).toEqual(['510300', undefined])
  })
})

describe('quote.history 的 days 解析', () => {
  it('字符串 symbol → 默认 days', async () => {
    const sources = makeSources()
    const bindings = createSensorBindings(sources)
    await member(bindings, 'quote', 'history')('588000')
    expect((sources.quotes.history as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]?.[1]).toBe(DEFAULT_HISTORY_DAYS)
  })

  it('数组入参 [symbol, days]', async () => {
    const sources = makeSources()
    const bindings = createSensorBindings(sources)
    await member(bindings, 'quote', 'history')(['588000', 30])
    expect((sources.quotes.history as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]).toEqual(['588000', 30, 'etf'])
  })

  it('对象入参 { symbol, days }', async () => {
    const sources = makeSources()
    const bindings = createSensorBindings(sources)
    await member(bindings, 'quote', 'history')({ symbol: '588000', days: 5 })
    expect((sources.quotes.history as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]?.[1]).toBe(5)
  })
})

describe('ledger.get 与无损 JSON / 缺参拒绝', () => {
  it('ledger.get 返回 JSON-safe 快照', async () => {
    const bindings = createSensorBindings(makeSources())
    const pos = await member(bindings, 'ledger', 'get')('588000')
    expect(pos).toMatchObject({ symbol: '588000', cash: 100, floatPnl: 12.5 })
    expect(JSON.parse(JSON.stringify(pos))).toEqual(pos)
  })

  it('缺 symbol 时拒绝', async () => {
    const bindings = createSensorBindings(makeSources())
    await expect(member(bindings, 'quote', 'realtime')(undefined)).rejects.toThrow(/symbol/)
    await expect(member(bindings, 'ledger', 'get')({})).rejects.toThrow(/symbol/)
  })

  it('所有方法返回值均为无损 JSON', async () => {
    const bindings = createSensorBindings(makeSources())
    for (const [global, name, args] of [
      ['symbols', 'list', undefined],
      ['quote', 'realtime', '588000'],
      ['quote', 'intraday', '588000'],
      ['quote', 'history', '588000'],
      ['ledger', 'get', '588000'],
    ] as const) {
      const value = await member(bindings, global, name)(args)
      expect(JSON.parse(JSON.stringify(value))).toEqual(value)
    }
  })
})
