/**
 * tester-tools-runtime.spec.ts —— Tester 独立运行时验证（t100353 工具层）。
 *
 * 与 Developer 的 tests/tools.test.ts 的区别：
 *   - tools.test.ts 直接调用 ToolDefinition.execute(args, fakeExec)；
 *   - 本文件改用**真实** @deepseek-ai/dsh-tools ToolRuntime registry 管线
 *     （`new Context()` → `provide('systemPrompt')` → `plugin(ToolRuntime)` →
 *      以 `inject:['tools']` 的插件经 `registerAllTools` 注册 → `registry.execute`），
 *     走 defineTool 的完整校验/归一/物化链路。
 *
 * 覆盖验收点 1~6 + 端到端；证据以 console.log('[EVIDENCE ...]') 输出。
 * 只新增本测试文件，不改动 src/**。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import ToolRuntime, {
  defineTool,
  assertSupportedJsonSchema,
  validateJsonSchemaValue,
  type ToolDefinition,
} from '@deepseek-ai/dsh-tools'
import { createToolContext, type ToolContext } from '../src/tools/context.js'
import { createAllTools, registerAllTools } from '../src/tools/index.js'

/* ================================================================== *
 * 真实 registry 引导
 * ================================================================== */

interface RegistryResult {
  isError: boolean
  value?: unknown
  content: Array<{ type: string; text?: string }>
  error?: { message: string; info?: { name?: string; code?: string } }
}

interface ToolBox {
  schemas: () => Array<{ name: string; description: string; parameters: unknown }>
  get: (name: string) => ToolDefinition | undefined
  execute: (input: unknown) => Promise<RegistryResult>
  register: (def: ToolDefinition) => () => void
}

/** systemPrompt 最小桩（ToolRuntime.inject = ['systemPrompt']）。 */
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

interface Booted {
  app: Context
  tools: ToolBox
  dispose: () => Promise<void>
}

/** 引导真实 ToolRuntime + 经 registerAllTools 注册 dsh-finance 工具。 */
async function bootRegistry(dataRoot: string): Promise<Booted> {
  const app = new Context()
  app.provide('systemPrompt', systemPromptStub())
  const toolsFiber = (await app.plugin(ToolRuntime as never)) as unknown as {
    dispose: () => Promise<void>
  }
  const pluginFiber = app.plugin({
    name: 'dsh-finance-tools',
    inject: ['tools'],
    apply(ctx: Context) {
      registerAllTools(ctx, { dataRoot })
    },
  } as never) as unknown as { dispose: () => Promise<void> }

  const tools = (app as unknown as { tools: ToolBox }).tools
  await vi.waitFor(
    () => {
      expect(tools.schemas()).toHaveLength(16)
    },
    { timeout: 5000, interval: 10 },
  )
  return {
    app,
    tools,
    async dispose() {
      await pluginFiber.dispose()
      await toolsFiber.dispose()
    },
  }
}

let seq = 0
function call(
  tools: ToolBox,
  name: string,
  args: Record<string, unknown> = {},
  signal?: AbortSignal,
): Promise<RegistryResult> {
  seq += 1
  return tools.execute({
    callId: `t4-${seq}`,
    name,
    arguments: args,
    signal: signal ?? new AbortController().signal,
  })
}

const textOf = (r: RegistryResult): string =>
  r.content.map((c) => c.text ?? '').join('\n')
const valueOf = (r: RegistryResult): unknown => r.value

/* ================================================================== *
 * 工具契约表（§4）：写/读分类 + output.schema 字段集合
 * ================================================================== */

const WRITE_TOOLS = [
  'ledger_init',
  'ledger_trade',
  'predict_make',
  'review_report',
  'sense_archive_commit',
  'sense_archive_rollback',
] as const

const READ_TOOLS = [
  'ledger_list',
  'ledger_query',
  'predict_verify',
  'predict_get',
  'review_check',
  'review_get',
  'review_metrics',
  'review_retrospect',
  'sense_archive_list',
  'sense_archive_get',
] as const

