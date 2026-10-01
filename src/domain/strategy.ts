/**
 * domain/strategy.ts —— per-symbol 策略文档注册表。
 *
 * 职责：维护 per-symbol 策略文档（Markdown 文本实体）的版本链，保证
 * 「版本不可变 + rationale 追溯 + current 指针」可回滚，与 sense-registry 对称。
 * 详细设计 §10.4 / §10.6：策略是 per-symbol 的文本实体，首版即启用版本链；
 * §10.8 定义 strategy_get / strategy_set 的契约。
 *
 * 接口（对齐任务卡片）：
 * ```
 * class StrategyRegistry {
 *   set(symbol, { text, rationale, parentVersion?, by? }): string   // 返回新版本号
 *   get(symbol, version?): { symbol, text, version, meta } | undefined
 *   list(symbol): StrategyVersionMeta[]
 *   current(symbol): string | undefined
 * }
 * ```
 *
 * 存储布局（§10.6）：
 * ```
 * data/
 *   strategy/<symbol>.md                    # 当前版内容
 *   strategy_versions/<symbol>/vNNN.md      # 各版全文
 *   strategy_versions/<symbol>/vNNN.meta.json  # { version, rationale, ts, parent?, by? }
 *   strategy_versions/<symbol>/current      # 指针文件（内容为版本号）
 * ```
 *
 * 关键规则（验收点）：
 * - 版本号 v001 起，按现有最大版本 +1（三位零填充）。
 * - 版本不可变：目标版本目录若已存在 → 报错（不得覆盖）。
 * - 非首版必须带 parentVersion，且必须等于当前版；首版不带 parent。
 *
 * 纯 TS + node:fs 实现，不接触 dsh/cordis API，亦不 import 任何
 * `@deepseek-ai/*`。
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import type {
  StrategyFull,
  StrategyVersionInput,
  StrategyVersionMeta,
} from './types.js'

/** current 指针文件名。 */
const CURRENT_POINTER = 'current'

/**
 * per-symbol 策略文档版本注册表。
 *
 * @param baseDir 数据根目录。当前版文档落 `${baseDir}/strategy/<symbol>.md`，
 *  版本链落 `${baseDir}/strategy_versions/<symbol>/…`。
 */
export class StrategyRegistry {
  private readonly baseDir: string

  constructor(baseDir: string) {
    this.baseDir = baseDir
    mkdirSync(this.baseDir, { recursive: true })
  }

  /** 当前版文档目录。 */
  private get currentRoot(): string {
    return join(this.baseDir, 'strategy')
  }

  /** 版本链目录（按 symbol 隔离）。 */
  private get versionsRoot(): string {
    return join(this.baseDir, 'strategy_versions')
  }

  /** 某标的的版本链目录。 */
  private symbolVersionsDir(symbol: string): string {
    return join(this.versionsRoot, symbol)
  }

  /** 某标的的当前版文档路径。 */
  private currentPath(symbol: string): string {
    return join(this.currentRoot, `${symbol}.md`)
  }

  /** 某标的某版本的正文文件路径。 */
  private versionFile(symbol: string, version: string): string {
    return join(this.symbolVersionsDir(symbol), `${version}.md`)
  }

  /** 某标的某版本的 meta.json 路径。 */
  private metaFile(symbol: string, version: string): string {
    return join(this.symbolVersionsDir(symbol), `${version}.meta.json`)
  }

  /** 某标的的 current 指针文件路径。 */
  private pointerPath(symbol: string): string {
    return join(this.symbolVersionsDir(symbol), CURRENT_POINTER)
  }

  /** 读取某标的的 current 指针（无则返回 undefined）。 */
  private readPointer(symbol: string): string | undefined {
    try {
      const v = readFileSync(this.pointerPath(symbol), 'utf8').trim()
      return v || undefined
    } catch {
      return undefined
    }
  }

