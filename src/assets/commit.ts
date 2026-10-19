/**
 * assets/commit.ts —— 资产「写入即 commit」的统一入口。
 *
 * 语义（资产单仓）：
 *   `<assetsDir>/.git` 是 skills / tasks / programs / strategies 的唯一仓库。
 *   资产改动若没有进入 git，就等于没有发生：任何写资产的模块（任务定义落盘、
 *   agent 直接写 SKILL / 任务程序）都必须经过本模块提交一次。
 *
 * 设计约束：
 *   - **只接收相对 assets 根的路径**，且限定四个资产前缀：
 *     `skills/`、`tasks/`、`programs/`、`strategies/`；拒绝绝对路径 / `..` /
 *     `.git` / 反斜杠，避免把仓库外文件或陈旧路径带进提交；
 *   - 先 `git add -- <paths>`，再以 `git status --porcelain -- <paths>` 判断
 *     **这些路径**是否真的产生 staged 变更；无变更 → no-op，**不产生空 commit**
 *     （因此连续两次写入相同内容不会新增历史）；
 *   - commit message 必须包含**每个变更资产的相对路径 + 动作**
 *     （`create` / `update` / `delete`），例如
 *     `assets: create skills/foo/SKILL.md`；
 *   - 提交只包含本次 paths（`git commit -- <paths>`），不顺手带走仓库里其它
 *     暂存内容；
 *   - **git 失败一律降级**：git 不可用 / 非零退出 / 无写权限等 → 捕获、
 *     `logger.warn`、返回 `degraded: true`，绝不抛错、不中断业务写入；
 *     唯一会抛错的是**路径非法**（调用方编程错误，应在写文件前修正）。
 *   - 作者身份复用 {@link defaultGitRunner}（固定 `dsh-ia` + `core.autocrlf=false`）。
 */
import { existsSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { resolveAssetsDir } from '../paths.js'
import { createLogger, type FinanceLogger } from '../log/logger.js'
import { defaultGitRunner, type GitRunner } from './git.js'

/** 允许提交的资产前缀（相对 `<assetsDir>`，含结尾斜杠）。 */
export const ASSET_PATH_PREFIXES = [
  'skills/',
  'tasks/',
  'programs/',
  'strategies/',
] as const

/** 单个资产文件的变更动作。 */
export type AssetAction = 'create' | 'update' | 'delete'

/** 单个资产的相对路径 + 动作。 */
export interface AssetFileChange {
  /** 相对 `<assetsDir>` 的 posix 路径（如 `skills/foo/SKILL.md`）。 */
  path: string
  /** 本次变更动作。 */
  action: AssetAction
}

/** 日志出口：只要求 warn（兼容统一门面 {@link FinanceLogger} 与简单回调）。 */
export type AssetsCommitLogger =
  | Pick<FinanceLogger, 'warn'>
  | ((message: string) => void)

/** {@link commitAssets} 配置。 */
export interface CommitAssetsOptions {
  /** 资产根目录（`<assetsDir>`）；省略时取 `resolveAssetsDir()`。 */
  assetsDir?: string
  /** 相对 assets 根的资产路径（必须命中四个资产前缀）。 */
  paths: readonly string[]
  /** 自定义提交前缀；实际 message 仍会追加每个资产的动作与路径。 */
  message?: string
  /** 自定义 git 执行器（仅测试注入；默认走系统 git + 固定身份）。 */
  gitRunner?: GitRunner
  /** 日志出口（默认统一日志门面 `dsh-ia:assets`，warn 级）。 */
  logger?: AssetsCommitLogger
}

/** {@link commitAssets} 结果。 */
export interface CommitAssetsOutcome {
  /** 仓库绝对路径（`<assetsDir>`）。 */
  dir: string
  /** 本次是否产生了新提交。 */
  committed: boolean
  /** 是否因 git 失败而降级（不中断业务）。 */
  degraded: boolean
  /** 本次提交的 git 短 SHA（12 位）；仅成功提交时存在。 */
  commit?: string
  /** 判据 / 降级原因。 */
  reason: string
  /** 本次实际变更的文件（相对路径 + 动作）。no-op 时为空数组。 */
  files: AssetFileChange[]
}

/** 路径非法错误（调用方编程错误，非 git 故障）。 */
export class AssetPathError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AssetPathError'
  }
}

/** 归一化日志出口为 warn 函数。 */
function warnOf(logger: AssetsCommitLogger): (message: string) => void {
  if (typeof logger === 'function') return logger
  return (message: string) => logger.warn(message)
}

/**
 * 校验并归一化单个资产相对路径。
 *
 * 规则：
 *   - 非空字符串、禁止反斜杠、禁止绝对路径（`/...` 或 `C:...`）；
 *   - 按 `/` 切分后不得出现空段、`.`、`..`，任一段不得为 `.git`（大小写不敏感）；
 *   - 首段必须是四个资产目录之一（`skills` / `tasks` / `programs` / `strategies`）。
 *
 * @throws {AssetPathError} 路径非法。
 */
