/**
 * tester-t100438-trace-context.INDEPENDENT.spec.ts
 * ==================================================================
 * Tester 独立复验 —— t100438「M4 trace 上下文（AsyncLocalStorage）」
 * 被测 HEAD：`8fab3b2`（已 commit）。
 *
 * 独立性声明（不复用 Developer 的 `tests/trace.test.ts`）：
 *   1) **真实宿主**：端到端一组用**真实 cordis `Context`**（`new Context()` 自带
 *      `ctx.logger` LoggerService）+ 注册**自定义 `Exporter`** 捕获结构化 `Message`，
 *      经**真实 `applyScheduler`** 装配真实 `tracedRunner` + 真实 `Scheduler` +
 *      真实 `createWaker`，仅在**外设**（loader/runner 子进程 spawner/agents）处注入替身。
 *   2) **验收标准逐条独立驱动**：同链路 traceId 一致（端到端捕获）/ 跨进程显式携带 /
 *      无第三方依赖（静态）/ 既有测试不回归（另跑全量）。
 *   3) **对抗用例**：并发交错隔离 / 嵌套隔离 / 门面三层优先级与调用级覆盖 /
 *      降级不抛（含**模拟 `node:async_hooks` 构造失败**的隔离模块图）/ 契约逐字不变。
 *
 * 约束：仅新增本测试文件；不改动 src/**、不 commit、不 push、不触碰
 *      `~/.dsh-finance`（用临时 `DSH_FINANCE_HOME`；`DSH_FINANCE_LOG_DIR` 亦隔离）。
 * ==================================================================
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PassThrough } from 'node:stream'
import { Context, type Exporter, type Message } from '@deepseek-ai/cordis'

// ---------------------------------------------------------------------------
// vi.hoisted：可变替身 + applyScheduler 内部装配捕获（供 vi.mock 工厂读取）
// ---------------------------------------------------------------------------

const H = vi.hoisted(() => ({
  /** 覆盖 loader 工厂返回值；null → 真实 createTaskLoader。 */
  loaderImpl: { value: null as unknown },
  /** 覆盖 runner 工厂返回值；null → 真实 createTaskRunner。 */
  runnerImpl: { value: null as unknown },
  /** createScheduler 入参捕获（取 tracedRunner）。 */
  cap: { options: null as { runner?: unknown } | null },
  /** 当前真实 Context（供替身 logger 复用同一 native logger）。 */
  app: { value: null as Context | null },
}))

vi.mock('../src/scheduler/loader.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/scheduler/loader.js')>()
  return {
    ...actual,
    createTaskLoader: (opts?: unknown) =>
      (H.loaderImpl.value as unknown) ?? actual.createTaskLoader(opts as never),
  }
})

vi.mock('../src/scheduler/runner.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/scheduler/runner.js')>()
  return {
    ...actual,
    createTaskRunner: (opts?: unknown) =>
      (H.runnerImpl.value as unknown) ?? actual.createTaskRunner(opts as never),
  }
})

vi.mock('../src/scheduler/scheduler.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/scheduler/scheduler.js')>()
  return {
    ...actual,
    createScheduler: (options: never) => {
      H.cap.options = options as unknown as { runner?: unknown }
      return actual.createScheduler(options)
    },
  }
})

import {
  enterWithTrace,
  getTrace,
  newTraceId,
  runWithTrace,
  withTrace,
  type TraceContext,
} from '../src/log/trace.js'
import {
  createFinanceLogger,
  type LogLevel,
  type NativeLoggerLike,
  type NativeLoggerServiceLike,
} from '../src/log/logger.js'
import {
  buildWakeText,
  createWaker,
  deriveSummary,
  DEFAULT_WAKE_COOLDOWN_MS,
} from '../src/scheduler/wake.js'
import { createNoticeMessage } from '../src/message-source.js'
import { applyScheduler } from '../src/scheduler/index.js'
import { createTaskRunner } from '../src/scheduler/runner.js'
import { getPinnedSessionId } from '../src/flags.js'
import type { AgentLike, AgentRegistryLike, Spawner, TaskProcess } from '../src/scheduler/types.js'

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const RISK_DISCLAIMER_LITERAL = '本内容不构成投资建议'

// ---------------------------------------------------------------------------
// 通用夹具：捕获式假原生 logger 服务（结构与 dev 无关，独立实现）
// ---------------------------------------------------------------------------

interface NativeCall {
  level: LogLevel
  args: unknown[]
}

