/**
 * 统一日志门面（里程碑 M1「统一门面」）。
 *
 * 目标：为 dsh-finance 插件提供**唯一日志出口**，封装 dsh 原生 `ctx.logger`
 *   （cordis `LoggerService`），取代全仓散乱的 `console.*` 调用与
 *   `src/scheduler/index.ts` 里的手写 `level → console` switch。
 *
 * 设计要点（对齐技术方案《日志完善技术方案（dsh-finance 插件）v1.0》§5.1）：
 *   1. **复用原生**：禁止引入 pino / winston 等第三方日志库，也不新增运行时依赖；
 *      native 侧直接委托 cordis `ctx.logger(name?)` 派生的命名 logger。
 *   2. **四级 + 派生 + 结构化 meta**：暴露 `error/warn/info/debug` 四级与
 *      `child(scope)` 派生命名 logger；每次调用可携带结构化 `meta`，与门面基础
 *      meta 浅合并（调用级优先）。
 *   2.1 **trace 上下文自动合并（M4）**：单一出口 `emit()` 读取当前
 *      `AsyncLocalStorage` 上下文（{@link getTrace}），把 `traceId/taskId/sessionId`
 *      **自动合并进 meta**；优先级「调用级显式 meta > 当前 trace 上下文 > 基础
 *      meta」。无上下文时**不加** trace 字段、退化为现状，绝不抛。
 *   3. **降级实现**：当 `ctx.logger` 缺失 / 形态非法（如纯单测、无宿主）时，回落到
 *      门面内极简实现（内部仍走 `console`），保证模块脱离宿主也能跑、能测。
 *      —— 方案 §10 验收第 1 条明确「统一门面内除外」，故仅本文件允许保留 `console.*`。
 *   4. **级别过滤（基础能力）**：降级路径按最低级别阈值过滤；阈值取
 *      `options.level` → 环境变量 `DSH_FINANCE_LOG_LEVEL` → 默认 `info`。
 *      native 可用时由其自身的 level 配置决定，本门面不二次过滤（纯粹「换出口」）。
 *   5. **只换出口、不改业务行为**：文件落地 / exporter / trace / 去敏属后续里程碑，
 *      本模块不实现文件写盘。
 *
 * 级别语义：`error(0) / warn(1) / info(2) / debug(3)`（{@link LEVEL_RANK}，数值越小越严重）；
 *   `shouldEmit(level, threshold)` 即「级别严重度 ≤ 阈值严重度」才输出。默认 `info`
 *   放行 error / warn / info，抑制 debug。
 */

import { getTrace, type TraceContext } from './trace.js'

/** 日志级别。 */
export type LogLevel = 'error' | 'warn' | 'info' | 'debug'

/** 结构化日志附加字段（K/V，值类型不限）。 */
export type LogMeta = Record<string, unknown>

/**
 * 统一日志门面契约。
 *
 * @example
 * ```ts
 * const logger = createFinanceLogger({ native: ctx.logger, scope: 'dsh-finance' })
 * logger.info('会话已确保', { id })
 * const sessionLog = logger.child('session') // 命名 logger：dsh-finance:session
 * sessionLog.warn('agents 服务不可用')
 * ```
 */
export interface FinanceLogger {
  /** 错误级。 */
  error(message: string, meta?: LogMeta): void
  /** 警告级。 */
  warn(message: string, meta?: LogMeta): void
  /** 信息级。 */
  info(message: string, meta?: LogMeta): void
  /** 调试级。 */
  debug(message: string, meta?: LogMeta): void
  /** 派生一个命名子 logger（scope 以 `:` 追加到当前 scope）。 */
  child(scope: string): FinanceLogger
}

/**
 * cordis 原生 logger 的最小结构契约。
 *
 * 覆盖 `ctx.logger(name?)` 的返回值（命名 {@link Logger}）与 `ctx.logger` 本身
 * （`LoggerService` 亦直接具备四级方法）。方法签名为 printf 风格
 * `(format, ...params)`，与原生一致。
 */
export interface NativeLoggerLike {
  error(format: unknown, ...params: unknown[]): void
  warn(format: unknown, ...params: unknown[]): void
  info(format: unknown, ...params: unknown[]): void
  debug(format: unknown, ...params: unknown[]): void
}

/** cordis 原生 logger 服务（`ctx.logger`）的最小结构契约：可调用 `(name?)` + 四级方法。 */
export interface NativeLoggerServiceLike extends NativeLoggerLike {
  (name?: string): NativeLoggerLike
}

