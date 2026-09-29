/**
 * lib/trading-calendar.ts 单元测试。
 * 覆盖验收点 4：
 *   - isTradingDay 正确判定周末 + 法定节假日
 *   - nextTradingDay 正确顺延
 *   - 节假日源失败时降级为纯周末判定（不抛异常）
 */
import { describe, it, expect } from 'vitest'
import type { HolidayProvider } from '../src/lib/trading-calendar.js'
import { TradingCalendar, isWeekend, dateKey } from '../src/lib/trading-calendar.js'

/** 2026-09 无实际法定节假日，构造一个注入 mock 的节假日源。 */
function holidayProvider(
  extra: Record<string, true> = {},
  name = 'mock-holiday',
): HolidayProvider {
  return {
    name,
    holidays: async (year: number) => {
      // 基础：2026-10-01 ~ 10-08 国庆假期（含周末，简化）
      const set = new Set<string>([
        '2026-10-01',
        '2026-10-02',
        '2026-10-05',
        '2026-10-06',
        '2026-10-07',
        '2026-10-08',
      ])
      for (const [d, _] of Object.entries(extra)) set.add(d)
      return set
    },
  }
}

describe('isTradingDay 周末判定', () => {
  const cal = new TradingCalendar(holidayProvider())

  it('周末（周六/周日）为非交易日', async () => {
    // 2026-09-26 周六、2026-09-27 周日
    expect(await cal.isTradingDay(new Date(2026, 8, 26))).toBe(false)
    expect(await cal.isTradingDay(new Date(2026, 8, 27))).toBe(false)
  })

  it('普通工作日为交易日', async () => {
    // 2026-09-29 周二（工作日，非节假日）
    expect(await cal.isTradingDay(new Date(2026, 8, 29))).toBe(true)
  })

  it('法定节假日（注入）为非交易日', async () => {
    // 2026-10-01 国庆（周四，工作日但休市）
    expect(await cal.isTradingDay(new Date(2026, 9, 1))).toBe(false)
    // 2026-10-06 周二，休市
    expect(await cal.isTradingDay(new Date(2026, 9, 6))).toBe(false)
  })
})

describe('nextTradingDay 顺延', () => {
  it('工作日次日顺延到下一工作日', async () => {
    const cal = new TradingCalendar(holidayProvider())
    // 2026-09-28 周一 → 次日 2026-09-29 周二
    const next = await cal.nextTradingDay(new Date(2026, 8, 28))
    expect(dateKey(next)).toBe('2026-09-29')
  })

  it('周五次日顺延到下周一（跨周末）', async () => {
    const cal = new TradingCalendar(holidayProvider())
    // 2026-10-09 周五 → 跳过 10-10/10-11 周末 → 10-12 周一
    const next = await cal.nextTradingDay(new Date(2026, 9, 9))
    expect(dateKey(next)).toBe('2026-10-12')
    expect(isWeekend(new Date(2026, 9, 10))).toBe(true)
    expect(isWeekend(new Date(2026, 9, 11))).toBe(true)
  })

  it('节假日前一日顺延跨过节假日', async () => {
    const cal = new TradingCalendar(holidayProvider())
    // 2026-09-30 周三 → 跳过 10-01~10-08 → 10-09 周三
    const next = await cal.nextTradingDay(new Date(2026, 8, 30))
    expect(dateKey(next)).toBe('2026-10-09')
  })
})

describe('节假日源失败降级（验收点 4）', () => {
  it('provider 抛错时降级为纯周末判定，不抛异常', async () => {
    const badProvider: HolidayProvider = {
      name: 'bad',
      holidays: () => Promise.reject(new Error('network down')),
    }
    const alerts: string[] = []
    const cal = new TradingCalendar(badProvider, {
      onAlert: (m) => alerts.push(m),
    })

    // 工作日：降级后视为交易日。
    expect(await cal.isTradingDay(new Date(2026, 8, 29))).toBe(true)
    // 周末仍正确判定为非交易日。
    expect(await cal.isTradingDay(new Date(2026, 8, 26))).toBe(false)
    expect(alerts.some((a) => a.includes('fallback'))).toBe(true)
  })

  it('无 provider（构造时未传）时按纯周末判定', async () => {
    const cal = new TradingCalendar()
    expect(await cal.isTradingDay(new Date(2026, 8, 29))).toBe(true)
    expect(await cal.isTradingDay(new Date(2026, 8, 27))).toBe(false)
  })
})