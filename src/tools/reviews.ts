/**
 * Agent 工具层：复盘域工具（review_check / review_report / review_get /
 * review_metrics / review_retrospect）。
 *
 * execute 一律走 domain/reviews 的 {@link Reviews}（本地 CRUD，无 HTTP 层）。
 *
 * 字段映射策略：domain 返回驼峰（decisionTriggered/decisionExecuted/reportId/
 * dirHitRate/rangeHitRate/cumReturn/rootCause），§4.3 契约用下划线
 * （decision_triggered/decision_executed/report_id/dir_hit_rate/range_hit_rate/
 * cum_return/root_cause）。execute 做显式蛇形映射，output.schema 与返回统一蛇形。
 *
 * 返回形态：写类 report 成功返回 `{ ok, report_id }`；读类 check / get / metrics /
 *   retrospect 返回无 ok 字段的数据对象（对照 §4.3 契约表）。错误 throw（见 ./error.ts）。
 *
 * 决策触发/执行注入：review_check 需 decision / hit 由调用方注入（domain 不主动
 *   判定），tools 层透传；缺省按 false 处理但仍返回 notes 说明。
 *
 * 阈值判定（review_retrospect）：从 ToolContext.getThresholds 读阈值（默认回落
 *   到 DEFAULT_THRESHOLDS），配合 review_metrics 的当前统计判定是否劣于阈值。
 */
import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { ToolContext } from './context.js'
import type { HitResult } from '../domain/predicts.js'
import type { MetricSnapshot } from '../domain/reviews.js'
import type {
  ReviewCheckResult,
  ReviewMetricsResult,
  ReviewReportItem,
  ReviewRetrospectResult,
  MetricSnapshotView,
} from './types.js'
import { assertNotAborted, throwToolError } from './error.js'
import { withDisclaimer } from './constants.js'
import {
  reviewCheckResultSchema,
  reviewGetResultSchema,
  reviewMetricsResultSchema,
  reviewReportResultSchema,
  reviewRetrospectResultSchema,
} from './schemas.js'

/** 逐日统计蛇形映射。 */
function toMetricSnapshotView(m: MetricSnapshot): MetricSnapshotView {
  return {
    symbol: m.symbol,
    date: m.date,
    dir_hit_rate: m.dirHitRate,
    range_hit_rate: m.rangeHitRate,
    cum_return: m.cumReturn,
  }
}

/** 从可选布尔参数构造 HitResult（两个命中布尔同时提供才注入）。 */
function hitFromArgs(hitDir?: boolean, hitRange?: boolean): HitResult | undefined {
  if (hitDir === undefined || hitRange === undefined) return undefined
  return { hitDir, hitRange, deviation: 0 }
}

/** review_check：校验前一日决策触发/执行。 */
export function createReviewCheckTool(ctx: ToolContext): ToolDefinition {
  return defineTool({
    name: 'review_check',
    description:
      '校验某标的某交易日前一日的决策是否触发/执行，并结合命中结果生成说明。' +
      '决策触发/执行由调用方注入。只读操作（不落库）。',
    parameters: {
      symbol: { type: 'string', required: true, description: '标的代码' },
      date: { type: 'string', required: true, description: '复盘对应交易日 YYYY-MM-DD' },
      decision_triggered: { type: 'boolean', required: true, description: '前一日决策是否触发' },
      decision_executed: { type: 'boolean', required: true, description: '决策是否执行' },
      hit_dir: { type: 'boolean', description: '命中结果注入：方向是否命中（可选）' },
      hit_range: { type: 'boolean', description: '命中结果注入：区间是否命中（可选）' },
    },
    output: {
      schema: reviewCheckResultSchema,
      render: (_args, value) => [{ type: 'text', text: withDisclaimer(value.notes) }],
    },
    async execute(args) {
      const res = ctx.reviews.review_check(args.symbol, args.date, {
        decisionTriggered: args.decision_triggered,
        decisionExecuted: args.decision_executed,
        hit: hitFromArgs(args.hit_dir, args.hit_range),
      })
      const result: ReviewCheckResult = {
        decision_triggered: res.decisionTriggered,
        decision_executed: res.decisionExecuted,
        notes: res.notes,
      }
      return result
    },
  })
}

/** review_report：汇总复盘落记录。 */
export function createReviewReportTool(ctx: ToolContext): ToolDefinition {
  return defineTool({
    name: 'review_report',
    description:
      '将复盘校验结论固化为一篇复盘记录（含报告正文与摘要）。同一 symbol+date 覆盖旧记录。写操作。',
    parameters: {
      symbol: { type: 'string', required: true, description: '标的代码' },
      date: { type: 'string', required: true, description: '复盘对应交易日 YYYY-MM-DD' },
      decision_triggered: { type: 'boolean', required: true, description: '决策是否触发' },
      decision_executed: { type: 'boolean', required: true, description: '决策是否执行' },
      hit_dir: { type: 'boolean', description: '方向是否命中（可选）' },
      hit_range: { type: 'boolean', description: '区间是否命中（可选）' },
      summary: { type: 'string', description: '复盘摘要（可选，缺省自动生成）' },
      report: { type: 'string', description: '复盘正文（可选，缺省自动生成）' },
    },
    output: {
      schema: reviewReportResultSchema,
      render: (_args, value) => [
        { type: 'text', text: withDisclaimer(`✅ 已落复盘（id=${value.report_id}）`) },
      ],
    },
    async execute(args, exec) {
      assertNotAborted(exec.signal)
      const hit = hitFromArgs(args.hit_dir, args.hit_range)
      const check = ctx.reviews.review_check(args.symbol, args.date, {
        decisionTriggered: args.decision_triggered,
        decisionExecuted: args.decision_executed,
        hit,
      })
      const res = ctx.reviews.review_report(args.symbol, args.date, check, {
        hit,
        summary: args.summary,
        report: args.report,
      })
      if (!res.ok) {
        throw new Error(res.error ?? '复盘失败')
      }
      return { ok: true as const, report_id: res.reportId! }
    },
  })
}

