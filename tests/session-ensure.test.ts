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
  mountDefaultPresetSetup,
  applySessionEnsure,
  attachPinnedSessionToWorkspace,
  type SessionEnsureDeps,
  type EnsureAgentHandle,
  type AgentPresetsLike,
  type WorkspaceRegistryLike,
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

describe('⑥ 固定会话归属（§9.7）：attachPinnedSessionToWorkspace 三分支', () => {
  it('归属成功：resolveByPath 未命中 → create → attachSession（cwd 对应工作区）', async () => {
    const attachSpy = vi.fn(async () => {})
    const createSpy = vi.fn(async () => ({ path: '/cwd', attachSession: attachSpy }))
    const resolveSpy = vi.fn(async () => undefined)
    const registry: WorkspaceRegistryLike = {
      resolveByPath: resolveSpy,
      create: createSpy,
    }

    await attachPinnedSessionToWorkspace(registry, '/cwd')

    expect(resolveSpy).toHaveBeenCalledWith('/cwd')
    expect(createSpy).toHaveBeenCalledWith('/cwd')
    expect(attachSpy).toHaveBeenCalledWith(PINNED_SESSION_ID)
  })

  it('归属幂等：resolveByPath 命中即复用，不重复 create 也不重复登记（单次 attach）', async () => {
    const attachSpy = vi.fn(async () => {})
    const createSpy = vi.fn(async () => ({ path: '/cwd', attachSession: attachSpy }))
    const resolveSpy = vi.fn(async () => ({ path: '/cwd', attachSession: attachSpy }))
    const registry: WorkspaceRegistryLike = {
      resolveByPath: resolveSpy,
      create: createSpy,
    }

    // 连续两次 apply：第二次 resolveByPath 命中已建工作区，不重复 create。
    await attachPinnedSessionToWorkspace(registry, '/cwd')
    await attachPinnedSessionToWorkspace(registry, '/cwd')

    expect(resolveSpy).toHaveBeenCalledTimes(2)
    expect(createSpy).not.toHaveBeenCalled()
    // attachSession 自身幂等：仍调用，但交由 harness 侧去重（本层不截流）。
    expect(attachSpy).toHaveBeenCalledWith(PINNED_SESSION_ID)
  })

  it('服务缺失/失败降级：resolveByPath reject → 抛错（交上层降级，不伪造成功）', async () => {
    const registry: WorkspaceRegistryLike = {
      resolveByPath: vi.fn(async () => { throw new Error('realpath reject: path not found') }),
      create: vi.fn(async () => ({ attachSession: vi.fn(async () => {}) })),
    }

    await expect(attachPinnedSessionToWorkspace(registry, '/nonexistent')).rejects.toThrow(
      'path not found',
    )
  })
})

