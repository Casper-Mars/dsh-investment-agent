/**
 * domain 层共享类型定义。
 *
 * 本文件仅承载纯类型与常量，不依赖任何 dsh/cordis API，也不接触 I/O。
 * 供 `ledger` / `metrics` / `sense-registry` 三域以及后续 `tools`
 * 复用。所有数据结构以 `symbol` 为维度隔离（感知版本注册表除外）。
 */

/** 标的类型：ETF（份） / 股票（股）。仅作元数据与交易单位提示，不改变台账数值逻辑。 */
export type AssetType = 'etf' | 'stock'

/** 交易方向。 */
export type Side = 'buy' | 'sell'

/**
 * 交易单位约束：ETF 与 A 股均按「手」交易，最小单位为 100 整数倍。
 * 详细设计 §5.1 明确「qty 单位为份(etf)/股(stock)，均为 100 整数倍」。
 */
export const LOT_SIZE = 100

/**
 * 台账数值的保留精度（加权平均成本等）。
 * 验收点 1 要求 avg_cost 保留 4 位小数。
 */
export const COST_PRECISION = 4

/** 标的快照：标的清单 + 基础持仓快照（含 type）。 */
export interface SymbolSnapshot {
  symbol: string
  type: AssetType
  name?: string
  qty: number
  avgCost: number
}

/** 完整持仓快照：含 cash / realized_pnl / float_pnl。 */
export interface PositionSnapshot {
  symbol: string
  type: AssetType
  name?: string
  qty: number
  avgCost: number
  cash: number
  realizedPnl: number
  floatPnl: number
}

/** 单笔交易流水。 */
export interface Trade {
  id: string
  symbol: string
  side: Side
  qty: number
  price: number
  ts: number
  reason?: string
}

/** 交易结果。 */
export interface TradeResult {
  ok: boolean
  tradeId?: string
  newQty?: number
  avgCost?: number
  realizedPnl?: number
  error?: string
}

/** 阈值配置（按标的独立）。 */
export interface Thresholds {
  /** 方向命中率下限（0-1）。 */
  dirHitMin: number
  /** 累计收益率下限。 */
  cumReturnMin: number
  /** 连续未命中次数上限。 */
  missStreakMax: number
}

/** 感知版本变更类型。 */
export type ChangeType = 'keep' | 'patch' | 'replace'

/** 感知版本提交输入。 */
export interface SenseVersionInput {
  changeType: ChangeType
  /** 推理理由（写入 rationale.md）。 */
  rationale: string
  /** 感知脚本本体（写入 sensor.ts）。 */
  code: string
  /** patch/replace 时的父版本号。 */
  parent?: string
  /** 触发本次调整的前因。 */
  trigger?: string
  /** 生成者。 */
  by?: string
}

/** 感知版本元数据（meta.json 去序列化形态）。 */
export interface SenseVersionMeta {
  version: string
  changeType: ChangeType
  parent?: string
  trigger?: string
  rationale?: string
  ts: string
  by?: string
}

/** 感知版本全文（含推理理由 + 脚本本体 + 元数据）。 */
export interface SenseVersionFull {
  meta: SenseVersionMeta
  rationale: string
  code: string
}

// ---------------------------------------------------------------------------
// 策略域（per-symbol 策略文档 + 版本链）类型，对应详细设计 §10.4 / §10.6。
// 策略是 per-symbol 的文本实体（Markdown），首版即启用版本链，每版带 rationale。
// ---------------------------------------------------------------------------

/** 策略版本提交输入（对应 strategy_set 工具参数，§10.8）。 */
export interface StrategyVersionInput {
  /** 策略文档正文（Markdown）。 */
  text: string
  /** 本次版本的理由（agent 为什么这么写 / 为什么改）。 */
  rationale: string
  /** 上一版版本号；非首版必填，首版省略。 */
  parentVersion?: string
  /** 生成者。 */
  by?: string
}

/** 策略版本元数据（meta.json 去序列化形态）。 */
export interface StrategyVersionMeta {
  version: string
  rationale: string
  ts: string
  parent?: string
  by?: string
}

/** 策略全文（含正文 + 版本元数据）。 */
export interface StrategyFull {
  symbol: string
  text: string
  version: string
  meta: StrategyVersionMeta
}

