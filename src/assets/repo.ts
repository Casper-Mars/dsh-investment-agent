/**
 * assets 外层 git 仓库 —— `<assetsDir>` 自身的版本管理地基。
 *
 * 背景（策略资产迁移任务-3）：
 *   策略文档是资产，版本交给 git。策略正文落在 `<assetsDir>/strategies/<symbol>.md`，
 *   每次变更由 {@link StrategyRegistry} 在**外层仓库**提交；`strategy_versions/`、
 *   `vNNN.md`、`vNNN.meta.json`、`current` 等自建版本链全部删除。
 *
 * 仓库布局：
 * ```
 * <assetsDir>/                      # 外层 git 仓库根（本模块负责初始化）
 *   .git/
 *   .gitignore                      # 排除 skills/ 与系统垃圾
 *   strategies/<symbol>.md          # 策略正文（纯正文，无 front-matter）
 *   skills/                         # 【嵌套独立 git 仓库】不纳入外层仓库
 * ```
 *
 * ⚠️ 为什么 `.gitignore` 必须排除 `skills/`：
 *   `assets/skills` 是**独立 git 仓库**（skill 自有历史）。若外层仓库不显式忽略，
 *   `git add -A` 会把它记录成 gitlink（嵌入式仓库 / submodule 语义），既丢失
 *   skill 内容，又让外层仓库的 diff / clone 依赖一个不存在的 submodule 配置。
 *   故外层仓库创建时即写入 `.gitignore` 排除 `skills/`。
 *
 * 设计约束（对齐 `src/skills/repo.ts`）：
 *   - 幂等：已有 `.git` → no-op；`.gitignore` 仅缺失时写入；
 *   - 降级不抛：git 不可用 / 无写权限等失败 → 返回 `degraded`，由调用方决定
 *     （策略写入是强语义操作，调用方会据此抛错；本模块自身不中断插件装载）；
 *   - 作者身份经 `src/assets/git.ts` 显式注入，不依赖宿主机 git config。
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { resolveAssetsDir } from '../paths.js'
import { defaultGitRunner, initGitRepo, type GitRunner } from './git.js'
import { createLogFunction } from '../log/logger.js'

/** 外层仓库 `.gitignore` 内容。 */
export const ASSETS_GITIGNORE = [
  '# 嵌套独立 git 仓库：skills 有自己的历史，不纳入外层仓库',
  'skills/',
  '.DS_Store',
  '*.tmp',
  '',
].join('\n')

/** 外层仓库确保选项。 */
export interface EnsureAssetsRepoOptions {
  /** 资产层根目录（可选）；省略时取 `resolveAssetsDir()`（`~/.dsh-ia/assets`）。 */
  assetsDir?: string
  /** 日志函数（默认走统一日志门面，info 级）。 */
  logger?: (message: string) => void
  /** 自定义 git 执行器（仅测试注入；默认走 `node:child_process` 调系统 git）。 */
  gitRunner?: GitRunner
}

/** 外层仓库确保结果。 */
export interface AssetsRepoOutcome {
  /** 外层仓库绝对路径（`<assetsDir>`）。 */
  dir: string
  /** 本次是否执行了 `git init`。false 表示已存在或降级。 */
  initialized: boolean
  /** 是否因失败而降级（git 不可用 / 命令失败 / 无写权限等）。 */
  degraded: boolean
  /** 判据 / 降级原因说明。 */
  reason: string
}

/** 解析 assets 外层仓库根目录（纯计算，无副作用）。 */
export function resolveAssetsGitRoot(assetsDir?: string): string {
  return assetsDir ?? resolveAssetsDir()
}

/**
 * 确保 assets 外层 git 仓库就绪（幂等）。
 *
 * - 目录缺失 → `mkdir -p`；
 * - 缺 `.git` → `git init -b main`（失败回落 `git init`）；
 * - `.gitignore` 缺失 → 写入（排除 `skills/`，见模块头注释）；
 * - 已存在 → no-op。
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

    const gitignore = join(dir, '.gitignore')
    if (!existsSync(gitignore)) {
      writeFileSync(gitignore, ASSETS_GITIGNORE, 'utf8')
    }

    const reason = initialized ? 'assets 仓库缺失，已初始化' : 'assets 仓库已就绪'
    if (initialized) logger(`[dsh-ia/assets] 已初始化资产层 git 仓库：${dir}`)
    return { dir, initialized, degraded: false, reason }
  } catch (err: unknown) {
    const reason = err instanceof Error ? err.message : String(err)
    logger(`[dsh-ia/assets] 警告资产层 git 仓库初始化失败（降级）：${reason}`)
    return { dir, initialized: false, degraded: true, reason }
  }
}
