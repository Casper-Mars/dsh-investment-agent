/**
 * 开场 notice 投递（Task-15 AC1，§9.7 v1.6）：固定会话「blank → 非 blank」。
 *
 * 问题根因（Tester 已定位，harness 事实）：固定会话经 `ctx.agents.create` 建立
 * 后**从未发生 `turn/start` 事件**，而 `session-controller` 的
 * `applySessionListMetadata` 中 `sessionListMetadata.blank` 恒为 true（`init` 即
 * `{ blank: true }`，仅当 `event.type === 'turn/start'` 才翻转为 false），前端
 * `sessionVisible` 据此把 `blank && id !== current` 的会话过滤掉 → 左侧列表不可见。
 *
 * 解决方案（用户决策 A）：ensure 成功 + workspace 归属之后，向固定会话投递
 * **一次性「开场 notice」**，触发首个 `turn/start`，使会话脱离 blank 状态。
 *
 * 关键判据（**一次性 = 会话是否 blank**，而非 ensure 结局）：
 *   - 会话只要尚未发生 `turn/start` 即视为 blank → 投递一次；
 *   - 已发生 `turn/start`（非 blank）→ 不投递（重启不重复；自愈）。
 *   之所以不能用 `outcome === 'created'` 作判据：已持久化但零事件的固定会话
 *   首次启动走 **resume 分支**，仍需补投开场 notice。
 *
 * blank 判读优先级（择一命中即返回，尽量少开句柄）：
 *   1. 软取 `sessionProjections.stateOf(session, 'sessionListMetadata').blank`
 *      —— web 宿主有 `sessionListMetadata` 投影（headless 常无 → 降级）；
 *   2. `sessionPersistence.open(id,'read')` → `handle.read(0)` 检查是否存在
 *      `type === 'turn/start'` —— 两种宿主（web / headless）、resume / created
 *      分支均可用，最可靠；
 *   3. `sessionPersistence.stat(id).eventCount === 0` —— JSONL 后端 `stat` 不返回
 *      `eventCount`（恒 undefined），仅作兜底快速路径。
 *
 * 本模块采用定点投递 + 降级语义：
 *   1. 消息形态用官方 `createUserMessage`（`@deepseek-ai/dsh-llm`）构造，
 *      `source.kind` 取 producer 自有 kind `'dsh-finance'`（V4 契约，非退役的
 *      `'plugin'` 包装，见 `src/message-source.ts`），`form: 'notice'` + `summary`；
 *   2. 投递目标固定为 `agents.get(PINNED_SESSION_ID)`，`followup(openingNotice)`；
 *   3. 降级固定为 **skip**：`agents` 不可达 / `followup` 抛错 / 判读失败 → 记日志、
 *      skip，不抛异常、不中断装载；不影响 ensure 与 workspace 归属。
 */
import {
  createNoticeMessage,
  type NoticeUserMessage,
} from './message-source.js'
import {
  PINNED_SESSION_ID,
  type SessionEventLike,
  type SessionHandleLike,
  type SessionPersistenceLike,
} from './session.js'

/** 开场 notice 正文（固定文案，触发 `turn/start` 用）。 */
export const OPENING_NOTICE_TEXT =
  '【投资顾问已就绪】固定会话已启动。交易日盘中我会推送感知研判；现在请简短回复一句，确认你已在线。'

/** notice 摘要长度上限（对齐 harness `CONTEXT_SUMMARY_MAX_CHARS`，简单截断）。 */
export const OPENING_NOTICE_SUMMARY = '固定会话已启动，等待在线确认'

/** 支持 `followup` 投递的 agent 最小结构替身（与 `wake.ts` 的 `AgentLike` 同构）。 */
export interface OpeningNoticeAgent {
  readonly id: string
  followup(message: NoticeUserMessage): void
  /** live Session 对象（web 宿主；供 `sessionListMetadata` 投影软取）。 */
  readonly session?: unknown
}

/** `ctx.agents` 的最小结构替身（只需 `get`）。 */
export interface OpeningNoticeAgents {
  get(id: string): OpeningNoticeAgent | undefined
}

/** `sessionProjections.stateOf` 的最小结构替身（web 宿主软取用）。 */
export interface SessionProjectionsLike {
  stateOf?(session: unknown, key: string): unknown
}

/** 供单测注入的判读 + 投递依赖。 */
export interface OpeningNoticeDeps {
  /** 活跃 agent 注册表（`ctx.agents` 结构替身）。 */
  agents: OpeningNoticeAgents
  /** 会话持久化服务（`ctx.sessionPersistence` 结构替身）。 */
  sessionPersistence: {
    /** 判读 blank：打开只读句柄读事件日志（不存在抛错 → 视为判读失败）。 */
    open(id: string, access: 'read'): Promise<SessionHandleLike>
    /** 兜底快速路径：事件计数（JSONL 后端通常不返回，可 undefined）。 */
    stat?(id: string): Promise<{ eventCount?: number } | undefined>
  }
  /** 软取 blank 投影（web 宿主有 `sessionListMetadata`，headless 常无）。 */
  sessionProjections?: SessionProjectionsLike
  /** 投递目标会话 id（默认 `PINNED_SESSION_ID`）。 */
  pinnedId?: string
  /** 日志（默认 `console.log`）。 */
  logger?: (message: string) => void
}

/**
 * 构造一条开场 notice UserMessage（官方 `createUserMessage` 产物，`source.kind`
 * 为 producer 自有 `'dsh-finance'`、`form: 'notice'`）。
 */
export function buildOpeningNoticeMessage(): NoticeUserMessage {
  return createNoticeMessage(OPENING_NOTICE_TEXT, OPENING_NOTICE_SUMMARY)
}

