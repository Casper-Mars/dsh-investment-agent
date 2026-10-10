/**
 * tester-t100418-skill-assets.INDEPENDENT.spec.ts
 *
 * 任务 t100418 独立验证（对抗 / 边界导向）：
 *   skill 资产迁移到运行时数据目录 `<dataRoot>/skills` 并 git 化。
 *
 * 与 Developer 的 `tests/skill-assets-repo.spec.ts` **独立编写**，不比对自述数字：
 *   ① 独立 mock 断言：注入自定义 `gitRunner` 观察调用序列（init / init 回落 /
 *      add -A / commit 仅 1 次；已就绪 → 不触发任何写操作）；
 *   ② 真实进程 / 真实 git E2E：临时 dataRoot 真跑 `ensureSkillAssetsRepo`，验
 *      目录结构 / git log 恰 1 条 / status 干净 / 6 skill 与种子逐字节一致；
 *      二次调用 commit 数不变；**编译态 E2E**（dist-server 产物独立 node 进程）；
 *   ③ 降级独立验证：gitRunner 抛错 / commit 阶段失败 / 路径不可创建（无写权限
 *      等价） / 种子读取异常（mock）→ 均不抛、返回 degraded；
 *   ④ 一致性：落盘 6 个 SKILL.md 用 frontmatter.ts 解析，目录名 ===
 *      frontmatter.name === 期望名；SKILL_NAMES 与落盘集合一致；
 *   ⑤ 空 / 半初始化判定：缺失 / 无 .git / 有 .git 无提交 / 仅空目录 / 无 skill
 *      内容 → 均需预置且恰一次首版 commit；
 *   ⑥ 路径护栏：不污染真实 `~/.dsh-finance`，dataRoot 优先级注入 > env > 默认；
 *   ⑦ 插件装配：`apply` 在最小上下文 + env 指向临时目录时不抛、并落盘到临时目录。
 *
 * 所有用例使用 `os.tmpdir()` 随机子目录，**不触碰**真实 `~/.dsh-finance`。
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
import { SKILL_NAMES } from '../src/skills/index.js'
import { parseSkillFile, SKILL_NAME_PATTERN } from '../src/skills/frontmatter.js'
import {
  ensureSkillAssetsRepo,
  loadSkillSeeds,
  resolveSkillsRepoDir,
  INITIAL_COMMIT_MESSAGE,
  SKILL_FILENAME,
  SKILLS_REPO_DIRNAME,
  GIT_IDENTITY_NAME,
  GIT_IDENTITY_EMAIL,
  type GitRunner,
} from '../src/skills/repo.js'
import { DATA_ROOT_ENV, resolveDataRoot } from '../src/paths.js'
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
function recordingRunner(): { runner: GitRunner; calls: string[] } {
  const calls: string[] = []
  const runner: GitRunner = (args, cwd) => {
    calls.push(args.join(' '))
    return git(args, cwd)
  }
  return { runner, calls }
}

function assertGitAvailable(): void {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' })
  } catch {
    throw new Error('本测试需要系统 git 可用（PATH 中找不到 git）')
  }
}

let tmp: string
const savedEnv = process.env[DATA_ROOT_ENV]
const REAL_SKILLS_DIR = join(
  process.env.HOME ?? '',
  '.dsh-finance',
  'data',
  SKILLS_REPO_DIRNAME,
)
let realSkillsExistedAtStart = false

beforeEach(() => {
  assertGitAvailable()
  tmp = mkdtempSync(join(tmpdir(), 'dsh-finance-t100418-'))
})

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true })
  if (savedEnv === undefined) delete process.env[DATA_ROOT_ENV]
  else process.env[DATA_ROOT_ENV] = savedEnv
})

/* ================================================================== *
 * ① 独立 mock 断言：调用序列
 * ================================================================== */
