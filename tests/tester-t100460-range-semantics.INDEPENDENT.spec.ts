/**
 * tests/tester-t100460-range-semantics.INDEPENDENT.spec.ts
 *
 * 独立验证 —— t100460「对齐区间命中口径并清理无效必填参数」（Issue #2，P0）。
 * 采纳方案 A：区间命中锁定为「收盘价」口径。本次改动只动对外契约 / 必填约束 /
 * 注释 / 测试，不改判定语义（domain/predicts.computeHit 未改）。
 *
 * 独立性声明（不复用 Developer 的用例断言与 seed）：
 *   1. AC1 不读源码注释，而是**独立读取 defineTool 注册后的工具对象**：
 *        - `ToolDefinition.parameters`：dsh-tools 将参数 spec 编译成的模型可见
 *          JSON Schema（逐属性 description + 顶层 required 列表）；
 *        - `ToolDefinition.output.schema`：成功返回值被运行时强校验的 JSON Schema。
 *      这才是真正下发给模型 / 被运行时强校验的契约，而非源码里的注释文本。
 *   2. AC2 自建预测（predict_make）后分别在「传 / 不传 high/low」两种入参下调用
 *      predict_verify，逐字段比较；并独立复现 Issue #2 给定数字。
 *   3. AC3 独立核验「high 越界但 close 命中」断言的前提成立，并直接调用 domain
 *      纯函数 computeHit 交叉验证。
 *   4. AC4 用 domain 纯函数确认 high/low 不参与判定，且历史边界语义不变。
 * 本文件只测试、不改动 src/**。
 */
import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { createToolContext, type ToolContext } from '../src/tools/context.js'
import { createAllTools } from '../src/tools/index.js'
import { computeHit } from '../src/domain/predicts.js'

let dir: string
let ctx: ToolContext
let tools: ToolDefinition[]

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 't100460-ind-'))
  ctx = createToolContext({ dataRoot: dir })
  tools = createAllTools(ctx)
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

/** 证据累积：报告直接引用其内容（真实读取到的字符串）。 */
const evidence: Record<string, unknown> = {}
afterAll(() => {
  try {
    writeFileSync('/tmp/t100460_independent_evidence.json', JSON.stringify(evidence, null, 2))
  } catch {
    /* 证据文件写入失败不影响测试结论 */
  }
})

function tool(name: string): ToolDefinition {
  const t = tools.find((x) => x.name === name)
  if (!t) throw new Error(`工具 ${name} 未注册`)
  return t
}

/** 独立读取工具对象的参数 JSON Schema（defineTool 编译产物，非源码注释）。 */
function params(name: string): any {
  return tool(name).parameters as any
}
/** 独立读取工具对象的输出 JSON Schema（成功值强校验契约）。 */
function outSchema(name: string): any {
  return (tool(name).output as any).schema
}
async function run(name: string, args: Record<string, unknown>): Promise<any> {
  return tool(name).execute(args, { signal: new AbortController().signal } as any)
}