/** §4 契约表：逐工具 output.schema 顶层字段集合（数组取 items.properties）。 */
const SCHEMA_FIELDS: Record<string, string[]> = {
  ledger_init: ['ok', 'symbol'],
  ledger_list: ['symbols'],
  ledger_query: [
    'symbol', 'type', 'name', 'qty', 'avg_cost', 'cash', 'realized_pnl', 'float_pnl',
  ],
  ledger_trade: ['ok', 'trade_id', 'new_qty', 'avg_cost'],
  predict_make: ['ok', 'prediction_id'],
  predict_verify: ['hit_dir', 'hit_range', 'deviation'],
  predict_get: ['prediction'],
  review_check: ['decision_triggered', 'decision_executed', 'notes'],
  review_report: ['ok', 'report_id'],
  review_get: ['reports'],
  review_metrics: ['dir_hit_rate', 'range_hit_rate', 'cum_return', 'history'],
  review_retrospect: ['root_cause', 'improvements'],
  sense_archive_commit: ['ok', 'version', 'is_current'],
  sense_archive_list: ['versions'],
  sense_archive_rollback: ['ok', 'current'],
  sense_archive_get: ['rationale', 'code', 'meta'],
}

/** 从 output.schema 取字段名（数组型取 items.properties）。 */
function schemaFieldNames(schema: unknown): string[] {
  const s = schema as { type?: string; properties?: Record<string, unknown>; items?: unknown }
  const target =
    s.type === 'array'
      ? (s.items as { properties?: Record<string, unknown> })
      : s
  return Object.keys(target.properties ?? {}).sort()
}

/** 校验 registry 成功返回值符合其声明 output.schema（0 violation）。 */
function expectSchemaOk(tools: ToolBox, name: string, value: unknown): void {
  const def = tools.get(name)!
  const violations = validateJsonSchemaValue(def.output.schema, value)
  expect(
    violations,
    `${name} 成功值不符合 output.schema：${JSON.stringify(violations)}`,
  ).toEqual([])
}

/* ================================================================== *
 * 生命周期
 * ================================================================== */

let dir: string
let booted: Booted
let tools: ToolBox

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'dsh-fin-t4-'))
  booted = await bootRegistry(dir)
  tools = booted.tools
})

afterEach(async () => {
  await booted.dispose()
  rmSync(dir, { recursive: true, force: true })
})

/* ================================================================== *
 * 验收点 1：16 工具注册、名称集合、schema 合法、ctx.tools 可见
 * ================================================================== */

