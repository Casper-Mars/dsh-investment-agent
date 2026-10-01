/**
 * 工具层单元测试：覆盖 t100353 六条验收点。
 *
 * 验收点映射：
 *   1. 15 个工具全部经 defineTool 注册（createAllTools 长度 + 名称 + output.schema 合法性）
 *   2. execute 走 domain、返回 lossless JSON 且符合 output schema
 *   3. 写类返回 {ok,...}，读类返回无 ok 字段
 *   4. sense_archive_commit 的 change_type / parent 校验
 *   5. 写操作按 symbol 隔离
 *   6. exec.signal 取消时不产生半写
 *
 * 说明：直接调用 ToolDefinition.execute(args, exec) 断言返回形状；同时用
 * output.schema 的严格校验语义（借助 @deepseek-ai/dsh-tools 导出的
 * validateJsonSchemaValue）验证 execute 返回与 schema 逐字段对齐。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import { createToolContext, type ToolContext } from '../src/tools/context.js'
import { createAllTools } from '../src/tools/index.js'

let dir: string
let ctx: ToolContext
let tools: ToolDefinition[]

/** 构造一个已 aborted / 未 aborted 的 exec。 */
function makeExec(aborted = false): { signal: AbortSignal } {
  const ctrl = new AbortController()
  if (aborted) ctrl.abort()
  return { signal: ctrl.signal }
}

/** 按名称取工具。 */
function tool(name: string): ToolDefinition {
  const t = tools.find((x) => x.name === name)
  if (!t) throw new Error(`工具 ${name} 未注册`)
  return t
}

/** 执行工具并断言成功（不抛错）。 */
async function run(name: string, args: Record<string, unknown> = {}, aborted = false) {
  const t = tool(name)
  const value = await t.execute(args, makeExec(aborted))
  return value
}

