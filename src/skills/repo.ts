/**
 * skill 资产落盘 —— `<assetsDir>/skills` 只是**普通目录**，不持有独立 git 仓库。
 *
 * 背景（assets 单仓接入任务）：
 *   skill 资产历史上落在 `<assetsDir>/skills` 的**嵌套独立 git 仓库**中（skill 自有
 *   进化历史）。现统一为单一仓库：`<assetsDir>/.git` 是唯一仓库，`skills/` 与其他资产
 *   （strategies / programs / tasks）共用同一条历史。本模块因此**不再** `git init`、
 *   不再产生首版提交，只负责「读取随包种子 + 幂等落盘」。
 *
 * 布局：
 *
 *     <assetsDir>/skills/<name>/SKILL.md   # 5 个「可进化 skill」（目录名 = frontmatter.name）
 *
 *   注意：`task-authorship` / `skill-authorship` / `finance-evolution` 是「固有 SKILL」，
 *   **不**落入本目录——它们不随 git 进化链 / 热更新时间线变动，由 `src/plugin.ts`
 *   单独静态注册。故本模块只预置 5 个可进化 SKILL（= {@link SKILL_NAMES}）。
 *
 * 本模块职责：
 *   1. {@link resolveSkillsRepoDir}：`<assetsDir>/skills` 路径解析；
 *   2. {@link loadSkillSeeds}：从随包发布的**首版种子**（`src/skills/<name>/SKILL.md`，
 *      编译态为 `dist-server/skills/<name>/SKILL.md`）读取 5 份原文，并校验
 *      「目录名 / 文件名 / frontmatter.name」三者一致；
 *   3. {@link ensureSkillAssetsRepo}：**幂等**落盘 —— 缺失的 SKILL.md 补齐；
 *      已存在的文件**绝不覆盖**（保护 agent 后续编辑与进化历史）。
 *
 * 设计约束：
 *   - **不新增第三方依赖**，也不依赖 git：版本管理统一由 `src/assets/repo.ts` 负责；
 *   - **路径来源统一**：assetsDir 复用 `src/paths.ts` 的 {@link resolveAssetsDir}
 *     （`~/.dsh-ia/assets`，跟随 `DSH_IA_HOME` 覆盖），**不**用 `process.cwd()` 锚定；
 *   - **降级语义**：种子读取失败 / 无写权限等 → 记日志、降级不抛、不中断插件装载。
 *
 * 依赖：`src/paths.ts`（叶子模块）、`src/skills/{index,frontmatter}.js`。
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { resolveAssetsDir } from '../paths.js'
import { loadSkillMarkdown, SKILL_NAMES, type SkillName } from './index.js'
import { parseSkillFile } from './frontmatter.js'
import { createLogFunction } from '../log/logger.js'

/** skill 资产目录的目录名（位于 assetsDir 下）。 */
export const SKILLS_REPO_DIRNAME = 'skills'

/** 每个 skill 的固定文件名。 */
export const SKILL_FILENAME = 'SKILL.md'

/** 落盘选项。 */
export interface EnsureSkillAssetsOptions {
  /** 资产层根目录（可选）；省略时取 `resolveAssetsDir()`（`~/.dsh-ia/assets`）。 */
  assetsDir?: string
  /** 日志函数（默认走统一日志门面，info 级）。 */
  logger?: (message: string) => void
}

/** 落盘结果（可判断，便于单测断言）。 */
export interface SkillAssetsRepoOutcome {
  /** skill 资产目录绝对路径（`<assetsDir>/skills`）。 */
  dir: string
  /** 本次是否写入了新的 SKILL.md。false 表示全部已存在（no-op）或降级。 */
  provisioned: boolean
  /** 是否因失败而降级跳过（种子读取失败 / 无写权限等）。 */
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

/** 解析 skill 资产目录路径：`<assetsDir>/skills`（纯计算，无副作用）。 */
export function resolveSkillsRepoDir(assetsDir: string): string {
  return join(assetsDir, SKILLS_REPO_DIRNAME)
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
 * 冷启动落盘 skill 资产（**幂等**）。
 *
 * - 目录缺失 → 创建；
 * - 逐个 SKILL.md：**仅缺失时写入种子**；已存在则保持原样（agent 可能已编辑，
 *   或已由 git 进化链更新过，绝不回滚覆盖）；
 * - 不做任何 git 操作（仓库由 `src/assets/repo.ts` 统一管理）。
 *
 * 任何失败（种子读取 / 写权限 / 路径被普通文件占位）都被捕获：
 * **记日志、降级不抛**，不中断插件装载。
 *
 * @param options 见 {@link EnsureSkillAssetsOptions}。
 * @returns 落盘结果（`provisioned` / `degraded` / `reason`）。
 */
export function ensureSkillAssetsRepo(
  options: EnsureSkillAssetsOptions = {},
): SkillAssetsRepoOutcome {
  const logger = options.logger ?? createLogFunction('dsh-ia:skills')

  let dir = ''
  try {
    const assetsDir = options.assetsDir ?? resolveAssetsDir()
    dir = resolveSkillsRepoDir(assetsDir)

    // 先读种子：种子非法时直接失败，避免落下半套内容。
    const seeds = loadSkillSeeds()
    mkdirSync(dir, { recursive: true })

    let written = 0
    for (const seed of seeds) {
      const skillDir = join(dir, seed.name)
      const file = join(skillDir, SKILL_FILENAME)
      if (existsSync(file)) continue
      mkdirSync(skillDir, { recursive: true })
      writeFileSync(file, seed.markdown, 'utf8')
      written += 1
    }

    if (written > 0) {
      logger(
        `[dsh-ia/skills] 冷启动落盘完成：${dir}（新建 ${written}/${seeds.length} 个 SKILL.md）`,
      )
      return {
        dir,
        provisioned: true,
        degraded: false,
        reason: `新建 ${written} 个 SKILL.md`,
      }
    }
    return { dir, provisioned: false, degraded: false, reason: 'skill 资产已就绪' }
  } catch (err: unknown) {
    const reason = err instanceof Error ? err.message : String(err)
    logger(`[dsh-ia/skills] 警告 skill 资产落盘失败（降级跳过）：${reason}`)
    return { dir, provisioned: false, degraded: true, reason }
  }
}
