/**
 * tester-independent-verify.test.ts —— Tester 独立运行时边界验证。
 *
 * 目的：不依赖 Developer 已写的 predicts/reviews 测试，用 Tester 自己的用例
 * 直接 import 源码，独立验证命中口径、缺 actual 抛错、重复落库覆盖、
 * symbol 隔离、复盘闭环、metrics 即时计算、retrospect、日期边界。
 *
 * 只新增测试文件，不改动 src/**。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Predicts, computeHit } from '../src/domain/predicts.js'
import { Reviews } from '../src/domain/reviews.js'
import { JsonStore } from '../src/domain/store.js'
import type { HitResult, Thresholds } from '../src/domain/types.js'

let dir: string
let predicts: Predicts
let reviews: Reviews

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dsh-ia-indep-'))
  predicts = new Predicts(dir)
  reviews = new Reviews(dir)
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('T1 命中口径（computeHit 独立验证，prevClose 基线 + 闭区间 + 非负偏差）', () => {
  it('dir=up, prevClose=10, close=11 → hitDir=true', () => {
    const r = computeHit('up', 10, 12, { close: 11, high: 11, low: 9, prevClose: 10 })
    expect(r.hitDir).toBe(true)
  })

  it('dir=up, prevClose=10, close=9 → hitDir=false', () => {
    const r = computeHit('up', 10, 12, { close: 9, high: 10, low: 8, prevClose: 10 })
    expect(r.hitDir).toBe(false)
  })

  it('rangeLow=10/rangeHigh=12, close=11 → hitRange=true, deviation=0', () => {
    const r = computeHit('up', 10, 12, { close: 11, high: 11, low: 9, prevClose: 10 })
    expect(r.hitRange).toBe(true)
    expect(r.deviation).toBe(0)
  })

  it('rangeLow=10/rangeHigh=12, close=13 → hitRange=false, deviation=1', () => {
    const r = computeHit('up', 10, 12, { close: 13, high: 13, low: 9, prevClose: 10 })
    expect(r.hitRange).toBe(false)
    expect(r.deviation).toBe(1)
  })

  it('rangeLow=10/rangeHigh=12, close=9 → hitRange=false, deviation=1（下破恒非负）', () => {
    const r = computeHit('up', 10, 12, { close: 9, high: 10, low: 8, prevClose: 10 })
    expect(r.hitRange).toBe(false)
    expect(r.deviation).toBe(1)
  })

  it('闭区间边界：close 恰等于 rangeHigh=12 → hitRange=true', () => {
    const r = computeHit('up', 10, 12, { close: 12, high: 12, low: 9, prevClose: 10 })
    expect(r.hitRange).toBe(true)
    expect(r.deviation).toBe(0)
  })

  it('震荡：prevClose==close → 实际方向 flat，与 dir=flat 匹配', () => {
    const r = computeHit('flat', 10, 12, { close: 10, high: 10, low: 9, prevClose: 10 })
    expect(r.hitDir).toBe(true)
  })
})

describe('T2 缺 actual 抛错（不静默）', () => {
  it('predict_verify 不传 actual → 抛错', () => {
    predicts.predict_make('588000', '2026-09-29', {
      dir: 'up', rangeLow: 10, rangeHigh: 12, confidence: 0.8, watchPoints: [],
    })
    expect(() => predicts.predict_verify('588000', '2026-09-29')).toThrow(/actual/)
  })

  it('predict_verify 传 actual 但无预判记录 → 抛错（并非静默）', () => {
    expect(() =>
      predicts.predict_verify('588000', '2026-09-30', { close: 11, high: 11, low: 9, prevClose: 10 }),
    ).toThrow()
  })
})

describe('T3 重复落库覆盖（predict_make 同 symbol+date 仅保留最新一条）', () => {
  it('同 symbol+date 两次 predict_make → 表中仅 1 条且为最新', () => {
    predicts.predict_make('588000', '2026-09-29', {
      dir: 'up', rangeLow: 10, rangeHigh: 12, confidence: 0.8, watchPoints: [],
    })
    predicts.predict_make('588000', '2026-09-29', {
      dir: 'down', rangeLow: 9, rangeHigh: 11, confidence: 0.5, watchPoints: ['修正'],
    })
    const got = predicts.predict_get('588000', '2026-09-29')
    expect(got.prediction).not.toBeNull()
    expect(got.prediction?.dir).toBe('down')
    expect(got.prediction?.watchPoints).toEqual(['修正'])
    // 通过 get 只能读到 1 条（无 list 接口，直接用 store 计数验证）。
    const store = new JsonStore(dir)
    const recs = store.readTable<Array<{ date: string }>>('588000', 'predictions') ?? []
    const sameDate = recs.filter((r) => r.date === '2026-09-29')
    expect(sameDate).toHaveLength(1)
  })
})

describe('T4 symbol 隔离（A 标的操作不影响 B 标的）', () => {
  it('对 A 落预判/复盘后，B 标的预判/复盘/统计均不可见', () => {
    // A 标的：预判 + verify + 复盘闭环。
    predicts.predict_make('588000', '2026-09-29', {
      dir: 'up', rangeLow: 10, rangeHigh: 12, confidence: 0.8, watchPoints: [],
    })
    const hit = predicts.predict_verify('588000', '2026-09-29', {
      close: 11, high: 11, low: 9, prevClose: 10,
    })
    const c = reviews.review_check('588000', '2026-09-29', {
      decisionTriggered: true, decisionExecuted: true, hit,
    })
    reviews.review_report('588000', '2026-09-29', c, { hit })

    // B 标的：预判为空、复盘为空、统计为 0。
    expect(predicts.predict_get('000001', '2026-09-29').prediction).toBeNull()
    expect(reviews.review_get('000001').reports).toEqual([])
    const m = reviews.review_metrics('000001')
    expect(m.dirHitRate).toBe(0)
    expect(m.rangeHitRate).toBe(0)
    expect(m.history).toEqual([])

    // A 标的统计不受 B 影响（仍基于 A 的命中）。
    const ma = reviews.review_metrics('588000')
    expect(ma.dirHitRate).toBe(1)
    expect(ma.rangeHitRate).toBe(1)
  })
})

describe('T5 复盘闭环（check 不落库 → report 落库返回 report_id → get 单日/全量）', () => {
  it('review_check 不落库（无副作用）', () => {
    reviews.review_check('588000', '2026-09-29', {
      decisionTriggered: true, decisionExecuted: true, hit: { hitDir: true, hitRange: true, deviation: 0 },
    })
    // check 后立即 get 应为空（check 不落库）。
    expect(reviews.review_get('588000').reports).toEqual([])
  })

  it('report 落库返回 report_id，get(date) 单日 / get() 全量', () => {
    const hit: HitResult = { hitDir: true, hitRange: false, deviation: 0.5 }
    const c28 = reviews.review_check('588000', '2026-09-28', {
      decisionTriggered: true, decisionExecuted: false, hit,
    })
    const r28 = reviews.review_report('588000', '2026-09-28', c28, { hit })
    expect(r28.ok).toBe(true)
    expect(r28.reportId).toMatch(/^rv_/)

    const c29 = reviews.review_check('588000', '2026-09-29', {
      decisionTriggered: false, decisionExecuted: false,
    })
    reviews.review_report('588000', '2026-09-29', c29)

    // 单日回读。
    const single = reviews.review_get('588000', '2026-09-29')
    expect(single.reports).toHaveLength(1)
    expect(single.reports[0].date).toBe('2026-09-29')

    // 全量回读（升序 2 条）。
    const all = reviews.review_get('588000')
    expect(all.reports.map((r) => r.date)).toEqual(['2026-09-28', '2026-09-29'])
  })
})

describe('T6 review_metrics 即时计算（无缓存时基于 reviews 命中字段）', () => {
  it('无 metrics 缓存时，基于 reviews 的 hitDir/hitRange 算两率', () => {
    const hit: HitResult = { hitDir: true, hitRange: true, deviation: 0 }
    const miss: HitResult = { hitDir: false, hitRange: false, deviation: 1 }

    const c1 = reviews.review_check('588000', '2026-09-26', { decisionTriggered: true, decisionExecuted: true, hit })
    reviews.review_report('588000', '2026-09-26', c1, { hit })
    const c2 = reviews.review_check('588000', '2026-09-27', { decisionTriggered: true, decisionExecuted: true, hit })
    reviews.review_report('588000', '2026-09-27', c2, { hit })
    const c3 = reviews.review_check('588000', '2026-09-28', { decisionTriggered: false, decisionExecuted: false, hit: miss })
    reviews.review_report('588000', '2026-09-28', c3, { hit: miss })

    const m = reviews.review_metrics('588000')
    expect(m.dirHitRate).toBeCloseTo(2 / 3, 4)
    expect(m.rangeHitRate).toBeCloseTo(2 / 3, 4)
    expect(m.history).toHaveLength(3)
    // 即时计算时 cum_return 缺省 0（domain 不主动算收益）。
    expect(m.cumReturn).toBe(0)
  })
})

describe('T7 review_retrospect（劣于阈值产根因；达标无需根因）', () => {
  const thr: Thresholds = { dirHitMin: 0.6, cumReturnMin: 0, missStreakMax: 3 }

  it('dirHitRate 低于 dirHitMin → root_cause 非空 + improvements 非空', () => {
    const r = reviews.review_retrospect('588000', thr, {
      dirHitRate: 0.3, rangeHitRate: 0.5, cumReturn: 0.05, history: [],
    })
    expect(r.rootCause).not.toBe('')
    expect(r.rootCause).toContain('方向命中率')
    expect(r.improvements.length).toBeGreaterThan(0)
  })

  it('均达标 → rootCause 含「无需根因定位」且 improvements 空', () => {
    const r = reviews.review_retrospect('588000', thr, {
      dirHitRate: 0.8, rangeHitRate: 0.7, cumReturn: 0.1, history: [],
    })
    expect(r.rootCause).toContain('无需根因定位')
    expect(r.improvements).toEqual([])
  })
})

describe('T8 日期边界（非 YYYY-MM-DD）', () => {
  it("predict_make date='2026-1-1' → 返回 error（不落库）", () => {
    const r = predicts.predict_make('588000', '2026-1-1', {
      dir: 'up', rangeLow: 10, rangeHigh: 12, confidence: 0.8, watchPoints: [],
    })
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/date/)
  })

  it("review_check date='2026-1-1' → 抛错", () => {
    expect(() =>
      reviews.review_check('588000', '2026-1-1', { decisionTriggered: false, decisionExecuted: false }),
    ).toThrow(/date/)
  })

  it("review_report date='2026-1-1' → 返回 error", () => {
    const r = reviews.review_report('588000', '2026-1-1', {
      decisionTriggered: false, decisionExecuted: false, notes: '',
    })
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/date/)
  })
})

describe('T9 纯 TS 不 import dsh/cordis（源码依赖守卫）', () => {
  it('predicts.ts / reviews.ts 无 dsh/cordis import', () => {
    const { readFileSync } = require('node:fs')
    for (const p of ['src/domain/predicts.ts', 'src/domain/reviews.ts']) {
      const src = readFileSync(join(process.cwd(), p), 'utf8')
      // 只检查真实 import 语句（不含注释/文档）。
      expect(src).not.toMatch(/import\s+[^'"]*['"][^'"]*(dsh|cordis)/)
    }
  })
})