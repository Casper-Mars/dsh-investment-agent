/**
 * tester-issue6-t1.INDEPENDENT.spec.ts —— Issue #6「ledger_trade 未校验 A 股 T+1」独立验收。
 *
 * 与 Developer 的 tests/settlement.test.ts / tests/ledger.test.ts 的区别：
 *   - 不 mock Ledger，**真实** `Ledger` + `mkdtempSync` 临时数据目录 + 注入时钟；
 *   - 拒绝路径的「零写入」用**文件字节级**证据（positions/accounts/trades 读写前后全等），
 *     不只看 query 返回值；
 *   - 工具层走**真实** dsh-tools ToolRuntime registry（`isError` 归一化链路），
 *     而非直接调用 `execute`；
 *   - 旧 `symbols.json`（无 settlement 字段）用**手写文件**构造，验证只读兼容且不回写。
 *
 * 验收点映射（Leader 下发）：
 *   AC1 同日买入后卖出被拒 + 零写入；
 *   AC2 存量 200 + 当日买 100 → 卖 200 成功、再卖被拒；
 *   AC3 跨日解冻；
 *   AC4 settlement='T+0' 当日回转；
 *   AC5 init 期初存量当日可卖；
 *   AC6 错误文案含 当日买入量/可卖量/持仓量，ETF「份」/股票「股」；
 *   AC7 旧 symbols.json 无 settlement → 按 T+1 且不回写；
 *   AC8 typecheck/test/build（由外层命令验证，报告记录）。
 *
 * 只新增本文件，不改 src/**、不改既有测试、不 commit / push。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import ToolRuntime, {
  validateJsonSchemaValue,
  type ToolDefinition,
} from '@deepseek-ai/dsh-tools'
import { Ledger } from '../src/domain/ledger.js'
import { computeSellableQty, todayBuyQty, tradingDayKey } from '../src/domain/settlement.js'
import { registerAllTools } from '../src/tools/index.js'

vi.setConfig({ testTimeout: 30000 })

/* ================================================================== *
 * 通用工具
 * ================================================================== */

/** 北京时间 → 毫秒时间戳（显式 +08:00，与宿主 TZ 无关）。 */
const cst = (iso: string): number => Date.parse(`${iso}+08:00`)

const DAY1_1000 = cst('2026-10-13T10:00:00')
const DAY1_1430 = cst('2026-10-13T14:30:00')
const DAY2_1000 = cst('2026-10-14T10:00:00')

/** 可控时钟（毫秒时间戳）。 */
class Clock {
  constructor(public t: number) {}
  readonly now = (): number => this.t
  set(ts: number): void {
    this.t = ts
  }
}

/** 台账表文件路径。 */
function tablePath(dataRoot: string, symbol: string, table: string): string {
  return join(dataRoot, 'ledger', symbol, `${table}.json`)
}

/** 读原始字节（utf8）；不存在返回 null。 */
function raw(dataRoot: string, symbol: string, table: string): string | null {
  const p = tablePath(dataRoot, symbol, table)
  return existsSync(p) ? readFileSync(p, 'utf8') : null
}

/** 读 JSON 表。 */
function json<T>(dataRoot: string, symbol: string, table: string): T | undefined {
  const s = raw(dataRoot, symbol, table)
  return s === null ? undefined : (JSON.parse(s) as T)
}

/** 一次性抓取 positions/accounts/trades 的原始字节，用于「零写入」对比。 */
function rawSnapshot(dataRoot: string, symbol: string): Record<string, string | null> {
  return {
    positions: raw(dataRoot, symbol, 'positions'),
    accounts: raw(dataRoot, symbol, 'accounts'),
    trades: raw(dataRoot, symbol, 'trades'),
  }
}

