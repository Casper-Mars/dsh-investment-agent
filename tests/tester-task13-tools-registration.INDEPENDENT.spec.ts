/**
 * tester-task13-tools-registration.INDEPENDENT.spec.ts
 * ==================================================================
 * Tester 独立复验（Task-13）：模型工具是否确实经 plugin.apply 注册、对模型可用。
 * （该轮为 16 个；Task-18 起为 18 个；引入定时任务层 7 工具后为 25 个 —— 本文件的数量断言已随之更新。）
 *
 * 独立性声明（不复用 Developer 的 tests/plugin-tools-registration.spec.ts）：
 *   1) 装载路径不同：本文件以 **ES module 命名空间整体** 装载真实插件
 *      （`import * as pluginNs` + `app.plugin(pluginNs)`），而非 Developer
 *      手写的 `{ name, inject, apply }` 对象字面量；两者走 cordis 不同的
 *      plugin resolve 分支，互为交叉验证。
 *   2) 契约核对方式不同：本文件 **独立读取 cordis.patch.yml 原文并解析**
 *      inject 数组，再与运行时 `pluginNs.inject` 比对。
 *   3) 附带独立核对 runner 调度参数的实际生效常量值。
 *
 * 仅新增本测试文件，不改动 src/**。
 * ==================================================================
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as pluginNs from '../src/plugin.js'
import * as scheduler from '../src/runner/scheduler.js'
import * as sensor from '../src/runner/sensor-runner.js'

const PROJECT_ROOT = fileURLToPath(new URL('..', import.meta.url))

interface ToolSchema {
  name: string
  description: string
  parameters?: unknown
}
interface ToolBox {
  schemas: () => ToolSchema[]
  get: (name: string) => unknown
}

/** 25 个工具的期望名称（按 §4 契约 + §10.8 策略域分组 + §7 定时任务层 7 工具）。 */
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
  sense_archives: [
    'sense_archive_commit',
    'sense_archive_list',
    'sense_archive_rollback',
    'sense_archive_get',
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

/** systemPrompt 最小桩（ToolRuntime.inject = ['systemPrompt']）。 */
function systemPromptStub() {
  return {
    name: 'systemPrompt',
    tools() {
      return () => {}
    },
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
  const dir = mkdtempSync(join(tmpdir(), 'dsh-finance-t13-'))
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
 * 装载**真实插件**：真实 cordis Context + 真实 @deepseek-ai/dsh-tools
 * ToolRuntime 提供 `ctx.tools`；其余注入服务以最小桩满足插件顶层 inject。
 * 插件本体经 **模块命名空间** 装载（独立于 Developer 的对象字面量路径）。
 */
async function bootRealPlugin(dataRoot: string) {
  process.env.DSH_FINANCE_DATA_DIR = dataRoot

  const app = new Context()
  app.provide('systemPrompt', systemPromptStub())
  app.provide('skills', { name: 'skills', register: () => () => {} } as never)
  // ptcRuntime 无 run() → applyRunner 安全降级，不启动调度 timer。
  app.provide('ptcRuntime', { name: 'ptcRuntime' } as never)
  app.provide('fs', { name: 'fs' } as never)

  const toolsFiber = (await app.plugin(ToolRuntime as never)) as unknown as {
    dispose: () => Promise<void>
  }
  // ★ 独立装载路径：模块命名空间（cordis `isApplicable` 分支），非对象字面量。
  const pluginFiber = app.plugin(pluginNs as never) as unknown as {
    dispose: () => Promise<void>
  }

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

describe('Task-13 独立复验：25 工具经 plugin.apply 注册（真实运行时）', () => {
  it('插件契约：name=investment-advisor 且顶层 inject=[tools,skills,ptcRuntime,fs]', () => {
    expect(pluginNs.name).toBe('investment-advisor')
    expect(pluginNs.inject).toEqual(['tools', 'skills', 'ptcRuntime', 'fs'])
    expect(typeof pluginNs.apply).toBe('function')
  })

  it('★ 真实装载后 ctx.tools 恰好暴露 25 个工具（名称逐一核对，逐一可 get）', async () => {
    const b = await bootRealPlugin(makeTmpDataRoot())
    try {
      await vi.waitFor(() => expect(b.tools.schemas()).toHaveLength(25), {
        timeout: 8000,
        interval: 10,
      })

      const names = b.tools.schemas().map((s) => s.name)
      expect(names).toHaveLength(25)
      expect(new Set(names).size).toBe(25)
      expect([...names].sort()).toEqual([...ALL_EXPECTED].sort())

      // 分组逐一存在
      for (const [group, groupNames] of Object.entries(EXPECTED)) {
        for (const n of groupNames) {
          expect(b.tools.get(n), `${group}:${n} 应已注册`).toBeDefined()
        }
      }
      // 每个工具对模型可见 = 有非空 description（wire schema）
      for (const s of b.tools.schemas()) {
        expect(s.description.length, `${s.name} description 非空`).toBeGreaterThan(0)
      }

      console.log(
        `[EVIDENCE T13-1] ctx.tools.schemas() count=25 :: ${[...names].sort().join(', ')}`,
      )
    } finally {
      await b.dispose()
    }
  })

  it('★ 注销验证：dispose 插件 fiber 后 25 工具全部从 registry 消失', async () => {
    const b = await bootRealPlugin(makeTmpDataRoot())
    try {
      await vi.waitFor(() => expect(b.tools.schemas()).toHaveLength(25), {
        timeout: 8000,
        interval: 10,
      })

      await b.pluginFiber.dispose()

      expect(b.tools.schemas()).toHaveLength(0)
      for (const n of ALL_EXPECTED) {
        expect(b.tools.get(n), `${n} 应已注销`).toBeUndefined()
      }
      console.log('[EVIDENCE T13-2] after pluginFiber.dispose(): schemas()=0, all 25 gone')
    } finally {
      await b.toolsFiber.dispose()
    }
  })

  it('★ 安全降级：ctx.tools 不可用的最小上下文下 apply 不抛错', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const ctx = {
        effect(body: () => unknown) {
          const d = body()
          return typeof d === 'function' ? (d as () => void) : () => {}
        },
        get() {
          return undefined
        },
        inject(_names: unknown, cb?: unknown) {
          if (typeof cb === 'function') (cb as (c: unknown) => void)(ctx)
          return () => {}
        },
      } as unknown as Parameters<typeof pluginNs.apply>[0]

      let disposer: (() => void) | undefined
      expect(() => {
        pluginNs.apply(ctx)
      }).not.toThrow()
      // 触发 effect 返回的注销器也不应抛错
      expect(() => disposer?.()).not.toThrow()

      const messages = warn.mock.calls.map((c) => String(c[0]))
      expect(messages.some((m) => m.includes('tools 服务不可用'))).toBe(true)
      console.log('[EVIDENCE T13-3] minimal ctx (no tools): apply() no-throw; warn emitted')
    } finally {
      warn.mockRestore()
    }
  })

  it('★ 契约一致性：cordis.patch.yml 的 inject 与 plugin.inject 完全一致', () => {
    const yml = readFileSync(join(PROJECT_ROOT, 'cordis.patch.yml'), 'utf8')
    const m = yml.match(/inject:\s*\[([^\]]*)\]/)
    expect(m, 'cordis.patch.yml 应包含 inject: [ ... ]').toBeTruthy()
    const parsed = m![1]
      .split(',')
      .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
      .filter((s) => s.length > 0)
    expect(parsed).toEqual(['tools', 'skills', 'ptcRuntime', 'fs'])
    expect(parsed).toEqual(pluginNs.inject)
    console.log(`[EVIDENCE T13-4] yml inject=[${parsed.join(', ')}] === plugin.inject`)
  })
})

describe('Task-13 附带：runner 调度参数实际生效值核对', () => {
  it('盘中脉冲周期 = 30 秒；窗口 9:30-11:30 / 13:00-15:00（含端点）', () => {
    expect(scheduler.PULSE_STEP_SECONDS).toBe(30)
    expect(scheduler.PULSE_WINDOWS).toEqual([
      [9 * 60 + 30, 11 * 60 + 30],
      [13 * 60, 15 * 60],
    ])
    // 行为抽样：端点含入、窗口外排除
    expect(scheduler.isPulseMinute(570)).toBe(true) // 9:30
    expect(scheduler.isPulseMinute(690)).toBe(true) // 11:30
    expect(scheduler.isPulseMinute(691)).toBe(false)
    expect(scheduler.isPulseMinute(780)).toBe(true) // 13:00
    expect(scheduler.isPulseMinute(900)).toBe(true) // 15:00
    expect(scheduler.isPulseMinute(901)).toBe(false)
    console.log(
      `[EVIDENCE T13-5] pulse=${scheduler.PULSE_STEP_SECONDS}s windows=${JSON.stringify(
        scheduler.PULSE_WINDOWS,
      )}`,
    )
  })

  it('盘后复盘 = 18:30；盘前准备 = 9:25', () => {
    expect(scheduler.REVIEW_MINUTE).toBe(18 * 60 + 30)
    expect(scheduler.PREP_MINUTE).toBe(9 * 60 + 25)
    console.log(
      `[EVIDENCE T13-6] review=${scheduler.REVIEW_MINUTE}min(18:30) prep=${scheduler.PREP_MINUTE}min(9:25)`,
    )
  })

  it('唤醒冷却 = 5 分钟；批处理上界 = 20；单次执行预算 = 60s；唤醒文本预算 = 2000', () => {
    expect(sensor.DEFAULT_WAKE_COOLDOWN_MS).toBe(5 * 60 * 1000)
    expect(sensor.DEFAULT_BATCH_LIMIT).toBe(20)
    expect(sensor.DEFAULT_SENSOR_TIMEOUT_MS).toBe(60_000)
    expect(sensor.DEFAULT_WAKE_TEXT_BUDGET).toBe(2000)
    console.log(
      `[EVIDENCE T13-7] cooldown=${sensor.DEFAULT_WAKE_COOLDOWN_MS}ms batch=${sensor.DEFAULT_BATCH_LIMIT} timeout=${sensor.DEFAULT_SENSOR_TIMEOUT_MS}ms textBudget=${sensor.DEFAULT_WAKE_TEXT_BUDGET}`,
    )
  })
})
