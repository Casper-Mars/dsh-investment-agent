/**
 * tester-strategy-feature.INDEPENDENT.spec.ts —— Tester 独立复验（策略域改造统一独立复验 + 全量回归）。
 *
 * 定位：对 Task-17~24 策略域改造做**端到端**（真实注册 + 真实工具调用）+ 全量回归复验。
 * 与 Developer 测试的区别：
 *   - Developer tests/strategy.test.ts / thresholds.test.ts 直接调用 domain / ToolContext；
 *   - 本文件走**真实** @deepseek-ai/dsh-tools ToolRuntime registry 管线
 *     （`new Context()` → `provide('systemPrompt')` → `plugin(ToolRuntime)` → `registerAllTools`），
 *     策略版本链 / 阈值来源 / 复盘检讨判定均经**工具层**（ledger_init → strategy_set → …）。
 *
 * 覆盖 8 项验收（逐条给证据，禁止只做代码审查）：
 *   1. 策略版本链 E2E（v001→v002 / 落盘 / current 指针 / 版本不可变 / parent 冲突 / 未 init / 未设定）
 *   2. 阈值来源 E2E（front-matter → 旧 json → 默认；非法键回落且不抛）
 *   3. review_retrospect 端到端（调整策略阈值可翻转「触发检讨」结论）
 *   4. 运行时可见性（真实插件装载：工具 21 / SKILL 5 可进化 + 1 固有）
 *   5. 旧功能全量回归（ledger_* / predict_* / review_*）
 *   6. Prompt/Skill 文本（advisor 6 步 + 措辞；3 skill 无残留；strategy-authorship 注册且 frontmatter 合法）
 *   7. 契约未变（顶层 inject 三项；cordis.patch.yml 无 diff；无新依赖）
 *   8. typecheck/build/test 全绿（由外部命令复核，见 REPORT）
 *
 * 约束：不改 src/** 与既有测试；一律临时 dataRoot；结束清理。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import ToolRuntime, { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import { createToolContext, DEFAULT_THRESHOLDS, type ToolContext } from '../src/tools/context.js'
import { createAllTools, registerAllTools } from '../src/tools/index.js'
import { parseStrategyDoc } from '../src/domain/strategy.js'
import { JsonStore } from '../src/domain/store.js'
import { SKILL_NAMES } from '../src/skills/index.js'
import { parseSkillFile } from '../src/skills/frontmatter.js'
import { apply, inject as topLevelInject, name as pluginName } from '../src/plugin.js'

/* ================================================================== *
 * 真实 registry 引导（复用 tester-tools-runtime 的 ToolRuntime 范式）
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

async function bootRegistry(dataRoot: string): Promise<Booted> {
  const app = new Context()
  app.provide('systemPrompt', systemPromptStub())
  const toolsFiber = (await app.plugin(ToolRuntime as never)) as unknown as {
    dispose: () => Promise<void>
  }
  const pluginFiber = app.plugin({
    name: 'dsh-ia-tools',
    inject: ['tools'],
    apply(ctx: Context) {
      registerAllTools(ctx, { dataRoot })
    },
  } as never) as unknown as { dispose: () => Promise<void> }

  const tools = (app as unknown as { tools: ToolBox }).tools
  await vi.waitFor(
    () => {
      expect(tools.schemas()).toHaveLength(14)
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
): Promise<RegistryResult> {
  seq += 1
  return tools.execute({
    callId: `t-strat-${seq}`,
    name,
    arguments: args,
    signal: new AbortController().signal,
  })
}

const textOf = (r: RegistryResult): string =>
  r.content.map((c) => c.text ?? '').join('\n')
const valueOf = (r: RegistryResult): unknown => r.value

/** 生成带 front-matter 的策略文档正文。 */
function strategyText(frontmatter: string, body = '自然语言策略正文'): string {
  return `---\n${frontmatter}\n---\n${body}`
}

/* ================================================================== *
 * 生命周期
 * ================================================================== */

let dir: string
let booted: Booted
let tools: ToolBox

beforeEach(async () => {
  // ledger_trade 连续竞价时段硬闸门（bc448d1）：固定系统时间到竞价时段。
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-10-13T10:00:00'))
  dir = mkdtempSync(join(tmpdir(), 'dsh-fin-strat-'))
  booted = await bootRegistry(dir)
  tools = booted.tools
})

afterEach(async () => {
  vi.useRealTimers()
  await booted.dispose()
  rmSync(dir, { recursive: true, force: true })
})

