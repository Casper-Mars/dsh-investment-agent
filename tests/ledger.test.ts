/**
 * domain/ledger.ts 单元测试。
 * 覆盖验收点 1-4：
 *   1. 买入加权平均成本 + 保留 4 位小数；卖出不改 avg_cost
 *   2. 卖超校验（不落账）
 *   3. qty 100 整数倍校验
 *   4. init 重复 symbol 报错；query 返回完整快照
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Ledger } from '../src/domain/ledger.js'

let dir: string
let ledger: Ledger

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dsh-ia-ledger-'))
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
      settlement: 'T+1',
      sellableQty: 1000,
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
  it('返回标的清单 + 快照（含 type / settlement）', () => {
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
    expect(a).toMatchObject({ symbol: '588000', type: 'etf', qty: 1000, settlement: 'T+1' })
    expect(b).toMatchObject({ symbol: '000001', type: 'stock', qty: 200, settlement: 'T+1' })
  })
})

describe('ledger.query 浮动盈亏 float_pnl（t100405）', () => {
  beforeEach(() => {
    ledger.init('588000', {
      type: 'etf',
      qty: 1000,
      cost: 2.0,
      cash: 100000,
    })
  })

  it('不传 price → floatPnl = 0（未提供现价、无法计算）', () => {
    expect(ledger.query('588000').floatPnl).toBe(0)
    // 显式 undefined 亦同。
    expect(ledger.query('588000', undefined).floatPnl).toBe(0)
  })

  it('传 price（持仓）→ floatPnl = (price − avgCost) × qty', () => {
    // (2.5 − 2.0) × 1000 = 500
    expect(ledger.query('588000', 2.5).floatPnl).toBe(500)
    // 亏损分支：(1.8 − 2.0) × 1000 = −200
    expect(ledger.query('588000', 1.8).floatPnl).toBe(-200)
  })

  it('传 price（持仓）→ 结果保留 4 位小数', () => {
    // (2.123456789 − 2.0) × 1000 = 123.456789 → 123.4568
    expect(ledger.query('588000', 2.123456789).floatPnl).toBe(123.4568)
  })

  it('传 price（空仓 qty=0）→ floatPnl = 0', () => {
    const r = ledger.trade('588000', { side: 'sell', qty: 1000, price: 2.5 })
    expect(r.ok).toBe(true)
    const snap = ledger.query('588000', 3.0)
    expect(snap.qty).toBe(0)
    expect(snap.floatPnl).toBe(0)
  })

  it('float_pnl 为即时计算，不改变账户持久化值', () => {
    // 传 price 查询后，再次不传 price 仍为 0（不污染 accounts.floatPnl）。
    expect(ledger.query('588000', 5.0).floatPnl).toBe(3000)
    expect(ledger.query('588000').floatPnl).toBe(0)
  })
})
/* -------------------------------------------------------------------------- *
 * Issue #6：A 股 T+1 拦截（方案 §6.2 集成测试）
 * -------------------------------------------------------------------------- */

