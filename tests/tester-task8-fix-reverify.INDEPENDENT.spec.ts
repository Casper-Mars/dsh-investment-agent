/**
 * tester-task8-fix-reverify.INDEPENDENT.spec.ts
 * —— Task 8（t100357）AC2「cum_return 口径」修复复验（Tester 独立用例）。
 *
 * 背景：端到端验收发现 `review_metrics.cum_return` 恒为 0（AC2 口径未落地），
 *   Developer 以 commit 4c233b5 修复。本文件为 Tester 的**独立复验**，
 *   **不复用** Developer 的 tests/metrics.test.ts / tests/reviews.test.ts。
 *
 * 复验目标：
 *   1) AC2：cum_return 不再为 0，且精确 = (期末市值 + 累计 realized - 期初资金)/期初资金。
 *      - 场景 S1（任务书给定）：init(50000,1000,2.00) → sell 500@3.0 → -0.9615
 *      - 场景 S2（盈利方向）：init(1000,1000,2.00)  → sell 1000@6.0 → +0.3333
 *      - 除零 / 未初始化标的 → 回落 0 且不抛错
 *   2) 工具层端到端（真实 ToolRuntime registry）AC2 落地。
 *   3) 未接 ledger 时回落 0（防 tester-independent-verify 回归）。
 *
 * 独立性：期望值均由「场景参数手算」得到，不调用被测实现反推。
 * 硬约束：只新增测试文件，不改动 src/**。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import ToolRuntime, { type ToolDefinition } from '@deepseek-ai/dsh-tools'
import { Ledger } from '../src/domain/ledger.js'
import { Reviews } from '../src/domain/reviews.js'
import { cumReturnOnCapital } from '../src/domain/metrics.js'
import { registerAllTools } from '../src/tools/index.js'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dsh-finance-t8-fix-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

/** 四舍五入到 4 位（与被测实现同口径，仅用于对齐断言精度）。 */
const r4 = (v: number): number => Math.round((v + Number.EPSILON) * 10000) / 10000

/* ================================================================== *
 * 一、域层独立复验：精确口径
 * ================================================================== */

describe('S1 · AC2 口径复验：init(50000,1000,2.00) → sell 500@3.0', () => {
  it('review_metrics 的 cum_return 精确 = (1500+500-52000)/52000 = -0.9615（且不为 0）', () => {
    const ledger = new Ledger(dir)
    ledger.init('588000', { type: 'etf', name: 'T', qty: 1000, cost: 2.0, cash: 50000 })
    ledger.trade('588000', { side: 'sell', qty: 500, price: 3.0 })
    const reviews = new Reviews(dir, ledger)

    // 独立手算（不复用被测反推逻辑）：
    //   期初资金 = 初始 cash 50000 + 初始持仓成本 1000×2.00 = 52000
    //   期末持仓 = 500；现价（缺省=最近成交价 3.0）→ 期末市值 = 500×3.0 = 1500
    //   累计 realized = (3.0-2.00)×500 = 500
    const expected = r4((1500 + 500 - 52000) / 52000) // = -0.9615
    const m = reviews.review_metrics('588000')
    console.log(
      `[EVIDENCE AC2-S1] cum_return=${m.cumReturn}  expected=${expected}  (期望 -0.9615)`,
    )
    expect(m.cumReturn).not.toBe(0)
    expect(m.cumReturn).toBeCloseTo(expected, 6)
    expect(m.cumReturn).toBeCloseTo(-0.9615, 4)
  })

  it('显式传现价 3.0 与缺省（回落最近成交价）结果一致', () => {
    const ledger = new Ledger(dir)
    ledger.init('588000', { type: 'etf', name: 'T', qty: 1000, cost: 2.0, cash: 50000 })
    ledger.trade('588000', { side: 'sell', qty: 500, price: 3.0 })
    const reviews = new Reviews(dir, ledger)

    const byDefault = reviews.review_metrics('588000')
    const byExplicit = reviews.review_metrics('588000', 3.0)
    console.log(
      `[EVIDENCE AC2-S1] default=${byDefault.cumReturn} explicit=${byExplicit.cumReturn}`,
    )
    expect(byDefault.cumReturn).toBe(byExplicit.cumReturn)
  })
})

