/**
 * domain/strategy.ts —— per-symbol 策略文档注册表（git 版本化）。
 *
 * 职责：维护 per-symbol 策略文档（Markdown 文本实体）。**版本交给 git**：
 *   策略正文是资产，落在资产层 `<assetsDir>/strategies/<symbol>.md`，每次写入
 *   由外层 assets git 仓库产生一次 commit；版本身份 = **git commit 短 SHA（12 位）**，
 *   历史回读走 `git log` / `git show`。
 *
 * 已删除的历史设计（不再使用）：
 *   `strategy_versions/<symbol>/vNNN.md`、`vNNN.meta.json`、`current` 指针，
 *   以及 `nextVersion` / `readPointer` / `writePointer` / `readMeta`。
 *
 * 接口（与旧版同名，下游工具无需改动）：
 * ```
 * class StrategyRegistry {
 *   set(symbol, { text, rationale, parentVersion?, by? }): string   // 返回短 SHA
 *   get(symbol, version?): { symbol, text, version, meta } | undefined
 *   list(symbol): StrategyVersionMeta[]
 *   current(symbol): string | undefined
 * }
 * ```
 *
 * 存储布局：
 * ```
 * <assetsDir>/
 *   .git/                              # 外层 git 仓库（ensureAssetsRepo 幂等初始化）
 *   strategies/<symbol>.md             # 当前版正文（纯正文，绝不写 front-matter）
 * ```
 *
 * 关键规则：
 * - `set` 的 `parentVersion` 语义为「期望的当前版本（短 SHA）」：提供且与 HEAD
 *   中该文件的短 SHA 不一致 → 抛错（乐观并发校验）；文件尚不存在时提供亦抛错。
 * - `set` 必须产生 commit（写策略是强语义操作），仅当正文与当前完全一致时允许
 *   no-op 返回当前短 SHA；git 不可用 / 提交失败 → 抛清晰中文错误（不降级）。
 * - 版本不可变由 git 保证：历史 commit 只读，`get(symbol, 旧SHA)` 回读原文。
 * - 策略文档保持纯正文，**不**写入 frontmatter / 元数据块。
 *
 * 纯 TS + node:fs / node:child_process，不接触 dsh/cordis API，亦不 import 任何
 * `@deepseek-ai/*`。
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import type {
  StrategyFull,
  StrategyVersionInput,
  StrategyVersionMeta,
} from './types.js'
import { assertSafeSegment } from './path-guard.js'
import { ensureAssetsRepo } from '../assets/repo.js'
import { defaultGitRunner, type GitRunner } from '../assets/git.js'

/** 策略文档子目录名（位于 assetsDir 下）。 */
export const STRATEGIES_DIRNAME = 'strategies'

/** 短 SHA 长度（版本身份展示口径）。 */
export const SHORT_SHA_LENGTH = 12

/** git 输出字段分隔符（commit 元数据解析用；正文中出现概率可忽略）。 */
const FIELD_SEP = '\x1f'

/** 把 git 异常归一为可读中文错误（不泄漏裸 stderr 全文）。 */
function describeGitError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err)
  const first = raw.split('\n').map((l) => l.trim()).find((l) => l !== '') ?? raw
  return first.length > 240 ? `${first.slice(0, 240)}…` : first
}

/**
 * per-symbol 策略文档注册表（git 版本化）。
 *
 * @param assetsDir 资产层根目录。正文落 `${assetsDir}/strategies/<symbol>.md`，
 *   git 命令的 cwd 为 `assetsDir`，仓库内路径为 `strategies/<symbol>.md`。
 */
export class StrategyRegistry {
  private readonly assetsDir: string
  private readonly git: GitRunner

  constructor(assetsDir: string, gitRunner: GitRunner = defaultGitRunner) {
    this.assetsDir = assetsDir
    this.git = gitRunner
    mkdirSync(this.assetsDir, { recursive: true })
  }