  /** 写入某标的的 current 指针。 */
  private writePointer(symbol: string, version: string): void {
    const p = this.pointerPath(symbol)
    mkdirSync(dirname(p), { recursive: true })
    writeFileSync(p, version, 'utf8')
  }

  /** 读取某标的某版本 meta.json（不存在返回 undefined）。 */
  private readMeta(
    symbol: string,
    version: string,
  ): StrategyVersionMeta | undefined {
    try {
      return JSON.parse(
        readFileSync(this.metaFile(symbol, version), 'utf8'),
      ) as StrategyVersionMeta
    } catch {
      return undefined
    }
  }

  /** 下一个版本号（vNNN，按该标的下现有最大序号 +1）。 */
  private nextVersion(symbol: string): string {
    let max = 0
    try {
      for (const entry of readdirSync(this.symbolVersionsDir(symbol))) {
        const m = /^v(\d{3,})(?:\.md|\.meta\.json)$/.exec(entry)
        if (m) {
          const n = Number.parseInt(m[1], 10)
          if (n > max) max = n
        }
      }
    } catch {
      // 目录不存在或不可读，从 v001 开始。
    }
    return `v${String(max + 1).padStart(3, '0')}`
  }

  /**
   * 写入策略文档的新版本，返回版本号。
   * - 首版（无 parentVersion）：生成 v001，current 指向 v001。
   * - 非首版：必须带 parentVersion，且必须等于当前版，否则报错。
   * - 版本不可变：目标版本若已存在 → 报错。
   */
  set(symbol: string, input: StrategyVersionInput): string {
    const cur = this.readPointer(symbol)

    if (input.parentVersion === undefined) {
      // 首版：仅当尚无任何版本时允许不带 parent。
      if (cur) {
        throw new Error(
          `[strategy-registry] ${symbol} 已有当前版本 ${cur}，非首版必须带 parentVersion`,
        )
      }
    } else {
      // 非首版：parentVersion 必须等于当前版。
      if (input.parentVersion !== cur) {
        throw new Error(
          `[strategy-registry] ${symbol} parentVersion ${input.parentVersion} 与当前版 ${
            cur ?? '(无)'
          } 不一致`,
        )
      }
    }

    const version = this.nextVersion(symbol)

    // 版本不可变：目标版本已存在则报错（正常情况下 nextVersion 保证不冲突）。
    const vFile = this.versionFile(symbol, version)
    if (existsSync(vFile)) {
      throw new Error(
        `[strategy-registry] ${symbol} 版本 ${version} 已存在，不可覆盖`,
      )
    }

    const meta: StrategyVersionMeta = {
      version,
      rationale: input.rationale,
      ts: new Date().toISOString(),
      parent: input.parentVersion,
      by: input.by,
    }

    mkdirSync(dirname(vFile), { recursive: true })
    writeFileSync(vFile, input.text, 'utf8')
    writeFileSync(
      this.metaFile(symbol, version),
      JSON.stringify(meta, null, 2),
      'utf8',
    )

    // 同步当前版内容与指针。
    const curPath = this.currentPath(symbol)
    mkdirSync(dirname(curPath), { recursive: true })
    writeFileSync(curPath, input.text, 'utf8')
    this.writePointer(symbol, version)

    return version
  }

  /**
   * 读取某标的策略：默认当前版，可指定历史版本。
   * 未设定（无 current 或 version 不存在）返回 undefined。
   */
  get(symbol: string, version?: string): StrategyFull | undefined {
    const v = version ?? this.readPointer(symbol)
    if (!v) return undefined

    const meta = this.readMeta(symbol, v)
    if (!meta) return undefined

    let text: string
    try {
      text = readFileSync(this.versionFile(symbol, v), 'utf8')
    } catch {
      return undefined
    }

    return { symbol, text, version: v, meta }
  }

