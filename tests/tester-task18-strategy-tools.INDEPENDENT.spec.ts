/**
 * 独立测试 —— Task-18「策略域工具层（strategy_get / strategy_set）」运行时验证。
 *
 * 被测交付物（工具层，Ta***s）：
 *   - 新增 src/tools/strategy.ts（createStrategyTools → strategy_get / strategy_set）
 *   - 改 src/tools/schemas.ts（+2 严格 schema）、src/tools/context.ts（ToolContext.strategy）、
 *     src/tools/index.ts（16→18）、src/tools/README.md、src/plugin.ts（仅注释）
 *
 * 本文件为 Tester 独立产出，**不改** src/ 与既有测试。
 * 一律用 mkdtemp 临时目录作为 dataRoot，直接构造真实 ToolContext + createAllTools，
 * 真实调用 ToolDefinition.execute(args, { signal })，不污染真实 dataRoot。
 *
 * 覆盖（对应任务卡 6 项必验点）：
 *   1. 注册与顺序（18 个；ledgers → strategy → predicts → reviews → sense_archives）
 *   2. 参数契约（strategy_get / strategy_set 的 required/optional）
 *   3. 行为（未初始化报错 / 首版 / 未设定读报错 / 版本递增与冲突 / 落盘）
 *   4. 中断语义（exec.signal aborted → 抛错且不落盘）
 *   5. schema 严格性（多余字段 / 缺失字段 → validateJsonSchemaValue 判失败）
 *   6. 契约未变（顶层 inject 四项 / cordis.patch.yml 无 diff / README 工具表 18）
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  existsSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import { createToolContext, type ToolContext } from '../src/tools/context.js'
import { createAllTools } from '../src/tools/index.js'

let dir: string
let ctx: ToolContext
let tools: ToolDefinition[]

/** 构造一个已 aborted / 未 aborted 的 exec（仅提供 signal）。 */
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

/** 执行工具并返回成功值（不抛错时）。 */
async function run(name: string, args: Record<string, unknown> = {}, aborted = false) {
  return tool(name).execute(args, makeExec(aborted))
}

/** ledger_init 一个标的（后续用例通用前置）。 */
async function initSymbol(symbol = '588000'): Promise<void> {
  await run('ledger_init', {
    symbol,
    type: 'etf',
    name: '科创50ETF',
    init_qty: 1000,
    init_cost: 1.95,
    init_cash: 100000,
  })
}

