/**
 * Task 7.1 复验 —— 独立验证 3 个补齐的验收缺口。
 *
 * 与 tests/task71-gaps.test.ts 互补：本文件重点补边界场景（乱序日期、
 * batchLimit=0、超长 summary、标的隔离回归、只读工具不加声明、cumReturn 回归）。
 *
 * 验收标准逐条覆盖：
 *   ① review_metrics.history 仅保留最近 30 个交易日（cached / 即时计算 / record_metrics 三路径一致 + 乱序 + <30 全返回）
 *   ② 批处理上界可配置 + 唤醒文本预算可配置（batchLimit=0 关闭 / 截断标注 / 标的隔离不破坏）
 *   ③ 合规声明：唤醒正文 + 写/决策类工具 render 末尾；只读查询工具不加
 *   ④ cumReturn 未动（回归：勿按新公式断言）
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  Reviews,
  REVIEW_METRICS_HISTORY_LIMIT,
  takeRecentHistory,
} from '../src/domain/reviews.js'
import {
  createSensorRunner,
  boundText,
  DEFAULT_BATCH_LIMIT,
  DEFAULT_WAKE_TEXT_BUDGET,
} from '../src/runner/sensor-runner.js'
import { buildWakeText, buildWakeMessage, boundSummary } from '../src/runner/wake.js'
import { createToolContext, type ToolContext } from '../src/tools/context.js'
import { createAllTools } from '../src/tools/index.js'
import { RISK_DISCLAIMER, withDisclaimer } from '../src/tools/constants.js'
import { cumReturn, hitRate, isBelowThreshold } from '../src/domain/metrics.js'
import type { Trade } from '../src/domain/types.js'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type {
  SensorWakePayload,
  PtcRuntimeLike,
  PtcRunSpec,
  PtcRunResult,
  PtcRunRequest,
  SensorRunOutcome,
} from '../src/runner/types.js'

// ---------------------------------------------------------------------------
// ① review_metrics.history 仅保留最近 30 个交易日
// ---------------------------------------------------------------------------
describe('① 30 日截断（独立边界复验）', () => {
  let dir: string
  let reviews: Reviews

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'dsh-finance-rev-t71-'))
    reviews = new Reviews(dir)
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('乱序日期 35 条 → 恰 30 条、为最近 30 个交易日', () => {
    // 构造 35 条乱序日期（YYYY-MM-DD 真实日期，字典序可靠）。
    const dates: string[] = []
    for (let i = 0; i < 35; i++) {
      const d = new Date(2026, 6, 1 + i) // 2026-07-01 起 35 天
      dates.push(d.toISOString().slice(0, 10))
    }
    // 打乱落库顺序（逆序 + 交错）。
    const shuffled = [...dates].reverse()
    for (const date of shuffled) {
      const c = reviews.review_check('588000', date, {
        decisionTriggered: true,
        decisionExecuted: true,
        hit: { hitDir: true, hitRange: false, deviation: 0 },
      })
      reviews.review_report('588000', date, c, {
        hit: { hitDir: true, hitRange: false, deviation: 0 },
      })
    }
    const m = reviews.review_metrics('588000')

    // 恰 30 条。
    expect(m.history).toHaveLength(REVIEW_METRICS_HISTORY_LIMIT)

    // 为最近 30 个交易日（日期升序返回）：最早 = 第 6 天，最晚 = 第 35 天。
    const sortedDates = [...dates].sort()
    expect(m.history[0].date).toBe(sortedDates[sortedDates.length - 30])
    expect(m.history[m.history.length - 1].date).toBe(sortedDates[sortedDates.length - 1])

    // 全为升序、无重复。
    for (let i = 1; i < m.history.length; i++) {
      expect(m.history[i].date > m.history[i - 1].date).toBe(true)
    }
  })

  it('cached 路径：缓存 history >30 条回读即截断', () => {
    const bigHistory = Array.from({ length: 45 }, (_, i) => {
      const d = new Date(2026, 0, 1 + i)
      return {
        symbol: '000001',
        date: d.toISOString().slice(0, 10),
        dirHitRate: 0.5,
        rangeHitRate: 0.5,
        cumReturn: 0,
        history: [],
      }
    })
    reviews.record_metrics('000001', {
      date: '2026-01-31',
      dirHitRate: 0.5,
      rangeHitRate: 0.5,
      cumReturn: 0.1,
      history: bigHistory,
    })
    const m = reviews.review_metrics('000001')
    expect(m.history).toHaveLength(REVIEW_METRICS_HISTORY_LIMIT)
    // 缓存命中率/收益率透传不变。
    expect(m.dirHitRate).toBe(0.5)
    expect(m.cumReturn).toBe(0.1)
  })

  it('record_metrics 写入时即约束 history 到 30 条（写后回读一致）', () => {
    const bigHistory = Array.from({ length: 60 }, (_, i) => {
      const d = new Date(2026, 0, 1 + i)
      return {
        symbol: '000001',
        date: d.toISOString().slice(0, 10),
        dirHitRate: 0.4,
        rangeHitRate: 0.4,
        cumReturn: 0,
        history: [],
      }
    })
    reviews.record_metrics('000001', {
      date: '2026-01-31',
      dirHitRate: 0.4,
      rangeHitRate: 0.4,
      cumReturn: 0.2,
      history: bigHistory,
    })
    const m = reviews.review_metrics('000001')
    expect(m.history).toHaveLength(REVIEW_METRICS_HISTORY_LIMIT)
  })

  it('<30 条时全返回、不截断、不丢', () => {
    for (let i = 0; i < 8; i++) {
      const d = new Date(2026, 8, 1 + i)
      const date = d.toISOString().slice(0, 10)
      const c = reviews.review_check('588000', date, {
        decisionTriggered: true,
        decisionExecuted: false,
      })
      reviews.review_report('588000', date, c, {})
    }
    expect(reviews.review_metrics('588000').history).toHaveLength(8)
  })

  it('takeRecentHistory：空数组、limit=0、恰好等于 limit 的边界', () => {
    expect(takeRecentHistory([], 30)).toEqual([])
    const rows = [
      { date: '2026-01-01' },
      { date: '2026-01-02' },
      { date: '2026-01-03' },
    ]
    // limit=0 → 空。
    expect(takeRecentHistory(rows, 0)).toEqual([])
    // limit 大于长度 → 全返回（升序）。
    expect(takeRecentHistory(rows, 10).map((r) => r.date)).toEqual([
      '2026-01-01',
      '2026-01-02',
      '2026-01-03',
    ])
    // 恰好等于长度 → 全返回。
    expect(takeRecentHistory(rows, 3).map((r) => r.date)).toEqual([
      '2026-01-01',
      '2026-01-02',
      '2026-01-03',
    ])
  })
})

// ---------------------------------------------------------------------------
// ② 批处理上界 + 唤醒文本预算
// ---------------------------------------------------------------------------
function makeRegistry(code = 'return { shouldWake: true, symbol: "588000", summary: "s" }') {
  return {
    current: vi.fn(() => ({ version: 'v001', changeType: 'keep' as const, ts: '' })),
    read: vi.fn(() => ({
      meta: { version: 'v001', changeType: 'keep' as const, ts: '' },
      rationale: 'r',
      code,
    })),
  }
}
function makeLedger(symbols: string[]) {
  const snapshots = symbols.map((s) => ({
    symbol: s,
    type: 'etf' as const,
    name: null,
    qty: 100,
    avgCost: 1,
  }))
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

describe('② 批处理上界与唤醒文本预算（独立边界复验）', () => {
  it('batchLimit=0 关闭截断 → 全量处理、不标注', async () => {
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
      batchLimit: 0,
    })
    const outcome = await runner.runReview()
    expect(outcome.kind).toBe('woke')
    const payload = waker.mock.calls[0][0]
    expect(payload.metrics.symbols).toHaveLength(25)
    expect(payload.metrics.truncated).toBeUndefined()
  })

  it('默认 batchLimit 生效（DEFAULT_BATCH_LIMIT=20），>20 截断并标注', async () => {
    expect(DEFAULT_BATCH_LIMIT).toBe(20)
    const symbols = Array.from({ length: 23 }, (_, i) => `S${i}`)
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

  it('唤醒文本预算（默认 2000）：超长 summary 截断到预算内', async () => {
    expect(DEFAULT_WAKE_TEXT_BUDGET).toBe(2000)
    const longSummary = '盘后复盘：标的偏离均线告警。'.repeat(200) // 远超 2000
    const { runtime } = makeRuntime()
    const waker = vi.fn((_p: SensorWakePayload) => 1)
    const runner = createSensorRunner({
      senseRegistry: makeRegistry(
        `return { shouldWake: true, symbol: "588000", summary: ${JSON.stringify(longSummary)}, metrics: { alert: 1 } }`,
      ),
      ledger: makeLedger(['588000']),
      quotes: makeQuotes(),
      ptcRuntime: runtime,
      dataRoot: '/r',
      logger: () => {},
      waker,
      wakeCooldownMs: 0,
    })
    const outcome = await runner.run('pulse')
    expect(outcome.kind).toBe('woke')
    const payload = waker.mock.calls[0][0]
    // summary 长度应 ≤ 预算（这里以默认预算衡量）。
    expect(payload.summary.length).toBeLessThanOrEqual(DEFAULT_WAKE_TEXT_BUDGET)
  })

  it('预算内 summary 不加省略号（未超限原样）', async () => {
    // 用 runReview 路径：summary 由 buildSummary 生成（短而可控），不受 runtime mock 影响。
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
      wakeTextBudget: 2000,
    })
    await runner.runReview()
    const payload = waker.mock.calls[0][0]
    // summary 短于预算，应原样保留（不含省略号）。
    expect(payload.summary).toContain('盘后复盘')
    expect(payload.summary.endsWith('…')).toBe(false)
    expect(payload.summary.length).toBeLessThanOrEqual(2000)
  })

  it('boundText / boundSummary 边界一致', () => {
    expect(boundText('abc', 10)).toBe('abc')
    expect(boundText('abcdefghij', 5).length).toBeLessThanOrEqual(5)
    expect(boundText('abc', 0)).toBe('')
    expect(boundText('abc', -1)).toBe('')
    expect(boundSummary('短', 10)).toBe('短')
    expect(boundSummary('长文本摘要很长很长', 4).length).toBeLessThanOrEqual(4)
  })
})

// ---------------------------------------------------------------------------
// ②附加：标的间隔离回归（补的批处理逻辑不破坏隔离）
// ---------------------------------------------------------------------------
describe('标的隔离回归（批处理逻辑未破坏隔离）', () => {
  let dir: string
  let ctx: ToolContext

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'dsh-finance-rev-iso-'))
    ctx = createToolContext({ dataRoot: dir })
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('A/B 两标的台账、预判、复盘互不影响', () => {
    // A 标的做完整链路。
    ctx.ledger.init('AAA', { type: 'etf', name: 'A', qty: 1000, cost: 2.0, cash: 0 })
    ctx.ledger.trade('AAA', { side: 'buy', qty: 500, price: 2.2 })
    ctx.predicts.predict_make('AAA', '2026-09-01', {
      dir: 'up',
      rangeLow: 2.0,
      rangeHigh: 3.0,
      confidence: 0.8,
      watchPoints: ['放量'],
    })
    ctx.reviews.review_report(
      'AAA',
      '2026-09-01',
      { decisionTriggered: true, decisionExecuted: true, notes: 'ok' },
      {},
    )

    // B 标的独立初始化。
    ctx.ledger.init('BBB', { type: 'stock', name: 'B', qty: 100, cost: 10, cash: 0 })

    // B 的台账不受 A 影响。
    expect(ctx.ledger.query('BBB').qty).toBe(100)
    expect(ctx.ledger.query('AAA').qty).toBe(1500) // 1000 + 500

    // B 的预判为空。
    expect(ctx.predicts.predict_get('BBB', '2026-09-01').prediction).toBeNull()

    // B 的复盘 metrics 为空历史。
    expect(ctx.reviews.review_metrics('BBB').history).toEqual([])

    // A 的 metrics 历史仅含自身（1 条）。
    const am = ctx.reviews.review_metrics('AAA')
    expect(am.history).toHaveLength(1)
    expect(am.history[0].symbol).toBe('AAA')
  })
})

// ---------------------------------------------------------------------------
// ③ 合规声明
// ---------------------------------------------------------------------------
describe('③ 合规声明「本内容不构成投资建议」（独立边界复验）', () => {
  let dir: string
  let ctx: ToolContext
  let tools: ToolDefinition[]

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'dsh-finance-rev-disc-'))
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
  const endsWithDisclaimer = (name: string, value: unknown) => {
    const text = render(name, value)
    expect(text.trimEnd().endsWith(RISK_DISCLAIMER)).toBe(true)
    return text
  }

  it('唤醒正文末尾含合规声明（buildWakeText / buildWakeMessage 一致）', () => {
    const text = buildWakeText({
      reason: 'review',
      symbol: '*',
      summary: '盘后复盘',
      metrics: { symbols: ['A'] },
    })
    expect(text.trimEnd().endsWith(RISK_DISCLAIMER)).toBe(true)

    const msg = buildWakeMessage({ reason: 'pulse', symbol: '588000', summary: 'x' })
    const body = msg.content[0]?.text ?? ''
    expect(body.trimEnd().endsWith(RISK_DISCLAIMER)).toBe(true)
  })

  it('写/决策类工具 render 末尾含声明', () => {
    endsWithDisclaimer('ledger_trade', {
      ok: true,
      trade_id: 't1',
      new_qty: 1100,
      avg_cost: 2.0,
    })
    endsWithDisclaimer('review_check', {
      decision_triggered: true,
      decision_executed: true,
      notes: 'n',
    })
    endsWithDisclaimer('review_report', { ok: true, report_id: 'rv_1' })
    endsWithDisclaimer('review_metrics', {
      dir_hit_rate: 0.5,
      range_hit_rate: 0.5,
      cum_return: 0.1,
      history: [],
    })
    endsWithDisclaimer('review_retrospect', {
      root_cause: 'x',
      improvements: [],
    })
  })

  it('只读查询工具 render 不含声明', () => {
    expect(render('ledger_list', {
      symbols: [{ symbol: '588000', type: 'etf', name: null, qty: 100, avg_cost: 1 }],
    })).not.toContain(RISK_DISCLAIMER)

    expect(render('ledger_query', {
      symbol: '588000',
      type: 'etf',
      name: null,
      qty: 100,
      avg_cost: 1,
      cash: 0,
      realized_pnl: 0,
      float_pnl: 0,
    })).not.toContain(RISK_DISCLAIMER)

    expect(render('predict_get', {
      prediction: {
        dir: 'up',
        range_low: 2,
        range_high: 3,
        confidence: 0.8,
        watch_points: ['x'],
      },
    })).not.toContain(RISK_DISCLAIMER)

    expect(render('sense_archive_get', {
      rationale: 'r',
      code: 'c',
      meta: { version: 'v001', change_type: 'replace', parent: null, trigger: null, ts: '' },
    })).not.toContain(RISK_DISCLAIMER)
  })

  it('withDisclaimer 末尾追加、含裸声明字符串', () => {
    expect(withDisclaimer('正文').endsWith(RISK_DISCLAIMER)).toBe(true)
    expect(withDisclaimer('正文')).toContain(RISK_DISCLAIMER)
  })
})

// ---------------------------------------------------------------------------
// ④ cumReturn 未动（回归：勿按新公式断言）
// ---------------------------------------------------------------------------
describe('④ cumReturn 未动（回归）', () => {
  it('沿用 Task 2 既有 metrics.test.ts 期望：买低卖高 → 0.375', () => {
    const trades: Trade[] = [
      { id: '1', symbol: '588000', side: 'buy', qty: 1000, price: 2.0, ts: 1 },
      { id: '2', symbol: '588000', side: 'sell', qty: 500, price: 2.5, ts: 2 },
      { id: '3', symbol: '588000', side: 'sell', qty: 500, price: 3.0, ts: 3 },
    ]
    expect(cumReturn(trades)).toBeCloseTo(0.375, 4)
  })

  it('买高卖低 → -0.3333（回归不变）', () => {
    const trades: Trade[] = [
      { id: '1', symbol: '588000', side: 'buy', qty: 1000, price: 3.0, ts: 1 },
      { id: '2', symbol: '588000', side: 'sell', qty: 1000, price: 2.0, ts: 2 },
    ]
    expect(cumReturn(trades)).toBeCloseTo(-0.3333, 4)
  })

  it('空流水 → 0；hitRate 口径不变', () => {
    expect(cumReturn([])).toBe(0)
    const r = hitRate([true, true, false, true], [true, false, false, true])
    expect(r.dir).toBe(0.75)
    expect(r.range).toBe(0.5)
  })

  it('isBelowThreshold 合法阈值 false / 负下限 true（不变）', () => {
    expect(
      isBelowThreshold('588000', { dirHitMin: 0.6, cumReturnMin: 0, missStreakMax: 3 }),
    ).toBe(false)
    expect(
      isBelowThreshold('588000', { dirHitMin: -0.1, cumReturnMin: 0, missStreakMax: 3 }),
    ).toBe(true)
  })
})