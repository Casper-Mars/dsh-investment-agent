/**
 * runner 层：感知脚本执行器（`sensor-runner`）。
 *
 * 职责（详细设计 §6.2）：**加载 current 感知脚本 → 组装只读 bindings →
 * 沙箱执行 → 解析返回值 →（应唤醒则投递）**。标的无关、type 无关。
 *
 * 职责边界（§10.1，感知层与策略解耦）：本模块属于「感知层 = 机制」
 * （执行器），**与策略无关**——只负责「跑当前感知程序」，不认识策略。
 * 感知程序 = 内容（agent 生成的代码，全局唯一、标的无关）为策略服务：
 * 策略声明「要什么」，感知程序实现「怎么看」。二者**不直连**，耦合发生在
 * **生成时**（agent 把策略需求翻译成感知程序）与**复盘时**（可能同时更新
 * 策略与感知程序）。策略/感知/工具的关系见详细设计 §10。
 *
 * 执行链路：
 *   1. `senseRegistry.current()` 取当前版本 meta；
 *   2. `senseRegistry.read(version).code` 取脚本正文
 *      （`current()` 只返回 meta，不含 code，故需 read() 回读全文）；
 *   3. `createSensorBindings(...)` 组装 3 个只读命名空间；
 *   4. `ptcRuntime.resolve(request)` → `ptcRuntime.run(spec)`
 *      （node 实现要求先 resolve：run 需 spec 带 sandboxPolicy / 绝对 cwd / 数值 timeoutMs）；
 *   5. 成功则解析 `result.value` → `shouldWake`；`true` 且未处于冷却 → 投递唤醒。
 *
 * 健壮性（NFR-03）：任何环节失败都不向调度层抛异常；以结构化 `SensorRunOutcome`
 * 返回（`failed` / `skipped` / `quiet` / `woke`），保证 `scheduler` 链条不断。
 *
 * 沙箱策略：`{ mode: 'read-only', workspaceRoot: dataRoot }`（不暴露写操作）。
 */
import type { Ledger } from '../domain/ledger.js'
import type { SenseRegistry } from '../domain/sense-registry.js'
import type { QuoteClient } from '../lib/quotes.js'
import type { SessionPersistenceLike } from '../session.js'
import { createSensorBindings } from './bindings.js'
import type {
  PtcJsonValue,
  PtcRunFailureKind,
  PtcRunRequest,
  PtcRunResult,
  PtcRuntimeLike,
  SensorRunOutcome,
  SensorRunReason,
  SensorWakePayload,
  SensorWaker,
  SensorScriptResult,
} from './types.js'

/** 默认单次执行预算（ms）。 */
export const DEFAULT_SENSOR_TIMEOUT_MS = 60_000

/** 默认唤醒冷却（ms）：同一标的在此窗口内不重复唤醒（NFR 幂等）。 */
export const DEFAULT_WAKE_COOLDOWN_MS = 5 * 60_000

/** 默认单次批处理标的数量上界（超出本轮留待后续轮次）。 */
export const DEFAULT_BATCH_LIMIT = 20

/** 默认单次唤醒文本预算（字符数）；超限截断 metrics/summary 避免 token 失控。 */
export const DEFAULT_WAKE_TEXT_BUDGET = 2000

/** `sensor-runner` 依赖。 */
export interface SensorRunnerDeps {
  /** 感知版本注册表（current / read）。 */
  senseRegistry: Pick<SenseRegistry, 'current' | 'read'>
  /** 台账域（list / query，只读）。 */
  ledger: Pick<Ledger, 'list' | 'query'>
  /** 行情客户端。 */
  quotes: Pick<QuoteClient, 'realtime' | 'intraday' | 'history'>
  /** PTC 运行时空服务（`ctx.ptcRuntime`）。 */
  ptcRuntime: PtcRuntimeLike
  /** 数据根目录（沙箱 workspaceRoot / cwd）。 */
  dataRoot: string
  /** 单次执行预算（ms）；默认 {@link DEFAULT_SENSOR_TIMEOUT_MS}。 */
  timeoutMs?: number | null
  /** 唤醒冷却（ms）；默认 {@link DEFAULT_WAKE_COOLDOWN_MS}；`0` 关闭。 */
  wakeCooldownMs?: number
  /** 单次批处理标的数量上界；默认 {@link DEFAULT_BATCH_LIMIT}；`0` 关闭。 */
  batchLimit?: number
  /** 单次唤醒文本预算（字符）；默认 {@link DEFAULT_WAKE_TEXT_BUDGET}。 */
  wakeTextBudget?: number
  /** 日志（默认 `console.log`）。 */
  logger?: (message: string) => void
  /** 时钟（默认 `Date.now`）。 */
  now?: () => number
  /** 唤醒通道（可由 `setWaker` 后续注入）。 */
  waker?: SensorWaker
}

