/**
 * tester-task19-thresholds.INDEPENDENT.spec.ts —— Tester 独立运行时验证（Task-19 阈值来源迁移）。
 *
 * 被测交付物（HEAD add5a29 + 未提交改动）：
 *   - src/domain/strategy.ts：parseStrategyDoc（轻量 YAML front-matter，失败不抛）
 *   - src/tools/context.ts：getThresholds 三级优先级（front-matter → thresholds.json → DEFAULT）
 *   - src/domain/store.ts：saveThresholds 标注 @deprecated（已无调用方）
 *   - tests/thresholds.test.ts（Developer 自有，不改）
 *
 * 依据：详细设计 v1.7 §10.4 / §10.6。
 *
 * 与 Developer tests/thresholds.test.ts 的区别：本文件独立构造断言与证据，
 *  一律临时目录做 dataRoot（不污染真实数据），覆盖「运行时行为」逐条验收，
 *  并额外覆盖 Developer 未覆盖的边界（miss_streak_max 负数、.inf/NaN、无策略文档时
 *  的 legacy 回落、端到端 review_retrospect 触发切换、strategy_set 不再写 thresholds.json）。
 *
 * 只新增本测试文件，不改动 src/** 或任何既有测试。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseStrategyDoc } from '../src/domain/strategy.js'
import { JsonStore } from '../src/domain/store.js'
import { Ledger } from '../src/domain/ledger.js'
import { createToolContext, DEFAULT_THRESHOLDS, type ToolContext } from '../src/tools/context.js'
import { createAllTools } from '../src/tools/index.js'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'

let dir: string
let ctx: ToolContext

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dsh-ia-task19-'))
  ctx = createToolContext({ dataRoot: dir })
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

/** 生成带 front-matter 的策略文档正文。 */
function strategyText(frontmatter: string, body = '自然语言策略正文'): string {
  return `---\n${frontmatter}\n---\n${body}`
}

/** 记录证据（便于在 vitest 输出与报告中直接看到实际值）。 */
function ev(label: string, value: unknown): void {
  // eslint-disable-next-line no-console
  console.log(`[EVIDENCE] ${label} = ${JSON.stringify(value)}`)
}

/** 按名称取工具。 */
function toolOf(tools: ToolDefinition[], name: string): ToolDefinition {
  const t = tools.find((x) => x.name === name)
  if (!t) throw new Error(`工具 ${name} 未注册`)
  return t
}

describe('优先级①：策略 front-matter thresholds', () => {
  it('完整 thresholds → getThresholds 返回该值', () => {
    ctx.strategy.set('588000', {
      text: strategyText(
        'thresholds:\n  dir_hit_min: 0.6\n  cum_return_min: 0.02\n  miss_streak_max: 5',
      ),
      rationale: 'r',
    })
    const got = ctx.getThresholds('588000')
    ev('优先级①完整阈值', got)
    expect(got).toEqual({ dirHitMin: 0.6, cumReturnMin: 0.02, missStreakMax: 5 })
  })

  it('逐键回落：仅给 dir_hit_min → 其余两键回落 DEFAULT', () => {
    ctx.strategy.set('588000', {
      text: strategyText('thresholds:\n  dir_hit_min: 0.7'),
      rationale: 'r',
    })
    const got = ctx.getThresholds('588000')
    ev('逐键回落', got)
    expect(got.dirHitMin).toBe(0.7)
    expect(got.cumReturnMin).toBe(DEFAULT_THRESHOLDS.cumReturnMin)
    expect(got.missStreakMax).toBe(DEFAULT_THRESHOLDS.missStreakMax)
  })

  it('dir_hit_min: 1.5（>1）→ 该键回落默认', () => {
    ctx.strategy.set('588000', {
      text: strategyText('thresholds:\n  dir_hit_min: 1.5\n  cum_return_min: 0.03\n  miss_streak_max: 4'),
      rationale: 'r',
    })
    const got = ctx.getThresholds('588000')
    ev('dir_hit_min 1.5', got)
    expect(got.dirHitMin).toBe(DEFAULT_THRESHOLDS.dirHitMin)
    expect(got.cumReturnMin).toBe(0.03)
    expect(got.missStreakMax).toBe(4)
  })

  it('miss_streak_max: -1（负数）→ 该键回落默认（AC 要求）', () => {
    ctx.strategy.set('588000', {
      text: strategyText('thresholds:\n  dir_hit_min: 0.7\n  miss_streak_max: -1'),
      rationale: 'r',
    })
    const got = ctx.getThresholds('588000')
    ev('miss_streak_max -1', got)
    expect(got.missStreakMax).toBe(DEFAULT_THRESHOLDS.missStreakMax)
  })

  it('cum_return_min: "abc"（字符串）→ 该键回落默认', () => {
    ctx.strategy.set('588000', {
      text: strategyText('thresholds:\n  dir_hit_min: 0.7\n  cum_return_min: "abc"'),
      rationale: 'r',
    })
    const got = ctx.getThresholds('588000')
    ev('cum_return_min "abc"', got)
    expect(got.cumReturnMin).toBe(DEFAULT_THRESHOLDS.cumReturnMin)
    expect(got.dirHitMin).toBe(0.7)
  })

  it('dir_hit_min: .inf → 回落默认且不抛', () => {
    ctx.strategy.set('588000', {
      text: strategyText('thresholds:\n  dir_hit_min: .inf'),
      rationale: 'r',
    })
    expect(() => ctx.getThresholds('588000')).not.toThrow()
    const got = ctx.getThresholds('588000')
    ev('dir_hit_min .inf', got)
    expect(got.dirHitMin).toBe(DEFAULT_THRESHOLDS.dirHitMin)
  })

  it('dir_hit_min: NaN → 回落默认且不抛', () => {
    ctx.strategy.set('588000', {
      text: strategyText('thresholds:\n  dir_hit_min: NaN'),
      rationale: 'r',
    })
    expect(() => ctx.getThresholds('588000')).not.toThrow()
    const got = ctx.getThresholds('588000')
    ev('dir_hit_min NaN', got)
    expect(got.dirHitMin).toBe(DEFAULT_THRESHOLDS.dirHitMin)
  })
})

