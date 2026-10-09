/**
 * 回归测试（t100363）：插件 `apply` 装配阶段必须注册 21 个模型工具。
 *
 * 背景：此前 `src/plugin.ts` 的 `apply` 只注册 skills + advisor + runner，
 * 漏接 `registerAllTools`，导致工具对模型不可用。本测试锁定该修复：
 *
 *   1. 真实装载：`new Context()` → 提供 `systemPrompt`（ToolRuntime 依赖）与
 *      `skills` / `fs` 桩 → `plugin(ToolRuntime)` 提供真实
 *      `ctx.tools` → 以**真实插件**（`src/plugin.ts` 的 name/inject/apply）
 *      驱动装载 → 断言 `ctx.tools` 恰好暴露 21 个工具（名称/分组逐一相符）。
 *   2. 注销绑定：dispose 插件 fiber 后 21 个工具全部消失（经 `ctx.effect` 注销）。
 *   3. 安全降级：`ctx.tools` 不可用的最小上下文下 `apply` 不抛错、不注册。
 *   4. 顶层 `inject` 契约保持 `['tools','skills','fs']` 不变。
 *
 * 采用真实 ToolRuntime registry 管线（与 tester-tools-runtime.spec.ts 一致），
 * 走 defineTool 完整校验链路，而非 mock。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { apply, inject as topLevelInject, name as pluginName } from '../src/plugin.js'

/** `ctx.tools` 最小结构（真实 ToolRuntime 暴露面）。 */
interface ToolBox {
  schemas: () => Array<{ name: string; description: string }>
  get: (name: string) => unknown
}

/** 21 个工具的期望名称集合（按 §4 契约表 + §10.8 策略域分组 + §7 定时任务层 7 工具）。 */
const EXPECTED_TOOLS = {
  ledgers: ['ledger_init', 'ledger_list', 'ledger_query', 'ledger_trade'],
  strategy: ['strategy_get', 'strategy_set'],
  predicts: ['predict_make', 'predict_verify', 'predict_get'],
  reviews: [
    'review_check',
    'review_report',
    'review_get',
    'review_metrics',
    'review_retrospect',
  ],
  scheduler: [
    'task_create',
    'task_list',
    'task_get',
    'task_update',
    'task_delete',
    'task_enable',
    'task_disable',
  ],
} as const

const ALL_EXPECTED = Object.values(EXPECTED_TOOLS).flat()

/** systemPrompt 最小桩（ToolRuntime.inject = ['systemPrompt']）。 */
function systemPromptStub() {
  return {
    name: 'systemPrompt',
    tools() {},
    section() {
      return () => {}
    },
    getSectionOrder() {
      return 0
    },
  } as unknown as never
}

const tmpDirs: string[] = []

function makeTmpDataRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-finance-plugin-tools-'))
  tmpDirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  }
})

/**
 * 装载真实插件：真实 ToolRuntime 提供 `ctx.tools`，其余注入服务以桩满足
 * 插件顶层 `inject`。返回可 dispose 的 fiber 与 registry 视图。
 */
async function bootPlugin(dataRoot: string) {
  process.env.DSH_FINANCE_DATA_DIR = dataRoot

  const app = new Context()
  app.provide('systemPrompt', systemPromptStub())
  // 插件顶层 inject 的其余服务：以最小桩满足依赖。
  app.provide('skills', { name: 'skills', register: () => () => {} } as never)
  app.provide('fs', { name: 'fs' } as never)

  const toolsFiber = (await app.plugin(ToolRuntime as never)) as unknown as {
    dispose: () => Promise<void>
  }
  const pluginFiber = app.plugin({
    name: pluginName,
    inject: [...topLevelInject],
    apply,
  } as never) as unknown as { dispose: () => Promise<void>; await: () => Promise<unknown> }

  const tools = (app as unknown as { tools: ToolBox }).tools
  return {
    app,
    tools,
    toolsFiber,
    pluginFiber,
    async dispose() {
      await pluginFiber.dispose()
      await toolsFiber.dispose()
    },
  }
}

describe('t100363 插件装配：21 个工具经 apply 注册', () => {
  it('顶层 inject 契约保持 [tools, skills, fs]', () => {
    expect(topLevelInject).toEqual(['tools', 'skills', 'fs'])
  })

  it('真实装载后 ctx.tools 恰好暴露 21 个工具，名称/分组逐一相符', async () => {
    const booted = await bootPlugin(makeTmpDataRoot())
    try {
      await vi.waitFor(
        () => {
          expect(booted.tools.schemas()).toHaveLength(21)
        },
        { timeout: 8000, interval: 10 },
      )

      const names = booted.tools.schemas().map((s) => s.name)
      expect(names).toHaveLength(21)
      expect(new Set(names).size).toBe(21)
      expect([...names].sort()).toEqual([...ALL_EXPECTED].sort())
      for (const group of Object.values(EXPECTED_TOOLS)) {
        for (const name of group) expect(booted.tools.get(name)).toBeDefined()
      }
    } finally {
      await booted.dispose()
    }
  })

  it('dispose 插件 fiber 后 21 个工具全部注销（ctx.effect 绑定生效）', async () => {
    const booted = await bootPlugin(makeTmpDataRoot())
    await vi.waitFor(
      () => {
        expect(booted.tools.schemas()).toHaveLength(21)
      },
      { timeout: 8000, interval: 10 },
    )

    await booted.pluginFiber.dispose()
    expect(booted.tools.schemas()).toHaveLength(0)
    for (const name of ALL_EXPECTED) expect(booted.tools.get(name)).toBeUndefined()

    await booted.toolsFiber.dispose()
  })

  it('ctx.tools 不可用的最小上下文下 apply 不抛错、不注册（安全降级）', () => {
    const ctx = {
      effect(body: () => unknown) {
        const d = body()
        return typeof d === 'function' ? (d as () => void) : () => {}
      },
      get: () => undefined,
      inject: () => ({}),
    } as unknown as Context

    expect(() => apply(ctx)).not.toThrow()
  })

  it('tools 服务缺省但 skills 可用时，skill 注册不受影响（互不干扰）', () => {
    const registered: Array<{ name: string }> = []
    // 真实 cordis 语义下，注入的就绪服务会同时暴露为 `ctx.<name>` 属性；
    // `registerAllSkills` 走 `ctx.skills.register`（标准访问）。故 mock 需同时
    // 提供 `ctx.skills` 属性与 `get('skills')`，才能真实还原装载环境。
    const skillsService = {
      name: 'skills',
      register(s: { name: string }) {
        registered.push(s)
        return () => {}
      },
    }
    const ctx = {
      effect(body: () => unknown) {
        const d = body()
        return typeof d === 'function' ? (d as () => void) : () => {}
      },
      get(name: string) {
        return name === 'skills' ? skillsService : undefined
      },
      // 还原 cordis：`ctx.tools` 缺省（未提供 tools 服务），但 `ctx.skills` 可用。
      skills: skillsService,
      inject: () => ({}),
    } as unknown as Context

    expect(() => apply(ctx)).not.toThrow()
    // 技术面 SKILL 共 5 个（trend-analysis / grid-strategy / stop-rule /
    // strategy-authorship / task-authorship）。
    expect(registered).toHaveLength(5)
  })
})
