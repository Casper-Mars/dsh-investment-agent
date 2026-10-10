/**
 * 会话确保层：固定会话「检查 → 恢复 → 新建」。
 *
 * 本模块把 ensure 逻辑抽成**可注入依赖的纯函数/工厂**，便于三分支单测。
 * 与 harness `session-controller` 的 `createOrAdopt` 同构（核对来源：
 * `packages/api/session-controller/src/agent.ts` L444-505），区别在于：
 *
 *   1. 判据精简：dsh 没有「归档」概念，故只需两段判定 ——
 *      (a) live（`agents.get(id)` 命中）→ 直接复用；
 *      (b) 已持久化（`sessionPersistence.stat(id)` 命中）→ `resume` 恢复；
 *      (c) 都不存在 → `create` 新建（带 `cwd` / `agentOptions`）。
 *   2. 会话缺失时行为固定为 **skip**：记日志、降级跳过，**不抛异常、
 *      不中断调度**，且**不提供开关**。
 *
 * 依赖来源（已核对 harness 源码）：
 *   - `ctx.agents.get(id): Agent | undefined`
 *     （`packages/core/agent/src/index.ts` L566，服务名 `agents`，类 `AgentRegistry`）
 *   - `ctx.agents.create(options): Promise<AgentHandle>`
 *     （同文件 L391，`options.sessionId` / `options.meta.cwd` / `options.agentOptions`）
 *   - `ctx.agents.resume(options): Promise<AgentHandle>`
 *     （同文件 L410，`options.resumeSessionId` / `options.agentOptions`）
 *   - `AgentHandle = { agent: Agent; dispose(): Promise<void> }`
 *     （同文件 L155-168，dispose 停循环 / 注销 / 移除 session；绑定插件 fiber）
 *   - `ctx.agentDefaultModel.currentSelection(): { provider, model, reasoningEffort? }`
 *     （`packages/core/agent-default-model/src/index.ts` L67；本节仅取 `{ provider, model }`，
 *      与 `agent.ts` 的 `agentOptions()` 一致）
 *   - `ctx.sessionPersistence.stat(id): Promise<SessionPersistenceSnapshot | undefined>`
 *     （`packages/session/session-persistence/src/index.ts` L194）
 *
 * 归属机制（关键）：`create` / `resume` 以「访问方上下文的 fiber/scope」为 ownerCtx，
 * 因此**必须在插件 ctx（或 ctx.effect 内）调用**；返回的 `handle.dispose()` 须绑定
 * `ctx.effect` 的卸载回调，使插件 fiber 卸载时自动拆除会话。再次 apply 且会话已
 * 落盘时，将自然走 resume 分支恢复历史上下文（见 §9.5）。
 */
import type { Context } from '@deepseek-ai/cordis'
import {
  PINNED_SESSION_ID,
  type PinnedSessionId,
  type SessionPersistenceLike,
} from './session.js'
import {
  deliverOpeningNotice,
  type OpeningNoticeAgents,
  type SessionProjectionsLike,
} from './opening-notice.js'

/** 会话确保依赖的可注入面（供纯函数三分支单测注入 fake）。 */
export interface SessionEnsureDeps {
  /** 活跃 agent 注册表（`ctx.agents` 结构替身）。 */
  agents: {
    /** 查 live：命中返回 agent，否则 `undefined`。 */
    get(id: PinnedSessionId): EnsureAgent | undefined
    /** 新建（live 未命中且无持久化）。 */
    create(options: {
      sessionId: PinnedSessionId
      agentOptions?: EnsureAgentOptions
      meta?: { cwd?: string }
    }): Promise<EnsureAgentHandle>
    /** 恢复（已持久化但未 live）。 */
    resume(options: {
      resumeSessionId: PinnedSessionId
      agentOptions?: EnsureAgentOptions
    }): Promise<EnsureAgentHandle>
  }
  /** 会话持久化服务（`ctx.sessionPersistence` 结构替身）。 */
  sessionPersistence: {
    /** 观察持久会话：存在返回快照，否则 `undefined`。 */
    stat(id: PinnedSessionId): Promise<unknown>
  }
  /** 宿主工作目录（新建会话的 `meta.cwd`）。 */
  cwd: string
  /** `agentDefaultModel.currentSelection()` 的精简投影（仅 provider/model）。 */
  agentOptions: EnsureAgentOptions
  /** 日志（默认 `console.log`）。 */
  logger?: (message: string) => void
}

