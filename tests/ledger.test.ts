/**
 * domain/ledger.ts 单元测试。
 * 覆盖验收点 1-4：
 *   1. 买入加权平均成本 + 保留 4 位小数；卖出不改 avg_cost
 *   2. 卖超校验（不落账）
 *   3. qty 100 整数倍校验
 *   4. init 重复 symbol 报错；query 返回完整快照
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Ledger } from '../src/domain/ledger.js'

let dir: string
let ledger: Ledger

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dsh-finance-ledger-'))
  ledger = new Ledger(dir)
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('ledger.init', () => {
  it('新增标的后 query 返回完整快照', () => {
    ledger.init('588000', {
      type: 'etf',
      name: '科创50ETF',
      qty: 1000,
      cost: 1.95,
      cash: 100000,
    })
    const snap = ledger.query('588000')
    expect(snap).toEqual({
      symbol: '588000',
      type: 'etf',
      name: '科创50ETF',
      qty: 1000,
      avgCost: 1.95,
      cash: 100000,
      realizedPnl: 0,
      floatPnl: 0,
    })
  })

  it('重复 symbol 报错（验收点 4）', () => {
    ledger.init('588000', {
      type: 'etf',
      qty: 1000,
      cost: 1.95,
      cash: 100000,
    })
    expect(() =>
      ledger.init('588000', {
        type: 'etf',
        qty: 1000,
        cost: 1.95,
        cash: 100000,
      }),
    ).toThrow(/已存在|重复/)
  })

  it('初始 qty 非 100 整数倍报错', () => {
    expect(() =>
      ledger.init('588000', {
        type: 'etf',
        qty: 150, // 非 100 整数倍
        cost: 1.95,
        cash: 100000,
      }),
    ).toThrow(/100/)
  })
})

describe('ledger.trade 买入（验收点 1/3）', () => {
  beforeEach(() => {
    ledger.init('588000', {
      type: 'etf',
      qty: 1000,
      cost: 2.0,
      cash: 100000,
    })
  })

  it('加权平均成本 + 保留 4 位小数', () => {
    // 旧 1000 股 @2.0，买 500 @2.5 → (1000*2 + 500*2.5)/1500 = 2.166666...
    const r = ledger.trade('588000', { side: 'buy', qty: 500, price: 2.5 })
    expect(r.ok).toBe(true)
    expect(r.avgCost).toBeCloseTo(2.1667, 4)
    // avg_cost 保留 4 位小数，无多余尾数。
    expect(String(r.avgCost)).toBe('2.1667')
  })

  it('非 100 整数倍买入被拒（验收点 3）', () => {
    const r = ledger.trade('588000', { side: 'buy', qty: 150, price: 2.5 })
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/100/)
    // 不落账：qty 不变。
    expect(ledger.query('588000').qty).toBe(1000)
  })

  it('buy 落账后 qty 增加、avgCost 更新', () => {
    ledger.trade('588000', { side: 'buy', qty: 500, price: 2.5 })
    const snap = ledger.query('588000')
    expect(snap.qty).toBe(1500)
    expect(snap.avgCost).toBeCloseTo(2.1667, 4)
  })
})

describe('ledger.trade 卖出（验收点 1/2）', () => {
  beforeEach(() => {
    ledger.init('588000', {
      type: 'etf',
      qty: 1000,
      cost: 2.0,
      cash: 100000,
    })
  })

  it('卖出不改 avg_cost，只减 qty 并结算 realized_pnl', () => {
    // 卖 300 @3.0 → realized = (3.0 - 2.0)*300 = 300
    const r = ledger.trade('588000', { side: 'sell', qty: 300, price: 3.0 })
    expect(r.ok).toBe(true)
    expect(r.avgCost).toBe(2.0) // 不改
    expect(r.newQty).toBe(700)
    expect(r.realizedPnl).toBe(300)

    const snap = ledger.query('588000')
    expect(snap.qty).toBe(700)
    expect(snap.avgCost).toBe(2.0)
    expect(snap.realizedPnl).toBe(300)
  })

  it('卖超校验：qty 超过持仓报错且不落账（验收点 2）', () => {
    const r = ledger.trade('588000', { side: 'sell', qty: 1100, price: 3.0 })
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/超过/)
    const snap = ledger.query('588000')
    expect(snap.qty).toBe(1000) // 不落账
    expect(snap.realizedPnl).toBe(0)
  })

  it('非 100 整数倍卖出被拒', () => {
    const r = ledger.trade('588000', { side: 'sell', qty: 250, price: 3.0 })
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/100/)
  })
})

describe('ledger.list', () => {
  it('返回标的清单 + 快照（含 type）', () => {
    ledger.init('588000', {
      type: 'etf',
      name: '科创50ETF',
      qty: 1000,
      cost: 1.95,
      cash: 100000,
    })
    ledger.init('000001', {
      type: 'stock',
      name: '平安银行',
      qty: 200,
      cost: 12.5,
      cash: 50000,
    })
    const list = ledger.list()
    expect(list).toHaveLength(2)
    const a = list.find((s) => s.symbol === '588000')
    const b = list.find((s) => s.symbol === '000001')
    expect(a).toMatchObject({ symbol: '588000', type: 'etf', qty: 1000 })
    expect(b).toMatchObject({ symbol: '000001', type: 'stock', qty: 200 })
  })
})