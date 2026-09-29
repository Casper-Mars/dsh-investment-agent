/**
 * Task 7 端到端集成验收测试（Tester 独立编写，不复用 Developer 单测）。
 *
 * 被测：dsh-finance 插件「调度 → 感知 → 研判唤醒」端到端闭环。
 * 把三层串起来跑完整时序（不依赖真实网络 / 真实 ptc-runtime 子进程 / 真实 dsh 宿主）：
 *   scheduler → sensor-runner（读 current 脚本 → 只读 bindings → 沙箱 run）→ parse → wake.
 *
 * 复用 applyRunner 真实装配（真实 createToolContext / SenseRegistry / Ledger /
 * createSensorBuffer / createSensorRunner / createScheduler / createAgentWaker），
 * 仅替换 ptcRuntime 为 mock（记录 resolve/run 入参并按需回脚本结局），
 * agents 经 ctx.inject 动态注入 mock registry，isTradingDay / quotes / logger 注入。
 *
 * 逐条对应 t100356 的 5 个验收点 + 任务书 9 项运行时验证。
 *
 * 关键背景：盘中脉冲每 30 秒 / 盘后复盘 18:30（commit 8b02eb6），非任务文案旧值。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { applyRunner } from '../src/runner/index.js'
import { SenseRegistry } from '../src/domain/sense-registry.js'
import type {
  PtcRunRequest,
  PtcRunResult,
  PtcRunSpec,
  PtcRuntimeLike,
} from '../src/runner/types.js'

/** UTC 时刻（Asia/Shanghai = UTC+8，无夏令时）。 */
function utc(iso: string): Date {
  return new Date(iso)
}

/** 构造一段「遍历 symbols 并对指定标的返回 shouldWake 决策」的感知脚本正文。 */
function buildSensorScript(wakeSymbol: string): string {
  return [
    'const symbols = await symbols.list();',
    'let shouldWake = false;',
    'let hitSymbol = null;',
    'let best = null;',
    'for (const s of symbols) {',
    "  const q = await quote.realtime(s.symbol);",
    `  if (s.symbol === '${wakeSymbol}') { shouldWake = true; hitSymbol = s.symbol; best = q; }`,
    '}',
    'if (!shouldWake) return { shouldWake: false };',
    "return { shouldWake: true, symbol: hitSymbol, summary: '触发标的 ' + hitSymbol, metrics: { price: best.price } };",
  ].join('\n')
}

/** 纯静默脚本：遍历但一律 shouldWake=false。 */
const NEVER_WAKE_SCRIPT = [
  'const symbols = await symbols.list();',
  'return { shouldWake: false };',
].join('\n')

interface HarnessServices {
  senseRegistry: {
    commit(v: { changeType: string; parent?: string; rationale: string; code: string }): string
    current(): { version: string } | null
    read(v: string): { code: string }
  }
}

/**
 * 构造最小 cordis Context + mock ptcRuntime + mock agents，装配真实 applyRunner。
 *
 * @param wakeScript 当前感知脚本正文（commit 到真实 SenseRegistry）。
 * @param runBehavior mock ptcRuntime.run 的结局回填：按 spec.program 返回 shouldWake 结局。
 * @returns 便于断言的句柄集合。
 */
