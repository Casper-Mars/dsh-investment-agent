/**
 * 独立验收测试 —— 任务-02「skill 资产迁出到 assets/skills」（t100464）。
 *
 * 本文件由 Tester 独立编写，**不复用** Developer 的测试断言，逐条覆盖：
 *   验收 1：冷启动 + 热更新（provider 扫描 `<assetsDir>/skills`，改写 SKILL.md 免重启生效）
 *   验收 2：独立 git 仓库 + 首版 commit + 显式作者身份（不依赖宿主机 git config）
 *   验收 3：类型与定向测试 —— 由外部命令 `pnpm typecheck` / `vitest run <定向文件>` 验证（见报告）
 *   额外 4：旧路径彻底消失（`<root>/data/skills` 不产生；`~/.dsh-ia` 绝不被触碰）
 *   额外 5：环境变量语义（`DSH_IA_HOME` 决定路径；`DSH_IA_DATA_DIR` 不再影响 skills 路径）
 *   额外 6：无兼容别名（`repo.ts` / `provider.ts` / `plugin.ts` 内无 `dataRoot`）
 *   额外 7：幂等（二次 `provisioned:false`，commit 数不变）
 *   额外 8：降级语义（注入抛错的 gitRunner → `degraded:true` 且不抛）
 *
 * 安全隔离：所有目录均为 `mkdtempSync(join(tmpdir(), ...))`；凡未显式传
 * `assetsDir` 的调用一律以 `DSH_IA_HOME` 指向临时 home。**不读写真实 `~/.dsh-ia`**。
 */
import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import {
  ensureSkillAssetsRepo,
  resolveSkillsRepoDir,
  INITIAL_COMMIT_MESSAGE,
  SKILL_FILENAME,
  type SkillAssetsRepoOutcome,
  type GitRunner,
} from '../src/skills/repo.js'
import {
  mountSkillFilesystemProviderAsync,
  SKILL_PROVIDER_NAME,
} from '../src/skills/provider.js'
import { SKILL_NAMES } from '../src/skills/index.js'
import { parseSkillFile } from '../src/skills/frontmatter.js'
import { resolveAssetsDir } from '../src/paths.js'
import { DATA_ROOT_ENV } from '../src/paths.js'
import { FINANCE_HOME_ENV } from '../src/flags.js'

/** chokidar 稳定阈值 + 并行负载下的余量。 */
const TEST_TIMEOUT = 30000

/** 仓库根（源码态）。 */
const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))

/** 静默 logger。 */
const noop = (): void => {}

const tmpDirs: string[] = []

/** 建临时目录并登记清理。 */
function mkTmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tmpDirs.push(dir)
  return dir
}

/** 系统 git（仅用于测试断言，不注入身份）。 */
function git(args: string[], cwd: string): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

/** 提交数（无 HEAD 视为 0）。 */
function commitCount(repoDir: string): number {
  try {
    return Number(git(['rev-list', '--count', 'HEAD'], repoDir).trim())
  } catch {
    return 0
  }
}

/**
 * 临时设置环境变量（值 `undefined` 表示删除），执行后恢复。
 * 用于「进程内默认路径」语义验证；git 子进程会继承这些变量。
 */
