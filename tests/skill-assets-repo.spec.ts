/**
 * skill 资产仓库（`<assetsDir>/skills` 独立 git 仓库）单测 —— 任务-1 / 任务-2（资产层迁移）。
 *
 * 覆盖：
 *   ① 全新 assetsDir 冷启动 → 目录 / git 仓库 / 5 个可进化 skill / 首版 commit 齐备；
 *   ② 幂等：二次调用 no-op（commit 数不增、内容逐字节不变）；
 *   ③ git 不可用 / 命令失败 → 降级不抛、不中断；
 *   ④ 目录名 / 文件名 / frontmatter.name 三者一致；
 *   ⑤ 与 `DSH_IA_HOME` 覆盖联动（env 生效 + 构造注入优先）；
 *   ⑥ assetsDir 纯计算语义 / 显式作者身份 / 不写旧路径。
 *
 * 所有用例使用 `os.tmpdir()` 下随机子目录，**不污染**真实 `~/.dsh-ia`。
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SKILL_NAMES } from '../src/skills/index.js'
import { parseSkillFile, SKILL_NAME_PATTERN } from '../src/skills/frontmatter.js'
import {
  ensureSkillAssetsRepo,
  loadSkillSeeds,
  resolveSkillsRepoDir,
  INITIAL_COMMIT_MESSAGE,
  SKILL_FILENAME,
  SKILLS_REPO_DIRNAME,
  type GitRunner,
} from '../src/skills/repo.js'
import { FINANCE_HOME_ENV } from '../src/flags.js'

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))

/** 静默 logger。 */
const noop = (): void => {}

/** 直接调系统 git（仅用于测试断言，不带身份）。 */
function git(args: string[], cwd: string): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

/** 提交数（无 HEAD 时返回 0）。 */
function commitCount(repoDir: string): number {
  try {
    return Number(git(['rev-list', '--count', 'HEAD'], repoDir).trim())
  } catch {
    return 0
  }
}

/** 最近一次提交的 subject。 */
function lastLog(repoDir: string): string {
  return git(['log', '-1', '--pretty=%s'], repoDir).trim()
}

/** 随包发布的首版种子原文（源态 `src/skills/<name>/SKILL.md`）。 */
function seedBytes(name: string): string {
  return readFileSync(join(REPO_ROOT, 'src', 'skills', name, SKILL_FILENAME), 'utf8')
}

/** 确认系统 git 可用（各用例依赖）。 */
function assertGitAvailable(): void {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' })
  } catch {
    throw new Error('本测试需要系统 git 可用（PATH 中找不到 git）')
  }
}

let tmp: string
const savedEnv = process.env[FINANCE_HOME_ENV]

beforeEach(() => {
  assertGitAvailable()
  tmp = mkdtempSync(join(tmpdir(), 'dsh-ia-skills-'))
})

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true })
  if (savedEnv === undefined) delete process.env[FINANCE_HOME_ENV]
  else process.env[FINANCE_HOME_ENV] = savedEnv
})

/* ------------------------------------------------------------------ *
 * ① 全新 assetsDir 冷启动
 * ------------------------------------------------------------------ */

describe('① 冷启动预置（全新 assetsDir）', () => {
  it('创建目录 + git 仓库 + 5 个可进化 skill + 首版 commit', () => {
    const assetsDir = join(tmp, 'assets')
    const logs: string[] = []
    const out = ensureSkillAssetsRepo({ assetsDir, logger: (m) => logs.push(m) })

    const repoDir = resolveSkillsRepoDir(assetsDir)
    expect(out.dir).toBe(repoDir)
    expect(out.dir).toBe(join(assetsDir, SKILLS_REPO_DIRNAME))
    expect(out.provisioned).toBe(true)
    expect(out.degraded).toBe(false)

    // git 仓库就绪。
    expect(existsSync(join(repoDir, '.git'))).toBe(true)

    // 5 个可进化 skill 齐全，且逐字节等同随包种子。
    // （固有 SKILL task-authorship 不落盘，见 src/skills/index.ts 分野。）
    for (const name of SKILL_NAMES) {
      const file = join(repoDir, name, SKILL_FILENAME)
      expect(existsSync(file), `${name} 缺失`).toBe(true)
      expect(readFileSync(file, 'utf8')).toBe(seedBytes(name))
    }

    // 首版 commit：恰好 1 个，message 正确，工作区干净。
    expect(commitCount(repoDir)).toBe(1)
    expect(lastLog(repoDir)).toBe(INITIAL_COMMIT_MESSAGE)
    expect(git(['status', '--porcelain'], repoDir).trim()).toBe('')
  })

  it('预置日志包含仓库路径与 message', () => {
    const assetsDir = join(tmp, 'assets')
    const logs: string[] = []
    ensureSkillAssetsRepo({ assetsDir, logger: (m) => logs.push(m) })
    const joined = logs.join('\n')
    expect(joined).toMatch(/冷启动预置完成/)
    expect(joined).toContain(INITIAL_COMMIT_MESSAGE)
  })
})

