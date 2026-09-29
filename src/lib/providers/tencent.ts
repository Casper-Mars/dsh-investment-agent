/**
 * 腾讯行情数据源适配（备用源）。
 *
 * 实时接口（GBK 编码）：
 *   GET https://qt.gtimg.cn/q=<sh|sz><code>
 *   返回形如 `v_sh588000="字段~字段~..."`，字段按 `~` 分隔，
 *   以实际响应为准，已实测 2026-09-29 的字段位置如下：
 *     [1]  名称        [2]  代码        [3] 最新价   [4] 昨收   [5] 今开
 *     [6]  成交量(手)  [30] 时间戳      [31] 涨跌额  [32] 涨跌幅(%)
 *     [33] 最高        [34] 最低        [37] 成交额(万)
 *
 * 本 provider 作为「备用源」，`name = 'tencent'`。腾讯接口不提供分时/K线公开
 * 免费端点（此处 realtime 为主），intraday/history 回调到日 K 近似不可用时
 * 返回空序列并交由上层降级缓存。
 */

import type { Quote, QuoteProvider } from '../quote-types.js'
import { inferMarket } from '../quote-types.js'
import { fetchWithTimeout, readText, withRetry } from '../http.js'

/** 涨跌幅阈值（一字板判定）。 */
const LIMIT_RATIO = 0.099

/** 腾讯代码前缀：沪市 sh / 深市 sz。 */
function marketPrefix(symbol: string): 'sh' | 'sz' {
  const m = inferMarket(symbol)
  return m === 0 ? 'sz' : 'sh'
}

export class TencentProvider implements QuoteProvider {
  readonly type: 'etf' | 'stock'
  readonly name = 'tencent'
  private readonly base = 'https://qt.gtimg.cn'

  constructor(type: 'etf' | 'stock') {
    this.type = type
  }

  async realtime(symbol: string): Promise<Quote> {
    const url = `${this.base}/q=${marketPrefix(symbol)}${symbol}`

    const txt = await withRetry(async () => {
      const res = await fetchWithTimeout(url, {
        headers: {
          Referer: 'https://gu.qq.com/',
          'User-Agent':
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        },
      })
      if (!res.ok) throw new Error(`tencent realtime HTTP ${res.status}`)
      return readText(res, 'gbk')
    })

    return this.parseRealtime(symbol, txt)
  }

  private parseRealtime(symbol: string, txt: string): Quote {
    const m = txt.match(/"([^"]*)"/)
    const body = m ? m[1] : txt
    const f = body.split('~')

    const name = f[1] ?? ''
    const price = num(f[3])
    const prevClose = num(f[4])
    const open = num(f[5])
    // [6] 成交量单位「手」。
    const volume = num(f[6]) * 100
    // [37] 成交额单位「万元」。
    const amount = num(f[37]) * 10000
    const high = num(f[33])
    const low = num(f[34])
    const changeRatio = num(f[32])
    // [30] 时间戳形如 20260929161438。
    const ts = parseTencentTime(f[30])

    const status = judgeStatus(price, volume, changeRatio)

    return {
      symbol,
      name,
      type: this.type,
      price,
      open,
      high,
      low,
      prevClose,
      volume,
      amount,
      ts,
      status,
      source: this.name,
    }
  }

  async intraday(_symbol: string): Promise<Quote[]> {
    // 腾讯公开接口无免费分时端点，返回空序列交由上层降级。
    return []
  }

  async history(_symbol: string, _days: number): Promise<Quote[]> {
    // 腾讯公开接口无免费日 K 端点，返回空序列交由上层降级。
    return []
  }
}

function num(v: string | undefined): number {
  if (v === undefined || v === '') return 0
  const n = Number(v)
  return Number.isNaN(n) ? 0 : n
}

function judgeStatus(
  price: number,
  volume: number,
  changeRatio: number,
): Quote['status'] {
  if (price === 0) return 'suspended'
  if (volume === 0) {
    if (changeRatio >= LIMIT_RATIO) return 'limit_up'
    if (changeRatio <= -LIMIT_RATIO) return 'limit_down'
  }
  return 'trading'
}

function parseTencentTime(v: string | undefined): number {
  if (!v || v.length < 14) return Date.now()
  const y = Number(v.slice(0, 4))
  const mo = Number(v.slice(4, 6))
  const d = Number(v.slice(6, 8))
  const h = Number(v.slice(8, 10))
  const mi = Number(v.slice(10, 12))
  const s = Number(v.slice(12, 14))
  return new Date(y, mo - 1, d, h, mi, s).getTime()
}