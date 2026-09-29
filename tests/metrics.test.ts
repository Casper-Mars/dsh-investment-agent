/**
 * domain/metrics.ts 单元测试。
 * 覆盖验收点 5：hitRate 口径、cumReturn 基于流水累计。
 */
import { describe, it, expect } from 'vitest'
import { hitRate, cumReturn, isBelowThreshold } from '../src/domain/metrics.js'
import type { Trade } from '../src/domain/types.js'

describe('metrics.hitRate', () => {
  it('方向命中率 = 方向命中数 / 已校验数', () => {
    const r = hitRate([true, true, false, true], [true, false, false, true])
    expect(r.dir).toBe(0.75) // 3/4
    expect(r.range).toBe(0.5) // 2/4
  })

  it('空数组防除零（返回 0）', () => {
    const r = hitRate([], [])
    expect(r.dir).toBe(0)
    expect(r.range).toBe(0)
  })

  it('全命中返回 1', () => {
    const r = hitRate([true, true], [true, true])
    expect(r.dir).toBe(1)
    expect(r.range).toBe(1)
  })
})

describe('metrics.cumReturn', () => {
  it('空流水返回 0', () => {
    expect(cumReturn([])).toBe(0)
  })

  it('基于流水累计（买低卖高 → 正收益）', () => {
    const trades: Trade[] = [
      { id: '1', symbol: '588000', side: 'buy', qty: 1000, price: 2.0, ts: 1 },
      { id: '2', symbol: '588000', side: 'sell', qty: 500, price: 2.5, ts: 2 },
      { id: '3', symbol: '588000', side: 'sell', qty: 500, price: 3.0, ts: 3 },
    ]
    // 已实现收益 = 500*(2.5-2.0) + 500*(3.0-2.0) = 250 + 500 = 750
    // 累计买入成本 = 1000 * 2.0 = 2000
    // 收益率 = 750 / 2000 = 0.375
    expect(cumReturn(trades)).toBeCloseTo(0.375, 4)
  })

  it('买高卖低 → 负收益', () => {
    const trades: Trade[] = [
      { id: '1', symbol: '588000', side: 'buy', qty: 1000, price: 3.0, ts: 1 },
      { id: '2', symbol: '588000', side: 'sell', qty: 1000, price: 2.0, ts: 2 },
    ]
    // 已实现收益 = 1000*(2.0-3.0) = -1000；成本 3000 → -0.3333
    expect(cumReturn(trades)).toBeCloseTo(-0.3333, 4)
  })
})

describe('metrics.isBelowThreshold', () => {
  it('合法阈值返回 false', () => {
    expect(
      isBelowThreshold('588000', {
        dirHitMin: 0.6,
        cumReturnMin: 0,
        missStreakMax: 3,
      }),
    ).toBe(false)
  })

  it('非法阈值（下限为负）返回 true', () => {
    expect(
      isBelowThreshold('588000', {
        dirHitMin: -0.1,
        cumReturnMin: 0,
        missStreakMax: 3,
      }),
    ).toBe(true)
  })
})