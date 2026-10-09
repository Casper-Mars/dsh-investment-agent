/**
 * T11 跨模块集成 + 契约测试（一）：`tools → store → scheduler.reload → 到点调度`
 * 真实模块组合（无 `src/**` 改动、无模块 mock）。
 *
 * 唯一权威设计文档：《感知层详细设计（dsh-finance 插件）》 v0.7。
 *
 * 本文件补齐 tester-task9 / scheduler-tools 单测**未覆盖**的端到端链路：
 *   - 既有 `scheduler-tools.test.ts` 用 FakeStore + mock scheduler（reload 仅计数），
 *     **未验证**真实 `Scheduler` 在写库后 reload 是否真的把新任务装进 timer。
 *   - 本文件用 **真实 TaskStore（tmp 目录）+ 真实 Scheduler（注入假 Timer/Clock +
 *     FakeRunner）+ 真实 createSchedulerTools**，验证「写后即时生效」端到端：
 *     create → 落盘 → reload → 新任务被调度；disable → reload → timer 被清；
 *     enable → 重新调度；update cron → 按新 cron 重算；delete → timer 被清。
 *
 * 另补两组**契约**（对齐 types.ts TaskDef / store 持久化结构）与一组**边界**
 * （月底 L cron 跨月，经真实 cron 引擎 + 假 clock 驱动真实 Scheduler）。
 *
 * 全部依赖注入替身（tmp 目录 store / 假 timer / 假 clock / FakeRunner），
 * 不依赖真实网络、真实时间或长时等待。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'

import { TaskStore } from '../src/scheduler/store.js'
import { createScheduler } from '../src/scheduler/scheduler.js'
import { createSchedulerTools } from '../src/scheduler/tools.js'
import type {
  Clock,
  TaskDef,
  TaskRunOutcome,
  Timer,
  TimerHandle,
} from '../src/scheduler/types.js'

// ---------------------------------------------------------------------------
// 测试替身（真实模块只换「外设」：timer / clock / runner）
// ---------------------------------------------------------------------------

/** 内存 fake timer（同 scheduler.test.ts 的可控实现，不用 vitest fake timers）。 */
class FakeTimer implements Timer {
  timers: { at: number; cb: () => void; id: number }[] = []
  cleared: number[] = []
  lastId = 0
  constructor(private clock: Clock) {}

  setTimer(delayMs: number, cb: () => void): TimerHandle {
    const id = ++this.lastId
    this.timers.push({ at: this.clock.now().getTime() + delayMs, cb, id })
    return id as unknown as TimerHandle
  }

  clearTimer(handle: TimerHandle): void {
    const id = handle as unknown as number
    this.cleared.push(id)
    this.timers = this.timers.filter((t) => t.id !== id)
  }

  /** 触发到点时间 <= nowMs 的所有回调（模拟真实时钟推进）。 */
  fireDue(nowMs: number): void {
    const due = this.timers.filter((t) => t.at <= nowMs).sort((a, b) => a.at - b.at)
    this.timers = this.timers.filter((t) => t.at > nowMs)
    for (const t of due) t.cb()
  }

  get pending(): number {
    return this.timers.length
  }
}

/** 可控时钟。 */
class FakeClock implements Clock {
  constructor(private current: Date) {}
  now(): Date {
    return this.current
  }
  set(d: Date): void {
    this.current = d
  }
}

/** 记录 run 调用、恒返回 quiet 的执行器替身（scheduler 只消费 outcome）。 */
class FakeRunner {
  calls: string[] = []
  run(taskId: string, taskPath: string): Promise<TaskRunOutcome> {
    this.calls.push(taskPath)
    return Promise.resolve({ kind: 'quiet', reason: 'ok' })
  }
}

/** 内存任务清单 source（仅供边界用例的 Scheduler 直接注入）。 */
class FakeStore {
  constructor(public tasks: TaskDef[] = [], public corrupted: string[] = []) {}
  list() {
    return { tasks: this.tasks.slice(), corrupted: this.corrupted.slice() }
  }
}

/** 构造一条合法 TaskDef。 */
function makeTask(id: string, overrides: Partial<TaskDef> = {}): TaskDef {
  return {
    id,
    name: `任务-${id}`,
    cron: '0 9 * * *',
    task_path: `tasks/${id}/task.ts`,
    enabled: true,
    ...overrides,
  }
}

/** 基准「当前」时刻：2026-10-08 08:00:00 UTC = 16:00 Asia/Shanghai。 */
const BASE = new Date('2026-10-08T08:00:00Z')

// ---------------------------------------------------------------------------
// 工具调用辅助（复用 scheduler-tools.test.ts 的调用约定）
// ---------------------------------------------------------------------------

const tmpDirs: string[] = []
function mkTmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'dsh-t11-tsi-'))
  tmpDirs.push(d)
  return d
}

function tool(tools: ToolDefinition[], name: string): ToolDefinition {
  const t = tools.find((x) => x.name === name)
  if (!t) throw new Error(`工具 ${name} 未注册`)
  return t
}

function makeExec(): { signal: AbortSignal } {
  return { signal: new AbortController().signal }
}

