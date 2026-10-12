/**
 * 任务进程日志采集器（里程碑 M3「任务进程日志独立采集」）。
 *
 * 目标：把**独立任务子进程**的 stdout（非末行内容）+ 全部 stderr **行级**落盘到
 *   `~/.dsh-finance/logs/tasks/<taskId>/<ts>-<pid>.log`，与宿主侧日志（M2 文件 exporter）
 *   分开存储，便于「一个任务一个目录」按任务追溯。
 *
 * 设计要点（对齐技术方案《日志完善技术方案（dsh-finance 插件）v1.0》§5.3 / §9 / §10）：
 *
 *   1. **末行判定（本任务核心难点）**：runner 把 stdout 的**最后一个非空行**当作结果
 *      JSON（`parseLastJsonLine`），其余行才是「日志」。但 stdout 是**流式 chunk**，
 *      流结束前无法预知哪行是末行。故采用「**延迟一行**」策略——
 *        - 逐 chunk 追加，按 `\n` 切出完整行；
 *        - 维护一份**未落盘的待定行缓冲**（`pending`）与「最后一个非空行」的位置；
 *        - 每当出现**新的非空行**，则其**之前**的所有待定行均被确认「非末行」→ 立即落盘，
 *          仅保留该非空行作为「末行候选」；
 *        - 流结束时（{@link TaskLogCollector.close}）：把无换行的残留视为最后一行，
 *          随后**丢弃**所有待定行（含末行结果 JSON 与尾随空行），**绝不落盘**。
 *      这样既保证「末行是 JSON 时不落日志」，又保证「末行之前的行**完整**落盘」，
 *      且**不改动** `parseLastJsonLine` 的既有语义（runner 仍对完整 stdout 解析）。
 *
 *   2. **stderr 全落**：stderr 无「末行」语义，全部按原始文本流式落盘。
 *
 *   3. **单文件上限（防磁盘打爆）**：任务程序不可信；stderr 不受 runner 的 1 MiB
 *      stdout 上限约束，失控输出可无限增长。故本采集器对**单个日志文件**设上限
 *      {@link DEFAULT_TASK_LOG_MAX_SIZE}（10 MB，可经 `DSH_FINANCE_LOG_MAX_SIZE` 覆盖）：
 *      预扣长度，一旦「已写字节 + 本段字节 > 上限」即**停写**并 `warn` 一次（磁盘占用
 *      严格受上限约束）。**停写只影响日志文件**，绝不影响任务执行与结局判定。
 *
 *   4. **任何写盘失败必须降级不抛**：目录创建 / 文件创建 / 追加 / chmod 全部 try/catch，
 *      失败即降级为 no-op，绝不把宿主或任务执行搞崩。
 *
 *   5. **权限与落盘位置**：目录 `0o700`、文件 `0o600`；日志根目录复用 `src/paths.ts`
 *      的 {@link resolveFinanceLogDir}（默认 `~/.dsh-finance/logs`，可经
 *      `DSH_FINANCE_LOG_DIR` 覆盖）；任务日志目录 = `<logDir>/tasks/<taskId>`。
 *      即便任务只输出了结果 JSON（无任何日志行），也会**留档一个空文件**，便于确认
 *      「该任务本次确实运行过」。
 *
 *   6. **零第三方依赖**：只用 `node:fs` / `node:path` 与本包 `src/paths.ts` / `src/log/logger.ts`。
 *
 * 本模块不做 trace 上下文（M4）/ 去敏（M5）。
 */
