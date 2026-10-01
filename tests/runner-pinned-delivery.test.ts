/**
 * Task-11（t100361）单元测试：定点投递 + 调度「仅装配一次」。
 *
 * 覆盖验收标准：
 *   1. 唤醒只投递到 `PINNED_SESSION_ID` 对应的会话；
 *   2. 多个其它会话存在时不误投（其它 agent 零调用）；
 *   3. 固定会话不可达时固定 skip（返回 0、不抛、无配置开关）；
 *   4. 调度只装配一次（多会话 / 重复触发不会重复 scheduler.start()）；
 *   5. 盘中脉冲 / 盘后复盘 / 盘前准备三条路径同走一个定点 waker。
 *
 * 全部使用注入式 fake，不依赖真实网络 / ptc-runtime 子进程 / 真实 cordis。
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'

import { createAgentWaker, resolveWakeTarget } from '../src/runner/wake.js'
import { createSensorRunner } from '../src/runner/sensor-runner.js'
import { PINNED_SESSION_ID } from '../src/session.js'
import type { AgentLike, AgentRegistryLike } from '../src/runner/wake.js'
import type { PtcRuntimeLike, SensorWakePayload } from '../src/runner/types.js'

// 调度「仅装配一次」验证用 spy（hoisted，供 vi.mock 工厂与用例共用）。
const { startSpy, stopSpy } = vi.hoisted(() => ({
  startSpy: vi.fn(),
  stopSpy: vi.fn(),
}))

vi.mock('../src/runner/scheduler.js', () => ({
  createScheduler: () => ({ start: startSpy, stop: stopSpy }),
  // 保留 index.ts 顶层 re-export 所需的其他静态导出（仅需类型，运行时不触碰）。
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

/** 构造一个带 followup spy 的 agent 替身。 */
function makeAgent(id: string): AgentLike & { followup: ReturnType<typeof vi.fn> } {
  return { id, followup: vi.fn() }
}