function makeCaptureNative(): { service: NativeLoggerServiceLike; calls: NativeCall[] } {
  const calls: NativeCall[] = []
  const build = (): NativeLoggerLike => ({
    error: (...args: unknown[]) => calls.push({ level: 'error', args }),
    warn: (...args: unknown[]) => calls.push({ level: 'warn', args }),
    info: (...args: unknown[]) => calls.push({ level: 'info', args }),
    debug: (...args: unknown[]) => calls.push({ level: 'debug', args }),
  })
  const service = ((_name?: string): NativeLoggerLike => build()) as unknown as NativeLoggerServiceLike
  Object.assign(service, build())
  return { service, calls }
}

const metaOf = (c: NativeCall | undefined): Record<string, unknown> | undefined =>
  c?.args[1] as Record<string, unknown> | undefined

// ---------------------------------------------------------------------------
// 环境隔离（绝不触碰真实 ~/.dsh-finance）
// ---------------------------------------------------------------------------

const tmpDirs: string[] = []
let savedHome: string | undefined
let savedLogDir: string | undefined
let savedSession: string | undefined

function mkTmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix))
  tmpDirs.push(d)
  return d
}

beforeEach(() => {
  savedHome = process.env.DSH_FINANCE_HOME
  savedLogDir = process.env.DSH_FINANCE_LOG_DIR
  savedSession = process.env.DSH_FINANCE_SESSION_ID
})

