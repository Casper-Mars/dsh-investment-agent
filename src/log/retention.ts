/**
 * 日志保留策略（里程碑「日志治理」）。
 *
 * 目标：为文件 exporter 提供**按天保留 + 过期清理**能力，避免日志目录无限增长。
 *
 * 口径（对齐技术方案 §5 日志治理 / §6 第 8 项）：
 *   1. **默认保留 30 天**（{@link DEFAULT_LOG_RETENTION_DAYS}），可经显式参数或环境变量
 *      {@link LOG_RETENTION_DAYS_ENV}（`DSH_IA_LOG_RETENTION_DAYS`）覆盖；非正数一律回落默认。
 *   2. **递归扫描** `dir` 下的 `*.jsonl` 与 `*.log`（含 `tasks/<id>/*.log` 等子目录）；
 *      **不跟随符号链接**，只删普通文件（目录 / 链接一律跳过）。
 *   3. **过期判据**：
 *      - 文件名匹配 `^(\d{4})-(\d{2})-(\d{2})(-\d+)?\.jsonl$`（exporter 的按天 / 滚动命名）
 *        → 用**文件名日期**（UTC 00:00）作为文件时间，避免「旧内容被复制 / 触碰后 mtime 变新」
 *        导致漏删；
 *      - 其余文件（如任务日志 `tasks/<id>/xxx.log`）→ 用 `mtimeMs`。
 *      文件时间早于 `now - retentionDays * 86400000` 即视为过期。
 *   4. **健壮性**：纯函数式（`now` 可注入，便于测试）；任何单个文件删除失败只标记
 *      `degraded` 并继续，**绝不抛异常**（日志设施自身不得影响主流程）。
 */
import { lstatSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'

/** 环境变量：日志保留天数。默认 {@link DEFAULT_LOG_RETENTION_DAYS}。 */
export const LOG_RETENTION_DAYS_ENV = 'DSH_IA_LOG_RETENTION_DAYS'

/** 默认日志保留天数：30 天。 */
export const DEFAULT_LOG_RETENTION_DAYS = 30

/** 一天毫秒数。 */
const DAY_MS = 24 * 60 * 60 * 1000

/** 递归深度上限（防御异常深层目录；正常日志结构远低于此值）。 */
const MAX_SCAN_DEPTH = 32

/** 认作日志的文件扩展名（小写比较）。 */
const LOG_EXTENSIONS: readonly string[] = ['.jsonl', '.log']

/** exporter 按天文件名的日期部分：`YYYY-MM-DD`，可选 `-N` 滚动后缀，扩展名 `.jsonl`。 */
const DATED_LOG_RX = /^(\d{4})-(\d{2})-(\d{2})(?:-\d+)?\.jsonl$/

/** {@link cleanupExpiredLogs} 选项。 */
export interface CleanupExpiredLogsOptions {
  /** 日志根目录（不存在时视为无过期文件）。 */
  dir: string
  /** 保留天数（> 0）；缺省取 {@link LOG_RETENTION_DAYS_ENV} → {@link DEFAULT_LOG_RETENTION_DAYS}。 */
  retentionDays?: number
  /** 当前时间（epoch ms）；默认 `Date.now()`，便于测试注入。 */
  now?: number
  /** 可选日志回调（仅用于删除失败等降级信息，缺省静默）。 */
  logger?: (msg: string) => void
}

/** {@link cleanupExpiredLogs} 结果。 */
export interface CleanupExpiredLogsResult {
  /** 已删除文件的路径（按扫描顺序）。 */
  deleted: string[]
  /** 扫描到的日志文件数（`*.jsonl` / `*.log` 普通文件）。 */
  scanned: number
  /** 是否存在任何降级（读取 / 删除失败）；`true` 表示清理不完整。 */
  degraded: boolean
}

/** 保留天数解析：显式（> 0）> 环境变量（> 0）> 默认 30。 */
export function resolveRetentionDays(explicit?: number): number {
  if (typeof explicit === 'number' && Number.isFinite(explicit) && explicit > 0) {
    return Math.floor(explicit)
  }
  const env = typeof process !== 'undefined' ? process.env?.[LOG_RETENTION_DAYS_ENV] : undefined
  if (typeof env === 'string' && env.trim() !== '') {
    const parsed = Number(env)
    if (Number.isFinite(parsed) && parsed > 0) return Math.floor(parsed)
  }
  return DEFAULT_LOG_RETENTION_DAYS
}

/** 判据：文件名是否为日志扩展名（大小写不敏感）。 */
function isLogFileName(name: string): boolean {
  const lower = name.toLowerCase()
  return LOG_EXTENSIONS.some((ext) => lower.endsWith(ext))
}

/**
 * 文件名日期（UTC 00:00 的 epoch ms）；非日期命名 / 非法日期返回 `undefined`。
 *
 * 严格校验 `YYYY-MM-DD` 的合法性（如 `2026-13-40` 视为非法 → 回落 mtime）。
 */
function parseDatedLogMs(name: string): number | undefined {
  const match = DATED_LOG_RX.exec(name)
  if (!match) return undefined
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const ms = Date.UTC(year, month - 1, day)
  const d = new Date(ms)
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) {
    return undefined
  }
  return ms
}

