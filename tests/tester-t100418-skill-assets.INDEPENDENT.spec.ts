/**
 * tester-t100418-skill-assets.INDEPENDENT.spec.ts
 *
 * 任务 t100418 独立验证（对抗 / 边界导向）：
 *   skill 资产落在资产层目录 `<assetsDir>/skills`，且**不再**是独立 git 仓库 ——
 *   `<assetsDir>/.git` 是唯一仓库，skills 只是普通目录。
 *
 * 与 Developer 的 `tests/skill-assets-repo.spec.ts` **独立编写**，不比对自述数字：
 *   ① 独立 mock 断言：注入自定义 `gitRunner` 观察调用序列（init 仅 1 次；提交仅 1 次；
 *      已就绪 → 不再 init / 不再 commit）；
 *   ② 真实进程 / 真实 git E2E：临时 assetsDir 真跑单仓冷启动，验「外层 .git + 无嵌套 .git」
 *      / git log 恰 1 条 / status 干净 / 5 个可进化 skill 与种子逐字节一致；
 *      二次调用 commit 数不变；**编译态 E2E**（dist-server 产物独立 node 进程）；
 *   ③ 降级独立验证：git 不可用 / commit 阶段失败 / 路径不可创建（无写权限等价） /
 *      种子读取异常（mock）→ 均不抛、返回 degraded；
 *   ④ 一致性：落盘 5 个可进化 SKILL.md 用 frontmatter.ts 解析，目录名 ===
 *      frontmatter.name === 期望名；固有 SKILL task-authorship 不落盘；
 *   ⑤ 空 / 半初始化判定：缺失 / 无 .git / 有 .git 无提交 / 仅空目录 / 种子已存在
 *      → 均能就绪且首次提交包含 5 个 SKILL.md；
 *   ⑥ 路径护栏：不污染真实 `~/.dsh-ia`，assetsDir 优先级注入 > env（DSH_IA_HOME）> 默认；
 *   ⑦ 插件装配：`apply` 在最小上下文 + env 指向临时目录时不抛、并落盘到临时目录。
 *
 * 所有用例使用 `os.tmpdir()` 随机子目录，**不触碰**真实 `~/.dsh-ia`。
 */
import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import {
  SKILL_NAMES,
  TASK_AUTHORSHIP_SKILL_NAME,
  SKILL_AUTHORSHIP_SKILL_NAME,
  FINANCE_EVOLUTION_SKILL_NAME,
} from '../src/skills/index.js'
import { parseSkillFile, SKILL_NAME_PATTERN } from '../src/skills/frontmatter.js'
import {
  ensureSkillAssetsRepo,
  loadSkillSeeds,
  resolveSkillsRepoDir,
  SKILL_FILENAME,
  SKILLS_REPO_DIRNAME,
} from '../src/skills/repo.js'
import {
  commitAssetsChanges,
  ensureAssetsRepo,
  INITIAL_COMMIT_MESSAGE,
} from '../src/assets/repo.js'
import { GIT_IDENTITY_EMAIL, GIT_IDENTITY_NAME } from '../src/assets/git.js'
import { FINANCE_HOME_ENV } from '../src/flags.js'
import { apply } from '../src/plugin.js'

/* ------------------------------------------------------------------ *
 * 注入式「种子读取失败」开关（mock ./index.js 的 loadSkillMarkdown）。
 * 仅在 ③-4 用例中翻转，其余用例保持 false，行为与真实模块一致。
 * ------------------------------------------------------------------ */
const mockState = vi.hoisted(() => ({ seedFailure: false }))
vi.mock('../src/skills/index.js', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  const real = actual.loadSkillMarkdown as (name: unknown) => string
  return {
    ...actual,
    loadSkillMarkdown: (name: unknown): string => {
      if (mockState.seedFailure) throw new Error('注入：模拟种子读取失败')
      return real(name)
    },
  }
})

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))
const noop = (): void => {}

