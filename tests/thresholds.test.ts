/**
 * 反向检讨阈值来源迁移单元测试（Task-19）。
 *
 * 覆盖验收标准 AC1：
 *   1. 策略文档带合法 thresholds → 取其间值（部分键缺失 → 该键回落默认）；
 *   2. 无 front-matter → 回落 thresholds.json（旧表兼容）；
 *   3. 非法 YAML（如 thresholds: [1,2）→ parseError 且不抛、回落默认；
 *   4. 数值非法（负数 / 非数 / dir_hit_min > 1）→ 该键回落默认。
 *
 * 也覆盖 parseStrategyDoc 的纯函数语义（无 front-matter / 嵌套 / 未闭合 / 流式集合）。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseStrategyDoc } from '../src/domain/strategy.js'
import { JsonStore } from '../src/domain/store.js'
import { createToolContext, DEFAULT_THRESHOLDS, type ToolContext } from '../src/tools/context.js'

let dir: string
let ctx: ToolContext

let prevHome: string | undefined

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dsh-ia-thresholds-'))
  // 策略是资产：ToolContext 的策略注册表使用 resolveAssetsDir()（跟随 DSH_IA_HOME）。
  prevHome = process.env.DSH_IA_HOME
  process.env.DSH_IA_HOME = dir
  ctx = createToolContext({ dataRoot: dir })
})

afterEach(() => {
  if (prevHome === undefined) delete process.env.DSH_IA_HOME
  else process.env.DSH_IA_HOME = prevHome
  rmSync(dir, { recursive: true, force: true })
})

/** 生成带 front-matter 的策略文档正文。 */
function strategyText(frontmatter: string, body = '自然语言策略正文'): string {
  return `---\n${frontmatter}\n---\n${body}`
}

describe('parseStrategyDoc', () => {
  it('无 front-matter → structured={}、body=原文', () => {
    const text = '只是普通正文，没有 front-matter'
    const r = parseStrategyDoc(text)
    expect(r.structured).toEqual({})
    expect(r.body).toBe(text)
    expect(r.parseError).toBeUndefined()
  })

  it('解析嵌套 thresholds → structured.thresholds 为对象', () => {
    const r = parseStrategyDoc(
      strategyText('thresholds:\n  dir_hit_min: 0.7\n  cum_return_min: 0.02\n  miss_streak_max: 3'),
    )
    expect(r.parseError).toBeUndefined()
    expect(r.structured.thresholds).toEqual({
      dir_hit_min: 0.7,
      cum_return_min: 0.02,
      miss_streak_max: 3,
    })
    expect(r.body).toBe('自然语言策略正文')
  })

  it('front-matter 未闭合 → parseError 且 structured={}', () => {
    const r = parseStrategyDoc('---\nthresholds:\n  dir_hit_min: 0.6\n')
    expect(r.structured).toEqual({})
    expect(r.parseError).toMatch(/未闭合/)
  })

  it('流式集合（thresholds: [1,2）→ parseError 且不抛', () => {
    const r = parseStrategyDoc(strategyText('thresholds: [1,2'))
    expect(r.structured).toEqual({})
    expect(r.parseError).toMatch(/流式集合/)
  })
})