/* ================================================================== *
 * 1. 策略版本链 E2E（经工具层）
 * ================================================================== */

describe('1. 策略版本链 E2E（真实 registry + 工具层）', () => {
  const SYM = '588000'
  const strategyDir = () => join(dir, 'strategy')
  const versionsDir = () => join(dir, 'strategy_versions', SYM)

  async function initSymbol(): Promise<void> {
    const r = await call(tools, 'ledger_init', {
      symbol: SYM, type: 'etf', name: '科创50ETF',
      init_qty: 1000, init_cost: 1.95, init_cash: 100000,
    })
    expect(r.isError, textOf(r)).toBe(false)
  }

  it('ledger_init → strategy_set(首版) → strategy_get → strategy_set(parent=首版) → strategy_get：版本 v001→v002', async () => {
    await initSymbol()

    const v1 = await call(tools, 'strategy_set', {
      symbol: SYM, text: '首版策略正文', rationale: '首版理由',
    })
    expect(v1.isError, textOf(v1)).toBe(false)
    expect(valueOf(v1)).toEqual({ ok: true, version: 'v001' })

    const g1 = await call(tools, 'strategy_get', { symbol: SYM })
    expect(g1.isError, textOf(g1)).toBe(false)
    expect(valueOf(g1)).toMatchObject({ symbol: SYM, version: 'v001', text: '首版策略正文' })

    const v2 = await call(tools, 'strategy_set', {
      symbol: SYM, text: '二版策略正文', rationale: '二版理由', parent_version: 'v001',
    })
    expect(v2.isError, textOf(v2)).toBe(false)
    expect(valueOf(v2)).toEqual({ ok: true, version: 'v002' })

    const g2 = await call(tools, 'strategy_get', { symbol: SYM })
    expect(g2.isError, textOf(g2)).toBe(false)
    expect(valueOf(g2)).toMatchObject({ symbol: SYM, version: 'v002', text: '二版策略正文' })

    console.log('[EVIDENCE 1a] strategy version chain v001 -> v002 via tool layer')
  })

  it('落盘：strategy/<symbol>.md 与 vNNN.md 内容正确；current 指针 = 最新版', async () => {
    await initSymbol()
    await call(tools, 'strategy_set', { symbol: SYM, text: '首版策略正文', rationale: 'r1' })
    await call(tools, 'strategy_set', {
      symbol: SYM, text: '二版策略正文', rationale: 'r2', parent_version: 'v001',
    })

    expect(readFileSync(join(strategyDir(), `${SYM}.md`), 'utf8')).toBe('二版策略正文')
    expect(readFileSync(join(versionsDir(), 'v001.md'), 'utf8')).toBe('首版策略正文')
    expect(readFileSync(join(versionsDir(), 'v002.md'), 'utf8')).toBe('二版策略正文')
    expect(readFileSync(join(versionsDir(), 'current'), 'utf8').trim()).toBe('v002')

    const meta2 = JSON.parse(readFileSync(join(versionsDir(), 'v002.meta.json'), 'utf8'))
    expect(meta2.version).toBe('v002')
    expect(meta2.parent).toBe('v001')
    expect(meta2.rationale).toBe('r2')

    console.log('[EVIDENCE 1b] disk layout correct: strategy/588000.md=v002 body, current pointer=v002, v002.meta.parent=v001')
  })

  it('版本不可变：v001.md / v001.meta.json 内容未被改写', async () => {
    await initSymbol()
    await call(tools, 'strategy_set', { symbol: SYM, text: '首版策略正文', rationale: 'r1' })

    const v001mdBefore = readFileSync(join(versionsDir(), 'v001.md'), 'utf8')
    const v001metaBefore = readFileSync(join(versionsDir(), 'v001.meta.json'), 'utf8')

    await call(tools, 'strategy_set', {
      symbol: SYM, text: '二版策略正文', rationale: 'r2', parent_version: 'v001',
    })

    expect(readFileSync(join(versionsDir(), 'v001.md'), 'utf8')).toBe(v001mdBefore)
    expect(readFileSync(join(versionsDir(), 'v001.meta.json'), 'utf8')).toBe(v001metaBefore)

    // 回读历史版本，内容与首版一致。
    const g = await call(tools, 'strategy_get', { symbol: SYM, version: 'v001' })
    expect(g.isError, textOf(g)).toBe(false)
    expect(valueOf(g)).toMatchObject({ version: 'v001', text: '首版策略正文' })

    console.log('[EVIDENCE 1c] v001.md / v001.meta.json immutable across v002 write')
  })

  it('parent_version 给错 → 抛冲突（isError）', async () => {
    await initSymbol()
    await call(tools, 'strategy_set', { symbol: SYM, text: '首版', rationale: 'r1' })
    await call(tools, 'strategy_set', {
      symbol: SYM, text: '二版', rationale: 'r2', parent_version: 'v001',
    })

    const bad = await call(tools, 'strategy_set', {
      symbol: SYM, text: '三版', rationale: 'r3', parent_version: 'v001',
    })
    expect(bad.isError).toBe(true)
    expect(textOf(bad)).toMatch(/不一致/)
    console.log(`[EVIDENCE 1d] wrong parent_version -> conflict: ${textOf(bad)}`)
  })

  it('未 ledger_init 就 strategy_set → 抛错', async () => {
    const r = await call(tools, 'strategy_set', {
      symbol: '999999', text: 'x', rationale: 'r',
    })
    expect(r.isError).toBe(true)
    expect(textOf(r)).toMatch(/台账注册|ledger_init/)
    console.log(`[EVIDENCE 1e] strategy_set without ledger_init -> error: ${textOf(r)}`)
  })

  it('未设定就 strategy_get → 抛错', async () => {
    await initSymbol()
    const r = await call(tools, 'strategy_get', { symbol: SYM })
    expect(r.isError).toBe(true)
    expect(textOf(r)).toMatch(/尚无策略文档|strategy_set/)
    console.log(`[EVIDENCE 1f] strategy_get without set -> error: ${textOf(r)}`)
  })
})