/** 手写一套「旧版」账本（symbols.json 无 settlement 字段）。 */
function writeLegacyLedger(
  dataRoot: string,
  symbol: string,
  opts: { type: 'etf' | 'stock'; qty: number; avgCost: number; cash: number; initTs: number },
): void {
  const dir = join(dataRoot, 'ledger', symbol)
  mkdirSync(dir, { recursive: true })
  // 关键：无 settlement 字段（Issue #6 之前的存量数据）。
  writeFileSync(
    join(dir, 'symbols.json'),
    JSON.stringify(
      { symbol, name: '旧数据标的', type: opts.type, initPrice: opts.avgCost },
      null,
      2,
    ),
    'utf8',
  )
  writeFileSync(
    join(dir, 'positions.json'),
    JSON.stringify({ symbol, qty: opts.qty, avgCost: opts.avgCost }, null, 2),
    'utf8',
  )
  writeFileSync(
    join(dir, 'accounts.json'),
    JSON.stringify({ symbol, cash: opts.cash, realizedPnl: 0, floatPnl: 0 }, null, 2),
    'utf8',
  )
  writeFileSync(
    join(dir, 'trades.json'),
    JSON.stringify(
      [
        {
          id: 't_legacy_init',
          symbol,
          side: 'buy',
          qty: opts.qty,
          price: opts.avgCost,
          ts: opts.initTs,
          reason: 'init',
        },
      ],
      null,
      2,
    ),
    'utf8',
  )
}

/* ================================================================== *
 * 第一部分：domain 层（真实 Ledger + 注入时钟 + 临时目录）
 * ================================================================== */

