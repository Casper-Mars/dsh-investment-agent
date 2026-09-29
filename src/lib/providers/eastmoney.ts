/**
 * 东方财富行情数据源适配（主源）。
 *
 * 实时接口：
 *   GET https://push2.eastmoney.com/api/qt/stock/get?secid=<市场>.<代码>&fields=...
 *   市场：沪市 1 / 深市 0。
 *   关键字段（以实际响应为准，已实测 2026-09-29）：
 *     f43 最新价（×100）  f44 最高  f45 最低  f46 今开
 *     f47 成交量(手)      f48 成交额(元)
 *     f57 代码            f58 名称  f60 昨收  f170 涨跌幅(×100)
 * K 线接口：
 *   GET https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=...&klt=101&fqt=1&beg=...&end=...
 *   klines[] 每条：date,open,close,high,low,volume,amount,amplitude
 *
 * 本 provider 作为「主源」，`name = 'eastmoney'`。识别停牌 / 涨跌停并写 status。
 */

import type { Quote, QuoteProvider } from '../quote-types.js'
import {
  fetchWithTimeout,
  readText,
  withRetry,
} from '../http.js'

/** 东财实时接口字段（已实测映射）。 */
const REALTIME_FIELDS =
  'f43,f44,f45,f46,f47,f48,f57,f58,f60,f170,f168,f169'

/** 涨跌幅阈值（用于判定一字板涨跌停）。 */
const LIMIT_RATIO = 0.099

interface EastmoneyRealtimeResp {
  rc?: number
  data?: {
    f43?: number
    f44?: number
    f45?: number
    f46?: number
    f47?: number
    f48?: number
    f57?: string
    f58?: string
    f60?: number
    f170?: number
    f168?: number
    f169?: number
  } | null
}

interface EastmoneyKlineResp {
  data?: {
    code?: string
    name?: string
    preKPrice?: number
    klines?: string[]
  } | null
}

/**
 * 构建东财 secid（`<市场>.<代码>`）。
 */
function secid(symbol: string): string {
  // 沪市 5/6/9 开头，深市 0/1/3 开头。
  const head = symbol[0]
  const market = head === '5' || head === '6' || head === '9' ? '1' : '0'
  return `${market}.${symbol}`
}

/** 涨跌幅数值字段（f170 / f169 / f168 均为 ×100 的百分数，如 85 → 0.85%）。 */
function ratioToValue(v?: number): number | undefined {
  if (v === undefined || v === null || Number.isNaN(v)) return undefined
  return v / 100
}

/**
 * 依据价格/成交量/涨跌幅判定状态。
 *  - 无价格（f43 缺失或 0）→ suspended（停牌）
 *  - 有价格、成交量 0 且涨跌幅逼近涨停板 → limit_up
 *  - 有价格、成交量 0 且涨跌幅逼近跌停板 → limit_down
 *  - 其余 → trading
 */
function judgeStatus(
  price: number | undefined,
  volume: number | undefined,
  changeRatio: number | undefined,
): Quote['status'] {
  if (price === undefined || price === 0) return 'suspended'
  if (volume !== undefined && volume === 0) {
    if (changeRatio !== undefined) {
      if (changeRatio >= LIMIT_RATIO) return 'limit_up'
      if (changeRatio <= -LIMIT_RATIO) return 'limit_down'
    }
  }
  return 'trading'
}

/** 东财价格字段均是「行情值 × 100」（DECIMAL 通常 2~3 位），直接 /100 还原。 */
function price100(v?: number): number {
  if (v === undefined || v === null || Number.isNaN(v)) return 0
  return v / 100
}

export class EastmoneyProvider implements QuoteProvider {
  readonly type: 'etf' | 'stock'
  readonly name = 'eastmoney'
  private readonly base = 'https://push2.eastmoney.com'
  private readonly hisBase = 'https://push2his.eastmoney.com'

  constructor(type: 'etf' | 'stock') {
    this.type = type
  }

  private headers(): Record<string, string> {
    return {
      Referer: 'https://quote.eastmoney.com/',
      'User-Agent':
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
    }
  }

  async realtime(symbol: string): Promise<Quote> {
    const url = `${this.base}/api/qt/stock/get?secid=${secid(
      symbol,
    )}&fields=${REALTIME_FIELDS}`

    const resp = await withRetry(async () => {
      const res = await fetchWithTimeout(url, { headers: this.headers() })
      if (!res.ok) throw new Error(`eastmoney realtime HTTP ${res.status}`)
      const text = await readText(res)
      const json = JSON.parse(text) as EastmoneyRealtimeResp
      if (json.rc !== undefined && json.rc !== 0) {
        throw new Error(`eastmoney realtime rc=${json.rc}`)
      }
      if (!json.data) throw new Error('eastmoney realtime empty data')
      return json
    })

    return this.mapRealtime(symbol, resp)
  }

