/**
 * skill 资产仓库 —— 数据目录内的**独立 git 仓库**（`<dataRoot>/skills`）。
 *
 * 背景（skill 重构任务-1）：
 *   历史上 skill（5 个可进化 + 1 个固有）以「随源码编译的静态 `.md`」形式存在于
 *   `src/skills/<name>/SKILL.md`（`scripts/copy-assets.mjs` 搬运到
 *   `dist-server/skills/`），只能随包发布、运行时不改写。目标是把 skill 资产
 *   迁移为「运行时可写 + 可 git 版本管理」的载体，落在数据目录下的独立 git
 *   仓库 `<dataRoot>/skills`：
 *
 *     <dataRoot>/skills                 # 独立 git 仓库根
 *     <dataRoot>/skills/<name>/SKILL.md # 5 个「可进化 skill」（目录名 = frontmatter.name）
 *
 *   注意：`task-authorship` 是「固有 SKILL」（任务程序方法论），**不**落入本仓库——
 *   它不随 git 进化链 / 热更新时间线变动，由 `src/plugin.ts` 单独静态注册。故本模块
 *   只预置 5 个可进化 SKILL（= {@link SKILL_NAMES}）。
 *
 *   此后 agent 复盘改文件 → `git commit` → 热更新（provider 切换属后续任务）。
 *
 * 本模块职责（仅「数据载体 + 迁移 + 幂等预置」这一层地基）：
 *   1. {@link resolveSkillsRepoDir}：`<dataRoot>/skills` 路径解析；
 *   2. {@link loadSkillSeeds}：从随包发布的**首版种子**（`src/skills/<name>/SKILL.md`，
 *      编译态为 `dist-server/skills/<name>/SKILL.md`）读取 5 份原文，并校验
 *      「目录名 / 文件名 / frontmatter.name」三者一致；
 *   3. {@link ensureSkillAssetsRepo}：**幂等**冷启动预置 —— 仓库缺失或为空时
 *      `mkdir -p` + `git init` + 落首版 5 个 SKILL.md + `git add` + `git commit`；
 *      仓库已就绪则**完全 no-op**（不重复 init / 不产生第二个 commit）。
 *
 * 设计约束：
 *   - **不新增第三方依赖**：git 一律经 `node:child_process`（`execFileSync`）调用；
 *   - **路径来源统一**：dataRoot 复用 `src/paths.ts` 的 {@link resolveDataRoot}
 *     （构造注入 > `DSH_FINANCE_DATA_DIR` > `~/.dsh-finance/data`），**不**用
 *     `process.cwd()` 锚定（历史漂移问题，已修）；
 *   - **降级语义**：git 不可用 / 命令非零退出 / 无写权限等 → 记日志、降级不抛、
 *     不中断插件装载（对齐 `src/plugin.ts` / `src/session-ensure.ts` 的软取 +
 *     try/catch 风格）；
 *   - **不依赖宿主机全局 git config**：以 `-c user.name=... -c user.email=...`
 *     显式提供作者身份（并同时设 `GIT_AUTHOR_*` / `GIT_COMMITTER_*` 环境变量），
 *     全新环境未配置 git 时仍可提交。
 *
 * 依赖：`src/paths.ts`（叶子模块）、`src/skills/{index,frontmatter}.js`。
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { resolveDataRoot } from '../paths.js'
import { loadSkillMarkdown, SKILL_NAMES, type SkillName } from './index.js'
import { parseSkillFile } from './frontmatter.js'

/** skill 资产仓库的目录名（位于 dataRoot 下）。 */
export const SKILLS_REPO_DIRNAME = 'skills'

/** 每个 skill 的固定文件名。 */
export const SKILL_FILENAME = 'SKILL.md'

/** 首版 commit 的 message。 */
export const INITIAL_COMMIT_MESSAGE = 'init: skill 资产首版'

/** git 作者身份：显式提供，避免依赖宿主机全局 git config。 */
export const GIT_IDENTITY_NAME = 'dsh-finance'
export const GIT_IDENTITY_EMAIL = 'dsh-finance@localhost'

/** 仓库内 `.gitignore` 内容：**不**忽略 skill 内容，仅忽略系统/临时文件。 */
export const SKILLS_GITIGNORE = '# 仅忽略系统/临时文件；skill 内容一律纳入版本管理。\n.DS_Store\n*.tmp\n'

/**
 * git 命令执行器：执行 `git <args>`（cwd 指定工作目录），成功返回 stdout 文本，
 * 失败（非零退出 / 可执行文件缺失）抛错。可注入以便单测模拟 git 不可用。
 */
