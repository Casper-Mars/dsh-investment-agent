/**
 * Task-10（t100360）会话确保层单测：固定会话「检查 → 恢复 → 新建」。
 *
 * 覆盖（验收标准逐条）：
 *   ① 会话 live 时直接复用，不重复创建（`agents.get` 命中 → `reuse`，
 *      不再调用 `create` / `resume`）。
 *   ② 会话已持久化但未 live 时走 resume 恢复（历史上下文保留）。
 *   ③ 均不存在时 create 新建，并带上 cwd / agentOptions。
 *   ④ create/resume 的归属为插件 fiber（卸载时拆除）；会话已落盘时再次
 *      apply 能 resume 恢复上下文。
 *   ⑤ 三分支均有单元测试（注入 fake agents / sessionPersistence 验证）。
 *
 * 另覆盖：服务缺失安全降级（agents 或 sessionPersistence 任一缺失时
 * `applySessionEnsure` 记日志、跳过、不抛异常）。
 */
import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import {
  ensurePinnedSession,
  resolveAgentOptions,
  applySessionEnsure,
  type SessionEnsureDeps,
  type EnsureAgentHandle,
} from '../src/session-ensure.js'
import { PINNED_SESSION_ID } from '../src/session.js'

/** 构造一个用于三分支断言的 fake agents（记录 create/resume 调用）。 */
function makeAgents(state: {
  live?: boolean
  persisted?: boolean
}): {
  agents: SessionEnsureDeps['agents']
  handle: EnsureAgentHandle
  createSpy: ReturnType<typeof vi.fn>
  resumeSpy: ReturnType<typeof vi.fn>
} {
  const disposeSpy = vi.fn(async () => {})
  const handle: EnsureAgentHandle = {
    agent: { id: PINNED_SESSION_ID },
    dispose: disposeSpy as unknown as EnsureAgentHandle['dispose'],
  }
  const createSpy = vi.fn(async () => handle)
  const resumeSpy = vi.fn(async () => handle)
  const agents = {
    get: vi.fn((id: string) => (state.live ? { id } : undefined)),
    create: createSpy,
    resume: resumeSpy,
  } as unknown as SessionEnsureDeps['agents']
  return { agents, handle, createSpy, resumeSpy }
}

function makeDeps(overrides: Partial<SessionEnsureDeps> = {}): SessionEnsureDeps {
  return {
    agents: {
      get: vi.fn(() => undefined),
      create: vi.fn(async () => ({ agent: { id: PINNED_SESSION_ID }, dispose: vi.fn() })),
      resume: vi.fn(async () => ({ agent: { id: PINNED_SESSION_ID }, dispose: vi.fn() })),
    },
    sessionPersistence: { stat: vi.fn(async () => undefined) },
    cwd: '/home/user/project',
    agentOptions: { provider: 'deepseek', model: 'deepseek-v4-pro' },
    logger: () => {},
    ...overrides,
  }
}

describe('③ ensurePinnedSession 三分支（注入 fake agents / sessionPersistence）', () => {
  it('① live 命中 → 直接复用，不调用 create / resume，且不返回 handle', async () => {
    const { agents, createSpy, resumeSpy } = makeAgents({ live: true, persisted: true })
    const deps = makeDeps({ agents, sessionPersistence: { stat: vi.fn(async () => ({})) } })

    const { outcome, handle } = await ensurePinnedSession(deps)

    expect(outcome).toEqual({ kind: 'reuse', id: PINNED_SESSION_ID })
    expect(handle).toBeUndefined()
    expect(createSpy).not.toHaveBeenCalled()
    expect(resumeSpy).not.toHaveBeenCalled()
    expect(agents.get).toHaveBeenCalledWith(PINNED_SESSION_ID)
  })

  it('② 已持久化（stat 命中）但未 live → resume 恢复，带上 agentOptions', async () => {
    const { agents, createSpy, resumeSpy } = makeAgents({ live: false, persisted: true })
    const stat = vi.fn(async () => ({ header: { id: PINNED_SESSION_ID } }))
    const agentOptions = { provider: 'deepseek', model: 'deepseek-v4-pro' }
    const deps = makeDeps({ agents, sessionPersistence: { stat }, agentOptions })

    const { outcome, handle } = await ensurePinnedSession(deps)

    expect(outcome).toEqual({ kind: 'resumed', id: PINNED_SESSION_ID })
    expect(handle).toBeDefined()
    expect(handle!.agent.id).toBe(PINNED_SESSION_ID)
    expect(resumeSpy).toHaveBeenCalledWith({
      resumeSessionId: PINNED_SESSION_ID,
      agentOptions,
    })
    expect(createSpy).not.toHaveBeenCalled()
  })

  it('③ 均不存在 → create 新建，带上 cwd / agentOptions', async () => {
    const { agents, createSpy, resumeSpy } = makeAgents({ live: false, persisted: false })
    const cwd = '/home/user/project'
    const agentOptions = { provider: 'deepseek', model: 'deepseek-v4-pro' }
    const deps = makeDeps({ agents, sessionPersistence: { stat: vi.fn(async () => undefined) }, cwd, agentOptions })

    const { outcome, handle } = await ensurePinnedSession(deps)

    expect(outcome).toEqual({ kind: 'created', id: PINNED_SESSION_ID })
    expect(handle).toBeDefined()
    expect(createSpy).toHaveBeenCalledWith({
      sessionId: PINNED_SESSION_ID,
      agentOptions,
      meta: { cwd },
    })
    expect(resumeSpy).not.toHaveBeenCalled()
  })

  it('② create/resume 抛错 → 降级 skip（不抛异常、不中断）', async () => {
    const agents = {
      get: vi.fn(() => undefined),
      create: vi.fn(async () => { throw new Error('boom') }),
      resume: vi.fn(async () => { throw new Error('boom') }),
    } as unknown as SessionEnsureDeps['agents']

    const { outcome, handle } = await ensurePinnedSession(
      makeDeps({ agents, sessionPersistence: { stat: vi.fn(async () => undefined) } }),
    )

    expect(outcome.kind).toBe('skipped')
    expect(handle).toBeUndefined()
  })
})

