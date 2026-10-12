/**
 * trace 上下文（里程碑 M4「trace 上下文」）——基于 Node 原生 `AsyncLocalStorage`。
 *
 * 目标：为「定时触发 → 唤醒 → agent 研判 → 记账」这条**异步链路**提供一个
 *   请求内可见的关联锚点 `traceId`，使散落在各模块（scheduler / loader / runner /
 *   wake / 门面）的日志行可被同一 `traceId` 串联，便于按一次唤醒链路回溯。
 *
 * 设计要点（对齐技术方案《日志完善技术方案（dsh-finance 插件）v1.0》§5.4 / §9 M4）：
 *   1. **零第三方依赖**：只用 Node 原生 `node:async_hooks` 的 `AsyncLocalStorage`
 *      与 `node:crypto` 的 `randomUUID`（均为 `node:*`）。不引 pino / winston 等。
 *   2. **纯进程内传播**：`AsyncLocalStorage` 只在**同一进程**的异步调用链内传播；
 *      **跨进程边界**（任务子进程 / 唤醒消息）不依赖它，改由调用方**显式传递**
 *      traceId（见 `src/scheduler/wake.ts`），避免「跨进程 ALS 不生效」的错误假设。
 *   3. **降级不抛**：无上下文（未 `run`、纯 mock / 测试）时 {@link getTrace} →
 *      `undefined`，日志门面退化为现状（不加 trace 字段）；`AsyncLocalStorage`
 *      不可用时 `runWithTrace` 直接执行 `fn`，绝不抛。
 *
 * 上下文载荷 {@link TraceContext}：
 *   - `traceId`  单次链路主键（必填；scheduler 触发时经 {@link newTraceId} 生成）；
 *   - `taskId`   触发该链路的任务 id（可选）；
 *   - `sessionId` 目标固定会话 id（可选，见 `src/flags.ts` 的 `getPinnedSessionId`）。
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'

/**
 * trace 上下文字段。
 *
 * `traceId` 为单次链路主键；`taskId` / `sessionId` 为可选的关联维度，
 * 三者会由日志门面（{@link ./logger.js}）自动合并进每条日志的 meta。
 */
export interface TraceContext {
  /** 单次链路主键（同一唤醒链路内一致）。 */
  readonly traceId: string
  /** 触发该链路的任务 id（可选）。 */
  readonly taskId?: string
  /** 目标固定会话 id（可选）。 */
  readonly sessionId?: string
}

/**
 * 进程内 trace 存储。惰性初始化并带降级：极端环境下构造失败时不抛，
 * 后续 {@link runWithTrace} / {@link getTrace} 退化为无上下文。
 */
let store: AsyncLocalStorage<TraceContext> | undefined
let initialized = false

/** 取（惰性初始化的）AsyncLocalStorage；不可用时返回 `undefined`（降级）。 */
function storage(): AsyncLocalStorage<TraceContext> | undefined {
  if (!initialized) {
    initialized = true
    try {
      store = new AsyncLocalStorage<TraceContext>()
    } catch {
      store = undefined
    }
  }
  return store
}

/**
 * 生成一个新的 traceId（`node:crypto` 的 `randomUUID`，零第三方依赖）。
 *
 * @returns 形如 `xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx` 的随机唯一串。
 */
export function newTraceId(): string {
  return randomUUID()
}

/**
 * 在给定 trace 上下文中同步 / 异步执行 `fn`，其（含派生异步）调用链内
 * {@link getTrace} 均可读到该上下文。
 *
 * 语义对齐 `AsyncLocalStorage.run`：`fn` 的返回值即本函数返回值；`fn` 抛错时
 * 原样抛出（**不吞异常**）。`AsyncLocalStorage` 不可用（降级）时直接执行 `fn`。
 *
 * @param ctx trace 上下文。
 * @param fn  待执行函数（可返回 T，含 Promise）。
 * @returns `fn` 的返回值。
 */
export function runWithTrace<T>(ctx: TraceContext, fn: () => T): T {
  const als = storage()
  return als ? als.run(ctx, fn) : fn()
}

/**
 * {@link runWithTrace} 的语义别名（便于调用点按「进入上下文」语义书写）。
 */
export function withTrace<T>(ctx: TraceContext, fn: () => T): T {
  return runWithTrace(ctx, fn)
}

/**
 * 读取**当前**异步上下文的 trace；无上下文（未进入 / 已退出）→ `undefined`。
 *
 * **降级不抛**：任何异常（含极端环境无 `AsyncLocalStorage`）一律返回 `undefined`。
 */
export function getTrace(): TraceContext | undefined {
  try {
    return storage()?.getStore()
  } catch {
    return undefined
  }
}

/**
 * 把当前上下文**原地**设为 `ctx`（`AsyncLocalStorage.enterWith` 语义）。
 *
 * 供「无法用 `run` 包裹、但需在本调用链后续可见」的场景使用；正常链路优先
 * {@link runWithTrace}（显式作用域，无泄漏）。`AsyncLocalStorage` 不可用时 no-op。
 *
 * @param ctx trace 上下文。
 */
export function enterWithTrace(ctx: TraceContext): void {
  try {
    storage()?.enterWith(ctx)
  } catch {
    /* 降级：无法进入上下文时不抛。 */
  }
}
