/**
 * runner/sensor-runner.ts + wake.ts 单元测试（验收点 1 / 3）。
 *
 * 覆盖：
 *   - run 读 current 脚本 → 用 mock ptcRuntime 走通 shouldWake 真 / 假两条路径；
 *   - 只读沙箱策略（read-only + workspaceRoot=dataRoot）；
 *   - run 不 reject、失败以 outcome.failed 表达（error 字段）；
 *   - 唤醒降级：无通道 / 无 agent → skipped，不抛异常；
 *   - 唤醒冷却；
 *   - 唤醒消息结构（plugin/notice/摘要）与目标解析（initiator > roots > list）。
 */
import { describe, it, expect, vi } from 'vitest'
import { createSensorRunner, parseSensorResult } from '../src/runner/sensor-runner.js'
import { createAgentWaker, buildWakeMessage, resolveWakeTargets, PLUGIN_SOURCE_NAME } from '../src/runner/wake.js'
import type {
  PtcRunRequest,
  PtcRunResult,
  PtcRunSpec,
  PtcRuntimeLike,
  SensorWakePayload,
} from '../src/runner/types.js'

const LEDGER_SYMBOLS = [
  { symbol: '588000', type: 'etf', name: '科创50ETF', qty: 1000, avgCost: 1.5 },
  { symbol: '000001', type: 'stock', qty: 200, avgCost: 10.25 },
]

const SCRIPT_CODE = 'return { shouldWake: true, symbol: "588000", summary: "偏离均线 3.2%", metrics: { ma: 1.6 } }'

function makeRegistry(code = SCRIPT_CODE, version = 'v002') {
  return {
    current: vi.fn(() => ({ version, changeType: 'patch' as const, ts: '2026-09-29T00:00:00.000Z' })),
    read: vi.fn((v: string) => ({
      meta: { version: v, changeType: 'patch' as const, ts: '2026-09-29T00:00:00.000Z' },
      rationale: 'r',
      code,
    })),
  }
}

function makeLedger() {
  return {
    list: vi.fn(() => LEDGER_SYMBOLS),
    query: vi.fn((symbol: string) => ({
      symbol,
      type: 'etf',
      name: '科创50ETF',
      qty: 1000,
      avgCost: 1.5,
      cash: 100,
      realizedPnl: 0,
      floatPnl: 12.5,
    })),
  }
}

function makeQuotes() {
  return {
    realtime: vi.fn(async (symbol: string) => ({ symbol, price: 1.66, status: 'trading' })),
    intraday: vi.fn(async (symbol: string) => [{ symbol, price: 1.6 }]),
    history: vi.fn(async (symbol: string) => [{ symbol, price: 1.5 }]),
  }
}

/** 记录 resolve/run 入参的 mock 运行时。 */
function makeRuntime(
  outcome: PtcRunResult | ((spec: PtcRunSpec) => PtcRunResult),
): { runtime: PtcRuntimeLike; specs: PtcRunSpec[]; requests: PtcRunRequest[] } {
  const specs: PtcRunSpec[] = []
  const requests: PtcRunRequest[] = []
  const runtime: PtcRuntimeLike = {
    resolve(request: PtcRunRequest): PtcRunSpec {
      requests.push(request)
      return { ...request, cwd: request.cwd ?? '/tmp/x', timeoutMs: request.timeoutMs ?? 1000 }
    },
    async run(spec: PtcRunSpec): Promise<PtcRunResult> {
      specs.push(spec)
      return typeof outcome === 'function' ? outcome(spec) : outcome
    },
  }
  return { runtime, specs, requests }
}

function makeRunner(over: Partial<Parameters<typeof createSensorRunner>[0]> = {}) {
  const waker = vi.fn((_p: SensorWakePayload) => 1)
  const runtimeBundle = makeRuntime({
    logs: [],
    value: { shouldWake: true, symbol: '588000', summary: '偏离均线 3.2%', metrics: { ma: 1.6 } },
  })
  const runner = createSensorRunner({
    senseRegistry: makeRegistry(),
    ledger: makeLedger(),
    quotes: makeQuotes(),
    ptcRuntime: runtimeBundle.runtime,
    dataRoot: '/data/root',
    logger: () => {},
    waker,
    wakeCooldownMs: 0,
    ...over,
  })
  return { runner, waker, runtimeBundle }
}

