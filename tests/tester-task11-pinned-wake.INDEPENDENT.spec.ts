/**
 * Task-11（t100361）独立复验 —— 定点唤醒投递 + 调度「仅装配一次」。
 *
 * ⚠️ 本文件由 Tester 独立构造，**不复用** developer 的
 * `tests/runner-pinned-delivery.test.ts`，亦不复用其断言方式。
 * 关键差异（相对 developer 自测）：
 *   1. 增加「动态解析已移除」的**回归守卫**：registry 仍带 `list / roots /
 *      currentInitiator` 且都返回**其它** agent 时，waker 仍只投递固定会话，
 *      零误投 —— 证明旧 `resolveWakeTargets`（currentInitiator → roots → list）
 *      的优先级解析已彻底移除。
 *   2. 投递 payload 做**全字段**结构校验（plugin='dsh-finance' / form='notice' /
 *      summary 长度上限 / id 非空 / 单一 text 块），而非仅抽查 role + kind。
 *   3. 三条路径（pulse/review/prep）用**真实 createAgentWaker**（非 spy waker 返回
 *      固定 1）串真实 createSensorRunner，断言固定会话 agent 实际收到 3 次 followup
 *      且 reason 序列正确。
 *   4. 真实 cordis 下覆盖「agents 提供但缺 `get`」的降级分支（developer 未覆盖）。
 *
 * 范围界定：本任务只验证「唤醒定点投递 + 调度装配幂等 + 降级固定 skip」；
 * 不把「尚未实现『固定会话就绪后再装配调度』的字面时序」判为缺陷（见 REPORT B 项）。
 */
import { describe, expect, it, vi, afterEach } from 'vitest'
import { Context } from '@deepseek-ai/cordis'

import {
  createAgentWaker,
  resolveWakeTarget,
  buildWakeMessage,
  PLUGIN_SOURCE_NAME,
  WAKE_SUMMARY_MAX_CHARS,
  type AgentLike,
  type AgentRegistryLike,
} from '../src/runner/wake.js'
import { createSensorRunner, parseSensorResult } from '../src/runner/sensor-runner.js'
import { PINNED_SESSION_ID } from '../src/session.js'
import { apply, inject, name as pluginName } from '../src/plugin.js'
import type { PtcRuntimeLike, SensorWakePayload } from '../src/runner/types.js'

// ---------------------------------------------------------------------------
// 工具：最小 agent / registry 替身
// ---------------------------------------------------------------------------

function makeAgent(id: string): AgentLike & { followup: ReturnType<typeof vi.fn> } {
  return { id, followup: vi.fn() }
}

/** 仅 `get(id)` 的定点 registry（多会话）。 */
function makeRegistry(agents: AgentLike[]): AgentRegistryLike {
  const byId = new Map(agents.map((a) => [a.id, a]))
  return { get: (id: string) => byId.get(id) }
}

const PAYLOAD: SensorWakePayload = { reason: 'pulse', symbol: '588000', summary: '触发标的 588000' }

afterEach(() => {
  vi.restoreAllMocks()
})

