/**
 * runner 层：唤醒 agent（shouldWake=true 时投递）。
 *
 * 已核对的 harness 契约：
 *   - 唤醒模式：`agent.followup(createUserMessage({ content, source }))`
 *     （见 `packages/subagent/subagent-in-process-driver/src/index.ts`、
 *      `packages/jobs/tool-jobs/src/index.ts` 的 `owner.followup(...)`）；
 *   - `createUserMessage` 来自 `@deepseek-ai/dsh-llm`，产物是
 *     `{ id, role:'user', content: ContentBlock[], source: MessageSource }`
 *     （冻结的不可变消息）；
 *   - `source` 取 `{ kind:'plugin', plugin, form:'notice', summary }`
 *     （notice 形态：一行摘要 + 正文）；
 *   - `agent` 运行时面（`@deepseek-ai/dsh-agent` 声明合并）提供
 *     `.followup(msg)`（排队 follow-up turn 并唤醒）/ `.inject(msg)`（不唤醒）/ `.status`。
 *
 * 本模块不引入上述包（顶层不可解析），改为：
 *   1. 用**结构等价的**最小类型描述 agent / registry / message；
 *   2. 本地构造 UserMessage（`id` 取 `randomUUID()`；`MessageId` 是编译期 brand，
 *      运行时即普通字符串，故结构等价）；
 *   3. **降级**：拿不到 agent（无活跃会话 / registry 不可用）时记日志并返回 0，
 *      **不抛异常、不中断调度**。
 *
 * 目标 agent 解析策略（`ctx.agents`，已核对 `packages/core/agent/src/index.ts`）：
 *   1. 若存在 initiator 上下文 → 用 `currentInitiator()`（同进程因果归属）；
 *   2. 否则用 `roots()`（无 owner 的顶层 agent，排除子 agent）；
 *   3. 再否则退回 `list()`；仍为空 → 降级跳过。
 */
import { randomUUID } from 'node:crypto'
import type { PtcJsonValue, SensorRunReason, SensorWakePayload, SensorWaker } from './types.js'

/** 投递消息的插件源标识。 */
export const PLUGIN_SOURCE_NAME = 'dsh-finance'

/** notice 摘要长度上限（对齐 harness `CONTEXT_SUMMARY_MAX_CHARS`）。 */
export const WAKE_SUMMARY_MAX_CHARS = 120

/** 程序（模型）可见的文本内容块。 */
export interface WakeContentBlock {
  type: 'text'
  text: string
}

/** 插件 notice 形态的消息源。 */
export interface WakeMessageSource {
  kind: 'plugin'
  plugin: string
  form: 'notice'
  summary: string
}

/** 结构等价的 `UserMessage`。 */
export interface WakeUserMessage {
  id: string
  role: 'user'
  content: WakeContentBlock[]
  source: WakeMessageSource
  [key: string]: unknown
}

/** agent 的最小结构契约（运行时面）。 */
export interface AgentLike {
  readonly id: string
  followup(message: WakeUserMessage): void
  inject?(message: WakeUserMessage): void
  readonly status?: 'idle' | 'running'
}

/** `ctx.agents`（AgentRegistry）的最小结构契约。 */
export interface AgentRegistryLike {
  list(): AgentLike[]
  get(id: string): AgentLike | undefined
  roots?(): AgentLike[]
  currentInitiator?(): AgentLike | undefined
}

/** 触发原因的中文标签。 */
const REASON_LABEL: Record<SensorRunReason, string> = {
  pulse: '盘中脉冲',
  review: '盘后复盘',
  prep: '盘前准备',
  manual: '手动触发',
}

/** 将通知摘要限制在上限内（超出省略）。 */
export function boundSummary(summary: string, max: number = WAKE_SUMMARY_MAX_CHARS): string {
  return summary.length <= max ? summary : `${summary.slice(0, max - 1)}…`
}

/** 组装唤醒正文（供 agent 研判）。 */
export function buildWakeText(payload: SensorWakePayload): string {
  const label = REASON_LABEL[payload.reason] ?? payload.reason
  const head =
    payload.symbol && payload.symbol !== '*'
      ? `【感知唤醒·${label}】标的 ${payload.symbol}`
      : `【感知唤醒·${label}】全部标的`
  const lines = [head, '', payload.summary]
  if (payload.metrics !== undefined) {
    lines.push('', `metrics: ${JSON.stringify(payload.metrics)}`)
  }
  if (payload.version) {
    lines.push('', `（感知脚本版本：${payload.version}）`)
  }
  return lines.join('\n')
}

/**
 * 构造一条唤醒 UserMessage（结构等价 `createUserMessage` 的产物）。
 *
 * @param payload 唤醒载荷。
 * @param idFactory 消息 id 工厂（默认 `randomUUID`，便于测试注入）。
 */
export function buildWakeMessage(
  payload: SensorWakePayload,
  idFactory: () => string = randomUUID,
): WakeUserMessage {
  return {
    id: idFactory(),
    role: 'user',
    content: [{ type: 'text', text: buildWakeText(payload) }],
    source: {
      kind: 'plugin',
      plugin: PLUGIN_SOURCE_NAME,
      form: 'notice',
      summary: boundSummary(payload.summary),
    },
  }
}

/**
 * 解析唤醒目标 agent（不抛异常，返回可能为空的数组）。
 *
 * @param agents `ctx.agents` 结构替身。
 * @returns 目标 agent 列表（去重）。
 */
export function resolveWakeTargets(agents: AgentRegistryLike): AgentLike[] {
  const initiator = agents.currentInitiator?.()
  if (initiator) return [initiator]

  const roots = agents.roots?.() ?? []
  const primary = roots.length > 0 ? roots : agents.list()

  const seen = new Set<string>()
  const out: AgentLike[] = []
  for (const agent of primary) {
    if (!agent || typeof agent.followup !== 'function') continue
    if (seen.has(agent.id)) continue
    seen.add(agent.id)
    out.push(agent)
  }
  return out
}

/**
 * 基于 `ctx.agents` 构造唤醒通道。
 *
 * 返回的 waker **绝不抛异常**：无可用 agent 时返回 0（调度不受影响）。
 *
 * @param agents `ctx.agents` 结构替身。
 * @param logger 日志（默认 `console.log`）。
 * @returns 唤醒通道函数（返回实际投递的会话数）。
 */
export function createAgentWaker(
  agents: AgentRegistryLike,
  logger: (message: string) => void = (message) => console.log(message),
): SensorWaker {
  return (payload: SensorWakePayload): number => {
    let targets: AgentLike[]
    try {
      targets = resolveWakeTargets(agents)
    } catch (err: unknown) {
      logger(`[dsh-finance/runner] 警告 解析唤醒目标失败，跳过唤醒：${String(err)}`)
      return 0
    }
    if (targets.length === 0) {
      logger('[dsh-finance/runner] 警告 无活跃 agent 会话，跳过唤醒（降级）')
      return 0
    }
    let delivered = 0
    for (const agent of targets) {
      try {
        agent.followup(buildWakeMessage(payload))
        delivered += 1
      } catch (err: unknown) {
        logger(`[dsh-finance/runner] 警告 唤醒 agent(${agent.id}) 失败：${String(err)}`)
      }
    }
    if (delivered > 0) {
      logger(
        `[dsh-finance/runner] 已投递唤醒（${delivered} 个会话）：${payload.symbol}`,
      )
    }
    return delivered
  }
}

/** 便捷类型别名（供 index 组装）。 */
export type { SensorWaker, SensorWakePayload, PtcJsonValue }
