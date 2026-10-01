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
     * @persistenceAttribution
     */
    'dsh-finance': { kind: 'dsh-finance' } & ContextFormed
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
 * @returns 冻结的 user 消息，`source.kind === 'dsh-finance'`、`form === 'notice'`。
 */
export function createNoticeMessage(text: string, summary: string): NoticeUserMessage {
  const source: NoticeMessageSource = {
    kind: PRODUCER_KIND,
    form: 'notice',
    summary,
  }
  return createUserMessage({
    content: [{ type: 'text', text }],
    source,
  })
}