describe('① 调用序列（注入 gitRunner 观察）', () => {
  it('全新目录 → init + add -A + 恰 1 次 commit', () => {
    const dataRoot = join(tmp, 'data')
    const { runner, calls } = recordingRunner()
    const out = ensureSkillAssetsRepo({ dataRoot, gitRunner: runner, logger: noop })

    expect(out.provisioned).toBe(true)
    expect(out.degraded).toBe(false)
    expect(calls.some((c) => c === 'init -b main' || c === 'init')).toBe(true)
    expect(calls).toContain('add -A')
    expect(calls.filter((c) => c.startsWith('commit')).length).toBe(1)
    expect(calls.filter((c) => c.startsWith('init')).length).toBe(1)
  })

  it('init -b main 不被支持时回落到普通 git init，且仍只 commit 一次', () => {
    const dataRoot = join(tmp, 'data')
    const calls: string[] = []
    const runner: GitRunner = (args, cwd) => {
      calls.push(args.join(' '))
      if (args[0] === 'init' && args[1] === '-b') throw new Error('unknown switch `b`')
      return git(args, cwd)
    }

    const out = ensureSkillAssetsRepo({ dataRoot, gitRunner: runner, logger: noop })
    expect(out.provisioned).toBe(true)
    expect(calls).toContain('init -b main')
    expect(calls).toContain('init') // 回落
    expect(calls.filter((c) => c.startsWith('commit')).length).toBe(1)
  })

  it('已就绪仓库 → 判 no-op：**不调用** init / add / commit（仅 rev-parse 探测）', () => {
    const dataRoot = join(tmp, 'data')
    expect(ensureSkillAssetsRepo({ dataRoot, logger: noop }).provisioned).toBe(true)

    const { runner, calls } = recordingRunner()
    const second = ensureSkillAssetsRepo({ dataRoot, gitRunner: runner, logger: noop })

    expect(second.provisioned).toBe(false)
    expect(second.degraded).toBe(false)
    expect(calls.some((c) => c.startsWith('init'))).toBe(false)
    expect(calls).not.toContain('add -A')
    expect(calls.some((c) => c.startsWith('commit'))).toBe(false)
    // 唯一调用是「有无 HEAD」探测。
    expect(calls).toEqual(['rev-parse --verify HEAD'])
  })
})

/* ================================================================== *
 * ② 真实 git E2E
 * ================================================================== */