describe('⑦ applySessionEnsure 的 workspaceRegistry 接线（降级不中断装载）', () => {
  /** 构造一个按 deps 名分发 get 的 ctx，并记录 effect label 与 workspaceRegistry fake。 */
  function makeCtxWithWorkspace(opts: {
    workspaceRegistry?: unknown
    withSessionServices?: boolean
  }) {
    const live = true
    const agents = {
      get: vi.fn((id: string) => (live && opts.withSessionServices ? { id } : undefined)),
      create: vi.fn(async () => ({ agent: { id: PINNED_SESSION_ID }, dispose: vi.fn(async () => {}) })),
      resume: vi.fn(async () => ({ agent: { id: PINNED_SESSION_ID }, dispose: vi.fn(async () => {}) })),
    }
    const stat = vi.fn(async () => undefined)
    const labels: string[] = []
    const ctx = {
      get(name: string) {
        if (name === 'agentDefaultModel') {
          return { currentSelection: () => ({ provider: 'p', model: 'm' }) }
        }
        return undefined
      },
      inject(_deps: string[], cb: (c: Context) => void) {
        cb({
          get: (name: string) => {
            if (name === 'agents' && opts.withSessionServices) return agents
            if (name === 'sessionPersistence' && opts.withSessionServices) return { stat }
            if (name === 'workspaceRegistry') return opts.workspaceRegistry
            return undefined
          },
        } as unknown as Context)
        return {} as never
      },
      effect(body: () => unknown, label?: string) {
        labels.push(label ?? '')
        body()
        return () => {}
      },
    } as unknown as Context
    return { ctx, agents, stat, labels }
  }

  it('workspaceRegistry 缺失 → 记日志降级，不抛异常，且不影响会话 ensure', async () => {
    const warnings: string[] = []
    const { ctx } = makeCtxWithWorkspace({ workspaceRegistry: undefined, withSessionServices: true })

    expect(() => applySessionEnsure(ctx, { logger: (m) => warnings.push(m), cwd: '/cwd' })).not.toThrow()
    await new Promise((r) => setTimeout(r, 20))

    expect(warnings.some((w) => w.includes('workspaceRegistry 服务不可用'))).toBe(true)
  })

  it('归属成功：ensure 就绪（live）→ resolveByPath 命中 → attachSession', async () => {
    const attachSpy = vi.fn(async () => {})
    const resolveSpy = vi.fn(async () => ({ path: '/cwd', attachSession: attachSpy }))
    const createSpy = vi.fn(async () => ({ path: '/cwd', attachSession: attachSpy }))
    const registry: WorkspaceRegistryLike = { resolveByPath: resolveSpy, create: createSpy }

    const { ctx } = makeCtxWithWorkspace({ workspaceRegistry: registry, withSessionServices: true })

    applySessionEnsure(ctx, { cwd: '/cwd' })
    await new Promise((r) => setTimeout(r, 20))

    expect(resolveSpy).toHaveBeenCalledWith('/cwd')
    expect(attachSpy).toHaveBeenCalledWith(PINNED_SESSION_ID)
  })

  it('归属失败（attach 抛错）→ 记日志降级 skip，不抛异常、不中断', async () => {
    const warnings: string[] = []
    const attachSpy = vi.fn(async () => { throw new Error('attach boom') })
    const registry: WorkspaceRegistryLike = {
      resolveByPath: vi.fn(async () => ({ path: '/cwd', attachSession: attachSpy })),
      create: vi.fn(async () => ({ path: '/cwd', attachSession: attachSpy })),
    }
    const { ctx } = makeCtxWithWorkspace({ workspaceRegistry: registry, withSessionServices: true })

    expect(() => applySessionEnsure(ctx, { logger: (m) => warnings.push(m), cwd: '/cwd' })).not.toThrow()
    await new Promise((r) => setTimeout(r, 20))

    expect(warnings.some((w) => w.includes('会话归属失败'))).toBe(true)
  })

  it('会话服务缺失（agents 不可用）→ 跳过 ensure，且不触发归属，不抛异常', async () => {
    const warnings: string[] = []
    const resolveSpy = vi.fn(async () => ({ path: '/cwd', attachSession: vi.fn(async () => {}) }))
    const registry: WorkspaceRegistryLike = {
      resolveByPath: resolveSpy,
      create: vi.fn(async () => ({ path: '/cwd', attachSession: vi.fn(async () => {}) })),
    }
    const { ctx } = makeCtxWithWorkspace({ workspaceRegistry: registry, withSessionServices: false })

    expect(() => applySessionEnsure(ctx, { logger: (m) => warnings.push(m), cwd: '/cwd' })).not.toThrow()
    await new Promise((r) => setTimeout(r, 20))

    expect(warnings.some((w) => w.includes('agents 服务不可用'))).toBe(true)
    expect(resolveSpy).not.toHaveBeenCalled()
  })
})

