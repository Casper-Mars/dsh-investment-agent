/**
 * tester-t100461-scheduler-assets.INDEPENDENT.spec.ts
 *
 * 独立验证：任务-04「任务定义与任务程序迁出到 assets/tasks + assets/programs」。
 *
 * 覆盖 Task 下发的验收 1–4 与额外必测 5–12：
 *   1. 调度器读取 assets/tasks（定义）+ assets/programs（程序），cron 触发 / 唤醒链路；
 *   2. task_path 全指向新位置；程序与依赖件都在 assets/programs 内；非法前缀被拒；
 *   3. tsc --noEmit EXIT=0 与定向测试（在 REPORT 中记录命令与输出，本 spec 覆盖运行期行为）；
 *   4. DSH_IA_HOME=<tmp> 下不产生 <tmp>/data/tasks；
 *   5. defaultTasksDir() = <home>/assets/tasks；
 *   6. task_path 绝对路径解析 = <home>/assets/programs/<id>/task.ts（无 assets/assets、无 data）；
 *   7. task_create / task_update 前缀校验矩阵（接受 2 条 / 拒绝 7 条）；
 *   8. 工具 CRUD 往返，落盘 <home>/assets/tasks；
 *   9. loader 的 pnpm install cwd = assets/programs/<id>/，依赖件（lib/）在该目录可解析；
 *  10. fake timers 驱动 cron → loader → runner → shouldWake → waker 投递，断言 taskId / 文本；
 *  11. 旧的任务目录解析导出已彻底删除（grep 在 REPORT 记录，源码/测试均无残留）；
 *  12. tester-path-fixed-dir 的破坏性 rmSync 已修复（grep + diff 在 REPORT 记录）。
 *
 * 隔离与安全：
 *   - 全部用例使用 `mkdtempSync(tmpdir())` + `DSH_IA_HOME`，**不读写真实 `~/.dsh-ia`**；
 *   - 不运行真实 pnpm / 真实子进程：loader/runner 工厂经 `vi.mock` 注入替身，
 *     但保留真实 TaskLoader / TaskRunner / Waker / Scheduler / TaskStore 行为；
 *   - 不改动 `src/**` 与 Developer 的测试文件。
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { PassThrough } from 'node:stream'

// ---------------------------------------------------------------------------
// vi.hoisted：可替换工厂 + 装配捕获（vi.mock 工厂读取，避免 TDZ）
// ---------------------------------------------------------------------------

const H = vi.hoisted(() => ({
  /** 覆盖 loader 工厂返回值；null → 真实 createTaskLoader。 */
  loaderImpl: { value: null as unknown },
  /** 覆盖 runner 工厂返回值；null → 真实 createTaskRunner。 */
  runnerImpl: { value: null as unknown },
  /** applyScheduler 内部 createScheduler 入参捕获（取编排 runner）。 */
  schedulerOptions: { value: null as unknown },
  /** waker.wake(taskId, data) 调用记录（真实 Waker 外包一层观测）。 */
  wakeCalls: [] as Array<{ taskId: string; data: string }>,
}))

vi.mock('../src/scheduler/loader.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/scheduler/loader.js')>()
  return {
    ...actual,
    createTaskLoader: (opts?: unknown) =>
      H.loaderImpl.value ?? actual.createTaskLoader(opts as never),
  }
})

vi.mock('../src/scheduler/runner.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/scheduler/runner.js')>()
  return {
    ...actual,
    createTaskRunner: (opts?: unknown) =>
      H.runnerImpl.value ?? actual.createTaskRunner(opts as never),
  }
})

vi.mock('../src/scheduler/wake.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/scheduler/wake.js')>()
  return {
    ...actual,
    createWaker: (opts: unknown) => {
      const inner = actual.createWaker(opts as never)
      // 仅观测，不改变真实 Waker 的投递 / 冷却语义。
      return {
        wake(taskId: string, data: string, traceId?: string) {
          H.wakeCalls.push({ taskId, data })
          return inner.wake(taskId, data, traceId)
        },
      }
    },
  }
})

vi.mock('../src/scheduler/scheduler.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/scheduler/scheduler.js')>()
  return {
    ...actual,
    createScheduler: (options: unknown) => {
      H.schedulerOptions.value = options
      return actual.createScheduler(options as never)
    },
  }
})

