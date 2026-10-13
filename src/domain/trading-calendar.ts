/**
 * domain/trading-calendar.ts —— 交易日历域（第 1 层：连续竞价时段硬闸门）。
 *
 * 职责：判定「当前时刻」是否处于 A 股连续竞价时段，供工具层在落账/下单前
 * 做硬约束校验（闸门属于工具层，domain 的 Ledger.trade 保持纯业务逻辑）。
 *
 * 判定口径（对齐详细设计 §14 / §5.5 / §4.1）：
 * - **true**：连续竞价时段 —— 上午 9:30–11:30、下午 13:00–15:00。
 * - **false**：其余一切时段 —— 含 9:00–9:30 盘前、9:15–9:25 集合竞价、
 *   11:30–13:00 午休、15:00 后。
 *
 * 边界语义（精确）：
 * - 9:30:00（含整点）~ 11:30:00（不含整点）→ true；
 * - 13:00:00（含整点）~ 15:00:00（不含整点）→ true。
 * 边界均对齐「整分」刻度（无秒级细分边界），故用 getHours/getMinutes
 * 折合为「当日累计分钟数」即可精确表达含/不含语义。
 *
 * 纯函数逻辑，不接触 dsh/cordis API、不接触 I/O（风格对齐 metrics.ts）。
 */

/**
 * 是否处于 A 股连续竞价时段（可下单）。
 *
 * @param date 待判定的时刻。
 * @returns 9:30–11:30 或 13:00–15:00（含下边界、不含上边界）返回 true，否则 false。
 */
export function isTradingTime(date: Date): boolean {
  // 当日累计分钟数（0–1439）。边界均在整分刻度上，分钟粒度即可精确表达。
  const minutes = date.getHours() * 60 + date.getMinutes()

  // 上午：9:30（含）~ 11:30（不含）
  const morning = minutes >= 9 * 60 + 30 && minutes < 11 * 60 + 30
  // 下午：13:00（含）~ 15:00（不含）
  const afternoon = minutes >= 13 * 60 && minutes < 15 * 60

  return morning || afternoon
}