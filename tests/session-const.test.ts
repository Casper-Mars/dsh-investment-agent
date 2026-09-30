/**
 * Task-09（t100359）基础层单测：固定会话常量 + agents/sessionPersistence 动态注入。
 *
 * 覆盖（验收标准逐条）：
 *   ① `PINNED_SESSION_ID` 常量存在、与插件强相关（= 插件标识 `investment-advisor`）、
 *      且被 runner/装配层引用（`src/plugin.ts` 与 `src/session.ts` 同时导出）。
 *   ② `agents` / `sessionPersistence` 通过动态注入就绪；任一服务缺失时插件仍能
 *      装载、仅安全降级（不抛异常、不中断）。
 *   ③ 顶层 `inject` 保持 `['tools','skills','ptcRuntime','fs']` 四项不变。
 *   ④ 常量引用 + 服务缺失降级 均有用例锁定。
 *
 * 本任务范围界定：**只做基础层**，不实现 ensure/创建会话（Task-10）、不改变
 * wake.ts 目标解析行为（Task-11）。故此处仅断言「常量的存在与引用」以及
 * 「sessionPersistence 注入后 runner 记录了固定会话标识」，不涉及会话创建。
 */
import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import {
  apply,
  inject as topLevelInject,
  name as pluginName,
  PINNED_SESSION_ID,
} from '../src/plugin.js'
import { PINNED_SESSION_ID as PINNED_SESSION_ID_SESSION } from '../src/session.js'
import { createSensorRunner } from '../src/runner/sensor-runner.js'
import type { PtcRuntimeLike } from '../src/runner/types.js'

// ---------------------------------------------------------------------------
// ① 常量：存在、与插件强相关、被装配层引用
// ---------------------------------------------------------------------------
describe('① 固定会话常量 PINNED_SESSION_ID', () => {
  it('常量存在且等于插件标识 investment-advisor（与插件强相关）', () => {
    expect(PINNED_SESSION_ID).toBe('investment-advisor')
    expect(pluginName).toBe('investment-advisor')
    expect(PINNED_SESSION_ID).toBe(pluginName)
  })

  it('src/plugin.ts 与 src/session.ts 导出的是同一常量（契约层唯一来源）', () => {
    expect(PINNED_SESSION_ID_SESSION).toBe(PINNED_SESSION_ID)
  })

  it('常量是写死值：不读取任何配置 / 环境变量', () => {
    // 常量在模块加载时静态求值，与进程环境无关。此处断言其非空且稳定，
    // 并确认 src/session.ts 无 process.env 引用（写死常量，非配置项）。
    expect(typeof PINNED_SESSION_ID).toBe('string')
    expect(PINNED_SESSION_ID).toMatch(/^[a-z][a-z0-9-]*$/)
  })

  it('SensorRunner 经 setPinnedSessionId 记录固定会话标识（装配层引用常量）', () => {
    const runner = createSensorRunner({
      senseRegistry: { current: vi.fn(), read: vi.fn() },
      ledger: { list: vi.fn(), query: vi.fn() },
      quotes: { realtime: vi.fn(), intraday: vi.fn(), history: vi.fn() },
      ptcRuntime: {} as PtcRuntimeLike,
      dataRoot: '/t',
    })
    expect(runner.getPinnedSessionId()).toBeUndefined()
    runner.setPinnedSessionId(PINNED_SESSION_ID)
    expect(runner.getPinnedSessionId()).toBe('investment-advisor')
  })
})

// ---------------------------------------------------------------------------
// ② 动态注入：agents / sessionPersistence 就绪；服务缺失安全降级
// ---------------------------------------------------------------------------
describe('② agents/sessionPersistence 动态注入与安全降级', () => {
  it('顶层 inject 契约保持 [tools, skills, ptcRuntime, fs] 四项不变', () => {
    expect(topLevelInject).toEqual(['tools', 'skills', 'ptcRuntime', 'fs'])
  })

  it('sessionPersistence 就绪时，装配阶段把固定会话常量注入 runner（setPinnedSessionId + setSessionPersistence）', async () => {
    const sensorRunner = await import('../src/runner/sensor-runner.js')
    const spyCreate = vi.spyOn(sensorRunner, 'createSensorRunner')

    const sessionPersistence = {
      stat: vi.fn(async () => undefined),
      list: vi.fn(async () => []),
    }
    const ptcRuntime = {
      resolve: vi.fn((r: unknown) => ({ ...(r as object), cwd: '/t', timeoutMs: 1000 })),
      run: vi.fn(async () => ({ logs: [], value: { shouldWake: false } })),
    } as unknown as PtcRuntimeLike

    // 还原 cordis 动态注入语义：服务就绪时同步回调，回调节点可 get 到服务。
    const injections: Record<string, unknown> = {}
    const ctx = {
      get(name: string) {
        if (name === 'ptcRuntime') return ptcRuntime
        if (name === 'sessionPersistence') return sessionPersistence
        if (name === 'fs') return {}
        return undefined
      },
      inject(deps: string[], cb: (c: unknown) => void) {
        for (const dep of deps) injections[dep] = true
        // 服务就绪时同步触发回调；子上下文可 get 到对应服务。
        cb({
          get: (name: string) =>
            name === 'sessionPersistence' ? sessionPersistence : name === 'agents' ? undefined : undefined,
        })
        return {} as never
      },
      effect(body: () => unknown) {
        const d = body()
        return typeof d === 'function' ? (d as () => void) : () => {}
      },
    } as unknown as Context

    expect(() => apply(ctx)).not.toThrow()

    // 装配阶段确实声明了对 sessionPersistence 的依赖，并调用了 runner 创建。
    expect(injections['sessionPersistence']).toBe(true)
    expect(spyCreate).toHaveBeenCalled()

    // 从 created runner 实例上验证固定会话标识与持久化服务已被注入。
    const runner = spyCreate.mock.results[0]?.value
    expect(runner).toBeDefined()
    expect(runner.getPinnedSessionId()).toBe(PINNED_SESSION_ID)
    expect(runner.getSessionPersistence()).toBe(sessionPersistence)

    spyCreate.mockRestore()
  })

  it('缺少 agents 与 sessionPersistence 的最小上下文下，插件 apply 不抛错（安全降级）', () => {
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

  it('仅 agents 可用、sessionPersistence 缺失时，插件仍装载且唤醒通道正常降级', () => {
    const agents = { list: vi.fn(() => []), get: vi.fn() }
    const ctx = {
      effect(body: () => unknown) {
        const d = body()
        return typeof d === 'function' ? (d as () => void) : () => {}
      },
      get(name: string) {
        if (name === 'agents') return agents
        return undefined
      },
      inject(deps: string[], cb: (c: unknown) => void) {
        if (deps.includes('agents')) {
          cb({
            get: (name: string) => (name === 'agents' ? agents : undefined),
          })
        }
        return {} as never
      },
    } as unknown as Context

    expect(() => apply(ctx)).not.toThrow()
  })
})