import { applyScheduler } from '../src/scheduler/index.js'
import {
  createTaskLoader,
  type InstallSpawner,
  type InstallSpawnResult,
  type LoaderFs,
} from '../src/scheduler/loader.js'
import { createTaskRunner } from '../src/scheduler/runner.js'
import { createTaskStore, defaultTasksDir } from '../src/scheduler/store.js'
import { createSchedulerTools } from '../src/scheduler/tools.js'
import type { Spawner, TaskProcess } from '../src/scheduler/types.js'
import {
  resolveAssetsProgramsDir,
  resolveAssetsTasksDir,
  resolveFinanceHomeDir,
} from '../src/paths.js'
import { FINANCE_HOME_ENV } from '../src/flags.js'

// ---------------------------------------------------------------------------
// 临时 home 隔离
// ---------------------------------------------------------------------------

const SAVED_HOME_ENV = process.env[FINANCE_HOME_ENV]
const tmpDirs: string[] = []

function mkTmpHome(): string {
  const dir = mkdtempSync(join(tmpdir(), 't100461-home-'))
  tmpDirs.push(dir)
  process.env[FINANCE_HOME_ENV] = dir
  return dir
}

function restoreHomeEnv(): void {
  if (SAVED_HOME_ENV === undefined) delete process.env[FINANCE_HOME_ENV]
  else process.env[FINANCE_HOME_ENV] = SAVED_HOME_ENV
}

beforeEach(() => {
  H.loaderImpl.value = null
  H.runnerImpl.value = null
  H.schedulerOptions.value = null
  H.wakeCalls.length = 0
})

afterEach(() => {
  disposeCtx(activeCtx)
  activeCtx = null
  restoreHomeEnv()
  for (const d of tmpDirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  }
})

afterAll(() => {
  restoreHomeEnv()
})

// ---------------------------------------------------------------------------
// 工具 / 文件辅助
// ---------------------------------------------------------------------------

/** 未 aborted 的 exec 上下文。 */
function makeExec(): { signal: AbortSignal } {
  return { signal: new AbortController().signal }
}

function setupTools(): {
  store: ReturnType<typeof createTaskStore>
  run: (name: string, args?: Record<string, unknown>) => Promise<unknown>
  reloads: () => number
} {
  const store = createTaskStore()
  let reloadCount = 0
  const tools = createSchedulerTools({
    store,
    scheduler: {
      reload: () => {
        reloadCount += 1
      },
    } as never,
  })
  const run = async (
    name: string,
    args: Record<string, unknown> = {},
  ): Promise<unknown> => {
    const t = tools.find((x) => x.name === name)
    if (!t) throw new Error(`工具 ${name} 未注册`)
    return t.execute(args, makeExec())
  }
  return { store, run, reloads: () => reloadCount }
}

