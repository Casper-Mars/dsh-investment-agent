/**
 * domain/predicts.ts —— 预测（预判）域。
 *
 * 职责：落库每日预判、按「实际行情快照」校验命中、回读预判原文。
 * 复用 Task 2 的 `JsonStore`（predictions 表），不做重复存储封装。
 *
 * 接口签名对齐详细设计 §4.2：
 * ```
 * interface Predicts {
 *   predict_make(symbol, date, dir, range_low, range_high, confidence, watch_points[]): { ok, prediction_id }
 *   predict_verify(symbol, date, actual?): { hit_dir, hit_range, deviation }
 *   predict_get(symbol, date): { prediction: {...} }
 * }
 * ```
 *
 * 命中验证口径（本域最关键的自洽设计，务必理解）：
 *
 * 1. 「实际走势」与「行情」解耦 —— domain 层不 import lib/quotes，因而不主动
 *    拉行情。`predict_verify` 通过 `actual` 参数（ActualitySnapshot）原子地接收
 *    当日的实际行情快照（close / high / low / prevClose）。tools 层负责拉取并注入；
 *    若不传 `actual`，则无法校验（抛错），保证口径不产生静默错误。
 *
 * 2. 方向命中（hit_dir）：
 *    - 基线 = prevClose（前一交易日收盘价）。
 *    - 实际方向 = sign(close - prevClose)：>0 看涨 / <0 看跌 / =0 震荡。
 *    - hit_dir = (实际方向 与 预判 dir 一致)。
 *
 * 3. 区间命中（hit_range）：
 *    - 预测区间为 [rangeLow, rangeHigh]（闭区间）。
 *    - hit_range = (rangeLow <= close <= rangeHigh)，即收盘价落在预测区间内。
 *
 * 4. 偏差（deviation）：
 *    - 区间命中时 deviation = 0（落在区间内，无偏离）。
 *    - 区间未命中且 close > rangeHigh：deviation = close - rangeHigh（上破距离）。
 *    - 区间未命中且 close < rangeLow：deviation = rangeLow - close（下破距离，恒为正）。
 *    - 偏差恒为非负，量纲与价格一致，便于 tools 层做阈值判定。
 *
 * 纯 TS + 本地 JSON 存储，不接触 dsh/cordis API。
 */
import type {
  ActualitySnapshot,
  HitResult,
  PredictDir,
  PredictionRecord,
  PredictRange,
} from './types.js'
import { JsonStore } from './store.js'
import { newTradeId } from './store.js'

/** 预判落库入参（对齐 §4.2 predict_make 参数）。 */
export interface PredictMakeInput {
  dir: PredictDir
  rangeLow: number
  rangeHigh: number
  confidence: number
  watchPoints: string[]
}

/** 预判落库结果。 */
export interface PredictMakeResult {
  ok: boolean
  predictionId?: string
  error?: string
}

/** 预判回读结果（§4.2 predict_get）。 */
export interface PredictGetResult {
  prediction: PredictionRecord | null
}

/** 生成预判 id（复用 store 的 newTradeId 前缀体系，保证唯一性）。 */
function newPredictionId(): string {
  return `p_${newTradeId().slice(2)}`
}

/**
 * 预测域实现。所有读写经 `JsonStore` 读 predictions 表（按 symbol 隔离）。
 */
export class Predicts {
  private readonly store: JsonStore

  constructor(dataRoot: string) {
    this.store = new JsonStore(dataRoot)
  }

  /** 读某标的全部预判。 */
  private all(symbol: string): PredictionRecord[] {
    return this.store.readTable<PredictionRecord[]>(symbol, 'predictions') ?? []
  }

  /** 写回某标的全部预判。 */
  private saveAll(symbol: string, recs: PredictionRecord[]): void {
    this.store.writeTable<PredictionRecord[]>(symbol, 'predictions', recs)
  }