// ---------------------------------------------------------------------------
// ① 定点解析 resolveWakeTarget（单元）
// ---------------------------------------------------------------------------
describe('Task-11 独立复验 ① 定点解析 resolveWakeTarget', () => {
  it('命中固定会话返回该 agent；未命中返回 undefined', () => {
    const pinned = makeAgent(PINNED_SESSION_ID)
    const other = makeAgent('other')
    expect(resolveWakeTarget(makeRegistry([pinned, other]), PINNED_SESSION_ID)).toBe(pinned)
    expect(resolveWakeTarget(makeRegistry([other]), PINNED_SESSION_ID)).toBeUndefined()
  })

  it('命中但无 followup（缺可调用面）→ 视为不可投递，返回 undefined', () => {
    const bare = { id: PINNED_SESSION_ID } as unknown as AgentLike
    expect(resolveWakeTarget(makeRegistry([bare]), PINNED_SESSION_ID)).toBeUndefined()
  })

  it('registry.get 抛错 → 不抛异常，返回 undefined', () => {
    const throwing = { get: () => { throw new Error('registry down') } }
    expect(() => resolveWakeTarget(throwing, PINNED_SESSION_ID)).not.toThrow()
    expect(resolveWakeTarget(throwing, PINNED_SESSION_ID)).toBeUndefined()
  })

  it('非固定会话 id（自定 pinnedId）也按入参定点', () => {
    const a = makeAgent('x')
    const b = makeAgent('y')
    expect(resolveWakeTarget(makeRegistry([a, b]), 'y')?.id).toBe('y')
    expect(resolveWakeTarget(makeRegistry([a, b]), 'z')).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// ② 定点投递 createAgentWaker（AC1/AC2/AC3 + 动态解析已移除回归）
// ---------------------------------------------------------------------------
describe('Task-11 独立复验 ② 定点投递 createAgentWaker', () => {
  it('命中：仅固定会话收到 followup，投递数返回 1', () => {
    const pinned = makeAgent(PINNED_SESSION_ID)
    const waker = createAgentWaker(makeRegistry([pinned]), PINNED_SESSION_ID, () => {})
    expect(waker(PAYLOAD)).toBe(1)
    expect(pinned.followup).toHaveBeenCalledTimes(1)
  })

  it('投递 payload 全字段结构：kind=dsh-finance（非 plugin）+ notice 形态 + 摘要上限 + 单一 text 块 + 非空 id', () => {
    const pinned = makeAgent(PINNED_SESSION_ID)
    const waker = createAgentWaker(makeRegistry([pinned]), PINNED_SESSION_ID, () => {})
    waker(PAYLOAD)

    const msg = pinned.followup.mock.calls[0]![0] as {
      id: string
      role: string
      source: { kind: string; form: string; summary: string }
      content: Array<{ type: string; text: string }>
    }
    expect(msg.role).toBe('user')
    expect(typeof msg.id).toBe('string')
    expect(msg.id.length).toBeGreaterThan(0)
    expect(msg.source.kind).toBe(PLUGIN_SOURCE_NAME)
    expect(msg.source.kind).toBe('dsh-finance')
    expect(msg.source.kind).not.toBe('plugin')
    expect(msg.source.kind.length).toBeGreaterThan(0)
    expect(msg.source.form).toBe('notice')
    expect(msg.source.summary).toBe(PAYLOAD.summary)
    expect(msg.source.summary.length).toBeLessThanOrEqual(WAKE_SUMMARY_MAX_CHARS)
    expect(msg.content).toHaveLength(1)
    expect(msg.content[0]!.type).toBe('text')
    expect(msg.content[0]!.text).toContain('588000')
  })

  it('摘要超长时被截断到上限（boundSummary 生效，插件/notice 形态不变）', () => {
    const pinned = makeAgent(PINNED_SESSION_ID)
    const waker = createAgentWaker(makeRegistry([pinned]), PINNED_SESSION_ID, () => {})
    const long = 'x'.repeat(300)
    waker({ ...PAYLOAD, summary: long })
    const msg = pinned.followup.mock.calls[0]![0] as { source: { summary: string; form: string } }
    expect(msg.source.summary.length).toBe(WAKE_SUMMARY_MAX_CHARS)
    expect(msg.source.summary.endsWith('…')).toBe(true)
  })

  it('【回归】registry 仍带 list/roots/currentInitiator 且返回其它 agent → 仍只投固定会话，零误投', () => {
    const pinned = makeAgent(PINNED_SESSION_ID)
    const initiator = makeAgent('initiator-session')
    const roots = [makeAgent('root-a'), makeAgent('root-b')]
    const listed = [makeAgent('list-a'), makeAgent('list-b'), makeAgent('list-c')]
    // 旧 resolveWakeTargets 会优先 currentInitiator，其次 roots，再 list —— 若仍生效，
    // 这里会命中 initiator-session 而非固定会话。
    const registry: AgentRegistryLike = {
      get: (id: string) => (id === PINNED_SESSION_ID ? pinned : undefined),
      list: () => listed,
      roots: () => roots,
      currentInitiator: () => initiator,
    }
    const waker = createAgentWaker(registry, PINNED_SESSION_ID, () => {})
    const n = waker(PAYLOAD)

    expect(n).toBe(1)
    expect(pinned.followup).toHaveBeenCalledTimes(1)
    expect(initiator.followup).not.toHaveBeenCalled()
    for (const a of roots) expect(a.followup).not.toHaveBeenCalled()
    for (const a of listed) expect(a.followup).not.toHaveBeenCalled()
  })

  it('多会话存在时不误投：其它 agent 零调用（AC2）', () => {
    const pinned = makeAgent(PINNED_SESSION_ID)
    const a = makeAgent('session-a')
    const b = makeAgent('session-b')
    const waker = createAgentWaker(makeRegistry([pinned, a, b]), PINNED_SESSION_ID, () => {})
    expect(waker(PAYLOAD)).toBe(1)
    expect(pinned.followup).toHaveBeenCalledTimes(1)
    expect(a.followup).not.toHaveBeenCalled()
    expect(b.followup).not.toHaveBeenCalled()
  })

  it('默认 pinnedId：pinnedId 传 undefined 时回落默认 PINNED_SESSION_ID', () => {
    const pinned = makeAgent(PINNED_SESSION_ID)
    const other = makeAgent('other')
    // 新签名：第 2 参是 pinnedId（logger 移到第 3 参）；显式传 undefined 触发默认值。
    const waker = createAgentWaker(makeRegistry([pinned, other]), undefined, () => {})
    expect(waker(PAYLOAD)).toBe(1)
    expect(pinned.followup).toHaveBeenCalledTimes(1)
    expect(other.followup).not.toHaveBeenCalled()
  })

  it('固定会话不可达（未命中）→ 返回 0、记日志、不抛（AC3，固定 skip）', () => {
    const logs: string[] = []
    const waker = createAgentWaker(makeRegistry([makeAgent('x')]), PINNED_SESSION_ID, (m) => logs.push(m))
    expect(() => waker(PAYLOAD)).not.toThrow()
    expect(waker(PAYLOAD)).toBe(0)
    expect(logs.join('\n')).toMatch(/固定会话不可达/)
  })

  it('registry.get 抛错 → 返回 0、记日志、不抛', () => {
    const logs: string[] = []
    const waker = createAgentWaker(
      { get: () => { throw new Error('down') } },
      PINNED_SESSION_ID,
      (m) => logs.push(m),
    )
    expect(() => waker(PAYLOAD)).not.toThrow()
    expect(waker(PAYLOAD)).toBe(0)
    expect(logs.join('\n')).toMatch(/解析唤醒目标失败|固定会话不可达/)
  })

  it('followup 抛错 → 返回 0、不抛、日志含 agent id', () => {
    const logs: string[] = []
    const bad = { id: PINNED_SESSION_ID, followup: vi.fn(() => { throw new Error('closed') }) }
    const waker = createAgentWaker(makeRegistry([bad]), PINNED_SESSION_ID, (m) => logs.push(m))
    expect(() => waker(PAYLOAD)).not.toThrow()
    expect(waker(PAYLOAD)).toBe(0)
    expect(bad.followup).toHaveBeenCalledTimes(2)
    expect(logs.join('\n')).toContain(PINNED_SESSION_ID)
  })
})

// ---------------------------------------------------------------------------
// ③ 三条路径（pulse/review/prep）同走一个真实定点 waker（AC1/AC5）
// ---------------------------------------------------------------------------
describe('Task-11 独立复验 ③ 三条路径同走一个定点 waker（真实 createAgentWaker）', () => {
  it('pulse / review / prep 均投递到固定会话，reason 序列正确，各返回 targets=1', async () => {
    const pinned = makeAgent(PINNED_SESSION_ID)
    const other = makeAgent('other')
    const waker = createAgentWaker(makeRegistry([pinned, other]), PINNED_SESSION_ID, () => {})

    const runner = createSensorRunner({
      senseRegistry: {
        current: () => ({ version: 'v001' }),
        read: () => ({ code: 'return { shouldWake: true, symbol: "588000", summary: "s" }' }),
      },
      ledger: {
        list: () => [{ symbol: '588000', type: 'etf' } as never],
        query: vi.fn(),
      },
      quotes: { realtime: vi.fn(), intraday: vi.fn(), history: vi.fn() },
      ptcRuntime: {
        resolve: (r) => ({ ...r, cwd: '/t', timeoutMs: 1000 }),
        run: async () => ({ logs: [], value: { shouldWake: true, symbol: '588000', summary: 's' } }),
      } as unknown as PtcRuntimeLike,
      dataRoot: '/t',
      logger: () => {},
      waker,
      wakeCooldownMs: 0,
    })

    const pulse = await runner.run('pulse')
    const review = await runner.runReview()
    const prep = await runner.runPrep()

    // 三者都 actually 投递（非跳过）。
    expect(pulse.kind).toBe('woke')
    expect(review.kind).toBe('woke')
    expect(prep.kind).toBe('woke')
    expect([pulse, review, prep].map((o) => (o as { targets: number }).targets)).toEqual([1, 1, 1])

    // 固定会话 agent 收到 3 次 followup，其它会话零调用。
    expect(pinned.followup).toHaveBeenCalledTimes(3)
    expect(other.followup).not.toHaveBeenCalled()

    // reason 序列：pulse → review → prep；payload 均为 plugin/notice 形态。
    const reasons = pinned.followup.mock.calls.map((c) => {
      const msg = c[0] as { content: Array<{ text: string }>; source: { form: string } }
      expect(msg.source.form).toBe('notice')
      return msg
    })
    // review / prep 的 symbol 为 '*'（固定唤醒全部标的）；pulse 为 '588000'。
    expect(reasons[0]!.content[0]!.text).toContain('588000')
    expect(reasons[1]!.content[0]!.text).toContain('盘后复盘')
    expect(reasons[2]!.content[0]!.text).toContain('盘前准备')
  })
})

// ---------------------------------------------------------------------------
// ④ 装配幂等：调度只装配一次（AC4，mock createScheduler）
// ---------------------------------------------------------------------------
const { startSpy, stopSpy } = vi.hoisted(() => ({
  startSpy: vi.fn(),
  stopSpy: vi.fn(),
}))

vi.mock('../src/runner/scheduler.js', () => ({
  createScheduler: () => ({ start: startSpy, stop: stopSpy }),
  shanghaiParts: () => ({}),
  isPulseMinute: () => false,
  isInPulseWindow: () => false,
  nextPulseInstant: () => new Date(0),
  nextDailyInstant: () => new Date(0),
  SHANGHAI_TIME_ZONE: 'Asia/Shanghai',
  PULSE_STEP_SECONDS: 30,
  PULSE_WINDOWS: [],
  REVIEW_MINUTE: 1110,
  PREP_MINUTE: 565,
}))

describe('Task-11 独立复验 ④ 调度仅装配一次（mock createScheduler）', () => {
  it('多次 effect 执行 → scheduler.start() 恰 1 次；cleanup → stop() 恰 1 次', async () => {
    startSpy.mockClear()
    stopSpy.mockClear()

    const { applyRunner } = await import('../src/runner/index.js')

    const services: Record<string, unknown> = {
      ptcRuntime: {
        resolve: (r: unknown) => r,
        run: async () => ({ logs: [], value: { shouldWake: false } }),
      },
      agents: makeRegistry([makeAgent(PINNED_SESSION_ID)]),
    }
    const effects: Array<() => void | (() => void)> = []
    const ctx = {
      get: (k: string) => services[k],
      inject: (_deps: string[], cb: (c: { get: (k: string) => unknown }) => void) => {
        cb({ get: (k: string) => services[k] })
      },
      effect: (cb: () => void | (() => void)) => {
        effects.push(cb)
      },
    } as unknown as import('@deepseek-ai/cordis').Context

    applyRunner(ctx, {
      quotes: {
        realtime: async () => ({ symbol: 'x', price: 1, status: 'trading' }),
        intraday: async () => [],
        history: async () => [],
      } as never,
      logger: () => {},
      isTradingDay: () => false,
    })

    // 模拟「多会话 / 多次触发」：反复执行装配的 effect。
    for (const effect of effects) effect()
    for (const effect of effects) effect()
    for (const effect of effects) effect()
    expect(startSpy).toHaveBeenCalledTimes(1)

    // fiber 卸载（cleanup）也应只 stop 一次。
    for (const effect of effects) {
      const cleanup = effect()
      if (typeof cleanup === 'function') cleanup()
    }
    expect(startSpy).toHaveBeenCalledTimes(1)
    expect(stopSpy).toHaveBeenCalledTimes(1)
  })

  it('agents 缺失时：scheduler 仍启动（不抛、不中断），且记录降级日志', async () => {
    startSpy.mockClear()
    stopSpy.mockClear()

    const { applyRunner } = await import('../src/runner/index.js')

    const logs: string[] = []
    const services: Record<string, unknown> = {
      ptcRuntime: {
        resolve: (r: unknown) => r,
        run: async () => ({ logs: [], value: { shouldWake: false } }),
      },
      // 不提供 agents
    }
    const effects: Array<() => void | (() => void)> = []
    const ctx = {
      get: (k: string) => services[k],
      inject: (_deps: string[], cb: (c: { get: (k: string) => unknown }) => void) => {
        cb({ get: (k: string) => services[k] })
      },
      effect: (cb: () => void | (() => void)) => {
        effects.push(cb)
      },
    } as unknown as import('@deepseek-ai/cordis').Context

    expect(() =>
      applyRunner(ctx, {
        quotes: {
          realtime: async () => ({ symbol: 'x', price: 1, status: 'trading' }),
          intraday: async () => [],
          history: async () => [],
        } as never,
        logger: (m) => logs.push(m),
        isTradingDay: () => false,
      }),
    ).not.toThrow()

    for (const effect of effects) effect()
    expect(startSpy).toHaveBeenCalledTimes(1)
    expect(logs.join('\n')).toMatch(/agents 服务不可用/)
  })
})

// ---------------------------------------------------------------------------
// ⑤ 真实 cordis：agents 就绪 / 缺失 / 缺 get 的降级路径
// ---------------------------------------------------------------------------
describe('Task-11 独立复验 ⑤ 真实 cordis 降级路径', () => {
  const cleanupFibers: Array<{ dispose: () => Promise<unknown> | unknown }> = []

  afterEach(async () => {
    for (const f of cleanupFibers.splice(0)) await f.dispose()
    vi.restoreAllMocks()
  })

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

  async function loadPluginWith(services: Record<string, unknown>): Promise<string[]> {
    const logs: string[] = []
    const logSpy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(' '))
    })
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})

    const root = new Context()
    for (const [key, value] of Object.entries(services)) root.provide(key, value)
    const fiber = root.plugin({ name: pluginName, inject, apply })
    await fiber
    await new Promise((resolve) => setTimeout(resolve, 20))
    cleanupFibers.push(fiber as unknown as { dispose: () => Promise<unknown> })
    logSpy.mockRestore()
    return logs
  }

  it('agents 提供且含 get：唤醒通道就绪（定点投递到固定会话），不抛', async () => {
    const pinned = makeAgent(PINNED_SESSION_ID)
    const logs = await loadPluginWith({
      ...coreServices(),
      agents: makeRegistry([pinned]),
    })
    expect(logs.join('\n')).toContain(`唤醒通道已就绪（定点投递：${PINNED_SESSION_ID}）`)
  })

  it('agents 提供但缺 get：降级为跳过（记录降级日志），不抛', async () => {
    // 仅 list() 无 get() —— 命中 `typeof agents.get !== 'function'` 分支。
    const logs = await loadPluginWith({
      ...coreServices(),
      agents: { list: () => [] },
    })
    expect(logs.join('\n')).toContain('agents 服务不可用，唤醒将降级为跳过')
  })

  it('agents 完全缺失：插件仍装载（不抛、不中断），无唤醒通道就绪日志', async () => {
    const logs = await loadPluginWith({ ...coreServices() })
    expect(logs.join('\n')).toContain(`插件加载：name=${pluginName}`)
    expect(logs.join('\n')).not.toContain('唤醒通道已就绪')
  })
})

