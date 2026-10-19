/**
 * 资产「写入即 commit」测试（t100470 任务-02）。
 *
 * 覆盖：
 *   a. skill 文件 create → commit message 含 `create skills/...`，作者 `dsh-ia`；
 *   b. program 文件 create → commit；
 *   c. task JSON create + update → 各一次 commit；连续两次相同写入不产生新 commit；
 *      task 删除 → delete commit；
 *   d. 三种资产都能在同一份 `git -C <assets> log` 中查到；
 *   e. git 失败（注入抛错 runner）→ commitAssets / TaskStore.save / asset_commit
 *      均降级不抛，文件仍落盘；
 *   f. 路径非法（绝对路径 / `..` / `.git` / 非资产前缀 / 反斜杠）被拒绝；
 *   g. asset_commit 工具成功返回、路径非法报错。
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import {
  AssetPathError,
  commitAssets,
  normalizeAssetPath,
} from '../src/assets/commit.js'
import { GIT_IDENTITY_NAME } from '../src/assets/git.js'
import { ensureAssetsRepo } from '../src/assets/repo.js'
import { TaskStore } from '../src/scheduler/store.js'
import type { TaskDef } from '../src/scheduler/types.js'
import { createAssetCommitTool } from '../src/tools/assets.js'
import { createToolContext } from '../src/tools/context.js'
import { createAllTools } from '../src/tools/index.js'

let home: string
let assetsDir: string
let tasksDir: string

const noop = (): void => {}

/** 直接调系统 git（仅断言用）。 */
function git(args: string[], cwd = assetsDir): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

/** 提交数（无 HEAD 时 0）。 */
function commitCount(): number {
  try {
    return Number(git(['rev-list', '--count', 'HEAD']).trim())
  } catch {
    return 0
  }
}

/** 最近一次提交 subject。 */
function lastSubject(): string {
  return git(['log', '-1', '--pretty=%s']).trim()
}

/** 最近一次提交作者名。 */
function lastAuthor(): string {
  return git(['log', '-1', '--pretty=%an']).trim()
}

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

function makeExec(aborted = false): { signal: AbortSignal } {
  const ctrl = new AbortController()
  if (aborted) ctrl.abort()
  return { signal: ctrl.signal }
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'dsh-ia-asset-commit-'))
  assetsDir = join(home, 'assets')
  tasksDir = join(assetsDir, 'tasks')
  const ensured = ensureAssetsRepo({ assetsDir, logger: noop })
  expect(ensured.degraded).toBe(false)
})

afterEach(() => {
  rmSync(home, { recursive: true, force: true })
})

describe('commitAssets：skill / program create', () => {
  it('a. skill 文件 create → commit message 含 create 与相对路径，作者 dsh-ia', () => {
    mkdirSync(join(assetsDir, 'skills', 'demo'), { recursive: true })
    const skill = join(assetsDir, 'skills', 'demo', 'SKILL.md')
    writeFileSync(skill, '# demo\n', 'utf8')

    const outcome = commitAssets({
      assetsDir,
      paths: ['skills/demo/SKILL.md'],
      logger: noop,
    })

    expect(outcome.degraded).toBe(false)
    expect(outcome.committed).toBe(true)
    expect(outcome.files).toEqual([{ path: 'skills/demo/SKILL.md', action: 'create' }])
    expect(outcome.commit).toMatch(/^[0-9a-f]{12}$/)
    expect(outcome.reason).toContain('create skills/demo/SKILL.md')
    expect(lastSubject()).toContain('create skills/demo/SKILL.md')
    expect(lastAuthor()).toBe(GIT_IDENTITY_NAME)
  })

  it('b. program 文件 create → 产生 commit', () => {
    mkdirSync(join(assetsDir, 'programs', 'pulse'), { recursive: true })
    writeFileSync(join(assetsDir, 'programs', 'pulse', 'task.ts'), 'export {}\n', 'utf8')

    const outcome = commitAssets({
      assetsDir,
      paths: ['programs/pulse/task.ts'],
      logger: noop,
    })

    expect(outcome.committed).toBe(true)
    expect(outcome.files).toEqual([{ path: 'programs/pulse/task.ts', action: 'create' }])
    expect(lastSubject()).toContain('create programs/pulse/task.ts')
  })
})