/* ================================================================== *
 * 2. 阈值来源 E2E（getThresholds 三级优先级）
 * ================================================================== */

describe('2. 阈值来源 E2E（front-matter → 旧 json → 默认）', () => {
  const SYM = '588000'

  it('① 带 front-matter thresholds 的策略文档 → 取其间值', () => {
    const ctx = createToolContext({ dataRoot: dir })
    ctx.strategy.set(SYM, {
      text: strategyText(
        'thresholds:\n  dir_hit_min: 0.7\n  cum_return_min: 0.05\n  miss_streak_max: 5',
      ),
      rationale: 'r',
    })
    expect(ctx.getThresholds(SYM)).toEqual({
      dirHitMin: 0.7,
      cumReturnMin: 0.05,
      missStreakMax: 5,
    })
    console.log('[EVIDENCE 2a] front-matter thresholds read: {0.7,0.05,5}')
  })

  it('② 无 front-matter（策略无 thresholds）→ 回落旧 thresholds.json', () => {
    const ctx = createToolContext({ dataRoot: dir })
    ctx.strategy.set(SYM, { text: '无 front-matter 的正文', rationale: 'r' })
    new JsonStore(dir).writeTable(SYM, 'thresholds', {
      dirHitMin: 0.55,
      cumReturnMin: 0.01,
      missStreakMax: 4,
    })
    expect(ctx.getThresholds(SYM)).toEqual({
      dirHitMin: 0.55,
      cumReturnMin: 0.01,
      missStreakMax: 4,
    })
    console.log('[EVIDENCE 2b] no front-matter -> legacy thresholds.json fallback')
  })

  it('③ 无策略无旧表 → 回落默认', () => {
    const ctx = createToolContext({ dataRoot: dir })
    expect(ctx.getThresholds(SYM)).toEqual(DEFAULT_THRESHOLDS)
    console.log('[EVIDENCE 2c] no strategy/no json -> DEFAULT_THRESHOLDS')
  })

  it('非法键（负数/非整数/NaN/Infinity/dir_hit_min>1）→ 该键回落默认且不抛', () => {
    const cases: Array<[string, string, keyof typeof DEFAULT_THRESHOLDS]> = [
      // frontmatter 片段, 字段名, 期望回落的默认字段
      ['dir_hit_min: -0.2', 'dirHitMin'],
      ['dir_hit_min: 1.5', 'dirHitMin'],
      ['dir_hit_min: NaN', 'dirHitMin'],
      ['dir_hit_min: Infinity', 'dirHitMin'],
      ['miss_streak_max: 2.5', 'missStreakMax'],
      ['miss_streak_max: NaN', 'missStreakMax'],
      ['miss_streak_max: Infinity', 'missStreakMax'],
      ['miss_streak_max: -1', 'missStreakMax'],
    ]
    cases.forEach(([fm, field], i) => {
      // 每例独立标的，避免版本链「非首版必须带 parentVersion」干扰。
      const symbol = `5880${String(i).padStart(2, '0')}`
      const ctx = createToolContext({ dataRoot: dir })
      ctx.strategy.set(symbol, {
        text: strategyText(`thresholds:\n  ${fm}`),
        rationale: 'r',
      })
      expect(() => ctx.getThresholds(symbol)).not.toThrow()
      const got = ctx.getThresholds(symbol)
      expect(got[field], `${fm} 应回落默认`).toBe(DEFAULT_THRESHOLDS[field])
    })
    console.log(`[EVIDENCE 2d] ${cases.length} illegal keys all fall back to default without throwing`)
  })
})

