/**
 * domain/sense-registry.ts 单元测试。
 * 覆盖验收点 6：版本不可变（patch 必须带 parent）、current 指针可 rollback。
 * 补充验收点 7：纯 TS 模块（由 typecheck/build 保证，不在此断言）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SenseRegistry } from '../src/domain/sense-registry.js'

let dir: string
let reg: SenseRegistry

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dsh-finance-sense-'))
  reg = new SenseRegistry(dir)
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function commitReplace(base: SenseRegistry, code = 'const x = 1', parent?: string) {
  return base.commit({
    changeType: 'replace',
    rationale: '初始版本',
    code,
    parent,
    trigger: 'init',
    by: 'test',
  })
}

describe('sense-registry.commit', () => {
  it('replace 生成 v001 且 current 指向 v001', () => {
    const v = commitReplace(reg)
    expect(v).toBe('v001')
    expect(reg.current()?.version).toBe('v001')
  })

  it('patch 必须带 parent，否则报错（验收点 6）', () => {
    expect(() =>
      reg.commit({ changeType: 'patch', rationale: 'x', code: 'x' }),
    ).toThrow(/parent/)
  })

  it('patch 带 parent 成功，且 current 更新', () => {
    const v1 = commitReplace(reg)
    const v2 = reg.commit({
      changeType: 'patch',
      rationale: '降低阈值',
      code: 'const x = 2',
      parent: v1,
    })
    expect(v2).toBe('v002')
    expect(reg.current()?.version).toBe('v002')
    expect(reg.read(v2).meta.parent).toBe('v001')
  })

  it('parent 不存在时报错', () => {
    expect(() =>
      reg.commit({
        changeType: 'patch',
        rationale: 'x',
        code: 'x',
        parent: 'v999',
      }),
    ).toThrow(/不存在/)
  })

  it('keep 复用 current 版本，不产生新版本', () => {
    const v1 = commitReplace(reg)
    const v = reg.commit({ changeType: 'keep', rationale: '', code: '' })
    expect(v).toBe(v1)
    expect(reg.list()).toHaveLength(1)
  })
})

describe('sense-registry list / current / read / rollback', () => {
  it('list 返回演化链（按版本号排序）', () => {
    commitReplace(reg)
    reg.commit({
      changeType: 'replace',
      rationale: 'v2',
      code: 'x2',
      parent: 'v001',
    })
    const list = reg.list()
    expect(list.map((m) => m.version)).toEqual(['v001', 'v002'])
  })

  it('read 返回完整全文（rationale + code + meta）', () => {
    const v = commitReplace(reg, 'const code = "abc"')
    const full = reg.read(v)
    expect(full.rationale).toBe('初始版本')
    expect(full.code).toBe('const code = "abc"')
    expect(full.meta.version).toBe(v)
  })

  it('当前无版本时 current 返回 null', () => {
    expect(reg.current()).toBeNull()
  })

  it('rollback 回指历史版本（验收点 6）', () => {
    const v1 = commitReplace(reg, 'code1')
    reg.commit({ changeType: 'replace', rationale: 'v2', code: 'code2', parent: v1 })
    expect(reg.current()?.version).toBe('v002')

    reg.rollback('v001')
    expect(reg.current()?.version).toBe('v001')
  })

  it('rollback 目标不存在时报错', () => {
    expect(() => reg.rollback('v999')).toThrow(/不存在/)
  })
})