/** agent 的最小结构替身（仅需可辨别的 id）。 */
export interface EnsureAgent {
  readonly id: string
}

/** `agentOptions` 的精简投影（与 harness `agentOptions()` 一致，仅 provider/model）。 */
export interface EnsureAgentOptions {
  provider?: string
  model?: string
}

/** `AgentHandle` 的最小结构替身（归属契约：dispose 拆除会话）。 */
export interface EnsureAgentHandle {
  agent: EnsureAgent
  dispose(): Promise<void>
}

/** ensure 结果：会话保证就绪的结局（live 复用 / resume 恢复 / create 新建 / skip 降级）。 */
export type EnsureOutcome =
  | { kind: 'reuse'; id: PinnedSessionId }
  | { kind: 'resumed'; id: PinnedSessionId }
  | { kind: 'created'; id: PinnedSessionId }
  | { kind: 'skipped'; id: PinnedSessionId; detail: string }

/**
 * 确保固定会话就绪（纯逻辑，可注入依赖）。
 *
 * 判定顺序（与 `createOrAdopt` 同构、判据精简）：
 *   1. `agents.get(id)` 命中（live）→ 直接复用，不重复创建；
 *   2. 否则 `sessionPersistence.stat(id)` 命中（已持久化）→ `resume` 恢复；
 *   3. 否则 → `create` 新建（带 `cwd` / `agentOptions`）。
 *
 * ⚠ 归属：`create` / `resume` 的返回 handle 由**调用方**持有并绑定 `ctx.effect`
 * （fiber 卸载自动 `dispose()`）。本函数只保证「会话就绪」并把 handle 交回，
 * 不自行绑定生命周期（便于单测注入 fake 验证三分支）。
 *
 * ⚠ 降级：`create` / `resume` 过程中任一失败（服务不足 / 抛错）→ 记日志返回
 * `{ kind: 'skipped' }`，**不抛异常、不中断**。
 *
 * @param deps 可注入依赖。
 * @returns 会话保活的 handle（live 复用分支为 `undefined`，因无需拆除）；
 *          或 `null`（skip 降级）。
 */
export async function ensurePinnedSession(
  deps: SessionEnsureDeps,
): Promise<{ outcome: EnsureOutcome; handle: EnsureAgentHandle | undefined }> {
  const log = deps.logger ?? ((message: string) => console.log(message))
  const id = PINNED_SESSION_ID

  let detail = ''
  try {
    // 1) live 命中 → 直接复用
    const live = deps.agents.get(id)
    if (live !== undefined) {
      log(`[dsh-finance/session] 固定会话已 live，直接复用：${id}`)
      return { outcome: { kind: 'reuse', id }, handle: undefined }
    }
  } catch (err: unknown) {
    // 服务不足：不中断，落入下方 skip 判定前的安全处理
    log(`[dsh-finance/session] 警告 agents.get 失败：${String(err)}`)
    detail = `agents.get failed: ${String(err)}`
    return { outcome: { kind: 'skipped', id, detail }, handle: undefined }
  }

  // 2) 已持久化 → resume 恢复
  try {
    const stat = await deps.sessionPersistence.stat(id)
    if (stat !== undefined) {
      log(`[dsh-finance/session] 固定会话已持久化，resume 恢复：${id}`)
      const handle = await deps.agents.resume({
        resumeSessionId: id,
        agentOptions: deps.agentOptions,
      })
      return { outcome: { kind: 'resumed', id }, handle }
    }
  } catch (err: unknown) {
    log(`[dsh-finance/session] 警告 恢复固定会话失败：${String(err)}`)
    detail = `resume failed: ${String(err)}`
    return { outcome: { kind: 'skipped', id, detail }, handle: undefined }
  }

  // 3) 都不存在 → create 新建（带 cwd / agentOptions）
  try {
    log(`[dsh-finance/session] 固定会话不存在，create 新建：${id}（cwd=${deps.cwd}）`)
    const handle = await deps.agents.create({
      sessionId: id,
      agentOptions: deps.agentOptions,
      meta: { cwd: deps.cwd },
    })
    return { outcome: { kind: 'created', id }, handle }
  } catch (err: unknown) {
    log(`[dsh-finance/session] 警告 新建固定会话失败：${String(err)}`)
    detail = `create failed: ${String(err)}`
    return { outcome: { kind: 'skipped', id, detail }, handle: undefined }
  }
}

