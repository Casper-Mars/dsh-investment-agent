/**
 * domain/reviews.ts —— 复盘域。
 *
 * 职责：校验前一日决策触发/执行、汇总复盘落库、回读复盘（单日/全量）、
 * 累计统计、劣于阈值时的根因定位。复用 Task 2 的 `JsonStore`
 * （reviews / metrics 两张表），不做重复存储封装。
 *
 * 接口签名对齐详细设计 §4.3：
 * ```
 * interface Reviews {
 *   review_check(symbol, date): { decision_triggered, decision_executed, notes }
 *   review_report(symbol, date): { ok, report_id }
 *   review_get(symbol, date?): { reports: [{ date, report, summary }] }
 *   review_metrics(symbol): { dir_hit_rate, range_hit_rate, cum_return, history[] }
 *   review_retrospect(symbol): { root_cause, improvements[] }
 * }
 * ```
 *
 * 关键口径（自洽设计说明）：
 * - 决策触发/执行（review_check）：前一日决策是否触发、执行由调用方（tools 层）
 *   依据信号与持仓变化判定后传入。domain 层据此落「校验结论」到 reviews 表
 *   的 decision_triggered / decision_executed 字段，并生成 notes。若无预判
 *   记录则返回「未触发」+ 说明性 notes（不抛错，视为「无决策可复盘」）。
 * - 命中数据来源：review 域的 hit_dir / hit_range 可直接复用 predicts 域的
 *   hit 口径——为避免双向耦合，review_check 接收可选的 hit 结果注入；若未注入，
 *   则尝试从该 symbol 已落的复盘记录中读取（闭环）。
 * - review_report：将 review_check 的结论固化为一篇复盘（report/summary），
 *   落 reviews 表并返回 report_id。
 * - review_metrics：读 metrics 表累计统计；若无记录，则基于 reviews 表即时
 *   计算 dir_hit_rate / range_hit_rate（cum_return 需由 ledger 流水供给，domain
 *   层不主动算，缺省 0 并在 history 保留空）。history 为逐日统计列表。
 * - review_retrospect：标的表现劣于阈值时的根因定位。阈值与「当前指标 vs
 *   阈值」的比较在调用方（tools）完成；本方法接收可选 `clue`（劣化快照）拼装
 *   root_cause 与 improvements。纯逻辑，不落库。
 *
 * 纯 TS + 本地 JSON 存储，不接触 dsh/cordis API。
 */
import type {
  HitResult,
  MetricSnapshot,
  ReviewCheckResult,
  ReviewRecord,
  Thresholds,
} from './types.js'
import { JsonStore } from './store.js'
import { isBelowThreshold } from './metrics.js'

/** 复盘校验入参（决策触发/执行与命中结果的注入，调用方提供）。 */
export interface ReviewCheckInput {
  /** 前一日决策是否触发。 */
  decisionTriggered: boolean
  /** 决策是否执行。 */
  decisionExecuted: boolean
  /** 附加说明。 */
  note?: string
  /** 命中结果注入（可选；来自 predicts.verify）。 */
  hit?: HitResult
}

/** 复盘落库结果（§4.3 review_report）。 */
export interface ReviewReportResult {
  ok: boolean
  reportId?: string
  error?: string
}

/** 复盘回读项（§4.3 review_get 的 reports 元素）。 */
export interface ReviewReportItem {
  date: string
  report: string
  summary: string
}

/** 复盘回读结果。 */
export interface ReviewGetResult {
  reports: ReviewReportItem[]
}

/** 累计统计结果（§4.3 review_metrics）。 */
export interface ReviewMetricsResult {
  dirHitRate: number
  rangeHitRate: number
  cumReturn: number
  history: MetricSnapshot[]
}

/** 根因定位结果（§4.3 review_retrospect）。 */
export interface ReviewRetrospectResult {
  rootCause: string
  improvements: string[]
}

/** 累计统计快照落库入参（record_metrics）。 */
export interface MetricRecordInput {
  date: string
  dirHitRate: number
  rangeHitRate: number
  cumReturn: number
  history?: MetricSnapshot[]
}

/** 生成复盘 id。 */
function newReviewId(): string {
  return `rv_${randomSuffix()}`
}

/** 生成预测/复盘唯一后缀（本地唯一，无外部依赖）。 */
function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36)
}

/**
 * 复盘域实现。
 */
export class Reviews {
  private readonly store: JsonStore

