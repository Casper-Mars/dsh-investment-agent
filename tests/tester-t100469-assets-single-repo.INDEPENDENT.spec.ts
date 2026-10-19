/**
 * 独立验收测试 —— t100469 任务-01「assets 单一仓库初始化接入（含 skills）」。
 *
 * 本文件由 Tester 独立编写，**不复用** Developer 的断言；核心链路一律走
 * 「真实 `apply(ctx)` + 真实系统 git + 临时 `DSH_IA_HOME`」，不使用 mock runner
 * 代替 init / add / commit（仅「降级」用例按设计注入真实不可用的 git）。
 *
 * 覆盖验收标准：
 *   AC1  唯一仓库：`<home>/assets/.git` 存在，`<home>/assets/skills/.git` 不存在；
 *   AC2  `git status` 能看到 skills 下「文件本身」，不是 gitlink；
 *   AC3  首次提交恰含 5 个 `skills/<name>/SKILL.md`（不含 3 个固有 skill）；
 *   AC4  二次启动 no-op，不产生新 commit；
 *   AC5  由外部命令跑定向 + 全量测试（见报告）；
 *   AC6  本机真实 `~/.dsh-ia/assets` 只读核对（不写、不删）；
 *   AC7  `.gitignore` 不排除 `skills/`，仅留 `.DS_Store` / `*.tmp` 等；
 *   AC8  失败降级：git 不可用 / 无写权限 / 路径不可用 → 装载不中断。
 *
 * 对抗场景：
 *   - 已有 HEAD + 脏改动（改 / 增 / 删）→ `commitAssetsChanges` 严格 no-op；
 *   - 半初始化：有 `.git` 无 HEAD、有种子无 `.git`、空目录、缺失目录；
 *   - 历史 `.gitignore` 含 `skills/` 排除 → 就地移除；
 *   - gitlink：`git ls-files -s` 全为 `100644`，无 `160000`；
 *   - 存量嵌套仓库（`skills/.git`）未清理时的真实行为（风险探测）。
 *
 * 隔离：所有写入均在 `mkdtempSync()` 临时目录；真实 `~/.dsh-ia` 仅做只读命令
 * （`ls` / `cat` / `git --no-optional-locks status` / `git ls-files`）。
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, chmodSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { apply } from '../src/plugin.js'
import {
  ASSETS_GITIGNORE,
  INITIAL_COMMIT_MESSAGE,
  commitAssetsChanges,
  ensureAssetsRepo,
} from '../src/assets/repo.js'
import { SKILL_NAMES } from '../src/skills/index.js'
import { SKILL_FILENAME } from '../src/skills/repo.js'
import { mountSkillFilesystemProviderAsync } from '../src/skills/provider.js'
import { FINANCE_HOME_ENV } from '../src/flags.js'

/** 仓库根（源码态），用于读取随包种子原文。 */
const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))

/** 静默 logger（避免测试输出噪音）。 */
const noop = (): void => {}

/** 本文件创建的全部临时目录，统一清理。 */
const tmpDirs: string[] = []

/** 建临时目录并登记。 */
function mkTmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tmpDirs.push(dir)
  return dir
}

/** 系统 git（仅用于断言 / 造场景，不注入身份）。 */
function git(args: string[], cwd: string): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

/** git 是否失败（返回 true 表示非零退出 / 不可用）。 */
function gitFails(args: string[], cwd: string): boolean {
  try {
    git(args, cwd)
    return false
  } catch {
    return true
  }
}

/** 提交数（无 HEAD 时 0）。 */
function commitCount(repoDir: string): number {
  try {
    return Number(git(['rev-list', '--count', 'HEAD'], repoDir).trim())
  } catch {
    return 0
  }
}

/** HEAD 提交 id（无 HEAD 时抛错）。 */
function headId(repoDir: string): string {
  return git(['rev-parse', 'HEAD'], repoDir).trim()
}

