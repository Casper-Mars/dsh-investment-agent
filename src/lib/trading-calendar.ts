/**
 * lib 层交易日历（trading-calendar）。
 *
 * A 股交易日历：ETF 与 A 股共用。判定规则：
 *   - 周末（周六/周日）必为非交易日；
 *   - 工作日若命中「法定节假日休市」亦为非交易日。
 *
 * 节假日数据「实时获取」（不内置静态大表）：通过 `HolidayProvider` 抽象拉取
 * 官方节假日安排；获取失败时降级为「纯周末判定」（NFR-03 降级要求）。
 *
 * 抽象设计：
 *   HolidayProvider（接口）返回某自然年内「休市日期集合」；
 *   TradingCalendar 组合 HolidayProvider 做最终判定，
 *   任何 provider 失败都不抛异常，退化为周末判定。
 */

/** 节假日数据源抽象：返回某自然年（如 2026）内所有非交易日的 `YYYY-MM-DD` 集合。 */
export interface HolidayProvider {
  /** 数据源名称（用于告警/追溯）。 */
  readonly name: string
  /**
   * 拉取某年的休市日期集合。
   * 返回 `yyyy-mm-dd` 字符串集合（含法定节假日与调休后的周末补班口径）。
   * 失败时抛错，由上层降级。
   */
  holidays(year: number): Promise<Set<string>>
}

/** 交易日历配置。 */
export interface TradingCalendarOptions {
  /** 告警回调，默认 noop。 */
  onAlert?: (msg: string) => void
}

/**
 * 交易日历。默认使用 HttpHolidayProvider（实时拉取节假日），
 * 任何失败自动降级为纯周末判定。
 */
export class TradingCalendar {
  private readonly opts: Required<TradingCalendarOptions>
  private provider: HolidayProvider | null

  constructor(provider?: HolidayProvider, opts: TradingCalendarOptions = {}) {
    this.provider = provider ?? null
    this.opts = {
      onAlert: opts.onAlert ?? (() => {}),
    }
  }

  /** 注入/替换节假日数据源。 */
  setProvider(provider: HolidayProvider): void {
    this.provider = provider
  }

  /**
   * 判定某日是否为 A 股交易日。
   * 周末直接 false；工作日查询节假日表，失败则降级（按工作日视为交易日）。
   */
  async isTradingDay(date: Date): Promise<boolean> {
    if (isWeekend(date)) return false

    const holidays = await this.safeHolidays(date.getFullYear())
    if (holidays !== null) {
      return !holidays.has(dateKey(date))
    }

    // 降级：取不到节假日表时，工作日默认视为交易日（纯周末判定）。
    return true
  }

  /**
   * 下一个交易日（不含 date 本身，从 date 次日开始顺延）。
   * 若 date 本身为交易日，返回其后第一个交易日。
   */
  async nextTradingDay(date: Date): Promise<Date> {
    let cur = addDays(date, 1)
    // 安全上限：最多顺延 15 天，避免节假日表异常导致死循环。
    for (let i = 0; i < 15; i++) {
      if (await this.isTradingDay(cur)) return cur
      cur = addDays(cur, 1)
    }
    return cur
  }

  /** 拉取节假日集合；失败返回 null（触发降级）。 */
  private async safeHolidays(year: number): Promise<Set<string> | null> {
    if (!this.provider) return null
    try {
      return await this.provider.holidays(year)
    } catch (err) {
      this.opts.onAlert(
        `[calendar] holiday provider(${this.provider.name}) failed: ${String(err)}, fallback to weekend-only`,
      )
      return null
    }
  }
}

/** 判断是否周末。 */
export function isWeekend(date: Date): boolean {
  const d = date.getDay()
  return d === 0 || d === 6
}

/** `YYYY-MM-DD` 键。 */
export function dateKey(date: Date): string {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

function addDays(date: Date, n: number): Date {
  const d = new Date(date.getTime())
  d.setDate(d.getDate() + n)
  return d
}