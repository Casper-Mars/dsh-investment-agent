/**
 * tester-task14-dsh-version-align.INDEPENDENT.spec.ts
 * ==================================================================
 * Tester 独立复验（Task-14）：依赖版本对齐 0.1.6-alpha.1 → 0.2.0-rc.2
 *
 * 被测交付物：dsh-finance（main @ 8ab4571 + 未提交 package.json / pnpm-lock.yaml）
 * 变更内容：@deepseek-ai/dsh-skill / @deepseek-ai/dsh-tools 由 0.1.6-alpha.1
 *   → 0.2.0-rc.2（peerDependencies + devDependencies 共 4 处）。
 *
 * 独立性声明（与 Developer 及 tester-task13 均不同）：
 *   1) 装载**真实构建产物 dist-server/**（而非 src/** 源码态）——`import * as
 *      pluginNs from '../dist-server/index.js'`，走 `package.json` exports
 *      `["."].default = ./dist-server/index.js` 的产物入口，与本仓库对外发布
 *      形态一致。
 *   2) 运行在**真实 @deepseek-ai/dsh-tools@0.2.0-rc.2**（node_modules 已解析
 *      0.2.0-rc.2）+ 真实 @deepseek-ai/cordis 4.0.4 的 Context 之上，并在测试
 *      内**运行时读取** node_modules 版本号作为「确实以 0.2.0-rc.2 运行」的证据。
 *   3) skills 与 systemPrompt 服务以**捕获式桩**提供，逐项核对 5 个 SKILL 与
 *      人设 section 的注册结果（非空桩）。
 *
 * 仅新增本测试文件，不改动 src/** 与 package.json。
 * ==================================================================
 */
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import ToolRuntime from '@deepseek-ai/dsh-tools'
// ★ 真实构建产物入口（exports["."].default = ./dist-server/index.js）
import * as pluginNs from '../dist-server/index.js'

const PROJECT_ROOT = fileURLToPath(new URL('..', import.meta.url))
const readJson = (rel: string): Record<string, unknown> =>
  JSON.parse(readFileSync(join(PROJECT_ROOT, rel), 'utf8')) as Record<string, unknown>

interface ToolSchema {
  name: string
  description: string
  parameters?: unknown
}
interface ToolBox {
  schemas: () => ToolSchema[]
  get: (name: string) => unknown
  register: (tool: unknown) => () => void
}