export type GitRunner = (args: string[], cwd: string) => string

/** 默认 git 执行器：`execFileSync` 调 `git`，显式注入作者身份。 */
function defaultGitRunner(args: string[], cwd: string): string {
  return execFileSync(
    'git',
    [
      '-c',
      `user.name=${GIT_IDENTITY_NAME}`,
      '-c',
      `user.email=${GIT_IDENTITY_EMAIL}`,
      ...args,
    ],
    {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      // 双保险：即便 `-c` 被上层覆盖，commit 仍带显式作者/提交者身份。
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: GIT_IDENTITY_NAME,
        GIT_AUTHOR_EMAIL: GIT_IDENTITY_EMAIL,
        GIT_COMMITTER_NAME: GIT_IDENTITY_NAME,
        GIT_COMMITTER_EMAIL: GIT_IDENTITY_EMAIL,
      },
    },
  )
}

/** 预置选项。 */
export interface EnsureSkillAssetsOptions {
  /** 数据根目录（可选）；省略时依次取环境变量 `DSH_FINANCE_DATA_DIR` → 默认值。 */
  dataRoot?: string
  /** 日志函数（默认 `console.log`）。 */
  logger?: (message: string) => void
  /** 自定义 git 执行器（仅测试注入；默认走 `node:child_process` 调系统 git）。 */
  gitRunner?: GitRunner
}

/** 预置结果（可判断，便于单测断言）。 */
export interface SkillAssetsRepoOutcome {
  /** skill 资产仓库绝对路径（`<dataRoot>/skills`）。 */
  dir: string
  /** 本次是否执行了预置（写入 + 提交）。false 表示 no-op 或降级未预置。 */
  provisioned: boolean
  /** 是否因失败而降级跳过（git 不可用 / 命令失败 / 无写权限等）。 */
  degraded: boolean
  /** 判据 / 降级原因说明。 */
  reason: string
}

/** 一份随包发布的首版 skill 种子。 */
export interface SkillSeed {
  /** skill 名（目录名，等于 frontmatter.name）。 */
  name: SkillName
  /** SKILL.md 原文（frontmatter + 正文，逐字节）。 */
  markdown: string
}

/** 解析 skill 资产仓库路径：`<dataRoot>/skills`（纯计算，无副作用）。 */
export function resolveSkillsRepoDir(dataRoot: string): string {
  return join(dataRoot, SKILLS_REPO_DIRNAME)
}

/**
 * 载入 5 份首版种子（`src/skills/<name>/SKILL.md`，编译态为
 * `dist-server/skills/<name>/SKILL.md`），并校验一致性：
 *   目录名（= 枚举名）与 frontmatter.name 一致；frontmatter 合法（kebab-case、
 *   description 非空）。返回**原文**（保留逐字节正文）。
 *
 * @throws {Error} 任一 skill 缺失 / frontmatter 非法 / 目录名与 name 不一致时抛出
 *   （由 {@link ensureSkillAssetsRepo} 捕获降级）。
 */
export function loadSkillSeeds(): SkillSeed[] {
  return SKILL_NAMES.map((name) => {
    const markdown = loadSkillMarkdown(name)
    const parsed = parseSkillFile(markdown)
    if (parsed.frontmatter.name !== name) {
      throw new Error(
        `SKILL 目录名与 frontmatter.name 不一致：目录 "${name}" vs name "${parsed.frontmatter.name}"`,
      )
    }
    return { name, markdown }
  })
}

/**
 * 是否存在任一 skill 内容（非 `.git` 子目录下的 `SKILL.md`）。
 *
 * 用于「为空」判定：仅有多余空目录（无 SKILL.md）视为**需要预置**。
 */
function hasAnySkillContent(repoDir: string): boolean {
  let entries: string[]
  try {
    entries = readdirSync(repoDir)
  } catch {
    return false
  }
  for (const entry of entries) {
    if (entry === '.git') continue
    const abs = join(repoDir, entry)
    try {
      if (!statSync(abs).isDirectory()) continue
    } catch {
      continue
    }
    if (existsSync(join(abs, SKILL_FILENAME))) return true
  }
  return false
}

/** 仓库是否已有提交（HEAD 可解析）。git 不可用 / 无提交 → false。 */
function hasHeadCommit(repoDir: string, run: GitRunner): boolean {
  try {
    run(['rev-parse', '--verify', 'HEAD'], repoDir)
    return true
  } catch {
    return false
  }
}

/** 仓库状态判定结果。 */
interface RepoState {
  /** 是否需要（重新）预置。 */
  needsProvision: boolean
  /** 判据说明。 */
  reason: string
}