/** 提交后的完整文件树（相对路径，已排序）。 */
function treeOfHead(repoDir: string): string[] {
  return git(['ls-tree', '-r', '--name-only', 'HEAD'], repoDir)
    .trim()
    .split('\n')
    .filter(Boolean)
    .sort()
}

/** `git ls-files -s` 的 mode 列表（形如 `100644` / `160000`）。 */
function modesOf(repoDir: string, pathspec?: string): string[] {
  const args = ['ls-files', '-s']
  if (pathspec) args.push('--', pathspec)
  return git(args, repoDir)
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => line.split(/\s+/)[0])
}

/** 随包首版种子原文（`src/skills/<name>/SKILL.md`）。 */
function seedBytes(name: string): string {
  return readFileSync(join(REPO_ROOT, 'src', 'skills', name, SKILL_FILENAME), 'utf8')
}

/** 期望的首次提交文件树：`.gitignore` + 5 个可进化 SKILL.md。 */
function expectedTree(): string[] {
  return ['.gitignore', ...SKILL_NAMES.map((n) => `skills/${n}/${SKILL_FILENAME}`)].sort()
}

/**
 * 最小 mock ctx：`apply()` 内所有非本任务链路（tools / session / scheduler /
 * provider）都会因服务缺失而降级；但 effect / get / inject 齐备，足以让
 * assets 装配链路真实执行。
 */
/** 静默原生 logger 实例（同时作为 scope 工厂，满足 `isNativeLoggerService` 形态）。 */
const silentLoggerInstance = {
  debug: (): void => {},
  info: (): void => {},
  warn: (): void => {},
  error: (): void => {},
  exporter: (): void => {},
}

const silentNativeLogger = Object.assign(
  (_scope?: string): typeof silentLoggerInstance => silentLoggerInstance,
  silentLoggerInstance,
)

function makeMinimalCtx(): Context {
  return {
    logger: silentNativeLogger,
    effect(body: () => unknown) {
      const disposer = body()
      return typeof disposer === 'function' ? (disposer as () => void) : () => {}
    },
    get() {
      return undefined
    },
    inject() {
      return {}
    },
    plugin() {
      // 不真正挂载 provider（本文件不测 watch），但让装配链路「成功」以免降级日志噪音；
      // provider 的实际扫描目录由上方用例独立验证。
      return { dispose: async (): Promise<void> => {} }
    },
  } as unknown as Context
}

/** 在指定 home 下真实跑一次插件装载（`apply`）。 */
function runApply(home: string): void {
  const prev = process.env[FINANCE_HOME_ENV]
  process.env[FINANCE_HOME_ENV] = home
  try {
    expect(() => apply(makeMinimalCtx())).not.toThrow()
  } finally {
    if (prev === undefined) delete process.env[FINANCE_HOME_ENV]
    else process.env[FINANCE_HOME_ENV] = prev
  }
}

let tmpRoot: string

beforeEach(() => {
  // 每个用例独立临时根：`<tmp>/home` 作为 DSH_IA_HOME，`<tmp>/home/assets` 为资产层。
  tmpRoot = mkTmp('dsh-ia-t100469-')
})

afterEach(() => {
  // 恢复可能被用例改动的权限（否则 rmSync 可能失败）。
  for (const dir of [join(tmpRoot, 'home', 'assets'), join(tmpRoot, 'home')]) {
    try {
      if (existsSync(dir)) chmodSync(dir, 0o755)
    } catch {
      /* ignore */
    }
  }
})

afterAll(() => {
  for (const dir of tmpDirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  }
})

/* ================================================================== *
 * AC1 / AC2 / AC3：真实 apply() 冷启动 —— 单仓 + 5 个 SKILL.md + 首提
 * ================================================================== */