import { appendFileSync, chmodSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { LOG_MAX_SIZE_ENV } from './file-exporter.js'
import { createLogger } from './logger.js'
import { resolveFinanceLogDir } from '../paths.js'

/** 环境变量：任务日志单文件上限（字节）；复用宿主日志同名变量。 */
export const TASK_LOG_MAX_SIZE_ENV = LOG_MAX_SIZE_ENV

/** 任务日志默认单文件上限：10 MB（任务侧，低于宿主日志的 50 MB）。 */
export const DEFAULT_TASK_LOG_MAX_SIZE = 10 * 1024 * 1024

/** 任务日志在日志根目录下的子目录名（`<logDir>/tasks/<taskId>`）。 */
export const TASK_LOG_SUBDIR = 'tasks'

/** 任务 id 缺失 / 非法，或 pid 缺失时的降级占位段。 */
export const TASK_LOG_UNKNOWN_SEGMENT = 'unknown'

/** 采集器日志出口（与调度层 logger 同签名）。 */
export type TaskLogFunction = (level: 'info' | 'warn' | 'error', message: string) => void

/** {@link createTaskLog} 选项。 */
export interface TaskLogOptions {
  /** 日志根目录覆盖；缺省取 `DSH_FINANCE_LOG_DIR` → `~/.dsh-finance/logs`。 */
  readonly dir?: string
  /** 单文件上限（字节）；缺省取 `DSH_FINANCE_LOG_MAX_SIZE` → {@link DEFAULT_TASK_LOG_MAX_SIZE}。 */
  readonly maxSize?: number | string
  /** 时间源（文件名 `<ts>` 段）；缺省 `() => new Date()`。注入便于测试确定性命名。 */
  readonly now?: () => Date
  /** warn / error 出口；缺省走统一日志门面（{@link createLogger}）。 */
  readonly log?: TaskLogFunction
}

/** 采集目标：任务 id + 进程 pid。 */
export interface TaskLogTarget {
  /** 任务 id（对应 `TaskDef.id`），用作 `<logDir>/tasks/<taskId>` 目录名。 */
  readonly taskId: string
  /** 子进程 pid（可选）；缺失时文件名 `<pid>` 段降级为 `unknown`。 */
  readonly pid?: number
}

/**
 * 任务进程日志采集器。
 *
 * 生命周期：`createTaskLog()` 构造即建目录 / 建空文件；`writeStdoutChunk` / `writeStderrChunk`
 * 流式追加；`close()` 收尾（丢弃末行结果 JSON）。所有方法**永不抛**。
 */
export interface TaskLogCollector {
  /** 日志文件绝对路径；初始化失败（降级）时为 `null`。 */
  readonly path: string | null
  /** 追加一段 stdout 文本（「延迟一行」：仅把已确认非末行的行落盘）。 */
  writeStdoutChunk(text: string): void
  /** 追加一段 stderr 文本（全部落盘）。 */
  writeStderrChunk(text: string): void
  /** 收尾：丢弃仍待定的末行（结果 JSON + 尾随空行）；幂等。 */
  close(): void
}

/** 值 → 正整数（> 0）；非法 / 非正 / 缺失返回 `undefined`。 */
function toPositiveInt(value: unknown): number | undefined {
  if (typeof value === 'number') {
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : undefined
  }
  return undefined
}

/**
 * 解析任务日志单文件上限（字节）：显式 > 环境变量 {@link TASK_LOG_MAX_SIZE_ENV}
 * > {@link DEFAULT_TASK_LOG_MAX_SIZE}。
 */
export function resolveTaskLogMaxSize(explicit?: number | string): number {
  const fromExplicit = toPositiveInt(explicit)
  if (fromExplicit !== undefined) return fromExplicit
  const env = typeof process !== 'undefined' ? process.env?.[TASK_LOG_MAX_SIZE_ENV] : undefined
  const fromEnv = toPositiveInt(env)
  if (fromEnv !== undefined) return fromEnv
  return DEFAULT_TASK_LOG_MAX_SIZE
}

/** 日期 → 文件名安全的时间戳（ISO 8601，`:` 与 `.` 换成 `-`）。 */
export function formatTaskLogTimestamp(date: Date): string {
  return date.toISOString().replace(/[:.]/g, '-')
}

/** pid → 文件名段；非整数 / 负数 / 缺失 → {@link TASK_LOG_UNKNOWN_SEGMENT}。 */
export function formatTaskLogPid(pid?: number): string {
  return typeof pid === 'number' && Number.isInteger(pid) && pid >= 0
    ? String(pid)
    : TASK_LOG_UNKNOWN_SEGMENT
}

/** 路径段净化：剔除路径分隔符 / NUL（防目录穿越）；空白段回退占位。 */
function sanitizeSegment(segment: string): string {
  const cleaned = segment.replace(/[/\\\u0000]/g, '_').trim()
  return cleaned.length > 0 ? cleaned : TASK_LOG_UNKNOWN_SEGMENT
}

/** 默认 warn / error 出口：统一日志门面（M1），降级路径内部走 console（仅门面允许）。 */
function defaultLog(): TaskLogFunction {
  const logger = createLogger('dsh-finance:task-log')
  return (level, message): void => {
    logger[level](message)
  }
}

/** {@link TaskLogCollector} 实现。所有公开方法永不抛。 */
class TaskLogCollectorImpl implements TaskLogCollector {
  /** 日志文件绝对路径；降级时为 `null`。 */
  readonly path: string | null = null
  /** 单文件上限（字节）。 */
  private readonly maxSize: number
  /** 日志出口。 */
  private readonly logFn: TaskLogFunction
  /** 已写字节数（近似按 UTF-8 字节）。 */
  private written = 0
  /** 是否已停写（超限 / 写失败后置位）。 */
  private stopped = false
  /** 是否已对「超限停写」告警过（去重）。 */
  private warned = false
  /** 是否已收尾。 */
  private closed = false
  /** 文件权限是否已兜底 chmod 为 `0o600`。 */
  private modeFixed = false
  /** stdout 未完成行缓冲（尚未见到换行的尾部）。 */
  private raw = ''
  /**
   * stdout「待定的行缓冲」：已切出但尚未落盘的行（含末行候选）。
   *
   * 不变式：`pending` 中至多保留从「最后一个非空行」到结尾的行——即一个非空行 + 其后
   * 若干空行；更早的行一旦出现更晚的非空行即被确认为「非末行」并落盘。
   */
  private pending: string[] = []

  constructor(target: TaskLogTarget, options?: TaskLogOptions) {
    this.maxSize = resolveTaskLogMaxSize(options?.maxSize)
    this.logFn = options?.log ?? defaultLog()
    try {
      const root = resolveFinanceLogDir(options?.dir)
      const dir = join(root, TASK_LOG_SUBDIR, sanitizeSegment(target.taskId))
      mkdirSync(dir, { recursive: true, mode: 0o700 })
      try {
        chmodSync(dir, 0o700)
      } catch {
        /* umask / 平台差异兜底：mkdir mode 已尽量收紧。 */
      }
      const now = options?.now ?? ((): Date => new Date())
      const name = `${formatTaskLogTimestamp(now())}-${formatTaskLogPid(target.pid)}.log`
      const path = join(dir, name)
      // 建空文件：即便任务无任何日志行（只输出结果 JSON），也留档「本次运行」。
      appendFileSync(path, '', { mode: 0o600 })
      this.path = path
      try {
        chmodSync(path, 0o600)
        this.modeFixed = true
      } catch {
        /* 权限收紧失败不致命。 */
      }
    } catch (err) {
      // 初始化失败 → 降级 no-op，绝不影响任务执行。
      this.path = null
      this.safeLog('warn', `[task-log] 任务 ${target.taskId} 日志初始化失败，已降级停写: ${describeError(err)}`)
    }
  }

  writeStdoutChunk(text: string): void {
    if (this.closed || this.stopped) return
    if (text.length === 0) return
    this.raw += text
    let idx = this.raw.indexOf('\n')
    while (idx >= 0) {
      const line = this.raw.slice(0, idx)
      this.raw = this.raw.slice(idx + 1)
      this.ingestStdoutLine(line)
      if (this.stopped) break
      idx = this.raw.indexOf('\n')
    }
    if (this.stopped) {
      // 停写后不再需要缓冲。
      this.raw = ''
      this.pending = []
    }
  }

  writeStderrChunk(text: string): void {
    if (this.closed || this.stopped) return
    if (text.length === 0) return
    this.appendRaw(text)
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    if (this.stopped) {
      this.pending = []
      this.raw = ''
      return
    }
    // 无换行的残留视为最后一行：先推进「末行判定」（把更早的待定行确认为非末行并落盘），
    // 之后统一丢弃仍待定的行（含末行结果 JSON 与尾随空行）——绝不落盘。
    if (this.raw.length > 0) {
      this.ingestStdoutLine(this.raw)
      this.raw = ''
    }
    this.pending = []
  }

  /** 处理一行 stdout（含末行判定）——只把「已确认非末行」的行落盘。 */
  private ingestStdoutLine(line: string): void {
    this.pending.push(line)
    if (line.trim().length === 0) return // 空行：保留待定（顺序敏感），不下判断。
    // 出现新的非空行 → 其之前所有待定行均确认非末行 → 全部落盘，仅保留本行作末行候选。
    const toFlush = this.pending.slice(0, -1)
    this.pending = [line]
    for (const prior of toFlush) this.appendRaw(`${prior}\n`)
  }

  /** 追加一段原始文本到日志文件；预扣上限，超限停写并 warn 一次。 */
  private appendRaw(text: string): void {
    if (this.stopped) return
    const path = this.path
    if (path === null) {
      // 初始化即失败：静默（构造时已 warn 一次）。
      return
    }
    const bytes = Buffer.byteLength(text)
    if (this.written + bytes > this.maxSize) {
      this.stopped = true
      if (!this.warned) {
        this.warned = true
        this.safeLog(
          'warn',
          `[task-log] 任务日志超过单文件上限（${this.maxSize} 字节），已停写: ${path}`,
        )
      }
      return
    }
    try {
      appendFileSync(path, text, { mode: 0o600 })
      this.written += bytes
      if (!this.modeFixed) {
        try {
          chmodSync(path, 0o600)
          this.modeFixed = true
        } catch {
          /* 权限收紧失败不致命。 */
        }
      }
    } catch {
      // 写盘失败 → 降级停写，不抛。
      this.stopped = true
    }
  }

  /** warn 出口本身也绝不抛。 */
  private safeLog(level: 'info' | 'warn' | 'error', message: string): void {
    try {
      this.logFn(level, message)
    } catch {
      /* 日志出口异常一律吞掉。 */
    }
  }
}

/** 错误 → 简短描述。 */
function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * 创建任务进程日志采集器。
 *
 * 构造即建目录（`0o700`）与空文件（`0o600`）；任何失败都降级为 no-op（{@link TaskLogCollector.path}
 * 为 `null`），**永不抛**。
 *
 * @param target  任务 id + pid。
 * @param options 目录 / 上限 / 时间源 / 日志出口覆盖。
 */
export function createTaskLog(target: TaskLogTarget, options?: TaskLogOptions): TaskLogCollector {
  return new TaskLogCollectorImpl(target, options)
}
