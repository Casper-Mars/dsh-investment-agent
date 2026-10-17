/**
 * scheduler/runner.ts 单元测试。
 *
 * 唯一权威设计文档：《感知层详细设计（dsh-ia 插件）》 v0.7。
 *
 * 覆盖任务卡验收点：
 * - stdout 最后非空行解析（多行日志 + 尾随空行）
 * - 结局映射：woke / quiet / failed（含 failureKind；skipped 为编排层降级，非 runner 产出）
 * - 契约违约 → failed/parse（shouldWake 非 boolean / data 非 string / JSON 无效）
 * - taskTimeoutMs 默认 60000 可注入，超时 SIGTERM 强杀，时序正确（timedOut 归因）
 * - spawner 可注入（mock，不真跑 node）
 * - 独立 Node 进程、无 bindings 白名单（真实 spawner 走 node + 无 --import 注入）
 *
 * 全部用 mock spawner + mock stdout（PassThrough）驱动，不真跑 node。
 */
import { PassThrough } from 'node:stream'

import { afterEach, describe, expect, it, vi } from 'vitest'

import type { Spawner, TaskProcess } from '../src/scheduler/types.js'
import {
  TaskRunner,
  createTaskRunner,
  parseLastJsonLine,
  accumulateStdout,
  DEFAULT_TASK_TIMEOUT_MS,
  DEFAULT_MAX_STDOUT_BYTES,
} from '../src/scheduler/runner.js'

// ---------------------------------------------------------------------------
// mock 进程构造：用 PassThrough 模拟 stdout，可编程「写 data → 结束 → 关闭」
// ---------------------------------------------------------------------------

class FakeProcess implements TaskProcess {
  /** 累积写入的 stdout 字节（用于断言 runner 实际读了多少）。 */
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()

  exitCode: number | null = null
  killedSignals: NodeJS.Signals[] = []

  kill(signal?: NodeJS.Signals): void {
    if (signal) this.killedSignals.push(signal)
  }

  /** 写一段 stdout 文本。 */
  writeStdout(text: string): void {
    this.stdout.write(text)
  }

  /** 以给定退出码结束 stdout 流（触发 close → runner 判读）。 */
  endStdout(exitCode: number | null): void {
    this.exitCode = exitCode
    this.stdout.end()
    this.stderr.end()
  }
}

/** 构造一个「约束 spawn 只一次」的 mock，返回可编程 FakeProcess。 */
function makeSpawner(proc: FakeProcess) {
  const spawn = vi.fn<(taskPath: string, args?: readonly string[]) => TaskProcess>()
  spawn.mockReturnValue(proc)
  const spawner: Spawner = { spawn }
  return { spawner, spawn }
}

const TASK_PATH = '/tmp/assets/programs/market-pulse/task.ts'

describe('parseLastJsonLine：最后非空行解析', () => {
  it('多行日志 + 尾随空行 → 取最后一个非空行 JSON', () => {
    const stdout = 'log line 1\nlog line 2\n{"shouldWake":false}\n\n  \n'
    expect(parseLastJsonLine(stdout)).toEqual({ shouldWake: false })
  })

  it('多行日志 + 结果 JSON（唤醒）→ 取最后非空行', () => {
    const stdout = 'fetching...\n{"shouldWake":true,"data":"BTC 突破 10w"}\n'
    expect(parseLastJsonLine(stdout)).toEqual({
      shouldWake: true,
      data: 'BTC 突破 10w',
    })
  })

  it('中间行是 JSON、末行是日志 → 只认末行（若末行非 JSON 则 null）', () => {
    const stdout = '{"shouldWake":false}\ndone\n'
    expect(parseLastJsonLine(stdout)).toBeNull()
  })

  it('无任何非空行 → null', () => {
    expect(parseLastJsonLine('')).toBeNull()
    expect(parseLastJsonLine('\n\n  \n\n')).toBeNull()
  })

  it('契约违约：shouldWake 非 boolean → null', () => {
    expect(parseLastJsonLine('{"shouldWake":"yes"}')).toBeNull()
    expect(parseLastJsonLine('{"shouldWake":1}')).toBeNull()
    expect(parseLastJsonLine('{"data":"x"}')).toBeNull()
  })

  it('契约违约：shouldWake=true 但 data 非 string → null', () => {
    expect(parseLastJsonLine('{"shouldWake":true}')).toBeNull()
    expect(parseLastJsonLine('{"shouldWake":true,"data":123}')).toBeNull()
    expect(parseLastJsonLine('{"shouldWake":true,"data":null}')).toBeNull()
  })

  it('JSON 无效 / 非对象 / 数组 → null', () => {
    expect(parseLastJsonLine('not json')).toBeNull()
    expect(parseLastJsonLine('123')).toBeNull()
    expect(parseLastJsonLine('"str"')).toBeNull()
    expect(parseLastJsonLine('[{"shouldWake":false}]')).toBeNull()
    expect(parseLastJsonLine('null')).toBeNull()
  })
})