afterEach(() => {
  const restore = (k: string, v: string | undefined): void => {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  restore('DSH_FINANCE_HOME', savedHome)
  restore('DSH_FINANCE_LOG_DIR', savedLogDir)
  restore('DSH_FINANCE_SESSION_ID', savedSession)
  H.loaderImpl.value = null
  H.runnerImpl.value = null
  H.cap.options = null
  H.app.value = null
  vi.useRealTimers()
  for (const d of tmpDirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  }
})

// ===========================================================================
// ① 原语（newTraceId / runWithTrace / getTrace / withTrace / enterWithTrace）
// ===========================================================================

describe('① trace 原语', () => {
  it('newTraceId 严格符合 UUID v4 且 1000 个两两不同', () => {
    const set = new Set<string>()
    for (let i = 0; i < 1000; i++) {
      const id = newTraceId()
      expect(id).toMatch(UUID_V4)
      set.add(id)
    }
    expect(set.size).toBe(1000)
  })

  it('无上下文时 getTrace → undefined（降级不抛）', () => {
    expect(getTrace()).toBeUndefined()
  })

  it('runWithTrace 内可见上下文、返回 fn 结果；退出后恢复 undefined', () => {
    const ctx: TraceContext = { traceId: 'T1', taskId: 'k1', sessionId: 's1' }
    const r = runWithTrace(ctx, () => {
      expect(getTrace()).toEqual(ctx)
      return 'ok'
    })
    expect(r).toBe('ok')
    expect(getTrace()).toBeUndefined()
  })

  it('上下文跨 `await` / `setTimeout` / `queueMicrotask` / `process.nextTick` 传播', async () => {
    const seen: Array<string | undefined> = []
    await runWithTrace({ traceId: 'PROP' }, async () => {
      await Promise.resolve()
      seen.push(getTrace()?.traceId)
      await new Promise((r) => setTimeout(r, 0))
      seen.push(getTrace()?.traceId)
      await new Promise<void>((r) => queueMicrotask(() => r()))
      seen.push(getTrace()?.traceId)
      await new Promise<void>((r) => process.nextTick(() => r()))
      seen.push(getTrace()?.traceId)
    })
    expect(seen).toEqual(['PROP', 'PROP', 'PROP', 'PROP'])
    expect(getTrace()).toBeUndefined()
  })

  it('withTrace 等价别名', () => {
    expect(withTrace({ traceId: 'W' }, () => getTrace()?.traceId)).toBe('W')
  })

  it('嵌套 run：内层覆盖外层，退出内层恢复外层，退出外层恢复 undefined', () => {
    runWithTrace({ traceId: 'OUTER' }, () => {
      expect(getTrace()?.traceId).toBe('OUTER')
      runWithTrace({ traceId: 'INNER' }, () => {
        expect(getTrace()?.traceId).toBe('INNER')
      })
      expect(getTrace()?.traceId).toBe('OUTER')
    })
    expect(getTrace()).toBeUndefined()
  })

  it('enterWithTrace 在当前执行内生效；run 退出后恢复无上下文', () => {
    runWithTrace({ traceId: 'SCOPE' }, () => {
      enterWithTrace({ traceId: 'ENTERED' })
      expect(getTrace()?.traceId).toBe('ENTERED')
    })
    expect(getTrace()).toBeUndefined()
  })

  it('runWithTrace 不吞异常（同步 throw 原样抛出，上下文退出）', () => {
    expect(() =>
      runWithTrace({ traceId: 'X' }, () => {
        throw new Error('boom-sync')
      }),
    ).toThrow('boom-sync')
    expect(getTrace()).toBeUndefined()
  })

  it('runWithTrace 不吞异常（异步 reject 原样抛出）', async () => {
    await expect(
      runWithTrace({ traceId: 'X' }, async () => {
        throw new Error('boom-async')
      }),
    ).rejects.toThrow('boom-async')
  })
})

// ===========================================================================
// ② 并发 / 嵌套隔离（AsyncLocalStorage 语义，对抗性交错）
// ===========================================================================

describe('② 并发 / 嵌套隔离（对抗性）', () => {
  it('5 条并发链交错 await 不串号（每条自证）', async () => {
    const native = makeCaptureNative()
    const logger = createFinanceLogger({ native: native.service })

    async function chain(id: string): Promise<void> {
      await runWithTrace({ traceId: id }, async () => {
        for (let i = 0; i < 5; i++) {
          await new Promise((r) => setTimeout(r, i % 3))
          logger.info(`${id}#${i}`)
          expect(getTrace()?.traceId).toBe(id)
        }
      })
    }

    await Promise.all(['A', 'B', 'C', 'D', 'E'].map((id) => chain(id)))

    const byMsg = new Map(native.calls.map((c) => [c.args[0] as string, metaOf(c)?.traceId]))
    for (const id of ['A', 'B', 'C', 'D', 'E']) {
      for (let i = 0; i < 5; i++) expect(byMsg.get(`${id}#${i}`)).toBe(id)
    }
    // 退出全部并发链后无残留上下文。
    expect(getTrace()).toBeUndefined()
  })

  it('嵌套并发：内层 lambda（含 await）不被外层污染，退出后外层恢复', async () => {
    const native = makeCaptureNative()
    const logger = createFinanceLogger({ native: native.service })

    await runWithTrace({ traceId: 'OUT' }, async () => {
      logger.info('out-1')
      await Promise.all([
        runWithTrace({ traceId: 'IN-A' }, async () => {
          await new Promise((r) => setTimeout(r, 1))
          logger.info('in-a')
          expect(getTrace()?.traceId).toBe('IN-A')
        }),
        runWithTrace({ traceId: 'IN-B' }, async () => {
          await new Promise((r) => setTimeout(r, 0))
          logger.info('in-b')
          expect(getTrace()?.traceId).toBe('IN-B')
        }),
      ])
      logger.info('out-2')
      expect(getTrace()?.traceId).toBe('OUT')
    })

    const byMsg = new Map(native.calls.map((c) => [c.args[0] as string, metaOf(c)?.traceId]))
    expect(byMsg.get('out-1')).toBe('OUT')
    expect(byMsg.get('in-a')).toBe('IN-A')
    expect(byMsg.get('in-b')).toBe('IN-B')
    expect(byMsg.get('out-2')).toBe('OUT')
  })
})

// ===========================================================================
// ③ 门面合并（无 trace 兼容 / 有 trace 附加 / 优先级 / child / 四级）
// ===========================================================================

describe('③ 日志门面合并 trace 上下文', () => {
  it('无 trace 上下文：meta 逐字等于现状（无 meta → 单参；有 meta → 原样）', () => {
    const { service, calls } = makeCaptureNative()
    const logger = createFinanceLogger({ native: service, scope: 'svc' })

    logger.info('plain')
    logger.error('with', { a: 1, traceId: undefined as unknown as string })
    logger.child('sub').warn('child-plain')

    expect(calls[0].args).toEqual(['plain'])
    // 调用级显式给的键（即便值为 undefined）原样保留，门面不注入任何 trace 字段。
    expect(calls[1].args).toEqual(['with', { a: 1, traceId: undefined }])
    expect(calls[2].args).toEqual(['child-plain'])
  })

  it('有 trace：四级 + child 均附加 traceId/taskId/sessionId', () => {
    const { service, calls } = makeCaptureNative()
    const logger = createFinanceLogger({ native: service, scope: 'svc' })

    runWithTrace({ traceId: 'TR', taskId: 'task-1', sessionId: 'sid-1' }, () => {
      logger.error('E')
      logger.warn('W')
      logger.info('I')
      logger.debug('D')
      logger.child('nested').child('deep').info('C')
    })

    expect(calls.map((c) => c.level)).toEqual(['error', 'warn', 'info', 'debug', 'info'])
    for (const c of calls) {
      expect(metaOf(c)).toEqual({ traceId: 'TR', taskId: 'task-1', sessionId: 'sid-1' })
    }
  })

  it('trace 仅含 traceId 时，不注入缺失的可选字段（无空值键）', () => {
    const { service, calls } = makeCaptureNative()
    const logger = createFinanceLogger({ native: service })
    runWithTrace({ traceId: 'ONLY' }, () => logger.info('x'))
    expect(metaOf(calls[0])).toEqual({ traceId: 'ONLY' })
    expect(Object.keys(metaOf(calls[0]) ?? {})).toEqual(['traceId'])
  })

  it('优先级：调用级显式 meta > trace 上下文 > 基础 meta（同名键后者覆盖前者）', () => {
    const { service, calls } = makeCaptureNative()
    const logger = createFinanceLogger({
      native: service,
      meta: { traceId: 'BASE', taskId: 'BASE-TASK', keep: 1 },
    })
    runWithTrace({ traceId: 'CTX', taskId: 'CTX-TASK', sessionId: 'S' }, () => {
      logger.info('inherit') // trace 覆盖 base
      logger.info('override', { traceId: 'CALL', taskId: 'CALL-TASK' }) // 调用级覆盖 trace
    })
    expect(metaOf(calls[0])).toEqual({ traceId: 'CTX', taskId: 'CTX-TASK', keep: 1, sessionId: 'S' })
    expect(metaOf(calls[1])).toEqual({
      traceId: 'CALL',
      taskId: 'CALL-TASK',
      keep: 1,
      sessionId: 'S',
    })
  })

  it('调用级新增字段与 trace / base 兼容共存', () => {
    const { service, calls } = makeCaptureNative()
    const logger = createFinanceLogger({ native: service, meta: { base: 1 } })
    runWithTrace({ traceId: 'T', sessionId: 'S' }, () => logger.info('m', { extra: 'x' }))
    expect(metaOf(calls[0])).toEqual({ base: 1, traceId: 'T', sessionId: 'S', extra: 'x' })
  })

  it('降级路径（无 native → console）同样合并 trace 且不抛', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const logger = createFinanceLogger({ scope: 'fallback' })
      runWithTrace({ traceId: 'FB', taskId: 'ft' }, () => {
        logger.info('i', { a: 1 })
        logger.warn('w')
      })
      expect(logSpy).toHaveBeenCalledWith('i', { a: 1, traceId: 'FB', taskId: 'ft' })
      expect(warnSpy).toHaveBeenCalledWith('w', { traceId: 'FB', taskId: 'ft' })
    } finally {
      logSpy.mockRestore()
      warnSpy.mockRestore()
    }
  })

  it('真实 cordis ctx.logger 出口下，exporter 收到的 Message.args[1] 含 trace', () => {
    const app = new Context()
    const messages: Message[] = []
    const exporter: Exporter = {
      levels: { default: 3 },
      export: (m: Message) => void messages.push(m),
    }
    app.logger.exporter(exporter)

    const logger = createFinanceLogger({ native: app.logger, scope: 'dsh-finance:test' })
    runWithTrace({ traceId: 'REAL', taskId: 'rt' }, () => logger.info('hello', { p: 1 }))

    expect(messages).toHaveLength(1)
    expect(messages[0].name).toBe('dsh-finance:test')
    expect(messages[0].args[1]).toEqual({ p: 1, traceId: 'REAL', taskId: 'rt' })
  })
})

