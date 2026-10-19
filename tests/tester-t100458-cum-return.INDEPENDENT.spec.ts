/**
 * tester-t100458-cum-return.INDEPENDENT.spec.ts
 * —— 修复 Issue #3「cum_return 分子缺少期末现金」的 Tester 独立验证。
 *
 * 任务：AC1~AC4（见任务书 t100458）。基线 commit fe31197，被测改动工作区未 commit。
 *
 * 独立性声明（硬约束：只新增本文件，不改动 src/**）：
 *   - 期望值全部由「场景参数手算」得到，**不调用被测实现反推**，不复用 Developer 的
 *     tests/metrics.test.ts / tests/reviews.test.ts / tests/tools.test.ts /
 *     tests/tester-task8-fix-reverify.INDEPENDENT.spec.ts 断言。
 *   - Issue #3 台账用 Ledger 的 init/trade 公共 API **自行重建**，再跑 review_metrics 观察产出，
 *     而非只读 Developer 断言。
 *
 * 新口径：`cum_return = (期末现金 + 期末市值 − 期初资金) / 期初资金`
 *   （期末总资产 vs 期初总资产；期末总资产 = 期末现金 + 期末持仓市值）
 * 旧口径：`(期末市值 + 累计 realized − 期初资金) / 期初资金`（分子漏期末现金）
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { Ledger } from '../src/domain/ledger.js'
import { Reviews } from '../src/domain/reviews.js'
import { cumReturnOnCapital } from '../src/domain/metrics.js'
import { registerAllTools } from '../src/tools/index.js'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dsh-ia-t100458-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

/** 与被测实现同口径四舍五入到 4 位（仅用于对齐断言精度，非反推实现）。 */
const r4 = (v: number): number => Math.round((v + Number.EPSILON) * 10000) / 10000

/* ====================================================================== *
 * 一、AC1（核心）：Issue #3 真实台账独立复现
 *
 * 台账：init 200@55.57（初始现金 50000）；sell 100@53.05；buy 100@53.08；sell 200@49.76
 * 期望：期末 qty=0、期末现金 59949、期初资金 61114
 *       cum_return = (59949 + 0 − 61114) / 61114 = −1165/61114 ≈ −0.0191（−1.91%）
 * 旧口径会算成 (0 − 61114)/61114 = −1.0191（−101.91%）
 * ====================================================================== */

/** 用 Ledger 公共 API 重建 Issue #3 台账，返回 ledger 实例。 */
function buildIssue3Ledger(dataRoot: string): Ledger {
  const l = new Ledger(dataRoot)
  l.init('002156', { type: 'stock', name: 'Iss3', qty: 200, cost: 55.57, cash: 50000 })
  l.trade('002156', { side: 'sell', qty: 100, price: 53.05 })
  l.trade('002156', { side: 'buy', qty: 100, price: 53.08 })
  l.trade('002156', { side: 'sell', qty: 200, price: 49.76 })
  return l
}

describe('AC1 · Issue #3 台账独立复现（域层）', () => {
  it('中间量自洽：期末 qty=0 / 期末现金 59949 / 期初资金 61114', () => {
    const l = buildIssue3Ledger(dir)
    // 期末持仓与现金（query 快照）。
    const snap = l.query('002156')
    expect(snap.qty).toBe(0)
    expect(snap.cash).toBe(59949)
    // 已实现盈亏（独立手算：(53.05−55.57)×100 + (49.76−54.325)×200 = −252 −913 = −1165）。
    expect(snap.realizedPnl).toBe(-1165)

    // cumReturnState 快照：finalCash / initialCapital / finalQty。
    const st = l.cumReturnState('002156', 49.76)!
    expect(st.finalQty).toBe(0)
    expect(st.finalCash).toBe(59949)
    // 期初资金 = 初始现金 50000 + 初始持仓成本 200×55.57 = 61114。
    expect(st.initialCapital).toBe(61114)
  })

  it('review_metrics 返回 ≈ −0.0191（精确 = −0.0191），而非 −1.0191', () => {
    const l = buildIssue3Ledger(dir)
    const reviews = new Reviews(dir, l)

    // 独立手算期望值（不复用实现反推）。
    const expected = r4((59949 + 0 - 61114) / 61114) // −1165/61114 ≈ −0.0191
    const oldFormula = r4((0 - 61114) / 61114) // 旧口径 = −1.0191

    // 缺省 price（回落最近成交价 49.76，因 finalQty=0 不影响期末市值）。
    const byDefault = reviews.review_metrics('002156')
    // 显式给现价。
    const byPrice = reviews.review_metrics('002156', 49.76)

    console.log(
      `[EVIDENCE AC1] default=${byDefault.cumReturn} explicit=${byPrice.cumReturn} ` +
        `expected=${expected} oldFormula=${oldFormula}`,
    )

    expect(byDefault.cumReturn).toBe(expected)
    expect(byPrice.cumReturn).toBe(expected)
    expect(byDefault.cumReturn).toBe(-0.0191)
    expect(byDefault.cumReturn).not.toBe(oldFormula)
    expect(byDefault.cumReturn).not.toBeCloseTo(-1.0191, 2)
  })

  it('回归护栏：cumReturnOnCapital 直接单测时旧口径不会再现', () => {
    // 新口径输入快照（finalCash 取代 realizedPnl）。
    expect(
      cumReturnOnCapital({ finalQty: 0, finalPrice: 49.76, finalCash: 59949, initialCapital: 61114 }),
    ).toBe(-0.0191)
  })
})