describe('Issue #6 · domain 层（真实 Ledger / 文件级证据）', () => {
  let dir: string
  let clock: Clock
  let ledger: Ledger

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'dsh-issue6-domain-'))
    clock = new Clock(DAY1_1000)
    ledger = new Ledger(dir, clock.now)
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  /* ---------------- AC1 ---------------- */

  it('AC1：同日买入 100 后卖出 100 被拒绝，qty/cash/realizedPnl/trades 全不变（字节级零写入）', () => {
    // AC1 的字面构造是「init 后当日买 100，卖 100 被拒」。init qty 必须 >0 且为 100 倍数，
    // 故先用「init 100 → 卖出 100（期初存量，合法）→ 当日买 100」得到 0 存量 + 当日买入 100
    // 的真实状态，再验证卖 100 被 T+1 拦截。
    ledger.init('588000', {
      type: 'etf',
      name: '科创50ETF',
      qty: 100,
      cost: 2,
      cash: 100000,
    })
    const sellInit = ledger.trade('588000', { side: 'sell', qty: 100, price: 2.2 })
    expect(sellInit.ok, `期初存量卖出应放行：${sellInit.error ?? ''}`).toBe(true)

    const buy = ledger.trade('588000', { side: 'buy', qty: 100, price: 2.1 })
    expect(buy.ok).toBe(true)

    const beforeQuery = ledger.query('588000')
    expect(beforeQuery.qty).toBe(100)
    expect(beforeQuery.sellableQty).toBe(0)
    expect(beforeQuery.cash).toBe(100010)
    expect(beforeQuery.realizedPnl).toBe(20)
    const tradesBefore = ledger.getTrades('588000')
    expect(tradesBefore).toHaveLength(3)
    const filesBefore = rawSnapshot(dir, '588000')

    const rejected = ledger.trade('588000', { side: 'sell', qty: 100, price: 2.3 })
    expect(rejected.ok).toBe(false)
    expect(rejected.error).toMatch(/T\+1/)
    expect(rejected.error).toContain('当日买入 100 份')
    expect(rejected.error).toContain('当前可卖 0 份')
    expect(rejected.error).toContain('持仓 100 份')

    const afterQuery = ledger.query('588000')
    expect(afterQuery.qty).toBe(beforeQuery.qty)
    expect(afterQuery.cash).toBe(beforeQuery.cash)
    expect(afterQuery.realizedPnl).toBe(beforeQuery.realizedPnl)
    expect(afterQuery.sellableQty).toBe(0)
    expect(ledger.getTrades('588000')).toHaveLength(tradesBefore.length)

    // 文件字节级零写入：拒绝路径不得触碰 positions / accounts / trades。
    expect(rawSnapshot(dir, '588000'), '拒绝路径必须零写入').toEqual(filesBefore)
  })

  it('AC1 前置：init qty=0 被拒绝，说明字面场景需以「清仓后买入」构造', () => {
    expect(() =>
      ledger.init('588000', { type: 'etf', qty: 0, cost: 2, cash: 100000 }),
    ).toThrow(/100 整数倍/)
    expect(existsSync(join(dir, 'ledger', '588000', 'symbols.json'))).toBe(false)
  })

  /* ---------------- AC2 ---------------- */

  it('AC2：期初 200 + 当日买 100 → 卖 200 成功；再卖 100 被拒（卖前可卖 200，卖后 0）', () => {
    ledger.init('588000', { type: 'etf', name: '科创50ETF', qty: 200, cost: 2, cash: 100000 })
    expect(ledger.query('588000').sellableQty).toBe(200) // init 不计入当日买入

    const buy = ledger.trade('588000', { side: 'buy', qty: 100, price: 2.1, reason: '加仓' })
    expect(buy.ok).toBe(true)
    expect(ledger.query('588000').qty).toBe(300)
    expect(ledger.query('588000').sellableQty).toBe(200)

    // 卖 200（仅卖存量部分）→ 放行。
    const sell1 = ledger.trade('588000', { side: 'sell', qty: 200, price: 2.2 })
    expect(sell1.ok, `卖 200 应成功：${sell1.error ?? ''}`).toBe(true)
    expect(sell1.newQty).toBe(100)
    expect(ledger.query('588000').sellableQty).toBe(0)

    const before = ledger.query('588000')
    const filesBefore = rawSnapshot(dir, '588000')
    // 再卖 100（剩下的是当日买入）→ 拒绝。
    const sell2 = ledger.trade('588000', { side: 'sell', qty: 100, price: 2.3 })
    expect(sell2.ok).toBe(false)
    expect(sell2.error).toMatch(/T\+1/)
    expect(sell2.error).toContain('当前可卖 0 份')
    expect(ledger.query('588000').qty).toBe(before.qty)
    expect(ledger.query('588000').cash).toBe(before.cash)
    expect(rawSnapshot(dir, '588000')).toEqual(filesBefore)
  })

  /* ---------------- AC3 ---------------- */

  it('AC3：跨日（推进时钟到次日）当日买入量清零，冻结部分可卖', () => {
    ledger.init('588000', { type: 'etf', qty: 100, cost: 2, cash: 100000 })
    expect(ledger.trade('588000', { side: 'buy', qty: 100, price: 2.1 }).ok).toBe(true)
    expect(ledger.query('588000').sellableQty).toBe(100)

    clock.set(DAY2_1000)
    const q = ledger.query('588000')
    expect(q.settlement).toBe('T+1')
    expect(q.qty).toBe(200)
    expect(q.sellableQty).toBe(200)
    expect(todayBuyQty(ledger.getTrades('588000'), clock.t)).toBe(0)

    const sell = ledger.trade('588000', { side: 'sell', qty: 200, price: 2.2 })
    expect(sell.ok, `跨日后卖 200 应成功：${sell.error ?? ''}`).toBe(true)
    expect(sell.newQty).toBe(0)
  })

  /* ---------------- AC4 ---------------- */

  it('AC4：settlement=T+0 当日买入可立即卖出，完整回转成功', () => {
    ledger.init('511990', {
      type: 'etf',
      name: '华宝添益',
      qty: 100,
      cost: 100,
      cash: 100000,
      settlement: 'T+0',
    })
    expect(ledger.query('511990').settlement).toBe('T+0')

    const buy = ledger.trade('511990', { side: 'buy', qty: 100, price: 100 })
    expect(buy.ok).toBe(true)
    expect(ledger.query('511990').sellableQty).toBe(200)

    // 同日完整回转 200。
    const sell = ledger.trade('511990', { side: 'sell', qty: 200, price: 100 })
    expect(sell.ok, `T+0 应允许当日回转：${sell.error ?? ''}`).toBe(true)
    expect(sell.newQty).toBe(0)
    expect(ledger.query('511990').settlement).toBe('T+0')
    expect(ledger.query('511990').sellableQty).toBe(0)

    // 回转后当日再买再卖仍可（T+0 无冻结）。
    expect(ledger.trade('511990', { side: 'buy', qty: 100, price: 100 }).ok).toBe(true)
    expect(ledger.trade('511990', { side: 'sell', qty: 100, price: 100 }).ok).toBe(true)
  })

  /* ---------------- AC5 ---------------- */

  it('AC5：init 期初存量持仓当日可卖（reason=init 不计入当日买入）', () => {
    ledger.init('000001', {
      type: 'stock',
      name: '平安银行',
      qty: 500,
      cost: 10,
      cash: 100000,
    })
    const q = ledger.query('000001')
    expect(q.settlement).toBe('T+1')
    expect(q.sellableQty).toBe(500)
    expect(todayBuyQty(ledger.getTrades('000001'), clock.t)).toBe(0)

    const sell = ledger.trade('000001', { side: 'sell', qty: 500, price: 12 })
    expect(sell.ok, `期初存量应可卖：${sell.error ?? ''}`).toBe(true)
    expect(sell.newQty).toBe(0)
    expect(sell.realizedPnl).toBe(1000)
  })

  /* ---------------- AC6 ---------------- */

  it('AC6：ETF 错误文案含当日买入/可卖/持仓量且单位为「份」', () => {
    ledger.init('588000', { type: 'etf', name: '科创50ETF', qty: 100, cost: 2, cash: 100000 })
    expect(ledger.trade('588000', { side: 'buy', qty: 100, price: 2.1 }).ok).toBe(true)

    const r = ledger.trade('588000', { side: 'sell', qty: 200, price: 2.2 })
    expect(r.ok).toBe(false)
    const msg = r.error ?? ''
    expect(msg).toContain('当日买入 100 份')
    expect(msg).toContain('当前可卖 100 份')
    expect(msg).toContain('持仓 200 份')
    expect(msg).not.toContain('股')
  })

  it('AC6：股票错误文案单位为「股」', () => {
    ledger.init('000001', { type: 'stock', qty: 100, cost: 10, cash: 100000 })
    expect(ledger.trade('000001', { side: 'buy', qty: 100, price: 10 }).ok).toBe(true)

    const r = ledger.trade('000001', { side: 'sell', qty: 200, price: 10.5 })
    expect(r.ok).toBe(false)
    const msg = r.error ?? ''
    expect(msg).toContain('当日买入 100 股')
    expect(msg).toContain('当前可卖 100 股')
    expect(msg).toContain('持仓 200 股')
    expect(msg).not.toContain('份')
  })

  /* ---------------- AC7 ---------------- */

  it('AC7：旧 symbols.json 无 settlement → 按 T+1 工作，且读取/交易回写均不改写该文件', () => {
    writeLegacyLedger(dir, '000001', {
      type: 'stock',
      qty: 300,
      avgCost: 10,
      cash: 50000,
      initTs: cst('2026-10-13T09:30:00'),
    })
    const legacyLedger = new Ledger(dir, clock.now)
    const symbolsBefore = raw(dir, '000001', 'symbols')

    const q = legacyLedger.query('000001')
    expect(q.settlement).toBe('T+1')
    expect(q.sellableQty).toBe(300)
    // 只读不得回写。
    expect(raw(dir, '000001', 'symbols')).toBe(symbolsBefore)

    expect(legacyLedger.trade('000001', { side: 'buy', qty: 100, price: 10.2 }).ok).toBe(true)
    expect(raw(dir, '000001', 'symbols')).toBe(symbolsBefore)
    expect(legacyLedger.query('000001').sellableQty).toBe(300)

    // 卖 400 越界 → 拒绝，且 trades 文件零写入。
    const tradesBefore = raw(dir, '000001', 'trades')
    const r = legacyLedger.trade('000001', { side: 'sell', qty: 400, price: 10.5 })
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/T\+1/)
    expect(raw(dir, '000001', 'trades')).toBe(tradesBefore)

    // 卖 300（存量）→ 放行；symbols.json 仍保持原样（无 settlement 字段）。
    expect(legacyLedger.trade('000001', { side: 'sell', qty: 300, price: 10.5 }).ok).toBe(true)
    expect(raw(dir, '000001', 'symbols')).toBe(symbolsBefore)
    expect(raw(dir, '000001', 'symbols')).not.toContain('settlement')
  })

  /* ---------------- 边界补充 ---------------- */

  it('边界：23:59 买入 / 次日 00:01 卖出 → 放行（Asia/Shanghai 日界，不依赖宿主 TZ）', () => {
    clock.set(cst('2026-10-13T23:59:00'))
    ledger.init('588000', { type: 'etf', qty: 100, cost: 2, cash: 100000 })
    expect(ledger.trade('588000', { side: 'buy', qty: 100, price: 2 }).ok).toBe(true)
    expect(ledger.query('588000').sellableQty).toBe(100)

    clock.set(cst('2026-10-14T00:01:00'))
    expect(ledger.query('588000').sellableQty).toBe(200)
    const r = ledger.trade('588000', { side: 'sell', qty: 200, price: 2.1 })
    expect(r.ok, `跨自然日 00:01 应解冻：${r.error ?? ''}`).toBe(true)
  })

  it('边界：当日先卖后买再卖 —— 卖出不重置当日买入量', () => {
    ledger.init('588000', { type: 'etf', qty: 200, cost: 2, cash: 100000 })
    // 先卖 100（存量）→ qty 100。
    expect(ledger.trade('588000', { side: 'sell', qty: 100, price: 2.1 }).ok).toBe(true)
    // 再买 100 → qty 200，当日买入 100。
    expect(ledger.trade('588000', { side: 'buy', qty: 100, price: 2.1 }).ok).toBe(true)
    expect(ledger.query('588000').sellableQty).toBe(100)
    expect(todayBuyQty(ledger.getTrades('588000'), clock.t)).toBe(100)

    // 卖 200 被拒（可卖仅 100）。
    const r = ledger.trade('588000', { side: 'sell', qty: 200, price: 2.2 })
    expect(r.ok).toBe(false)
    expect(r.error).toContain('当日买入 100 份')
    // 卖 100 放行。
    expect(ledger.trade('588000', { side: 'sell', qty: 100, price: 2.2 }).ok).toBe(true)
  })

  it('边界：当日买入后部分卖出 —— 剩余可卖量按持仓 − 当日买入量计算', () => {
    ledger.init('588000', { type: 'etf', qty: 200, cost: 2, cash: 100000 })
    expect(ledger.trade('588000', { side: 'buy', qty: 100, price: 2.1 }).ok).toBe(true)
    expect(ledger.query('588000').sellableQty).toBe(200)

    // 部分卖出 100 → 持仓 200，可卖 100。
    expect(ledger.trade('588000', { side: 'sell', qty: 100, price: 2.2 }).ok).toBe(true)
    expect(ledger.query('588000').qty).toBe(200)
    expect(ledger.query('588000').sellableQty).toBe(100)

    // 再卖 200 被拒。
    const r = ledger.trade('588000', { side: 'sell', qty: 200, price: 2.2 })
    expect(r.ok).toBe(false)
    expect(r.error).toContain('当前可卖 100 份')
    // 再卖 100 放行。
    expect(ledger.trade('588000', { side: 'sell', qty: 100, price: 2.2 }).ok).toBe(true)
    expect(ledger.query('588000').sellableQty).toBe(0)
  })

  it('边界：同日多笔买入累加，卖出不重置；跨日后全部解冻', () => {
    ledger.init('588000', { type: 'etf', qty: 100, cost: 2, cash: 100000 })
    expect(ledger.trade('588000', { side: 'buy', qty: 100, price: 2.1 }).ok).toBe(true)
    expect(ledger.trade('588000', { side: 'buy', qty: 200, price: 2.2 }).ok).toBe(true)
    expect(todayBuyQty(ledger.getTrades('588000'), clock.t)).toBe(300)
    expect(ledger.query('588000').qty).toBe(400)
    expect(ledger.query('588000').sellableQty).toBe(100)

    clock.set(DAY2_1000)
    expect(ledger.query('588000').sellableQty).toBe(400)
    expect(ledger.trade('588000', { side: 'sell', qty: 400, price: 2.3 }).ok).toBe(true)
  })
})

