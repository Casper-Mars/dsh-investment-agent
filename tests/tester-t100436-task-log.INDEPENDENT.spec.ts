/**
 * 独立验收测试（Tester）—— t100436「M3 任务进程日志独立采集」。
 *
 * 本文件**自成体系**，不复用 Developer 的 `tests/task-log.test.ts`。目的：用**独立**
 * 视角（含真实 node 子进程 E2E + 对抗性边界）核验技术方案 §5.3 / §9 与任务卡验收点。
 *
 * 被测交付物 HEAD=5617847：
 *   - src/log/task-log.ts（任务日志采集器）
 *   - src/scheduler/runner.ts（run() 新增第 3 参 options.taskId；stdout「延迟一行」旁路 + stderr 全落；createNodeSpawner 填 pid）
 *   - src/scheduler/index.ts（编排层携带 taskId）
 *   - src/scheduler/types.ts（TaskProcess.pid?）
 *
 * 隔离策略：所有用例一律用临时目录（注入 TaskLogOptions.dir 或临时设 DSH_IA_LOG_DIR），
 * 绝不触碰真实 ~/.dsh-ia；afterEach 清理。
 */
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { Spawner, TaskProcess, TaskRunOutcome } from '../src/scheduler/types.js'
import {
  DEFAULT_MAX_STDOUT_BYTES,
  DEFAULT_TASK_TIMEOUT_MS,
  createTaskRunner,
  parseLastJsonLine,
  TaskRunner,
} from '../src/scheduler/runner.js'
import {
  DEFAULT_TASK_LOG_MAX_SIZE,
  TASK_LOG_SUBDIR,
  TASK_LOG_UNKNOWN_SEGMENT,
  createTaskLog,
  formatTaskLogPid,
  formatTaskLogTimestamp,
  resolveTaskLogMaxSize,
} from '../src/log/task-log.js'
import { inject as topLevelInject } from '../src/plugin.js'

// ---------------------------------------------------------------------------
// 公共装置
// ---------------------------------------------------------------------------

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'tester-t100436-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
  vi.useRealTimers()
})

const FIXED_NOW = (): Date => new Date('2026-10-12T11:31:00.123Z')

/** 递增的假时间源（每调用一次 +1s，避免同 taskId 多次运行文件名撞车）。 */
function tickingNow(): () => Date {
  let tick = 0
  return () => new Date(1740000000000 + tick++ * 1000)
}

/** 任务日志目录。 */
function taskDir(logRoot: string, taskId: string): string {
  return join(logRoot, TASK_LOG_SUBDIR, taskId)
}

/** 某任务目录下的日志文件名列表（升序）。 */
function logFiles(logRoot: string, taskId: string): string[] {
  const d = taskDir(logRoot, taskId)
  if (!existsSync(d)) return []
  return readdirSync(d).sort()
}

/** 读取某任务目录下**唯一**的日志文件内容。 */
function readOnlyLog(logRoot: string, taskId: string): string {
  const files = logFiles(logRoot, taskId)
  expect(files.length).toBe(1)
  return readFileSync(join(taskDir(logRoot, taskId), files[0]), 'utf8')
}

// ---------------------------------------------------------------------------
// 采集器：末行判定矩阵（对抗性，重点）
// ---------------------------------------------------------------------------

