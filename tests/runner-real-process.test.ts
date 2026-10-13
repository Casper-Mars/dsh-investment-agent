/**
 * scheduler/runner.ts 真实进程 end-to-end 测试。
 *
 * 唯一权威设计文档：《感知层详细设计（dsh-ia 插件）》 v0.7。
 *
 * 为什么需要本文件：
 * 原 tests/runner.test.ts 的 21 个用例全部 mock 了 spawner，从未驱动真实的
 * `createNodeSpawner`，因此掩盖了一处 Critical 缺陷——真实 Node 子进程的
 * `stdout` 流 `close` 事件与进程 `exit` 事件是**竞争的**，并不保证 close 晚于
 * exit。runner 若以 stdout close 为「进程结束」信号读 `exitCode`，会遇到
 * exitCode 间歇性为 `null`，把本应 woke/quiet 的任务误判为 failed。
 *
 * 修复后：runner 改用 TaskProcess.onClose（child_process 的 `close` 事件，
 * 进程退出且全部 stdio 关闭后触发，exitCode 已确定）驱动退出判定。
 *
 * 本文件用真实 `createTaskRunner()`（缺省真实 node spawner）驱动四个结局，
 * 其中 woke/quiet 用例循环多次（N=20）以暴露此前 exitCode 竞争——修复后应
 * 100% 确定性 woke/quiet，绝不误判 failed。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createTaskRunner } from '../src/scheduler/runner.js'
import type { TaskRunOutcome } from '../src/scheduler/types.js'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dsh-ia-runner-real-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

/** 写一个临时 `.js` 任务脚本，返回其绝对路径。 */
function writeScript(name: string, body: string): string {
  const path = join(dir, name)
  writeFileSync(path, body, 'utf8')
  return path
}

/** 以真实 createTaskRunner（真实 node spawner）执行一个临时脚本，返回结局。 */
async function runReal(scriptBody: string, opts?: { timeoutMs?: number }): Promise<TaskRunOutcome> {
  const taskPath = writeScript('task.js', scriptBody)
  const runner = createTaskRunner({ taskTimeoutMs: opts?.timeoutMs })
  return runner.run(taskPath)
}

/** 结局 kind 提取，便于断言。 */
function kindOf(o: TaskRunOutcome): string {
  return o.kind
}

const LOOP = 20

describe('真实进程 end-to-end：三结局（createNodeSpawner）', () => {
  it('(a) 多行日志 + 末行唤醒 JSON → woke（循环 N 次无竞争）', async () => {
    // 最关键的模式：打印一行结果 JSON 后立即 process.exit —— 正是此前间歇性
    // 触发 exitCode 竞争的「打印结果即退出」用例。
    const body = [
      "console.log('log line 1')",
      "console.log('log line 2')",
      "console.log(JSON.stringify({ shouldWake: true, data: 'hi' }))",
      'process.exit(0)',
    ].join('\n')

    for (let i = 0; i < LOOP; i++) {
      const outcome = await runReal(body)
      expect(kindOf(outcome)).toBe('woke')
      expect((outcome as { data?: string }).data).toBe('hi')
    }
  })

  it('(b) shouldWake=false → quiet（循环 N 次无竞争）', async () => {
    const body = [
      "console.log('noise log')",
      'console.log(JSON.stringify({ shouldWake: false }))',
      'process.exit(0)',
    ].join('\n')

    for (let i = 0; i < LOOP; i++) {
      const outcome = await runReal(body)
      expect(kindOf(outcome)).toBe('quiet')
    }
  })

  it('(c) 非法 JSON（exit 0 无有效结果）→ failed/parse', async () => {
    const body = [
      "console.log('only plain log')",
      "console.log('done')",
    ].join('\n')

    const outcome = await runReal(body)
    expect(kindOf(outcome)).toBe('failed')
    expect((outcome as { failureKind?: string }).failureKind).toBe('parse')
  })

  it('(d) process.exit(3) 非零退出 → failed/exec', async () => {
    const body = [
      "console.log(JSON.stringify({ shouldWake: false }))",
      'process.exit(3)',
    ].join('\n')

    const outcome = await runReal(body)
    expect(kindOf(outcome)).toBe('failed')
    expect((outcome as { failureKind?: string }).failureKind).toBe('exec')
  })

  it('(e) setInterval 空转 + 干扰日志，短 timeout → failed/exec（超时强杀）', async () => {
    const body = [
      "setInterval(() => console.log('still running'), 50)",
      "console.log('should not matter')",
    ].join('\n')

    const outcome = await runReal(body, { timeoutMs: 300 })
    expect(kindOf(outcome)).toBe('failed')
    expect((outcome as { failureKind?: string }).failureKind).toBe('exec')
  })
})

describe('真实进程：exitCode 始终被正确读到（不再偶发 null）', () => {
  it('快速退出 + 结果 JSON 的任务，exitCode=0 被可靠读到（循环 N 次）', async () => {
    const body = [
      "console.log('log')",
      'console.log(JSON.stringify({ shouldWake: false }))',
    ].join('\n')

    for (let i = 0; i < LOOP; i++) {
      const outcome = await runReal(body)
      // 修复前：stdout close 与 exit 竞争 → 偶发 exitCode null → 误判 failed。
      // 修复后：onClose 保证 exitCode 已确定 → 恒 quiet。
      expect(kindOf(outcome)).toBe('quiet')
    }
  })
})