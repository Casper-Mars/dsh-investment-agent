/**
 * scheduler/cron.ts 单元测试。
 *
 * 唯一权威设计文档：《感知层详细设计（dsh-ia 插件）》 v0.7。
 *
 * 覆盖任务卡验收点：
 * - 5 段 cron 全语法（* / 值 / 枚举 / 区间 / 步进 / ? / L）+ 月份星期英文名
 * - DOM/DOW OR 语义（Vixie）
 * - Asia/Shanghai 时区锁定，最小粒度分钟
 * - next() 纯函数、from 可注入，跨天/跨月/跨年/L/闰年正确
 * - 非法表达式抛错 / isValidCron 返回 false
 */
import { describe, it, expect } from 'vitest'
import { parseCron, next, isValidCron, SHANGHAI_TIME_ZONE } from '../src/scheduler/cron.js'

/** Asia/Shanghai 墙钟格式化（测试断言用，与本机时区无关）。 */
const shanghaiFmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
})

/** 将 Date 转成 `YYYY-MM-DD, HH:mm` 的 Asia/Shanghai 墙钟字符串。 */
function shanghai(d: Date): string {
  return shanghaiFmt.format(d)
}

/**
 * 便捷断言：从 `fromIso`（UTC ISO 字符串）出发，期望下一次触发为 `expectShanghai`
 * （`YYYY-MM-DD, HH:mm`，Asia/Shanghai 墙钟）。
 */
function expectNext(expr: string, fromIso: string, expectShanghai: string): void {
  const schedule = parseCron(expr)
  const got = shanghai(next(schedule, new Date(fromIso)))
  expect(got).toBe(expectShanghai)
}

describe('parseCron：合法表达式解析', () => {
  it('解析 5 段：分/时/日/月/周', () => {
    const s = parseCron('0 9 * * *')
    expect(s.minute.values).toEqual([0])
    expect(s.hour.values).toEqual([9])
    expect(s.month.values).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])
    expect(s.dayOfMonth.restricted).toBe(false)
    expect(s.dayOfWeek.restricted).toBe(false)
  })

  it('月份与星期英文名（大小写不敏感）', () => {
    expect(parseCron('0 9 * JAN *').month.values).toEqual([1])
    expect(parseCron('0 9 * jan *').month.values).toEqual([1])
    expect(parseCron('0 9 * * MON').dayOfWeek.values).toEqual([1])
    expect(parseCron('0 9 * * sat').dayOfWeek.values).toEqual([6])
  })

  it('星期 0 与 7 均归一为周日', () => {
    expect(parseCron('0 9 * * 7').dayOfWeek.values).toEqual([0])
    expect(parseCron('0 9 * * 0').dayOfWeek.values).toEqual([0])
  })

  it('步进与区间步进', () => {
    expect(parseCron('*/15 * * * *').minute.values).toEqual([0, 15, 30, 45])
    expect(parseCron('5-50/15 * * * *').minute.values).toEqual([5, 20, 35, 50])
  })
})

describe('next：基础时刻计算', () => {
  it('每天 09:00', () => {
    expectNext('0 9 * * *', '2024-01-01T00:59:00Z', '2024-01-01, 09:00')
    expectNext('0 9 * * *', '2024-01-01T01:00:00Z', '2024-01-02, 09:00')
  })

  it('步进每 15 分钟', () => {
    expectNext('*/15 * * * *', '2024-01-01T01:00:00Z', '2024-01-01, 09:15')
    expectNext('*/15 * * * *', '2024-01-01T01:14:59Z', '2024-01-01, 09:15')
  })

  it('区间 9-17 点（分钟固定 0）', () => {
    // 07:59 Shanghai → 当天 09:00
    expectNext('0 9-17 * * *', '2024-01-01T23:59:00Z', '2024-01-02, 09:00')
    // 09:00 Shanghai（严格大于）→ 10:00
    expectNext('0 9-17 * * *', '2024-01-01T01:00:00Z', '2024-01-01, 10:00')
    // 17:00 Shanghai（严格大于，当日窗口已过）→ 次日 09:00
    expectNext('0 9-17 * * *', '2024-01-01T09:00:00Z', '2024-01-02, 09:00')
  })

  it('枚举 0,30 分', () => {
    expectNext('0,30 * * * *', '2024-01-01T01:00:00Z', '2024-01-01, 09:30')
    expectNext('0,30 * * * *', '2024-01-01T01:30:00Z', '2024-01-01, 10:00')
  })

  it('跨天：23:50 → 次日 00:00', () => {
    expectNext('0 0 * * *', '2024-01-01T15:50:00Z', '2024-01-02, 00:00')
  })

  it('跨年：12 月 31 日 → 次年 1 月 1 日', () => {
    expectNext('0 0 1 1 *', '2024-12-31T01:00:00Z', '2025-01-01, 00:00')
  })
})