describe('TaskStore：任务 JSON 写入即 commit', () => {
  it('c. create + update 各一次 commit；连续两次相同写入不产生新 commit', () => {
    const store = new TaskStore(tasksDir, { assetsDir, logger: noop })
    const task = makeTask('pulse')

    store.save(task)
    expect(commitCount()).toBe(1)
    expect(lastSubject()).toContain('create tasks/pulse.json')

    // 相同内容重复写入：git 无变更 → no-op。
    store.save(task)
    expect(commitCount()).toBe(1)

    store.save({ ...task, name: '任务-pulse-改' })
    expect(commitCount()).toBe(2)
    expect(lastSubject()).toContain('update tasks/pulse.json')
    expect(lastAuthor()).toBe(GIT_IDENTITY_NAME)
  })

  it('remove 删除后提交 delete', () => {
    const store = new TaskStore(tasksDir, { assetsDir, logger: noop })
    store.save(makeTask('pulse'))
    expect(commitCount()).toBe(1)

    expect(store.remove('pulse')).toBe(true)
    expect(commitCount()).toBe(2)
    expect(lastSubject()).toContain('delete tasks/pulse.json')
    // 再删一次：文件不存在 → false，且不产生 commit。
    expect(store.remove('pulse')).toBe(false)
    expect(commitCount()).toBe(2)
  })

  it('默认 assetsDir 取 tasksDir 父目录（new TaskStore(tasksDir) 兼容）', () => {
    const store = new TaskStore(tasksDir, { logger: noop })
    store.save(makeTask('compat'))
    expect(commitCount()).toBe(1)
    expect(lastSubject()).toContain('create tasks/compat.json')
  })
})

describe('d. 三种资产共享同一 assets git 历史', () => {
  it('skill / program / task 都能在同一份 log 中查到', () => {
    mkdirSync(join(assetsDir, 'skills', 'demo'), { recursive: true })
    mkdirSync(join(assetsDir, 'programs', 'pulse'), { recursive: true })
    writeFileSync(join(assetsDir, 'skills', 'demo', 'SKILL.md'), '# demo\n', 'utf8')
    writeFileSync(join(assetsDir, 'programs', 'pulse', 'task.ts'), 'export {}\n', 'utf8')
    const store = new TaskStore(tasksDir, { assetsDir, logger: noop })
    store.save(makeTask('pulse'))

    expect(
      commitAssets({ assetsDir, paths: ['skills/demo/SKILL.md'], logger: noop }).committed,
    ).toBe(true)
    expect(
      commitAssets({ assetsDir, paths: ['programs/pulse/task.ts'], logger: noop }).committed,
    ).toBe(true)

    const log = git(['log', '--pretty=%s', '--name-only'])
    expect(log).toContain('skills/demo/SKILL.md')
    expect(log).toContain('programs/pulse/task.ts')
    expect(log).toContain('tasks/pulse.json')
    expect(commitCount()).toBe(3)
  })
})

describe('e. git 失败降级：不抛、文件仍落盘', () => {
  const boom = (): string => {
    throw new Error('git unavailable (injected)')
  }

  it('commitAssets 返回 degraded 且文件仍在', () => {
    mkdirSync(join(assetsDir, 'skills', 'demo'), { recursive: true })
    const skill = join(assetsDir, 'skills', 'demo', 'SKILL.md')
    writeFileSync(skill, '# demo\n', 'utf8')

    const warnings: string[] = []
    const outcome = commitAssets({
      assetsDir,
      paths: ['skills/demo/SKILL.md'],
      gitRunner: boom,
      logger: (m) => warnings.push(m),
    })

    expect(outcome.degraded).toBe(true)
    expect(outcome.committed).toBe(false)
    expect(existsSync(skill)).toBe(true)
    expect(warnings.join('\n')).toContain('降级')
  })

  it('TaskStore.save 不抛、文件仍落盘', () => {
    const warnings: string[] = []
    const store = new TaskStore(tasksDir, {
      assetsDir,
      gitRunner: boom,
      logger: (m) => warnings.push(m),
    })
    expect(() => store.save(makeTask('pulse'))).not.toThrow()
    expect(existsSync(join(tasksDir, 'pulse.json'))).toBe(true)
    expect(store.get('pulse')?.id).toBe('pulse')
    expect(warnings.join('\n')).toContain('降级')
  })

  it('asset_commit 工具降级返回（不抛工具异常）', async () => {
    mkdirSync(join(assetsDir, 'skills', 'demo'), { recursive: true })
    writeFileSync(join(assetsDir, 'skills', 'demo', 'SKILL.md'), '# demo\n', 'utf8')
    const tool = createAssetCommitTool({ assetsDir, gitRunner: boom, logger: noop })

    const value = await tool.execute(
      { paths: ['skills/demo/SKILL.md'] },
      makeExec(),
    )
    expect(value.degraded).toBe(true)
    expect(value.committed).toBe(false)
    expect(existsSync(join(assetsDir, 'skills', 'demo', 'SKILL.md'))).toBe(true)
  })
})