describe('S2 · AC2 盈利方向复验：init(1000,1000,2.00) → sell 1000@6.0', () => {
  it('正收益方向正确：cum_return = (0+4000-3000)/3000 = +0.3333', () => {
    const ledger = new Ledger(dir)
    ledger.init('000001', { type: 'stock', name: 'B', qty: 1000, cost: 2.0, cash: 1000 })
    // 卖出全部 1000 @ 6.0：realized = (6.0-2.0)×1000 = 4000
    ledger.trade('000001', { side: 'sell', qty: 1000, price: 6.0 })
    const reviews = new Reviews(dir, ledger)

    // 独立手算：
    //   期初资金 = 初始 cash 1000 + 初始持仓成本 1000×2.00 = 3000
    //   期末持仓 = 0；现价（缺省=最近成交价 6.0）→ 期末市值 = 0
    //   累计 realized = 4000 → (0 + 4000 - 3000)/3000 = +0.3333
    const expected = r4((0 + 4000 - 3000) / 3000)
    const m = reviews.review_metrics('000001')
    console.log(
      `[EVIDENCE AC2-S2] cum_return=${m.cumReturn}  expected=${expected}  (期望 +0.3333)`,
    )
    expect(m.cumReturn).toBeGreaterThan(0)
    expect(m.cumReturn).toBeCloseTo(0.3333, 4)
    expect(m.cumReturn).toBeCloseTo(expected, 6)
  })
})

describe('S3 · 除零 / 未初始化回落 0 且不抛错', () => {
  it('未初始化标的 → cum_return=0，不抛错', () => {
    const ledger = new Ledger(dir)
    const reviews = new Reviews(dir, ledger)
    let m!: ReturnType<Reviews['review_metrics']>
    expect(() => {
      m = reviews.review_metrics('999999')
    }).not.toThrow()
    console.log(`[EVIDENCE AC2-S3] 未初始化标的 cum_return=${m.cumReturn}`)
    expect(m.cumReturn).toBe(0)
  })

  it('期初资金=0（init cash=0 且成本=0）→ 防除零回落 0', () => {
    const ledger = new Ledger(dir)
    ledger.init('000002', { type: 'stock', name: 'Z', qty: 100, cost: 0, cash: 0 })
    const reviews = new Reviews(dir, ledger)
    const m = reviews.review_metrics('000002')
    console.log(`[EVIDENCE AC2-S3] 期初资金=0 cum_return=${m.cumReturn}`)
    expect(m.cumReturn).toBe(0)
  })

  it('cumReturnOnCapital 直接单测：initialCapital 非法（0/NaN/Infinity）→ 0', () => {
    expect(cumReturnOnCapital({ finalQty: 1, finalPrice: 1, realizedPnl: 9, initialCapital: 0 })).toBe(0)
    expect(cumReturnOnCapital({ finalQty: 1, finalPrice: 1, realizedPnl: 9, initialCapital: NaN })).toBe(0)
    expect(cumReturnOnCapital({ finalQty: 1, finalPrice: 1, realizedPnl: 9, initialCapital: Infinity })).toBe(0)
  })
})

/* ================================================================== *
 * 二、工具层端到端（真实 registry）AC2 落地
 * ================================================================== */

interface RegistryResult {
  isError: boolean
  value?: unknown
  content: Array<{ type: string; text?: string }>
}
interface ToolBox {
  schemas: () => Array<{ name: string }>
  execute: (input: unknown) => Promise<RegistryResult>
}

function systemPromptStub() {
  return {
    name: 'systemPrompt',
    tools() {},
    section() {},
    getSectionOrder() {
      return 0
    },
  } as unknown as never
}

async function bootRegistry(
  dataRoot: string,
  quotes: { realtime: (s: string) => Promise<{ price: number; status: string }> },
): Promise<{ tools: ToolBox; dispose: () => Promise<void> }> {
  const app = new Context()
  app.provide('systemPrompt', systemPromptStub())
  const toolsFiber = (await app.plugin(ToolRuntime as never)) as unknown as {
    dispose: () => Promise<void>
  }
  const pluginFiber = app.plugin({
    name: 'dsh-finance-tools',
    inject: ['tools'],
    apply(ctx: Context) {
      registerAllTools(ctx, { dataRoot, quotes })
    },
  } as never) as unknown as { dispose: () => Promise<void> }
  const tools = (app as unknown as { tools: ToolBox }).tools
  await vi.waitFor(() => expect(tools.schemas()).toHaveLength(14), {
    timeout: 5000,
    interval: 10,
  })
  return {
    tools,
    async dispose() {
      await pluginFiber.dispose()
      await toolsFiber.dispose()
    },
  }
}

let seq = 0
function call(tools: ToolBox, name: string, args: Record<string, unknown>): Promise<RegistryResult> {
  seq += 1
  return tools.execute({
    callId: `t8fix-${seq}`,
    name,
    arguments: args,
    signal: new AbortController().signal,
  })
}

type MetricsValue = {
  dir_hit_rate: number
  range_hit_rate: number
  cum_return: number
  history: unknown[]
}

