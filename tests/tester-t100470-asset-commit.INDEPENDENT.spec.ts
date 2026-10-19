/**
 * t100470 任务-02「资产写入即 commit」独立运行时验证（tester）。
 *
 * 与开发者自带 `tests/assets-commit.test.ts` 完全独立：本文件不 import 其任何
 * helper，所有断言均从**外部可观察事实**（真实 fs + 真实 `git` 子进程）取证。
 *
 * 覆盖验收标准：
 *   AC1 改 task / program / skill 后各自有 commit，作者 dsh-ia；
 *   AC2 连续两次相同写入不产生空 commit；
 *   AC3 三种资产共享同一 assets git log；
 *   AC4 成功路径 + git 失败路径；
 *   AC5 commit message 含相对路径与动作 create/update/delete；
 *   AC6 git 失败降级告警、不中断业务（文件仍落盘）；
 *   AC7 skill 直接写文件后有统一提交入口 asset_commit。
 *
 * 重点对抗场景：
 *   - 只提交指定路径（无关未跟踪 / 无关已 staged 文件都不得被带走）；
 *   - 注入抛错 gitRunner（add 阶段失败、仅 commit 阶段失败、仓库缺 .git）；
 *   - 非法路径（绝对 / .. / .git / 反斜杠 / data/ 前缀 …）抛错且零 commit；
 *   - 真实链路：临时 DSH_IA_HOME + 真实 TaskStore / createSchedulerTools；
 *   - 真实插件装载：22 工具（asset_commit 可见）、createAllTools 15。
 *
 * 隔离：所有写入都在 `mkdtemp` 临时目录；`DSH_IA_HOME` 在 beforeEach 指向临时
 * home 并在 afterEach 还原；绝不写真实 `~/.dsh-ia`（只读语义都不需要）。
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
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import { Context } from '@deepseek-ai/cordis'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import {
  AssetPathError,
  commitAssets,
  normalizeAssetPath,
  normalizeAssetPaths,
} from '../src/assets/commit.js'
import {
  GIT_IDENTITY_EMAIL,
  GIT_IDENTITY_NAME,
  type GitRunner,
} from '../src/assets/git.js'
import { ensureAssetsRepo } from '../src/assets/repo.js'
import { apply as applyPlugin, inject as pluginInject, name as pluginName } from '../src/plugin.js'
import { TaskStore } from '../src/scheduler/store.js'
import { createSchedulerTools } from '../src/scheduler/tools.js'
import type { TaskDef } from '../src/scheduler/types.js'
import { createAssetCommitTool } from '../src/tools/assets.js'
import { createToolContext } from '../src/tools/context.js'
import { createAllTools } from '../src/tools/index.js'
import { resolveAssetsDir, resolveAssetsTasksDir } from '../src/paths.js'

// ---------------------------------------------------------------------------
// 测试夹具
// ---------------------------------------------------------------------------

let home: string
let assetsDir: string
let tasksDir: string
let prevHome: string | undefined

/** 未 aborted 的工具执行上下文。 */
function makeExec(): { signal: AbortSignal } {
  return { signal: new AbortController().signal }
}

/** 直接调系统 git（仅取证用，不经过被测代码）。 */
function git(args: string[], cwd: string = assetsDir): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

/** 当前提交数；仓库尚无 HEAD 时返回 0。 */
function commitCount(cwd: string = assetsDir): number {
  try {
    return Number(git(['rev-list', '--count', 'HEAD'], cwd).trim())
  } catch {
    return 0
  }
}

/** 最近一次提交 subject。 */
function lastSubject(cwd: string = assetsDir): string {
  return git(['log', '-1', '--pretty=%s'], cwd).trim()
}

/** 最近一次提交作者 `Name <email>`。 */
function lastAuthor(cwd: string = assetsDir): string {
  return git(['log', '-1', '--pretty=%an <%ae>'], cwd).trim()
}

/** 最近一次提交 committer `Name <email>`。 */
function lastCommitter(cwd: string = assetsDir): string {
  return git(['log', '-1', '--pretty=%cn <%ce>'], cwd).trim()
}

/** HEAD 提交实际包含的文件（相对仓库根，已排序）。 */
function committedFiles(cwd: string = assetsDir): string[] {
  return git(['show', '--name-only', '--pretty=format:', 'HEAD'], cwd)
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .sort()
}

/** 指定路径的 porcelain 状态（空字符串 = clean / 无变化）。 */
function statusOf(path: string, cwd: string = assetsDir): string {
  return git(['status', '--porcelain', '--', path], cwd).trim()
}

/** 写资产文件（自动建父目录）。 */
function writeAsset(rel: string, content: string): string {
  const abs = join(assetsDir, rel)
  mkdirSync(dirname(abs), { recursive: true })
  writeFileSync(abs, content, 'utf8')
  return abs
}