// ---------------------------------------------------------------------------
// predicts 域（预判）与 reviews 域（复盘）类型。
// 对应详细设计 §7.1 的 predictions / reviews / metrics 三张表。
// ---------------------------------------------------------------------------

/** 预判方向。 */
export type PredictDir = 'up' | 'down' | 'flat'

/**
 * 预判记录（predictions 表，§7.1）。
 * 字段：symbol, date, dir, range, confidence, watch_points。
 *
 * `range`（预判区间）在 §7.1 以标量 `range` 出现，但工具契约（§4.2）拆为
 * `range_low` / `range_high`（下沿/上沿）。实现上以 `rangeLow` / `rangeHigh`
 * 两个显式字段落库，同时保留 `range` 作为冗余视图（兼容 §7.1 标量口径）——
 * 二者等价：`range = [rangeLow, rangeHigh]`。
 */
export interface PredictionRecord {
  id: string
  symbol: string
  /** 预判对应的交易日，`YYYY-MM-DD`。 */
  date: string
  /** 方向：up（看涨）/ down（看跌）/ flat（震荡）。 */
  dir: PredictDir
  /** 区间下沿（预测最低价，隐含阈值）。 */
  rangeLow: number
  /** 区间上沿（预测最高价，隐含阈值）。 */
  rangeHigh: number
  /** 置信度（0-1）。 */
  confidence: number
  /** 观察点（触发关注的事件/点位，`YYYY-MM-DD` 或点位描述）。 */
  watchPoints: string[]
  /** 创建时间（毫秒时间戳）。 */
  ts: number
}

/** 预测区间（冗余视图，兼容 §7.1 标量 `range`）。 */
export interface PredictRange {
  low: number
  high: number
}

/**
 * 预判命中校验的「实际走势快照」，由调用方注入（domain 层不依赖 lib/quotes）。
 * 这是 predicts/reviews 与行情解耦的关键注入点。
 */
export interface ActualitySnapshot {
  /** 实际收盘价。 */
  close: number
  /** 实际最高价。 */
  high: number
  /** 实际最低价。 */
  low: number
  /** 前一交易日收盘价（用于方向判定基线）。 */
  prevClose: number
}

/** 预判命中结果（predict_verify 返回，§4.2）。 */
export interface HitResult {
  /** 方向是否命中。 */
  hitDir: boolean
  /** 区间是否命中。 */
  hitRange: boolean
  /** 偏差：close 相对预测区间中点的偏离（区间命中时为 0；否则为越界距离）。 */
  deviation: number
}

/**
 * 复盘记录（reviews 表，§7.1）。
 * 字段：symbol, date, hit_dir, hit_range, decision_triggered, decision_executed。
 */
export interface ReviewRecord {
  id: string
  symbol: string
  /** 复盘对应的交易日，`YYYY-MM-DD`。 */
  date: string
  /** 方向命中。 */
  hitDir: boolean
  /** 区间命中。 */
  hitRange: boolean
  /** 决策是否触发。 */
  decisionTriggered: boolean
  /** 决策是否执行。 */
  decisionExecuted: boolean
  /** 复盘备注。 */
  notes: string
  /** 复盘摘要（review_report 生成，供 review_get 汇总）。 */
  summary?: string
  /** 复盘正文（markdown，供 review_get 读取）。 */
  report?: string
  /** 创建时间（毫秒时间戳）。 */
  ts: number
}

/** 复盘校验结果（review_check 返回，§4.3）。 */
export interface ReviewCheckResult {
  decisionTriggered: boolean
  decisionExecuted: boolean
  notes: string
}

/**
 * 累计统计（metrics 表，§7.1 + review_metrics 返回，§4.3）。
 * 字段：symbol, date, dir_hit_rate, range_hit_rate, cum_return。
 */
export interface MetricSnapshot {
  symbol: string
  /** 统计截止交易日，`YYYY-MM-DD`。 */
  date: string
  /** 方向命中率（0-1）。 */
  dirHitRate: number
  /** 区间命中率（0-1）。 */
  rangeHitRate: number
  /** 累计收益率。 */
  cumReturn: number
  /** 历史逐日统计（review_metrics 的 history[]）。 */
  history: MetricSnapshot[]
}