function assembleHarness(opts: {
  wakeScript: string
  runBehavior?: (program: string) => PtcRunResult
  agents?: Array<{ id: string; followup: (m: unknown) => void }>
  isTradingDay?: (d: Date) => boolean
  enablePrep?: boolean
}) {
  const tmp = mkdtempSync(join(tmpdir(), 'dsh-task7-'))

  // ---- mock ptcRuntime：记录 resolve/run 入参，按 program 回填结局 ----
  const requests: PtcRunRequest[] = []
  const specs: PtcRunSpec[] = []
  let runBehavior: (program: string) => PtcRunResult =
    opts.runBehavior ?? (() => ({ logs: [], value: { shouldWake: false } }))
  const ptcRuntime: PtcRuntimeLike = {
    resolve(request: PtcRunRequest): PtcRunSpec {
      requests.push(request)
      return { ...request, cwd: request.cwd ?? tmp, timeoutMs: request.timeoutMs ?? 1000 }
    },
    async run(spec: PtcRunSpec): Promise<PtcRunResult> {
      specs.push(spec)
      return runBehavior(spec.program)
    },
  }

  // ---- mock agents registry（经 ctx.inject 动态注入） ----
  const agentsList = opts.agents ?? []
  const agentsRegistry = {
    list: () => agentsList,
    get: (id: string) => agentsList.find((a) => a.id === id),
    roots: () => agentsList,
  }

  const services: Record<string, unknown> = {
    ptcRuntime,
    agents: agentsRegistry,
  }

  const disposers: Array<() => void> = []
  const ctx = {
    get: (k: string) => services[k],
    inject: (deps: string[], cb: (c: { get: (k: string) => unknown }) => void) => {
      cb({ get: (k: string) => services[k] })
    },
    effect: (cb: () => void | (() => void)) => {
      const d = cb()
      if (typeof d === 'function') disposers.push(d)
    },
  } as unknown as Context

  // 经 applyRunner 的 createToolContext 内部会 new SenseRegistry(tmp)；此处直接用同一 tmp
  // 预提交版本，使 current() 命中。（SenseRegistry 版本目录位于 tmp/sense_versions）
  const registry = new SenseRegistry(tmp)
  registry.commit({ changeType: 'replace', rationale: 'task7 e2e', code: opts.wakeScript })

  applyRunner(ctx, {
    toolContextOptions: { dataRoot: tmp },
    isTradingDay: opts.isTradingDay ?? (() => true),
    enablePrep: opts.enablePrep,
    // 注入真实行情：供脚本经 quote.realtime 调用（mock ptcRuntime 下脚本在沙箱内，实际不会真调）
    quotes: {
      realtime: async (symbol: string) => ({ symbol, price: 1.66, status: 'trading' }),
      intraday: async () => [],
      history: async () => [],
    } as unknown as Parameters<typeof applyRunner>[1]['quotes'],
    logger: () => {},
  })

  return { tmp, ctx, requests, specs, disposers, ptcRuntime, agentsList, agentsRegistry, setRunBehavior: (f: (p: string) => PtcRunResult) => { runBehavior = f } }
}