describe('AC1/AC2/AC3 真实 apply() 冷启动（单仓）', { timeout: 30000 }, () => {
  it('只产生一个仓库；首提恰含 5 个 SKILL.md；全为 100644；工作区干净', () => {
    const home = join(tmpRoot, 'home')
    const assetsDir = join(home, 'assets')

    runApply(home)

    // AC1：唯一仓库。
    expect(existsSync(join(assetsDir, '.git'))).toBe(true)
    expect(existsSync(join(assetsDir, 'skills', '.git'))).toBe(false)

    // AC2：skills 下是普通文件（100644），无 gitlink（160000）。
    const modes = modesOf(assetsDir, 'skills')
    expect(modes.length).toBe(SKILL_NAMES.length)
    expect(modes.every((m) => m === '100644')).toBe(true)
    expect(modes).not.toContain('160000')

    // AC3：首次提交恰 1 个，文件树精确匹配（不含 task-authorship 等固有 skill）。
    expect(commitCount(assetsDir)).toBe(1)
    expect(git(['log', '-1', '--pretty=%s'], assetsDir).trim()).toBe(INITIAL_COMMIT_MESSAGE)
    expect(treeOfHead(assetsDir)).toEqual(expectedTree())
    for (const name of SKILL_NAMES) {
      expect(treeOfHead(assetsDir)).toContain(`skills/${name}/${SKILL_FILENAME}`)
    }
    for (const intrinsic of ['task-authorship', 'skill-authorship', 'finance-evolution']) {
      expect(existsSync(join(assetsDir, 'skills', intrinsic))).toBe(false)
    }

    // 工作区干净（所有种子与 .gitignore 都已入库）。
    expect(git(['--no-optional-locks', 'status', '--porcelain'], assetsDir).trim()).toBe('')
  })

  it('落盘内容逐字节等于随包种子，且 HEAD 与磁盘一致（无覆盖 / 无规范化）', () => {
    const home = join(tmpRoot, 'home')
    const assetsDir = join(home, 'assets')

    runApply(home)

    for (const name of SKILL_NAMES) {
      const rel = `skills/${name}/${SKILL_FILENAME}`
      const onDisk = readFileSync(join(assetsDir, 'skills', name, SKILL_FILENAME), 'utf8')
      const inHead = git(['show', `HEAD:${rel}`], assetsDir)
      expect(onDisk, `${name} 落盘内容`).toBe(seedBytes(name))
      expect(inHead, `${name} 入库内容`).toBe(seedBytes(name))
    }
  })

  it('AC7：.gitignore 只排除系统/临时文件，不排除 skills/', () => {
    const home = join(tmpRoot, 'home')
    const assetsDir = join(home, 'assets')

    runApply(home)

    const content = readFileSync(join(assetsDir, '.gitignore'), 'utf8')
    expect(content).toBe(ASSETS_GITIGNORE)
    expect(content).toContain('.DS_Store')
    expect(content).toContain('*.tmp')
    expect(content).not.toMatch(/^\s*\/?skills\/?\s*$/m)

    // git 视角：skills 下的文件不被忽略（check-ignore 未命中 → 非零退出）。
    expect(gitFails(['check-ignore', '-q', '--', `skills/${SKILL_NAMES[0]}/${SKILL_FILENAME}`], assetsDir)).toBe(true)
  })

  it('provider 仍指向 <assetsDir>/skills（路径未漂移）', async () => {
    const home = join(tmpRoot, 'home')
    const assetsDir = join(home, 'assets')
    const prev = process.env[FINANCE_HOME_ENV]
    process.env[FINANCE_HOME_ENV] = home
    try {
      const captured: Array<Record<string, unknown>> = []
      const ctx = {
        plugin(_mod: unknown, config: Record<string, unknown>) {
          captured.push(config)
          return { dispose: async () => {} }
        },
      }
      const mount = await mountSkillFilesystemProviderAsync(ctx as unknown as Context, { watch: false })
      expect(captured).toHaveLength(1)
      expect(captured[0].customSkillDirs).toEqual([join(assetsDir, 'skills')])
      expect(captured[0].includeDefaultRoots).toBe(false)
      expect(mount.dir).toBe(join(assetsDir, 'skills'))
      await mount.dispose()
    } finally {
      if (prev === undefined) delete process.env[FINANCE_HOME_ENV]
      else process.env[FINANCE_HOME_ENV] = prev
    }
  }, 20000)
})

