/**
 * scheduler/scheduler.ts —— 多任务独立调度引擎。
 *
 * 唯一权威设计文档：《感知层详细设计（dsh-ia 插件）》 v0.7。
 *
 * 职责（§7「调度器设计」/ AC-2「多任务模型」/ AC-9「调度」）：
 * scheduler 是「多定时任务的调度引擎」。每个 `enabled===true` 的任务自带
 * `cron` 表达式与 `task_path`，按各自 cron 独立触发。scheduler 对任务内容
 * **一无所知**——只负责「到点触发 runner 执行」，不做依赖安装（loader 职责）、
 * 不做唤醒投递（wake 职责），拿到 runner 的 {@link TaskRunOutcome} 后只消费
 * （记录日志 / 忽略），不投递。
 *
 * 关键语义（§7，勿偏离）：
 *   - **多 timer**：每个 enabled 任务维护自己的「下次触发时刻」，各自调度，互不阻塞。
 *   - **链式自调度**：任务到点触发后，立即用 `next(schedule, 当前时刻)` 计算该任务的
 *     下一次触发时刻并重设 timer（一次性 timer 链式接力，非 setInterval）。
 *   - **任务变更即时生效**：`reload()` 全量重建（清掉旧 timer，按新清单重新设 timer）。
 *   - **幂等启动/停止**：`started` 守卫，多会话不重复装配；stop 清空 timer。
 *   - **异常隔离**：单个任务 runner 抛错 / reject / cron 非法 / task_path 缺失，均被
 *     catch / 跳过，不中断其它任务的调度链。
 *
 * 硬约束（§7.1）：零第三方 cron 库（复用 `cron.ts` 的 parseCron / next + 原生
 * setTimeout 抽象）；时区锁 Asia/Shanghai（cron.ts 已处理，scheduler 不重复）；
 * 最小粒度分钟。
 *
 * 可注入设计（对齐 types.ts 的 Clock / Timer）：
 *   - store：读任务清单（等价 list 抽象）
 *   - runner：执行任务（等价 run 抽象）
 *   - cron：parseCron / next（注入可测替身）
 *   - timer：原生 setTimeout/clearTimeout 抽象（复用 types.ts 的 Timer）
 *   - clock：当前时间（复用 types.ts 的 Clock）
 *
 * 纯 TS，不 import dsh/cordis API。
 */

import type { Clock, TaskDef, TaskRunOutcome, Timer, TimerHandle } from './types.js'
import type { CronSchedule } from './cron.js'
import { next as cronNext, parseCron as parseCronReal } from './cron.js'

// ---------------------------------------------------------------------------
// 可注入类型契约（最小结构，对齐 types.ts 可注入风格）
// ---------------------------------------------------------------------------

/**
 * 任务清单读取抽象（可注入）。
 *
 * 对齐 store.ts 的 {@link createTaskStore} 返回结构的 `list()` 签名：
 * 注入该抽象使 scheduler 可用内存 mock 替代真实文件系统 store。
 */
export interface TaskListSource {
  /**
   * 读取任务清单。
   * @returns 有效任务 + 损坏文件名（scheduler 忽略 corrupted）。
   */
  list(): { readonly tasks: readonly TaskDef[]; readonly corrupted: readonly string[] }
}

/**
 * 任务执行抽象（可注入）。由 scheduler 携带 taskId + taskPath 调用。
 *
 * 与 runner.ts 的 {@link TaskRunner.run} 不同：真实执行器只认 taskPath；编排适配层
 * （index.ts 的 orchestratedRunner）额外需要 taskId 用于依赖安装与按 id 定位唤醒投递。
 * 故此处契约收紧为 `run(taskId, taskPath)`，把 scheduler 在 `fire(id, schedule, taskPath)`
 * 中**已持有**的 taskId 直接透传，避免编排层再按 taskPath 反查（冗余 + 同 path 歧义）。
 */