  /** 策略文档目录。 */
  private get docsDir(): string {
    return join(this.assetsDir, STRATEGIES_DIRNAME)
  }

  /** 仓库内相对路径（posix 分隔符；git 路径参数）。 */
  private relPath(symbol: string): string {
    return `${STRATEGIES_DIRNAME}/${assertSafeSegment(symbol, 'symbol')}.md`
  }

  /** 当前工作区正文文件绝对路径。 */
  private docPath(symbol: string): string {
    return join(this.assetsDir, this.relPath(symbol))
  }

  /** 仓库是否已初始化（只读判定，不触发 init）。 */
  private hasRepo(): boolean {
    return existsSync(join(this.assetsDir, '.git'))
  }

  /** 执行 git（写路径用；失败转换为清晰中文错误）。 */
  private runGit(args: string[], op: string): string {
    try {
      return this.git(args, this.assetsDir)
    } catch (err) {
      throw new Error(`[strategy-registry] git ${op} 失败：${describeGitError(err)}`)
    }
  }

  /** 确保外层 assets 仓库就绪；降级则抛错（写策略为强语义操作）。 */
  private ensureRepo(): void {
    const outcome = ensureAssetsRepo({ assetsDir: this.assetsDir, gitRunner: this.git })
    if (outcome.degraded) {
      throw new Error(
        `[strategy-registry] 资产层 git 仓库不可用，无法写入策略：${outcome.reason}`,
      )
    }
  }

  /**
   * 某文件在 HEAD 中的提交短 SHA；未跟踪 / 无提交 → undefined。
   * 历史提交已删除该文件时也视为「当前无版本」。
   */
  private headVersion(rel: string): string | undefined {
    if (!this.hasRepo()) return undefined
    try {
      const tracked = this.git(['ls-tree', '-r', '--name-only', 'HEAD', '--', rel], this.assetsDir).trim()
      if (!tracked) return undefined
      const sha = this.git(['log', '-1', '--format=%H', '--', rel], this.assetsDir).trim()
      return sha ? sha.slice(0, SHORT_SHA_LENGTH) : undefined
    } catch {
      return undefined
    }
  }

  /** 读取某 commit 中文件正文；不存在 / git 失败 → undefined。 */
  private textAt(rev: string, rel: string): string | undefined {
    try {
      // `rev:path` 的 rev 已经过调用方校验（短 SHA），path 已由 symbol 校验构造。
      return this.git(['show', `${rev}:${rel}`], this.assetsDir)
    } catch {
      return undefined
    }
  }

  /** 读取 worktree 正文；不存在 → undefined。 */
  private textInWorktree(symbol: string): string | undefined {
    try {
      return readFileSync(this.docPath(symbol), 'utf8')
    } catch {
      return undefined
    }
  }

  /** 写入前的文件快照（字节级；用于提交失败时回滚）。 */
  private snapshotDoc(docPath: string): { existed: boolean; content?: Buffer } {
    try {
      return { existed: true, content: readFileSync(docPath) }
    } catch {
      // 读取失败但文件存在时只记录存在，回滚时不做破坏性处理。
      return { existed: existsSync(docPath) }
    }
  }

  /**
   * 写入 / 提交失败时回滚，避免「工作区新正文 + HEAD 旧提交」的半写状态。
   *
   * - 文件原先存在 → 恢复原字节内容；
   * - 文件原先不存在 → 删除；
   * - 尽力清理 `git add` 留下的暂存状态（`git reset -- <path>`；无 HEAD 等情况失败忽略）。
   *
   * 恢复动作本身失败也不得掩盖原始错误：本方法**绝不抛出**，由调用方重新抛出原错误。
   */
  private rollbackDoc(
    docPath: string,
    rel: string,
    snapshot: { existed: boolean; content?: Buffer },
    stagedGitignore: boolean,
  ): void {
    try {
      if (snapshot.existed) {
        // 未能读到原内容（如权限异常）时不覆盖，避免二次破坏。
        if (snapshot.content !== undefined) writeFileSync(docPath, snapshot.content)
      } else {
        rmSync(docPath, { force: true })
      }
    } catch {
      // 忽略：原始错误优先。
    }

    try {
      this.git(['reset', '--', rel], this.assetsDir)
    } catch {
      // 首次提交前仓库无 HEAD 等场景，忽略。
    }

    if (stagedGitignore) {
      try {
        this.git(['reset', '--', '.gitignore'], this.assetsDir)
      } catch {
        // 同上：清理失败不掩盖原始错误。
      }
    }
  }