// ===========================================================================
// ④ 唤醒（wake）跨进程显式携带 traceId + 契约 + 降级
// ===========================================================================

interface CapturedNotice {
  content?: readonly { type: string; text?: string }[]
  source?: { kind?: string; form?: string; summary?: string; traceId?: string }
}

function makeCaptureRegistry(sink: CapturedNotice[]): AgentRegistryLike {
  const agent: AgentLike = {
    id: 'investment-advisor',
    followup: (msg) => void sink.push(msg as unknown as CapturedNotice),
  }
  return { get: (id: string) => (id === getPinnedSessionId() || id === 'investment-advisor' ? agent : undefined) }
}

describe('④ 唤醒消息显式携带 traceId（跨进程）', () => {
  it('在 trace 上下文内 wake：消息 source.traceId == 当前 traceId', () => {
    const sink: CapturedNotice[] = []
    const waker = createWaker({ agents: makeCaptureRegistry(sink), wakeCooldownMs: 0, targetId: 'investment-advisor' })
    runWithTrace({ traceId: 'WAKE-1' }, () => {
      expect(waker.wake('t1', '市场速报').delivered).toBe(true)
    })
    expect(sink).toHaveLength(1)
    expect(sink[0].source?.traceId).toBe('WAKE-1')
    expect(JSON.stringify(sink[0].source)).toContain('WAKE-1')
  })

  it('显式传入 traceId 优先于上下文', () => {
    const sink: CapturedNotice[] = []
    const waker = createWaker({ agents: makeCaptureRegistry(sink), wakeCooldownMs: 0, targetId: 'investment-advisor' })
    runWithTrace({ traceId: 'CTX' }, () => {
      waker.wake('t2', 'x', 'EXPLICIT')
    })
    expect(sink[0].source?.traceId).toBe('EXPLICIT')
  })

  it('无上下文且未显式传入：消息不含 traceId 字段（notice 形态不变）', () => {
    const sink: CapturedNotice[] = []
    const waker = createWaker({ agents: makeCaptureRegistry(sink), wakeCooldownMs: 0, targetId: 'investment-advisor' })
    waker.wake('t3', '普通唤醒')
    expect('traceId' in (sink[0].source ?? {})).toBe(false)
  })

  it('缺省回落：显式传 undefined 但在上下文内 → 用 getTrace()', () => {
    const sink: CapturedNotice[] = []
    const waker = createWaker({ agents: makeCaptureRegistry(sink), wakeCooldownMs: 0, targetId: 'investment-advisor' })
    runWithTrace({ traceId: 'FALLBACK' }, () => {
      waker.wake('t4', 'x', undefined)
    })
    expect(sink[0].source?.traceId).toBe('FALLBACK')
  })

  it('契约不破：kind/form/summary ≤120，buildWakeText/deriveSummary 逐字不变', () => {
    const sink: CapturedNotice[] = []
    const waker = createWaker({ agents: makeCaptureRegistry(sink), wakeCooldownMs: 0, targetId: 'investment-advisor' })
    const data = 'BUY 600519 第一行\n第二行被忽略'
    waker.wake('t5', data, 'TR-K')

    const m = sink[0]
    expect(m.source?.kind).toBe('dsh-finance')
    expect(m.source?.form).toBe('notice')
    expect(m.content?.[0]?.text).toBe(`${data}\n\n> ${RISK_DISCLAIMER_LITERAL}`)
    expect(m.source?.summary).toBe('BUY 600519 第一行')
    expect((m.source?.summary ?? '').length).toBeLessThanOrEqual(120)
    // 与既有函数输出逐字一致（单一事实来源）。
    expect(buildWakeText(data)).toBe(`${data}\n\n> ${RISK_DISCLAIMER_LITERAL}`)
    expect(deriveSummary(data)).toBe('BUY 600519 第一行')
  })

  it('超长单行 data：summary 被截断到 ≤120（含 trace 时同样成立）', () => {
    const sink: CapturedNotice[] = []
    const waker = createWaker({ agents: makeCaptureRegistry(sink), wakeCooldownMs: 0, targetId: 'investment-advisor' })
    const long = 'A'.repeat(5000)
    waker.wake('t6', long, 'TR-LONG')
    expect((sink[0].source?.summary ?? '').length).toBe(120)
    expect(sink[0].source?.traceId).toBe('TR-LONG')
  })

  it('降级不抛：无上下文 wake 正常投递且无 trace 字段', () => {
    const sink: CapturedNotice[] = []
    const waker = createWaker({ agents: makeCaptureRegistry(sink), wakeCooldownMs: 0, targetId: 'investment-advisor' })
    expect(() => {
      const r = waker.wake('t7', 'x')
      expect(r.delivered).toBe(true)
    }).not.toThrow()
    expect('traceId' in (sink[0].source ?? {})).toBe(false)
  })

  it('createNoticeMessage 第 3 参缺省行为兼容；传值可检出', () => {
    const a = createNoticeMessage('body', 'sum') as unknown as CapturedNotice
    expect('traceId' in (a.source ?? {})).toBe(false)
    expect(a.source?.kind).toBe('dsh-finance')
    expect(a.source?.form).toBe('notice')
    const b = createNoticeMessage('body', 'sum', 'TR-9') as unknown as CapturedNotice
    expect(b.source?.traceId).toBe('TR-9')
  })
})