/**
 * 判定仓库是否需要预置（「为空」判定要稳）：
 *   - 目录缺失 → 需要；
 *   - 无 `.git` → 需要（未初始化）；
 *   - 无任何 skill 内容（含仅有空目录）→ 需要；
 *   - 有 `.git` 但无提交 → 需要；
 *   - 三者齐备 → **完全 no-op**。
 */
function inspectRepo(repoDir: string, run: GitRunner): RepoState {
  if (!existsSync(repoDir)) {
    return { needsProvision: true, reason: 'skills 仓库目录缺失' }
  }
  if (!existsSync(join(repoDir, '.git'))) {
    return { needsProvision: true, reason: 'skills 仓库未初始化（缺少 .git）' }
  }
  if (!hasAnySkillContent(repoDir)) {
    return { needsProvision: true, reason: 'skills 仓库无 skill 内容' }
  }
  if (!hasHeadCommit(repoDir, run)) {
    return { needsProvision: true, reason: 'skills 仓库无提交历史' }
  }
  return { needsProvision: false, reason: 'skills 仓库已就绪' }
}

/** 初始化 git 仓库（默认分支 main）；`-b` 不被支持时回落到普通 `git init`。 */
function initRepo(repoDir: string, run: GitRunner): void {
  try {
    run(['init', '-b', 'main'], repoDir)
  } catch {
    // 老版本 git 不支持 `-b`：回落普通 init（分支名用仓库默认）。
    run(['init'], repoDir)
  }
}

/** 幂等写入仓库内 `.gitignore`（不忽略 skill 内容）。 */
function ensureGitignore(repoDir: string): void {
  const path = join(repoDir, '.gitignore')
  if (!existsSync(path)) writeFileSync(path, SKILLS_GITIGNORE, 'utf8')
}

/**
 * 执行预置：`mkdir -p` +（必要时）`git init` + 落 5 个 SKILL.md + `git add` +
 * （仅当有变更时）`git commit`。
 *
 * 「仅当有变更时提交」是幂等的第二道保险：即便在「有 `.git` 但无提交」的
 * 半初始化状态下，也不会产生多余提交。
 */
function provisionRepo(repoDir: string, seeds: SkillSeed[], run: GitRunner): void {
  mkdirSync(repoDir, { recursive: true })
  if (!existsSync(join(repoDir, '.git'))) initRepo(repoDir, run)
  ensureGitignore(repoDir)
  for (const seed of seeds) {
    const dir = join(repoDir, seed.name)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, SKILL_FILENAME), seed.markdown, 'utf8')
  }
  run(['add', '-A'], repoDir)
  if (run(['status', '--porcelain'], repoDir).trim() !== '') {
    run(['commit', '-m', INITIAL_COMMIT_MESSAGE], repoDir)
  }
}

/**
 * 冷启动预置 skill 资产仓库（**幂等**，见模块头注释）。
 *
 * 触发时机：插件 `apply(ctx)` 内调用一次。仓库已就绪时 no-op；否则预置。
 * 预置过程中的任何失败（git 不可用 / 命令非零退出 / 无写权限 / 种子读取失败）
 * 都被捕获：**记日志、降级不抛**，不中断插件装载。
 *
 * @param options 见 {@link EnsureSkillAssetsOptions}。
 * @returns 预置结果（可判断：`provisioned` / `degraded` / `reason`）。
 */
export function ensureSkillAssetsRepo(
  options: EnsureSkillAssetsOptions = {},
): SkillAssetsRepoOutcome {
  const logger = options.logger ?? ((message: string) => console.log(message))
  const run = options.gitRunner ?? defaultGitRunner

  let dir = ''
  try {
    const dataRoot = resolveDataRoot(options.dataRoot)
    dir = resolveSkillsRepoDir(dataRoot)

    const state = inspectRepo(dir, run)
    if (!state.needsProvision) {
      // 已就绪：完全 no-op（不重复 init / 不产生第二个 commit）。
      return { dir, provisioned: false, degraded: false, reason: state.reason }
    }

    const seeds = loadSkillSeeds()
    provisionRepo(dir, seeds, run)
    logger(
      `[dsh-finance/skills] 冷启动预置完成：${dir}（${seeds.length} 个 skill，message="${INITIAL_COMMIT_MESSAGE}"）`,
    )
    return { dir, provisioned: true, degraded: false, reason: state.reason }
  } catch (err: unknown) {
    const reason = err instanceof Error ? err.message : String(err)
    logger(`[dsh-finance/skills] 警告 skill 资产仓库预置失败（降级跳过）：${reason}`)
    return { dir, provisioned: false, degraded: true, reason }
  }
}
