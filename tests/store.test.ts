/**
 * scheduler/store.ts 单元测试。
 *
 * 覆盖任务卡验收点：
 * - 复用 path-guard 的 assertSafeSegment（防目录穿越：`../` 之类 id 抛错）
 * - dataDir 依赖注入（可覆盖、不写死路径）
 * - list 遇到损坏 JSON 跳过不崩（不抛异常）
 * - save 后跨实例可恢复（同一 dataDir 重新 new 一个 store 可读到）
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  mkdirSync,
  readFileSync,
  existsSync,
} from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'
import { TaskStore, createTaskStore, defaultTasksDir } from '../src/scheduler/store.js'
import type { TaskDef } from '../src/scheduler/types.js'

let dir: string
let tasksDir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dsh-ia-store-'))
  tasksDir = join(dir, 'data', 'tasks')
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

/** 构造一个合法的 TaskDef。 */
function makeTask(id: string): TaskDef {
  return {
    id,
    name: `任务-${id}`,
    cron: '0 9 * * *',
    task_path: `tasks/${id}/task.ts`,
    enabled: true,
  }
}

describe('TaskStore 基本读写', () => {
  it('save 后 get 可读、list 可见（同实例）', () => {
    const store = new TaskStore(tasksDir)
    const task = makeTask('market-pulse')
    store.save(task)

    expect(store.get('market-pulse')).toEqual(task)
    expect(store.list().tasks.map((t) => t.id)).toEqual(['market-pulse'])
  })

  it('get 不存在的任务返回 undefined', () => {
    const store = new TaskStore(tasksDir)
    expect(store.get('nope')).toBeUndefined()
  })

  it('list 空目录返回空', () => {
    const store = new TaskStore(tasksDir)
    expect(store.list()).toEqual({ tasks: [], corrupted: [] })
  })

  it('list 目录不存在也不抛错，返回空', () => {
    const store = new TaskStore(join(dir, 'missing', 'tasks'))
    expect(store.list().tasks).toEqual([])
  })

  it('list 按 id 升序稳定排序', () => {
    const store = new TaskStore(tasksDir)
    store.save(makeTask('b-task'))
    store.save(makeTask('a-task'))
    store.save(makeTask('c-task'))
    expect(store.list().tasks.map((t) => t.id)).toEqual(['a-task', 'b-task', 'c-task'])
  })

  it('save 覆盖同 id 旧记录', () => {
    const store = new TaskStore(tasksDir)
    store.save(makeTask('market-pulse'))
    const updated: TaskDef = { ...makeTask('market-pulse'), enabled: false }
    store.save(updated)

    expect(store.get('market-pulse')).toEqual(updated)
    expect(store.list().tasks).toHaveLength(1)
  })
})

describe('TaskStore.remove', () => {
  it('删除已存在任务返回 true，且 get 变为 undefined', () => {
    const store = new TaskStore(tasksDir)
    store.save(makeTask('market-pulse'))
    expect(store.remove('market-pulse')).toBe(true)
    expect(store.get('market-pulse')).toBeUndefined()
  })

  it('删除不存在任务返回 false（不抛错）', () => {
    const store = new TaskStore(tasksDir)
    expect(store.remove('nope')).toBe(false)
  })
})

describe('依赖注入（dataDir 覆盖）', () => {
  it('createTaskStore 支持注入 tasksDir', () => {
    const custom = join(dir, 'custom', 'tasks')
    const store = createTaskStore(custom)
    store.save(makeTask('x'))

    // 落盘在注入目录，而非默认目录。
    expect(store.get('x')).toBeDefined()
    expect(store.list().tasks.map((t) => t.id)).toEqual(['x'])
  })

  it('createTaskStore 缺省使用 defaultTasksDir（~/.dsh-ia/data/tasks）', () => {
    const store = createTaskStore()
    // factory 缺省目录即 defaultTasksDir；此处仅验证函数引用一致，不落盘避免污染主目录。
    expect(defaultTasksDir()).toBe(join(homedir(), '.dsh-ia', 'data', 'tasks'))
    expect(store).toBeInstanceOf(TaskStore)
  })
})

