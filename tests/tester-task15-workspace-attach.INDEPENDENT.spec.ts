/**
 * Tester 独立验收单测（t100364 / Ta*** §9.7 会话归属修复）。
 *
 * 本文件为 **Tester 独立产出**，不修改 src/ 与既有测试；只做只读验证 + 新增本文件。
 *
 * 覆盖验收标准（逐条独立验证，不与 Developer 自测复用同一 fake 结构）：
 *   AC2 归属幂等：resolveByPath 命中即复用 → workspaceRegistry.create 不重复调用；
 *        attachSession 幂等（重复 apply 不重复登记）。
 *   AC3 降级 skip：workspaceRegistry 缺失 / resolveByPath reject / attachSession 失败
 *        → 记日志、不抛、不中断装载。
 *   AC4 ensure 只执行一次：apply 流程下 agents.create 仅调用一次（D1 竞态回归）。
 *   AC5 顶层 inject 仍为 ['tools','skills','fs']；cordis.patch.yml 未改。
 *
 * 另补两个 Developer 未覆盖的盲区：
 *   - ensure 结果为 skipped（create 抛错）时 → 不触发归属（resolveByPath 不被调用）；
 *   - 归属目标 cwd 与 ensure 使用的 cwd 一致（同一份 cwd 贯穿 create/归属）。
 */
import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  applySessionEnsure,
  attachPinnedSessionToWorkspace,
  type WorkspaceRegistryLike,
  type WorkspaceLike,
} from '../src/session-ensure.js'
import { PINNED_SESSION_ID } from '../src/session.js'
import { inject as topLevelInject } from '../src/plugin.js'

/** 等微任务 + 宏任务，让 ensure / attach 的异步链完全落定。 */
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 30))

/** 构造一个可按服务名分发 get 的假 ctx，并记录 inject 依赖序列与日志。 */
function makeCtx(services: Record<string, unknown>, logs: string[] = []) {
  const injectDeps: string[][] = []
  const ctx = {
    get(name: string) {
      return services[name]
    },
    inject(deps: string[], cb: (c: Context) => void) {
      injectDeps.push([...deps])
      cb({
        get: (name: string) => services[name],
      } as unknown as Context)
      return {} as never
    },
    effect(body: () => unknown, _label?: string) {
      body()
      return () => {}
    },
  } as unknown as Context
  const log = (m: string) => logs.push(m)
  return { ctx, injectDeps, log }
}

describe('AC2 归属幂等（resolveByPath 命中即复用，不重复登记）', () => {
  it('attachPinnedSessionToWorkspace：命中 → 不调用 create，attach 仅一次且带固定会话 id', async () => {
    const attachSpy = vi.fn(async () => {})
    const createSpy = vi.fn(async (): Promise<WorkspaceLike> => ({ path: '/cwd', attachSession: attachSpy }))
    const registry: WorkspaceRegistryLike = {
      resolveByPath: vi.fn(async () => ({ path: '/cwd', attachSession: attachSpy })),
      create: createSpy,
    }

    await attachPinnedSessionToWorkspace(registry, '/cwd')

    expect(createSpy).not.toHaveBeenCalled()
    expect(attachSpy).toHaveBeenCalledTimes(1)
    expect(attachSpy).toHaveBeenCalledWith(PINNED_SESSION_ID)
  })

  it('attachPinnedSessionToWorkspace：连续两次调用（命中）→ create 始终 0 次，attach 幂等', async () => {
    const attachSpy = vi.fn(async () => {})
    const createSpy = vi.fn(async (): Promise<WorkspaceLike> => ({ path: '/cwd', attachSession: attachSpy }))
    const registry: WorkspaceRegistryLike = {
      resolveByPath: vi.fn(async () => ({ path: '/cwd', attachSession: attachSpy })),
      create: createSpy,
    }

    await attachPinnedSessionToWorkspace(registry, '/cwd')
    await attachPinnedSessionToWorkspace(registry, '/cwd')

    expect(createSpy).not.toHaveBeenCalled()
    expect(attachSpy).toHaveBeenCalledTimes(2)
    expect(attachSpy).toHaveBeenCalledWith(PINNED_SESSION_ID)
  })

  it('applySessionEnsure 完整流程：命中 → workspaceRegistry.create 不调用，attach 一次', async () => {
    const agentsCreate = vi.fn(async () => ({
      agent: { id: PINNED_SESSION_ID },
      dispose: vi.fn(async () => {}),
    }))
    const agents = {
      get: vi.fn(() => undefined),
      create: agentsCreate,
      resume: vi.fn(async () => ({ agent: { id: PINNED_SESSION_ID }, dispose: vi.fn(async () => {}) })),
    }
    const attachSpy = vi.fn(async () => {})
    const wsCreate = vi.fn(async (): Promise<WorkspaceLike> => ({ path: '/cwd', attachSession: attachSpy }))
    const registry: WorkspaceRegistryLike = {
      resolveByPath: vi.fn(async () => ({ path: '/cwd', attachSession: attachSpy })),
      create: wsCreate,
    }

    const { ctx, log } = makeCtx({
      agents,
      sessionPersistence: { stat: vi.fn(async () => undefined) },
      workspaceRegistry: registry,
      agentDefaultModel: { currentSelection: () => ({ provider: 'p', model: 'm' }) },
    })

    applySessionEnsure(ctx, { logger: log, cwd: '/cwd' })
    await flush()

    expect(agentsCreate).toHaveBeenCalledTimes(1)
    expect(wsCreate).not.toHaveBeenCalled()
    expect(attachSpy).toHaveBeenCalledTimes(1)
    expect(attachSpy).toHaveBeenCalledWith(PINNED_SESSION_ID)
  })
})