/**
 * `workspaceRegistry` 服务的最小结构替身（仅需 `resolveByPath` / `create`）。
 *
 * 对齐来源（已核对 harness 源码）：
 *   - `packages/workspace/workspace/src/index.ts` L170 `WorkspaceRegistry`，
 *     服务名 `workspaceRegistry`（L193 `super(ctx, 'workspaceRegistry')`）；
 *   - `resolveByPath(path): Promise<Workspace | undefined>`（L501，未命中返回
 *     `undefined`；path 不存在时 realpath **reject**）；
 *   - `create(path, title?): Promise<Workspace>`（L236，path 必须存在且为目录）。
 *
 * 与 `SessionPersistenceLike` 同一套路：结构等价、运行时以实际源码为准，
 * 不把 workspace 包加入本插件硬依赖。
 */
export interface WorkspaceRegistryLike {
  /** 按 canonical 目录路径解析工作区；未命中返回 `undefined`（path 不存在 reject）。 */
  resolveByPath(path: string): Promise<WorkspaceLike | undefined>
  /** 创建（或复用）工作区；path 必须存在且为目录，否则 reject。 */
  create(path: string, title?: string): Promise<WorkspaceLike>
}

/**
 * `Workspace` 的最小结构替身（仅需 `attachSession`）。
 *
 * 对齐来源（已核对 harness 源码）：
 *   - `packages/workspace/workspace/src/entity.ts` L109 `attachSession(sessionId)`：
 *     校验该会话 `header.cwd` 必须等于工作区 path，自身幂等；
 *   - `Workspace` 接口（`types.ts` L63）：`path` / `title` / `sessionIds` /
 *     `attachSession`。
 */
export interface WorkspaceLike {
  /** 工作区 canonical 路径（与 `header.cwd` 比对用）。 */
  readonly path?: string
  /** 将某会话归属到本工作区（幂等）。 */
  attachSession(sessionId: PinnedSessionId): Promise<void>
}

/**
 * 固定会话归属到其 cwd 对应的工作区（§9.7，v1.5）。
 *
 * 语义：
 *   1. `resolveByPath(cwd)` 命中 → 复用该工作区；
 *   2. 未命中 → `create(cwd)` 新建（cwd 已满足「存在且为目录」）；
 *   3. `attachSession(PINNED_SESSION_ID)` 归属（`resolveByPath` 命中即复用、
 *      `attachSession` 自身幂等，故重复 apply 不重复登记）。
 *
 * 降级：服务不可用 / 任一调用失败 → 抛错交调用方捕获（记日志、skip，不中断装载）。
 *
 * @param registry `workspaceRegistry` 结构替身。
 * @param cwd 归属目标工作区目录。
 */
export async function attachPinnedSessionToWorkspace(
  registry: WorkspaceRegistryLike,
  cwd: string,
): Promise<void> {
  const ws =
    (await registry.resolveByPath(cwd)) ?? (await registry.create(cwd))
  await ws.attachSession(PINNED_SESSION_ID)
}

/** `agentDefaultModel` 服务的最小结构替身（仅需 `currentSelection()`）。 */
export interface AgentDefaultModelLike {
  currentSelection(): { provider: string; model: string; reasoningEffort?: string }
}

/**
 * 解析 `agentOptions`：取 `ctx.agentDefaultModel.currentSelection()` 的
 * `{ provider, model }` 投影（与 harness `agentOptions()` 一致）。
 *
 * `agentDefaultModel` 不在顶层 `inject`，故软取；拿不到时返回 `{}`
 *（`agentOptions` 全可选，宿主按默认模型装配）。
 */
export function resolveAgentOptions(
  ctx: Pick<Context, 'get'>,
): EnsureAgentOptions {
  const model: AgentDefaultModelLike | undefined =
    typeof ctx.get === 'function'
      ? (ctx.get('agentDefaultModel') as AgentDefaultModelLike | undefined)
      : undefined
  if (!model || typeof model.currentSelection !== 'function') return {}
  const selection = model.currentSelection()
  return { provider: selection.provider, model: selection.model }
}

/**
 * 会话归属降级包装：ensure 成功后动态注入 workspaceRegistry 并执行归属。
 *
 * 语义（§9.7）：
 *   - 经 `ctx.inject(['workspaceRegistry'], cb)` **动态注入**（不改顶层 inject）；
 *   - `workspaceRegistry` 缺失 / `resolveByPath` reject / `attachSession` 失败 /
 *     inject 自身异常 → 记日志、降级 skip，**不抛、不中断装载**。
 */