/* ====================================================================== *
 * 二、AC1（工具层）：走真实 ToolRuntime registry，literal `review_metrics('002156')`
 * ====================================================================== */

interface RegistryResult {
  isError: boolean
  value?: unknown
  content: Array<{ type: string; text?: string }>
}
interface ToolBox {
  schemas: () => Array<{ name: string }>
  execute: (input: unknown) => Promise<RegistryResult>
}
type MetricsValue = {
  dir_hit_rate: number
  range_hit_rate: number
  cum_return: number
  history: unknown[]
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

async function bootRegistry(dataRoot: string): Promise<{ tools: ToolBox; dispose: () => Promise<void> }> {
  const app = new Context()
  app.provide('systemPrompt', systemPromptStub())
  const toolsFiber = (await app.plugin(ToolRuntime as never)) as unknown as { dispose: () => Promise<void> }
  const pluginFiber = app.plugin({
    name: 'dsh-ia-tools',
    inject: ['tools'],
    apply(ctx: Context) {
      registerAllTools(ctx, { dataRoot })
    },
  } as never) as unknown as { dispose: () => Promise<void> }
  const tools = (app as unknown as { tools: ToolBox }).tools
  let tries = 0
  while (tools.schemas().length !== 15 && tries < 500) {
    await new Promise((r) => setTimeout(r, 10))
    tries += 1
  }
  expect(tools.schemas()).toHaveLength(15)
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
    callId: `t100458-${seq}`,
    name,
    arguments: args,
    signal: new AbortController().signal,
  })
}

describe('AC1 · 工具层端到端：review_metrics("002156") → −0.0191', () => {
  it('台账经域层写入后，工具层 review_metrics 透出新口径值', async () => {
    buildIssue3Ledger(dir) // 同一 dataRoot
    const { tools, dispose } = await bootRegistry(dir)
    try {
      const expected = r4((59949 + 0 - 61114) / 61114) // −0.0191

      const resNoPrice = await call(tools, 'review_metrics', { symbol: '002156' })
      expect(resNoPrice.isError).toBe(false)
      const m1 = resNoPrice.value as MetricsValue

      const resPrice = await call(tools, 'review_metrics', { symbol: '002156', price: 49.76 })
      expect(resPrice.isError).toBe(false)
      const m2 = resPrice.value as MetricsValue

      console.log(
        `[EVIDENCE AC1-TOOL] cum_return(no price)=${m1.cum_return} explicit=${m2.cum_return} expected=${expected}`,
      )
      expect(m1.cum_return).toBe(expected)
      expect(m2.cum_return).toBe(expected)
      expect(m1.cum_return).toBe(-0.0191)
      expect(m1.cum_return).not.toBeCloseTo(-1.0191, 2)
    } finally {
      await dispose()
    }
  })
})

/* ====================================================================== *
 * 三、AC2：三类场景口径用例（数据自洽：期初资金 = 初始现金 + 初始持仓成本）
 * ====================================================================== */

describe('AC2 · 场景①：期初有现金（initialCash > 0）', () => {
  it('端到端 + 自洽校验：0 成交，期末现金=初始现金，cum_return=(现金+市值−期初资金)/期初资金', () => {
    const initCash = 8000
    const initQty = 1000
    const initCost = 2.0
    const price = 2.2

    const l = new Ledger(dir)
    l.init('S1', { type: 'etf', name: 'A', qty: initQty, cost: initCost, cash: initCash })
    const reviews = new Reviews(dir, l)

    // 自洽性：期初资金 = 初始现金 + 初始持仓成本。
    const st = l.cumReturnState('S1', price)!
    const initCapitalHand = initCash + initQty * initCost // 8000 + 2000 = 10000
    expect(st.initialCapital).toBe(initCapitalHand)

    // 独立手算：期末现金 8000（无成交）、期末市值 1000×2.2=2200
    //   → (8000 + 2200 − 10000)/10000 = 0.02
    const expected = r4((initCash + initQty * price - initCapitalHand) / initCapitalHand)
    const m = reviews.review_metrics('S1', price)
    console.log(`[EVIDENCE AC2-①] cum_return=${m.cumReturn} expected=${expected}`)
    expect(m.cumReturn).toBe(expected)
    expect(m.cumReturn).toBe(0.02)
  })
})

