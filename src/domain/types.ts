/**
 * domain 层共享类型定义。
 *
 * 本文件仅承载纯类型与常量，不依赖任何 dsh/cordis API，也不接触 I/O。
 * 供 `ledger` / `metrics` / `sense-registry` 三域以及后续 `tools` / `runner`
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