describe('TaskRunner.run：结局映射', () => {
  it('shouldWake=true → woke（data 原样 + targets 空数组）', async () => {
    const proc = new FakeProcess()
    const { spawner, spawn } = makeSpawner(proc)
    const runner = new TaskRunner({ spawner })

    const pending = runner.run(TASK_PATH)
    proc.writeStdout('doing work\n{"shouldWake":true,"data":"BTC 突破 10w"}\n')
    proc.endStdout(0)

    const outcome = await pending
    expect(outcome).toMatchObject({
      kind: 'woke',
      data: 'BTC 突破 10w',
      targets: [],
    })
    expect(spawn).toHaveBeenCalledTimes(1)
    expect(spawn).toHaveBeenCalledWith(TASK_PATH, undefined)
  })

  it('shouldWake=false → quiet', async () => {
    const proc = new FakeProcess()
    const { spawner } = makeSpawner(proc)
    const runner = new TaskRunner({ spawner })

    const pending = runner.run(TASK_PATH)
    proc.writeStdout('log\n{"shouldWake":false}\n')
    proc.endStdout(0)

    await expect(pending).resolves.toMatchObject({ kind: 'quiet' })
  })

  it('stdout 无有效 JSON → failed（failureKind=parse，含 detail 表达 parse 违约）', async () => {
    const proc = new FakeProcess()
    const { spawner } = makeSpawner(proc)
    const runner = new TaskRunner({ spawner })

    const pending = runner.run(TASK_PATH)
    proc.writeStdout('only logs, no json\n')
    proc.endStdout(0)

    const outcome = await pending
    expect(outcome.kind).toBe('failed')
    expect((outcome as { failureKind?: string }).failureKind).toBe('parse')
    expect((outcome as { detail?: string }).detail).toBeTruthy()
  })

  it('shouldWake 非 boolean → failed（failureKind=parse）', async () => {
    const proc = new FakeProcess()
    const { spawner } = makeSpawner(proc)
    const runner = new TaskRunner({ spawner })

    const pending = runner.run(TASK_PATH)
    proc.writeStdout('{"shouldWake":"yes","data":"x"}\n')
    proc.endStdout(0)

    await expect(pending).resolves.toMatchObject({ kind: 'failed', failureKind: 'parse' })
  })

  it('shouldWake=true 但 data 非 string → failed（failureKind=parse）', async () => {
    const proc = new FakeProcess()
    const { spawner } = makeSpawner(proc)
    const runner = new TaskRunner({ spawner })

    const pending = runner.run(TASK_PATH)
    proc.writeStdout('{"shouldWake":true}\n')
    proc.endStdout(0)

    await expect(pending).resolves.toMatchObject({ kind: 'failed', failureKind: 'parse' })
  })

  it('非零退出码 → failed（failureKind=exec）', async () => {
    const proc = new FakeProcess()
    const { spawner } = makeSpawner(proc)
    const runner = new TaskRunner({ spawner })

    const pending = runner.run(TASK_PATH)
    proc.writeStdout('{"shouldWake":false}\n')
    proc.endStdout(1)

    const outcome = await pending
    expect(outcome.kind).toBe('failed')
    expect((outcome as { failureKind?: string }).failureKind).toBe('exec')
  })

  it('进程崩溃（exitCode=null）→ failed（failureKind=exec）', async () => {
    const proc = new FakeProcess()
    const { spawner } = makeSpawner(proc)
    const runner = new TaskRunner({ spawner })

    const pending = runner.run(TASK_PATH)
    proc.endStdout(null)

    const outcome = await pending
    expect(outcome.kind).toBe('failed')
    expect((outcome as { failureKind?: string }).failureKind).toBe('exec')
  })

  it('spawn 抛错 → failed（failureKind=spawn）', async () => {
    const spawn = vi.fn<(taskPath: string, args?: readonly string[]) => TaskProcess>()
    spawn.mockImplementation(() => {
      throw new Error('spawn boom')
    })
    const runner = new TaskRunner({ spawner: { spawn } })

    const outcome = await runner.run(TASK_PATH)
    expect(outcome.kind).toBe('failed')
    expect((outcome as { failureKind?: string }).failureKind).toBe('spawn')
  })
})

