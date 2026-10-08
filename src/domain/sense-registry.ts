/**
 * domain/sense-registry.ts —— 感知版本注册表。
 *
 * 职责：维护 `sense_versions/` 目录 + `current` 指针，保证版本不可变、演化链可追溯。
 * 被 `tools/sense_archive` 复用。脚本标的无关，registry 不区分标的。
 *
 * 接口签名对齐详细设计 §5.3：
 * ```
 * interface SenseRegistry {
 *   commit(v: SenseVersionInput): string   // 返回 version
 *   list(): SenseVersionMeta[]
 *   current(): SenseVersionMeta | null
 *   rollback(version: string): void
 *   read(version: string): SenseVersionFull
 * }
 * ```
 *
 * 归档结构（§7.2）：
 * ```
 * sense_versions/
 *   v001/{rationale.md, sensor.ts, meta.json}
 *   v002/{...}
 *   current → v002        # 指针文件，内容为当前版本号
 * ```
 *
 * 关键规则（验收点 6）：
 * - 版本不可变：patch/replace 必须带 parent（patch 强制带 parent；replace 建议带）。
 * - current 指针可 rollback（回指历史版本）。
 * - 每个版本一经 commit 不可修改（目录/文件只写一次）。
 *
 * 纯 TS + node:fs 实现，不接触 dsh/cordis API。
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
  ChangeType,
  SenseVersionFull,
  SenseVersionInput,
  SenseVersionMeta,
} from './types.js'
import { assertSafeSegment } from './path-guard.js'

/** current 指针文件名。 */
const CURRENT_POINTER = 'current'

/**
 * 感知版本注册表。
 *
 * @param baseDir 归档根目录（`sense_versions/` 的父级或直接为其所在目录）。
 *  版本目录落 `${baseDir}/sense_versions/<version>/`，指针文件在
 *  `${baseDir}/sense_versions/current`。
 */
export class SenseRegistry {
  private readonly root: string

  constructor(baseDir: string) {
    // 允许传入的 baseDir 即为 sense_versions 根，或为其父目录。
    this.root = baseDir.endsWith('sense_versions')
      ? baseDir
      : join(baseDir, 'sense_versions')
    mkdirSync(this.root, { recursive: true })
  }

  /** 版本目录路径。version 为外部输入，先做路径段安全校验。 */
  private versionDir(version: string): string {
    return join(this.root, assertSafeSegment(version, 'version'))
  }

  /** current 指针文件路径。 */
  private get pointerPath(): string {
    return join(this.root, CURRENT_POINTER)
  }

  /** 读取 current 指针（无则返回 null）。 */
  private readPointer(): string | null {
    try {
      const v = readFileSync(this.pointerPath, 'utf8').trim()
      return v || null
    } catch {
      return null
    }
  }

  /** 写入 current 指针。 */
  private writePointer(version: string): void {
    mkdirSync(dirname(this.pointerPath), { recursive: true })
    writeFileSync(this.pointerPath, version, 'utf8')
  }

  /** 读取某版本 meta.json。 */
  private readMeta(version: string): SenseVersionMeta | null {
    const path = join(this.versionDir(version), 'meta.json')
    try {
      return JSON.parse(readFileSync(path, 'utf8')) as SenseVersionMeta
    } catch {
      return null
    }
  }

  /** 下一个版本号（vNNN，按现有最大序号 +1）。 */
  private nextVersion(): string {
    let max = 0
    try {
      for (const entry of readdirSync(this.root)) {
        const m = /^v(\d{3,})$/.exec(entry)
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
   * 归档新版本，返回版本号。
   * - `keep`：不产生新版本（沿用），返回 current 版本号（无则抛错）。
   * - `patch`：必须带 parent，否则报错；生成新版本，current 指向新版本。
   * - `replace`：整体替换；parent 可选（建议带），current 指向新版本。
   */
  commit(v: SenseVersionInput): string {
    if (v.changeType === 'keep') {
      const cur = this.readPointer()
      if (!cur) {
        throw new Error('[sense-registry] keep 但尚无 current 版本')
      }
      return cur
    }

    if (v.changeType === 'patch' && !v.parent) {
      throw new Error('[sense-registry] patch 必须带 parent')
    }

    // patch/replace：父版本若给出则必须已存在。
    if (v.parent && !this.readMeta(v.parent)) {
      throw new Error(`[sense-registry] parent 版本 ${v.parent} 不存在`)
    }

    const version = this.nextVersion()
    const dir = this.versionDir(version)

    // 版本不可变：目录若已存在则报错（正常情况下 nextVersion 保证不冲突）。
    if (existsSync(dir)) {
      throw new Error(`[sense-registry] 版本 ${version} 已存在，不可覆盖`)
    }
    mkdirSync(dir, { recursive: true })

    const meta: SenseVersionMeta = {
      version,
      changeType: v.changeType,
      parent: v.parent,
      trigger: v.trigger,
      rationale: v.rationale,
      ts: new Date().toISOString(),
      by: v.by,
    }

    writeFileSync(join(dir, 'rationale.md'), v.rationale, 'utf8')
    writeFileSync(join(dir, 'sensor.ts'), v.code, 'utf8')
    writeFileSync(join(dir, 'meta.json'), JSON.stringify(meta, null, 2), 'utf8')

    this.writePointer(version)
    return version
  }

  /** 版本演化链（按版本号排序）。 */
  list(): SenseVersionMeta[] {
    const metas: SenseVersionMeta[] = []
    try {
      for (const entry of readdirSync(this.root)) {
        const m = /^(v\d{3,})$/.exec(entry)
        if (m) {
          const meta = this.readMeta(m[1])
          if (meta) metas.push(meta)
        }
      }
    } catch {
      // 目录不存在/不可读，返回空。
    }
    return metas.sort((a, b) => a.version.localeCompare(b.version))
  }

  /** 当前生效版本元数据。 */
  current(): SenseVersionMeta | null {
    const cur = this.readPointer()
    if (!cur) return null
    return this.readMeta(cur)
  }

  /** 将 current 指针回指历史版本。 */
  rollback(version: string): void {
    if (!this.readMeta(version)) {
      throw new Error(`[sense-registry] 回滚目标版本 ${version} 不存在`)
    }
    this.writePointer(version)
  }

  /** 读某一版全文（含 rationale + code + meta）。 */
  read(version: string): SenseVersionFull {
    const meta = this.readMeta(version)
    if (!meta) {
      throw new Error(`[sense-registry] 版本 ${version} 不存在`)
    }
    const dir = this.versionDir(version)
    const rationale = readFileSync(join(dir, 'rationale.md'), 'utf8')
    const code = readFileSync(join(dir, 'sensor.ts'), 'utf8')
    return { meta, rationale, code }
  }
}

export type {
  ChangeType,
  SenseVersionFull,
  SenseVersionInput,
  SenseVersionMeta,
}