  /** 解析某 commit 的元数据（不含 parent）。 */
  private commitMeta(rev: string): StrategyVersionMeta | undefined {
    let out: string
    try {
      out = this.git(
        ['show', '-s', `--format=%H${FIELD_SEP}%B${FIELD_SEP}%aI${FIELD_SEP}%an`, rev],
        this.assetsDir,
      )
    } catch {
      return undefined
    }
    const [sha, body, ts, by] = out.split(FIELD_SEP)
    if (!sha) return undefined
    return {
      version: sha.trim().slice(0, SHORT_SHA_LENGTH),
      rationale: (body ?? '').trim(),
      ts: (ts ?? '').trim(),
      by: (by ?? '').trim() || undefined,
    }
  }

  /** 该文件在 `rev` 之前的上一次提交短 SHA（无则 undefined）。 */
  private parentOf(rev: string, rel: string): string | undefined {
    try {
      const sha = this.git(
        ['log', '-1', '--format=%H', `${rev}^`, '--', rel],
        this.assetsDir,
      ).trim()
      return sha ? sha.slice(0, SHORT_SHA_LENGTH) : undefined
    } catch {
      return undefined
    }
  }

  /** 组装完整 meta（补 parent）。 */
  private fullMeta(rev: string, rel: string): StrategyVersionMeta | undefined {
    const meta = this.commitMeta(rev)
    if (!meta) return undefined
    return { ...meta, parent: this.parentOf(rev, rel) }
  }

  /**
   * 写入策略文档的新版本，返回 **git 短 SHA（12 位）**。
   *
   * - `parentVersion`（可选）为期望的当前版本：与 HEAD 中该文件短 SHA 不一致 →
   *   抛冲突错误；文件尚不存在时提供亦抛错；
   * - 正文原样写入，不追加任何 frontmatter / 元数据；
   * - 产生一次 commit（message = rationale 原文）；正文与当前完全一致时 no-op；
   * - 提交失败（git 不可用 / hook 失败 / 锁冲突 / 无权限）→ 抛错（不静默成功），
   *   且**不留下半写状态**：工作区恢复写入前内容（原先不存在则删除），暂存状态尽力清理。
   */
  set(symbol: string, input: StrategyVersionInput): string {
    const rel = this.relPath(symbol)
    this.ensureRepo()

    const current = this.headVersion(rel)

    if (input.parentVersion !== undefined) {
      if (!current) {
        throw new Error(
          `[strategy-registry] ${symbol} 尚无当前版本，不能声明 parentVersion`,
        )
      }
      if (current !== input.parentVersion) {
        throw new Error(
          `[strategy-registry] ${symbol} parentVersion ${input.parentVersion} 与当前版 ${current} 不一致`,
        )
      }
    }

    // 内容与 HEAD 完全一致 → no-op（避免空提交报错），但仍确保工作区与提交一致。
    if (current && this.textAt('HEAD', rel) === input.text) {
      const docPath = this.docPath(symbol)
      const snapshot = this.snapshotDoc(docPath)
      try {
        mkdirSync(this.docsDir, { recursive: true })
        writeFileSync(docPath, input.text, 'utf8')
      } catch (err) {
        this.rollbackDoc(docPath, rel, snapshot, false)
        throw err
      }
      return current
    }

    const docPath = this.docPath(symbol)
    const snapshot = this.snapshotDoc(docPath)
    let stagedGitignore = false
    let committed = false

    try {
      mkdirSync(this.docsDir, { recursive: true })
      writeFileSync(docPath, input.text, 'utf8')

      this.runGit(['add', '--', rel], 'add')
      // 首次提交顺带把资产仓库 .gitignore 纳入版本管理（避免永久 untracked）；
      // 它只排除系统/临时文件，skills / strategies / programs / tasks 均入库，
      // 见 src/assets/repo.ts。
      const hasGitignore = existsSync(join(this.assetsDir, '.gitignore'))
      if (hasGitignore) {
        this.runGit(['add', '--', '.gitignore'], 'add')
        stagedGitignore = true
      }
      const staged = this.runGit(
        ['diff', '--cached', '--name-only', '--', rel],
        'diff',
      ).trim()
      if (staged === '') {
        if (current) return current
        throw new Error(
          `[strategy-registry] ${symbol} 策略正文无变更，无法生成 git 版本`,
        )
      }

      this.runGit(
        ['commit', '-m', input.rationale, '--', rel, ...(hasGitignore ? ['.gitignore'] : [])],
        'commit',
      )
      committed = true
      const sha = this.runGit(['rev-parse', 'HEAD'], 'rev-parse').trim()
      if (!sha) {
        throw new Error(`[strategy-registry] ${symbol} 提交后无法解析 HEAD`)
      }
      return sha.slice(0, SHORT_SHA_LENGTH)
    } catch (err) {
      // commit 已成功（如后续 rev-parse 异常）时不得回滚，否则工作区会落后于 HEAD。
      if (!committed) {
        this.rollbackDoc(docPath, rel, snapshot, stagedGitignore)
      }
      throw err
    }
  }

