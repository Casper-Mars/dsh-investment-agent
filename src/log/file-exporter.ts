/**
 * 文件落地 exporter（里程碑 M2「文件落地」）。
 *
 * 目标：在 M1 统一门面（`src/log/logger.ts`）之上，追加一个**文件 exporter**，
 * 把宿主内日志以 **JSONL** 形式落地到 `~/.dsh-finance/logs/<date>.jsonl`，并支持
 * 「按天轮转 + 同日超阈值后缀 + 级别过滤 + 文件权限」。
 *
 * 设计要点（对齐技术方案《日志完善技术方案（dsh-finance 插件）v1.0》§4.2 / §5.2 / §9 M2）：
 *   1. **复用 cordis `Exporter` 契约**：本模块导出一个符合
 *      `import type { Exporter, Message } from '@deepseek-ai/cordis'` 的工厂
 *      {@link createFileExporter}，经 `ctx.logger.exporter(exporter)` **追加注册**
 *      （不改动宿主既有 exporter，也不新增顶层 `inject` 依赖）。
 *   2. **JSONL 记录形状**（§4.2）：`{ ts, level, name, msg, args?, pid, origin }`。
 *      `ts` 为 `message.ts`（epoch ms）转 ISO；`msg` 由 `message.args` 的 printf 风格
 *      首参展开；`args` 为结构化附加数据（M1 门面把 `meta` 作为第二参传入）。
 *      写盘前经 M5 {@link ./redact.js} 的 {@link redactRecord} 做**字段级去敏**（`msg` 文本级 /
 *      `args` 深遍历）；`sessionId/taskId/traceId` 由 M4 trace 上下文自动并入 `meta`。
 *   3. **按天轮转**：文件名带日期（`message.ts` 的 UTC 日期）→ 跨天自然新开当日文件；
 *      同日若当前文件已达阈值 `DSH_FINANCE_LOG_MAX_SIZE`（默认 50 MB），则递增后缀
 *      `-1`、`-2`… 选下一个未达阈值的文件。
 *   4. **写策略**：`fs.appendFileSync` 逐行追加（单条 JSON + `\n`）——同步写保证
 *      「`export()` 返回后内容已在盘上」，崩溃不丢已写行，且天然保证同进程内写入有序。
 *      **所有 fs / 序列化异常一律 try/catch 吞掉降级**：日志设施自身绝不把宿主搞崩。
 *   5. **权限**：目录 `0o700`（经 `ensureFinanceLogDir`）、文件 `0o600`（创建时 `mode`
 *      + 显式 `chmod` 兜底，规避 umask）。
 *   6. **级别过滤（关键陷阱）**：cordis 的**数值**级别序为 `ERROR=0, INFO=1, WARN=2,
 *      DEBUG=3`，与方案 §4.1 严重度序 `error ≤ warn ≤ info ≤ debug` **不一致**
 *      （info/warn 相反）。故**不**用 cordis 数值阈值过滤，而是：
 *        - 让 exporter `levels.default = 3`（DEBUG 数值）→ 保证 cordis 侧**全量放行**，
 *          我们拿到所有消息；
 *        - 在 `export()` 内按 `message.type` 的方案严重度 {@link LEVEL_RANK}
 *          （`error=0, warn=1, info=2, debug=3`）判定：`rank(type) > rank(threshold)`
 *          即丢弃。
 *      阈值取 `options.level` → 环境变量 `DSH_FINANCE_LOG_LEVEL` → 默认 `info`
 *      （复用 M1 门面的 {@link resolveLogLevel} / {@link LEVEL_RANK}，避免口径漂移）。
 *   7. **name 白名单（本插件命名空间）**：本 exporter 追加注册在**共享** `ctx.logger`
 *      上，会长到宿主核心 / 其它插件（如 `skill-filesystem`）的日志。方案 §3.1 的
 *      日志出口针对的是**本插件宿主侧日志**，故只接受 name 属于本插件命名空间的消息：
 *      `name === p` 或 `name` 以 `p + ':'` 为前缀（子 scope），`p ∈ options.names`
 *      （默认 `['dsh-finance']`）。与上面的级别过滤**叠加**（两者都满足才落盘）。
 *
 * 8. **去敏（M5）**：写盘前对 `msg` 与 `args` 统一去敏——敏感 / 金额键值 → `[REDACTED]`、
 *    长文本截断、`Error` 仅记 message + 前 N 行 stack。去敏口径见 `src/log/redact.ts`。
 *
 * 不引第三方依赖；不改顶层 `inject`（仍 `['tools','skills','fs']`）。
 */
