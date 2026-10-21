/**
 * tester-issue6-f1-reverify.INDEPENDENT.spec.ts —— Issue #6 / F1 修复**独立复验**。
 *
 * 背景：上一轮独立测试（`tests/tester-issue6-t1.INDEPENDENT.spec.ts`）发现
 * F1：`ledger_trade` 可传 `reason='init'`，使当日买入不被计入冻结量，绕过 T+1。
 *
 * 复验原则（不信任实现方自测）：
 *   - 只通过**公开 API**（`Ledger` / 真实 dsh-tools registry）验证，不调用内部私有函数；
 *   - 「零写入」一律用**文件字节级**证据（positions/accounts/trades 前后原文全等 +
 *     目录清单不变），不只看返回值；
 *   - 变体矩阵逐一验证归一化行为（trim + 小写）与「放行即可冻结」；
 *   - 手工构造 `trades.json` 验证**非首笔** `reason='init'` 不被豁免；
 *   - 正常路径（T+1 拦截 / T+0 回转 / init 存量可卖 / 普通 reason 冻结）回归。
 *
 * 只新增本文件，不改 `src/**`、不改既有测试、不 commit / push。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import ToolRuntime, { type ToolDefinition } from '@deepseek-ai/dsh-tools'
import { Ledger } from '../src/domain/ledger.js'
import {
  INIT_TRADE_REASON,
  isReservedTradeReason,
  todayBuyQty,
} from '../src/domain/settlement.js'
import { registerAllTools } from '../src/tools/index.js'

vi.setConfig({ testTimeout: 30000 })

/* ================================================================== *
 * 通用工具（与首轮独立用例同构，保持证据口径一致）
 * ================================================================== */

const cst = (iso: string): number => Date.parse(`${iso}+08:00`)

const DAY1_1000 = cst('2026-10-13T10:00:00')
const DAY2_1000 = cst('2026-10-14T10:00:00')

class Clock {
  constructor(public t: number) {}
  readonly now = (): number => this.t
  set(ts: number): void {
    this.t = ts
  }
}

function symbolDir(dataRoot: string, symbol: string): string {
  return join(dataRoot, 'ledger', symbol)
}

function raw(dataRoot: string, symbol: string, table: string): string | null {
  const p = join(symbolDir(dataRoot, symbol), `${table}.json`)
  return existsSync(p) ? readFileSync(p, 'utf8') : null
}

/** positions / accounts / trades 三表字节快照。 */
function rawSnapshot(dataRoot: string, symbol: string): Record<string, string | null> {
  return {
    positions: raw(dataRoot, symbol, 'positions'),
    accounts: raw(dataRoot, symbol, 'accounts'),
    trades: raw(dataRoot, symbol, 'trades'),
  }
}

/** 标的目录清单（用于证明拒绝路径未新增任何表文件）。 */
function listing(dataRoot: string, symbol: string): string[] {
  const d = symbolDir(dataRoot, symbol)
  return existsSync(d) ? readdirSync(d).sort() : []
}

const text = (v: unknown): string => JSON.stringify(v)

/* ================================================================== *
 * 第一部分：保留值归一化纯函数（isReservedTradeReason）
 * ================================================================== */

const RESERVED_VARIANTS = [
  'init',
  'INIT',
  'Init',
  'inIt',
  ' INIT ',
  'init\t',
  '\tinit\n',
  '  init  ',
] as const

const NON_RESERVED_VARIANTS = [
  { label: '全角 ｉｎｉｔ', value: 'ｉｎｉｔ' },
  { label: '零宽后缀 init\\u200b', value: 'init\u200b' },
  { label: '零宽前缀 \\u200binit', value: '\u200binit' },
  { label: 'init2', value: 'init2' },
  { label: 'init init', value: 'init init' },
  { label: '空串', value: '' },
] as const