  private mapRealtime(symbol: string, resp: EastmoneyRealtimeResp): Quote {
    const d = resp.data ?? {}
    const price = price100(d.f43) || undefined
    const open = price100(d.f46)
    const high = price100(d.f44)
    const low = price100(d.f45)
    const prevClose = price100(d.f60)
    // f47 成交量单位「手」，1 手 = 100 股。
    const volume = (d.f47 ?? 0) * 100
    const amount = d.f48 ?? 0
    const changeRatio = ratioToValue(d.f170 ?? d.f169 ?? d.f168)

    const status = judgeStatus(price, volume, changeRatio)

    return {
      symbol,
      name: d.f58 ?? '',
      type: this.type,
      price: price ?? 0,
      open,
      high,
      low,
      prevClose,
      volume,
      amount,
      ts: Date.now(),
      status,
      source: this.name,
    }
  }

  async intraday(symbol: string): Promise<Quote[]> {
    // 分时行情：使用 kline 接口 klt=1（1 分钟）近似日内分时。
    return this.fetchKline(symbol, 1)
  }

  async history(symbol: string, days: number): Promise<Quote[]> {
    return this.fetchKline(symbol, 101, days)
  }

  /**
   * 拉取 K 线并按升序映射为 Quote[]。
   * @param klt 101=日K / 1=1分钟（分时）
   * @param days 仅对日 K 生效（向后取 days 个交易日）。
   */
  private async fetchKline(
    symbol: string,
    klt: number,
    days = 0,
  ): Promise<Quote[]> {
    const now = new Date()
    // beg/end 用 YYYYMMDD；日 K 向后多回看 30 日以覆盖节假日顺延。
    const end = fmt(now)
    const lookback = klt === 101 ? Math.max(days + 30, 90) : 40
    const begDate = new Date(now.getTime() - lookback * 24 * 3600 * 1000)
    const beg = fmt(begDate)

    const url = `${this.hisBase}/api/qt/stock/kline/get?secid=${secid(
      symbol,
    )}&klt=${klt}&fqt=1&beg=${beg}&end=${end}&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56,f57,f58`

    const resp = await withRetry(async () => {
      const res = await fetchWithTimeout(url, { headers: this.headers() })
      if (!res.ok) throw new Error(`eastmoney kline HTTP ${res.status}`)
      const text = await readText(res)
      const json = JSON.parse(text) as EastmoneyKlineResp
      if (!json.data?.klines) throw new Error('eastmoney kline empty data')
      return json
    })

    const klines = resp.data?.klines ?? []
    const metaPrevClose = resp.data?.preKPrice
    // 逐条映射时按顺序推导昨收：第一条用响应 meta 的 preKPrice 或自身开盘价近似，
    // 后续条目用前一条的收盘价。
    let runningPrev: number | undefined
    const mapped = klines.map((line) => {
      const q = this.mapKline(
        symbol,
        line,
        resp,
        runningPrev ?? metaPrevClose,
      )
      runningPrev = q.prevCloseForNext
      return q.quote
    })

    // 日 K 截取最近 days 个点；分时全量返回。
    if (klt === 101 && days > 0) {
      return mapped.slice(-days)
    }
    return mapped
  }

  private mapKline(
    symbol: string,
    line: string,
    resp: EastmoneyKlineResp,
    prevCloseHint?: number,
  ): { quote: Quote; prevCloseForNext: number } {
    // date,open,close,high,low,volume,amount,amplitude
    const parts = line.split(',')
    const [dateStr, o, c, h, l, v, a] = parts
    const open = Number(o)
    const close = Number(c)
    const high = Number(h)
    const low = Number(l)
    const volume = Number(v)
    const amount = Number(a)

    // K 线接口不逐条返回昨收，用前一条收盘价（或 meta preKPrice / 开盘价）近似。
    const prevClose = prevCloseHint ?? open

    return {
      quote: {
        symbol,
        name: resp.data?.name ?? '',
        type: this.type,
        price: close || 0,
        open,
        high,
        low,
        prevClose,
        volume,
        amount,
        ts: parseDate(dateStr),
        status: close > 0 ? 'trading' : 'suspended',
        source: this.name,
      },
      prevCloseForNext: close,
    }
  }
}

function fmt(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}${m}${day}`
}

function parseDate(s: string): number {
  // dateStr 形如 2026-09-29
  const [y, m, d] = s.split('-').map(Number)
  return new Date(y, m - 1, d).getTime()
}