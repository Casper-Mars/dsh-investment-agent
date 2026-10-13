/**
 * 任务进程日志独立采集（M3）测试。
 *
 * 覆盖任务卡 t100436 验收点：
 *   1. 触发一次任务后 `logs/tasks/<taskId>/` 有日志文件，且**不含结果 JSON 污染**；
 *   2. 三结局既有测试全绿（本文件另附 runner 集成回归：结局不受日志旁路影响）；
 *   3. 单文件 10MB 上限（本文件用小上限驱动：超限停写 + warn，文件 ≤ 上限）；
 *   4. 落盘 `<logDir>/tasks/<taskId>/<ts>-<pid>.log`；目录 0700、文件 0600；
 *      目录可经 `DSH_IA_LOG_DIR` 覆盖；
 *   5. 零第三方依赖、不改顶层 inject（构建/类型门禁覆盖）。
 *
 * 另覆盖：末行结果 JSON 不落盘、stderr 全落、中间行完整落（含 chunk 跨边界）、
 * 写盘失败降级不抛、taskId/pid 命名与降级命名。
 */
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { Spawner, TaskProcess } from '../src/scheduler/types.js'
import { TaskRunner } from '../src/scheduler/runner.js'
import {
  createTaskLog,
  resolveTaskLogMaxSize,
  formatTaskLogPid,
  formatTaskLogTimestamp,
  DEFAULT_TASK_LOG_MAX_SIZE,
} from '../src/log/task-log.js'

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dsh-ia-tasklog-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

const FIXED_NOW = (): Date => new Date('2026-10-12T11:31:00.123Z')

/** 读取某任务目录下的唯一日志文件内容。 */
function readTaskLog(logDir: string, taskId: string): string {
  const dir = join(logDir, 'tasks', taskId)
  const files = readdirSync(dir)
  expect(files.length).toBeGreaterThan(0)
  return readFileSync(join(dir, files[0]), 'utf8')
}

/** 采集器：喂 stdout 若干段后收尾。 */
function runCollector(options: {
  taskId?: string
  pid?: number
  chunks?: string[]
  stderr?: string[]
  maxSize?: number
  now?: () => Date
}): { path: string | null; dir: string } {
  const log = createTaskLog(
    { taskId: options.taskId ?? 'demo', pid: options.pid },
    { dir: root, maxSize: options.maxSize, now: options.now ?? FIXED_NOW },
  )
  for (const c of options.chunks ?? []) log.writeStdoutChunk(c)
  for (const e of options.stderr ?? []) log.writeStderrChunk(e)
  log.close()
  return { path: log.path, dir: join(root, 'tasks', options.taskId ?? 'demo') }
}

describe('task-log 落盘：末行判定（结果 JSON 不落盘，其余完整落盘）', () => {
  it('多行日志 + 末行 JSON → 仅日志行落盘，JSON 与尾随空行丢弃', () => {
    runCollector({ chunks: ['log1\nlog2\n{"shouldWake":false}\n'] })
    expect(readTaskLog(root, 'demo')).toBe('log1\nlog2\n')
  })

  it('chunk 跨行边界（一行拆成两段）→ 中间行仍完整落盘', () => {
    runCollector({ chunks: ['line1\nli', 'ne2\n{"shouldWake":false}\n'] })
    expect(readTaskLog(root, 'demo')).toBe('line1\nline2\n')
  })

  it('末行无换行（JSON 未尾随 \\n）→ 前面的日志完整落盘，末行丢弃', () => {
    runCollector({ chunks: ['a\nb\n{"shouldWake":false}'] })
    expect(readTaskLog(root, 'demo')).toBe('a\nb\n')
  })

  it('中间出现空行 → 空行按序完整落盘（顺序与内容保真）', () => {
    runCollector({ chunks: ['a\n\nb\n{"shouldWake":false}\n'] })
    expect(readTaskLog(root, 'demo')).toBe('a\n\nb\n')
  })

  it('末尾多个空行 → 末行判定跳过空行，JSON 与其后空行均不落盘', () => {
    runCollector({ chunks: ['x\ny\n{"shouldWake":false}\n\n  \n'] })
    expect(readTaskLog(root, 'demo')).toBe('x\ny\n')
  })

  it('stdout 仅结果 JSON（无日志）→ 文件留档但内容为空（无污染）', () => {
    const { path } = runCollector({ chunks: ['{"shouldWake":true,"data":"hi"}\n'] })
    expect(path).not.toBeNull()
    expect(readTaskLog(root, 'demo')).toBe('')
  })

  it('完全无 stdout → 仍留档空文件', () => {
    const { path } = runCollector({ chunks: [] })
    expect(path).not.toBeNull()
    expect(readTaskLog(root, 'demo')).toBe('')
  })

  it('stderr 全部落盘（含多行与无尾随换行）', () => {
    runCollector({ chunks: ['ok\n{"shouldWake":false}\n'], stderr: ['w1\nw2\n', 'w3'] })
    const content = readTaskLog(root, 'demo')
    expect(content).toContain('w1\nw2\nw3')
    expect(content).not.toContain('shouldWake')
  })
})

