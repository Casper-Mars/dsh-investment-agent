/**
 * 定时任务层（感知层）最小结构契约类型。
 *
 * 唯一权威设计文档：《感知层详细设计（dsh-finance 插件）》 v0.7。
 *
 * 本文件只导出「类型」（interface / type），无任何运行时副作用、无函数实现体。
 * 这些契约是 `store` / `tools` / `loader` / `runner` / `scheduler` / `wake` 等
 * 后续模块的公共依据——各模块通过依赖注入（无副作用工厂）复用这些签名。
 *
 * 核心定性（§1）：定时任务层 = 机制，只做「定时 → 执行任务程序 → 判读是否唤醒」。
 */

// ---------------------------------------------------------------------------
// §2.1 任务记录 —— 定时任务清单记录的最小结构契约
// ---------------------------------------------------------------------------

/**
 * 一条定时任务的持久化记录（`data/tasks/<id>.json`）。
 *
 * 对应设计文档 §2.1「任务记录」。每个字段直接对齐文档字段表：
 * - `id`      唯一标识
 * - `name`    人类可读名称
 * - `cron`    cron 表达式（Asia/Shanghai 时区，最小粒度「分钟」，见 §2.2 / §7）
 * - `task_path` 任务程序入口文件路径（如 `tasks/market-pulse/task.ts`）
 * - `enabled` 是否启用
 */
export interface TaskDef {
  /** 唯一标识（如 `market-pulse`），对应任务程序目录名。§2.1 */
  readonly id: string;
  /** 人类可读名称。§2.1 */
  readonly name: string;
  /** cron 表达式（5 段：分 时 日 月 周），始终按 Asia/Shanghai 解析，最小粒度分钟。§2.1 / §2.2 */
  readonly cron: string;
  /** 任务程序入口文件路径（相对路径，指向该任务的 `task.ts`）。§2.1 */
  readonly task_path: string;
  /** 是否启用；`enabled=false` 的任务不被调度。§2.1 */
  readonly enabled: boolean;
}

// ---------------------------------------------------------------------------
// §5.3 任务返回值契约 —— 任务程序的 stdout 单行 JSON 结构
// ---------------------------------------------------------------------------

/**
 * 任务程序返回值契约（§5.3）。
 *
 * 任务进程把最终结果以「一行 JSON」写到 stdout，由 `runner` 捕获解析为该类型。
 * 体现「shouldWake=true 时必带 data，为 false 时静默」的联合区分：
 * - 唤醒分支：`{ shouldWake: true; data: string }`，`data` 逐字作为唤醒正文。
 * - 静默分支：`{ shouldWake: false }`。
 *
 * §9 明确：`shouldWake` 必须为 boolean，非 boolean（或缺省）→ 解析失败 → `failed`
 * （`failureKind='parse'`；`skipped` 仅用于编排层降级分支，非 runner 产出）。
 */
export type TaskScriptResult =
  | { readonly shouldWake: true; readonly data: string }
  | { readonly shouldWake: false };

// ---------------------------------------------------------------------------
// §9 执行结局 —— 单次任务运行的结局枚举
// ---------------------------------------------------------------------------

/**
 * 单次任务运行的结局（§9），四值分别对应「正常静默 / 已唤醒 / 判定无效 / 执行失败」。
 */
export type TaskRunOutcome =
  | {
      /** 正常执行、无需唤醒。§9 */
      readonly kind: 'quiet';
      /** 结局说明（人类可读）。§9 */
      readonly reason: string;
    }
  | {
      /** 成功唤醒。§9 */
      readonly kind: 'woke';
      /** 唤醒说明。§9 */
      readonly reason: string;
      /** 唤醒正文（即任务返回的 `data`）。§9 / §8.4 */
      readonly data: string;
      /** 投递目标（固定会话等）。§9 */
      readonly targets: readonly string[];
    }
  | {
      /** 跳过（判定无效 / 契约违约 / 降级）。§9 */
      readonly kind: 'skipped';
      /** 跳过说明。§9 */
      readonly reason: string;
      /** 降级细节（可选）。§9 */
      readonly detail?: string;
    }
  | {
      /** 失败（执行失败 / 降级）。§9 */
      readonly kind: 'failed';
      /** 失败说明。§9 */
      readonly reason: string;
      /** 失败细节（可选）。§9 */
      readonly detail?: string;
      /** 失败分类（可选，见 {@link TaskRunFailureKind}）。§9 */
      readonly failureKind?: TaskRunFailureKind;
    };