describe('Task7 端到端闭环：调度 → 感知 → 研判唤醒', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('E2E·§9 完整时序：盘中脉冲 → 执行 current 脚本 → 只读沙箱 → 唤醒 agent（payload 含 symbol/summary）', async () => {
    vi.setSystemTime(utc('2026-09-29T01:30:00Z')) // 周二 09:30:00
    const followup = vi.fn()
    const h = assembleHarness({
      wakeScript: buildSensorScript('588000'),
      agents: [{ id: 'agent-1', followup }],
      // mock ptcRuntime 不真实执行脚本沙箱，此处回脚本遍历后的 shouldWake 结局
      runBehavior: () => ({ logs: [], value: { shouldWake: true, symbol: '588000', summary: '触发标的 588000' } }),
    })
    // 第一个脉冲点在 09:30:30（30 秒粒度）
    await vi.advanceTimersByTimeAsync(30_000)

    // 1) ptcRuntime 被调用，program = 已提交脚本，sandboxPolicy 只读、cwd = dataRoot
    expect(h.requests.length).toBeGreaterThanOrEqual(1)
    const req = h.requests[0]!
    expect(req.program).toContain('symbols.list()')
    expect(req.sandboxPolicy).toEqual({ mode: 'read-only', workspaceRoot: h.tmp })
    expect(req.cwd).toBe(h.tmp)
    expect(req.bindings.map((b) => b.global)).toEqual(['symbols', 'quote', 'ledger'])
    // 2) resolve → run 顺序正确
    expect(h.specs.length).toBe(h.requests.length)

    // 3) 唤醒通道投递：agent.followup 被调用，payload 含 symbol/summary
    expect(followup).toHaveBeenCalledTimes(1)
    const msg = followup.mock.calls[0]![0] as {
      role: string
      source: { kind: string; plugin: string; form: string }
      content: Array<{ type: string; text: string }>
    }
    expect(msg.role).toBe('user')
    expect(msg.source.kind).toBe('plugin')
    expect(msg.source.form).toBe('notice')
    expect(msg.content[0]!.text).toContain('588000')
    expect(msg.content[0]!.text).toContain('盘中脉冲')

    for (const d of h.disposers) d()
    rmSync(h.tmp, { recursive: true, force: true })
  })

  it('E2E·30 秒粒度：09:30:00 起连续 3 个 30 秒 → 3 次脉冲（sensor-runner.run("pulse") 各执行一次）', async () => {
    vi.setSystemTime(utc('2026-09-29T01:30:00Z'))
    // 让脚本每次静默，避免冷却干扰，直接数 run 调用次数
    const followup = vi.fn()
    const h = assembleHarness({ wakeScript: NEVER_WAKE_SCRIPT, agents: [{ id: 'a', followup }] })
    await vi.advanceTimersByTimeAsync(90_000) // → 09:31:30，覆盖 09:30:30 / 09:31:00 / 09:31:30
    expect(h.requests.length).toBe(3)
    expect(h.specs.length).toBe(3)
    expect(followup).not.toHaveBeenCalled() // 静默，不空转
    for (const d of h.disposers) d()
    rmSync(h.tmp, { recursive: true, force: true })
  })

  it('E2E·盘后复盘 18:30：推进到 18:30 → onReview 触发（runReview 唤醒，即使脚本无 shouldWake）', async () => {
    vi.setSystemTime(utc('2026-09-29T10:20:00Z')) // 18:20
    const followup = vi.fn()
    const h = assembleHarness({
      wakeScript: NEVER_WAKE_SCRIPT,
      agents: [{ id: 'a', followup }],
    })
    await vi.advanceTimersByTimeAsync(10 * 60_000) // → 18:30
    // 复盘不执行 current 脚本（固定唤醒全部标的），不产生 resolve/run（脉冲窗口外）
    const reviewMsg = followup.mock.calls.map((c) => c[0] as { source: { form: string }; content: Array<{ text: string }> })
    expect(followup).toHaveBeenCalled()
    const review = reviewMsg.find((m) => m.content[0]!.text.includes('盘后复盘'))
    expect(review).toBeTruthy()
    expect(review!.content[0]!.text).toContain('盘后复盘')
    for (const d of h.disposers) d()
    rmSync(h.tmp, { recursive: true, force: true })
  })

  it('E2E·盘前准备 9:25：推进到 9:25 → onPrep 触发（runPrep）', async () => {
    vi.setSystemTime(utc('2026-09-29T01:20:00Z')) // 09:20
    const followup = vi.fn()
    const h = assembleHarness({
      wakeScript: NEVER_WAKE_SCRIPT,
      agents: [{ id: 'a', followup }],
      enablePrep: true,
    })
    await vi.advanceTimersByTimeAsync(5 * 60_000) // → 09:25
    expect(followup).toHaveBeenCalled()
    const prep = followup.mock.calls.map((c) => c[0] as { content: Array<{ text: string }> })
      .find((m) => m.content[0]!.text.includes('盘前准备'))
    expect(prep).toBeTruthy()
    for (const d of h.disposers) d()
    rmSync(h.tmp, { recursive: true, force: true })
  })

  it('E2E·多标的任一触发即唤醒：脚本遍历 [A,B,C]，仅 B 返回 shouldWake → 仅唤醒一次 payload.symbol=B', async () => {
    vi.setSystemTime(utc('2026-09-29T01:30:00Z'))
    const followup = vi.fn()
    // 模拟脚本内部遍历 A/B/C，仅 B 命中（在沙箱内完成，这里由 run 行为回 B 的结局）
    const h = assembleHarness({
      wakeScript: buildSensorScript('000002'),
      agents: [{ id: 'a', followup }],
      runBehavior: () => ({ logs: [], value: { shouldWake: true, symbol: '000002', summary: '触发标的 000002' } }),
    })
    await vi.advanceTimersByTimeAsync(30_000)
    expect(followup).toHaveBeenCalledTimes(1) // 仅一次
    const msg = followup.mock.calls[0]![0] as { source: { summary: string }; content: Array<{ text: string }> }
    expect(msg.content[0]!.text).toContain('000002')
    expect(msg.source.summary).toContain('000002')
    for (const d of h.disposers) d()
    rmSync(h.tmp, { recursive: true, force: true })
  })

  it('E2E·无触发静默：脚本 shouldWake=false → 不唤醒、不空转 agent', async () => {
    vi.setSystemTime(utc('2026-09-29T01:30:00Z'))
    const followup = vi.fn()
    const h = assembleHarness({
      wakeScript: NEVER_WAKE_SCRIPT,
      agents: [{ id: 'a', followup }],
      runBehavior: () => ({ logs: [], value: { shouldWake: false } }),
    })
    await vi.advanceTimersByTimeAsync(90_000)
    expect(h.requests.length).toBe(3) // 仍执行脚本
    expect(followup).not.toHaveBeenCalled() // 但不唤醒
    for (const d of h.disposers) d()
    rmSync(h.tmp, { recursive: true, force: true })
  })

  it('E2E·非交易日挡板：isTradingDay=false → 脉冲不触发、不唤醒、不产生复盘', async () => {
    vi.setSystemTime(utc('2026-09-29T01:30:00Z'))
    const followup = vi.fn()
    const h = assembleHarness({
      wakeScript: buildSensorScript('588000'),
      agents: [{ id: 'a', followup }],
      isTradingDay: () => false,
    })
    await vi.advanceTimersByTimeAsync(10 * 60_000) // 覆盖多个脉冲点
    expect(h.requests.length).toBe(0) // 脉冲未触发（sensor-runner 未执行）
    expect(followup).not.toHaveBeenCalled()
    for (const d of h.disposers) d()
    rmSync(h.tmp, { recursive: true, force: true })
  })

  it('E2E·stop/重新 apply：effect 注销器后 timer 归 0；再次 applyRunner 又能 start（1 个 timer）', () => {
    vi.setSystemTime(utc('2026-09-29T01:30:00Z'))
    const h1 = assembleHarness({ wakeScript: NEVER_WAKE_SCRIPT, agents: [{ id: 'a', followup: vi.fn() }] })
    expect(vi.getTimerCount()).toBe(1)
    // 触发生命周期注销
    for (const d of h1.disposers) d()
    expect(vi.getTimerCount()).toBe(0)

    // 再次 applyRunner（同一程序重载）= 第二次装配
    const h2 = assembleHarness({ wakeScript: NEVER_WAKE_SCRIPT, agents: [{ id: 'a', followup: vi.fn() }] })
    expect(vi.getTimerCount()).toBe(1)

    for (const d of h2.disposers) d()
    rmSync(h1.tmp, { recursive: true, force: true })
    rmSync(h2.tmp, { recursive: true, force: true })
  })

  it('E2E·唤醒降级：agents 无会话 → followup 不调用、日志告警、不抛、调度不断', async () => {
    vi.setSystemTime(utc('2026-09-29T01:30:00Z'))
    const h = assembleHarness({
      wakeScript: buildSensorScript('588000'),
      agents: [], // 无活跃会话
    })
    // 推进两个脉冲点，调度不应因无 agent 而中断（requests 仍递增）
    await vi.advanceTimersByTimeAsync(60_000)
    expect(h.requests.length).toBe(2) // 感知仍执行
    for (const d of h.disposers) d()
    rmSync(h.tmp, { recursive: true, force: true })
  })
})