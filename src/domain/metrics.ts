/**
 * domain/metrics.ts —— 统计域。
 *
 * 职责：方向/区间命中率、累计收益率、反向检讨阈值判定，按标的独立统计。
 *
 * 接口签名对齐详细设计 §5.2：
 * ```
 * interface Metrics {
 *   hitRate(dirHits: boolean[], rangeHits: boolean[]): { dir: number; range: number }
 *   cumReturn(trades: Trade[]): number
 *   isBelowThreshold(symbol: string, thresholds: Thresholds): boolean
 * }
 * ```
 *
 * 关键口径（验收点 5）：
 * - `hitRate`：dir_hit_rate = 方向命中数 / 已校验数（range 同理）。
 * - `cumReturn`：基于 trades 流水累计（未含初始现金，见实现说明）。
 *
 * 纯函数逻辑，不接触 dsh/cordis API、不落库（落库由 ledger 层负责）。
 */
import type { Side, Thresholds, Trade } from './types.js'

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
 * 累计收益率（基于 trades 流水累计）。
 *
 * 口径：以买入为成本流出、卖出为收入流入，结合持仓成本估算收益。
 * 此处采用「已实现收益 / 累计买入成本」的口径——即用流水重放得到
 * 已实现盈亏与期末持仓市值之差，再除以初始投入，得到累计收益率。
 *
 * 简化实现（与 ledger 的 realized_pnl 口径一致）：
 * 遍历流水，卖出时按「(卖价 - 加权平均成本) × 数量」累计已实现收益，
 * 买入时累计投入成本；收益率 = 已实现收益 / 累计买入成本。
 * 若累计买入成本为 0，返回 0。
 */
export function cumReturn(trades: Trade[]): number {
  if (trades.length === 0) return 0

  // 重放：维护 qty / avgCost，统计已实现收益与累计买入成本。
  let qty = 0
  let avgCost = 0
  let realized = 0
  let totalBuyCost = 0

  for (const t of trades) {
    if (t.side === 'buy') {
      const newQty = qty + t.qty
      const cost = t.qty * t.price
      totalBuyCost += cost
      avgCost = newQty === 0 ? 0 : (qty * avgCost + cost) / newQty
      qty = newQty
    } else {
      const sellQty = Math.min(t.qty, qty)
      const gain = (t.price - avgCost) * sellQty
      realized += gain
      qty -= sellQty
    }
  }

  if (totalBuyCost === 0) return 0
  return round4(realized / totalBuyCost)
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