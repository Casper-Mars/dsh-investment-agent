/**
 * Task 7.1 补齐 Task 8 验收缺口 ①②③ 的单元测试。
 *
 * 覆盖：
 *   ① review_metrics.history 仅保留最近 30 条（cached / 即时计算两条路径 + record_metrics 一致性）
 *   ② 多标的批处理上界（>N 标的 → 本轮仅处理 N 并标注截断）+ 单次唤醒文本预算（超长 summary 截断）
 *   ③ 合规声明：ledger_trade / review_* render 输出末尾 + 唤醒正文末尾均含「本内容不构成投资建议」
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Reviews, REVIEW_METRICS_HISTORY_LIMIT, takeRecentHistory } from '../src/domain/reviews.js'
import { createSensorRunner, boundText, DEFAULT_BATCH_LIMIT, DEFAULT_WAKE_TEXT_BUDGET } from '../src/runner/sensor-runner.js'
import { buildWakeText } from '../src/runner/wake.js'
import { createToolContext, type ToolContext } from '../src/tools/context.js'
import { createAllTools } from '../src/tools/index.js'
import { RISK_DISCLAIMER } from '../src/tools/constants.js'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { SensorWakePayload, PtcRuntimeLike, PtcRunSpec, PtcRunResult, PtcRunRequest } from '../src/runner/types.js'

// ---------------------------------------------------------------------------
// ① review_metrics 30 日截断
// ---------------------------------------------------------------------------
describe('① review_metrics.history 仅保留最近 30 条', () => {
  let dir: string
  let reviews: Reviews

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'dsh-finance-t71-reviews-'))
    reviews = new Reviews(dir)
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('即时计算分支：>30 条记录只返回最近 30 条', () => {
    // 构造 35 个交易日（日期升序落库）。
    for (let i = 0; i < 35; i++) {
      const day = String(i + 1).padStart(2, '0')
      const date = `2026-08-${day}` // 08-01 ~ 08-35（非法日期字符串亦可，仅作字典序）
      const c = reviews.review_check('588000', date, {
        decisionTriggered: true, decisionExecuted: true, hit: { hitDir: true, hitRange: true, deviation: 0 },
      })
      reviews.review_report('588000', date, c, { hit: { hitDir: true, hitRange: true, deviation: 0 } })
    }
    const m = reviews.review_metrics('588000')
    expect(m.history).toHaveLength(REVIEW_METRICS_HISTORY_LIMIT)
    // 最近 30 条 = 按日期降序取前 30，再升序返回 → 首条应为第 6 条（08-06）。
    expect(m.history[0].date).toBe('2026-08-06')
    expect(m.history[m.history.length - 1].date).toBe('2026-08-35')
  })

  it('cached 分支：缓存的 history >30 条同样截断', () => {
    const bigHistory = Array.from({ length: 40 }, (_, i) => ({
      symbol: '588000',
      date: `2026-01-${String(i + 1).padStart(2, '0')}`,
      dirHitRate: 0.5,
      rangeHitRate: 0.5,
      cumReturn: 0,
      history: [],
    }))
    reviews.record_metrics('588000', {
      date: '2026-01-31',
      dirHitRate: 0.5,
      rangeHitRate: 0.5,
      cumReturn: 0.1,
      history: bigHistory,
    })
    const m = reviews.review_metrics('588000')
    expect(m.history).toHaveLength(REVIEW_METRICS_HISTORY_LIMIT)
  })

  it('record_metrics 写入时也约束 history 到最近 30 条', () => {
    const bigHistory = Array.from({ length: 50 }, (_, i) => ({
      symbol: '588000',
      date: `2026-01-${String(i + 1).padStart(2, '0')}`,
      dirHitRate: 0.5,
      rangeHitRate: 0.5,
      cumReturn: 0,
      history: [],
    }))
    reviews.record_metrics('588000', {
      date: '2026-01-31',
      dirHitRate: 0.5,
      rangeHitRate: 0.5,
      cumReturn: 0.1,
      history: bigHistory,
    })
    // 读回缓存即截断后的结果。
    const m = reviews.review_metrics('588000')
    expect(m.history).toHaveLength(REVIEW_METRICS_HISTORY_LIMIT)
  })

  it('takeRecentHistory 对乱序输入先按日期降序再取 30', () => {
    const rows = [
      { date: '2026-01-03' },
      { date: '2026-01-01' },
      { date: '2026-01-05' },
      { date: '2026-01-02' },
      { date: '2026-01-04' },
    ]
    const out = takeRecentHistory(rows, 3)
    expect(out.map((r) => r.date)).toEqual(['2026-01-03', '2026-01-04', '2026-01-05'])
  })

  it('不足 30 条时原样返回（不截断）', () => {
    for (let i = 0; i < 5; i++) {
      const date = `2026-09-0${i + 1}`
      const c = reviews.review_check('588000', date, {
        decisionTriggered: true, decisionExecuted: true,
      })
      reviews.review_report('588000', date, c, {})
    }
    expect(reviews.review_metrics('588000').history).toHaveLength(5)
  })
})

// ---------------------------------------------------------------------------
// ② 批处理上界 + 唤醒文本预算
// ---------------------------------------------------------------------------
function makeRegistry(code = 'return { shouldWake: true, symbol: "588000", summary: "s" }') {
  return {
    current: vi.fn(() => ({ version: 'v001', changeType: 'keep' as const, ts: '' })),
    read: vi.fn(() => ({ meta: { version: 'v001', changeType: 'keep' as const, ts: '' }, rationale: 'r', code })),
  }
}
function makeLedger(symbols: string[]) {
  const snapshots = symbols.map((s) => ({ symbol: s, type: 'etf' as const, name: null, qty: 100, avgCost: 1 }))
  return { list: vi.fn(() => snapshots), query: vi.fn() }
}
function makeQuotes() {
  return { realtime: vi.fn(), intraday: vi.fn(), history: vi.fn() }
}
function makeRuntime(): { runtime: PtcRuntimeLike; requests: PtcRunRequest[] } {
  const requests: PtcRunRequest[] = []
  const runtime: PtcRuntimeLike = {
    resolve(r: PtcRunRequest): PtcRunSpec {
      requests.push(r)
      return { ...r, cwd: r.cwd ?? '/t', timeoutMs: r.timeoutMs ?? 1000 }
    },
    async run(_s: PtcRunSpec): Promise<PtcRunResult> {
      return { logs: [], value: { shouldWake: true, symbol: '588000', summary: 's' } }
    },
  }
  return { runtime, requests }
}

describe('② 批处理上界与唤醒文本预算', () => {
  it('标的 > batchLimit 时 runReview 仅处理前 N 个并标注截断', async () => {
    const symbols = Array.from({ length: 25 }, (_, i) => `SYM${String(i).padStart(3, '0')}`)
    const waker = vi.fn((_p: SensorWakePayload) => 1)
    const { runtime } = makeRuntime()
    const runner = createSensorRunner({
      senseRegistry: makeRegistry(),
      ledger: makeLedger(symbols),
      quotes: makeQuotes(),
      ptcRuntime: runtime,
      dataRoot: '/r',
      logger: () => {},
      waker,
      wakeCooldownMs: 0,
      batchLimit: 10,
    })
    const outcome = await runner.runReview()
    expect(outcome.kind).toBe('woke')
    const payload = waker.mock.calls[0][0]
    expect(payload.metrics).toMatchObject({ symbols: symbols.slice(0, 10), truncated: true })
    expect(payload.metrics.symbols).toHaveLength(10)
  })

  it('标的 > 默认上界时标注截断（DEFAULT_BATCH_LIMIT）', async () => {
    const symbols = Array.from({ length: DEFAULT_BATCH_LIMIT + 3 }, (_, i) => `SYM${i}`)
    const waker = vi.fn((_p: SensorWakePayload) => 1)
    const { runtime } = makeRuntime()
    const runner = createSensorRunner({
      senseRegistry: makeRegistry(),
      ledger: makeLedger(symbols),
      quotes: makeQuotes(),
      ptcRuntime: runtime,
      dataRoot: '/r',
      logger: () => {},
      waker,
      wakeCooldownMs: 0,
    })
    await runner.runReview()
    const payload = waker.mock.calls[0][0]
    expect(payload.metrics.symbols).toHaveLength(DEFAULT_BATCH_LIMIT)
    expect(payload.metrics.truncated).toBe(true)
  })

  it('标的 ≤ 上界时不截断、不标注', async () => {
    const waker = vi.fn((_p: SensorWakePayload) => 1)
    const { runtime } = makeRuntime()
    const runner = createSensorRunner({
      senseRegistry: makeRegistry(),
      ledger: makeLedger(['A', 'B']),
      quotes: makeQuotes(),
      ptcRuntime: runtime,
      dataRoot: '/r',
      logger: () => {},
      waker,
      wakeCooldownMs: 0,
      batchLimit: 5,
    })
    await runner.runReview()
    const payload = waker.mock.calls[0][0]
    expect(payload.metrics.truncated).toBeUndefined()
    expect(payload.metrics.symbols).toEqual(['A', 'B'])
  })

  it('超长 summary 被文本预算截断（run 路径）', async () => {
    const longSummary = 'x'.repeat(3000)
    const { runtime } = makeRuntime()
    const waker = vi.fn((_p: SensorWakePayload) => 1)
    const runner = createSensorRunner({
      senseRegistry: makeRegistry(`return { shouldWake: true, symbol: "588000", summary: "${longSummary}" }`),
      ledger: makeLedger(['588000']),
      quotes: makeQuotes(),
      ptcRuntime: runtime,
      dataRoot: '/r',
      logger: () => {},
      waker,
      wakeCooldownMs: 0,
      wakeTextBudget: 100,
    })
    const outcome = await runner.run('pulse')
    expect(outcome.kind).toBe('woke')
    const payload = waker.mock.calls[0][0]
    expect(payload.summary.length).toBeLessThanOrEqual(100)
  })

  it('boundText：超限截断、未超限原样、≤0 返回空', () => {
    expect(boundText('hello', 10)).toBe('hello')
    expect(boundText('hello world', 5).length).toBeLessThanOrEqual(5)
    expect(boundText('hello world', 5).endsWith('…')).toBe(true)
    expect(boundText('hello', 0)).toBe('')
  })
})

// ---------------------------------------------------------------------------
// ③ 合规声明
// ---------------------------------------------------------------------------
describe('③ 合规声明「本内容不构成投资建议」', () => {
  let dir: string
  let ctx: ToolContext
  let tools: ToolDefinition[]

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'dsh-finance-t71-tools-'))
    ctx = createToolContext({ dataRoot: dir })
    tools = createAllTools(ctx)
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  const render = (name: string, value: unknown): string => {
    const t = tools.find((x) => x.name === name)
    if (!t) throw new Error(`工具 ${name} 未注册`)
    const blocks = t.output.render({}, value) as Array<{ type: string; text: string }>
    return blocks.map((b) => b.text).join('\n')
  }

  it('唤醒正文末尾含合规声明', () => {
    const text = buildWakeText({ reason: 'pulse', symbol: '588000', summary: '偏离均线' })
    expect(text).toContain(RISK_DISCLAIMER)
    // 声明应在末尾。
    expect(text.trimEnd().endsWith(RISK_DISCLAIMER)).toBe(true)
  })

  it('ledger_trade render 末尾含合规声明', () => {
    const text = render('ledger_trade', { ok: true, trade_id: 't1', new_qty: 1100, avg_cost: 2.0 })
    expect(text).toContain(RISK_DISCLAIMER)
  })

  it('review_check / report / metrics / retrospect render 末尾含合规声明', () => {
    expect(render('review_check', { decision_triggered: true, decision_executed: true, notes: 'n' })).toContain(RISK_DISCLAIMER)
    expect(render('review_report', { ok: true, report_id: 'rv_1' })).toContain(RISK_DISCLAIMER)
    expect(render('review_metrics', { dir_hit_rate: 0.5, range_hit_rate: 0.5, cum_return: 0.1, history: [] })).toContain(RISK_DISCLAIMER)
    expect(render('review_retrospect', { root_cause: 'x', improvements: [] })).toContain(RISK_DISCLAIMER)
  })

  it('只读查询工具（ledger_list）不加合规声明', () => {
    const text = render('ledger_list', { symbols: [{ symbol: '588000', type: 'etf', name: null, qty: 100, avg_cost: 1 }] })
    expect(text).not.toContain(RISK_DISCLAIMER)
  })
})