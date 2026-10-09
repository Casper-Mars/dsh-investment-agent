/**
 * 独立验证 spec —— t100405：[P1] ledger_query 增加可选现价 price 计算浮动盈亏 float_pnl。
 *
 * 本文件由 Tester 独立编写，不复用 Developer 的断言，自行构造持仓/空仓/负值/price=0
 * 场景，直接读原始 accounts.json 核验持久化未被污染，并核验工具层 schema/参数可选性。
 *
 * 契约（设计文档 v1.9 §4.1/§5.1）：
 *   - ledger_query(symbol)            → float_pnl = 0
 *   - ledger_query(symbol, price=X)   → float_pnl = (X − avg_cost) × qty，保留 4 位小数
 *   - 即时计算，不写库（accounts.float_pnl 不被改写）
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { Ledger } from '../src/domain/ledger.js'
import { createToolContext, type ToolContext } from '../src/tools/context.js'
import { createAllTools } from '../src/tools/index.js'

let dir: string
let ledger: Ledger

function accountsPath(symbol: string): string {
  return join(dir, 'ledger', symbol, 'accounts.json')
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 't100405-ind-'))
  ledger = new Ledger(dir)
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

// ───────────────────────────────────────────────────────────────────────────
// 1. 口径正确性：float_pnl = (price − avgCost) × qty（4 位小数）
// ───────────────────────────────────────────────────────────────────────────
describe('t100405 口径正确性（domain.Ledger.query）', () => {
  beforeEach(() => {
    ledger.init('588000', { type: 'etf', qty: 1000, cost: 2.0, cash: 100000 })
  })

  it('不传 price → floatPnl = 0', () => {
    expect(ledger.query('588000').floatPnl).toBe(0)
  })

  it('显式 undefined → floatPnl = 0（等同缺省）', () => {
    expect(ledger.query('588000', undefined).floatPnl).toBe(0)
  })

  it('持仓 + 盈利：(2.5 − 2.0) × 1000 = 500', () => {
    expect(ledger.query('588000', 2.5).floatPnl).toBe(500)
  })

  it('持仓 + 亏损符号正确：(1.8 − 2.0) × 1000 = −200', () => {
    expect(ledger.query('588000', 1.8).floatPnl).toBe(-200)
  })

  it('4 位小数舍入：(2.123456789 − 2.0) × 1000 = 123.456789 → 123.4568', () => {
    expect(ledger.query('588000', 2.123456789).floatPnl).toBe(123.4568)
  })

  it('价格远高于成本：(9.9 − 2.0) × 1000 = 7900', () => {
    expect(ledger.query('588000', 9.9).floatPnl).toBe(7900)
  })
})

// ───────────────────────────────────────────────────────────────────────────
// 2. 边界：price=0 参与计算（不被当作缺省）
// ───────────────────────────────────────────────────────────────────────────
describe('t100405 边界 - price=0', () => {
  it('price=0 参与计算而非回落：(0 − 2.0) × 1000 = −2000', () => {
    ledger.init('588000', { type: 'etf', qty: 1000, cost: 2.0, cash: 100000 })
    const r = ledger.query('588000', 0)
    expect(r.floatPnl).toBe(-2000)
    expect(r.floatPnl).not.toBe(0)
  })
})

// ───────────────────────────────────────────────────────────────────────────
// 3. 边界：空仓 qty=0 → float_pnl 恰为 0（且非 -0）
// ───────────────────────────────────────────────────────────────────────────
describe('t100405 边界 - 空仓 qty=0', () => {
  it('清仓后传 price，float_pnl = 0（非 -0）', () => {
    ledger.init('588000', { type: 'etf', qty: 1000, cost: 2.0, cash: 100000 })
    const t = ledger.trade('588000', { side: 'sell', qty: 1000, price: 2.5 })
    expect(t.ok).toBe(true)
    const snap = ledger.query('588000', 3.0)
    expect(snap.qty).toBe(0)
    expect(snap.floatPnl).toBe(0)
    expect(Object.is(snap.floatPnl, -0)).toBe(false)
  })

  it('清仓后不传 price 亦为 0', () => {
    ledger.init('588000', { type: 'etf', qty: 1000, cost: 2.0, cash: 100000 })
    ledger.trade('588000', { side: 'sell', qty: 1000, price: 2.5 })
    expect(ledger.query('588000').floatPnl).toBe(0)
  })
})

// ───────────────────────────────────────────────────────────────────────────
// 4. 第二个标的：不同 qty/cost 再验口径（避免单一场景巧合）
// ───────────────────────────────────────────────────────────────────────────
describe('t100405 口径正确性 - 第二标的', () => {
  it('qty=300 cost=10.5：盈利/亏损/小数 三算', () => {
    ledger.init('000001', { type: 'stock', qty: 300, cost: 10.5, cash: 50000 })
    // (11.0 − 10.5) × 300 = 150
    expect(ledger.query('000001', 11.0).floatPnl).toBe(150)
    // (10.0 − 10.5) × 300 = −150
    expect(ledger.query('000001', 10.0).floatPnl).toBe(-150)
    // (10.50005 − 10.5) × 300 = 0.015 → 0.015
    expect(ledger.query('000001', 10.50005).floatPnl).toBe(0.015)
  })
})

// ───────────────────────────────────────────────────────────────────────────
// 5. 持久化不污染：accounts.json 原始字节不变；带 price 查询后无 price 仍为 0
// ───────────────────────────────────────────────────────────────────────────
describe('t100405 持久化不污染', () => {
  it('带 price 查询不改写 accounts.json（原始字节一致）', () => {
    ledger.init('588000', { type: 'etf', qty: 1000, cost: 2.0, cash: 100000 })
    const before = readFileSync(accountsPath('588000'), 'utf8')

    // 多次带 price 查询
    expect(ledger.query('588000', 5.0).floatPnl).toBe(3000)
    expect(ledger.query('588000', 1.0).floatPnl).toBe(-1000)

    const after = readFileSync(accountsPath('588000'), 'utf8')
    expect(after).toBe(before)

    // 反序列化后持久化字段 floatPnl（camelCase，store 结构）仍为 0
    const acc = JSON.parse(after) as { floatPnl: number }
    expect(acc.floatPnl).toBe(0)
  })

  it('带 price 查询后，再次不带 price 查询仍返回 0', () => {
    ledger.init('588000', { type: 'etf', qty: 1000, cost: 2.0, cash: 100000 })
    expect(ledger.query('588000', 5.0).floatPnl).toBe(3000)
    expect(ledger.query('588000').floatPnl).toBe(0)
  })

  it('买入/卖出后 accounts.float_pnl 仍写占位 0', () => {
    ledger.init('588000', { type: 'etf', qty: 1000, cost: 2.0, cash: 100000 })
    ledger.trade('588000', { side: 'buy', qty: 100, price: 2.2 })
    expect((JSON.parse(readFileSync(accountsPath('588000'), 'utf8')) as { floatPnl: number }).floatPnl).toBe(0)
  })
})

// ───────────────────────────────────────────────────────────────────────────
// 6. 向后兼容：旧单参调用 query(symbol) 正常
// ───────────────────────────────────────────────────────────────────────────
describe('t100405 向后兼容', () => {
  it('旧单参调用 query(symbol) 返回完整快照且 floatPnl=0', () => {
    ledger.init('588000', { type: 'etf', name: '科创50ETF', qty: 1000, cost: 2.0, cash: 100000 })
    const s = ledger.query('588000')
    expect(s.symbol).toBe('588000')
    expect(s.qty).toBe(1000)
    expect(s.avgCost).toBe(2.0)
    expect(s.floatPnl).toBe(0)
  })

  it('list() 内部调用 query(symbol) 单参，不受影响', () => {
    ledger.init('588000', { type: 'etf', qty: 1000, cost: 2.0, cash: 100000 })
    const l = ledger.list()
    expect(l).toHaveLength(1)
    expect(l[0]).toMatchObject({ symbol: '588000', qty: 1000, avgCost: 2.0 })
  })
})

// ───────────────────────────────────────────────────────────────────────────
// 7. 工具层：ledger_query 可选 price + output.schema 校验 + 参数可选性
// ───────────────────────────────────────────────────────────────────────────
describe('t100405 工具层 ledger_query', () => {
  let ctx: ToolContext
  let tools: ToolDefinition[]

  function tool(name: string): ToolDefinition {
    const t = tools.find((x) => x.name === name)
    if (!t) throw new Error(`工具 ${name} 未注册`)
    return t
  }
  async function run(name: string, args: Record<string, unknown> = {}) {
    return tool(name).execute(args, { signal: new AbortController().signal })
  }
  function assertSchema(name: string, value: unknown) {
    const v = validateJsonSchemaValue(tool(name).output.schema, value)
    expect(v, `${name} schema 违规：${v?.join('; ')}`).toEqual([])
  }

  beforeEach(() => {
    ctx = createToolContext({ dataRoot: dir })
    tools = createAllTools(ctx)
  })

  it('price 为可选参数（properties 含 price 且不在 required 列表）', () => {
    const params = tool('ledger_query').parameters as {
      properties: Record<string, { type: string }>
      required: string[]
    }
    expect(params.properties.price).toBeDefined()
    expect(params.properties.price.type).toBe('number')
    expect(params.required).toContain('symbol')
    expect(params.required).not.toContain('price')
  })

  it('不传 price → float_pnl = 0（并过 schema）', async () => {
    await run('ledger_init', { symbol: '588000', type: 'etf', init_qty: 1000, init_cost: 2, init_cash: 100000 })
    const v = await run('ledger_query', { symbol: '588000' })
    expect(v.float_pnl).toBe(0)
    assertSchema('ledger_query', v)
  })

  it('传 price=2.5 → float_pnl = 500（并过 schema）', async () => {
    await run('ledger_init', { symbol: '588000', type: 'etf', init_qty: 1000, init_cost: 2, init_cash: 100000 })
    const v = await run('ledger_query', { symbol: '588000', price: 2.5 })
    expect(v.float_pnl).toBe(500)
    assertSchema('ledger_query', v)
  })

  it('传 price=0 → 参与计算（−2000），不回落', async () => {
    await run('ledger_init', { symbol: '588000', type: 'etf', init_qty: 1000, init_cost: 2, init_cash: 100000 })
    const v = await run('ledger_query', { symbol: '588000', price: 0 })
    expect(v.float_pnl).toBe(-2000)
    assertSchema('ledger_query', v)
  })

  it('空仓传 price → float_pnl = 0', async () => {
    await run('ledger_init', { symbol: '588000', type: 'etf', init_qty: 1000, init_cost: 2, init_cash: 100000 })
    await run('ledger_trade', { symbol: '588000', side: 'sell', qty: 1000, price: 2.5 })
    const v = await run('ledger_query', { symbol: '588000', price: 3 })
    expect(v.qty).toBe(0)
    expect(v.float_pnl).toBe(0)
    assertSchema('ledger_query', v)
  })
})
