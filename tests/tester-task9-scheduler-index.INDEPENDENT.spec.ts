/**
 * tester-task9-scheduler-index.INDEPENDENT.spec.ts
 * ==================================================================
 * Tester 独立复验（t100385）：`src/scheduler/index.ts` 的 `applyScheduler(ctx)`
 * 装配入口 + `src/plugin.ts` 接入。
 *
 * 独立性声明（不复用 Developer 的用例，也不做纯代码审查）：
 *   1) **装配层隔离**：以最小结构替身 mock ctx（get / inject / effect），
 *      真实 store（tmp 目录）+ 通过 `vi.mock` 注入的 loader / runner / waker
 *      **替身工厂**，直接抓到 `applyScheduler` 内部构造的「编排 runner」
 *      （`createScheduler({runner})` 的入参），对其 `run(taskPath)` 逐链路验证。
 *   2) **不脱离真实**：默认 loader / runner / waker 仍走真实实现，仅在需要
 *      确定性时替换为替身；另有一组**真实 node 子进程**端到端（真实 spawn +
 *      真实 stdout 解析 + 真实投递），验证编排 runner 真能跑出四结局。
 *   3) **契约同步**：核对 7 个 task_* 工具名与 `src/scheduler/tools.ts` 的
 *      `createSchedulerTools` 返回值逐一致，并核对顶层 inject 契约。
 *
 * 仅新增本测试文件；不改动 src/**（数量断言同步在其它 5 个既有测试文件完成）。
 * ==================================================================
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// ---------------------------------------------------------------------------
// vi.hoisted：可变替身 + 装配捕获（供 vi.mock 工厂读取，避免 TDZ）
// ---------------------------------------------------------------------------

const H = vi.hoisted(() => ({
  /** 覆盖 loader 工厂返回值；null → 用真实 createTaskLoader。 */
  loaderImpl: { value: null as unknown },
  /** 覆盖 runner 工厂返回值；null → 用真实 createTaskRunner。 */
  runnerImpl: { value: null as unknown },
  /** 覆盖 waker 工厂返回值；null → 用真实 createWaker。 */
  wakerImpl: { value: null as unknown },
  /** applyScheduler 内部 createScheduler 入参 + 启停计数。 */
  cap: {
    scheduler: null as unknown,
    options: null as unknown,
    startCalls: 0,
    stopCalls: 0,
  },
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
    createWaker: (opts?: unknown) =>
      H.wakerImpl.value ?? actual.createWaker(opts as never),
  }
})

vi.mock('../src/scheduler/scheduler.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/scheduler/scheduler.js')>()
  return {
    ...actual,
    // 保留真实 Scheduler 行为（多 timer / 幂等启停），同时捕获装配入参与启停计数。
    createScheduler: (options: any) => {
      const s: any = actual.createScheduler(options)
      H.cap.scheduler = s
      H.cap.options = options
      H.cap.startCalls = 0
      H.cap.stopCalls = 0
      const oStart = s.start.bind(s)
      const oStop = s.stop.bind(s)
      s.start = () => {
        H.cap.startCalls += 1
        return oStart()
      }
      s.stop = () => {
        H.cap.stopCalls += 1
        return oStop()
      }
      return s
    },
  }
})

import { applyScheduler } from '../src/scheduler/index.js'
import { createSchedulerTools } from '../src/scheduler/tools.js'
import { LoaderError } from '../src/scheduler/loader.js'
import * as pluginNs from '../src/plugin.js'

// ---------------------------------------------------------------------------
// 常量 / 辅助
// ---------------------------------------------------------------------------

const PROJECT_ROOT = fileURLToPath(new URL('..', import.meta.url))

/** 本任务新增的 7 个定时任务层工具名（契约）。 */
const TASK_TOOL_NAMES = [
  'task_create',
  'task_list',
  'task_get',
  'task_update',
  'task_delete',
  'task_enable',
  'task_disable',
] as const

const noopLog = (): void => {}