describe('F1 复验 · 保留值归一化', () => {
  it('INIT_TRADE_REASON 常量值为 "init"', () => {
    expect(INIT_TRADE_REASON).toBe('init')
  })

  for (const v of RESERVED_VARIANTS) {
    it(`保留判定：${text(v)} → true（trim + 小写归一化）`, () => {
      expect(isReservedTradeReason(v)).toBe(true)
    })
  }

  for (const c of NON_RESERVED_VARIANTS) {
    it(`保留判定：${c.label} → false（不做 Unicode 兼容折叠）`, () => {
      expect(isReservedTradeReason(c.value)).toBe(false)
    })
  }

  it('保留判定：undefined / null（运行时）→ false（类型守卫不抛错）', () => {
    expect(isReservedTradeReason(undefined)).toBe(false)
    expect(isReservedTradeReason(null as unknown as string)).toBe(false)
  })

  it('todayBuyQty：仅「首笔 + reason=init」豁免；非首笔 init 仍计入冻结', () => {
    const trades = [
      { id: 'a', symbol: 'X', side: 'buy', qty: 200, price: 2, ts: DAY1_1000, reason: 'init' },
      { id: 'b', symbol: 'X', side: 'buy', qty: 100, price: 2, ts: DAY1_1000, reason: '加仓' },
      { id: 'c', symbol: 'X', side: 'buy', qty: 100, price: 2, ts: DAY1_1000, reason: 'init' },
    ] as never
    expect(todayBuyQty(trades, DAY1_1000)).toBe(200)
    // 跨日后当日买入量归零（与冻结豁免无关）。
    expect(todayBuyQty(trades, DAY2_1000)).toBe(0)
  })

  it('todayBuyQty：首笔 reason 为 " INIT "（非精确 init）时**不**豁免（偏保守）', () => {
    const trades = [
      { id: 'a', symbol: 'X', side: 'buy', qty: 200, price: 2, ts: DAY1_1000, reason: ' INIT ' },
    ] as never
    expect(todayBuyQty(trades, DAY1_1000)).toBe(200)
  })
})

/* ================================================================== *
 * 第二部分：domain 层 —— 原绕过路径与变体
 * ================================================================== */