/**
 * 判读会话是否 blank（尚未发生 `turn/start`）。
 *
 * 判读优先级：投影软取 → `open('read')` 事件日志 → `stat.eventCount` 兜底。
 * 任一判读失败（服务缺失 / 抛错 / 句柄不可读）→ 返回 `undefined`（视为
 * 「未知」，交调用方按降级处理，**不抛异常**）。
 *
 * `session` 参数为 live Session 对象（来自 `agent.session`），web 宿主下供
 * `sessionListMetadata` 投影软取；headless 常无 → 降级到事件日志判读。
 *
 * @returns `true`（blank，需投递）/ `false`（非 blank，不投递）/ `undefined`（未知）。
 */
export async function isSessionBlank(
  deps: Pick<OpeningNoticeDeps, 'sessionPersistence' | 'sessionProjections' | 'pinnedId'>,
  session?: unknown,
): Promise<boolean | undefined> {
  const id = deps.pinnedId ?? PINNED_SESSION_ID

  // 1) 软取投影空白位（web 宿主）。
  try {
    const projections = deps.sessionProjections
    if (projections && typeof projections.stateOf === 'function') {
      const state = projections.stateOf(session, 'sessionListMetadata') as
        | { blank?: boolean }
        | undefined
      if (state && typeof state.blank === 'boolean') return state.blank
    }
  } catch {
    // 投影软取失败 → 落入事件日志判读。
  }

  // 2) 打开只读句柄读事件日志（跨宿主 / 跨分支均可靠）。
  try {
    const handle = await deps.sessionPersistence.open(id, 'read')
    try {
      const { events } = await handle.read(0)
      if (Array.isArray(events)) {
        return !events.some((e: SessionEventLike) => e.type === 'turn/start')
      }
    } finally {
      if (typeof handle.close === 'function') {
        await handle.close().catch(() => {})
      }
    }
  } catch {
    // open/read 失败（会话不存在 / 服务不可用）→ 落入兜底。
  }

  // 3) 兜底：stat.eventCount（JSONL 后端通常不返回 → undefined 即未知）。
  try {
    if (deps.sessionPersistence.stat) {
      const stat = await deps.sessionPersistence.stat(id)
      if (stat && typeof stat.eventCount === 'number') return stat.eventCount === 0
    }
  } catch {
    // 兜底失败 → 判读未知。
  }

  return undefined
}

/**
 * 开场 notice 投递结果。
 */
export type OpeningNoticeResult =
  | { kind: 'delivered'; id: string }
  | { kind: 'not-blank'; id: string }
  | { kind: 'skipped'; id: string; detail: string }

/**
 * 投递开场 notice（一次性）：判读 blank → blank 则 `followup` 一次，否则跳过。
 *
 * **绝不抛异常**：`agents` 不可达 / `followup` 抛错 / 判读失败 → 记日志、返回
 * `skipped`，不影响调用方（ensure / workspace 归属照常）。
 *
 * @param deps 注入依赖。
 * @returns 投递结果。
 */
export async function deliverOpeningNotice(
  deps: OpeningNoticeDeps,
): Promise<OpeningNoticeResult> {
  const log = deps.logger ?? ((message: string) => console.log(message))
  const id = deps.pinnedId ?? PINNED_SESSION_ID

  // 解析投递目标 agent（同时取 live session 供投影软取）。
  let agent: OpeningNoticeAgent | undefined
  try {
    agent = deps.agents.get(id)
  } catch (err: unknown) {
    log(`[dsh-finance/notice] 警告 agents.get 失败（降级 skip）：${String(err)}`)
    return { kind: 'skipped', id, detail: `agents.get failed: ${String(err)}` }
  }

  // 判读 blank（软取 agent.session 一并带入，供投影判读使用）。
  let blank: boolean | undefined
  try {
    blank = await isSessionBlank(
      {
        sessionPersistence: deps.sessionPersistence,
        sessionProjections: deps.sessionProjections,
        pinnedId: id,
      },
      agent?.session,
    )
  } catch (err: unknown) {
    log(`[dsh-finance/notice] 警告 判读会话 blank 失败（降级 skip）：${String(err)}`)
    return { kind: 'skipped', id, detail: `blank check failed: ${String(err)}` }
  }

  if (blank === false) {
    // 已非 blank（发生过 turn/start）→ 自愈，不重复投递。
    return { kind: 'not-blank', id }
  }
  if (blank === undefined) {
    // 判读失败（服务不可读 / open 拖错 / 投影与兜底均无法判定）→ 按 §9.6 语义
    // 降级 skip（**不投**，避免误判导致重复投递）；会话若仍 blank，会由其它
    // 真实 turn 或下次可判读时自愈。
    log(`[dsh-finance/notice] 警告 无法判读会话 blank 状态，跳过开场 notice（降级）`)
    return { kind: 'skipped', id, detail: 'blank state unknown' }
  }

  if (!agent || typeof agent.followup !== 'function') {
    log(`[dsh-finance/notice] 警告 固定会话不可达（${id}），跳过开场 notice（降级）`)
    return { kind: 'skipped', id, detail: 'agent unreachable' }
  }

  // 投递（仅当判读为 blank 时）。
  try {
    agent.followup(buildOpeningNoticeMessage())
    log(`[dsh-finance/notice] 已投递开场 notice（固定会话 ${id}）`)
    return { kind: 'delivered', id }
  } catch (err: unknown) {
    log(`[dsh-finance/notice] 警告 投递开场 notice 失败（降级 skip）：${String(err)}`)
    return { kind: 'skipped', id, detail: `followup failed: ${String(err)}` }
  }
}