interface FakeCtx {
  services: Record<string, unknown>
  effects: Array<{ label?: string; dispose: () => void; body: () => unknown }>
  injects: Array<{ deps: readonly string[]; cb: (c: any) => void }>
  get: (name: string) => unknown
  inject: (deps: string[], cb: (c: any) => void) => () => void
  effect: (body: () => unknown, label?: string) => () => void
}

/** 最小结构 ctx 替身（仅 applyScheduler 实际用到的 get / inject / effect）。 */
function makeCtx(services: Record<string, unknown> = {}): FakeCtx {
  const effects: FakeCtx['effects'] = []
  const injects: FakeCtx['injects'] = []
  const ctx: FakeCtx = {
    services,
    effects,
    injects,
    get(name) {
      return services[name]
    },
    inject(deps, cb) {
      injects.push({ deps, cb })
      return () => {}
    },
    effect(body, label) {
      const d = body()
      const dispose = typeof d === 'function' ? (d as () => void) : () => {}
      effects.push({ label, dispose, body })
      return dispose
    },
  }
  return ctx
}

/** 捕获式 tools 服务替身（记录注册/注销的工具定义）。 */
function makeToolsStub() {
  const registered: any[] = []
  const unregistered: any[] = []
  const service = {
    name: 'tools',
    register(def: any) {
      registered.push(def)
      return () => {
        unregistered.push(def)
      }
    },
  }
  return {
    service,
    registered,
    unregistered,
    names: () => registered.map((d) => (d as { name?: string })?.name),
  }
}

const tmpDirs: string[] = []
function mkTmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'dsh-t9-'))
  tmpDirs.push(d)
  return d
}

