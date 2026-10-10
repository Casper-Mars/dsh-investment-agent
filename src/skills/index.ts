/**
 * Agent SKILL 层入口 —— 技术面 6 个 SKILL 的**随包种子读取 / 解析出口**。
 *
 * 职责：
 *   1. 维护 6 个 SKILL 的名清单（{@link SKILL_NAMES}）与联合类型（{@link SkillName}）；
 *   2. 从 `src/skills/<name>/SKILL.md` 读取 Markdown（随构建产物发布到
 *      `dist-server/skills/<name>/SKILL.md`）；
 *   3. 解析 frontmatter（轻量解析器见 `./frontmatter.js`），暴露 {`parseSkill`}。
 *
 * 运行时注册已**不再**经本模块：6 个 SKILL 由 `src/skills/provider.ts` 挂载 dsh 原生
 *   `skill-filesystem` provider，指向数据目录 `<dataRoot>/skills` 并开启 watch 热更新
 *   （见 skill 重构任务-2）。本模块保留的 `SKILL_NAMES` / `loadSkillMarkdown` 是
 *   `src/skills/repo.ts` 冷启动种子预置所需的**纯静态读取**；`parseSkill` 供种子/测试
 *   校验「目录名 = frontmatter.name」一致性。
 *
 * 路径策略：`new URL('./<name>/SKILL.md', import.meta.url)` 在源码态
 *   （`src/skills/index.ts`）与编译态（`dist-server/skills/index.js`）下
 *   均指向同名相对目录，故两态皆可解析；`.md` 由 `scripts/copy-assets.mjs`
 *   搬运到 `dist-server`。
 */
import { readFileSync } from 'node:fs'
import { parseSkillFile, type ParsedSkillFile } from './frontmatter.js'

/**
 * 技术面 SKILL 名清单（kebab-case）。
 *
 * 目次顺序即种子落盘顺序：趋势研判 → 网格策略 → 止损纪律 → 策略创作 → 分析与决策 → 任务程序创作。
 * 目录名与 frontmatter 的 `name` 必须与之一致（skill-filesystem 发现规范）。
 */
export const SKILL_NAMES = [
  'trend-analysis',
  'grid-strategy',
  'stop-rule',
  'strategy-authorship',
  'analysis-decision',
  'task-authorship',
] as const

/** SKILL 名联合类型。 */
export type SkillName = (typeof SKILL_NAMES)[number]

/** 读取某 SKILL 的 Markdown 原文（含 frontmatter）。 */
export function loadSkillMarkdown(name: SkillName): string {
  return readFileSync(new URL(`./${name}/SKILL.md`, import.meta.url), 'utf8')
}

/** 读取并解析某 SKILL 文件（frontmatter + 正文）。 */
export function parseSkill(name: SkillName): ParsedSkillFile {
  const parsed = parseSkillFile(loadSkillMarkdown(name))
  if (parsed.frontmatter.name !== name) {
    throw new Error(
      `SKILL 目录名与 frontmatter.name 不一致：目录 "${name}" vs name "${parsed.frontmatter.name}"`,
    )
  }
  return parsed
}
