/**
 * tester-path-fixed-dir.INDEPENDENT.spec.ts
 * 独立验证：固定目录改造（paths.ts）—— 路径解析 + 目录自动创建 + 环境变量优先级。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import {
  FINANCE_HOME,
  resolveFinanceHomeDir,
  ensureFinanceHomeDir,
  resolveFinanceDataDir,
  ensureFinanceDataDir,
  resolveFinanceTasksDir,
} from '../src/paths.js'
import { createToolContext, DATA_ROOT_ENV } from '../src/tools/context.js'

const HOME = homedir()
const base = join(HOME, FINANCE_HOME)

describe('路径解析（固定目录锚定）', () => {
  it('resolveFinanceHomeDir = ~/.dsh-finance（绝对路径）', () => {
    expect(resolveFinanceHomeDir()).toBe(base)
    expect(resolveFinanceHomeDir().startsWith('/')).toBe(true)
    expect(resolveFinanceHomeDir()).not.toContain('~')
  })

  it('resolveFinanceDataDir = ~/.dsh-finance/data', () => {
    expect(resolveFinanceDataDir()).toBe(join(base, 'data'))
  })

  it('resolveFinanceTasksDir = ~/.dsh-finance/data/tasks', () => {
    expect(resolveFinanceTasksDir()).toBe(join(base, 'data', 'tasks'))
  })

  it('三处路径均为绝对路径且不含 .. 段', () => {
    for (const p of [resolveFinanceHomeDir(), resolveFinanceDataDir(), resolveFinanceTasksDir()]) {
      expect(p.startsWith('/')).toBe(true)
      expect(p).not.toContain('..')
    }
  })
})

describe('目录自动创建（幂等）', () => {
  beforeAll(() => {
    // 幂等测试环境：确保从干净状态出发（仅删 .dsh-finance/data，不碰 home 其他内容）
    if (existsSync(base)) {
      rmSync(base, { recursive: true, force: true })
    }
  })

  it('ensureFinanceHomeDir 创建目录并返回绝对路径', () => {
    const dir = ensureFinanceHomeDir()
    expect(dir).toBe(base)
    expect(existsSync(dir)).toBe(true)
  })

  it('ensureFinanceDataDir 递归创建 ~/.dsh-finance/data', () => {
    const dir = ensureFinanceDataDir()
    expect(dir).toBe(join(base, 'data'))
    expect(existsSync(dir)).toBe(true)
  })

  it('ensure 幂等：重复调用不报错且结果一致', () => {
    expect(ensureFinanceHomeDir()).toBe(base)
    expect(ensureFinanceDataDir()).toBe(join(base, 'data'))
    expect(ensureFinanceHomeDir()).toBe(base)
  })
})

describe('环境变量优先级（构造注入 > DSH_FINANCE_DATA_DIR > 默认）', () => {
  const savedEnv = process.env[DATA_ROOT_ENV]

  afterAll(() => {
    if (savedEnv === undefined) delete process.env[DATA_ROOT_ENV]
    else process.env[DATA_ROOT_ENV] = savedEnv
  })

  it('构造注入 dataRoot 最高优先级', () => {
    process.env[DATA_ROOT_ENV] = '/tmp/should-be-overridden'
    const ctx = createToolContext({ dataRoot: '/tmp/injected-root' })
    expect(ctx.dataRoot).toBe(resolve('/tmp/injected-root'))
  })

  it('环境变量 DSH_FINANCE_DATA_DIR 优先于默认', () => {
    process.env[DATA_ROOT_ENV] = '/tmp/env-root'
    const ctx = createToolContext()
    expect(ctx.dataRoot).toBe(resolve('/tmp/env-root'))
  })

  it('缺省回落默认 ~/.dsh-finance/data', () => {
    delete process.env[DATA_ROOT_ENV]
    const ctx = createToolContext()
    expect(ctx.dataRoot).toBe(join(base, 'data'))
  })
})