  /** 某标的的版本演化链（按版本号排序）。 */
  list(symbol: string): StrategyVersionMeta[] {
    const metas: StrategyVersionMeta[] = []
    try {
      for (const entry of readdirSync(this.symbolVersionsDir(symbol))) {
        const m = /^(v\d{3,})\.meta\.json$/.exec(entry)
        if (m) {
          const meta = this.readMeta(symbol, m[1])
          if (meta) metas.push(meta)
        }
      }
    } catch {
      // 目录不存在或不可读，返回空。
    }
    return metas.sort((a, b) => a.version.localeCompare(b.version))
  }

  /** 某标的的当前版本号（无则 undefined）。 */
  current(symbol: string): string | undefined {
    return this.readPointer(symbol)
  }
}

// ---------------------------------------------------------------------------
// 策略文档 front-matter 轻量解析（阈值来源迁移用，Task-19）。
//
// 策略文档 `strategy/<symbol>.md` 的顶部可带 YAML front-matter（`---` 包裹）：
// ```
// ---
// thresholds:
//   dir_hit_min: 0.6
//   cum_return_min: 0.02
//   miss_streak_max: 3
// ---
// （正文）
// ```
// 键名为**蛇形**，由 tools/context 映射到驼峰 `Thresholds`。
//
// 设计约束（沿用 skills/frontmatter.ts 的「无第三方 YAML 依赖」范式）：
//   - 仅支持「缩进层级 + `key: value`」的轻量语法子集（数字/布尔/null/引号或裸字符串标量）；
//   - 解析失败**绝不抛出**：返回 `structured = {}` + `parseError`；
//   - 无 front-matter：`structured = {}`、`body = text`。
// ---------------------------------------------------------------------------

/** 策略文档 front-matter 解析结果。 */
export interface ParsedStrategyDoc {
  /** front-matter 之后的 Markdown 正文（无 front-matter 时为原文）。 */
  body: string
  /** front-matter 解析出的结构化对象（顶层键 → 值）。解析失败/无 front-matter 为空对象。 */
  structured: Record<string, unknown>
  /** 解析失败原因（仅当存在 front-matter 且解析失败时设置）。 */
  parseError?: string
}

/** 统计行首空格数（YAML 缩进层级；仅计空格，制表符视为 0 级以避免误判）。 */
function indentOf(line: string): number {
  let n = 0
  while (n < line.length && line[n] === ' ') n += 1
  return n
}