describe('ledger.trade T+1 拦截（Issue #6）', () => {
  /** 可推进的测试时钟（毫秒）。 */
  let clock: number
  const DAY1 = Date.parse('2026-10-13T10:00:00+08:00')
  const DAY1_LATER = Date.parse('2026-10-13T14:30:00+08:00')
  const DAY2 = Date.parse('2026-10-14T10:00:00+08:00')

  beforeEach(() => {
    clock = DAY1
    ledger = new Ledger(dir, () => clock)
  })

  it('AC1：同日 buy 100 → sell 100 被拒，且 qty/cash/realizedPnl/trades 均不变', () => {
    // 还原 Issue 场景：账户先清空，次日买入 100 后当日卖出 100。
    ledger.init('588000', { type: 'etf', qty: 100, cost: 2.0, cash: 100000 })
    expect(ledger.trade('588000', { side: 'sell', qty: 100, price: 2.1 }).ok).toBe(true)
    expect(ledger.query('588000').qty).toBe(0)

    clock = DAY2
    const buy = ledger.trade('588000', { side: 'buy', qty: 100, price: 2.2 })
    expect(buy.ok).toBe(true)

    const tradeCount = ledger.getTrades('588000').length
    const afterBuy = ledger.query('588000')
    const r = ledger.trade('588000', { side: 'sell', qty: 100, price: 2.3 })
    expect(r.ok).toBe(false)
    expect(r.error).toContain('T+1')

    // 零写入：持仓 / 现金 / 已实现盈亏 / 流水长度全部不变。
    const afterReject = ledger.query('588000')
    expect(afterReject.qty).toBe(afterBuy.qty)
    expect(afterReject.cash).toBe(afterBuy.cash)
    expect(afterReject.realizedPnl).toBe(afterBuy.realizedPnl)
    expect(ledger.getTrades('588000')).toHaveLength(tradeCount)
  })

  it('AC2：持仓 200 + 当日买 100，卖 200 成功', () => {
    ledger.init('588000', { type: 'etf', qty: 200, cost: 2.0, cash: 100000 })
    ledger.trade('588000', { side: 'buy', qty: 100, price: 2.2 })
    // 可卖 200（存量），而非 300。
    expect(ledger.query('588000').sellableQty).toBe(200)

    const r = ledger.trade('588000', { side: 'sell', qty: 200, price: 2.5 })
    expect(r.ok).toBe(true)
    expect(r.newQty).toBe(100)
  })

  it('AC2：同场景卖 300 被拒（可卖 200，而非超持仓）', () => {
    ledger.init('588000', { type: 'etf', qty: 200, cost: 2.0, cash: 100000 })
    ledger.trade('588000', { side: 'buy', qty: 100, price: 2.2 })

    const r = ledger.trade('588000', { side: 'sell', qty: 300, price: 2.5 })
    expect(r.ok).toBe(false)
    expect(r.error).toContain('T+1')
    expect(r.error).toContain('当前可卖 200')
    expect(ledger.query('588000').qty).toBe(300) // 不落账
  })

  it('AC3：跨日后当日买入量清零，可卖量恢复为全部持仓', () => {
    ledger.init('588000', { type: 'etf', qty: 200, cost: 2.0, cash: 100000 })
    ledger.trade('588000', { side: 'buy', qty: 100, price: 2.2 })
    expect(ledger.query('588000').sellableQty).toBe(200)

    clock = DAY2
    expect(ledger.query('588000').sellableQty).toBe(300)
    const r = ledger.trade('588000', { side: 'sell', qty: 300, price: 2.5 })
    expect(r.ok).toBe(true)
    expect(r.newQty).toBe(0)
  })

  it('AC4：settlement=T+0 允许当日完整回转', () => {
    ledger.init('588000', {
      type: 'etf',
      qty: 100,
      cost: 2.0,
      cash: 100000,
      settlement: 'T+0',
    })
    expect(ledger.query('588000').settlement).toBe('T+0')

    // 先清掉存量，再当日买入 → 当日卖出（完整回转）。
    expect(ledger.trade('588000', { side: 'sell', qty: 100, price: 2.1 }).ok).toBe(true)
    clock = DAY2
    const buy = ledger.trade('588000', { side: 'buy', qty: 100, price: 2.2 })
    expect(buy.ok).toBe(true)
    expect(ledger.query('588000').sellableQty).toBe(100)

    const sell = ledger.trade('588000', { side: 'sell', qty: 100, price: 2.3 })
    expect(sell.ok).toBe(true)
    expect(sell.newQty).toBe(0)
  })

  it('AC5：init 建仓的存量持仓当日可卖（init 不计入当日买入）', () => {
    clock = DAY1
    ledger.init('588000', { type: 'etf', qty: 1000, cost: 2.0, cash: 100000 })
    clock = DAY1_LATER
    const r = ledger.trade('588000', { side: 'sell', qty: 1000, price: 2.5 })
    expect(r.ok).toBe(true)
    expect(r.newQty).toBe(0)
  })

  it('AC6：错误文案含当日买入量、可卖量、持仓量，ETF 用「份」', () => {
    ledger.init('588000', { type: 'etf', qty: 200, cost: 2.0, cash: 100000 })
    ledger.trade('588000', { side: 'buy', qty: 100, price: 2.2 })

    const r = ledger.trade('588000', { side: 'sell', qty: 300, price: 2.5 })
    expect(r.ok).toBe(false)
    expect(r.error).toBe(
      'T+1 限制：当日买入 100 份不可卖出，当前可卖 200 份（持仓 300 份）',
    )
    expect(r.error).not.toContain('股')
  })

  it('AC6：股票标的错误文案用「股」', () => {
    ledger.init('000001', { type: 'stock', qty: 100, cost: 12.0, cash: 100000 })
    ledger.trade('000001', { side: 'buy', qty: 100, price: 12.5 })
    // 持仓 200、可卖 100（存量），卖 200 超可卖量。
    const r = ledger.trade('000001', { side: 'sell', qty: 200, price: 13.0 })
    expect(r.ok).toBe(false)
    expect(r.error).toBe(
      'T+1 限制：当日买入 100 股不可卖出，当前可卖 100 股（持仓 200 股）',
    )
  })

  it('错误优先级：超持仓仍报「超过当前持仓」，不返回 T+1 文案', () => {
    ledger.init('588000', { type: 'etf', qty: 200, cost: 2.0, cash: 100000 })
    ledger.trade('588000', { side: 'buy', qty: 100, price: 2.2 })
    // 500 > 持仓 300，应命中超卖分支而非 T+1 分支。
    const r = ledger.trade('588000', { side: 'sell', qty: 500, price: 2.5 })
    expect(r.ok).toBe(false)
    expect(r.error).toContain('超过当前持仓 300')
    expect(r.error).not.toContain('T+1')
  })

  it('当日反复买卖无法绕过：卖出不重置当日买入量', () => {
    ledger.init('588000', { type: 'etf', qty: 200, cost: 2.0, cash: 100000 })
    expect(ledger.trade('588000', { side: 'sell', qty: 100, price: 2.5 }).ok).toBe(true)
    expect(ledger.trade('588000', { side: 'buy', qty: 100, price: 2.4 }).ok).toBe(true)
    // 持仓 200，但当日买入 100 仍冻结 → 可卖 100。
    expect(ledger.query('588000').sellableQty).toBe(100)
    const r = ledger.trade('588000', { side: 'sell', qty: 200, price: 2.5 })
    expect(r.ok).toBe(false)
    expect(r.error).toContain('当前可卖 100')
  })
})

