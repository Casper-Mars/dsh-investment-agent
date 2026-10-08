/**
 * scheduler 层入口：装配「定时任务多任务调度 + 依赖加载 + 唤醒投递 + 7 工具」并接入插件生命周期。
 *
 * `applyScheduler(ctx)`（由 `src/plugin.ts` 的 `apply` 调用）：
 *   1. 解析 dataRoot（复用 tools 层 {@link DATA_ROOT_ENV} / {@link DEFAULT_DATA_DIR} 的
 *      注入优先级：构造注入 > 环境变量 `DSH_FINANCE_DATA_DIR` > 默认 `<cwd>/.dsh-finance/data`），
 *      并显式派生任务清单目录 `join(dataRoot, 'tasks')`——**不依赖 `process.cwd()`**；
 *   2. `createTaskStore(tasksDir)` 建任务清单 store；
 *   3. 组装「编排 runner」（本层真正难点）：满足 `TaskRunnerLike`（`run(taskPath)` 不携带
 *      taskId），在 `run()` 内完成设计文档 §4.3 完整链路——
 *      `由 taskPath 反查 taskId → loader 依赖就绪 → runner 独立进程执行 → 解析 outcome →
 *      shouldWake=true 时 waker.wake(taskId, data) 投递`；
 *   4. `createScheduler({ store, runner: 编排runner })`（多任务独立调度引擎）；
 *   5. 经 `ctx.inject(['agents'], cb)` 动态注入 agents 构造**可变引用** waker（拿不到则降级
 *      waker=undefined，唤醒走 skipped，不中断）；
 *   6. 惰性 import `./tools.js` 注册 7 个 `task_*` 工具（注销器绑定 `ctx.effect`）；
 *   7. `ctx.effect` 自持 start/stop（幂等 `started` 守卫，多会话不重复 start）。
 *
 * 顶层 `inject = ['tools','skills','ptcRuntime','fs']` **保持不变**（agents/tools 经
 * `ctx.inject` / `ctx.get` 软取，不加入顶层 inject）。
 */
