/**
 * scheduler/wake.ts —— 唤醒投递器（把 shouldWake=true 的任务 data 定点投递给固定会话）。
 *
 * 唯一权威设计文档：《感知层详细设计（dsh-finance 插件）》 v0.7，§8（定点投递 /
 * 消息源 / 正文组装）、§9.1~§9.3（降级 / 文本预算 / 冷却）。
 *
 * 职责（§8「定点投递」）：
 * 任务程序被判读为「唤醒」后，waker 负责把其 `data`（唤醒正文）投递给固定会话
 * `investment-advisor`。正文 = `data 原文 + 末尾合规声明`（§8.4）；消息源复用
 * `message-source.ts` 的 {@link createNoticeMessage}（producer kind `'dsh-finance'` +
 * `form: 'notice'`），**不自行造 producer kind，禁用 V3 退役的 `'plugin'` 包装**。
 *
 * 三段安全护栏（§9）：
 *   - **降级语义（§9.1）**：waker 未配置 / 固定会话不可达 / 投递异常 → 返回
 *     `skipped`（投递数 0），**不抛异常、不中断调度**。
 *   - **文本预算（§9.2 / §9.3）**：`wakeTextBudget`（默认 2000 字符），`data` 超出
 *     时截断（保留前 N 字符）；体现 `boundPayload` 语义。
 *   - **冷却（§9.3）**：`wakeCooldownMs`（默认 5 分钟），按 `task_id` 记录最近一次
 *     成功投递时刻，冷却窗口内不重复唤醒；`cooldownMs <= 0` 关闭冷却。
 *
 * 可注入设计（§8.2 / 对齐 types.ts）：
 *   - `agents`：agent 注册表（最小结构 {@link AgentRegistryLike}，定点取
 *     `investment-advisor`）。
 *   - `clock`：时钟源（{@link Clock}），冷却判定用。
 *   - `wakeTextBudget` / `wakeCooldownMs`：预算 / 冷却参数可注入，不写死全局单例。
 *
 * 纯 TS；结构等价最小类型，复用 types.ts 已声明的 AgentLike / AgentRegistryLike /
 * Clock，不硬依赖 harness 重包。
 */

import type { Clock, AgentLike, AgentRegistryLike } from './types.js'
import { RISK_DISCLAIMER } from '../tools/constants.js'
import { createNoticeMessage, type NoticeUserMessage } from '../message-source.js'
import { PINNED_SESSION_ID } from '../session.js'

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/**
 * 固定会话 id（§8.1「investment-advisor」）。
 *
 * 别名：复用 {@link PINNED_SESSION_ID}（`src/session.ts`）作为单一事实来源，
 * 避免会话 id 字面量在多处重复硬编码（DRY）。保留本别名以兼容既有 import /
 * `scheduler/index.ts` 的 re-export。
 */
export const WAKE_TARGET_ID = PINNED_SESSION_ID

/** 缺省唤醒正文预算（字符数，§9.2 / §9.3）。data 超出时截断保留前 N 字符。 */
export const DEFAULT_WAKE_TEXT_BUDGET = 2000

/** 缺省冷却窗口（毫秒，§9.3，默认 5 分钟）。同一 task_id 在窗口内不重复唤醒。 */
export const DEFAULT_WAKE_COOLDOWN_MS = 5 * 60 * 1000

/** notice 摘要（summary）字符上限（message-source 要求 ≤ 120 字符）。 */
const SUMMARY_MAX_LEN = 120

// ---------------------------------------------------------------------------
// 可注入类型契约（最小结构，对齐 types.ts 可注入风格）
// ---------------------------------------------------------------------------

/**
 * waker 的依赖注入配置（工厂参数，§8.2）。
 */
export interface WakerOptions {
  /** agent 注册表（定点取 {@link WAKE_TARGET_ID}）；必填。 */
  readonly agents: AgentRegistryLike
  /** 时钟源；缺省用系统时间。 */
  readonly clock?: Clock
  /** 唤醒正文预算（字符数）；缺省 {@link DEFAULT_WAKE_TEXT_BUDGET}。 */
  readonly wakeTextBudget?: number
  /** 冷却窗口（毫秒）；缺省 {@link DEFAULT_WAKE_COOLDOWN_MS}，`<= 0` 关闭冷却。 */
  readonly wakeCooldownMs?: number
  /** 投递日志钩子（可选，用于诊断 / 测试观测）。 */
  readonly log?: (level: 'info' | 'warn' | 'error', message: string) => void
}

/**
 * 单次唤醒投递的结果（§9 / §9.1）。
 *
 * 成功（`delivered: true`）返回投递数 1 与回填的 targets；降级（waker 未配置 /
 * 固定会话不可达 / 投递异常）返回 `delivered: false`（投递数 0），不抛异常。
 */