describe('[1] 末行判定：结果 JSON 绝不落日志，其余行顺序/内容保真', () => {
  /** 便捷：喂 stdout/stderr 若干段后 close，返回采集器路径 + 目录。 */
  function collect(opts: {
    taskId?: string
    pid?: number
    chunks?: string[]
    stderr?: string[]
    maxSize?: number | string
  }): { path: string | null } {
    const taskId = opts.taskId ?? 'demo'
    const log = createTaskLog(
      { taskId, pid: opts.pid },
      { dir: root, now: FIXED_NOW, maxSize: opts.maxSize },
    )
    for (const c of opts.chunks ?? []) log.writeStdoutChunk(c)
    for (const e of opts.stderr ?? []) log.writeStderrChunk(e)
    log.close()
    return { path: log.path }
  }

  it('a) stdout 恰一行结果 JSON（无日志行）→ 文件存在但为空（零污染）', () => {
    const { path } = collect({ chunks: ['{"shouldWake":false}\n'] })
    expect(path).not.toBeNull()
    expect(readOnlyLog(root, 'demo')).toBe('')
  })

  it('b) 日志行A\\n日志行B\\n{JSON} → 只含 A、B（顺序保真），无 JSON', () => {
    collect({ chunks: ['日志行A\n日志行B\n{"shouldWake":false}\n'] })
    expect(readOnlyLog(root, 'demo')).toBe('日志行A\n日志行B\n')
  })

  it('c) 结果 JSON 后带尾随空行（含纯空白行）→ JSON 与其后空行均不落盘', () => {
    collect({ chunks: ['a\nb\n{"shouldWake":false}\n\n   \n\n'] })
    expect(readOnlyLog(root, 'demo')).toBe('a\nb\n')
  })

  it('d) 结果 JSON 无尾随换行（EOF 收尾）→ 前置日志完整落盘，JSON 丢弃', () => {
    collect({ chunks: ['a\nb\n{"shouldWake":false}'] })
    expect(readOnlyLog(root, 'demo')).toBe('a\nb\n')
  })

  it('e) JSON 跨 chunk 分片（“半个 chunk”到达）→ 不误落 JSON', () => {
    collect({ chunks: ['logA\n{"shouldWa', 'ke":true,"data":"BTC"}\n'] })
    expect(readOnlyLog(root, 'demo')).toBe('logA\n')
  })

  it('f) 行在 chunk 边界被拆开 → 中间行完整落盘（跨边界无损）', () => {
    collect({ chunks: ['li', 'ne1\nli', 'ne2\n{"shouldWake":false}\n'] })
    expect(readOnlyLog(root, 'demo')).toBe('line1\nline2\n')
  })

  it('g) 中间空行按序落盘；末行 JSON 与尾随空行不落盘', () => {
    collect({ chunks: ['x\n\n\ny\n{"shouldWake":false}\n\n'] })
    expect(readOnlyLog(root, 'demo')).toBe('x\n\n\ny\n')
  })

  it('h) 仅空行 + JSON → 空行在 JSON 之前仍落盘；JSON 不落盘', () => {
    collect({ chunks: ['\n\n{"shouldWake":true,"data":"hi"}\n'] })
    expect(readOnlyLog(root, 'demo')).toBe('\n\n')
  })

  it('i) 完全无 stdout → 仍留档空文件（可确认本次运行过）', () => {
    const { path } = collect({ chunks: [] })
    expect(path).not.toBeNull()
    expect(statSync(path as string).size).toBe(0)
  })

  it('j) 【既定策略核验】末行非 JSON（失败结局）时，最后一行也被当“结果候选”丢弃', () => {
    // 技术方案 §5.3 声明：失败结局下末行 stdout 同样被丢弃。此处核验与设计一致。
    collect({ chunks: ['keep1\nkeep2\nlastline-not-json\n'] })
    expect(readOnlyLog(root, 'demo')).toBe('keep1\nkeep2\n')
  })

  it('k) 结果 JSON 中含中文/转义 → 不落盘（无残留片段）', () => {
    collect({ chunks: ['preamble\n{"shouldWake":true,"data":"突破 10w \\"quoted\\""}\n'] })
    const content = readOnlyLog(root, 'demo')
    expect(content).toBe('preamble\n')
    expect(content).not.toContain('shouldWake')
    expect(content).not.toContain('突破')
  })
})

// ---------------------------------------------------------------------------
// 采集器：stderr 全落
// ---------------------------------------------------------------------------

describe('[2] stderr 全量落盘', () => {
  it('stderr 多行 + 无尾随换行 → 全部落盘；stdout 结果 JSON 不落', () => {
    const log = createTaskLog({ taskId: 'se', pid: 5 }, { dir: root, now: FIXED_NOW })
    log.writeStdoutChunk('out\n{"shouldWake":false}\n')
    log.writeStderrChunk('w1\nw2\n')
    log.writeStderrChunk('w3') // 无尾随换行
    log.close()
    const content = readOnlyLog(root, 'se')
    expect(content).toContain('w1\nw2\n')
    expect(content).toContain('w3')
    expect(content).not.toContain('shouldWake')
  })

  it('空 stderr 段被忽略（不产生内容、不抛）', () => {
    const log = createTaskLog({ taskId: 'se0', pid: 6 }, { dir: root, now: FIXED_NOW })
    expect(() => {
      log.writeStderrChunk('')
      log.writeStdoutChunk('')
      log.close()
    }).not.toThrow()
    expect(readOnlyLog(root, 'se0')).toBe('')
  })
})

// ---------------------------------------------------------------------------
// 采集器：命名 / 权限 / 路径覆盖
// ---------------------------------------------------------------------------

