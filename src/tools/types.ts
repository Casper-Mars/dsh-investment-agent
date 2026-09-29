/**
 * Agent 工具层：实体类型定义（镜像 output.schema 的蛇形字段）。
 *
 * 这些类型只用于工具层的返回形状标注（render 函数入参、映射产物），
 * 不 import domain 类型——domain 返回驼峰，工具层在 `execute` 内做蛇形映射，
 * 此处声明蛇形实体供 render / 类型推断统一引用（详见各工具组文件注释）。
 */

/** 标的类型。 */
export type AssetType = 'etf' | 'stock'

/** 交易方向。 */
export type Side = 'buy' | 'sell'

/** 标的信息对象（symbols 表 + 持仓快照）。 */
export interface LedgerSymbol {
  symbol: string
  type: AssetType
  name: string | null
  qty: number
  avg_cost: number
}

/** 完整持仓快照（ledger_query / ledger_list 复用）。 */
export interface LedgerPosition {
  symbol: string
  type: AssetType
  name: string | null
  qty: number
  avg_cost: number
  cash: number
  realized_pnl: number
  float_pnl: number
}

/** ledger_list 返回。 */
export interface LedgerListResult {
  symbols: LedgerSymbol[]
}

/** 预判方向。 */
export type PredictDir = 'up' | 'down' | 'flat'

/** 预判原文（predict_get 返回的 prediction）。 */
export interface PredictionView {
  dir: PredictDir
  range_low: number
  range_high: number
  confidence: number
  watch_points: string[]
}

/** 预判命中结果（predict_verify）。 */
export interface PredictVerifyResult {
  hit_dir: boolean
  hit_range: boolean
  deviation: number
}

/** 预判回读结果（predict_get）。 */
export interface PredictGetResult {
  prediction: PredictionView | null
}

/** 复盘校验结果（review_check）。 */
export interface ReviewCheckResult {
  decision_triggered: boolean
  decision_executed: boolean
  notes: string
}

/** 复盘回读项（review_get）。 */
export interface ReviewReportItem {
  date: string
  report: string
  summary: string
}

/** 复盘回读结果（review_get）。 */
export interface ReviewGetResult {
  reports: ReviewReportItem[]
}

/** 逐日统计项（review_metrics.history 元素）。 */
export interface MetricSnapshotView {
  symbol: string
  date: string
  dir_hit_rate: number
  range_hit_rate: number
  cum_return: number
}

/** 累计统计结果（review_metrics）。 */
export interface ReviewMetricsResult {
  dir_hit_rate: number
  range_hit_rate: number
  cum_return: number
  history: MetricSnapshotView[]
}

/** 根因定位结果（review_retrospect）。 */
export interface ReviewRetrospectResult {
  root_cause: string
  improvements: string[]
}

/** 感知版本变更类型。 */
export type ChangeType = 'keep' | 'patch' | 'replace'

/** 版本链元素（sense_archive_list）。 */
export interface SenseVersionMetaView {
  version: string
  change_type: ChangeType
  ts: string
  rationale_extract: string
}

/** 版本链结果（sense_archive_list）。 */
export interface SenseArchiveListResult {
  versions: SenseVersionMetaView[]
}

/** 某一版全文 meta（sense_archive_get）。 */
export interface SenseVersionFullMetaView {
  version: string
  change_type: ChangeType
  parent: string | null
  trigger: string | null
  ts: string
}

/** 某一版全文（sense_archive_get）。 */
export interface SenseVersionFullView {
  rationale: string
  code: string
  meta: SenseVersionFullMetaView
}