/** 用 output.schema 严格校验返回值（成功值必须逐字段对齐）。 */
function expectMatchesOutputSchema(name: string, value: unknown): void {
  const schema = tool(name).output.schema
  const violations = validateJsonSchemaValue(schema, value)
  expect(
    violations,
    `${name} 返回值 ${JSON.stringify(value)} 不符合 output.schema：${violations?.join('; ')}`,
  ).toEqual([])
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dsh-finance-task18-'))
  ctx = createToolContext({ dataRoot: dir })
  tools = createAllTools(ctx)
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('必验点 1：注册与顺序', () => {
  const expectedOrder = [
    'ledger_init', 'ledger_list', 'ledger_query', 'ledger_trade',
    'strategy_get', 'strategy_set',
    'predict_make', 'predict_verify', 'predict_get',
    'review_check', 'review_report', 'review_get', 'review_metrics', 'review_retrospect',
    'sense_archive_commit', 'sense_archive_list', 'sense_archive_rollback', 'sense_archive_get',
  ]

  it('createAllTools 长度为 18，名称齐全且无重复', () => {
    expect(tools.length).toBe(18)
    const names = tools.map((t) => t.name)
    expect(new Set(names).size).toBe(18)
    for (const n of expectedOrder) expect(names).toContain(n)
  })

  it('顺序严格为 ledgers → strategy → predicts → reviews → sense_archives', () => {
    const names = tools.map((t) => t.name)
    expect(names).toEqual(expectedOrder)
  })

  it('strategy_get / strategy_set 均注册且 description 非空、output.schema/render 就绪', () => {
    for (const n of ['strategy_get', 'strategy_set']) {
      const t = tool(n)
      expect(t.description.length).toBeGreaterThan(0)
      expect(t.output).toBeDefined()
      expect(t.output.schema).toBeDefined()
      expect(typeof t.output.render).toBe('function')
    }
  })
})

describe('必验点 2：参数契约', () => {
  interface CompiledParamSchema {
    type: string
    properties: Record<string, unknown>
    required?: string[]
  }
  const params = (name: string): CompiledParamSchema =>
    tool(name).parameters as unknown as CompiledParamSchema

  it('strategy_get：symbol 必填 + version 可选', () => {
    const p = params('strategy_get')
    expect(p.type).toBe('object')
    expect(p.required).toEqual(['symbol'])
    expect(Object.keys(p.properties).sort()).toEqual(['symbol', 'version'].sort())
  })

  it('strategy_set：symbol/text/rationale 必填 + parent_version 可选', () => {
    const p = params('strategy_set')
    expect(p.type).toBe('object')
    expect(p.required?.sort()).toEqual(['symbol', 'text', 'rationale'].sort())
    expect(Object.keys(p.properties).sort()).toEqual(
      ['symbol', 'text', 'rationale', 'parent_version'].sort(),
    )
  })
})

describe('必验点 3：行为（真实 execute，临时目录 dataRoot）', () => {
  it('a. 标的未 ledger_init → strategy_set 抛错，含引导「ledger_init」', async () => {
    await expect(
      run('strategy_set', { symbol: '999999', text: 'x', rationale: 'r' }),
    ).rejects.toThrow(/ledger_init/)
  })

  it('b. ledger_init 后首版 → {ok,version:v001}；strategy_get 往返字段与 text 一致', async () => {
    await initSymbol()
    const s = await run('strategy_set', {
      symbol: '588000',
      text: '# 首版\n买入并持有',
      rationale: '初始策略',
    })
    expect(s).toEqual({ ok: true, version: 'v001' })
    expectMatchesOutputSchema('strategy_set', s)

    const g = await run('strategy_get', { symbol: '588000' })
    expect(g).not.toHaveProperty('ok')
    expect(g).toEqual({
      symbol: '588000',
      text: '# 首版\n买入并持有',
      version: 'v001',
      updated_at: expect.any(String) as unknown,
    })
    expect((g as { updated_at: string }).updated_at).not.toBe('')
    // updated_at 是合法 ISO 时间
    expect(Number.isNaN(Date.parse((g as { updated_at: string }).updated_at))).toBe(false)
    expectMatchesOutputSchema('strategy_get', g)
  })

  it('c. 已注册但未设定策略的标的 strategy_get → 抛错，含引导「strategy_set」', async () => {
    await initSymbol()
    await expect(run('strategy_get', { symbol: '588000' })).rejects.toThrow(/strategy_set/)
  })

  it('d. parent_version=v001 → v002；parent_version 给错(v003) → 抛冲突错误', async () => {
    await initSymbol()
    await run('strategy_set', { symbol: '588000', text: 'v1', rationale: 'r1' })
    const v2 = await run('strategy_set', {
      symbol: '588000',
      text: 'v2',
      rationale: 'r2',
      parent_version: 'v001',
    })
    expect(v2).toEqual({ ok: true, version: 'v002' })
    expectMatchesOutputSchema('strategy_set', v2)

    // 当前 v002，声明 parent=v003（或过期的 v001）→ 冲突
    await expect(
      run('strategy_set', {
        symbol: '588000',
        text: 'v3',
        rationale: 'r3',
        parent_version: 'v003',
      }),
    ).rejects.toThrow(/不一致/)
    await expect(
      run('strategy_set', {
        symbol: '588000',
        text: 'v3',
        rationale: 'r3',
        parent_version: 'v001',
      }),
    ).rejects.toThrow(/不一致/)
  })

  it('e. 落盘真实存在（strategy/<symbol>.md、strategy_versions/<symbol>/v00N.md 等）', async () => {
    await initSymbol()
    await run('strategy_set', { symbol: '588000', text: '正文 A', rationale: 'r1' })
    await run('strategy_set', {
      symbol: '588000',
      text: '正文 B',
      rationale: 'r2',
      parent_version: 'v001',
    })

    // 当前版文档
    expect(existsSync(join(dir, 'strategy', '588000.md'))).toBe(true)
    expect(readFileSync(join(dir, 'strategy', '588000.md'), 'utf8')).toBe('正文 B')
    // 版本链正文
    expect(readFileSync(join(dir, 'strategy_versions', '588000', 'v001.md'), 'utf8')).toBe('正文 A')
    expect(readFileSync(join(dir, 'strategy_versions', '588000', 'v002.md'), 'utf8')).toBe('正文 B')
    // 版本 meta
    const meta1 = JSON.parse(
      readFileSync(join(dir, 'strategy_versions', '588000', 'v001.meta.json'), 'utf8'),
    )
    expect(meta1.version).toBe('v001')
    expect(meta1.rationale).toBe('r1')
    expect(meta1.parent).toBeUndefined()
    const meta2 = JSON.parse(
      readFileSync(join(dir, 'strategy_versions', '588000', 'v002.meta.json'), 'utf8'),
    )
    expect(meta2.version).toBe('v002')
    expect(meta2.rationale).toBe('r2')
    expect(meta2.parent).toBe('v001')
    // current 指针
    expect(
      readFileSync(join(dir, 'strategy_versions', '588000', 'current'), 'utf8').trim(),
    ).toBe('v002')
  })
})

describe('必验点 4：中断语义（exec.signal aborted → 抛错且不落盘）', () => {
  it('strategy_set 已 aborted → 抛错，且 strategy/ 无任何落盘', async () => {
    await initSymbol()
    await expect(
      run('strategy_set', { symbol: '588000', text: 'v1', rationale: 'r1' }, true),
    ).rejects.toThrow(/取消/)

    // 不落盘：无 strategy/<symbol>.md，也无版本链目录
    expect(existsSync(join(dir, 'strategy', '588000.md'))).toBe(false)
    expect(existsSync(join(dir, 'strategy_versions', '588000'))).toBe(false)

    // 后续 strategy_get 仍报「未设定」引导
    await expect(run('strategy_get', { symbol: '588000' })).rejects.toThrow(/strategy_set/)
  })
})

describe('必验点 5：schema 严格性（多余/缺失字段 → 校验失败）', () => {
  it('strategy_get 返回对象塞入多余字段 → validateJsonSchemaValue 判失败', () => {
    const schema = tool('strategy_get').output.schema
    const valid = {
      symbol: '588000',
      text: 'x',
      version: 'v001',
      updated_at: new Date().toISOString(),
    }
    expect(validateJsonSchemaValue(schema, valid)).toEqual([])

    const withExtra = { ...valid, extra_field: 'hack' }
    expect(validateJsonSchemaValue(schema, withExtra).length).toBeGreaterThan(0)
  })

  it('strategy_get 返回对象缺失字段 → validateJsonSchemaValue 判失败', () => {
    const schema = tool('strategy_get').output.schema
    const missingUpdatedAt = {
      symbol: '588000',
      text: 'x',
      version: 'v001',
      // 缺 updated_at
    }
    expect(validateJsonSchemaValue(schema, missingUpdatedAt).length).toBeGreaterThan(0)
  })

  it('strategy_set 返回对象塞入多余字段 → validateJsonSchemaValue 判失败', () => {
    const schema = tool('strategy_set').output.schema
    expect(validateJsonSchemaValue(schema, { ok: true, version: 'v001' })).toEqual([])
    expect(
      validateJsonSchemaValue(schema, { ok: true, version: 'v001', symbol: 'x' }).length,
    ).toBeGreaterThan(0)
  })
})

describe('必验点 6：契约未变', () => {
  it('顶层 inject 四项；cordis.patch.yml 无策略域变更；README 工具表 18', () => {
    const pluginSrc = readFileSync(join(__dirname, '..', 'src', 'plugin.ts'), 'utf8')
    // inject 数组仍为四项（契约固定）
    expect(pluginSrc).toMatch(/export const inject: string\[\] = \['tools', 'skills', 'ptcRuntime', 'fs'\]/)

    const patchSrc = readFileSync(join(__dirname, '..', 'cordis.patch.yml'), 'utf8')
    expect(patchSrc).toMatch(/inject: \['tools', 'skills', 'ptcRuntime', 'fs'\]/)

    const readme = readFileSync(join(__dirname, '..', 'src', 'tools', 'README.md'), 'utf8')
    // 工具表为 18（标题声明 18 个）
    expect(readme).toMatch(/18 个/)
    const allNames = [
      'ledger_init', 'ledger_list', 'ledger_query', 'ledger_trade',
      'strategy_get', 'strategy_set',
      'predict_make', 'predict_verify', 'predict_get',
      'review_check', 'review_report', 'review_get', 'review_metrics', 'review_retrospect',
      'sense_archive_commit', 'sense_archive_list', 'sense_archive_rollback', 'sense_archive_get',
    ]
    for (const n of allNames) expect(readme).toContain(n)
  })
})