/** review_get：读回复盘（单日/全量）。 */
export function createReviewGetTool(ctx: ToolContext): ToolDefinition {
  return defineTool({
    name: 'review_get',
    description:
      '读回某标的的复盘记录（date 缺省返回全量，给定返回单日）。只读操作。',
    parameters: {
      symbol: { type: 'string', required: true, description: '标的代码' },
      date: { type: 'string', description: '复盘对应交易日 YYYY-MM-DD（可选）' },
    },
    output: {
      schema: reviewGetResultSchema,
      render: (_args, value) => {
        if (value.reports.length === 0) {
          return [{ type: 'text', text: '无复盘记录。' }]
        }
        const lines = value.reports.map(
          (r, i) => `${i + 1}. [${r.date}] ${r.summary}`,
        )
        return [{ type: 'text', text: `共 ${value.reports.length} 篇复盘：\n${lines.join('\n')}` }]
      },
    },
    async execute(args) {
      const res = ctx.reviews.review_get(args.symbol, args.date)
      const reports: ReviewReportItem[] = res.reports.map((r) => ({
        date: r.date,
        report: r.report,
        summary: r.summary,
      }))
      return { reports }
    },
  })
}

/** review_metrics：读累计统计。 */
export function createReviewMetricsTool(ctx: ToolContext): ToolDefinition {
  return defineTool({
    name: 'review_metrics',
    description:
      '读取某标的的累计统计（方向命中率 / 区间命中率 / 累计收益率 + 逐日历史）。只读操作。',
    parameters: {
      symbol: { type: 'string', required: true, description: '标的代码' },
      price: {
        type: 'number',
        description:
          '现价，用于计算累计收益率 cum_return 的期末市值（期末总资产 = 期末现金 + 期末持仓市值）；缺省则用最近成交价代理',
      },
    },
    output: {
      schema: reviewMetricsResultSchema,
      render: (_args, value) => [
        {
          type: 'text',
          text: withDisclaimer(
            `方向命中率：${value.dir_hit_rate}  区间命中率：${value.range_hit_rate}  ` +
              `累计收益率：${value.cum_return}`,
          ),
        },
      ],
    },
    async execute(args) {
      const price = args.price
      const m = ctx.reviews.review_metrics(args.symbol, price)
      const result: ReviewMetricsResult = {
        dir_hit_rate: m.dirHitRate,
        range_hit_rate: m.rangeHitRate,
        cum_return: m.cumReturn,
        history: m.history.map(toMetricSnapshotView),
      }
      return result
    },
  })
}

/** review_retrospect：劣于阈值时根因定位。 */
export function createReviewRetrospectTool(ctx: ToolContext): ToolDefinition {
  return defineTool({
    name: 'review_retrospect',
    description:
      '当标的表现劣于阈值时定位根因并给出改进建议（方向命中率 / 累计收益率 / 阈值配置）。只读操作。',
    parameters: {
      symbol: { type: 'string', required: true, description: '标的代码' },
      price: {
        type: 'number',
        description:
          '现价，用于计算累计收益率 cum_return 的期末市值（期末总资产 = 期末现金 + 期末持仓市值）；缺省则用最近成交价代理',
      },
    },
    output: {
      schema: reviewRetrospectResultSchema,
      render: (_args, value) => [
        {
          type: 'text',
          text: withDisclaimer(
            `${value.root_cause}` +
              (value.improvements.length > 0
                ? `\n改进：${value.improvements.join('、')}`
                : ''),
          ),
        },
      ],
    },
    async execute(args) {
      const thresholds = ctx.getThresholds(args.symbol)
      const price = args.price
      const m = ctx.reviews.review_metrics(args.symbol, price)
      const r = ctx.reviews.review_retrospect(args.symbol, thresholds, {
        dirHitRate: m.dirHitRate,
        rangeHitRate: m.rangeHitRate,
        cumReturn: m.cumReturn,
        history: m.history,
      })
      const result: ReviewRetrospectResult = {
        root_cause: r.rootCause,
        improvements: [...r.improvements],
      }
      return result
    },
  })
}

export function createReviewTools(ctx: ToolContext): ToolDefinition[] {
  return [
    createReviewCheckTool(ctx),
    createReviewReportTool(ctx),
    createReviewGetTool(ctx),
    createReviewMetricsTool(ctx),
    createReviewRetrospectTool(ctx),
  ]
}