import { appendFileSync, chmodSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { Exporter, Message } from '@deepseek-ai/cordis'
import {
  LEVEL_RANK,
  resolveLogLevel,
  type LogLevel,
} from './logger.js'
import { redactRecord, type RedactOptions } from './redact.js'
import { ensureFinanceLogDir, resolveFinanceLogDir } from '../paths.js'

/** 环境变量：轮转 / 封顶阈值（字节）。默认 {@link DEFAULT_LOG_MAX_SIZE}。 */
export const LOG_MAX_SIZE_ENV = 'DSH_FINANCE_LOG_MAX_SIZE'

/** 默认单文件大小阈值：50 MB（宿主日志）。 */
export const DEFAULT_LOG_MAX_SIZE = 50 * 1024 * 1024

/** 同日轮转后缀的防御性上限：极端配置下避免死循环（正常远不会触达）。 */
const MAX_ROTATION_INDEX = 9999

/**
 * 默认接受落盘的 logger name 白名单（本插件命名空间）。
 *
 * 匹配规则：`name === p` 或 `name` 以 `p + ':'` 为前缀（子 scope，如
 * `dsh-finance:scheduler`）。`exporter` 注册在**共享** `ctx.logger` 上，故须收窄到
 * 本插件命名的日志，避免宿主核心 / 其它插件的日志被落盘。
 */
export const DEFAULT_EXPORT_NAMES: readonly string[] = ['dsh-finance']

/** {@link createFileExporter} 选项。 */
export interface FileExporterOptions {
  /** 日志目录；缺省时取 `DSH_FINANCE_LOG_DIR` → `~/.dsh-finance/logs`。 */
  dir?: string
  /** 单文件大小阈值（字节，> 0）；缺省取 `DSH_FINANCE_LOG_MAX_SIZE` → 50 MB。 */
  maxSize?: number
  /** 最低级别；缺省取 `DSH_FINANCE_LOG_LEVEL` → `info`。 */
  level?: LogLevel | string
  /**
   * 接受落盘的 logger name 白名单（本插件命名空间）；缺省 {@link DEFAULT_EXPORT_NAMES}。
   * 匹配规则：`name === p` 或 `name` 以 `p + ':'` 为前缀。显式传入空 / 全空白数组时回落默认。
   */
  names?: string[]
  /**
   * 字段级去敏（M5）选项；缺省按 {@link ./redact.js} 默认口径。
   * 写盘前经 {@link redactRecord} 对 `msg`（文本级）与 `args`（深遍历）统一去敏。
   */
  redact?: RedactOptions
}

/** 解析 name 白名单：显式非空数组 > 默认；剔除空 / 全空白项（防误配导致全丢弃）。 */
function resolveExportNames(explicit?: readonly string[]): readonly string[] {
  if (Array.isArray(explicit)) {
    const cleaned = explicit.filter((n) => typeof n === 'string' && n.trim() !== '')
    if (cleaned.length > 0) return cleaned
  }
  return DEFAULT_EXPORT_NAMES
}

/** 解析后的 printf 展开结果。 */
interface FormatResult {
  /** 展开后的消息文本。 */
  text: string
  /** 被占位符消费的参数个数。 */
  used: number
}

/** printf 占位符 → 字符串化（对齐 cordis `defaultFormatters` 的常用子集）。 */
const PLACEHOLDERS: Record<string, (value: unknown) => string> = {
  s: (value) => String(value),
  d: (value) => String(Math.trunc(Number(value))),
  i: (value) => String(Math.trunc(Number(value))),
  f: (value) => String(Number(value)),
  o: (value) => stringify(value),
  O: (value) => stringify(value),
  j: (value) => stringify(value),
}

/** 安全字符串化：字符串原样；其余尝试 `JSON.stringify`，失败（如循环引用）回退 `String`。 */
function stringify(value: unknown): string {
  if (typeof value === 'string') return value
  try {
    const json = JSON.stringify(value)
    return json === undefined ? String(value) : json
  } catch {
    return String(value)
  }
}

/** 判据：非 null 且非数组的对象（可作结构化 `args`）。 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * printf 风格展开：把 `format` 中的 `%s/%d/%i/%f/%o/%O/%j` 占位符按顺序消费 `params`。
 * `%%` → 字面 `%`；未知占位符保持原样且不消费参数（对齐 cordis `Logger.format`）。
 */
function expandFormat(format: string, params: readonly unknown[]): FormatResult {
  let used = 0
  const text = format.replace(/%([a-zA-Z%])/g, (match, char: string) => {
    if (match === '%%') return '%'
    const formatter = PLACEHOLDERS[char]
    if (typeof formatter !== 'function') return match
    const value = used < params.length ? params[used] : undefined
    used += 1
    return formatter(value)
  })
  return { text, used }
}

/** 合并若干结构化对象为一个 `args`（按键顺序后者覆盖前者）；全空则返回 `undefined`。 */
function mergeObjects(
  items: readonly Record<string, unknown>[],
): Record<string, unknown> | undefined {
  if (items.length === 0) return undefined
  if (items.length === 1) {
    return Object.keys(items[0]).length > 0 ? { ...items[0] } : undefined
  }
  const merged: Record<string, unknown> = {}
  for (const item of items) Object.assign(merged, item)
  return Object.keys(merged).length > 0 ? merged : undefined
}

/**
 * 把 cordis `Message.args` 展开为 `{ msg, args? }`。
 *
 * - 首参为 `Error`：`msg = stack || message`，其余对象并入 `args`；
 * - 首参为字符串：作 printf format 展开，未消费的对象参数并入 `args`，未消费的原始值
 *   追加到 `msg`（保持轻量、与 cordis 追加语义一致）；
 * - 其余（数字 / 布尔 / 对象等）：`msg = stringify(首参)`，其余对象并入 `args`。
 */
function formatMessage(args: readonly unknown[]): { msg: string; args?: Record<string, unknown> } {
  if (args.length === 0) return { msg: '' }
  const [first, ...rest] = args

  if (first instanceof Error) {
    const meta = mergeObjects(rest.filter(isPlainObject))
    const msg = first.stack || first.message
    return meta ? { msg, args: meta } : { msg }
  }

  if (typeof first === 'string') {
    const { text, used } = expandFormat(first, rest)
    const leftovers = rest.slice(used)
    const metaList = leftovers.filter(isPlainObject)
    let msg = text
    for (const leftover of leftovers) {
      if (!isPlainObject(leftover)) msg += ` ${stringify(leftover)}`
    }
    const meta = mergeObjects(metaList)
    return meta ? { msg, args: meta } : { msg }
  }

  const meta = mergeObjects(rest.filter(isPlainObject))
  const msg = stringify(first)
  return meta ? { msg, args: meta } : { msg }
}

/** 解析单文件大小阈值（字节）：显式 > 环境变量 {@link LOG_MAX_SIZE_ENV} > {@link DEFAULT_LOG_MAX_SIZE}。 */
export function resolveLogMaxSize(explicit?: number | string): number {
  const fromExplicit = toPositiveInt(explicit)
  if (fromExplicit !== undefined) return fromExplicit
  const env = typeof process !== 'undefined' ? process.env?.[LOG_MAX_SIZE_ENV] : undefined
  const fromEnv = toPositiveInt(env)
  if (fromEnv !== undefined) return fromEnv
  return DEFAULT_LOG_MAX_SIZE
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

/** `message.ts`（epoch ms）→ ISO 8601 字符串（UTC）。 */
function tsToIso(ts: number): string {
  return new Date(ts).toISOString()
}

/** `message.ts`（epoch ms）→ `YYYY-MM-DD`（UTC，用于文件名按天分组）。 */
function tsToDate(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10)
}

/** 文件落地 exporter 实现（符合 cordis {@link Exporter} 契约）。 */
class FileExporter implements Exporter {
  /** 关闭颜色：落盘为纯文本 JSON，不带 ANSI。 */
  colors: number | false = false
  /** 单行最大长度（与 cordis 默认一致；本实现自行格式化，预留契约字段）。 */
  maxLength = 10240
  /**
   * cordis 侧级别放行阈值：`default = 3`（即 DEBUG 的数值）→ 全量放行。
   * 真正的过滤在 {@link export} 内按 `message.type` 的方案严重度进行（见文件头注释「级别过滤」）。
   */
  levels: Record<string, number> = { default: 3 }

  /** 已解析的日志目录绝对路径。 */
  private readonly dir: string
  /** 单文件大小阈值（字节）。 */
  private readonly maxSize: number
  /** 方案严重度阈值（`error` 最严 / `debug` 最松）。 */
  private readonly threshold: LogLevel
  /** 接受落盘的 logger name 白名单（本插件命名空间）。 */
  private readonly names: readonly string[]
  /** 字段级去敏选项（M5）。 */
  private readonly redactOptions: RedactOptions | undefined
  /** 目录是否已确保存在（仅成功创建后置位，失败则下次重试）。 */
  private dirEnsured = false
  /** 已显式 chmod 为 `0o600` 的文件路径集合（避免逐行重复 chmod）。 */
  private readonly modeFixed = new Set<string>()

  constructor(options: FileExporterOptions) {
    this.dir = resolveFinanceLogDir(options.dir)
    this.maxSize = resolveLogMaxSize(options.maxSize)
    this.threshold = resolveLogLevel(options.level)
    this.names = resolveExportNames(options.names)
    this.redactOptions = options.redact
  }

  /** 单条结构化日志落地（cordis `Exporter` 契约入口）。任何异常吞掉降级。 */
  export(message: Message): void {
    try {
      if (!this.matchesName(message.name)) return
      if (!this.shouldEmit(message.type)) return
      const path = this.resolveTargetPath(tsToDate(message.ts))
      this.ensureDir()
      appendFileSync(path, `${JSON.stringify(this.buildRecord(message))}\n`, { mode: 0o600 })
      this.ensureFileMode(path)
    } catch {
      /* 日志设施自身绝不抛出：fs / 序列化异常一律降级吞掉。 */
    }
  }

  /** name 白名单过滤：`name === p` 或 `name` 以 `p + ':'` 为前缀（子 scope）才接受。 */
  private matchesName(name: string): boolean {
    return this.names.some((prefix) => name === prefix || name.startsWith(`${prefix}:`))
  }

  /** 方案严重度过滤：`rank(type) > rank(threshold)` 即丢弃。 */
  private shouldEmit(type: LogLevel): boolean {
    return LEVEL_RANK[type] <= LEVEL_RANK[this.threshold]
  }

  /**
   * 组装 JSONL 记录（§4.2 形状），并在返回前统一做**字段级去敏**（M5）。
   *
   * 去敏入口固定在此（写盘前）：`msg` 走文本级去敏、`args` 走深遍历去敏。
   * 若 `args` 含循环引用，{@link redactRecord} 会抛错（默认策略），由
   * {@link export} 的降级 `try/catch` 吞掉 → 该行静默丢弃（保持 M2 既有行为）。
   */
  private buildRecord(message: Message): Record<string, unknown> {
    const { msg, args } = formatMessage(message.args)
    const record: Record<string, unknown> = {
      ts: tsToIso(message.ts),
      level: message.type,
      name: message.name,
      msg,
      pid: process.pid,
      origin: 'host',
    }
    if (args !== undefined) record.args = args
    return redactRecord(record, this.redactOptions)
  }

  /** 幂等确保目录存在（`0o700`）；失败保持未置位以便下次重试。 */
  private ensureDir(): void {
    if (this.dirEnsured) return
    ensureFinanceLogDir(this.dir)
    this.dirEnsured = true
  }

  /**
   * 解析当日目标文件：`<date>.jsonl`；若已达阈值则递增后缀 `-1`、`-2`… 取首个未达
   * 阈值的文件（`maxSize <= 0` 视为不轮转，恒用基础文件名）。
   */
  private resolveTargetPath(date: string): string {
    const base = `${date}.jsonl`
    if (this.maxSize <= 0) return join(this.dir, base)
    for (let index = 0; index <= MAX_ROTATION_INDEX; index += 1) {
      const name = index === 0 ? base : `${date}-${index}.jsonl`
      const path = join(this.dir, name)
      if (this.fileSize(path) < this.maxSize) return path
    }
    return join(this.dir, `${date}-${MAX_ROTATION_INDEX}.jsonl`)
  }

  /** 当前文件大小（字节）；缺失 / 读失败返回 `0`。 */
  private fileSize(path: string): number {
    try {
      return statSync(path).size
    } catch {
      return 0
    }
  }

  /** 首次写入某文件后显式 chmod `0o600` 兜底（规避 umask）。 */
  private ensureFileMode(path: string): void {
    if (this.modeFixed.has(path)) return
    try {
      chmodSync(path, 0o600)
    } catch {
      /* 权限收紧失败不致命。 */
    }
    this.modeFixed.add(path)
  }
}

/**
 * 创建文件落地 exporter（符合 cordis `Exporter` 契约，可经 `ctx.logger.exporter(...)` 注册）。
 *
 * @param options 见 {@link FileExporterOptions}。
 * @returns 可注册的 {@link Exporter} 实例。
 *
 * @example
 * ```ts
 * const exporter = createFileExporter({ dir, maxSize: 50 * 1024 * 1024, level: 'info' })
 * ctx.logger.exporter(exporter) // 追加注册，注销随 ctx.effect
 * ```
 *
 * 注意：默认只接受 name 属于本插件命名空间（`dsh-finance[:scope]`）的消息；
 * 如需扩展可经 `options.names` 注入更多前缀。
 */
export function createFileExporter(options: FileExporterOptions = {}): Exporter {
  return new FileExporter(options)
}