describe('⑧ 回归：apply 流程下 ensure/create 只执行一次（D1 竞态消除）', () => {
  it('非 live、未持久化 → create 仅调用一次，且归属仅执行一次', async () => {
    const createSpy = vi.fn(async () => ({
      agent: { id: PINNED_SESSION_ID },
      dispose: vi.fn(async () => {}),
    }))
    const resumeSpy = vi.fn(async () => ({
      agent: { id: PINNED_SESSION_ID },
      dispose: vi.fn(async () => {}),
    }))
    const agents = {
      get: vi.fn(() => undefined), // 未 live
      create: createSpy,
      resume: resumeSpy,
    }
    const stat = vi.fn(async () => undefined) // 未持久化

    const attachSpy = vi.fn(async () => {})
    const registry: WorkspaceRegistryLike = {
      resolveByPath: vi.fn(async () => ({ path: '/cwd', attachSession: attachSpy })),
      create: vi.fn(async () => ({ path: '/cwd', attachSession: attachSpy })),
    }

    const ctx = {
      get(name: string) {
        if (name === 'agentDefaultModel') {
          return { currentSelection: () => ({ provider: 'p', model: 'm' }) }
        }
        return undefined
      },
      inject(_deps: string[], cb: (c: Context) => void) {
        cb({
          get: (name: string) => {
            if (name === 'agents') return agents
            if (name === 'sessionPersistence') return { stat }
            if (name === 'workspaceRegistry') return registry
            return undefined
          },
        } as unknown as Context)
        return {} as never
      },
      effect(body: () => unknown) {
        body()
        return () => {}
      },
    } as unknown as Context

    applySessionEnsure(ctx, { cwd: '/cwd' })
    await new Promise((r) => setTimeout(r, 20))

    // D1 回归：ensure 只执行一次 → create 只被调用一次（旧实现两个 effect 会并发 create 两次）。
    expect(createSpy).toHaveBeenCalledTimes(1)
    expect(resumeSpy).not.toHaveBeenCalled()
    // 归属仅执行一次（无重复 ensure 引发的重复 attach）。
    expect(attachSpy).toHaveBeenCalledTimes(1)
    expect(attachSpy).toHaveBeenCalledWith(PINNED_SESSION_ID)
  })
})