/** {@link createFinanceLogger} 选项。 */
export interface CreateFinanceLoggerOptions {
  /**
   * 原生 logger 服务（通常为 `ctx.logger`）。
   * 缺失或形态非法时，门面回落为内部降级实现（仍走 `console`）。
   */
  native?: unknown
  /** 基础 scope（命名 logger 名）；`child(scope)` 时以 `:` 追加。 */
  scope?: string
  /** 基础 meta（与每次调用的 meta 浅合并，调用级优先）。 */
  meta?: LogMeta
  /**
   * 降级路径的最低级别（阈值）；默认取环境变量 {@link LOG_LEVEL_ENV} → {@link DEFAULT_LOG_LEVEL}。
   * native 可用时此值不生效（由 native 自身 level 配置决定）。
   */
  level?: LogLevel
}

/** 环境变量：降级路径的最低日志级别。 */
export const LOG_LEVEL_ENV = 'DSH_FINANCE_LOG_LEVEL'

/** 默认最低日志级别。 */
export const DEFAULT_LOG_LEVEL: LogLevel = 'info'

/**
 * 级别严重度排序（过滤用）。数值越小越严重。
 *
 * 顺序对齐技术方案《日志完善技术方案》§4.1（`error ≤ warn ≤ info ≤ debug`），
 * 与 cordis `LoggerLevel` 的**数值**序（`ERROR=0, INFO=1, WARN=2, DEBUG=3`）**不同**
 * （info / warn 相反）。凡按方案严重度过滤（如 M2 文件 exporter）都应复用本表，
 * 避免两处口径漂移。
 */
export const LEVEL_RANK: Record<LogLevel, number> = { error: 0, warn: 1, info: 2, debug: 3 }

/** 全部合法级别（用于环境变量解析）。 */
const LEVELS: readonly LogLevel[] = ['error', 'warn', 'info', 'debug']

/** 是否为合法级别字符串。 */
function isLogLevel(value: unknown): value is LogLevel {
  return typeof value === 'string' && (LEVELS as readonly string[]).includes(value)
}

/** 读取环境变量（无 `process` 时安全返回 `undefined`）。 */
function readEnv(name: string): string | undefined {
  return typeof process !== 'undefined' ? process.env?.[name] : undefined
}

/**
 * 解析最低级别：显式值 > 环境变量 {@link LOG_LEVEL_ENV} > 默认 {@link DEFAULT_LOG_LEVEL}。
 * 非法 / 缺失值一律回落默认。
 */
export function resolveLogLevel(explicit?: LogLevel | string): LogLevel {
  if (isLogLevel(explicit)) return explicit
  const env = readEnv(LOG_LEVEL_ENV)
  if (isLogLevel(env)) return env
  return DEFAULT_LOG_LEVEL
}

/** 结构判据：是否为形态合法的原生 logger 服务。 */
function isNativeLoggerService(value: unknown): value is NativeLoggerServiceLike {
  if (typeof value !== 'function') return false
  const methods = value as unknown as Record<string, unknown>
  return LEVELS.every((level) => typeof methods[level] === 'function')
}

/** 浅合并基础 meta 与调用级 meta（调用级优先）。 */
function mergeMeta(base: LogMeta | undefined, extra: LogMeta | undefined): LogMeta | undefined {
  if (!base) return extra
  if (!extra) return base
  return { ...base, ...extra }
}

/**
 * 把当前 trace 上下文投影为日志 meta 片段（仅含**已定义**字段）。
 *
 * 无上下文 / 全字段缺失 → `undefined`（不产生空对象，保持「无 trace 字段」的现状）。
 */
function traceMeta(trace: TraceContext | undefined): LogMeta | undefined {
  if (!trace) return undefined
  const out: LogMeta = {}
  if (trace.traceId !== undefined) out.traceId = trace.traceId
  if (trace.taskId !== undefined) out.taskId = trace.taskId
  if (trace.sessionId !== undefined) out.sessionId = trace.sessionId
  return hasEntries(out) ? out : undefined
}

/**
 * 合并三层 meta（M4）：基础 meta → 当前 trace 上下文 → 调用级显式 meta。
 *
 * 优先级：**调用级显式 meta > trace 上下文 > 基础 meta**（同名键后者覆盖前者）。
 * 无 trace 上下文时退化为既有的「基础 ⊕ 调用级」（行为零变化）。
 */
function mergeEmitMeta(
  base: LogMeta | undefined,
  meta: LogMeta | undefined,
): LogMeta | undefined {
  return mergeMeta(mergeMeta(base, traceMeta(getTrace())), meta)
}

/** 判据：meta 存在且至少含一个键。 */
function hasEntries(meta: LogMeta | undefined): meta is LogMeta {
  return meta !== undefined && Object.keys(meta).length > 0
}