/* ================================================================== *
 * AC4：二次启动 no-op
 * ================================================================== */

describe('AC4 二次启动 no-op', { timeout: 30000 }, () => {
  it('同一 home 连续两次 apply：commit 数与 HEAD 均不变', () => {
    const home = join(tmpRoot, 'home')
    const assetsDir = join(home, 'assets')

    runApply(home)
    const firstHead = headId(assetsDir)
    const firstCount = commitCount(assetsDir)
    expect(firstCount).toBe(1)

    runApply(home)

    expect(commitCount(assetsDir)).toBe(firstCount)
    expect(headId(assetsDir)).toBe(firstHead)
    expect(git(['log', '--pretty=%s'], assetsDir).trim()).toBe(INITIAL_COMMIT_MESSAGE)
    expect(git(['--no-optional-locks', 'status', '--porcelain'], assetsDir).trim()).toBe('')
  })

  it('已有 HEAD + 未提交修改/新增 → 再启动严格 no-op（不 add、不 commit、脏改动保留）', () => {
    const home = join(tmpRoot, 'home')
    const assetsDir = join(home, 'assets')

    runApply(home)
    const headBefore = headId(assetsDir)
    const target = join(assetsDir, 'skills', SKILL_NAMES[0], SKILL_FILENAME)
    const original = readFileSync(target, 'utf8')
    const edited = `${original}\n<!-- agent edit pending rationale -->\n`
    writeFileSync(target, edited, 'utf8')
    writeFileSync(join(assetsDir, 'agent-note.md'), 'pending evolution\n', 'utf8')

    runApply(home)

    // 未产生新提交，HEAD 未变。
    expect(commitCount(assetsDir)).toBe(1)
    expect(headId(assetsDir)).toBe(headBefore)
    // 脏改动原样保留，且没有被 stage。
    expect(git(['diff', '--cached', '--name-only'], assetsDir).trim()).toBe('')
    const status = git(['--no-optional-locks', 'status', '--porcelain'], assetsDir)
    expect(status).toContain(` M skills/${SKILL_NAMES[0]}/${SKILL_FILENAME}`)
    expect(status).toContain('?? agent-note.md')
    expect(readFileSync(target, 'utf8')).toBe(edited)
    // HEAD 中仍是种子原文（未被启动流程吞掉编辑）。
    expect(git(['show', `HEAD:skills/${SKILL_NAMES[0]}/${SKILL_FILENAME}`], assetsDir)).toBe(original)
  })

  it('已有 HEAD + 删除 SKILL.md → 启动按种子补齐（不产生新 commit）', () => {
    const home = join(tmpRoot, 'home')
    const assetsDir = join(home, 'assets')

    runApply(home)
    const headBefore = headId(assetsDir)
    const target = join(assetsDir, 'skills', SKILL_NAMES[1], SKILL_FILENAME)
    rmSync(target)
    expect(existsSync(target)).toBe(false)

    runApply(home)

    // 幂等落盘语义：缺失的 SKILL.md 会被种子补齐（内容与 HEAD 一致 → 工作区仍干净），
    // 但绝不因此产生新提交。
    expect(existsSync(target)).toBe(true)
    expect(readFileSync(target, 'utf8')).toBe(seedBytes(SKILL_NAMES[1]))
    expect(headId(assetsDir)).toBe(headBefore)
    expect(commitCount(assetsDir)).toBe(1)
    expect(git(['diff', '--cached', '--name-only'], assetsDir).trim()).toBe('')
    expect(git(['--no-optional-locks', 'status', '--porcelain'], assetsDir).trim()).toBe('')
  })
})

/* ================================================================== *
 * 半初始化：各种中间态都能收敛到正确结果
 * ================================================================== */