describe('② 真实 git E2E（临时 dataRoot）', () => {
  it('冷启动：目录 / .git / 6 skill / git log 恰 1 条 / status 干净 / 逐字节一致', () => {
    const dataRoot = join(tmp, 'data')
    const out = ensureSkillAssetsRepo({ dataRoot, logger: noop })
    const repoDir = out.dir

    expect(out.dir).toBe(resolveSkillsRepoDir(dataRoot))
    expect(out.dir).toBe(join(dataRoot, SKILLS_REPO_DIRNAME))
    expect(out.provisioned).toBe(true)
    expect(out.degraded).toBe(false)

    expect(existsSync(join(repoDir, '.git'))).toBe(true)

    // 落盘集合 = SKILL_NAMES，无多余目录（.git / .gitignore 除外）。
    const entries = readdirSync(repoDir).filter((n) => n !== '.git' && n !== '.gitignore')
    expect([...entries].sort()).toEqual([...SKILL_NAMES].sort())

    // 6 skill 逐字节 = 源码种子 = 编译态种子。
    for (const name of SKILL_NAMES) {
      const file = join(repoDir, name, SKILL_FILENAME)
      expect(existsSync(file), `${name} 缺失`).toBe(true)
      expect(readFileSync(file, 'utf8'), `${name} vs src seed`).toBe(seedBytes(name))
      expect(readFileSync(file, 'utf8'), `${name} vs dist seed`).toBe(distSeedBytes(name))
    }

    // git log 恰 1 条；commit 数 1；message 正确；分支 main；工作区干净。
    const onelog = git(['log', '--oneline'], repoDir).trim().split('\n').filter(Boolean)
    expect(onelog).toHaveLength(1)
    expect(commitCount(repoDir)).toBe(1)
    expect(git(['log', '-1', '--pretty=%s'], repoDir).trim()).toBe(INITIAL_COMMIT_MESSAGE)
    expect(git(['rev-parse', '--abbrev-ref', 'HEAD'], repoDir).trim()).toBe('main')
    expect(git(['status', '--porcelain'], repoDir).trim()).toBe('')
  })

  it('幂等：二次 / 三次调用 commit 数不增、内容逐字节不变、status 仍干净', () => {
    const dataRoot = join(tmp, 'data')
    const first = ensureSkillAssetsRepo({ dataRoot, logger: noop })
    const repoDir = first.dir
    const before = SKILL_NAMES.map((n) => readFileSync(join(repoDir, n, SKILL_FILENAME), 'utf8'))
    const count = commitCount(repoDir)

    for (let i = 0; i < 2; i += 1) {
      const again = ensureSkillAssetsRepo({ dataRoot, logger: noop })
      expect(again.provisioned).toBe(false)
      expect(again.degraded).toBe(false)
    }

    expect(commitCount(repoDir)).toBe(count)
    const after = SKILL_NAMES.map((n) => readFileSync(join(repoDir, n, SKILL_FILENAME), 'utf8'))
    expect(after).toEqual(before)
    expect(git(['status', '--porcelain'], repoDir).trim()).toBe('')
  })

  it('编译态 E2E：独立 node 进程走 dist-server 产物预置，种子可读、逐字节一致', () => {
    const distRepo = join(REPO_ROOT, 'dist-server', 'skills', 'repo.js')
    if (!existsSync(distRepo)) {
      throw new Error('需先执行 `pnpm build`（dist-server/skills/repo.js 缺失）')
    }
    const dataRoot = join(tmp, 'dist-data')
    const scriptPath = join(tmp, 'dist-e2e.mjs')
    const url = pathToFileURL(distRepo).href
    writeFileSync(
      scriptPath,
      [
        `import { ensureSkillAssetsRepo } from ${JSON.stringify(url)}`,
        `import { readFileSync, readdirSync } from 'node:fs'`,
        `import { join } from 'node:path'`,
        `const dataRoot = process.argv[2]`,
        `const out = ensureSkillAssetsRepo({ dataRoot, logger: () => {} })`,
        `const files = {}`,
        `if (out.dir) {`,
        `  for (const n of readdirSync(out.dir)) {`,
        `    if (n === '.git' || n === '.gitignore') continue`,
        `    files[n] = readFileSync(join(out.dir, n, 'SKILL.md'), 'utf8')`,
        `  }`,
        `}`,
        `process.stdout.write(JSON.stringify({ out, files }))`,
        '',
      ].join('\n'),
      'utf8',
    )

    const stdout = execFileSync(process.execPath, [scriptPath, dataRoot], { encoding: 'utf8' })
    const parsed = JSON.parse(stdout) as {
      out: { dir: string; provisioned: boolean; degraded: boolean }
      files: Record<string, string>
    }

    expect(parsed.out.provisioned).toBe(true)
    expect(parsed.out.degraded).toBe(false)
    expect(parsed.out.dir).toBe(resolveSkillsRepoDir(dataRoot))
    const names = Object.keys(parsed.files).sort()
    expect(names).toEqual([...SKILL_NAMES].sort())
    for (const name of SKILL_NAMES) {
      expect(parsed.files[name], `编译态 ${name} 与源码种子不一致`).toBe(seedBytes(name))
    }
    expect(commitCount(parsed.out.dir)).toBe(1)
    expect(git(['status', '--porcelain'], parsed.out.dir).trim()).toBe('')
  })
})

/* ================================================================== *
 * ③ 降级
 * ================================================================== */
