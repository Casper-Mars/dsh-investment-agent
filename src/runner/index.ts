/**
 * runner 层入口：装配「感知脚本执行 + 自持调度」并接入插件生命周期。
 *
 * `applyRunner(ctx)`（由 `src/plugin.ts` 的 `apply` 调用）：
 *   1. 经 `ctx.get('ptcRuntime')` 软取 PTC 运行时空服务（**顶层 inject 固定四项，
 *      不新增依赖**；软取使最小上下文下安全降级）；
 *   2. 复用 `createToolContext()` 解析 dataRoot，并共享 Ledger / SenseRegistry；
 *   3. 组装 sensor-runner（只读 bindings + read-only 沙箱策略）；
 *   4. 经 `ctx.inject(['agents'], cb)` **动态注入** agents，作为唤醒通道
 *      （拿不到则降级：仅告警，不中断调度）；
 *   5. `ctx.effect(() => { scheduler.start(); return () => scheduler.stop() })`
 *      —— `apply` 即启动，fiber 卸载（含 HMR）自动 `stop()` 清空 timer。
 *
 * 顶层 `inject = ['tools','skills','ptcRuntime','fs']` **保持不变**。
 */
import type { Context } from '@deepseek-ai/cordis'
import { createToolContext, type ToolContextOptions } from '../tools/context.js'
import { QuoteClient } from '../lib/quotes.js'
import { HttpHolidayProvider } from '../lib/holiday-provider.js'
import { TradingCalendar } from '../lib/trading-calendar.js'
import { createSensorRunner, type SensorRunnerDeps } from './sensor-runner.js'
import { createScheduler, type Scheduler } from './scheduler.js'
import { createAgentWaker, type AgentRegistryLike } from './wake.js'
import type { PtcRuntimeLike, SensorWaker } from './types.js'

export * from './types.js'
export {
  toJsonValue,
} from './json.js'
export {
  createSensorBindings,
  SENSOR_BINDING_GLOBALS,
  SENSOR_READONLY_METHODS,
  DEFAULT_HISTORY_DAYS,
  type SensorBindingSources,
} from './bindings.js'
export {
  buildWakeMessage,
  buildWakeText,
  boundSummary,
  createAgentWaker,
  resolveWakeTargets,
  PLUGIN_SOURCE_NAME,
  WAKE_SUMMARY_MAX_CHARS,
  type AgentLike,
  type AgentRegistryLike,
  type WakeUserMessage,
} from './wake.js'
export {
  createSensorRunner,
  parseSensorResult,
  boundText,
  DEFAULT_SENSOR_TIMEOUT_MS,
  DEFAULT_WAKE_COOLDOWN_MS,
  DEFAULT_BATCH_LIMIT,
  DEFAULT_WAKE_TEXT_BUDGET,
  type SensorRunner,
  type SensorRunnerDeps,
} from './sensor-runner.js'
export {
  createScheduler,
  shanghaiParts,
  isPulseMinute,
  isInPulseWindow,
  nextPulseInstant,
  nextDailyInstant,
  SHANGHAI_TIME_ZONE,
  PULSE_STEP_SECONDS,
  PULSE_WINDOWS,
  REVIEW_MINUTE,
  PREP_MINUTE,
  type Scheduler,
  type SchedulerOptions,
  type ShanghaiParts,
} from './scheduler.js'

