/**
 * 资源搬运脚本：将 `src/**` 下的非 TS 资源（SKILL 指南 / 人设 Prompt 的 `.md`）
 * 复制到 `dist-server/**` 对应位置，使编译产物在运行时仍可读取这些文件。
 *
 * 背景：`tsc` 只产出 `.js` / `.d.ts`，不会搬运 `.md`。在 `src/skills` /
 * `src/prompts` 放置的 Markdown 资源需随构建产物一并发布，以便编译态下
 * `new URL('./relative.md', import.meta.url)` 依然可解析：
 *   - `src/prompts/`（如 advisor.md）→ `dist-server/prompts/`
 *   - `src/skills/`（如 `<name>/SKILL.md`）→ `dist-server/skills/`
 *
 * 实现：自 `src/` 递归收集全部 `.md`，按原相对路径复制到 `dist-server/`。
 *
 * 用法：`node scripts/copy-assets.mjs`（由 `package.json` 的 `build` / `build:server` 调用）。
 */
import { cpSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const srcDir = path.join(root, 'src')
const outDir = path.join(root, 'dist-server')

/** 需要搬运的资源扩展名。 */
const ASSET_EXTENSIONS = new Set(['.md'])

/** 递归遍历目录，返回其中所有匹配扩展名的文件（相对 `srcDir` 的路径）。 */
function collectAssets(dir) {
  const results = []
  if (!existsSync(dir)) return results
  for (const entry of readdirSync(dir)) {
    const abs = path.join(dir, entry)
    const stat = statSync(abs)
    if (stat.isDirectory()) {
      results.push(...collectAssets(abs))
    } else if (ASSET_EXTENSIONS.has(path.extname(entry))) {
      results.push(path.relative(srcDir, abs))
    }
  }
  return results
}

const assets = collectAssets(srcDir)
for (const rel of assets) {
  const from = path.join(srcDir, rel)
  const to = path.join(outDir, rel)
  mkdirSync(path.dirname(to), { recursive: true })
  cpSync(from, to)
  console.log(`[dsh-finance-assets] ${path.relative(root, from)} -> ${path.relative(root, to)}`)
}

console.log(`[dsh-finance-assets] 共搬运 ${assets.length} 个资源文件到 dist-server/`)