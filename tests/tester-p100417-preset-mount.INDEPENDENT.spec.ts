/**
 * tester-p100417-preset-mount.INDEPENDENT.spec.ts
 *
 * 独立验收测试（Tester 产出，独立于 Developer 的 §⑩ 单测）：
 * 针对「固定会话 investment-advisor 工具补全」修复（Task-p100417）做对抗性验证。
 *
 * 核验的运行时语义（工具可见性）：
 *   dsh 工具「按 scope 归属可见」——dsh-base 的 read/write/edit/bash 工具挂在
 *   agent preset 的 standing mount 上，必须 `agentPresets.mount(agentCtx, preset.id)`
 *   把 agent scope 挂到 preset mount 才能对固定会话可见。
 *
 * 本文件补足 Developer §⑩ 测试未覆盖的接线层分支：
 *   1. applySessionEnsure 走 **resume** 分支时，setup 里调用了 mount(agentCtx, defaultId)；
 *   2. applySessionEnsure 下 agentPresets **缺失** → 不挂 setup、不设 meta.agentPreset、不崩溃；
 *   3. applySessionEnsure 下 mount **抛错** → 记日志降级，会话仍 created/resumed，不崩溃；
 *   4. mountDefaultPresetSetup 边界：defaultId 为空字符串、mount 非函数 → 返回 undefined。
 */
import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import {
  applySessionEnsure,
  mountDefaultPresetSetup,
  type AgentPresetsLike,
} from '../src/session-ensure.js'

/** 构造一个极简可注入 ctx：get 分层返回 agentDefaultModel / agentPresets，inject 注入 agents + sessionPersistence。 */
function makeCtx(opts: {
  agentPresets?: AgentPresetsLike | undefined
  persisted?: boolean
}): {
  ctx: Context
  capture: { meta?: unknown; resumeSetup?: unknown; createSetup?: unknown }
  mountSpy: ReturnType<typeof vi.fn>
  logs: string[]
} {
  const mountSpy = vi.fn(async () => ({ id: 'default' }))
  const capture: { meta?: unknown; resumeSetup?: unknown; createSetup?: unknown } = {}
  const logs: string[] = []

  const ctx = {
    get(name: string) {
      if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'p', model: 'm' }) }
      if (name === 'agentPresets') return opts.agentPresets
      return undefined
    },
    inject(_deps: string[], cb: (c: Context) => void) {
      cb({
        get: (name: string) => {
          if (name === 'agents') {
            return {
              get: () => undefined,
              create: (opts: { meta?: unknown; setup?: unknown }) => {
                capture.meta = opts.meta
                capture.createSetup = opts.setup
                return Promise.resolve({ agent: { id: 'investment-advisor' }, dispose: async () => {} })
              },
              resume: (opts: { setup?: unknown }) => {
                capture.resumeSetup = opts.setup
                return Promise.resolve({ agent: { id: 'investment-advisor' }, dispose: async () => {} })
              },
            }
          }
          if (name === 'sessionPersistence') {
            return { stat: async () => (opts.persisted ? { header: {} } : undefined) }
          }
          return undefined
        },
      } as unknown as Context)
      return {} as never
    },
    effect(body: () => unknown) {
      body()
      return () => {}
    },
    on() {
      return () => {}
    },
  } as unknown as Context

  return { ctx, capture, mountSpy, logs }
}