describe('优先级②：旧 thresholds.json 兼容回落', () => {
  it('策略文档无 front-matter + 存在旧表 → 取旧表值', () => {
    ctx.strategy.set('588000', { text: '无 front-matter 的正文', rationale: 'r' })
    new JsonStore(dir).writeTable('588000', 'thresholds', {
      dirHitMin: 0.55,
      cumReturnMin: 0.01,
      missStreakMax: 4,
    })
    const got = ctx.getThresholds('588000')
    ev('②策略无 front-matter 回落旧表', got)
    expect(got).toEqual({ dirHitMin: 0.55, cumReturnMin: 0.01, missStreakMax: 4 })
  })

  it('无策略文档 + 存在旧表 → 取旧表值', () => {
    new JsonStore(dir).writeTable('588000', 'thresholds', {
      dirHitMin: 0.5,
      cumReturnMin: 0.02,
      missStreakMax: 6,
    })
    const got = ctx.getThresholds('588000')
    ev('②无策略回落旧表', got)
    expect(got).toEqual({ dirHitMin: 0.5, cumReturnMin: 0.02, missStreakMax: 6 })
  })
})

describe('优先级③：两者都无 → DEFAULT_THRESHOLDS', () => {
  it('无策略无旧表 → 默认', () => {
    const got = ctx.getThresholds('588000')
    ev('③默认', got)
    expect(got).toEqual(DEFAULT_THRESHOLDS)
  })
})

describe('解析失败不抛 + parseError 非空', () => {
  it('thresholds: [1,2（流式集合未闭合）→ getThresholds 回落且不抛，parseError 非空', () => {
    ctx.strategy.set('588000', {
      text: strategyText('thresholds: [1,2'),
      rationale: 'r',
    })
    const parsed = parseStrategyDoc(ctx.strategy.get('588000')!.text)
    ev('parseError', parsed.parseError)
    expect(parsed.parseError).toBeTruthy()
    expect(parsed.structured).toEqual({})

    expect(() => ctx.getThresholds('588000')).not.toThrow()
    const got = ctx.getThresholds('588000')
    ev('流式集合回落结果', got)
    expect(got).toEqual(DEFAULT_THRESHOLDS)
  })
})

describe('端到端：review_retrospect 触发受策略文档阈值控制', () => {
  it('默认阈值触发；策略 front-matter 放宽后不再触发（证明阈值来自策略文档）', async () => {
    const tools = createAllTools(ctx)
    const retrospect = toolOf(tools, 'review_retrospect')
    const makeExec = () => ({ signal: new AbortController().signal })

    // 构造 per-symbol 累计统计：方向命中率 0.3（低于默认 0.6），cum_return=0（不触发累计收益归因）。
    ctx.reviews.record_metrics('588000', {
      date: '2026-09-29',
      dirHitRate: 0.3,
      rangeHitRate: 0.5,
      cumReturn: 0,
    })

    // 情形 A：默认阈值（无策略文档）→ dirHitRate 0.3 < 0.6 → 触发。
    const defaultResult = (await retrospect.execute({ symbol: '588000' }, makeExec())) as {
      root_cause: string
      improvements: string[]
    }
    ev('默认阈值 root_cause', defaultResult.root_cause)
    expect(defaultResult.root_cause).toContain('方向命中率')

    // 写入策略 front-matter：dir_hit_min 放宽到 0.2。
    ctx.strategy.set('588000', {
      text: strategyText('thresholds:\n  dir_hit_min: 0.2'),
      rationale: '放宽方向命中率下限',
    })
    const thAfter = ctx.getThresholds('588000')
    ev('策略阈值 dirHitMin', thAfter.dirHitMin)
    expect(thAfter.dirHitMin).toBe(0.2)

    // 情形 B：0.3 >= 0.2 → 不再触发。
    const relaxedResult = (await retrospect.execute({ symbol: '588000' }, makeExec())) as {
      root_cause: string
      improvements: string[]
    }
    ev('放宽后 root_cause', relaxedResult.root_cause)
    expect(relaxedResult.root_cause).toContain('未劣于')
    expect(relaxedResult.improvements).toEqual([])
  })
})