/** 还原成对引号包裹的标量（单引号 `''`→`'`；双引号 `\n`/`\"`/`\\` 转义）。 */
function unquoteScalar(raw: string): string {
  const quote = raw[0]
  const inner = raw.slice(1, -1)
  if (quote === "'") return inner.replace(/''/g, "'")
  return inner.replace(/\\(["\\n])/g, (_m, ch: string) => (ch === 'n' ? '\n' : ch))
}

/** 解析单个标量值（轻量 YAML 子集）。失败返回 error。 */
function parseScalar(raw: string): { value?: unknown; error?: string } {
  let s = raw.trim()
  if (s === '') return { value: '' }

  // 引号字符串：须成对闭合。
  if (s.startsWith('"') || s.startsWith("'")) {
    const quote = s[0]
    if (s.length < 2 || !s.endsWith(quote)) {
      return { error: `引号未闭合：${raw}` }
    }
    return { value: unquoteScalar(s) }
  }

  // 流式集合（[...] / {...}）不在本轻量子集内 → 判为解析失败（如 `thresholds: [1,2`）。
  if (s.startsWith('[') || s.startsWith('{')) {
    return { error: `不支持流式集合：${raw}` }
  }

  // 去除行内注释（# 前需有空白）。
  const hashIdx = s.search(/\s#/)
  if (hashIdx >= 0) s = s.slice(0, hashIdx).trimEnd()
  if (s === '') return { value: '' }

  if (s === 'true' || s === 'True' || s === 'TRUE') return { value: true }
  if (s === 'false' || s === 'False' || s === 'FALSE') return { value: false }
  if (s === 'null' || s === 'Null' || s === 'NULL' || s === '~') return { value: null }

  if (/^[-+]?(\d+(\.\d*)?|\.\d+)([eE][-+]?\d+)?$/.test(s)) {
    const n = Number(s)
    if (Number.isFinite(n)) return { value: n }
    return { error: `数值非法：${raw}` }
  }

  return { value: s }
}

/**
 * 递归解析一段「同缩进层级」的 mapping（返回对象）。
 * 遇到缩进回退即交还父级；`pos.i` 推进到已消费位置；`endLine` 为 front-matter 块右边界。
 */
function parseMapping(
  lines: string[],
  pos: { i: number },
  indent: number,
  endLine: number,
): { value: Record<string, unknown>; error?: string } {
  const obj: Record<string, unknown> = {}

  while (pos.i < endLine) {
    const line = lines[pos.i]
    if (line.trim() === '' || line.trimStart().startsWith('#')) {
      pos.i += 1
      continue
    }
    const cur = indentOf(line)
    if (cur < indent) break // 缩进回退：交还父级
    if (cur > indent) {
      return { value: obj, error: `第 ${pos.i + 1} 行缩进异常` }
    }

    const content = line.trim()
    const sep = content.indexOf(':')
    if (sep === -1) return { value: obj, error: `无法解析的行：${content}` }
    const key = content.slice(0, sep).trim()
    if (key === '') return { value: obj, error: `键名为空：${content}` }
    const rest = content.slice(sep + 1).trim()
    pos.i += 1

    if (rest !== '') {
      const scalar = parseScalar(rest)
      if (scalar.error) return { value: obj, error: `${key}: ${scalar.error}` }
      obj[key] = scalar.value
    } else {
      // 嵌套 mapping：子行实际缩进为准。
      let j = pos.i
      while (
        j < endLine &&
        (lines[j].trim() === '' || lines[j].trimStart().startsWith('#'))
      ) j += 1
      const childIndent = j < endLine ? indentOf(lines[j]) : indent + 1
      if (childIndent <= indent) {
        obj[key] = {} // 空 mapping（key: 无子键）
        continue
      }
      const child = parseMapping(lines, pos, childIndent, endLine)
      if (child.error) return { value: obj, error: child.error }
      obj[key] = child.value
    }
  }

  return { value: obj }
}

/**
 * 解析策略文档文本，提取顶部 `---` YAML front-matter 与正文。
 *
 * @param raw 文档原文（可含 BOM、CRLF）。
 * @returns 结构化 front-matter + 正文。解析失败**绝不抛出**：
 *   返回 `structured = {}` + `parseError`；无 front-matter 时 `structured = {}`、
 *   `body = raw`。
 */
export function parseStrategyDoc(raw: string): ParsedStrategyDoc {
  const text = raw.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n')
  try {
    const lines = text.split('\n')

    let start = 0
    while (start < lines.length && lines[start].trim() === '') start += 1
    if (lines[start]?.trim() !== '---') {
      return { body: text, structured: {} }
    }

    let end = start + 1
    while (end < lines.length && lines[end].trim() !== '---') end += 1
    if (end >= lines.length) {
      return {
        body: text,
        structured: {},
        parseError: 'front-matter 未闭合（缺少结尾 "---"）',
      }
    }

    const pos = { i: start + 1 }
    const parsed = parseMapping(lines, pos, 0, end)
    if (parsed.error) {
      return { body: text, structured: {}, parseError: parsed.error }
    }

    const body = lines
      .slice(end + 1)
      .join('\n')
      .replace(/^\n+/, '')
      .replace(/\n+$/, '')

    return { body, structured: parsed.value }
  } catch (err) {
    return {
      body: text,
      structured: {},
      parseError: err instanceof Error ? err.message : String(err),
    }
  }
}

export type { StrategyFull, StrategyVersionInput, StrategyVersionMeta }