/** `applyRunner` 配置。 */
export interface RunnerOptions {
  /** ToolContext 数据根配置（复用 tools 层解析逻辑）。 */
  toolContextOptions?: ToolContextOptions
  /** 单次执行预算（ms）；默认 {@link DEFAULT_SENSOR_TIMEOUT_MS}。 */
  timeoutMs?: number | null
  /** 唤醒冷却（ms）；默认 {@link DEFAULT_WAKE_COOLDOWN_MS}。 */
  wakeCooldownMs?: number
  /** 单次批处理标的数量上界；默认 {@link DEFAULT_BATCH_LIMIT}。 */
  batchLimit?: number
  /** 单次唤醒文本预算（字符）；默认 {@link DEFAULT_WAKE_TEXT_BUDGET}。 */
  wakeTextBudget?: number
  /** 是否启用盘前准备（9:25）；默认启用。 */
  enablePrep?: boolean
  /** 交易日判定覆盖（测试注入；默认实时 HTTP 节假日源 + 周末降级）。 */
  isTradingDay?: (date: Date) => boolean | Promise<boolean>
  /** 行情客户端覆盖（测试注入）。 */
  quotes?: QuoteClient
  /** 日志（默认 `console.log`）。 */
  logger?: (message: string) => void
}

/**
 * 装配并启动机器人感知与调度（自持，随插件生命周期启停）。
 *
 * @param ctx 插件上下文（顶层 inject 已保证 `ptcRuntime` / `fs` 就绪）。
 * @param options 覆盖项（数据根 / 预算 / 交易日判定 / 行情客户端 / 日志）。
 */
export function applyRunner(ctx: Context, options: RunnerOptions = {}): void {
  const log = options.logger ?? ((message: string) => console.log(message))

  // ---- 1) 软取 ptcRuntime（顶层 inject 已含；最小上下文下安全降级） ----
  const ptcRuntime = ctx.get('ptcRuntime') as PtcRuntimeLike | undefined
  if (!ptcRuntime || typeof ptcRuntime.run !== 'function') {
    log('[dsh-finance/runner] 警告 ptcRuntime 不可用，感知执行与调度未启动')
    return
  }

  // ---- 2) 复用 tools 层 dataRoot 解析 + 共享 Ledger / SenseRegistry ----
  const quotes =
    options.quotes ??
    new QuoteClient({ onAlert: (msg: string) => log(`[dsh-finance/runner] 警告 [quote] ${msg}`) })
  // 注入行情源，供工具上下文 review_metrics 计算 cum_return 的「现价」。
  const toolCtx = createToolContext({ quotes, ...(options.toolContextOptions ?? {}) })

  // ---- 3) 组装 sensor-runner ----
  const runnerDeps: SensorRunnerDeps = {
    senseRegistry: toolCtx.senseRegistry,
    ledger: toolCtx.ledger,
    quotes,
    ptcRuntime,
    dataRoot: toolCtx.dataRoot,
    timeoutMs: options.timeoutMs,
    wakeCooldownMs: options.wakeCooldownMs,
    batchLimit: options.batchLimit,
    wakeTextBudget: options.wakeTextBudget,
    logger: log,
  }
  const runner = createSensorRunner(runnerDeps)

  // ---- 4) 动态注入 agents 作为唤醒通道（拿不到则降级） ----
  ctx.inject(['agents'], (agentCtx) => {
    const agents = agentCtx.get('agents') as AgentRegistryLike | undefined
    if (!agents || typeof agents.list !== 'function') {
      log('[dsh-finance/runner] 警告 agents 服务不可用，唤醒将降级为跳过')
      return
    }
    const waker: SensorWaker = createAgentWaker(agents, log)
    runner.setWaker(waker)
    log('[dsh-finance/runner] 唤醒通道已就绪（agents 服务）')
  })

  // ---- 5) 交易日判定（默认实时节假日源，失败降级为纯周末判定） ----
  const calendar = new TradingCalendar(new HttpHolidayProvider(), { onAlert: log })
  const isTradingDay =
    options.isTradingDay ?? ((date: Date) => calendar.isTradingDay(date))

  // ---- 6) 自持调度：apply 即启动，随 effect 卸载 stop() ----
  const scheduler: Scheduler = createScheduler({
    isTradingDay,
    onPulse: () => runner.run('pulse'),
    onReview: () => runner.runReview(),
    onPrep: options.enablePrep === false ? undefined : () => runner.runPrep(),
    logger: log,
  })

  ctx.effect(() => {
    scheduler.start()
    return () => scheduler.stop()
  }, 'dsh-finance runner')
}