export interface TaskRunnerLike {
  /**
   * 执行任务程序并返回单次运行结局。
   * @param taskId 任务 id（对应该次调度装配时的 `TaskDef.id`）。
   * @param taskPath 任务入口文件路径（对应 `TaskDef.task_path`）。
   * @returns 单次运行结局；scheduler 只消费、不投递。
   */
  run(taskId: string, taskPath: string): Promise<TaskRunOutcome>
}

/**
 * cron 解析 + next 计算抽象（可注入）。
 *
 * 对齐 cron.ts 的 {@link parseCron} + {@link next} 签名；默认直接用真实实现，
 * 测试可注入可测替身以脱离真实时间/时区逻辑。
 */
export interface CronEngine {
  /** 解析 cron 表达式为调度描述（非法时抛错）。 */
  parseCron(expr: string): CronSchedule
  /** 计算严格大于 `from` 的下一次触发时刻。 */
  next(schedule: CronSchedule, from: Date): Date
}

/**
 * scheduler 的依赖注入配置（工厂参数，对齐 types.ts 可注入风格）。
 */
export interface SchedulerOptions {
  /** 任务清单读取源；必填。 */
  readonly store: TaskListSource
  /** 任务执行器；必填。 */
  readonly runner: TaskRunnerLike
  /** cron 引擎；缺省用真实 `cron.ts` 的 parseCron / next。 */
  readonly cron?: CronEngine
  /** 定时器抽象；缺省用原生 setTimeout/clearTimeout 封装。 */
  readonly timer?: Timer
  /** 时钟源；缺省用系统时间 `() => new Date()`。 */
  readonly clock?: Clock
  /** 调度日志钩子（可选，用于诊断 / 测试观测）。 */
  readonly log?: (level: 'info' | 'warn' | 'error', message: string) => void
}

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/** 无日志钩子注入时的缺省行为：静默（调度器不向 stdout 输出噪声）。 */
const NOOP_LOG = (): void => {}

// ---------------------------------------------------------------------------
// 真实缺省实现（原生 setTimeout / 系统时钟），仅在工厂缺省路径下被加载
// ---------------------------------------------------------------------------

/**
 * 原生定时器抽象（复用 types.ts 的 {@link Timer} 契约）。
 */
function createNativeTimer(): Timer {
  return {
    setTimer(delayMs, cb) {
      return setTimeout(cb, delayMs)
    },
    clearTimer(handle) {
      clearTimeout(handle as ReturnType<typeof setTimeout>)
    },
  }
}

/** 系统时钟（复用 types.ts 的 {@link Clock} 契约）。 */
function createSystemClock(): Clock {
  return { now: () => new Date() }
}

/** 真实 cron 引擎（直接映射 cron.ts 的 parseCron / next）。 */
function createRealCron(): CronEngine {
  return { parseCron: parseCronReal, next: cronNext }
}

// ---------------------------------------------------------------------------
// Scheduler 主体
// ---------------------------------------------------------------------------

/**
 * 多任务独立调度引擎。
 *
 * 通过 {@link createScheduler} 创建（依赖可注入），亦可用 `new Scheduler(options)`。
 *
 * 生命周期与语义（§7.3）：
 *   - {@link start}：加载任务清单并启动调度（幂等）。
 *   - {@link stop}：停止并清空所有 timer（幂等）。
 *   - {@link reload}：重新加载任务清单（tools 变更后调用，全量重建）。
 *   - {@link running}：只读状态。
 */
export class Scheduler {
  /** 任务清单读取源（注入）。 */
  private readonly store: TaskListSource
  /** 任务执行器（注入）。 */
  private readonly runner: TaskRunnerLike
  /** cron 引擎（注入）。 */
  private readonly cron: CronEngine
  /** 定时器抽象（注入）。 */
  private readonly timer: Timer
  /** 时钟源（注入）。 */
  private readonly clock: Clock
  /** 调度日志钩子（注入，可空）。 */
  private readonly log: (level: 'info' | 'warn' | 'error', message: string) => void

  /** 是否已启动（幂等守卫）。 */
  private started = false