// ===========================================================================
// ⑤ 端到端（真实 Context + 真实 applyScheduler/tracedRunner/scheduler/waker）
// ===========================================================================

/** 用 PassThrough 模拟任务子进程（mock spawner 用）。 */
class FakeProcess implements TaskProcess {
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  exitCode: number | null = null
  kill(): void {}
  writeStdout(t: string): void {
    this.stdout.write(t)
  }
  end(code: number | null): void {
    this.exitCode = code
    this.stdout.end()
    this.stderr.end()
  }
}

function makeSpawner(program: (p: FakeProcess) => void): { spawner: Spawner; spawn: ReturnType<typeof vi.fn> } {
  const spawn = vi.fn((_taskPath: string) => {
    const proc = new FakeProcess()
    queueMicrotask(() => program(proc))
    return proc
  })
  return { spawner: { spawn } as unknown as Spawner, spawn }
}

interface E2EEnv {
  app: Context
  messages: Message[]
  home: string
  dataRoot: string
}

function setupE2E(): E2EEnv {
  const home = mkTmp('t100438-home-')
  process.env.DSH_FINANCE_HOME = home
  process.env.DSH_FINANCE_LOG_DIR = mkTmp('t100438-logs-')
  const dataRoot = join(home, 'data')
  mkdirSync(join(dataRoot, 'tasks'), { recursive: true })

  const app = new Context()
  const messages: Message[] = []
  app.logger.exporter({
    levels: { default: 3 },
    export: (m: Message) => void messages.push(m),
  })
  H.app.value = app
  H.loaderImpl.value = { installTaskDeps: vi.fn(async () => {}) }
  return { app, messages, home, dataRoot }
}