describe('task-log 命名 / 权限 / 路径', () => {
  it('文件名 `<ts>-<pid>.log`（时间戳注入确定性）', () => {
    const { path } = runCollector({ taskId: 'market-pulse', pid: 4242 })
    expect(path).toBe(join(root, 'tasks', 'market-pulse', '2026-10-12T11-31-00-123Z-4242.log'))
  })

  it('pid 缺失 → 文件名降级为 `-unknown.log`', () => {
    const { path } = runCollector({ taskId: 'no-pid' })
    expect(path).toMatch(/-unknown\.log$/)
  })

  it('目录 0700 / 文件 0600', () => {
    const { path } = runCollector({ taskId: 'perm' })
    const dir = join(root, 'tasks', 'perm')
    expect(statSync(dir).mode & 0o777).toBe(0o700)
    expect(statSync(path as string).mode & 0o777).toBe(0o600)
  })

  it('taskId 含路径分隔符 → 目录段净化（防穿越）', () => {
    const { path } = runCollector({ taskId: 'a/b' })
    const dir = join(root, 'tasks', 'a_b')
    expect(existsSync(dir)).toBe(true)
    expect(path?.startsWith(dir)).toBe(true)
  })

  it('`DSH_IA_LOG_DIR` 覆盖日志根目录', () => {
    const prev = process.env.DSH_IA_LOG_DIR
    const envRoot = mkdtempSync(join(tmpdir(), 'dsh-ia-tasklog-env-'))
    process.env.DSH_IA_LOG_DIR = envRoot
    try {
      const log = createTaskLog({ taskId: 'envtask', pid: 9 }, { now: FIXED_NOW })
      log.writeStdoutChunk('hello\n{"shouldWake":false}\n')
      log.close()
      expect(log.path).toBe(join(envRoot, 'tasks', 'envtask', '2026-10-12T11-31-00-123Z-9.log'))
      expect(readFileSync(log.path as string, 'utf8')).toBe('hello\n')
    } finally {
      if (prev === undefined) delete process.env.DSH_IA_LOG_DIR
      else process.env.DSH_IA_LOG_DIR = prev
      rmSync(envRoot, { recursive: true, force: true })
    }
  })
})

describe('task-log 单文件上限（防磁盘打爆）', () => {
  it('超限 → 停写 + warn 一次，文件大小不超过上限', () => {
    const logFn = vi.fn()
    const log = createTaskLog(
      { taskId: 'flood', pid: 1 },
      { dir: root, maxSize: 10, now: FIXED_NOW, log: logFn },
    )
    // 每行 6 字节（"aaaaa\n"）；上限 10 → 只允许第一行写入。
    log.writeStdoutChunk('aaaaa\nbbbbb\nccccc\n{"shouldWake":false}\n')
    log.close()

    const path = log.path as string
    expect(statSync(path).size).toBeLessThanOrEqual(10)
    expect(readFileSync(path, 'utf8')).toBe('aaaaa\n')
    expect(logFn).toHaveBeenCalledTimes(1)
    const [level, message] = logFn.mock.calls[0]
    expect(level).toBe('warn')
    expect(String(message)).toContain('上限')
  })

  it('stderr 失控输出同样受上限约束（停写不再增长）', () => {
    const logFn = vi.fn()
    const log = createTaskLog(
      { taskId: 'stderr-flood', pid: 2 },
      { dir: root, maxSize: 64, now: FIXED_NOW, log: logFn },
    )
    for (let i = 0; i < 100; i++) log.writeStderrChunk('x'.repeat(32))
    log.close()
    expect(statSync(log.path as string).size).toBeLessThanOrEqual(64)
    expect(logFn).toHaveBeenCalledTimes(1)
  })

  it('resolveTaskLogMaxSize：显式 > 环境变量 > 默认 10MB', () => {
    const prev = process.env.DSH_IA_LOG_MAX_SIZE
    try {
      delete process.env.DSH_IA_LOG_MAX_SIZE
      expect(DEFAULT_TASK_LOG_MAX_SIZE).toBe(10 * 1024 * 1024)
      expect(resolveTaskLogMaxSize()).toBe(10 * 1024 * 1024)
      process.env.DSH_IA_LOG_MAX_SIZE = '2048'
      expect(resolveTaskLogMaxSize()).toBe(2048)
      expect(resolveTaskLogMaxSize(512)).toBe(512)
    } finally {
      if (prev === undefined) delete process.env.DSH_IA_LOG_MAX_SIZE
      else process.env.DSH_IA_LOG_MAX_SIZE = prev
    }
  })
})

