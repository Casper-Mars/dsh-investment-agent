/**
 * trace 上下文（`src/log/trace.ts` + 门面合并 + 唤醒显式携带）单元测试（里程碑 M4）。
 *
 * 覆盖（对齐任务卡 §验收标准 1~3）：
 *   1. 同一 trace 内多次日志 `traceId` 一致（可串联）；
 *   2. **并发 / 嵌套 trace 隔离**（AsyncLocalStorage 语义：两个并发 run 不串 traceId）；
 *   3. 无 trace 上下文时日志**不含** trace 字段（现状兼容，降级不抛）；
 *   4. 调用级显式 meta 覆盖 trace 字段；基础 meta < trace 上下文优先级；
 *   5. 跨进程唤醒消息**确实携带** traceId（消息 source 中可检出）；
 *   6. 降级不抛（无上下文 / 无 als 时 getTrace → undefined，绝不抛）。
 *
 * 全部使用注入的 mock（假原生 logger / mock agents 注册表），不依赖真实 harness。
 */
import { describe, expect, it } from 'vitest'

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
import { createWaker, deriveSummary, buildWakeText, WAKE_TARGET_ID } from '../src/scheduler/wake.js'
import { createNoticeMessage } from '../src/message-source.js'
import type { AgentLike, AgentRegistryLike } from '../src/scheduler/types.js'

// ---------------------------------------------------------------------------
// 测试替身：捕获调用的假原生 logger 服务
// ---------------------------------------------------------------------------

interface CapturedCall {
  level: LogLevel
  args: unknown[]
}

function makeFakeNative(): { service: NativeLoggerServiceLike; calls: CapturedCall[] } {
  const calls: CapturedCall[] = []
  const makeLogger = (): NativeLoggerLike => ({
    error: (...args: unknown[]) => calls.push({ level: 'error', args }),
    warn: (...args: unknown[]) => calls.push({ level: 'warn', args }),
    info: (...args: unknown[]) => calls.push({ level: 'info', args }),
    debug: (...args: unknown[]) => calls.push({ level: 'debug', args }),
  })
  const service = ((_name?: string): NativeLoggerLike => makeLogger()) as unknown as NativeLoggerServiceLike
  Object.assign(service, makeLogger())
  return { service, calls }
}

/** 取某次调用的 meta（第二参；无则 undefined）。 */
function metaOf(call: CapturedCall | undefined): Record<string, unknown> | undefined {
  return call?.args[1] as Record<string, unknown> | undefined
}

// ---------------------------------------------------------------------------
// ① trace.ts 原语
// ---------------------------------------------------------------------------

describe('① trace 原语（newTraceId / runWithTrace / getTrace）', () => {
  it('newTraceId 返回非空且互不相同的串', () => {
    const a = newTraceId()
    const b = newTraceId()
    expect(typeof a).toBe('string')
    expect(a.length).toBeGreaterThan(0)
    expect(a).not.toBe(b)
  })

  it('无上下文时 getTrace → undefined（降级不抛）', () => {
    expect(getTrace()).toBeUndefined()
  })

  it('runWithTrace 内 getTrace 读到上下文，且返回 fn 结果', () => {
    const ctx: TraceContext = { traceId: 'T1', taskId: 'task-1', sessionId: 'sess-1' }
    const result = runWithTrace(ctx, () => {
      expect(getTrace()).toEqual(ctx)
      return 42
    })
    expect(result).toBe(42)
    // 退出后恢复无上下文。
    expect(getTrace()).toBeUndefined()
  })

  it('withTrace 是 runWithTrace 的等价别名', () => {
    expect(withTrace({ traceId: 'T2' }, () => getTrace()?.traceId)).toBe('T2')
  })

  it('嵌套 run：内层覆盖外层，退出内层后外层恢复', () => {
    runWithTrace({ traceId: 'OUTER' }, () => {
      expect(getTrace()?.traceId).toBe('OUTER')
      runWithTrace({ traceId: 'INNER' }, () => {
        expect(getTrace()?.traceId).toBe('INNER')
      })
      expect(getTrace()?.traceId).toBe('OUTER')
    })
  })

  it('enterWithTrace 在当前执行内生效，run 退出后恢复', () => {
    runWithTrace({ traceId: 'SCOPE' }, () => {
      enterWithTrace({ traceId: 'ENTERED' })
      expect(getTrace()?.traceId).toBe('ENTERED')
    })
    expect(getTrace()).toBeUndefined()
  })

  it('runWithTrace 不吞 fn 抛出的异常', () => {
    expect(() =>
      runWithTrace({ traceId: 'T' }, () => {
        throw new Error('boom')
      }),
    ).toThrow('boom')
  })
})