describe('验收点 1：工具注册数量/名称 + schema 合法性 + ctx.tools 可见', () => {
  const EXPECTED = [
    'ledger_init', 'ledger_list', 'ledger_query', 'ledger_trade',
    'predict_make', 'predict_verify', 'predict_get',
    'review_check', 'review_report', 'review_get', 'review_metrics', 'review_retrospect',
    'sense_archive_commit', 'sense_archive_list', 'sense_archive_rollback', 'sense_archive_get',
  ]

  it('真实 registry 恰好暴露 16 个工具，名称/顺序与 §4 契约表一致', () => {
    const names = tools.schemas().map((s) => s.name)
    expect(names.length).toBe(16)
    expect(names).toEqual(EXPECTED)
    // 无重复
    expect(new Set(names).size).toBe(16)
    console.log(`[EVIDENCE AC1] registered count=${names.length} names=${names.join(',')}`)
  })

  it('【核报】工具数量实为 16（任务描述写 15 = 与分组明细冲突，按 §4 契约表）', () => {
    // 任务描述「共 15 个」；分组明细 4+3+5+4=16；实现为 16。
    const groups: Record<string, string[]> = {}
    for (const n of EXPECTED) {
      const g = n.startsWith('ledger')
        ? 'ledgers'
        : n.startsWith('predict')
          ? 'predicts'
          : n.startsWith('review')
            ? 'reviews'
            : 'sense_archives'
      ;(groups[g] ??= []).push(n)
    }
    expect(groups.ledgers).toHaveLength(4)
    expect(groups.predicts).toHaveLength(3)
    expect(groups.reviews).toHaveLength(5)
    expect(groups.sense_archives).toHaveLength(4)
    expect(tools.schemas().length).toBe(16)
    console.log(
      `[EVIDENCE AC1] groups ledgers=${groups.ledgers.length} predicts=${groups.predicts.length} ` +
        `reviews=${groups.reviews.length} sense=${groups.sense_archives.length} TOTAL=16`,
    )
  })

  it('每个工具的 parameters / output.schema 均为合法受支持 JSON Schema', () => {
    for (const def of createAllTools(createToolContext({ dataRoot: dir }))) {
      // assertSupportedJsonSchema 对不合规 schema 抛 JsonSchemaError。
      expect(() => assertSupportedJsonSchema(def.parameters)).not.toThrow()
      expect(() => assertSupportedJsonSchema(def.output.schema)).not.toThrow()
      expect(def.description.length).toBeGreaterThan(0)
      expect(typeof def.output.render).toBe('function')
    }
  })

  it('dsh 加载后 ctx.tools 可见：registry.get 能解析每个工具且字段与契约表逐一相符', () => {
    for (const name of Object.keys(SCHEMA_FIELDS)) {
      const def = tools.get(name)
      expect(def, `registry.get(${name}) 应可见`).toBeDefined()
      // output.schema 顶层字段集合严格等于契约表（多/少字段都失败）
      expect(schemaFieldNames(def!.output.schema), `${name} 字段集合`).toEqual(
        [...SCHEMA_FIELDS[name]!].sort(),
      )
    }
  })

  it('defineTool 归一证据：parameters 被编译为 object-root 的受支持 JSON Schema', () => {
    // 声明处是隐式 open object（无 type），defineTool 编译后应是 type:'object' + properties。
    for (const def of createAllTools(createToolContext({ dataRoot: dir }))) {
      const p = def.parameters as { type?: string; properties?: Record<string, unknown> }
      expect(p.type, `${def.name}.parameters.type`).toBe('object')
      expect(p.properties, `${def.name}.parameters.properties`).toBeTypeOf('object')
    }
    const sample = tools.get('ledger_init')!.parameters as { required?: string[] }
    expect(sample.required).toEqual(expect.arrayContaining(['symbol', 'type', 'init_qty', 'init_cost', 'init_cash']))
  })

  it('卸载：dispose 插件后 ctx.tools 不再暴露这些工具', async () => {
    expect(tools.schemas()).toHaveLength(16)
    await booted.dispose()
    await vi.waitFor(() => expect(tools.schemas()).toHaveLength(0), { timeout: 2000, interval: 10 })
    // 重新引导，供 afterEach 正常清理。
    booted = await bootRegistry(dir)
    tools = booted.tools
  })

  it('registerAllTools 返回的注销器按注册逆序注销全部工具', () => {
    const registered: string[] = []
    const unregistered: string[] = []
    const fakeCtx = {
      tools: {
        register(def: { name: string }) {
          registered.push(def.name)
          return () => unregistered.push(def.name)
        },
      },
    } as unknown as Context

    const dispose = registerAllTools(fakeCtx, { dataRoot: dir })
    expect(registered).toEqual([
      'ledger_init', 'ledger_list', 'ledger_query', 'ledger_trade',
      'predict_make', 'predict_verify', 'predict_get',
      'review_check', 'review_report', 'review_get', 'review_metrics', 'review_retrospect',
      'sense_archive_commit', 'sense_archive_list', 'sense_archive_rollback', 'sense_archive_get',
    ])
    dispose()
    expect(unregistered).toEqual([...registered].reverse())
  })
})

/* ================================================================== *
 * 验收点 2：execute 走 domain、返回 lossless JSON、符合 output schema；
 *           + 严格校验（缺失/多余字段被判失败）
 * ================================================================== */