describe('⑨ 开场 notice 接线（§9.7 v1.6，Task-15 AC1）：applySessionEnsure 触发一次性投递', () => {
  /** 构造「含 open 判读能力」的 ctx：sessionPersistence 带 open(返回带 read 的句柄)。 */
  function makeCtxWithNotice(opts: {
    openEvents: Array<{ type: string }>
    withWorkspace?: boolean
  }) {
    const followupSpy = vi.fn()
    const liveAgent = { id: PINNED_SESSION_ID, followup: followupSpy }
    const agents = {
      get: vi.fn(() => liveAgent),
      create: vi.fn(async () => ({ agent: liveAgent, dispose: vi.fn(async () => {}) })),
      resume: vi.fn(async () => ({ agent: liveAgent, dispose: vi.fn(async () => {}) })),
    }
    // 只读句柄：read 返回注入的事件序列（判读 blank 用）。
    const sessionPersistence = {
      stat: vi.fn(async () => undefined),
      open: vi.fn(async () => ({
        read: vi.fn(async () => ({ events: opts.openEvents })),
        close: vi.fn(async () => {}),
      })),
    }
    const attachSpy = vi.fn(async () => {})
    const registry: WorkspaceRegistryLike = {
      resolveByPath: vi.fn(async () => ({ path: '/cwd', attachSession: attachSpy })),
      create: vi.fn(async () => ({ path: '/cwd', attachSession: attachSpy })),
    }
    const state = { followupSpy, agents, sessionPersistence, attachSpy }
    const ctx = {
      get(name: string) {
        if (name === 'agentDefaultModel') {
          return { currentSelection: () => ({ provider: 'p', model: 'm' }) }
        }
        return undefined
      },
      inject(_deps: string[], cb: (c: Context) => void) {
        cb({
          get: (name: string) => {
            if (name === 'agents') return agents
            if (name === 'sessionPersistence') return sessionPersistence
            if (name === 'workspaceRegistry' && opts.withWorkspace !== false) return registry
            return undefined
          },
        } as unknown as Context)
        return {} as never
      },
      effect(body: () => unknown) {
        body()
        return () => {}
      },
    } as unknown as Context
    return { ctx, ...state }
  }

  it('blank（空事件）→ 归属后投递一次开场 notice；再次 apply（非 blank）→ 不重复投', async () => {
    const first = makeCtxWithNotice({ openEvents: [] })
    applySessionEnsure(first.ctx, { cwd: '/cwd' })
    await new Promise((r) => setTimeout(r, 30))
    // 归属已执行。
    expect(first.attachSpy).toHaveBeenCalledWith(PINNED_SESSION_ID)
    // blank → 投递一次。
    expect(first.followupSpy).toHaveBeenCalledTimes(1)
    expect(first.followupSpy).toHaveBeenCalledWith(
      expect.objectContaining({ role: 'user', source: expect.objectContaining({ form: 'notice' }) }),
    )

    // 二次 apply：open 返回的事件含 turn/start → 非 blank → 不重复投递。
    const second = makeCtxWithNotice({ openEvents: [{ type: 'turn/start' }] })
    applySessionEnsure(second.ctx, { cwd: '/cwd' })
    await new Promise((r) => setTimeout(r, 30))
    expect(second.followupSpy).not.toHaveBeenCalled()
  })

  it('sessionPersistence.open 缺失 → 降级跳过，不抛异常，且不影响 ensure/归属', async () => {
    const followupSpy = vi.fn()
    const liveAgent = { id: PINNED_SESSION_ID, followup: followupSpy }
    const agents = {
      get: vi.fn(() => liveAgent),
      create: vi.fn(async () => ({ agent: liveAgent, dispose: vi.fn(async () => {}) })),
      resume: vi.fn(async () => ({ agent: liveAgent, dispose: vi.fn(async () => {}) })),
    }
    const sessionPersistence = { stat: vi.fn(async () => undefined) } // 无 open
    const attachSpy = vi.fn(async () => {})
    const registry: WorkspaceRegistryLike = {
      resolveByPath: vi.fn(async () => ({ path: '/cwd', attachSession: attachSpy })),
      create: vi.fn(async () => ({ path: '/cwd', attachSession: attachSpy })),
    }
    const warnings: string[] = []
    const ctx = {
      get(name: string) {
        if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'p', model: 'm' }) }
        return undefined
      },
      inject(_deps: string[], cb: (c: Context) => void) {
        cb({
          get: (name: string) => {
            if (name === 'agents') return agents
            if (name === 'sessionPersistence') return sessionPersistence
            if (name === 'workspaceRegistry') return registry
            return undefined
          },
        } as unknown as Context)
        return {} as never
      },
      effect(body: () => unknown) {
        body()
        return () => {}
      },
    } as unknown as Context

    expect(() => applySessionEnsure(ctx, { logger: (m) => warnings.push(m), cwd: '/cwd' })).not.toThrow()
    await new Promise((r) => setTimeout(r, 30))
    // 归属照常执行（open 缺失仅影响 notice，不影响 ensure/归属）。
    expect(attachSpy).toHaveBeenCalledWith(PINNED_SESSION_ID)
    // 未投递 notice。
    expect(followupSpy).not.toHaveBeenCalled()
    expect(warnings.some((w) => w.includes('sessionPersistence 服务不可用'))).toBe(true)
  })

  it('agents 不可达（get 返回 undefined，但 create 返回 live）→ 归属执行，notice 降级 skip 不抛', async () => {
    const followupSpy = vi.fn()
    const liveAgent = { id: PINNED_SESSION_ID, followup: followupSpy }
    // create 返回 live agent（确保 ensure 成功 → 归属仍执行），但 get 返回 undefined
    //（模拟 notice 阶段解析目标失败）。
    const agents = {
      get: vi.fn(() => undefined),
      create: vi.fn(async () => ({ agent: liveAgent, dispose: vi.fn(async () => {}) })),
      resume: vi.fn(async () => ({ agent: liveAgent, dispose: vi.fn(async () => {}) })),
    }
    const sessionPersistence = {
      stat: vi.fn(async () => undefined),
      open: vi.fn(async () => ({
        read: vi.fn(async () => ({ events: [] })),
        close: vi.fn(async () => {}),
      })),
    }
    const attachSpy = vi.fn(async () => {})
    const registry: WorkspaceRegistryLike = {
      resolveByPath: vi.fn(async () => ({ path: '/cwd', attachSession: attachSpy })),
      create: vi.fn(async () => ({ path: '/cwd', attachSession: attachSpy })),
    }
    const ctx = {
      get(name: string) {
        if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'p', model: 'm' }) }
        return undefined
      },
      inject(_deps: string[], cb: (c: Context) => void) {
        cb({
          get: (name: string) => {
            if (name === 'agents') return agents
            if (name === 'sessionPersistence') return sessionPersistence
            if (name === 'workspaceRegistry') return registry
            return undefined
          },
        } as unknown as Context)
        return {} as never
      },
      effect(body: () => unknown) {
        body()
        return () => {}
      },
    } as unknown as Context

    expect(() => applySessionEnsure(ctx, { cwd: '/cwd' })).not.toThrow()
    await new Promise((r) => setTimeout(r, 30))
    expect(attachSpy).toHaveBeenCalledWith(PINNED_SESSION_ID)
    expect(followupSpy).not.toHaveBeenCalled()
  })
})