// ---------------------------------------------------------------------------
// ② 门面合并（同一 trace 串联 / 无 trace 兼容 / 优先级）
// ---------------------------------------------------------------------------

describe('② 日志门面合并 trace 上下文', () => {
  it('同一 trace 内多次日志 traceId 一致（可串联）', () => {
    const { service, calls } = makeFakeNative()
    const logger = createFinanceLogger({ native: service, scope: 'svc' })

    runWithTrace({ traceId: 'TRACE-X', taskId: 'task-9', sessionId: 'advisor' }, () => {
      logger.info('step-1')
      logger.warn('step-2')
      logger.child('sub').info('step-3')
    })

    expect(calls).toHaveLength(3)
    for (const c of calls) {
      expect(metaOf(c)).toMatchObject({ traceId: 'TRACE-X', taskId: 'task-9', sessionId: 'advisor' })
    }
  })

  it('无 trace 上下文时日志不含 trace 字段（现状兼容）', () => {
    const { service, calls } = makeFakeNative()
    const logger = createFinanceLogger({ native: service, scope: 'svc' })

    logger.info('plain')
    expect(calls[0].args).toEqual(['plain'])

    logger.info('with-meta', { a: 1 })
    expect(calls[1].args).toEqual(['with-meta', { a: 1 }])
  })

  it('优先级：调用级显式 meta > trace 上下文 > 基础 meta', () => {
    const { service, calls } = makeFakeNative()
    const logger = createFinanceLogger({
      native: service,
      scope: 'svc',
      meta: { traceId: 'BASE', base: 1, keep: true },
    })

    runWithTrace({ traceId: 'CTX' }, () => {
      logger.info('inherit') // trace 覆盖 base
      logger.info('override', { traceId: 'CALL' }) // 调用级覆盖 trace
    })

    expect(metaOf(calls[0])).toEqual({ traceId: 'CTX', base: 1, keep: true })
    expect(metaOf(calls[1])).toEqual({ traceId: 'CALL', base: 1, keep: true })
  })

  it('调用级 meta 可新增字段，且与 trace / base 兼容共存', () => {
    const { service, calls } = makeFakeNative()
    const logger = createFinanceLogger({ native: service, meta: { base: 1 } })
    runWithTrace({ traceId: 'T', taskId: 'K' }, () => {
      logger.info('m', { extra: 'x' })
    })
    expect(metaOf(calls[0])).toEqual({ base: 1, traceId: 'T', taskId: 'K', extra: 'x' })
  })

  it('降级路径（无 native）携带 trace meta 也不抛', () => {
    const logger = createFinanceLogger({ scope: 'fallback' })
    expect(() =>
      runWithTrace({ traceId: 'T' }, () => logger.info('x', { a: 1 })),
    ).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// ③ 并发 / 嵌套隔离（AsyncLocalStorage 语义）
// ---------------------------------------------------------------------------

describe('③ 并发 / 嵌套 trace 隔离', () => {
  it('两个并发 run 不串 traceId（异步交错）', async () => {
    const { service, calls } = makeFakeNative()
    const logger = createFinanceLogger({ native: service })

    async function chain(id: string): Promise<void> {
      await runWithTrace({ traceId: id }, async () => {
        await Promise.resolve()
        logger.info(`a-${id}`)
        await new Promise((r) => setTimeout(r, 0))
        logger.info(`b-${id}`)
      })
    }

    await Promise.all([chain('A'), chain('B')])

    const byMsg = new Map(calls.map((c) => [c.args[0] as string, metaOf(c)?.traceId]))
    expect(byMsg.get('a-A')).toBe('A')
    expect(byMsg.get('b-A')).toBe('A')
    expect(byMsg.get('a-B')).toBe('B')
    expect(byMsg.get('b-B')).toBe('B')
  })

  it('嵌套并发：内层 lambda 上下文不被外层污染', async () => {
    const { service, calls } = makeFakeNative()
    const logger = createFinanceLogger({ native: service })

    await runWithTrace({ traceId: 'OUTER' }, async () => {
      logger.info('outer-1')
      await runWithTrace({ traceId: 'INNER' }, async () => {
        await new Promise((r) => setTimeout(r, 0))
        logger.info('inner')
      })
      logger.info('outer-2')
    })

    const byMsg = new Map(calls.map((c) => [c.args[0] as string, metaOf(c)?.traceId]))
    expect(byMsg.get('outer-1')).toBe('OUTER')
    expect(byMsg.get('inner')).toBe('INNER')
    expect(byMsg.get('outer-2')).toBe('OUTER')
  })
})

// ---------------------------------------------------------------------------
// ④ 跨进程唤醒消息显式携带 traceId
// ---------------------------------------------------------------------------

interface CapturedMessage {
  content?: readonly { type: string; text?: string }[]
  source?: { kind?: string; form?: string; summary?: string; traceId?: string }
}

function makeCaptureRegistry(sink: CapturedMessage[]): AgentRegistryLike {
  const agent: AgentLike = {
    id: WAKE_TARGET_ID,
    followup: (msg) => {
      sink.push(msg as unknown as CapturedMessage)
    },
  }
  return { get: (id: string) => (id === WAKE_TARGET_ID ? agent : undefined) }
}

describe('④ 跨进程唤醒消息显式携带 traceId', () => {
  it('wake 在 trace 上下文内投递：消息 source.traceId == 当前 traceId', () => {
    const sink: CapturedMessage[] = []
    const waker = createWaker({ agents: makeCaptureRegistry(sink), wakeCooldownMs: 0 })

    runWithTrace({ traceId: 'WAKE-TRACE-1' }, () => {
      const r = waker.wake('t1', '市场速报')
      expect(r.delivered).toBe(true)
    })

    expect(sink).toHaveLength(1)
    expect(sink[0].source?.kind).toBe('dsh-finance')
    expect(sink[0].source?.form).toBe('notice')
    expect(sink[0].source?.traceId).toBe('WAKE-TRACE-1')
    // 源中可检出（跨进程携带的可检证据）。
    expect(JSON.stringify(sink[0].source)).toContain('WAKE-TRACE-1')
  })

  it('traceId 可经调用方显式传入（优先于上下文）', () => {
    const sink: CapturedMessage[] = []
    const waker = createWaker({ agents: makeCaptureRegistry(sink), wakeCooldownMs: 0 })

    waker.wake('t2', '显式携带', 'EXPLICIT-TRACE')
    expect(sink[0].source?.traceId).toBe('EXPLICIT-TRACE')
  })

  it('无 trace 时消息不含 traceId 字段（notice 形态逐字不变）', () => {
    const sink: CapturedMessage[] = []
    const waker = createWaker({ agents: makeCaptureRegistry(sink), wakeCooldownMs: 0 })

    waker.wake('t3', '普通唤醒')
    expect('traceId' in (sink[0].source ?? {})).toBe(false)
    // 正文 / 摘要不受影响。
    expect(sink[0].content?.[0]?.text).toBe(buildWakeText('普通唤醒'))
    expect(sink[0].source?.summary).toBe(deriveSummary('普通唤醒'))
  })

  it('createNoticeMessage 第 3 参缺省时行为兼容（无 traceId）；传值时可检出', () => {
    const a = createNoticeMessage('body', 'sum') as unknown as CapturedMessage
    expect('traceId' in (a.source ?? {})).toBe(false)
    expect(a.source?.kind).toBe('dsh-finance')

    const b = createNoticeMessage('body', 'sum', 'TR-9') as unknown as CapturedMessage
    expect(b.source?.traceId).toBe('TR-9')
  })
})