/** 直接调系统 git（显式注入身份，供测试断言；不依赖宿主机 git config）。 */
function git(args: string[], cwd: string): string {
  return execFileSync(
    'git',
    ['-c', `user.name=${GIT_IDENTITY_NAME}`, '-c', `user.email=${GIT_IDENTITY_EMAIL}`, ...args],
    { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  )
}

/** 提交数（无 HEAD → 0）。 */
function commitCount(repoDir: string): number {
  try {
    return Number(git(['rev-list', '--count', 'HEAD'], repoDir).trim())
  } catch {
    return 0
  }
}

/** 随包发布的首版种子原文（源码态 `src/skills/<name>/SKILL.md`）。 */
function seedBytes(name: string): string {
  return readFileSync(join(REPO_ROOT, 'src', 'skills', name, SKILL_FILENAME), 'utf8')
}

/** 编译态种子原文（`dist-server/skills/<name>/SKILL.md`）。 */
function distSeedBytes(name: string): string {
  return readFileSync(join(REPO_ROOT, 'dist-server', 'skills', name, SKILL_FILENAME), 'utf8')
}

/** 记录调用序列的 gitRunner（真实委派系统 git）。 */
function recordingRunner(): { runner: (args: string[], cwd: string) => string; calls: string[] } {
  const calls: string[] = []
  const runner = (args: string[], cwd: string): string => {
    calls.push(args.join(' '))
    return git(args, cwd)
  }
  return { runner, calls }
}

/** 单仓冷启动：外层仓库就绪 → 种子落盘 → 首次提交。 */
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

function assertGitAvailable(): void {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' })
  } catch {
    throw new Error('本测试需要系统 git 可用（PATH 中找不到 git）')
  }
}

let tmp: string
const savedEnv = process.env[FINANCE_HOME_ENV]
const REAL_ASSETS_DIR = join(process.env.HOME ?? '', '.dsh-ia', 'assets')
let realAssetsExistedAtStart = false

beforeEach(() => {
  assertGitAvailable()
  tmp = mkdtempSync(join(tmpdir(), 'dsh-ia-t100418-'))
  realAssetsExistedAtStart = existsSync(REAL_ASSETS_DIR)
})

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true })
  if (savedEnv === undefined) delete process.env[FINANCE_HOME_ENV]
  else process.env[FINANCE_HOME_ENV] = savedEnv
})

/* ================================================================== *
 * ① 独立 mock 断言：调用序列
 * ================================================================== */
describe('① 调用序列（注入 gitRunner 观察）', () => {
  it('全新目录 → init 恰 1 次；提交阶段 add -A + commit 恰 1 次', () => {
    const assetsDir = join(tmp, 'assets')
    const init = recordingRunner()
    const assets = ensureAssetsRepo({ assetsDir, gitRunner: init.runner, logger: noop })
    expect(assets.initialized).toBe(true)
    expect(init.calls.filter((c) => c.startsWith('init')).length).toBe(1)
    // 就绪阶段不产生提交。
    expect(init.calls.some((c) => c.startsWith('commit'))).toBe(false)

    const skills = ensureSkillAssetsRepo({ assetsDir, logger: noop })
    expect(skills.provisioned).toBe(true)

    const commitRun = recordingRunner()
    const commit = commitAssetsChanges({ dir: assetsDir, gitRunner: commitRun.runner, logger: noop })
    expect(commit.committed).toBe(true)
    expect(commitRun.calls).toContain('add -A')
    expect(commitRun.calls.filter((c) => c.startsWith('commit')).length).toBe(1)
  })

  it('init -b main 不被支持时回落到普通 git init，且仍只 commit 一次', () => {
    const assetsDir = join(tmp, 'assets')
    const calls: string[] = []
    const runner = (args: string[], cwd: string): string => {
      calls.push(args.join(' '))
      if (args[0] === 'init' && args[1] === '-b') throw new Error('unknown switch `b`')
      return git(args, cwd)
    }

    const assets = ensureAssetsRepo({ assetsDir, gitRunner: runner, logger: noop })
    expect(assets.initialized).toBe(true)
    expect(calls).toContain('init -b main')
    expect(calls).toContain('init') // 回落

    ensureSkillAssetsRepo({ assetsDir, logger: noop })
    commitAssetsChanges({ dir: assetsDir, gitRunner: runner, logger: noop })
    expect(calls.filter((c) => c.startsWith('commit')).length).toBe(1)
  })

  it('已就绪仓库（已有 HEAD）→ no-op：不再 init、不 add、不 commit', () => {
    const assetsDir = join(tmp, 'assets')
    coldStart(assetsDir)

    const init = recordingRunner()
    const second = ensureAssetsRepo({ assetsDir, gitRunner: init.runner, logger: noop })
    expect(second.initialized).toBe(false)
    expect(init.calls.some((c) => c.startsWith('init'))).toBe(false)

    const commitRun = recordingRunner()
    const commit = commitAssetsChanges({ dir: assetsDir, gitRunner: commitRun.runner, logger: noop })
    expect(commit.committed).toBe(false)
    expect(commit.degraded).toBe(false)
    // 已有 HEAD → 严格 no-op：连 add 都不执行（否则会暂存工作区脏改动）。
    expect(commitRun.calls.some((c) => c.startsWith('add'))).toBe(false)
    expect(commitRun.calls.some((c) => c.startsWith('commit'))).toBe(false)
  })
})

