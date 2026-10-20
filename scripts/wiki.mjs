#!/usr/bin/env node
/**
 * wiki.mjs —— dsh-finance wiki 的索引与体检脚本。
 *
 * 用法：
 *   node scripts/wiki.mjs          # 重建 wiki/index.md 与 wiki/reports/lint.md
 *   node scripts/wiki.mjs --check  # 只检查，不写文件；有错误则退出码 1
 *
 * 设计原则：
 *   - 零第三方依赖，只用 node:*。
 *   - 页面无 frontmatter：标题取第一个 H1，身份取相对路径。
 *   - 生成块用标记包裹，保留块外人工内容。
 *   - 输出确定性（不写时间戳），避免无意义 diff。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const WIKI = join(ROOT, 'wiki')
const CHECK = process.argv.includes('--check')

const SKIP_DIRS = new Set(['_templates', 'reports', '.index', 'node_modules'])
const SKIP_FILES = new Set(['README.md', 'AGENTS.md'])
const GROUP_LABELS = {
  entities: '实体',
  concepts: '概念',
  decisions: '决策记录',
  guides: '操作手册',
  sources: '证据',
}

function walk(dir, out = []) {
  for (const name of readdirSync(dir).sort()) {
    if (name.startsWith('.') || SKIP_DIRS.has(name)) continue
    const abs = join(dir, name)
    const st = statSync(abs)
    if (st.isDirectory()) walk(abs, out)
    else if (name.endsWith('.md') && !SKIP_FILES.has(name)) out.push(abs)
  }
  return out
}

const toPosix = (p) => p.split(sep).join('/')

function parsePage(abs) {
  const body = readFileSync(abs, 'utf8')
  const rel = toPosix(relative(WIKI, abs))
  const id = rel.replace(/\.md$/, '')
  const title = (body.match(/^#\s+(.+)$/m) || [])[1]?.trim() ?? ''
  const links = []
  for (const m of body.matchAll(/\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]*))?\]\]/g)) {
    links.push({ target: m[1].trim().replace(/^wiki\//, '').replace(/\.md$/, ''), label: (m[2] || '').trim() })
  }
  const srcMatch = body.match(/^##\s+来源\s*$([\s\S]*?)(?=^##\s|(?![\s\S]))/m)
  const sources = []
  if (srcMatch) {
    for (const m of srcMatch[1].matchAll(/`([^`]+)`/g)) {
      const ref = m[1].trim()
      if (/^https?:\/\//.test(ref) || ref.startsWith('~') || ref.includes('*') || ref.includes('<')) continue
      if (!/^[\w./-]+$/.test(ref)) continue
      sources.push(ref.replace(/\/$/, ''))
    }
  }
  return { abs, rel, id, title, body, links, sources, hasSourceSection: Boolean(srcMatch) }
}

function gitTime(files) {
  const res = spawnSync('git', ['-C', ROOT, 'log', '-1', '--format=%ct', '--', ...files], {
    encoding: 'utf8',
  })
  if (res.status !== 0) return 0
  const n = Number.parseInt((res.stdout || '').trim(), 10)
  return Number.isFinite(n) ? n : 0
}

const pages = walk(WIKI).filter((abs) => toPosix(relative(WIKI, abs)) !== 'index.md').map(parsePage)
const byId = new Map(pages.map((p) => [p.id, p]))

const errors = []
const warnings = []

for (const page of pages) {
  if (!page.title) errors.push(`${page.rel}：缺少 H1 标题`)
  if (!page.hasSourceSection) errors.push(`${page.rel}：缺少 “## 来源” 段`)
  else if (page.sources.length === 0) errors.push(`${page.rel}：“## 来源” 段没有可用路径`)

  for (const ref of page.sources) {
    if (!existsSync(resolve(ROOT, ref))) errors.push(`${page.rel}：来源不存在 → ${ref}`)
  }

  for (const link of page.links) {
    if (!byId.has(link.target)) errors.push(`${page.rel}：wikilink 无法解析 → [[${link.target}]]`)
  }
}

// 孤儿页：没有任何其它页面指向它
const inbound = new Map(pages.map((p) => [p.id, 0]))
for (const page of pages) {
  for (const link of page.links) {
    if (link.target !== page.id && inbound.has(link.target)) inbound.set(link.target, inbound.get(link.target) + 1)
  }
}
for (const [id, count] of inbound) {
  if (count === 0) warnings.push(`${id}.md：孤儿页（没有入链）`)
}

// 重复标题
const titleCount = new Map()
for (const page of pages) titleCount.set(page.title, (titleCount.get(page.title) || 0) + 1)
for (const [title, count] of titleCount) {
  if (title && count > 1) warnings.push(`重复标题：“${title}” 出现 ${count} 次`)
}

// 来源比页面新 → 页面可能过期（仅对已提交页面生效）
for (const page of pages) {
  const repoRel = toPosix(relative(ROOT, page.abs))
  const pageTime = gitTime([repoRel])
  if (!pageTime || page.sources.length === 0) continue
  const srcTime = gitTime(page.sources)
  if (srcTime > pageTime) warnings.push(`${page.rel}：来源比页面新，结论可能已过期`)
}

const summary = `页面 ${pages.length} · 错误 ${errors.length} · 警告 ${warnings.length}`
const groups = new Map()
for (const page of pages) {
  const group = page.id.includes('/') ? page.id.split('/')[0] : 'other'
  if (!groups.has(group)) groups.set(group, [])
  groups.get(group).push(page)
}

const order = ['entities', 'concepts', 'decisions', 'guides', 'sources']
const sortedGroups = [...groups.keys()].sort((a, b) => {
  const ia = order.indexOf(a)
  const ib = order.indexOf(b)
  return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib) || a.localeCompare(b)
})

const indexLines = ['<!-- wiki:index:start -->', `> ${summary}`, '']
for (const group of sortedGroups) {
  indexLines.push(`### ${GROUP_LABELS[group] || group}`, '')
  for (const page of groups.get(group).sort((a, b) => a.id.localeCompare(b.id))) {
    indexLines.push(`- [[${page.id}|${page.title || page.id}]]`)
  }
  indexLines.push('')
}
indexLines.push('<!-- wiki:index:end -->')
const indexBlock = indexLines.join('\n')

const indexAbs = join(WIKI, 'index.md')
const indexSkeleton = `# Wiki Index\n\n> 本页由 \`pnpm wiki\` 生成；标记块外可写人工备注。\n\n${indexBlock}\n\n## 人工备注\n`

if (!CHECK) {
  if (!existsSync(indexAbs)) {
    writeFileSync(indexAbs, indexSkeleton, 'utf8')
  } else {
    const old = readFileSync(indexAbs, 'utf8')
    const re = /<!-- wiki:index:start -->[\s\S]*?<!-- wiki:index:end -->/
    writeFileSync(indexAbs, re.test(old) ? old.replace(re, indexBlock) : indexSkeleton, 'utf8')
  }
}

const reportLines = [
  '# Wiki Lint',
  '',
  '> 由 `pnpm wiki` 生成，勿手改。输出不含时间戳，未变化时不会产生 diff。',
  '',
  `## 统计`,
  '',
  `- ${summary}`,
  '',
  '## 错误',
  '',
  ...(errors.length ? errors.map((e) => `- ${e}`) : ['- 无']),
  '',
  '## 警告',
  '',
  ...(warnings.length ? warnings.map((w) => `- ${w}`) : ['- 无']),
  '',
  '## 规则',
  '',
  '- 每个页面必须有 H1 标题与 `## 来源` 段；来源路径必须真实存在。',
  '- `[[wikilink]]` 必须解析到 `wiki/` 下的页面（省略 `.md`）。',
  '- 警告项：孤儿页、重复标题、来源比页面新。',
  '',
]
const report = reportLines.join('\n')

if (!CHECK) {
  mkdirSync(join(WIKI, 'reports'), { recursive: true })
  writeFileSync(join(WIKI, 'reports', 'lint.md'), report, 'utf8')
}

console.log(`[wiki] ${summary}`)
for (const e of errors) console.error(`[error] ${e}`)
for (const w of warnings) console.warn(`[warn] ${w}`)
if (CHECK && errors.length > 0) process.exit(1)
