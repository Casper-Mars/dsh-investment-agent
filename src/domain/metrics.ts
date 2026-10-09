/**
 * domain/metrics.ts —— 统计域。
 *
 * 职责：方向/区间命中率、累计收益率、反向检讨阈值判定，按标的独立统计。
 *
 * 接口签名对齐详细设计 §5.2：
 * ```
 * interface Metrics {
 *   hitRate(dirHits: boolean[], rangeHits: boolean[]): { dir: number; range: number }
 *   isBelowThreshold(symbol: string, thresholds: Thresholds): boolean
 * }
 * ```
 *
 * 关键口径（验收点 5）：
 * - `hitRate`：dir_hit_rate = 方向命中数 / 已校验数（range 同理）。
 * - `cumReturnOnCapital`：唯一累计收益口径（验收口径 t100357 AC2），
 *   `(期末市值 + 累计 realized - 期初资金) / 期初资金`。
 *
 * 纯函数逻辑，不接触 dsh/cordis API、不落库（落库由 ledger 层负责）。
 */
import type { Side, Thresholds, Trade } from './types.js'

/**
 * 累计收益率计算所需的状态快照（验收口径 t100357 AC2）。
 *
 * 口径：`cum_return = (期末市值 + 累计 realized - 期初资金) / 期初资金`。
 */
export interface CumReturnState {
  /** 期末持仓数量（当前持仓 qty）。 */
  finalQty: number
  /** 期末现价（当前价格）。 */
  finalPrice: number
  /** 已实现盈亏（累计 realized）。 */
  realizedPnl: number
  /** 期初资金 = 初始 cash + 初始持仓成本。 */
  initialCapital: number
}

/**
 * 累计收益率（唯一累计收益口径，验收口径 t100357 AC2）。
 *
 * 公式：`(期末市值 + 累计 realized - 期初资金) / 期初资金`。
 *   期末市值 = finalQty × finalPrice；
 *   累计 realized = realizedPnl；
 *   期初资金 = initialCapital。
 * 期初资金为 0 或非法即返回 0（防除零）。
 */
export function cumReturnOnCapital(state: CumReturnState): number {
  const ic = state.initialCapital
  if (!Number.isFinite(ic) || ic === 0) return 0
  const marketValue = state.finalQty * state.finalPrice
  return round4((marketValue + state.realizedPnl - ic) / ic)
}

/**
 * 命中率。
 * 「已校验数」= 传入数组中参与校验的元素个数（本实现按数组长度计）。
 * 空数组防除零：返回 0。
 */
export function hitRate(
  dirHits: boolean[],
  rangeHits: boolean[],
): { dir: number; range: number } {
  const dirRate = dirHits.length === 0 ? 0 : countTrue(dirHits) / dirHits.length
  const rangeRate =
    rangeHits.length === 0 ? 0 : countTrue(rangeHits) / rangeHits.length
  return { dir: round4(dirRate), range: round4(rangeRate) }
}

function countTrue(arr: boolean[]): number {
  let n = 0
  for (const v of arr) if (v) n += 1
  return n
}

/**
 * 阈值判定：是否存在「劣于阈值」的情形。
 *
 * 说明：接口签名（§5.2）固定为 `isBelowThreshold(symbol, thresholds)`，
 * 仅接收阈值配置；实际「当前指标 vs 阈值」的比较在调用方（tools/review）
 * 侧完成。此处提供一个守卫实现：阈值配置本身非法（下限为负）即返回 true，
 * 表示该标的的阈值配置「劣于」合理区间，需触发反向检讨。
 * symbol 作为上下文保留（阈值按标的独立，未来可扩展按标的差异化处理）。
 */
export function isBelowThreshold(
  symbol: string,
  thresholds: Thresholds,
): boolean {
  // 阈值按标的独立；此处 symbol 作为上下文保留（未来可扩展按标的差异化读取）。
  void symbol
  return (
    thresholds.dirHitMin < 0 ||
    thresholds.cumReturnMin < 0 ||
    thresholds.missStreakMax < 0
  )
}

/** 四舍五入到 4 位小数。 */
function round4(value: number): number {
  return Math.round((value + Number.EPSILON) * 10000) / 10000
}

export type { Side, Thresholds, Trade }
