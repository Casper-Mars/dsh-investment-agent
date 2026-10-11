/**
 * tester-t100433-seed-provision.INDEPENDENT.spec.ts
 * ==================================================================
 * Tester 独立复验（任务卡 t100433）：为「种子预置与构建搬运」做**运行时 / 产物级**
 * 核验（非仅代码审查）。被测交付物：
 *   - `/Users/reachlucifer/project/opc/dsh-finance`（HEAD=0d13441 + 未提交改动：
 *     `src/skills/provider.ts` / `src/skills/repo.ts` 各 1 行注释，把「6 个技术面
 *     SKILL」表述同步为「5 个可进化 + 1 个固有」）。
 *
 * 覆盖 AC1–AC3（AC4 由三命令外部执行，见同名 REPORT.md §三，避免「测试内跑测试」）：
 *   - AC1：`<dataRoot>/skills` 冷启动只预置 5 个 skill，**无** task-authorship。
 *          真实调用 `loadSkillSeeds()` + 真实 `ensureSkillAssetsRepo()` 冷启动路径
 *          （临时 dataRoot + 真实 git），断言种子 name 集合 = 5 个可进化 SKILL。
 *   - AC2：`dist-server` **仍保留** task-authorship（固有 SKILL 原文可静态读取）。
 *   - AC3：计数注释无「6 个」残留（`src/**` 全文件递归扫描 5 种写法）。
 *
 * 独立性声明（关键）：
 *   本文件由 Tester **独立编写**，不复用 Developer 的 `tests/skill-assets-repo.spec.ts`
 *   / `tests/skill-provider.spec.ts`，也不逐字复制 t100432 的用例。证据链：
 *     - AC1 走 **真实进程 + 真实 git** 的冷启动预置（临时 dataRoot，不污染真实
 *       数据目录），并在预置产物上做**递归文件树**核验（不止顶层目录）；
 *     - AC2 用**编译态 dist-server 动态 import** 读固有 SKILL 原文（产物级，非源态）；
 *     - AC3 用**独立正则扫描器** walk `src/**`，并附「检测器自检」对抗用例。
 * ==================================================================
 */
import { afterEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  SKILL_NAMES,
  TASK_AUTHORSHIP_SKILL_NAME,
  loadTaskAuthorshipMarkdown,
} from '../src/skills/index.js'
import {
  ensureSkillAssetsRepo,
  loadSkillSeeds,
  resolveSkillsRepoDir,
} from '../src/skills/repo.js'
import { parseSkillFile } from '../src/skills/frontmatter.js'

const PROJECT_ROOT = fileURLToPath(new URL('..', import.meta.url))
const SRC_DIR = join(PROJECT_ROOT, 'src')
const DIST_DIR = join(PROJECT_ROOT, 'dist-server')

/** 5 个「可进化 SKILL」（顺序 = SKILL_NAMES 落盘顺序）。 */
const EVOLVABLE = [
  'trend-analysis',
  'grid-strategy',
  'stop-rule',
  'strategy-authorship',
  'analysis-decision',
] as const

/** 固有 SKILL 名（**不应**落入 <dataRoot>/skills）。 */
const TA = TASK_AUTHORSHIP_SKILL_NAME

/** 新建并在用例结束后自动清理的临时目录。 */
const tempDirs: string[] = []
function mkTmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop() as string
    rmSync(dir, { recursive: true, force: true })
  }
  delete process.env.DSH_FINANCE_DATA_DIR
})