export interface WakeDeliveryResult {
  /** 是否成功投递。 */
  readonly delivered: boolean
  /** 投递数（成功 1，降级 0）。§9.1 */
  readonly count: number
  /** 投递目标列表（成功时为 `[WAKE_TARGET_ID]`，降级为空）。§9 / §8.4 */
  readonly targets: readonly string[]
  /** 结果说明（人类可读）。 */
  readonly reason: string
}

// ---------------------------------------------------------------------------
// 正文组装（可独立导出 + 单测）
// ---------------------------------------------------------------------------

/**
 * 组装唤醒正文：`data 原文 + "\n\n> 本内容不构成投资建议"`（§8.4）。
 *
 * 合规声明与 `src/tools/constants.ts` 的 {@link RISK_DISCLAIMER} 一致，
 * 通过 `withDisclaimer` 保持单一事实来源。
 *
 * @param data 任务返回的唤醒正文原文（已按预算截断）。
 * @returns 末尾附合规声明的完整正文。
 */
export function buildWakeText(data: string): string {
  return `${data}\n\n> ${RISK_DISCLAIMER}`
}

/**
 * 从 `data` 派生 notice 一行摘要（≤ 120 字符，对齐 message-source 的 summary 要求）。
 *
 * 规则：取 `data` 首行（去首尾空白）作为摘要；若首行超过上限则截断；
 * 若 `data` 无有效首行（空串 / 全空白）则用固定占位。
 *
 * @param data 唤醒正文原文。
 * @returns notice 摘要（≤ 120 字符），用于 {@link createNoticeMessage} 的 `summary`。
 */
export function deriveSummary(data: string): string {
  const firstLine = data.split('\n').map((l) => l.trim()).find((l) => l.length > 0) ?? ''
  const base = firstLine.length > 0 ? firstLine : '感知唤醒'
  return base.length > SUMMARY_MAX_LEN ? base.slice(0, SUMMARY_MAX_LEN) : base
}

/**
 * 文本预算约束：`data` 超过 `budget` 时截断，保留前 `budget` 字符（§9.2「boundPayload」）。
 */
export function boundPayload(data: string, budget: number): string {
  if (budget <= 0) return data
  return data.length > budget ? data.slice(0, budget) : data
}

// ---------------------------------------------------------------------------
// 时钟缺省实现
// ---------------------------------------------------------------------------

/** 系统时钟（复用 types.ts 的 {@link Clock} 契约）。 */
function createSystemClock(): Clock {
  return { now: () => new Date() }
}

/** 无日志钩子注入时的缺省行为：静默。 */
const NOOP_LOG = (): void => {}

// ---------------------------------------------------------------------------
// Waker 主体
// ---------------------------------------------------------------------------

/**
 * 唤醒投递器：把 shouldWake=true 的任务 `data` 定点投递给固定会话 `investment-advisor`。
 *
 * 通过 {@link createWaker} 创建（依赖可注入）。职责单一：取出 woke 的 data →
 * boundPayload 截断 → buildWakeText → 冷却检查 → createNoticeMessage → 定点
 * followup → 回填 targets。任何一步异常 → `delivered: false`（降级），不抛异常。
 */
export class Waker {
  /** agent 注册表（注入）。 */
  private readonly agents: AgentRegistryLike
  /** 时钟源（注入）。 */
  private readonly clock: Clock
  /** 唤醒正文预算（字符数）。 */
  private readonly wakeTextBudget: number
  /** 冷却窗口（毫秒，<= 0 关闭冷却）。 */
  private readonly wakeCooldownMs: number
  /** 投递日志钩子（注入，可空）。 */
  private readonly log: (level: 'info' | 'warn' | 'error', message: string) => void

  /**
   * 每个 task_id 最近一次「成功投递」时刻（毫秒时间戳），冷却判定用（§9.3）。
   *
   * 仅在投递成功时写入（降级不写），这样冷却只挡「连续成功唤醒」的重复投递，
   * 不会因一次失败而让后续窗口内的成功唤醒被误吞。
   */
  private readonly lastDeliveredAt = new Map<string, number>()

  constructor(options: WakerOptions) {
    this.agents = options.agents
    this.clock = options.clock ?? createSystemClock()
    this.wakeTextBudget = options.wakeTextBudget ?? DEFAULT_WAKE_TEXT_BUDGET
    this.wakeCooldownMs = options.wakeCooldownMs ?? DEFAULT_WAKE_COOLDOWN_MS
    this.log = options.log ?? NOOP_LOG
  }