/* ================================================================== *
 * 3. review_retrospect 端到端（阈值驱动，可翻转）
 * ================================================================== */

describe('3. review_retrospect 端到端：触发检讨由策略文档阈值决定', () => {
  const SYM = '588000'

  async function seedHalfHit(): Promise<void> {
    // 初始资金 0 使 cum_return=0（避免干扰方向命中率判定），成本 10。
    const init = await call(tools, 'ledger_init', {
      symbol: SYM, type: 'etf', init_qty: 1000, init_cost: 10, init_cash: 0,
    })
    expect(init.isError, textOf(init)).toBe(false)

    // 两条复盘：一命中一未命中 → dir_hit_rate = 0.5。
    await call(tools, 'review_report', {
      symbol: SYM, date: '2026-09-29',
      decision_triggered: true, decision_executed: true, hit_dir: true, hit_range: true,
    })
    await call(tools, 'review_report', {
      symbol: SYM, date: '2026-09-30',
      decision_triggered: true, decision_executed: true, hit_dir: false, hit_range: false,
    })
  }

  it('无策略（默认 dirHitMin=0.6）→ 方向命中率 0.5 触发检讨', async () => {
    await seedHalfHit()
    const m = await call(tools, 'review_metrics', { symbol: SYM })
    expect(valueOf(m)).toMatchObject({ dir_hit_rate: 0.5 })

    const r = await call(tools, 'review_retrospect', { symbol: SYM })
    expect(r.isError, textOf(r)).toBe(false)
    const root = (valueOf(r) as { root_cause: string }).root_cause
    expect(root).toMatch(/方向命中率低于下限/)
    console.log(`[EVIDENCE 3a] default threshold -> retrospect triggered: ${root}`)
  })

  it('策略文档 dir_hit_min=0.4 → 0.5 不再触发（结论翻转）', async () => {
    await seedHalfHit()
    const set = await call(tools, 'strategy_set', {
      symbol: SYM,
      text: strategyText('thresholds:\n  dir_hit_min: 0.4\n  cum_return_min: 0'),
      rationale: '放宽方向命中率阈值',
    })
    expect(set.isError, textOf(set)).toBe(false)

    const r = await call(tools, 'review_retrospect', { symbol: SYM })
    expect(r.isError, textOf(r)).toBe(false)
    const root = (valueOf(r) as { root_cause: string }).root_cause
    expect(root).toBe('表现未劣于阈值，无需根因定位')
    console.log(`[EVIDENCE 3b] strategy dir_hit_min=0.4 -> not triggered (flipped): ${root}`)
  })
})

/* ================================================================== *
 * 4. 运行时可见性（真实插件装载：工具 21 / SKILL 5 可进化 + 1 固有）
 * ================================================================== */

