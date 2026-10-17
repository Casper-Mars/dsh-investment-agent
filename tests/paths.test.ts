/**
 * paths.test.ts —— `src/paths.ts` 资产层根目录解析 + 幂等创建单元测试。
 *
 * 覆盖验收标准：
 *   1. `resolveAssetsDir()` 默认返回 `<homedir>/.dsh-ia/assets`（纯计算，无副作用）；
 *   2. 设置 `DSH_IA_HOME=<tmpdir>` 时返回 `<tmpdir>/assets`（继承 home 覆盖语义）；
 *   3. `ensureAssetsDir()` 创建目录；连续调用两次不抛错（幂等）。
 *
 * 隔离策略：创建类用例一律通过 `DSH_IA_HOME` 指向临时目录，不触碰真实
 * `~/.dsh-ia`；用例结束后恢复环境变量并递归清理临时目录。
 *
 * 注意：`resolveAssetsDir` 每次调用实时读取 `process.env`（经 `getFinanceHome()`），
 * 故无需模块重置，只需在用例间保存 / 恢复 `DSH_IA_HOME`。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { FINANCE_HOME_ENV } from '../src/flags.js'
import { FINANCE_HOME, ensureAssetsDir, resolveAssetsDir } from '../src/paths.js'

const SAVED_HOME = process.env[FINANCE_HOME_ENV]
const tmpDirs: string[] = []

function mkTmp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-assets-paths-'))
  tmpDirs.push(dir)
  return dir
}

beforeEach(() => {
  delete process.env[FINANCE_HOME_ENV]
})

afterEach(() => {
  if (SAVED_HOME === undefined) delete process.env[FINANCE_HOME_ENV]
  else process.env[FINANCE_HOME_ENV] = SAVED_HOME
  for (const dir of tmpDirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      /* 清理失败不影响断言结果 */
    }
  }
})

describe('resolveAssetsDir（纯计算，无副作用）', () => {
  it('默认返回 <homedir>/.dsh-ia/assets 绝对路径', () => {
    const dir = resolveAssetsDir()
    expect(dir).toBe(join(homedir(), FINANCE_HOME, 'assets'))
    expect(dir.startsWith('/')).toBe(true)
    expect(dir).not.toContain('~')
  })

  it('纯计算，无副作用：解析不创建 assets 目录', () => {
    const tmp = mkTmp()
    process.env[FINANCE_HOME_ENV] = tmp
    const dir = resolveAssetsDir()
    expect(dir).toBe(join(resolve(tmp), 'assets'))
    expect(existsSync(dir)).toBe(false)
  })

  it('设置 DSH_IA_HOME 时返回 <tmpdir>/assets', () => {
    const tmp = mkTmp()
    process.env[FINANCE_HOME_ENV] = tmp
    expect(resolveAssetsDir()).toBe(join(resolve(tmp), 'assets'))
    expect(resolveAssetsDir().startsWith(resolve(tmp))).toBe(true)
  })
})

describe('ensureAssetsDir（幂等创建）', () => {
  it('创建 <tmpdir>/assets 目录并返回绝对路径', () => {
    const tmp = mkTmp()
    process.env[FINANCE_HOME_ENV] = tmp
    const dir = ensureAssetsDir()
    expect(dir).toBe(join(resolve(tmp), 'assets'))
    expect(existsSync(dir)).toBe(true)
    expect(statSync(dir).isDirectory()).toBe(true)
  })

  it('连续调用两次不抛错，返回同一路径（已存在 no-op）', () => {
    const tmp = mkTmp()
    process.env[FINANCE_HOME_ENV] = tmp
    const first = ensureAssetsDir()
    expect(() => ensureAssetsDir()).not.toThrow()
    const second = ensureAssetsDir()
    expect(second).toBe(first)
    expect(existsSync(second)).toBe(true)
  })
})