describe('F1 复验 · domain 层（真实 Ledger + 文件级零写入）', () => {
  let dir: string
  let clock: Clock
  let ledger: Ledger

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'dsh-f1-domain-'))
    clock = new Clock(DAY1_1000)
    ledger = new Ledger(dir, clock.now)
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  /** 构造「持仓全部为当日买入、可卖量为 0」的状态：init 100 → 卖出 100（合法）→ 当日买 100。 */
  function primeAllTodayBought(symbol = '588000'): void {
    ledger.init(symbol, { type: 'etf', name: '科创50ETF', qty: 100, cost: 2, cash: 100000 })
    const clear = ledger.trade(symbol, { side: 'sell', qty: 100, price: 2 })
    expect(clear.ok, `期初存量卖出应放行：${clear.error ?? ''}`).toBe(true)
    const buy = ledger.trade(symbol, { side: 'buy', qty: 100, price: 2.1 })
    expect(buy.ok).toBe(true)
    const q = ledger.query(symbol)
    expect(q.qty).toBe(100)
    expect(q.sellableQty).toBe(0)
  }

  it('F1-A1【原绕过路径】当日买入 100 后用 reason="init" 卖出 → 被拒，三表字节零变化', () => {
    primeAllTodayBought()

    const beforeQuery = ledger.query('588000')
    const filesBefore = rawSnapshot(dir, '588000')
    const listBefore = listing(dir, '588000')
    const tradesBefore = ledger.getTrades('588000').length

    const bypass = ledger.trade('588000', { side: 'sell', qty: 100, price: 2.3, reason: 'init' })

    expect(bypass.ok, 'F1：reason=init 的卖出必须被拒绝').toBe(false)
    expect(bypass.error).toContain('保留标记')
    expect(bypass.error).toContain('init')

    // 运行时状态零变化
    expect(ledger.query('588000')).toEqual(beforeQuery)
    expect(ledger.getTrades('588000')).toHaveLength(tradesBefore)
    // 文件字节级零写入
    expect(rawSnapshot(dir, '588000'), '拒绝路径必须零写入').toEqual(filesBefore)
    expect(listing(dir, '588000'), '拒绝路径不得新增表文件').toEqual(listBefore)
  })

  it('F1-A2 卖出侧变体矩阵：所有归一化等价写法均被拒绝且零写入', () => {
    for (const v of RESERVED_VARIANTS) {
      // 每个变体独立数据目录（init 重复 symbol 会报错，不能共用一套账本）。
      const d = mkdtempSync(join(tmpdir(), 'dsh-f1-sell-variant-'))
      try {
        const clk = new Clock(DAY1_1000)
        const l = new Ledger(d, clk.now)
        l.init('588000', { type: 'etf', qty: 100, cost: 2, cash: 100000 })
        expect(l.trade('588000', { side: 'sell', qty: 100, price: 2 }).ok).toBe(true)
        expect(l.trade('588000', { side: 'buy', qty: 100, price: 2.1 }).ok).toBe(true)
        expect(l.query('588000').sellableQty).toBe(0)

        const filesBefore = rawSnapshot(d, '588000')
        const res = l.trade('588000', { side: 'sell', qty: 100, price: 2.3, reason: v })
        expect(res.ok, `变体 ${text(v)} 必须被拒绝`).toBe(false)
        expect(res.error).toContain('保留标记')
        expect(rawSnapshot(d, '588000'), `变体 ${text(v)} 必须零写入`).toEqual(filesBefore)
      } finally {
        rmSync(d, { recursive: true, force: true })
      }
    }
  })

  it('F1-A3 买入侧变体矩阵：保留值买入同样被拒绝（不落流水）', () => {
    ledger.init('588000', { type: 'etf', qty: 100, cost: 2, cash: 100000 })
    for (const v of RESERVED_VARIANTS) {
      const filesBefore = rawSnapshot(dir, '588000')
      const res = ledger.trade('588000', { side: 'buy', qty: 100, price: 2.1, reason: v })
      expect(res.ok, `买入变体 ${text(v)} 必须被拒绝`).toBe(false)
      expect(res.error).toContain('保留标记')
      expect(rawSnapshot(dir, '588000'), `买入变体 ${text(v)} 必须零写入`).toEqual(filesBefore)
    }
  })

  it('F1-A4 非保留变体放行，但必须计入当日买入并被 T+1 冻结', () => {
    for (const c of NON_RESERVED_VARIANTS) {
      const d = mkdtempSync(join(tmpdir(), 'dsh-f1-variant-'))
      try {
        const clk = new Clock(DAY1_1000)
        const l = new Ledger(d, clk.now)
        l.init('588000', { type: 'etf', qty: 100, cost: 2, cash: 100000 })
        const buy = l.trade('588000', { side: 'buy', qty: 100, price: 2.1, reason: c.value })
        expect(buy.ok, `变体「${c.label}」应作为普通理由放行：${buy.error ?? ''}`).toBe(true)
        // 放行后：当日买入 100 全部冻结。
        expect(todayBuyQty(l.getTrades('588000'), clk.t), `变体「${c.label}」必须计入冻结`).toBe(100)
        const q = l.query('588000')
        expect(q.qty).toBe(200)
        expect(q.sellableQty).toBe(100) // 仅 init 存量可卖
        const sell = l.trade('588000', { side: 'sell', qty: 200, price: 2.3 })
        expect(sell.ok, `变体「${c.label}」买入的 100 必须被冻结`).toBe(false)
        expect(sell.error).toContain('当日买入 100 份')
        // 与之对照：卖 100（仅存量）合法。
        const sellOk = l.trade('588000', { side: 'sell', qty: 100, price: 2.3 })
        expect(sellOk.ok, `存量部分应可卖：${sellOk.error ?? ''}`).toBe(true)
      } finally {
        rmSync(d, { recursive: true, force: true })
      }
    }
  })

  it('F1-A5 reason 为 null / 缺失 → 视为普通理由，计入当日买入并冻结', () => {
    ledger.init('588000', { type: 'etf', qty: 100, cost: 2, cash: 100000 })
    const buyNull = ledger.trade('588000', {
      side: 'buy',
      qty: 100,
      price: 2.1,
      reason: null as unknown as string,
    })
    expect(buyNull.ok, `reason=null 应放行：${buyNull.error ?? ''}`).toBe(true)
    const buyMissing = ledger.trade('588000', { side: 'buy', qty: 100, price: 2.2 })
    expect(buyMissing.ok).toBe(true)

    expect(todayBuyQty(ledger.getTrades('588000'), clock.t)).toBe(200)
    expect(ledger.query('588000').sellableQty).toBe(100)

    const sell = ledger.trade('588000', { side: 'sell', qty: 300, price: 2.3 })
    expect(sell.ok).toBe(false)
    expect(sell.error).toContain('当日买入 200 份')

    // 落库的 reason 原样保留（null / 缺省），不影响冻结判定。
    const stored = JSON.parse(raw(dir, '588000', 'trades')!) as Array<Record<string, unknown>>
    expect(stored[1]!.reason).toBeNull()
    expect('reason' in stored[2]! ? stored[2]!.reason : undefined).toBeUndefined()
  })

  it('F1-A7 reason 传 String 包装对象（非原始 string）→ 不豁免，仍计入冻结', () => {
    // 运行时 `typeof new String('init') === 'object'`，类型守卫放行；但落库后即便被
    // JSON 序列化为 "init"，也因处于**非首笔**位置而不获 T+1 豁免。
    ledger.init('588000', { type: 'etf', qty: 100, cost: 2, cash: 100000 })
    const buy = ledger.trade('588000', {
      side: 'buy',
      qty: 100,
      price: 2.1,
      reason: new String('init') as unknown as string,
    })
    expect(buy.ok, `String 包装对象不应被当作保留值：${buy.error ?? ''}`).toBe(true)
    expect(todayBuyQty(ledger.getTrades('588000'), clock.t)).toBe(100)
    expect(ledger.query('588000').sellableQty).toBe(100)
    const sell = ledger.trade('588000', { side: 'sell', qty: 200, price: 2.2 })
    expect(sell.ok).toBe(false)
    expect(sell.error).toContain('当日买入 100 份')
  })

  it('F1-A6 冻结后再传 init 仍被拒（顺序：保留值校验先于 T+1 计算）', () => {
    primeAllTodayBought()
    const res = ledger.trade('588000', { side: 'sell', qty: 200, price: 2.3, reason: 'init' })
    expect(res.ok).toBe(false)
    // 超卖 + 保留值同时成立时，返回的是保留值错误（在任何校验/读写之前）。
    expect(res.error).toContain('保留标记')
    expect(res.error).not.toMatch(/T\+1/)
  })
})