describe('4. 运行时可见性：真实插件装载路径', () => {
  it('顶层 inject 契约 + 真实装载后工具 21 / SKILL 5 可进化（+ 1 固有，skill-filesystem provider）', async () => {
    expect(topLevelInject).toEqual(['tools', 'skills', 'fs'])

    process.env.DSH_IA_DATA_DIR = dir
    const app = new Context()
    app.provide('systemPrompt', systemPromptStub())
    await (app.plugin(SkillRegistry as never) as Promise<unknown>)

    // 注：测试装载 inject 仅取 ['tools','skills']——本测试不提供真实的 dsh-fs 服务，
    // 而 skill-filesystem provider 在 `ctx.get('fs')` 存在时会经其读取 custom roots；
    // 若提供不兼容的 fs 桩会使其发现失效。缺省 fs 时 provider 回落到 node fs。
    const toolsFiber = (await app.plugin(ToolRuntime as never)) as unknown as {
      dispose: () => Promise<void>
    }
    const pluginFiber = app.plugin({
      name: pluginName,
      inject: ['tools', 'skills'],
      apply,
    } as never) as unknown as { dispose: () => Promise<void> }

    const toolsBox = (app as unknown as { tools: ToolBox }).tools
    await vi.waitFor(
      () => {
        expect(toolsBox.schemas()).toHaveLength(21)
      },
      { timeout: 8000, interval: 10 },
    )

    // SKILL 由挂载的 skill-filesystem provider 提供（惰性加载 + watch）：等其就绪。
    let skillNames: string[] = []
    await vi.waitFor(
      async () => {
        const list = await app.skills.list({})
        skillNames = list
          .map((s) => s.name)
          .filter((n) => (SKILL_NAMES as readonly string[]).includes(n))
          .sort()
        expect(skillNames).toEqual([...SKILL_NAMES].sort())
      },
      { timeout: 8000, interval: 50 },
    )

    console.log(
      `[EVIDENCE 4] plugin load -> tools=${toolsBox.schemas().length}, skills=${skillNames.length} ` +
        `(${skillNames.join(',')})`,
    )

    await pluginFiber.dispose()
    await toolsFiber.dispose()
    delete process.env.DSH_IA_DATA_DIR
  }, 20000)

  it('随包种子 frontmatter 合法（5 个可进化；strategy-authorship 在目次）', () => {
    expect(SKILL_NAMES).toHaveLength(5)
    for (const n of SKILL_NAMES) {
      const parsed = parseSkillFile(
        readFileSync(join(process.cwd(), 'src/skills', n, 'SKILL.md'), 'utf8'),
      )
      expect(parsed.frontmatter.name).toBe(n)
      expect(parsed.frontmatter.description.length).toBeGreaterThan(0)
      expect(parsed.content.length).toBeGreaterThan(0)
    }
    // strategy-authorship 在目次中。
    expect(SKILL_NAMES).toContain('strategy-authorship')
  })
})

/* ================================================================== *
 * 5. 旧功能全量回归（ledger_* / predict_* / review_*）
 * ================================================================== */

describe('5. 旧功能全量回归（工具层）', () => {
  const SYM = '588000'

  it('ledger_*：init/list/query/trade 全链路', async () => {
    const init = await call(tools, 'ledger_init', {
      symbol: SYM, type: 'etf', name: '科创50ETF', init_qty: 1000, init_cost: 2, init_cash: 100000,
    })
    expect(init.isError, textOf(init)).toBe(false)

    const list = await call(tools, 'ledger_list', {})
    expect((valueOf(list) as { symbols: unknown[] }).symbols).toHaveLength(1)

    const buy = await call(tools, 'ledger_trade', { symbol: SYM, side: 'buy', qty: 500, price: 3 })
    expect(valueOf(buy)).toMatchObject({ ok: true, new_qty: 1500, avg_cost: 2.3333 })

    const sell = await call(tools, 'ledger_trade', { symbol: SYM, side: 'sell', qty: 500, price: 3.5 })
    expect(valueOf(sell)).toMatchObject({ ok: true, new_qty: 1000 })

    const q = await call(tools, 'ledger_query', { symbol: SYM })
    expect(valueOf(q)).toMatchObject({ symbol: SYM, qty: 1000, avg_cost: 2.3333 })
    console.log('[EVIDENCE 5a] ledger init/list/query/trade OK')
  })

  it('predict_*：make/get/verify 全链路', async () => {
    await call(tools, 'ledger_init', {
      symbol: SYM, type: 'etf', init_qty: 1000, init_cost: 10, init_cash: 100000,
    })
    const mk = await call(tools, 'predict_make', {
      symbol: SYM, date: '2026-09-29', dir: 'up',
      range_low: 9, range_high: 12, confidence: 0.8, watch_points: ['突破'],
    })
    expect(mk.isError, textOf(mk)).toBe(false)

    const get = await call(tools, 'predict_get', { symbol: SYM, date: '2026-09-29' })
    expect((valueOf(get) as { prediction: { dir: string } }).prediction.dir).toBe('up')

    const ver = await call(tools, 'predict_verify', {
      symbol: SYM, date: '2026-09-29',
      actual_close: 11, actual_high: 12, actual_low: 9.5, prev_close: 10,
    })
    expect(valueOf(ver)).toEqual({ hit_dir: true, hit_range: true, deviation: 0 })
    console.log('[EVIDENCE 5b] predict make/get/verify OK')
  })

  it('review_*：check/report/get/metrics 全链路', async () => {
    await call(tools, 'ledger_init', {
      symbol: SYM, type: 'etf', init_qty: 1000, init_cost: 10, init_cash: 100000,
    })
    const chk = await call(tools, 'review_check', {
      symbol: SYM, date: '2026-09-29', decision_triggered: true, decision_executed: true,
      hit_dir: true, hit_range: true,
    })
    expect(valueOf(chk)).toMatchObject({ decision_triggered: true, decision_executed: true })

    const rep = await call(tools, 'review_report', {
      symbol: SYM, date: '2026-09-29',
      decision_triggered: true, decision_executed: true, hit_dir: true, hit_range: true,
    })
    expect((valueOf(rep) as { ok: boolean }).ok).toBe(true)

    const get = await call(tools, 'review_get', { symbol: SYM })
    expect((valueOf(get) as { reports: unknown[] }).reports).toHaveLength(1)

    const met = await call(tools, 'review_metrics', { symbol: SYM })
    expect(valueOf(met)).toMatchObject({ dir_hit_rate: 1, range_hit_rate: 1 })
    console.log('[EVIDENCE 5c] review check/report/get/metrics OK')
  })
})