describe('[3] 落盘位置 / 文件名 / 权限', () => {
  it('a) 文件名 <ts>-<pid>.log（注入 now 确定性命名）', () => {
    const log = createTaskLog({ taskId: 'named', pid: 4242 }, { dir: root, now: FIXED_NOW })
    expect(log.path).toBe(
      join(root, TASK_LOG_SUBDIR, 'named', '2026-10-12T11-31-00-123Z-4242.log'),
    )
    log.close()
  })

  it('b) pid 缺失 → 文件名降级 <ts>-unknown.log，且不抛', () => {
    const log = createTaskLog({ taskId: 'nopid' }, { dir: root, now: FIXED_NOW })
    expect(log.path).toMatch(new RegExp(`-${TASK_LOG_UNKNOWN_SEGMENT}\\.log$`))
    expect(() => {
      log.writeStdoutChunk('x\n{"shouldWake":false}\n')
      log.close()
    }).not.toThrow()
  })

  it('c) 目录 0700 / 文件 0600', () => {
    const log = createTaskLog({ taskId: 'perm', pid: 7 }, { dir: root, now: FIXED_NOW })
    log.writeStdoutChunk('hello\n{"shouldWake":false}\n')
    log.close()
    const d = taskDir(root, 'perm')
    expect(statSync(d).mode & 0o777).toBe(0o700)
    expect(statSync(log.path as string).mode & 0o777).toBe(0o600)
  })

  it('d) DSH_IA_LOG_DIR 覆盖根目录（不传 dir 时生效）', () => {
    const prev = process.env.DSH_IA_LOG_DIR
    const envRoot = mkdtempSync(join(tmpdir(), 'tester-t100436-env-'))
    process.env.DSH_IA_LOG_DIR = envRoot
    try {
      const log = createTaskLog({ taskId: 'envtask', pid: 9 }, { now: FIXED_NOW })
      log.writeStdoutChunk('hit\n{"shouldWake":false}\n')
      log.close()
      expect(log.path).toBe(join(envRoot, TASK_LOG_SUBDIR, 'envtask', '2026-10-12T11-31-00-123Z-9.log'))
      expect(readFileSync(log.path as string, 'utf8')).toBe('hit\n')
    } finally {
      if (prev === undefined) delete process.env.DSH_IA_LOG_DIR
      else process.env.DSH_IA_LOG_DIR = prev
      rmSync(envRoot, { recursive: true, force: true })
    }
  })

  it('e) taskId 含路径分隔符 → 目录段净化，禁止目录穿越', () => {
    const log = createTaskLog({ taskId: '../../etc/x', pid: 1 }, { dir: root, now: FIXED_NOW })
    // 净化规则：路径分隔符 → '_'；'../../etc/x' → '.._.._etc_x'（不逃逸 root）。
    expect(log.path).not.toBeNull()
    expect(log.path!.startsWith(join(root, TASK_LOG_SUBDIR))).toBe(true)
    expect(existsSync(join(root, TASK_LOG_SUBDIR, '.._.._etc_x'))).toBe(true)
    expect(existsSync(join(root, 'etc'))).toBe(false)
    log.close()
  })

  it('f) 纯函数：时间戳 / pid 格式化', () => {
    expect(formatTaskLogTimestamp(new Date('2026-10-12T11:31:00.123Z'))).toBe(
      '2026-10-12T11-31-00-123Z',
    )
    expect(formatTaskLogPid(123)).toBe('123')
    expect(formatTaskLogPid(0)).toBe('0')
    expect(formatTaskLogPid(undefined)).toBe(TASK_LOG_UNKNOWN_SEGMENT)
    expect(formatTaskLogPid(-1)).toBe(TASK_LOG_UNKNOWN_SEGMENT)
    expect(formatTaskLogPid(2.5)).toBe(TASK_LOG_UNKNOWN_SEGMENT)
  })
})

// ---------------------------------------------------------------------------
// 采集器：单文件上限
// ---------------------------------------------------------------------------