/* ------------------------------------------------------------------ *
 * ② 幂等
 * ------------------------------------------------------------------ */

describe('② 幂等（重复调用 no-op）', () => {
  it('二次/三次调用不重复 init、不产生第二个 commit、内容不变', () => {
    const assetsDir = join(tmp, 'assets')
    const first = ensureSkillAssetsRepo({ assetsDir, logger: noop })
    expect(first.provisioned).toBe(true)
    const repoDir = first.dir
    const countBefore = commitCount(repoDir)
    const before = SKILL_NAMES.map((n) => readFileSync(join(repoDir, n, SKILL_FILENAME), 'utf8'))

    const second = ensureSkillAssetsRepo({ assetsDir, logger: noop })
    expect(second.provisioned).toBe(false)
    expect(second.degraded).toBe(false)
    expect(commitCount(repoDir)).toBe(countBefore)

    const third = ensureSkillAssetsRepo({ assetsDir, logger: noop })
    expect(third.provisioned).toBe(false)
    expect(commitCount(repoDir)).toBe(countBefore)

    const after = SKILL_NAMES.map((n) => readFileSync(join(repoDir, n, SKILL_FILENAME), 'utf8'))
    expect(after).toEqual(before)
  })

  it('已就绪仓库即使存在额外未提交改动也不自动提交（严格 no-op）', () => {
    const assetsDir = join(tmp, 'assets')
    const first = ensureSkillAssetsRepo({ assetsDir, logger: noop })
    const repoDir = first.dir
    const countBefore = commitCount(repoDir)
    // 制造一个未提交改动：no-op 语义下不应被本模块提交。
    writeFileSync(join(repoDir, 'README.tmp.md'), 'stray\n', 'utf8')

    const second = ensureSkillAssetsRepo({ assetsDir, logger: noop })
    expect(second.provisioned).toBe(false)
    expect(commitCount(repoDir)).toBe(countBefore)
  })
})

/* ------------------------------------------------------------------ *
 * ③ 降级
 * ------------------------------------------------------------------ */

describe('③ 降级（git 不可用 / 命令失败不抛）', () => {
  it('git 可执行文件缺失（runner 抛错）→ 降级不抛、不中断', () => {
    const assetsDir = join(tmp, 'assets')
    const logs: string[] = []
    const failing: GitRunner = () => {
      throw new Error('spawn git ENOENT')
    }

    let out!: ReturnType<typeof ensureSkillAssetsRepo>
    expect(() => {
      out = ensureSkillAssetsRepo({ assetsDir, gitRunner: failing, logger: (m) => logs.push(m) })
    }).not.toThrow()

    expect(out.degraded).toBe(true)
    expect(out.provisioned).toBe(false)
    expect(logs.join('\n')).toMatch(/降级/)
    // 未产生 git 仓库（init 失败）。
    expect(existsSync(join(out.dir, '.git'))).toBe(false)
  })

  it('git 命令非零退出（commit 阶段失败）→ 降级不抛、不中断', () => {
    const assetsDir = join(tmp, 'assets')
    const partial: GitRunner = (args, cwd) => {
      if (args[0] === 'commit') throw new Error('commit failed: exit status 1')
      return git(args, cwd)
    }

    let out!: ReturnType<typeof ensureSkillAssetsRepo>
    expect(() => {
      out = ensureSkillAssetsRepo({ assetsDir, gitRunner: partial, logger: noop })
    }).not.toThrow()

    expect(out.degraded).toBe(true)
    expect(out.provisioned).toBe(false)
    // 无提交历史。
    expect(commitCount(out.dir)).toBe(0)
  })
})