/* ================================================================== *
 * 第三部分：手工构造 trades.json —— 非首笔伪造 init
 * ================================================================== */

interface ForgeOpts {
  trades: Array<Record<string, unknown>>
  qty: number
  avgCost: number
  cash: number
}

function writeLedger(dataRoot: string, symbol: string, opts: ForgeOpts): void {
  const d = symbolDir(dataRoot, symbol)
  mkdirSync(d, { recursive: true })
  writeFileSync(
    join(d, 'symbols.json'),
    JSON.stringify({ symbol, name: '伪造标的', type: 'etf', initPrice: 2, settlement: 'T+1' }, null, 2),
    'utf8',
  )
  writeFileSync(
    join(d, 'positions.json'),
    JSON.stringify({ symbol, qty: opts.qty, avgCost: opts.avgCost }, null, 2),
    'utf8',
  )
  writeFileSync(
    join(d, 'accounts.json'),
    JSON.stringify({ symbol, cash: opts.cash, realizedPnl: 0, floatPnl: 0 }, null, 2),
    'utf8',
  )
  writeFileSync(join(d, 'trades.json'), JSON.stringify(opts.trades, null, 2), 'utf8')
}

describe('F1 复验 · 非首笔伪造 init（手工 trades.json）', () => {
  let dir: string
  let clock: Clock
  let ledger: Ledger

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'dsh-f1-forge-'))
    clock = new Clock(DAY1_1000)
    ledger = new Ledger(dir, clock.now)
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('F1-B1 中间位置 reason=init 的当日买入必须计入冻结量（不豁免）', () => {
    writeLedger(dir, '588000', {
      qty: 400,
      avgCost: 2.05,
      cash: 100000,
      trades: [
        // 首笔 init（唯一合法豁免）
        { id: 't0', symbol: '588000', side: 'buy', qty: 200, price: 2, ts: DAY1_1000, reason: 'init' },
        { id: 't1', symbol: '588000', side: 'buy', qty: 100, price: 2.1, ts: DAY1_1000, reason: '加仓' },
        // 伪造：非首笔带 init
        { id: 't2', symbol: '588000', side: 'buy', qty: 100, price: 2.2, ts: DAY1_1000, reason: 'init' },
      ],
    })

    expect(todayBuyQty(ledger.getTrades('588000'), clock.t), '非首笔 init 不得豁免').toBe(200)
    const q = ledger.query('588000')
    expect(q.qty).toBe(400)
    expect(q.sellableQty).toBe(200)

    const before = rawSnapshot(dir, '588000')
    const reject = ledger.trade('588000', { side: 'sell', qty: 300, price: 2.3 })
    expect(reject.ok).toBe(false)
    expect(reject.error).toContain('当日买入 200 份')
    expect(reject.error).toContain('当前可卖 200 份')
    expect(rawSnapshot(dir, '588000')).toEqual(before)

    const sell = ledger.trade('588000', { side: 'sell', qty: 200, price: 2.3 })
    expect(sell.ok, `仅存量部分应可卖：${sell.error ?? ''}`).toBe(true)
    expect(sell.newQty).toBe(200)
    expect(ledger.query('588000').sellableQty).toBe(0)

    expect(ledger.trade('588000', { side: 'sell', qty: 100, price: 2.4 }).ok).toBe(false)
  })

  it('F1-B2 伪造 init 不污染累计收益口径（cumReturnState 可用）', () => {
    writeLedger(dir, '588000', {
      qty: 400,
      avgCost: 2.05,
      cash: 100000,
      trades: [
        { id: 't0', symbol: '588000', side: 'buy', qty: 200, price: 2, ts: DAY1_1000, reason: 'init' },
        { id: 't1', symbol: '588000', side: 'buy', qty: 100, price: 2.1, ts: DAY1_1000, reason: '加仓' },
        { id: 't2', symbol: '588000', side: 'buy', qty: 100, price: 2.2, ts: DAY1_1000, reason: 'init' },
      ],
    })
    const st = ledger.cumReturnState('588000', 2.3)!
    expect(st).toBeDefined()
    expect(st.finalQty).toBe(400)
    expect(st.finalCash).toBe(100000)
    // initialCapital = cash + Σ买入 − Σ卖出（与 initCost 抵消，故伪造 init 不改变结果）。
    expect(st.initialCapital).toBe(100000 + 830)
  })
})