  /**
   * 调度代际（generation / epoch）。
   *
   * 每次「清空 / 全量重建」（stop、reload 均经 {@link clearAll}）自增一次。
   * {@link fire} 在触发瞬间记录本次触发所属代际，{@link rescheduleAfterFire} 仅在
   * 「触发代际 === 当前代际」时才装下一次 timer。
   *
   * 用途（修复 P1 竞态）：`fire()` 触发后 runner 异步执行期间，若发生 `reload()`
   * （agent 调写类工具触发），reload 已为同 id 重建了新 timer；旧 fire 的 `finally`
   * 因代际已变而**不再补 timer**，避免同 id 双份活跃 timer（泄漏 + 双份触发，且随
   * 每次 reload 指数增长）。代际守卫同时天然覆盖「reload 时该任务被禁用 / 移除」的边缘
   * ——旧 fire 不会为一个已不再调度的任务重新装上 timer。
   */
  private epoch = 0

  /**
   * 每个已调度任务的运行时状态。
   *
   * Key 为任务 id（同一 id 唯一，reload 时按 id 对齐/移除）。持有：
   *  - schedule：该任务的 cron 解析结果（触发后重算下次时刻用）
   *  - taskPath：该任务的执行入口（触发时传给 runner）
   *  - handle：当前排定的「下次触发」一次性 timer 句柄（stop/reload 时 clear）
   */
  private readonly scheduled = new Map<
    string,
    { readonly schedule: CronSchedule; readonly taskPath: string; handle: TimerHandle }
  >()

  constructor(options: SchedulerOptions) {
    this.store = options.store
    this.runner = options.runner
    this.cron = options.cron ?? createRealCron()
    this.timer = options.timer ?? createNativeTimer()
    this.clock = options.clock ?? createSystemClock()
    this.log = options.log ?? NOOP_LOG
  }

  /** 调度引擎当前是否处于运行态（只读）。 */
  get running(): boolean {
    return this.started
  }

  /**
   * 加载任务清单并启动调度（幂等）。
   *
   * 已启动（`running===true`）时直接返回，不重复装配（避免双份 timer）。
   * 首次启动时从 store `list()` 读清单，对每个 `enabled===true` 且合法的任务
   * 计算下次触发时刻并安装独立 timer；`enabled=false` / cron 非法 / task_path
   * 缺失的任务被跳过，不中断其它任务。
   */
  start(): void {
    if (this.started) return
    this.started = true
    this.rebuildFromStore()
  }

  /**
   * 停止并清空所有 timer（幂等）。
   *
   * 已停止时直接返回。清空 {@link scheduled} 中所有已排定的 timer 句柄，
   * 确保进程退出无 timer 泄漏，`running` 变 false。
   */
  stop(): void {
    if (!this.started) return
    this.started = false
    this.clearAll()
  }

  /**
   * 重新加载任务清单（tools 变更后调用，全量重建）。
   *
   * 语义（§7.2「任务变更即时生效」）：清掉旧 timer，按新清单重新设 timer。
   * 未 start 时（`running===false`）为空操作——尚未装配任何 timer，无旧 timer 需清。
   */
  reload(): void {
    if (!this.started) return
    this.clearAll()
    this.rebuildFromStore()
  }

  // -------------------------------------------------------------------------
  // 内部：装配 / 清除 / 触发
  // -------------------------------------------------------------------------

  /** 清空所有已排定的 timer 句柄（不动 `started` 标志）。 */
  private clearAll(): void {
    // 代际自增：任何「清空 / 重建」都令此前 in-flight fire 的补 timer 失效（见 epoch 字段说明）。
    this.epoch++
    for (const entry of this.scheduled.values()) {
      this.timer.clearTimer(entry.handle)
    }
    this.scheduled.clear()
  }