function attachSessionToWorkspaceSafely(
  ctx: Context,
  log: (message: string) => void,
  cwd: string,
): void {
  try {
    ctx.inject(['workspaceRegistry'], (workspaceCtx) => {
      const workspaceRegistry = workspaceCtx.get('workspaceRegistry') as
        | WorkspaceRegistryLike
        | undefined
      if (!workspaceRegistry || typeof workspaceRegistry.resolveByPath !== 'function') {
        log('[dsh-finance/session] 警告 workspaceRegistry 服务不可用，跳过会话归属（降级）')
        return
      }
      void attachPinnedSessionToWorkspace(workspaceRegistry, cwd).then(
        () => {},
        (err: unknown) => {
          log(`[dsh-finance/session] 警告 会话归属失败（降级 skip）：${String(err)}`)
        },
      )
    })
  } catch (err: unknown) {
    // inject 自身异常（极端）：降级，不中断装载。
    log(`[dsh-finance/session] 警告 会话归属装配失败（降级 skip）：${String(err)}`)
  }
}

/**
 * 开场 notice 降级装配（§9.7 v1.6，Task-15 AC1）：ensure 成功且 workspace 归属之后，
 * 对**仍 blank** 的固定会话投递一次性「开场 notice」触发首个 `turn/start`，使其脱离
 * blank 状态 → 左侧会话列表可见。
 *
 * 语义：
 *   - 经 `ctx.inject(['agents', 'sessionPersistence'], cb)` **动态注入**两项服务（不变
 *     层 inject，契约固定四项）；`sessionProjections` 为 web 宿主可用的可选投影，
 *     用 `ctx.get` 软取，headless 无 → 降级到事件日志判读；
 *   - 判据 = 会话是否 blank（无 `turn/start`），而非 ensure 结局（已持久化零事件的
 *     固定会话首次启动走 resume 分支，仍需补投）；
 *   - **一次性**：blank → 投一次；非 blank → 不投（重启自愈，不重复）；
 *   - **降级**：`agents` / `sessionPersistence` 缺失 / 判读失败 / `followup` 抛错 →
 *     记日志、skip，**不抛异常、不中断装载**，不影响 ensure 与 workspace 归属。
 */
function deliverOpeningNoticeSafely(
  ctx: Context,
  log: (message: string) => void,
): void {
  ctx.inject(['agents', 'sessionPersistence'], (noticeCtx) => {
    const agents = noticeCtx.get('agents') as OpeningNoticeAgents | undefined
    const sessionPersistence = noticeCtx.get('sessionPersistence') as
      | SessionPersistenceLike
      | undefined

    if (!agents || typeof agents.get !== 'function') {
      log('[dsh-finance/notice] 警告 agents 服务不可用，跳过开场 notice（降级）')
      return
    }
    if (!sessionPersistence || typeof sessionPersistence.open !== 'function') {
      log('[dsh-finance/notice] 警告 sessionPersistence 服务不可用，跳过开场 notice（降级）')
      return
    }
    // 拆出 open 到局部（TS 收窄后仍可选，显式绑定避免闭包内 possibly-undefined）。
    const open = sessionPersistence.open.bind(sessionPersistence)
    const rawStat = sessionPersistence.stat?.bind(sessionPersistence)
    // `stat` 在 `SessionPersistenceLike` 上返回 `Promise<unknown>`（宽类型），
    // 此处收窄为 `eventCount` 快速路径所需的 `{ eventCount?: number }` 投影。
    const maybeStat = rawStat
      ? (id: string) =>
          rawStat(id).then(
            (snap) => snap as { eventCount?: number } | undefined,
          )
      : undefined

    // 软取 sessionProjections（web 宿主有，headless 常无）。
    let sessionProjections: SessionProjectionsLike | undefined
    try {
      sessionProjections = ctx.get('sessionProjections') as SessionProjectionsLike | undefined
    } catch {
      sessionProjections = undefined
    }

    void deliverOpeningNotice({
      agents,
      sessionPersistence: { open, stat: maybeStat },
      sessionProjections,
      logger: log,
    }).catch((err: unknown) => {
      log(`[dsh-finance/notice] 警告 开场 notice 投递异常：${String(err)}`)
    })
  })
}

