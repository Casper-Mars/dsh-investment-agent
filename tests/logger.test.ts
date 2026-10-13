/**
 * 统一日志门面（`src/log/logger.ts`）单元测试（里程碑 M1「统一门面」）。
 *
 * 覆盖（对齐任务卡 §验收标准 第 7 条）：
 *   1. 四级分派（error / warn / info / debug）→ 委托原生 logger；
 *   2. `child(scope)` 派生命名 logger（scope 以 `:` 追加）；
 *   3. 结构化 meta 合并（基础 meta ⊕ 调用级 meta，调用级优先）；
 *   4. `ctx.logger` 缺失 / 形态非法 → 降级实现（内部走 `console`）；
 *   5. level 过滤（降级路径；阈值取 options.level / env `DSH_IA_LOG_LEVEL` / 默认 info）；
 *   6. 两个「既有注入位」适配器（`(message)` / `(level, message)`）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createFinanceLogger,
  createLeveledLogFunction,
  createLogFunction,
  createLogger,
  DEFAULT_LOG_LEVEL,
  LOG_LEVEL_ENV,
  resolveLogLevel,
  type LogLevel,
  type NativeLoggerLike,
  type NativeLoggerServiceLike,
} from '../src/log/logger.js'

/** 捕获的一次原生调用。 */
interface CapturedCall {
  level: LogLevel
  name: string
  args: unknown[]
}

/** 假原生 logger 服务：可调用 `(name?)` + 四级方法，并记录派生名与调用。 */
interface FakeNative {
  service: NativeLoggerServiceLike
  /** 每次 `service(name)` 派生的命名 logger 名（按调用序）。 */
  created: string[]
  /** 全部四级调用。 */
  calls: CapturedCall[]
}

/** 构造假原生 logger 服务。 */
function makeFakeNative(): FakeNative {
  const created: string[] = []
  const calls: CapturedCall[] = []
  const makeLogger = (name: string): NativeLoggerLike => ({
    error: (...args: unknown[]) => {
      calls.push({ level: 'error', name, args })
    },
    warn: (...args: unknown[]) => {
      calls.push({ level: 'warn', name, args })
    },
    info: (...args: unknown[]) => {
      calls.push({ level: 'info', name, args })
    },
    debug: (...args: unknown[]) => {
      calls.push({ level: 'debug', name, args })
    },
  })
  const service = ((name?: string): NativeLoggerLike => {
    const resolved = name ?? '<fiber>'
    created.push(resolved)
    return makeLogger(resolved)
  }) as unknown as NativeLoggerServiceLike
  // 服务自身亦具备四级方法（对齐 cordis LoggerService）。
  Object.assign(service, makeLogger('<self>'))
  return { service, created, calls }
}

let logSpy: ReturnType<typeof vi.spyOn>
let warnSpy: ReturnType<typeof vi.spyOn>
let errSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
  errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
  delete process.env[LOG_LEVEL_ENV]
})

describe('① 四级分派（native 委托）', () => {
  it('error/warn/info/debug 分别委托到原生对应级别，且透传消息', () => {
    const { service, calls } = makeFakeNative()
    const logger = createFinanceLogger({ native: service, scope: 'svc' })

    logger.error('E')
    logger.warn('W')
    logger.info('I')
    logger.debug('D')

    expect(calls.map((c) => c.level)).toEqual(['error', 'warn', 'info', 'debug'])
    expect(calls.map((c) => c.args)).toEqual([['E'], ['W'], ['I'], ['D']])
    // 命名 logger 使用传入的 scope 名。
    expect(calls.every((c) => c.name === 'svc')).toBe(true)
    // native 可用时不触碰 console。
    expect(logSpy).not.toHaveBeenCalled()
    expect(errSpy).not.toHaveBeenCalled()
  })

  it('无 scope 时使用服务本身（fiber 派生名），不额外命名', () => {
    const { service, calls } = makeFakeNative()
    const logger = createFinanceLogger({ native: service })
    logger.info('root')
    expect(calls).toHaveLength(1)
    expect(calls[0].name).toBe('<self>')
  })
})

describe('② child(scope) 派生命名 logger', () => {
  it('child 以 `:` 追加 scope，形成分级命名 logger', () => {
    const { service, created, calls } = makeFakeNative()
    const logger = createFinanceLogger({ native: service, scope: 'svc' })

    logger.info('root') // 触发根命名 logger 绑定（'svc'）
    logger.child('session').info('a')
    logger.child('session').child('deep').warn('b')

    expect(created).toEqual(['svc', 'svc:session', 'svc:session:deep'])
    expect(calls.map((c) => c.name)).toEqual(['svc', 'svc:session', 'svc:session:deep'])
  })

  it('根无 scope 时，child 直接使用子 scope（不再加前导 `:`）', () => {
    const { service, created } = makeFakeNative()
    const logger = createFinanceLogger({ native: service })
    logger.child('scheduler').info('x')
    expect(created).toContain('scheduler')
    expect(created.some((n) => n.startsWith(':'))).toBe(false)
  })

  it('派生 logger 仍共享同一基础 meta', () => {
    const { service, calls } = makeFakeNative()
    const logger = createFinanceLogger({ native: service, scope: 'svc', meta: { base: 1 } })
    logger.child('child').info('m', { extra: 2 })
    expect(calls[0].args).toEqual(['m', { base: 1, extra: 2 }])
  })
})