describe('f. 路径非法被拒绝', () => {
  const invalid = [
    '/etc/passwd',
    'C:\\tmp\\x',
    'skills/../tasks/x.json',
    '../outside.txt',
    'skills/.git/config',
    'skills',
    'data/ledger.json',
    'skills\\demo\\SKILL.md',
    '',
  ]

  it.each(invalid)('拒绝 %j', (path) => {
    expect(() => normalizeAssetPath(path)).toThrow(AssetPathError)
    expect(() =>
      commitAssets({ assetsDir, paths: [path], logger: noop }),
    ).toThrow(AssetPathError)
  })

  it('合法前缀全部接受', () => {
    expect(normalizeAssetPath('skills/a/SKILL.md')).toBe('skills/a/SKILL.md')
    expect(normalizeAssetPath('tasks/a.json')).toBe('tasks/a.json')
    expect(normalizeAssetPath('programs/a/task.ts')).toBe('programs/a/task.ts')
    expect(normalizeAssetPath('strategies/002156.md')).toBe('strategies/002156.md')
  })
})

describe('g. asset_commit 工具：成功返回 + 路径非法报错', () => {
  it('成功提交并返回严格 schema 对齐的结果', async () => {
    mkdirSync(join(assetsDir, 'skills', 'demo'), { recursive: true })
    writeFileSync(join(assetsDir, 'skills', 'demo', 'SKILL.md'), '# demo\n', 'utf8')
    const tool = createAssetCommitTool({ assetsDir, logger: noop })

    const value = await tool.execute({ paths: ['skills/demo/SKILL.md'] }, makeExec())
    expect(value.committed).toBe(true)
    expect(value.degraded).toBe(false)
    expect(value.files).toEqual([{ path: 'skills/demo/SKILL.md', action: 'create' }])
    expect(validateJsonSchemaValue(tool.output.schema, value)).toEqual([])
  })

  it('路径非法 → 抛错（不降级吞掉）', async () => {
    const tool = createAssetCommitTool({ assetsDir, logger: noop })
    await expect(
      tool.execute({ paths: ['../escape.txt'] }, makeExec()),
    ).rejects.toThrow(AssetPathError)
  })

  it('createAllTools 注册 asset_commit（15 个工具）', () => {
    const tools = createAllTools(createToolContext({ dataRoot: join(home, 'data') }))
    expect(tools).toHaveLength(15)
    expect(tools.map((t) => t.name)).toContain('asset_commit')
  })

  it('相同内容重复提交 → no-op，不产生空 commit', () => {
    mkdirSync(join(assetsDir, 'skills', 'demo'), { recursive: true })
    writeFileSync(join(assetsDir, 'skills', 'demo', 'SKILL.md'), '# demo\n', 'utf8')
    expect(
      commitAssets({ assetsDir, paths: ['skills/demo/SKILL.md'], logger: noop }).committed,
    ).toBe(true)
    const again = commitAssets({ assetsDir, paths: ['skills/demo/SKILL.md'], logger: noop })
    expect(again.committed).toBe(false)
    expect(again.degraded).toBe(false)
    expect(commitCount()).toBe(1)
    expect(readFileSync(join(assetsDir, 'skills', 'demo', 'SKILL.md'), 'utf8')).toBe('# demo\n')
  })
})