describe('验收点 2：lossless JSON + output.schema 严格校验', () => {
  it('16 个工具真实执行成功值均通过 validateJsonSchemaValue（0 violation）', async () => {
    // 铺垫数据，使所有读工具都返回成功值。
    await call(tools, 'ledger_init', {
      symbol: '588000', type: 'etf', name: '科创50ETF',
      init_qty: 1000, init_cost: 1.95, init_cash: 100000,
    })
    await call(tools, 'ledger_trade', { symbol: '588000', side: 'buy', qty: 100, price: 2.0 })
    await call(tools, 'predict_make', {
      symbol: '588000', date: '2026-09-29', dir: 'up',
      range_low: 1.8, range_high: 2.2, confidence: 0.8, watch_points: ['突破'],
    })
    await call(tools, 'review_report', {
      symbol: '588000', date: '2026-09-29',
      decision_triggered: true, decision_executed: true, hit_dir: true, hit_range: true,
    })
    await call(tools, 'sense_archive_commit', { change_type: 'replace', rationale: 'r1', code: 'c1' })
    await call(tools, 'sense_archive_rollback', { version: 'v001' })

    const cases: Array<[string, Record<string, unknown>]> = [
      ['ledger_init', { symbol: '000001', type: 'stock', init_qty: 100, init_cost: 10, init_cash: 5000 }],
      ['ledger_list', {}],
      ['ledger_query', { symbol: '588000' }],
      ['ledger_trade', { symbol: '588000', side: 'sell', qty: 100, price: 2.5 }],
      ['predict_make', { symbol: '588000', date: '2026-09-30', dir: 'flat', range_low: 1.9, range_high: 2.1, confidence: 0.5, watch_points: [] }],
      ['predict_verify', { symbol: '588000', date: '2026-09-29', actual_close: 2.0, actual_high: 2.1, actual_low: 1.9, prev_close: 1.8 }],
      ['predict_get', { symbol: '588000', date: '2026-09-29' }],
      ['review_check', { symbol: '588000', date: '2026-09-29', decision_triggered: true, decision_executed: false }],
      ['review_report', { symbol: '588000', date: '2026-09-30', decision_triggered: true, decision_executed: true, hit_dir: true, hit_range: true }],
      ['review_get', { symbol: '588000' }],
      ['review_metrics', { symbol: '588000' }],
      ['review_retrospect', { symbol: '588000' }],
      ['sense_archive_commit', { change_type: 'patch', rationale: 'r2', code: 'c2', parent_version: 'v001' }],
      ['sense_archive_list', {}],
      ['sense_archive_rollback', { version: 'v001' }],
      ['sense_archive_get', { version: 'v001' }],
    ]

    for (const [name, args] of cases) {
      const r = await call(tools, name, args)
      expect(r.isError, `${name} 应成功，实际：${textOf(r)}`).toBe(false)
      expectSchemaOk(tools, name, valueOf(r))
    }
    console.log(`[EVIDENCE AC2] 16/16 tools executed OK, all values schema-valid`)
  })

  it('严格性：字段缺失 / 多余字段都会被 validateJsonSchemaValue 判失败（additionalProperties:false）', () => {
    const def = tools.get('ledger_query')!
    const good = {
      symbol: '588000', type: 'etf', name: null, qty: 1000, avg_cost: 1.95,
      cash: 100000, realized_pnl: 0, float_pnl: 0,
    }
    expect(validateJsonSchemaValue(def.output.schema, good)).toEqual([])

    // 缺 cash
    const missing = { ...good }
    delete (missing as Record<string, unknown>).cash
    expect(validateJsonSchemaValue(def.output.schema, missing).length).toBeGreaterThan(0)

    // 多一个字段
    expect(
      validateJsonSchemaValue(def.output.schema, { ...good, extra: 1 }).length,
    ).toBeGreaterThan(0)

    // 类型错
    expect(
      validateJsonSchemaValue(def.output.schema, { ...good, qty: '1000' }).length,
    ).toBeGreaterThan(0)
  })

  it('静态守卫：四组工具经 ctx.<domain> 走 domain 层（非 HTTP），context 装配四大 domain', async () => {
    const { readFileSync } = await import('node:fs')
    const groups: Array<[string, RegExp]> = [
      ['ledgers.ts', /ctx\.ledger\./],
      ['predicts.ts', /ctx\.predicts\./],
      ['reviews.ts', /ctx\.reviews\./],
      ['sense-archives.ts', /ctx\.senseRegistry\./],
    ]
    for (const [f, re] of groups) {
      const src = readFileSync(join(process.cwd(), 'src/tools', f), 'utf8')
      expect(src, `${f} 应经 ${re} 走 domain`).toMatch(re)
      expect(src, `${f} 不应使用 fetch/http（非 HTTP 层）`).not.toMatch(/\bfetch\s*\(|node:http|node:https/)
    }
    const ctxSrc = readFileSync(join(process.cwd(), 'src/tools/context.ts'), 'utf8')
    for (const mod of ['ledger', 'predicts', 'reviews', 'sense-registry']) {
      expect(ctxSrc, `context.ts 应装配 domain/${mod}`).toContain(`../domain/${mod}.js`)
    }
  })

  it('registry 真实强制 output 契约：返回多余字段的工具被归一为 isError', async () => {
    const rogue = defineTool({
      name: 't4_rogue_output',
      description: '返回越多余字段的合成工具（验证 registry 对 output.schema 的强制）',
      parameters: {},
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: { ok: { type: 'boolean', required: true } },
        },
        render: () => [{ type: 'text', text: 'rogue' }],
      },
      async execute() {
        return { ok: true, extra: 'not-declared' }
      },
    })
    tools.register(rogue)
    const r = await call(tools, 't4_rogue_output')
    expect(r.isError).toBe(true)
    expect(r.error?.info?.name).toBe('ToolOutputError')
    console.log(`[EVIDENCE AC2] rogue output rejected: ${textOf(r)}`)
  })
})