describe('next：日字段 L（当月最后一天）', () => {
  it('普通月 31 号', () => {
    expectNext('0 0 L * *', '2024-01-30T10:00:00Z', '2024-01-31, 00:00')
  })

  it('闰年 2 月 29 号', () => {
    expectNext('0 0 L * *', '2024-02-28T10:00:00Z', '2024-02-29, 00:00')
  })

  it('非闰年 2 月 28 号（最后一天即 28 号）', () => {
    // 2025 年 2 月有 28 天，2 月最后一天 = 28 号；从 2 月 27 日出发应命中 2 月 28 日。
    expectNext('0 0 L * *', '2025-02-27T10:00:00Z', '2025-02-28, 00:00')
  })

  it('跨月：从当月 L 之后出发滚动到下月最后一天', () => {
    // 2025-02-28 18:00 已过 2 月 28 日 00:00，下一 L = 3 月 31 日。
    expectNext('0 0 L * *', '2025-02-28T10:00:00Z', '2025-03-31, 00:00')
  })

  it('小月 30 天与 4 月 30 天', () => {
    expectNext('0 0 L * *', '2024-04-29T10:00:00Z', '2024-04-30, 00:00')
  })
})

describe('next：DOM/DOW OR 语义（Vixie）', () => {
  it('DOM 与 DOW 均限制 → OR：任一命中即触发', () => {
    // `0 9 15 * MON`：每月 15 号 OR 每周一，09:00。
    // 2024-01-01 是周一，从 01-01T08:59 出发 → 当天 09:00 命中（DOW=MON）。
    expectNext('0 9 15 * MON', '2024-01-01T00:59:00Z', '2024-01-01, 09:00')
  })

  it('仅 DOM 限制（DOW 为 *）→ 只按 DOM 判断', () => {
    // 1 月 15 号是周一，但只限制 DOM=15，下一个 15 号即触发。
    expectNext('0 9 15 * *', '2024-01-01T01:00:00Z', '2024-01-15, 09:00')
  })

  it('仅 DOW 限制（DOM 为 ?）→ 只按 DOW 判断', () => {
    // `?` 表无特定日，仅按周一。
    expectNext('0 9 ? * MON', '2024-01-01T01:00:00Z', '2024-01-08, 09:00')
  })

  it('DOM 与 DOW 都未限制（* *）→ 恒命中', () => {
    expectNext('0 9 * * *', '2024-01-01T01:00:00Z', '2024-01-02, 09:00')
  })
})

describe('next：星期英文名与 DOW L（可选）', () => {
  it('工作日 MON-FRI', () => {
    // 2024-01-05 是周五，下一工作日 = 周一 1 月 8 日。
    expectNext('0 9 * * MON-FRI', '2024-01-05T10:00:00Z', '2024-01-08, 09:00')
  })

  it('每月最后一个周五（5L）', () => {
    // 2024 年 1 月最后一个周五 = 1 月 26 日。
    expectNext('0 9 * * 5L', '2024-01-25T10:00:00Z', '2024-01-26, 09:00')
  })
})

describe('时区正确性（锁定 Asia/Shanghai）', () => {
  it('SHANGHAI_TIME_ZONE 常量为 Asia/Shanghai', () => {
    expect(SHANGHAI_TIME_ZONE).toBe('Asia/Shanghai')
  })

  it('同一 UTC 时刻，按 Shanghai 视角的下一次 9 点正确（UTC 08:59 = Shanghai 16:59）', () => {
    // from = 2024-01-01T08:59Z 即 Shanghai 2024-01-01 16:59（已过当日 09:00），
    // 故下一次 9 点应为 Shanghai 2024-01-02 09:00。
    expectNext('0 9 * * *', '2024-01-01T08:59:00Z', '2024-01-02, 09:00')
    // from = 2024-01-01T00:59Z 即 Shanghai 2024-01-01 08:59（未到 09:00），
    // 故下一次为当日 09:00。
    expectNext('0 9 * * *', '2024-01-01T00:59:00Z', '2024-01-01, 09:00')
  })

  it('返回值为绝对 Date，且其 Shanghai 墙钟等于断言值', () => {
    const s = parseCron('0 9 * * *')
    const r = next(s, new Date('2024-01-01T00:59:00Z'))
    // 期望绝对时刻为 Shanghai 2024-01-01 09:00 = UTC 2024-01-01 01:00。
    expect(r.getTime()).toBe(Date.UTC(2024, 0, 1, 1, 0, 0, 0))
  })
})