describe('[4] 单文件上限（防磁盘打爆）', () => {
  it('a) 默认上限 = 10MB；解析优先级 显式 > env > 默认', () => {
    const prev = process.env.DSH_IA_LOG_MAX_SIZE
    try {
      delete process.env.DSH_IA_LOG_MAX_SIZE
      expect(DEFAULT_TASK_LOG_MAX_SIZE).toBe(10 * 1024 * 1024)
      expect(resolveTaskLogMaxSize()).toBe(10 * 1024 * 1024)
      process.env.DSH_IA_LOG_MAX_SIZE = '4096'
      expect(resolveTaskLogMaxSize()).toBe(4096)
      expect(resolveTaskLogMaxSize(128)).toBe(128)
      process.env.DSH_IA_LOG_MAX_SIZE = '0'
      expect(resolveTaskLogMaxSize()).toBe(10 * 1024 * 1024) // 非正 → 回退默认
    } finally {
      if (prev === undefined) delete process.env.DSH_IA_LOG_MAX_SIZE
      else process.env.DSH_IA_LOG_MAX_SIZE = prev
    }
  })

  it('b) stdout 海量行 → 文件 ≤ 上限 + warn 恰一次 + 不再增长', () => {
    const logFn = vi.fn()
    const log = createTaskLog(
      { taskId: 'cap', pid: 1 },
      { dir: root, maxSize: 32, now: FIXED_NOW, log: logFn },
    )
    for (let i = 0; i < 100; i++) log.writeStdoutChunk(`line-${i}\n`) // 大量“非末行”行
    log.writeStdoutChunk('{"shouldWake":false}\n')
    log.close()
    const size = statSync(log.path as string).size
    expect(size).toBeLessThanOrEqual(32)
    expect(logFn).toHaveBeenCalledTimes(1)
    expect(logFn.mock.calls[0][0]).toBe('warn')
    expect(String(logFn.mock.calls[0][1])).toContain('上限')
  })

  it('c) stderr 海量输出 → 同样封顶（不随输出增长）', () => {
    const logFn = vi.fn()
    const log = createTaskLog(
      { taskId: 'cap-se', pid: 2 },
      { dir: root, maxSize: 64, now: FIXED_NOW, log: logFn },
    )
    for (let i = 0; i < 200; i++) log.writeStderrChunk('y'.repeat(48))
    log.close()
    expect(statSync(log.path as string).size).toBeLessThanOrEqual(64)
    expect(logFn).toHaveBeenCalledTimes(1)
  })

  it('d) 恰好等于上限 → 允许写入（边界含）', () => {
    const log = createTaskLog(
      { taskId: 'edge', pid: 3 },
      { dir: root, maxSize: 12, now: FIXED_NOW, log: vi.fn() },
    )
    log.writeStdoutChunk('aaaaa\n') // 6
    log.writeStdoutChunk('bbbbb\n') // 6 → 合计 12（=上限，允许）
    log.close()
    // 第一行在遇到第二非空行时落盘；第二行作为“末行候选”被丢弃。
    expect(statSync(log.path as string).size).toBe(6)
  })
})

// ---------------------------------------------------------------------------
// 采集器：写盘失败降级（永不抛）
// ---------------------------------------------------------------------------

