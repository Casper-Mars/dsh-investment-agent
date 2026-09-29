/**
 * lib 层行情共享类型。
 *
 * 本文件仅承载纯类型与常量，不依赖任何 dsh/cordis API，也不接触 I/O。
 * 供 `quotes.ts` 与 `providers/` 下各数据源适配复用。
 * `AssetType` 复用自 `domain/types.ts`（纯类型，无运行时代码依赖）。
 */

import type { AssetType } from '../domain/types.js'

/**
 * 行情状态标记（供感知层识别「无有效行情」）。
 *  - trading     正常交易中，存在有效行情
 *  - suspended   停牌（价格/成交量缺失）
 *  - limit_up    涨停（一字板，无成交或仅涨停价成交）
 *  - limit_down  跌停（同上反向）
 *  - unavailable 数据源不可用 / 降级失败，无法取得有效行情
 */
export type QuoteStatus =
  | 'trading'
  | 'suspended'
  | 'limit_up'
  | 'limit_down'
  | 'unavailable'

/**
 * 统一行情结构。三个方法（realtime/intraday/history）返回一致字段，
 * 由各 provider 负责将自身响应映射到此结构。
 */
export interface Quote {
  /** 标的代码（如 588000 / 000001）。 */
  symbol: string
  /** 标的名称（数据源提供时填，否则可为空串）。 */
  name: string
  /** 标的类型。 */
  type: AssetType
  /** 最新价（当前价 / 收盘价）。 */
  price: number
  /** 今开价。 */
  open: number
  /** 最高价。 */
  high: number
  /** 最低价。 */
  low: number
  /** 昨收价。 */
  prevClose: number
  /** 成交量（股）。 */
  volume: number
  /** 成交额（元）。 */
  amount: number
  /** 时间戳（毫秒，Unix epoch）。 */
  ts: number
  /** 交易状态标记。 */
  status: QuoteStatus
  /** 数据源标识（如 eastmoney / tencent / cache），便于告警与追溯。 */
  source: string
}

/**
 * 行情数据源抽象接口。
 * 每个 provider 对应一种标的类型（etf / stock）与一个上游数据源，
 * `QuoteClient` 依据 symbol 对应的 type 路由到具体 provider。
 */
export interface QuoteProvider {
  /** 本 provider 服务的标的类型。 */
  readonly type: AssetType
  /** 数据源标识（如 eastmoney / tencent）。 */
  readonly name: string
  /** 实时行情。 */
  realtime(symbol: string): Promise<Quote>
  /** 日内分时（返回序列，时间升序）。 */
  intraday(symbol: string): Promise<Quote[]>
  /** 日 K 历史（days 个交易日，时间升序）。 */
  history(symbol: string, days: number): Promise<Quote[]>
}

/**
 * 简易行情：仅标记状态 + 价格，symbol/type/source 由调用上下文补齐。
 * 用于降级失败时构造「unavailable」占位行情。
 */
export interface QuoteStub {
  price?: number
  status?: QuoteStatus
}

/** 市场标识：沪市 1 / 深市 0（东财 secid 前缀）。 */
export type Market = 1 | 0

/**
 * 依据 A 股代码推断市场（secid 前缀）。
 *  - 沪市：5 / 6 / 9 开头（含 ETF）
 *  - 深市：0 / 1 / 3 开头
 * 无法识别时返回 null。
 */
export function inferMarket(symbol: string): Market | null {
  if (!/^\d{6}$/.test(symbol)) return null
  const head = symbol[0]
  if (head === '5' || head === '6' || head === '9') return 1
  if (head === '0' || head === '1' || head === '3') return 0
  return null
}

/**
 * 依据 A 股代码推断标的类型（默认路由）。
 *  - 5 开头：沪市 ETF
 *  - 1 开头：深市 ETF
 *  - 其余（0/3/6/9）：个股
 * 无法识别时返回 null，调用方需显式传入 type。
 */
export function inferAssetType(symbol: string): AssetType | null {
  if (!/^\d{6}$/.test(symbol)) return null
  const head = symbol[0]
  if (head === '5' || head === '1') return 'etf'
  if (head === '0' || head === '3' || head === '6' || head === '9') return 'stock'
  return null
}