describe('旧 symbols.json 兼容（无 settlement 字段 → 按 T+1）', () => {
  const DAY1 = Date.parse('2026-10-13T10:00:00+08:00')

  it('AC7：缺字段时 query 归一化为 T+1，卖出受 T+1 约束', () => {
    // 手工构造 Issue #6 之前的存量标的（无 settlement）。
    mkdirSync(join(dir, 'ledger', '588000'), { recursive: true })
    writeFileSync(
      join(dir, 'ledger', '588000', 'symbols.json'),
      JSON.stringify({ symbol: '588000', type: 'etf', initPrice: 2.0 }, null, 2),
      'utf8',
    )
    writeFileSync(
      join(dir, 'ledger', '588000', 'positions.json'),
      JSON.stringify({ symbol: '588000', qty: 100, avgCost: 2.0 }, null, 2),
      'utf8',
    )
    writeFileSync(
      join(dir, 'ledger', '588000', 'accounts.json'),
      JSON.stringify(
        { symbol: '588000', cash: 100000, realizedPnl: 0, floatPnl: 0 },
        null,
        2,
      ),
      'utf8',
    )
    writeFileSync(join(dir, 'ledger', '588000', 'trades.json'), '[]', 'utf8')

    const old = new Ledger(dir, () => DAY1)
    expect(old.query('588000').settlement).toBe('T+1')
    old.trade('588000', { side: 'buy', qty: 100, price: 2.2 })
    // 存量 100 可卖，当日买入的 100 被冻结 → 卖 200 越界。
    const r = old.trade('588000', { side: 'sell', qty: 200, price: 2.5 })
    expect(r.ok).toBe(false)
    expect(r.error).toContain('T+1 限制')

    // 读时不回写：文件仍无 settlement 字段。
    const raw = JSON.parse(
      readFileSync(join(dir, 'ledger', '588000', 'symbols.json'), 'utf8'),
    ) as Record<string, unknown>
    expect(raw.settlement).toBeUndefined()
  })
})

/* -------------------------------------------------------------------------- *
 * F1 回归（Issue #6 复验）：reason='init' 是建仓保留标记，不可由 trade 接口传入。
 *
 * 缺陷成因：`todayBuyQty` 无条件排除 `reason === 'init'` 的买入流水，而 `reason`
 * 由调用方自由传入 → 当日买入后传 `init` 即可让冻结量归零，完全绕过 T+1。
 * 修复后：`Ledger.trade()` 在任何落盘前拒绝保留值，拒绝路径零写入。
 * -------------------------------------------------------------------------- */