/* ================================================================== *
 * 第四部分：正常路径不回归
 * ================================================================== */

describe('F1 复验 · 正常路径回归', () => {
  let dir: string
  let clock: Clock
  let ledger: Ledger

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'dsh-f1-regress-'))
    clock = new Clock(DAY1_1000)
    ledger = new Ledger(dir, clock.now)
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('R1 不传 reason 的 T+1 拦截仍生效（文案三要素不变）', () => {
    ledger.init('588000', { type: 'etf', qty: 100, cost: 2, cash: 100000 })
    expect(ledger.trade('588000', { side: 'sell', qty: 100, price: 2 }).ok).toBe(true)
    expect(ledger.trade('588000', { side: 'buy', qty: 100, price: 2.1 }).ok).toBe(true)
    const res = ledger.trade('588000', { side: 'sell', qty: 100, price: 2.2 })
    expect(res.ok).toBe(false)
    expect(res.error).toBe('T+1 限制：当日买入 100 份不可卖出，当前可卖 0 份（持仓 100 份）')
  })

  it('R2 T+0 当日回转正常（不受保留值校验影响）', () => {
    ledger.init('511990', { type: 'etf', qty: 100, cost: 100, cash: 100000, settlement: 'T+0' })
    expect(ledger.trade('511990', { side: 'buy', qty: 100, price: 100, reason: '调仓' }).ok).toBe(true)
    expect(ledger.query('511990').sellableQty).toBe(200)
    const sell = ledger.trade('511990', { side: 'sell', qty: 200, price: 100, reason: '止盈' })
    expect(sell.ok, `T+0 应允许当日回转：${sell.error ?? ''}`).toBe(true)
    expect(sell.newQty).toBe(0)
  })

  it('R3 init 期初存量当日可卖（首笔 init 仍豁免）', () => {
    ledger.init('000001', { type: 'stock', qty: 500, cost: 10, cash: 100000 })
    expect(ledger.query('000001').sellableQty).toBe(500)
    expect(todayBuyQty(ledger.getTrades('000001'), clock.t)).toBe(0)
    const sell = ledger.trade('000001', { side: 'sell', qty: 500, price: 12 })
    expect(sell.ok, `期初存量应可卖：${sell.error ?? ''}`).toBe(true)
    expect(sell.realizedPnl).toBe(1000)
  })

  it('R4 普通 reason（调仓）买入仍被冻结', () => {
    ledger.init('588000', { type: 'etf', qty: 100, cost: 2, cash: 100000 })
    expect(ledger.trade('588000', { side: 'buy', qty: 200, price: 2.1, reason: '调仓' }).ok).toBe(true)
    expect(ledger.query('588000').sellableQty).toBe(100)
    const res = ledger.trade('588000', { side: 'sell', qty: 300, price: 2.2 })
    expect(res.ok).toBe(false)
    expect(res.error).toContain('当日买入 200 份')
  })

  it('R5 跨日解冻正常', () => {
    ledger.init('588000', { type: 'etf', qty: 100, cost: 2, cash: 100000 })
    expect(ledger.trade('588000', { side: 'buy', qty: 100, price: 2.1 }).ok).toBe(true)
    expect(ledger.query('588000').sellableQty).toBe(100)
    clock.set(DAY2_1000)
    expect(ledger.query('588000').sellableQty).toBe(200)
    const sell = ledger.trade('588000', { side: 'sell', qty: 200, price: 2.2 })
    expect(sell.ok, `跨日后应全部可卖：${sell.error ?? ''}`).toBe(true)
  })

  it('R6 同日多笔混合 reason，仅首笔 init 豁免', () => {
    ledger.init('588000', { type: 'etf', qty: 100, cost: 2, cash: 100000 })
    expect(ledger.trade('588000', { side: 'buy', qty: 100, price: 2.1, reason: '加仓' }).ok).toBe(true)
    expect(ledger.trade('588000', { side: 'buy', qty: 200, price: 2.2, reason: '调仓' }).ok).toBe(true)
    expect(todayBuyQty(ledger.getTrades('588000'), clock.t)).toBe(300)
    expect(ledger.query('588000').sellableQty).toBe(100)
    const res = ledger.trade('588000', { side: 'sell', qty: 400, price: 2.3 })
    expect(res.ok).toBe(false)
    expect(res.error).toContain('当日买入 300 份')
  })
})