/** 递归扫描 + 删除实现（内部可变状态容器）。 */
interface CleanupState {
  readonly cutoff: number
  readonly deleted: string[]
  readonly failures: string[]
  scanned: number
  readonly logger?: (msg: string) => void
}

/** 单个文件：判定过期 → 删除（失败只记录，不中断）。 */
function maybeDelete(path: string, name: string, state: CleanupState): void {
  state.scanned += 1
  const dated = parseDatedLogMs(name)
  let fileMs: number
  if (dated !== undefined) {
    fileMs = dated
  } else {
    try {
      fileMs = statSync(path).mtimeMs
    } catch {
      state.failures.push(`${path}: stat failed`)
      return
    }
  }
  if (fileMs >= state.cutoff) return
  try {
    rmSync(path, { force: true })
    state.deleted.push(path)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    state.failures.push(`${path}: ${message}`)
    state.logger?.(`log retention: failed to delete ${path}: ${message}`)
  }
}

/** 递归目录：不跟随符号链接、只处理普通文件。 */
function scanDir(dir: string, depth: number, state: CleanupState): void {
  if (depth > MAX_SCAN_DEPTH) return
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    state.failures.push(`${dir}: readdir failed`)
    return
  }
  for (const entry of entries) {
    const path = join(dir, entry.name)
    if (entry.isSymbolicLink()) continue
    if (entry.isDirectory()) {
      scanDir(path, depth + 1, state)
      continue
    }
    if (!entry.isFile()) continue
    if (!isLogFileName(entry.name)) continue
    maybeDelete(path, entry.name, state)
  }
}

/**
 * 清理过期日志（纯函数式；不抛异常）。
 *
 * @param options 见 {@link CleanupExpiredLogsOptions}。
 * @returns 删除列表 / 扫描数 / 是否降级。
 */
export function cleanupExpiredLogs(
  options: CleanupExpiredLogsOptions,
): CleanupExpiredLogsResult {
  const { dir } = options
  const retentionDays = resolveRetentionDays(options.retentionDays)
  const now = typeof options.now === 'number' && Number.isFinite(options.now) ? options.now : Date.now()
  const cutoff = now - retentionDays * DAY_MS

  const state: CleanupState = {
    cutoff,
    deleted: [],
    failures: [],
    scanned: 0,
    logger: options.logger,
  }

  if (typeof dir !== 'string' || dir.trim() === '') {
    return { deleted: [], scanned: 0, degraded: false }
  }

  // 根目录不存在 → 无过期文件（非降级）；其他读取异常由 scanDir 记录。
  try {
    const root = lstatSync(dir)
    if (root.isSymbolicLink() || !root.isDirectory()) {
      return { deleted: [], scanned: 0, degraded: false }
    }
  } catch {
    return { deleted: [], scanned: 0, degraded: false }
  }

  scanDir(dir, 0, state)
  return {
    deleted: state.deleted,
    scanned: state.scanned,
    degraded: state.failures.length > 0,
  }
}

/**
 * 判据辅助（导出供测试 / 调用方复用）：是否为 exporter 的按天 / 滚动日志文件名。
 */
export function isDatedLogFileName(name: string): boolean {
  return parseDatedLogMs(name) !== undefined
}

