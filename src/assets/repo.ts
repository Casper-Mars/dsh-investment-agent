/**
 * assets 资产仓库 —— `<assetsDir>` 是**唯一**的资产 git 仓库。
 *
 * 背景（assets 单仓接入任务）：
 *   历史上 `assets/skills` 曾是一个**嵌套的独立 git 仓库**（skill 自有历史），
 *   外层仓库因此在 `.gitignore` 中排除 `skills/`。嵌套仓库带来两个问题：
 *     1. `git add -A` 会把 `skills/` 记成 gitlink（嵌入式仓库语义），内容丢失；
 *     2. 资产被切成两套历史，`skills / strategies / programs / tasks` 无法在同一次
 *        提交里形成一致快照。
 *   现在统一为**单一仓库**：`<assetsDir>/.git` 是唯一仓库，`skills/` 只是普通目录。
 *
 * 仓库布局：
 * ```
 * <assetsDir>/                      # 唯一 git 仓库根（本模块负责初始化）
 *   .git/
 *   .gitignore                      # 仅排除系统/临时文件
 *   skills/<name>/SKILL.md          # 5 个可进化 SKILL（普通文件，纳入本仓库）
 *   strategies/<symbol>.md          # 策略正文
 *   programs/ · tasks/              # 程序与任务资产
 * ```
 *
 * 设计约束：
 *   - 幂等：已有 `.git` → no-op；`.gitignore` 缺失时写入，**若检测到历史遗留的
 *     `skills/` 排除规则则改写**（一次性就地升级，不写迁移脚本）；
 *   - 降级不抛：git 不可用 / 无写权限等失败 → 返回 `degraded`，由调用方决定
 *     （策略写入是强语义操作，调用方会据此抛错；本模块自身不中断插件装载）；
 *   - 作者身份经 `src/assets/git.ts` 显式注入，不依赖宿主机 git config。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { resolveAssetsDir } from '../paths.js'
import { defaultGitRunner, initGitRepo, type GitRunner } from './git.js'
import { createLogFunction } from '../log/logger.js'

/** 外层仓库 `.gitignore` 内容：只忽略系统/临时文件，资产内容一律入库。 */
export const ASSETS_GITIGNORE = [
  '# 仅忽略系统/临时文件；skills / strategies / programs / tasks 一律纳入版本管理。',
  '.DS_Store',
  '*.tmp',
  '',
].join('\n')

/** 首次提交的 message（首次提交必须包含 5 个 SKILL.md）。 */
export const INITIAL_COMMIT_MESSAGE = 'init: 资产仓库首版'

/** 历史遗留的 `skills/` 排除规则（用于就地升级 `.gitignore`）。 */
const LEGACY_SKILLS_IGNORE = /^\s*\/?skills\/?\s*$/m

/** 资产仓库确保选项。 */
export interface EnsureAssetsRepoOptions {
  /** 资产层根目录（可选）；省略时取 `resolveAssetsDir()`（`~/.dsh-ia/assets`）。 */
  assetsDir?: string
  /** 日志函数（默认走统一日志门面，info 级）。 */
  logger?: (message: string) => void
  /** 自定义 git 执行器（仅测试注入；默认走 `node:child_process` 调系统 git）。 */
  gitRunner?: GitRunner
}

/** 资产仓库确保结果。 */
export interface AssetsRepoOutcome {
  /** 仓库绝对路径（`<assetsDir>`）。 */
  dir: string
  /** 本次是否执行了 `git init`。false 表示已存在或降级。 */
  initialized: boolean
  /** 是否因失败而降级（git 不可用 / 命令失败 / 无写权限等）。 */
  degraded: boolean
  /** 判据 / 降级原因说明。 */
  reason: string
}

/** 提交结果。 */
export interface AssetsCommitOutcome {
  /** 仓库绝对路径（`<assetsDir>`）。 */
  dir: string
  /** 本次是否产生了新提交。false 表示无变更（no-op）或降级。 */
  committed: boolean
  /** 是否因失败而降级（git 不可用 / 命令失败 / 无写权限等）。 */
  degraded: boolean
  /** 判据 / 降级原因说明。 */
  reason: string
}

/** 解析资产仓库根目录（纯计算，无副作用）。 */
export function resolveAssetsGitRoot(assetsDir?: string): string {
  return assetsDir ?? resolveAssetsDir()
}

/** 幂等写 `.gitignore`：缺失即写；含历史 `skills/` 排除规则则就地升级。 */
function ensureGitignore(dir: string): void {
  const path = join(dir, '.gitignore')
  if (!existsSync(path)) {
    writeFileSync(path, ASSETS_GITIGNORE, 'utf8')
    return
  }
  try {
    const current = readFileSync(path, 'utf8')
    if (LEGACY_SKILLS_IGNORE.test(current)) {
      // 单仓升级：移除 `skills/` 排除，避免 skill 内容继续被忽略。
      writeFileSync(path, ASSETS_GITIGNORE, 'utf8')
    }
  } catch {
    // 读取失败不阻断就绪流程（后续 git 操作会给出更准确的失败原因）。
  }
}

