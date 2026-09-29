/**
 * domain/predicts.ts 单元测试。
 * 覆盖：
 *   1. predict_make 落库 + 参数校验（date/dir/range/confidence）
 *   2. predict_verify 命中口径（方向/区间/偏差，边界：上破、下破、区间命中、震荡）
 *   3. predict_get 回读
 *   4. 按 symbol 隔离
 *   5. 日期边界（YYYY-MM-DD 校验）
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Predicts, computeHit } from '../src/domain/predicts.js'
import type { ActualitySnapshot } from '../src/domain/types.js'

let dir: string
let predicts: Predicts

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dsh-finance-predicts-'))
  predicts = new Predicts(dir)
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('predicts.predict_make', () => {
  it('落库并返回 prediction_id', () => {
    const r = predicts.predict_make('588000', '2026-09-29', {
      dir: 'up',
      rangeLow: 1.90,
      rangeHigh: 2.10,
      confidence: 0.8,
      watchPoints: ['突破前高'],
    })
    expect(r.ok).toBe(true)
    expect(r.predictionId).toMatch(/^p_/)

    const got = predicts.predict_get('588000', '2026-09-29')
    expect(got.prediction).toMatchObject({
      symbol: '588000',
      date: '2026-09-29',
      dir: 'up',
      rangeLow: 1.90,
      rangeHigh: 2.10,
      confidence: 0.8,
      watchPoints: ['突破前高'],
    })
  })

  it('同一 symbol+date 覆盖旧记录', () => {
    predicts.predict_make('588000', '2026-09-29', {
      dir: 'up',
      rangeLow: 1.90,
      rangeHigh: 2.10,
      confidence: 0.8,
      watchPoints: [],
    })
    predicts.predict_make('588000', '2026-09-29', {
      dir: 'down',
      rangeLow: 1.80,
      rangeHigh: 2.00,
      confidence: 0.5,
      watchPoints: ['跌破支撑'],
    })
    const got = predicts.predict_get('588000', '2026-09-29')
    expect(got.prediction?.dir).toBe('down')
    expect(got.prediction?.rangeLow).toBe(1.80)
  })

  it('非法 date 报错（日期边界）', () => {
    const r = predicts.predict_make('588000', '2026/09/29', {
      dir: 'up',
      rangeLow: 1.9,
      rangeHigh: 2.1,
      confidence: 0.8,
      watchPoints: [],
    })
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/date/)
  })

  it('非法 dir 报错', () => {
    const r = predicts.predict_make('588000', '2026-09-29', {
      dir: 'sideways' as never,
      rangeLow: 1.9,
      rangeHigh: 2.1,
      confidence: 0.8,
      watchPoints: [],
    })
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/dir/)
  })

  it('rangeLow > rangeHigh 报错', () => {
    const r = predicts.predict_make('588000', '2026-09-29', {
      dir: 'up',
      rangeLow: 2.1,
      rangeHigh: 1.9,
      confidence: 0.8,
      watchPoints: [],
    })
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/rangeLow/)
  })

  it('confidence 越界报错', () => {
    const r = predicts.predict_make('588000', '2026-09-29', {
      dir: 'up',
      rangeLow: 1.9,
      rangeHigh: 2.1,
      confidence: 1.5,
      watchPoints: [],
    })
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/confidence/)
  })
})

describe('computeHit（命中口径核心）', () => {
  const base: ActualitySnapshot = {
    close: 2.0,
    high: 2.2,
    low: 1.8,
    prevClose: 1.95,
  }

  it('方向命中 + 区间命中（close 在区间内且升）', () => {
    const r = computeHit('up', 1.90, 2.10, { ...base, close: 2.0, prevClose: 1.95 })
    expect(r.hitDir).toBe(true)
    expect(r.hitRange).toBe(true)
    expect(r.deviation).toBe(0)
  })

  it('方向命中 but 区间上破（deviation = close - high）', () => {
    const r = computeHit('up', 1.90, 2.10, { ...base, close: 2.3, prevClose: 1.95 })
    expect(r.hitDir).toBe(true) // 仍上涨
    expect(r.hitRange).toBe(false)
    expect(r.deviation).toBeCloseTo(0.2, 6) // 2.3 - 2.1
  })

  it('方向未命中 + 区间下破（deviation = low - close）', () => {
    const r = computeHit('up', 1.90, 2.10, { ...base, close: 1.85, prevClose: 1.95 })
    expect(r.hitDir).toBe(false) // 实际下跌
    expect(r.hitRange).toBe(false)
    expect(r.deviation).toBeCloseTo(0.05, 6) // 1.90 - 1.85
  })

  it('震荡（flat）命中边界：close == prevClose', () => {
    const r = computeHit('flat', 1.90, 2.10, { ...base, close: 1.95, prevClose: 1.95 })
    expect(r.hitDir).toBe(true)
    expect(r.hitRange).toBe(true)
    expect(r.deviation).toBe(0)
  })

  it('区间命中边界：close 恰等于 rangeLow', () => {
    const r = computeHit('up', 1.90, 2.10, { ...base, close: 1.90, prevClose: 1.85 })
    expect(r.hitRange).toBe(true)
    expect(r.deviation).toBe(0)
  })
})

describe('predicts.predict_verify', () => {
  beforeEach(() => {
    predicts.predict_make('588000', '2026-09-29', {
      dir: 'up',
      rangeLow: 1.90,
      rangeHigh: 2.10,
      confidence: 0.8,
      watchPoints: [],
    })
  })

  it('命中校验（注入实际快照）', () => {
    const r = predicts.predict_verify('588000', '2026-09-29', {
      close: 2.0,
      high: 2.2,
      low: 1.85,
      prevClose: 1.95,
    })
    expect(r.hitDir).toBe(true)
    expect(r.hitRange).toBe(true)
    expect(r.deviation).toBe(0)
  })

  it('无预判记录抛错', () => {
    expect(() => predicts.predict_verify('588000', '2026-09-30')).toThrow(/无预判/)
  })

  it('缺少 actual 快照抛错（口径守卫）', () => {
    expect(() => predicts.predict_verify('588000', '2026-09-29')).toThrow(/actual/)
  })
})

describe('predicts 按 symbol 隔离', () => {
  it('不同 symbol 记录互不可见', () => {
    predicts.predict_make('588000', '2026-09-29', {
      dir: 'up',
      rangeLow: 1.9,
      rangeHigh: 2.1,
      confidence: 0.8,
      watchPoints: [],
    })
    // 另一 symbol 无记录。
    expect(predicts.predict_get('000001', '2026-09-29').prediction).toBeNull()
    // symbol 空校验。
    const r = predicts.predict_make('', '2026-09-29', {
      dir: 'up',
      rangeLow: 1.9,
      rangeHigh: 2.1,
      confidence: 0.8,
      watchPoints: [],
    })
    expect(r.ok).toBe(false)
  })
})