/**
 * 装配「启动即确保」：在插件 `apply` 阶段对固定会话执行一次
 * 「检查 → 恢复 → 新建」（§9.5）。
 *
 * - 经 `ctx.inject(['agents', 'sessionPersistence'], cb)` **动态注入**两项会话服务；
 *   任一缺失 → 记日志、安全降级跳过（**不抛异常、不中断装载**），互不影响。
 * - 归属：`create` / `resume` 在 `ctx.effect` 内调用（ownerCtx 绑定插件 fiber），
 *   返回的 `handle.dispose()` 绑定 effect 卸载回调，插件卸载即拆除会话；handle
 *   **唯一持有**（不存在第二个持有者）。
 * - 再次 apply 且会话已落盘时，`agents.get` 未命中 + `stat` 命中 → 走 resume 分支
 *   恢复历史上下文。
 * - 固定会话归属（§9.7）：ensure **成功（非 skipped）后**，才经
 *   `ctx.inject(['workspaceRegistry'], cb)` **动态注入** workspaceRegistry，把固定
 *   会话归属到其 cwd 对应的工作区（使 dsh web 左侧会话列表可见）。归属注册发生在
 *   ensure 成功之后，与 ensure 共享同一份 `outcome`/`handle`，因此 **ensure 只执行
 *   一次**（消除并发重复 create 的竞态 + 顺序依赖）；服务缺失 / 调用失败 → 记日志、
 *   降级 skip，不抛异常、不中断装载。
 */
export function applySessionEnsure(
  ctx: Context,
  options: { logger?: (message: string) => void; cwd?: string } = {},
): void {
  const log = options.logger ?? ((message: string) => console.log(message))

  // cwd：取宿主工作目录（`process.cwd()`）。这是新建会话落地的工作目录来源；
  // 不臆造其他路径、不新增配置项 / 环境变量。
  const cwd = options.cwd ?? process.cwd()
  const agentOptions = resolveAgentOptions(ctx)

  ctx.inject(['agents', 'sessionPersistence'], (sessionCtx) => {
    const agents = sessionCtx.get('agents') as SessionEnsureDeps['agents'] | undefined
    const sessionPersistence = sessionCtx.get('sessionPersistence') as
      | SessionPersistenceLike
      | undefined

    if (!agents || typeof agents.get !== 'function') {
      log('[dsh-finance/session] 警告 agents 服务不可用，跳过会话确保（降级）')
      return
    }
    if (!sessionPersistence || typeof sessionPersistence.stat !== 'function') {
      log('[dsh-finance/session] 警告 sessionPersistence 服务不可用，跳过会话确保（降级）')
      return
    }
    // 拆出 stat 到局部（TS 收窄后仍可选，显式绑定避免闭包内 possibly-undefined）。
    const stat = sessionPersistence.stat.bind(sessionPersistence)

    ctx.effect(() => {
      let cancelled = false
      let disposeHandle: (() => void) | undefined

      void ensurePinnedSession({
        agents,
        sessionPersistence: { stat },
        cwd,
        agentOptions,
        logger: log,
      }).then(({ outcome, handle }) => {
        if (cancelled) {
          // 插件在 ensure 完成前已卸载：立刻拆除刚建好的会话，避免泄漏。
          if (handle) void handle.dispose()
          return
        }
        if (handle) {
          // 归属：绑定插件 fiber，卸载时自动拆除（唯一持有，无第二持有者）。
          disposeHandle = () => {
            void handle.dispose()
          }
        }
        switch (outcome.kind) {
          case 'reuse':
          case 'resumed':
          case 'created':
            break
          case 'skipped':
            log(`[dsh-finance/session] 固定会话确保跳过：${outcome.detail}`)
            break
        }

        // 固定会话归属（§9.7）：仅在 ensure 成功（非 skipped）后动态注入
        // workspaceRegistry 归属到 cwd 对应工作区。注册发生在 ensure 成功之后，
        // 天然消除与 ensure 的顺序依赖 + 重复 ensure（D1/D3）；handle 仍由本块
        // 唯一持有（D2），无第二持有者、无泄漏。
        if (outcome.kind !== 'skipped') {
          attachSessionToWorkspaceSafely(ctx, log, cwd)
          // 开场 notice（§9.7 v1.6，Task-15 AC1）：归属之后对仍 blank 的固定会话
          // 投递一次性 notice 触发首个 turn/start（脱离 blank → 左侧列表可见）。
          deliverOpeningNoticeSafely(ctx, log)
        }
      }).catch((err: unknown) => {
        log(`[dsh-finance/session] 警告 会话确保异常：${String(err)}`)
      })

      return () => {
        cancelled = true
        if (disposeHandle) disposeHandle()
      }
    }, 'dsh-finance session')
  })
}
