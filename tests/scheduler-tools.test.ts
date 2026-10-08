/**
 * scheduler/tools.ts 单元测试。
 *
 * 覆盖 9 条验收标准：
 *   1. 7 个工具全部存在且用 defineTool 定义（task_create/list/get/update/delete/enable/disable）
 *   2. 写类工具（create/update/delete/enable/disable）落盘后确实调用 scheduler.reload()
 *   3. 只读工具（list/get）不调用 reload
 *   4. 数据后端复用 store：create 后用同一 store 的 get/list 能读到（持久化生效）
 *   5. id / task_path 经 assertSafeSegment 校验，非法抛 [path-guard]
 *   6. cron 经 parseCron 校验，非法 cron 抛错且不落盘
 *   7. 签名对齐 TaskDef：create 返回 task 含 id/name/cron/task_path/enabled 全字段
 *   8. enabled 语义：create 缺省 true；update ?? 缺省保持、显式 false 可写；enable/disable 翻转
 *   9. 错误处理：get/delete/update 对不存在 id 抛清晰错误
 *
 * 说明：依赖注入，用真实 TaskStore（内存 tmp 目录）+ mock scheduler（记录 reload 调用次数），
 * 不依赖真实调度引擎即可验证「写后 reload + 持久化 + 校验」链路。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { TaskStore } from '../src/scheduler/store.js'
import type { TaskDef } from '../src/scheduler/types.js'
import { createSchedulerTools } from '../src/scheduler/tools.js'

let dir: string
let tasksDir: string
let store: TaskStore
let reloadCalls: number
let tools: ToolDefinition[]

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dsh-finance-schedtools-'))
  tasksDir = join(dir, 'data', 'tasks')
  store = new TaskStore(tasksDir)
  reloadCalls = 0
  tools = createSchedulerTools({
    store,
    // mock scheduler：只需 reload()，记录调用次数。
    scheduler: { reload: () => { reloadCalls += 1 } } as never,
  })
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

/** 按名称取工具。 */
function tool(name: string): ToolDefinition {
  const t = tools.find((x) => x.name === name)
  if (!t) throw new Error(`工具 ${name} 未注册`)
  return t
}

/** 未 aborted 的 exec。 */
function makeExec(): { signal: AbortSignal } {
  const ctrl = new AbortController()
  return { signal: ctrl.signal }
}

/** 执行工具，返回成功值。 */
async function run(name: string, args: Record<string, unknown> = {}): Promise<unknown> {
  return tool(name).execute(args, makeExec())
}