/* ================================================================== *
 * 第二部分：settlement 纯函数（独立复核日界与口径）
 * ================================================================== */

describe('Issue #6 · settlement 纯函数复核', () => {
  it('tradingDayKey 以 Asia/Shanghai 为日界（UTC 15:59Z=北京 23:59，16:01Z=次日 00:01）', () => {
    expect(tradingDayKey(Date.parse('2026-10-13T15:59:00Z'))).toBe('2026-10-13')
    expect(tradingDayKey(Date.parse('2026-10-13T16:01:00Z'))).toBe('2026-10-14')
    expect(tradingDayKey(Date.parse('2026-10-13T16:00:00Z'))).toBe('2026-10-14')
  })

  it('computeSellableQty：T+1 扣当日买入；T+0 全额；可卖量非负', () => {
    const trades = [
      { id: 'a', symbol: 'X', side: 'buy' as const, qty: 500, price: 1, ts: DAY1_1000, reason: 'init' },
      { id: 'b', symbol: 'X', side: 'buy' as const, qty: 100, price: 1, ts: DAY1_1430 },
    ]
    expect(
      computeSellableQty({ rule: 'T+1', positionQty: 600, trades, now: DAY1_1430 }),
    ).toBe(500)
    expect(
      computeSellableQty({ rule: 'T+0', positionQty: 600, trades, now: DAY1_1430 }),
    ).toBe(600)
    expect(
      computeSellableQty({ rule: 'T+1', positionQty: 50, trades, now: DAY1_1430 }),
    ).toBe(0)
  })
})