function writeTask(env: E2EEnv, def: Record<string, unknown>): void {
  writeFileSync(join(env.dataRoot, 'tasks', `${String(def.id)}.json`), JSON.stringify(def), 'utf8')
  const abs = resolve(env.home, String(def.task_path))
  mkdirSync(dirname(abs), { recursive: true })
  writeFileSync(abs, '// test entry\n', 'utf8')
}

/** 从捕获消息里提取「带 traceId 的日志」及其 traceId。 */
function tracedLogs(messages: Message[]): Array<{ name?: string; traceId: string; taskId?: string }> {
  const out: Array<{ name?: string; traceId: string; taskId?: string }> = []
  for (const m of messages) {
    const meta = m.args[1] as Record<string, unknown> | undefined
    const t = meta?.['traceId']
    if (typeof t === 'string') out.push({ name: m.name, traceId: t, taskId: meta?.['taskId'] as string })
  }
  return out
}

describe('⑤ 端到端：真实 Context + applyScheduler（同链路一致 / 跨 fire 不同 / 并发隔离）', () => {
  it('触发一次 → 该 fire 全部带 trace 的日志同一 traceId；waker 投递消息携带同一 traceId', async () => {
    vi.useFakeTimers()
    const env = setupE2E()
    const delivered: CapturedNotice[] = []

    // 注入 runner 替身：模拟「链路内某模块」跨 await 打多条门面日志 + 返回 woke。
    H.runnerImpl.value = {
      async run(_taskPath: string, _args?: unknown, opts?: { taskId?: string }) {
        const t = getTrace()
        const { createFinanceLogger } = await import('../src/log/logger.js')
        const lg = createFinanceLogger({ native: H.app.value?.logger, scope: 'fake-runner' })
        for (let i = 0; i < 3; i++) {
          await new Promise((r) => setTimeout(r, 0))
          lg.info(`step-${i}`)
        }
        return { kind: 'woke', reason: 'woke', data: `DATA-${opts?.taskId}-${t?.traceId}`, targets: [] }
      },
    }

    env.app.provide('agents', {
      get: () => ({ id: 'investment-advisor', followup: (m: unknown) => void delivered.push(m as CapturedNotice) }),
    })
    writeTask(env, { id: 'alpha', name: 'A', cron: '* * * * *', task_path: 'tasks/alpha/task.mjs', enabled: true })

    applyScheduler(env.app, { dataRoot: env.dataRoot, wakeCooldownMs: 0 })

    await vi.advanceTimersByTimeAsync(61_000)

    // 3 条链路内日志全部带同一 traceId。
    const logs = tracedLogs(env.messages).filter((l) => l.name === 'fake-runner')
    expect(logs).toHaveLength(3)
    const tracedIds = new Set(logs.map((l) => l.traceId))
    expect(tracedIds.size).toBe(1)
    const fireTrace = logs[0].traceId
    expect(fireTrace).toMatch(UUID_V4)
    expect(logs.every((l) => l.taskId === 'alpha')).toBe(true)

    // 跨进程：waker 实际投递的消息携带该 fire 的 traceId（与日志一致）。
    expect(delivered).toHaveLength(1)
    expect(delivered[0].source?.traceId).toBe(fireTrace)
    expect(delivered[0].source?.kind).toBe('dsh-finance')
    expect(delivered[0].source?.form).toBe('notice')
    // data 里 encode 的 traceId 也等于 fireTrace（runner 看到的上下文与日志一致）。
    expect(delivered[0].content?.[0]?.text).toContain(`DATA-alpha-${fireTrace}`)
  })

  it('两个 fire：各自 traceId 不同，且同一 fire 内一致', async () => {
    vi.useFakeTimers()
    const env = setupE2E()
    const seenTrace: string[] = []
    H.runnerImpl.value = {
      async run() {
        seenTrace.push(getTrace()?.traceId ?? '')
        const { createFinanceLogger } = await import('../src/log/logger.js')
        const lg = createFinanceLogger({ native: H.app.value?.logger, scope: 'fire-runner' })
        await new Promise((r) => setTimeout(r, 0))
        lg.info('once')
        return { kind: 'quiet', reason: 'ok' }
      },
    }
    env.app.provide('agents', { get: () => ({ id: 'investment-advisor', followup: () => {} }) })
    writeTask(env, { id: 'beta', name: 'B', cron: '* * * * *', task_path: 'tasks/beta/task.mjs', enabled: true })

    applyScheduler(env.app, { dataRoot: env.dataRoot, wakeCooldownMs: 0 })

    await vi.advanceTimersByTimeAsync(61_000) // fire #1
    await vi.advanceTimersByTimeAsync(61_000) // fire #2

    expect(seenTrace).toHaveLength(2)
    expect(seenTrace[0]).toMatch(UUID_V4)
    expect(seenTrace[1]).toMatch(UUID_V4)
    expect(seenTrace[0]).not.toBe(seenTrace[1])

    // 日志里两种 traceId 各出现一次，且都属 seenTrace。
    const logs = tracedLogs(env.messages).filter((l) => l.name === 'fire-runner')
    const ids = logs.map((l) => l.traceId)
    expect(new Set(ids).size).toBe(2)
    for (const id of ids) expect(seenTrace).toContain(id)
  })

  it('两任务同刻并发触发：各自 traceId 独立、不串号', async () => {
    vi.useFakeTimers()
    const env = setupE2E()
    const byTask = new Map<string, string>()
    H.runnerImpl.value = {
      async run(_p: string, _a?: unknown, opts?: { taskId?: string }) {
        const id = opts?.taskId ?? '?'
        const t0 = getTrace()?.traceId
        await new Promise((r) => setTimeout(r, id === 'm1' ? 5 : 0))
        const t1 = getTrace()?.traceId
        byTask.set(id, t1 ?? '')
        expect(t1).toBe(t0)
        return { kind: 'quiet', reason: 'ok' }
      },
    }
    env.app.provide('agents', { get: () => ({ id: 'investment-advisor', followup: () => {} }) })
    for (const id of ['m1', 'm2']) {
      writeTask(env, { id, name: id, cron: '* * * * *', task_path: `tasks/${id}/task.mjs`, enabled: true })
    }
    applyScheduler(env.app, { dataRoot: env.dataRoot, wakeCooldownMs: 0 })
    await vi.advanceTimersByTimeAsync(61_000)

    expect(byTask.size).toBe(2)
    expect(byTask.get('m1')).toMatch(UUID_V4)
    expect(byTask.get('m2')).toMatch(UUID_V4)
    expect(byTask.get('m1')).not.toBe(byTask.get('m2'))
  })

  it('全真实 runner（mock spawner 产出 woke）+ 真实 waker：消息携带有效 traceId 且不同 fire 不同', async () => {
    vi.useFakeTimers()
    const env = setupE2E()
    const delivered: CapturedNotice[] = []
    const sp = makeSpawner((p) => {
      p.writeStdout('log\n{"shouldWake":true,"data":"ALERT"}\n')
      p.end(0)
    })
    // 真实 runner（注入 mock spawner）：走完整 stdout 解析 / 三结局映射。
    H.runnerImpl.value = createTaskRunner({ spawner: sp.spawner })
    env.app.provide('agents', {
      get: () => ({ id: 'investment-advisor', followup: (m: unknown) => void delivered.push(m as CapturedNotice) }),
    })
    writeTask(env, { id: 'gamma', name: 'G', cron: '* * * * *', task_path: 'tasks/gamma/task.mjs', enabled: true })

    applyScheduler(env.app, { dataRoot: env.dataRoot, wakeCooldownMs: 0 })
    await vi.advanceTimersByTimeAsync(61_000)

    expect(delivered).toHaveLength(1)
    expect(delivered[0].source?.traceId).toMatch(UUID_V4)
    expect(delivered[0].content?.[0]?.text).toContain('ALERT')

    const first = delivered[0].source?.traceId
    await vi.advanceTimersByTimeAsync(61_000) // fire #2
    expect(delivered).toHaveLength(2)
    expect(delivered[1].source?.traceId).toMatch(UUID_V4)
    expect(delivered[1].source?.traceId).not.toBe(first)
  })

  it('characterization：scheduler 自身的「触发 / 消费」日志在 ALS 作用域之外（不带 traceId），链路内日志才带', async () => {
    vi.useFakeTimers()
    const env = setupE2E()
    H.runnerImpl.value = {
      async run() {
        const { createFinanceLogger } = await import('../src/log/logger.js')
        const lg = createFinanceLogger({ native: H.app.value?.logger, scope: 'inner-mod' })
        await new Promise((r) => setTimeout(r, 0))
        lg.info('inside-chain')
        return { kind: 'quiet', reason: 'ok' }
      },
    }
    env.app.provide('agents', { get: () => undefined })
    writeTask(env, { id: 'scope', name: 'S', cron: '* * * * *', task_path: 'tasks/scope/task.mjs', enabled: true })
    applyScheduler(env.app, { dataRoot: env.dataRoot, wakeCooldownMs: 0 })
    await vi.advanceTimersByTimeAsync(61_000)

    const byMsg = new Map(env.messages.map((m) => [m.args[0] as string, m.args[1] as Record<string, unknown> | undefined]))
    // 链路内（runner.run 内部）日志带 trace。
    expect(byMsg.get('inside-chain')?.['traceId']).toMatch(UUID_V4)
    // scheduler.fire 的触发日志 / 结局消费日志在 tracedRunner 之外，不带 trace（作用域边界，非缺陷）。
    const trigger = [...byMsg.keys()].find((k) => k.includes('触发'))
    expect(trigger).toBeTruthy()
    expect(byMsg.get(trigger as string)?.['traceId']).toBeUndefined()
  })

  it('tracedRunner 捕获：createScheduler 收到的 runner 进入即 newTraceId 并携带 taskId/sessionId', async () => {
    vi.useFakeTimers()
    const env = setupE2E()
    const obs: Array<TraceContext | undefined> = []
    H.runnerImpl.value = {
      async run() {
        obs.push(getTrace())
        return { kind: 'quiet', reason: 'ok' }
      },
    }
    env.app.provide('agents', { get: () => undefined })
    writeTask(env, { id: 'delta', name: 'D', cron: '* * * * *', task_path: 'tasks/delta/task.mjs', enabled: true })
    applyScheduler(env.app, { dataRoot: env.dataRoot, wakeCooldownMs: 0 })
    await vi.advanceTimersByTimeAsync(61_000)

    expect(obs).toHaveLength(1)
    expect(obs[0]?.traceId).toMatch(UUID_V4)
    expect(obs[0]?.taskId).toBe('delta')
    expect(obs[0]?.sessionId).toBe(getPinnedSessionId())
    // 真实 Scheduler 拿到的确为 tracedRunner（透传 taskId）。
    expect(H.cap.options?.runner).toBeTruthy()
  })
})

