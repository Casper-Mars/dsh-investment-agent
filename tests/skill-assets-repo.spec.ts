/**
 * 资产单仓（`<assetsDir>` 唯一 git 仓库）单测 —— assets 单仓接入任务。
 *
 * 覆盖：
 *   ① 全新 assetsDir：外层仓库初始化 + 5 个可进化 SKILL 落盘 + 首次提交包含 5 个
 *      `skills/<name>/SKILL.md`（普通文件，非 gitlink）；
 *   ② 幂等：二次/三次调用 no-op（`provisioned:false`、commit 数不增、内容逐字节不变）；
 *   ③ 不覆盖既有内容：agent 编辑后的 SKILL.md 不被种子回滚；缺文件才补齐；
 *   ④ 降级：skills 路径不可创建 / 种子读取失败 → 降级不抛、不中断；
 *   ⑤ 目录名 / 文件名 / frontmatter.name 三者一致；无 task-authorship；
 *   ⑥ `DSH_IA_HOME` 覆盖联动（env 生效 + 构造注入优先）；
 *   ⑦ 纯计算语义 / 显式作者身份 / 无嵌套 `.git` / `.gitignore` 不排除 skills。
 *
 * 所有用例使用 `os.tmpdir()` 下随机子目录，**不污染**真实 `~/.dsh-ia`。
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SKILL_NAMES, TASK_AUTHORSHIP_SKILL_NAME } from '../src/skills/index.js'
import { parseSkillFile, SKILL_NAME_PATTERN } from '../src/skills/frontmatter.js'
import {
  ensureSkillAssetsRepo,
  loadSkillSeeds,
  resolveSkillsRepoDir,
  SKILL_FILENAME,
  SKILLS_REPO_DIRNAME,
} from '../src/skills/repo.js'
import {
  ASSETS_GITIGNORE,
  commitAssetsChanges,
  ensureAssetsRepo,
  INITIAL_COMMIT_MESSAGE,
  resolveAssetsGitRoot,
} from '../src/assets/repo.js'
import { GIT_IDENTITY_EMAIL, GIT_IDENTITY_NAME } from '../src/assets/git.js'
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

/** 走一次完整冷启动：外层仓库就绪 → 种子落盘 → 首次提交。 */
function coldStart(assetsDir: string): {
  assets: ReturnType<typeof ensureAssetsRepo>
  skills: ReturnType<typeof ensureSkillAssetsRepo>
  commit: ReturnType<typeof commitAssetsChanges>
} {
  const assets = ensureAssetsRepo({ assetsDir, logger: noop })
  const skills = ensureSkillAssetsRepo({ assetsDir, logger: noop })
  const commit = commitAssetsChanges({ dir: assetsDir, logger: noop })
  return { assets, skills, commit }
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
 * ① 全新 assetsDir 冷启动（单仓）
 * ------------------------------------------------------------------ */

describe('① 冷启动（全新 assetsDir，单仓）', () => {
  it('外层仓库 + 5 个可进化 skill + 首次提交包含 5 个 SKILL.md', () => {
    const assetsDir = join(tmp, 'assets')
    const { assets, skills, commit } = coldStart(assetsDir)

    expect(assets.degraded).toBe(false)
    expect(assets.initialized).toBe(true)
    expect(assets.dir).toBe(resolveAssetsGitRoot(assetsDir))

    const repoDir = resolveSkillsRepoDir(assetsDir)
    expect(skills.dir).toBe(repoDir)
    expect(skills.dir).toBe(join(assetsDir, SKILLS_REPO_DIRNAME))
    expect(skills.provisioned).toBe(true)
    expect(skills.degraded).toBe(false)
    expect(commit.committed).toBe(true)

    // 唯一仓库：外层有 .git，skills 下没有嵌套 .git。
    expect(existsSync(join(assetsDir, '.git'))).toBe(true)
    expect(existsSync(join(repoDir, '.git'))).toBe(false)

    // 5 个可进化 skill 齐全，且逐字节等同随包种子（固有 SKILL 不落盘）。
    for (const name of SKILL_NAMES) {
      const file = join(repoDir, name, SKILL_FILENAME)
      expect(existsSync(file), `${name} 缺失`).toBe(true)
      expect(readFileSync(file, 'utf8')).toBe(seedBytes(name))
    }
    expect(existsSync(join(repoDir, TASK_AUTHORSHIP_SKILL_NAME))).toBe(false)

    // 首次提交恰 1 个，message 正确，工作区干净。
    expect(commitCount(assetsDir)).toBe(1)
    expect(lastLog(assetsDir)).toBe(INITIAL_COMMIT_MESSAGE)
    expect(git(['status', '--porcelain'], assetsDir).trim()).toBe('')

    // 提交内容确实包含 5 个 SKILL.md 与 .gitignore。
    const tracked = git(['ls-files'], assetsDir).trim().split('\n').filter(Boolean)
    for (const name of SKILL_NAMES) {
      expect(tracked).toContain(`${SKILLS_REPO_DIRNAME}/${name}/${SKILL_FILENAME}`)
    }
    expect(tracked).toContain('.gitignore')

    // 普通文件（mode 100644），不是 gitlink（160000）。
    const staged = git(['ls-files', '-s', `${SKILLS_REPO_DIRNAME}/${SKILL_NAMES[0]}/${SKILL_FILENAME}`], assetsDir)
    expect(staged.startsWith('100644')).toBe(true)
  })

  it('首次提交的作者/提交者显式注入（不依赖宿主机 git config）', () => {
    const assetsDir = join(tmp, 'assets')
    coldStart(assetsDir)
    expect(git(['log', '-1', '--format=%an <%ae>|%cn <%ce>'], assetsDir).trim()).toBe(
      `${GIT_IDENTITY_NAME} <${GIT_IDENTITY_EMAIL}>|${GIT_IDENTITY_NAME} <${GIT_IDENTITY_EMAIL}>`,
    )
  })

  it('skills 文件是普通文件：git status 中可见，且不被忽略', () => {
    const assetsDir = join(tmp, 'assets')
    coldStart(assetsDir)
    // check-ignore 命中 → 退出码 0（不应发生）；未命中 → 非零退出（期望抛错）。
    expect(() =>
      git(['check-ignore', '-v', '--', `${SKILL_NAMES[0]}/${SKILL_FILENAME}`], assetsDir),
    ).toThrow()
    expect(ASSETS_GITIGNORE).not.toContain('skills/')

    // 删掉一个已提交文件 → status 里能看到 skills 下普通文件的删除。
    rmSync(join(assetsDir, SKILLS_REPO_DIRNAME, SKILL_NAMES[0], SKILL_FILENAME))
    const status = git(['status', '--porcelain'], assetsDir).trim()
    expect(status).toContain(`skills/${SKILL_NAMES[0]}/${SKILL_FILENAME}`)
  })
})

/* ------------------------------------------------------------------ *
 * ② 幂等
 * ------------------------------------------------------------------ */

describe('② 幂等（重复调用 no-op）', () => {
  it('二次/三次调用不重复 init、不产生第二个 commit、内容不变', () => {
    const assetsDir = join(tmp, 'assets')
    const first = coldStart(assetsDir)
    expect(first.skills.provisioned).toBe(true)
    const repoDir = first.skills.dir
    const countBefore = commitCount(assetsDir)
    const before = SKILL_NAMES.map((n) => readFileSync(join(repoDir, n, SKILL_FILENAME), 'utf8'))

    for (let i = 0; i < 2; i += 1) {
      const assets = ensureAssetsRepo({ assetsDir, logger: noop })
      const second = ensureSkillAssetsRepo({ assetsDir, logger: noop })
      const commit = commitAssetsChanges({ dir: assets.dir, logger: noop })

      expect(assets.initialized).toBe(false)
      expect(second.provisioned).toBe(false)
      expect(second.degraded).toBe(false)
      expect(commit.committed).toBe(false)
      expect(commit.degraded).toBe(false)
      expect(commitCount(assetsDir)).toBe(countBefore)
    }

    const after = SKILL_NAMES.map((n) => readFileSync(join(repoDir, n, SKILL_FILENAME), 'utf8'))
    expect(after).toEqual(before)
    expect(git(['status', '--porcelain'], assetsDir).trim()).toBe('')
  })

  it('已就绪仓库即使存在额外未提交改动，ensure* 也不自动提交（严格 no-op）', () => {
    const assetsDir = join(tmp, 'assets')
    coldStart(assetsDir)
    const countBefore = commitCount(assetsDir)
    writeFileSync(join(tmp, 'assets', 'README.tmp.md'), 'stray\n', 'utf8')

    const second = ensureSkillAssetsRepo({ assetsDir, logger: noop })
    expect(second.provisioned).toBe(false)
    expect(commitCount(assetsDir)).toBe(countBefore)
  })
})

/* ------------------------------------------------------------------ *
 * ②b 首次快照边界：仅当仓库尚无 HEAD 时提交
 * ------------------------------------------------------------------ */

describe('②b 首次快照边界（已有 HEAD 时严格 no-op）', () => {
  it('已有 HEAD + 修改 SKILL.md → no-op：不产生新 commit，脏改动原样保留', () => {
    const assetsDir = join(tmp, 'assets')
    const first = coldStart(assetsDir)
    const countBefore = commitCount(assetsDir)
    const rel = `${SKILLS_REPO_DIRNAME}/${SKILL_NAMES[0]}/${SKILL_FILENAME}`
    const target = join(first.skills.dir, SKILL_NAMES[0], SKILL_FILENAME)
    const original = readFileSync(target, 'utf8')
    const edited = `${original}\n<!-- agent edited, pending rationale -->\n`
    writeFileSync(target, edited, 'utf8')

    const out = commitAssetsChanges({ dir: assetsDir, logger: noop })

    // 严格 no-op：未提交、未降级、commit 数不变。
    expect(out.committed).toBe(false)
    expect(out.degraded).toBe(false)
    expect(commitCount(assetsDir)).toBe(countBefore)
    // 工作区脏改动仍在，且未被暂存（首列空格 = 未 staged）。
    expect(git(['status', '--porcelain'], assetsDir)).toContain(` M ${rel}`)
    expect(git(['diff', '--cached', '--name-only'], assetsDir).trim()).toBe('')
    // HEAD 中的内容仍是首次快照原文，磁盘保留 agent 编辑。
    expect(git(['show', `HEAD:${rel}`], assetsDir)).toBe(original)
    expect(readFileSync(target, 'utf8')).toBe(edited)
    // HEAD 仍是首次快照（message 未被 `init:` 冒名覆盖）。
    expect(commitCount(assetsDir)).toBe(1)
    expect(lastLog(assetsDir)).toBe(INITIAL_COMMIT_MESSAGE)
  })

  it('已有 HEAD + 新增未跟踪文件 → no-op：不 add、不 commit，文件仍未跟踪', () => {
    const assetsDir = join(tmp, 'assets')
    coldStart(assetsDir)
    const countBefore = commitCount(assetsDir)
    const stray = join(assetsDir, 'agent-note.md')
    writeFileSync(stray, 'pending evolution\n', 'utf8')

    const out = commitAssetsChanges({ dir: assetsDir, logger: noop })

    expect(out.committed).toBe(false)
    expect(out.degraded).toBe(false)
    expect(commitCount(assetsDir)).toBe(countBefore)
    expect(git(['status', '--porcelain'], assetsDir)).toContain('?? agent-note.md')
    // 未被加入索引：`ls-files --error-unmatch` 应失败。
    expect(() => git(['ls-files', '--error-unmatch', 'agent-note.md'], assetsDir)).toThrow()
    expect(existsSync(stray)).toBe(true)
  })
})

/* ------------------------------------------------------------------ *
 * ③ 不覆盖既有内容 / 缺文件补齐
 * ------------------------------------------------------------------ */

describe('③ 落盘语义：不覆盖已有内容、缺文件才补齐', () => {
  it('agent 编辑后的 SKILL.md 不被种子回滚', () => {
    const assetsDir = join(tmp, 'assets')
    const first = coldStart(assetsDir)
    const target = join(first.skills.dir, SKILL_NAMES[0], SKILL_FILENAME)
    const edited = `${readFileSync(target, 'utf8')}\n<!-- agent edited -->\n`
    writeFileSync(target, edited, 'utf8')

    const second = ensureSkillAssetsRepo({ assetsDir, logger: noop })
    expect(second.provisioned).toBe(false)
    expect(readFileSync(target, 'utf8')).toBe(edited)
  })

  it('缺失的 SKILL.md 会被补齐，其余文件保持不变', () => {
    const assetsDir = join(tmp, 'assets')
    const first = coldStart(assetsDir)
    const [missing, kept] = SKILL_NAMES
    const keptPath = join(first.skills.dir, kept, SKILL_FILENAME)
    const edited = `${readFileSync(keptPath, 'utf8')}\n<!-- keep me -->\n`
    writeFileSync(keptPath, edited, 'utf8')
    rmSync(join(first.skills.dir, missing, SKILL_FILENAME))

    const second = ensureSkillAssetsRepo({ assetsDir, logger: noop })
    expect(second.provisioned).toBe(true)
    expect(readFileSync(join(first.skills.dir, missing, SKILL_FILENAME), 'utf8')).toBe(
      seedBytes(missing),
    )
    expect(readFileSync(keptPath, 'utf8')).toBe(edited)
  })
})

/* ------------------------------------------------------------------ *
 * ④ 降级
 * ------------------------------------------------------------------ */

describe('④ 降级（失败不抛）', () => {
  it('skills 路径被普通文件占位 → 降级不抛、不中断', () => {
    const assetsDir = join(tmp, 'assets')
    mkdirSync(assetsDir, { recursive: true })
    writeFileSync(join(assetsDir, SKILLS_REPO_DIRNAME), 'not a dir', 'utf8')

    const logs: string[] = []
    let out!: ReturnType<typeof ensureSkillAssetsRepo>
    expect(() => {
      out = ensureSkillAssetsRepo({ assetsDir, logger: (m) => logs.push(m) })
    }).not.toThrow()

    expect(out.degraded).toBe(true)
    expect(out.provisioned).toBe(false)
    expect(logs.join('\n')).toMatch(/降级/)
  })

  it('git 不可用时资产仓库降级，但 skill 种子仍可落盘（内容可读）', () => {
    const assetsDir = join(tmp, 'assets')
    const failing = (): string => {
      throw new Error('spawn git ENOENT')
    }
    const assets = ensureAssetsRepo({ assetsDir, gitRunner: failing, logger: noop })
    expect(assets.degraded).toBe(true)
    expect(assets.initialized).toBe(false)

    const skills = ensureSkillAssetsRepo({ assetsDir, logger: noop })
    expect(skills.degraded).toBe(false)
    expect(skills.provisioned).toBe(true)
    expect(existsSync(join(skills.dir, SKILL_NAMES[0], SKILL_FILENAME))).toBe(true)
  })

  it('commit 阶段失败 → commitAssetsChanges 降级不抛，无提交', () => {
    const assetsDir = join(tmp, 'assets')
    ensureAssetsRepo({ assetsDir, logger: noop })
    ensureSkillAssetsRepo({ assetsDir, logger: noop })

    const partial = (args: string[], cwd: string): string => {
      if (args[0] === 'commit') throw new Error('commit failed: exit status 1')
      return git(args, cwd)
    }
    let out!: ReturnType<typeof commitAssetsChanges>
    expect(() => {
      out = commitAssetsChanges({ dir: assetsDir, gitRunner: partial, logger: noop })
    }).not.toThrow()

    expect(out.degraded).toBe(true)
    expect(out.committed).toBe(false)
    expect(commitCount(assetsDir)).toBe(0)
  })
})

/* ------------------------------------------------------------------ *
 * ⑤ 一致性
 * ------------------------------------------------------------------ */

describe('⑤ 目录名 / 文件名 / frontmatter.name 三者一致', () => {
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
    const { skills } = coldStart(assetsDir)
    for (const name of SKILL_NAMES) {
      const file = join(skills.dir, name, SKILL_FILENAME)
      expect(existsSync(file)).toBe(true)
      const parsed = parseSkillFile(readFileSync(file, 'utf8'))
      expect(parsed.frontmatter.name).toBe(name)
      expect(file.endsWith(`${name}/${SKILL_FILENAME}`)).toBe(true)
    }
  })
})