/* ================================================================== *
 * 验收点 3：写类返回 {ok,...}，读类无 ok
 * ================================================================== */

describe('验收点 3：写类返回 {ok,...}，读类返回无 ok 字段的数据对象', () => {
  it('6 个写工具成功值均含 ok=true；10 个读工具成功值均不含 ok', async () => {
    // 铺垫
    const init = await call(tools, 'ledger_init', {
      symbol: '588000', type: 'etf', init_qty: 1000, init_cost: 2, init_cash: 100000,
    })
    expect(init.isError, textOf(init)).toBe(false)
    expect((valueOf(init) as { ok?: unknown }).ok).toBe(true)

    const writeCalls: Array<[string, Record<string, unknown>]> = [
      ['ledger_trade', { symbol: '588000', side: 'buy', qty: 100, price: 2.1 }],
      ['predict_make', { symbol: '588000', date: '2026-09-29', dir: 'up', range_low: 1, range_high: 3, confidence: 0.7, watch_points: [] }],
      ['review_report', { symbol: '588000', date: '2026-09-29', decision_triggered: true, decision_executed: true, hit_dir: true, hit_range: true }],
      ['sense_archive_commit', { change_type: 'replace', rationale: 'r', code: 'c' }],
      ['sense_archive_rollback', { version: 'v001' }],
    ]
    for (const [name, args] of writeCalls) {
      const r = await call(tools, name, args)
      expect(r.isError, textOf(r)).toBe(false)
      const v = valueOf(r) as Record<string, unknown>
      expect(Object.prototype.hasOwnProperty.call(v, 'ok'), `${name} 写类应有 ok`).toBe(true)
      expect(v.ok).toBe(true)
    }

    const readCalls: Array<[string, Record<string, unknown>]> = [
      ['ledger_list', {}],
      ['ledger_query', { symbol: '588000' }],
      ['predict_verify', { symbol: '588000', date: '2026-09-29', actual_close: 2, actual_high: 2.1, actual_low: 1.9, prev_close: 1.8 }],
      ['predict_get', { symbol: '588000', date: '2026-09-29' }],
      ['review_check', { symbol: '588000', date: '2026-09-29', decision_triggered: true, decision_executed: true }],
      ['review_get', { symbol: '588000' }],
      ['review_metrics', { symbol: '588000' }],
      ['review_retrospect', { symbol: '588000' }],
      ['sense_archive_list', {}],
      ['sense_archive_get', { version: 'v001' }],
    ]
    for (const [name, args] of readCalls) {
      const r = await call(tools, name, args)
      expect(r.isError, textOf(r)).toBe(false)
      const v = valueOf(r) as Record<string, unknown>
      expect(
        Object.prototype.hasOwnProperty.call(v, 'ok'),
        `${name} 读类不应有 ok`,
      ).toBe(false)
    }
    console.log(
      `[EVIDENCE AC3] writes=${WRITE_TOOLS.length} have ok; reads=${READ_TOOLS.length} have no ok`,
    )
  })
})

/* ================================================================== *
 * 验收点 4：sense_archive_commit 的 change_type / parent 校验
 * ================================================================== */

