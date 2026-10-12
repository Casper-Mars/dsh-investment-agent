/**
 * flags.test.ts —— `src/flags.ts` 环境变量解析 + 访问器单元测试。
 *
 * 覆盖验收标准：
 *   1. 设置 `DSH_FINANCE_HOME` → `getFinanceHome()` 返回 `resolve()` 后的绝对路径；
 *   2. 不设置 → 返回默认 `~/.dsh-finance`（绝对路径）；
 *   3. `DSH_FINANCE_SESSION_ID` 同理（设置 / 不设置）；
 *   4. 默认常量值与规格一致。
 *
 * 注意：访问器每次调用都实时读取 `process.env`，故用例间用 `beforeEach` /
 * `afterEach` 保存并恢复 `process.env.DSH_FINANCE_HOME` / `DSH_FINANCE_SESSION_ID`
 * 两个变量，避免污染其它测试。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { homedir } from 'node:os'
import { resolve } from 'node:path'
import {
  DEFAULT_FINANCE_HOME_NAME,
  DEFAULT_PINNED_SESSION_ID,
  FINANCE_HOME_ENV,
  FINANCE_SESSION_ID_ENV,
  getFinanceHome,
  getPinnedSessionId,
} from '../src/flags.js'

const SAVED_HOME = process.env[FINANCE_HOME_ENV]
const SAVED_SESSION = process.env[FINANCE_SESSION_ID_ENV]

beforeEach(() => {
  delete process.env[FINANCE_HOME_ENV]
  delete process.env[FINANCE_SESSION_ID_ENV]
})

afterEach(() => {
  if (SAVED_HOME === undefined) delete process.env[FINANCE_HOME_ENV]
  else process.env[FINANCE_HOME_ENV] = SAVED_HOME
  if (SAVED_SESSION === undefined) delete process.env[FINANCE_SESSION_ID_ENV]
  else process.env[FINANCE_SESSION_ID_ENV] = SAVED_SESSION
})

describe('环境变量名常量', () => {
  it('导出 FINANCE_HOME_ENV / FINANCE_SESSION_ID_ENV，值与规格一致', () => {
    expect(FINANCE_HOME_ENV).toBe('DSH_FINANCE_HOME')
    expect(FINANCE_SESSION_ID_ENV).toBe('DSH_FINANCE_SESSION_ID')
  })

  it('DEFAULT 常量值与规格一致', () => {
    expect(DEFAULT_PINNED_SESSION_ID).toBe('investment-advisor')
    expect(DEFAULT_FINANCE_HOME_NAME).toBe('.dsh-finance')
  })
})

describe('getFinanceHome（DSH_FINANCE_HOME）', () => {
  it('设置环境变量 → resolve 为绝对路径', () => {
    process.env[FINANCE_HOME_ENV] = '/tmp/foo'
    expect(getFinanceHome()).toBe(resolve('/tmp/foo'))
    expect(getFinanceHome().startsWith('/')).toBe(true)
  })

  it('相对路径环境变量 → resolve 为绝对路径', () => {
    process.env[FINANCE_HOME_ENV] = 'relative/dir'
    expect(getFinanceHome()).toBe(resolve('relative/dir'))
    expect(getFinanceHome().startsWith('/')).toBe(true)
  })

  it('环境变量带首尾空白 → trim 后 resolve', () => {
    process.env[FINANCE_HOME_ENV] = '  /tmp/foo  '
    expect(getFinanceHome()).toBe(resolve('/tmp/foo'))
  })

  it('环境变量为空串/纯空白 → 回落默认 ~/.dsh-finance', () => {
    process.env[FINANCE_HOME_ENV] = '   '
    expect(getFinanceHome()).toBe(resolve(homedir(), DEFAULT_FINANCE_HOME_NAME))
  })

  it('不设置 → 默认 ~/.dsh-finance（绝对路径）', () => {
    expect(getFinanceHome()).toBe(resolve(homedir(), DEFAULT_FINANCE_HOME_NAME))
    expect(getFinanceHome().startsWith('/')).toBe(true)
  })
})

describe('getPinnedSessionId（DSH_FINANCE_SESSION_ID）', () => {
  it('设置环境变量 → 返回覆盖值', () => {
    process.env[FINANCE_SESSION_ID_ENV] = 'bar'
    expect(getPinnedSessionId()).toBe('bar')
  })

  it('环境变量带首尾空白 → trim 后返回', () => {
    process.env[FINANCE_SESSION_ID_ENV] = '  bar  '
    expect(getPinnedSessionId()).toBe('bar')
  })

  it('环境变量为空串/纯空白 → 回落默认 investment-advisor', () => {
    process.env[FINANCE_SESSION_ID_ENV] = '   '
    expect(getPinnedSessionId()).toBe(DEFAULT_PINNED_SESSION_ID)
  })

  it('不设置 → 默认 investment-advisor', () => {
    expect(getPinnedSessionId()).toBe(DEFAULT_PINNED_SESSION_ID)
  })
})

describe('两个环境变量组合', () => {
  it('同时设置 → 两个 getter 均返回覆盖值', () => {
    process.env[FINANCE_HOME_ENV] = '/tmp/foo'
    process.env[FINANCE_SESSION_ID_ENV] = 'bar'
    expect(getFinanceHome()).toBe(resolve('/tmp/foo'))
    expect(getPinnedSessionId()).toBe('bar')
  })

  it('同时不设置 → 行为与现状完全一致', () => {
    expect(getFinanceHome()).toBe(resolve(homedir(), DEFAULT_FINANCE_HOME_NAME))
    expect(getPinnedSessionId()).toBe(DEFAULT_PINNED_SESSION_ID)
  })
})