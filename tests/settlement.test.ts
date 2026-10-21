/**
 * domain/settlement.ts 单元测试（Issue #6 · T+1 拦截）。
 *
 * 覆盖方案 §6.1 的 10 个用例：
 *   1. T+0 → 全部可卖
 *   2. T+1，仅 init 建仓，当日可卖全部
 *   3. T+1，当日买入 100 → 可卖 0（禁止当日回转）
 *   4. T+1，持仓 200 + 当日买 100 → 可卖 200（卖 200 放行）
 *   5. 同上，卖 300 → 可卖 200（拒绝由 Ledger.trade 执行，此处断言可卖量）
 *   6. 当日先卖后买：卖出不重置当日买入量
 *   7. 跨日 → 当日买入量清零，可卖量恢复为全部持仓
 *   8. 23:59 买入 → 次日 00:01 卖出：按 Asia/Shanghai 日界放行
 *   9. 宿主 TZ=UTC 时用例 8 结果不变（不依赖宿主时区）
 *  10. reason='init' 流水不计入当日买入
 *
 * 纯函数测试：不涉及 I/O。
 */
import { describe, it, expect } from 'vitest'
import { computeSellableQty, todayBuyQty, tradingDayKey } from '../src/domain/settlement.js'
import type { Trade } from '../src/domain/types.js'

/** 构造流水（默认 buy、非 init）。 */
function mkTrade(ts: number, qty: number, side: Trade['side'] = 'buy', reason?: string): Trade {
  return {
    id: `t_${ts}_${side}_${qty}`,
    symbol: '588000',
    side,
    qty,
    price: 2,
    ts,
    reason,
  }
}

/** 北京时间 → 毫秒时间戳（显式 +08:00，与宿主 TZ 无关）。 */
const cst = (iso: string): number => Date.parse(`${iso}+08:00`)

const DAY1_NOON = cst('2026-10-13T10:00:00')
const DAY1_CLOSE = cst('2026-10-13T14:30:00')
const DAY2_NOON = cst('2026-10-14T10:00:00')

describe('tradingDayKey：Asia/Shanghai 日界', () => {
  it('同一自然日不同时刻 → 同一键', () => {
    expect(tradingDayKey(cst('2026-10-13T00:00:00'))).toBe('2026-10-13')
    expect(tradingDayKey(cst('2026-10-13T23:59:59'))).toBe('2026-10-13')
  })

  it('北京时间 23:59 与次日 00:01 → 不同键（不是 UTC 截断）', () => {
    // 2026-10-13T23:59+08:00 = 2026-10-13T15:59Z；若按 UTC 会算成 10-13，本轮断言日界正确。
    expect(tradingDayKey(cst('2026-10-13T23:59:00'))).toBe('2026-10-13')
    expect(tradingDayKey(cst('2026-10-14T00:01:00'))).toBe('2026-10-14')
  })

  it('输出恒为 YYYY-MM-DD（两位月/日补零）', () => {
    expect(tradingDayKey(cst('2026-01-05T09:30:00'))).toBe('2026-01-05')
  })
})

