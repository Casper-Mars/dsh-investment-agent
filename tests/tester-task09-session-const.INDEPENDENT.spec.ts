/**
 * Task-09（t100359）独立复验 —— 固定会话「基础层」。
 *
 * ⚠️ 本文件由 Tester 独立构造，**不复用** developer 的 `tests/session-const.test.ts`。
 * 关键差异：全部动态注入场景使用**真实 cordis Context**（`new Context()` +
 * `ctx.provide` + `ctx.plugin`），而非手工 mock 的 `ctx.inject`。真实 cordis 的
 * `ctx.inject([...], cb)` 语义是「依赖未提供则子 fiber 保持 inactive、回调不触发」，
 * 与 mock 的「无条件同步回调」有本质区别 —— 因此本文件对「服务缺失安全降级」的
 * 断言是：插件仍装载成功（不抛、不中断），且就绪回调**不触发**（即动态依赖处于等待态）。
 *
 * 范围界定：本任务只做基础层，不实现 ensure/创建会话（Task-10）、不改变唤醒定点
 * 投递（Task-11）—— 不把「尚未实现 ensure/定点投递」判为缺陷。
 */
import { describe, expect, it, vi, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import {
  apply,
  inject,
  name as pluginName,
  PINNED_SESSION_ID,
} from '../src/plugin.js'
import { PINNED_SESSION_ID as PINNED_SESSION_ID_SESSION } from '../src/session.js'

/** 顶层契约（与 cordis.patch.yml 一致）。 */
const EXPECTED_TOP_INJECT = ['tools', 'skills', 'ptcRuntime', 'fs']

/** 待处置的 plugin fiber（用于在用例结束后 stop scheduler，避免 timer 泄漏）。 */
const cleanupFibers: Array<{ dispose: () => Promise<unknown> | unknown }> = []

afterEach(async () => {
  for (const f of cleanupFibers.splice(0)) await f.dispose()
  vi.restoreAllMocks()
})

/** 静默日志，仅保留我们要断言的 console.log 捕获。 */
function silenceConsole() {
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
}

/** 提取 console.log 的全部输出（跨调用拼接）。 */
function loggedText(logSpy: ReturnType<typeof vi.spyOn>): string {
  return logSpy.mock.calls.map((c) => c.join(' ')).join('\n')
}

/**
 * 用真实 cordis Context 装载插件：
 *   - `new Context()` 建根上下文；
 *   - `ctx.provide` 注入服务（真实 store / fiber 语义）；
 *   - `ctx.plugin({ name, inject, apply })` 启动插件 fiber（顶层 inject 四项全就绪才激活）。
 */
async function loadPluginWith(services: Record<string, unknown>): Promise<Context> {
  const root = new Context()
  for (const [key, value] of Object.entries(services)) root.provide(key, value)
  const fiber = root.plugin({ name: pluginName, inject, apply })
  await fiber // 等插件 fiber 收敛（apply 已执行、scheduler 已 start）
  // 让 `ctx.inject(['agents']/['sessionPersistence']/['systemPrompt'])` 子 fiber
  // 的 reload（`await Promise.resolve()` 后执行）在微任务队列中完成。
  await new Promise((resolve) => setTimeout(resolve, 20))
  cleanupFibers.push(fiber as unknown as { dispose: () => Promise<unknown> })
  return root
}

/** 顶层四项服务的最小可用桩。 */
function coreServices() {
  return {
    tools: { register: () => () => {} },
    skills: { register: () => () => {} },
    ptcRuntime: {
      run: async () => ({ logs: [], value: { shouldWake: false } }),
      resolve: (r: unknown) => r,
    },
    fs: {},
  }
}

// ---------------------------------------------------------------------------
// ① 固定常量 PINNED_SESSION_ID
// ---------------------------------------------------------------------------
describe('Task-09 独立复验 ① 固定常量', () => {
  it('常量存在，且为写死字面量（与插件身份一致）', () => {
    expect(PINNED_SESSION_ID).toBe('investment-advisor')
    expect(pluginName).toBe('investment-advisor')
    expect(PINNED_SESSION_ID).toBe(pluginName)
  })

  it('plugin.ts 与 session.ts 导出同一常量（契约层唯一来源）', () => {
    expect(PINNED_SESSION_ID_SESSION).toBe(PINNED_SESSION_ID)
  })

  it('session.ts 源码无 process.env / 无配置读取路径（写死值，非配置项）', () => {
    const src = readFileSync(
      fileURLToPath(new URL('../src/session.ts', import.meta.url)),
      'utf8',
    )
    expect(src).toContain("export const PINNED_SESSION_ID = 'investment-advisor'")
    expect(src).not.toContain('process.env')
    expect(src).not.toContain('DATA_ROOT_ENV')
    // 无任何配置读取函数（如 resolveConfig / readConfig / getConfig）。
    expect(src).not.toMatch(/readConfig|getConfig|resolveConfig|loadConfig/)
  })
})

// ---------------------------------------------------------------------------
// ③ 顶层契约未被改动
// ---------------------------------------------------------------------------
describe('Task-09 独立复验 ③ 顶层 inject 契约', () => {
  it('顶层 inject 仍为 [tools, skills, ptcRuntime, fs]', () => {
    expect(inject).toEqual(EXPECTED_TOP_INJECT)
  })

  it('cordis.patch.yml 的 inject 与 src/plugin.ts 完全一致（id/name 亦不回退）', () => {
    const patch = readFileSync(
      fileURLToPath(new URL('../cordis.patch.yml', import.meta.url)),
      'utf8',
    )
    expect(patch).toContain('id: dsh-finance')
    expect(patch).toContain('name: dsh-finance')
    expect(patch).toContain("inject: ['tools', 'skills', 'ptcRuntime', 'fs']")
  })
})

// ---------------------------------------------------------------------------
// ② 动态注入就绪（真实 cordis Context 验证）
// ---------------------------------------------------------------------------
describe('Task-09 独立复验 ② 动态注入与安全降级（真实 cordis）', () => {
  it('(a) 服务齐全：agents 与 sessionPersistence 就绪回调均触发，固定会话常量注入 runner', async () => {
    silenceConsole()
    const logSpy = vi.mocked(console.log)

    await loadPluginWith({
      ...coreServices(),
      agents: { list: () => [] },
      sessionPersistence: {
        stat: async () => undefined,
        list: async () => [],
      },
    })

    const text = loggedText(logSpy)
    // 插件本体成功装载（apply 已执行）。
    expect(text).toContain('插件加载：name=investment-advisor')
    // agents 就绪回调触发。
    expect(text).toContain('唤醒通道已就绪（agents 服务）')
    // sessionPersistence 就绪回调触发，且固定会话标识被注入。
    expect(text).toContain('会话持久化通道已就绪（pinned session = investment-advisor）')
  })

  it('(b) agents 与 sessionPersistence 均缺失：插件仍装载、不抛、就绪回调不触发（安全降级）', async () => {
    silenceConsole()
    const logSpy = vi.mocked(console.log)

    // 仅顶层四项服务；不提供 agents / sessionPersistence。
    await expect(loadPluginWith(coreServices())).resolves.toBeDefined()

    const text = loggedText(logSpy)
    expect(text).toContain('插件加载：name=investment-advisor')
    expect(text).not.toContain('唤醒通道已就绪')
    expect(text).not.toContain('会话持久化通道已就绪')
  })

  it('(b2) 仅 agents 可用、sessionPersistence 缺失：agents 通道就绪、会话通道保持等待（互不影响）', async () => {
    silenceConsole()
    const logSpy = vi.mocked(console.log)

    await expect(
      loadPluginWith({ ...coreServices(), agents: { list: () => [] } }),
    ).resolves.toBeDefined()

    const text = loggedText(logSpy)
    expect(text).toContain('唤醒通道已就绪（agents 服务）')
    expect(text).not.toContain('会话持久化通道已就绪')
  })

  it('(b3) 仅 sessionPersistence 可用、agents 缺失：会话通道就绪、agents 通道保持等待（互不影响）', async () => {
    silenceConsole()
    const logSpy = vi.mocked(console.log)

    await expect(
      loadPluginWith({
        ...coreServices(),
        sessionPersistence: { stat: async () => undefined, list: async () => [] },
      }),
    ).resolves.toBeDefined()

    const text = loggedText(logSpy)
    expect(text).toContain('会话持久化通道已就绪（pinned session = investment-advisor）')
    expect(text).not.toContain('唤醒通道已就绪')
  })
})