describe('验收点 4：sense_archive_commit 校验 change_type / parent', () => {
  const senseVersionsDir = () => join(dir, 'sense_versions')
  const versionDirs = (): string[] =>
    existsSync(senseVersionsDir())
      ? readdirSync(senseVersionsDir()).filter((e) => /^v\d{3,}$/.test(e))
      : []

  it('patch 缺 parent → 报错（isError），不产生新版本', async () => {
    const r = await call(tools, 'sense_archive_commit', {
      change_type: 'patch', rationale: 'r', code: 'c',
    })
    expect(r.isError).toBe(true)
    expect(textOf(r)).toMatch(/parent/)
    expect(versionDirs()).toEqual([])
    console.log(`[EVIDENCE AC4] patch w/o parent -> isError: ${r.error?.message}`)
  })

  it('patch 携带不存在的 parent → 报错', async () => {
    const r = await call(tools, 'sense_archive_commit', {
      change_type: 'patch', rationale: 'r', code: 'c', parent_version: 'v999',
    })
    expect(r.isError).toBe(true)
    expect(textOf(r)).toMatch(/parent/)
  })

  it('keep 在无 current 时报错，且不产生任何版本', async () => {
    const r = await call(tools, 'sense_archive_commit', {
      change_type: 'keep', rationale: 'r', code: 'c',
    })
    expect(r.isError).toBe(true)
    expect(textOf(r)).toMatch(/current/)
    expect(versionDirs()).toEqual([])
    console.log(`[EVIDENCE AC4] keep w/o current -> isError: ${r.error?.message}`)
  })

  it('【核报】replace 缺 parent 的实际行为：成功（作为首版），返回 v001 且 is_current=true', async () => {
    // 任务验收点 4 写「patch/replace 缺 parent 报错」；§4.4 只强制 patch；
    // 实现为 replace 允许无 parent 作首版引导 —— 如实记录实际行为。
    const r = await call(tools, 'sense_archive_commit', {
      change_type: 'replace', rationale: '初版', code: 'sensor v1',
    })
    expect(r.isError, textOf(r)).toBe(false)
    const v = valueOf(r) as { ok: boolean; version: string; is_current: boolean }
    expect(v).toEqual({ ok: true, version: 'v001', is_current: true })
    expect(versionDirs()).toEqual(['v001'])
    console.log(
      `[EVIDENCE AC4] replace w/o parent -> OK version=${v.version} is_current=${v.is_current}`,
    )
  })

  it('正常 patch 带 parent → 成功，version 递增且 is_current=true', async () => {
    await call(tools, 'sense_archive_commit', { change_type: 'replace', rationale: 'r1', code: 'c1' })
    const r = await call(tools, 'sense_archive_commit', {
      change_type: 'patch', rationale: 'r2', code: 'c2', parent_version: 'v001',
    })
    expect(r.isError, textOf(r)).toBe(false)
    const v = valueOf(r) as { version: string; is_current: boolean }
    expect(v.version).toBe('v002')
    expect(v.is_current).toBe(true)
  })

  it('keep 有 current 时不产生新版本（返回沿用版本，is_current=true）', async () => {
    await call(tools, 'sense_archive_commit', { change_type: 'replace', rationale: 'r1', code: 'c1' })
    const r = await call(tools, 'sense_archive_commit', { change_type: 'keep', rationale: 'r', code: 'c' })
    expect(r.isError, textOf(r)).toBe(false)
    const v = valueOf(r) as { version: string; is_current: boolean }
    expect(v.version).toBe('v001')
    expect(v.is_current).toBe(true)
    expect(versionDirs()).toEqual(['v001']) // 未产生新版本
  })

  it('rollback → current 指针回指历史版本（磁盘 current 文件核实）', async () => {
    await call(tools, 'sense_archive_commit', { change_type: 'replace', rationale: 'r1', code: 'c1' })
    await call(tools, 'sense_archive_commit', { change_type: 'patch', rationale: 'r2', code: 'c2', parent_version: 'v001' })
    expect(readFileSync(join(senseVersionsDir(), 'current'), 'utf8').trim()).toBe('v002')

    const r = await call(tools, 'sense_archive_rollback', { version: 'v001' })
    expect(r.isError, textOf(r)).toBe(false)
    expect(valueOf(r)).toEqual({ ok: true, current: 'v001' })
    expect(readFileSync(join(senseVersionsDir(), 'current'), 'utf8').trim()).toBe('v001')
    console.log('[EVIDENCE AC4] rollback current v002 -> v001 (disk pointer confirmed)')
  })
})

/* ================================================================== *
 * 验收点 5：写操作按 symbol 隔离
 * ================================================================== */