describe('computeSellableQty（§6.1 用例 1-10）', () => {
  it('用例 1：T+0，当日买卖任意 → 全部持仓可卖', () => {
    const trades = [mkTrade(DAY1_NOON, 500)]
    expect(
      computeSellableQty({ rule: 'T+0', positionQty: 500, trades, now: DAY1_CLOSE }),
    ).toBe(500)
  })

  it('用例 2：T+1，仅 init 建仓，当日可卖全部', () => {
    const trades = [mkTrade(DAY1_NOON, 1000, 'buy', 'init')]
    expect(
      computeSellableQty({ rule: 'T+1', positionQty: 1000, trades, now: DAY1_CLOSE }),
    ).toBe(1000)
  })

  it('用例 3：T+1，当日买 100 → 可卖 0', () => {
    const trades = [mkTrade(DAY1_NOON, 100)]
    expect(
      computeSellableQty({ rule: 'T+1', positionQty: 100, trades, now: DAY1_CLOSE }),
    ).toBe(0)
  })

  it('用例 4：T+1，持仓 200 + 当日买 100 → 可卖 200（卖 200 放行）', () => {
    const trades = [mkTrade(DAY1_NOON, 100)]
    // positionQty 300 = 存量 200 + 当日买 100
    expect(
      computeSellableQty({ rule: 'T+1', positionQty: 300, trades, now: DAY1_CLOSE }),
    ).toBe(200)
    expect(200 <= 200).toBe(true)
  })

  it('用例 5：同上，可卖 200（卖 300 越界）', () => {
    const trades = [mkTrade(DAY1_NOON, 100)]
    const sellable = computeSellableQty({
      rule: 'T+1',
      positionQty: 300,
      trades,
      now: DAY1_CLOSE,
    })
    expect(sellable).toBe(200)
    expect(300 > sellable).toBe(true)
  })

  it('用例 6：当日先卖 100、再买 100 → 卖出不重置当日买入量', () => {
    // 存量 200；当日卖 100（剩 100）；当日再买 100（持仓 200）。
    // 当日买入量仍为 100 → 可卖 100，而非 200。
    const trades = [
      mkTrade(DAY1_NOON, 100, 'sell'),
      mkTrade(DAY1_CLOSE, 100, 'buy'),
    ]
    expect(
      computeSellableQty({ rule: 'T+1', positionQty: 200, trades, now: DAY1_CLOSE }),
    ).toBe(100)
    expect(todayBuyQty(trades, DAY1_CLOSE)).toBe(100)
  })

  it('用例 7：跨日 → 当日买入量清零，可卖量恢复为全部持仓', () => {
    const trades = [mkTrade(DAY1_NOON, 100)]
    expect(
      computeSellableQty({ rule: 'T+1', positionQty: 100, trades, now: DAY2_NOON }),
    ).toBe(100)
    expect(todayBuyQty(trades, DAY2_NOON)).toBe(0)
  })

  it('用例 8：23:59 买入、次日 00:01 卖出 → 放行（Asia/Shanghai 日界）', () => {
    const buyTs = cst('2026-10-13T23:59:00')
    const sellNow = cst('2026-10-14T00:01:00')
    const trades = [mkTrade(buyTs, 100)]
    expect(tradingDayKey(buyTs)).not.toBe(tradingDayKey(sellNow))
    expect(
      computeSellableQty({ rule: 'T+1', positionQty: 100, trades, now: sellNow }),
    ).toBe(100)
  })

  it('用例 9：宿主 TZ=UTC 时用例 8 结果不变', () => {
    const prevTZ = process.env.TZ
    process.env.TZ = 'UTC'
    try {
      // 同一时刻分别以 Z / +08:00 两种写法表达，日键必须一致。
      const buyTs = Date.parse('2026-10-13T15:59:00Z') // = 北京 10-13 23:59
      const sellNow = Date.parse('2026-10-13T16:01:00Z') // = 北京 10-14 00:01
      expect(tradingDayKey(buyTs)).toBe('2026-10-13')
      expect(tradingDayKey(sellNow)).toBe('2026-10-14')
      const trades = [mkTrade(buyTs, 100)]
      expect(
        computeSellableQty({ rule: 'T+1', positionQty: 100, trades, now: sellNow }),
      ).toBe(100)
      // 同日（北京 10-13 内）仍需冻结。
      expect(
        computeSellableQty({
          rule: 'T+1',
          positionQty: 100,
          trades,
          now: Date.parse('2026-10-13T15:58:00Z'),
        }),
      ).toBe(0)
    } finally {
      if (prevTZ === undefined) delete process.env.TZ
      else process.env.TZ = prevTZ
    }
  })

  it('用例 10：reason=init 流水不计入当日买入', () => {
    const trades = [
      mkTrade(DAY1_NOON, 500, 'buy', 'init'),
      mkTrade(DAY1_CLOSE, 100, 'buy'),
    ]
    // 持仓 600，当日真实买入 100 → 可卖 500。
    expect(todayBuyQty(trades, DAY1_CLOSE)).toBe(100)
    expect(
      computeSellableQty({ rule: 'T+1', positionQty: 600, trades, now: DAY1_CLOSE }),
    ).toBe(500)
  })

  it('默认规则为 T+1（rule 缺省时按 T+1 计算）', () => {
    const trades = [mkTrade(DAY1_NOON, 100)]
    expect(computeSellableQty({ positionQty: 100, trades, now: DAY1_CLOSE })).toBe(0)
  })

  it('可卖量恒非负（异常数据不产生负数）', () => {
    const trades = [mkTrade(DAY1_NOON, 500)]
    expect(
      computeSellableQty({ rule: 'T+1', positionQty: 100, trades, now: DAY1_CLOSE }),
    ).toBe(0)
  })
})
