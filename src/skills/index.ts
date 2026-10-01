/**
 * Agent SKILL 层入口 —— 技术面 5 个运行时 SKILL 的**唯一注册出口**。
 *
 * 职责（对应 Task 5 §A / §C）：
 *   1. 从 `src/skills/<name>/SKILL.md` 读取 Markdown（随构建产物发布到
 *      `dist-server/skills/<name>/SKILL.md`）；
 *   2. 解析 frontmatter（轻量解析器见 `./frontmatter.js`）提取
 *      `name` / `description` / `whenToUse`；
 *   3. 组装为运行时 SKILL 贡献（`SkillRegistration`，`content` = 正文）；
 *   4. 经 `ctx.skills.register()` 注册到当前上下文作用域，返回注销器。
 *
 * 路径策略：`new URL('./<name>/SKILL.md', import.meta.url)` 在源码态
 *   （`src/skills/index.ts`）与编译态（`dist-server/skills/index.js`）下
 *   均指向同名相对目录，故两态皆可解析；`.md` 由 `scripts/copy-assets.mjs`
 *   搬运到 `dist-server`。
 *
 * 依赖：调用方（`plugin.ts`）需 `inject` 含 `'skills'`，保证 `ctx.skills` 就绪；
 *   `@deepseek-ai/dsh-skill` 仅用于类型（编译期擦除，无运行时裸包导入）。
 */
import { readFileSync } from 'node:fs'
import type { Context } from '@deepseek-ai/cordis'
import type { SkillRegistration } from '@deepseek-ai/dsh-skill'
import { parseSkillFile, type ParsedSkillFile } from './frontmatter.js'

/**
 * 技术面 SKILL 名清单（kebab-case）。
 *
 * 目次顺序即注册顺序：趋势研判 → 网格策略 → 止损纪律 → 策略创作 → 感知脚本创作。
 * 目录名与 frontmatter 的 `name` 必须与之一致（skill-filesystem 发现规范）。
 */
export const SKILL_NAMES = [
  'trend-analysis',
  'grid-strategy',
  'stop-rule',
  'strategy-authorship',
  'sense-authorship',
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

/**
 * 组装单个运行时 SKILL 注册对象（无副作用，便于单测断言）。
 *
 * `source` 为 `runtime`（运行时贡献）；`invocation` 同时开放模型侧与用户侧。
 */
export function createSkillRegistration(name: SkillName): SkillRegistration {
  const { frontmatter, content } = parseSkill(name)
  return {
    name: frontmatter.name,
    description: frontmatter.description,
    ...(frontmatter.whenToUse === undefined ? {} : { whenToUse: frontmatter.whenToUse }),
    source: 'runtime',
    content,
    invocation: { modelInvocable: true, userInvocable: true },
  }
}

/** 组装全部 5 个 SKILL 注册对象。 */
export function createAllSkillRegistrations(): SkillRegistration[] {
  return SKILL_NAMES.map((name) => createSkillRegistration(name))
}

/**
 * 将 5 个技术面 SKILL 注册到当前上下文（唯一注册出口）。
 *
 * @param ctx 插件上下文（需 `inject` 含 `'skills'`，`ctx.skills` 就绪）。
 * @returns 注销器：按注册**逆序**注销全部 SKILL（由调用方绑定到 `ctx.effect`）。
 */
export function registerAllSkills(ctx: Context): () => void {
  const disposers = SKILL_NAMES.map((name) => ctx.skills.register(createSkillRegistration(name)))
  return () => {
    for (let i = disposers.length - 1; i >= 0; i -= 1) disposers[i]?.()
  }
}
