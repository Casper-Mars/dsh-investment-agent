/**
 * Task-10（t100360）独立复验 —— 固定会话「启动即 ensure」（检查 → 恢复 → 新建）。
 *
 * ⚠️ 本文件由 Tester 独立构造，**不复用** developer 的 `tests/session-ensure.test.ts`。
 * 关键差异：
 *   1. 三分支与降级统一用「调用记录 fake」（自建 spy agents / sessionPersistence），
 *      断言各分支**只**走对应 API 且参数精确（sessionId/resumeSessionId/meta.cwd/agentOptions）；
 *   2. 集成场景全部用**真实 cordis Context**（`new Context()` + `ctx.provide` +
 *      `ctx.plugin`），而非手工 mock 的 `ctx.inject`。真实 cordis 的
 *      `ctx.inject([...], cb)` 语义是「依赖未提供 → 子 fiber 保持 inactive、
 *      回调**不触发**」，与 developer 测试里的「无条件同步回调」有本质区别 ——
 *      故本文件对「服务缺失安全降级」的断言是：插件 fiber 仍装载（不抛、不中断），
 *      且 ensure 回调**不触发**（create/resume **不被调用**）。
 *   3. 归属（AC4）用真实 fiber 卸载验证：`handle.dispose` 恰被调用一次。
 *
 * 范围界定：本任务验证 ensure 层 + 装配/生命周期；不把「Task-11 唤醒定点投递
 * 尚未实现」判为缺陷。
 */
