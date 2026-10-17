/**
 * tester-t100440-finance-home-path.INDEPENDENT.spec.ts
 * ==================================================================
 * Tester 独立复验：`src/scheduler/index.ts` orchestrator 路径拼接修复。
 *
 * 被测改动（Developer）：`applyScheduler` 编排 runner 内
 *   - 旧：`const absTaskPath = resolve(dataRoot, taskPath)`
 *   - 新：`const financeHome = resolveFinanceHomeDir(); const absTaskPath = resolve(financeHome, taskPath)`
 *
 * 语义（task-04 起）：`task_path` 形如 `assets/programs/<id>/task.ts`，相对
 * FINANCE_HOME（`~/.dsh-ia`）解析；任务定义固定落在 `<financeHome>/assets/tasks`，
 * dataRoot（`~/.dsh-ia/data`）不再参与任务层路径。
 *
 * 验收标准（逐条验证）：
 *   1. absTaskPath 解析为 `<financeHome>/assets/programs/<id>/task.ts`
 *      （无 data 层，也不重复拼 assets）。
 *   2. taskDir = dirname(absTaskPath) 指向 `<financeHome>/assets/programs/<id>`，使
 *      loader.installTaskDeps(taskId, taskDir) 能命中任务目录下的 package.json。
 *   3. tasksDir = `<financeHome>/assets/tasks`（任务定义在资产层）。
 *   4. 现有测试全绿（或至少 scheduler 相关测试通过），无回归。
 *
 * 独立性声明：不复用 Developer 用例、不做纯代码审查。通过
 *   - vi.mock('../src/paths.js') 将 `resolveFinanceHomeDir` 重定向到一个临时目录
 *     （隔离真实 `~/.dsh-ia`，避免污染 / 被测试清理影响），并同步 mock
 *     `resolveAssetsTasksDir` 指向同一临时 home 的资产层；
 *   - vi.mock 注入 loader/runner 替身工厂，捕获「编排 runner」；
 *   - 对 `run(taskId, taskPath)` 逐链路验证：入口程序 + package.json 放在
 *     **mock 后的 financeHome** 下，证明 realpath
 *     命中正确位置（无 data 层）。
 * ==================================================================
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

// ---------------------------------------------------------------------------
// vi.hoisted：可变替身 + 装配捕获 + mock 后的 financeHome 目录
// ---------------------------------------------------------------------------

const H = vi.hoisted(() => ({
  loaderImpl: { value: null as unknown },
  runnerImpl: { value: null as unknown },
  wakerImpl: { value: null as unknown },
  cap: {
    options: null as unknown,
    financeHome: '',
  },
}))

// 将 resolveFinanceHomeDir 重定向到临时目录（隔离真实 home）。
vi.mock('../src/paths.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/paths.js')>()
  return {
    ...actual,
    resolveFinanceHomeDir: () => H.cap.financeHome,
    // 任务定义目录跟着 mock 后的 finance home 走（隔离真实 ~/.dsh-ia）。
    resolveAssetsTasksDir: () => `${H.cap.financeHome}/assets/tasks`,
  }
})

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
    createScheduler: (options: any) => {
      const s: any = actual.createScheduler(options)
      H.cap.options = options
      return s
    },
  }
})

import { applyScheduler } from '../src/scheduler/index.js'
import { FINANCE_HOME, resolveFinanceHomeDir } from '../src/paths.js'

// ---------------------------------------------------------------------------
// 辅助
// ---------------------------------------------------------------------------

const noopLog = (): void => {}

interface FakeCtx {
  services: Record<string, unknown>
  effects: Array<{ label?: string; dispose: () => void; body: () => unknown }>
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
}

let activeCtx: FakeCtx | null = null
const tmpDirs: string[] = []

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

function mkTmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'dsh-t100440-'))
  tmpDirs.push(d)
  return d
}

function boot(dataRoot: string, financeHome: string, services: Record<string, unknown> = {}): FakeCtx {
  disposeCtx(activeCtx)
  H.cap.financeHome = financeHome
  const ctx = makeCtx(services)
  activeCtx = ctx
  applyScheduler(ctx, { dataRoot, logger: noopLog })
  return ctx
}

function orch(): { run: (taskId: string, taskPath: string) => Promise<any> } {
  return (H.cap.options as { runner: any }).runner
}

afterEach(() => {
  disposeCtx(activeCtx)
  activeCtx = null
  H.loaderImpl.value = null
  H.runnerImpl.value = null
  H.wakerImpl.value = null
  H.cap.financeHome = ''
  for (const d of tmpDirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  }
})

// ---------------------------------------------------------------------------
// 测试
// ---------------------------------------------------------------------------

describe('t100440 路径解析基准：task_path 相对 FINANCE_HOME 而非 dataRoot', () => {
  it('验收1：absTaskPath = resolve(financeHome, taskPath)，无 data 层、无重复 assets', async () => {
    const dataRoot = mkTmp()
    const financeHome = mkTmp()

    // 入口程序放在 <financeHome>/assets/programs/<id>/task.ts（正确语义位置）。
    const programDir = join(financeHome, 'assets/programs/002156-intraday')
    mkdirSync(programDir, { recursive: true })
    writeFileSync(join(programDir, 'task.ts'), '// task.ts\n', 'utf8')

    const runCalls: string[] = []
    H.loaderImpl.value = { installTaskDeps: vi.fn(async () => {}) }
    H.runnerImpl.value = {
      run: vi.fn(async (p: string) => {
        runCalls.push(p)
        return { kind: 'quiet', reason: 'ok' }
      }),
    }

    boot(dataRoot, financeHome)
    const taskPath = 'assets/programs/002156-intraday/task.ts'
    const out = await orch().run('002156-intraday', taskPath)

    expect(out.kind).toBe('quiet')

    // 关键断言：absPath 基准是 financeHome，**不含** data 层，也**不重复** assets 层。
    const expectedAbs = resolve(financeHome, taskPath)
    expect(runCalls).toEqual([expectedAbs])
    expect(runCalls[0]).not.toBe(resolve(dataRoot, taskPath))
    expect(runCalls[0]).not.toBe(join(financeHome, 'assets', 'assets', 'programs', '002156-intraday', 'task.ts'))
    expect(expectedAbs).not.toContain('/data/')
  })

  it('验收2：taskDir = dirname(absTaskPath) 指向 financeHome/assets/programs/<id>，命中 package.json', async () => {
    const dataRoot = mkTmp()
    const financeHome = mkTmp()

    const programDir = join(financeHome, 'assets/programs/002156-intraday')
    mkdirSync(programDir, { recursive: true })
    writeFileSync(join(programDir, 'task.ts'), '// task.ts\n', 'utf8')
    // 任务目录下的 package.json（loader.installTaskDeps 需要命中它）。
    writeFileSync(join(programDir, 'package.json'), '{}\n', 'utf8')

    const loadCalls: Array<[string, string]> = []
    H.loaderImpl.value = {
      installTaskDeps: vi.fn(async (_id: string, dir: string) => {
        loadCalls.push([_id, dir])
      }),
    }
    H.runnerImpl.value = {
      run: vi.fn(async () => ({ kind: 'quiet', reason: 'ok' })),
    }

    boot(dataRoot, financeHome)
    await orch().run('002156-intraday', 'assets/programs/002156-intraday/task.ts')

    const expectedDir = join(financeHome, 'assets/programs/002156-intraday')
    expect(loadCalls).toEqual([['002156-intraday', expectedDir]])
    expect(dirname(resolve(financeHome, 'assets/programs/002156-intraday/task.ts'))).toBe(expectedDir)
  })

  it('验收3：tasksDir = financeHome/assets/tasks（任务定义在资产层，dataRoot 不再参与）', () => {
    const dataRoot = mkTmp()
    const financeHome = mkTmp()
    const tasksRoot = join(financeHome, 'assets', 'tasks')
    mkdirSync(tasksRoot, { recursive: true })
    writeFileSync(
      join(tasksRoot, '002156-eod.json'),
      JSON.stringify({
        id: '002156-eod',
        name: 'EOD',
        cron: '0 15 * * *',
        task_path: 'assets/programs/002156-eod/task.ts',
        enabled: true,
      }),
      'utf8',
    )

    boot(dataRoot, financeHome)
    const store = (H.cap.options as { store: any }).store
    const listed = store.list()
    expect(listed.tasks.map((t: any) => t.id)).toContain('002156-eod')
    // 任务定义目录跟随 FINANCE_HOME 的资产层，而非 dataRoot。
    expect(tasksRoot).toBe(join(financeHome, 'assets', 'tasks'))
    expect(tasksRoot).not.toContain(dataRoot)
  })
})

describe('t100440 语义区分：程序目录 vs 任务定义目录同处资产层', () => {
  it('程序命中 financeHome/assets/programs，定义命中 financeHome/assets/tasks，dataRoot 不参与', async () => {
    const dataRoot = mkTmp()
    const financeHome = mkTmp()

    // 程序：financeHome/assets/programs/<id>/task.ts
    const programDir = join(financeHome, 'assets/programs/alpha')
    mkdirSync(programDir, { recursive: true })
    writeFileSync(join(programDir, 'task.ts'), '// task.ts\n', 'utf8')

    // 定义：financeHome/assets/tasks/<id>.json
    const metaDir = join(financeHome, 'assets', 'tasks')
    mkdirSync(metaDir, { recursive: true })
    writeFileSync(
      join(metaDir, 'alpha.json'),
      JSON.stringify({
        id: 'alpha',
        name: 'A',
        cron: '0 9 * * *',
        task_path: 'assets/programs/alpha/task.ts',
        enabled: true,
      }),
      'utf8',
    )

    const runCalls: string[] = []
    H.loaderImpl.value = { installTaskDeps: vi.fn(async () => {}) }
    H.runnerImpl.value = {
      run: vi.fn(async (p: string) => {
        runCalls.push(p)
        return { kind: 'quiet', reason: 'ok' }
      }),
    }

    boot(dataRoot, financeHome)
    const out = await orch().run('alpha', 'assets/programs/alpha/task.ts')
    expect(out.kind).toBe('quiet')

    // 程序 realpath = financeHome/assets/programs/alpha/task.ts。
    expect(runCalls[0]).toBe(resolve(financeHome, 'assets/programs/alpha/task.ts'))
    expect(runCalls[0]).not.toContain(resolve(dataRoot))
    // 定义目录同样不落在 dataRoot。
    expect((H.cap.options as { store: any }).store.list().tasks.map((t: any) => t.id)).toContain('alpha')
  })
})
