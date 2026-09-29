/**
 * lib 层行情客户端（QuoteClient）。
 *
 * 职责：按标的 type 路由到对应数据源；提供多数据源备用（主源失败自动切换备用源）、
 * 缓存与降级。绝不抛未捕获异常（NFR-03）。
 *
 * 抽象层设计：
 *   QuoteProvider（接口，见 quote-types.ts）为数据源最小契约；
 *   每个 (type, source) 组合一个实现：
 *     - EastmoneyProvider（主源）
 *     - TencentProvider（备用源）
 *   QuoteClient 内部按 type 维护「主源 → 备用源」的顺序提供者链，
 *   依次尝试，全部失败时返回缓存或「unavailable」占位行情。
 */

import type { AssetType } from '../domain/types.js'
import type { Quote, QuoteProvider, QuoteStatus } from './quote-types.js'
import { inferAssetType } from './quote-types.js'
import { withRetry } from './http.js'
import { EastmoneyProvider } from './providers/eastmoney.js'
import { TencentProvider } from './providers/tencent.js'

interface ProviderChain {
  primary: QuoteProvider
  fallback: QuoteProvider
}

/** QuoteClient 配置。 */
export interface QuoteClientOptions {
  /** 重试次数（初次 + N 次重试），默认 3。 */
  retries?: number
  /** 重试基础退避间隔（ms），默认 200。 */
  baseDelayMs?: number
  /** 缓存 TTL（ms），默认 60s。 */
  cacheTtlMs?: number
  /** 告警回调（数据源全部失败 / 命中缓存时触发），默认 noop。 */
  onAlert?: (msg: string) => void
  /** 是否启用缓存降级，默认 true。 */
  cacheEnabled?: boolean
}

interface CacheEntry {
  quote: Quote
  ts: number
}

/**
 * 行情客户端。默认注册东财为主源、腾讯为备用源，均按 type 分实例。
 * 测试可注入自定义 provider（mock）。
 */
export class QuoteClient {
  private readonly chains = new Map<AssetType, ProviderChain>()
  private readonly cache = new Map<string, CacheEntry>()
  private readonly opts: Required<QuoteClientOptions>

  constructor(opts: QuoteClientOptions = {}) {
    this.opts = {
      retries: opts.retries ?? 3,
      baseDelayMs: opts.baseDelayMs ?? 200,
      cacheTtlMs: opts.cacheTtlMs ?? 60_000,
      onAlert: opts.onAlert ?? (() => {}),
      cacheEnabled: opts.cacheEnabled ?? true,
    }

    // 默认数据源链：东财主源 + 腾讯备用源。
    for (const type of ['etf', 'stock'] as AssetType[]) {
      this.chains.set(type, {
        primary: new EastmoneyProvider(type),
        fallback: new TencentProvider(type),
      })
    }
  }

  /**
   * 覆盖指定 type 的数据源链（供测试注入 mock，或运行时替换数据源）。
   */
  setChain(type: AssetType, primary: QuoteProvider, fallback?: QuoteProvider): void {
    this.chains.set(type, {
      primary,
      fallback: fallback ?? primary,
    })
  }

  /** 解析标的 type：优先显式传入，否则按代码前缀推断。 */
  resolveType(symbol: string, type?: AssetType): AssetType {
    if (type) return type
    const inferred = inferAssetType(symbol)
    if (inferred) return inferred
    // 无法推断时代码前缀兜底：5/6/9 → 沪，ETF 或 stock 无强证据时默认 stock。
    return 'stock'
  }

  private chain(symbol: string, type?: AssetType): ProviderChain {
    const t = this.resolveType(symbol, type)
    const chain = this.chains.get(t)
    if (!chain) throw new Error(`no provider chain for type: ${t}`)
    return chain
  }

  /** 实时行情。 */
  async realtime(symbol: string, type?: AssetType): Promise<Quote> {
    return this.withFallback(symbol, type, (p) => p.realtime(symbol))
  }

  /** 日内分时。 */
  async intraday(symbol: string, type?: AssetType): Promise<Quote[]> {
    return this.withFallbackList(symbol, type, (p) => p.intraday(symbol))
  }

  /** 日 K 历史。 */
  async history(
    symbol: string,
    days: number,
    type?: AssetType,
  ): Promise<Quote[]> {
    return this.withFallbackList(symbol, type, (p) => p.history(symbol, days))
  }