describe('AC3 降级 skip（服务缺失 / resolveByPath reject / attach 失败）', () => {
  it('workspaceRegistry 缺失 → 记日志、不抛、ensure 不受影响', async () => {
    const logs: string[] = []
    const agentsCreate = vi.fn(async () => ({
      agent: { id: PINNED_SESSION_ID },
      dispose: vi.fn(async () => {}),
    }))
    const { ctx } = makeCtx({
      agents: {
        get: vi.fn(() => undefined),
        create: agentsCreate,
        resume: vi.fn(async () => ({ agent: { id: PINNED_SESSION_ID }, dispose: vi.fn(async () => {}) })),
      },
      sessionPersistence: { stat: vi.fn(async () => undefined) },
      // workspaceRegistry 故意缺失
      agentDefaultModel: { currentSelection: () => ({ provider: 'p', model: 'm' }) },
    })

    expect(() => applySessionEnsure(ctx, { logger: (m) => logs.push(m), cwd: '/cwd' })).not.toThrow()
    await flush()

    expect(agentsCreate).toHaveBeenCalledTimes(1)
    expect(logs.some((w) => w.includes('workspaceRegistry 服务不可用'))).toBe(true)
  })

  it('resolveByPath reject → 记日志「会话归属失败」、不抛、ensure 仍成功', async () => {
    const logs: string[] = []
    const agentsCreate = vi.fn(async () => ({
      agent: { id: PINNED_SESSION_ID },
      dispose: vi.fn(async () => {}),
    }))
    const registry: WorkspaceRegistryLike = {
      resolveByPath: vi.fn(async () => { throw new Error('realpath reject: path not found') }),
      create: vi.fn(async (): Promise<WorkspaceLike> => ({ path: '/cwd', attachSession: vi.fn(async () => {}) })),
    }
    const { ctx } = makeCtx({
      agents: {
        get: vi.fn(() => undefined),
        create: agentsCreate,
        resume: vi.fn(async () => ({ agent: { id: PINNED_SESSION_ID }, dispose: vi.fn(async () => {}) })),
      },
      sessionPersistence: { stat: vi.fn(async () => undefined) },
      workspaceRegistry: registry,
      agentDefaultModel: { currentSelection: () => ({ provider: 'p', model: 'm' }) },
    })

    expect(() => applySessionEnsure(ctx, { logger: (m) => logs.push(m), cwd: '/cwd' })).not.toThrow()
    await flush()

    expect(agentsCreate).toHaveBeenCalledTimes(1)
    expect(logs.some((w) => w.includes('会话归属失败'))).toBe(true)
  })

  it('attachSession 失败 → 记日志「会话归属失败」、不抛、不中断', async () => {
    const logs: string[] = []
    const agentsCreate = vi.fn(async () => ({
      agent: { id: PINNED_SESSION_ID },
      dispose: vi.fn(async () => {}),
    }))
    const attachSpy = vi.fn(async () => { throw new Error('attach boom') })
    const registry: WorkspaceRegistryLike = {
      resolveByPath: vi.fn(async () => ({ path: '/cwd', attachSession: attachSpy })),
      create: vi.fn(async (): Promise<WorkspaceLike> => ({ path: '/cwd', attachSession: attachSpy })),
    }
    const { ctx } = makeCtx({
      agents: {
        get: vi.fn(() => undefined),
        create: agentsCreate,
        resume: vi.fn(async () => ({ agent: { id: PINNED_SESSION_ID }, dispose: vi.fn(async () => {}) })),
      },
      sessionPersistence: { stat: vi.fn(async () => undefined) },
      workspaceRegistry: registry,
      agentDefaultModel: { currentSelection: () => ({ provider: 'p', model: 'm' }) },
    })

    expect(() => applySessionEnsure(ctx, { logger: (m) => logs.push(m), cwd: '/cwd' })).not.toThrow()
    await flush()

    expect(agentsCreate).toHaveBeenCalledTimes(1)
    expect(logs.some((w) => w.includes('会话归属失败'))).toBe(true)
  })
})

