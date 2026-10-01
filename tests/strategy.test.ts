/**
 * domain/strategy.ts 单元测试（Task-17）。
 * 覆盖验收标准 AC1：首版 v001 / 追加 v002（parent=v001）/ get 旧版 /
 * 未设定 get 返回 undefined / 重复写同版本被拒 / 当前版与版本文件内容一致
 * + current 指针正确。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { StrategyRegistry } from '../src/domain/strategy.js'

let dir: string
let reg: StrategyRegistry

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dsh-finance-strategy-'))
  reg = new StrategyRegistry(dir)
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('strategy-registry.set', () => {
  it('首版生成 v001，current 指向 v001', () => {
    const v = reg.set('588000', { text: '首版', rationale: '初始策略', by: 'test' })
    expect(v).toBe('v001')
    expect(reg.current('588000')).toBe('v001')
  })

  it('追加 v002，meta.parent === v001', () => {
    reg.set('588000', { text: '首版', rationale: 'r1' })
    const v2 = reg.set('588000', {
      text: '二版',
      rationale: 'r2',
      parentVersion: 'v001',
    })
    expect(v2).toBe('v002')
    const full = reg.get('588000')
    expect(full?.meta.parent).toBe('v001')
    expect(full?.version).toBe('v002')
  })

  it('非首版不带 parentVersion 报错', () => {
    reg.set('588000', { text: '首版', rationale: 'r1' })
    expect(() => reg.set('588000', { text: '二版', rationale: 'r2' })).toThrow(
      /parentVersion/,
    )
  })

  it('首版带上 parentVersion 报错（当前无版本）', () => {
    expect(() =>
      reg.set('588000', { text: 'x', rationale: 'r', parentVersion: 'v001' }),
    ).toThrow(/不一致|parentVersion/)
  })

  it('parentVersion 与当前版不一致报错', () => {
    reg.set('588000', { text: '首版', rationale: 'r1' })
    reg.set('588000', {
      text: '二版',
      rationale: 'r2',
      parentVersion: 'v001',
    })
    // 当前已是 v002，却声明 parent=v001
    expect(() =>
      reg.set('588000', { text: '三版', rationale: 'r3', parentVersion: 'v001' }),
    ).toThrow(/不一致/)
  })

  it('版本不可变：历史版本内容不被覆盖', () => {
    reg.set('588000', { text: '首版', rationale: 'r1' })
    reg.set('588000', { text: '二版', rationale: 'r2', parentVersion: 'v001' })
    // 再次写新版本，历史 v001 的内容与 meta 保持原样（不可变）。
    reg.set('588000', { text: '三版', rationale: 'r3', parentVersion: 'v002' })
    const v1 = reg.get('588000', 'v001')
    expect(v1?.text).toBe('首版')
    expect(v1?.meta.rationale).toBe('r1')
    expect(reg.list('588000').map((m) => m.version)).toEqual([
      'v001',
      'v002',
      'v003',
    ])
  })
})

describe('strategy-registry.get', () => {
  it('get 读旧版 v001', () => {
    reg.set('588000', { text: '首版内容', rationale: 'r1' })
    reg.set('588000', {
      text: '二版内容',
      rationale: 'r2',
      parentVersion: 'v001',
    })
    const old = reg.get('588000', 'v001')
    expect(old?.text).toBe('首版内容')
    expect(old?.version).toBe('v001')
    expect(old?.symbol).toBe('588000')
  })

  it('未设定时 get 返回 undefined', () => {
    expect(reg.get('588000')).toBeUndefined()
  })
})

describe('strategy-registry 存储布局一致性', () => {
  it('strategy/<symbol>.md 与当前版 vNNN.md 内容一致 + current 指针正确', () => {
    reg.set('588000', { text: '策略正文 A', rationale: 'r1' })
    reg.set('588000', {
      text: '策略正文 B',
      rationale: 'r2',
      parentVersion: 'v001',
    })

    const curDoc = readFileSync(
      join(dir, 'strategy', '588000.md'),
      'utf8',
    )
    const v2Doc = readFileSync(
      join(dir, 'strategy_versions', '588000', 'v002.md'),
      'utf8',
    )
    const v1Doc = readFileSync(
      join(dir, 'strategy_versions', '588000', 'v001.md'),
      'utf8',
    )
    const pointer = readFileSync(
      join(dir, 'strategy_versions', '588000', 'current'),
      'utf8',
    ).trim()

    // 当前版内容与 v002 一致，且等于「策略正文 B」。
    expect(curDoc).toBe('策略正文 B')
    expect(v2Doc).toBe('策略正文 B')
    expect(v1Doc).toBe('策略正文 A')
    // current 指针指向 v002。
    expect(pointer).toBe('v002')
  })

  it('list 返回版本链（按版本号排序）', () => {
    reg.set('588000', { text: 'a', rationale: 'r1' })
    reg.set('588000', { text: 'b', rationale: 'r2', parentVersion: 'v001' })
    const list = reg.list('588000')
    expect(list.map((m) => m.version)).toEqual(['v001', 'v002'])
    expect(list[1].parent).toBe('v001')
  })
})