describe('parseCron：非法表达式抛错', () => {
  const invalid: Array<[string, string]> = [
    ['', '空表达式'],
    ['   ', '空表达式'],
    ['0 9 * *', '缺段'],
    ['0 9 * * * *', '超段'],
    ['60 * * * *', '分越界'],
    ['* 24 * * *', '时越界'],
    ['0 0 32 * *', '日越界'],
    ['0 0 0 * *', '日越界（0）'],
    ['0 0 * 13 *', '月越界'],
    ['0 9 * * 8', '周越界（8）'],
    ['0 9 * * FOO', '周非法字符'],
    ['0 9 * * MON-FOO', '周区间非法'],
    ['a 9 * * *', '分非法字符'],
    ['0 9 * * *?', '非法后缀'],
    ['0 0 * * SAT-SUN', '周数字环绕区间'],
    ['0 0 * * FRI-MON', '周英文名环绕区间'],
    ['0 0 * * 5-2', '周数字环绕区间（5-2）'],
    ['0 0 * * 6-0', '周数字环绕区间（6-0）'],
    ['0 0 * * 5-7', '周数字环绕区间（5-7）'],
    ['0 0 1 NOV-FEB *', '月英文名环绕区间'],
    ['0 0 1 11-2 *', '月数字环绕区间（11-2）'],
  ]

  it.each(invalid)('parseCron(%j) 抛 [cron] 错误', (expr) => {
    expect(() => parseCron(expr)).toThrow(/\[cron\]/)
  })
})

describe('isValidCron：合法/非法判定（不抛）', () => {
  it.each([
    '0 9 * * *',
    '*/15 * * * *',
    '0 9-17 * * *',
    '0,30 * * * *',
    '0 0 L * *',
    '0 9 ? * MON',
    '30 9 * JAN *',
    '0 9 * * MON-FRI',
    '0 9 * * 5L',
  ])('isValidCron(%j) === true', (expr) => {
    expect(isValidCron(expr)).toBe(true)
  })

  it.each([
    '',
    'bad',
    '0 9 * *',
    '60 * * * *',
    '0 25 * * *',
    '0 0 32 * *',
    '0 0 * 13 *',
    '0 9 * * 8',
    '0 9 * * FOO',
    '0 0 * * SAT-SUN',
    '0 0 * * FRI-MON',
    '0 0 * * 5-2',
    '0 0 1 NOV-FEB *',
  ])('isValidCron(%j) === false', (expr) => {
    expect(isValidCron(expr)).toBe(false)
  })

  it('isValidCron 不抛异常（区别于 parseCron）', () => {
    expect(() => isValidCron('@@@')).not.toThrow()
  })
})

describe('环绕区间（起点 > 终点）统一拒绝：不静默展开', () => {
  it.each([
    '0 0 * * SAT-SUN',
    '0 0 * * FRI-MON',
    '0 0 * * 5-2',
    '0 0 * * 6-0',
    '0 0 * * 5-7',
    '0 0 1 NOV-FEB *',
    '0 0 1 11-2 *',
    '0 0 1 DEC-JAN *',
  ])('parseCron(%j) 拒环绕区间（抛 [cron] 错误）', (expr) => {
    expect(() => parseCron(expr)).toThrow(/\[cron\]/)
    expect(isValidCron(expr)).toBe(false)
  })

  it('正常区间（起点 <= 终点）仍正确展开', () => {
    // DOW 正常区间 MON-FRI → [1..5]
    expect(parseCron('0 0 * * MON-FRI').dayOfWeek.values).toEqual([1, 2, 3, 4, 5])
    // DOW SUN-TUE → [0,1,2]（0=周日）
    expect(parseCron('0 0 * * SUN-TUE').dayOfWeek.values).toEqual([0, 1, 2])
    // DOW 数字 0-2 → [0,1,2]
    expect(parseCron('0 0 * * 0-2').dayOfWeek.values).toEqual([0, 1, 2])
    // 月份正常区间 JAN-MAR → [1,2,3]
    expect(parseCron('0 0 1 JAN-MAR *').month.values).toEqual([1, 2, 3])
    // 月份数字 9-11 → [9,10,11]
    expect(parseCron('0 0 1 9-11 *').month.values).toEqual([9, 10, 11])
    // 跨名数值 JAN-3 → [1,2,3]
    expect(parseCron('0 0 1 JAN-3 *').month.values).toEqual([1, 2, 3])
  })

  it('步进区间（a-b/n, a<=b）仍正确展开', () => {
    // DOW 步进 0-6/2 → [0,2,4,6]
    expect(parseCron('0 0 * * 0-6/2').dayOfWeek.values).toEqual([0, 2, 4, 6])
  })

  it('DOW 环绕区间带步进同样拒绝（FRI-MON/2）', () => {
    expect(() => parseCron('0 0 * * FRI-MON/2')).toThrow(/\[cron\]/)
  })
})