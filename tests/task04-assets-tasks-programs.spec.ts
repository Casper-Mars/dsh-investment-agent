/**
 * task-04：任务定义 / 任务程序迁出到资产层。
 *
 * 覆盖：
 *   1. 默认任务定义目录 = `<DSH_IA_HOME>/assets/tasks`；
 *   2. 任务程序目录 = `<DSH_IA_HOME>/assets/programs`；
 *   3. 默认 store 落盘只写 assets/tasks，**不产生** `<home>/data/tasks`（无旧路径写入）；
 *   4. 工具层强制 `task_path` 以 `assets/programs/` 开头。
 *
 * 全程 `DSH_IA_HOME=<mkdtemp>` 隔离，不触碰真实 `~/.dsh-ia`。
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  resolveAssetsProgramsDir,
  resolveAssetsTasksDir,
} from '../src/paths.js'
import { createTaskStore } from '../src/scheduler/store.js'
import { createSchedulerTools } from '../src/scheduler/tools.js'
import type { TaskDef } from '../src/scheduler/types.js'
import { FINANCE_HOME_ENV } from '../src/flags.js'

const SAVED_HOME = process.env[FINANCE_HOME_ENV]
let home = ''

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'task04-'))
  process.env[FINANCE_HOME_ENV] = home
})

afterEach(() => {
  if (SAVED_HOME === undefined) delete process.env[FINANCE_HOME_ENV]
  else process.env[FINANCE_HOME_ENV] = SAVED_HOME
  rmSync(home, { recursive: true, force: true })
})

afterAll(() => {
  if (SAVED_HOME === undefined) delete process.env[FINANCE_HOME_ENV]
  else process.env[FINANCE_HOME_ENV] = SAVED_HOME
})

const task: TaskDef = {
  id: 'market-pulse',
  name: '市场脉搏',
  cron: '0 9 * * *',
  task_path: 'assets/programs/market-pulse/task.ts',
  enabled: true,
}

describe('task-04 资产层任务布局', () => {
  it('resolveAssetsTasksDir / resolveAssetsProgramsDir 指向 assets 下', () => {
    expect(resolveAssetsTasksDir()).toBe(join(home, 'assets', 'tasks'))
    expect(resolveAssetsProgramsDir()).toBe(join(home, 'assets', 'programs'))
  })

  it('默认 store 落盘到 assets/tasks，且不产生 data/tasks', () => {
    const store = createTaskStore()
    store.save(task)

    expect(existsSync(join(home, 'assets', 'tasks', 'market-pulse.json'))).toBe(true)
    expect(store.get('market-pulse')).toEqual(task)
    // 验收 4：无旧路径写入。
    expect(existsSync(join(home, 'data', 'tasks'))).toBe(false)
    expect(existsSync(join(home, 'data'))).toBe(false)
  })

  it('task_create 接受 assets/programs/ 前缀并落盘 assets/tasks', async () => {
    const store = createTaskStore()
    const tools = createSchedulerTools({
      store,
      scheduler: { reload: () => {} } as never,
    })
    const create = tools.find((t) => t.name === 'task_create')
    if (!create) throw new Error('task_create 未注册')
    const ctrl = new AbortController()

    await create.execute(
      { id: 'x', name: 'X', cron: '0 9 * * *', task_path: 'assets/programs/x/task.ts' },
      { signal: ctrl.signal },
    )
    expect(store.get('x')?.task_path).toBe('assets/programs/x/task.ts')
    expect(existsSync(join(home, 'assets', 'tasks', 'x.json'))).toBe(true)
    expect(existsSync(join(home, 'data', 'tasks'))).toBe(false)
  })

  it('task_create 拒绝旧布局与任意目录的 task_path', async () => {
    const store = createTaskStore()
    const tools = createSchedulerTools({
      store,
      scheduler: { reload: () => {} } as never,
    })
    const create = tools.find((t) => t.name === 'task_create')
    if (!create) throw new Error('task_create 未注册')
    const ctrl = new AbortController()

    for (const bad of ['data/tasks/x/task.ts', 'tasks/x/task.ts', '../x/task.ts']) {
      await expect(
        create.execute(
          { id: 'x', name: 'X', cron: '0 9 * * *', task_path: bad },
          { signal: ctrl.signal },
        ),
      ).rejects.toThrow(/\[path-guard\]/)
    }
    expect(store.list().tasks).toEqual([])
  })
})