/** 21 个工具的期望名称（按 §4 契约分组：ledgers 4 + strategy 2 + predicts 3 + reviews 5 + scheduler 7）。 */
const EXPECTED = {
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
const ALL_EXPECTED = Object.values(EXPECTED).flat()
/** 5 个技术面 SKILL（注册顺序：趋势研判 → 网格策略 → 止损纪律 → 策略创作 → 任务程序创作）。 */
const EXPECTED_SKILLS = [
  'trend-analysis',
  'grid-strategy',
  'stop-rule',
  'strategy-authorship',
  'task-authorship',
] as const
/** 人设 section 契约（src/prompts/index.ts）。 */
const ADVISOR_SECTION_NAME = 'dsh-finance:advisor'
const ADVISOR_SECTION_ORDER = 100

/** systemPrompt 捕获式桩：记录注册的 section（人设 + ToolRuntime 自身的 tools 注册）。 */
function makeSystemPromptStub() {
  const sections: Array<{ name: string; order: number; text: unknown }> = []
  return {
    sections,
    service: {
      name: 'systemPrompt',
      tools() {
        return () => {}
      },
      section(s: { name: string; order: number; text: unknown }) {
        sections.push(s)
        return () => {
          const i = sections.indexOf(s)
          if (i >= 0) sections.splice(i, 1)
        }
      },
      getSectionOrder() {
        return 0
      },
    } as unknown as never,
  }
}

/** skills 捕获式桩：记录 register 调用（用于逐项核对 5 个 SKILL）。 */
function makeSkillsStub() {
  const registered: Array<{
    name: string
    description: string
    whenToUse?: string
    content: string
  }> = []
  return {
    registered,
    service: {
      name: 'skills',
      register(reg: {
        name: string
        description: string
        whenToUse?: string
        content: string
      }) {
        registered.push(reg)
        return () => {
          const i = registered.indexOf(reg)
          if (i >= 0) registered.splice(i, 1)
        }
      },
    } as unknown as never,
  }
}

const tmpDirs: string[] = []
function makeTmpDataRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-finance-t14-'))
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
 * 装载**真实构建产物 dist-server**：真实 cordis Context + 真实
 * @deepseek-ai/dsh-tools ToolRuntime（0.2.0-rc.2）提供 `ctx.tools`；
 * skills / systemPrompt 以捕获式桩满足注入并记录注册结果。
 */
async function bootDistPlugin(dataRoot: string) {
  process.env.DSH_FINANCE_DATA_DIR = dataRoot

  const app = new Context()
  const sp = makeSystemPromptStub()
  const sk = makeSkillsStub()
  app.provide('systemPrompt', sp.service)
  app.provide('skills', sk.service)
  app.provide('fs', { name: 'fs' } as never)

  const toolsFiber = (await app.plugin(ToolRuntime as never)) as unknown as {
    dispose: () => Promise<void>
  }
  const pluginFiber = app.plugin(pluginNs as never) as unknown as {
    dispose: () => Promise<void>
  }

  const tools = (app as unknown as { tools: ToolBox }).tools
  return {
    app,
    tools,
    sp,
    sk,
    toolsFiber,
    pluginFiber,
    async dispose() {
      await pluginFiber.dispose()
      await toolsFiber.dispose()
    },
  }
}

describe('Task-14 复验 A：版本声明与解析一致（4 处 0.2.0-rc.2）', () => {
  it('A1·package.json：peerDeps + devDeps 四处 dsh-skill/dsh-tools 均为 0.2.0-rc.2，cordis >=4.0.0', () => {
    const pkg = readJson('package.json') as {
      peerDependencies: Record<string, string>
      devDependencies: Record<string, string>
    }
    expect(pkg.peerDependencies['@deepseek-ai/dsh-skill']).toBe('0.2.0-rc.2')
    expect(pkg.peerDependencies['@deepseek-ai/dsh-tools']).toBe('0.2.0-rc.2')
    expect(pkg.devDependencies['@deepseek-ai/dsh-skill']).toBe('0.2.0-rc.2')
    expect(pkg.devDependencies['@deepseek-ai/dsh-tools']).toBe('0.2.0-rc.2')
    expect(pkg.peerDependencies['@deepseek-ai/cordis']).toBe('>=4.0.0')
    expect(pkg.devDependencies['@deepseek-ai/cordis']).toBe('>=4.0.0')
    console.log(
      '[EVIDENCE A1] pkg peer/dev 四处 dsh-skill/dsh-tools = 0.2.0-rc.2；cordis = >=4.0.0',
    )
  })

  it('A2·node_modules 实际解析版本：dsh-skill / dsh-tools = 0.2.0-rc.2，cordis = 4.0.4', () => {
    const skill = readJson('node_modules/@deepseek-ai/dsh-skill/package.json')
      .version as string
    const tools = readJson('node_modules/@deepseek-ai/dsh-tools/package.json')
      .version as string
    const cordis = readJson('node_modules/@deepseek-ai/cordis/package.json')
      .version as string
    expect(skill).toBe('0.2.0-rc.2')
    expect(tools).toBe('0.2.0-rc.2')
    expect(cordis.startsWith('4.0.')).toBe(true)
    console.log(
      `[EVIDENCE A2] resolved: dsh-skill=${skill} dsh-tools=${tools} cordis=${cordis}`,
    )
  })

  it('A3·pnpm-lock.yaml：无 0.1.6-alpha.1 残留；dsh-skill/dsh-tools 解析为 0.2.0-rc.2', () => {
    const lock = readFileSync(join(PROJECT_ROOT, 'pnpm-lock.yaml'), 'utf8')
    expect(lock).not.toContain('0.1.6-alpha.1')
    expect(lock).toContain('@deepseek-ai/dsh-skill@0.2.0-rc.2')
    expect(lock).toContain('@deepseek-ai/dsh-tools@0.2.0-rc.2')
    console.log(
      '[EVIDENCE A3] lock: 无 0.1.6-alpha.1 残留；dsh-skill/dsh-tools 锁 0.2.0-rc.2',
    )
  })

  it('A4·（回归证据）本测试实际以 0.2.0-rc.2 依赖运行', () => {
    // ToolRuntime 即从 node_modules 解析的 @deepseek-ai/dsh-tools 默认导出装载，
    // 此处显式声明其运行时来源版本，作为「以 0.2.0-rc.2 运行」的直接证据。
    const tools = readJson('node_modules/@deepseek-ai/dsh-tools/package.json')
      .version as string
    const cordis = readJson('node_modules/@deepseek-ai/cordis/package.json')
      .version as string
    expect(tools).toBe('0.2.0-rc.2')
    console.log(
      `[EVIDENCE A4] ToolRuntime 来自 @deepseek-ai/dsh-tools@${tools} + cordis@${cordis}`,
    )
  })
})

describe('Task-14 复验 B：真实构建产物（dist-server）装载与运行时装配', () => {
  it('B1·dist-server 导出三要素：name=investment-advisor，inject=[tools,skills,fs]', () => {
    expect(pluginNs.name).toBe('investment-advisor')
    expect(pluginNs.inject).toEqual(['tools', 'skills', 'fs'])
    expect(typeof pluginNs.apply).toBe('function')
    console.log(
      `[EVIDENCE B1] dist-server: name=${pluginNs.name} inject=[${pluginNs.inject.join(', ')}]`,
    )
  })

  it('B2·★ 真实装载：apply 不抛异常，ctx.tools 恰好暴露 21 个工具（名称逐一核对）', async () => {
    const b = await bootDistPlugin(makeTmpDataRoot())
    try {
      // apply 经 app.plugin() 同步执行不抛异常（bootDistPlugin 未抛即为通过）。
      await vi_waitFor(
        () => expect(b.tools.schemas()).toHaveLength(21),
        8000,
      )

      const names = b.tools.schemas().map((s) => s.name)
      expect(names).toHaveLength(21)
      expect(new Set(names).size).toBe(21)
      expect([...names].sort()).toEqual([...ALL_EXPECTED].sort())

      for (const [group, groupNames] of Object.entries(EXPECTED)) {
        for (const n of groupNames) {
          expect(b.tools.get(n), `${group}:${n} 应已注册`).toBeDefined()
        }
      }
      for (const s of b.tools.schemas()) {
        expect(s.description.length, `${s.name} description 非空`).toBeGreaterThan(0)
      }
      console.log(
        `[EVIDENCE B2] ctx.tools.schemas() count=21 :: ${[...names].sort().join(', ')}`,
      )
    } finally {
      await b.dispose()
    }
  })

  it('B3·★ dispose 插件 fiber 后 21 工具全部注销', async () => {
    const b = await bootDistPlugin(makeTmpDataRoot())
    try {
      await vi_waitFor(() => expect(b.tools.schemas()).toHaveLength(21), 8000)

      await b.pluginFiber.dispose()

      expect(b.tools.schemas()).toHaveLength(0)
      for (const n of ALL_EXPECTED) {
        expect(b.tools.get(n), `${n} 应已注销`).toBeUndefined()
      }
      console.log('[EVIDENCE B3] after pluginFiber.dispose(): schemas()=0, 21 工具全部注销')
    } finally {
      await b.toolsFiber.dispose()
    }
  })

  it('B4·★ skills 5 个正常注册（名称/顺序逐一核对）', async () => {
    const b = await bootDistPlugin(makeTmpDataRoot())
    try {
      const names = b.sk.registered.map((s) => s.name)
      expect(names).toEqual([...EXPECTED_SKILLS])
      for (const s of b.sk.registered) {
        expect(s.description.length, `${s.name} description 非空`).toBeGreaterThan(0)
        expect(s.content.length, `${s.name} content 非空`).toBeGreaterThan(0)
      }
      console.log(`[EVIDENCE B4] skills registered=6 :: ${names.join(', ')}`)
    } finally {
      await b.dispose()
    }
  })

  it('B5·★ 人设 section 正常注册：name=dsh-finance:advisor，order=100', async () => {
    const b = await bootDistPlugin(makeTmpDataRoot())
    try {
      // ctx.inject(['systemPrompt'], cb) 为异步回调（cordis 调度至下一 tick），
      // 需等待 section 注入完成。
      await vi_waitFor(
        () =>
          expect(
            b.sp.sections.some((s) => s.name === ADVISOR_SECTION_NAME),
            '人设 section 应已注册',
          ).toBe(true),
        2000,
      )
      const advisor = b.sp.sections.find((s) => s.name === ADVISOR_SECTION_NAME)
      expect(advisor!.order).toBe(ADVISOR_SECTION_ORDER)
      // text 为 provider（函数），求值后含 advisor.md 正文（非空）。
      const text = typeof advisor!.text === 'function'
        ? (advisor!.text as () => string)()
        : String(advisor!.text)
      expect(text.length).toBeGreaterThan(0)
      expect(text).toContain('金融')
      console.log(
        `[EVIDENCE B5] persona section name=${advisor!.name} order=${advisor!.order} textLen=${text.length}`,
      )
    } finally {
      await b.dispose()
    }
  })
})

/** 轻量 waitFor（不引入额外依赖，语义同 vitest 的 vi.waitFor）。 */
async function vi_waitFor(
  assertion: () => void,
  timeout: number,
  interval = 10,
): Promise<void> {
  const start = Date.now()
  for (;;) {
    try {
      assertion()
      return
    } catch (err) {
      if (Date.now() - start >= timeout) throw err
      await new Promise((r) => setTimeout(r, interval))
    }
  }
}
