/**
 * domain/reviews.ts 单元测试。
 * 覆盖：
 *   1. review_check 决策触发/执行 + notes 组装
 *   2. review_report 落库，review_get 单日/全量回读
 *   3. review_metrics 即时计算命中率 + 缓存回读
 *   4. review_retrospect 根因定位（劣于/未劣于阈值）
 *   5. 按 symbol 隔离 + 日期边界
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Reviews } from '../src/domain/reviews.js'
import { Ledger } from '../src/domain/ledger.js'
import type { HitResult, Thresholds } from '../src/domain/types.js'

let dir: string
let reviews: Reviews

const HIT: HitResult = { hitDir: true, hitRange: true, deviation: 0 }
const MISS: HitResult = { hitDir: false, hitRange: false, deviation: 0.2 }

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dsh-ia-reviews-'))
  reviews = new Reviews(dir)
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('reviews.review_check', () => {
  it('决策触发+执行，命中，notes 组装完整', () => {
    const r = reviews.review_check('588000', '2026-09-29', {
      decisionTriggered: true,
      decisionExecuted: true,
      hit: HIT,
    })
    expect(r.decisionTriggered).toBe(true)
    expect(r.decisionExecuted).toBe(true)
    expect(r.notes).toContain('决策已触发')
    expect(r.notes).toContain('方向命中')
  })

  it('决策未触发，无命中，notes 反映未触发', () => {
    const r = reviews.review_check('588000', '2026-09-29', {
      decisionTriggered: false,
      decisionExecuted: false,
    })
    expect(r.decisionTriggered).toBe(false)
    expect(r.notes).toContain('未触发')
  })

  it('非法 date 抛错（日期边界）', () => {
    expect(() =>
      reviews.review_check('588000', 'bad-date', { decisionTriggered: false, decisionExecuted: false }),
    ).toThrow(/date/)
  })
})

describe('reviews.review_report + review_get', () => {
  it('落库并回读单日/全量', () => {
    const c1 = reviews.review_check('588000', '2026-09-28', {
      decisionTriggered: true,
      decisionExecuted: true,
      hit: HIT,
    })
    const r1 = reviews.review_report('588000', '2026-09-28', c1, { hit: HIT })
    expect(r1.ok).toBe(true)
    expect(r1.reportId).toMatch(/^rv_/)

    const c2 = reviews.review_check('588000', '2026-09-29', {
      decisionTriggered: false,
      decisionExecuted: false,
      hit: MISS,
    })
    reviews.review_report('588000', '2026-09-29', c2, { hit: MISS })

    // 单日回读。
    const single = reviews.review_get('588000', '2026-09-28')
    expect(single.reports).toHaveLength(1)
    expect(single.reports[0].date).toBe('2026-09-28')
    expect(single.reports[0].report).toContain('复盘报告')

    // 全量回读（2 条，按 date 升序）。
    const all = reviews.review_get('588000')
    expect(all.reports).toHaveLength(2)
    expect(all.reports[0].date).toBe('2026-09-28')
    expect(all.reports[1].date).toBe('2026-09-29')
  })

  it('同一 symbol+date 覆盖', () => {
    const c = reviews.review_check('588000', '2026-09-29', {
      decisionTriggered: true,
      decisionExecuted: true,
    })
    reviews.review_report('588000', '2026-09-29', c)
    reviews.review_report('588000', '2026-09-29', c, { summary: '覆盖版' })
    const got = reviews.review_get('588000', '2026-09-29')
    expect(got.reports).toHaveLength(1)
    expect(got.reports[0].summary).toBe('覆盖版')
  })

  it('symbol 空报错', () => {
    const r = reviews.review_report('', '2026-09-29', {
      decisionTriggered: false,
      decisionExecuted: false,
      notes: '',
    })
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/symbol/)
  })
})

describe('reviews.review_metrics', () => {
  it('无复盘记录返回 0 命中率', () => {
    const m = reviews.review_metrics('588000')
    expect(m.dirHitRate).toBe(0)
    expect(m.rangeHitRate).toBe(0)
    expect(m.history).toEqual([])
  })

  it('基于 reviews 即时计算命中率', () => {
    // 3 次复盘：方向命中 2/3，区间命中 2/3（HIT 两次均方向+区间命中，MISS 一次均未命）。
    const c1 = reviews.review_check('588000', '2026-09-26', {
      decisionTriggered: true, decisionExecuted: true, hit: HIT,
    })
    reviews.review_report('588000', '2026-09-26', c1, { hit: HIT })
    const c2 = reviews.review_check('588000', '2026-09-27', {
      decisionTriggered: true, decisionExecuted: false, hit: HIT,
    })
    reviews.review_report('588000', '2026-09-27', c2, { hit: HIT })
    const c3 = reviews.review_check('588000', '2026-09-28', {
      decisionTriggered: false, decisionExecuted: false, hit: MISS,
    })
    reviews.review_report('588000', '2026-09-28', c3, { hit: MISS })

    const m = reviews.review_metrics('588000')
    expect(m.dirHitRate).toBeCloseTo(2 / 3, 4)
    expect(m.rangeHitRate).toBeCloseTo(2 / 3, 4)
    expect(m.history).toHaveLength(3)
    // 即时计算路径（无 metrics 缓存）下逐日 history 的 cumReturn 恒为 0，
    // 属语义澄清（需逐日重放流水才有真实逐日累计收益），并非当日真实亏损；
    // 真实累计收益仅体现在顶层 m.cumReturn。
    expect(m.history.every((h) => h.cumReturn === 0)).toBe(true)
  })

  it('方向与区间命中可不同（各自独立统计）', () => {
    // 方向命中、区间未命中的情形，验证两率独立。
    const dirOnly: HitResult = { hitDir: true, hitRange: false, deviation: 0.15 }
    const c = reviews.review_check('588000', '2026-09-26', {
      decisionTriggered: true, decisionExecuted: true, hit: dirOnly,
    })
    reviews.review_report('588000', '2026-09-26', c, { hit: dirOnly })
    const m = reviews.review_metrics('588000')
    expect(m.dirHitRate).toBe(1)
    expect(m.rangeHitRate).toBe(0)
  })

  it('record_metrics 后缓存回读', () => {
    reviews.record_metrics('588000', {
      date: '2026-09-29',
      dirHitRate: 0.75,
      rangeHitRate: 0.5,
      cumReturn: 0.12,
    })
    const m = reviews.review_metrics('588000')
    expect(m.dirHitRate).toBe(0.75)
    expect(m.rangeHitRate).toBe(0.5)
    expect(m.cumReturn).toBe(0.12)
  })
})

describe('reviews.review_retrospect', () => {
  const okThreshold: Thresholds = { dirHitMin: 0.6, cumReturnMin: 0, missStreakMax: 3 }

  it('未劣于阈值 → 无需根因定位', () => {
    const r = reviews.review_retrospect('588000', okThreshold, {
      dirHitRate: 0.8,
      rangeHitRate: 0.7,
      cumReturn: 0.1,
      history: [],
    })
    expect(r.rootCause).toContain('未劣于')
    expect(r.improvements).toEqual([])
  })

  it('劣于阈值 → 根因归因 + 改进建议', () => {
    const r = reviews.review_retrospect('588000', okThreshold, {
      dirHitRate: 0.3,
      rangeHitRate: 0.5,
      cumReturn: -0.2,
      history: [],
    })
    expect(r.rootCause).toContain('方向命中率')
    expect(r.rootCause).toContain('累计收益')
    expect(r.improvements.length).toBeGreaterThan(0)
  })

  it('仅方向命中率劣于阈值 → 仅归因方向', () => {
    const r = reviews.review_retrospect('588000', okThreshold, {
      dirHitRate: 0.3,
      rangeHitRate: 0.7,
      cumReturn: 0.05,
      history: [],
    })
    expect(r.rootCause).toContain('方向命中率')
    expect(r.rootCause).not.toContain('累计收益')
  })

  it('阈值非法 → 守卫触发，提示核对阈值', () => {
    const bad: Thresholds = { dirHitMin: -0.1, cumReturnMin: 0, missStreakMax: 3 }
    const r = reviews.review_retrospect('588000', bad)
    expect(r.rootCause).toContain('劣于阈值')
    expect(r.improvements.some((i) => i.includes('阈值'))).toBe(true)
  })
})

describe('reviews 按 symbol 隔离', () => {
  it('不同 symbol 复盘互不可见', () => {
    const c = reviews.review_check('588000', '2026-09-29', {
      decisionTriggered: true, decisionExecuted: true, hit: HIT,
    })
    reviews.review_report('588000', '2026-09-29', c, { hit: HIT })
    expect(reviews.review_get('000001').reports).toEqual([])
  })
})

describe('reviews.review_metrics cum_return 接线（验收口径 t100357 AC2）', () => {
  it('无 ledger 注入时 cum_return 回落 0（向后兼容）', () => {
    // reviews 未接 ledger，应保持 cum_return=0。
    const solo = new Reviews(dir)
    const m = solo.review_metrics('588000')
    expect(m.cumReturn).toBe(0)
  })

  it('接 ledger 后，基于流水+持仓+现价计算非零 cum_return', () => {
    const ledger = new Ledger(dir)
    ledger.init('588000', { type: 'etf', name: 'T', qty: 1000, cost: 2.0, cash: 50000 })
    const wired = new Reviews(dir, ledger)

    // 现价 3.0：期末现金 50000（期间无成交），期末市值 = 1000×3.0 = 3000；
    // 期初资金 = 50000 + 1000×2.0 = 52000 → cum_return = (50000 + 3000 - 52000) / 52000 = 1000/52000
    const m = wired.review_metrics('588000', 3.0)
    expect(m.cumReturn).toBeCloseTo(1000 / 52000, 4)
  })

  it('买入后被评估：缺省现价用最近一笔成交价', () => {
    const ledger = new Ledger(dir)
    ledger.init('588000', { type: 'etf', name: 'T', qty: 1000, cost: 2.0, cash: 50000 })
    ledger.trade('588000', { side: 'buy', qty: 500, price: 2.5 })
    const wired = new Reviews(dir, ledger)

    // 最近一笔成交价 = 2.5，期末持仓 1500；期末现金 = 50000 - 500×2.5 = 48750；
    // 期初资金 = 50000 + 1000×2.0 = 52000；期末市值 = 1500×2.5 = 3750；
    // → (48750 + 3750 - 52000) / 52000 = 500/52000
    const m = wired.review_metrics('588000')
    expect(m.cumReturn).toBeCloseTo(500 / 52000, 4)
  })

  it('已实现盈亏计入：卖出后 realized 参与分子', () => {
    const ledger = new Ledger(dir)
    ledger.init('588000', { type: 'etf', name: 'T', qty: 1000, cost: 2.0, cash: 50000 })
    // 卖出 500 @ 3.0，realized = (3.0-2.0)*500 = 500
    ledger.trade('588000', { side: 'sell', qty: 500, price: 3.0 })
    const wired = new Reviews(dir, ledger)

    // 现价 3.0，期末持仓 500，期末现金 = 50000 + 500×3.0 = 51500；期末市值 = 1500；
    // 期初资金 = 52000（realized 经现金回笼已计入期末现金）
    // → cum_return = (51500 + 1500 - 52000) / 52000 = 1000/52000
    const m = wired.review_metrics('588000', 3.0)
    expect(m.cumReturn).toBeCloseTo(1000 / 52000, 4)
  })

  it('标的未初始化时不会抛错，cum_return 回落 0', () => {
    const ledger = new Ledger(dir)
    const wired = new Reviews(dir, ledger)
    const m = wired.review_metrics('999999')
    expect(m.cumReturn).toBe(0)
  })

  it('Issue #3 真实台账复现：已清仓账户真实 −1.91%，而非 −101.91%', () => {
    // 台账：init 200@55.57（现金 50000）；sell 100@53.05；buy 100@53.08；sell 200@49.76。
    // 期末 qty=0、期末现金 59949、期初资金 = 50000 + 200×55.57 = 61114。
    // 旧口径（分子缺期未现金）会算成 (0 - 61114)/61114 = -1.0191（~−101.91%）；
    // 新口径：(59949 + 0 - 61114)/61114 = -1165/61114 ≈ -0.0191（−1.91%）。
    //
    // 该重建序列是「多日」账本：用可推进时钟跨日，避免被 A 股 T+1 拦截（Issue #6）。
    let clock = Date.parse('2026-10-13T10:00:00+08:00')
    const DAY = 24 * 60 * 60 * 1000
    const ledger = new Ledger(dir, () => clock)
    ledger.init('002156', { type: 'stock', name: 'T', qty: 200, cost: 55.57, cash: 50000 })
    ledger.trade('002156', { side: 'sell', qty: 100, price: 53.05 })
    clock += DAY
    ledger.trade('002156', { side: 'buy', qty: 100, price: 53.08 })
    clock += DAY
    ledger.trade('002156', { side: 'sell', qty: 200, price: 49.76 })
    const wired = new Reviews(dir, ledger)
    const m = wired.review_metrics('002156')
    expect(m.cumReturn).toBe(-0.0191)
    expect(m.cumReturn).not.toBeCloseTo(-1.0191, 2)
  })
})