// ── AC1：契约一致（工具对象独立读取） ──────────────────────────────────────
describe('AC1 契约一致：字段描述 / 入参 required / hit_range 说明 三处均指向收盘口径', () => {
  it('predict_make 的 range_low/range_high：描述含「收盘」，且仍为必填', () => {
    const p = params('predict_make')
    evidence['predict_make.required'] = p.required
    evidence['predict_make.range_low.description'] = p.properties.range_low.description
    evidence['predict_make.range_high.description'] = p.properties.range_high.description

    expect(p.properties.range_low.type).toBe('number')
    expect(p.properties.range_low.description).toContain('收盘')
    expect(p.properties.range_high.description).toContain('收盘')
    expect(p.required).toEqual(expect.arrayContaining(['range_low', 'range_high']))
  })

  it('predict_verify：actual_high/actual_low 不再必填；actual_close 仍必填且注明收盘口径', () => {
    const p = params('predict_verify')
    evidence['predict_verify.required'] = p.required
    evidence['predict_verify.actual_high.description'] = p.properties.actual_high.description
    evidence['predict_verify.actual_low.description'] = p.properties.actual_low.description
    evidence['predict_verify.actual_close.description'] = p.properties.actual_close.description

    expect(p.required).not.toContain('actual_high')
    expect(p.required).not.toContain('actual_low')
    expect(p.required).toEqual(expect.arrayContaining(['symbol', 'date', 'actual_close', 'prev_close']))
    expect(p.properties.actual_high.description).toContain('不参与判定')
    expect(p.properties.actual_low.description).toContain('不参与判定')
    expect(p.properties.actual_close.description).toContain('收盘')
  })

  it('hit_range 说明三处（predict_verify 输出 / review_check 入参 / review_report 入参）均含收盘口径', () => {
    const vr = outSchema('predict_verify').properties.hit_range
    const rc = params('review_check').properties.hit_range
    const rr = params('review_report').properties.hit_range
    evidence['predict_verify.output.hit_range.description'] = vr.description
    evidence['review_check.hit_range.description'] = rc.description
    evidence['review_report.hit_range.description'] = rr.description

    expect(vr.description).toContain('收盘')
    expect(rc.description).toContain('收盘')
    expect(rr.description).toContain('收盘')
  })

  it('range_hit_rate 说明（review_metrics 输出）注明收盘口径', () => {
    const rr = outSchema('review_metrics').properties.range_hit_rate
    evidence['review_metrics.output.range_hit_rate.description'] = rr.description
    expect(rr.description).toContain('收盘')
  })
})

// ── AC2：可选参数可用且判定等价 ────────────────────────────────────────────
describe('AC2 可选参数可用：不传 high/low 与传入时逐字段一致 + 复现 Issue #2', () => {
  it('不传 actual_high/actual_low 可正常调用，三字段与传入时一致', async () => {
    await run('predict_make', {
      symbol: '588001', date: '2026-09-29', dir: 'up',
      range_low: 1.8, range_high: 2.2, confidence: 0.8, watch_points: [],
    })
    const withHL = await run('predict_verify', {
      symbol: '588001', date: '2026-09-29',
      actual_close: 2.0, actual_high: 2.5, actual_low: 1.5, prev_close: 1.8,
    })
    const withoutHL = await run('predict_verify', {
      symbol: '588001', date: '2026-09-29',
      actual_close: 2.0, prev_close: 1.8,
    })
    evidence['ac2.withHL'] = withHL
    evidence['ac2.withoutHL'] = withoutHL

    expect(withHL).toEqual({ hit_dir: true, hit_range: true, deviation: 0 })
    expect(withoutHL).toEqual(withHL)
    // 字段集合恰为契约三字段（无 ok / 无多余）
    expect(Object.keys(withoutHL as object).sort()).toEqual(['deviation', 'hit_dir', 'hit_range'])
  })

  it('独立复现 Issue #2 数字（dir=up）：hit_dir=false, hit_range=true, deviation=0', async () => {
    // range=[48.00,49.20] prevClose=49.75 close=48.67 high=51.16 low=48.05
    // close<prevClose → 实际方向 down；预判 up → 方向未命中；close 落区间内 → 命中。
    await run('predict_make', {
      symbol: '002156', date: '2026-10-16', dir: 'up',
      range_low: 48.0, range_high: 49.2, confidence: 0.6, watch_points: [],
    })
    const v = await run('predict_verify', {
      symbol: '002156', date: '2026-10-16',
      actual_close: 48.67, actual_high: 51.16, actual_low: 48.05, prev_close: 49.75,
    })
    evidence['issue2.dir_up'] = v
    expect(v).toEqual({ hit_dir: false, hit_range: true, deviation: 0 })
  })

  it('Issue #2 数字对照（dir=down）：实际方向 down → hit_dir=true（区间/偏差不变）', async () => {
    await run('predict_make', {
      symbol: '002156', date: '2026-10-17', dir: 'down',
      range_low: 48.0, range_high: 49.2, confidence: 0.6, watch_points: [],
    })
    const v = await run('predict_verify', {
      symbol: '002156', date: '2026-10-17',
      actual_close: 48.67, actual_high: 51.16, actual_low: 48.05, prev_close: 49.75,
    })
    evidence['issue2.dir_down'] = v
    expect(v).toEqual({ hit_dir: true, hit_range: true, deviation: 0 })
  })

  it('不传 high/low 的工具结果与 domain computeHit 直接计算一致（交叉验证）', async () => {
    await run('predict_make', {
      symbol: '002156', date: '2026-10-18', dir: 'up',
      range_low: 48.0, range_high: 49.2, confidence: 0.6, watch_points: [],
    })
    const withoutHL = await run('predict_verify', {
      symbol: '002156', date: '2026-10-18', actual_close: 48.67, prev_close: 49.75,
    })
    const direct = computeHit('up', 48.0, 49.2, { close: 48.67, prevClose: 49.75 })
    expect(withoutHL).toEqual({
      hit_dir: direct.hitDir, hit_range: direct.hitRange, deviation: direct.deviation,
    })
    expect(withoutHL).toEqual({ hit_dir: false, hit_range: true, deviation: 0 })
  })
})