describe('③ 结构化 meta 合并', () => {
  it('基础 meta ⊕ 调用级 meta（调用级优先）', () => {
    const { service, calls } = makeFakeNative()
    const logger = createFinanceLogger({
      native: service,
      scope: 'svc',
      meta: { a: 1, b: 1 },
    })
    logger.info('x', { b: 2, c: 3 })
    expect(calls[0].args).toEqual(['x', { a: 1, b: 2, c: 3 }])
  })

  it('无 meta 时仅传消息（不产生空 meta）', () => {
    const { service, calls } = makeFakeNative()
    const logger = createFinanceLogger({ native: service, scope: 'svc' })
    logger.info('plain')
    expect(calls[0].args).toEqual(['plain'])
  })

  it('仅基础 meta 时，每次调用都带上（与调用级合并）', () => {
    const { service, calls } = makeFakeNative()
    const logger = createFinanceLogger({ native: service, scope: 'svc', meta: { only: true } })
    logger.warn('w')
    expect(calls[0].args).toEqual(['w', { only: true }])
  })
})

describe('④ 降级：ctx.logger 缺失 / 形态非法', () => {
  it('native 缺失 → 走 console（四级别分别映射 error/warn/log）', () => {
    const logger = createFinanceLogger({ scope: 'dsh-ia:test' })
    logger.error('E')
    logger.warn('W')
    logger.info('I')

    expect(errSpy).toHaveBeenCalledWith('E')
    expect(warnSpy).toHaveBeenCalledWith('W')
    expect(logSpy).toHaveBeenCalledWith('I')
  })

  it('native 形态非法（普通对象）→ 同样降级', () => {
    const logger = createFinanceLogger({ native: { not: 'a logger' } })
    logger.info('fallback')
    expect(logSpy).toHaveBeenCalledWith('fallback')
  })

  it('降级实现携带 meta 时作为附加参数传入', () => {
    const logger = createFinanceLogger({ meta: { a: 1 } })
    logger.error('boom', { b: 2 })
    expect(errSpy).toHaveBeenCalledWith('boom', { a: 1, b: 2 })
  })

  it('createLogger 便捷工厂等价于无 native 门面', () => {
    createLogger('dsh-ia:x').info('hi')
    expect(logSpy).toHaveBeenCalledWith('hi')
  })
})

describe('⑤ level 过滤（降级路径）', () => {
  it('阈值 error：仅 error 输出，warn/info/debug 被抑制', () => {
    const logger = createFinanceLogger({ level: 'error' })
    logger.error('e')
    logger.warn('w')
    logger.info('i')
    logger.debug('d')

    expect(errSpy).toHaveBeenCalledTimes(1)
    expect(errSpy).toHaveBeenCalledWith('e')
    expect(warnSpy).not.toHaveBeenCalled()
    expect(logSpy).not.toHaveBeenCalled()
  })

  it('默认阈值 info：放行 error/warn/info，抑制 debug', () => {
    const logger = createFinanceLogger({})
    logger.error('e')
    logger.warn('w')
    logger.info('i')
    logger.debug('d')

    expect(errSpy).toHaveBeenCalledWith('e')
    expect(warnSpy).toHaveBeenCalledWith('w')
    expect(logSpy).toHaveBeenCalledWith('i')
    // debug 被抑制：console.log 只被 info 调用一次。
    expect(logSpy).toHaveBeenCalledTimes(1)
  })

  it('阈值 debug：全部放行', () => {
    const logger = createFinanceLogger({ level: 'debug' })
    logger.debug('d')
    expect(logSpy).toHaveBeenCalledWith('d')
  })

  it('resolveLogLevel：显式 > env > 默认；非法值回落默认', () => {
    expect(resolveLogLevel('debug')).toBe('debug')
    expect(resolveLogLevel()).toBe(DEFAULT_LOG_LEVEL)
    process.env[LOG_LEVEL_ENV] = 'error'
    expect(resolveLogLevel()).toBe('error')
    expect(resolveLogLevel('warn')).toBe('warn')
    process.env[LOG_LEVEL_ENV] = 'bogus'
    expect(resolveLogLevel()).toBe(DEFAULT_LOG_LEVEL)
  })

  it('env DSH_IA_LOG_LEVEL 生效于降级路径', () => {
    process.env[LOG_LEVEL_ENV] = 'error'
    const logger = createLogger('x')
    logger.info('i')
    logger.error('e')
    expect(logSpy).not.toHaveBeenCalled()
    expect(errSpy).toHaveBeenCalledWith('e')
  })
})

describe('⑥ 既有注入位适配器', () => {
  it('createLogFunction → info 级 console.log', () => {
    createLogFunction('dsh-ia:session')('M')
    expect(logSpy).toHaveBeenCalledWith('M')
  })

  it('createLeveledLogFunction → 按 level 分流到 console.error/warn/log', () => {
    const log = createLeveledLogFunction('dsh-ia:scheduler')
    log('error', 'E')
    log('warn', 'W')
    log('info', 'I')
    expect(errSpy).toHaveBeenCalledWith('E')
    expect(warnSpy).toHaveBeenCalledWith('W')
    expect(logSpy).toHaveBeenCalledWith('I')
  })
})