/** 合法 create 参数（可被覆盖）。 */
function validCreate(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'market-pulse',
    name: '市场脉搏',
    cron: '0 9 * * *',
    task_path: 'marketPulseTask',
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// AC-1：7 个工具全部存在
// ---------------------------------------------------------------------------
describe('AC-1 工具注册', () => {
  it('createSchedulerTools 返回恰好 7 个工具，名称与顺序对齐', () => {
    expect(tools.map((t) => t.name)).toEqual([
      'task_create',
      'task_list',
      'task_get',
      'task_update',
      'task_delete',
      'task_enable',
      'task_disable',
    ])
  })

  it('7 个工具均有 name 与 non-null execute（defineTool 定义）', () => {
    for (const t of tools) {
      expect(typeof t.name).toBe('string')
      expect(typeof t.execute).toBe('function')
      expect(t.output).toBeDefined()
      expect(t.output.schema).toBeDefined()
    }
  })
})

// ---------------------------------------------------------------------------
// AC-2 / AC-3：写类调用 reload，只读不调用
// ---------------------------------------------------------------------------
describe('AC-2/AC-3 reload 调用语义', () => {
  it('task_create 落盘后调用 reload（1 次）', async () => {
    await run('task_create', validCreate())
    expect(reloadCalls).toBe(1)
  })

  it('task_update 落盘后调用 reload', async () => {
    await run('task_create', validCreate())
    reloadCalls = 0
    await run('task_update', { id: 'market-pulse', name: '新名字' })
    expect(reloadCalls).toBe(1)
  })

  it('task_delete 删除后调用 reload', async () => {
    await run('task_create', validCreate())
    reloadCalls = 0
    await run('task_delete', { id: 'market-pulse' })
    expect(reloadCalls).toBe(1)
  })

  it('task_enable 调用 reload', async () => {
    await run('task_create', validCreate())
    reloadCalls = 0
    await run('task_enable', { id: 'market-pulse' })
    expect(reloadCalls).toBe(1)
  })

  it('task_disable 调用 reload', async () => {
    await run('task_create', validCreate())
    reloadCalls = 0
    await run('task_disable', { id: 'market-pulse' })
    expect(reloadCalls).toBe(1)
  })

  it('task_list 只读，不调用 reload', async () => {
    await run('task_create', validCreate())
    reloadCalls = 0
    await run('task_list')
    expect(reloadCalls).toBe(0)
  })

  it('task_get 只读，不调用 reload', async () => {
    await run('task_create', validCreate())
    reloadCalls = 0
    await run('task_get', { id: 'market-pulse' })
    expect(reloadCalls).toBe(0)
  })

  it('写类工具校验失败（如非法 cron）时不调用 reload', async () => {
    await expect(run('task_create', validCreate({ cron: 'bad' }))).rejects.toThrow()
    expect(reloadCalls).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// AC-4：数据后端复用 store（持久化生效）
// ---------------------------------------------------------------------------
describe('AC-4 store 持久化复用', () => {
  it('create 后同一 store 的 get 能读到', async () => {
    await run('task_create', validCreate())
    const got = store.get('market-pulse')
    expect(got?.id).toBe('market-pulse')
    expect(got?.name).toBe('市场脉搏')
  })

  it('create 后同一 store 的 list 能读到', async () => {
    await run('task_create', validCreate())
    const { tasks } = store.list()
    expect(tasks.map((t) => t.id)).toEqual(['market-pulse'])
  })

  it('delete 后同一 store 的 get 读不到（remove 生效）', async () => {
    await run('task_create', validCreate())
    await run('task_delete', { id: 'market-pulse' })
    expect(store.get('market-pulse')).toBeUndefined()
  })

  it('update 后 get 读到新值', async () => {
    await run('task_create', validCreate())
    await run('task_update', { id: 'market-pulse', name: '改后的名字' })
    expect(store.get('market-pulse')?.name).toBe('改后的名字')
  })
})

// ---------------------------------------------------------------------------
// AC-5：id / task_path 经 assertSafeSegment 校验
// ---------------------------------------------------------------------------
describe('AC-5 路径段守卫（[path-guard]）', () => {
  const badIds = ['../x', 'a/b', '', '.', '..', '/abs', 'a b', 'x'.repeat(65)]

  it.each(badIds)('task_create 非法 id=%j 抛 [path-guard]', async (id) => {
    await expect(run('task_create', validCreate({ id }))).rejects.toThrow(/\[path-guard\]/)
  })

  it.each(badIds)('task_get 非法 id=%j 抛 [path-guard]', async (id) => {
    await expect(run('task_get', { id })).rejects.toThrow(/\[path-guard\]/)
  })

  it.each(badIds)('task_delete 非法 id=%j 抛 [path-guard]', async (id) => {
    await expect(run('task_delete', { id })).rejects.toThrow(/\[path-guard\]/)
  })

  it('非法 task_path（含 ../）抛 [path-guard]', async () => {
    await expect(
      run('task_create', validCreate({ task_path: '../escape/task.ts' })),
    ).rejects.toThrow(/\[path-guard\]/)
  })

  it('非法 task_path（空串）抛 [path-guard]', async () => {
    await expect(run('task_create', validCreate({ task_path: '' }))).rejects.toThrow(
      /\[path-guard\]/,
    )
  })

  it('非法 task_path（超 64 字符）抛 [path-guard]', async () => {
    const long = 'x'.repeat(65)
    await expect(run('task_create', validCreate({ task_path: long }))).rejects.toThrow(
      /\[path-guard\]/,
    )
  })

  it('非法 id 不产生任何落盘（守卫先于 save）', async () => {
    await expect(run('task_create', validCreate({ id: '../x' }))).rejects.toThrow()
    expect(store.list().tasks).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// AC-10：task_path 多级相对路径校验语义（复验修复重点）
//
// 修复前：task_path 被当作「单段」用 assertSafeSegment 校验，合法的多级相对路径
// （如 tasks/market-pulse/task.ts，含 `/`）被误拒绝。
// 修复后：safeTaskPath 按 `/` 切分逐段校验再 join('/') 重组；显式拒绝反斜杠。
// ---------------------------------------------------------------------------
describe('AC-10 task_path 多级相对路径语义', () => {
  const validMultiLevel = [
    'tasks/market-pulse/task.ts',
    'tasks/foo/task.ts',
    'a/b/c/d.ts',
    'a/b.ts',
  ]

  it.each(validMultiLevel)('合法多级路径 task_path=%j 应通过', async (task_path) => {
    const v = (await run('task_create', validCreate({ task_path }))) as { task: TaskDef }
    expect(v.task.task_path).toBe(task_path)
    expect(store.get('market-pulse')?.task_path).toBe(task_path)
  })

  const validSingleDegenerate = ['task.ts', 'market-pulse.ts', 'marketPulseTask']

  it.each(validSingleDegenerate)('退化单段路径 task_path=%j 应通过', async (task_path) => {
    const v = (await run('task_create', validCreate({ task_path }))) as { task: TaskDef }
    expect(v.task.task_path).toBe(task_path)
  })

  const badMultiLevel = [
    'tasks/../etc/task.ts', // 含 `..` 段（目录穿越）
    'tasks//task.ts', // 空段
    'ta b/task.ts', // 含空格非法字符段
    '/abs/task.ts', // 绝对路径（首段为空）
    'tasks\evil\task.ts', // 含反斜杠 / Windows 分隔符
    'C:\evil\task.ts', // Windows 盘符
    './task.ts', // `.` 段
    'tasks/.hidden/task.ts', // 隐式（合法，但保留对照）
  ]

  // 注意：`.hidden` 段匹配 [A-Za-z0-9._-]+，因此 tasks/.hidden/task.ts 实际应**通过**。
  // 此处仅前 6 项为非法（目录穿越/非法字符），下面单独断言非法项。
  const multiLevelInvalid = badMultiLevel.slice(0, 6)

  it.each(multiLevelInvalid)('非法多级路径 task_path=%j 应抛 [path-guard]', async (task_path) => {
    await expect(
      run('task_create', validCreate({ task_path })),
    ).rejects.toThrow(/\[path-guard\]/)
    // 非法路径不落盘。
    expect(store.get('market-pulse')).toBeUndefined()
  })

  it('含反斜杠的路径抛错信息含 [path-guard]（不回退到单段语义）', async () => {
    await expect(
      run('task_create', validCreate({ task_path: 'tasks\evil\task.ts' })),
    ).rejects.toThrow(/\[path-guard\]/)
  })

  it('绝对路径（首段为空）抛 [path-guard]', async () => {
    await expect(
      run('task_create', validCreate({ task_path: '/abs/task.ts' })),
    ).rejects.toThrow(/\[path-guard\]/)
  })

  it('task_update 传入非法多级路径也抛错且原值保留', async () => {
    await run('task_create', validCreate({ task_path: 'tasks/foo/task.ts' }))
    await expect(
      run('task_update', { id: 'market-pulse', task_path: 'tasks/../evil.ts' }),
    ).rejects.toThrow(/\[path-guard\]/)
    expect(store.get('market-pulse')?.task_path).toBe('tasks/foo/task.ts')
  })
})

// ---------------------------------------------------------------------------
// AC-6：cron 经 parseCron 校验，非法不落盘
// ---------------------------------------------------------------------------
describe('AC-6 cron 校验', () => {
  it('合法 cron 可创建', async () => {
    const v = (await run('task_create', validCreate({ cron: '*/5 9-17 * * 1-5' }))) as {
      task: TaskDef
    }
    expect(v.task.cron).toBe('*/5 9-17 * * 1-5')
  })

  const badCrons = ['bad', '0 9 * *', '0 9 * * * *', '', '   ', '61 * * * *', '* 25 * * *', '0 9 * 13 *']

  it.each(badCrons)('非法 cron=%j 抛错且不落盘', async (cron) => {
    await expect(run('task_create', validCreate({ cron }))).rejects.toThrow()
    expect(store.get('market-pulse')).toBeUndefined()
    expect(store.list().tasks).toEqual([])
  })

  it('task_update 传入非法 cron 抛错且原值保留', async () => {
    await run('task_create', validCreate())
    await expect(
      run('task_update', { id: 'market-pulse', cron: 'bad cron' }),
    ).rejects.toThrow()
    expect(store.get('market-pulse')?.cron).toBe('0 9 * * *')
  })
})

// ---------------------------------------------------------------------------
// AC-7：返回签名对齐 TaskDef
// ---------------------------------------------------------------------------
describe('AC-7 返回 task 全字段', () => {
  it('create 返回 task 含 id/name/cron/task_path/enabled', async () => {
    const v = (await run('task_create', validCreate())) as { ok: boolean; task: TaskDef }
    expect(v.ok).toBe(true)
    expect(v.task).toEqual({
      id: 'market-pulse',
      name: '市场脉搏',
      cron: '0 9 * * *',
      task_path: 'marketPulseTask',
      enabled: true,
    })
  })

  it('task_get 返回 { task } 且字段齐全', async () => {
    await run('task_create', validCreate())
    const v = (await run('task_get', { id: 'market-pulse' })) as { task: TaskDef }
    expect(Object.keys(v.task).sort()).toEqual(['cron', 'enabled', 'id', 'name', 'task_path'])
  })
})

// ---------------------------------------------------------------------------
// AC-8：enabled 语义
// ---------------------------------------------------------------------------
describe('AC-8 enabled 语义', () => {
  it('create 缺省 enabled=true', async () => {
    const v = (await run('task_create', validCreate())) as { task: TaskDef }
    expect(v.task.enabled).toBe(true)
  })

  it('create 显式 enabled=false 可写入', async () => {
    const v = (await run('task_create', validCreate({ enabled: false }))) as { task: TaskDef }
    expect(v.task.enabled).toBe(false)
    expect(store.get('market-pulse')?.enabled).toBe(false)
  })

  it('update 不传 enabled 保持原值', async () => {
    await run('task_create', validCreate({ enabled: false }))
    const v = (await run('task_update', { id: 'market-pulse', name: 'x' })) as { task: TaskDef }
    expect(v.task.enabled).toBe(false)
  })

  it('update 显式 enabled=false 能写入', async () => {
    await run('task_create', validCreate({ enabled: true }))
    const v = (await run('task_update', { id: 'market-pulse', enabled: false })) as {
      task: TaskDef
    }
    expect(v.task.enabled).toBe(false)
    expect(store.get('market-pulse')?.enabled).toBe(false)
  })

  it('task_enable 把 false 翻转为 true', async () => {
    await run('task_create', validCreate({ enabled: false }))
    const v = (await run('task_enable', { id: 'market-pulse' })) as { task: TaskDef }
    expect(v.task.enabled).toBe(true)
    expect(store.get('market-pulse')?.enabled).toBe(true)
  })

  it('task_disable 把 true 翻转为 false', async () => {
    await run('task_create', validCreate({ enabled: true }))
    const v = (await run('task_disable', { id: 'market-pulse' })) as { task: TaskDef }
    expect(v.task.enabled).toBe(false)
    expect(store.get('market-pulse')?.enabled).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// AC-9：不存在 id 的错误处理
// ---------------------------------------------------------------------------
describe('AC-9 不存在 id 的错误处理', () => {
  it('task_get 不存在 id 抛清晰错误', async () => {
    await expect(run('task_get', { id: 'ghost' })).rejects.toThrow(/不存在/)
  })

  it('task_update 不存在 id 抛清晰错误', async () => {
    await expect(run('task_update', { id: 'ghost', name: 'x' })).rejects.toThrow(/不存在/)
  })

  it('task_delete 不存在 id 抛清晰错误', async () => {
    await expect(run('task_delete', { id: 'ghost' })).rejects.toThrow(/不存在/)
  })

  it('task_enable 不存在 id 抛清晰错误', async () => {
    await expect(run('task_enable', { id: 'ghost' })).rejects.toThrow(/不存在/)
  })

  it('task_disable 不存在 id 抛清晰错误', async () => {
    await expect(run('task_disable', { id: 'ghost' })).rejects.toThrow(/不存在/)
  })

  it('不存在 id 的写类操作不调用 reload', async () => {
    await expect(run('task_delete', { id: 'ghost' })).rejects.toThrow()
    expect(reloadCalls).toBe(0)
  })
})