export function normalizeAssetPath(raw: unknown): string {
  const hint = '仅允许 skills/、tasks/、programs/、strategies/ 下的相对路径'
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new AssetPathError(`[assets] 非法资产路径：${JSON.stringify(raw)}（${hint}）`)
  }
  if (raw.includes('\\')) {
    throw new AssetPathError(`[assets] 非法资产路径：${raw}（不得使用反斜杠；${hint}）`)
  }
  if (raw.startsWith('/') || /^[A-Za-z]:/.test(raw) || isAbsolute(raw)) {
    throw new AssetPathError(`[assets] 非法资产路径：${raw}（不得为绝对路径；${hint}）`)
  }

  const segments = raw.split('/')
  for (const segment of segments) {
    if (segment === '' || segment === '.' || segment === '..') {
      throw new AssetPathError(
        `[assets] 非法资产路径：${raw}（不得包含空段 / . / ..；${hint}）`,
      )
    }
    if (segment.toLowerCase() === '.git') {
      throw new AssetPathError(`[assets] 非法资产路径：${raw}（不得指向 .git；${hint}）`)
    }
  }

  const normalized = segments.join('/')
  const allowed = ASSET_PATH_PREFIXES.some((prefix) => normalized.startsWith(prefix))
  if (!allowed) {
    throw new AssetPathError(`[assets] 非法资产路径：${raw}（${hint}）`)
  }
  return normalized
}

/** 批量校验并去重（保留首次出现顺序）。 */
export function normalizeAssetPaths(paths: readonly unknown[]): string[] {
  if (!Array.isArray(paths) || paths.length === 0) {
    throw new AssetPathError('[assets] paths 非法：必须为非空的资产路径数组')
  }
  const seen = new Set<string>()
  const result: string[] = []
  for (const path of paths) {
    const normalized = normalizeAssetPath(path)
    if (!seen.has(normalized)) {
      seen.add(normalized)
      result.push(normalized)
    }
  }
  return result
}

/** 去掉 git status 对特殊路径的包裹引号（资产路径字符集受限，通常不会触发）。 */
function unquotePath(path: string): string {
  if (path.startsWith('"') && path.endsWith('"')) {
    return path.slice(1, -1).replace(/\\(.)/g, '$1')
  }
  return path
}

/**
 * 解析 `git status --porcelain -- <paths>` 输出，映射为「路径 + 动作」。
 *
 * 动作映射：`??` / 含 `A` → create；含 `D` → delete；其余（`M` / `R` / `T` / `C`）→ update。
 * 重命名行形如 `R  old -> new`，取新路径。
 */
function parseStatus(stdout: string): AssetFileChange[] {
  const files: AssetFileChange[] = []
  for (const line of stdout.split('\n')) {
    if (line.trim() === '') continue
    const code = line.slice(0, 2)
    let path = line.slice(3)
    const arrow = path.lastIndexOf(' -> ')
    if (arrow >= 0) path = path.slice(arrow + 4)
    path = unquotePath(path)

    const action: AssetAction =
      code === '??' || code.includes('A')
        ? 'create'
        : code.includes('D')
          ? 'delete'
          : 'update'
    files.push({ path, action })
  }
  return files
}

/** 组装 commit message：自定义前缀 + 每个资产的动作与相对路径。 */
function buildMessage(files: AssetFileChange[], message?: string): string {
  const details = files.map((file) => `${file.action} ${file.path}`).join(', ')
  const prefix = message?.trim() ? message.trim() : 'assets'
  return `${prefix}: ${details}`
}

/**
 * 提交一批资产变更（写入即 commit 的统一入口）。
 *
 * 行为：
 *   1. 校验 paths（非法 → 抛 {@link AssetPathError}，发生在 git 操作之前）；
 *   2. 仓库 / `.git` 缺失 → 降级返回，不尝试向父仓库提交；
 *   3. `git add -- <paths>` → `git status --porcelain -- <paths>`；
 *   4. 无 staged 变更 → no-op（`committed: false`，不产生空 commit）；
 *   5. 有变更 → 以「动作 + 相对路径」message 提交，只提交这些 paths；
 *   6. git 任一步失败 → `logger.warn` + `degraded: true`，不抛错。
 *
 * @param options 资产根目录 / 相对路径 / 自定义 message / 可注入 git 与 logger。
 * @returns 提交结果（调用方可用 `files` 判断本次实际变更）。
 */
export function commitAssets(options: CommitAssetsOptions): CommitAssetsOutcome {
  const paths = normalizeAssetPaths(options.paths)
  const dir = options.assetsDir ?? resolveAssetsDir()
  const run = options.gitRunner ?? defaultGitRunner
  const warn = warnOf(options.logger ?? createLogger('dsh-ia:assets'))

  try {
    if (!existsSync(dir) || !existsSync(join(dir, '.git'))) {
      const reason = '资产仓库未初始化（缺少 .git），跳过提交'
      warn(`[dsh-ia/assets] ${reason}：${dir}`)
      return { dir, committed: false, degraded: true, reason, files: [] }
    }

    // 先 add：把本次写入（含删除）纳入暂存区。
    run(['add', '--', ...paths], dir)

    // 只关心本次 paths 的 staged 变更；空输出 = 内容与 HEAD 一致 → no-op。
    const status = run(['status', '--porcelain', '--', ...paths], dir)
    const files = parseStatus(status)
    if (files.length === 0) {
      return {
        dir,
        committed: false,
        degraded: false,
        reason: '资产无变更（no-op）',
        files: [],
      }
    }

    const message = buildMessage(files, options.message)
    // `-- <paths>`：只提交本次资产，不带走仓库里其它暂存内容。
    run(['commit', '-m', message, '--', ...paths], dir)
    const commit = run(['rev-parse', '--short=12', 'HEAD'], dir).trim()

    return {
      dir,
      committed: true,
      degraded: false,
      commit,
      reason: message,
      files,
    }
  } catch (err: unknown) {
    const reason = err instanceof Error ? err.message : String(err)
    warn(`[dsh-ia/assets] 警告资产提交失败（降级，不中断业务）：${reason}`)
    return { dir, committed: false, degraded: true, reason, files: [] }
  }
}