/** 直接调系统 git（仅用于测试断言，显式注入身份以脱离宿主全局配置）。 */
function git(args: string[], cwd: string): string {
  return execFileSync(
    'git',
    ['-c', 'user.name=tester', '-c', 'user.email=tester@localhost', ...args],
    { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  )
}

/** 递归收集目录下全部文件（相对 path 的路径；跳过 .git）。 */
function walkFiles(dir: string): string[] {
  const out: string[] = []
  const rec = (abs: string): void => {
    for (const entry of readdirSync(abs)) {
      if (entry === '.git') continue
      const child = join(abs, entry)
      if (statSync(child).isDirectory()) rec(child)
      else out.push(relative(dir, child))
    }
  }
  rec(dir)
  return out
}

/* ================================================================== *
 * AC1：冷启动种子/预置恰 5 个可进化 SKILL，无 task-authorship
 * ================================================================== */

describe('[AC1] 冷启动只预置 5 个可进化 SKILL，无 task-authorship', () => {
  it('AC1a：loadSkillSeeds() 恰 5 份、name 集合 = 5 可进化、不含 TA，逐字节等同随包种子', () => {
    const seeds = loadSkillSeeds()
    expect(seeds).toHaveLength(5)
    expect(seeds.map((s) => s.name).sort()).toEqual([...EVOLVABLE].sort())
    expect(seeds.map((s) => s.name)).not.toContain(TA)
    expect([...SKILL_NAMES]).toEqual([...EVOLVABLE])

    for (const seed of seeds) {
      // 目录名 / frontmatter.name 一致。
      expect(parseSkillFile(seed.markdown).frontmatter.name).toBe(seed.name)
      // 逐字节等同随包种子（独立读取磁盘对照）。
      const src = readFileSync(join(SRC_DIR, 'skills', seed.name, 'SKILL.md'), 'utf8')
      expect(seed.markdown).toBe(src)
    }
    console.log(
      `[EVIDENCE AC1a] seedNames=${seeds.map((s) => s.name).join(',')} count=${seeds.length} hasTA=${seeds.some((s) => s.name === TA)}`,
    )
  })

  it(
    'AC1b：真实数据目录冷启动预置——产物目录集合恰 5 可进化、递归无 TA、git 仅 1 提交',
    () => {
      const dataRoot = mkTmp('dsh-fin-t100433-cold-')
      const out = ensureSkillAssetsRepo({ dataRoot, logger: () => {} })
      expect(out.provisioned).toBe(true)
      expect(out.degraded).toBe(false)

      const repoDir = out.dir
      expect(repoDir).toBe(resolveSkillsRepoDir(dataRoot))

      // 顶层子目录（排除 .git）= 5 可进化。
      const subDirs = readdirSync(repoDir)
        .filter((e) => e !== '.git' && statSync(join(repoDir, e)).isDirectory())
        .sort()
      expect(subDirs).toEqual([...EVOLVABLE].sort())
      expect(existsSync(join(repoDir, TA))).toBe(false)

      // 递归文件树：不应出现任何含 task-authorship 的路径。
      const tree = walkFiles(repoDir)
      const taPaths = tree.filter((p) => p.split(/[\\/]/).includes(TA))
      expect(taPaths, `预置产物不应含 task-authorship：${taPaths.join('|')}`).toHaveLength(0)

      // SKILL.md 恰 5 个，且每个 frontmatter.name 与目录一致。
      const skillFiles = tree.filter((p) => p.endsWith('/SKILL.md'))
      expect(skillFiles).toHaveLength(5)
      for (const p of skillFiles) {
        const md = readFileSync(join(repoDir, p), 'utf8')
        const dirName = p.split('/').slice(0, -1).join('/')
        expect(parseSkillFile(md).frontmatter.name).toBe(dirName)
      }

      // 真实 git：恰 1 提交，被追踪恰 5 个 SKILL.md 且无 TA，工作区干净。
      expect(existsSync(join(repoDir, '.git'))).toBe(true)
      const commits = git(['log', '--oneline'], repoDir).trim().split('\n').filter(Boolean)
      expect(commits).toHaveLength(1)
      const tracked = git(['ls-files'], repoDir).trim().split('\n').filter(Boolean)
      expect(tracked.filter((f) => f.endsWith('/SKILL.md'))).toHaveLength(5)
      expect(tracked.some((f) => f.startsWith(`${TA}/`))).toBe(false)
      expect(git(['status', '--porcelain'], repoDir).trim()).toBe('')

      console.log(
        `[EVIDENCE AC1b] dirs=${subDirs.join(',')} treeFiles=${tree.length} skillMd=${skillFiles.length} commits=${commits.length} hasTA=false`,
      )
    },
    30_000,
  )

  it(
    'AC1c：幂等——二次预置 no-op，既不产生第二个 commit，也不会补回 TA',
    () => {
      const dataRoot = mkTmp('dsh-fin-t100433-idem-')
      const first = ensureSkillAssetsRepo({ dataRoot, logger: () => {} })
      expect(first.provisioned).toBe(true)

      const second = ensureSkillAssetsRepo({ dataRoot, logger: () => {} })
      expect(second.provisioned).toBe(false)
      expect(second.degraded).toBe(false)

      const repoDir = first.dir
      const commits = git(['log', '--oneline'], repoDir).trim().split('\n').filter(Boolean)
      expect(commits).toHaveLength(1)
      const subDirs = readdirSync(repoDir)
        .filter((e) => e !== '.git' && statSync(join(repoDir, e)).isDirectory())
        .sort()
      expect(subDirs).toEqual([...EVOLVABLE].sort())
      expect(existsSync(join(repoDir, TA))).toBe(false)
      console.log(`[EVIDENCE AC1c] commits=${commits.length} dirs=${subDirs.length} noOp=true`)
    },
    30_000,
  )

  it('AC1d：预置产物与随包种子（src/skills）逐字一致', () => {
    const dataRoot = mkTmp('dsh-fin-t100433-bytes-')
    const out = ensureSkillAssetsRepo({ dataRoot, logger: () => {} })
    for (const n of EVOLVABLE) {
      const seeded = readFileSync(join(out.dir, n, 'SKILL.md'), 'utf8')
      const src = readFileSync(join(SRC_DIR, 'skills', n, 'SKILL.md'), 'utf8')
      expect(seeded).toBe(src)
    }
    console.log(`[EVIDENCE AC1d] byteEqual=${EVOLVABLE.length}/${EVOLVABLE.length}`)
  }, 30_000)
})

/* ================================================================== *
 * AC2：dist-server 仍保留 task-authorship（固有 SKILL 原文）
 * ================================================================== */

describe('[AC2] dist-server 仍保留 task-authorship（产物级）', () => {
  it('AC2a：dist-server/skills 含 6 个 SKILL.md，其中 task-authorship 与 src 逐字一致', () => {
    const distSkillsDir = join(DIST_DIR, 'skills')
    expect(existsSync(distSkillsDir), '需先 pnpm build 产出 dist-server').toBe(true)

    const mdFiles = walkFiles(distSkillsDir).filter((p) => p.endsWith('/SKILL.md'))
    // 5 可进化 + 1 固有 = 6 份随包资源。
    expect(mdFiles.map((p) => p.split('/')[0]).sort()).toEqual(
      [...EVOLVABLE, TA].sort(),
    )

    const distTA = join(distSkillsDir, TA, 'SKILL.md')
    expect(existsSync(distTA), 'dist-server 应保留 task-authorship/SKILL.md').toBe(true)
    expect(readFileSync(distTA, 'utf8')).toBe(
      readFileSync(join(SRC_DIR, 'skills', TA, 'SKILL.md'), 'utf8'),
    )
    console.log(`[EVIDENCE AC2a] distSkillMd=${mdFiles.length} hasDistTA=true`)
  })

  it('AC2b：编译态 dist-server/skills/index.js 能读到固有 SKILL 原文，且 SKILL_NAMES 收窄为 5', async () => {
    const distSkills = (await import('../dist-server/skills/index.js')) as unknown as {
      SKILL_NAMES: readonly string[]
      TASK_AUTHORSHIP_SKILL_NAME: string
      loadTaskAuthorshipMarkdown: () => string
    }

    expect([...distSkills.SKILL_NAMES]).toEqual([...EVOLVABLE])
    expect(distSkills.TASK_AUTHORSHIP_SKILL_NAME).toBe(TA)

    const raw = distSkills.loadTaskAuthorshipMarkdown()
    expect(raw).toBe(readFileSync(join(DIST_DIR, 'skills', TA, 'SKILL.md'), 'utf8'))
    expect(raw).toBe(loadTaskAuthorshipMarkdown())
    expect(parseSkillFile(raw).frontmatter.name).toBe(TA)
    console.log(
      `[EVIDENCE AC2b] distSkillNames=${[...distSkills.SKILL_NAMES].length} distTA=${raw.length}B name=${parseSkillFile(raw).frontmatter.name}`,
    )
  })

  it('AC2c：dist-server 构建产物完整（关键 JS 齐备且可 import）', async () => {
    const required = [
      'index.js',
      'plugin.js',
      'skills/index.js',
      'skills/repo.js',
      'skills/provider.js',
      'skills/frontmatter.js',
      'prompts/index.js',
      'scheduler/index.js',
    ]
    for (const rel of required) {
      expect(existsSync(join(DIST_DIR, rel)), `缺少构建产物 ${rel}`).toBe(true)
    }
    const distIndex = (await import('../dist-server/index.js')) as unknown as {
      name: string
      apply: unknown
    }
    expect(distIndex.name).toBe('investment-advisor')
    expect(typeof distIndex.apply).toBe('function')
    console.log(`[EVIDENCE AC2c] artifacts=${required.length} distName=${distIndex.name}`)
  })
})

/* ================================================================== *
 * AC3：src/** 无「6 个」类计数残留
 * ================================================================== */

describe('[AC3] src/** 计数注释无「6 个」残留', () => {
  /** 5 种写法（与任务卡 grep 模式一致：6 个 / 六个 / 6个 / 6 份 / 6份）。 */
  const PATTERNS = ['6 个', '六个', '6个', '6 份', '6份'] as const

  const scan = (): Array<{ file: string; line: number; text: string }> => {
    const hits: Array<{ file: string; line: number; text: string }> = []
    for (const rel of walkFiles(SRC_DIR)) {
      let content: string
      try {
        content = readFileSync(join(SRC_DIR, rel), 'utf8')
      } catch {
        continue
      }
      const lines = content.split(/\r?\n/)
      lines.forEach((line, i) => {
        if (PATTERNS.some((p) => line.includes(p))) {
          hits.push({ file: rel, line: i + 1, text: line.trim() })
        }
      })
    }
    return hits
  }

  it('AC3a：src/** 全文件扫描 5 种写法 → 零命中', () => {
    const files = walkFiles(SRC_DIR)
    const hits = scan()
    console.log(
      `[EVIDENCE AC3a] srcFiles=${files.length} hits=${hits.length}${
        hits.length ? ' → ' + hits.map((h) => `${h.file}:${h.line}`).join(',') : ''
      }`,
    )
    expect(hits, `src 下不应残留「6 个」类计数：${JSON.stringify(hits)}`).toHaveLength(0)
  })

  it('AC3b（对抗·检测器自检）：含「6 个」的样本必被检出，含「5 个可进化」的样本不误报', () => {
    const detect = (line: string): boolean => PATTERNS.some((p) => line.includes(p))
    // 正样本：旧表述应被抓到（证明 AC3a 的 0 命中非检测器失灵）。
    expect(detect('历史上 6 个技术面 SKILL')).toBe(true)
    expect(detect('六个技术面 SKILL')).toBe(true)
    expect(detect('共 6份 SKILL')).toBe(true)
    // 负样本：新表述不应误报。
    expect(detect('5 个可进化 + 1 个固有')).toBe(false)
    expect(detect('5 个「可进化 SKILL」+ 1 个「固有 SKILL」')).toBe(false)
    console.log('[EVIDENCE AC3b] detectorSelfCheck=ok')
  })

  it('AC3c：被改动的两个注释文件（provider.ts / repo.ts）亦无「6 个」类残留', () => {
    for (const rel of ['skills/provider.ts', 'skills/repo.ts']) {
      const content = readFileSync(join(SRC_DIR, rel), 'utf8')
      expect(PATTERNS.some((p) => content.includes(p)), `${rel} 仍含「6 个」类计数`).toBe(false)
    }
    console.log('[EVIDENCE AC3c] editedComments=clean')
  })
})

/* 说明：AC4（`pnpm typecheck` / `pnpm build` / `pnpm test` 三命令 EXIT=0）由 Tester
 * 在外部独立执行三条命令记录于同名 REPORT.md §三，避免「测试内跑测试」的递归与
 * 资源竞争（vitest 内部再跑 vitest / tsc 会拖垮并行时序）。本文件不重复执行。 */