/* ================================================================== *
 * ② 真实 git E2E
 * ================================================================== */
describe('② 真实 git E2E（临时 assetsDir）', () => {
  it('冷启动：单仓 / 5 个可进化 skill / git log 恰 1 条 / status 干净 / 逐字节一致', () => {
    const assetsDir = join(tmp, 'assets')
    const { assets, skills, commit } = coldStart(assetsDir)
    const repoDir = skills.dir

    expect(repoDir).toBe(resolveSkillsRepoDir(assetsDir))
    expect(repoDir).toBe(join(assetsDir, SKILLS_REPO_DIRNAME))
    expect(skills.provisioned).toBe(true)
    expect(skills.degraded).toBe(false)
    expect(commit.committed).toBe(true)

    // 唯一仓库在外层；skills 下无嵌套 .git。
    expect(assets.dir).toBe(assetsDir)
    expect(existsSync(join(assetsDir, '.git'))).toBe(true)
    expect(existsSync(join(repoDir, '.git'))).toBe(false)

    // 落盘集合 = SKILL_NAMES，无多余目录。
    const entries = readdirSync(repoDir)
    expect([...entries].sort()).toEqual([...SKILL_NAMES].sort())

    // 5 个可进化 skill 逐字节 = 源码种子 = 编译态种子（固有 SKILL 不落盘）。
    for (const name of SKILL_NAMES) {
      const file = join(repoDir, name, SKILL_FILENAME)
      expect(existsSync(file), `${name} 缺失`).toBe(true)
      expect(readFileSync(file, 'utf8'), `${name} vs src seed`).toBe(seedBytes(name))
      expect(readFileSync(file, 'utf8'), `${name} vs dist seed`).toBe(distSeedBytes(name))
    }

    // git log 恰 1 条；message 正确；分支 main；工作区干净。
    const onelog = git(['log', '--oneline'], assetsDir).trim().split('\n').filter(Boolean)
    expect(onelog).toHaveLength(1)
    expect(commitCount(assetsDir)).toBe(1)
    expect(git(['log', '-1', '--pretty=%s'], assetsDir).trim()).toBe(INITIAL_COMMIT_MESSAGE)
    expect(git(['rev-parse', '--abbrev-ref', 'HEAD'], assetsDir).trim()).toBe('main')
    expect(git(['status', '--porcelain'], assetsDir).trim()).toBe('')

    // 被跟踪：5 个 SKILL.md 普通文件（100644），非 gitlink（160000）。
    const tracked = git(['ls-files'], assetsDir).trim().split('\n').filter(Boolean)
    expect(tracked.filter((f) => f.endsWith('/SKILL.md'))).toHaveLength(5)
    const mode = git(['ls-files', '-s', `skills/${SKILL_NAMES[0]}/${SKILL_FILENAME}`], assetsDir)
    expect(mode.startsWith('100644')).toBe(true)
  })

  it('幂等：二次 / 三次调用 commit 数不增、内容逐字节不变、status 仍干净', () => {
    const assetsDir = join(tmp, 'assets')
    const first = coldStart(assetsDir)
    const repoDir = first.skills.dir
    const before = SKILL_NAMES.map((n) => readFileSync(join(repoDir, n, SKILL_FILENAME), 'utf8'))
    const count = commitCount(assetsDir)

    for (let i = 0; i < 2; i += 1) {
      const assets = ensureAssetsRepo({ assetsDir, logger: noop })
      const again = ensureSkillAssetsRepo({ assetsDir, logger: noop })
      const commit = commitAssetsChanges({ dir: assets.dir, logger: noop })
      expect(assets.initialized).toBe(false)
      expect(again.provisioned).toBe(false)
      expect(again.degraded).toBe(false)
      expect(commit.committed).toBe(false)
    }

    expect(commitCount(assetsDir)).toBe(count)
    const after = SKILL_NAMES.map((n) => readFileSync(join(repoDir, n, SKILL_FILENAME), 'utf8'))
    expect(after).toEqual(before)
    expect(git(['status', '--porcelain'], assetsDir).trim()).toBe('')
  })

  it('编译态 E2E：独立 node 进程走 dist-server 产物落盘，种子可读、逐字节一致', () => {
    const distAssetsRepo = join(REPO_ROOT, 'dist-server', 'assets', 'repo.js')
    const distSkillsRepo = join(REPO_ROOT, 'dist-server', 'skills', 'repo.js')
    if (!existsSync(distAssetsRepo) || !existsSync(distSkillsRepo)) {
      throw new Error('需先执行 `pnpm build`（dist-server/{assets,skills}/repo.js 缺失）')
    }
    const assetsDir = join(tmp, 'dist-assets')
    const scriptPath = join(tmp, 'dist-e2e.mjs')
    const assetsUrl = pathToFileURL(distAssetsRepo).href
    const skillsUrl = pathToFileURL(distSkillsRepo).href
    writeFileSync(
      scriptPath,
      [
        `import { ensureAssetsRepo, commitAssetsChanges } from ${JSON.stringify(assetsUrl)}`,
        `import { ensureSkillAssetsRepo } from ${JSON.stringify(skillsUrl)}`,
        `import { readFileSync, readdirSync } from 'node:fs'`,
        `import { join } from 'node:path'`,
        `const assetsDir = process.argv[2]`,
        `const assets = ensureAssetsRepo({ assetsDir, logger: () => {} })`,
        `const out = ensureSkillAssetsRepo({ assetsDir, logger: () => {} })`,
        `const commit = commitAssetsChanges({ dir: assetsDir, logger: () => {} })`,
        `const files = {}`,
        `if (out.dir) {`,
        `  for (const n of readdirSync(out.dir)) {`,
        `    files[n] = readFileSync(join(out.dir, n, 'SKILL.md'), 'utf8')`,
        `  }`,
        `}`,
        `process.stdout.write(JSON.stringify({ assets, out, commit, files }))`,
        '',
      ].join('\n'),
      'utf8',
    )

    const stdout = execFileSync(process.execPath, [scriptPath, assetsDir], { encoding: 'utf8' })
    const parsed = JSON.parse(stdout) as {
      assets: { dir: string; initialized: boolean; degraded: boolean }
      out: { dir: string; provisioned: boolean; degraded: boolean }
      commit: { committed: boolean; degraded: boolean }
      files: Record<string, string>
    }

    expect(parsed.assets.initialized).toBe(true)
    expect(parsed.assets.degraded).toBe(false)
    expect(parsed.out.provisioned).toBe(true)
    expect(parsed.out.degraded).toBe(false)
    expect(parsed.commit.committed).toBe(true)
    expect(parsed.out.dir).toBe(resolveSkillsRepoDir(assetsDir))
    const names = Object.keys(parsed.files).sort()
    expect(names).toEqual([...SKILL_NAMES].sort())
    for (const name of SKILL_NAMES) {
      expect(parsed.files[name], `编译态 ${name} 与源码种子不一致`).toBe(seedBytes(name))
    }
    expect(commitCount(assetsDir)).toBe(1)
    expect(git(['status', '--porcelain'], assetsDir).trim()).toBe('')
  })
})

