/**
 * Agent SKILL 层入口 —— 技术面 SKILL 的**随包种子读取 / 解析出口**。
 *
 * 分野（关键）：
 *   - **5 个「可进化 SKILL」**（{@link SKILL_NAMES}，类型 {@link SkillName}）：
 *     趋势研判 / 网格策略 / 止损纪律 / 策略创作 / 分析与决策。它们是「可进化资产」——
 *     随 `src/skills/repo.ts` 冷启动种子落盘到 `<dataRoot>/skills` 独立 git 仓库，
 *     并由 `src/skills/provider.ts` 挂载的 dsh 原生 `skill-filesystem` provider 发现
 *     且开启 watch 热更新（改 `SKILL.md` → 无需重启生效）。
 *   - **1 个「固有 SKILL」**（{@link TASK_AUTHORSHIP_SKILL_NAME}）：任务程序创作
 *     (`task-authorship`)。它定义任务程序的结构 / 返回值契约 / 自测纪律，属方法论层，
 *     **不进入 git 进化链与热更新时间线**；原文经 {@link loadTaskAuthorshipMarkdown}
 *     读取，由 `src/plugin.ts` 单独**静态注册**（`createIntrinsicSkillRegistration`）。
 *
 * 职责：
 *   1. 维护 5 个可进化 SKILL 的名清单（{@link SKILL_NAMES}）与联合类型（{@link SkillName}）；
 *   2. 从 `src/skills/<name>/SKILL.md` 读取 Markdown（随构建产物发布到
 *      `dist-server/skills/<name>/SKILL.md`）；
 *   3. 解析 frontmatter（轻量解析器见 `./frontmatter.js`），暴露 {`parseSkill`}；
 *   4. 提供固有 SKILL（task-authorship）的静态读取 / 注册对象装配入口。
 *
 * 运行时注册：5 个可进化 SKILL 由 `src/skills/provider.ts` 挂载 dsh 原生
 *   `skill-filesystem` provider 发现（指向 `<dataRoot>/skills`，watch 热更新，
 *   见 skill 重构任务-2）；固有 SKILL 由 `src/plugin.ts` 静态注册。本模块保留的
 *   `SKILL_NAMES` / `loadSkillMarkdown` 是 `src/skills/repo.ts` 冷启动种子预置所需的
 *   **纯静态读取**；`parseSkill` 供种子 / 测试校验「目录名 = frontmatter.name」一致性。
 *
 * 路径策略：`new URL('./<name>/SKILL.md', import.meta.url)` 在源码态
 *   （`src/skills/index.ts`）与编译态（`dist-server/skills/index.js`）下
 *   均指向同名相对目录，故两态皆可解析；`.md` 由 `scripts/copy-assets.mjs`
 *   搬运到 `dist-server`。
 */
import { readFileSync } from 'node:fs'
import type { SkillRegistration } from '@deepseek-ai/dsh-skill'
import { parseSkillFile, type ParsedSkillFile } from './frontmatter.js'

/**
 * 5 个「可进化 SKILL」名清单（kebab-case）。
 *
 * 目次顺序即种子落盘顺序：趋势研判 → 网格策略 → 止损纪律 → 策略创作 → 分析与决策。
 * 目录名与 frontmatter 的 `name` 必须与之一致（skill-filesystem 发现规范）。
 * 固有 SKILL（task-authorship）**不在此清单**，见 {@link TASK_AUTHORSHIP_SKILL_NAME}。
 */
export const SKILL_NAMES = [
  'trend-analysis',
  'grid-strategy',
  'stop-rule',
  'strategy-authorship',
  'analysis-decision',
] as const

/** 可进化 SKILL 名联合类型。 */
export type SkillName = (typeof SKILL_NAMES)[number]

/**
 * 固有 SKILL 名（任务程序创作，kebab-case）。
 *
 * 不进入可进化清单 {@link SKILL_NAMES}：它属方法论层，不随 git 进化链 / 热更新
 * 时间线变动；由 `src/plugin.ts` 静态注册，原文经 {@link loadTaskAuthorshipMarkdown} 读取。
 */
export const TASK_AUTHORSHIP_SKILL_NAME = 'task-authorship' as const

/** 固有 SKILL 名类型。 */
export type IntrinsicSkillName = typeof TASK_AUTHORSHIP_SKILL_NAME

/** 读取某**可进化** SKILL 的 Markdown 原文（含 frontmatter）。 */
export function loadSkillMarkdown(name: SkillName): string {
  return readFileSync(new URL(`./${name}/SKILL.md`, import.meta.url), 'utf8')
}

/**
 * 读取**固有 SKILL**（{@link TASK_AUTHORSHIP_SKILL_NAME}）的 Markdown 原文（含 frontmatter）。
 *
 * 路径解析风格与 {@link loadSkillMarkdown} 一致：`new URL('./<name>/SKILL.md',
 * import.meta.url)` 在源码态与编译态下均指向同名相对目录，故两态皆可解析。
 */
export function loadTaskAuthorshipMarkdown(): string {
  return readFileSync(
    new URL(`./${TASK_AUTHORSHIP_SKILL_NAME}/SKILL.md`, import.meta.url),
    'utf8',
  )
}

/** 读取并解析某**可进化** SKILL 文件（frontmatter + 正文）。 */
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
 * 组装**固有 SKILL**（task-authorship）的运行时注册对象（无副作用，便于单测断言）。
 *
 * `source` 取 `runtime`（运行时贡献）；`invocation` 同时开放模型侧与用户侧。
 * 供 `src/plugin.ts` 经 `ctx.skills.register` **静态注册**（不经数据目录 / provider 发现，
 * 因它是方法论层的「固有资产」，不随 git 进化链变动）。
 *
 * @throws {Error} 文件缺失 / frontmatter 非法时抛出（由调用方捕获降级）。
 */
export function createIntrinsicSkillRegistration(): SkillRegistration {
  const { frontmatter, content } = parseSkillFile(loadTaskAuthorshipMarkdown())
  return {
    name: frontmatter.name,
    description: frontmatter.description,
    ...(frontmatter.whenToUse === undefined ? {} : { whenToUse: frontmatter.whenToUse }),
    source: 'runtime',
    content,
    invocation: { modelInvocable: true, userInvocable: true },
  }
}