describe('④ 归属：applySessionEnsure 把 handle.dispose 绑定插件 fiber；再次 apply resume', () => {
  it('create/resume 的 dispose 绑定 effect 卸载回调（卸载即拆除）', async () => {
    const disposeSpy = vi.fn(async () => {})
    const handle: EnsureAgentHandle = {
      agent: { id: PINNED_SESSION_ID },
      dispose: disposeSpy as unknown as EnsureAgentHandle['dispose'],
    }
    const agents = {
      get: vi.fn(() => undefined),
      create: vi.fn(async () => handle),
      resume: vi.fn(async () => handle),
    }

    // 还原 cordis 语义：ctx.inject 同步回调；ctx.effect 记录 body 并返回 disposer。
    let effectDisposer: (() => void) | undefined
    const ctx = {
      get(name: string) {
        if (name === 'agentDefaultModel') {
          return { currentSelection: () => ({ provider: 'p', model: 'm' }) }
        }
        return undefined
      },
      inject(_deps: string[], cb: (c: Context) => void) {
        cb({
          get: (name: string) => (name === 'agents' ? agents : { stat: vi.fn(async () => undefined) }),
        } as unknown as Context)
        return {} as never
      },
      effect(body: () => unknown) {
        const d = body()
        effectDisposer = typeof d === 'function' ? (d as () => void) : undefined
        return () => {}
      },
    } as unknown as Context

    applySessionEnsure(ctx)

    // 等待内部 ensurePinnedSession 异步完成，让 disposeHandle 被赋值。
    await new Promise((r) => setTimeout(r, 20))

    expect(disposeSpy).not.toHaveBeenCalled()
    effectDisposer!()
    expect(disposeSpy).toHaveBeenCalledTimes(1)
  })

  it('再次 apply：stat 命中（已落盘）且未 live → 走 resume 分支', async () => {
    const resumeSpy = vi.fn(async () => ({
      agent: { id: PINNED_SESSION_ID },
      dispose: vi.fn(async () => {}),
    }))
    const agents = {
      get: vi.fn(() => undefined), // 未 live
      create: vi.fn(),
      resume: resumeSpy,
    }
    const stat = vi.fn(async () => ({ header: { id: PINNED_SESSION_ID } }))

    const ctx = {
      get(name: string) {
        if (name === 'agentDefaultModel') {
          return { currentSelection: () => ({ provider: 'p', model: 'm' }) }
        }
        return undefined
      },
      inject(_deps: string[], cb: (c: Context) => void) {
        cb({
          get: (name: string) => (name === 'agents' ? agents : { stat }),
        } as unknown as Context)
        return {} as never
      },
      effect(body: () => unknown) {
        body()
        return () => {}
      },
    } as unknown as Context

    applySessionEnsure(ctx)

    await new Promise((r) => setTimeout(r, 20))

    expect(resumeSpy).toHaveBeenCalledTimes(1)
    expect(resumeSpy).toHaveBeenCalledWith(
      expect.objectContaining({ resumeSessionId: PINNED_SESSION_ID }),
    )
    expect(agents.create).not.toHaveBeenCalled()
  })
})

describe('⑤ 服务缺失安全降级（不抛异常、不中断装载）', () => {
  it('agents 缺失 → 记日志跳过，不抛异常', () => {
    const warnings: string[] = []
    const ctx = {
      get: () => undefined,
      inject(_deps: string[], cb: (c: Context) => void) {
        cb({ get: () => undefined } as unknown as Context)
        return {} as never
      },
      effect(body: () => unknown) {
        body()
        return () => {}
      },
    } as unknown as Context

    expect(() => applySessionEnsure(ctx, { logger: (m) => warnings.push(m) })).not.toThrow()
    expect(warnings.some((w) => w.includes('agents 服务不可用'))).toBe(true)
  })

  it('sessionPersistence 缺失 → 记日志跳过，不抛异常', () => {
    const warnings: string[] = []
    const agents = { get: vi.fn(() => undefined) }
    const ctx = {
      get: () => undefined,
      inject(_deps: string[], cb: (c: Context) => void) {
        cb({
          get: (name: string) => (name === 'agents' ? agents : undefined),
        } as unknown as Context)
        return {} as never
      },
      effect(body: () => unknown) {
        body()
        return () => {}
      },
    } as unknown as Context

    expect(() => applySessionEnsure(ctx, { logger: (m) => warnings.push(m) })).not.toThrow()
    expect(warnings.some((w) => w.includes('sessionPersistence 服务不可用'))).toBe(true)
  })

  it('resolveAgentOptions：agentDefaultModel 缺失时返回 {}，命中时取 provider/model', () => {
    const empty = { get: () => undefined } as unknown as Pick<Context, 'get'>
    expect(resolveAgentOptions(empty)).toEqual({})

    const modeled = {
      get: (name: string) =>
        name === 'agentDefaultModel'
          ? { currentSelection: () => ({ provider: 'deepseek', model: 'v4', reasoningEffort: 'high' }) }
          : undefined,
    } as unknown as Pick<Context, 'get'>
    expect(resolveAgentOptions(modeled)).toEqual({ provider: 'deepseek', model: 'v4' })
  })
})