/* ================================================================== *
 * ③ 降级
 * ================================================================== */
describe('③ 降级（不抛、返回 degraded）', () => {
  it('git 不可用（runner 抛错）→ 资产仓库降级、无 .git；种子仍可落盘', () => {
    const assetsDir = join(tmp, 'assets')
    const logs: string[] = []
    const failing = (): string => {
      throw new Error('spawn git ENOENT')
    }
    let assets!: ReturnType<typeof ensureAssetsRepo>
    expect(() => {
      assets = ensureAssetsRepo({ assetsDir, gitRunner: failing, logger: (m) => logs.push(m) })
    }).not.toThrow()
    expect(assets.degraded).toBe(true)
    expect(assets.initialized).toBe(false)
    expect(logs.join('\n')).toMatch(/降级/)
    expect(existsSync(join(assetsDir, '.git'))).toBe(false)

    // skill 落盘不依赖 git：内容仍可用。
    const out = ensureSkillAssetsRepo({ assetsDir, logger: noop })
    expect(out.degraded).toBe(false)
    expect(out.provisioned).toBe(true)
    expect(existsSync(join(out.dir, SKILL_NAMES[0], SKILL_FILENAME))).toBe(true)

    // 提交阶段分别降级，不抛。
    let committed!: ReturnType<typeof commitAssetsChanges>
    expect(() => {
      committed = commitAssetsChanges({ dir: assetsDir, gitRunner: failing, logger: noop })
    }).not.toThrow()
    expect(committed.degraded).toBe(true)
    expect(committed.committed).toBe(false)
  })

  it('commit 阶段非零退出 → 不抛、degraded、无提交', () => {
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

  it('路径不可创建（无写权限等价：<skillsDir> 被普通文件占位）→ 不抛、degraded', () => {
    const assetsDir = join(tmp, 'assets')
    mkdirSync(assetsDir, { recursive: true })
    writeFileSync(join(assetsDir, SKILLS_REPO_DIRNAME), 'not a dir', 'utf8')

    let out!: ReturnType<typeof ensureSkillAssetsRepo>
    const logs: string[] = []
    expect(() => {
      out = ensureSkillAssetsRepo({ assetsDir, logger: (m) => logs.push(m) })
    }).not.toThrow()
    expect(out.degraded).toBe(true)
    expect(out.provisioned).toBe(false)
    expect(logs.join('\n')).toMatch(/降级/)
  })

  it('种子读取异常（mock loadSkillMarkdown 抛错）→ 不抛、degraded、未落盘', () => {
    const assetsDir = join(tmp, 'assets')
    ensureAssetsRepo({ assetsDir, logger: noop })
    mockState.seedFailure = true
    try {
      let out!: ReturnType<typeof ensureSkillAssetsRepo>
      expect(() => {
        out = ensureSkillAssetsRepo({ assetsDir, logger: noop })
      }).not.toThrow()
      expect(out.degraded).toBe(true)
      expect(out.provisioned).toBe(false)
      expect(existsSync(join(out.dir, SKILL_NAMES[0], SKILL_FILENAME))).toBe(false)
    } finally {
      mockState.seedFailure = false
    }
  })
})

/* ================================================================== *
 * ④ 一致性（目录名 / 文件名 / frontmatter.name）
 * ================================================================== */
describe('④ 三者一致 + SKILL_NAMES 对齐', () => {
  it('种子：恰 5 个、kebab-case、目录名 === frontmatter.name、正文非空', () => {
    const seeds = loadSkillSeeds()
    expect(seeds).toHaveLength(SKILL_NAMES.length)
    expect(seeds.map((s) => s.name)).toEqual([...SKILL_NAMES])
    for (const { name, markdown } of seeds) {
      expect(SKILL_NAME_PATTERN.test(name)).toBe(true)
      const parsed = parseSkillFile(markdown)
      expect(parsed.frontmatter.name).toBe(name)
      expect(parsed.frontmatter.description.trim().length).toBeGreaterThan(0)
      expect(parsed.content.trim().length).toBeGreaterThan(0)
    }
  })

  it('源码目录集合 === 5 个可进化 SKILL + 3 个固有 SKILL，且每个目录含 SKILL.md', () => {
    const srcSkillsDir = join(REPO_ROOT, 'src', 'skills')
    const dirs = readdirSync(srcSkillsDir).filter((n) =>
      existsSync(join(srcSkillsDir, n, SKILL_FILENAME)),
    )
    expect([...dirs].sort()).toEqual(
      [
        ...SKILL_NAMES,
        TASK_AUTHORSHIP_SKILL_NAME,
        SKILL_AUTHORSHIP_SKILL_NAME,
        FINANCE_EVOLUTION_SKILL_NAME,
      ].sort(),
    )
  })

  it('落盘后：目录名 === 文件名 SKILL.md === frontmatter.name', () => {
    const assetsDir = join(tmp, 'assets')
    const out = ensureSkillAssetsRepo({ assetsDir, logger: noop })
    for (const name of SKILL_NAMES) {
      const file = join(out.dir, name, SKILL_FILENAME)
      expect(existsSync(file)).toBe(true)
      const parsed = parseSkillFile(readFileSync(file, 'utf8'))
      expect(parsed.frontmatter.name).toBe(name)
      expect(file.endsWith(`${name}/${SKILL_FILENAME}`)).toBe(true)
    }
    const onDisk = readdirSync(out.dir)
    expect([...onDisk].sort()).toEqual([...SKILL_NAMES].sort())
  })
})

/* ================================================================== *
 * ⑤ 空 / 半初始化判定
 * ================================================================== */
describe('⑤ 空 / 半初始化 → 均能就绪且首次提交包含 5 个 SKILL.md', () => {
  it('目录完全缺失 → 5 个 SKILL.md + 1 commit', () => {
    const { skills } = coldStart(join(tmp, 'assets'))
    expect(skills.provisioned).toBe(true)
    expect(commitCount(join(tmp, 'assets'))).toBe(1)
  })

  it('目录存在但无 .git（空目录）→ init + 5 个 SKILL.md + 1 commit', () => {
    const assetsDir = join(tmp, 'assets')
    mkdirSync(resolveSkillsRepoDir(assetsDir), { recursive: true })
    const { assets, skills } = coldStart(assetsDir)
    expect(assets.initialized).toBe(true)
    expect(skills.provisioned).toBe(true)
    expect(commitCount(assetsDir)).toBe(1)
    expect(existsSync(join(assetsDir, '.git'))).toBe(true)
    expect(existsSync(join(resolveSkillsRepoDir(assetsDir), '.git'))).toBe(false)
  })

  it('无 .git 但已有种子内容 → 首次提交包含它们，内容保持逐字节', () => {
    const assetsDir = join(tmp, 'assets')
    const repoDir = resolveSkillsRepoDir(assetsDir)
    for (const name of SKILL_NAMES) {
      mkdirSync(join(repoDir, name), { recursive: true })
      writeFileSync(join(repoDir, name, SKILL_FILENAME), seedBytes(name), 'utf8')
    }
    const { skills } = coldStart(assetsDir)
    expect(skills.provisioned).toBe(false) // 内容已齐，无需补写
    expect(commitCount(assetsDir)).toBe(1)
    for (const name of SKILL_NAMES) {
      expect(readFileSync(join(repoDir, name, SKILL_FILENAME), 'utf8')).toBe(seedBytes(name))
    }
    expect(git(['ls-files'], assetsDir).trim().split('\n').filter((f) => f.endsWith('/SKILL.md'))).toHaveLength(5)
  })

  it('有 .git 但无提交（内容已就位）→ 恰 1 commit，再次调用 no-op', () => {
    const assetsDir = join(tmp, 'assets')
    const repoDir = resolveSkillsRepoDir(assetsDir)
    mkdirSync(repoDir, { recursive: true })
    git(['init'], assetsDir)
    for (const name of SKILL_NAMES) {
      mkdirSync(join(repoDir, name), { recursive: true })
      writeFileSync(join(repoDir, name, SKILL_FILENAME), seedBytes(name), 'utf8')
    }
    const { skills, commit } = coldStart(assetsDir)
    expect(skills.provisioned).toBe(false)
    expect(skills.degraded).toBe(false)
    expect(commit.committed).toBe(true)
    expect(commitCount(assetsDir)).toBe(1)
    expect(git(['status', '--porcelain'], assetsDir).trim()).toBe('')

    expect(ensureSkillAssetsRepo({ assetsDir, logger: noop }).provisioned).toBe(false)
    expect(commitAssetsChanges({ dir: assetsDir, logger: noop }).committed).toBe(false)
    expect(commitCount(assetsDir)).toBe(1)
  })

  it('仅有一个空目录（无 skill 内容）→ 补齐 5 个并提交', () => {
    const assetsDir = join(tmp, 'assets')
    mkdirSync(join(resolveSkillsRepoDir(assetsDir), 'stray-empty'), { recursive: true })
    const { skills } = coldStart(assetsDir)
    expect(skills.provisioned).toBe(true)
    expect(commitCount(assetsDir)).toBe(1)
  })

  it('资产仓库 .gitignore 不忽略 skill 内容', () => {
    const assetsDir = join(tmp, 'assets')
    coldStart(assetsDir)
    // `git check-ignore` 命中 → 退出码 0（不应发生）；未命中 → 非零退出（期望）。
    expect(() =>
      git(['check-ignore', '-v', '--', `skills/${SKILL_NAMES[0]}/${SKILL_FILENAME}`], assetsDir),
    ).toThrow()
    expect(git(['status', '--porcelain'], assetsDir).trim()).toBe('')
  })
})

/* ================================================================== *
 * ⑥ 路径护栏 / 优先级 / 不污染
 * ================================================================== */
describe('⑥ 路径护栏：assetsDir 优先级与不污染真实 ~/.dsh-ia', () => {
  it('构造注入 assetsDir 优先于 env（DSH_IA_HOME）', () => {
    const envHome = join(tmp, 'env-home')
    const injectAssets = join(tmp, 'inject-assets')
    process.env[FINANCE_HOME_ENV] = envHome

    const assets = ensureAssetsRepo({ assetsDir: injectAssets, logger: noop })
    const out = ensureSkillAssetsRepo({ assetsDir: injectAssets, logger: noop })
    expect(assets.dir).toBe(injectAssets)
    expect(out.dir).toBe(resolveSkillsRepoDir(injectAssets))
    expect(existsSync(resolveSkillsRepoDir(join(envHome, 'assets')))).toBe(false)
  })

  it('env 生效：落在 <DSH_IA_HOME>/assets/skills，仓库在 <DSH_IA_HOME>/assets', () => {
    const envHome = join(tmp, 'env-home')
    process.env[FINANCE_HOME_ENV] = envHome
    const assets = ensureAssetsRepo({ logger: noop })
    const out = ensureSkillAssetsRepo({ logger: noop })
    expect(assets.dir).toBe(join(envHome, 'assets'))
    expect(out.dir).toBe(resolveSkillsRepoDir(join(envHome, 'assets')))
    expect(out.provisioned).toBe(true)
    expect(existsSync(join(out.dir, SKILL_NAMES[0], SKILL_FILENAME))).toBe(true)
    expect(existsSync(join(envHome, 'assets', '.git'))).toBe(true)
  })

  it('本文件所有用例产物均在 os.tmpdir() 下，且未新建真实 ~/.dsh-ia/assets', () => {
    const out = ensureSkillAssetsRepo({ assetsDir: join(tmp, 'assets'), logger: noop })
    expect(out.dir.startsWith(tmpdir())).toBe(true)
    if (!realAssetsExistedAtStart) {
      expect(existsSync(REAL_ASSETS_DIR)).toBe(false)
    }
  })
})

/* ================================================================== *
 * ⑦ 插件装配（apply → 单仓就绪 + 种子落盘 + 首次快照）
 * ================================================================== */
describe('⑦ 插件装配：apply 接线与安全降级', () => {
  function minimalCtx(): { ctx: Context; disposers: Array<() => void> } {
    const disposers: Array<() => void> = []
    const ctx = {
      effect(body: () => unknown) {
        const d = body()
        const f = typeof d === 'function' ? (d as () => void) : () => {}
        disposers.push(f)
        return f
      },
      get: () => undefined,
      inject: () => ({}),
    } as unknown as Context
    return { ctx, disposers }
  }

  it('最小上下文 + DSH_IA_HOME 指向临时 home：apply 不抛，外层 .git 唯一、5 个 SKILL、1 commit', () => {
    const envHome = join(tmp, 'apply-home')
    process.env[FINANCE_HOME_ENV] = envHome
    const { ctx, disposers } = minimalCtx()

    expect(() => apply(ctx)).not.toThrow()

    const assetsDir = join(envHome, 'assets')
    const repoDir = resolveSkillsRepoDir(assetsDir)
    expect(existsSync(join(assetsDir, '.git'))).toBe(true)
    expect(existsSync(join(repoDir, '.git'))).toBe(false)
    for (const name of SKILL_NAMES) {
      expect(existsSync(join(repoDir, name, SKILL_FILENAME))).toBe(true)
    }
    expect(commitCount(assetsDir)).toBe(1)
    const tracked = git(['ls-files'], assetsDir).trim().split('\n').filter(Boolean)
    expect(tracked.filter((f) => f.endsWith('/SKILL.md'))).toHaveLength(5)
    expect(git(['status', '--porcelain'], assetsDir).trim()).toBe('')

    for (const d of disposers) d()
  })

  it('skills 位置被文件占位（落盘必失败）→ apply 仍不抛（装载不中断）', () => {
    const envHome = join(tmp, 'apply-degrade-home')
    mkdirSync(join(envHome, 'assets'), { recursive: true })
    writeFileSync(join(envHome, 'assets', SKILLS_REPO_DIRNAME), 'blocker', 'utf8')
    process.env[FINANCE_HOME_ENV] = envHome
    const { ctx, disposers } = minimalCtx()

    expect(() => apply(ctx)).not.toThrow()
    for (const d of disposers) d()
  })
})
