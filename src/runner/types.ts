/**
 * runner 层：感知脚本执行 + 自持调度所需的**最小结构类型**。
 *
 * 设计约束（详细设计 §6 / §8）：本插件顶层 `inject` 固定为
 * `['tools','skills','ptcRuntime','fs']`，且**不把** `@deepseek-ai/dsh-ptc-runtime` /
 * `@deepseek-ai/dsh-sandbox` / `@deepseek-ai/dsh-agent` / `@deepseek-ai/dsh-llm`
 * 加入本包依赖（它们仅作为 dsh-tools 的传递依赖存在于 pnpm store，顶层不可解析）。
 *
 * 因此这里按需声明与 harness 源码**逐字对齐**的最小结构契约，用于类型标注 /
 * 边界断言，运行时通过 `ctx.get('ptcRuntime')` 软取真实服务。这样：
 *   1. 编译期不引入对上述包的硬依赖（与 `src/prompts/index.ts` 的
 *      `SystemPromptLike` / `src/skills` 的 `SkillRegistration` 同一套路）；
 *   2. 与真实运行时实现**结构兼容**（TS 结构化类型），运行时行为以 harness 为准。
 *
 * 对齐来源（已核对）：
 *   - `packages/ptc-runtime/ptc-runtime/src/types.ts`（PtcRunRequest/Spec/Result/Failure）
 *   - `packages/ptc-runtime/ptc-runtime/src/index.ts`（PtcRuntime.resolve/run 契约）
 *   - `packages/ptc-runtime/ptc-runtime-node/src/index.ts`（run 需先 resolve；需 sandboxPolicy）
 *   - `packages/sandbox/sandbox/src/index.ts`（SandboxExecutionPolicy / SandboxMode）
 */

/**
 * 可通过依赖极轻的 Service Definition 传输的**无损 JSON 值**。
 * 与 `@deepseek-ai/dsh-ptc-runtime` 的 `PtcJsonValue` 同构。
 */
export type PtcJsonValue =
  | null
  | boolean
  | number
  | string
  | PtcJsonValue[]
  | { [key: string]: PtcJsonValue }

/**
 * 暴露给程序的一个 host 异步可调用函数。
 *
 * ⚠️ 运行时程序侧的绑定成员签名是 `(args: unknown) => Promise<unknown>`（单参数）：
 * 见 `ptc-runtime-node/src/bootstrap.ts` 的 `makeNamespaces`。因此**多值调用必须由
 * 脚本打包为单个对象/数组**（例如 `quote.history({ symbol, days })`），
 * 直接写 `quote.history(sym, days)` 时第二个实参会被丢弃。
 */
export type PtcBindingFunction = (args: unknown) => Promise<PtcJsonValue>

/** 命名空间级的「程序可见类型化拒绝」契约（本插件不使用，仅结构对齐）。 */
export interface PtcBindingErrorClass {
  /** 构造器全局名与 `Error.name`。 */
  name: string
  /** 暴露成员名的自有属性名。 */
  memberNameProperty: string
}

/**
 * 一个命名绑定分组：运行时将其作为一个全局对象暴露给程序。
 *
 * ⚠️ 实际 API 字段名是 **`functions`**（详细设计 §6.3 误写作 `members`，系笔误）。
 */
export interface PtcBindingNamespace {
  /** 程序可见的全局标识符（必须匹配 `[A-Za-z_][A-Za-z0-9_]*` 且非保留字）。 */
  global: string
  /** 可调用成员，键为程序调用的精确名字。 */
  functions: Record<string, PtcBindingFunction>
  /** 可选的程序可见类型化拒绝契约。 */
  errorClass?: PtcBindingErrorClass
}

/** 文件效果模式（与 `@deepseek-ai/dsh-sandbox` 一致）。 */
export type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access'

/** 单次执行解析后的文件效果策略。 */
export interface SandboxExecutionPolicy {
  /** 文件效果模式；感知脚本固定 `read-only`。 */
  mode: SandboxMode
  /** 绝对工作区根目录（`workspace-write` 可写范围；read-only 下用于解析相对路径）。 */
  workspaceRoot: string
  /** 调用会话身份（可选）。 */
  sessionId?: string
}

