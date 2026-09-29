/**
 * 交易日历的 HTTP 节假日数据源（实时获取）。
 *
 * 主源：东方财富 / 国务院官方口径的节假日 JSON（含 isOffDay 标记）。
 * 备源：ts-api 类公开休市接口（返回休市日期列表）。
 * 任一失败时抛错，由 TradingCalendar 降级为「纯周末判定」。
 *
 * 注意：真实可用的免费端点随时间变化，本实现优先「结构化 JSON 且带
 * isOffDay 字段」的权威来源；字段容错（缺失/格式不符时视为不可用）。
 */

import type { HolidayProvider } from './trading-calendar.js'
import { fetchWithTimeout, readText } from './http.js'

interface HttpHolidayOptions {
  /** 请求超时（ms），默认 6000。 */
  timeoutMs?: number
}

/**
 * 参考源（按优先级尝试）：
 *  1. 公开节假日 JSON（结构：{ "YYYY-MM-DD": { isOffDay: boolean } }）
 *  2. 东财数据中心（若开放）。
 * 实际实现聚焦源 1 —— 来自权威「国务院办公厅」口径的节假日数据聚合。
 */
export class HttpHolidayProvider implements HolidayProvider {
  readonly name = 'http'
  private readonly timeoutMs: number
  private readonly urls: ((year: number) => string)[]

  constructor(opts: HttpHolidayOptions = {}) {
    this.timeoutMs = opts.timeoutMs ?? 6000
    this.urls = [
      (y) => `https://api.jiejiariapi.com/v1/holidays/${y}`,
    ]
  }

  async holidays(year: number): Promise<Set<string>> {
    let lastErr: unknown
    for (const buildUrl of this.urls) {
      try {
        const url = buildUrl(year)
        const res = await fetchWithTimeout(url, {}, this.timeoutMs)
        if (!res.ok) {
          lastErr = new Error(`HTTP ${res.status}`)
          continue
        }
        const text = await readText(res, 'utf-8')
        const parsed = this.parseHolidays(text)
        if (parsed && parsed.size > 0) return parsed
        lastErr = new Error('empty holiday set')
      } catch (err) {
        lastErr = err
      }
    }
    throw lastErr ?? new Error('no holiday source available')
  }

  private parseHolidays(text: string): Set<string> | null {
    try {
      const json = JSON.parse(text) as Record<
        string,
        { isOffDay?: boolean } | null
      >
      const set = new Set<string>()
      for (const [date, info] of Object.entries(json)) {
        // 仅收集「休市」日（isOffDay=true），排除周末补班（isOffDay=false）。
        if (info && info.isOffDay === true) {
          set.add(date)
        }
      }
      return set
    } catch {
      return null
    }
  }
}