describe('半初始化状态收敛', { timeout: 30000 }, () => {
  it('有 .git 无 HEAD + 已存在 agent 编辑的 SKILL.md → 首提保留编辑内容', () => {
    const home = join(tmpRoot, 'home')
    const assetsDir = join(home, 'assets')
    mkdirSync(assetsDir, { recursive: true })
    git(['init', '-b', 'main'], assetsDir)
    const edited = '# agent edited before first snapshot\n'
    mkdirSync(join(assetsDir, 'skills', SKILL_NAMES[0]), { recursive: true })
    writeFileSync(join(assetsDir, 'skills', SKILL_NAMES[0], SKILL_FILENAME), edited, 'utf8')

    runApply(home)

    expect(commitCount(assetsDir)).toBe(1)
    expect(git(['show', `HEAD:skills/${SKILL_NAMES[0]}/${SKILL_FILENAME}`], assetsDir)).toBe(edited)
    expect(readFileSync(join(assetsDir, 'skills', SKILL_NAMES[0], SKILL_FILENAME), 'utf8')).toBe(edited)
    // 其余 4 个由种子补齐。
    expect(modesOf(assetsDir, 'skills')).toHaveLength(SKILL_NAMES.length)
    expect(modesOf(assetsDir, 'skills').every((m) => m === '100644')).toBe(true)
  }, 20000)

  it('有种子无 .git → 初始化后首提包含既有种子（不被覆盖）', () => {
    const home = join(tmpRoot, 'home')
    const assetsDir = join(home, 'assets')
    mkdirSync(join(assetsDir, 'skills', SKILL_NAMES[0]), { recursive: true })
    const custom = '# pre-existing skill seed\n'
    writeFileSync(join(assetsDir, 'skills', SKILL_NAMES[0], SKILL_FILENAME), custom, 'utf8')

    runApply(home)

    expect(existsSync(join(assetsDir, '.git'))).toBe(true)
    expect(commitCount(assetsDir)).toBe(1)
    expect(git(['show', `HEAD:skills/${SKILL_NAMES[0]}/${SKILL_FILENAME}`], assetsDir)).toBe(custom)
    expect(git(['--no-optional-locks', 'status', '--porcelain'], assetsDir).trim()).toBe('')
    expect(treeOfHead(assetsDir)).toEqual(expectedTree())
  }, 20000)

  it('只有空 assets 目录 → 正常初始化并首提', () => {
    const home = join(tmpRoot, 'home')
    const assetsDir = join(home, 'assets')
    mkdirSync(assetsDir, { recursive: true })

    runApply(home)

    expect(commitCount(assetsDir)).toBe(1)
    expect(treeOfHead(assetsDir)).toEqual(expectedTree())
  }, 20000)

  it('assets 目录整体缺失 → 自动创建并首提', () => {
    const home = join(tmpRoot, 'home')
    mkdirSync(home, { recursive: true })

    runApply(home)

    const assetsDir = join(home, 'assets')
    expect(existsSync(assetsDir)).toBe(true)
    expect(commitCount(assetsDir)).toBe(1)
    expect(treeOfHead(assetsDir)).toEqual(expectedTree())
  }, 20000)

  it('空目录 + 历史 .gitignore（含 skills/ 排除）→ 就地移除该规则并纳入 skills', () => {
    const home = join(tmpRoot, 'home')
    const assetsDir = join(home, 'assets')
    mkdirSync(assetsDir, { recursive: true })
    writeFileSync(join(assetsDir, '.gitignore'), 'skills/\nnode_modules/\n.DS_Store\n', 'utf8')

    runApply(home)

    const content = readFileSync(join(assetsDir, '.gitignore'), 'utf8')
    expect(content).toBe(ASSETS_GITIGNORE)
    expect(content).not.toMatch(/^\s*\/?skills\/?\s*$/m)
    expect(modesOf(assetsDir, 'skills').every((m) => m === '100644')).toBe(true)
    expect(commitCount(assetsDir)).toBe(1)
    // skills 下文件确实入库（不是被忽略）。
    expect(treeOfHead(assetsDir)).toContain(`skills/${SKILL_NAMES[0]}/${SKILL_FILENAME}`)
  }, 20000)

  it('历史 .gitignore 变体 `/skills/` 同样被就地清除', () => {
    const home = join(tmpRoot, 'home')
    const assetsDir = join(home, 'assets')
    mkdirSync(assetsDir, { recursive: true })
    writeFileSync(join(assetsDir, '.gitignore'), '/skills/\n', 'utf8')

    runApply(home)

    expect(readFileSync(join(assetsDir, '.gitignore'), 'utf8')).toBe(ASSETS_GITIGNORE)
    expect(treeOfHead(assetsDir)).toContain(`skills/${SKILL_NAMES[0]}/${SKILL_FILENAME}`)
  }, 20000)

  it('非历史 .gitignore（无 skills 排除）→ 原样保留，不重写', () => {
    const home = join(tmpRoot, 'home')
    const assetsDir = join(home, 'assets')
    mkdirSync(assetsDir, { recursive: true })
    const custom = '# user rules\n*.log\n'
    writeFileSync(join(assetsDir, '.gitignore'), custom, 'utf8')

    runApply(home)

    expect(readFileSync(join(assetsDir, '.gitignore'), 'utf8')).toBe(custom)
  }, 20000)
})