describe('sensor-runner.run 主路径', () => {
  it('shouldWake=true → 投递该标的市场状态并唤醒', async () => {
    const { runner, waker, runtimeBundle } = makeRunner()
    const outcome = await runner.run('pulse')
    expect(outcome.kind).toBe('woke')
    if (outcome.kind !== 'woke') throw new Error('expected woke')
    expect(outcome.symbol).toBe('588000')
    expect(outcome.targets).toBe(1)
    expect(waker).toHaveBeenCalledTimes(1)
    const payload = waker.mock.calls[0][0]
    expect(payload.symbol).toBe('588000')
    expect(payload.summary).toBe('偏离均线 3.2%')
    expect(payload.version).toBe('v002')

    // 用 current() 拿版本 + read(version).code 作 program，并带只读沙箱策略
    const request = runtimeBundle.requests[0]
    expect(request.program).toBe(SCRIPT_CODE)
    expect(request.sandboxPolicy).toEqual({ mode: 'read-only', workspaceRoot: '/data/root' })
    expect(request.cwd).toBe('/data/root')
    const namespaces = request.bindings.map((b) => b.global)
    expect(namespaces).toEqual(['symbols', 'quote', 'ledger'])
  })

  it('shouldWake=false → 静默结束（不投递）', async () => {
    const { runtime } = makeRuntime({ logs: [], value: { shouldWake: false } })
    const waker = vi.fn((_p: SensorWakePayload) => 1)
    const runner = createSensorRunner({
      senseRegistry: makeRegistry(),
      ledger: makeLedger(),
      quotes: makeQuotes(),
      ptcRuntime: runtime,
      dataRoot: '/data/root',
      logger: () => {},
      waker,
      wakeCooldownMs: 0,
    })
    const outcome = await runner.run('pulse')
    expect(outcome.kind).toBe('quiet')
    expect(waker).not.toHaveBeenCalled()
  })

  it('无 current 脚本 → skipped（不抛异常）', async () => {
    const { runner, waker } = makeRunner({
      senseRegistry: { current: () => null, read: vi.fn() },
    })
    const outcome = await runner.run('pulse')
    expect(outcome.kind).toBe('skipped')
    expect(waker).not.toHaveBeenCalled()
  })

  it('runtime 返回 error 字段 → failed（run 不 reject）', async () => {
    const { runtime } = makeRuntime({
      logs: ['boom'],
      error: { kind: 'timeout', message: 'execution deadline reached' },
    })
    const runner = createSensorRunner({
      senseRegistry: makeRegistry(),
      ledger: makeLedger(),
      quotes: makeQuotes(),
      ptcRuntime: runtime,
      dataRoot: '/data/root',
      logger: () => {},
      wakeCooldownMs: 0,
    })
    const outcome = await runner.run('pulse')
    expect(outcome.kind).toBe('failed')
    if (outcome.kind !== 'failed') throw new Error('expected failed')
    expect(outcome.failureKind).toBe('timeout')
  })

  it('脚本返回值非法 → skipped', async () => {
    const { runner } = makeRunner()
    // 直接替换运行时返回值
    const runtimeBundle = makeRuntime({ logs: [], value: { nope: 1 } })
    const runner2 = createSensorRunner({
      senseRegistry: makeRegistry(),
      ledger: makeLedger(),
      quotes: makeQuotes(),
      ptcRuntime: runtimeBundle.runtime,
      dataRoot: '/data/root',
      logger: () => {},
      wakeCooldownMs: 0,
    })
    expect((await runner2.run('pulse')).kind).toBe('skipped')
    void runner
  })
})

describe('唤醒降级与冷却', () => {
  it('未配置唤醒通道 → skipped（降级，不抛异常）', async () => {
    const { runner, waker } = makeRunner({ waker: undefined })
    const outcome = await runner.run('pulse')
    expect(outcome.kind).toBe('skipped')
    expect(waker).not.toHaveBeenCalled()
  })

  it('有通道但无活跃 agent → 返回 0 → skipped（降级）', async () => {
    const emptyRegistry = {
      list: () => [],
      get: () => undefined,
    }
    const waker = createAgentWaker(emptyRegistry, () => {})
    const { runner } = makeRunner({ waker })
    const outcome = await runner.run('pulse')
    expect(outcome.kind).toBe('skipped')
    if (outcome.kind !== 'skipped') throw new Error('expected skipped')
    expect(outcome.detail).toContain('跳过唤醒')
  })

  it('唤醒冷却：同标的冷却期内不重复唤醒', async () => {
    let clock = 1_000_000
    const waker = vi.fn((_p: SensorWakePayload) => 1)
    const { runtime } = makeRuntime({
      logs: [],
      value: { shouldWake: true, symbol: '588000', summary: 's' },
    })
    const runner = createSensorRunner({
      senseRegistry: makeRegistry(),
      ledger: makeLedger(),
      quotes: makeQuotes(),
      ptcRuntime: runtime,
      dataRoot: '/r',
      logger: () => {},
      waker,
      wakeCooldownMs: 10 * 60_000,
      now: () => clock,
    })
    expect((await runner.run('pulse')).kind).toBe('woke')
    clock += 60_000 // 1 分钟内
    expect((await runner.run('pulse')).kind).toBe('skipped')
    expect(waker).toHaveBeenCalledTimes(1)
    clock += 10 * 60_000 // 冷却结束
    expect((await runner.run('pulse')).kind).toBe('woke')
    expect(waker).toHaveBeenCalledTimes(2)
  })
})