describe('验收点 5：写操作按 symbol 隔离（单标的操作不影响其他标的）', () => {
  it('对 A 做 ledger/predict/review 后，B 标的完全独立', async () => {
    // A 标的
    await call(tools, 'ledger_init', { symbol: '588000', type: 'etf', name: 'A', init_qty: 1000, init_cost: 2, init_cash: 100000 })
    await call(tools, 'ledger_trade', { symbol: '588000', side: 'buy', qty: 500, price: 3 })
    await call(tools, 'predict_make', { symbol: '588000', date: '2026-09-29', dir: 'up', range_low: 1, range_high: 4, confidence: 0.9, watch_points: [] })
    await call(tools, 'review_report', { symbol: '588000', date: '2026-09-29', decision_triggered: true, decision_executed: true, hit_dir: true, hit_range: true })

    // B 标的：独立初始化
    await call(tools, 'ledger_init', { symbol: '000001', type: 'stock', name: 'B', init_qty: 100, init_cost: 10, init_cash: 5000 })

    // 查 A：不受 B 影响
    const a = valueOf(await call(tools, 'ledger_query', { symbol: '588000' })) as {
      qty: number; cash: number; name: string
    }
    expect(a.qty).toBe(1500) // 1000 + 500，与 B 无关
    expect(a.name).toBe('A')

    // 查 B：干净，仅 100 股
    const b = valueOf(await call(tools, 'ledger_query', { symbol: '000001' })) as {
      qty: number; name: string
    }
    expect(b.qty).toBe(100)
    expect(b.name).toBe('B')

    // B 无预判 / 无复盘 / 统计为 0
    expect((valueOf(await call(tools, 'predict_get', { symbol: '000001', date: '2026-09-29' })) as { prediction: unknown }).prediction).toBeNull()
    expect((valueOf(await call(tools, 'review_get', { symbol: '000001' })) as { reports: unknown[] }).reports).toEqual([])
    expect((valueOf(await call(tools, 'review_metrics', { symbol: '000001' })) as { dir_hit_rate: number }).dir_hit_rate).toBe(0)

    // 磁盘目录也是两套
    expect(readdirSync(join(dir, 'ledger')).sort()).toEqual(['000001', '588000'])
    console.log('[EVIDENCE AC5] A(588000) qty=1500 unaffected; B(000001) isolated qty=100')
  })

  it('对 B 写不影响 A：先写 A，再写 B，再查 A 值不变', async () => {
    await call(tools, 'ledger_init', { symbol: '588000', type: 'etf', init_qty: 1000, init_cost: 2, init_cash: 100000 })
    const before = valueOf(await call(tools, 'ledger_query', { symbol: '588000' }))
    await call(tools, 'ledger_init', { symbol: '000001', type: 'stock', init_qty: 100, init_cost: 10, init_cash: 5000 })
    await call(tools, 'ledger_trade', { symbol: '000001', side: 'buy', qty: 100, price: 20 })
    const after = valueOf(await call(tools, 'ledger_query', { symbol: '588000' }))
    expect(after).toEqual(before)
  })
})

/* ================================================================== *
 * 验收点 6：exec.signal 取消 → 可中断，不产生半写状态
 * ================================================================== */