/* ================================================================== *
 * 6. Prompt / Skill 文本
 * ================================================================== */

describe('6. Prompt / Skill 文本', () => {
  const advisor = () =>
    readFileSync(join(process.cwd(), 'src/prompts/advisor.md'), 'utf8')
  const skill = (name: string) =>
    readFileSync(join(process.cwd(), 'src/skills', name, 'SKILL.md'), 'utf8')

  it('advisor.md 为 6 步工作流，且含「策略由你负责生成与迭代，不依赖用户输入」', () => {
    const a = advisor()
    const steps = a.split('\n').filter((l) => /^[一二三四五六七八九十]、/.test(l))
    expect(steps).toHaveLength(6)
    expect(steps[0]).toContain('建立标的')
    expect(steps[5]).toContain('双线迭代')
    expect(a).toContain('策略由你负责生成与迭代，不依赖用户输入')
    console.log('[EVIDENCE 6a] advisor.md 6-step workflow confirmed')
  })

  it('3 个 skill 无「从该标的策略配置读取」残留，且含「遵循该标的策略文档」', () => {
    for (const name of ['trend-analysis', 'grid-strategy', 'stop-rule']) {
      const c = skill(name)
      expect(c, `${name} 不应含残留`).not.toContain('从该标的策略配置读取')
      expect(c, `${name} 应含新措辞`).toContain('遵循该标的策略文档')
    }
    console.log('[EVIDENCE 6b] 3 skills wording aligned (no residual)')
  })

  it('strategy-authorship 已注册且 frontmatter 合法', () => {
    expect(SKILL_NAMES).toContain('strategy-authorship')
    const parsed = parseSkillFile(skill('strategy-authorship'))
    expect(parsed.frontmatter.name).toBe('strategy-authorship')
    expect(parsed.frontmatter.description.length).toBeGreaterThan(0)
    console.log('[EVIDENCE 6c] strategy-authorship registered + valid frontmatter')
  })

  it('parseStrategyDoc 纯函数语义（无 front-matter / 嵌套 / 非法）', () => {
    expect(parseStrategyDoc('普通正文').structured).toEqual({})
    const nested = parseStrategyDoc(
      strategyText('thresholds:\n  dir_hit_min: 0.7\n  miss_streak_max: 3'),
    )
    expect(nested.structured.thresholds).toEqual({ dir_hit_min: 0.7, miss_streak_max: 3 })
  })
})

/* ================================================================== *
 * 7. 契约未变
 * ================================================================== */

describe('7. 契约未变', () => {
  it('顶层 inject 三项 + cordis.patch.yml inject 一致', () => {
    expect(topLevelInject).toEqual(['tools', 'skills', 'fs'])

    const patch = readFileSync(join(process.cwd(), 'cordis.patch.yml'), 'utf8')
    expect(patch).toContain("inject: ['tools', 'skills', 'fs']")
    console.log('[EVIDENCE 7a] inject contract unchanged')
  })

  it('package.json 无新增依赖（dependencies 键缺失 = 全为 peer/dev）', () => {
    const pkg = JSON.parse(
      readFileSync(join(process.cwd(), 'package.json'), 'utf8'),
    ) as { dependencies?: Record<string, string> }
    expect(pkg.dependencies).toBeUndefined()
    console.log('[EVIDENCE 7b] no runtime dependencies added')
  })
})
