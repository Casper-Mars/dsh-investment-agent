/**
 * domain/ledger.ts —— 台账域。
 *
 * 职责：持仓成本重算（加权平均）、盈亏累计、逐笔流水落库，按 `symbol` 隔离。
 * `type` 仅作元数据与交易单位提示（份/股），不改变台账数值逻辑。
 *
 * 接口签名对齐详细设计 §5.1：
 * ```
 * interface Ledger {
 *   init(symbol, init: { type; name?; qty; cost; cash }): void
 *   list(): SymbolSnapshot[]
 *   query(symbol): PositionSnapshot
 *   trade(symbol, t: { side; qty; price; reason? }): TradeResult
 * }
 * ```
 *
 * 关键规则（验收点）：
 * - 买入加权平均成本：avg_cost=(旧qty×旧avg+本次qty×price)/(旧qty+本次qty)，保留 4 位小数。
 * - 卖出不改 avg_cost，只减 qty 并结算 realized_pnl。
 * - 卖出 qty 超过当前持仓时报错，不落账。
 * - 卖出需满足结算规则（默认 T+1）：当日买入的数量当日不可卖，违规不落账。
 * - `reason='init'` 为建仓保留标记（仅 init() 直写），交易接口传入将被拒绝且零写入。
 * - 写入前校验 qty 必须为 100 整数倍（份/股均适用）。
 * - init 重复 symbol 报错；query 返回完整快照（含 cash/realized/float/settlement/sellableQty）。
 *
 * 纯函数逻辑 + 本地 JSON 存储（JsonStore），不接触 dsh/cordis API。
 */
import { COST_PRECISION, DEFAULT_SETTLEMENT, LOT_SIZE } from './types.js'
import type {
  AssetType,
  PositionSnapshot,
  SettlementRule,
  SymbolSnapshot,
  Side,
  Trade,
  TradeResult,
} from './types.js'
import type { CumReturnState } from './metrics.js'
import { computeSellableQty, INIT_TRADE_REASON, isReservedTradeReason, todayBuyQty } from './settlement.js'
import { JsonStore, LedgerStore, newTradeId } from './store.js'

/** 初始化入参。 */
export interface LedgerInit {
  type: AssetType
  name?: string
  qty: number
  cost: number
  cash: number
  /** 结算规则，缺省 `T+1`（股票 ETF 保守默认；T+0 品种显式声明）。 */
  settlement?: SettlementRule
}

/** 交易入参。 */
export interface LedgerTrade {
  side: Side
  qty: number
  price: number
  reason?: string
}

/** 将一个数值四舍五入到指定小数位（成本精度）。 */
function round(value: number, precision: number = COST_PRECISION): number {
  const factor = 10 ** precision
  return Math.round((value + Number.EPSILON) * factor) / factor
}

/** 校验 qty 是否为 100 的整数倍。 */
function isLotMultiple(qty: number): boolean {
  return Number.isInteger(qty) && qty > 0 && qty % LOT_SIZE === 0
}

/** 将数量单位转为可读文案：ETF 用「份」，股票用「股」。 */
function qtyUnit(type: AssetType): string {
  return type === 'etf' ? '份' : '股'
}

/**
 * 台账实现。所有读写经 `LedgerStore`（按 symbol 隔离的 JSON 存储）。
 *
 * @param dataRoot 数据根目录。
 * @param now 时钟注入（默认 `Date.now`）；`init` / `trade` 的流水时间戳与
 *   T+1 判定基准日统一取自该时钟，便于测试推进时间跨日。
 */
export class Ledger {
  private readonly store: LedgerStore

  constructor(
    dataRoot: string,
    private readonly now: () => number = Date.now,
  ) {
    this.store = new LedgerStore(new JsonStore(dataRoot))
  }

  /** 新增标的 + 初始持仓/成本/资金；symbol 重复则报错。 */
  init(symbol: string, init: LedgerInit): void {
    if (!symbol || symbol.trim() === '') {
      throw new Error(`[ledger] symbol 为空`)
    }
    if (this.store.getSymbol(symbol)) {
      throw new Error(`[ledger] 标的 ${symbol} 已存在，禁止重复初始化`)
    }
    // 初始 qty 也须为 100 整数倍（份/股）。
    if (!isLotMultiple(init.qty)) {
      throw new Error(
        `[ledger] 初始数量 ${init.qty} 非 100 整数倍`,
      )
    }

    const now = this.now()
    this.store.saveSymbol({
      symbol,
      name: init.name,
      type: init.type,
      initPrice: init.cost,
      settlement: init.settlement ?? DEFAULT_SETTLEMENT,
    })
    this.store.savePosition({
      symbol,
      qty: init.qty,
      avgCost: round(init.cost),
    })
    this.store.saveAccount({
      symbol,
      cash: init.cash,
      realizedPnl: 0,
      floatPnl: 0,
    })

    // 初始建仓亦记一条流水（side='buy'，price=init.cost），便于累计收益口径（cum_return）核算。
    this.store.appendTrade(symbol, {
      id: newTradeId(),
      symbol,
      side: 'buy',
      qty: init.qty,
      price: init.cost,
      ts: now,
      reason: INIT_TRADE_REASON,
    })
  }

