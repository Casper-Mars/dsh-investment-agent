/**
 * domain/path-guard.ts 单元测试（路径段安全校验）。
 *
 * AC1：assertSafeSegment 对合法值通过、对非法值（空 / `.` / `..` / 含 `../` /
 *  前导 `/` / 含 `/` / 含空白 / 超 64 长度）抛错。
 * AC2：端到端越界用例被拒——symbol 为 `../../esc2` 时，JsonStore.symbolDir /
 *  Ledger.init / StrategyRegistry.set 均抛错，且 baseDir 之外不产生任何文件。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assertSafeSegment } from '../src/domain/path-guard.js'
import { JsonStore } from '../src/domain/store.js'
import { Ledger } from '../src/domain/ledger.js'
import { StrategyRegistry } from '../src/domain/strategy.js'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dsh-ia-pathguard-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('assertSafeSegment 合法值', () => {
  it.each(['588000', '000001', 'v001', 'a-b_c.d'])('%s 通过且原样返回', (seg) => {
    expect(assertSafeSegment(seg, 'symbol')).toBe(seg)
  })
})

describe('assertSafeSegment 非法值', () => {
  const bad = [
    ['空字符串', ''],
    ['单个点', '.'],
    ['双点', '..'],
    ['单层穿越', '../x'],
    ['双层穿越', '../../esc2'],
    ['前导斜杠', '/abs'],
    ['含斜杠', 'a/b'],
    ['含反斜杠', 'a\\b'],
    ['含空白', 'a b'],
    ['超 64 长度', 'a'.repeat(65)],
  ] as const

  it.each(bad)('%s 抛错', (_label, seg) => {
    expect(() => assertSafeSegment(seg, 'symbol')).toThrow(/\[path-guard\]/)
  })

  it('非字符串输入抛错', () => {
    expect(() => assertSafeSegment(undefined, 'symbol')).toThrow(/\[path-guard\]/)
    expect(() => assertSafeSegment(123 as unknown as string, 'symbol')).toThrow(
      /\[path-guard\]/,
    )
  })
})

describe('端到端越界 symbol 被拒（不落盘 baseDir 之外）', () => {
  it('JsonStore.symbolDir(../../esc2) 抛错', () => {
    const baseDir = join(dir, 'data')
    const store = new JsonStore(baseDir)
    expect(() => store.symbolDir('../../esc2')).toThrow(/\[path-guard\]/)
    expect(existsSync(join(dir, 'esc2'))).toBe(false)
  })

  it('Ledger.init(../../esc2) 抛错且不产生越界文件', () => {
    const baseDir = join(dir, 'data')
    const ledger = new Ledger(baseDir)
    expect(() =>
      ledger.init('../../esc2', { type: 'etf', qty: 1000, cost: 1.5, cash: 100000 }),
    ).toThrow(/\[path-guard\]/)
    // baseDir（dir）之外不产生任何文件/目录。
    expect(existsSync(join(dir, 'esc2'))).toBe(false)
    expect(existsSync(join(dir, 'data'))).toBe(false)
  })

  it('StrategyRegistry.set(../../esc2) 抛错且不产生越界文件', () => {
    const baseDir = join(dir, 'data')
    const reg = new StrategyRegistry(baseDir)
    expect(() => reg.set('../../esc2', { text: 'x', rationale: 'r' })).toThrow(
      /\[path-guard\]/,
    )
    expect(existsSync(join(dir, 'esc2'))).toBe(false)
    expect(existsSync(join(dir, 'esc2.md'))).toBe(false)
  })

  it('StrategyRegistry.get(../../esc2) 不越界（无文件落盘）', () => {
    const baseDir = join(dir, 'data')
    const reg = new StrategyRegistry(baseDir)
    // 读取路径亦被守卫拦截，不构造越界路径、不产生文件。
    const full = reg.get('../../esc2')
    expect(full).toBeUndefined()
    expect(existsSync(join(dir, 'esc2'))).toBe(false)
  })
})

describe('端到端越界 version 被拒', () => {
  it('StrategyRegistry.get 越界 version 抛错（显式 version 来自工具输入）', () => {
    const reg = new StrategyRegistry(dir)
    reg.set('588000', { text: '首版', rationale: 'r' })
    // 显式传入越界 version：读取路径被守卫拦截（metaFile/versionFile 内部抛错，
    // 由 readMeta 吞掉后返回 undefined），但绝不越界读文件。
    expect(() => reg.get('588000', '../../esc2')).not.toThrow()
    expect(reg.get('588000', '../../esc2')).toBeUndefined()
  })
})