// ---------------------------------------------------------------------------
// §9 失败分类 —— 执行失败 / 降级链路的字面量类型
// ---------------------------------------------------------------------------

/**
 * 任务执行失败 / 降级链路的「失败分类」字面量类型（§9）。
 *
 * 依据 §9.1「降级分支清单」全链路降级环节推导，最小且完整覆盖：
 * 依赖安装（install）→ 进程 spawn → 子进程执行（exec）→ stdout 解析（parse）→ 唤醒投递（wake）。
 */
export type TaskRunFailureKind =
  | /** 依赖安装阶段失败 / 超时（§9.1「依赖安装」）。 */ 'install'
  | /** 进程 spawn 阶段失败——起独立进程失败（§9.1「进程执行」的启动环节，§4.3）。 */ 'spawn'
  | /** 子进程执行阶段失败——非零退出码 / 崩溃（§9.1「进程执行」/「执行结果」）。 */ 'exec'
  | /** stdout 解析阶段失败——输出无有效 JSON / 结构非法（§9.1「执行结果」，§4.4）。 */ 'parse'
  | /** 唤醒投递阶段失败——固定会话不可达 / 投递异常（§9.1「唤醒」）。 */ 'wake';

// ---------------------------------------------------------------------------
// 可注入函数类型（§6 / §7.3 / §8.2）—— 依赖注入解耦的最小结构契约
// ---------------------------------------------------------------------------

/**
 * 时钟源（Clock）——可注入的「当前时间」抽象。§6 / §7.1 / §10.3。
 *
 * 调度器用 `now()` 获取当前时刻，计算「下次触发时刻」与「超时/冷却」判定；
 * 固定返回 Asia/Shanghai 视角的时间（§7.1 时区锁）。
 */
export interface Clock {
  /** 返回当前时刻（毫秒时间戳，或可比较的 Date）。§7.1 */
  now(): Date;
}

/**
 * 定时器（Timer）——调度按 cron 到点触发的能力。§6 / §7.1 / §7.3。
 *
 * 调度器用 `setTimer(delayMs, cb)` 安排「某任务下次触发」的一次性定时，
 * 触发后再链式自调度；`clearTimer` 用于 stop / reload 时清空已排定的 timer（无泄漏）。
 */
export interface Timer {
  /**
   * 安排一次性定时，`delayMs` 毫秒后回调 `cb`，返回可被取消的句柄。
   * 对应原生 `setTimeout`。§7.1
   */
  setTimer(delayMs: number, cb: () => void): TimerHandle;
  /** 取消一个已排定的定时句柄。对应原生 `clearTimeout`。§7.3 */
  clearTimer(handle: TimerHandle): void;
}

/** 定时器句柄（`setTimer` 返回值的最小结构；可用原生 `ReturnType<typeof setTimeout>` 兼容）。 */
export type TimerHandle = { readonly _timerBrand?: never } | ReturnType<typeof setTimeout>;

/**
 * 进程生成器（Spawner）——独立进程执行任务程序的抽象。§5 / §6 / §4.3。
 *
 * 输入任务程序入口路径与参数，起独立 Node 进程执行 `task.ts`，
 * 输出「可读的输出流」与进程结束结果，供 `runner` 捕获 stdout 单行 JSON（§4.4）。
 */
export interface Spawner {
  /**
   * 起独立进程执行任务程序。
   * @param taskPath  任务程序入口文件的绝对路径（对应 `TaskDef.task_path`）。§5.1 / §4.3
   * @param args      传给 `node` 的额外参数（可空）。§4.3
   * @returns 进程句柄，可读 stdout / stderr，并可用于超时强杀（§9.3）。
   */
  spawn(taskPath: string, args?: readonly string[]): TaskProcess;
}

/**
 * 由 spawner 返回的任务子进程句柄（最小结构）。
 *
 * 供 `runner` 消费：读取 `stdout`（拿到最后一行 JSON）、读取 `stderr`，
 * 并感知进程退出（`exitCode`）以区分「成功 / 非零退出 / 崩溃」（§4.4 / §9.1）。
 */