/** 感知执行器。 */
export interface SensorRunner {
  /** 执行 current 感知脚本并按 `shouldWake` 决定是否唤醒。 */
  run(reason?: SensorRunReason): Promise<SensorRunOutcome>
  /** 盘后复盘：投递固定唤醒（唤醒 agent 执行复盘工具链）。 */
  runReview(): Promise<SensorRunOutcome>
  /** 盘前准备：投递固定唤醒（唤醒 agent 生成当日关注点）。 */
  runPrep(): Promise<SensorRunOutcome>
  /** 注入 / 替换唤醒通道（`agents` 服务就绪后调用；`undefined` 表示降级为跳过）。 */
  setWaker(waker: SensorWaker | undefined): void
  /** 设定固定会话标识（`PINNED_SESSION_ID`；Task-10/11 定点投递的稳定锚点）。 */
  setPinnedSessionId(id: string | undefined): void
  /** 读取当前固定会话标识（未注入时 `undefined`）。 */
  getPinnedSessionId(): string | undefined
  /** 注入会话持久化服务（`sessionPersistence` 就绪后调用；基础层仅观察）。 */
  setSessionPersistence(persistence: SessionPersistenceLike | undefined): void
  /** 读取当前会话持久化服务（未注入时 `undefined`）。 */
  getSessionPersistence(): SessionPersistenceLike | undefined
}

/**
 * 截断文本到预算内（超限则保留前 `max-1` 字符并追加省略号）。
 * 与 wake.ts 的 `boundSummary` 同源；此处独立实现避免 runner↔wake 循环依赖。
 */
