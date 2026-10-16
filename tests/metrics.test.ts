/**
 * domain/metrics.ts 单元测试。
 * 覆盖验收点 5：hitRate 口径、累计收益口径（cumReturnOnCapital）。
 */
import { describe, it, expect } from 'vitest'
import { hitRate, cumReturnOnCapital, isBelowThreshold } from '../src/domain/metrics.js'

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

describe('metrics.cumReturnOnCapital（验收口径 t100357 AC2：期末总资产 vs 期初总资产）', () => {
  it('期初资金为 0 → 返回 0（防除零）', () => {
    expect(
      cumReturnOnCapital({ finalQty: 0, finalPrice: 0, finalCash: 0, initialCapital: 0 }),
    ).toBe(0)
  })

  it('场景①期初有现金（initialCash>0）：现金 + 期末市值 − 期初资金', () => {
    // 自洽：期初资金 10000 = 初始现金 8000 + 初始持仓成本 1000×2.0(2000)；
    // 期间无成交 → 期末现金 8000；现价 2.2 → 期末市值 1000×2.2 = 2200。
    //   → (8000 + 2200 - 10000) / 10000 = 0.02
    const r = cumReturnOnCapital({
      finalQty: 1000,
      finalPrice: 2.2,
      finalCash: 8000,
      initialCapital: 10000,
    })
    expect(r).toBeCloseTo(0.02, 4)
  })

  it('场景②期间有卖出（realizedPnl≠0）：已实现盈亏经现金回笼计入', () => {
    // 自洽：init 1000@2.0 现金 50000（期初资金 52000）；卖出 500@3.0
    //   → 期末现金 50000 + 500×3.0 = 51500、期末持仓 500；现价 3.0 → 期末市值 1500。
    //   → (51500 + 1500 - 52000) / 52000 = 1000/52000 ≈ 0.0192
    const r = cumReturnOnCapital({
      finalQty: 500,
      finalPrice: 3.0,
      finalCash: 51500,
      initialCapital: 52000,
    })
    expect(r).toBeCloseTo(1000 / 52000, 4)
  })

  it('场景③已清仓（finalQty=0）：Issue #3 真实台账 → ≈ −0.0191（不再是 −1.0191）', () => {
    // 自洽台账：init 200@55.57；sell 100@53.05；buy 100@53.08；sell 200@49.76；
    // 期末 qty=0、期末现金 59949、期初资金 = 61114（50000 + 200×55.57）。
    //   → (59949 + 0 - 61114) / 61114 = -1165/61114 ≈ -0.0191
    const r = cumReturnOnCapital({
      finalQty: 0,
      finalPrice: 0,
      finalCash: 59949,
      initialCapital: 61114,
    })
    expect(r).toBeCloseTo(-0.0191, 4)
    expect(r).toBe(-0.0191) // round4(-1165/61114)
  })

  it('期末市值 = 持仓 qty × 现价（持仓价值计入分子）', () => {
    // 期末现金 8800，持仓 1000 现价 1.2 → 期末市值 1200；期初资金 10000
    //   → (8800 + 1200 - 10000) / 10000 = 0
    const r = cumReturnOnCapital({
      finalQty: 1000,
      finalPrice: 1.2,
      finalCash: 8800,
      initialCapital: 10000,
    })
    expect(r).toBeCloseTo(0, 4)
  })

  it('非法期初资金（NaN/Infinity）→ 返回 0', () => {
    expect(
      cumReturnOnCapital({ finalQty: 1, finalPrice: 1, finalCash: 0, initialCapital: NaN }),
    ).toBe(0)
    expect(
      cumReturnOnCapital({ finalQty: 1, finalPrice: 1, finalCash: 0, initialCapital: Infinity }),
    ).toBe(0)
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