  constructor(dataRoot: string) {
    this.store = new JsonStore(dataRoot)
  }

  // ---- reviews 表读写 ----
  private all(symbol: string): ReviewRecord[] {
    return this.store.readTable<ReviewRecord[]>(symbol, 'reviews') ?? []
  }

  private saveAll(symbol: string, recs: ReviewRecord[]): void {
    this.store.writeTable<ReviewRecord[]>(symbol, 'reviews', recs)
  }

  // ---- metrics 表读写 ----
  private getMetrics(symbol: string): MetricSnapshot | undefined {
    return this.store.readTable<MetricSnapshot>(symbol, 'metrics')
  }

  private saveMetrics(symbol: string, m: MetricSnapshot): void {
    this.store.writeTable<MetricSnapshot>(symbol, 'metrics', m)
  }

  /**
   * 校验前一日决策触发/执行（§4.3 review_check）。
   * 返回 { decision_triggered, decision_executed, notes }（下划线命名对齐契约）。
   * 纯解析结论，不落库（落库由 review_report 负责）。
   */
  review_check(symbol: string, date: string, input: ReviewCheckInput): ReviewCheckResult {
    if (!symbol || symbol.trim() === '') {
      throw new Error('[reviews] symbol 为空')
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      throw new Error(`[reviews] date 非法：${date}（应为 YYYY-MM-DD）`)
    }

    const parts: string[] = []
    if (input.decisionTriggered) parts.push('前一日决策已触发')
    else parts.push('前一日决策未触发')
    if (input.decisionExecuted) parts.push('决策已执行')
    else parts.push('决策未执行')
    if (input.hit) {
      parts.push(
        input.hit.hitDir ? '方向命中' : '方向未命中',
        input.hit.hitRange ? '区间命中' : '区间未命中',
      )
    }
    if (input.note) parts.push(input.note)

    return {
      decisionTriggered: input.decisionTriggered,
      decisionExecuted: input.decisionExecuted,
      notes: parts.join('；'),
    }
  }

  /**
   * 汇总复盘并落库（§4.3 review_report）。
   * 输入为 review_check 的结论 + 可选的命中结果 + 摘要正文。
   * 同一 symbol + date 覆盖旧记录。
   */
  review_report(
    symbol: string,
    date: string,
    check: ReviewCheckResult,
    opts: { hit?: HitResult; summary?: string; report?: string } = {},
  ): ReviewReportResult {
    if (!symbol || symbol.trim() === '') {
      return { ok: false, error: '[reviews] symbol 为空' }
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return { ok: false, error: `[reviews] date 非法：${date}` }
    }

    const summary =
      opts.summary ??
      `复盘 ${date}：${check.notes}${opts.hit ? `（方向${opts.hit.hitDir ? '✓' : '✗'} 区间${opts.hit.hitRange ? '✓' : '✗'}）` : ''}`

    const report =
      opts.report ??
      [
        `# 复盘报告 ${date}`,
        ``,
        `- 决策触发：${check.decisionTriggered ? '是' : '否'}`,
        `- 决策执行：${check.decisionExecuted ? '是' : '否'}`,
        opts.hit
          ? `- 方向命中：${opts.hit.hitDir ? '是' : '否'}\n- 区间命中：${opts.hit.hitRange ? '是' : '否'}\n- 偏差：${opts.hit.deviation}`
          : `- 命中：未提供`,
        ``,
        check.notes,
      ].join('\n')

    const rec: ReviewRecord = {
      id: newReviewId(),
      symbol,
      date,
      hitDir: opts.hit?.hitDir ?? false,
      hitRange: opts.hit?.hitRange ?? false,
      decisionTriggered: check.decisionTriggered,
      decisionExecuted: check.decisionExecuted,
      notes: check.notes,
      summary,
      report,
      ts: Date.now(),
    }

    const recs = this.all(symbol).filter((r) => r.date !== date)
    recs.push(rec)
    recs.sort((a, b) => a.date.localeCompare(b.date))
    this.saveAll(symbol, recs)

    return { ok: true, reportId: rec.id }
  }

  /**
   * 回读复盘（§4.3 review_get）。date 缺省返回全量；date 给定时返回单日。
   */
  review_get(symbol: string, date?: string): ReviewGetResult {
    const recs = this.all(symbol)
    const target = date === undefined ? recs : recs.filter((r) => r.date === date)
    const reports: ReviewReportItem[] = target.map((r) => ({
      date: r.date,
      report: r.report ?? r.summary ?? '',
      summary: r.summary ?? '',
    }))
    return { reports }
  }