  /**
   * 读取某标的策略：默认读工作区当前版，可指定历史 git 短 SHA。
   * 未设定 / 版本不存在 → undefined。
   */
  get(symbol: string, version?: string): StrategyFull | undefined {
    // symbol 非法时读路径安全返回 undefined（写路径 set 仍抛 [path-guard]）。
    let rel: string
    try {
      rel = this.relPath(symbol)
    } catch {
      return undefined
    }

    if (version !== undefined) {
      // version 来自工具输入：非法路径段视为「不存在」，不抛错、不越界。
      let rev: string
      try {
        rev = assertSafeSegment(version, 'version')
      } catch {
        return undefined
      }
      const text = this.textAt(rev, rel)
      if (text === undefined) return undefined
      const meta = this.fullMeta(rev, rel)
      if (!meta) return undefined
      return { symbol, text, version: meta.version, meta }
    }

    const text = this.textInWorktree(symbol)
    if (text === undefined) return undefined
    const current = this.headVersion(rel)
    if (!current) return undefined
    const meta = this.fullMeta(current, rel)
    if (!meta) return undefined
    return { symbol, text, version: current, meta }
  }

  /** 某标的的版本链（按 commit 时间正序返回）。 */
  list(symbol: string): StrategyVersionMeta[] {
    let rel: string
    try {
      rel = this.relPath(symbol)
    } catch {
      return []
    }
    if (!this.hasRepo()) return []

    let shas: string[]
    try {
      shas = this.git(
        ['log', '--format=%H', '--', rel],
        this.assetsDir,
      )
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l !== '')
    } catch {
      return []
    }
    shas.reverse() // git log 新→旧；接口要求正序。

    const metas: StrategyVersionMeta[] = []
    for (const sha of shas) {
      const meta = this.commitMeta(sha)
      if (!meta) continue
      metas.push({
        ...meta,
        parent: metas.length > 0 ? metas[metas.length - 1].version : undefined,
      })
    }
    return metas
  }

  /** 某标的的当前版本短 SHA（文件未跟踪 / 无提交 → undefined）。 */
  current(symbol: string): string | undefined {
    try {
      return this.headVersion(this.relPath(symbol))
    } catch {
      return undefined
    }
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