/** 用 output.schema 严格校验返回值（成功值必须逐字段对齐）。 */
function expectMatchesOutputSchema(name: string, value: unknown): void {
  const t = tool(name)
  const schema = t.output.schema
  const violations = validateJsonSchemaValue(schema, value)
  expect(
    violations,
    `${name} 返回值 ${JSON.stringify(value)} 不符合 output.schema：${violations?.join('; ')}`,
  ).toEqual([])
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dsh-finance-tools-'))
  ctx = createToolContext({ dataRoot: dir })
  tools = createAllTools(ctx)
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('验收点 1：18 个工具注册 + 名称 + schema 合法', () => {
  const expected = [
    'ledger_init', 'ledger_list', 'ledger_query', 'ledger_trade',
    'strategy_get', 'strategy_set',
    'predict_make', 'predict_verify', 'predict_get',
    'review_check', 'review_report', 'review_get', 'review_metrics', 'review_retrospect',
    'sense_archive_commit', 'sense_archive_list', 'sense_archive_rollback', 'sense_archive_get',
  ]
  it('createAllTools 返回 18 个工具，名称齐全无重复', () => {
    // §4 契约表 16 个 + §10.8 策略域 2 个 = 18 个。
    expect(tools.length).toBe(18)
    const names = tools.map((t) => t.name)
    expect(new Set(names).size).toBe(18)
    for (const n of expected) expect(names).toContain(n)
  })

  it('每个工具都有非空 description / output.schema / output.render', () => {
    for (const t of tools) {
      expect(t.description.length).toBeGreaterThan(0)
      expect(t.output).toBeDefined()
      expect(t.output.schema).toBeDefined()
      expect(typeof t.output.render).toBe('function')
    }
  })
})

describe('验收点 2+3：ledger 域 —— 返回形态 + schema 对齐', () => {
  it('ledger_init：写类返回 {ok,symbol}，符合 schema', async () => {
    const v = await run('ledger_init', {
      symbol: '588000', type: 'etf', name: '科创50ETF',
      init_qty: 1000, init_cost: 1.95, init_cash: 100000,
    })
    expect(v).toEqual({ ok: true, symbol: '588000' })
    expectMatchesOutputSchema('ledger_init', v)
  })

  it('ledger_init 重复 symbol 抛错（不返回 {ok:false}）', async () => {
    const args = { symbol: '588000', type: 'etf', init_qty: 1000, init_cost: 1.95, init_cash: 100000 }
    await run('ledger_init', args)
    await expect(run('ledger_init', args)).rejects.toThrow(/已存在|重复/)
  })

  it('ledger_list：读类返回 {symbols}（无 ok），字段含 avg_cost', async () => {
    await run('ledger_init', { symbol: '588000', type: 'etf', name: '科创50ETF', init_qty: 1000, init_cost: 1.95, init_cash: 100000 })
    const v = await run('ledger_list')
    expect(v).not.toHaveProperty('ok')
    expect(v.symbols).toHaveLength(1)
    expect(v.symbols[0]).toEqual({
      symbol: '588000', type: 'etf', name: '科创50ETF', qty: 1000, avg_cost: 1.95,
    })
    expectMatchesOutputSchema('ledger_list', v)
  })

  it('ledger_query：读类返回完整快照（蛇形字段）', async () => {
    await run('ledger_init', { symbol: '588000', type: 'etf', name: '科创50ETF', init_qty: 1000, init_cost: 1.95, init_cash: 100000 })
    const v = await run('ledger_query', { symbol: '588000' })
    expect(v).not.toHaveProperty('ok')
    expect(v).toEqual({
      symbol: '588000', type: 'etf', name: '科创50ETF', qty: 1000, avg_cost: 1.95,
      cash: 100000, realized_pnl: 0, float_pnl: 0,
    })
    expectMatchesOutputSchema('ledger_query', v)
  })

  it('ledger_query：name 缺省时为 null（与 schema oneOf(null) 对齐）', async () => {
    await run('ledger_init', { symbol: '588000', type: 'etf', init_qty: 1000, init_cost: 1.95, init_cash: 100000 })
    const v = await run('ledger_query', { symbol: '588000' })
    expect(v.name).toBeNull()
    expectMatchesOutputSchema('ledger_query', v)
  })

  it('ledger_trade：写类返回 {ok,trade_id,new_qty,avg_cost}，卖出重算', async () => {
    await run('ledger_init', { symbol: '588000', type: 'etf', init_qty: 1000, init_cost: 2, init_cash: 100000 })
    const v = await run('ledger_trade', { symbol: '588000', side: 'buy', qty: 100, price: 2.2 })
    expect(v.ok).toBe(true)
    expect(typeof v.trade_id).toBe('string')
    expect(v.new_qty).toBe(1100)
    expectMatchesOutputSchema('ledger_trade', v)
  })

  it('ledger_trade 卖超抛错', async () => {
    await run('ledger_init', { symbol: '588000', type: 'etf', init_qty: 1000, init_cost: 2, init_cash: 100000 })
    await expect(
      run('ledger_trade', { symbol: '588000', side: 'sell', qty: 2000, price: 2.5 }),
    ).rejects.toThrow(/超过|超卖/)
  })
})

describe('验收点 2+3：strategy 域（strategy_get / strategy_set）', () => {
  it('strategy_set 首版返回 {ok,version=v001}；strategy_get 往返返回 {symbol,text,version,updated_at}', async () => {
    await run('ledger_init', { symbol: '588000', type: 'etf', init_qty: 1000, init_cost: 1.95, init_cash: 100000 })
    const s = await run('strategy_set', { symbol: '588000', text: '# 首版\n买入并持有', rationale: '初始策略' })
    expect(s).toEqual({ ok: true, version: 'v001' })
    expectMatchesOutputSchema('strategy_set', s)

    const g = await run('strategy_get', { symbol: '588000' })
    expect(g).not.toHaveProperty('ok')
    expect(g.symbol).toBe('588000')
    expect(g.text).toBe('# 首版\n买入并持有')
    expect(g.version).toBe('v001')
    expect(typeof g.updated_at).toBe('string')
    expect(g.updated_at).not.toBe('')
    expectMatchesOutputSchema('strategy_get', g)
  })

  it('strategy_set 带 parent_version 版本递增 v001→v002', async () => {
    await run('ledger_init', { symbol: '588000', type: 'etf', init_qty: 1000, init_cost: 1.95, init_cash: 100000 })
    await run('strategy_set', { symbol: '588000', text: 'v1', rationale: 'r1' })
    const v2 = await run('strategy_set', { symbol: '588000', text: 'v2', rationale: 'r2', parent_version: 'v001' })
    expect(v2).toEqual({ ok: true, version: 'v002' })
    expectMatchesOutputSchema('strategy_set', v2)

    // 历史版本仍可读（不可变）。
    const old = await run('strategy_get', { symbol: '588000', version: 'v001' })
    expect(old.text).toBe('v1')
    expect(old.version).toBe('v001')
    expectMatchesOutputSchema('strategy_get', old)
  })

  it('strategy_set parent_version 与当前版不一致报错（防并发覆盖，不吞错）', async () => {
    await run('ledger_init', { symbol: '588000', type: 'etf', init_qty: 1000, init_cost: 1.95, init_cash: 100000 })
    await run('strategy_set', { symbol: '588000', text: 'v1', rationale: 'r1' })
    await run('strategy_set', { symbol: '588000', text: 'v2', rationale: 'r2', parent_version: 'v001' })
    // 当前已是 v002，却声明 parent=v001
    await expect(
      run('strategy_set', { symbol: '588000', text: 'v3', rationale: 'r3', parent_version: 'v001' }),
    ).rejects.toThrow(/不一致/)
  })

  it('strategy_set 未初始化台账的标的报错', async () => {
    await expect(
      run('strategy_set', { symbol: '999999', text: 'x', rationale: 'r' }),
    ).rejects.toThrow(/台账|ledger_init/)
  })

  it('strategy_get 未设定策略的标的报错（明确可读引导）', async () => {
    await run('ledger_init', { symbol: '588000', type: 'etf', init_qty: 1000, init_cost: 1.95, init_cash: 100000 })
    await expect(run('strategy_get', { symbol: '588000' })).rejects.toThrow(/strategy_set/)
  })

  it('strategy_set 写前取消时不产生版本', async () => {
    await run('ledger_init', { symbol: '588000', type: 'etf', init_qty: 1000, init_cost: 1.95, init_cash: 100000 })
    await expect(
      run('strategy_set', { symbol: '588000', text: 'v1', rationale: 'r1' }, true),
    ).rejects.toThrow(/取消/)
    await expect(run('strategy_get', { symbol: '588000' })).rejects.toThrow(/strategy_set/)
  })
})

describe('验收点 2+3：predicts 域', () => {
  it('predict_make 返回 {ok,prediction_id}', async () => {
    const v = await run('predict_make', {
      symbol: '588000', date: '2026-09-29', dir: 'up',
      range_low: 1.8, range_high: 2.2, confidence: 0.8, watch_points: ['突破'],
    })
    expect(v.ok).toBe(true)
    expect(typeof v.prediction_id).toBe('string')
    expectMatchesOutputSchema('predict_make', v)
  })

  it('predict_verify 返回 {hit_dir,hit_range,deviation}（无 ok）', async () => {
    await run('predict_make', {
      symbol: '588000', date: '2026-09-29', dir: 'up',
      range_low: 1.8, range_high: 2.2, confidence: 0.8, watch_points: [],
    })
    const v = await run('predict_verify', {
      symbol: '588000', date: '2026-09-29',
      actual_close: 2.0, actual_high: 2.1, actual_low: 1.9, prev_close: 1.8,
    })
    expect(v).not.toHaveProperty('ok')
    expect(v).toEqual({ hit_dir: true, hit_range: true, deviation: 0 })
    expectMatchesOutputSchema('predict_verify', v)
  })

  it('predict_get 返回 {prediction}，无记录返回 null', async () => {
    await run('predict_make', {
      symbol: '588000', date: '2026-09-29', dir: 'flat',
      range_low: 1.8, range_high: 2.2, confidence: 0.5, watch_points: ['a'],
    })
    const v = await run('predict_get', { symbol: '588000', date: '2026-09-29' })
    expect(v.prediction.dir).toBe('flat')
    expect(v.prediction.watch_points).toEqual(['a'])
    expectMatchesOutputSchema('predict_get', v)

    const empty = await run('predict_get', { symbol: '588000', date: '2026-09-30' })
    expect(empty.prediction).toBeNull()
    expectMatchesOutputSchema('predict_get', empty)
  })
})

describe('验收点 2+3：reviews 域', () => {
  it('review_check 返回 {decision_triggered,decision_executed,notes}（无 ok）', async () => {
    const v = await run('review_check', {
      symbol: '588000', date: '2026-09-29',
      decision_triggered: true, decision_executed: false,
    })
    expect(v).not.toHaveProperty('ok')
    expect(v.decision_triggered).toBe(true)
    expect(v.decision_executed).toBe(false)
    expect(typeof v.notes).toBe('string')
    expectMatchesOutputSchema('review_check', v)
  })

  it('review_report 返回 {ok,report_id}', async () => {
    const v = await run('review_report', {
      symbol: '588000', date: '2026-09-29',
      decision_triggered: true, decision_executed: true,
      hit_dir: true, hit_range: true,
    })
    expect(v.ok).toBe(true)
    expect(typeof v.report_id).toBe('string')
    expectMatchesOutputSchema('review_report', v)
  })

  it('review_get 返回 {reports}；review_metrics 返回累计统计；review_retrospect 返回根因', async () => {
    await run('review_report', {
      symbol: '588000', date: '2026-09-29',
      decision_triggered: true, decision_executed: true, hit_dir: true, hit_range: true,
    })
    const g = await run('review_get', { symbol: '588000' })
    expect(g.reports).toHaveLength(1)
    expectMatchesOutputSchema('review_get', g)

    const m = await run('review_metrics', { symbol: '588000' })
    expect(m).not.toHaveProperty('ok')
    expect(m).toHaveProperty('dir_hit_rate')
    expect(m).toHaveProperty('range_hit_rate')
    expect(m).toHaveProperty('cum_return')
    expect(Array.isArray(m.history)).toBe(true)
    expectMatchesOutputSchema('review_metrics', m)

    const r = await run('review_retrospect', { symbol: '588000' })
    expect(r).not.toHaveProperty('ok')
    expect(typeof r.root_cause).toBe('string')
    expect(Array.isArray(r.improvements)).toBe(true)
    expectMatchesOutputSchema('review_retrospect', r)
  })
})

describe('验收点 4：sense_archive_commit 校验 change_type / parent', () => {
  it('patch 缺 parent 报错（设计 §4.4）', async () => {
    await expect(
      run('sense_archive_commit', { change_type: 'patch', rationale: 'r', code: 'c' }),
    ).rejects.toThrow(/parent/)
  })

  it('patch 带不存在的 parent 报错', async () => {
    await expect(
      run('sense_archive_commit', { change_type: 'patch', rationale: 'r', code: 'c', parent_version: 'v999' }),
    ).rejects.toThrow(/parent/)
  })

  it('keep 在无 current 时报错（不产生新版本）', async () => {
    await expect(
      run('sense_archive_commit', { change_type: 'keep', rationale: 'r', code: 'c' }),
    ).rejects.toThrow(/current/)
  })

  it('首次 commit replace（无 parent，作为首版）成功并成为 current', async () => {
    const v = await run('sense_archive_commit', { change_type: 'replace', rationale: '初版', code: 'sensor v1' })
    expect(v.ok).toBe(true)
    expect(v.version).toBe('v001')
    expect(v.is_current).toBe(true)
    expectMatchesOutputSchema('sense_archive_commit', v)
  })

  it('patch 带 parent 成功，version 递增且 is_current', async () => {
    await run('sense_archive_commit', { change_type: 'replace', rationale: 'r1', code: 'c1' })
    const v = await run('sense_archive_commit', {
      change_type: 'patch', rationale: 'r2', code: 'c2', parent_version: 'v001',
    })
    expect(v.ok).toBe(true)
    expect(v.version).toBe('v002')
    expect(v.is_current).toBe(true)
  })

  it('list / get / rollback 完整链路', async () => {
    await run('sense_archive_commit', { change_type: 'replace', rationale: 'r1', code: 'c1' })
    await run('sense_archive_commit', { change_type: 'patch', rationale: 'r2', code: 'c2', parent_version: 'v001' })

    const list = await run('sense_archive_list')
    expect(list.versions).toHaveLength(2)
    expect(list.versions[0].change_type).toBe('replace')
    expect(list.versions[1].change_type).toBe('patch')
    expectMatchesOutputSchema('sense_archive_list', list)

    const get = await run('sense_archive_get', { version: 'v001' })
    expect(get.rationale).toBe('r1')
    expect(get.code).toBe('c1')
    expect(get.meta.version).toBe('v001')
    expectMatchesOutputSchema('sense_archive_get', get)

    const rb = await run('sense_archive_rollback', { version: 'v001' })
    expect(rb).toEqual({ ok: true, current: 'v001' })
    expectMatchesOutputSchema('sense_archive_rollback', rb)
  })
})

describe('验收点 5：写操作按 symbol 隔离', () => {
  it('不同标的的 ledger / predict / review 互不可见', async () => {
    // symbol A
    await run('ledger_init', { symbol: '588000', type: 'etf', init_qty: 1000, init_cost: 2, init_cash: 100000 })
    await run('predict_make', { symbol: '588000', date: '2026-09-29', dir: 'up', range_low: 1, range_high: 3, confidence: 0.7, watch_points: [] })
    await run('review_report', { symbol: '588000', date: '2026-09-29', decision_triggered: true, decision_executed: true, hit_dir: true, hit_range: true })

    // symbol B 应有独立空数据
    const listB = await run('ledger_list')
    expect(listB.symbols.map((s: { symbol: string }) => s.symbol)).not.toContain('000001')

    const predB = await run('predict_get', { symbol: '000001', date: '2026-09-29' })
    expect(predB.prediction).toBeNull()

    const reviewB = await run('review_get', { symbol: '000001' })
    expect(reviewB.reports).toEqual([])
  })
})

describe('验收点 6：exec.signal 取消时不产生半写', () => {
  it('ledger_init 已取消时抛错且不落数据', async () => {
    await expect(
      run('ledger_init', { symbol: '588000', type: 'etf', init_qty: 1000, init_cost: 2, init_cash: 100000 }, true),
    ).rejects.toThrow(/取消/)

    // 未产生半写：list 仍为空
    const list = await run('ledger_list')
    expect(list.symbols).toEqual([])
  })

  it('sense_archive_commit 已取消时抛错且不产生版本', async () => {
    await expect(
      run('sense_archive_commit', { change_type: 'replace', rationale: 'r', code: 'c' }, true),
    ).rejects.toThrow(/取消/)

    const list = await run('sense_archive_list')
    expect(list.versions).toEqual([])
  })
})