/* ------------------------------------------------------------------ *
 * ④ 一致性
 * ------------------------------------------------------------------ */

describe('④ 目录名 / 文件名 / frontmatter.name 三者一致', () => {
  it('种子：恰 5 个、kebab-case、目录名 = frontmatter.name、正文非空', () => {
    const seeds = loadSkillSeeds()
    expect(seeds).toHaveLength(5)
    expect(seeds.map((s) => s.name)).toEqual([...SKILL_NAMES])
    for (const { name, markdown } of seeds) {
      expect(SKILL_NAME_PATTERN.test(name)).toBe(true)
      const parsed = parseSkillFile(markdown)
      expect(parsed.frontmatter.name).toBe(name)
      expect(parsed.frontmatter.description.length).toBeGreaterThan(0)
      expect(parsed.content.trim().length).toBeGreaterThan(0)
    }
  })

  it('落盘后：目录名 = 文件名 SKILL.md = frontmatter.name', () => {
    const assetsDir = join(tmp, 'assets')
    const out = ensureSkillAssetsRepo({ assetsDir, logger: noop })
    for (const name of SKILL_NAMES) {
      const file = join(out.dir, name, SKILL_FILENAME)
      expect(existsSync(file)).toBe(true)
      const parsed = parseSkillFile(readFileSync(file, 'utf8'))
      expect(parsed.frontmatter.name).toBe(name)
      // 文件名固定为 SKILL.md。
      expect(file.endsWith(`/${name}/${SKILL_FILENAME}`)).toBe(true)
    }
  })
})

/* ------------------------------------------------------------------ *
 * ⑤ DSH_IA_HOME 联动（资产层由 home 派生）
 * ------------------------------------------------------------------ */

describe('⑤ 与 DSH_IA_HOME 覆盖联动', () => {
  it('env 覆盖 home：仓库落在 <home>/assets/skills', () => {
    const envHome = join(tmp, 'env-home')
    const envAssets = join(envHome, 'assets')
    process.env[FINANCE_HOME_ENV] = envHome

    const out = ensureSkillAssetsRepo({ logger: noop })
    expect(out.dir).toBe(resolveSkillsRepoDir(envAssets))
    expect(out.provisioned).toBe(true)
    expect(existsSync(join(out.dir, 'trend-analysis', SKILL_FILENAME))).toBe(true)
  })

  it('构造注入 assetsDir 优先于 env', () => {
    const envHome = join(tmp, 'env-home')
    const injected = join(tmp, 'injected-assets')
    process.env[FINANCE_HOME_ENV] = envHome

    const out = ensureSkillAssetsRepo({ assetsDir: injected, logger: noop })
    expect(out.dir).toBe(resolveSkillsRepoDir(injected))
    expect(existsSync(resolveSkillsRepoDir(join(envHome, 'assets')))).toBe(false)
  })
})

/* ------------------------------------------------------------------ *
 * ⑥ assetsDir 语义 / 作者身份 / 不写旧路径
 * ------------------------------------------------------------------ */