describe('复盘 / 盘前固定唤醒', () => {
  it('runReview / runPrep 投递全部标的唤醒', async () => {
    const { runner, waker } = makeRunner()
    const review = await runner.runReview()
    expect(review.kind).toBe('woke')
    expect(waker.mock.calls[0][0].reason).toBe('review')
    expect(waker.mock.calls[0][0].symbol).toBe('*')
    expect(waker.mock.calls[0][0].metrics).toEqual({ symbols: ['588000', '000001'] })

    const prep = await runner.runPrep()
    expect(prep.kind).toBe('woke')
    expect(waker.mock.calls[1][0].reason).toBe('prep')
  })
})

describe('唤醒消息与目标解析', () => {
  it('消息结构：plugin/notice + 文本正文 + 摘要上限', () => {
    const longSummary = 'x'.repeat(200)
    const msg = buildWakeMessage({ reason: 'pulse', symbol: '588000', summary: longSummary })
    expect(msg.role).toBe('user')
    expect(msg.source.kind).toBe('plugin')
    expect(msg.source.plugin).toBe(PLUGIN_SOURCE_NAME)
    expect(msg.source.form).toBe('notice')
    expect(msg.source.summary.length).toBeLessThanOrEqual(120)
    expect(msg.content[0].type).toBe('text')
    expect(msg.content[0].text).toContain('588000')
    expect(typeof msg.id).toBe('string')
    expect(msg.id.length).toBeGreaterThan(0)
  })

  it('目标解析：initiator 优先，其次 roots，再 list', () => {
    const a = { id: 'a', followup: vi.fn(), inject: vi.fn() }
    const b = { id: 'b', followup: vi.fn(), inject: vi.fn() }
    const c = { id: 'c', followup: vi.fn(), inject: vi.fn() }
    const withInitiator = {
      list: () => [a, b],
      get: () => undefined,
      roots: () => [b],
      currentInitiator: () => a,
    }
    expect(resolveWakeTargets(withInitiator).map((x) => x.id)).toEqual(['a'])

    const withRoots = { list: () => [a, b], get: () => undefined, roots: () => [b] }
    expect(resolveWakeTargets(withRoots).map((x) => x.id)).toEqual(['b'])

    const listOnly = { list: () => [a, b, c], get: () => undefined }
    expect(resolveWakeTargets(listOnly).map((x) => x.id)).toEqual(['a', 'b', 'c'])
  })

  it('waker 对个别 agent 抛错容错，返回成功数', () => {
    const ok = { id: 'ok', followup: vi.fn(), inject: vi.fn() }
    const bad = { id: 'bad', followup: vi.fn(() => { throw new Error('closed') }), inject: vi.fn() }
    const waker = createAgentWaker({ list: () => [ok, bad], get: () => undefined }, () => {})
    const n = waker({ reason: 'pulse', symbol: '588000', summary: 's' })
    expect(n).toBe(1)
    expect(ok.followup).toHaveBeenCalledTimes(1)
  })
})

describe('parseSensorResult', () => {
  it('接受合法形态、拒绝非法形态', () => {
    expect(parseSensorResult({ shouldWake: false })).toEqual({ shouldWake: false })
    expect(parseSensorResult({ shouldWake: true, symbol: 'x', summary: 'y' })).toMatchObject({ shouldWake: true, symbol: 'x' })
    expect(parseSensorResult({})).toBeNull()
    expect(parseSensorResult([])).toBeNull()
    expect(parseSensorResult(null)).toBeNull()
    expect(parseSensorResult(42)).toBeNull()
  })
})