/* ------------------------------------------------------------------ *
 * ⑥ DSH_IA_HOME 联动
 * ------------------------------------------------------------------ */

describe('⑥ 与 DSH_IA_HOME 覆盖联动', () => {
  it('env 覆盖 home：落在 <home>/assets/skills', () => {
    const envHome = join(tmp, 'env-home')
    process.env[FINANCE_HOME_ENV] = envHome

    const assets = ensureAssetsRepo({ logger: noop })
    const out = ensureSkillAssetsRepo({ logger: noop })
    expect(assets.dir).toBe(join(envHome, 'assets'))
    expect(out.dir).toBe(resolveSkillsRepoDir(join(envHome, 'assets')))
    expect(out.provisioned).toBe(true)
    expect(existsSync(join(out.dir, 'trend-analysis', SKILL_FILENAME))).toBe(true)
  })

  it('构造注入 assetsDir 优先于 env', () => {
    const envHome = join(tmp, 'env-home')
    const injected = join(tmp, 'injected-assets')
    process.env[FINANCE_HOME_ENV] = envHome

    const assets = ensureAssetsRepo({ assetsDir: injected, logger: noop })
    const out = ensureSkillAssetsRepo({ assetsDir: injected, logger: noop })
    expect(assets.dir).toBe(injected)
    expect(out.dir).toBe(resolveSkillsRepoDir(injected))
    expect(existsSync(resolveSkillsRepoDir(join(envHome, 'assets')))).toBe(false)
  })
})