export interface TaskProcess {
  /** 任务进程的 stdout 流（单行 JSON 结果来源，§4.4）。 */
  readonly stdout: NodeJS.ReadableStream;
  /** 任务进程的 stderr 流（诊断信息）。 */
  readonly stderr: NodeJS.ReadableStream;
  /**
   * 子进程 pid（可选，向后兼容扩展）。
   *
   * 供 runner 组装任务进程日志文件名 `<ts>-<pid>.log`（M3）。真实
   * `createNodeSpawner` 填 `child.pid`；纯 mock 可省略——缺失时文件名降级为
   * `<ts>-unknown.log`。**可选成员**，故既有 mock 无需改动。
   */
  readonly pid?: number;
  /** 进程退出码（`null` 表示尚未退出或崩溃）。 */
  readonly exitCode: number | null;
  /** 强制终止进程（用于超时强杀，§9.3）。 */
  kill(signal?: NodeJS.Signals): void;
  /**
   * 订阅「进程完全结束」信号（可选，向后兼容扩展）。
   *
   * 回调在「子进程退出（`exit` 已触发）且全部 stdio 流均已关闭」后触发，
   * 对应 `child_process.ChildProcess` 的 `'close'` 事件。此时 {@link exitCode}
   * 已确定（不再可能为表示「尚未退出」的中间态）。
   *
   * **这是 runner 判定退出码的可靠信号**（相对于 `stdout` 流的 `'close'`
   * 事件——后者与子进程 `'exit'` 事件是竞争的，真实 Node 下并不保证
   * `stdout 'close'` 一定晚于 `'exit'`，读到 `exitCode` 可能仍是 `null`）。
   *
   * 实现者（如 `createNodeSpawner`）应挂到真实的 `child.on('close', ...)`；
   * 可选成员——纯 mock 可省略，runner 需提供回退路径（退回 stdout/stderr close）。
   */
  onClose?(cb: () => void): void;
}

/**
 * 唤醒器（Waker）——把 `shouldWake=true` 的投递给固定会话的能力。§8 / §8.2。
 *
 * 通过注入的「agent 注册表」定点取到固定会话 `investment-advisor`（§8.1），
 * 对其 `followup` 投递唤醒消息（正文 = 任务 `data` + 合规声明，§8.4）。
 */
export interface Waker {
  /**
   * 投递一条唤醒消息到固定会话并唤醒。
   * @param text 唤醒正文（任务 `data` 原文 + 合规声明，§8.4）。
   * @returns 投递结果；投递失败时由调用方走 `skipped` 降级（§9.1「唤醒」）。
   */
  wake(text: string): void;
}

// ---------------------------------------------------------------------------
// §8.2 投递契约 —— 会话 / 注册表的最小结构类型（供 waker 定点投递复用）
// ---------------------------------------------------------------------------

/** 唤醒消息（定点投递给固定会话的最小结构）。§8.2 */
export interface NoticeUserMessage {
  /** 消息 kind（V4 producer-owned，§8.3 使用 `'dsh-finance'`）。 */
  readonly kind: string;
  /** 消息正文。 */
  readonly text: string;
}

/** 可投递的 agent 会话（最小结构，结构等价，非硬依赖 harness 重包）。§8.2 */
export interface AgentLike {
  /** 会话 id（固定会话 `investment-advisor`）。§8.1 */
  readonly id: string;
  /** 排队 follow-up turn 并唤醒。§8.2 */
  followup(message: NoticeUserMessage): void;
  /** 仅注入不唤醒（保留）。§8.2 */
  inject?(message: NoticeUserMessage): void;
  /** 会话状态（可选）。§8.2 */
  readonly status?: 'idle' | 'running';
}

/** agent 注册表（最小结构，定点投递只需 `get`）。§8.2 */
export interface AgentRegistryLike {
  /** 定点取会话。§8.2 */
  get(id: string): AgentLike | undefined;
  /** 列全部会话（可选）。§8.2 */
  list?(): AgentLike[];
  /** 根会话（可选）。§8.2 */
  roots?(): AgentLike[];
  /** 当前发起者（可选，已废弃的动态解析路径，保留兼容）。§8.2 */
  currentInitiator?(): AgentLike | undefined;
}