describe('TaskRunner.run：超时强杀（时序正确）', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('默认 taskTimeoutMs 为 60000', () => {
    expect(DEFAULT_TASK_TIMEOUT_MS).toBe(60_000)
  })

  it('超时 → kill(SIGTERM) 强杀，归因 failed（exec），不落回正常退出', async () => {
    vi.useFakeTimers()
    const proc = new FakeProcess()
    const { spawner } = makeSpawner(proc)
    const runner = new TaskRunner({ spawner })

    const pending = runner.run(TASK_PATH)
    // 进程卡住，不结束 stdout。

    await vi.advanceTimersByTimeAsync(60_000)

    const outcome = await pending
    expect(outcome.kind).toBe('failed')
    expect((outcome as { failureKind?: string }).failureKind).toBe('exec')
    expect(proc.killedSignals).toContain('SIGTERM')
  })

  it('超时 timer 触发 SIGTERM 后进程快速 close → 仍归因 failed（不解析 stdout）', async () => {
    vi.useFakeTimers()
    const proc = new FakeProcess()
    const { spawner } = makeSpawner(proc)
    const runner = new TaskRunner({ spawner })

    const pending = runner.run(TASK_PATH)

    await vi.advanceTimersByTimeAsync(60_000)
    expect(proc.killedSignals).toContain('SIGTERM')

    // 进程响应 SIGTERM 立即输出一行「诱饵」JSON 并 close（timedOut 已 true，应被忽略）。
    proc.writeStdout('{"shouldWake":false}\n')
    proc.endStdout(0)

    // 排空剩余 timer（结算已被 settled 守卫挡掉）。
    await vi.runAllTimersAsync()

    const outcome = await pending
    expect(outcome.kind).toBe('failed')
    expect((outcome as { failureKind?: string }).failureKind).toBe('exec')
  })

  it('taskTimeoutMs 可注入覆盖，并按时注入值强杀', async () => {
    vi.useFakeTimers()
    const proc = new FakeProcess()
    const { spawner } = makeSpawner(proc)
    const runner = new TaskRunner({ spawner, taskTimeoutMs: 500 })

    const pending = runner.run(TASK_PATH)

    await vi.advanceTimersByTimeAsync(500)
    expect(proc.killedSignals).toContain('SIGTERM')

    const outcome = await pending
    expect(outcome.kind).toBe('failed')
  })

  it('进程在超时前正常 close → 不触发 kill，正常判读结果', async () => {
    vi.useFakeTimers()
    const proc = new FakeProcess()
    const { spawner } = makeSpawner(proc)
    const runner = new TaskRunner({ spawner, taskTimeoutMs: 60_000 })

    const pending = runner.run(TASK_PATH)
    proc.writeStdout('{"shouldWake":false}\n')
    proc.endStdout(0)

    const outcome = await pending
    expect(outcome.kind).toBe('quiet')
    expect(proc.killedSignals).toEqual([])

    await vi.runAllTimersAsync()
  })
})

describe('工厂入口 createTaskRunner', () => {
  it('返回可用的 TaskRunner', () => {
    expect(createTaskRunner()).toBeInstanceOf(TaskRunner)
  })
})

// ---------------------------------------------------------------------------
// stdout 上限（防 OOM）——白盒：封顶累积纯函数
// ---------------------------------------------------------------------------

describe('accumulateStdout：stdout 封顶累积（防 OOM）', () => {
  it('未超限 → 原样累加，overflowed=false', () => {
    expect(accumulateStdout('ab', 'cd', 10)).toEqual({ buffer: 'abcd', overflowed: false })
  })

  it('恰好等于上限 → 不判超限（边界含）', () => {
    expect(accumulateStdout('ab', 'cd', 4)).toEqual({ buffer: 'abcd', overflowed: false })
  })

  it('越限 → 只保留到上限的前缀，overflowed=true 且不越界', () => {
    const r = accumulateStdout('ab', 'cdef', 4)
    expect(r).toEqual({ buffer: 'abcd', overflowed: true })
    expect(r.buffer.length).toBeLessThanOrEqual(4)
  })

  it('已达上限再追加 → 不增长，overflowed=true', () => {
    const r = accumulateStdout('abcd', 'ef', 4)
    expect(r.buffer).toBe('abcd')
    expect(r.overflowed).toBe(true)
  })

  it('反复追加（模拟疯狂输出）→ 缓冲永不越界', () => {
    const LIMIT = 1024
    let buf = ''
    let overflows = 0
    for (let i = 0; i < 1000; i++) {
      const r = accumulateStdout(buf, 'x'.repeat(97), LIMIT)
      buf = r.buffer
      expect(buf.length).toBeLessThanOrEqual(LIMIT)
      if (r.overflowed) overflows++
    }
    expect(overflows).toBeGreaterThan(0)
    expect(buf.length).toBe(LIMIT)
  })
})

