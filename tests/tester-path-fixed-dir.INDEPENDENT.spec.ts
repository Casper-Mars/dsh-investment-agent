/**
 * tester-path-fixed-dir.INDEPENDENT.spec.ts
 * 独立验证：固定目录改造（paths.ts）—— 路径解析 + 目录自动创建 + 环境变量优先级。
 *
 * 隔离约束（task-04 起）：所有会落盘的用例一律 `DSH_IA_HOME=<mkdtemp>`，
 * **绝不创建或删除真实 `~/.dsh-ia`**。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import {
  FINANCE_HOME,
  resolveFinanceHomeDir,
  ensureFinanceHomeDir,
  resolveFinanceDataDir,
  ensureFinanceDataDir,
  resolveAssetsDir,
  resolveAssetsTasksDir,
  resolveAssetsProgramsDir,
  ensureAssetsTasksDir,
  ensureAssetsProgramsDir,
} from '../src/paths.js'
import { FINANCE_HOME_ENV } from '../src/flags.js'
import { createToolContext, DATA_ROOT_ENV } from '../src/tools/context.js'

const HOME = homedir()
const base = join(HOME, FINANCE_HOME)

describe('路径解析（固定目录锚定）', () => {
  it('resolveFinanceHomeDir = ~/.dsh-ia（绝对路径）', () => {
    expect(resolveFinanceHomeDir()).toBe(base)
    expect(resolveFinanceHomeDir().startsWith('/')).toBe(true)
    expect(resolveFinanceHomeDir()).not.toContain('~')
  })

  it('resolveFinanceDataDir = ~/.dsh-ia/data', () => {
    expect(resolveFinanceDataDir()).toBe(join(base, 'data'))
  })

  it('resolveAssetsDir = ~/.dsh-ia/assets', () => {
    expect(resolveAssetsDir()).toBe(join(base, 'assets'))
  })

  it('resolveAssetsTasksDir = ~/.dsh-ia/assets/tasks', () => {
    expect(resolveAssetsTasksDir()).toBe(join(base, 'assets', 'tasks'))
  })

  it('resolveAssetsProgramsDir = ~/.dsh-ia/assets/programs', () => {
    expect(resolveAssetsProgramsDir()).toBe(join(base, 'assets', 'programs'))
  })

  it('所有派生路径均为绝对路径且不含 .. 段', () => {
    for (const p of [
      resolveFinanceHomeDir(),
      resolveFinanceDataDir(),
      resolveAssetsDir(),
      resolveAssetsTasksDir(),
      resolveAssetsProgramsDir(),
    ]) {
      expect(p.startsWith('/')).toBe(true)
      expect(p).not.toContain('..')
    }
  })
})

describe('目录自动创建（幂等，tmp 隔离）', () => {
  const savedEnv = process.env[FINANCE_HOME_ENV]
  let tmpHome: string

  beforeAll(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'tester-path-fixed-'))
    process.env[FINANCE_HOME_ENV] = tmpHome
  })

  afterAll(() => {
    if (savedEnv === undefined) delete process.env[FINANCE_HOME_ENV]
    else process.env[FINANCE_HOME_ENV] = savedEnv
    if (tmpHome) rmSync(tmpHome, { recursive: true, force: true })
  })

  it('ensureFinanceHomeDir 创建目录并返回绝对路径', () => {
    const dir = ensureFinanceHomeDir()
    expect(dir).toBe(tmpHome)
    expect(existsSync(dir)).toBe(true)
  })

  it('ensureFinanceDataDir 递归创建 <home>/data', () => {
    const dir = ensureFinanceDataDir()
    expect(dir).toBe(join(tmpHome, 'data'))
    expect(existsSync(dir)).toBe(true)
  })

  it('ensureAssetsTasksDir / ensureAssetsProgramsDir 递归创建资产子目录', () => {
    expect(ensureAssetsTasksDir()).toBe(join(tmpHome, 'assets', 'tasks'))
    expect(ensureAssetsProgramsDir()).toBe(join(tmpHome, 'assets', 'programs'))
    expect(existsSync(join(tmpHome, 'assets', 'tasks'))).toBe(true)
    expect(existsSync(join(tmpHome, 'assets', 'programs'))).toBe(true)
  })

  it('ensure 幂等：重复调用不报错且结果一致', () => {
    expect(ensureFinanceHomeDir()).toBe(tmpHome)
    expect(ensureFinanceDataDir()).toBe(join(tmpHome, 'data'))
    expect(ensureAssetsTasksDir()).toBe(join(tmpHome, 'assets', 'tasks'))
    expect(ensureFinanceHomeDir()).toBe(tmpHome)
  })
})

describe('环境变量优先级（构造注入 > DSH_IA_DATA_DIR > 默认）', () => {
  const savedEnv = process.env[DATA_ROOT_ENV]
  const savedHome = process.env[FINANCE_HOME_ENV]
  const tmpHome = mkdtempSync(join(tmpdir(), 'tester-path-fixed-home-'))

  afterAll(() => {
    if (savedEnv === undefined) delete process.env[DATA_ROOT_ENV]
    else process.env[DATA_ROOT_ENV] = savedEnv
    if (savedHome === undefined) delete process.env[FINANCE_HOME_ENV]
    else process.env[FINANCE_HOME_ENV] = savedHome
    rmSync(tmpHome, { recursive: true, force: true })
  })

  it('构造注入 dataRoot 最高优先级', () => {
    process.env[DATA_ROOT_ENV] = '/tmp/should-be-overridden'
    const ctx = createToolContext({ dataRoot: '/tmp/injected-root' })
    expect(ctx.dataRoot).toBe(resolve('/tmp/injected-root'))
  })

  it('环境变量 DSH_IA_DATA_DIR 优先于默认', () => {
    process.env[DATA_ROOT_ENV] = '/tmp/env-root'
    const ctx = createToolContext()
    expect(ctx.dataRoot).toBe(resolve('/tmp/env-root'))
  })

  it('DSH_IA_DATA_DIR 未设置时回落 home 下 data（tmp 隔离）', () => {
    delete process.env[DATA_ROOT_ENV]
    process.env[FINANCE_HOME_ENV] = tmpHome
    const ctx = createToolContext()
    expect(ctx.dataRoot).toBe(join(tmpHome, 'data'))
  })
})