function run(
  tools: ToolDefinition[],
  name: string,
  args: Record<string, unknown> = {},
): Promise<any> {
  return tool(tools, name).execute(args as never, makeExec() as never) as Promise<any>
}

afterEach(() => {
  for (const d of tmpDirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  }
})

// ===========================================================================
// A. 真实 tools → 真实 store → 真实 scheduler.reload → 到点调度（写后即时生效）
// ===========================================================================

describe('T11-I1 tools→store→scheduler 端到端：写后即时生效', () => {
  it('task_create 落盘 → reload → 新任务被调度；到点触发 FakeRunner；disable/enable/delete 同步 timer', async () => {
    const dir = mkTmp()
    const tasksDir = join(dir, 'tasks')
    const store = new TaskStore(tasksDir)
    const clock = new FakeClock(BASE)
    const timer = new FakeTimer(clock)
    const runner = new FakeRunner()

    const scheduler = createScheduler({ store, runner, timer, clock })
    scheduler.start()
    expect(timer.pending).toBe(0) // 初始空清单

    const tools = createSchedulerTools({ store, scheduler })

    // ---- create：写库 + reload → 新增一条 timer ----
    const created = await run(tools, 'task_create', {
      id: 'market-pulse',
      name: '市场脉搏',
      cron: '0 9 * * *',
      task_path: 'tasks/market-pulse/task.ts',
    })
    expect(created.ok).toBe(true)
    expect(created.task).toEqual({
      id: 'market-pulse',
      name: '市场脉搏',
      cron: '0 9 * * *',
      task_path: 'tasks/market-pulse/task.ts',
      enabled: true,
    })
    // 落盘真实存在
    expect(existsSync(join(tasksDir, 'market-pulse.json'))).toBe(true)
    // reload 即时生效：新任务已被装上 timer
    expect(timer.pending).toBe(1)

    // ---- 到点触发：FakeRunner 被调用（scheduler 消费 outcome，只记录不投递） ----
    const firstAt = timer.timers[0].at
    clock.set(new Date(firstAt))
    timer.fireDue(firstAt)
    await vi.waitFor(() => expect(runner.calls.length).toBe(1))
    expect(runner.calls[0]).toBe('tasks/market-pulse/task.ts')
    // 链式自调度：触发后重设下一次 timer
    await vi.waitFor(() => expect(timer.pending).toBe(1))

    // ---- disable：reload → 原 timer 被清（无泄漏） ----
    const disabled = await run(tools, 'task_disable', { id: 'market-pulse' })
    expect(disabled.task.enabled).toBe(false)
    expect(timer.pending).toBe(0)

    // ---- enable：reload → 重新调度 ----
    await run(tools, 'task_enable', { id: 'market-pulse' })
    expect(timer.pending).toBe(1)

    // ---- update cron：reload → 按新 cron 重算（到点时刻变化） ----
    const beforeAt = timer.timers[0].at
    await run(tools, 'task_update', { id: 'market-pulse', cron: '30 10 * * *' })
    expect(timer.pending).toBe(1)
    expect(timer.timers[0].at).not.toBe(beforeAt)

    // ---- delete：reload → timer 被清、磁盘记录消失 ----
    const deleted = await run(tools, 'task_delete', { id: 'market-pulse' })
    expect(deleted.ok).toBe(true)
    expect(timer.pending).toBe(0)
    expect(store.get('market-pulse')).toBeUndefined()
    expect(existsSync(join(tasksDir, 'market-pulse.json'))).toBe(false)
  })

  it('多任务并存：各自独立 timer；disable 其一不影响另一', async () => {
    const dir = mkTmp()
    const store = new TaskStore(join(dir, 'tasks'))
    const clock = new FakeClock(BASE)
    const timer = new FakeTimer(clock)
    const runner = new FakeRunner()
    const scheduler = createScheduler({ store, runner, timer, clock })
    scheduler.start()
    const tools = createSchedulerTools({ store, scheduler })

    await run(tools, 'task_create', {
      id: 'a',
      name: 'A',
      cron: '0 9 * * *',
      task_path: 'tasks/a/task.ts',
    })
    await run(tools, 'task_create', {
      id: 'b',
      name: 'B',
      cron: '30 10 * * *',
      task_path: 'tasks/b/task.ts',
    })
    expect(timer.pending).toBe(2)

    // 两个任务到点时刻不同（各自 cron 独立 next）。
    const times = timer.timers.map((t) => t.at).sort((x, y) => x - y)
    expect(times[0]).not.toBe(times[1])

    // disable a → 只剩 b
    await run(tools, 'task_disable', { id: 'a' })
    expect(timer.pending).toBe(1)

    // b 仍可触发
    const at = timer.timers[0].at
    clock.set(new Date(at))
    timer.fireDue(at)
    await vi.waitFor(() => expect(runner.calls).toContain('tasks/b/task.ts'))
  })
})

// ===========================================================================
// B. 契约：store 持久化文件结构对齐 TaskDef
// ===========================================================================