/** 构造合法 TaskDef。 */
function makeTask(id: string, overrides: Partial<TaskDef> = {}): TaskDef {
  return {
    id,
    name: `任务-${id}`,
    cron: '0 9 * * *',
    task_path: `assets/programs/${id}/task.ts`,
    enabled: true,
    ...overrides,
  }
}

/** 注入用的「git 完全不可用」执行器。 */
const boom: GitRunner = () => {
  throw new Error('git unavailable (injected)')
}

/** 记录告警的 logger。 */
function collectingLogger(): { messages: string[]; logger: (m: string) => void } {
  const messages: string[] = []
  return { messages, logger: (m) => messages.push(m) }
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'tester-t100470-'))
  prevHome = process.env.DSH_IA_HOME
  process.env.DSH_IA_HOME = home
  assetsDir = resolveAssetsDir()
  tasksDir = resolveAssetsTasksDir()

  const ensured = ensureAssetsRepo({ assetsDir, logger: () => {} })
  expect(ensured.degraded).toBe(false)
})

afterEach(() => {
  if (prevHome === undefined) delete process.env.DSH_IA_HOME
  else process.env.DSH_IA_HOME = prevHome
  rmSync(home, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// AC1 / AC3 / AC5：成功路径、动作、message、作者、单一历史
// ---------------------------------------------------------------------------

describe('AC1/AC3/AC5 成功路径：三种资产写入即 commit', () => {
  it('skill create：message 含 create + 相对路径，作者/提交者均为 dsh-ia', () => {
    writeAsset('skills/demo/SKILL.md', '# demo\n')

    const outcome = commitAssets({ assetsDir, paths: ['skills/demo/SKILL.md'], logger: () => {} })

    expect(outcome.degraded).toBe(false)
    expect(outcome.committed).toBe(true)
    expect(outcome.files).toEqual([{ path: 'skills/demo/SKILL.md', action: 'create' }])
    expect(outcome.commit).toMatch(/^[0-9a-f]{12}$/)
    expect(lastSubject()).toBe('assets: create skills/demo/SKILL.md')
    expect(lastAuthor()).toBe(`${GIT_IDENTITY_NAME} <${GIT_IDENTITY_EMAIL}>`)
    expect(lastCommitter()).toBe(`${GIT_IDENTITY_NAME} <${GIT_IDENTITY_EMAIL}>`)
    expect(committedFiles()).toEqual(['skills/demo/SKILL.md'])
  })

  it('program create：asset_commit 工具提交，message 含 create programs/...', async () => {
    writeAsset('programs/pulse/task.ts', 'export const pulse = 1\n')
    const tool = createAssetCommitTool({ assetsDir, logger: () => {} })

    const value = (await tool.execute(
      { paths: ['programs/pulse/task.ts'] },
      makeExec(),
    )) as {
      committed: boolean
      degraded: boolean
      files: Array<{ path: string; action: string }>
      commit?: string
    }

    expect(value.committed).toBe(true)
    expect(value.degraded).toBe(false)
    expect(value.files).toEqual([{ path: 'programs/pulse/task.ts', action: 'create' }])
    expect(lastSubject()).toBe('assets: create programs/pulse/task.ts')
    expect(lastAuthor()).toBe(`${GIT_IDENTITY_NAME} <${GIT_IDENTITY_EMAIL}>`)
  })

  it('task create → update → delete：三次 commit 动作与 message 正确', () => {
    const store = new TaskStore(tasksDir, { assetsDir, logger: () => {} })
    const task = makeTask('pulse')

    store.save(task)
    expect(commitCount()).toBe(1)
    expect(lastSubject()).toBe('assets: create tasks/pulse.json')

    store.save({ ...task, name: '任务-pulse-改' })
    expect(commitCount()).toBe(2)
    expect(lastSubject()).toBe('assets: update tasks/pulse.json')
    expect(lastAuthor()).toBe(`${GIT_IDENTITY_NAME} <${GIT_IDENTITY_EMAIL}>`)

    expect(store.remove('pulse')).toBe(true)
    expect(commitCount()).toBe(3)
    expect(lastSubject()).toBe('assets: delete tasks/pulse.json')
    expect(existsSync(join(tasksDir, 'pulse.json'))).toBe(false)
  })

  it('同一 commit 内 create / update / delete 三种动作都被正确识别并写入 message', () => {
    writeAsset('strategies/s.md', 'v1\n')
    writeAsset('programs/p/task.ts', 'v1\n')
    expect(
      commitAssets({
        assetsDir,
        paths: ['strategies/s.md', 'programs/p/task.ts'],
        logger: () => {},
      }).committed,
    ).toBe(true)
    expect(commitCount()).toBe(1)

    writeAsset('strategies/s.md', 'v2\n')
    rmSync(join(assetsDir, 'programs/p/task.ts'))
    writeAsset('skills/new/SKILL.md', '# new\n')

    const outcome = commitAssets({
      assetsDir,
      paths: ['strategies/s.md', 'programs/p/task.ts', 'skills/new/SKILL.md'],
      logger: () => {},
    })

    expect(outcome.committed).toBe(true)
    expect(outcome.files).toEqual(
      expect.arrayContaining([
        { path: 'strategies/s.md', action: 'update' },
        { path: 'programs/p/task.ts', action: 'delete' },
        { path: 'skills/new/SKILL.md', action: 'create' },
      ]),
    )
    expect(outcome.files).toHaveLength(3)
    const subject = lastSubject()
    expect(subject).toContain('update strategies/s.md')
    expect(subject).toContain('delete programs/p/task.ts')
    expect(subject).toContain('create skills/new/SKILL.md')
    expect(commitCount()).toBe(2)
  })

  it('自定义 message 前缀保留，同时仍追加每个资产的动作 + 相对路径', () => {
    writeAsset('skills/demo/SKILL.md', '# demo\n')
    commitAssets({
      assetsDir,
      paths: ['skills/demo/SKILL.md'],
      message: 'feat(skill): demo 首版',
      logger: () => {},
    })
    expect(lastSubject()).toBe('feat(skill): demo 首版: create skills/demo/SKILL.md')
  })

  it('AC3：skill / program / task 都出现在同一个 assets 仓库的 log 中', () => {
    writeAsset('skills/demo/SKILL.md', '# demo\n')
    writeAsset('programs/pulse/task.ts', 'export {}\n')
    const store = new TaskStore(tasksDir, { assetsDir, logger: () => {} })

    expect(commitAssets({ assetsDir, paths: ['skills/demo/SKILL.md'], logger: () => {} }).committed).toBe(true)
    expect(commitAssets({ assetsDir, paths: ['programs/pulse/task.ts'], logger: () => {} }).committed).toBe(true)
    store.save(makeTask('pulse'))

    expect(commitCount()).toBe(3)
    const log = git(['log', '--pretty=%s', '--name-only'])
    expect(log).toContain('skills/demo/SKILL.md')
    expect(log).toContain('programs/pulse/task.ts')
    expect(log).toContain('tasks/pulse.json')
    // 全部提交同属一个仓库：仓库根就是 assetsDir。
    expect(realpathSync(git(['rev-parse', '--show-toplevel']).trim())).toBe(realpathSync(assetsDir))
  })
})

// ---------------------------------------------------------------------------
// AC2：幂等 / 无空 commit
// ---------------------------------------------------------------------------

describe('AC2 相同内容连续写入不产生空 commit', () => {
  it('commitAssets 连续两次相同内容：第二次 no-op', () => {
    writeAsset('skills/demo/SKILL.md', '# demo\n')
    const first = commitAssets({ assetsDir, paths: ['skills/demo/SKILL.md'], logger: () => {} })
    const second = commitAssets({ assetsDir, paths: ['skills/demo/SKILL.md'], logger: () => {} })

    expect(first.committed).toBe(true)
    expect(second.committed).toBe(false)
    expect(second.degraded).toBe(false)
    expect(second.files).toEqual([])
    expect(second.reason).toContain('no-op')
    expect(commitCount()).toBe(1)
  })

  it('TaskStore.save 相同 TaskDef 两次：commit 数不增', () => {
    const store = new TaskStore(tasksDir, { assetsDir, logger: () => {} })
    const task = makeTask('pulse')
    store.save(task)
    store.save(task)
    expect(commitCount()).toBe(1)

    store.save({ ...task, name: '改名' })
    store.save({ ...task, name: '改名' })
    expect(commitCount()).toBe(2)
    expect(lastSubject()).toBe('assets: update tasks/pulse.json')
  })

  it('remove 同一任务两次：第二次返回 false 且不产生 commit', () => {
    const store = new TaskStore(tasksDir, { assetsDir, logger: () => {} })
    store.save(makeTask('pulse'))
    expect(commitCount()).toBe(1)

    expect(store.remove('pulse')).toBe(true)
    expect(commitCount()).toBe(2)
    expect(store.remove('pulse')).toBe(false)
    expect(commitCount()).toBe(2)
  })

  it('asset_commit 工具连续两次提交同一文件：第二次 committed=false，无空 commit', async () => {
    writeAsset('skills/demo/SKILL.md', '# demo\n')
    const tool = createAssetCommitTool({ assetsDir, logger: () => {} })

    const first = (await tool.execute({ paths: ['skills/demo/SKILL.md'] }, makeExec())) as {
      committed: boolean
    }
    const second = (await tool.execute({ paths: ['skills/demo/SKILL.md'] }, makeExec())) as {
      committed: boolean
      degraded: boolean
    }

    expect(first.committed).toBe(true)
    expect(second.committed).toBe(false)
    expect(second.degraded).toBe(false)
    expect(commitCount()).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// 对抗：只提交指定路径，不带走仓库里的其它改动
// ---------------------------------------------------------------------------

describe('对抗：只提交指定路径', () => {
  it('无关未跟踪文件（根目录 noise.txt + skills/other/SKILL.md）不被本次 commit 带走', () => {
    writeAsset('noise.txt', 'noise\n')
    writeAsset('skills/other/SKILL.md', '# other\n')
    writeAsset('skills/target/SKILL.md', '# target\n')

    const outcome = commitAssets({ assetsDir, paths: ['skills/target/SKILL.md'], logger: () => {} })

    expect(outcome.committed).toBe(true)
    expect(committedFiles()).toEqual(['skills/target/SKILL.md'])
    expect(statusOf('noise.txt')).toBe('?? noise.txt')
    expect(statusOf('skills/other/SKILL.md')).toBe('?? skills/other/SKILL.md')
    expect(statusOf('skills/target/SKILL.md')).toBe('')
  })

  it('无关文件已被 staged：不得被本次 commit 带走，且仍保持 staged', () => {
    writeAsset('noise.txt', 'noise\n')
    git(['add', '--', 'noise.txt'])
    expect(statusOf('noise.txt')).toBe('A  noise.txt')

    writeAsset('skills/target/SKILL.md', '# target\n')
    const outcome = commitAssets({ assetsDir, paths: ['skills/target/SKILL.md'], logger: () => {} })

    expect(outcome.committed).toBe(true)
    expect(committedFiles()).toEqual(['skills/target/SKILL.md'])
    // 无关文件仍 staged、未进入 HEAD。
    expect(statusOf('noise.txt')).toBe('A  noise.txt')
    expect(git(['ls-tree', '--name-only', 'HEAD', '--', 'noise.txt']).trim()).toBe('')
  })

  it('无关文件是另一项资产的 staged 修改：同样不被带走', () => {
    writeAsset('strategies/other.md', 'v1\n')
    expect(
      commitAssets({ assetsDir, paths: ['strategies/other.md'], logger: () => {} }).committed,
    ).toBe(true)

    writeAsset('strategies/other.md', 'v2-staged\n')
    git(['add', '--', 'strategies/other.md'])
    writeAsset('skills/target/SKILL.md', '# target\n')

    const outcome = commitAssets({ assetsDir, paths: ['skills/target/SKILL.md'], logger: () => {} })

    expect(outcome.committed).toBe(true)
    expect(committedFiles()).toEqual(['skills/target/SKILL.md'])
    expect(statusOf('strategies/other.md')).toBe('M  strategies/other.md')
    // 该文件在 HEAD 中仍是 v1，staged v2 尚未提交。
    expect(git(['show', 'HEAD:strategies/other.md'])).toBe('v1\n')
  })

  it('多个目标路径一次提交，message 逐一列出；无关文件仍未被带走', () => {
    writeAsset('skills/a/SKILL.md', '# a\n')
    writeAsset('programs/b/task.ts', 'export {}\n')
    writeAsset('noise.txt', 'noise\n')

    const outcome = commitAssets({
      assetsDir,
      paths: ['skills/a/SKILL.md', 'programs/b/task.ts'],
      logger: () => {},
    })

    expect(outcome.committed).toBe(true)
    expect(outcome.files).toHaveLength(2)
    expect(lastSubject()).toContain('create skills/a/SKILL.md')
    expect(lastSubject()).toContain('create programs/b/task.ts')
    expect(committedFiles()).toEqual(['programs/b/task.ts', 'skills/a/SKILL.md'])
    expect(statusOf('noise.txt')).toBe('?? noise.txt')
  })
})

// ---------------------------------------------------------------------------
// 作者身份：不依赖宿主机 git config
// ---------------------------------------------------------------------------

describe('作者身份：固定 dsh-ia，不依赖宿主机 git config', () => {
  it('敌对全局 git config + 敌对 GIT_AUTHOR_* 环境变量下仍为 dsh-ia', () => {
    const hostileConfig = join(home, 'hostile-gitconfig')
    writeFileSync(
      hostileConfig,
      ['[user]', '  name = Host Machine', '  email = host@machine.example', ''].join('\n'),
      'utf8',
    )
    const saved: Record<string, string | undefined> = {
      GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL,
      GIT_CONFIG_SYSTEM: process.env.GIT_CONFIG_SYSTEM,
      GIT_AUTHOR_NAME: process.env.GIT_AUTHOR_NAME,
      GIT_AUTHOR_EMAIL: process.env.GIT_AUTHOR_EMAIL,
      GIT_COMMITTER_NAME: process.env.GIT_COMMITTER_NAME,
      GIT_COMMITTER_EMAIL: process.env.GIT_COMMITTER_EMAIL,
    }
    process.env.GIT_CONFIG_GLOBAL = hostileConfig
    process.env.GIT_CONFIG_SYSTEM = '/dev/null'
    process.env.GIT_AUTHOR_NAME = 'Host Author'
    process.env.GIT_AUTHOR_EMAIL = 'host-author@example.com'
    process.env.GIT_COMMITTER_NAME = 'Host Committer'
    process.env.GIT_COMMITTER_EMAIL = 'host-committer@example.com'

    try {
      writeAsset('skills/demo/SKILL.md', '# demo\n')
      const outcome = commitAssets({ assetsDir, paths: ['skills/demo/SKILL.md'], logger: () => {} })
      expect(outcome.committed).toBe(true)
      expect(lastAuthor()).toBe('dsh-ia <dsh-ia@localhost>')
      expect(lastCommitter()).toBe('dsh-ia <dsh-ia@localhost>')
      // 敌对 config 确实生效（普通 git 读取时是 Host Machine），证明上述固定身份
      // 不是「配置本来就没生效」的假阳性。
      expect(git(['config', '--get', 'user.name']).trim()).toBe('Host Machine')
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    }
  })

  it('task / program / skill 三类提交作者均为 dsh-ia', () => {
    const store = new TaskStore(tasksDir, { assetsDir, logger: () => {} })
    store.save(makeTask('pulse'))
    expect(lastAuthor()).toBe('dsh-ia <dsh-ia@localhost>')

    writeAsset('programs/pulse/task.ts', 'export {}\n')
    commitAssets({ assetsDir, paths: ['programs/pulse/task.ts'], logger: () => {} })
    expect(lastAuthor()).toBe('dsh-ia <dsh-ia@localhost>')

    writeAsset('skills/demo/SKILL.md', '# demo\n')
    commitAssets({ assetsDir, paths: ['skills/demo/SKILL.md'], logger: () => {} })
    expect(lastAuthor()).toBe('dsh-ia <dsh-ia@localhost>')

    // 全部历史逐条核对（不止 HEAD）。
    const authors = git(['log', '--pretty=%an <%ae>']).trim().split('\n')
    expect(authors).toHaveLength(3)
    expect(new Set(authors)).toEqual(new Set(['dsh-ia <dsh-ia@localhost>']))
  })
})

// ---------------------------------------------------------------------------
// AC4 / AC6：git 失败降级（不抛、文件落盘、告警）
// ---------------------------------------------------------------------------

describe('AC4/AC6 git 失败降级：不中断业务', () => {
  it('commitAssets：注入抛错 runner → degraded=true、告警、文件仍在', () => {
    const abs = writeAsset('skills/demo/SKILL.md', '# demo\n')
    const { messages, logger } = collectingLogger()

    const outcome = commitAssets({
      assetsDir,
      paths: ['skills/demo/SKILL.md'],
      gitRunner: boom,
      logger,
    })

    expect(outcome.committed).toBe(false)
    expect(outcome.degraded).toBe(true)
    expect(outcome.reason).toContain('git unavailable (injected)')
    expect(outcome.files).toEqual([])
    expect(readFileSync(abs, 'utf8')).toBe('# demo\n')
    expect(messages.join('\n')).toContain('降级')
    expect(commitCount()).toBe(0)
  })

  it('TaskStore.save：注入抛错 runner → 不抛、文件落盘、降级告警', () => {
    const { messages, logger } = collectingLogger()
    const store = new TaskStore(tasksDir, { assetsDir, gitRunner: boom, logger })
    const task = makeTask('pulse')

    expect(() => store.save(task)).not.toThrow()
    expect(existsSync(join(tasksDir, 'pulse.json'))).toBe(true)
    expect(JSON.parse(readFileSync(join(tasksDir, 'pulse.json'), 'utf8'))).toMatchObject({
      id: 'pulse',
    })
    expect(store.get('pulse')?.name).toBe(task.name)
    expect(messages.join('\n')).toContain('降级')
    expect(commitCount()).toBe(0)
  })

  it('TaskStore.remove：注入抛错 runner → 不抛、文件已删、降级告警', () => {
    const normal = new TaskStore(tasksDir, { assetsDir, logger: () => {} })
    normal.save(makeTask('pulse'))
    expect(commitCount()).toBe(1)

    const { messages, logger } = collectingLogger()
    const broken = new TaskStore(tasksDir, { assetsDir, gitRunner: boom, logger })

    expect(() => broken.remove('pulse')).not.toThrow()
    expect(broken.remove('pulse')).toBe(false) // 已删除
    expect(existsSync(join(tasksDir, 'pulse.json'))).toBe(false)
    expect(commitCount()).toBe(1) // 没有新 commit
    expect(messages.join('\n')).toContain('降级')
  })

  it('asset_commit 工具：注入抛错 runner → degraded=true、schema 合法、文件仍在', async () => {
    const abs = writeAsset('skills/demo/SKILL.md', '# demo\n')
    const { messages, logger } = collectingLogger()
    const tool = createAssetCommitTool({ assetsDir, gitRunner: boom, logger })

    const value = (await tool.execute(
      { paths: ['skills/demo/SKILL.md'] },
      makeExec(),
    )) as Record<string, unknown>

    expect(value.committed).toBe(false)
    expect(value.degraded).toBe(true)
    expect(validateJsonSchemaValue(tool.output.schema, value)).toEqual([])
    expect(readFileSync(abs, 'utf8')).toBe('# demo\n')
    expect(messages.join('\n')).toContain('降级')
    expect(commitCount()).toBe(0)
  })

  it('仅 commit 步骤失败（add/status 正常）：降级且不留下新 commit，文件仍在', () => {
    const failingAtCommit: GitRunner = (args, cwd) => {
      if (args[0] === 'commit') throw new Error('commit step failed (injected)')
      return execFileSync(
        'git',
        ['-c', 'user.name=dsh-ia', '-c', 'user.email=dsh-ia@localhost', ...args],
        { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
      )
    }

    const abs = writeAsset('programs/pulse/task.ts', 'export {}\n')
    const { messages, logger } = collectingLogger()

    const outcome = commitAssets({
      assetsDir,
      paths: ['programs/pulse/task.ts'],
      gitRunner: failingAtCommit,
      logger,
    })

    expect(outcome.committed).toBe(false)
    expect(outcome.degraded).toBe(true)
    expect(commitCount()).toBe(0)
    expect(existsSync(abs)).toBe(true)
    expect(messages.join('\n')).toContain('降级')
  })

  it('仓库缺 .git：commitAssets / asset_commit 都降级返回而不抛错，也不初始化仓库', async () => {
    const bare = join(home, 'bare-assets')
    mkdirSync(join(bare, 'skills'), { recursive: true })
    writeFileSync(join(bare, 'skills', 'SKILL.md'), '# x\n', 'utf8')

    const outcome = commitAssets({ assetsDir: bare, paths: ['skills/SKILL.md'], logger: () => {} })
    expect(outcome.committed).toBe(false)
    expect(outcome.degraded).toBe(true)
    expect(outcome.reason).toContain('.git')
    expect(existsSync(join(bare, '.git'))).toBe(false)

    const tool = createAssetCommitTool({ assetsDir: bare, logger: () => {} })
    const value = (await tool.execute({ paths: ['skills/SKILL.md'] }, makeExec())) as {
      committed: boolean
      degraded: boolean
    }
    expect(value.committed).toBe(false)
    expect(value.degraded).toBe(true)
    expect(existsSync(join(bare, '.git'))).toBe(false)
  })

  it('TaskStore 落在 assets 之外（tasksDir 不在 assetsDir 下）：跳过提交但不影响落盘', () => {
    const outside = join(home, 'outside-tasks')
    const { messages, logger } = collectingLogger()
    const store = new TaskStore(outside, { assetsDir, logger })

    expect(() => store.save(makeTask('odd'))).not.toThrow()
    expect(existsSync(join(outside, 'odd.json'))).toBe(true)
    expect(messages.join('\n')).toContain('不在资产目录内')
    expect(commitCount()).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// 对抗：非法路径 → 抛错且零 commit
// ---------------------------------------------------------------------------

const INVALID_PATHS: Array<[string, string]> = [
  ['绝对路径', '/etc/passwd'],
  ['Windows 绝对路径', 'C:/Windows/system.ini'],
  ['父级穿越', '../outside.txt'],
  ['资产内穿越', 'skills/../tasks/x.json'],
  ['.git 目录', 'skills/.git/config'],
  ['裸 .git', '.git/config'],
  ['大小写 .git', 'skills/.GIT/config'],
  ['反斜杠', 'skills/demo\\SKILL.md'],
  ['反斜杠穿越', '..\\outside.txt'],
  ['data 前缀', 'data/ledger.json'],
  ['非资产前缀', 'noise.txt'],
  ['前缀不完整', 'skills'],
  ['空段', 'skills//SKILL.md'],
  ['点段', 'skills/./SKILL.md'],
  ['空字符串', ''],
]

describe('对抗：非法路径抛错且不产生任何 commit', () => {
  it.each(INVALID_PATHS)('%s：normalizeAssetPath / commitAssets 均抛 AssetPathError', (_label, path) => {
    expect(() => normalizeAssetPath(path)).toThrow(AssetPathError)
    expect(() => commitAssets({ assetsDir, paths: [path], logger: () => {} })).toThrow(AssetPathError)
    expect(commitCount()).toBe(0)
  })

  it.each(INVALID_PATHS)('%s：asset_commit 工具拒绝，且零 commit', async (_label, path) => {
    const tool = createAssetCommitTool({ assetsDir, logger: () => {} })
    await expect(tool.execute({ paths: [path] }, makeExec())).rejects.toThrow(AssetPathError)
    expect(commitCount()).toBe(0)
  })

  it('空 paths 数组被拒绝，且零 commit', () => {
    expect(() => normalizeAssetPaths([])).toThrow(AssetPathError)
    expect(() => commitAssets({ assetsDir, paths: [], logger: () => {} })).toThrow(AssetPathError)
    expect(commitCount()).toBe(0)
  })

  it('合法四前缀接受，重复路径去重（message 不重复）', () => {
    expect(normalizeAssetPath('skills/a/SKILL.md')).toBe('skills/a/SKILL.md')
    expect(normalizeAssetPath('tasks/a.json')).toBe('tasks/a.json')
    expect(normalizeAssetPath('programs/a/task.ts')).toBe('programs/a/task.ts')
    expect(normalizeAssetPath('strategies/002156.md')).toBe('strategies/002156.md')
    expect(
      normalizeAssetPaths(['skills/a/SKILL.md', 'skills/a/SKILL.md', 'tasks/a.json']),
    ).toEqual(['skills/a/SKILL.md', 'tasks/a.json'])

    writeAsset('skills/a/SKILL.md', '# a\n')
    const outcome = commitAssets({
      assetsDir,
      paths: ['skills/a/SKILL.md', 'skills/a/SKILL.md'],
      logger: () => {},
    })
    expect(outcome.committed).toBe(true)
    expect(outcome.files).toEqual([{ path: 'skills/a/SKILL.md', action: 'create' }])
    expect(lastSubject()).toBe('assets: create skills/a/SKILL.md')
  })

  it('非法路径不触碰磁盘：目标文件存在但未被 add 进任何 commit', () => {
    writeAsset('skills/demo/SKILL.md', '# demo\n')
    expect(() => commitAssets({ assetsDir, paths: ['/etc/passwd'], logger: () => {} })).toThrow(
      AssetPathError,
    )
    expect(commitCount()).toBe(0)
    expect(statusOf('skills/demo/SKILL.md')).toBe('?? skills/demo/SKILL.md')
  })
})

// ---------------------------------------------------------------------------
// 真实链路 1：TaskStore + createSchedulerTools（task_create → update → delete）
// ---------------------------------------------------------------------------

describe('真实链路：task_create → task_update → task_delete', () => {
  it('三个工具依次落盘并各产生一次 commit（动作/作者正确），reload 各一次', async () => {
    let reloads = 0
    const store = new TaskStore(resolveAssetsTasksDir(), {
      assetsDir: resolveAssetsDir(),
      logger: () => {},
    })
    const tools = createSchedulerTools({
      store,
      scheduler: { reload: () => { reloads += 1 } } as never,
    })
    const byName = (name: string) => {
      const tool = tools.find((t) => t.name === name)
      if (!tool) throw new Error(`未注册工具：${name}`)
      return tool
    }

    await byName('task_create').execute(
      {
        id: 'pulse',
        name: '市场脉搏',
        cron: '0 9 * * *',
        task_path: 'assets/programs/pulse/task.ts',
      },
      makeExec(),
    )
    expect(commitCount()).toBe(1)
    expect(lastSubject()).toBe('assets: create tasks/pulse.json')
    expect(lastAuthor()).toBe('dsh-ia <dsh-ia@localhost>')

    await byName('task_update').execute({ id: 'pulse', name: '市场脉搏-改' }, makeExec())
    expect(commitCount()).toBe(2)
    expect(lastSubject()).toBe('assets: update tasks/pulse.json')

    await byName('task_delete').execute({ id: 'pulse' }, makeExec())
    expect(commitCount()).toBe(3)
    expect(lastSubject()).toBe('assets: delete tasks/pulse.json')
    expect(existsSync(join(resolveAssetsTasksDir(), 'pulse.json'))).toBe(false)
    expect(reloads).toBe(3)

    // 同一工具链的 list 不再看到任务。
    const listed = (await byName('task_list').execute({}, makeExec())) as {
      tasks: unknown[]
      corrupted: unknown[]
    }
    expect(listed.tasks).toEqual([])
    expect(listed.corrupted).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// 真实链路 2 / AC7：program + SKILL 直接写盘后统一经 asset_commit 提交
// ---------------------------------------------------------------------------

describe('AC7 真实链路：直接写 program / SKILL 后 asset_commit', () => {
  it('SKILL 直接写盘 → 调 asset_commit（默认取 DSH_IA_HOME）→ create；再次编辑 → update', async () => {
    const skill = writeAsset('skills/direct/SKILL.md', '# v1\n')
    // 直接写盘后：文件在，git 尚未接管（未跟踪）。
    expect(statusOf('skills/direct/SKILL.md')).toBe('?? skills/direct/SKILL.md')
    expect(commitCount()).toBe(0)

    const tool = createAssetCommitTool({ logger: () => {} }) // 不传 assetsDir，走 DSH_IA_HOME
    const created = (await tool.execute(
      { paths: ['skills/direct/SKILL.md'] },
      makeExec(),
    )) as { committed: boolean; files: Array<{ action: string; path: string }> }

    expect(created.committed).toBe(true)
    expect(created.files).toEqual([{ path: 'skills/direct/SKILL.md', action: 'create' }])
    expect(statusOf('skills/direct/SKILL.md')).toBe('')
    expect(commitCount()).toBe(1)

    writeFileSync(skill, '# v2\n', 'utf8')
    const updated = (await tool.execute(
      { paths: ['skills/direct/SKILL.md'] },
      makeExec(),
    )) as { committed: boolean; files: Array<{ action: string; path: string }> }

    expect(updated.committed).toBe(true)
    expect(updated.files).toEqual([{ path: 'skills/direct/SKILL.md', action: 'update' }])
    expect(lastSubject()).toBe('assets: update skills/direct/SKILL.md')
    expect(readFileSync(skill, 'utf8')).toBe('# v2\n')
  })

  it('program 与 SKILL 可一次 asset_commit 提交，文件内容逐字节不变', async () => {
    const skillText = '# demo\n\n中文正文\n'
    const programText = 'export const run = () => "ok"\n'
    writeAsset('skills/demo/SKILL.md', skillText)
    writeAsset('programs/pulse/task.ts', programText)

    const tool = createAssetCommitTool({ logger: () => {} })
    const value = (await tool.execute(
      { paths: ['skills/demo/SKILL.md', 'programs/pulse/task.ts'] },
      makeExec(),
    )) as { committed: boolean; files: Array<{ action: string; path: string }> }

    expect(value.committed).toBe(true)
    expect(value.files).toHaveLength(2)
    expect(lastSubject()).toContain('create skills/demo/SKILL.md')
    expect(lastSubject()).toContain('create programs/pulse/task.ts')
    expect(readFileSync(join(assetsDir, 'skills/demo/SKILL.md'), 'utf8')).toBe(skillText)
    expect(readFileSync(join(assetsDir, 'programs/pulse/task.ts'), 'utf8')).toBe(programText)
    expect(committedFiles()).toEqual(['programs/pulse/task.ts', 'skills/demo/SKILL.md'])
  })

  it('asset_commit 只提交、不写文件：指向不存在的路径不会凭空造文件', async () => {
    const tool = createAssetCommitTool({ logger: () => {} })
    const value = (await tool.execute(
      { paths: ['skills/ghost/SKILL.md'] },
      makeExec(),
    )) as { committed: boolean }

    expect(value.committed).toBe(false)
    expect(existsSync(join(assetsDir, 'skills/ghost/SKILL.md'))).toBe(false)
    expect(commitCount()).toBe(0)
  })

  it('skill 删除也走统一入口：rm 后 asset_commit → delete 动作', async () => {
    const skill = writeAsset('skills/demo/SKILL.md', '# demo\n')
    const tool = createAssetCommitTool({ logger: () => {} })
    await tool.execute({ paths: ['skills/demo/SKILL.md'] }, makeExec())
    expect(commitCount()).toBe(1)

    rmSync(skill)
    const value = (await tool.execute(
      { paths: ['skills/demo/SKILL.md'] },
      makeExec(),
    )) as { committed: boolean; files: Array<{ action: string; path: string }> }

    expect(value.committed).toBe(true)
    expect(value.files).toEqual([{ path: 'skills/demo/SKILL.md', action: 'delete' }])
    expect(lastSubject()).toBe('assets: delete skills/demo/SKILL.md')
    expect(commitCount()).toBe(2)
  })
})

// ---------------------------------------------------------------------------
// 插件装载：asset_commit 对模型可见（22 / 15）
// ---------------------------------------------------------------------------

interface ToolBox {
  schemas: () => Array<{ name: string }>
  get: (name: string) => unknown
}

function systemPromptStub() {
  return {
    name: 'systemPrompt',
    tools() {},
    section() {
      return () => {}
    },
    getSectionOrder() {
      return 0
    },
  } as unknown as never
}

describe('插件装载：asset_commit 可见（工具总数 22；createAllTools 15）', () => {
  it('真实 Context + ToolRuntime + 真实插件 apply：22 个工具且含 asset_commit', async () => {
    const app = new Context()
    app.provide('systemPrompt', systemPromptStub())
    app.provide('skills', { name: 'skills', register: () => () => {} } as never)
    app.provide('fs', { name: 'fs' } as never)

    const toolsFiber = (await app.plugin(ToolRuntime as never)) as unknown as {
      dispose: () => Promise<void>
    }
    const pluginFiber = app.plugin({
      name: pluginName,
      inject: [...pluginInject],
      apply: applyPlugin,
    } as never) as unknown as { dispose: () => Promise<void> }

    const tools = (app as unknown as { tools: ToolBox }).tools
    try {
      await vi.waitFor(
        () => {
          expect(tools.schemas()).toHaveLength(22)
        },
        { timeout: 10000, interval: 10 },
      )

      const names = tools.schemas().map((s) => s.name)
      expect(names).toHaveLength(22)
      expect(new Set(names).size).toBe(22)
      expect(names).toContain('asset_commit')
      expect(tools.get('asset_commit')).toBeDefined()
      expect(names).toContain('task_create')
    } finally {
      await pluginFiber.dispose()
      await toolsFiber.dispose()
    }
    expect(tools.schemas()).toHaveLength(0)
  })

  it('createAllTools 恰好 15 个且含 asset_commit（不含 scheduler 工具）', () => {
    const tools = createAllTools(createToolContext({ dataRoot: join(home, 'data') }))
    expect(tools).toHaveLength(15)
    const names = tools.map((t) => t.name)
    expect(names).toContain('asset_commit')
    expect(names.filter((n) => n.startsWith('task_'))).toEqual([])
  })
})