/** 一次程序执行的调用方输入。 */
export interface PtcRunRequest {
  /** 程序源码（作为 async 函数体执行，支持顶层 await/return）。 */
  program: string
  /** 暴露给程序的 host 函数（每个命名空间一个全局对象）。 */
  bindings: PtcBindingNamespace[]
  /** 工作目录（绝对路径）。 */
  cwd?: string
  /** 执行预算（ms）；`null` 表示无截止时间；省略用 provider 默认。 */
  timeoutMs?: number | null
  /** 本次执行解析后的文件效果策略。 */
  sandboxPolicy?: SandboxExecutionPolicy
  /** 中止信号。 */
  signal?: AbortSignal
}

/** 已解析的执行输入（`resolve` 的产物）。 */
export interface PtcRunSpec extends PtcRunRequest {
  /** 绝对工作目录。 */
  cwd: string
  /** 规范化后的执行预算（正有限数）或 `null`（无截止）。 */
  timeoutMs: number | null
}

/** 运行失败类别（正交结局）。 */
export type PtcRunFailureKind =
  | 'exception'
  | 'timeout'
  | 'abort'
  | 'worker-exit'
  | 'invalid-output'
  | 'output-limit'
  | 'protocol'
  | 'sandbox-unavailable'

/** 运行失败详情。 */
export interface PtcRunFailure {
  kind: PtcRunFailureKind
  message: string
}

/** 本次执行施加的文件限制事实。 */
export interface PtcRunSandbox {
  mode: SandboxMode
  denied: boolean
  enforcement?: 'full' | 'partial'
}

/**
 * 单次运行结果。
 *
 * ⚠️ **`error` 是结果字段，`run()` 不 reject**（Service 契约误用除外）。
 */
export interface PtcRunResult {
  sandbox?: PtcRunSandbox
  value?: PtcJsonValue
  logs: string[]
  error?: PtcRunFailure
}

/**
 * `ctx.ptcRuntime` 的最小结构契约。
 *
 * 实际调用方式（已核对 `ptc-runtime-node`）：**先 `resolve(request)` 得 spec，
 * 再 `run(spec)`** —— `run` 要求 spec 已带 `sandboxPolicy` / 绝对 `cwd` / 数值
 * `timeoutMs`，否则抛错（属调用方误用）。
 */
export interface PtcRuntimeLike {
  /** 源码语言标识（信息性）。 */
  readonly language?: string
  /** 执行隔离底座标识（信息性）。 */
  readonly isolation?: string
  /** 解析执行输入（补齐目录 / 截止时间 / 授权）。 */
  resolve(request: PtcRunRequest): PtcRunSpec
  /** 执行已解析输入；程序结局以结果字段返回。 */
  run(spec: PtcRunSpec): Promise<PtcRunResult>
}

/** 感知脚本的返回值契约（§6.4）。 */
export interface SensorScriptResult {
  /** 是否唤醒 agent。 */
  shouldWake: boolean
  /** 触发唤醒的标的。 */
  symbol?: string
  /** 人类可读摘要。 */
  summary?: string
  /** 结构化指标（无损 JSON）。 */
  metrics?: PtcJsonValue
}

/** 触发感知执行的原因。 */
export type SensorRunReason = 'pulse' | 'review' | 'prep' | 'manual'

/** 唤醒投递载荷。 */
export interface SensorWakePayload {
  reason: SensorRunReason
  /** 触发标的；`'*'` 表示「全部标的」（复盘 / 盘前场景）。 */
  symbol: string
  /** 摘要（供 notice 一行展示与正文）。 */
  summary: string
  /** 结构化指标。 */
  metrics?: PtcJsonValue
  /** 感知脚本版本（有则附注）。 */
  version?: string
}

/**
 * 唤醒通道：投递载荷并返回**实际投递的会话数**。
 * 返回 0 表示无可用 agent（降级跳过，不抛异常）。
 */
export type SensorWaker = (payload: SensorWakePayload) => number

/** 单次感知执行的结局（结构化、便于断言与日志）。 */
export type SensorRunOutcome =
  | { kind: 'quiet'; reason: SensorRunReason; version?: string }
  | {
      kind: 'woke'
      reason: SensorRunReason
      version?: string
      symbol: string
      summary: string
      targets: number
    }
  | { kind: 'skipped'; reason: SensorRunReason; detail: string; symbol?: string; version?: string }
  | {
      kind: 'failed'
      reason: SensorRunReason
      detail: string
      failureKind?: PtcRunFailureKind
    }