export function boundText(text: string, max: number): string {
  if (max <= 0) return ''
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`
}

/** 解析脚本返回值（非法时返回 null）。 */
export function parseSensorResult(value: PtcJsonValue | undefined): SensorScriptResult | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const obj = value as Record<string, PtcJsonValue>
  if (typeof obj.shouldWake !== 'boolean') return null
  const result: SensorScriptResult = { shouldWake: obj.shouldWake }
  if (typeof obj.symbol === 'string') result.symbol = obj.symbol
  if (typeof obj.summary === 'string') result.summary = obj.summary
  if (obj.metrics !== undefined) result.metrics = obj.metrics
  return result
}

/**
 * 构造感知执行器。
 *
 * @param deps 依赖（注册表 / 台账 / 行情 / 运行时 / 数据根）。
 * @returns {@link SensorRunner}。
 */
export function createSensorRunner(deps: SensorRunnerDeps): SensorRunner {
  const log = deps.logger ?? ((message: string) => console.log(message))
  const now = deps.now ?? (() => Date.now())
  const timeoutMs =
    deps.timeoutMs === undefined ? DEFAULT_SENSOR_TIMEOUT_MS : deps.timeoutMs
  const cooldownMs = deps.wakeCooldownMs ?? DEFAULT_WAKE_COOLDOWN_MS
  const batchLimit = deps.batchLimit ?? DEFAULT_BATCH_LIMIT
  const wakeTextBudget = deps.wakeTextBudget ?? DEFAULT_WAKE_TEXT_BUDGET
  let waker = deps.waker
  /** 固定会话标识（由装配阶段注入 `PINNED_SESSION_ID`）。 */
  let pinnedSessionId: string | undefined
  /** 会话持久化服务（由装配阶段注入；基础层仅观察，不 ensure/创建）。 */
  let sessionPersistence: SessionPersistenceLike | undefined

  /** 各唤醒键（reason:symbol）的最近一次成功投递时刻。 */
  const lastWakeAt = new Map<string, number>()

  /** 冷却判定。 */
  const inCooldown = (key: string): boolean => {
    if (cooldownMs <= 0) return false
    const last = lastWakeAt.get(key)
    return last !== undefined && now() - last < cooldownMs
  }

  /** 投递唤醒（降级：无通道 / 投递异常 → 0）。返回实际投递会话数。 */
  const deliver = (payload: SensorWakePayload): number => {
    if (!waker) {
      log('[dsh-finance/runner] 警告 未配置唤醒通道，跳过唤醒（降级）')
      return 0
    }
    try {
      const delivered = waker(payload)
      return Number.isFinite(delivered) && delivered > 0 ? delivered : 0
    } catch (err: unknown) {
      log(`[dsh-finance/runner] 警告 唤醒投递异常：${String(err)}`)
      return 0
    }
  }

  /** 标的清单（异常时返回空数组）。 */
  const symbolCodes = (): string[] => {
    try {
      return deps.ledger.list().map((s) => s.symbol)
    } catch {
      return []
    }
  }

  /**
   * 应用单次批处理上界：超限则仅取前 `batchLimit` 个，其余留待后续轮次。
   * 返回 `{ symbols, truncated }`（truncated 表示是否发生截断）。
   */
  const applyBatchLimit = (
    symbols: string[],
  ): { symbols: string[]; truncated: boolean } => {
    if (batchLimit > 0 && symbols.length > batchLimit) {
      return { symbols: symbols.slice(0, batchLimit), truncated: true }
    }
    return { symbols, truncated: false }
  }

  /**
   * 截断唤醒载荷到单次文本预算内：优先缩短 summary，再裁 metrics JSON。
   * 返回裁剪后的载荷（不改动入参；据此判断是否发生截断）。
   */
  const boundPayload = (
    payload: SensorWakePayload,
  ): { payload: SensorWakePayload; truncated: boolean } => {
    if (wakeTextBudget <= 0) return { payload, truncated: false }
    // 先预算 summary 与 metrics 的 JSON 总长。
    const metricsJson = payload.metrics === undefined ? '' : JSON.stringify(payload.metrics)
    const total = payload.summary.length + (metricsJson.length > 0 ? metricsJson.length + 1 : 0)
    if (total <= wakeTextBudget) return { payload, truncated: false }

    let summary = payload.summary
    // summary 至少保留预算的 1/4，其余让渡给 metrics；若超预算则先裁 summary。
    const summaryBudget = Math.max(0, Math.floor(wakeTextBudget / 2))
    if (summary.length > summaryBudget) {
      summary = boundText(summary, summaryBudget)
    }
    // metrics 占剩余预算。
    let metrics = payload.metrics
    const remaining = wakeTextBudget - summary.length
    if (metrics !== undefined && metricsJson.length > remaining) {
      const trimmed = boundText(metricsJson, Math.max(1, remaining - 1))
      metrics = JSON.parse(trimmed)
    }
    return {
      payload: { ...payload, summary, ...(metrics === undefined ? {} : { metrics }) },
      truncated: true,
    }
  }

  /** 复盘 / 盘前固定唤醒。 */
  const runNotice = async (
    reason: 'review' | 'prep',
    buildSummary: (symbols: string[]) => string,
  ): Promise<SensorRunOutcome> => {
    let version: string | undefined
    try {
      version = deps.senseRegistry.current()?.version
    } catch {
      version = undefined
    }
    const allSymbols = symbolCodes()
    const bounded = applyBatchLimit(allSymbols)
    const symbols = bounded.symbols
    const key = `${reason}:*`
    if (inCooldown(key)) {
      return { kind: 'skipped', reason, detail: '唤醒冷却中', symbol: '*', version }
    }
    if (bounded.truncated) {
      log(
        `[dsh-finance/runner] 批处理标的超上界（${batchLimit}），本轮仅处理前 ${symbols.length} 个，其余 ${allSymbols.length - symbols.length} 个留待后续轮次`,
      )
    }
    let payload: SensorWakePayload = {
      reason,
      symbol: '*',
      summary: buildSummary(symbols),
      metrics: { symbols, ...(bounded.truncated ? { truncated: true } : {}) },
      ...(version === undefined ? {} : { version }),
    }
    const bound = boundPayload(payload)
    payload = bound.payload
    const delivered = deliver(payload)
    if (delivered <= 0) {
      return { kind: 'skipped', reason, detail: '无可用 agent，跳过唤醒', symbol: '*', version }
    }
    lastWakeAt.set(key, now())
    return {
      kind: 'woke',
      reason,
      symbol: '*',
      summary: payload.summary,
      targets: delivered,
      ...(version === undefined ? {} : { version }),
    }
  }

  const run = async (reason: SensorRunReason = 'pulse'): Promise<SensorRunOutcome> => {
    // 1) 取 current 版本（含 code）。
    let version: string
    let code: string
    try {
      const current = deps.senseRegistry.current()
      if (!current) {
        return { kind: 'skipped', reason, detail: '尚无 current 感知脚本' }
      }
      version = current.version
      code = deps.senseRegistry.read(current.version).code
    } catch (err: unknown) {
      return { kind: 'skipped', reason, detail: `读取感知脚本失败：${String(err)}` }
    }

    // 2~4) 组装只读 bindings → 沙箱执行。
    let result: PtcRunResult
    try {
      const bindings = createSensorBindings({ ledger: deps.ledger, quotes: deps.quotes })
      const request: PtcRunRequest = {
        program: code,
        bindings,
        cwd: deps.dataRoot,
        timeoutMs,
        sandboxPolicy: { mode: 'read-only', workspaceRoot: deps.dataRoot },
      }
      const spec = deps.ptcRuntime.resolve(request)
      result = await deps.ptcRuntime.run(spec)
    } catch (err: unknown) {
      return { kind: 'failed', reason, detail: `沙箱执行异常：${String(err)}` }
    }

    if (result.error) {
      log(
        `[dsh-finance/runner] 感知脚本执行失败（${result.error.kind}）：${result.error.message}`,
      )
      return {
        kind: 'failed',
        reason,
        detail: result.error.message,
        failureKind: result.error.kind,
      }
    }

    // 5) 解析返回值 → 唤醒判定。
    const parsed = parseSensorResult(result.value)
    if (!parsed) {
      return {
        kind: 'skipped',
        reason,
        detail: '脚本返回值非法（缺少 boolean 型 shouldWake）',
        version,
      }
    }
    if (!parsed.shouldWake) {
      return { kind: 'quiet', reason, version }
    }

    const symbol = parsed.symbol ?? '*'
    const summary = parsed.summary ?? `${symbol} 触发感知唤醒`
    const key = `${reason}:${symbol}`
    if (inCooldown(key)) {
      return { kind: 'skipped', reason, detail: '唤醒冷却中', symbol, version }
    }

    let payload: SensorWakePayload = {
      reason,
      symbol,
      summary,
      ...(parsed.metrics === undefined ? {} : { metrics: parsed.metrics }),
      version,
    }
    const bound = boundPayload(payload)
    payload = bound.payload
    const delivered = deliver(payload)
    if (delivered <= 0) {
      return { kind: 'skipped', reason, detail: '无可用 agent，跳过唤醒', symbol, version }
    }
    lastWakeAt.set(key, now())
    return { kind: 'woke', reason, version, symbol, summary, targets: delivered }
  }

  return {
    run,
    runReview: () =>
      runNotice('review', (symbols) =>
        `盘后复盘：请对 ${symbols.length} 个标的依次执行 predict_verify → review_check → review_metrics，命中率劣于阈值时再 review_retrospect。`,
      ),
    runPrep: () =>
      runNotice('prep', (symbols) =>
        `盘前准备：请为 ${symbols.length} 个标的生成当日关注点（方向 / 区间 / 关键观测点）。`,
      ),
    setWaker(next: SensorWaker | undefined): void {
      waker = next
    },
    setPinnedSessionId(id: string | undefined): void {
      pinnedSessionId = id
    },
    getPinnedSessionId(): string | undefined {
      return pinnedSessionId
    },
    setSessionPersistence(persistence: SessionPersistenceLike | undefined): void {
      sessionPersistence = persistence
    },
    getSessionPersistence(): SessionPersistenceLike | undefined {
      return sessionPersistence
    },
  }
}

export type { PtcRunFailureKind }