describe('损坏文件跳过（list 不崩）', () => {
  it('损坏 JSON 被归入 corrupted 且不中断其它任务加载', () => {
    mkdirSync(tasksDir, { recursive: true })
    writeFileSync(join(tasksDir, 'broken.json'), '{ not json !!!', 'utf8')
    writeFileSync(join(tasksDir, 'valid.json'), JSON.stringify(makeTask('valid')), 'utf8')

    const store = new TaskStore(tasksDir)
    const { tasks, corrupted } = store.list()

    expect(tasks.map((t) => t.id)).toEqual(['valid'])
    expect(corrupted).toContain('broken')
  })

  it('结构非法（非 TaskDef）被归入 corrupted', () => {
    mkdirSync(tasksDir, { recursive: true })
    writeFileSync(join(tasksDir, 'weird.json'), JSON.stringify({ foo: 'bar' }), 'utf8')

    const store = new TaskStore(tasksDir)
    const { tasks, corrupted } = store.list()

    expect(tasks).toEqual([])
    expect(corrupted).toContain('weird')
  })

  it('缺字段的 TaskDef（如缺 enabled）被判为损坏而非有效任务', () => {
    mkdirSync(tasksDir, { recursive: true })
    writeFileSync(
      join(tasksDir, 'partial.json'),
      JSON.stringify({ id: 'partial', name: 'x', cron: '0 0 * * *', task_path: 'p' }),
      'utf8',
    )

    const store = new TaskStore(tasksDir)
    const { tasks, corrupted } = store.list()

    expect(tasks).toEqual([])
    expect(corrupted).toContain('partial')
  })

  it('get 损坏文件返回 undefined 而非抛错', () => {
    mkdirSync(tasksDir, { recursive: true })
    writeFileSync(join(tasksDir, 'broken.json'), 'not-json', 'utf8')

    const store = new TaskStore(tasksDir)
    expect(store.get('broken')).toBeUndefined()
  })
})

describe('目录穿越拦截（复用 path-guard）', () => {
  const badIds = ['../x', '../../escape', 'a/b', '..', '.', '/abs', 'a b'] as const

  it.each(badIds)('get(%s) 抛 [path-guard] 错误', (id) => {
    const store = new TaskStore(tasksDir)
    expect(() => store.get(id)).toThrow(/\[path-guard\]/)
  })

  it.each(badIds)('save 带穿越 id 抛 [path-guard] 错误', (id) => {
    const store = new TaskStore(tasksDir)
    expect(() => store.save(makeTask(id))).toThrow(/\[path-guard\]/)
  })

  it.each(badIds)('remove(%s) 抛 [path-guard] 错误', (id) => {
    const store = new TaskStore(tasksDir)
    expect(() => store.remove(id)).toThrow(/\[path-guard\]/)
  })

  it('穿越尝试不产生 data/tasks 之外的任何文件', () => {
    const store = new TaskStore(tasksDir)
    expect(() => store.save(makeTask('../../esc'))).toThrow(/\[path-guard\]/)
    // 守卫在 mkdir 前抛出，故越界位置不应产生文件。
    expect(existsSync(join(dir, 'esc.json'))).toBe(false)
  })
})

describe('跨实例恢复（AC-4）', () => {
  it('同一 dataDir 重新 new 一个 store 可读到已保存数据', () => {
    const store1 = new TaskStore(tasksDir)
    store1.save(makeTask('market-pulse'))

    // 全新实例，指向同一 tasksDir。
    const store2 = new TaskStore(tasksDir)
    expect(store2.get('market-pulse')).toEqual(makeTask('market-pulse'))
    expect(store2.list().tasks.map((t) => t.id)).toEqual(['market-pulse'])
  })

  it('save 后磁盘立即可读（同步落盘）', () => {
    const store = new TaskStore(tasksDir)
    store.save(makeTask('sync-check'))

    // 直接读磁盘文件确认已落盘（不经过 store 内存态）。
    const onDisk = JSON.parse(
      readFileSync(join(tasksDir, 'sync-check.json'), 'utf8'),
    ) as TaskDef
    expect(onDisk.id).toBe('sync-check')
  })
})