describe('AC4 ensure 只执行一次（D1 回归：agents.create 仅一次）', () => {
  it('非 live、未持久化 → agents.create 仅一次，attach 仅一次，无并发重复 create', async () => {
    const agentsCreate = vi.fn(async () => ({
      agent: { id: PINNED_SESSION_ID },
      dispose: vi.fn(async () => {}),
    }))
    const agentsResume = vi.fn(async () => ({
      agent: { id: PINNED_SESSION_ID },
      dispose: vi.fn(async () => {}),
    }))
    const attachSpy = vi.fn(async () => {})
    const wsCreate = vi.fn(async (): Promise<WorkspaceLike> => ({ path: '/cwd', attachSession: attachSpy }))
    const registry: WorkspaceRegistryLike = {
      resolveByPath: vi.fn(async () => undefined),
      create: wsCreate,
    }
    const { ctx } = makeCtx({
      agents: {
        get: vi.fn(() => undefined),
        create: agentsCreate,
        resume: agentsResume,
      },
      sessionPersistence: { stat: vi.fn(async () => undefined) },
      workspaceRegistry: registry,
      agentDefaultModel: { currentSelection: () => ({ provider: 'p', model: 'm' }) },
    })

    applySessionEnsure(ctx, { cwd: '/cwd' })
    await flush()

    expect(agentsCreate).toHaveBeenCalledTimes(1)
    expect(agentsResume).not.toHaveBeenCalled()
    expect(wsCreate).toHaveBeenCalledTimes(1)
    expect(attachSpy).toHaveBeenCalledTimes(1)
    expect(attachSpy).toHaveBeenCalledWith(PINNED_SESSION_ID)
  })
})

describe('盲区补充：skipped 不触发归属 + cwd 一致性', () => {
  it('ensure 结果为 skipped（create 抛错）→ 不触发归属（resolveByPath 不被调用）', async () => {
    const logs: string[] = []
    const resolveSpy = vi.fn(async () => ({ path: '/cwd', attachSession: vi.fn(async () => {}) }))
    const registry: WorkspaceRegistryLike = {
      resolveByPath: resolveSpy,
      create: vi.fn(async (): Promise<WorkspaceLike> => ({ path: '/cwd', attachSession: vi.fn(async () => {}) })),
    }
    const { ctx } = makeCtx({
      agents: {
        get: vi.fn(() => undefined),
        create: vi.fn(async () => { throw new Error('create boom') }),
        resume: vi.fn(async () => ({ agent: { id: PINNED_SESSION_ID }, dispose: vi.fn(async () => {}) })),
      },
      sessionPersistence: { stat: vi.fn(async () => undefined) },
      workspaceRegistry: registry,
      agentDefaultModel: { currentSelection: () => ({ provider: 'p', model: 'm' }) },
    })

    expect(() => applySessionEnsure(ctx, { logger: (m) => logs.push(m), cwd: '/cwd' })).not.toThrow()
    await flush()

    expect(logs.some((w) => w.includes('会话确保异常') || w.includes('新建固定会话失败'))).toBe(true)
    expect(resolveSpy).not.toHaveBeenCalled()
  })

  it('归属目标 cwd 与 ensure 使用的 cwd 一致（同一份 cwd 贯穿 create + 归属）', async () => {
    const resolveSpy = vi.fn(async () => undefined)
    const wsCreate = vi.fn(async (p: string) => ({ path: p, attachSession: vi.fn(async () => {}) }))
    const registry: WorkspaceRegistryLike = { resolveByPath: resolveSpy, create: wsCreate }
    const createMetaCwd: string[] = []
    const { ctx } = makeCtx({
      agents: {
        get: vi.fn(() => undefined),
        create: vi.fn(async (opts: { meta?: { cwd?: string } }) => {
          createMetaCwd.push(opts.meta?.cwd ?? '')
          return { agent: { id: PINNED_SESSION_ID }, dispose: vi.fn(async () => {}) }
        }),
        resume: vi.fn(async () => ({ agent: { id: PINNED_SESSION_ID }, dispose: vi.fn(async () => {}) })),
      },
      sessionPersistence: { stat: vi.fn(async () => undefined) },
      workspaceRegistry: registry,
      agentDefaultModel: { currentSelection: () => ({ provider: 'p', model: 'm' }) },
    })

    applySessionEnsure(ctx, { cwd: '/my/project' })
    await flush()

    expect(createMetaCwd).toEqual(['/my/project'])
    expect(resolveSpy).toHaveBeenCalledWith('/my/project')
    expect(wsCreate).toHaveBeenCalledWith('/my/project')
  })
})

describe('AC5 顶层 inject 与 cordis.patch.yml 未改', () => {
  it('顶层 inject 仍为三项固定契约', () => {
    expect(topLevelInject).toEqual(['tools', 'skills', 'fs'])
  })

  it('cordis.patch.yml 的 inject 与顶层 inject 一致（三项不变）', () => {
    const patchPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'cordis.patch.yml')
    const patch = readFileSync(patchPath, 'utf-8')
    // 断言关键行存在：inject 三项
    expect(patch).toContain("inject: ['tools', 'skills', 'fs']")
    expect(patch).toContain('id: dsh-finance')
    expect(patch).toContain('name: dsh-finance')
  })
})
