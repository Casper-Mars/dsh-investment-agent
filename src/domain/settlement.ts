/**
 * domain/settlement.ts —— 结算规则（T+1 / T+0）纯函数。
 *
 * 职责：判断「当日买入量」与「当前可卖数量」，供 `Ledger.trade` 在写库前拦截
 * 违反 A 股 T+1 的卖出指令。
 *
 * 硬约束：
 * - **纯逻辑**，不碰 I/O、不碰 dsh/cordis API（风格对齐 `trading-calendar.ts`）；
 * - 时区**显式**取 `Asia/Shanghai`，不依赖宿主进程 TZ；
 * - 以「当日累计买入量」判定，而不是「最近一笔买入」——卖出不会重置当日买入量，
 *   反复买卖无法绕过；`reason === 'init'` 的建仓流水不计入当日买入（期初存量可卖）。
 * - `init` 是**系统保留标记**：仅 `Ledger.init()` 直写流水时使用，且只认首笔流水
 *   （建仓流水天然是该 symbol 的第一笔）。交易接口传入该值一律拒绝，见
 *   {@link isReservedTradeReason}——否则调用方可伪造 `init` 绕过 T+1 冻结。
 * - 跨日自动清零：只比较自然日键，不持久化任何「冻结数量」，避免第二份真相。
 *
 * 为什么用自然日而不是交易日历：T+1 只限制「买入当日卖出」。只要不是同一天，
 * 之后的任何可交易日卖出都合法；节假日期间本无成交，工具层 `isTradingTime`
 * 已拦截下单时段。
 */
import type { SettlementRule, Trade } from './types.js'
import { DEFAULT_SETTLEMENT } from './types.js'

/**
 * `Asia/Shanghai` 日期格式化器。
 *
 * 使用 `formatToParts` 逐段组装 `YYYY-MM-DD`，避免宿主 TZ 与 locale 影响
 * （不使用 `toISOString()` —— 它按 UTC 截断，会把 23:59 CST 算成前一天）。
 */
/** 建仓流水保留标记：仅 `Ledger.init()` 内部直写，禁止经交易接口传入。 */
export const INIT_TRADE_REASON = 'init'

/**
 * 判断 `reason` 是否为系统保留值（外部不可用）。
 *
 * 归一化后再比较（去首尾空白 + 小写），避免 `' INIT '` 之类的变体在未来被
 * 某处按字符串判等误判为特权流水。
 *
 * @param reason 调用方传入的交易理由（自由文本）。
 */
export function isReservedTradeReason(reason: string | undefined): boolean {
  if (typeof reason !== 'string') return false
  return reason.trim().toLowerCase() === INIT_TRADE_REASON
}

const SHANGHAI_DAY_FORMATTER = new Intl.DateTimeFormat('en-US', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
})

/**
 * 以 `Asia/Shanghai` 为准的交易日键：`YYYY-MM-DD`。
 *
 * @param ts 毫秒时间戳。
 */
export function tradingDayKey(ts: number): string {
  const parts = SHANGHAI_DAY_FORMATTER.formatToParts(new Date(ts))
  let year = ''
  let month = ''
  let day = ''
  for (const part of parts) {
    if (part.type === 'year') year = part.value
    else if (part.type === 'month') month = part.value
    else if (part.type === 'day') day = part.value
  }
  return `${year}-${month}-${day}`
}

/**
 * 统计「与 `now` 同一自然日」的买入数量。
 *
 * 条件：`side === 'buy'`、不是「建仓流水」且 `tradingDayKey(t.ts) === tradingDayKey(now)`。
 *
 * 「建仓流水」的判定收紧为**首笔流水 + `reason === 'init'`**：`init()` 总是该 symbol
 * 的第一笔流水，因此这一等价条件不影响既有数据；而伪造在后续位置的 `init` 流水
 * 不会获得豁免（仍计入当日买入，偏保守）。
 *
 * @param trades 该标的的全部流水（按写入顺序）。
 * @param now 判定基准时刻（毫秒时间戳）。
 */
export function todayBuyQty(trades: readonly Trade[], now: number): number {
  const todayKey = tradingDayKey(now)
  let sum = 0
  for (let i = 0; i < trades.length; i += 1) {
    const t = trades[i]!
    if (t.side !== 'buy') continue
    if (i === 0 && t.reason === INIT_TRADE_REASON) continue
    if (tradingDayKey(t.ts) !== todayKey) continue
    sum += t.qty
  }
  return sum
}

/** `computeSellableQty` 入参。 */
export interface SellableParams {
  /** 结算规则（缺省按 T+1）。 */
  rule?: SettlementRule
  /** 当前持仓数量。 */
  positionQty: number
  /** 该标的的全部流水。 */
  trades: readonly Trade[]
  /** 判定基准时刻（毫秒时间戳）。 */
  now: number
}

/**
 * 计算当前可卖数量。
 *
 * - `T+0`：当前持仓全部可卖；
 * - `T+1`：`max(0, positionQty − todayBuyQty)`（当日买入部分当日不可卖）。
 *
 * @returns 非负整数（理论上恒为 `LOT_SIZE` 的整数倍）。
 */
export function computeSellableQty(params: SellableParams): number {
  const rule = params.rule ?? DEFAULT_SETTLEMENT
  if (rule === 'T+0') return params.positionQty
  const frozen = todayBuyQty(params.trades, params.now)
  return Math.max(0, params.positionQty - frozen)
}
