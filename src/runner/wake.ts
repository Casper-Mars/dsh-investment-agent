/**
 * runner 层：唤醒 agent（shouldWake=true 时投递）。
 *
 * 定点投递（Task-11，§9.3）：唤醒**只**投递到固定会话
 * `PINNED_SESSION_ID` 对应的 agent，不再做 `currentInitiator → roots → list`
 * 的动态解析。原因：多会话环境下动态解析的投递目标不确定，且「定时唤醒的
 * 会话」与「用户对话的会话」可能不是同一个，导致上下文割裂。
 *
 * 已核对的 harness 契约：
 *   - 唤醒模式：`agent.followup(createUserMessage({ content, source }))`
 *     （见 `packages/subagent/subagent-in-process-driver/src/index.ts`、
 *      `packages/jobs/tool-jobs/src/index.ts` 的 `owner.followup(...)`）；
 *   - `ctx.agents.get(id: SessionId): Agent | undefined`
 *     （`packages/core/agent/src/index.ts` L566，服务名 `agents`）；
 *   - `agent` 运行时面（`@deepseek-ai/dsh-agent` 声明合并）提供
 *     `.followup(msg)`（排队 follow-up turn 并唤醒）/ `.inject(msg)`（不唤醒）/ `.status`。
 *
 * 本模块不引入上述包（顶层不可解析），改为：
 *   1. 用**结构等价的**最小类型描述 agent / registry / message；
 *   2. 本地构造 UserMessage（`id` 取 `randomUUID()`；`MessageId` 是编译期 brand，
 *      运行时即普通字符串，故结构等价）；
 *   3. **降级固定为 skip**（NFR-03）：固定会话不可达（`get` 未命中 / registry
 *      不可用 / 投递抛错）时记日志并返回 0，**不抛异常、不中断调度链**，
 *      **不提供配置开关**。
 */
import { randomUUID } from 'node:crypto'
import type { PtcJsonValue, SensorRunReason, SensorWakePayload, SensorWaker } from './types.js'
import { RISK_DISCLAIMER } from '../tools/constants.js'
import { PINNED_SESSION_ID } from '../session.js'

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

/** `ctx.agents`（AgentRegistry）的最小结构契约。
 *
 * 定点投递只需要 `get(id)`；`list` / `roots` / `currentInitiator` 保留为可选
 * 以维持与 harness `AgentRegistry` 的结构兼容（本模块不再使用它们做目标解析）。
 */
export interface AgentRegistryLike {
  get(id: string): AgentLike | undefined
  list?(): AgentLike[]
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
  lines.push('', `> ${RISK_DISCLAIMER}`)
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
 * 定点解析：取固定会话对应的 agent（不抛异常，未命中返回 `undefined`）。
 *
 * 仅当 `agents.get(pinnedId)` 命中且 `followup` 可调用时才返回该 agent；
 * `get` 抛错（registry 不可用）时视为未命中。
 *
 * @param agents `ctx.agents` 结构替身。
 * @param pinnedId 固定会话 id（`PINNED_SESSION_ID`）。
 * @returns 命中且可投递的目标 agent，否则 `undefined`。
 */
export function resolveWakeTarget(
  agents: AgentRegistryLike,
  pinnedId: string,
): AgentLike | undefined {
  let agent: AgentLike | undefined
  try {
    agent = agents.get(pinnedId)
  } catch {
    agent = undefined
  }
  if (agent && typeof agent.followup === 'function') return agent
  return undefined
}

/**
 * 基于 `ctx.agents` 构造**定点**唤醒通道（固定会话）。
 *
 * 返回的 waker **绝不抛异常**：固定会话不可达时返回 0（调度不受影响）。
 * 盘中脉冲 / 盘后复盘 / 盘前准备三条路径共用本 waker（同此一路径）。
 *
 * @param agents `ctx.agents` 结构替身。
 * @param pinnedId 固定会话 id（`PINNED_SESSION_ID`）。
 * @param logger 日志（默认 `console.log`）。
 * @returns 唤醒通道函数（返回实际投递的会话数：0 或 1）。
 */
export function createAgentWaker(
  agents: AgentRegistryLike,
  pinnedId: string = PINNED_SESSION_ID,
  logger: (message: string) => void = (message) => console.log(message),
): SensorWaker {
  return (payload: SensorWakePayload): number => {
    let agent: AgentLike | undefined
    try {
      agent = resolveWakeTarget(agents, pinnedId)
    } catch (err: unknown) {
      logger(`[dsh-finance/runner] 警告 解析唤醒目标失败，跳过唤醒：${String(err)}`)
      return 0
    }
    if (!agent) {
      logger(
        `[dsh-finance/runner] 警告 固定会话不可达（${pinnedId}），跳过唤醒（降级）`,
      )
      return 0
    }
    try {
      agent.followup(buildWakeMessage(payload))
      logger(
        `[dsh-finance/runner] 已投递唤醒（固定会话 ${pinnedId}）：${payload.symbol}`,
      )
      return 1
    } catch (err: unknown) {
      logger(`[dsh-finance/runner] 警告 唤醒 agent(${agent.id}) 失败：${String(err)}`)
      return 0
    }
  }
}

/** 便捷类型别名（供 index 组装）。 */
export type { SensorWaker, SensorWakePayload, PtcJsonValue }