// ---------------------------------------------------------------------------
// ⑥ 契约回归：顶层 inject 不变 + buildWakeMessage 结构（AC6）
// ---------------------------------------------------------------------------
describe('Task-11 独立复验 ⑥ 契约回归', () => {
  it('顶层 inject 仍为 [tools, skills, ptcRuntime, fs]（契约不变）', () => {
    expect(inject).toEqual(['tools', 'skills', 'ptcRuntime', 'fs'])
  })

  it('buildWakeMessage 结构：role=user、content 单一 text、kind=dsh-finance（非 plugin）、form=notice', () => {
    const msg = buildWakeMessage(PAYLOAD)
    expect(msg.role).toBe('user')
    expect(msg.content).toHaveLength(1)
    expect(msg.content[0]!.type).toBe('text')
    expect(msg.source.kind).toBe(PLUGIN_SOURCE_NAME)
    expect(msg.source.kind).toBe('dsh-finance')
    expect(msg.source.kind).not.toBe('plugin')
    expect(msg.source.form).toBe('notice')
    expect('plugin' in msg.source).toBe(false)
  })

  it('parseSensorResult 仍解析 shouldWake（无关回归护栏）', () => {
    expect(parseSensorResult({ shouldWake: true, symbol: '588000' })).toMatchObject({
      shouldWake: true,
      symbol: '588000',
    })
    expect(parseSensorResult({})).toBeNull()
    expect(parseSensorResult(undefined)).toBeNull()
  })
})