import { describe, expect, it, vi, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import {
  ensurePinnedSession,
  resolveAgentOptions,
  applySessionEnsure,
  type SessionEnsureDeps,
  type EnsureAgentHandle,
  type EnsureAgentOptions,
} from '../src/session-ensure.js'
import { inject, name as pluginName, PINNED_SESSION_ID } from '../src/plugin.js'
import { PINNED_SESSION_ID as PINNED_ID_FROM_SESSION } from '../src/session.js'

const EXPECTED_TOP_INJECT = ['tools', 'skills', 'ptcRuntime', 'fs']

/** 待处置的 plugin fiber（用例结束后卸载，避免 timer 泄漏）。 */
const cleanupFibers: Array<{ dispose: () => Promise<unknown> | unknown }> = []

afterEach(async () => {
  for (const f of cleanupFibers.splice(0)) await f.dispose()
  vi.restoreAllMocks()
})

/** 构造一个自建的「调用记录」fake agents（记录 get/create/resume 调用与参数）。 */
function spyAgents(opts: {
  live?: boolean
  createReject?: Error
  resumeReject?: Error
  getThrows?: Error
} = {}) {
  const disposeSpy = vi.fn(async () => {})
  const handle: EnsureAgentHandle = {
    agent: { id: PINNED_SESSION_ID },
    dispose: disposeSpy as unknown as EnsureAgentHandle['dispose'],
  }
  const createSpy = vi.fn(async (_o: unknown) => {
    if (opts.createReject) throw opts.createReject
    return handle
  })
  const resumeSpy = vi.fn(async (_o: unknown) => {
    if (opts.resumeReject) throw opts.resumeReject
    return handle
  })
  const getSpy = vi.fn((_id: string) => {
    if (opts.getThrows) throw opts.getThrows
    return opts.live ? { id: PINNED_SESSION_ID } : undefined
  })
  const agents = {
    get: getSpy,
    create: createSpy,
    resume: resumeSpy,
  } as unknown as SessionEnsureDeps['agents']
  return { agents, handle, disposeSpy, createSpy, resumeSpy, getSpy }
}

/** 自建 deps 工厂（不依赖 developer 测试的 makeDeps）。 */
function makeDeps(overrides: Partial<SessionEnsureDeps> = {}): SessionEnsureDeps {
  return {
    agents: {
      get: vi.fn(() => undefined),
      create: vi.fn(async () => ({ agent: { id: PINNED_SESSION_ID }, dispose: vi.fn() })),
      resume: vi.fn(async () => ({ agent: { id: PINNED_SESSION_ID }, dispose: vi.fn() })),
    },
    sessionPersistence: { stat: vi.fn(async () => undefined) },
    cwd: '/srv/dsh-finance',
    agentOptions: { provider: 'deepseek', model: 'deepseek-v4-pro' },
    logger: () => {},
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// ① 纯逻辑三分支（自建 spy fake）
// ---------------------------------------------------------------------------
describe('独立复验 ① ensurePinnedSession 三分支（自建 spy fake）', () => {
  it('AC1 live 命中 → reuse：不调用 create/resume，且不返回 handle', async () => {
    const { agents, createSpy, resumeSpy, getSpy } = spyAgents({ live: true })
    const deps = makeDeps({
      agents,
      sessionPersistence: { stat: vi.fn(async () => ({ header: { id: PINNED_SESSION_ID } })) },
    })

    const { outcome, handle } = await ensurePinnedSession(deps)

    expect(outcome).toEqual({ kind: 'reuse', id: PINNED_SESSION_ID })
    expect(handle).toBeUndefined()
    expect(getSpy).toHaveBeenCalledWith(PINNED_SESSION_ID)
    expect(createSpy).not.toHaveBeenCalled()
    expect(resumeSpy).not.toHaveBeenCalled()
  })

  it('AC2 已持久化未 live → resume：带 agentOptions，且不调用 create', async () => {
    const { agents, createSpy, resumeSpy } = spyAgents({ live: false })
    const stat = vi.fn(async () => ({ header: { id: PINNED_SESSION_ID } }))
    const agentOptions: EnsureAgentOptions = { provider: 'deepseek', model: 'deepseek-v4-pro' }
    const deps = makeDeps({ agents, sessionPersistence: { stat }, agentOptions })

    const { outcome, handle } = await ensurePinnedSession(deps)

    expect(outcome).toEqual({ kind: 'resumed', id: PINNED_SESSION_ID })
    expect(handle).toBeDefined()
    expect(resumeSpy).toHaveBeenCalledTimes(1)
    expect(resumeSpy).toHaveBeenCalledWith({ resumeSessionId: PINNED_SESSION_ID, agentOptions })
    expect(createSpy).not.toHaveBeenCalled()
  })

  it('AC3 均不存在 → create：带 meta.cwd 与 agentOptions，且不调用 resume', async () => {
    const { agents, createSpy, resumeSpy } = spyAgents({ live: false })
    const cwd = '/srv/dsh-finance'
    const agentOptions: EnsureAgentOptions = { provider: 'deepseek', model: 'deepseek-v4-pro' }
    const deps = makeDeps({
      agents,
      sessionPersistence: { stat: vi.fn(async () => undefined) },
      cwd,
      agentOptions,
    })

    const { outcome, handle } = await ensurePinnedSession(deps)

    expect(outcome).toEqual({ kind: 'created', id: PINNED_SESSION_ID })
    expect(handle).toBeDefined()
    expect(createSpy).toHaveBeenCalledTimes(1)
    expect(createSpy).toHaveBeenCalledWith({
      sessionId: PINNED_SESSION_ID,
      agentOptions,
      meta: { cwd },
    })
    expect(resumeSpy).not.toHaveBeenCalled()
  })

  it('边界：agents.get 抛错 → 降级 skip，不抛异常', async () => {
    const { agents, createSpy, resumeSpy } = spyAgents({ getThrows: new Error('get boom') })
    const deps = makeDeps({ agents })

    const { outcome, handle } = await ensurePinnedSession(deps)

    expect(outcome.kind).toBe('skipped')
    expect(handle).toBeUndefined()
    expect(createSpy).not.toHaveBeenCalled()
    expect(resumeSpy).not.toHaveBeenCalled()
  })

  it('边界：stat 抛错 → 降级 skip，不抛异常', async () => {
    const { agents, createSpy, resumeSpy } = spyAgents({ live: false })
    const deps = makeDeps({
      agents,
      sessionPersistence: { stat: vi.fn(async () => { throw new Error('stat boom') }) },
    })

    const { outcome, handle } = await ensurePinnedSession(deps)

    expect(outcome.kind).toBe('skipped')
    expect(handle).toBeUndefined()
    expect(createSpy).not.toHaveBeenCalled()
    expect(resumeSpy).not.toHaveBeenCalled()
  })

  it('边界：resume reject → 降级 skip，不抛异常', async () => {
    const { agents, createSpy, resumeSpy } = spyAgents({
      live: false,
      resumeReject: new Error('resume boom'),
    })
    const deps = makeDeps({
      agents,
      sessionPersistence: { stat: vi.fn(async () => ({ header: { id: PINNED_SESSION_ID } })) },
    })

    const { outcome, handle } = await ensurePinnedSession(deps)

    expect(outcome.kind).toBe('skipped')
    expect(handle).toBeUndefined()
    expect(resumeSpy).toHaveBeenCalledTimes(1)
    expect(createSpy).not.toHaveBeenCalled()
  })

  it('AC4 再次 apply：首次 create 落盘后，重 apply（未 live + stat 命中）→ resume 恢复', async () => {
    // 第一阶段：全新 → create 新建（handle 归插件 fiber，卸载即拆除，会话落盘）。
    let persisted = false
    const agents1 = {
      get: vi.fn(() => undefined),
      create: vi.fn(async () => { persisted = true; return { agent: { id: PINNED_SESSION_ID }, dispose: vi.fn() } }),
      resume: vi.fn(async () => ({ agent: { id: PINNED_SESSION_ID }, dispose: vi.fn() })),
    } as unknown as SessionEnsureDeps['agents']
    const stat1 = vi.fn(async () => (persisted ? { header: { id: PINNED_SESSION_ID } } : undefined))
    const deps1 = makeDeps({ agents: agents1, sessionPersistence: { stat: stat1 } })
    const first = await ensurePinnedSession(deps1)
    expect(first.outcome.kind).toBe('created')
    expect(agents1.create).toHaveBeenCalledTimes(1)

    // 第二阶段：卸载后重 apply（未 live，stat 命中已落盘）→ resume 恢复，不再 create。
    const agents2 = {
      get: vi.fn(() => undefined), // 已卸载，未 live
      create: vi.fn(async () => ({ agent: { id: PINNED_SESSION_ID }, dispose: vi.fn() })),
      resume: vi.fn(async () => ({ agent: { id: PINNED_SESSION_ID }, dispose: vi.fn() })),
    } as unknown as SessionEnsureDeps['agents']
    const stat2 = vi.fn(async () => ({ header: { id: PINNED_SESSION_ID } })) // 已落盘
    const agentOptions = { provider: 'deepseek', model: 'deepseek-v4-pro' }
    const second = await ensurePinnedSession(
      makeDeps({ agents: agents2, sessionPersistence: { stat: stat2 }, agentOptions }),
    )
    expect(second.outcome.kind).toBe('resumed')
    expect(agents2.resume).toHaveBeenCalledTimes(1)
    expect(agents2.resume).toHaveBeenCalledWith({ resumeSessionId: PINNED_SESSION_ID, agentOptions })
    expect(agents2.create).not.toHaveBeenCalled()
  })

  it('边界：create reject → 降级 skip，不抛异常', async () => {
    const { agents, createSpy, resumeSpy } = spyAgents({
      live: false,
      createReject: new Error('create boom'),
    })
    const deps = makeDeps({
      agents,
      sessionPersistence: { stat: vi.fn(async () => undefined) },
    })

    const { outcome, handle } = await ensurePinnedSession(deps)

    expect(outcome.kind).toBe('skipped')
    expect(handle).toBeUndefined()
    expect(createSpy).toHaveBeenCalledTimes(1)
    expect(resumeSpy).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// ② resolveAgentOptions 投影
// ---------------------------------------------------------------------------
describe('独立复验 ② resolveAgentOptions', () => {
  it('agentDefaultModel 缺失 → 返回 {}（软取，agentOptions 全可选）', () => {
    const ctx = { get: () => undefined } as unknown as Parameters<typeof resolveAgentOptions>[0]
    expect(resolveAgentOptions(ctx)).toEqual({})
  })

  it('命中 → 仅取 { provider, model }，丢弃 reasoningEffort', () => {
    const ctx = {
      get: (name: string) =>
        name === 'agentDefaultModel'
          ? { currentSelection: () => ({ provider: 'deepseek', model: 'v4', reasoningEffort: 'high' }) }
          : undefined,
    } as unknown as Parameters<typeof resolveAgentOptions>[0]
    expect(resolveAgentOptions(ctx)).toEqual({ provider: 'deepseek', model: 'v4' })
  })
})

// ---------------------------------------------------------------------------
// ③ 集成：真实 cordis Context（inject 语义 + effect 归属）
// ---------------------------------------------------------------------------
describe('独立复验 ③ 真实 cordis Context（装配/生命周期）', () => {
  /** 用真实 cordis 装载一个「仅装配 ensure」的最小插件，返回 fiber 便于卸载。 */
  async function runEnsure(options: { cwd?: string } = {}) {
    const cwd = options.cwd ?? '/srv/dsh-finance'
    const root = new Context()
    const fiber = root.plugin({
      name: 'test-session-ensure',
      apply: (ctx: Context) => applySessionEnsure(ctx, { cwd, logger: () => {} }),
    })
    await fiber
    // 等 inject 子 fiber 的 reload 与 ensurePinnedSession 异步完成。
    await new Promise((r) => setTimeout(r, 25))
    cleanupFibers.push(fiber as unknown as { dispose: () => Promise<unknown> })
    return { root, fiber }
  }

  function provideOn(root: Context, services: Record<string, unknown>) {
    for (const [k, v] of Object.entries(services)) root.provide(k, v)
  }

  it('AC4a 服务齐备 → ensure 走 create，且 handle.dispose 绑定 fiber（卸载恰调用一次）', async () => {
    const { agents, disposeSpy, createSpy, resumeSpy } = spyAgents({ live: false })
    const stat = vi.fn(async () => undefined)

    const root = new Context()
    provideOn(root, {
      agents,
      sessionPersistence: { stat },
      agentDefaultModel: { currentSelection: () => ({ provider: 'deepseek', model: 'v4', reasoningEffort: 'high' }) },
    })
    const fiber = root.plugin({
      name: 'test-session-ensure',
      apply: (ctx: Context) => applySessionEnsure(ctx, { cwd: '/srv/dsh-finance', logger: () => {} }),
    })
    await fiber
    await new Promise((r) => setTimeout(r, 25))
    cleanupFibers.push(fiber as unknown as { dispose: () => Promise<unknown> })

    // ensure 回调触发 → 走 create（全新 Context 无 live、stat 未命中）。
    expect(createSpy).toHaveBeenCalledTimes(1)
    expect(createSpy).toHaveBeenCalledWith({
      sessionId: PINNED_SESSION_ID,
      agentOptions: { provider: 'deepseek', model: 'v4' },
      meta: { cwd: '/srv/dsh-finance' },
    })
    expect(resumeSpy).not.toHaveBeenCalled()
    expect(disposeSpy).not.toHaveBeenCalled()

    // 卸载插件 fiber → handle.dispose 恰被调用一次。
    await fiber.dispose()
    expect(disposeSpy).toHaveBeenCalledTimes(1)
  })

  it('AC4b 服务齐备但 agents.get 命中（live）→ 不 create/resume（复用，无需 dispose）', async () => {
    const { agents, disposeSpy, createSpy, resumeSpy, getSpy } = spyAgents({ live: true })
    const stat = vi.fn(async () => ({ header: { id: PINNED_SESSION_ID } }))

    const root = new Context()
    provideOn(root, {
      agents,
      sessionPersistence: { stat },
      agentDefaultModel: { currentSelection: () => ({ provider: 'deepseek', model: 'v4' }) },
    })
    const fiber = root.plugin({
      name: 'test-session-ensure',
      apply: (ctx: Context) => applySessionEnsure(ctx, { cwd: '/srv/dsh-finance', logger: () => {} }),
    })
    await fiber
    await new Promise((r) => setTimeout(r, 25))
    cleanupFibers.push(fiber as unknown as { dispose: () => Promise<unknown> })

    expect(getSpy).toHaveBeenCalledWith(PINNED_SESSION_ID)
    expect(createSpy).not.toHaveBeenCalled()
    expect(resumeSpy).not.toHaveBeenCalled()
    expect(disposeSpy).not.toHaveBeenCalled()
  })

  it('AC4c 服务齐备且 stat 命中 → resume（历史上下文保留），卸载拆除 handle', async () => {
    const { agents, disposeSpy, createSpy, resumeSpy } = spyAgents({ live: false })
    const stat = vi.fn(async () => ({ header: { id: PINNED_SESSION_ID } }))

    const root = new Context()
    provideOn(root, {
      agents,
      sessionPersistence: { stat },
      agentDefaultModel: { currentSelection: () => ({ provider: 'deepseek', model: 'v4' }) },
    })
    const fiber = root.plugin({
      name: 'test-session-ensure',
      apply: (ctx: Context) => applySessionEnsure(ctx, { cwd: '/srv/dsh-finance', logger: () => {} }),
    })
    await fiber
    await new Promise((r) => setTimeout(r, 25))
    cleanupFibers.push(fiber as unknown as { dispose: () => Promise<unknown> })

    expect(resumeSpy).toHaveBeenCalledTimes(1)
    expect(resumeSpy).toHaveBeenCalledWith({
      resumeSessionId: PINNED_SESSION_ID,
      agentOptions: { provider: 'deepseek', model: 'v4' },
    })
    expect(createSpy).not.toHaveBeenCalled()

    await fiber.dispose()
    expect(disposeSpy).toHaveBeenCalledTimes(1)
  })

  it('AC 服务缺失（agents 缺失）→ 不抛、fiber 装载、ensure 回调不触发（create 不被调用）', async () => {
    const createSpy = vi.fn()
    const root = new Context()
    // 仅提供 sessionPersistence，缺 agents。
    provideOn(root, { sessionPersistence: { stat: vi.fn(async () => undefined) } })
    const fiber = root.plugin({
      name: 'test-session-ensure',
      apply: (ctx: Context) => applySessionEnsure(ctx, { cwd: '/srv/dsh-finance', logger: () => {} }),
    })
    await expect(fiber).resolves.toBeDefined()
    await new Promise((r) => setTimeout(r, 25))
    cleanupFibers.push(fiber as unknown as { dispose: () => Promise<unknown> })

    // 真实 cordis：依赖未齐 → 回调不触发，create 绝不调用，也不抛异常。
    expect(createSpy).not.toHaveBeenCalled()
  })

  it('AC 服务缺失（sessionPersistence 缺失）→ 不抛、fiber 装载、ensure 回调不触发', async () => {
    const createSpy = vi.fn()
    const root = new Context()
    // 仅提供 agents，缺 sessionPersistence。
    provideOn(root, {
      agents: { get: () => undefined, create: createSpy, resume: vi.fn() },
    })
    const fiber = root.plugin({
      name: 'test-session-ensure',
      apply: (ctx: Context) => applySessionEnsure(ctx, { cwd: '/srv/dsh-finance', logger: () => {} }),
    })
    await expect(fiber).resolves.toBeDefined()
    await new Promise((r) => setTimeout(r, 25))
    cleanupFibers.push(fiber as unknown as { dispose: () => Promise<unknown> })

    expect(createSpy).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// ④ 顶层契约不变（AC6）
// ---------------------------------------------------------------------------
describe('独立复验 ④ 顶层契约不变（AC6）', () => {
  it('顶层 inject 仍为 [tools, skills, ptcRuntime, fs]', () => {
    expect(inject).toEqual(EXPECTED_TOP_INJECT)
  })

  it('cordis.patch.yml 未被改动（id/name/inject 与 plugin.ts 一致）', () => {
    const patch = readFileSync(fileURLToPath(new URL('../cordis.patch.yml', import.meta.url)), 'utf8')
    expect(patch).toContain('id: dsh-finance')
    expect(patch).toContain('name: dsh-finance')
    expect(patch).toContain("inject: ['tools', 'skills', 'ptcRuntime', 'fs']")
  })

  it('PINNED_SESSION_ID 单一来源（plugin.ts 与 session.ts 一致，值 = 插件名）', () => {
    expect(PINNED_SESSION_ID).toBe('investment-advisor')
    expect(PINNED_ID_FROM_SESSION).toBe(PINNED_SESSION_ID)
    expect(PINNED_SESSION_ID).toBe(pluginName)
  })
})
