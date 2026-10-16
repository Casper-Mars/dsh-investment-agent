/**
 * Agent 工具层：预测域工具（predict_make / predict_verify / predict_get）。
 *
 * execute 一律走 domain/predicts 的 {@link Predicts}（本地 CRUD，无 HTTP 层）。
 *
 * 字段映射策略：domain 返回驼峰（rangeLow/rangeHigh/watchPoints/hitDir/hitRange/
 * predictionId），§4.2 契约用下划线（range_low/range_high/watch_points/hit_dir/
 * hit_range/prediction_id）。execute 做显式蛇形映射，output.schema 与返回统一蛇形。
 *
 * 返回形态：写类 predict_make 成功返回 `{ ok, prediction_id }`；读类 verify / get
 *   返回无 ok 字段的数据对象（verify: 命中三字段；get: `{ prediction }`）。错误
 *   不返回 `{ ok:false }`，而是 throw（见 ./error.ts）。
 *
 * actual 注入：predict_verify 需 actual 快照（close/high/low/prevClose），由
 *   调用方传入（domain 不主动拉行情）。domain 在无预判 / 缺 actual 时 throw，
 *   execute try/catch 归一后抛出。
 */
import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { ToolContext } from './context.js'
import type { PredictionView, PredictVerifyResult } from './types.js'
import { assertNotAborted, throwIfFailed, throwToolError } from './error.js'
import {
  predictGetResultSchema,
  predictMakeResultSchema,
  predictVerifyResultSchema,
} from './schemas.js'

/** predict_make：写 predictions 表。 */
export function createPredictMakeTool(ctx: ToolContext): ToolDefinition {
  return defineTool({
    name: 'predict_make',
    description:
      '为指定标的在某交易日落一条预判（方向 / 区间 / 置信度 / 观察点）。' +
      '同一 symbol+date 重复落库覆盖旧记录。写操作，按 symbol 隔离。',
    parameters: {
      symbol: { type: 'string', required: true, description: '标的代码' },
      date: { type: 'string', required: true, description: '预判对应交易日 YYYY-MM-DD' },
      dir: {
        type: 'string',
        enum: ['up', 'down', 'flat'],
        required: true,
        description: '方向：up（看涨）/ down（看跌）/ flat（震荡）',
      },
      range_low: {
        type: 'number',
        required: true,
        description: '预期收盘区间下沿（收盘口径：判定时以实际收盘价是否 ≥ 本下沿为准）',
      },
      range_high: {
        type: 'number',
        required: true,
        description: '预期收盘区间上沿（收盘口径：判定时以实际收盘价是否 ≤ 本上沿为准）',
      },
      confidence: { type: 'number', required: true, description: '置信度（0-1）' },
      watch_points: {
        type: 'array',
        items: { type: 'string' },
        required: true,
        description: '观察点列表（触发关注的事件 / 点位）',
      },
    },
    output: {
      schema: predictMakeResultSchema,
      render: (_args, value) => [
        { type: 'text', text: `✅ 已落预判（id=${value.prediction_id}）` },
      ],
    },
    async execute(args, exec) {
      assertNotAborted(exec.signal)
      const res = ctx.predicts.predict_make(args.symbol, args.date, {
        dir: args.dir,
        rangeLow: args.range_low,
        rangeHigh: args.range_high,
        confidence: args.confidence,
        watchPoints: args.watch_points,
      })
      throwIfFailed(res)
      return { ok: true as const, prediction_id: res.predictionId! }
    },
  })
}

/** predict_verify：读前一日预判 vs 实际算命中。 */
export function createPredictVerifyTool(ctx: ToolContext): ToolDefinition {
  return defineTool({
    name: 'predict_verify',
    description:
      '校验某标的某交易日的预判是否命中（方向 / 区间 / 偏差）。需注入当日实际行情快照' +
      '（close / prevClose；high / low 当前不参与判定、可选，区间判定为收盘口径）。只读操作。',
    parameters: {
      symbol: { type: 'string', required: true, description: '标的代码' },
      date: { type: 'string', required: true, description: '预判对应交易日 YYYY-MM-DD' },
      actual_close: {
        type: 'number',
        required: true,
        description: '实际收盘价（参与区间判定，收盘口径：收盘价落入 [range_low, range_high] 闭区间即命中）',
      },
      // 可选入参：不写 required（工具 schema 约定「必填=required:true，可选=缺省」）。
      actual_high: {
        type: 'number',
        description: '实际最高价（当前不参与判定：区间判定为收盘口径，本字段预留给日后高低价口径）',
      },
      actual_low: {
        type: 'number',
        description: '实际最低价（当前不参与判定：区间判定为收盘口径，本字段预留给日后高低价口径）',
      },
      prev_close: { type: 'number', required: true, description: '前一交易日收盘价（方向基线）' },
    },
    output: {
      schema: predictVerifyResultSchema,
      render: (_args, value) => [
        {
          type: 'text',
          text:
            `方向命中：${value.hit_dir ? '✓' : '✗'}  区间命中：${value.hit_range ? '✓' : '✗'}` +
            `  偏差：${value.deviation}`,
        },
      ],
    },
    async execute(args) {
      try {
        // 区间判定为收盘口径（computeHit 只读 close / prevClose）。actual_high /
        // actual_low 当前不参与判定，缺省时透传 undefined 即可，判定结果与传入时一致。
        const hit = ctx.predicts.predict_verify(args.symbol, args.date, {
          close: args.actual_close,
          high: args.actual_high,
          low: args.actual_low,
          prevClose: args.prev_close,
        })
        const result: PredictVerifyResult = {
          hit_dir: hit.hitDir,
          hit_range: hit.hitRange,
          deviation: hit.deviation,
        }
        return result
      } catch (err) {
        throwToolError(err)
      }
    },
  })
}

/** predict_get：读回预判原文。 */
export function createPredictGetTool(ctx: ToolContext): ToolDefinition {
  return defineTool({
    name: 'predict_get',
    description:
      '读回某标的某交易日的预判原文（方向 / 区间 / 置信度 / 观察点）。无记录时 prediction 为 null。只读操作。',
    parameters: {
      symbol: { type: 'string', required: true, description: '标的代码' },
      date: { type: 'string', required: true, description: '预判对应交易日 YYYY-MM-DD' },
    },
    output: {
      schema: predictGetResultSchema,
      render: (_args, value) => {
        const p = value.prediction
        if (p === null) return [{ type: 'text', text: '无预判记录。' }]
        return [
          {
            type: 'text',
            text:
              `方向：${p.dir}  区间：[${p.range_low}, ${p.range_high}]  ` +
              `置信度：${p.confidence}\n观察点：${p.watch_points.join('、') || '—'}`,
          },
        ]
      },
    },
    async execute(args) {
      const res = ctx.predicts.predict_get(args.symbol, args.date)
      const rec = res.prediction
      if (rec === null) {
        return { prediction: null }
      }
      const view: PredictionView = {
        dir: rec.dir,
        range_low: rec.rangeLow,
        range_high: rec.rangeHigh,
        confidence: rec.confidence,
        watch_points: [...rec.watchPoints],
      }
      return { prediction: view }
    },
  })
}

export function createPredictTools(ctx: ToolContext): ToolDefinition[] {
  return [
    createPredictMakeTool(ctx),
    createPredictVerifyTool(ctx),
    createPredictGetTool(ctx),
  ]
}