/** 统一门面实现：native 优先委托，缺失则降级到 `console`。 */
class FinanceLoggerImpl implements FinanceLogger {
  /** 显式提供的原生 logger 服务（缺省 undefined → 降级）。 */
  private readonly nativeSource: NativeLoggerServiceLike | undefined
  /** 当前 scope（命名 logger 名）。 */
  private readonly scope: string
  /** 降级路径的最低级别阈值。 */
  private readonly threshold: LogLevel
  /** 基础 meta（与调用级 meta 合并）。 */
  private readonly baseMeta: LogMeta | undefined
  /** 已解析绑定的原生 logger 缓存（避免每次调用重建命名 logger）。 */
  private cachedSource: NativeLoggerServiceLike | undefined
  private cachedBound: NativeLoggerLike | undefined

  constructor(
    nativeSource: NativeLoggerServiceLike | undefined,
    scope: string,
    threshold: LogLevel,
    baseMeta: LogMeta | undefined,
  ) {
    this.nativeSource = nativeSource
    this.scope = scope
    this.threshold = threshold
    this.baseMeta = baseMeta
  }

  error(message: string, meta?: LogMeta): void {
    this.emit('error', message, meta)
  }

  warn(message: string, meta?: LogMeta): void {
    this.emit('warn', message, meta)
  }

  info(message: string, meta?: LogMeta): void {
    this.emit('info', message, meta)
  }

  debug(message: string, meta?: LogMeta): void {
    this.emit('debug', message, meta)
  }

  child(scope: string): FinanceLogger {
    const next = this.scope ? `${this.scope}:${scope}` : scope
    return new FinanceLoggerImpl(this.nativeSource, next, this.threshold, this.baseMeta)
  }

  /** 解析当前 scope 对应的原生 logger（懒解析 + 缓存）。 */
  private bound(): NativeLoggerLike | undefined {
    const source = this.nativeSource
    if (!source) return undefined
    if (source !== this.cachedSource) {
      this.cachedSource = source
      this.cachedBound = this.scope ? source(this.scope) : source
    }
    return this.cachedBound
  }

  /** 单一出口：native 优先；缺失则按阈值过滤后走 `console`。 */
  private emit(level: LogLevel, message: string, meta?: LogMeta): void {
    const merged = mergeEmitMeta(this.baseMeta, meta)
    const native = this.bound()
    if (native) {
      if (hasEntries(merged)) native[level](message, merged)
      else native[level](message)
      return
    }
    // 降级路径：门面内 level 过滤 + console 兜底。
    if (LEVEL_RANK[level] > LEVEL_RANK[this.threshold]) return
    const sink = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log
    if (hasEntries(merged)) sink(message, merged)
    else sink(message)
  }
}

/**
 * 创建统一日志门面。
 *
 * @param options 见 {@link CreateFinanceLoggerOptions}。
 * @returns {@link FinanceLogger} 门面实例。
 */
export function createFinanceLogger(options: CreateFinanceLoggerOptions = {}): FinanceLogger {
  const native = isNativeLoggerService(options.native) ? options.native : undefined
  return new FinanceLoggerImpl(native, options.scope ?? '', resolveLogLevel(options.level), options.meta)
}

/**
 * 便捷工厂：按 scope 创建门面（**不含**原生 logger，走降级实现）。
 *
 * 供「无 `ctx` 可用」的模块（如 domain/工具层）以统一出口记录日志；降级实现内部走
 * `console`，保证脱离宿主也能运行与测试。
 *
 * @param scope 命名 scope（可选）。
 * @param options 级别 / 基础 meta 覆盖项。
 */
export function createLogger(
  scope?: string,
  options: { level?: LogLevel; meta?: LogMeta } = {},
): FinanceLogger {
  return new FinanceLoggerImpl(undefined, scope ?? '', resolveLogLevel(options.level), options.meta)
}

/**
 * 便捷适配器：把门面适配为既有 `(message: string) => void` 注入位（info 级）。
 *
 * 用于 `session-ensure` / `skills/repo` / `opening-notice` 等**既有**「可注入 logger」
 * 接口的**默认实现**统一（保持接口不变）。
 *
 * @param scope 命名 scope（可选）。
 * @param native 原生 logger 服务（可选；如 `ctx.logger`）。缺失则走降级实现。
 */
export function createLogFunction(scope?: string, native?: unknown): (message: string) => void {
  const logger = createFinanceLogger({ native, scope })
  return (message: string): void => {
    logger.info(message)
  }
}

/**
 * 便捷适配器：把门面适配为 `scheduler` 既有 `(level, message) => void` 注入位。
 *
 * 取代 `src/scheduler/index.ts` 里手写的 `level → console` 三分支 switch。
 *
 * @param scope 命名 scope（可选）。
 * @param native 原生 logger 服务（可选；如 `ctx.logger`）。缺失则走降级实现。
 */
export function createLeveledLogFunction(
  scope?: string,
  native?: unknown,
): (level: 'info' | 'warn' | 'error', message: string) => void {
  const logger = createFinanceLogger({ native, scope })
  return (level, message): void => {
    logger[level](message)
  }
}