// ---------------------------------------------------------------------------
// stdout 上限（防 OOM）——集成：注入疯狂输出 mock 进程
// ---------------------------------------------------------------------------

describe('TaskRunner.run：stdout 超限强杀（防 OOM）', () => {
  it('默认上限为 1 MiB（DEFAULT_MAX_STDOUT_BYTES）', () => {
    expect(DEFAULT_MAX_STDOUT_BYTES).toBe(1_048_576)
  })

  it('疯狂输出越限 → SIGTERM 强杀 + failed/exec（含上限数字）', async () => {
    const proc = new FakeProcess()
    const { spawner } = makeSpawner(proc)
    const runner = new TaskRunner({ spawner, maxStdoutBytes: 1024 })

    const pending = runner.run(TASK_PATH)
    // 疯狂输出：每 chunk 512 字节，写 20 次（共 10 KiB，远超 1024 上限）。
    for (let i = 0; i < 20; i++) proc.writeStdout('x'.repeat(512))
    // 进程被强杀 → 模拟非正常退出（无退出码）。
    proc.endStdout(null)

    const outcome = await pending
    expect(outcome.kind).toBe('failed')
    expect((outcome as { failureKind?: string }).failureKind).toBe('exec')
    expect((outcome as { reason: string }).reason).toContain('超过上限')
    expect((outcome as { reason: string }).reason).toContain('1024')
    expect((outcome as { detail?: string }).detail).toBe('输出上限 1024 字节')
    expect(proc.killedSignals).toContain('SIGTERM')
  })

  it('单次大 chunk 直接越限 → 封顶缓冲不越界，强杀并归 failed', async () => {
    const proc = new FakeProcess()
    const { spawner } = makeSpawner(proc)
    const runner = new TaskRunner({ spawner, maxStdoutBytes: 100 })

    const pending = runner.run(TASK_PATH)
    // 一个 5000 字节的巨型 chunk（远超 100 上限）：不得被整段存入缓冲。
    proc.writeStdout('y'.repeat(5000))
    proc.endStdout(0)

    const outcome = await pending
    expect(outcome.kind).toBe('failed')
    expect((outcome as { failureKind?: string }).failureKind).toBe('exec')
    expect(proc.killedSignals).toContain('SIGTERM')
  })

  it('超限强杀后进程再输出诱饵 JSON 并正常 close → 仍为 failed（不落回 quiet）', async () => {
    const proc = new FakeProcess()
    const { spawner } = makeSpawner(proc)
    const runner = new TaskRunner({ spawner, maxStdoutBytes: 256 })

    const pending = runner.run(TASK_PATH)
    proc.writeStdout('z'.repeat(1000))
    // 越限结算后，进程再吐一行合法结果 JSON 并以 0 退出（overflowed 兜底应忽略）。
    proc.writeStdout('{"shouldWake":false}\n')
    proc.endStdout(0)

    const outcome = await pending
    expect(outcome.kind).toBe('failed')
    expect((outcome as { failureKind?: string }).failureKind).toBe('exec')
  })

  it('回归：小输出（未越限）行为不变 → quiet', async () => {
    const proc = new FakeProcess()
    const { spawner } = makeSpawner(proc)
    const runner = new TaskRunner({ spawner, maxStdoutBytes: 1024 })

    const pending = runner.run(TASK_PATH)
    proc.writeStdout('log\n{"shouldWake":false}\n')
    proc.endStdout(0)

    await expect(pending).resolves.toMatchObject({ kind: 'quiet' })
    expect(proc.killedSignals).toEqual([])
  })

  it('回归：小输出（未越限）woke 分支不受影响', async () => {
    const proc = new FakeProcess()
    const { spawner } = makeSpawner(proc)
    const runner = new TaskRunner({ spawner, maxStdoutBytes: 1024 })

    const pending = runner.run(TASK_PATH)
    proc.writeStdout('{"shouldWake":true,"data":"BTC 突破 10w"}\n')
    proc.endStdout(0)

    await expect(pending).resolves.toMatchObject({
      kind: 'woke',
      data: 'BTC 突破 10w',
      targets: [],
    })
    expect(proc.killedSignals).toEqual([])
  })
})