describe('getThresholds 优先级', () => {
  it('① 策略文档合法 thresholds → 取其值', () => {
    ctx.strategy.set('588000', {
      text: strategyText(
        'thresholds:\n  dir_hit_min: 0.7\n  cum_return_min: 0.05\n  miss_streak_max: 5',
      ),
      rationale: 'r',
    })
    expect(ctx.getThresholds('588000')).toEqual({
      dirHitMin: 0.7,
      cumReturnMin: 0.05,
      missStreakMax: 5,
    })
  })

  it('① 部分键缺失 → 该键回落默认', () => {
    ctx.strategy.set('588000', {
      text: strategyText('thresholds:\n  dir_hit_min: 0.7'),
      rationale: 'r',
    })
    expect(ctx.getThresholds('588000')).toEqual({
      dirHitMin: 0.7,
      cumReturnMin: DEFAULT_THRESHOLDS.cumReturnMin,
      missStreakMax: DEFAULT_THRESHOLDS.missStreakMax,
    })
  })

  it('① dir_hit_min > 1 → 该键回落默认', () => {
    ctx.strategy.set('588000', {
      text: strategyText('thresholds:\n  dir_hit_min: 1.5'),
      rationale: 'r',
    })
    expect(ctx.getThresholds('588000').dirHitMin).toBe(DEFAULT_THRESHOLDS.dirHitMin)
  })

  it('① dir_hit_min 为负 → 该键回落默认', () => {
    ctx.strategy.set('588000', {
      text: strategyText('thresholds:\n  dir_hit_min: -0.2'),
      rationale: 'r',
    })
    expect(ctx.getThresholds('588000').dirHitMin).toBe(DEFAULT_THRESHOLDS.dirHitMin)
  })

  it('① 数值非数（字符串）→ 该键回落默认', () => {
    ctx.strategy.set('588000', {
      text: strategyText('thresholds:\n  cum_return_min: "oops"'),
      rationale: 'r',
    })
    expect(ctx.getThresholds('588000').cumReturnMin).toBe(DEFAULT_THRESHOLDS.cumReturnMin)
  })

  it('② 无 front-matter → 回落旧 thresholds.json', () => {
    ctx.strategy.set('588000', { text: '无 front-matter 的策略正文', rationale: 'r' })
    new JsonStore(dir).writeTable('588000', 'thresholds', {
      dirHitMin: 0.55,
      cumReturnMin: 0.01,
      missStreakMax: 4,
    })
    expect(ctx.getThresholds('588000')).toEqual({
      dirHitMin: 0.55,
      cumReturnMin: 0.01,
      missStreakMax: 4,
    })
  })

  it('③ 无策略无旧表 → 回落默认', () => {
    expect(ctx.getThresholds('588000')).toEqual(DEFAULT_THRESHOLDS)
  })

  it('非法 YAML → 回落默认且不抛', () => {
    ctx.strategy.set('588000', {
      text: strategyText('thresholds: [1,2'),
      rationale: 'r',
    })
    expect(() => ctx.getThresholds('588000')).not.toThrow()
    expect(ctx.getThresholds('588000')).toEqual(DEFAULT_THRESHOLDS)
  })

  it('front-matter 解析失败 → 输出 warn 告警日志', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    ctx.strategy.set('588000', {
      text: strategyText('thresholds: [1,2'),
      rationale: 'r',
    })
    ctx.getThresholds('588000')
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('588000 策略文档 front-matter 解析失败'),
    )
    warn.mockRestore()
  })

  it('thresholds 字段形态非法（写成标量）→ 输出 warn 告警日志', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    ctx.strategy.set('588000', {
      // 合法 YAML，但 thresholds 的值是标量（数字）而非对象。
      text: strategyText('thresholds: 3'),
      rationale: 'r',
    })
    ctx.getThresholds('588000')
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('thresholds 字段形态非法'),
    )
    warn.mockRestore()
  })
})

describe('miss_streak_max 校验（非负整数）', () => {
  function missOnly(miss: string): void {
    ctx.strategy.set('588000', {
      text: strategyText(`thresholds:\n  miss_streak_max: ${miss}`),
      rationale: 'r',
    })
  }

  it.each([
    ['-1', '负整数'],
    ['-0.5', '负小数'],
    ['NaN', '非数'],
    ['Infinity', '无穷大'],
    ['2.5', '非整数'],
  ])('miss_streak_max: %s（%s）→ 回落默认', (miss) => {
    missOnly(miss)
    expect(ctx.getThresholds('588000').missStreakMax).toBe(DEFAULT_THRESHOLDS.missStreakMax)
  })

  it('miss_streak_max: 0（合法非负整数）→ 采用', () => {
    missOnly('0')
    expect(ctx.getThresholds('588000').missStreakMax).toBe(0)
  })

  it('miss_streak_max: 5（正整数）→ 采用', () => {
    missOnly('5')
    expect(ctx.getThresholds('588000').missStreakMax).toBe(5)
  })
})