/* ================================================================== *
 * AC8：失败降级（装载不中断）
 * ================================================================== */

describe('AC8 降级不中断装载', { timeout: 30000 }, () => {
  it('git 不可用（PATH 为空）→ apply 不抛，seed 仍落盘，仅缺 .git', () => {
    const home = join(tmpRoot, 'home')
    const assetsDir = join(home, 'assets')
    mkdirSync(home, { recursive: true })
    const prevPath = process.env.PATH

    process.env.PATH = ''
    try {
      // 直接调用：应返回 degraded 而不是抛错。
      const outcome = ensureAssetsRepo({ assetsDir, logger: noop })
      expect(outcome.degraded).toBe(true)
      expect(outcome.initialized).toBe(false)

      runApply(home)
    } finally {
      process.env.PATH = prevPath
    }

    // 装载未中断：5 个 SKILL.md 仍落盘（种子不依赖 git）。
    for (const name of SKILL_NAMES) {
      expect(existsSync(join(assetsDir, 'skills', name, SKILL_FILENAME)), `${name} 应已落盘`).toBe(true)
    }
    expect(existsSync(join(assetsDir, '.git'))).toBe(false)
    // commit 阶段同样降级，不产生提交。
    const commit = commitAssetsChanges({ dir: assetsDir, logger: noop })
    expect(commit.committed).toBe(false)
    expect(commit.degraded).toBe(true)
  }, 20000)

  it('资产目录无写权限 → 降级不抛，插件装载继续', () => {
    const home = join(tmpRoot, 'home')
    const assetsDir = join(home, 'assets')
    mkdirSync(assetsDir, { recursive: true })
    chmodSync(assetsDir, 0o555)

    const outcome = ensureAssetsRepo({ assetsDir, logger: noop })
    expect(outcome.degraded).toBe(true)
    expect(outcome.initialized).toBe(false)

    runApply(home)
    expect(existsSync(join(assetsDir, '.git'))).toBe(false)

    chmodSync(assetsDir, 0o755)
  }, 20000)

  it('skills 路径被普通文件占位 → apply 不抛（种子落盘降级）', () => {
    const home = join(tmpRoot, 'home')
    const assetsDir = join(home, 'assets')
    mkdirSync(assetsDir, { recursive: true })
    writeFileSync(join(assetsDir, 'skills'), 'not a directory', 'utf8')

    expect(statSync(join(assetsDir, 'skills')).isFile()).toBe(true)
    runApply(home)
    // 文件未被破坏，仓库仍可就绪（commit 因无可加入的 skills 内容而只含 .gitignore）。
    expect(readFileSync(join(assetsDir, 'skills'), 'utf8')).toBe('not a directory')
    expect(existsSync(join(assetsDir, '.git'))).toBe(true)
  }, 20000)
})