describe('T11-C1 store 持久化结构契约（对齐 TaskDef 全字段）', () => {
  it('落盘 JSON 恰含 TaskDef 五字段（id/name/cron/task_path/enabled），round-trip 等价', () => {
    const dir = mkTmp()
    const tasksDir = join(dir, 'tasks')
    const store = new TaskStore(tasksDir)
    const task: TaskDef = {
      id: 'contract',
      name: '契约任务',
      cron: '0 9 * * *',
      task_path: 'tasks/contract/task.ts',
      enabled: true,
    }
    store.save(task)

    const raw = JSON.parse(readFileSync(join(tasksDir, 'contract.json'), 'utf8'))
    expect(Object.keys(raw).sort()).toEqual([
      'cron',
      'enabled',
      'id',
      'name',
      'task_path',
    ])
    expect(raw).toEqual(task)
    // 读回等价（跨实例 round-trip）
    expect(store.get('contract')).toEqual(task)
    expect(new TaskStore(tasksDir).get('contract')).toEqual(task)
  })

  it('list() 对缺字段记录判为 corrupted；对多余字段记录仍然接受（守卫只做最小结构校验）', () => {
    const dir = mkTmp()
    const tasksDir = join(dir, 'tasks')
    const store = new TaskStore(tasksDir)
    mkdirSync(tasksDir, { recursive: true })

    // 缺 enabled → 损坏
    writeFileSync(
      join(tasksDir, 'missing.json'),
      JSON.stringify({ id: 'missing', name: 'M', cron: '0 9 * * *', task_path: 't' }),
      'utf8',
    )
    // 多余字段 → 仍为合法（结构守卫只要求五字段存在且类型吻合）
    writeFileSync(
      join(tasksDir, 'extra.json'),
      JSON.stringify({
        id: 'extra',
        name: 'E',
        cron: '0 9 * * *',
        task_path: 'tasks/extra/task.ts',
        enabled: true,
        extra_field: 'tolerated',
      }),
      'utf8',
    )
    // 类型不符 → 损坏
    writeFileSync(
      join(tasksDir, 'badenabled.json'),
      JSON.stringify({ id: 'badenabled', name: 'BE', cron: 'x', task_path: 't', enabled: 'true' }),
      'utf8',
    )

    const { tasks, corrupted } = store.list()
    expect(corrupted.sort()).toEqual(['missing', 'badenabled'].sort())
    expect(tasks.map((t) => t.id)).toEqual(['extra'])
    // 多余字段被原样保留（契约：守卫不做白名单裁剪）
    expect((tasks[0] as Record<string, unknown>)['extra_field']).toBe('tolerated')
  })
})

// ===========================================================================
// C. 边界：月底 L cron 经真实 cron 引擎 + 假 clock 驱动真实 Scheduler
// ===========================================================================

describe('T11-B1 边界：月底 L cron 跨月（真实 cron + 假 clock）', () => {
  it('每月最后一天 09:00（Shanghai）：4 月 15 起算 → 4/30 09:00 触发 → 重设为 5/31 09:00', async () => {
    const clock = new FakeClock(new Date('2026-04-15T00:00:00Z')) // Shanghai 04-15 08:00
    const timer = new FakeTimer(clock)
    const runner = new FakeRunner()
    const store = new FakeStore([makeTask('eom', { cron: '0 9 L * *' })])

    const scheduler = createScheduler({ store, runner, timer, clock })
    scheduler.start()

    // 下次触发 = 2026-04-30 09:00 Asia/Shanghai = 2026-04-30T01:00:00Z
    expect(timer.pending).toBe(1)
    expect(timer.timers[0].at).toBe(Date.parse('2026-04-30T01:00:00Z'))

    // 触发 → runner 被调；重设为 2026-05-31 09:00 Shanghai = 2026-05-31T01:00:00Z（跨月）
    clock.set(new Date('2026-04-30T01:00:00Z'))
    timer.fireDue(clock.now().getTime())
    await vi.waitFor(() => expect(runner.calls).toContain('tasks/eom/task.ts'))
    await vi.waitFor(() => expect(timer.pending).toBe(1))
    expect(timer.timers[0].at).toBe(Date.parse('2026-05-31T01:00:00Z'))
  })

  it('跨天：23:50 → 次日 00:00（真实 cron + 假 clock，经 Scheduler 触发链）', async () => {
    const clock = new FakeClock(new Date('2026-10-08T15:50:00Z')) // Shanghai 23:50 当日
    const timer = new FakeTimer(clock)
    const runner = new FakeRunner()
    const store = new FakeStore([makeTask('midnight', { cron: '0 0 * * *' })]) // 每日 00:00

    const scheduler = createScheduler({ store, runner, timer, clock })
    scheduler.start()

    // 下次触发 = 次日 00:00 Shanghai = 2026-10-08T16:00:00Z
    expect(timer.timers[0].at).toBe(Date.parse('2026-10-08T16:00:00Z'))

    clock.set(new Date('2026-10-08T16:00:00Z'))
    timer.fireDue(clock.now().getTime())
    await vi.waitFor(() => expect(runner.calls).toContain('tasks/midnight/task.ts'))
  })
})
