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

export type { StrategyFull, StrategyVersionInput, StrategyVersionMeta }
