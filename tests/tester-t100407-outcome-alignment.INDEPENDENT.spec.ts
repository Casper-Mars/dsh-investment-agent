/**
 * tester-t100407-outcome-alignment.INDEPENDENT.spec.ts
 * ==================================================================
 * Tester 独立复验（t100407）：runner 结局语义对齐 v0.7 §9.1
 *
 * 覆盖两条被测改动：
 *   (i)  src/scheduler/runner.ts  —— exit 0 但输出不可解析：skipped → failed/parse
 *   (ii) src/scheduler/index.ts   —— 编排层「任务程序缺失 / 不可读」→ skipped（不启动 runner、不装依赖）
 *
 * 独立性：
 *   - 不复用 Developer 的用例断言，自行构造输入与断言；
 *   - runner 层用**真实 TaskRunner** + 可编程假进程（确定性驱动 stdout/exitCode/超时）；
 *   - 编排层用**真实 applyScheduler** + 真实 store（tmp 目录）+ loader/runner 替身（spy）。
 * 本文件仅测试用，不改动 src/**。
 * ==================================================================
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { PassThrough } from 'node:stream'

// ---------------------------------------------------------------------------
// vi.hoisted：装配捕获 + 替身（供 vi.mock 工厂读取，避免 TDZ）
// ---------------------------------------------------------------------------
const H = vi.hoisted(() => ({
  loaderImpl: { value: null as unknown },
  runnerImpl: { value: null as unknown },
  wakerImpl: { value: null as unknown },
  cap: { options: null as unknown, financeHome: '' },
}))

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
  return { ...actual, createTaskLoader: (o?: unknown) => H.loaderImpl.value ?? actual.createTaskLoader(o as never) }
})
vi.mock('../src/scheduler/runner.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/scheduler/runner.js')>()
  return { ...actual, createTaskRunner: (o?: unknown) => H.runnerImpl.value ?? actual.createTaskRunner(o as never) }
})
vi.mock('../src/scheduler/wake.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/scheduler/wake.js')>()
  return { ...actual, createWaker: (o?: unknown) => H.wakerImpl.value ?? actual.createWaker(o as never) }
})
vi.mock('../src/scheduler/scheduler.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/scheduler/scheduler.js')>()
  return {
    ...actual,
    createScheduler: (o: any) => {
      const s: any = actual.createScheduler(o)
      H.cap.options = o
      return s
    },
  }
})

import { applyScheduler } from '../src/scheduler/index.js'
import { TaskRunner } from '../src/scheduler/runner.js'
import type { Spawner, TaskProcess } from '../src/scheduler/types.js'

// ===========================================================================
// 通用辅助
// ===========================================================================
const noopLog = (): void => {}

interface FakeCtx {
  services: Record<string, unknown>
  effects: Array<{ label?: string; dispose: () => void }>
  get: (n: string) => unknown
  inject: (d: string[], cb: (c: any) => void) => () => void
  effect: (b: () => unknown, l?: string) => () => void
}
function makeCtx(services: Record<string, unknown> = {}): FakeCtx {
  const effects: FakeCtx['effects'] = []
  return {
    services,
    effects,
    get: (n) => services[n],
    inject: () => () => {},
    effect(b, l) {
      const d = b()
      const dispose = typeof d === 'function' ? (d as () => void) : () => {}
      effects.push({ label: l, dispose })
      return dispose
    },
  }
}

const tmpDirs: string[] = []
function mkTmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'dsh-t100407-'))
  tmpDirs.push(d)
  const home = mkdtempSync(join(tmpdir(), 'dsh-t100407-home-'))
  tmpDirs.push(home)
  H.cap.financeHome = home
  return d
}

/** 写任务清单 JSON（可选是否补齐入口文件）。 */
function writeTaskDef(dataRoot: string, def: Record<string, unknown>, withEntry: boolean): void {
  const dir = join(H.cap.financeHome, 'assets', 'tasks')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${String(def.id)}.json`), JSON.stringify(def), 'utf8')
  const abs = resolve(H.cap.financeHome, String(def.task_path))
  mkdirSync(dirname(abs), { recursive: true })
  if (withEntry) writeFileSync(abs, '// entry\n', 'utf8')
  if (!withEntry) writeFileSync(join(dirname(abs), 'package.json'), '{}', 'utf8')
}

let activeCtx: FakeCtx | null = null
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
function boot(dataRoot: string): FakeCtx {
  disposeCtx(activeCtx)
  const ctx = makeCtx()
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
  for (const d of tmpDirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  }
  H.cap.financeHome = ''
})

// ===========================================================================
// A. 验收1：入口文件缺失 / 不可读 / 非普通文件 → skipped 且不启动 runner（编排层）
// ===========================================================================
describe('T100407-A 验收1：入口缺失/不可读 → skipped + 不启动 runner、不装依赖', () => {
  it('A1 目录存在 + package.json 存在 + task.ts 缺失 → skipped，runner 未被调用', async () => {
    const dataRoot = mkTmp()
    writeTaskDef(
      dataRoot,
      { id: 'noentry', name: 'NE', cron: '0 9 * * *', task_path: 'assets/programs/noentry/task.ts', enabled: true },
      false,
    )
    H.loaderImpl.value = { installTaskDeps: vi.fn(async () => {}) }
    const run = vi.fn(async () => ({ kind: 'quiet', reason: 'SHOULD-NOT-RUN' }))
    H.runnerImpl.value = { run }

    boot(dataRoot)
    const out = await orch().run('noentry', 'assets/programs/noentry/task.ts')

    expect(out.kind).toBe('skipped')
    expect(out.kind).not.toBe('failed')
    expect(String(out.reason)).toContain('任务程序文件缺失')
    expect(out.detail).toBe(resolve(H.cap.financeHome, 'assets/programs/noentry/task.ts'))
    // 关键：runner 必须完全未被触达
    expect(run).not.toHaveBeenCalled()
  })

  it('A2 检查点位置：缺失文件时 loader.installTaskDeps 不被执行（校验前移到依赖安装之前）', async () => {
    const dataRoot = mkTmp()
    writeTaskDef(
      dataRoot,
      { id: 'noentry2', name: 'NE2', cron: '0 9 * * *', task_path: 'assets/programs/noentry2/task.ts', enabled: true },
      false,
    )
    const install = vi.fn(async () => {})
    H.loaderImpl.value = { installTaskDeps: install }
    const run = vi.fn(async () => ({ kind: 'quiet', reason: 'x' }))
    H.runnerImpl.value = { run }

    boot(dataRoot)
    const out = await orch().run('noentry2', 'assets/programs/noentry2/task.ts')

    expect(out.kind).toBe('skipped')
    // 观察点：可读性校验前移到依赖安装之前，故缺程序时连依赖都不装。
    expect(install).not.toHaveBeenCalled()
    expect(run).not.toHaveBeenCalled()
  })

  it('A3 入口文件存在 → 正常透传执行（新校验不影响正常路径）', async () => {
    const dataRoot = mkTmp()
    writeTaskDef(
      dataRoot,
      { id: 'ok', name: 'OK', cron: '0 9 * * *', task_path: 'assets/programs/ok/task.ts', enabled: true },
      true,
    )
    const runCalls: string[] = []
    H.loaderImpl.value = { installTaskDeps: vi.fn(async () => {}) }
    H.runnerImpl.value = {
      run: vi.fn(async (p: string) => {
        runCalls.push(p)
        return { kind: 'quiet', reason: 'done' }
      }),
    }

    boot(dataRoot)
    const out = await orch().run('ok', 'assets/programs/ok/task.ts')

    expect(out.kind).toBe('quiet')
    expect(runCalls).toEqual([resolve(H.cap.financeHome, 'assets/programs/ok/task.ts')])
  })

  it('A4 顺序：缺失文件 + loader 会抛错 → 仍 skipped（校验先于安装，install 未被触发）', async () => {
    const dataRoot = mkTmp()
    writeTaskDef(
      dataRoot,
      { id: 'noentry3', name: 'NE3', cron: '0 9 * * *', task_path: 'assets/programs/noentry3/task.ts', enabled: true },
      false,
    )
    H.loaderImpl.value = {
      installTaskDeps: vi.fn(async () => {
        throw new Error('install boom')
      }),
    }
    const run = vi.fn(async () => ({ kind: 'quiet', reason: 'x' }))
    H.runnerImpl.value = { run }

    boot(dataRoot)
    const out = await orch().run('noentry3', 'assets/programs/noentry3/task.ts')

    // 校验先于安装：即使 loader 会抛，也不触发安装；缺程序 → skipped（不误归 failed/install）。
    expect(out.kind).toBe('skipped')
    expect(out.kind).not.toBe('failed')
    expect((H.loaderImpl.value as { installTaskDeps: { mock: { calls: unknown[] } } }).installTaskDeps.mock.calls.length).toBe(0)
    expect(run).not.toHaveBeenCalled()
  })

  it('A5 §9.1 读取失败：入口是非普通文件（目录）→ skipped，install/runner 均未被调用', async () => {
    const dataRoot = mkTmp()
    // 任务目录 + package.json 存在；入口 task.ts 位置被建成「目录」（existsSync=true 但非普通文件）。
    writeTaskDef(
      dataRoot,
      { id: 'direntry', name: 'DE', cron: '0 9 * * *', task_path: 'assets/programs/direntry/task.ts', enabled: true },
      false,
    )
    mkdirSync(resolve(H.cap.financeHome, 'assets/programs/direntry/task.ts'), { recursive: true })
    const install = vi.fn(async () => {})
    H.loaderImpl.value = { installTaskDeps: install }
    const run = vi.fn(async () => ({ kind: 'quiet', reason: 'SHOULD-NOT-RUN' }))
    H.runnerImpl.value = { run }

    boot(dataRoot)
    const out = await orch().run('direntry', 'assets/programs/direntry/task.ts')

    expect(out.kind).toBe('skipped')
    expect(String(out.reason)).toContain('任务程序文件缺失或不可读')
    expect(out.detail).toBe(resolve(H.cap.financeHome, 'assets/programs/direntry/task.ts'))
    expect(install).not.toHaveBeenCalled()
    expect(run).not.toHaveBeenCalled()
  })

  it('A6 §9.1 读取失败：入口存在但不可读（chmod 000）→ skipped，install/runner 均未被调用', async () => {
    const dataRoot = mkTmp()
    writeTaskDef(
      dataRoot,
      { id: 'unreadable', name: 'UR', cron: '0 9 * * *', task_path: 'assets/programs/unreadable/task.ts', enabled: true },
      true,
    )
    const abs = resolve(H.cap.financeHome, 'assets/programs/unreadable/task.ts')
    const { chmodSync } = await import('node:fs')
    chmodSync(abs, 0o000)
    const install = vi.fn(async () => {})
    H.loaderImpl.value = { installTaskDeps: install }
    const run = vi.fn(async () => ({ kind: 'quiet', reason: 'SHOULD-NOT-RUN' }))
    H.runnerImpl.value = { run }

    try {
      boot(dataRoot)
      const out = await orch().run('unreadable', 'assets/programs/unreadable/task.ts')
      expect(out.kind).toBe('skipped')
      expect(String(out.reason)).toContain('任务程序文件缺失或不可读')
      expect(out.detail).toBe(abs)
      expect(install).not.toHaveBeenCalled()
      expect(run).not.toHaveBeenCalled()
    } finally {
      try {
        chmodSync(abs, 0o644)
      } catch {
        /* ignore */
      }
    }
  })
})

// ===========================================================================
// B. 验收2：exit 0 但输出不可解析 → failed/parse（真实 TaskRunner）
// ===========================================================================
class FakeProcess implements TaskProcess {
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  exitCode: number | null = null
  killed: NodeJS.Signals[] = []
  kill(s?: NodeJS.Signals): void {
    if (s) this.killed.push(s)
  }
  write(t: string): void {
    this.stdout.write(t)
  }
  end(code: number | null): void {
    this.exitCode = code
    this.stdout.end()
    this.stderr.end()
  }
}
function spawnerOf(proc: FakeProcess) {
  const spawn = vi.fn((_p: string, _a?: readonly string[]) => proc)
  const spawner: Spawner = { spawn }
  return { spawner, spawn }
}
const TASK = '/tmp/assets/programs/x/task.ts'

describe('T100407-B 验收2：exit 0 输出不可解析 → failed/parse', () => {
  const cases: Array<[string, string, number | null]> = [
    ['无任何输出（空 stdout）', '', 0],
    ['只有纯日志行（无 JSON）', 'plain log\ndone\n', 0],
    ['末行非法 JSON', '{"shouldWake":\n', 0],
    ['末行是 JSON 数字（非对象）', '42\n', 0],
    ['末行是 JSON 数组（非对象）', '[{"shouldWake":false}]\n', 0],
    ['末行是 JSON null', 'null\n', 0],
    ['末行是 JSON 字符串', '"x"\n', 0],
    ['shouldWake 为字符串', '{"shouldWake":"yes"}\n', 0],
    ['shouldWake 为数字', '{"shouldWake":1}\n', 0],
    ['shouldWake 缺省（仅 data）', '{"data":"x"}\n', 0],
    ['shouldWake=true 但缺 data', '{"shouldWake":true}\n', 0],
    ['shouldWake=true 但 data 非 string', '{"shouldWake":true,"data":123}\n', 0],
  ]
  for (const [name, body, code] of cases) {
    it(`B ${name} → failed + failureKind=parse`, async () => {
      const proc = new FakeProcess()
      const { spawner } = spawnerOf(proc)
      const runner = new TaskRunner({ spawner })
      const pending = runner.run(TASK)
      if (body) proc.write(body)
      proc.end(code)
      const out = await pending
      expect(out.kind).toBe('failed')
      expect((out as { failureKind?: string }).failureKind).toBe('parse')
    })
  }

  it('B 边界：中间行是合法 JSON、末行是日志 → 仍 failed/parse（只认末行）', async () => {
    const proc = new FakeProcess()
    const { spawner } = spawnerOf(proc)
    const runner = new TaskRunner({ spawner })
    const pending = runner.run(TASK)
    proc.write('{"shouldWake":false}\ndone\n')
    proc.end(0)
    const out = await pending
    expect(out.kind).toBe('failed')
    expect((out as { failureKind?: string }).failureKind).toBe('parse')
  })
})

// ===========================================================================
// C. 验收3：回归——quiet / woke / exec / spawn / 超时 未被误改
// ===========================================================================
describe('T100407-C 验收3：既有结局零回归', () => {
  it('C1 shouldWake:false（合法）→ quiet', async () => {
    const proc = new FakeProcess()
    const { spawner } = spawnerOf(proc)
    const runner = new TaskRunner({ spawner })
    const pending = runner.run(TASK)
    proc.write('log\n{"shouldWake":false}\n\n')
    proc.end(0)
    const out = await pending
    expect(out.kind).toBe('quiet')
  })

  it('C2 shouldWake:true + data（合法）→ woke（data 原样）', async () => {
    const proc = new FakeProcess()
    const { spawner } = spawnerOf(proc)
    const runner = new TaskRunner({ spawner })
    const pending = runner.run(TASK)
    proc.write('{"shouldWake":true,"data":"HELLO"}\n')
    proc.end(0)
    const out = await pending
    expect(out.kind).toBe('woke')
    expect((out as { data?: string }).data).toBe('HELLO')
  })

  it('C3 非零退出 → failed/exec（即便末行是合法 JSON）', async () => {
    const proc = new FakeProcess()
    const { spawner } = spawnerOf(proc)
    const runner = new TaskRunner({ spawner })
    const pending = runner.run(TASK)
    proc.write('{"shouldWake":false}\n')
    proc.end(3)
    const out = await pending
    expect(out.kind).toBe('failed')
    expect((out as { failureKind?: string }).failureKind).toBe('exec')
  })

  it('C4 崩溃（exitCode=null）→ failed/exec', async () => {
    const proc = new FakeProcess()
    const { spawner } = spawnerOf(proc)
    const runner = new TaskRunner({ spawner })
    const pending = runner.run(TASK)
    proc.end(null)
    const out = await pending
    expect(out.kind).toBe('failed')
    expect((out as { failureKind?: string }).failureKind).toBe('exec')
  })

  it('C5 spawn 抛错 → failed/spawn', async () => {
    const spawner: Spawner = {
      spawn: vi.fn(() => {
        throw new Error('cannot spawn')
      }),
    }
    const runner = new TaskRunner({ spawner })
    const out = await runner.run(TASK)
    expect(out.kind).toBe('failed')
    expect((out as { failureKind?: string }).failureKind).toBe('spawn')
  })

  it('C6 超时 → failed/exec（SIGTERM 强杀，即便 stdout 已有合法 JSON）', async () => {
    const proc = new FakeProcess()
    const { spawner } = spawnerOf(proc)
    let fire: (() => void) | null = null
    const timeBudget = {
      setTimeout: (cb: () => void, _d: number) => {
        fire = cb
        return 0 as unknown as ReturnType<typeof setTimeout>
      },
      clearTimeout: () => {},
    }
    const runner = new TaskRunner({ spawner, timeBudget, taskTimeoutMs: 50 })
    const pending = runner.run(TASK)
    proc.write('{"shouldWake":false}\n')
    fire!()
    const out = await pending
    expect(out.kind).toBe('failed')
    expect((out as { failureKind?: string }).failureKind).toBe('exec')
    expect(proc.killed).toContain('SIGTERM')
  })

  it('C6b [真实 spawner] 超时 → failed/exec（真实 node 空转 + 短超时强杀）', async () => {
    const dir = mkTmp()
    const entry = join(dir, 'spin.mjs')
    writeFileSync(entry, 'setInterval(()=>{},1000)\n', 'utf8')
    const runner = new TaskRunner({ taskTimeoutMs: 300 })
    const out = await runner.run(entry)
    expect(out.kind).toBe('failed')
    expect((out as { failureKind?: string }).failureKind).toBe('exec')
  })
})

// ===========================================================================
// D. 边缘探针（runner 层直调）：非普通文件 / 不可读入口若「绕过编排层」直喂 runner，
//    仍按「起 node → 非零退出」归 failed/exec。
//    —— 新的编排层（§9.1 读取失败 → skipped）已在 A5/A6 用 statSync/accessSync 前置拦截，
//       正常链路下 runner 不会再收到这类路径；本组仅刻画 runner 自身黑盒行为。
// ===========================================================================
describe('T100407-D 边缘探针（runner 层）：读取失败/非普通文件直喂 runner 仍 failed/exec', () => {
  it('D1 [真实 spawner] 入口是目录 → 直喂 runner → failed/exec（编排层已前置拦截为 skipped，见 A5）', async () => {
    const dir = mkTmp()
    const entryAsDir = join(dir, 'task.ts')
    mkdirSync(entryAsDir, { recursive: true })
    // 直调 runner（绕过编排层）→ 真实 runner 起 node 读目录 → 非零退出
    const runner = new TaskRunner({ taskTimeoutMs: 3000 })
    const out = await runner.run(entryAsDir)
    expect(out.kind).toBe('failed')
    expect((out as { failureKind?: string }).failureKind).toBe('exec')
  })

  it('D2 [真实 spawner] 入口存在但不可读（chmod 000）→ 直喂 runner → failed/exec（编排层已前置拦截为 skipped，见 A6）', async () => {
    const dir = mkTmp()
    const entry = join(dir, 'task.ts')
    writeFileSync(entry, 'console.log("{\\"shouldWake\\":false}")\n', 'utf8')
    const { chmodSync } = await import('node:fs')
    chmodSync(entry, 0o000)
    try {
      const runner = new TaskRunner({ taskTimeoutMs: 3000 })
      const out = await runner.run(entry)
      // 不可读 → node EACCES → 非零退出 → failed/exec（未被归入 skipped）
      expect(out.kind).toBe('failed')
      expect((out as { failureKind?: string }).failureKind).toBe('exec')
    } finally {
      try {
        chmodSync(entry, 0o644)
      } catch {
        /* ignore */
      }
    }
  })
})