  /**
   * 单条行情：主源 → 备用源 → 缓存 → unavailable 占位。
   * 全程不抛未捕获异常。
   */
  private async withFallback(
    symbol: string,
    type: AssetType | undefined,
    fn: (p: QuoteProvider) => Promise<Quote>,
  ): Promise<Quote> {
    const chain = this.chain(symbol, type)
    const t = this.resolveType(symbol, type)

    const providers = [chain.primary, chain.fallback].filter(
      (p, i, arr) => arr.indexOf(p) === i, // 去重（primary === fallback 时）
    )

    let lastErr: unknown
    for (const p of providers) {
      try {
        const q = await withRetry(
          () => fn(p),
          this.opts.retries,
          this.opts.baseDelayMs,
          (attempt, err) =>
            this.opts.onAlert(
              `[quote] ${symbol} ${p.name} retry ${attempt}: ${String(err)}`,
            ),
        )
        this.putCache(symbol, q)
        return q
      } catch (err) {
        lastErr = err
        this.opts.onAlert(`[quote] ${symbol} ${p.name} failed: ${String(err)}`)
      }
    }

    // 全部失败 → 缓存降级。
    const cached = this.getCache(symbol)
    if (cached) {
      this.opts.onAlert(`[quote] ${symbol} fallback to cache`)
      return cached
    }

    // 无缓存 → unavailable 占位（最低可用降级，绝不抛错）。
    this.opts.onAlert(`[quote] ${symbol} unavailable: ${String(lastErr)}`)
    return this.stub(symbol, t, undefined, 'unavailable')
  }

  /**
   * 序列行情：主源 → 备用源 → 缓存 → 空序列。
   * 备用源腾讯不提供分时/K线，返回空序列时继续后续降级。
   */
  private async withFallbackList(
    symbol: string,
    type: AssetType | undefined,
    fn: (p: QuoteProvider) => Promise<Quote[]>,
  ): Promise<Quote[]> {
    const chain = this.chain(symbol, type)

    const providers = [chain.primary, chain.fallback].filter(
      (p, i, arr) => arr.indexOf(p) === i,
    )

    let lastErr: unknown
    for (const p of providers) {
      try {
        const list = await withRetry(
          () => fn(p),
          this.opts.retries,
          this.opts.baseDelayMs,
          (attempt, err) =>
            this.opts.onAlert(
              `[quote] ${symbol} ${p.name} retry ${attempt}: ${String(err)}`,
            ),
        )
        if (list && list.length > 0) {
          this.putCacheList(symbol, list)
          return list
        }
        // 空序列（如腾讯无此能力）→ 视为失败，继续备用/降级。
        lastErr = new Error('empty series')
      } catch (err) {
        lastErr = err
        this.opts.onAlert(`[quote] ${symbol} ${p.name} failed: ${String(err)}`)
      }
    }

    const cached = this.getCacheList(symbol)
    if (cached.length > 0) {
      this.opts.onAlert(`[quote] ${symbol} series fallback to cache`)
      return cached
    }

    this.opts.onAlert(`[quote] ${symbol} series unavailable: ${String(lastErr)}`)
    return []
  }

  private stub(
    symbol: string,
    type: AssetType,
    _price: number | undefined,
    status: QuoteStatus,
  ): Quote {
    return {
      symbol,
      name: '',
      type,
      price: 0,
      open: 0,
      high: 0,
      low: 0,
      prevClose: 0,
      volume: 0,
      amount: 0,
      ts: Date.now(),
      status,
      source: 'unavailable',
    }
  }

  private cacheKey(symbol: string): string {
    return symbol
  }

  private putCache(symbol: string, quote: Quote): void {
    if (!this.opts.cacheEnabled) return
    this.cache.set(this.cacheKey(symbol), { quote, ts: Date.now() })
  }

  private getCache(symbol: string): Quote | undefined {
    if (!this.opts.cacheEnabled) return undefined
    const e = this.cache.get(this.cacheKey(symbol))
    if (!e) return undefined
    if (Date.now() - e.ts > this.opts.cacheTtlMs) {
      this.cache.delete(this.cacheKey(symbol))
      return undefined
    }
    return { ...e.quote, source: 'cache' }
  }

  private putCacheList(symbol: string, list: Quote[]): void {
    if (!this.opts.cacheEnabled) return
    // 仅缓存最后一条作单条降级用；序列缓存 key 独立。
    const last = list[list.length - 1]
    if (last) {
      this.cache.set(`${this.cacheKey(symbol)}:list`, {
        quote: last,
        ts: Date.now(),
      })
      this.listCache.set(this.cacheKey(symbol), { list, ts: Date.now() })
    }
  }

  private getCacheList(symbol: string): Quote[] {
    if (!this.opts.cacheEnabled) return []
    const e = this.listCache.get(this.cacheKey(symbol))
    if (!e) return []
    if (Date.now() - e.ts > this.opts.cacheTtlMs) {
      this.listCache.delete(this.cacheKey(symbol))
      return []
    }
    return e.list
  }

  private readonly listCache = new Map<string, { list: Quote[]; ts: number }>()
}