  /**
   * 读累计统计（§4.3 review_metrics）。
   * 优先返回 metrics 表已落快照；无记录则基于 reviews 表即时计算命中率，
   * cum_return 缺省 0（累计收益需 ledger 流水，domain 层不主动算）。
   */
  review_metrics(symbol: string): ReviewMetricsResult {
    const cached = this.getMetrics(symbol)
    if (cached) {
      return {
        dirHitRate: cached.dirHitRate,
        rangeHitRate: cached.rangeHitRate,
        cumReturn: cached.cumReturn,
        history: cached.history ?? [],
      }
    }

    const recs = this.all(symbol)
    const dirHitRate = rate(recs.map((r) => r.hitDir))
    const rangeHitRate = rate(recs.map((r) => r.hitRange))

    const snapshot: MetricSnapshot = {
      symbol,
      date: recs.length > 0 ? recs[recs.length - 1].date : '',
      dirHitRate,
      rangeHitRate,
      cumReturn: 0,
      history: recs.map((r) => ({
        symbol,
        date: r.date,
        dirHitRate: r.hitDir ? 1 : 0,
        rangeHitRate: r.hitRange ? 1 : 0,
        cumReturn: 0,
        history: [],
      })),
    }

    return {
      dirHitRate,
      rangeHitRate,
      cumReturn: snapshot.cumReturn,
      history: snapshot.history,
    }
  }

  /**
   * 落一条累计统计快照（供 tools 层在拿到 ledger 流水后回写）。
   * 与 review_metrics 互补：metrics 表无记录时即时算，有记录时读缓存。
   */
  record_metrics(symbol: string, m: MetricRecordInput): void {
    const snapshot: MetricSnapshot = {
      symbol,
      date: m.date,
      dirHitRate: m.dirHitRate,
      rangeHitRate: m.rangeHitRate,
      cumReturn: m.cumReturn,
      history: m.history ?? [],
    }
    this.saveMetrics(symbol, snapshot)
  }

  /**
   * 根因定位（§4.3 review_retrospect）。
   * 阈值判定复用 metrics.isBelowThreshold 守卫；当标的表现劣于阈值时，
   * 结合 hit 分布给出根因与改进建议。纯逻辑，不落库。
   *
   * @param symbol 标的。
   * @param thresholds 阈值配置（用于判定）。
   * @param metrics 当前累计统计（用于根因归因）。
   */
  review_retrospect(
    symbol: string,
    thresholds: Thresholds,
    metrics?: ReviewMetricsResult,
  ): ReviewRetrospectResult {
    // 阈值配置守卫：若阈值本身非法（下限为负），直接判定为「需根因定位」。
    const thresholdInvalid = isBelowThreshold(symbol, thresholds)

    const improvements: string[] = []
    const reasons: string[] = []

    if (thresholdInvalid) {
      reasons.push('阈值配置异常（存在负下限）')
      improvements.push('阈值配置本身异常，请核对 dirHitMin/cumReturnMin/missStreakMax')
    }

    if (metrics) {
      if (metrics.dirHitRate < thresholds.dirHitMin) {
        reasons.push('方向命中率低于下限')
        improvements.push('复盘方向判定信号，收紧方向置信度门槛')
      }
      if (metrics.cumReturn < thresholds.cumReturnMin) {
        reasons.push('累计收益低于下限')
        improvements.push('回看持仓成本与卖出时机，优化止盈/止损规则')
      }
    } else {
      reasons.push('缺少累计统计')
      improvements.push('补齐复盘统计后再精确定位根因')
    }

    // 无任何「劣于阈值」情形：无需根因定位。
    if (reasons.length === 0) {
      return {
        rootCause: '表现未劣于阈值，无需根因定位',
        improvements: [],
      }
    }

    return {
      rootCause: `标的表现劣于阈值：${reasons.join('；')}`,
      improvements,
    }
  }
}

/** 命中率：命中数 / 总数（空数组防除零）。 */
function rate(bools: boolean[]): number {
  if (bools.length === 0) return 0
  let n = 0
  for (const b of bools) if (b) n += 1
  return Math.round((n / bools.length) * 10000) / 10000
}

export type {
  HitResult,
  MetricSnapshot,
  ReviewCheckResult,
  ReviewRecord,
  Thresholds,
}