/* ------------------------------------------------------------------ *
 * ⑦ 纯计算 / 旧路径护栏 / 历史 gitignore 升级
 * ------------------------------------------------------------------ */

describe('⑦ 纯计算语义 + 路径护栏 + .gitignore 升级', () => {
  it('resolveSkillsRepoDir / resolveAssetsGitRoot 纯计算：无副作用', () => {
    const assetsDir = join(tmp, 'pure')
    expect(resolveSkillsRepoDir(assetsDir)).toBe(join(assetsDir, 'skills'))
    expect(resolveAssetsGitRoot(assetsDir)).toBe(assetsDir)
    expect(existsSync(assetsDir)).toBe(false)
  })

  it('不产生旧路径：<assetsDir 的父目录> 下不存在 data/skills', () => {
    const assetsDir = join(tmp, 'assets')
    const out = ensureSkillAssetsRepo({ assetsDir, logger: noop })
    expect(out.dir).toBe(join(assetsDir, 'skills'))
    expect(existsSync(join(tmp, 'data', 'skills'))).toBe(false)
    expect(existsSync(join(tmp, 'data'))).toBe(false)
  })

  it('历史 .gitignore 中的 `skills/` 排除规则被就地升级移除', () => {
    const assetsDir = join(tmp, 'assets')
    mkdirSync(assetsDir, { recursive: true })
    writeFileSync(
      join(assetsDir, '.gitignore'),
      '# 嵌套独立 git 仓库：skills 有自己的历史，不纳入外层仓库\nskills/\n.DS_Store\n*.tmp\n',
      'utf8',
    )

    const assets = ensureAssetsRepo({ assetsDir, logger: noop })
    expect(assets.degraded).toBe(false)
    const content = readFileSync(join(assetsDir, '.gitignore'), 'utf8')
    expect(content).toBe(ASSETS_GITIGNORE)
    expect(content).not.toMatch(/^skills\/$/m)
  })

  it('已有 .git 时 ensureAssetsRepo no-op（不重复 init）', () => {
    const assetsDir = join(tmp, 'assets')
    const first = ensureAssetsRepo({ assetsDir, logger: noop })
    expect(first.initialized).toBe(true)
    const second = ensureAssetsRepo({ assetsDir, logger: noop })
    expect(second.initialized).toBe(false)
    expect(second.degraded).toBe(false)
  })
})