function withEnv<T>(vars: Record<string, string | undefined>, fn: () => T): T {
  const saved = new Map<string, string | undefined>()
  for (const [key, value] of Object.entries(vars)) {
    saved.set(key, process.env[key])
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  try {
    return fn()
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

/** 新建真实 SkillRegistry 上下文。 */
async function newSkillContext(): Promise<Context> {
  const ctx = new Context()
  await (ctx.plugin(SkillRegistry as never) as Promise<unknown>)
  return ctx
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  }
})

/* ================================================================== *
 * 验收 1：冷启动 + 热更新
 * ================================================================== */

describe('[AC1] 冷启动预置 + provider 扫描 + watch 热更新', () => {
  it('冷启动后 provider 从 <assetsDir>/skills 发现 5 个可进化 skill；改写 SKILL.md 免重启生效', async () => {
    const assetsDir = mkTmp('t100464-ac1-')
    const skillsDir = resolveSkillsRepoDir(assetsDir)

    // 冷启动：预置独立 git 仓库。
    const seeded = ensureSkillAssetsRepo({ assetsDir, logger: noop })
    expect(seeded.degraded, `冷启动降级：${seeded.reason}`).toBe(false)
    expect(seeded.provisioned).toBe(true)
    for (const name of SKILL_NAMES) {
      expect(existsSync(join(skillsDir, name, SKILL_FILENAME)), `${name} 种子缺失`).toBe(true)
    }

    const ctx = await newSkillContext()
    // 不传 watch：验证默认即开启热更新。
    const mount = await mountSkillFilesystemProviderAsync(ctx, { assetsDir })
    expect(mount.providerName).toBe(SKILL_PROVIDER_NAME)
    expect(mount.dir).toBe(skillsDir)

    try {
      // 初值：恰好 5 个可进化 skill，正文与磁盘文件一致。
      const list = await ctx.skills.list({})
      const names = list.map((s) => s.name).sort()
      expect(names).toEqual([...SKILL_NAMES].sort())
      expect(list.every((s) => s.provider === SKILL_PROVIDER_NAME)).toBe(true)

      const target = 'trend-analysis'
      const diskBefore = parseSkillFile(
        readFileSync(join(skillsDir, target, SKILL_FILENAME), 'utf8'),
      )
      const defBefore = await ctx.skills.get(target)
      expect(defBefore?.content).toBe(diskBefore.content)
      const descBefore = list.find((s) => s.name === target)?.description
      expect(descBefore).toBe(diskBefore.frontmatter.description)

      // 改写磁盘文件（description + 正文），无需重启。
      const updated = [
        '---',
        `name: ${target}`,
        'description: T100464-HOT-RELOAD-DESC',
        'whenToUse: T100464-HOT-RELOAD-WHEN',
        '---',
        '',
        '# T100464-HOT-RELOAD-BODY',
        '独立热更新验证正文',
        '',
      ].join('\n')
      writeFileSync(join(skillsDir, target, SKILL_FILENAME), updated, 'utf8')

      // 轮询等待 chokidar 触发 invalidate（真实 watch，无重启）。
      await vi.waitFor(
        async () => {
          const after = await ctx.skills.list({})
          expect(after.find((s) => s.name === target)?.description).toBe(
            'T100464-HOT-RELOAD-DESC',
          )
        },
        { timeout: 12000, interval: 100 },
      )

      const defAfter = await ctx.skills.get(target)
      expect(defAfter?.content).toContain('T100464-HOT-RELOAD-BODY')
      expect(defAfter?.content).toContain('独立热更新验证正文')
      // 5 个 skill 仍在（热更新未破坏目录）。
      expect((await ctx.skills.list({})).map((s) => s.name).sort()).toEqual(
        [...SKILL_NAMES].sort(),
      )
    } finally {
      await mount.dispose()
      await ctx.fiber.dispose()
    }
  }, TEST_TIMEOUT)
})

/* ================================================================== *
 * 验收 2：独立 git 仓库 + 显式作者身份
 * ================================================================== */

describe('[AC2] 独立 git 仓库 + 首版 commit + 显式作者身份', () => {
  it('assets/skills 是独立 git 仓库（toplevel 即自身），首版恰 1 个 commit', () => {
    const assetsDir = mkTmp('t100464-ac2-repo-')
    const out = ensureSkillAssetsRepo({ assetsDir, logger: noop })
    expect(out.provisioned).toBe(true)
    expect(existsSync(join(out.dir, '.git'))).toBe(true)

    const topLevel = git(['rev-parse', '--show-toplevel'], out.dir).trim()
    expect(realpathSync(topLevel)).toBe(realpathSync(out.dir))
    // 不在被测主仓库内（独立版本线）。
    expect(realpathSync(out.dir).startsWith(realpathSync(REPO_ROOT) + '/')).toBe(false)

    expect(commitCount(out.dir)).toBe(1)
    expect(git(['log', '-1', '--pretty=%s'], out.dir).trim()).toBe(INITIAL_COMMIT_MESSAGE)
    expect(git(['status', '--porcelain'], out.dir).trim()).toBe('')
  })

  it('作者/提交者显式为 dsh-ia <dsh-ia@localhost>，且 GIT_CONFIG_GLOBAL=/dev/null、GIT_CONFIG_SYSTEM=/dev/null 下仍成立', () => {
    const assetsDir = mkTmp('t100464-ac2-nullcfg-')
    // 临时清空全局/系统 git config（不依赖宿主机 user.name / user.email）。
    const out = withEnv(
      {
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_SYSTEM: '/dev/null',
      },
      () => ensureSkillAssetsRepo({ assetsDir, logger: noop }),
    )
    expect(out.provisioned).toBe(true)
    expect(out.degraded).toBe(false)
    expect(git(['log', '-1', '--format=%an <%ae>|%cn <%ce>'], out.dir).trim()).toBe(
      'dsh-ia <dsh-ia@localhost>|dsh-ia <dsh-ia@localhost>',
    )
  })

  it('宿主机全局 config 即使配了别的身份也不被采用（显式身份优先）', () => {
    const assetsDir = mkTmp('t100464-ac2-hostilecfg-')
    const decoyConfig = join(mkTmp('t100464-ac2-cfg-'), 'gitconfig')
    writeFileSync(
      decoyConfig,
      '[user]\n\tname = HOST-ONLY-USER\n\temail = host-only@example.invalid\n',
      'utf8',
    )
    const fakeHome = mkTmp('t100464-ac2-home-')

    const out = withEnv(
      {
        GIT_CONFIG_GLOBAL: decoyConfig,
        GIT_CONFIG_SYSTEM: '/dev/null',
        HOME: fakeHome,
        XDG_CONFIG_HOME: join(fakeHome, '.config'),
      },
      () => ensureSkillAssetsRepo({ assetsDir, logger: noop }),
    )
    expect(out.provisioned).toBe(true)
    expect(git(['log', '-1', '--format=%an <%ae>'], out.dir).trim()).toBe(
      'dsh-ia <dsh-ia@localhost>',
    )
    expect(git(['log', '-1', '--format=%cn <%ce>'], out.dir).trim()).toBe(
      'dsh-ia <dsh-ia@localhost>',
    )
  })
})

/* ================================================================== *
 * 额外 4：旧路径彻底消失
 * ================================================================== */

describe('[AC4] 旧路径彻底消失（不写 data/skills，不触碰真实 home）', () => {
  it('显式 assetsDir 时：同根下不产生 data/ 与 data/skills', () => {
    const root = mkTmp('t100464-ac4-explicit-')
    const out = ensureSkillAssetsRepo({ assetsDir: join(root, 'assets'), logger: noop })
    expect(out.dir).toBe(join(root, 'assets', 'skills'))
    expect(existsSync(join(root, 'data', 'skills'))).toBe(false)
    expect(existsSync(join(root, 'data'))).toBe(false)
  })

  it('DSH_IA_HOME=<tmp> 默认路径时：不产生 <tmp>/data/skills；HOME 指向的假 home 不被创建 .dsh-ia', () => {
    const root = mkTmp('t100464-ac4-env-')
    const home = join(root, 'env-home')
    const fakeHome = join(root, 'fake-home')
    mkdirSync(fakeHome, { recursive: true })

    const out = withEnv({ [FINANCE_HOME_ENV]: home, HOME: fakeHome }, () =>
      ensureSkillAssetsRepo({ logger: noop }),
    )
    expect(out.dir).toBe(join(home, 'assets', 'skills'))
    expect(out.provisioned).toBe(true)
    expect(existsSync(join(home, 'data', 'skills'))).toBe(false)
    expect(existsSync(join(home, 'data'))).toBe(false)
    // HOME 未被消费（DSH_IA_HOME 完全覆盖默认 home）。
    expect(existsSync(join(fakeHome, '.dsh-ia'))).toBe(false)
  })
})

/* ================================================================== *
 * 额外 5：环境变量语义
 * ================================================================== */

describe('[AC5] DSH_IA_HOME 决定 skills 路径；DSH_IA_DATA_DIR 不再影响', () => {
  it('DSH_IA_HOME=<tmp>/home 时默认路径为 <tmp>/home/assets/skills', () => {
    const root = mkTmp('t100464-ac5-home-')
    const home = join(root, 'home')
    const out = withEnv({ [FINANCE_HOME_ENV]: home, [DATA_ROOT_ENV]: undefined }, () => {
      const resolved = resolveAssetsDir()
      expect(resolved).toBe(join(home, 'assets'))
      expect(resolveSkillsRepoDir(resolved)).toBe(join(home, 'assets', 'skills'))
      return ensureSkillAssetsRepo({ logger: noop })
    })
    expect(out.dir).toBe(join(home, 'assets', 'skills'))
    expect(existsSync(join(home, 'assets', 'skills', '.git'))).toBe(true)
  })

  it('设置 DSH_IA_DATA_DIR（含预置的旧 skills 仓库）不会改变 skills 落点', () => {
    const root = mkTmp('t100464-ac5-legacy-')
    const home = join(root, 'home')
    const legacyData = join(root, 'legacy-data')
    // 制造「旧路径已有 skills 内容」的现场：若仍读旧语义，会误判为已就绪而 no-op。
    const legacyRepo = join(legacyData, 'skills')
    mkdirSync(join(legacyRepo, 'legacy-only'), { recursive: true })
    writeFileSync(
      join(legacyRepo, 'legacy-only', SKILL_FILENAME),
      '---\nname: legacy-only\ndescription: 旧路径残留\nwhenToUse: 不应被读取\n---\n\n旧正文\n',
      'utf8',
    )

    const out = withEnv(
      { [FINANCE_HOME_ENV]: home, [DATA_ROOT_ENV]: legacyData },
      () => ensureSkillAssetsRepo({ logger: noop }),
    )

    // 落在新资产层，且确实执行了预置（未被旧目录「骗过」）。
    expect(out.dir).toBe(join(home, 'assets', 'skills'))
    expect(out.provisioned).toBe(true)
    expect(existsSync(join(out.dir, 'trend-analysis', SKILL_FILENAME))).toBe(true)
    // 旧路径未被初始化 / 未被写入。
    expect(existsSync(join(legacyRepo, '.git'))).toBe(false)
    expect(existsSync(join(legacyRepo, 'trend-analysis'))).toBe(false)
    // 也不存在 <home>/data/skills。
    expect(existsSync(join(home, 'data', 'skills'))).toBe(false)
  })
})

/* ================================================================== *
 * 额外 6：无兼容别名
 * ================================================================== */

describe('[AC6] 源码无 compat 别名 dataRoot', () => {
  it('repo.ts / provider.ts / plugin.ts 中不出现 dataRoot，也不出现 DSH_IA_DATA_DIR', () => {
    const files = ['src/skills/repo.ts', 'src/skills/provider.ts', 'src/plugin.ts']
    for (const rel of files) {
      const source = readFileSync(join(REPO_ROOT, rel), 'utf8')
      expect(source, `${rel} 仍含 dataRoot`).not.toMatch(/dataRoot/)
      expect(source, `${rel} 仍引用 DSH_IA_DATA_DIR`).not.toContain('DSH_IA_DATA_DIR')
      // 正向锚定：新语义字段 assetsDir 存在。
      expect(source, `${rel} 缺少 assetsDir`).toContain('assetsDir')
    }
  })
})

/* ================================================================== *
 * 额外 7：幂等
 * ================================================================== */

describe('[AC7] 幂等', () => {
  it('连续两次 ensure：第二次 provisioned=false，commit 数不变，内容不变', () => {
    const assetsDir = mkTmp('t100464-ac7-')
    const first = ensureSkillAssetsRepo({ assetsDir, logger: noop })
    expect(first.provisioned).toBe(true)
    expect(commitCount(first.dir)).toBe(1)

    const before = SKILL_NAMES.map((n) =>
      readFileSync(join(first.dir, n, SKILL_FILENAME), 'utf8'),
    )

    const second = ensureSkillAssetsRepo({ assetsDir, logger: noop })
    expect(second.provisioned).toBe(false)
    expect(second.degraded).toBe(false)
    expect(second.dir).toBe(first.dir)
    expect(commitCount(first.dir)).toBe(1)

    const after = SKILL_NAMES.map((n) =>
      readFileSync(join(first.dir, n, SKILL_FILENAME), 'utf8'),
    )
    expect(after).toEqual(before)
    expect(git(['status', '--porcelain'], first.dir).trim()).toBe('')
  })
})

/* ================================================================== *
 * 额外 8：降级语义
 * ================================================================== */

describe('[AC8] 降级语义不被破坏', () => {
  it('gitRunner 全程抛错 → degraded:true、provisioned:false、不抛异常', () => {
    const assetsDir = mkTmp('t100464-ac8-fail-')
    const failing: GitRunner = () => {
      throw new Error('spawn git ENOENT')
    }
    const logs: string[] = []

    let out!: SkillAssetsRepoOutcome
    expect(() => {
      out = ensureSkillAssetsRepo({
        assetsDir,
        gitRunner: failing,
        logger: (message) => logs.push(message),
      })
    }).not.toThrow()

    expect(out.degraded).toBe(true)
    expect(out.provisioned).toBe(false)
    expect(out.dir).toBe(resolveSkillsRepoDir(assetsDir))
    expect(logs.join('\n')).toMatch(/降级/)
    expect(existsSync(join(out.dir, '.git'))).toBe(false)
  })

  it('仅 commit 阶段失败（git 命令非零退出）→ degraded:true、不抛异常', () => {
    const assetsDir = mkTmp('t100464-ac8-commit-')
    const partial: GitRunner = (args, cwd) => {
      if (args[0] === 'commit') throw new Error('commit failed: exit status 1')
      return git(args, cwd)
    }

    let out!: SkillAssetsRepoOutcome
    expect(() => {
      out = ensureSkillAssetsRepo({ assetsDir, gitRunner: partial, logger: noop })
    }).not.toThrow()

    expect(out.degraded).toBe(true)
    expect(out.provisioned).toBe(false)
    expect(commitCount(out.dir)).toBe(0)
  })
})