  /** 标的清单 + 快照（含 type）。 */
  list(): SymbolSnapshot[] {
    return this.store.listSymbols().map((symbol) => {
      const snap = this.query(symbol)
      return {
        symbol: snap.symbol,
        type: snap.type,
        name: snap.name,
        qty: snap.qty,
        avgCost: snap.avgCost,
        settlement: snap.settlement,
      }
    })
  }

  /**
   * 完整快照（含 cash/realized/float）。
   *
   * 浮动盈亏为**即时计算**：显式传入现价 `price` 时按
   * `float_pnl = (price − avg_cost) × qty` 计算并保留 4 位小数；
   * 未传入（undefined）时按「未提供现价、无法计算」记为 0。
   * 该值不写入 accounts 持久化（init/buy/sell 仍写占位 0）。
   */
  query(symbol: string, price?: number): PositionSnapshot {
    const sym = this.store.getSymbol(symbol)
    if (!sym) {
      throw new Error(`[ledger] 标的 ${symbol} 不存在`)
    }
    const pos = this.store.getPosition(symbol)
    const acc = this.store.getAccount(symbol)
    const qty = pos?.qty ?? 0
    const avgCost = pos?.avgCost ?? 0
    const settlement = sym.settlement ?? DEFAULT_SETTLEMENT
    const now = this.now()
    // 可卖量：按当前时刻与标的结算规则即时计算（T+0 = 全部持仓）。
    const sellableQty = computeSellableQty({
      rule: settlement,
      positionQty: qty,
      trades: this.store.getTrades(symbol),
      now,
    })
    // float_pnl=(现价−平均成本)×持仓数量，保留 4 位小数；未传现价则无法计算，记 0。
    const floatPnl = typeof price === 'number' ? round((price - avgCost) * qty, 4) : 0
    return {
      symbol,
      type: sym.type,
      name: sym.name,
      qty,
      avgCost,
      cash: acc?.cash ?? 0,
      realizedPnl: acc?.realizedPnl ?? 0,
      settlement,
      sellableQty,
      floatPnl,
    }
  }

  /** 某标的的全部交易流水（供 review_metrics 计算累计收益率）。 */
  getTrades(symbol: string): Trade[] {
    return this.store.getTrades(symbol)
  }

  /**
   * 计算累计收益率所需的状态快照（验收口径 t100357 AC2）。
   *
   * - finalQty：当前持仓数量（positions.qty）；
   * - finalCash：期末现金（accounts.cash，已含期间买卖回笼/支出与已实现盈亏）；
   * - initialCapital：期初资金 = 初始 cash + 初始持仓成本。
   *   初始 cash 未单独落库，故由「当前 cash + Σ买入 − Σ卖出」反推；
   *   初始持仓成本取 init 流水（reason='init'）的 qty×price。
   * - finalPrice：由调用方注入（现价）。
   *
   * 标的不存在/无流水时返回 undefined（调用方降级为 cum_return=0）。
   */
  cumReturnState(symbol: string, finalPrice: number): CumReturnState | undefined {
    const sym = this.store.getSymbol(symbol)
    if (!sym) return undefined
    const pos = this.store.getPosition(symbol)
    const acc = this.store.getAccount(symbol)
    const trades = this.store.getTrades(symbol)

    const finalQty = pos?.qty ?? 0
    const cash = acc?.cash ?? 0

    // 初始持仓成本：init 建仓流水（reason='init'）的 qty×price；无 init 流水则为 0。
    // 只认首笔流水：init 天然是建仓时的第一笔，收紧判定可防伪造 init 流水影响口径。
    const first = trades[0]
    const initTrade = first && first.reason === INIT_TRADE_REASON ? first : undefined
    const initCost = initTrade ? initTrade.qty * initTrade.price : 0

    // 反推初始 cash：
    //   init 时 accounts.cash 直接置为 init_cash，未扣减建仓成本（init 流水为账面
    //   流水而非现金流出），故初始 cash = 当前 cash + Σ其他买入 − Σ卖出。
    //   其中 Σ其他买入 = Σ买入 − init 成本。
    let totalBuy = 0
    let totalSell = 0
    for (const t of trades) {
      if (t.side === 'buy') totalBuy += t.qty * t.price
      else totalSell += t.qty * t.price
    }
    const otherBuy = totalBuy - initCost
    const initialCash = cash + otherBuy - totalSell
    // 期初资金 = 初始 cash + 初始持仓成本。
    const initialCapital = initialCash + initCost

    return { finalQty, finalPrice, finalCash: cash, initialCapital }
  }

