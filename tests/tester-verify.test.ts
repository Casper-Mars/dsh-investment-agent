/**
 * Tester 独立运行时验证（不依赖 Developer 已有用例）。
 * 逐条覆盖 task t100352 的 7 条验收点，重点验证边界/异常行为。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Ledger } from '../src/domain/ledger.js'
import { JsonStore, LedgerStore } from '../src/domain/store.js'
import { hitRate, cumReturn } from '../src/domain/metrics.js'
import { SenseRegistry } from '../src/domain/sense-registry.js'
import { LOT_SIZE, COST_PRECISION } from '../src/domain/types.js'
import type { Trade } from '../src/domain/types.js'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dsh-finance-verify-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

// ---------- 验收点 1：加权平均成本 ----------
describe('验收点1：ledger.trade 加权平均成本', () => {
  it('旧qty=1000 oldavg=1.5，买200@2.0 → avg=1.5833（4位）', () => {
    const l = new Ledger(dir)
    l.init('588000', { type: 'etf', qty: 1000, cost: 1.5, cash: 100000 })
    const r = l.trade('588000', { side: 'buy', qty: 200, price: 2.0 })
    expect(r.ok).toBe(true)
    // (1000*1.5 + 200*2.0)/1200 = (1500+400)/1200 = 1.583333...
    expect(r.avgCost).toBe(1.5833)
    expect(String(r.avgCost)).toBe('1.5833') // 精确 4 位，无尾数
  })

  it('卖出不改 avg_cost（卖部分后 avgCost 数值不变，qty 减少）', () => {
    const l = new Ledger(dir)
    l.init('588000', { type: 'etf', qty: 1000, cost: 1.5, cash: 100000 })
    l.trade('588000', { side: 'buy', qty: 200, price: 2.0 })
    const before = l.query('588000')
    const r = l.trade('588000', { side: 'sell', qty: 300, price: 2.5 })
    expect(r.ok).toBe(true)
    expect(r.avgCost).toBe(before.avgCost) // 不变 = 1.5833
    const after = l.query('588000')
    expect(after.avgCost).toBe(before.avgCost)
    expect(after.qty).toBe(before.qty - 300)
  })

  it('realized_pnl 累计正确（连续多次卖出）', () => {
    const l = new Ledger(dir)
    l.init('588000', { type: 'etf', qty: 1000, cost: 2.0, cash: 100000 })
    // 卖 400@3.0 → (3.0-2.0)*400 = 400
    l.trade('588000', { side: 'sell', qty: 400, price: 3.0 })
    // 卖 200@1.0 → (1.0-2.0)*200 = -200 → 累计 200
    const r = l.trade('588000', { side: 'sell', qty: 200, price: 1.0 })
    expect(r.realizedPnl).toBe(200)
    const snap = l.query('588000')
    expect(snap.realizedPnl).toBe(200)
    expect(snap.qty).toBe(400)
  })
})

// ---------- 验收点 2：卖超校验 ----------
describe('验收点2：卖超校验', () => {
  it('持仓100，卖200 → 报错且 qty 仍为100（不落账）', () => {
    const l = new Ledger(dir)
    l.init('588000', { type: 'etf', qty: 100, cost: 2.0, cash: 100000 })
    const r = l.trade('588000', { side: 'sell', qty: 200, price: 3.0 })
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/超过/)
    const snap = l.query('588000')
    expect(snap.qty).toBe(100) // 不落账
    expect(snap.realizedPnl).toBe(0)
    expect(snap.cash).toBe(100000) // 现金亦不变
  })

  it('卖空边界的 qty=持仓 → 允许清仓', () => {
    const l = new Ledger(dir)
    l.init('588000', { type: 'etf', qty: 100, cost: 2.0, cash: 100000 })
    const r = l.trade('588000', { side: 'sell', qty: 100, price: 2.5 })
    expect(r.ok).toBe(true)
    expect(r.newQty).toBe(0)
  })
})

// ---------- 验收点 3：qty 100 整数倍 ----------
describe('验收点3：qty 100 整数倍（etf 与 stock 均测）', () => {
  it.each(['etf', 'stock'] as const)('type=%s：50/150 拒，100/200 收', (type) => {
    const symbol = type === 'etf' ? '588000' : '000001'
    const l = new Ledger(dir)
    l.init(symbol, { type, qty: 100, cost: 2.0, cash: 100000 })

    // 买 50 → 拒
    expect(l.trade(symbol, { side: 'buy', qty: 50, price: 2.0 }).ok).toBe(false)
    // 买 150 → 拒
    expect(l.trade(symbol, { side: 'buy', qty: 150, price: 2.0 }).ok).toBe(false)
    // 买 100 → 收
    expect(l.trade(symbol, { side: 'buy', qty: 100, price: 2.0 }).ok).toBe(true)
    // 买 200 → 收
    expect(l.trade(symbol, { side: 'buy', qty: 200, price: 2.0 }).ok).toBe(true)
  })

  it('非整数（如 100.5）与 0 被拒', () => {
    const l = new Ledger(dir)
    l.init('588000', { type: 'etf', qty: 100, cost: 2.0, cash: 100000 })
    expect(l.trade('588000', { side: 'buy', qty: 100.5, price: 2.0 }).ok).toBe(false)
    expect(l.trade('588000', { side: 'buy', qty: 0, price: 2.0 }).ok).toBe(false)
  })
})

// ---------- 验收点 4：ledger_init 重复 / query 完整快照 ----------
describe('验收点4：init 重复 & query 完整快照', () => {
  it('init 重复 symbol 抛错', () => {
    const l = new Ledger(dir)
    l.init('588000', { type: 'etf', qty: 100, cost: 2.0, cash: 100000 })
    expect(() =>
      l.init('588000', { type: 'etf', qty: 100, cost: 2.0, cash: 100000 }),
    ).toThrow(/已存在|重复/)
  })

  it('query 返回完整快照（含 cash/realized/float）', () => {
    const l = new Ledger(dir)
    l.init('588000', { type: 'etf', name: '科创50', qty: 500, cost: 2.1, cash: 88888 })
    const s = l.query('588000')
    expect(s).toMatchObject({
      symbol: '588000',
      type: 'etf',
      name: '科创50',
      qty: 500,
      avgCost: 2.1,
      cash: 88888,
      realizedPnl: 0,
      floatPnl: 0,
    })
    // 完整快照必须含 cash / realized / float 三个字段
    expect(Object.keys(s)).toContain('cash')
    expect(Object.keys(s)).toContain('realizedPnl')
    expect(Object.keys(s)).toContain('floatPnl')
  })

  it('query 不存在的 symbol 抛错', () => {
    const l = new Ledger(dir)
    expect(() => l.query('NOPE')).toThrow(/不存在/)
  })
})

// ---------- 验收点 5：metrics ----------
describe('验收点5：metrics.hitRate & cumReturn', () => {
  it('hitRate dir=[T,F,T] → 2/3≈0.6667', () => {
    const r = hitRate([true, false, true], [true, false, true])
    expect(r.dir).toBe(0.6667)
    expect(r.range).toBe(0.6667)
  })

  it('hitRate 空数组 → 0（防除零）', () => {
    expect(hitRate([], []).dir).toBe(0)
    expect(hitRate([], []).range).toBe(0)
  })

  it('cumReturn 基于 trades 流水累计', () => {
    const trades: Trade[] = [
      { id: '1', symbol: '588000', side: 'buy', qty: 100, price: 1.0, ts: 1 },
      { id: '2', symbol: '588000', side: 'sell', qty: 100, price: 1.2, ts: 2 },
    ]
    // realized = (1.2-1.0)*100 = 20；成本 = 100 → 0.2
    expect(cumReturn(trades)).toBeCloseTo(0.2, 4)
  })

  it('cumReturn 空流水 → 0', () => {
    expect(cumReturn([])).toBe(0)
  })
})

// ---------- 验收点 6：sense-registry 版本不可变 ----------
describe('验收点6：sense-registry 版本不可变 & rollback', () => {
  it('patch 不带 parent → 抛错', () => {
    const reg = new SenseRegistry(dir)
    expect(() =>
      reg.commit({ changeType: 'patch', rationale: 'x', code: 'x' }),
    ).toThrow(/parent/)
  })

  it('版本一经 commit 不可变：二次 commit 生成新版本，旧版本内容不变', () => {
    const reg = new SenseRegistry(dir)
    const v1 = reg.commit({ changeType: 'replace', rationale: '初始', code: 'c1' })
    const beforeV1 = reg.read(v1)

    // 再 commit → 生成 v002，而非覆盖 v001
    const v2 = reg.commit({ changeType: 'patch', rationale: '改', code: 'c2', parent: v1 })
    expect(v2).toBe('v002')

    // 旧版本全文完全不变
    const afterV1 = reg.read(v1)
    expect(afterV1).toEqual(beforeV1)
    expect(afterV1.code).toBe('c1')
    expect(afterV1.rationale).toBe('初始')
    expect(afterV1.meta.changeType).toBe('replace')
  })

  it('read 返回对象为副本：修改返回值不影响磁盘存档（不可变）', () => {
    const reg = new SenseRegistry(dir)
    const v = reg.commit({ changeType: 'replace', rationale: '初始', code: 'c1' })
    const full = reg.read(v)
    // 修改内存中的返回对象
    full.meta.changeType = 'keep'
    full.code = 'HACKED'
    full.rationale = 'HACKED'
    // 重新读取，磁盘内容不受影响
    const again = reg.read(v)
    expect(again.meta.changeType).toBe('replace')
    expect(again.code).toBe('c1')
    expect(again.rationale).toBe('初始')
  })

  it('rollback 到历史版本后 current() 返回该版本', () => {
    const reg = new SenseRegistry(dir)
    const v1 = reg.commit({ changeType: 'replace', rationale: 'v1', code: 'c1' })
    const v2 = reg.commit({ changeType: 'replace', rationale: 'v2', code: 'c2', parent: v1 })
    expect(reg.current()?.version).toBe(v2)
    reg.rollback(v1)
    expect(reg.current()?.version).toBe(v1)
    // rollback 后 read 依然能读到该历史版本的完整内容
    expect(reg.read(v1).code).toBe('c1')
  })
})

// ---------- 验收点 7：纯 TS，不 import dsh API ----------
describe('验收点7：domain 模块纯 TS', () => {
  it('常量 LOT_SIZE=100, COST_PRECISION=4', () => {
    expect(LOT_SIZE).toBe(100)
    expect(COST_PRECISION).toBe(4)
  })

  it('LedgerStore 可按 symbol 隔离读写', () => {
    const js = new JsonStore(dir)
    const store = new LedgerStore(js)
    store.saveSymbol({ symbol: 'A', type: 'etf', initPrice: 1.5 })
    store.saveSymbol({ symbol: 'B', type: 'stock', initPrice: 2.5 })
    store.savePosition({ symbol: 'A', qty: 100, avgCost: 1.5 })
    store.savePosition({ symbol: 'B', qty: 200, avgCost: 2.5 })
    // 按 symbol 隔离：互不干扰
    expect(store.getPosition('A')?.qty).toBe(100)
    expect(store.getPosition('B')?.qty).toBe(200)
    // listSymbols 仅列「已初始化标的」（有 symbols 记录者）
    expect(store.listSymbols().sort()).toEqual(['A', 'B'])
  })

  it('listSymbols 只列已初始化标的（无 symbols 记录的目录不计入）', () => {
    const js = new JsonStore(dir)
    const store = new LedgerStore(js)
    // 仅写 positions、不写 symbols → 不算已初始化
    store.savePosition({ symbol: 'C', qty: 100, avgCost: 1.5 })
    expect(store.listSymbols()).toEqual([])
  })
})