describe('strategy_set 不再写 thresholds.json', () => {
  it('调用 strategy_set 后 ledger/<symbol>/thresholds.json 不被创建', async () => {
    const tools = createAllTools(ctx)
    const strategySet = toolOf(tools, 'strategy_set')
    const makeExec = () => ({ signal: new AbortController().signal })

    // 标的须已注册。
    ctx.ledger.init('588000', { type: 'etf', name: 'T', qty: 100, cost: 2.0, cash: 50000 })

    const res = (await strategySet.execute(
      {
        symbol: '588000',
        text: strategyText('thresholds:\n  dir_hit_min: 0.65'),
        rationale: 'r',
      },
      makeExec(),
    )) as { ok: boolean; version: string }
    expect(res.ok).toBe(true)
    expect(res.version).toBe('v001')

    const legacyPath = join(dir, 'ledger', '588000', 'thresholds.json')
    const strategyPath = join(dir, 'strategy', '588000.md')
    ev('thresholds.json 是否存在', existsSync(legacyPath))
    ev('strategy 当前版文件是否存在', existsSync(strategyPath))
    expect(existsSync(legacyPath)).toBe(false)
    expect(existsSync(strategyPath)).toBe(true)
  })
})

describe('契约未变：cordis.patch.yml inject 三项', () => {
  it('cordis.patch.yml inject 与 plugin.inject 一致（三项）', () => {
    const patch = readFileSync(join(process.cwd(), 'cordis.patch.yml'), 'utf8')
    const m = /inject:\s*\[([^\]]*)\]/.exec(patch)
    expect(m).toBeTruthy()
    const items = m![1]
      .split(',')
      .map((s) => s.trim().replace(/['"]/g, ''))
      .filter(Boolean)
    ev('cordis.patch.yml inject', items)
    expect(items).toEqual(['tools', 'skills', 'fs'])
  })
})

describe('miss_streak_max 校验（R2 缺陷闭环）', () => {
  function missOnly(miss: string): void {
    ctx.strategy.set('588000', {
      text: strategyText(`thresholds:\n  miss_streak_max: ${miss}`),
      rationale: 'r',
    })
  }

  it.each([
    ['-1', '负整数'],
    ['-0.5', '负小数'],
    ['NaN', '非数 NaN'],
    ['.nan', '非数 .nan'],
    ['Infinity', '无穷 Infinity'],
    ['.inf', '无穷 .inf'],
    ['2.5', '非整数'],
  ])('miss_streak_max: %s（%s）→ 回落默认且不抛', (miss) => {
    missOnly(miss)
    expect(() => ctx.getThresholds('588000')).not.toThrow()
    const got = ctx.getThresholds('588000')
    ev(`miss_streak_max ${miss}`, got)
    expect(got.missStreakMax).toBe(DEFAULT_THRESHOLDS.missStreakMax)
  })

  it('miss_streak_max: 0（非负整数下界）→ 采用', () => {
    missOnly('0')
    const got = ctx.getThresholds('588000')
    ev('miss_streak_max 0', got)
    expect(got.missStreakMax).toBe(0)
  })

  it('miss_streak_max: 5（正整数）→ 采用', () => {
    missOnly('5')
    const got = ctx.getThresholds('588000')
    ev('miss_streak_max 5', got)
    expect(got.missStreakMax).toBe(5)
  })

  it('cum_return_min: -0.05（负数，合法）→ 采用', () => {
    ctx.strategy.set('588000', {
      text: strategyText('thresholds:\n  cum_return_min: -0.05'),
      rationale: 'r',
    })
    const got = ctx.getThresholds('588000')
    ev('cum_return_min -0.05', got)
    expect(got.cumReturnMin).toBe(-0.05)
  })

  it('cum_return_min: Infinity → 回落默认且不抛', () => {
    ctx.strategy.set('588000', {
      text: strategyText('thresholds:\n  cum_return_min: Infinity'),
      rationale: 'r',
    })
    expect(() => ctx.getThresholds('588000')).not.toThrow()
    const got = ctx.getThresholds('588000')
    ev('cum_return_min Infinity', got)
    expect(got.cumReturnMin).toBe(DEFAULT_THRESHOLDS.cumReturnMin)
  })
})