/* ================================================================== *
 * 第五部分：工具层（真实 ToolRuntime registry）
 * ================================================================== */

interface RegistryResult {
  isError: boolean
  value?: unknown
  content: Array<{ type: string; text?: string }>
}

interface ToolBox {
  schemas: () => Array<{ name: string }>
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
    name: 'dsh-ia-tools-f1',
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
    callId: `f1-${seq}`,
    name,
    arguments: args,
    signal: new AbortController().signal,
  })
}

const textOf = (r: RegistryResult): string => r.content.map((c) => c.text ?? '').join('\n')
const valueOf = (r: RegistryResult): unknown => r.value

describe('F1 复验 · 工具层（ledger_trade reason=init）', () => {
  let dir: string
  let booted: Booted
  let tools: ToolBox
  let prevHome: string | undefined

  beforeEach(async () => {
    // 10:00 本地时间 → 处于连续竞价时段（正常路径需要放行时段闸门）。
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 9, 13, 10, 0, 0))
    dir = mkdtempSync(join(tmpdir(), 'dsh-f1-tools-'))
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

  async function initSymbol(symbol = '588000', settlement?: string): Promise<void> {
    const r = await call(tools, 'ledger_init', {
      symbol,
      type: 'etf',
      init_qty: 100,
      init_cost: 2,
      init_cash: 100000,
      ...(settlement ? { settlement } : {}),
    })
    expect(r.isError, textOf(r)).toBe(false)
  }

  it('F1-C1 交易时段：reason="init" → isError=true、文案可读、三表零写入', async () => {
    await initSymbol()
    // 清掉存量 → 当日买 100 → 可卖 0（与首轮 F1 复现路径一致）。
    const clear = await call(tools, 'ledger_trade', { symbol: '588000', side: 'sell', qty: 100, price: 2 })
    expect(clear.isError, textOf(clear)).toBe(false)
    const buy = await call(tools, 'ledger_trade', { symbol: '588000', side: 'buy', qty: 100, price: 2.1 })
    expect(buy.isError, textOf(buy)).toBe(false)

    const filesBefore = rawSnapshot(dir, '588000')
    const listBefore = listing(dir, '588000')
    const qBefore = valueOf(await call(tools, 'ledger_query', { symbol: '588000' }))

    const res = await call(tools, 'ledger_trade', {
      symbol: '588000',
      side: 'sell',
      qty: 100,
      price: 2.3,
      reason: 'init',
    })

    expect(res.isError, 'F1：工具层必须拒绝 reason=init').toBe(true)
    const msg = textOf(res)
    expect(msg).toContain('建仓保留标记')
    expect(msg).toContain('ledger_trade')
    expect(msg).toMatch(/请改用其他交易理由/)
    // 不能是交易时段错误。
    expect(msg).not.toContain('非连续竞价')

    expect(valueOf(await call(tools, 'ledger_query', { symbol: '588000' }))).toEqual(qBefore)
    expect(rawSnapshot(dir, '588000'), '工具层拒绝路径必须零写入').toEqual(filesBefore)
    expect(listing(dir, '588000')).toEqual(listBefore)
  })

  it('F1-C2 交易时段：买入侧 reason=" INIT " → isError、零写入', async () => {
    await initSymbol()
    const filesBefore = rawSnapshot(dir, '588000')
    const res = await call(tools, 'ledger_trade', {
      symbol: '588000',
      side: 'buy',
      qty: 100,
      price: 2.1,
      reason: ' INIT ',
    })
    expect(res.isError).toBe(true)
    expect(textOf(res)).toContain('建仓保留标记')
    expect(rawSnapshot(dir, '588000')).toEqual(filesBefore)
  })

  it('F1-C3 交易时段：全角 "ｉｎｉｔ" → 放行买入，但当日卖出仍被 T+1 拦截', async () => {
    await initSymbol()
    const buy = await call(tools, 'ledger_trade', {
      symbol: '588000',
      side: 'buy',
      qty: 100,
      price: 2.1,
      reason: 'ｉｎｉｔ',
    })
    expect(buy.isError, `非保留变体应放行：${textOf(buy)}`).toBe(false)

    const q = valueOf(await call(tools, 'ledger_query', { symbol: '588000' })) as Record<
      string,
      unknown
    >
    expect(q.qty).toBe(200)
    expect(q.sellable_qty).toBe(100) // 全角 init 买入被计入冻结

    const sell = await call(tools, 'ledger_trade', {
      symbol: '588000',
      side: 'sell',
      qty: 200,
      price: 2.3,
    })
    expect(sell.isError, '被冻结的 100 不可卖').toBe(true)
    expect(textOf(sell)).toMatch(/T\+1/)
    expect(textOf(sell)).toContain('当日买入 100 份')
  })

  it('F1-C4 非交易时段：初始化错误的优先级（保留值校验先于时段校验）', async () => {
    await initSymbol()
    vi.setSystemTime(new Date(2026, 9, 13, 20, 0, 0)) // 20:00 收盘后
    const filesBefore = rawSnapshot(dir, '588000')

    const withInit = await call(tools, 'ledger_trade', {
      symbol: '588000',
      side: 'sell',
      qty: 100,
      price: 2.3,
      reason: 'init',
    })
    expect(withInit.isError).toBe(true)
    const msgInit = textOf(withInit)
    expect(msgInit, '非交易时段也应先报保留值错误').toContain('建仓保留标记')
    expect(msgInit).not.toContain('非连续竞价')

    const withNormal = await call(tools, 'ledger_trade', {
      symbol: '588000',
      side: 'sell',
      qty: 100,
      price: 2.3,
      reason: '调仓',
    })
    expect(withNormal.isError).toBe(true)
    expect(textOf(withNormal), '普通理由应被时段闸门拦截').toContain('非连续竞价')

    // 两条路径均零写入。
    expect(rawSnapshot(dir, '588000')).toEqual(filesBefore)
  })

  it('F1-C5 工具层：缺省 reason 的 T+1 拦截仍生效（回归）', async () => {
    await initSymbol()
    expect(
      (await call(tools, 'ledger_trade', { symbol: '588000', side: 'sell', qty: 100, price: 2 }))
        .isError,
    ).toBe(false)
    expect(
      (await call(tools, 'ledger_trade', { symbol: '588000', side: 'buy', qty: 100, price: 2.1 }))
        .isError,
    ).toBe(false)
    const res = await call(tools, 'ledger_trade', { symbol: '588000', side: 'sell', qty: 100, price: 2.2 })
    expect(res.isError).toBe(true)
    expect(textOf(res)).toContain('T+1 限制：当日买入 100 份不可卖出，当前可卖 0 份（持仓 100 份）')
  })

  it('F1-C7 工具层：reason=null → 参数校验拒绝（INVALID_ARGS）；缺省 reason → 放行并冻结', async () => {
    await initSymbol()
    const filesBefore = rawSnapshot(dir, '588000')

    const withNull = await call(tools, 'ledger_trade', {
      symbol: '588000',
      side: 'buy',
      qty: 100,
      price: 2.1,
      reason: null,
    })
    expect(withNull.isError, 'null 不是合法 string，应由参数校验拒绝').toBe(true)
    const msgNull = textOf(withNull)
    expect(msgNull).toMatch(/must be a string|INVALID_ARGS|invalid arguments/i)
    expect(rawSnapshot(dir, '588000'), '参数校验拒绝必须零写入').toEqual(filesBefore)

    // 缺省 reason：放行，但计入当日买入并被冻结。
    const omitted = await call(tools, 'ledger_trade', { symbol: '588000', side: 'buy', qty: 100, price: 2.1 })
    expect(omitted.isError, textOf(omitted)).toBe(false)
    const q = valueOf(await call(tools, 'ledger_query', { symbol: '588000' })) as Record<
      string,
      unknown
    >
    expect(q.qty).toBe(200)
    expect(q.sellable_qty).toBe(100)
    const sell = await call(tools, 'ledger_trade', { symbol: '588000', side: 'sell', qty: 200, price: 2.2 })
    expect(sell.isError).toBe(true)
    expect(textOf(sell)).toContain('当日买入 100 份')
  })

  it('F1-C6 工具层：不存在的 symbol + reason="init" → 保留值错误优先（不泄露标的探测差异）', async () => {
    const res = await call(tools, 'ledger_trade', {
      symbol: '999999',
      side: 'buy',
      qty: 100,
      price: 1,
      reason: 'init',
    })
    expect(res.isError).toBe(true)
    expect(textOf(res)).toContain('建仓保留标记')
    expect(existsSync(symbolDir(dir, '999999'))).toBe(false)
  })
})