describe('③ 降级（不抛、返回 degraded）', () => {
  it('git 不可用（runner 抛错）→ 不抛、degraded、无 .git', () => {
    const dataRoot = join(tmp, 'data')
    const logs: string[] = []
    const failing: GitRunner = () => {
      throw new Error('spawn git ENOENT')
    }
    let out!: ReturnType<typeof ensureSkillAssetsRepo>
    expect(() => {
      out = ensureSkillAssetsRepo({ dataRoot, gitRunner: failing, logger: (m) => logs.push(m) })
    }).not.toThrow()
    expect(out.degraded).toBe(true)
    expect(out.provisioned).toBe(false)
    expect(logs.join('\n')).toMatch(/降级/)
    expect(existsSync(join(out.dir, '.git'))).toBe(false)
  })

  it('commit 阶段非零退出 → 不抛、degraded、无提交', () => {
    const dataRoot = join(tmp, 'data')
    const partial: GitRunner = (args, cwd) => {
      if (args[0] === 'commit') throw new Error('commit failed: exit status 1')
      return git(args, cwd)
    }
    let out!: ReturnType<typeof ensureSkillAssetsRepo>
    expect(() => {
      out = ensureSkillAssetsRepo({ dataRoot, gitRunner: partial, logger: noop })
    }).not.toThrow()
    expect(out.degraded).toBe(true)
    expect(out.provisioned).toBe(false)
    expect(commitCount(out.dir)).toBe(0)
  })

  it('路径不可创建（无写权限等价：<repoDir> 被普通文件占位）→ 不抛、degraded', () => {
    const dataRoot = join(tmp, 'data')
    // 先建目录再把 skills 位置用「普通文件」占位，使 mkdirSync 失败。
    mkdirSync(dataRoot, { recursive: true })
    writeFileSync(join(dataRoot, SKILLS_REPO_DIRNAME), 'not a dir', 'utf8')

    let out!: ReturnType<typeof ensureSkillAssetsRepo>
    const logs: string[] = []
    expect(() => {
      out = ensureSkillAssetsRepo({ dataRoot, logger: (m) => logs.push(m) })
    }).not.toThrow()
    expect(out.degraded).toBe(true)
    expect(out.provisioned).toBe(false)
    expect(logs.join('\n')).toMatch(/降级/)
  })

  it('种子读取异常（mock loadSkillMarkdown 抛错）→ 不抛、degraded、未落盘', () => {
    const dataRoot = join(tmp, 'data')
    mockState.seedFailure = true
    try {
      let out!: ReturnType<typeof ensureSkillAssetsRepo>
      expect(() => {
        out = ensureSkillAssetsRepo({ dataRoot, logger: noop })
      }).not.toThrow()
      expect(out.degraded).toBe(true)
      expect(out.provisioned).toBe(false)
      expect(existsSync(join(out.dir, '.git'))).toBe(false)
    } finally {
      mockState.seedFailure = false
    }
  })
})

/* ================================================================== *
 * ④ 一致性（目录名 / 文件名 / frontmatter.name）
 * ================================================================== */