  /**
   * 投递一条唤醒消息到固定会话。
   *
   * 完整流程（synced，§8 / §9）：
   *   1. boundPayload 截断（§9.2 文本预算）；
   *   2. buildWakeText 组装正文（data + 合规声明，§8.4）；
   *   3. 冷却检查（§9.3）：同 task_id 冷却窗口内已成功投递 → skipped；
   *   4. 定点取固定会话 {@link WAKE_TARGET_ID}；缺失 / 无 followup → skipped；
   *   5. createNoticeMessage(text, summary) 构造消息（复用 message-source，§8.3）；
   *   6. agent.followup(...) 投递；异常 → skipped；
   *   7. 记录成功投递时刻 + 回填 targets。
   *
   * 任何一步异常 → 返回 `delivered: false`（`count: 0`），**不抛异常、不中断调度**（§9.1）。
   *
   * @param taskId  任务 id（冷却键，§9.3）。
   * @param data    任务返回的唤醒正文原文（§5.3 / §9）。
   * @returns 投递结果（成功 / 降级，均不抛异常）。
   */
  wake(taskId: string, data: string): WakeDeliveryResult {
    try {
      // 1. 文本预算截断（§9.2 / §9.3 boundPayload）。
      const bounded = boundPayload(data, this.wakeTextBudget)

      // 2. 组装正文（§8.4）。
      const text = buildWakeText(bounded)

      // 3. 冷却检查（§9.3）：cooldownMs > 0 且窗口内已成功投递 → 跳过。
      if (this.isInCooldown(taskId)) {
        const reason = `[wake] 任务 ${taskId} 处于冷却窗口内，跳过重复唤醒`
        this.log('info', reason)
        return { delivered: false, count: 0, targets: [], reason }
      }

      // 4. 定点取固定会话（§8.1）。
      const agent = this.agents.get(WAKE_TARGET_ID)
      if (!agent || typeof agent.followup !== 'function') {
        const reason = `[wake] 固定会话 ${WAKE_TARGET_ID} 不可达（无 followup），降级 skipped`
        this.log('warn', reason)
        return { delivered: false, count: 0, targets: [], reason }
      }

      // 5. 复用 message-source 构造 notice 消息（§8.3，禁用 V3 'plugin' 包装）。
      const summary = deriveSummary(bounded)
      const message = createNoticeMessage(text, summary)

      // 6. 投递。
      //
      // 类型桥接说明：types.ts 的 AgentLike.followup 参数是最小结构本地类型
      // `NoticeUserMessage`（`{kind, text}`），而 message-source 的 `createNoticeMessage`
      // 返回真实 harness `UserMessage`（`source.kind === 'dsh-finance'` +
      // `source.form === 'notice'` + `content`）。二者是同一概念的两套结构表述：
      // 本模块按任务要求「复用 createNoticeMessage（不重写/不自行造 kind）」产出真实
      // 消息，仅在此处做一次无信息损失的窄化桥接以对齐 types.ts 的最小结构契约。
      try {
        agent.followup(message as unknown as Parameters<AgentLike['followup']>[0])
      } catch (err) {
        const reason = `[wake] 投递到 ${WAKE_TARGET_ID} 异常，降级 skipped: ${String(err)}`
        this.log('error', reason)
        return { delivered: false, count: 0, targets: [], reason }
      }

      // 7. 记录成功投递时刻（冷却键）+ 回填 targets。
      this.lastDeliveredAt.set(taskId, this.clock.now().getTime())

      return {
        delivered: true,
        count: 1,
        targets: [WAKE_TARGET_ID],
        reason: `[wake] 已唤醒并投递到 ${WAKE_TARGET_ID}`,
      }
    } catch (err) {
      // 兜底降级：任何未预期异常（异常契约实现）→ skipped，不抛异常（§9.1）。
      const reason = `[wake] 唤醒投递失败（已降级）: ${String(err)}`
      this.log('error', reason)
      return { delivered: false, count: 0, targets: [], reason }
    }
  }

  /**
   * 冷却判定：`cooldownMs > 0` 且该 `taskId` 最近成功投递时刻距今未过窗口 → 在冷却内。
   */
  private isInCooldown(taskId: string): boolean {
    if (this.wakeCooldownMs <= 0) return false
    const lastAt = this.lastDeliveredAt.get(taskId)
    if (lastAt === undefined) return false
    return this.clock.now().getTime() - lastAt < this.wakeCooldownMs
  }
}

// ---------------------------------------------------------------------------
// 工厂
// ---------------------------------------------------------------------------

/**
 * 创建唤醒投递器的工厂函数（无副作用工厂，对齐 types.ts 可注入风格）。
 *
 * @param options 依赖注入配置（agents 必填；clock / wakeTextBudget / wakeCooldownMs / log 可选）。
 * @returns 就绪的 {@link Waker} 实例。
 */
export function createWaker(options: WakerOptions): Waker {
  return new Waker(options)
}

export type { NoticeUserMessage }