// ── AC3：口径锁定用例独立核验 ──────────────────────────────────────────────
describe('AC3 口径锁定用例独立核验（high 越界但 close 命中 → hit_range=true）', () => {
  it('前提成立：high > range_high 且 low < range_low，同时 range_low ≤ close ≤ range_high', () => {
    const rangeLow = 48.0, rangeHigh = 49.2
    const close = 48.67, high = 51.16, low = 47.8
    expect(high).toBeGreaterThan(rangeHigh)        // high 确实越上界
    expect(low).toBeLessThan(rangeLow)             // low 确实越下界
    expect(close).toBeGreaterThanOrEqual(rangeLow) // close 命中下沿
    expect(close).toBeLessThanOrEqual(rangeHigh)   // close 命中上沿
  })

  it('domain computeHit：high/low 越界不影响，仅依 close → 判命中（有意取舍）', () => {
    const r = computeHit('up', 48.0, 49.2, { close: 48.67, high: 51.16, low: 47.8, prevClose: 48.1 })
    expect(r).toEqual({ hitDir: true, hitRange: true, deviation: 0 })
  })

  it('工具层同场景：actual_high (51.16) 越界但 actual_close (48.67) 命中 → hit_range=true', async () => {
    await run('predict_make', {
      symbol: '002156', date: '2026-10-15', dir: 'up',
      range_low: 48.0, range_high: 49.2, confidence: 0.6, watch_points: [],
    })
    const v = await run('predict_verify', {
      symbol: '002156', date: '2026-10-15',
      actual_close: 48.67, actual_high: 51.16, actual_low: 47.8, prev_close: 48.1,
    })
    evidence['ac3.tool'] = v
    expect(v).toEqual({ hit_dir: true, hit_range: true, deviation: 0 })
  })
})

// ── AC4：判定语义未变 + 回归 ───────────────────────────────────────────────
describe('AC4 判定语义未变：high/low 不参与判定；历史边界回归', () => {
  it('任意改变 high/low，computeHit 结果不变（只依赖 close/prevClose）', () => {
    const a = computeHit('up', 48.0, 49.2, { close: 48.67, high: 51.16, low: 47.8, prevClose: 48.1 })
    const b = computeHit('up', 48.0, 49.2, { close: 48.67, high: 9999, low: -9999, prevClose: 48.1 })
    const c = computeHit('up', 48.0, 49.2, { close: 48.67, prevClose: 48.1 })
    expect(b).toEqual(a)
    expect(c).toEqual(a)
  })

  it('区间上破 / 下破 / flat 边界语义未变', () => {
    expect(computeHit('up', 1.9, 2.1, { close: 2.3, prevClose: 1.95 }))
      .toEqual({ hitDir: true, hitRange: false, deviation: expect.closeTo(0.2, 6) })
    expect(computeHit('up', 1.9, 2.1, { close: 1.85, prevClose: 1.95 }))
      .toEqual({ hitDir: false, hitRange: false, deviation: expect.closeTo(0.05, 6) })
    expect(computeHit('flat', 1.9, 2.1, { close: 1.95, prevClose: 1.95 }))
      .toEqual({ hitDir: true, hitRange: true, deviation: 0 })
    // close 恰等于下沿
    expect(computeHit('up', 1.9, 2.1, { close: 1.9, prevClose: 1.85 }))
      .toEqual({ hitDir: true, hitRange: true, deviation: 0 })
  })

  it('契约改动未增删既有工具：现为 15 个（含 asset_commit）', () => {
    expect(tools.length).toBe(15)
  })
})