/* ================================================================== *
 * 第三部分：工具层（真实 ToolRuntime registry → isError / schema）
 * ================================================================== */

interface RegistryResult {
  isError: boolean
  value?: unknown
  content: Array<{ type: string; text?: string }>
  error?: { message: string; info?: { name?: string; code?: string } }
}

interface ToolBox {
  schemas: () => Array<{ name: string; description: string; parameters: unknown }>
  get: (name: string) => ToolDefinition | undefined
  execute: (input: unknown) => Promise<RegistryResult>
  register: (def: ToolDefinition) => () => void
}

function systemPromptStub() {
  return {
    name: 'systemPrompt',
    tools() {},
    section() {},
    getSectionOrder() {
      return 0
    },
  } as unknown as never
}

interface Booted {
  tools: ToolBox
  dispose: () => Promise<void>
}

async function bootRegistry(dataRoot: string): Promise<Booted> {
  const app = new Context()
  app.provide('systemPrompt', systemPromptStub())
  const toolsFiber = (await app.plugin(ToolRuntime as never)) as unknown as {
    dispose: () => Promise<void>
  }
  const pluginFiber = app.plugin({
    name: 'dsh-ia-tools-issue6',
    inject: ['tools'],
    apply(ctx: Context) {
      registerAllTools(ctx, { dataRoot })
    },
  } as never) as unknown as { dispose: () => Promise<void> }

  const tools = (app as unknown as { tools: ToolBox }).tools
  await vi.waitFor(
    () => {
      expect(tools.schemas()).toHaveLength(15)
    },
    { timeout: 5000, interval: 10 },
  )
  return {
    tools,
    async dispose() {
      await pluginFiber.dispose()
      await toolsFiber.dispose()
    },
  }
}