describe('[5] 写盘失败降级（永不抛，不影响结局）', () => {
  it('a) 目录无法创建（ENOTDIR）→ path=null，写/关均不抛，warn 一次', () => {
    const logFn = vi.fn()
    const blocker = join(root, 'blockfile')
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

  it('b) 初始化后目录被删 → 追加降级，不抛', () => {
    const log = createTaskLog({ taskId: 'gone', pid: 3 }, { dir: root, now: FIXED_NOW })
    expect(log.path).not.toBeNull()
    rmSync(taskDir(root, 'gone'), { recursive: true, force: true })
    expect(() => {
      log.writeStdoutChunk('x\ny\n')
      log.writeStderrChunk('later\n')
      log.close()
    }).not.toThrow()
  })

  it('c) 日志出口（log 回调）抛错 → 采集器吞掉，不抛', () => {
    const boom = (): never => {
      throw new Error('log sink boom')
    }
    const log = createTaskLog(
      { taskId: 'sink', pid: 1 },
      { dir: root, maxSize: 4, now: FIXED_NOW, log: boom },
    )
    expect(() => {
      log.writeStderrChunk('overflowing\n') // 触发 warn → log 抛 → 应被吞
      log.close()
    }).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// runner × task-log：mock 集成
// ---------------------------------------------------------------------------

/** 支持 onClose 的 mock 进程。 */
class FakeProc implements TaskProcess {
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  exitCode: number | null = null
  readonly killedSignals: NodeJS.Signals[] = []
  private cb?: () => void

  constructor(readonly pid?: number) {}

  kill(signal?: NodeJS.Signals): void {
    if (signal) this.killedSignals.push(signal)
  }

  onClose(cb: () => void): void {
    this.cb = cb
  }

  writeStdout(t: string): void {
    this.stdout.write(t)
  }

  writeStderr(t: string): void {
    this.stderr.write(t)
  }

  /** 设退出码 + 结束流，随后触发 onClose（模拟真实 close 晚于 exit）。 */
  end(code: number | null): void {
    this.exitCode = code
    this.stdout.end()
    this.stderr.end()
    setImmediate(() => this.cb?.())
  }
}

function spawnerOf(proc: TaskProcess): Spawner {
  return { spawn: () => proc }
}

describe('[6] runner × task-log：taskId 透传与零副作用', () => {
  it('a) 携带 taskId → 落盘（stdout 非末行 + stderr；不含结果 JSON），结局正确', async () => {
    const proc = new FakeProc(777)
    const runner = new TaskRunner({
      spawner: spawnerOf(proc),
      taskLog: { dir: root, now: FIXED_NOW },
    })
    const pending = runner.run('/p/task.ts', undefined, { taskId: 'market-pulse' })
    proc.writeStdout('fetching...\nparsed ok\n')
    proc.writeStderr('warn: limited\n')
    proc.writeStdout('{"shouldWake":true,"data":"BTC 10w"}\n')
    proc.end(0)

    const outcome = await pending
    expect(outcome).toMatchObject({ kind: 'woke', data: 'BTC 10w', targets: [] })

    const content = readOnlyLog(root, 'market-pulse')
    expect(content).toContain('fetching...')
    expect(content).toContain('parsed ok')
    expect(content).toContain('warn: limited')
    expect(content).not.toContain('shouldWake')
    expect(content).not.toContain('BTC 10w')
    expect(logFiles(root, 'market-pulse')[0]).toContain('-777.log')
  })

  it('b) 未携带 taskId → 零磁盘写入（既有调用零影响）', async () => {
    const proc = new FakeProc(778)
    const runner = new TaskRunner({
      spawner: spawnerOf(proc),
      taskLog: { dir: root, now: FIXED_NOW },
    })
    const pending = runner.run('/p/task.ts')
    proc.writeStdout('log\n{"shouldWake":false}\n')
    proc.end(0)
    await expect(pending).resolves.toMatchObject({ kind: 'quiet' })
    expect(existsSync(join(root, TASK_LOG_SUBDIR))).toBe(false)
    expect(existsSync(root)).toBe(true) // root 本身是 mkdtemp，未被创建子目录
    expect(logFiles(root, 'anything')).toEqual([])
  })

  it('c) taskId 为空串 / 纯空白 → 视同缺失，零写入', async () => {
    for (const bad of ['', '   ']) {
      const proc = new FakeProc(779)
      const runner = new TaskRunner({
        spawner: spawnerOf(proc),
        taskLog: { dir: root, now: FIXED_NOW },
      })
      const pending = runner.run('/p/task.ts', undefined, { taskId: bad })
      proc.writeStdout('log\n{"shouldWake":false}\n')
      proc.end(0)
      await expect(pending).resolves.toMatchObject({ kind: 'quiet' })
    }
    expect(existsSync(join(root, TASK_LOG_SUBDIR))).toBe(false)
  })

  it('d) spawn 抛错 → failed/spawn，且不产生日志目录（无进程可采）', async () => {
    const spawner: Spawner = {
      spawn: () => {
        throw new Error('spawn boom')
      },
    }
    const runner = new TaskRunner({ spawner, taskLog: { dir: root, now: FIXED_NOW } })
    const outcome = await runner.run('/p/task.ts', undefined, { taskId: 'boom' })
    expect(outcome).toMatchObject({ kind: 'failed', failureKind: 'spawn' })
    expect(logFiles(root, 'boom')).toEqual([])
  })

  it('e) pid 缺失（mock 无 pid）→ 降级 <ts>-unknown.log，且不抛', async () => {
    const proc = new FakeProc(undefined)
    const runner = new TaskRunner({
      spawner: spawnerOf(proc),
      taskLog: { dir: root, now: FIXED_NOW },
    })
    const pending = runner.run('/p/task.ts', undefined, { taskId: 'nopid' })
    proc.writeStdout('noise\n{"shouldWake":false}\n')
    proc.end(0)
    await expect(pending).resolves.toMatchObject({ kind: 'quiet' })
    expect(logFiles(root, 'nopid')[0]).toMatch(/-unknown\.log$/)
  })

  it('f) 无 onClose 的 mock（回退 stdout close）→ 落盘与结局均正常', async () => {
    // 构造一个不带 onClose 的最小 TaskProcess。
    const streams = { stdout: new PassThrough(), stderr: new PassThrough() }
    let code: number | null = null
    const proc: TaskProcess = {
      stdout: streams.stdout,
      stderr: streams.stderr,
      get exitCode() {
        return code
      },
      kill() {
        /* noop */
      },
    }
    const runner = new TaskRunner({
      spawner: spawnerOf(proc),
      taskLog: { dir: root, now: FIXED_NOW },
    })
    const pending = runner.run('/p/task.ts', undefined, { taskId: 'nocb' })
    streams.stdout.write('logline\n{"shouldWake":false}\n')
    streams.stderr.write('diagnostic\n')
    code = 0
    streams.stdout.end()
    streams.stderr.end()

    await expect(pending).resolves.toMatchObject({ kind: 'quiet' })
    const content = readOnlyLog(root, 'nocb')
    expect(content).toContain('logline')
    expect(content).toContain('diagnostic')
    expect(content).not.toContain('shouldWake')
  })

  it('g) 初始化后目录被删 → 结局不受影响，不抛', async () => {
    const proc = new FakeProc(780)
    const runner = new TaskRunner({
      spawner: spawnerOf(proc),
      taskLog: { dir: root, now: FIXED_NOW },
    })
    const pending = runner.run('/p/task.ts', undefined, { taskId: 'deleted' })
    rmSync(taskDir(root, 'deleted'), { recursive: true, force: true })
    proc.writeStdout('a\n{"shouldWake":false}\n')
    proc.end(0)
    await expect(pending).resolves.toMatchObject({ kind: 'quiet' })
  })
})

// ---------------------------------------------------------------------------
// runner × task-log：结局语义回归（对齐 runner.test.ts 口径）
// ---------------------------------------------------------------------------

describe('[7] 结局语义回归（日志旁路不改变任何结局）', () => {
  const PATH = '/tmp/assets/programs/x/task.ts'
  function runner(proc: TaskProcess, extra: Partial<ConstructorParameters<typeof TaskRunner>[0]> = {}) {
    return new TaskRunner({
      spawner: spawnerOf(proc),
      taskLog: { dir: root, now: FIXED_NOW },
      ...extra,
    })
  }

  it('quiet：shouldWake=false', async () => {
    const p = new FakeProc(1)
    const pending = runner(p).run(PATH, undefined, { taskId: 'q' })
    p.writeStdout('log\n{"shouldWake":false}\n')
    p.end(0)
    await expect(pending).resolves.toMatchObject({ kind: 'quiet' })
  })

  it('woke：shouldWake=true（data 透传 + targets []）', async () => {
    const p = new FakeProc(2)
    const pending = runner(p).run(PATH, undefined, { taskId: 'w' })
    p.writeStdout('log\n{"shouldWake":true,"data":"BTC 突破 10w"}\n')
    p.end(0)
    await expect(pending).resolves.toMatchObject({
      kind: 'woke',
      data: 'BTC 突破 10w',
      targets: [],
    })
  })

  it('failed/parse：末行无有效 JSON', async () => {
    const p = new FakeProc(3)
    const pending = runner(p).run(PATH, undefined, { taskId: 'p' })
    p.writeStdout('only logs\n')
    p.end(0)
    await expect(pending).resolves.toMatchObject({ kind: 'failed', failureKind: 'parse' })
  })

  it('failed/parse：shouldWake 非 boolean / data 非 string', async () => {
    for (const body of ['{"shouldWake":"yes"}\n', '{"shouldWake":true}\n']) {
      const p = new FakeProc(4)
      const pending = runner(p).run(PATH, undefined, { taskId: 'p2' })
      p.writeStdout(body)
      p.end(0)
      await expect(pending).resolves.toMatchObject({ kind: 'failed', failureKind: 'parse' })
    }
  })

  it('failed/exec：非零退出码', async () => {
    const p = new FakeProc(5)
    const pending = runner(p).run(PATH, undefined, { taskId: 'e' })
    p.writeStdout('{"shouldWake":false}\n')
    p.end(1)
    await expect(pending).resolves.toMatchObject({ kind: 'failed', failureKind: 'exec' })
  })

  it('failed/exec：崩溃（exitCode=null）', async () => {
    const p = new FakeProc(6)
    const pending = runner(p).run(PATH, undefined, { taskId: 'c' })
    p.end(null)
    await expect(pending).resolves.toMatchObject({ kind: 'failed', failureKind: 'exec' })
  })

  it('failed/exec：超时 SIGTERM 强杀（fake timers）', async () => {
    vi.useFakeTimers()
    const p = new FakeProc(7)
    const pending = runner(p, { taskTimeoutMs: 500 }).run(PATH, undefined, { taskId: 'to' })
    await vi.advanceTimersByTimeAsync(500)
    const outcome = await pending
    expect(outcome).toMatchObject({ kind: 'failed', failureKind: 'exec' })
    expect(p.killedSignals).toContain('SIGTERM')
  })

  it('failed/exec：stdout 超限 SIGTERM 强杀（maxStdoutBytes 注入）', async () => {
    const p = new FakeProc(8)
    const pending = runner(p, { maxStdoutBytes: 256 }).run(PATH, undefined, { taskId: 'of' })
    for (let i = 0; i < 10; i++) p.writeStdout('x'.repeat(128))
    p.end(null)
    const outcome = await pending
    expect(outcome).toMatchObject({ kind: 'failed', failureKind: 'exec' })
    expect((outcome as { reason: string }).reason).toContain('超过上限')
    expect(p.killedSignals).toContain('SIGTERM')
  })

  it('常量口径：DEFAULT_MAX_STDOUT_BYTES=1MiB、DEFAULT_TASK_TIMEOUT_MS=60s', () => {
    expect(DEFAULT_MAX_STDOUT_BYTES).toBe(1_048_576)
    expect(DEFAULT_TASK_TIMEOUT_MS).toBe(60_000)
  })

  it('parseLastJsonLine 语义未变（抽查）', () => {
    expect(parseLastJsonLine('log\n{"shouldWake":false}\n\n')).toEqual({ shouldWake: false })
    expect(parseLastJsonLine('{"shouldWake":false}\ndone\n')).toBeNull()
    expect(parseLastJsonLine('   \n')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// runner × task-log：多次运行不串扰
// ---------------------------------------------------------------------------

describe('[8] 多次运行不串扰', () => {
  it('同 taskId 多次运行（递增时钟）→ 文件互不覆盖、内容各自正确', async () => {
    // 共享同一递增时钟（模拟真实时间推进），使两次运行落入不同 <ts> 文件名。
    const clock = tickingNow()
    for (const body of ['one', 'two']) {
      const p = new FakeProc(1001)
      const r = new TaskRunner({ spawner: spawnerOf(p), taskLog: { dir: root, now: clock } })
      const pending = r.run('/p/t.ts', undefined, { taskId: 'same' })
      p.writeStdout(`${body}\n{"shouldWake":false}\n`)
      p.end(0)
      await expect(pending).resolves.toMatchObject({ kind: 'quiet' })
    }
    const files = logFiles(root, 'same')
    expect(files.length).toBe(2)
    const contents = files.map((f) => readFileSync(join(taskDir(root, 'same'), f), 'utf8'))
    expect(contents.sort()).toEqual(['one\n', 'two\n'])
  })

  it('不同 taskId 并发 → 目录独立、内容互不混入', async () => {
    const clock = tickingNow()
    const pA = new FakeProc(2001)
    const pB = new FakeProc(2002)
    const rA = new TaskRunner({ spawner: spawnerOf(pA), taskLog: { dir: root, now: clock } })
    const rB = new TaskRunner({ spawner: spawnerOf(pB), taskLog: { dir: root, now: clock } })

    const pendA = rA.run('/p/a.ts', undefined, { taskId: 'taskA' })
    const pendB = rB.run('/p/b.ts', undefined, { taskId: 'taskB' })

    pA.writeStdout('alpha-only\n{"shouldWake":false}\n')
    pB.writeStdout('beta-only\n{"shouldWake":true,"data":"B"}\n')
    pA.end(0)
    pB.end(0)

    await expect(pendA).resolves.toMatchObject({ kind: 'quiet' })
    await expect(pendB).resolves.toMatchObject({ kind: 'woke', data: 'B' })

    const contentA = readOnlyLog(root, 'taskA')
    const contentB = readOnlyLog(root, 'taskB')
    expect(contentA).toBe('alpha-only\n')
    expect(contentB).toBe('beta-only\n')
    expect(contentA).not.toContain('beta')
    expect(contentB).not.toContain('alpha')
  })
})

// ---------------------------------------------------------------------------
// 真实 node 子进程 E2E（createNodeSpawner）
// ---------------------------------------------------------------------------

describe('[9] 真实 node 子进程 E2E（createTaskRunner 缺省真实 spawner）', () => {
  /** 写一个临时 .js 任务脚本，返回绝对路径。 */
  function writeScript(body: string): string {
    const p = join(root, `task-${Math.random().toString(36).slice(2)}.js`)
    writeFileSync(p, body, 'utf8')
    return p
  }

  it('a) 多行日志 + stderr + 末行 JSON → 文件位置/命名(含 pid)/权限/内容 + 结局 woke', async () => {
    const script = writeScript(
      [
        "console.log('real line 1')",
        "console.log('real line 2')",
        "console.error('stderr line 1')",
        'console.error(`PID=${process.pid}`)',
        "console.log(JSON.stringify({ shouldWake: true, data: 'REAL-E2E' }))",
      ].join('\n'),
    )
    const runner = createTaskRunner({ taskLog: { dir: root } })
    const outcome = await runner.run(script, undefined, { taskId: 'e2e-woke' })

    expect(outcome).toMatchObject({ kind: 'woke', data: 'REAL-E2E', targets: [] })

    const files = logFiles(root, 'e2e-woke')
    expect(files.length).toBe(1)
    // 文件名含真实子进程 pid（由脚本打印成 PID=... 交叉校验）。
    const m = files[0].match(/-(\d+)\.log$/)
    expect(m).not.toBeNull()
    const content = readOnlyLog(root, 'e2e-woke')
    expect(content).toContain(`PID=${m![1]}`)
    expect(content).toContain('real line 1')
    expect(content).toContain('real line 2')
    expect(content).toContain('stderr line 1')
    expect(content).not.toContain('shouldWake')
    expect(content).not.toContain('REAL-E2E')

    const d = taskDir(root, 'e2e-woke')
    expect(statSync(d).mode & 0o777).toBe(0o700)
    expect(statSync(join(d, files[0])).mode & 0o777).toBe(0o600)
  })

  it('b) 真实子进程 quiet（shouldWake=false）→ 日志不含结果 JSON', async () => {
    const script = writeScript(
      [
        "console.log('noise 1')",
        "console.log(JSON.stringify({ shouldWake: false }))",
      ].join('\n'),
    )
    const runner = createTaskRunner({ taskLog: { dir: root } })
    const outcome = await runner.run(script, undefined, { taskId: 'e2e-quiet' })
    expect(outcome).toMatchObject({ kind: 'quiet' })
    const content = readOnlyLog(root, 'e2e-quiet')
    expect(content).toContain('noise 1')
    expect(content).not.toContain('shouldWake')
  })

  it('c) 真实子进程超时强杀 → 日志留档 + failed/exec', async () => {
    const script = writeScript(
      [
        "setInterval(() => console.log('still running'), 20)",
        "console.log('booted')",
      ].join('\n'),
    )
    const runner = createTaskRunner({ taskLog: { dir: root }, taskTimeoutMs: 400 })
    const outcome = await runner.run(script, undefined, { taskId: 'e2e-timeout' })
    expect(outcome).toMatchObject({ kind: 'failed', failureKind: 'exec' })
    // 留档：目录应存在（可能已含若干日志行）
    expect(logFiles(root, 'e2e-timeout').length).toBe(1)
  })

  it('d) 真实子进程 stderr 失控 → 文件 ≤ 上限 + warn + 结局仍正确解析（env 驱动）', async () => {
    const prev = process.env.DSH_IA_LOG_MAX_SIZE
    process.env.DSH_IA_LOG_MAX_SIZE = '8192'
    const warn = vi.fn()
    try {
      const script = writeScript(
        [
          'const buf = "z".repeat(256)',
          'for (let i = 0; i < 2000; i++) process.stderr.write(buf)', // ~512KB stderr
          "console.log(JSON.stringify({ shouldWake: false }))",
        ].join('\n'),
      )
      const runner = createTaskRunner({ taskLog: { dir: root, log: warn } })
      const outcome = await runner.run(script, undefined, { taskId: 'e2e-flood' })
      expect(outcome).toMatchObject({ kind: 'quiet' }) // 结局不受日志封顶影响
      const file = join(taskDir(root, 'e2e-flood'), logFiles(root, 'e2e-flood')[0])
      expect(statSync(file).size).toBeLessThanOrEqual(8192)
      const warnCalls = warn.mock.calls.filter((c) => c[0] === 'warn')
      expect(warnCalls.length).toBeGreaterThanOrEqual(1)
      expect(String(warnCalls[0][1])).toContain('上限')
    } finally {
      if (prev === undefined) delete process.env.DSH_IA_LOG_MAX_SIZE
      else process.env.DSH_IA_LOG_MAX_SIZE = prev
    }
  })

  it('e) 上限只约束日志文件、不影响 stdout 结果解析（极小上限）', async () => {
    const script = writeScript(
      [
        "console.log('some log line')",
        "console.log(JSON.stringify({ shouldWake: true, data: 'OK' }))",
      ].join('\n'),
    )
    const runner = createTaskRunner({ taskLog: { dir: root, maxSize: 1, log: vi.fn() } })
    const outcome = await runner.run(script, undefined, { taskId: 'e2e-cap-parse' })
    expect(outcome).toMatchObject({ kind: 'woke', data: 'OK' })
    const file = join(taskDir(root, 'e2e-cap-parse'), logFiles(root, 'e2e-cap-parse')[0])
    expect(statSync(file).size).toBeLessThanOrEqual(1)
  })
})

// ---------------------------------------------------------------------------
// 契约门禁：零第三方依赖 / 顶层 inject 不变
// ---------------------------------------------------------------------------

describe('[10] 契约门禁', () => {
  it('a) 顶层 inject 仍为 [tools, skills, fs]', () => {
    expect(topLevelInject).toEqual(['tools', 'skills', 'fs'])
  })

  it('b) src/log/task-log.ts 仅依赖 node:* 与相对路径（零第三方）', () => {
    const src = readFileSync(new URL('../src/log/task-log.ts', import.meta.url), 'utf8')
    const specifiers = [...src.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1])
    expect(specifiers.length).toBeGreaterThan(0)
    for (const s of specifiers) {
      const ok = s.startsWith('node:') || s.startsWith('./') || s.startsWith('../')
      expect(ok, `非 node:/相对 依赖: ${s}`).toBe(true)
    }
    // 无 require() 动态依赖
    expect(/\brequire\s*\(/.test(src)).toBe(false)
  })
})
