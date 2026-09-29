/**
 * SKILL.md frontmatter 轻量解析器。
 *
 * 职责：从 `SKILL.md` 文本中解析出 YAML frontmatter（`---` 包裹的头部），
 * 提取 `name` / `description` / 可选 `whenToUse`，并返回**正文**（body）。
 *
 * 设计约束（对应 Task 5 §C）：
 *   - **不引入第三方 YAML 依赖**：frontmatter 仅用「单行 `key: value`」的轻量语法；
 *   - 支持值两侧的**成对引号**（单引号 / 双引号），双引号内支持 `\n`、`\"`、`\\` 转义；
 *   - `name` 必须为 kebab-case（`^[a-z0-9]+(?:-[a-z0-9]+)*$`）且非空；
 *   - `description` 必填且非空；`whenToUse` 可省略。
 *
 * 该模块纯函数、无 IO，便于单测（真实 `SKILL.md` 与构造文本均可断言）。
 */

/** SKILL 名称的 kebab-case 语法（与 dsh skill 注册表校验一致）。 */
export const SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/** 解析出的 frontmatter 关键字段。 */
export interface SkillFrontmatter {
  /** kebab-case 技能名（必填）。 */
  name: string
  /** 面向模型的路由描述（必填）。 */
  description: string
  /** 何时加载该技能（可选）。 */
  whenToUse?: string
}

/** 一份 SKILL.md 的解析结果。 */
export interface ParsedSkillFile {
  /** frontmatter 关键字段。 */
  frontmatter: SkillFrontmatter
  /** frontmatter 之后的 Markdown 正文（去除前后空白行）。 */
  content: string
}

/** 去除单个值两侧成对引号，并还原双引号内的转义。 */
function unquote(raw: string): string {
  const value = raw.trim()
  if (value.length >= 2) {
    const first = value[0]
    const last = value[value.length - 1]
    if (first === '"' && last === '"') {
      return value
        .slice(1, -1)
        .replace(/\\(["\\n])/g, (_m, ch: string) => (ch === 'n' ? '\n' : ch))
    }
    if (first === "'" && last === "'") {
      // 单引号：YAML 以 '' 表示单个单引号。
      return value.slice(1, -1).replace(/''/g, "'")
    }
  }
  return value
}

/**
 * 解析 SKILL.md 文本。
 *
 * @param raw 文件原始文本（可含 BOM、CRLF）。
 * @returns frontmatter 字段 + 正文。
 * @throws {Error} 缺少 frontmatter、缺少 name/description、或 name 非法时抛出。
 */
export function parseSkillFile(raw: string): ParsedSkillFile {
  const text = raw.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n')
  const lines = text.split('\n')

  // 首行必须是 `---`（允许前置空白行）。
  let start = 0
  while (start < lines.length && lines[start].trim() === '') start += 1
  if (lines[start]?.trim() !== '---') {
    throw new Error('SKILL.md 缺少 YAML frontmatter（首行应为 "---"）')
  }

  // 找到闭合的 `---`。
  let end = start + 1
  while (end < lines.length && lines[end].trim() !== '---') end += 1
  if (end >= lines.length) {
    throw new Error('SKILL.md frontmatter 未闭合（缺少结尾 "---"）')
  }

  const entries: Record<string, string> = {}
  for (let i = start + 1; i < end; i += 1) {
    const line = lines[i]
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue
    const sep = line.indexOf(':')
    if (sep === -1) continue
    const key = line.slice(0, sep).trim()
    if (key === '') continue
    entries[key] = unquote(line.slice(sep + 1))
  }

  const name = entries.name ?? ''
  const description = entries.description ?? ''
  if (name === '') throw new Error('SKILL.md frontmatter 缺少 name')
  if (!SKILL_NAME_PATTERN.test(name)) {
    throw new Error(`SKILL.md frontmatter 的 name 非法（需 kebab-case）："${name}"`)
  }
  if (description === '') throw new Error(`SKILL.md "${name}" 缺少 description`)

  const content = lines
    .slice(end + 1)
    .join('\n')
    .replace(/^\n+/, '')
    .replace(/\n+$/, '')

  const frontmatter: SkillFrontmatter = { name, description }
  if (entries.whenToUse !== undefined && entries.whenToUse !== '') {
    frontmatter.whenToUse = entries.whenToUse
  }

  return { frontmatter, content }
}