  /**
   * 从 store 读最新清单并全量装配（清掉旧 timer、按新清单重新设 timer）。
   *
   * 每个 `enabled===true` 的任务独立：解析 cron → 非法则跳过（记录 warn）；
   * task_path 缺失（空串/空白）则跳过；合法则计算下次触发并安装独立 timer。
   * corrupted 清单（store.list 返回的 corrupted 文件名）被忽略（仅诊断记录）。
   */
  private rebuildFromStore(): void {
    let listResult: { readonly tasks: readonly TaskDef[]; readonly corrupted: readonly string[] }
    try {
      listResult = this.store.list()
    } catch (err) {
      // store.list 抛错（异常契约实现）：记录错误后保持空清单，不中断已启动态。
      this.log('error', `[scheduler] 读取任务清单失败，跳过本轮装配: ${String(err)}`)
      return
    }

    if (listResult.corrupted.length > 0) {
      this.log(
        'warn',
        `[scheduler] 忽略 ${listResult.corrupted.length} 个损坏任务文件: ${listResult.corrupted.join(', ')}`,
      )
    }

    for (const task of listResult.tasks) {
      this.scheduleTask(task)
    }
  }

  /**
   * 为单个任务装配调度（§7.2「多 timer」）。
   *
   * 只处理 `enabled===true` 且合法的任务；非法任务被跳过（记录原因），不抛异常、
   * 不影响其它任务。此方法本身被 try/catch 包裹，任何未预期异常都被隔离。
   */
  private scheduleTask(task: TaskDef): void {
    try {
      if (!task.enabled) return

      const taskPath = task.task_path?.trim()
      if (!taskPath) {
        this.log('warn', `[scheduler] 任务 ${task.id} 缺 task_path，已跳过`)
        return
      }

      let schedule: CronSchedule
      try {
        schedule = this.cron.parseCron(task.cron)
      } catch (err) {
        this.log('warn', `[scheduler] 任务 ${task.id} cron 非法，已跳过: ${String(err)}`)
        return
      }

      const nextAt = this.cron.next(schedule, this.clock.now())
      const handle = this.timer.setTimer(nextAt.getTime() - this.clock.now().getTime(), () => {
        this.fire(task.id, schedule, taskPath)
      })
      this.scheduled.set(task.id, { schedule, taskPath, handle })
    } catch (err) {
      // 兜底隔离：任何未预期异常（如 next 计算抛错）不中断其它任务装配。
      this.log('error', `[scheduler] 任务 ${task.id} 装配失败，已跳过: ${String(err)}`)
      this.scheduled.delete(task.id)
    }
  }