// ===========================================================================
// ⑥ 无第三方依赖（静态核验）
// ===========================================================================

describe('⑥ 无第三方依赖（node:async_hooks / node:crypto）', () => {
  it('trace.ts 仅 import node:* 内建模块', () => {
    const src = readFileSync(join(PROJECT_ROOT, 'src/log/trace.ts'), 'utf8')
    const specifiers = [...src.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1])
    expect(specifiers.length).toBeGreaterThan(0)
    for (const s of specifiers) expect(s.startsWith('node:')).toBe(true)
    expect(specifiers).toContain('node:async_hooks')
    expect(specifiers).toContain('node:crypto')
    expect(src).toMatch(/AsyncLocalStorage/)
  })

  it('package.json 未引入任何第三方日志/上下文依赖（无 dependencies 新增 pino/winston/cls-hooked）', () => {
    const pkg = JSON.parse(readFileSync(join(PROJECT_ROOT, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>
      devDependencies?: Record<string, string>
    }
    const banned = ['pino', 'winston', 'cls-hooked', 'async-local-storage']
    for (const b of banned) {
      expect(pkg.dependencies?.[b]).toBeUndefined()
      expect(pkg.devDependencies?.[b]).toBeUndefined()
    }
    // 门面/runner 亦不应 import 第三方日志库。
    for (const f of ['src/log/logger.ts', 'src/scheduler/wake.ts', 'src/message-source.ts']) {
      const src = readFileSync(join(PROJECT_ROOT, f), 'utf8')
      expect(src).not.toMatch(/from\s+['"](pino|winston|cls-hooked)['"]/)
    }
  })
})

// ===========================================================================
// ⑦ 降级：模拟 node:async_hooks 构造失败（隔离模块图，绝不抛）
// ===========================================================================

describe('⑦ 降级：AsyncLocalStorage 不可用时不抛', () => {
  it('node:async_hooks 构造抛错 → runWithTrace 直接执行 / getTrace undefined / enterWithTrace no-op', async () => {
    vi.resetModules()
    vi.doMock('node:async_hooks', () => ({
      AsyncLocalStorage: class {
        constructor() {
          throw new Error('ALS unavailable')
        }
      },
    }))
    try {
      const t = (await import('../src/log/trace.js')) as typeof import('../src/log/trace.js')
      expect(t.getTrace()).toBeUndefined()
      let ran = false
      const out = t.runWithTrace({ traceId: 'X' }, () => {
        ran = true
        return 7
      })
      expect(out).toBe(7)
      expect(ran).toBe(true)
      expect(t.getTrace()).toBeUndefined()
      expect(() => t.enterWithTrace({ traceId: 'Y' })).not.toThrow()
    } finally {
      vi.doUnmock('node:async_hooks')
      vi.resetModules()
    }
  })

  it('真实模块下 DEFAULT_WAKE_COOLDOWN_MS 常量未被改动（5min）', () => {
    expect(DEFAULT_WAKE_COOLDOWN_MS).toBe(5 * 60 * 1000)
  })
})