/* ================================================================== *
 * 风险探测：存量嵌套仓库未清理时的真实行为（不计入 AC 失败）
 * ================================================================== */

describe('风险探测：存量 skills/.git 未清理', { timeout: 30000 }, () => {
  it('嵌套仓库有提交 → 首提记录 160000 gitlink（内容不进外层历史）', () => {
    const home = join(tmpRoot, 'home')
    const assetsDir = join(home, 'assets')
    // 存量形态：`<assetsDir>/skills/.git` 是**嵌套独立仓库**（skill 自有历史）。
    const skillsDir = join(assetsDir, 'skills')
    mkdirSync(join(skillsDir, SKILL_NAMES[0]), { recursive: true })
    git(['init', '-b', 'main'], skillsDir)
    writeFileSync(join(skillsDir, SKILL_NAMES[0], SKILL_FILENAME), '# legacy nested\n', 'utf8')
    git(['add', '-A'], skillsDir)
    git(['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-m', 'legacy'], skillsDir)

    runApply(home)

    // 当前实现不清理存量嵌套仓库：skills 被记为 gitlink。
    expect(existsSync(join(assetsDir, 'skills', '.git'))).toBe(true)
    expect(modesOf(assetsDir, 'skills')).toEqual(['160000'])
    expect(git(['ls-files', '--', 'skills'], assetsDir).trim()).toBe('skills')
  }, 20000)

  it('嵌套仓库无提交 → git add -A 失败，首次快照降级（无 HEAD）', () => {
    const home = join(tmpRoot, 'home')
    const assetsDir = join(home, 'assets')
    const skillsDir = join(assetsDir, 'skills')
    mkdirSync(join(skillsDir, SKILL_NAMES[0]), { recursive: true })
    git(['init', '-b', 'main'], skillsDir)
    writeFileSync(join(skillsDir, SKILL_NAMES[0], SKILL_FILENAME), '# legacy nested, no commit\n', 'utf8')

    runApply(home)

    expect(existsSync(join(assetsDir, '.git'))).toBe(true)
    expect(commitCount(assetsDir)).toBe(0)
    const outcome = commitAssetsChanges({ dir: assetsDir, logger: noop })
    expect(outcome.degraded).toBe(true)
    expect(outcome.committed).toBe(false)
  }, 20000)
})

/* ================================================================== *
 * AC6：本机真实 ~/.dsh-ia/assets 只读核对
 * ================================================================== */

describe('AC6 本机真实 assets 目录（只读）', { timeout: 30000 }, () => {
  it('唯一仓库 / 无嵌套 .git / 无 gitlink / 无 skills 排除', () => {
    const realAssets = join(homedir(), '.dsh-ia', 'assets')
    if (!existsSync(realAssets)) {
      // 本机未初始化过：不构成失败（该 AC 的前提是「存量已处理」）。
      expect(existsSync(join(homedir(), '.dsh-ia'))).toBe(false)
      return
    }

    // 只读命令：ls / cat / git status / git ls-files。
    expect(existsSync(join(realAssets, 'skills', '.git'))).toBe(false)
    if (!existsSync(join(realAssets, '.git'))) return

    const status = execFileSync('git', ['--no-optional-locks', 'status', '--porcelain'], {
      cwd: realAssets,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    // 允许存量历史遗留（未跟踪/已修改），但不得出现 gitlink 记录。
    expect(status).not.toMatch(/^[ MADRCU?!]{2} skills$/m)

    const modes = git(['ls-files', '-s', '--', 'skills'], realAssets)
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => line.split(/\s+/)[0])
    expect(modes).not.toContain('160000')
    expect(modes.every((m) => m === '100644')).toBe(true)

    const gitignore = readFileSync(join(realAssets, '.gitignore'), 'utf8')
    expect(gitignore).not.toMatch(/^\s*\/?skills\/?\s*$/m)
  })
})