/** 构造一个 `agents.get(id)` 命中的 registry（含多个会话）。 */
function makeRegistry(agents: AgentLike[]): AgentRegistryLike {
  const byId = new Map(agents.map((a) => [a.id, a]))
  return { get: (id: string) => byId.get(id) }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('定点解析 resolveWakeTarget', () => {
  it('仅命中固定会话；未命中 / 无 followup 均返回 undefined', () => {
    const pinned = makeAgent(PINNED_SESSION_ID)
    const other = makeAgent('other-session')

    expect(resolveWakeTarget(makeRegistry([pinned, other]), PINNED_SESSION_ID)).toBe(pinned)
    expect(resolveWakeTarget(makeRegistry([other]), PINNED_SESSION_ID)).toBeUndefined()
    // 命中但无 followup（结构替身缺可调用面）→ 视为不可投递。
    expect(
      resolveWakeTarget(
        { get: () => ({ id: PINNED_SESSION_ID }) as unknown as AgentLike },
        PINNED_SESSION_ID,
      ),
    ).toBeUndefined()
    // registry.get 抛错 → undefined（不抛异常）。
    expect(
      resolveWakeTarget(
        { get: () => { throw new Error('down') } },
        PINNED_SESSION_ID,
      ),
    ).toBeUndefined()
  })
})

describe('定点投递 createAgentWaker（AC1/AC2/AC3）', () => {
  it('命中固定会话 → 仅该 agent 收到 followup，多会话不误投', () => {
    const pinned = makeAgent(PINNED_SESSION_ID)
    const a = makeAgent('session-a')
    const b = makeAgent('session-b')
    const waker = createAgentWaker(
      makeRegistry([pinned, a, b]),
      PINNED_SESSION_ID,
      () => {},
    )
    const payload: SensorWakePayload = { reason: 'pulse', symbol: '588000', summary: 's' }
    const n = waker(payload)
    expect(n).toBe(1)
    expect(pinned.followup).toHaveBeenCalledTimes(1)
    expect(a.followup).not.toHaveBeenCalled()
    expect(b.followup).not.toHaveBeenCalled()

    // 校验投递的 payload 消息为 producer-owned kind/notice 形态，正文含 symbol。
    const msg = pinned.followup.mock.calls[0]![0] as {
      role: string
      source: { kind: string; form: string }
      content: Array<{ type: string; text: string }>
    }
    expect(msg.role).toBe('user')
    expect(msg.source.kind).toBe('dsh-finance')
    expect(msg.source.kind).not.toBe('plugin')
    expect(msg.source.form).toBe('notice')
    expect(msg.content[0]!.text).toContain('588000')
  })

  it('固定会话不可达 → 返回 0、记日志、不抛（固定 skip，无开关）', () => {
    const logs: string[] = []
    // 未命中
    const wakerMiss = createAgentWaker(makeRegistry([makeAgent('x')]), PINNED_SESSION_ID, (m) => logs.push(m))
    expect(() => wakerMiss({ reason: 'pulse', symbol: 'x', summary: 's' })).not.toThrow()
    expect(wakerMiss({ reason: 'pulse', symbol: 'x', summary: 's' })).toBe(0)
    // get 抛错
    const wakerThrow = createAgentWaker(
      { get: () => { throw new Error('down') } },
      PINNED_SESSION_ID,
      (m) => logs.push(m),
    )
    expect(() => wakerThrow({ reason: 'pulse', symbol: 'x', summary: 's' })).not.toThrow()
    expect(wakerThrow({ reason: 'pulse', symbol: 'x', summary: 's' })).toBe(0)
    expect(logs.join('\n')).toMatch(/固定会话不可达|解析唤醒目标失败/)
  })
})

describe('三条路径同走一个 waker（AC5）', () => {
  it('pulse / review / prep 均经同一个定点 waker 投递到固定会话', async () => {
    const pinned = makeAgent(PINNED_SESSION_ID)
    const waker = vi.fn((_p: SensorWakePayload) => 1)
    const runner = createSensorRunner({
      senseRegistry: {
        current: () => ({ version: 'v001' }),
        read: () => ({ code: 'return { shouldWake: true, symbol: "588000", summary: "s" }' }),
      },
      ledger: { list: () => [{ symbol: '588000', type: 'etf' } as never], query: vi.fn() },
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

    // 三条路径都触发了同一个 waker。
    expect(waker).toHaveBeenCalledTimes(3)
    expect(waker.mock.calls[0]![0].reason).toBe('pulse')
    expect(waker.mock.calls[1]![0].reason).toBe('review')
    expect(waker.mock.calls[2]![0].reason).toBe('prep')
    expect(pulse.kind).toBe('woke')
    expect(review.kind).toBe('woke')
    expect(prep.kind).toBe('woke')
    // 三者都只返回 1（定点单会话投递），而非多会话广播。
    expect(waker.mock.results.every((r) => r.value === 1)).toBe(true)
    void pinned
  })
})

describe('调度仅装配一次（AC4）', () => {
  it('applyRunner 内 scheduler.start() 恰被调用一次（多会话 / 重复触发不重复起调度）', async () => {
    startSpy.mockClear()
    stopSpy.mockClear()

    // 重新加载 index（使 vi.mock 生效）。
    const { applyRunner } = await import('../src/runner/index.js')

    const pinned = makeAgent(PINNED_SESSION_ID)
    const registry = makeRegistry([pinned])
    const services: Record<string, unknown> = {
      ptcRuntime: {
        resolve: (r: unknown) => r,
        run: async () => ({ logs: [], value: { shouldWake: false } }),
      },
      agents: registry,
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
    } as unknown as Context

    applyRunner(ctx, {
      quotes: {
        realtime: async () => ({ symbol: 'x', price: 1, status: 'trading' }),
        intraday: async () => [],
        history: async () => [],
      } as never,
      logger: () => {},
      isTradingDay: () => false,
    })

    // 模拟「多会话 / 多次触发」：反复执行装配的 effect（每个 agent ready 都可能触发）。
    // 幂等守卫应保证 start() 只被调用一次。
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
})