import { dirname, join, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { DATA_ROOT_ENV, DEFAULT_DATA_DIR } from '../tools/context.js'
import { createTaskStore, type TaskStore } from './store.js'
import { createTaskLoader, LoaderError, type TaskLoader } from './loader.js'
import { createTaskRunner, type TaskRunner } from './runner.js'
import {
  createScheduler,
  type Scheduler,
  type TaskRunnerLike,
} from './scheduler.js'
import { createWaker, type Waker } from './wake.js'
import type { AgentRegistryLike, TaskRunOutcome } from './types.js'

export * from './types.js'
export { createTaskStore, TaskStore, defaultTasksDir, type TaskListResult } from './store.js'
export {
  createTaskLoader,
  TaskLoader,
  LoaderError,
  ensureTaskDeps,
  DEFAULT_INSTALL_TIMEOUT_MS,
  type InstallSpawner,
  type InstallSpawnResult,
  type LoaderFs,
  type LoaderOptions,
} from './loader.js'
export {
  createTaskRunner,
  TaskRunner,
  parseLastJsonLine,
  DEFAULT_TASK_TIMEOUT_MS,
  type RunnerOptions,
  type TimeBudget,
} from './runner.js'
export { createScheduler, Scheduler, type SchedulerOptions, type TaskRunnerLike } from './scheduler.js'
export {
  createWaker,
  Waker,
  buildWakeText,
  deriveSummary,
  boundPayload,
  WAKE_TARGET_ID,
  DEFAULT_WAKE_TEXT_BUDGET,
  DEFAULT_WAKE_COOLDOWN_MS,
  type WakerOptions,
  type WakeDeliveryResult,
} from './wake.js'
export { createSchedulerTools, type SchedulerToolsOptions } from './tools.js'
export {
  parseCron,
  isValidCron,
  next,
  SHANGHAI_TIME_ZONE,
  type CronSchedule,
  type FieldSchedule,
} from './cron.js'

/** `applyScheduler` 配置。 */
export interface SchedulerApplyOptions {
  /** 数据根目录（可选）；省略时依次取环境变量 → 默认值。 */
  dataRoot?: string
  /** 唤醒文本预算（字符）；默认 {@link DEFAULT_WAKE_TEXT_BUDGET}。 */
  wakeTextBudget?: number
  /** 唤醒冷却（ms）；默认 {@link DEFAULT_WAKE_COOLDOWN_MS}。 */
  wakeCooldownMs?: number
  /** 调度日志钩子（level + message）。默认分流到 console。 */
  logger?: (level: 'info' | 'warn' | 'error', message: string) => void
}

/**
 * 解析数据根目录（构造注入 > 环境变量 > 默认值）。
 *
 * 与 `src/tools/context.ts` 的 `resolveDataRoot` 逻辑完全一致（复用其导出的
 * {@link DATA_ROOT_ENV} / {@link DEFAULT_DATA_DIR} 常量），仅在 scheduler 装配层独立
 * 实现，避免为取一个路径而实例化整个 ToolContext（Ledger / Predicts 等领域类）。
 */
function resolveDataRoot(explicit?: string): string {
  if (explicit && explicit.trim() !== '') return resolve(explicit)
  const env = process.env[DATA_ROOT_ENV]
  if (env && env.trim() !== '') return resolve(env)
  return resolve(process.cwd(), DEFAULT_DATA_DIR)
}

/**
 * 装配并启动定时任务调度（自持，随插件生命周期启停）。
 *
 * @param ctx 插件上下文（顶层 inject 已保证 `fs` 就绪；agents/tools 经软取注入）。
 * @param options 覆盖项（数据根 / 唤醒预算 / 冷却 / 日志）。
 */
export function applyScheduler(ctx: Context, options: SchedulerApplyOptions = {}): void {
  const log: (level: 'info' | 'warn' | 'error', message: string) => void =
    options.logger ??
    ((level, message) => {
      if (level === 'error') console.error(message)
      else if (level === 'warn') console.warn(message)
      else console.log(message)
    })

  // ---- 1) 解析 dataRoot，并显式派生任务清单目录（不依赖 process.cwd()） ----
  const dataRoot = resolveDataRoot(options.dataRoot)
  const tasksDir = join(dataRoot, 'tasks')

  // ---- 2) 任务清单 store ----
  const store: TaskStore = createTaskStore(tasksDir)

  // ---- 3) 编排 runner：loader → runner → waker 的完整 §4.3 链路 ----
  // scheduler.ts 的 Scheduler 只注入 TaskRunnerLike（run(taskPath) 不携带 taskId），
  // 且拿到 woke outcome 后「只消费不投递」。这里构造一个满足 TaskRunnerLike 的编排
  // runner，在 run() 内补上「taskId 反查 + 依赖安装 + woke 投递」。
  const loader: TaskLoader = createTaskLoader()
  const taskRunner: TaskRunner = createTaskRunner()

  // waker 为**可变引用**：agents 经 ctx.inject(['agents']) 异步回调拿到后才就绪；
  // scheduler.start() 在 ctx.effect 内同步执行，编排 runner 在触发时读**最新** waker。
  let waker: Waker | undefined

  const orchestratedRunner: TaskRunnerLike = {
    async run(taskPath: string): Promise<TaskRunOutcome> {
      // 3a) 由 taskPath 反查 taskId（store.list 找 task_path === taskPath）。
      //     scheduler 传进来的 taskPath 即 TaskDef.task_path 原文（相对路径），
      //     这里用 store 的 list() 现查，避免装配期快照过期（tools 写库后 reload）。
      let taskId: string | undefined
      let taskDef: { readonly id: string; readonly task_path: string } | undefined
      try {
        const { tasks } = store.list()
        const found = tasks.find((t) => t.task_path === taskPath)
        if (found) {
          taskId = found.id
          taskDef = found
        }
      } catch (err) {
        log('error', `[dsh-finance/scheduler] 反查任务失败（${taskPath}）: ${String(err)}`)
      }

      if (!taskId || !taskDef) {
        // 找不到对应任务：跳过（不抛、不中断调度链）。
        const reason = `[scheduler/orchestrator] 未找到 task_path=${taskPath} 对应的任务，跳过`
        log('warn', reason)
        return { kind: 'skipped', reason }
      }

      // 3b) 任务程序绝对路径 + 任务目录（含 package.json）。
      const absTaskPath = resolve(dataRoot, taskDef.task_path)
      const taskDir = dirname(absTaskPath)

      // 3c) loader 依赖就绪（编排责任，设计 §4.3「到点 → 依赖就绪 → 执行」）。
      try {
        await loader.installTaskDeps(taskId, taskDir)
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err)
        const reason = `[scheduler/orchestrator] 任务 ${taskId} 依赖安装失败: ${detail}`
        log('error', reason)
        return {
          kind: 'failed',
          reason,
          detail,
          failureKind: 'install',
        }
      }

      // 3d) runner 独立进程执行。
      let outcome: TaskRunOutcome
      try {
        outcome = await taskRunner.run(absTaskPath)
      } catch (err) {
        // runner 异常契约实现（reject）：归为 failed，不穿透调度链。
        const detail = err instanceof Error ? err.message : String(err)
        log('error', `[scheduler/orchestrator] 任务 ${taskId} 执行异常: ${detail}`)
        return { kind: 'failed', reason: `执行异常: ${detail}`, detail, failureKind: 'exec' }
      }

      // 3e) 仅 woke 需要投递；waker 未就绪/降级 → skipped。
      if (outcome.kind !== 'woke') return outcome

      if (!waker) {
        const reason = `[scheduler/orchestrator] 任务 ${taskId} 唤醒但 waker 未就绪（agents 不可用），降级 skipped`
        log('warn', reason)
        return { kind: 'skipped', reason, detail: 'agents 服务不可用，唤醒降级' }
      }

      // 3f) waker.wake(taskId, data) 投递，回填 targets；delivered:false → skipped（§9.1）。
      let delivery
      try {
        delivery = waker.wake(taskId, outcome.data)
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err)
        const reason = `[scheduler/orchestrator] 任务 ${taskId} 唤醒投递异常，降级 skipped: ${detail}`
        log('error', reason)
        return { kind: 'skipped', reason, detail }
      }

      if (!delivery.delivered) {
        return {
          kind: 'skipped',
          reason: delivery.reason,
          detail: '唤醒投递降级（投递数 0）',
        }
      }

      return {
        kind: 'woke',
        reason: `[scheduler/orchestrator] 任务 ${taskId} 已唤醒并投递`,
        data: outcome.data,
        targets: delivery.targets,
      }
    },
  }

  // ---- 4) 多任务独立调度引擎 ----
  const scheduler: Scheduler = createScheduler({
    store,
    runner: orchestratedRunner,
    log,
  })

  // ---- 5) 动态注入 agents 构造 waker（拿不到则降级，不抛、不中断） ----
  ctx.inject(['agents'], (agentCtx) => {
    const agents = agentCtx.get('agents') as AgentRegistryLike | undefined
    if (!agents || typeof agents.get !== 'function') {
      log('warn', '[dsh-finance/scheduler] agents 服务不可用，唤醒将降级为跳过')
      waker = undefined
      return
    }
    waker = createWaker({
      agents,
      wakeTextBudget: options.wakeTextBudget,
      wakeCooldownMs: options.wakeCooldownMs,
      log,
    })
    log('info', '[dsh-finance/scheduler] 唤醒通道已就绪（定点投递）')
  })

  // ---- 6) 惰性注册 7 个 task_* 工具（注销器绑定 ctx.effect） ----
  ctx.effect(() => {
    let cancelled = false
    let disposeTools: (() => void) | undefined

    // 安全降级：tools 服务不可用（最小上下文 / 装载测试）时跳过，不中断装载。
    const tools = typeof ctx.get === 'function' ? ctx.get('tools') : undefined
    if (!tools || typeof tools.register !== 'function') {
      log('warn', '[dsh-finance/scheduler] tools 服务不可用，跳过 scheduler 工具注册')
    } else {
      void import('./tools.js')
        .then(({ createSchedulerTools }) => {
          if (cancelled) return // 插件在动态加载完成前已被卸载：跳过。
          const defs = createSchedulerTools({ store, scheduler })
          const disposers = defs.map((d) => tools.register(d))
          disposeTools = () => {
            for (let i = disposers.length - 1; i >= 0; i -= 1) disposers[i]?.()
          }
        })
        .catch((err: unknown) => {
          log('error', `[dsh-finance/scheduler] scheduler 工具注册失败: ${String(err)}`)
        })
    }

    return () => {
      cancelled = true
      disposeTools?.()
    }
  }, 'dsh-finance scheduler tools')

  // ---- 7) 自持启停：apply 即启动，随 effect 卸载 stop（幂等守卫） ----
  let started = false
  ctx.effect(() => {
    if (!started) {
      scheduler.start()
      started = true
    }
    return () => {
      if (started) {
        scheduler.stop()
        started = false
      }
    }
  }, 'dsh-finance scheduler')
}