function writeTaskDef(
  home: string,
  def: {
    id: string
    name: string
    cron: string
    task_path: string
    enabled: boolean
  },
): void {
  const dir = join(home, 'assets', 'tasks')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${def.id}.json`), JSON.stringify(def, null, 2), 'utf8')
}

/** 写任务程序入口 + package.json + 依赖件 lib/x.ts。 */
function writeProgram(home: string, relTaskPath: string): string {
  const abs = resolve(home, relTaskPath)
  mkdirSync(dirname(abs), { recursive: true })
  writeFileSync(abs, '// task entry\n', 'utf8')
  const programDir = dirname(abs)
  writeFileSync(
    join(programDir, 'package.json'),
    JSON.stringify({ name: 'task-program', private: true }, null, 2),
    'utf8',
  )
  mkdirSync(join(programDir, 'lib'), { recursive: true })
  writeFileSync(join(programDir, 'lib', 'x.ts'), 'export const x = 1\n', 'utf8')
  return abs
}

// ---------------------------------------------------------------------------
// Fake ctx（仅 applyScheduler 用到的 get / inject / effect）
// ---------------------------------------------------------------------------

interface FakeCtx {
  services: Record<string, unknown>
  effects: Array<{ label?: string; dispose: () => void }>
  injects: Array<{ deps: readonly string[]; cb: (c: any) => void }>
  get: (name: string) => unknown
  inject: (deps: string[], cb: (c: any) => void) => () => void
  effect: (body: () => unknown, label?: string) => () => void
}

function makeCtx(services: Record<string, unknown> = {}): FakeCtx {
  const effects: FakeCtx['effects'] = []
  const injects: FakeCtx['injects'] = []
  return {
    services,
    effects,
    injects,
    get: (name) => services[name],
    inject(deps, cb) {
      injects.push({ deps, cb })
      return () => {}
    },
    effect(body, label) {
      const d = body()
      const dispose = typeof d === 'function' ? (d as () => void) : () => {}
      effects.push({ label, dispose })
      return dispose
    },
  }
}

let activeCtx: FakeCtx | null = null

function disposeCtx(ctx: FakeCtx | null): void {
  if (!ctx) return
  for (const e of ctx.effects) {
    try {
      e.dispose()
    } catch {
      /* ignore */
    }
  }
}

function boot(services: Record<string, unknown> = {}): FakeCtx {
  disposeCtx(activeCtx)
  const ctx = makeCtx(services)
  activeCtx = ctx
  applyScheduler(ctx, { logger: () => {} })
  return ctx
}

/** 抓取 applyScheduler 内部构造的「编排 runner」。 */
function orch(): { run: (taskId: string, taskPath: string) => Promise<any> } {
  return (H.schedulerOptions.value as { runner: any }).runner
}

// ---------------------------------------------------------------------------
// 注入替身：mock 任务进程 / spawner / install spawner / agents
// ---------------------------------------------------------------------------

class FakeProcess implements TaskProcess {
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  exitCode: number | null = null
  killed: NodeJS.Signals[] = []
  kill(signal?: NodeJS.Signals): void {
    if (signal) this.killed.push(signal)
  }
  writeStdout(text: string): void {
    this.stdout.write(text)
  }
  end(exitCode: number | null): void {
    this.exitCode = exitCode
    this.stdout.end()
    this.stderr.end()
  }
}

function makeSpawner(program: (p: FakeProcess) => void): {
  spawner: Spawner
  spawn: ReturnType<typeof vi.fn>
} {
  const spawn = vi.fn((_taskPath: string) => {
    const proc = new FakeProcess()
    queueMicrotask(() => program(proc))
    return proc
  })
  return { spawner: { spawn } as Spawner, spawn: spawn as never }
}

function makeInstallSpawner(
  onInstall?: (cwd: string) => void,
): { spawner: InstallSpawner; install: ReturnType<typeof vi.fn> } {
  const install = vi.fn(async (cwd: string, _timeoutMs: number) => {
    onInstall?.(cwd)
    return { exitCode: 0, killed: false, reason: 'exit' } as InstallSpawnResult
  })
  return { spawner: { install } as InstallSpawner, install: install as never }
}

/** 真实 fs（严格校验 assets/programs/<id> 下 package.json 确实存在）。 */
const realFs: LoaderFs = {
  dirExists: (p) => existsSync(p),
  packageJsonExists: (p) => existsSync(join(p, 'package.json')),
}

/** agents 注册表：任一 id 均可命中（DSH_IA_HOME 会派生不同 session id）。 */
function makeAgents(followup: (m: unknown) => void) {
  return {
    get: (id: string) => ({ id, followup }),
  }
}

// ===========================================================================
// 额外 5 / 11：默认目录 + 旧导出清理
// ===========================================================================

describe('AC5 默认任务目录', () => {
  it('DSH_IA_HOME=<tmp> 时 defaultTasksDir() = <tmp>/assets/tasks', () => {
    const home = mkTmpHome()
    expect(defaultTasksDir()).toBe(join(home, 'assets', 'tasks'))
    expect(resolveAssetsTasksDir()).toBe(join(home, 'assets', 'tasks'))
    expect(resolveAssetsProgramsDir()).toBe(join(home, 'assets', 'programs'))
    expect(resolveFinanceHomeDir()).toBe(home)
  })

  it('未设置 DSH_IA_HOME 时回落 ~/.dsh-ia/assets/tasks（纯计算，不落盘）', () => {
    delete process.env[FINANCE_HOME_ENV]
    expect(defaultTasksDir()).toBe(join(homedir(), '.dsh-ia', 'assets', 'tasks'))
  })
})

// ===========================================================================
// 验收 4 / 8：无旧路径写入 + 工具 CRUD 往返
// ===========================================================================

describe('AC4/AC8 默认 store + 工具 CRUD 往返（assets/tasks，无 data/tasks）', () => {
  it('默认 store 只写 <home>/assets/tasks，不产生 <home>/data', () => {
    const home = mkTmpHome()
    const store = createTaskStore()
    const task = {
      id: 'market-pulse',
      name: '市场脉搏',
      cron: '0 9 * * *',
      task_path: 'assets/programs/market-pulse/task.ts',
      enabled: true,
    }
    store.save(task)

    expect(existsSync(join(home, 'assets', 'tasks', 'market-pulse.json'))).toBe(true)
    expect(store.get('market-pulse')).toEqual(task)
    expect(existsSync(join(home, 'data', 'tasks'))).toBe(false)
    expect(existsSync(join(home, 'data'))).toBe(false)
  })

  it('task_create → task_list → task_get → task_update → task_delete 全链路', async () => {
    const home = mkTmpHome()
    const { store, run, reloads } = setupTools()

    const created = (await run('task_create', {
      id: 'crud-1',
      name: 'CRUD 1',
      cron: '0 9 * * *',
      task_path: 'assets/programs/crud-1/task.ts',
    })) as any
    expect(created.ok).toBe(true)
    expect(created.task.task_path).toBe('assets/programs/crud-1/task.ts')

    const file = join(home, 'assets', 'tasks', 'crud-1.json')
    expect(existsSync(file)).toBe(true)
    expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({
      id: 'crud-1',
      task_path: 'assets/programs/crud-1/task.ts',
      enabled: true,
    })

    const listed = (await run('task_list')) as any
    expect(listed.tasks.map((t: any) => t.id)).toEqual(['crud-1'])
    expect(listed.corrupted).toEqual([])

    const got = (await run('task_get', { id: 'crud-1' })) as any
    expect(got.task.name).toBe('CRUD 1')

    const updated = (await run('task_update', {
      id: 'crud-1',
      name: 'CRUD 1 renamed',
      task_path: 'assets/programs/crud-1/lib/entry.ts',
    })) as any
    expect(updated.task.name).toBe('CRUD 1 renamed')
    expect(updated.task.task_path).toBe('assets/programs/crud-1/lib/entry.ts')
    expect(JSON.parse(readFileSync(file, 'utf8')).task_path).toBe(
      'assets/programs/crud-1/lib/entry.ts',
    )

    const deleted = (await run('task_delete', { id: 'crud-1' })) as any
    expect(deleted).toEqual({ ok: true, id: 'crud-1' })
    expect(existsSync(file)).toBe(false)
    await expect(run('task_get', { id: 'crud-1' })).rejects.toThrow(/不存在/)

    // 写类工具 4 次 reload（create/update/delete；list/get 不计）。
    expect(reloads()).toBe(3)
    expect(store.list().tasks).toEqual([])

    // 全程无旧路径写入。
    expect(existsSync(join(home, 'data', 'tasks'))).toBe(false)
    expect(existsSync(join(home, 'data'))).toBe(false)
  })
})

// ===========================================================================
// 额外 7：前缀校验矩阵（task_create / task_update）
// ===========================================================================

const ACCEPTED_PATHS = ['assets/programs/p1/task.ts', 'assets/programs/p1/lib/x.ts']

const REJECTED_PREFIX = [
  { path: 'tasks/p1/task.ts', why: '旧 tasks/ 前缀' },
  { path: 'data/tasks/p1/task.ts', why: '旧 data/tasks 前缀' },
  { path: 'assets/tasks/p1/task.ts', why: '定义目录冒充程序目录' },
  { path: 'assets/programs', why: '段数不足（无文件名）' },
]

const REJECTED_STRUCTURAL = [
  { path: 'assets/programs/../x.ts', why: '目录穿越 ..' },
  { path: '/abs/assets/programs/x.ts', why: '绝对路径' },
  { path: 'assets\\programs\\x.ts', why: 'Windows 反斜杠' },
]

describe('AC7 前缀校验矩阵', () => {
  it('task_create 接受 assets/programs/ 下的多级相对路径', async () => {
    const home = mkTmpHome()
    const { run } = setupTools()
    for (let i = 0; i < ACCEPTED_PATHS.length; i += 1) {
      const id = `ok-${i}`
      const res = (await run('task_create', {
        id,
        name: id,
        cron: '0 9 * * *',
        task_path: ACCEPTED_PATHS[i],
      })) as any
      expect(res.ok).toBe(true)
      const persisted = JSON.parse(
        readFileSync(join(home, 'assets', 'tasks', `${id}.json`), 'utf8'),
      )
      expect(persisted.task_path).toBe(ACCEPTED_PATHS[i])
    }
  })

  it('task_create 拒绝 4 条前缀违规，错误信息含“必须以 assets/programs/ 开头”', async () => {
    const home = mkTmpHome()
    const { store, run } = setupTools()
    for (let i = 0; i < REJECTED_PREFIX.length; i += 1) {
      await expect(
        run('task_create', {
          id: `bad-${i}`,
          name: 'bad',
          cron: '0 9 * * *',
          task_path: REJECTED_PREFIX[i].path,
        }),
        REJECTED_PREFIX[i].why,
      ).rejects.toThrow(/必须以 assets\/programs\/ 开头/)
    }
    expect(store.list().tasks).toEqual([])
    expect(existsSync(join(home, 'assets', 'tasks'))).toBe(false)
  })

  it('task_create 拒绝 3 条结构非法路径（[path-guard]）', async () => {
    mkTmpHome()
    const { store, run } = setupTools()
    for (let i = 0; i < REJECTED_STRUCTURAL.length; i += 1) {
      await expect(
        run('task_create', {
          id: `struct-${i}`,
          name: 'bad',
          cron: '0 9 * * *',
          task_path: REJECTED_STRUCTURAL[i].path,
        }),
        REJECTED_STRUCTURAL[i].why,
      ).rejects.toThrow(/\[path-guard\] task_path 非法/)
    }
    expect(store.list().tasks).toEqual([])
  })

  it('task_update 同样接受合法路径 / 拒绝非法路径，且失败不改写原记录', async () => {
    const home = mkTmpHome()
    const { store, run } = setupTools()
    await run('task_create', {
      id: 'upd',
      name: 'upd',
      cron: '0 9 * * *',
      task_path: 'assets/programs/upd/task.ts',
    })

    for (const p of ACCEPTED_PATHS) {
      const res = (await run('task_update', { id: 'upd', task_path: p })) as any
      expect(res.task.task_path).toBe(p)
    }

    const allRejects = [...REJECTED_PREFIX, ...REJECTED_STRUCTURAL]
    for (const bad of allRejects) {
      await expect(
        run('task_update', { id: 'upd', task_path: bad.path }),
        bad.why,
      ).rejects.toThrow(/\[path-guard\] task_path 非法/)
      // 失败不落盘：记录保持最后一次合法值。
      expect(store.get('upd')?.task_path).toBe(ACCEPTED_PATHS[ACCEPTED_PATHS.length - 1])
    }
    expect(
      JSON.parse(readFileSync(join(home, 'assets', 'tasks', 'upd.json'), 'utf8')).task_path,
    ).toBe(ACCEPTED_PATHS[ACCEPTED_PATHS.length - 1])
    expect(existsSync(join(home, 'data', 'tasks'))).toBe(false)
  })
})

// ===========================================================================
// 验收 1 / 2 / 6 / 9 / 10：调度链路 + 绝对路径 + loader cwd + 唤醒
// ===========================================================================

describe('AC1/AC2/AC6/AC9/AC10 调度装配与唤醒链路', () => {
  function setupChain(home: string, id = 'alpha') {
    const relTaskPath = `assets/programs/${id}/task.ts`
    writeTaskDef(home, {
      id,
      name: id,
      cron: '* * * * *',
      task_path: relTaskPath,
      enabled: true,
    })
    const absTaskPath = writeProgram(home, relTaskPath)

    const installCwds: string[] = []
    const install = makeInstallSpawner((cwd) => {
      installCwds.push(cwd)
      // AC9：cwd 内必须能看到 package.json 与依赖件 lib/x.ts。
      expect(existsSync(join(cwd, 'package.json'))).toBe(true)
      expect(existsSync(join(cwd, 'lib', 'x.ts'))).toBe(true)
    })
    const sp = makeSpawner((p) => {
      p.writeStdout('working\n{"shouldWake":true,"data":"BUY 600519"}\n')
      p.end(0)
    })

    // 真实 TaskLoader / TaskRunner，注入 mock 外设。
    H.loaderImpl.value = createTaskLoader({ spawner: install.spawner, fs: realFs })
    H.runnerImpl.value = createTaskRunner({ spawner: sp.spawner })

    return { relTaskPath, absTaskPath, install, sp, installCwds }
  }

  it('task_path 解析为 <home>/assets/programs/<id>/task.ts（非 assets/assets、非 data）', async () => {
    const home = mkTmpHome()
    const { relTaskPath, absTaskPath, install, sp } = setupChain(home)
    const ctx = boot()
    // 唤醒通道就绪（真实 Waker + mock agents），否则编排层会降级 skipped。
    ctx.injects[0].cb({
      get: (n: string) => (n === 'agents' ? makeAgents(() => {}) : undefined),
    })

    const out = await orch().run('alpha', relTaskPath)
    expect(out.kind).toBe('woke')

    expect(install.install).toHaveBeenCalledTimes(1)
    expect(sp.spawn).toHaveBeenCalledTimes(1)
    expect(install.install.mock.calls[0][0]).toBe(
      resolve(home, 'assets', 'programs', 'alpha'),
    )
    expect(sp.spawn.mock.calls[0][0]).toBe(absTaskPath)
    expect(absTaskPath).toBe(resolve(home, 'assets', 'programs', 'alpha', 'task.ts'))
    expect(absTaskPath).not.toContain('/assets/assets/')
    expect(absTaskPath).not.toContain('/data/')

    expect(H.wakeCalls).toEqual([{ taskId: 'alpha', data: 'BUY 600519' }])
    expect(existsSync(join(home, 'data', 'tasks'))).toBe(false)
    expect(existsSync(join(home, 'data'))).toBe(false)
  })

  it('fake timers：cron 到点 → install(cwd) → spawn(abs) → shouldWake → waker 投递；冷却按 taskId 生效', async () => {
    vi.useFakeTimers()
    try {
      const home = mkTmpHome()
      const { absTaskPath, install, sp } = setupChain(home)
      const followup = vi.fn()

      const ctx = boot()
      expect(ctx.injects[0].deps).toEqual(['agents'])
      // agents 就绪 → index 内部构造真实 Waker。
      ctx.injects[0].cb({
        get: (n: string) => (n === 'agents' ? makeAgents(followup) : undefined),
      })

      // 推进到下一分钟触发点（cron '* * * * *'）。
      await vi.advanceTimersByTimeAsync(61_000)

      expect(install.install).toHaveBeenCalledTimes(1)
      expect(install.install.mock.calls[0][0]).toBe(
        resolve(home, 'assets', 'programs', 'alpha'),
      )
      expect(sp.spawn).toHaveBeenCalledTimes(1)
      expect(sp.spawn.mock.calls[0][0]).toBe(absTaskPath)

      // 唤醒：taskId / 文本正确（当前契约：wake 正文 = data 原文）。
      expect(H.wakeCalls).toEqual([{ taskId: 'alpha', data: 'BUY 600519' }])
      expect(followup).toHaveBeenCalledTimes(1)
      const msg = followup.mock.calls[0][0] as {
        content: Array<{ type: string; text?: string }>
        source: { kind: string; form: string }
      }
      const text = msg.content
        .filter((b) => b.type === 'text')
        .map((b) => b.text ?? '')
        .join('')
      expect(text).toBe('BUY 600519')
      expect(msg.source.kind).toBe('dsh-ia')
      expect(msg.source.form).toBe('notice')

      // 链式自调度 + 冷却（5 分钟，按 taskId）：第二次触发会执行但不重复投递。
      await vi.advanceTimersByTimeAsync(61_000)
      expect(install.install).toHaveBeenCalledTimes(2)
      expect(sp.spawn).toHaveBeenCalledTimes(2)
      expect(H.wakeCalls).toHaveLength(2) // 编排层仍调用 waker
      expect(followup).toHaveBeenCalledTimes(1) // 冷却窗口内不重复投递

      // 全程无旧路径写入。
      expect(existsSync(join(home, 'data', 'tasks'))).toBe(false)
      expect(existsSync(join(home, 'data'))).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('applyScheduler 的 options.dataRoot 已 deprecated：传入也不改变 assets/tasks 落点', async () => {
    const home = mkTmpHome()
    const otherDataRoot = join(home, 'legacy-data-root')
    const { relTaskPath } = setupChain(home)

    disposeCtx(activeCtx)
    const ctx = makeCtx()
    activeCtx = ctx
    applyScheduler(ctx, { dataRoot: otherDataRoot, logger: () => {} })
    ctx.injects[0].cb({
      get: (n: string) => (n === 'agents' ? makeAgents(() => {}) : undefined),
    })

    const out = await orch().run('alpha', relTaskPath)
    expect(out.kind).toBe('woke')
    expect(existsSync(join(otherDataRoot, 'tasks'))).toBe(false)
    expect(existsSync(join(home, 'assets', 'tasks', 'alpha.json'))).toBe(true)
  })
})