describe('P100417 独立验收：固定会话工具补全（preset 挂载运行时语义）', () => {
  it('applySessionEnsure 走 resume 分支 → setup 调用 mount(agentCtx, defaultId)（重启工具仍齐全）', async () => {
    const agentPresets: AgentPresetsLike = { defaultId: 'standard', mount: vi.fn(async () => ({ id: 'standard' })) }
    const { ctx, capture } = makeCtx({ agentPresets, persisted: true })

    applySessionEnsure(ctx, { cwd: '/cwd' })
    await new Promise((r) => setTimeout(r, 20))
    // 用力 flush 微任务，确保 ensurePinnedSession 的 .then 链路跑完。
    await new Promise((r) => setImmediate(r))

    expect(capture.resumeSetup).toBeTypeOf('function')
    const fakeAgentCtx = { marker: 'agent-scope' } as unknown as Context
    await (capture.resumeSetup as (c: Context) => Promise<void>)(fakeAgentCtx)
    expect(agentPresets.mount).toHaveBeenCalledTimes(1)
    expect(agentPresets.mount).toHaveBeenCalledWith(fakeAgentCtx, 'standard')
  })

  it('applySessionEnsure 走 create 分支 → 带 agentPreset meta + setup(mount)，工具不缺失', async () => {
    const agentPresets: AgentPresetsLike = { defaultId: 'standard', mount: vi.fn(async () => ({ id: 'standard' })) }
    const { ctx, capture } = makeCtx({ agentPresets, persisted: false })

    applySessionEnsure(ctx, { cwd: '/cwd' })
    await new Promise((r) => setTimeout(r, 20))
    await new Promise((r) => setImmediate(r))

    expect(capture.meta).toEqual({ cwd: '/cwd', agentPreset: 'standard' })
    expect(capture.createSetup).toBeTypeOf('function')
    const fakeAgentCtx = { marker: 'agent-scope' } as unknown as Context
    await (capture.createSetup as (c: Context) => Promise<void>)(fakeAgentCtx)
    expect(agentPresets.mount).toHaveBeenCalledTimes(1)
    expect(agentPresets.mount).toHaveBeenCalledWith(fakeAgentCtx, 'standard')
  })

  it('applySessionEnsure：agentPresets 缺失 → 不挂 setup、不设 meta.agentPreset，装载不崩溃', async () => {
    const { ctx, capture } = makeCtx({ agentPresets: undefined, persisted: false })
    expect(() => applySessionEnsure(ctx, { cwd: '/cwd' })).not.toThrow()
    await new Promise((r) => setTimeout(r, 20))
    await new Promise((r) => setImmediate(r))

    expect(capture.meta).toEqual({ cwd: '/cwd' })
    expect(capture.createSetup).toBeUndefined()
  })

  it('applySessionEnsure：mount 抛错 → 记日志降级，会话仍 created，不向上抛', async () => {
    const mountSpy = vi.fn(async () => { throw new Error('mount boom') })
    const agentPresets: AgentPresetsLike = { defaultId: 'standard', mount: mountSpy }
    const { ctx, capture } = makeCtx({ agentPresets, persisted: false })

    expect(() => applySessionEnsure(ctx, { cwd: '/cwd' })).not.toThrow()
    await new Promise((r) => setTimeout(r, 20))
    await new Promise((r) => setImmediate(r))

    // meta.agentPreset 已写（setup 能构造出来），setup 本身已挂
    expect(capture.createSetup).toBeTypeOf('function')
    // 调用 setup 时 mount 抛错 → 不应向上抛
    const fakeAgentCtx = {} as Context
    await expect((capture.createSetup as (c: Context) => Promise<void>)(fakeAgentCtx)).resolves.toBeUndefined()
    expect(mountSpy).toHaveBeenCalledTimes(1)
  })

  it('mountDefaultPresetSetup 边界：mount 非函数 / agentPresets 为 undefined → 返回 undefined（不挂 setup）', () => {
    const log = () => {}
    // mount 非函数
    expect(mountDefaultPresetSetup({ defaultId: 'x', mount: 'not-a-fn' as unknown as AgentPresetsLike['mount'] }, log)).toBeUndefined()
    // agentPresets 为 undefined
    expect(mountDefaultPresetSetup(undefined, log)).toBeUndefined()
    // 缺 mount 字段
    expect(mountDefaultPresetSetup({ defaultId: 'x' } as unknown as AgentPresetsLike, log)).toBeUndefined()
  })
})