/** 写一条任务清单记录到 `<dataRoot>/tasks/<id>.json`。 */
function writeTask(dataRoot: string, def: Record<string, unknown>): void {
  const dir = join(dataRoot, 'tasks')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${String(def.id)}.json`), JSON.stringify(def), 'utf8')
}

/** 写一个任务入口程序文件到 `<dataRoot>/<taskPath>`。 */
function writeProgram(dataRoot: string, taskPath: string, content: string): void {
  const abs = resolve(dataRoot, taskPath)
  mkdirSync(dirname(abs), { recursive: true })
  writeFileSync(abs, content, 'utf8')
}

let activeCtx: FakeCtx | null = null

/** 卸载给定 ctx 上登记的所有 effect（幂等、容错）。 */
function disposeCtx(ctx: FakeCtx | null): void {
  if (!ctx) return
  for (const e of ctx.effects ?? []) {
    try {
      e.dispose()
    } catch {
      /* ignore */
    }
  }
}

/** 装配 applyScheduler（自动登记 activeCtx 供 afterEach 卸载；重复 boot 先卸前者）。 */
function boot(dataRoot: string, services: Record<string, unknown> = {}): FakeCtx {
  disposeCtx(activeCtx)
  const ctx = makeCtx(services)
  activeCtx = ctx
  applyScheduler(ctx, { dataRoot, logger: noopLog })
  return ctx
}

/** 抓取 applyScheduler 内部构造的「编排 runner」。 */
function orch(): { run: (taskPath: string) => Promise<any> } {
  return (H.cap.options as { runner: any }).runner
}

afterEach(() => {
  disposeCtx(activeCtx)
  activeCtx = null
  H.loaderImpl.value = null
  H.runnerImpl.value = null
  H.wakerImpl.value = null
  for (const d of tmpDirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  }
})

// ---------------------------------------------------------------------------
// A. 交付物与契约（验收点 1 / 2 / 7）
// ---------------------------------------------------------------------------

describe('T9-A 交付物与顶层契约', () => {
  it('验收1：src/scheduler/index.ts 存在并导出 applyScheduler', () => {
    expect(typeof applyScheduler).toBe('function')
    const src = readFileSync(join(PROJECT_ROOT, 'src/scheduler/index.ts'), 'utf8')
    expect(src).toMatch(/export\s+function\s+applyScheduler\s*\(/)
  })

  it('验收2：plugin.ts 调用 applyScheduler(ctx)，顶层 inject 不变', () => {
    const src = readFileSync(join(PROJECT_ROOT, 'src/plugin.ts'), 'utf8')
    // 接入点：apply() 末尾 try { applyScheduler(ctx) } catch
    expect(src).toMatch(/applyScheduler\s*\(\s*ctx\s*\)/)
    // 顶层 inject 字面量仍是四项原样
    expect(src).toMatch(
      /inject:\s*string\[\]\s*=\s*\[\s*'tools'\s*,\s*'skills'\s*,\s*'ptcRuntime'\s*,\s*'fs'\s*\]/,
    )
  })

  it('验收7：运行时 plugin.inject 契约 = [tools, skills, ptcRuntime, fs]', () => {
    expect(pluginNs.inject).toEqual(['tools', 'skills', 'ptcRuntime', 'fs'])
    expect(pluginNs.name).toBe('investment-advisor')
  })

  it('7 个 task_* 工具名与 createSchedulerTools 返回值逐一致（名称来源核对）', () => {
    const defs = createSchedulerTools({
      store: {
        list: () => ({ tasks: [], corrupted: [] }),
        get: () => undefined,
        save: () => {},
        remove: () => true,
      } as never,
      scheduler: { reload() {} } as never,
    })
    expect(defs.map((d: any) => d.name)).toEqual([...TASK_TOOL_NAMES])
  })
})

// ---------------------------------------------------------------------------
// B. 装配链完整性（验收点 3）
// ---------------------------------------------------------------------------

describe('T9-B 装配链完整性：store → 编排runner → scheduler → 工具 → effect 启停', () => {
  it('装配链完整：createScheduler 收到真实 store + 编排 runner；7 工具惰性注册；start 一次', async () => {
    const dataRoot = mkTmp()
    // 放一条任务，证明 tasksDir 由 dataRoot 派生（不依赖 cwd）。
    writeTask(dataRoot, {
      id: 'alpha',
      name: 'A',
      cron: '0 9 * * *',
      task_path: 'tasks/alpha/task.mjs',
      enabled: true,
    })

    const tools = makeToolsStub()
    const ctx = boot(dataRoot, { tools: tools.service })

    // createScheduler 入参
    const opts = H.cap.options as { store: any; runner: any; log?: unknown }
    expect(typeof opts.store.list).toBe('function') // 真实 TaskStore
    expect(typeof opts.runner.run).toBe('function') // 编排 runner（TaskRunnerLike）
    // 编排 runner 与 store 绑定同一 dataRoot（store 能读到 alpha）
    const listed = opts.store.list()
    expect(listed.tasks.map((t: any) => t.id)).toContain('alpha')

    // 惰性注册 7 工具（异步 import('./tools.js')）
    await vi.waitFor(() => expect(tools.registered).toHaveLength(7), {
      timeout: 8000,
      interval: 10,
    })
    expect([...tools.names()].sort()).toEqual([...TASK_TOOL_NAMES].sort())

    // 两个 effect：工具注销 + 自持启停
    const labels = ctx.effects.map((e) => e.label)
    expect(labels).toContain('dsh-finance scheduler tools')
    expect(labels).toContain('dsh-finance scheduler')

    // apply 即启动，且只启动一次
    expect(H.cap.startCalls).toBe(1)
    expect((H.cap.scheduler as { running: boolean }).running).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// C. 编排 runner 运行时行为（验收点 4）
// ---------------------------------------------------------------------------

describe('T9-C 编排 runner 运行时行为（loader/runner/waker 替身）', () => {
  it('C1 taskId 反查：按 task_path 命中 TaskDef.id，并传正确 taskDir/absPath 给 loader/runner', async () => {
    const dataRoot = mkTmp()
    writeTask(dataRoot, {
      id: 'alpha',
      name: 'A',
      cron: '0 9 * * *',
      task_path: 'tasks/alpha/task.mjs',
      enabled: true,
    })

    const loadCalls: Array<[string, string]> = []
    const runCalls: string[] = []
    H.loaderImpl.value = {
      installTaskDeps: vi.fn(async (id: string, dir: string) => {
        loadCalls.push([id, dir])
      }),
    }
    H.runnerImpl.value = {
      run: vi.fn(async (p: string) => {
        runCalls.push(p)
        return { kind: 'quiet', reason: 'ok' }
      }),
    }

    boot(dataRoot)
    const out = await orch().run('tasks/alpha/task.mjs')

    expect(out.kind).toBe('quiet')
    expect(loadCalls).toEqual([['alpha', resolve(dataRoot, 'tasks/alpha')]])
    expect(runCalls).toEqual([resolve(dataRoot, 'tasks/alpha/task.mjs')])
  })

  it('C2 taskId 反查失败：无匹配 task_path → skipped，不触达 loader/runner', async () => {
    const dataRoot = mkTmp()
    const load = vi.fn(async () => {})
    const run = vi.fn(async () => ({ kind: 'quiet', reason: 'x' }))
    H.loaderImpl.value = { installTaskDeps: load }
    H.runnerImpl.value = { run }

    boot(dataRoot)
    const out = await orch().run('tasks/ghost/task.mjs')

    expect(out.kind).toBe('skipped')
    expect(load).not.toHaveBeenCalled()
    expect(run).not.toHaveBeenCalled()
  })

  it('C3 loader 接入：依赖安装失败（LoaderError）→ failed + failureKind=install，且不执行 runner', async () => {
    const dataRoot = mkTmp()
    writeTask(dataRoot, {
      id: 'beta',
      name: 'B',
      cron: '0 9 * * *',
      task_path: 'tasks/beta/task.mjs',
      enabled: true,
    })

    H.loaderImpl.value = {
      installTaskDeps: vi.fn(async () => {
        throw new LoaderError('[loader] beta 依赖安装失败: 任务目录不存在')
      }),
    }
    const run = vi.fn(async () => ({ kind: 'quiet', reason: 'x' }))
    H.runnerImpl.value = { run }

    boot(dataRoot)
    const out = await orch().run('tasks/beta/task.mjs')

    expect(out.kind).toBe('failed')
    expect(out.failureKind).toBe('install')
    expect(run).not.toHaveBeenCalled()
  })

  it('C3 真实 loader：任务目录不存在 / 缺 package.json → failed + failureKind=install（不跑 pnpm）', async () => {
    const dataRoot = mkTmp()
    // 任务目录不存在
    writeTask(dataRoot, {
      id: 'noloader',
      name: 'N',
      cron: '0 9 * * *',
      task_path: 'tasks/noloader/task.mjs',
      enabled: true,
    })
    H.loaderImpl.value = null // 真实 createTaskLoader
    const run = vi.fn(async () => ({ kind: 'quiet', reason: 'x' }))
    H.runnerImpl.value = { run }

    boot(dataRoot)
    const out = await orch().run('tasks/noloader/task.mjs')
    expect(out.kind).toBe('failed')
    expect(out.failureKind).toBe('install')
    expect(run).not.toHaveBeenCalled()
  })

  it('C3b 真实 loader：目录存在但缺 package.json → failed + failureKind=install', async () => {
    const dataRoot = mkTmp()
    writeTask(dataRoot, {
      id: 'nopkg',
      name: 'P',
      cron: '0 9 * * *',
      task_path: 'tasks/nopkg/task.mjs',
      enabled: true,
    })
    // 仅建目录（无 package.json）
    mkdirSync(resolve(dataRoot, 'tasks/nopkg'), { recursive: true })
    H.loaderImpl.value = null // 真实 createTaskLoader
    const run = vi.fn(async () => ({ kind: 'quiet', reason: 'x' }))
    H.runnerImpl.value = { run }

    boot(dataRoot)
    const out = await orch().run('tasks/nopkg/task.mjs')
    expect(out.kind).toBe('failed')
    expect(out.failureKind).toBe('install')
    expect(run).not.toHaveBeenCalled()
  })

  it('C4 runner 执行：四结局中 quiet/skipped/failed 原样透传（含 failureKind）', async () => {
    const dataRoot = mkTmp()
    writeTask(dataRoot, {
      id: 'gamma',
      name: 'G',
      cron: '0 9 * * *',
      task_path: 'tasks/gamma/task.mjs',
      enabled: true,
    })

    H.loaderImpl.value = { installTaskDeps: vi.fn(async () => {}) }
    const run = vi
      .fn()
      .mockResolvedValueOnce({ kind: 'quiet', reason: 'q' })
      .mockResolvedValueOnce({ kind: 'skipped', reason: 's', detail: 'd' })
      .mockResolvedValueOnce({ kind: 'failed', reason: 'f', failureKind: 'exec' })
    H.runnerImpl.value = { run }

    boot(dataRoot)
    const o1 = await orch().run('tasks/gamma/task.mjs')
    const o2 = await orch().run('tasks/gamma/task.mjs')
    const o3 = await orch().run('tasks/gamma/task.mjs')

    expect(o1.kind).toBe('quiet')
    expect(o2.kind).toBe('skipped')
    expect(o2.detail).toBe('d')
    expect(o3.kind).toBe('failed')
    expect(o3.failureKind).toBe('exec')
  })

  it('C5 woke 投递：shouldWake=true → waker.wake(taskId, data)，按 taskId 定点投递到固定会话', async () => {
    const dataRoot = mkTmp()
    writeTask(dataRoot, {
      id: 'delta',
      name: 'D',
      cron: '0 9 * * *',
      task_path: 'tasks/delta/task.mjs',
      enabled: true,
    })

    H.loaderImpl.value = { installTaskDeps: vi.fn(async () => {}) }
    H.runnerImpl.value = {
      run: vi.fn(async () => ({
        kind: 'woke',
        reason: 'w',
        data: 'BUY 600519',
        targets: [],
      })),
    }
    H.wakerImpl.value = null // 用真实 createWaker

    const followup = vi.fn()
    const registry = {
      get: (id: string) =>
        id === 'investment-advisor' ? { id, followup } : undefined,
    }

    const ctx = boot(dataRoot)
    // 手动触发 agents 动态注入（模拟 agents 服务就绪）
    expect(ctx.injects).toHaveLength(1)
    expect(ctx.injects[0].deps).toEqual(['agents'])
    ctx.injects[0].cb({ get: (n: string) => (n === 'agents' ? registry : undefined) })

    const out = await orch().run('tasks/delta/task.mjs')

    expect(out.kind).toBe('woke')
    expect(out.targets).toContain('investment-advisor')
    expect(followup).toHaveBeenCalledTimes(1)
    const delivered = JSON.stringify(followup.mock.calls[0][0])
    expect(delivered).toContain('BUY 600519') // data 逐字投递
  })

  it('C6 投递降级：(a) agents 不可用 (b) delivered:false (c) wake 抛错 → 均 skipped，不抛不中断', async () => {
    const dataRoot = mkTmp()
    writeTask(dataRoot, {
      id: 'eps',
      name: 'E',
      cron: '0 9 * * *',
      task_path: 'tasks/eps/task.mjs',
      enabled: true,
    })
    H.loaderImpl.value = { installTaskDeps: vi.fn(async () => {}) }
    H.runnerImpl.value = {
      run: vi.fn(async () => ({
        kind: 'woke',
        reason: 'w',
        data: 'X',
        targets: [],
      })),
    }

    // (a) agents 服务不可用 → inject 回调里 waker 置 undefined
    let ctx = boot(dataRoot)
    ctx.injects[0].cb({ get: () => undefined })
    const a = await orch().run('tasks/eps/task.mjs')
    expect(a.kind).toBe('skipped')
    expect(String(a.reason)).toMatch(/waker|agents|降级/)

    // (b) delivered:false（waker 就绪但投递降级）
    H.wakerImpl.value = {
      wake: vi.fn(() => ({
        delivered: false,
        count: 0,
        targets: [],
        reason: 'cooldown',
      })),
    }
    ctx = boot(dataRoot)
    ctx.injects[0].cb({ get: (n: string) => (n === 'agents' ? { get: () => ({ id: 'x', followup() {} }) } : undefined) })
    const b = await orch().run('tasks/eps/task.mjs')
    expect(b.kind).toBe('skipped')

    // (c) wake 抛错 → 降级 skipped（不穿透）
    H.wakerImpl.value = {
      wake: vi.fn(() => {
        throw new Error('boom')
      }),
    }
    ctx = boot(dataRoot)
    ctx.injects[0].cb({ get: (n: string) => (n === 'agents' ? { get: () => ({ id: 'x', followup() {} }) } : undefined) })
    const c = await orch().run('tasks/eps/task.mjs')
    expect(c.kind).toBe('skipped')
  })
})

// ---------------------------------------------------------------------------
// D. 软取降级 / 最小上下文（验收点 5）
// ---------------------------------------------------------------------------

describe('T9-D 软取降级：tools/agents 不可用时不抛、不中断装载', () => {
  it('tools 服务不可用：applyScheduler 不抛，跳过工具注册，但仍启动调度', () => {
    const dataRoot = mkTmp()
    expect(() => boot(dataRoot)).not.toThrow()
    expect(H.cap.startCalls).toBe(1)
    expect((H.cap.scheduler as { running: boolean }).running).toBe(true)
  })

  it('最小上下文（get 全 undefined）：apply 不抛、不注册工具', async () => {
    const registered: any[] = []
    const ctx = {
      effect(body: () => unknown) {
        const d = body()
        return typeof d === 'function' ? (d as () => void) : () => {}
      },
      get: () => undefined,
      inject: () => ({}),
    } as unknown as FakeCtx
    activeCtx = ctx

    expect(() => applyScheduler(ctx, { logger: noopLog })).not.toThrow()
    // 即便 tools 不可用也不应注册任何工具
    await new Promise((r) => setTimeout(r, 20))
    expect(registered).toHaveLength(0)
  })

  it('plugin.apply 在最简 ctx 下整体不抛（scheduler 软取降级不破坏装载）', () => {
    const ctx = {
      effect(body: () => unknown) {
        const d = body()
        return typeof d === 'function' ? (d as () => void) : () => {}
      },
      get: () => undefined,
      inject: () => ({}),
    } as unknown as never
    expect(() => pluginNs.apply(ctx)).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// E. 生命周期（验收点 6）
// ---------------------------------------------------------------------------

describe('T9-E 生命周期：幂等 start、卸载 stop', () => {
  it('幂等 start：apply 只 start 一次；重复触发启停 effect body 不再 start', () => {
    const dataRoot = mkTmp()
    const ctx = boot(dataRoot)
    expect(H.cap.startCalls).toBe(1)

    const startEffect = ctx.effects.find((e) => e.label === 'dsh-finance scheduler')!
    // 模拟多会话 / 依赖重复就绪：再次执行 effect body
    startEffect.body()
    startEffect.body()
    expect(H.cap.startCalls).toBe(1) // 幂等守卫生效
    expect((H.cap.scheduler as { running: boolean }).running).toBe(true)
  })

  it('卸载：effect 注销 → scheduler.stop() 清 timer（running=false）；二次卸载不再 stop', () => {
    const dataRoot = mkTmp()
    const ctx = boot(dataRoot)
    const startEffect = ctx.effects.find((e) => e.label === 'dsh-finance scheduler')!
    expect((H.cap.scheduler as { running: boolean }).running).toBe(true)

    startEffect.dispose()
    expect(H.cap.stopCalls).toBe(1)
    expect((H.cap.scheduler as { running: boolean }).running).toBe(false)

    startEffect.dispose()
    expect(H.cap.stopCalls).toBe(1) // 幂等：不再重复 stop
  })

  it('工具注销：卸载 tools effect → 7 个 task_* 工具全部注销', async () => {
    const dataRoot = mkTmp()
    const tools = makeToolsStub()
    const ctx = boot(dataRoot, { tools: tools.service })

    await vi.waitFor(() => expect(tools.registered).toHaveLength(7), {
      timeout: 8000,
      interval: 10,
    })

    const toolsEffect = ctx.effects.find((e) => e.label === 'dsh-finance scheduler tools')!
    toolsEffect.dispose()
    expect(tools.unregistered).toHaveLength(7)
  })
})

// ---------------------------------------------------------------------------
// F. 真实 node 子进程端到端（验收点 4 的「真实」侧）
// ---------------------------------------------------------------------------

describe('T9-F 编排 runner 真实端到端（真实 spawn + 真实投递）', () => {
  const programs: Array<{ id: string; taskPath: string; body: string }> = [
    { id: 'rq', taskPath: 'tasks/rq/task.mjs', body: `console.log(JSON.stringify({ shouldWake: false }))` },
    {
      id: 'rw',
      taskPath: 'tasks/rw/task.mjs',
      body: `console.log(JSON.stringify({ shouldWake: true, data: 'REAL-PROC-CONTENT' }))`,
    },
    { id: 'rs', taskPath: 'tasks/rs/task.mjs', body: `console.log('not-json-line')` },
    { id: 'rf', taskPath: 'tasks/rf/task.mjs', body: `process.exit(3)` },
  ]

  it('真实执行四结局：quiet / woke(投递) / skipped(解析) / failed(非零退出)', async () => {
    const dataRoot = mkTmp()
    for (const p of programs) {
      writeTask(dataRoot, {
        id: p.id,
        name: p.id,
        cron: '0 9 * * *',
        task_path: p.taskPath,
        enabled: true,
      })
      writeProgram(dataRoot, p.taskPath, p.body)
    }

    // loader 用替身（成功、不跑 pnpm）；runner / waker 走真实实现。
    H.loaderImpl.value = { installTaskDeps: vi.fn(async () => {}) }
    H.runnerImpl.value = null
    H.wakerImpl.value = null

    const followup = vi.fn()
    const registry = {
      get: (id: string) => (id === 'investment-advisor' ? { id, followup } : undefined),
    }

    const ctx = boot(dataRoot)
    ctx.injects[0].cb({ get: (n: string) => (n === 'agents' ? registry : undefined) })

    const quiet = await orch().run('tasks/rq/task.mjs')
    expect(quiet.kind).toBe('quiet')

    const woke = await orch().run('tasks/rw/task.mjs')
    expect(woke.kind).toBe('woke')
    expect(woke.targets).toContain('investment-advisor')
    expect(JSON.stringify(followup.mock.calls[0][0])).toContain('REAL-PROC-CONTENT')

    const skipped = await orch().run('tasks/rs/task.mjs')
    expect(skipped.kind).toBe('skipped')

    const failed = await orch().run('tasks/rf/task.mjs')
    expect(failed.kind).toBe('failed')
    expect(failed.failureKind).toBe('exec')
  }, 30000)
})

// ---------------------------------------------------------------------------
// G. 真实 scheduler 到点触发链（fake timers）——装配链「启 → 触发 → 重设 → 停」
// ---------------------------------------------------------------------------

describe('T9-G 真实 scheduler 触发链（fake timers）', () => {
  it('到点触发 → 编排 runner 执行 → 链式重设；卸载后不再触发', async () => {
    vi.useFakeTimers()
    try {
      const dataRoot = mkTmp()
      writeTask(dataRoot, {
        id: 'tick',
        name: 'T',
        cron: '* * * * *',
        task_path: 'tasks/tick/task.mjs',
        enabled: true,
      })
      const run = vi.fn(async () => ({ kind: 'quiet', reason: 'ok' }))
      H.loaderImpl.value = { installTaskDeps: vi.fn(async () => {}) }
      H.runnerImpl.value = { run }

      const ctx = makeCtx()
      activeCtx = ctx
      applyScheduler(ctx, { dataRoot, logger: noopLog })
      expect((H.cap.scheduler as { running: boolean }).running).toBe(true)

      // 推进到下一分钟触发点
      await vi.advanceTimersByTimeAsync(61_000)
      expect(run).toHaveBeenCalled()
      expect((H.cap.scheduler as { running: boolean }).running).toBe(true)

      // 卸载（stop 清 timer）后，继续推进时间不再触发
      disposeCtx(ctx)
      activeCtx = null
      expect(H.cap.stopCalls).toBe(1)
      const callsBefore = run.mock.calls.length
      await vi.advanceTimersByTimeAsync(180_000)
      expect(run.mock.calls.length).toBe(callsBefore)
    } finally {
      vi.useRealTimers()
    }
  })
})