  /**
   * 任务到点触发：执行 runner → 链式重设下次触发。
   *
   * 关键正确性（§7.2「链式自调度」/ §7.1「异常隔离」）：
   *   - **先触发再重算**：调用 `runner.run(id, taskPath)`，无论成功/失败/reject，
   *     都在 `finally` 中重新计算该任务的下一次触发时刻并重设 timer。
   *   - **runner reject 被 catch**：`run` 返回 rejected Promise 时被捕获，不抛到
   *     调度链；该任务仍被重设 timer（下个周期继续尝试）。
   *   - **outcome 只消费不投递**：拿到 {@link TaskRunOutcome} 后仅记录日志 / 忽略，
   *     唤醒投递由上层（wake 模块/index）处理，scheduler 不越界。
   *   - 重设前先清理旧句柄（该句柄已触发，但为防 timer 实现重复回调，稳妥清掉）。
   */
  private fire(id: string, schedule: CronSchedule, taskPath: string): void {
    // 任务到点触发：先记录 trace，保证「任务确实执行了」这一事实可观测。
    this.log('info', `[scheduler] 任务 ${id} 触发，执行 ${taskPath}`)

    // 记录本次触发所属代际：finally 中仅在代际未变（执行期间未 stop/reload）时才补 timer。
    const fireEpoch = this.epoch

    // 旧句柄已触发，从 map 移除（触发的这套由本次 finally 重新装配）。
    this.scheduled.delete(id)

    // 先包一层 try/catch：runner.run 的同步抛错（异常契约实现）也归入异常隔离，
    // 转为 rejected Promise 走下方 catch / finally，避免同步异常穿透调度链、阻塞其它 timer。
    let runPromise: Promise<TaskRunOutcome>
    try {
      runPromise = Promise.resolve(this.runner.run(id, taskPath))
    } catch (err) {
      runPromise = Promise.reject(err)
    }

    void runPromise
      .then((outcome) => {
        // 只消费 outcome：唤醒（woke）由上层投递，scheduler 仅记录诊断。
        if (outcome.kind === 'woke') {
          this.log('info', `[scheduler] 任务 ${id} 唤醒，交由上层投递`)
        } else if (outcome.kind === 'failed') {
          this.log(
            'error',
            `[scheduler] 任务 ${id} 执行失败: ${outcome.reason}${outcome.detail ? ` — ${outcome.detail}` : ''}`,
          )
        } else if (outcome.kind === 'skipped') {
          this.log('warn', `[scheduler] 任务 ${id} 判定无效: ${outcome.reason}`)
        } else {
          // quiet：正常执行完成但未唤醒，也记录 trace，保证「任务确实执行过」可观测。
          this.log('info', `[scheduler] 任务 ${id} 执行完成（未唤醒）`)
        }
      })
      .catch((err) => {
        // runner.run 返回 rejected Promise：异常被隔离，不抛到调度链。
        this.log('error', `[scheduler] 任务 ${id} 触发异常（已隔离）: ${String(err)}`)
      })
      .finally(() => {
        // 链式自调度：无论成功/失败，都重算并重设该任务的下一次触发
        //（除非已 stop，或执行期间发生过 reload —— 由 rescheduleAfterFire 的代际守卫拦截）。
        this.rescheduleAfterFire(id, schedule, taskPath, fireEpoch)
      })
  }

  /**
   * 触发后重设该任务的下一次触发 timer（链式自调度）。
   *
   * 两个守卫，任一命中即不补 timer：
   *   - 若 stop 已发生（`started===false`），不再重设 timer（避免 stop 后残留 timer）。
   *   - **代际守卫（竞态修复核心）**：若 `fireEpoch !== this.epoch`，说明本次 fire 执行
   *     期间发生过 stop/reload（{@link clearAll} 已令代际自增），该任务已被重建或移除；
   *     此时**不得**再补 timer——否则会与 rebuild 新装的 timer 并存（同 id 双份触发 /
   *     泄漏），或复活一个已被禁用 / 删除的任务。
   *
   * 重算过程（next 计算）抛错时被捕获，记录错误后终止该任务的链（不崩溃调度引擎，
   * 也不影响其它任务）；此时该任务不再被调度，直到下一次 reload 重新装配。
   */
  private rescheduleAfterFire(
    id: string,
    schedule: CronSchedule,
    taskPath: string,
    fireEpoch: number,
  ): void {
    if (!this.started) return
    // 代际守卫：执行期间发生过 stop/reload → 旧 fire 不得再补 timer（见方法说明）。
    if (fireEpoch !== this.epoch) return
    try {
      const now = this.clock.now()
      const nextAt = this.cron.next(schedule, now)
      const handle = this.timer.setTimer(nextAt.getTime() - now.getTime(), () => {
        this.fire(id, schedule, taskPath)
      })
      this.scheduled.set(id, { schedule, taskPath, handle })
    } catch (err) {
      this.log('error', `[scheduler] 任务 ${id} 重算下次触发失败，调度链终止: ${String(err)}`)
    }
  }
}

/**
 * 创建调度引擎的工厂函数（无副作用工厂，对齐 types.ts 可注入风格）。
 *
 * @param options 依赖注入配置（store / runner 必填；cron / timer / clock / log 可选）。
 * @returns 就绪的 {@link Scheduler} 实例（未启动，需显式 `start()`）。
 */
export function createScheduler(options: SchedulerOptions): Scheduler {
  return new Scheduler(options)
}

export type { Clock, TaskDef, TaskRunOutcome, Timer }