let seq = 0
function call(
  tools: ToolBox,
  name: string,
  args: Record<string, unknown> = {},
): Promise<RegistryResult> {
  seq += 1
  return tools.execute({
    callId: `issue6-${seq}`,
    name,
    arguments: args,
    signal: new AbortController().signal,
  })
}

const textOf = (r: RegistryResult): string => r.content.map((c) => c.text ?? '').join('\n')
const valueOf = (r: RegistryResult): unknown => r.value

function expectSchemaOk(tools: ToolBox, name: string, value: unknown): void {
  const def = tools.get(name)!
  const violations = validateJsonSchemaValue(def.output.schema, value)
  expect(
    violations,
    `${name} 成功值不符合 output.schema：${JSON.stringify(violations)}`,
  ).toEqual([])
}

describe('Issue #6 · 工具层（真实 registry：ledger_init / ledger_query / ledger_trade）', () => {
  let dir: string
  let booted: Booted
  let tools: ToolBox
  let prevHome: string | undefined

  beforeEach(async () => {
    // 本地时间 10:00 → 任意宿主 TZ 下都是连续竞价时段，避免交易时段闸门干扰。
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 9, 13, 10, 0, 0))
    dir = mkdtempSync(join(tmpdir(), 'dsh-issue6-tools-'))
    prevHome = process.env.DSH_IA_HOME
    process.env.DSH_IA_HOME = dir
    booted = await bootRegistry(dir)
    tools = booted.tools
  })

  afterEach(async () => {
    await booted.dispose()
    vi.useRealTimers()
    if (prevHome === undefined) delete process.env.DSH_IA_HOME
    else process.env.DSH_IA_HOME = prevHome
    rmSync(dir, { recursive: true, force: true })
  })

  it('工具层：ledger_init 缺省 settlement=T+1；ledger_query 返回 settlement/sellable_qty', async () => {
    const init = await call(tools, 'ledger_init', {
      symbol: '588000',
      type: 'etf',
      name: '科创50ETF',
      init_qty: 1000,
      init_cost: 1.95,
      init_cash: 100000,
    })
    expect(init.isError, textOf(init)).toBe(false)
    expectSchemaOk(tools, 'ledger_init', valueOf(init))

    const q = await call(tools, 'ledger_query', { symbol: '588000' })
    expect(q.isError, textOf(q)).toBe(false)
    const v = valueOf(q) as Record<string, unknown>
    expect(v.settlement).toBe('T+1')
    expect(v.sellable_qty).toBe(1000) // init 存量当日可卖
    expect(v.qty).toBe(1000)
    expectSchemaOk(tools, 'ledger_query', v)

    // 渲染文本也透出结算与可卖量。
    expect(textOf(q)).toContain('结算：T+1')
    expect(textOf(q)).toContain('可卖：1000')

    const list = await call(tools, 'ledger_list')
    expect(list.isError, textOf(list)).toBe(false)
    expect((valueOf(list) as { symbols: Array<Record<string, unknown>> }).symbols[0].settlement).toBe(
      'T+1',
    )
  })

  it('工具层 AC1/AC6：同日买入后超卖 → isError，文案含 T+1/当日买入/可卖/持仓，状态零变化', async () => {
    await call(tools, 'ledger_init', {
      symbol: '588000',
      type: 'etf',
      init_qty: 100,
      init_cost: 2,
      init_cash: 100000,
    })
    // 清掉期初存量，构造「全部为当日买入」的状态。
    const clear = await call(tools, 'ledger_trade', { symbol: '588000', side: 'sell', qty: 100, price: 2 })
    expect(clear.isError, textOf(clear)).toBe(false)

    const buy = await call(tools, 'ledger_trade', {
      symbol: '588000',
      side: 'buy',
      qty: 100,
      price: 2.1,
      reason: '当日买入',
    })
    expect(buy.isError, textOf(buy)).toBe(false)

    const before = valueOf(await call(tools, 'ledger_query', { symbol: '588000' })) as Record<
      string,
      unknown
    >
    expect(before.sellable_qty).toBe(0)
    const filesBefore = rawSnapshot(dir, '588000')

    const rejected = await call(tools, 'ledger_trade', {
      symbol: '588000',
      side: 'sell',
      qty: 100,
      price: 2.2,
    })
    expect(rejected.isError, 'T+1 违规必须归一为 isError').toBe(true)
    const msg = textOf(rejected)
    expect(msg).toMatch(/T\+1/)
    expect(msg).toContain('当日买入 100 份')
    expect(msg).toContain('当前可卖 0 份')
    expect(msg).toContain('持仓 100 份')

    const after = valueOf(await call(tools, 'ledger_query', { symbol: '588000' })) as Record<
      string,
      unknown
    >
    expect(after.qty).toBe(before.qty)
    expect(after.cash).toBe(before.cash)
    expect(after.realized_pnl).toBe(before.realized_pnl)
    expect(rawSnapshot(dir, '588000'), '工具层拒绝路径必须零写入').toEqual(filesBefore)
  })

  it('工具层 AC4：ledger_init settlement=T+0 → 当日买入可立即卖出（成功，非 isError）', async () => {
    const init = await call(tools, 'ledger_init', {
      symbol: '511990',
      type: 'etf',
      init_qty: 100,
      init_cost: 100,
      init_cash: 100000,
      settlement: 'T+0',
    })
    expect(init.isError, textOf(init)).toBe(false)

    const q0 = valueOf(await call(tools, 'ledger_query', { symbol: '511990' })) as Record<
      string,
      unknown
    >
    expect(q0.settlement).toBe('T+0')

    expect(
      (await call(tools, 'ledger_trade', { symbol: '511990', side: 'buy', qty: 100, price: 100 }))
        .isError,
    ).toBe(false)

    const sell = await call(tools, 'ledger_trade', {
      symbol: '511990',
      side: 'sell',
      qty: 200,
      price: 100,
    })
    expect(sell.isError, `T+0 当日回转应成功：${textOf(sell)}`).toBe(false)
    expect((valueOf(sell) as Record<string, unknown>).new_qty).toBe(0)
  })

  it('工具层 AC3：跨日推进系统时钟 → ledger_query 可卖量解冻，ledger_trade 卖出成功', async () => {
    await call(tools, 'ledger_init', {
      symbol: '588000',
      type: 'etf',
      init_qty: 100,
      init_cost: 2,
      init_cash: 100000,
    })
    expect(
      (await call(tools, 'ledger_trade', { symbol: '588000', side: 'buy', qty: 100, price: 2.1 }))
        .isError,
    ).toBe(false)

    const day1 = valueOf(await call(tools, 'ledger_query', { symbol: '588000' })) as Record<
      string,
      unknown
    >
    expect(day1.sellable_qty).toBe(100)

    // 次日同一时刻（本地 10:00，仍是竞价时段）。
    vi.setSystemTime(new Date(2026, 9, 14, 10, 0, 0))

    const day2 = valueOf(await call(tools, 'ledger_query', { symbol: '588000' })) as Record<
      string,
      unknown
    >
    expect(day2.sellable_qty).toBe(200)

    const sell = await call(tools, 'ledger_trade', {
      symbol: '588000',
      side: 'sell',
      qty: 200,
      price: 2.2,
    })
    expect(sell.isError, `跨日卖出应成功：${textOf(sell)}`).toBe(false)
    expect((valueOf(sell) as Record<string, unknown>).new_qty).toBe(0)
  })

  it('工具层 AC7：旧 symbols.json（无 settlement）→ query 显示 T+1、按 T+1 拦截、文件不回写', async () => {
    writeLegacyLedger(dir, '000001', {
      type: 'stock',
      qty: 300,
      avgCost: 10,
      cash: 50000,
      initTs: Date.now() - 60_000,
    })
    const symbolsBefore = raw(dir, '000001', 'symbols')

    const q = await call(tools, 'ledger_query', { symbol: '000001' })
    expect(q.isError, textOf(q)).toBe(false)
    const v = valueOf(q) as Record<string, unknown>
    expect(v.settlement).toBe('T+1')
    expect(v.sellable_qty).toBe(300)
    expect(raw(dir, '000001', 'symbols')).toBe(symbolsBefore)

    expect(
      (await call(tools, 'ledger_trade', { symbol: '000001', side: 'buy', qty: 100, price: 10.2 }))
        .isError,
    ).toBe(false)
    expect(raw(dir, '000001', 'symbols')).toBe(symbolsBefore)

    const rejected = await call(tools, 'ledger_trade', {
      symbol: '000001',
      side: 'sell',
      qty: 400,
      price: 10.5,
    })
    expect(rejected.isError).toBe(true)
    expect(textOf(rejected)).toMatch(/T\+1/)
    expect(textOf(rejected)).toContain('股')

    const ok = await call(tools, 'ledger_trade', {
      symbol: '000001',
      side: 'sell',
      qty: 300,
      price: 10.5,
    })
    expect(ok.isError, textOf(ok)).toBe(false)
    expect(raw(dir, '000001', 'symbols')).toBe(symbolsBefore)
    expect(raw(dir, '000001', 'symbols')).not.toContain('settlement')
  })

  it('工具层：ledger_init 非法 settlement 值被注册层拒绝（isError）', async () => {
    const r = await call(tools, 'ledger_init', {
      symbol: '588000',
      type: 'etf',
      init_qty: 100,
      init_cost: 2,
      init_cash: 100000,
      settlement: 'T+2',
    })
    expect(r.isError).toBe(true)
    expect(existsSync(tablePath(dir, '588000', 'symbols.json'))).toBe(false)
  })
})
