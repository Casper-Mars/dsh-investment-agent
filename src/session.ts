/**
 * 会话层基础：固定会话标识 + `sessionPersistence` 服务的最小结构契约。
 *
 * 本文件提供「基础层」：固定常量、会话服务的最小结构契约。
 * 会话确保（Task-10：检查 → 恢复 → 新建）已实现于 `src/session-ensure.ts`；
 * 尚待实现：
 *   - Task-11：唤醒改为定点投递 + agent-scoped 装配
 *
 * 设计约束：
 *   - `PINNED_SESSION_ID` 是**与插件强相关的写死常量**（非配置项、非环境变量），
 *     全局唯一稳定；取插件标识 `investment-advisor`（与 `src/plugin.ts` 的
 *     `name` 一致），使「该插件独占的常驻会话」与插件身份一一对应。
 *   - `SessionPersistenceLike` 是 `@deepseek-ai/dsh-session-persistence` 的
 *     `SessionPersistence` 服务的最小结构替身（结构等价，运行时即以实际源码
 *     为准），避免把该包加入本插件硬依赖（与 `src/runner/types.ts` 的
 *     `PtcRuntimeLike` / `src/prompts/index.ts` 的 `SystemPromptLike` 同一套路）。
 *
 * 对齐来源（已核对 harness 源码）：
 *   - `packages/session/session-persistence/src/index.ts`：`SessionPersistence`
 *     抽象服务，暴露 `create` / `open` / `flush` / `stat` / `list`。
 *   - `SessionId` 是 brand 字符串（`@deepseek-ai/dsh-session/types`），运行时即
 *     普通字符串；此处以 `string` 结构标注即可。
 */

/**
 * 固定会话标识：本插件专属的常驻会话 id。
 *
 * **非配置项**：不读取任何配置 / 环境变量，全局唯一稳定，为后续
 * Task-10/11 的「ensure / 定点投递」提供稳定锚点。
 */
export const PINNED_SESSION_ID = 'investment-advisor'

/** 持久会话 id（`SessionId` 运行时即普通字符串，结构标注为 string）。 */
export type PinnedSessionId = string

/**
 * `sessionPersistence` 服务的最小结构契约。
 *
 * 仅声明本插件后续会用到的只读 / 观察面；`create` / `open` 等写入面在
 * Task-10（ensure/新建）再补齐，当前基础层只需 `stat` / `list` 的观察能力，
 * 以支撑「服务缺失安全降级 + 引用常量」的验收。
 */
export interface SessionPersistenceLike {
  /** 观察某一持久会话（不读日志、不占所有权）；不存在返回 `undefined`。 */
  stat?(id: PinnedSessionId): Promise<unknown>
  /** 列出本进程可见的所有持久会话快照。 */
  list?(): Promise<readonly unknown[]>
  /**
   * 打开一个已存储会话的只读句柄（不占所有权，可与写句柄并存）。
   *
   * 对齐来源（已核对 harness 源码）：
   *   - `packages/session/session-persistence/src/index.ts` L160 `open(id, access)`；
   *     不存在的会话抛 `SessionPersistenceNotFoundError`；
   *   - `SessionHandle.read(offset?, length?)` 返回
   *     `{ eventState, events: readonly SessionEvent[] }`（`handle.ts` L59）。
   *
   * 仅用于「判读会话是否 blank（无 `turn/start` 事件）」，不写、不占所有权。
   */
  open?(id: PinnedSessionId, access: 'read' | 'write'): Promise<SessionHandleLike>
}

/** `SessionHandle` 的最小结构替身（仅需 `read`，用于判读 blank）。 */
export interface SessionHandleLike {
  /** 读取一段连续逻辑事件（`offset` 默认 0，超出尾部返回空数组）。 */
  read(offset?: number, length?: number): Promise<{ events: readonly SessionEventLike[] }>
  /** 关闭句柄（幂等；`Symbol.asyncDispose` 委托于此）。 */
  close?(): Promise<void>
}

/** `SessionEvent` 的最小结构替身（仅需 `type` 判读 `turn/start`）。 */
export interface SessionEventLike {
  readonly type: string
}