describe('验收点 6：exec.signal 取消（registry 管线 + 工具级守卫）', () => {
  it('registry.execute 传已 abort 的 signal → isError=true（ABORTED_BEFORE_DISPATCH），无半写', async () => {
    const ctrl = new AbortController()
    ctrl.abort()

    const r = await call(
      tools,
      'ledger_init',
      { symbol: '588000', type: 'etf', init_qty: 1000, init_cost: 2, init_cash: 100000 },
      ctrl.signal,
    )
    expect(r.isError).toBe(true)
    expect(r.error?.info?.code).toBe('ABORTED_BEFORE_DISPATCH')

    // 无半写：ledger 目录为空（或不存在）
    const ledgerDir = join(dir, 'ledger')
    const dirs = existsSync(ledgerDir) ? readdirSync(ledgerDir) : []
    expect(dirs).toEqual([])
    // list 仍为空
    const list = valueOf(await call(tools, 'ledger_list', {})) as { symbols: unknown[] }
    expect(list.symbols).toEqual([])
    console.log(`[EVIDENCE AC6] aborted ledger_init -> code=${r.error?.info?.code}, no residual`)
  })

  it('registry.execute 取消 sense_archive_commit → isError，且无版本目录', async () => {
    const ctrl = new AbortController()
    ctrl.abort()
    const r = await call(
      tools,
      'sense_archive_commit',
      { change_type: 'replace', rationale: 'r', code: 'c' },
      ctrl.signal,
    )
    expect(r.isError).toBe(true)
    const svDir = join(dir, 'sense_versions')
    const versions = existsSync(svDir) ? readdirSync(svDir).filter((e) => /^v\d/.test(e)) : []
    expect(versions).toEqual([])
  })

  it('工具级守卫：直接调用 execute 且 signal 已 abort → 抛错（不落盘）', async () => {
    const def = tools.get('ledger_init')!
    const ctrl = new AbortController()
    ctrl.abort()
    await expect(
      def.execute(
        { symbol: '588000', type: 'etf', init_qty: 1000, init_cost: 2, init_cash: 100000 },
        { signal: ctrl.signal } as never,
      ),
    ).rejects.toThrow(/取消|abort/i)
    const ledgerDir = join(dir, 'ledger')
    const dirs = existsSync(ledgerDir) ? readdirSync(ledgerDir) : []
    expect(dirs).toEqual([])
  })

  it('工具级守卫：sense_archive_commit 直接调用且 signal 已 abort → 抛错且无版本', async () => {
    const def = tools.get('sense_archive_commit')!
    const ctrl = new AbortController()
    ctrl.abort()
    await expect(
      def.execute(
        { change_type: 'replace', rationale: 'r', code: 'c' },
        { signal: ctrl.signal } as never,
      ),
    ).rejects.toThrow(/取消|abort/i)
    const svDir = join(dir, 'sense_versions')
    const versions = existsSync(svDir) ? readdirSync(svDir).filter((e) => /^v\d/.test(e)) : []
    expect(versions).toEqual([])
  })
})

/* ================================================================== *
 * 端到端：建标的 → 建预判 → 校验命中 → 复盘 → metrics → retrospect
 * ================================================================== */

describe('端到端：标的全链路经工具层走通', () => {
  it('ledger_init → predict_make → predict_verify → review_report → review_metrics → review_retrospect', async () => {
    const init = await call(tools, 'ledger_init', {
      symbol: '588000', type: 'etf', init_qty: 1000, init_cost: 10, init_cash: 100000,
    })
    expect(init.isError, textOf(init)).toBe(false)

    const mk = await call(tools, 'predict_make', {
      symbol: '588000', date: '2026-09-29', dir: 'up',
      range_low: 9, range_high: 12, confidence: 0.8, watch_points: ['突破 11'],
    })
    expect(mk.isError, textOf(mk)).toBe(false)

    const ver = await call(tools, 'predict_verify', {
      symbol: '588000', date: '2026-09-29',
      actual_close: 11, actual_high: 12, actual_low: 9.5, prev_close: 10,
    })
    expect(ver.isError, textOf(ver)).toBe(false)
    const vv = valueOf(ver) as { hit_dir: boolean; hit_range: boolean; deviation: number }
    expect(vv.hit_dir).toBe(true)
    expect(vv.hit_range).toBe(true)
    expect(vv.deviation).toBe(0)

    const rep = await call(tools, 'review_report', {
      symbol: '588000', date: '2026-09-29',
      decision_triggered: true, decision_executed: true, hit_dir: true, hit_range: true,
    })
    expect(rep.isError, textOf(rep)).toBe(false)

    const met = await call(tools, 'review_metrics', { symbol: '588000' })
    expect(met.isError, textOf(met)).toBe(false)
    const mv = valueOf(met) as { dir_hit_rate: number; range_hit_rate: number; history: unknown[] }
    expect(mv.dir_hit_rate).toBe(1)
    expect(mv.range_hit_rate).toBe(1)
    expect(Array.isArray(mv.history)).toBe(true)
    expectSchemaOk(tools, 'review_metrics', mv)

    const ret = await call(tools, 'review_retrospect', { symbol: '588000' })
    expect(ret.isError, textOf(ret)).toBe(false)
    const rv = valueOf(ret) as { root_cause: string; improvements: string[] }
    expect(typeof rv.root_cause).toBe('string')
    expect(Array.isArray(rv.improvements)).toBe(true)
    expectSchemaOk(tools, 'review_retrospect', rv)

    console.log(
      `[EVIDENCE E2E] ledger->predict(dirHit=${vv.hit_dir},rangeHit=${vv.hit_range})->verify->report->` +
        `metrics(dir=${mv.dir_hit_rate},range=${mv.range_hit_rate})->retrospect OK`,
    )
  })
})