describe('F1 回归：reason=init 为保留标记，trade 接口不可用', () => {
  let clock: number
  const DAY1 = Date.parse('2026-10-13T10:00:00+08:00')
  const DAY1_LATER = Date.parse('2026-10-13T14:30:00+08:00')

  /** 读取某标的的三张台账表原始字节（用于断言「零写入」）。 */
  const rawFiles = (symbol: string): Record<string, string> => ({
    positions: readFileSync(join(dir, 'ledger', symbol, 'positions.json'), 'utf8'),
    accounts: readFileSync(join(dir, 'ledger', symbol, 'accounts.json'), 'utf8'),
    trades: readFileSync(join(dir, 'ledger', symbol, 'trades.json'), 'utf8'),
  })

  beforeEach(() => {
    clock = DAY1
    ledger = new Ledger(dir, () => clock)
  })

  it('F1-1：当日买入 100 后传 reason=init 卖出 → 被拒，三表字节零变化', () => {
    ledger.init('588000', { type: 'etf', qty: 100, cost: 2.0, cash: 100000 })
    // 清掉期初存量，构造「持仓全部来自当日买入」。
    expect(ledger.trade('588000', { side: 'sell', qty: 100, price: 2.1 }).ok).toBe(true)
    clock = DAY1_LATER
    expect(ledger.trade('588000', { side: 'buy', qty: 100, price: 2.2 }).ok).toBe(true)
    expect(ledger.query('588000').sellableQty).toBe(0)

    const before = rawFiles('588000')
    const r = ledger.trade('588000', { side: 'sell', qty: 100, price: 2.3, reason: 'init' })

    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/init/)
    expect(r.error).toMatch(/保留/)
    // 零写入：positions / accounts / trades 三表字节完全一致。
    expect(rawFiles('588000')).toEqual(before)
    // 防御性复核：持仓仍为 100，T+1 仍生效。
    expect(ledger.query('588000').qty).toBe(100)
  })

  it('F1-2：reason=init 的买入同样被拒（保留值买卖两侧都不可用），零写入', () => {
    ledger.init('588000', { type: 'etf', qty: 100, cost: 2.0, cash: 100000 })
    const before = rawFiles('588000')

    const r = ledger.trade('588000', { side: 'buy', qty: 100, price: 2.2, reason: 'init' })

    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/保留/)
    expect(rawFiles('588000')).toEqual(before)
    expect(ledger.query('588000').qty).toBe(100)
  })

  it('F1-3：保留值变体（大小写/空白）同样被拒，无法绕过', () => {
    ledger.init('588000', { type: 'etf', qty: 100, cost: 2.0, cash: 100000 })
    const before = rawFiles('588000')

    for (const reason of [' INIT ', 'Init', '\tinit\n']) {
      const r = ledger.trade('588000', { side: 'buy', qty: 100, price: 2.2, reason })
      expect(r.ok, `reason=${JSON.stringify(reason)} 应被拒绝`).toBe(false)
    }
    expect(rawFiles('588000')).toEqual(before)
  })

  it('F1-4：普通 reason（调仓）的买入仍计入当日买入、仍被 T+1 冻结', () => {
    ledger.init('588000', { type: 'etf', qty: 1000, cost: 2.0, cash: 100000 })
    clock = DAY1_LATER
    expect(ledger.trade('588000', { side: 'buy', qty: 100, price: 2.2, reason: '调仓' }).ok).toBe(
      true,
    )
    // 存量 1000 可卖，当日买入 100 冻结。
    expect(ledger.query('588000').sellableQty).toBe(1000)

    const r = ledger.trade('588000', { side: 'sell', qty: 1100, price: 2.5, reason: '止盈' })
    expect(r.ok).toBe(false)
    expect(r.error).toBe('T+1 限制：当日买入 100 份不可卖出，当前可卖 1000 份（持仓 1100 份）')
  })

  it('F1-5：既有行为不回归 —— init 期初持仓当日可卖、T+0 当日可回转', () => {
    // init 建仓流水是首笔，仍豁免冻结。
    ledger.init('588000', { type: 'etf', qty: 1000, cost: 2.0, cash: 100000 })
    clock = DAY1_LATER
    expect(ledger.query('588000').sellableQty).toBe(1000)
    expect(ledger.trade('588000', { side: 'sell', qty: 1000, price: 2.5 }).ok).toBe(true)

    // T+0 标的：当日买入当日可卖。
    ledger.init('511990', {
      type: 'etf',
      qty: 100,
      cost: 100,
      cash: 100000,
      settlement: 'T+0',
    })
    expect(ledger.trade('511990', { side: 'buy', qty: 100, price: 100.1 }).ok).toBe(true)
    expect(ledger.query('511990').sellableQty).toBe(200)
    expect(ledger.trade('511990', { side: 'sell', qty: 200, price: 100.2 }).ok).toBe(true)
  })
})