  /** 模拟成交：写流水，重算持仓成本 / 结算盈亏。 */
  trade(symbol: string, t: LedgerTrade): TradeResult {
    // `init` 是系统保留标记（仅 init() 直写建仓流水使用）。必须在任何读写落盘前拒绝：
    // 否则调用方传 reason='init' 即可让当日买入不被计入冻结量，完全绕过 T+1。
    if (isReservedTradeReason(t.reason)) {
      return {
        ok: false,
        error:
          `reason「${INIT_TRADE_REASON}」为建仓保留标记，不可由交易接口传入；` +
          `请改用其他交易理由`,
      }
    }

    const now = this.now()
    const sym = this.store.getSymbol(symbol)
    if (!sym) {
      return { ok: false, error: `标的 ${symbol} 不存在` }
    }
    if (!isLotMultiple(t.qty)) {
      return {
        ok: false,
        error: `交易数量 ${t.qty} 非 100 整数倍（份/股）`,
      }
    }

    const pos = this.store.getPosition(symbol)
    const acc = this.store.getAccount(symbol)
    const curQty = pos?.qty ?? 0
    const avgCost = pos?.avgCost ?? 0
    const cash = acc?.cash ?? 0
    const realizedPnl = acc?.realizedPnl ?? 0

    if (t.side === 'buy') {
      // 加权平均成本，保留 4 位小数。
      const newQty = curQty + t.qty
      const newAvg =
        newQty === 0
          ? 0
          : round((curQty * avgCost + t.qty * t.price) / newQty)
      const newCash = cash - t.qty * t.price

      this.store.savePosition({ symbol, qty: newQty, avgCost: newAvg })
      this.store.saveAccount({
        symbol,
        cash: newCash,
        realizedPnl,
        floatPnl: 0,
      })

      const tradeId = newTradeId()
      this.store.appendTrade(symbol, {
        id: tradeId,
        symbol,
        side: 'buy',
        qty: t.qty,
        price: t.price,
        ts: now,
        reason: t.reason,
      })

      return {
        ok: true,
        tradeId,
        newQty,
        avgCost: newAvg,
        realizedPnl,
      }
    }

    // sell：校验不超卖。
    if (t.qty > curQty) {
      return {
        ok: false,
        error: `卖出数量 ${t.qty} 超过当前持仓 ${curQty}`,
      }
    }

    // sell：结算规则校验（默认 T+1）。
    // 校验必须发生在任何写入之前：拒绝路径零写入（不写 trades，不改 qty/cash/realizedPnl）。
    const settlement = sym.settlement ?? DEFAULT_SETTLEMENT
    if (settlement === 'T+1') {
      const trades = this.store.getTrades(symbol)
      const sellableQty = computeSellableQty({
        rule: settlement,
        positionQty: curQty,
        trades,
        now,
      })
      if (t.qty > sellableQty) {
        const unit = qtyUnit(sym.type)
        const frozen = todayBuyQty(trades, now)
        return {
          ok: false,
          error:
            `T+1 限制：当日买入 ${frozen} ${unit}不可卖出，` +
            `当前可卖 ${sellableQty} ${unit}（持仓 ${curQty} ${unit}）`,
        }
      }
    }

    // 卖出不改 avg_cost，只减 qty 并结算 realized_pnl。
    const newQty = curQty - t.qty
    const realized = round((t.price - avgCost) * t.qty)
    const newRealized = round(realizedPnl + realized)
    const newCash = cash + t.qty * t.price

    this.store.savePosition({ symbol, qty: newQty, avgCost })
    this.store.saveAccount({
      symbol,
      cash: newCash,
      realizedPnl: newRealized,
      floatPnl: 0,
    })

    const tradeId = newTradeId()
    this.store.appendTrade(symbol, {
      id: tradeId,
      symbol,
      side: 'sell',
      qty: t.qty,
      price: t.price,
      ts: now,
      reason: t.reason,
    })

    return {
      ok: true,
      tradeId,
      newQty,
      avgCost,
      realizedPnl: newRealized,
    }
  }
}

// Re-export types used by downstream tools.
export type {
  AssetType,
  PositionSnapshot,
  SettlementRule,
  SymbolSnapshot,
  Side,
  Trade,
  TradeResult,
}