  /**
   * 落库一条预判（§4.2 predict_make）。
   * 同一 symbol + date 重复落库时覆盖旧记录（预测以最新一次为准）。
   */
  predict_make(
    symbol: string,
    date: string,
    input: PredictMakeInput,
  ): PredictMakeResult {
    if (!symbol || symbol.trim() === '') {
      return { ok: false, error: '[predicts] symbol 为空' }
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return { ok: false, error: `[predicts] date 非法：${date}（应为 YYYY-MM-DD）` }
    }
    if (!isValidDir(input.dir)) {
      return { ok: false, error: `[predicts] dir 非法：${input.dir}` }
    }
    if (!Number.isFinite(input.rangeLow) || !Number.isFinite(input.rangeHigh)) {
      return { ok: false, error: '[predicts] range 上下沿必须为有限数字' }
    }
    if (input.rangeLow > input.rangeHigh) {
      return { ok: false, error: '[predicts] rangeLow 不能大于 rangeHigh' }
    }
    if (
      !Number.isFinite(input.confidence) ||
      input.confidence < 0 ||
      input.confidence > 1
    ) {
      return { ok: false, error: '[predicts] confidence 必须在 [0,1] 区间' }
    }

    const rec: PredictionRecord = {
      id: newPredictionId(),
      symbol,
      date,
      dir: input.dir,
      rangeLow: input.rangeLow,
      rangeHigh: input.rangeHigh,
      confidence: input.confidence,
      watchPoints: [...input.watchPoints],
      ts: Date.now(),
    }

    const recs = this.all(symbol).filter((r) => r.date !== date)
    recs.push(rec)
    // 按 date 升序，便于 verify 取「前一日」。
    recs.sort((a, b) => a.date.localeCompare(b.date))
    this.saveAll(symbol, recs)

    return { ok: true, predictionId: rec.id }
  }

  /**
   * 校验某日预判是否命中（§4.2 predict_verify）。
   *
   * @param actual 当日实际行情快照（由调用方注入）；缺省则无法校验、抛错。
   * @returns 命中结果 { hit_dir, hit_range, deviation }（字段用下划线命名，
   *   对齐 §4.2 工具契约返回字段）。
   */
  predict_verify(
    symbol: string,
    date: string,
    actual?: ActualitySnapshot,
  ): HitResult {
    const rec = this.all(symbol).find((r) => r.date === date)
    if (!rec) {
      throw new Error(`[predicts] 标的 ${symbol} 在 ${date} 无预判记录`)
    }
    if (!actual) {
      throw new Error(
        `[predicts] 校验 ${symbol}@${date} 需注入实际行情快照（actual）`,
      )
    }
    if (!Number.isFinite(actual.close)) {
      throw new Error('[predicts] 实际行情快照 close 非法')
    }

    return computeHit(rec.dir, rec.rangeLow, rec.rangeHigh, actual)
  }

  /**
   * 回读某日预判原文（§4.2 predict_get）。
   * 无记录返回 { prediction: null }（不抛错，供 tools 层友好提示）。
   */
  predict_get(symbol: string, date: string): PredictGetResult {
    const rec = this.all(symbol).find((r) => r.date === date)
    return { prediction: rec ?? null }
  }

  /** 读取某日预判区间（供 reviews 域复用，避免重复解析）。 */
  getRange(symbol: string, date: string): PredictRange | undefined {
    const rec = this.all(symbol).find((r) => r.date === date)
    if (!rec) return undefined
    return { low: rec.rangeLow, high: rec.rangeHigh }
  }
}

/** 方向合法性校验。 */
function isValidDir(dir: PredictDir): boolean {
  return dir === 'up' || dir === 'down' || dir === 'flat'
}

/**
 * 命中计算核心（纯函数，供单测直接覆盖边界）。
 *
 * 口径详见文件头注释。
 */
export function computeHit(
  dir: PredictDir,
  rangeLow: number,
  rangeHigh: number,
  actual: ActualitySnapshot,
): HitResult {
  // 方向命中：以 prevClose 为基线判实际方向。
  const delta = actual.close - actual.prevClose
  let actualDir: PredictDir
  if (delta > 0) actualDir = 'up'
  else if (delta < 0) actualDir = 'down'
  else actualDir = 'flat'
  const hitDir = actualDir === dir

  // 区间命中：收盘价落在 [rangeLow, rangeHigh] 闭区间内。
  const hitRange = actual.close >= rangeLow && actual.close <= rangeHigh

  // 偏差：区间命中为 0；否则为越界距离（恒非负）。
  let deviation = 0
  if (!hitRange) {
    if (actual.close > rangeHigh) deviation = actual.close - rangeHigh
    else deviation = rangeLow - actual.close
  }

  return { hitDir, hitRange, deviation }
}

export type {
  ActualitySnapshot,
  HitResult,
  PredictDir,
  PredictionRecord,
  PredictRange,
}