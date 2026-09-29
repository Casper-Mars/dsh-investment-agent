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
 * 并发安全：本脚本可能被多个测试文件（vitest 默认文件级并行）或构建流程
 * 并发调用，且写入同一 `dist-server/**`。`fs.cpSync` 内部「先 stat 再拷贝」
 * 在并发下会对同一目标文件抛 `EEXIST`。故改为「读源内容 → 写唯一临时文件 →
 * 原子 rename 覆盖目标」的幂等写入：rename 在同一文件系统上是原子操作，
 * 后写者覆盖先写者，且不会出现半写/EEXIST。只触碰本脚本负责的 `.md` 资源，
 * 不删除 tsc 产出的 `.js` / `.d.ts` 等编译产物。
 *
 * 用法：`node scripts/copy-assets.mjs`（由 `package.json` 的 `build` / `build:server` 调用）。
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { randomBytes } from 'node:crypto'
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

/**
 * 幂等写入单文件：读源 → 写唯一临时文件 → 原子 rename 覆盖目标。
 * 并发调用同一目标时，rename 原子生效，后写者覆盖先写者，不会 EEXIST。
 */
function copyAssetIdempotent(from, to) {
  mkdirSync(path.dirname(to), { recursive: true })
  const content = readFileSync(from)
  const tmp = `${to}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`
  try {
    writeFileSync(tmp, content)
    renameSync(tmp, to)
  } catch (err) {
    // 失败时清理临时文件，避免残留。
    try {
      rmSync(tmp, { force: true })
    } catch {
      /* ignore cleanup failure */
    }
    throw err
  }
}

const assets = collectAssets(srcDir)
for (const rel of assets) {
  const from = path.join(srcDir, rel)
  const to = path.join(outDir, rel)
  copyAssetIdempotent(from, to)
  console.log(`[dsh-finance-assets] ${path.relative(root, from)} -> ${path.relative(root, to)}`)
}

console.log(`[dsh-finance-assets] 共搬运 ${assets.length} 个资源文件到 dist-server/`)