describe('⑥ assetsDir 纯计算语义 + 显式作者身份 + 不产生旧路径', () => {
  it('resolveSkillsRepoDir 纯计算：等于 <assetsDir>/skills，且无副作用', () => {
    const assetsDir = join(tmp, 'pure')
    expect(resolveSkillsRepoDir(assetsDir)).toBe(join(assetsDir, 'skills'))
    // 纯计算：不创建目录。
    expect(existsSync(assetsDir)).toBe(false)
  })

  it('首版 commit 作者显式注入为 dsh-ia <dsh-ia@localhost>（不依赖宿主机 git config）', () => {
    const assetsDir = join(tmp, 'assets')
    const out = ensureSkillAssetsRepo({ assetsDir, logger: noop })
    expect(out.provisioned).toBe(true)
    expect(git(['log', '-1', '--format=%an <%ae>'], out.dir).trim()).toBe('dsh-ia <dsh-ia@localhost>')
  })

  it('幂等：连续两次 provisioned=false 且 commit 数不变', () => {
    const assetsDir = join(tmp, 'assets')
    expect(ensureSkillAssetsRepo({ assetsDir, logger: noop }).provisioned).toBe(true)
    const repoDir = resolveSkillsRepoDir(assetsDir)
    const count = commitCount(repoDir)
    expect(commitCount(repoDir)).toBe(1)
    expect(ensureSkillAssetsRepo({ assetsDir, logger: noop }).provisioned).toBe(false)
    expect(ensureSkillAssetsRepo({ assetsDir, logger: noop }).provisioned).toBe(false)
    expect(commitCount(repoDir)).toBe(count)
  })

  it('不产生旧路径：<assetsDir 的父目录> 下不存在 data/skills（无回落写旧位置）', () => {
    const assetsDir = join(tmp, 'assets')
    const out = ensureSkillAssetsRepo({ assetsDir, logger: noop })
    expect(out.dir).toBe(join(assetsDir, 'skills'))
    expect(existsSync(join(tmp, 'data', 'skills'))).toBe(false)
    expect(existsSync(join(tmp, 'data'))).toBe(false)
  })
})

/* ------------------------------------------------------------------ *
 * 边界：「为空」判定的稳健性
 * ------------------------------------------------------------------ */

describe('「为空」判定稳健性', () => {
  it('有 .git 但无提交 → 需预置并产生首版 commit（不重复）', () => {
    const assetsDir = join(tmp, 'assets')
    const repoDir = resolveSkillsRepoDir(assetsDir)
    mkdirSync(repoDir, { recursive: true })
    git(['init'], repoDir)
    for (const name of SKILL_NAMES) {
      mkdirSync(join(repoDir, name), { recursive: true })
      writeFileSync(join(repoDir, name, SKILL_FILENAME), seedBytes(name), 'utf8')
    }

    const out = ensureSkillAssetsRepo({ assetsDir, logger: noop })
    expect(out.provisioned).toBe(true)
    expect(out.degraded).toBe(false)
    expect(commitCount(repoDir)).toBe(1)
    for (const name of SKILL_NAMES) {
      expect(readFileSync(join(repoDir, name, SKILL_FILENAME), 'utf8')).toBe(seedBytes(name))
    }

    // 再次调用 no-op，不产生第二个 commit。
    expect(ensureSkillAssetsRepo({ assetsDir, logger: noop }).provisioned).toBe(false)
    expect(commitCount(repoDir)).toBe(1)
  })

  it('仅有空目录（无 skill 内容）→ 需预置', () => {
    const assetsDir = join(tmp, 'assets')
    const repoDir = resolveSkillsRepoDir(assetsDir)
    mkdirSync(join(repoDir, 'stray-empty'), { recursive: true })

    const out = ensureSkillAssetsRepo({ assetsDir, logger: noop })
    expect(out.provisioned).toBe(true)
    expect(commitCount(out.dir)).toBe(1)
  })

  it('已 git init 但仅有空目录（无 skill 内容）→ 需预置', () => {
    const assetsDir = join(tmp, 'assets')
    const repoDir = resolveSkillsRepoDir(assetsDir)
    mkdirSync(join(repoDir, 'stray-empty'), { recursive: true })
    git(['init'], repoDir)

    const out = ensureSkillAssetsRepo({ assetsDir, logger: noop })
    expect(out.provisioned).toBe(true)
    expect(commitCount(out.dir)).toBe(1)
  })

  it('仓库内 .gitignore 不忽略 skill 内容', () => {
    const assetsDir = join(tmp, 'assets')
    const out = ensureSkillAssetsRepo({ assetsDir, logger: noop })
    // `git check-ignore` 命中时退出码 0 并输出规则；未命中退出码 1 → 抛错。
    // skill 内容不应被忽略 → 期望抛错。
    expect(() =>
      git(['check-ignore', '-v', '--', 'trend-analysis/SKILL.md'], out.dir),
    ).toThrow()
  })
})