describe('AC2 · 场景②：期间有卖出（realizedPnl ≠ 0）', () => {
  it('已实现盈亏经现金回笼计入期末现金，而非独立分子项', () => {
    const initCash = 50000
    const initQty = 1000
    const initCost = 2.0

    const l = new Ledger(dir)
    l.init('S2', { type: 'etf', name: 'B', qty: initQty, cost: initCost, cash: initCash })
    const tr = l.trade('S2', { side: 'sell', qty: 500, price: 3.0 })
    expect(tr.ok).toBe(true)

    const snap = l.query('S2')
    // 场景确有 realizedPnl ≠ 0：(3.0−2.0)×500 = 500。
    expect(snap.realizedPnl).toBe(500)
    expect(snap.qty).toBe(500)
    expect(snap.cash).toBe(51500) // 50000 + 500×3.0

    // 自洽：期初资金 = 初始现金 + 初始持仓成本 = 50000 + 2000 = 52000。
    const initCapitalHand = initCash + initQty * initCost
    // 独立手算，缺省现价 = 最近成交价 3.0 → 期末市值 = 500×3.0 = 1500
    //   → (51500 + 1500 − 52000)/52000 = 1000/52000 ≈ 0.0192
    const expected = r4((51500 + 500 * 3.0 - initCapitalHand) / initCapitalHand)
    const reviews = new Reviews(dir, l)
    const m = reviews.review_metrics('S2')
    console.log(`[EVIDENCE AC2-②] cum_return=${m.cumReturn} expected=${expected}`)
    expect(m.cumReturn).toBe(expected)
    expect(m.cumReturn).toBe(0.0192)
  })
})

describe('AC2 · 场景③：已清仓（finalQty = 0）', () => {
  it('清仓后分子仅剩期末现金，不再漏算成亏损', () => {
    const initCash = 1000
    const initQty = 1000
    const initCost = 2.0

    const l = new Ledger(dir)
    l.init('S3', { type: 'stock', name: 'C', qty: initQty, cost: initCost, cash: initCash })
    const tr = l.trade('S3', { side: 'sell', qty: 1000, price: 6.0 })
    expect(tr.ok).toBe(true)

    const snap = l.query('S3')
    expect(snap.qty).toBe(0)
    expect(snap.cash).toBe(7000) // 1000 + 1000×6.0
    expect(snap.realizedPnl).toBe(4000) // (6.0−2.0)×1000

    // 自洽：期初资金 = 1000 + 1000×2.0 = 3000。
    const initCapitalHand = initCash + initQty * initCost
    // 独立手算：期末市值 = 0 → (7000 + 0 − 3000)/3000 = 4000/3000 ≈ 1.3333
    const expected = r4((7000 + 0 - initCapitalHand) / initCapitalHand)
    const reviews = new Reviews(dir, l)
    const m = reviews.review_metrics('S3')
    console.log(`[EVIDENCE AC2-③] cum_return=${m.cumReturn} expected=${expected}`)
    expect(m.cumReturn).toBe(expected)
    expect(m.cumReturn).toBe(1.3333)
  })
})

/* ====================================================================== *
 * 四、口径一致性：域纯函数 review_metrics 与 cumReturnOnCapital 同源
 * ====================================================================== */

describe('AC2 · 口径一致性（域层 review_metrics 与纯函数同源）', () => {
  it('三场景下 review_metrics.cumReturn === cumReturnOnCapital(cumReturnState)', () => {
    const cases: Array<[string, number, number, number, { side: 'buy' | 'sell'; qty: number; price: number }?]> = [
      ['C1', 8000, 1000, 2.0, undefined],
      ['C2', 50000, 1000, 2.0, { side: 'sell', qty: 500, price: 3.0 }],
      ['C3', 1000, 1000, 2.0, { side: 'sell', qty: 1000, price: 6.0 }],
    ]
    const price = 2.2
    for (const [sym, cash, qty, cost, trade] of cases) {
      const l = new Ledger(dir)
      l.init(sym, { type: 'etf', qty, cost, cash })
      if (trade) l.trade(sym, trade)
      const reviews = new Reviews(dir, l)
      const viaReviews = reviews.review_metrics(sym, price).cumReturn
      const viaPure = cumReturnOnCapital(l.cumReturnState(sym, price)!)
      expect(viaReviews).toBe(viaPure)
    }
  })
})