describe('task-log 写盘失败降级（永不抛）', () => {
  it('目录无法创建 → 降级 no-op，不抛，写入无副作用', () => {
    const logFn = vi.fn()
    // 用一个「文件」占位父目录，使 mkdirSync 失败（ENOTDIR）。
    const blocker = join(root, 'blocker')
    writeFileSync(blocker, 'x')
    const log = createTaskLog(
      { taskId: 't', pid: 1 },
      { dir: join(blocker, 'sub'), now: FIXED_NOW, log: logFn },
    )
    expect(log.path).toBeNull()
    expect(() => {
      log.writeStdoutChunk('a\n')
      log.writeStderrChunk('b\n')
      log.close()
    }).not.toThrow()
    expect(logFn).toHaveBeenCalled()
  })

  it('初始化后目录被删除 → 追加失败降级，不抛', () => {
    const log = createTaskLog({ taskId: 'gone', pid: 3 }, { dir: root, now: FIXED_NOW })
    expect(log.path).not.toBeNull()
    rmSync(join(root, 'tasks', 'gone'), { recursive: true, force: true })
    expect(() => {
      log.writeStderrChunk('later\n')
      log.writeStdoutChunk('x\ny\n')
      log.close()
    }).not.toThrow()
  })
})

describe('task-log 纯函数', () => {
  it('formatTaskLogTimestamp：ISO → 文件名安全', () => {
    expect(formatTaskLogTimestamp(new Date('2026-10-12T11:31:00.123Z'))).toBe(
      '2026-10-12T11-31-00-123Z',
    )
  })

  it('formatTaskLogPid：整数原样，缺失 / 负数 → unknown', () => {
    expect(formatTaskLogPid(123)).toBe('123')
    expect(formatTaskLogPid(0)).toBe('0')
    expect(formatTaskLogPid(undefined)).toBe('unknown')
    expect(formatTaskLogPid(-1)).toBe('unknown')
    expect(formatTaskLogPid(1.5)).toBe('unknown')
  })
})

// ---------------------------------------------------------------------------
// runner 集成：taskId 透传 → 任务日志落盘；结局语义不变
// ---------------------------------------------------------------------------

class FakeProcess implements TaskProcess {
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  exitCode: number | null = null
  killedSignals: NodeJS.Signals[] = []
  constructor(readonly pid?: number) {}
  kill(signal?: NodeJS.Signals): void {
    if (signal) this.killedSignals.push(signal)
  }
  writeStdout(text: string): void {
    this.stdout.write(text)
  }
  writeStderr(text: string): void {
    this.stderr.write(text)
  }
  end(code: number | null): void {
    this.exitCode = code
    this.stdout.end()
    this.stderr.end()
  }
}

function makeSpawner(proc: FakeProcess): Spawner {
  return { spawn: () => proc }
}

describe('runner × task-log 集成', () => {
  it('携带 taskId → `logs/tasks/<taskId>/` 落盘（含 stdout 非末行 + stderr；不含结果 JSON）', async () => {
    const proc = new FakeProcess(777)
    const runner = new TaskRunner({
      spawner: makeSpawner(proc),
      taskLog: { dir: root, now: FIXED_NOW },
    })

    const pending = runner.run('/p/market-pulse/task.ts', undefined, { taskId: 'market-pulse' })
    proc.writeStdout('fetching...\nparsed ok\n')
    proc.writeStderr('warn: rate limited\n')
    proc.writeStdout('{"shouldWake":true,"data":"BTC 10w"}\n')
    proc.end(0)

    const outcome = await pending
    expect(outcome).toMatchObject({ kind: 'woke', data: 'BTC 10w', targets: [] })

    const file = join(root, 'tasks', 'market-pulse', '2026-10-12T11-31-00-123Z-777.log')
    const content = readFileSync(file, 'utf8')
    expect(content).toContain('fetching...')
    expect(content).toContain('parsed ok')
    expect(content).toContain('warn: rate limited')
    expect(content).not.toContain('shouldWake')
    expect(content).not.toContain('BTC 10w')
  })

  it('未携带 taskId → 不产生任何任务日志副作用（既有调用零影响）', async () => {
    const proc = new FakeProcess(778)
    const runner = new TaskRunner({
      spawner: makeSpawner(proc),
      taskLog: { dir: root, now: FIXED_NOW },
    })

    const pending = runner.run('/p/task.ts')
    proc.writeStdout('log\n{"shouldWake":false}\n')
    proc.end(0)

    await expect(pending).resolves.toMatchObject({ kind: 'quiet' })
    expect(existsSync(join(root, 'tasks'))).toBe(false)
  })

  it('坏结局（非零退出）仍落盘诊断；结局不受日志旁路影响', async () => {
    const proc = new FakeProcess(779)
    const runner = new TaskRunner({
      spawner: makeSpawner(proc),
      taskLog: { dir: root, now: FIXED_NOW },
    })

    const pending = runner.run('/p/task.ts', undefined, { taskId: 'boom' })
    proc.writeStdout('starting\ngoing\n') // 末行 going 按“末行判定”丢弃（非末行 starting 落盘）
    proc.writeStderr('boom!\n')
    proc.end(1)

    const outcome = await pending
    expect(outcome.kind).toBe('failed')
    expect((outcome as { failureKind?: string }).failureKind).toBe('exec')

    const content = readTaskLog(root, 'boom')
    expect(content).toContain('starting')
    expect(content).toContain('boom!')
    expect(content).not.toContain('going') // 末行（结果候选）按策略不落盘
  })
})