describe('④ 三者一致 + SKILL_NAMES 对齐', () => {
  it('种子：恰 6 个、kebab-case、目录名 === frontmatter.name、正文非空', () => {
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

  it('源码目录集合 === SKILL_NAMES，且每个目录含 SKILL.md', () => {
    const srcSkillsDir = join(REPO_ROOT, 'src', 'skills')
    const dirs = readdirSync(srcSkillsDir).filter((n) =>
      existsSync(join(srcSkillsDir, n, SKILL_FILENAME)),
    )
    expect([...dirs].sort()).toEqual([...SKILL_NAMES].sort())
  })

  it('落盘后：目录名 === 文件名 SKILL.md === frontmatter.name', () => {
    const dataRoot = join(tmp, 'data')
    const out = ensureSkillAssetsRepo({ dataRoot, logger: noop })
    for (const name of SKILL_NAMES) {
      const file = join(out.dir, name, SKILL_FILENAME)
      expect(existsSync(file)).toBe(true)
      const parsed = parseSkillFile(readFileSync(file, 'utf8'))
      expect(parsed.frontmatter.name).toBe(name)
      expect(file.endsWith(`${name}/${SKILL_FILENAME}`)).toBe(true)
    }
    const onDisk = readdirSync(out.dir).filter(
      (n) => n !== '.git' && n !== '.gitignore',
    )
    expect([...onDisk].sort()).toEqual([...SKILL_NAMES].sort())
  })
})

/* ================================================================== *
 * ⑤ 空 / 半初始化判定
 * ================================================================== */
describe('⑤ 空 / 半初始化 → 均预置且恰一次首版 commit', () => {
  it('目录完全缺失 → 预置 1 commit', () => {
    const out = ensureSkillAssetsRepo({ dataRoot: join(tmp, 'data'), logger: noop })
    expect(out.provisioned).toBe(true)
    expect(commitCount(out.dir)).toBe(1)
  })

  it('目录存在但无 .git（空目录）→ 预置 1 commit', () => {
    const dataRoot = join(tmp, 'data')
    mkdirSync(resolveSkillsRepoDir(dataRoot), { recursive: true })
    const out = ensureSkillAssetsRepo({ dataRoot, logger: noop })
    expect(out.provisioned).toBe(true)
    expect(commitCount(out.dir)).toBe(1)
  })

  it('无 .git 但已有种子内容 → 预置 1 commit，内容保持逐字节', () => {
    const dataRoot = join(tmp, 'data')
    const repoDir = resolveSkillsRepoDir(dataRoot)
    for (const name of SKILL_NAMES) {
      mkdirSync(join(repoDir, name), { recursive: true })
      writeFileSync(join(repoDir, name, SKILL_FILENAME), seedBytes(name), 'utf8')
    }
    const out = ensureSkillAssetsRepo({ dataRoot, logger: noop })
    expect(out.provisioned).toBe(true)
    expect(commitCount(repoDir)).toBe(1)
    for (const name of SKILL_NAMES) {
      expect(readFileSync(join(repoDir, name, SKILL_FILENAME), 'utf8')).toBe(seedBytes(name))
    }
  })

  it('有 .git 但无提交（内容已就位）→ 预置恰 1 commit，再次调用 no-op', () => {
    const dataRoot = join(tmp, 'data')
    const repoDir = resolveSkillsRepoDir(dataRoot)
    mkdirSync(repoDir, { recursive: true })
    git(['init'], repoDir)
    for (const name of SKILL_NAMES) {
      mkdirSync(join(repoDir, name), { recursive: true })
      writeFileSync(join(repoDir, name, SKILL_FILENAME), seedBytes(name), 'utf8')
    }
    const out = ensureSkillAssetsRepo({ dataRoot, logger: noop })
    expect(out.provisioned).toBe(true)
    expect(out.degraded).toBe(false)
    expect(commitCount(repoDir)).toBe(1)
    expect(git(['status', '--porcelain'], repoDir).trim()).toBe('')

    expect(ensureSkillAssetsRepo({ dataRoot, logger: noop }).provisioned).toBe(false)
    expect(commitCount(repoDir)).toBe(1)
  })

  it('仅有一个空目录（无 skill 内容）→ 预置 1 commit', () => {
    const dataRoot = join(tmp, 'data')
    mkdirSync(join(resolveSkillsRepoDir(dataRoot), 'stray-empty'), { recursive: true })
    const out = ensureSkillAssetsRepo({ dataRoot, logger: noop })
    expect(out.provisioned).toBe(true)
    expect(commitCount(out.dir)).toBe(1)
  })

  it('已 git init 但仅有空目录（无 skill 内容）→ 预置 1 commit', () => {
    const dataRoot = join(tmp, 'data')
    const repoDir = resolveSkillsRepoDir(dataRoot)
    mkdirSync(join(repoDir, 'stray-empty'), { recursive: true })
    git(['init'], repoDir)
    const out = ensureSkillAssetsRepo({ dataRoot, logger: noop })
    expect(out.provisioned).toBe(true)
    expect(commitCount(repoDir)).toBe(1)
  })

  it('仓库内 .gitignore 不忽略 skill 内容', () => {
    const dataRoot = join(tmp, 'data')
    const out = ensureSkillAssetsRepo({ dataRoot, logger: noop })
    // `git check-ignore` 命中 → 退出码 0（不应发生）；未命中 → 非零退出（期望）。
    expect(() =>
      git(['check-ignore', '-v', '--', `${SKILL_NAMES[0]}/${SKILL_FILENAME}`], out.dir),
    ).toThrow()
    // .gitignore 本身已被提交（工作区干净）。
    expect(git(['status', '--porcelain'], out.dir).trim()).toBe('')
  })
})

/* ================================================================== *
 * ⑥ 路径护栏 / 优先级 / 不污染
 * ================================================================== */
describe('⑥ 路径护栏：优先级与不污染真实 ~/.dsh-finance', () => {
  it('resolveDataRoot：构造注入 > env > 默认（空串回落）', () => {
    const envRoot = join(tmp, 'env-data')
    const injectRoot = join(tmp, 'inject-data')
    process.env[DATA_ROOT_ENV] = envRoot

    expect(resolveDataRoot(injectRoot)).toBe(injectRoot)
    expect(resolveDataRoot('   ')).toBe(envRoot) // 空白注入回落 env（不触默认）
    expect(resolveDataRoot(undefined)).toBe(envRoot)

    // 注入优先于 env：不会在 env 目录落库。
    const out = ensureSkillAssetsRepo({ dataRoot: injectRoot, logger: noop })
    expect(out.dir).toBe(resolveSkillsRepoDir(injectRoot))
    expect(existsSync(resolveSkillsRepoDir(envRoot))).toBe(false)
  })

  it('env 生效：仓库落在 <env>/skills', () => {
    const envRoot = join(tmp, 'env-data')
    process.env[DATA_ROOT_ENV] = envRoot
    const out = ensureSkillAssetsRepo({ logger: noop })
    expect(out.dir).toBe(resolveSkillsRepoDir(envRoot))
    expect(out.provisioned).toBe(true)
    expect(existsSync(join(out.dir, SKILL_NAMES[0], SKILL_FILENAME))).toBe(true)
  })

  it('本文件所有用例产物均在 os.tmpdir() 下，且未新建真实 ~/.dsh-finance/skills', () => {
    const out = ensureSkillAssetsRepo({ dataRoot: join(tmp, 'data'), logger: noop })
    expect(out.dir.startsWith(tmpdir())).toBe(true)
    if (!realSkillsExistedAtStart) {
      expect(existsSync(REAL_SKILLS_DIR)).toBe(false)
    }
  })
})

/* ================================================================== *
 * ⑦ 插件装配（apply → ensureSkillAssetsRepo 接线 + 不中断装载）
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

  it('最小上下文 + env 指向临时目录：apply 不抛且落盘到临时目录（6 skill）', () => {
    const envRoot = join(tmp, 'apply-data')
    process.env[DATA_ROOT_ENV] = envRoot
    const { ctx, disposers } = minimalCtx()

    expect(() => apply(ctx)).not.toThrow()

    const repoDir = resolveSkillsRepoDir(envRoot)
    expect(existsSync(join(repoDir, '.git'))).toBe(true)
    for (const name of SKILL_NAMES) {
      expect(existsSync(join(repoDir, name, SKILL_FILENAME))).toBe(true)
    }
    expect(commitCount(repoDir)).toBe(1)

    for (const d of disposers) d()
  })

  it('skills 位置被文件占位（预置必失败）→ apply 仍不抛（装载不中断）', () => {
    const envRoot = join(tmp, 'apply-degrade-data')
    mkdirSync(envRoot, { recursive: true })
    writeFileSync(join(envRoot, SKILLS_REPO_DIRNAME), 'blocker', 'utf8')
    process.env[DATA_ROOT_ENV] = envRoot
    const { ctx, disposers } = minimalCtx()

    expect(() => apply(ctx)).not.toThrow()
    for (const d of disposers) d()
  })
})

/* ------------------------------------------------------------------ *
 * beforeAll：记录真实 ~/.dsh-finance/skills 起始状态（不污染判定基线）
 * ------------------------------------------------------------------ */
beforeEach(() => {
  realSkillsExistedAtStart = existsSync(REAL_SKILLS_DIR)
})