describe('⑩ 默认 preset 挂载（Task-p100417：固定会话工具补全）', () => {
  it('create 分支：带 agentPreset → meta.agentPreset + setup(mount defaultId)；工具不缺失', async () => {
    const mountSpy = vi.fn(async () => ({ id: 'default' }))
    const agentPresets: AgentPresetsLike = { defaultId: 'default', mount: mountSpy }
    const capture: { meta?: unknown; setup?: unknown } = {}
    const agents = {
      get: vi.fn(() => undefined),
      create: vi.fn(async (opts: { meta?: unknown; setup?: unknown }) => {
        capture.meta = opts.meta
        capture.setup = opts.setup
        return { agent: { id: PINNED_SESSION_ID }, dispose: vi.fn(async () => {}) }
      }),
      resume: vi.fn(),
    } as unknown as SessionEnsureDeps['agents']

    const { outcome } = await ensurePinnedSession(
      makeDeps({ agents, agentPresets, sessionPersistence: { stat: vi.fn(async () => undefined) } }),
    )

    expect(outcome.kind).toBe('created')
    expect(capture.meta).toEqual({ cwd: '/home/user/project', agentPreset: 'default' })
    expect(capture.setup).toBeTypeOf('function')

    // setup 内部 mount 默认 preset（补全 base 工具）。
    const fakeAgentCtx = {} as Context
    await (capture.setup as (c: Context) => Promise<void>)(fakeAgentCtx)
    expect(mountSpy).toHaveBeenCalledTimes(1)
    expect(mountSpy).toHaveBeenCalledWith(fakeAgentCtx, 'default')
  })

  it('resume 分支：带 agentPreset → setup(mount)，重启后工具仍齐全', async () => {
    const mountSpy = vi.fn(async () => ({ id: 'default' }))
    const agentPresets: AgentPresetsLike = { defaultId: 'default', mount: mountSpy }
    const capture: { setup?: unknown } = {}
    const agents = {
      get: vi.fn(() => undefined),
      create: vi.fn(),
      resume: vi.fn(async (opts: { setup?: unknown }) => {
        capture.setup = opts.setup
        return { agent: { id: PINNED_SESSION_ID }, dispose: vi.fn(async () => {}) }
      }),
    } as unknown as SessionEnsureDeps['agents']

    const { outcome } = await ensurePinnedSession(
      makeDeps({ agents, agentPresets, sessionPersistence: { stat: vi.fn(async () => ({ header: {} })) } }),
    )

    expect(outcome.kind).toBe('resumed')
    expect(capture.setup).toBeTypeOf('function')
    const fakeAgentCtx = {} as Context
    await (capture.setup as (c: Context) => Promise<void>)(fakeAgentCtx)
    expect(mountSpy).toHaveBeenCalledWith(fakeAgentCtx, 'default')
  })

  it('agentPresets 缺失 → 不设 meta.agentPreset、不挂 setup（降级，不影响 create）', async () => {
    const createSpy = vi.fn(async () => ({ agent: { id: PINNED_SESSION_ID }, dispose: vi.fn(async () => {}) }))
    const agents = {
      get: vi.fn(() => undefined),
      create: createSpy,
      resume: vi.fn(),
    } as unknown as SessionEnsureDeps['agents']

    const { outcome } = await ensurePinnedSession(
      makeDeps({ agents, agentPresets: undefined, sessionPersistence: { stat: vi.fn(async () => undefined) } }),
    )

    expect(outcome.kind).toBe('created')
    const opts = createSpy.mock.calls[0][0] as { meta?: unknown; setup?: unknown }
    expect(opts.meta).toEqual({ cwd: '/home/user/project' })
    expect(opts.setup).toBeUndefined()
  })

  it('mount 抛错 → 记日志降级，不向上抛（会话仍正常 created）', async () => {
    const warnings: string[] = []
    const mountSpy = vi.fn(async () => { throw new Error('mount boom') })
    const agentPresets: AgentPresetsLike = { defaultId: 'default', mount: mountSpy }
    const capture: { setup?: unknown } = {}
    const agents = {
      get: vi.fn(() => undefined),
      create: vi.fn(async (opts: { setup?: unknown }) => {
        capture.setup = opts.setup
        return { agent: { id: PINNED_SESSION_ID }, dispose: vi.fn(async () => {}) }
      }),
      resume: vi.fn(),
    } as unknown as SessionEnsureDeps['agents']

    const { outcome } = await ensurePinnedSession(
      makeDeps({ agents, agentPresets, sessionPersistence: { stat: vi.fn(async () => undefined) }, logger: (m) => warnings.push(m) }),
    )
    expect(outcome.kind).toBe('created')
    await (capture.setup as (c: Context) => Promise<void>)({} as Context)
    expect(warnings.some((w) => w.includes('默认 preset 挂载失败'))).toBe(true)
  })

  it('applySessionEnsure 软取 agentPresets（不加入顶层 inject）并传入 ensure', async () => {
    const mountSpy = vi.fn(async () => ({ id: 'default' }))
    const agentPresets: AgentPresetsLike = { defaultId: 'default', mount: mountSpy }
    const capture: { meta?: unknown; setup?: unknown } = {}
    const agents = {
      get: vi.fn(() => undefined),
      create: vi.fn(async (opts: { meta?: unknown; setup?: unknown }) => {
        capture.meta = opts.meta
        capture.setup = opts.setup
        return { agent: { id: PINNED_SESSION_ID }, dispose: vi.fn(async () => {}) }
      }),
      resume: vi.fn(),
    }
    const stat = vi.fn(async () => undefined)
    const ctx = {
      get(name: string) {
        if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'p', model: 'm' }) }
        if (name === 'agentPresets') return agentPresets
        return undefined
      },
      inject(_deps: string[], cb: (c: Context) => void) {
        cb({
          get: (name: string) => {
            if (name === 'agents') return agents
            if (name === 'sessionPersistence') return { stat }
            return undefined
          },
        } as unknown as Context)
        return {} as never
      },
      effect(body: () => unknown) {
        body()
        return () => {}
      },
    } as unknown as Context

    applySessionEnsure(ctx, { cwd: '/cwd' })
    await new Promise((r) => setTimeout(r, 20))

    expect(capture.meta).toEqual({ cwd: '/cwd', agentPreset: 'default' })
    expect(capture.setup).toBeTypeOf('function')
  })
})