/**
 * 确保资产仓库就绪（幂等，**不产生提交**）。
 *
 * - 目录缺失 → `mkdir -p`；
 * - 缺 `.git` → `git init -b main`（失败回落 `git init`）；
 * - `.gitignore` 缺失 → 写入；含历史 `skills/` 排除规则 → 就地升级；
 * - 已存在 → no-op。
 *
 * 提交由 {@link commitAssetsChanges} 单独负责（首次提交需包含已落盘的 SKILL 种子，
 * 故调用方须在种子落盘后再提交）。
 *
 * 任何失败（git 不可用 / 非零退出 / 无写权限）都**捕获并降级**，返回
 * `degraded: true` + `reason`，不抛出。
 */
export function ensureAssetsRepo(
  options: EnsureAssetsRepoOptions = {},
): AssetsRepoOutcome {
  const logger = options.logger ?? createLogFunction('dsh-ia:assets')
  const run = options.gitRunner ?? defaultGitRunner

  let dir = ''
  try {
    dir = resolveAssetsGitRoot(options.assetsDir)
    mkdirSync(dir, { recursive: true })

    let initialized = false
    if (!existsSync(join(dir, '.git'))) {
      initGitRepo(dir, run)
      initialized = true
    }

    ensureGitignore(dir)

    const reason = initialized ? 'assets 仓库缺失，已初始化' : 'assets 仓库已就绪'
    if (initialized) logger(`[dsh-ia/assets] 已初始化资产层 git 仓库：${dir}`)
    return { dir, initialized, degraded: false, reason }
  } catch (err: unknown) {
    const reason = err instanceof Error ? err.message : String(err)
    logger(`[dsh-ia/assets] 警告资产层 git 仓库初始化失败（降级）：${reason}`)
    return { dir, initialized: false, degraded: true, reason }
  }
}

/**
 * 仓库是否已有 HEAD 提交（`git init` 后尚未提交时为 false）。
 *
 * 判据以 git 自身为准（`rev-parse --verify HEAD`），而非读 `.git/HEAD` 文件：
 *   - 成功 → 已有提交历史；
 *   - 失败 → 先用 `rev-parse --git-dir` 复核仓库有效性：
 *     - 复核成功 ⇒ 是合法仓库、只是尚无 HEAD（首次快照场景），返回 false；
 *     - 复核失败 ⇒ git 不可用 / 非 git 仓库等异常，**向上抛**，由调用方降级，
 *       避免误判为「无 HEAD」后继续 `git add -A`。
 */
function hasHeadCommit(run: GitRunner, dir: string): boolean {
  try {
    run(['rev-parse', '--verify', 'HEAD'], dir)
    return true
  } catch {
    // 复核仓库有效性：抛错说明 git 不可用/非仓库，交由调用方降级。
    run(['rev-parse', '--git-dir'], dir)
    return false
  }
}

/**
 * 首次快照：**仅首次快照（仓库尚无 HEAD）** 时把工作区变更提交为第一个 commit。
 *
 * 语义（严格限定为「首次快照」）：
 *   - 已有 HEAD（仓库不是首次快照）→ **完全 no-op**：不 `git add`、不 commit
 *     工作区脏改动，返回
 *     `committed: false, degraded: false`。已就绪仓库的改动（例如 agent 编辑
 *     SKILL.md）必须由进化流程自行写 rationale 并提交，插件启动不得代为提交；
 *   - 尚无 HEAD（`git init` 后首次启动）→ `git add -A`，有变更则用 `message`
 *     （默认 {@link INITIAL_COMMIT_MESSAGE}）提交一次；无变更则不提交；
 *   - 资产目录 / `.git` 缺失、git 不可用、命令失败 → 降级不抛，返回
 *     `degraded: true`。
 *
 * 首次启动时由 `src/plugin.ts` 在 5 个 SKILL.md 落盘后调用，故首次提交天然包含
 * 5 个 `skills/<name>/SKILL.md`（外加 `.gitignore`）。
 */
export function commitAssetsChanges(
  options: Omit<EnsureAssetsRepoOptions, 'assetsDir'> & {
    dir?: string
    message?: string
  } = {},
): AssetsCommitOutcome {
  const logger = options.logger ?? createLogFunction('dsh-ia:assets')
  const run = options.gitRunner ?? defaultGitRunner
  const message = options.message ?? INITIAL_COMMIT_MESSAGE

  let dir = ''
  try {
    dir = resolveAssetsGitRoot(options.dir)
    if (!existsSync(dir)) {
      return { dir, committed: false, degraded: true, reason: '资产仓库目录不存在' }
    }
    if (!existsSync(join(dir, '.git'))) {
      return {
        dir,
        committed: false,
        degraded: true,
        reason: '资产仓库未初始化（缺少 .git），跳过首次快照',
      }
    }
    // 先确认 git 可用：不可用直接降级，绝不误判为「无 HEAD」后继续 add。
    run(['--version'], dir)
    if (hasHeadCommit(run, dir)) {
      return {
        dir,
        committed: false,
        degraded: false,
        reason: '已有提交历史，跳过自动快照',
      }
    }
    run(['add', '-A'], dir)
    if (run(['status', '--porcelain'], dir).trim() === '') {
      return { dir, committed: false, degraded: false, reason: '资产仓库无变更（no-op）' }
    }
    run(['commit', '-m', message], dir)
    logger(`[dsh-ia/assets] 资产仓库已提交：${message}`)
    return { dir, committed: true, degraded: false, reason: message }
  } catch (err: unknown) {
    const reason = err instanceof Error ? err.message : String(err)
    logger(`[dsh-ia/assets] 警告资产仓库提交失败（降级）：${reason}`)
    return { dir, committed: false, degraded: true, reason }
  }
}
