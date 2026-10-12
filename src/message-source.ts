/**
 * dsh-finance 生产者消息源契约（V4 producer-owned source kind）。
 *
 * 背景（Task-15 修复轮 2 · 阻断缺陷）：旧实现用 V3 退役的「plugin 包装」形态
 * （`source.kind` 取退役字符串 `'plugin'` 并额外携带 `plugin` 字段），被 harness
 * `session-format-v3-to-v4` 的 `source()` 校验拒绝（`kind === 'plugin'` 即抛
 * `SessionFormatError('format v4 message requires a producer-owned source kind')`），
 * 导致 notice / 唤醒消息在起 turn 写入会话时被 codec 拒绝 → `turn/start` 不落盘 →
 * 固定会话恒 blank（AC1 失败、AC2 随之失效）。
 *
 * 修复（对齐 harness 官方契约，参考 `packages/context/tmux-context/src/index.ts`）：
 *   1. 声明 producer 自有 kind `'dsh-finance'`（非空字符串且 ≠ `'plugin'`）；
 *   2. 经 `declare module '@deepseek-ai/dsh-llm'` 增补 `MessageSourceMap`；
 *   3. 用官方 `createUserMessage(...)` 构造消息（冻结 + 稳定 id）。
 *
 * `@deepseek-ai/dsh-llm` 是 harness 核心包（版本 `0.2.0-rc.2`，与 dsh-skill /
 * dsh-tools 同法声明为 peerDependency + devDependency）。
 */
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContextFormed, UserMessage } from '@deepseek-ai/dsh-llm'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /**
     * dsh-finance 感知唤醒 / 开场 notice 的生产者归属。
     * 消费者按 kind 保留该来源，投影据此去重。
     *
     * `traceId`（可选）为 M4 引入的跨进程关联锚点：唤醒消息**显式**携带，
     * 使「触发 → 唤醒 → 研判」链路可被同一 traceId 串联（不依赖 ALS 跨进程传播）。
     * 生产者为自有 kind，可附加自有字段；harness 原生 source 准入仅校验
     * `kind`（非空且 ≠ `plugin`）并**保留未知归属字段**，故为向后兼容的加法扩展。
     * @persistenceAttribution
     */
    'dsh-finance': { kind: 'dsh-finance' } & ContextFormed & { readonly traceId?: string }
  }
}

/** dsh-finance 生产者自有 kind（V4 要求非空字符串且 ≠ `'plugin'`）。 */
export const PRODUCER_KIND = 'dsh-finance' as const

/**
 * notice 形态的消息源：`form: 'notice'` 要求携带 `summary`（one-line account）。
 * `kind` 固定为 {@link PRODUCER_KIND}，不再携带退役的 `plugin` 字段。
 */
export type NoticeMessageSource = {
  readonly kind: typeof PRODUCER_KIND
  readonly form: 'notice'
  readonly summary: string
  /**
   * 跨进程关联锚点（M4，可选）。唤醒链路经消息**显式**携带；无 trace 时
   * **不写该字段**（保持既有 notice 形态逐字不变）。
   */
  readonly traceId?: string
}

/** notice 形态的 user 消息（`role: 'user'`，source 为 dsh-finance notice）。 */
export type NoticeUserMessage = UserMessage & {
  readonly role: 'user'
  readonly source: NoticeMessageSource
}

/**
 * 构造一条 notice 形态的 user 消息（官方 `createUserMessage`：冻结 + 稳定 id）。
 *
 * @param text 模型可见正文。
 * @param summary notice 一行摘要（≤ 120 字符）。
 * @param traceId 可选跨进程关联锚点（M4）；缺省（`undefined`）时**不写**该字段。
 * @returns 冻结的 user 消息，`source.kind === 'dsh-finance'`、`form === 'notice'`。
 */
export function createNoticeMessage(
  text: string,
  summary: string,
  traceId?: string,
): NoticeUserMessage {
  const source: NoticeMessageSource = {
    kind: PRODUCER_KIND,
    form: 'notice',
    summary,
    ...(traceId === undefined ? {} : { traceId }),
  }
  return createUserMessage({
    content: [{ type: 'text', text }],
    source,
  })
}