describe('T1 · 工具层端到端：review_metrics 透出非零 cum_return（行情源给价 3.0）', () => {
  it('ledger_init → ledger_trade(卖出) → review_metrics → cum_return=-0.9615', async () => {
    const quotes = {
      realtime: async () => ({ price: 3.0, status: 'trading' }),
    }
    const { tools, dispose } = await bootRegistry(dir, quotes)
    try {
      const init = await call(tools, 'ledger_init', {
        symbol: '588000',
        type: 'etf',
        init_qty: 1000,
        init_cost: 2.0,
        init_cash: 50000,
      })
      expect(init.isError).toBe(false)
      const sell = await call(tools, 'ledger_trade', {
        symbol: '588000',
        side: 'sell',
        qty: 500,
        price: 3.0,
      })
      expect(sell.isError).toBe(false)

      const res = await call(tools, 'review_metrics', { symbol: '588000' })
      expect(res.isError).toBe(false)
      const m = res.value as MetricsValue
      console.log(
        `[EVIDENCE AC2-TOOL] cum_return=${m.cum_return}（行情供给现价 3.0，期望 -0.9615）`,
      )
      expect(m.cum_return).not.toBe(0)
      expect(m.cum_return).toBeCloseTo(-0.9615, 4)
    } finally {
      await dispose()
    }
  })
})

describe('T2 · 工具层端到端：行情缺省（undefined）→ 回落最近成交价仍非零', () => {
  it('quotes 返回 undefined → resolvePrice 回落 → cum_return=-0.9615', async () => {
    // 模拟行情不可用：realtime 抛错，resolvePrice 捕获后回落（缺省=最近成交价）。
    const quotes = {
      realtime: async () => {
        throw new Error('feed down')
      },
    }
    const { tools, dispose } = await bootRegistry(dir, quotes)
    try {
      await call(tools, 'ledger_init', { symbol: '588000', type: 'etf', init_qty: 1000, init_cost: 2.0, init_cash: 50000 })
      await call(tools, 'ledger_trade', { symbol: '588000', side: 'sell', qty: 500, price: 3.0 })

      const res = await call(tools, 'review_metrics', { symbol: '588000' })
      expect(res.isError).toBe(false)
      const m = res.value as MetricsValue
      console.log(`[EVIDENCE AC2-TOOL] 行情缺省回落 cum_return=${m.cum_return}（期望 -0.9615）`)
      expect(m.cum_return).not.toBe(0)
      expect(m.cum_return).toBeCloseTo(-0.9615, 4)
    } finally {
      await dispose()
    }
  })

  it('未初始化标的经工具层 → cum_return=0 且非 isError', async () => {
    const quotes = { realtime: async () => ({ price: 10, status: 'trading' }) }
    const { tools, dispose } = await bootRegistry(dir, quotes)
    try {
      const res = await call(tools, 'review_metrics', { symbol: '999999' })
      expect(res.isError).toBe(false)
      const m = res.value as MetricsValue
      console.log(`[EVIDENCE AC2-TOOL] 未初始化标的 cum_return=${m.cum_return}`)
      expect(m.cum_return).toBe(0)
    } finally {
      await dispose()
    }
  })
})

describe('R2 · 未接 ledger → cum_return 回落 0（tester-independent-verify 回归）', () => {
  it('new Reviews(dir)（无 ledger）→ review_metrics.cumReturn === 0', () => {
    const solo = new Reviews(dir)
    expect(solo.review_metrics('588000').cumReturn).toBe(0)
  })
})

/* ================================================================== *
 * 四、AC2 附带口径：dir_hit_rate / history 未被修复破坏
 * ================================================================== */

describe('R3 · AC2 其他子项（命中率 / history）未回归', () => {
  it('dir_hit_rate=命中数/已校验数；history 保留最近 30 日', () => {
    const reviews = new Reviews(dir)
    // 3 日：2 命中 1 未命中 → 2/3。
    for (let i = 0; i < 3; i += 1) {
      const d = `2026-09-2${i + 1}`
      const hit = { hitDir: i < 2, hitRange: i < 2, deviation: 0 }
      const c = reviews.review_check('588000', d, {
        decisionTriggered: true,
        decisionExecuted: true,
        hit,
      })
      reviews.review_report('588000', d, c, { hit })
    }
    const m = reviews.review_metrics('588000')
    console.log(`[EVIDENCE AC2-R3] dir_hit_rate=${m.dirHitRate}（期望 0.6667）`)
    expect(m.dirHitRate).toBeCloseTo(2 / 3, 4)
    expect(m.history.length).toBe(3)

    // 注入 35 日 → history 截断到 30。
    const many = new Reviews(dir)
    for (let i = 0; i < 35; i += 1) {
      const day = String(i + 1).padStart(2, '0')
      const d = `2026-08-${day}`
      const c = many.review_check('T', d, { decisionTriggered: true, decisionExecuted: true })
      many.review_report('T', d, c)
    }
    expect(many.review_metrics('T').history.length).toBe(30)
  })
})
