/**
 * runner 层：感知脚本的**只读 bindings 组装**（详细设计 §6.3）。
 *
 * 仅暴露 5 个只读方法，**无任何写方法**：
 *   - `symbols.list()`               → 标的清单（含 type）
 *   - `quote.realtime(args)`         → 实时行情（按 type 路由）
 *   - `quote.intraday(args)`         → 日内分时
 *   - `quote.history(args)`          → 日 K 历史
 *   - `ledger.get(args)`             → 只读台账快照
 *
 * 设计要点：
 *   - `quote.*` 内部按标的口径路由数据源：优先用脚本显式传入的 `type`，否则回查
 *     `ledger.list()` 中该标的的 `type`，最后交由 `QuoteClient` 按代码前缀推断。
 *   - 入参/出参均为无损 JSON（经 {@link toJsonValue} 清洗）。
 *   - ⚠️ 运行时绑定成员是**单参数**函数（见 `types.ts` 说明）：脚本应传单个对象/数组。
 *     为最大兼容，参数解析同时接受：纯字符串、`{ symbol, type?, days? }`、`[symbol, ...]`。
 */
import type { Ledger } from '../domain/ledger.js'
import type { AssetType } from '../domain/types.js'
import type { QuoteClient } from '../lib/quotes.js'
import { toJsonValue } from './json.js'
import type { PtcBindingNamespace, PtcJsonValue } from './types.js'

/** 组装 bindings 所需的数据源。 */
export interface SensorBindingSources {
  /** 台账域（只读：list / query）。 */
  ledger: Pick<Ledger, 'list' | 'query'>
  /** 行情客户端（按 type 路由）。 */
  quotes: Pick<QuoteClient, 'realtime' | 'intraday' | 'history'>
}

/** 三个命名空间的全局名（验收点 2）。 */
export const SENSOR_BINDING_GLOBALS = ['symbols', 'quote', 'ledger'] as const

/** 只读方法清单（验收点 2：只暴露这 5 个，无写方法）。 */
export const SENSOR_READONLY_METHODS = [
  'symbols.list',
  'quote.realtime',
  'quote.intraday',
  'quote.history',
  'ledger.get',
] as const

/** `quote.history` 未显式给 days 时的默认交易日数。 */
export const DEFAULT_HISTORY_DAYS = 60

/** 取对象形态入参。 */
function asObject(args: unknown): Record<string, unknown> | undefined {
  return typeof args === 'object' && args !== null && !Array.isArray(args)
    ? (args as Record<string, unknown>)
    : undefined
}

/** 取非空字符串。 */
function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}

/** 从多种入参形态解出 symbol。 */
function symbolOf(args: unknown): string | undefined {
  const direct = asNonEmptyString(args)
  if (direct) return direct
  if (Array.isArray(args)) return asNonEmptyString(args[0])
  const obj = asObject(args)
  return obj ? asNonEmptyString(obj.symbol) : undefined
}

/** 从入参解出显式 type（仅接受 'etf' / 'stock'）。 */
function typeOf(args: unknown): AssetType | undefined {
  const obj = asObject(args)
  const t = obj?.type
  return t === 'etf' || t === 'stock' ? t : undefined
}

/** 从多种入参形态解出 days。 */
function daysOf(args: unknown, fallback: number): number {
  const candidates: unknown[] = []
  if (Array.isArray(args)) candidates.push(args[1])
  const obj = asObject(args)
  if (obj) candidates.push(obj.days)
  for (const raw of candidates) {
    const n = typeof raw === 'string' ? Number(raw) : raw
    if (typeof n === 'number' && Number.isFinite(n) && n > 0) return Math.floor(n)
  }
  return fallback
}

/** 校验并取 symbol，缺失时抛错（错误经 ptc-runtime 以 binding 拒绝形式回传脚本）。 */
function requireSymbol(caller: string, args: unknown): string {
  const symbol = symbolOf(args)
  if (!symbol) throw new Error(`${caller}: 缺少 symbol 参数`)
  return symbol
}

/**
 * 组装感知脚本的只读 bindings。
 *
 * @param sources 数据源（台账域 + 行情客户端）。
 * @returns 三个命名空间（symbols / quote / ledger）的只读绑定。
 */
export function createSensorBindings(sources: SensorBindingSources): PtcBindingNamespace[] {
  const { ledger, quotes } = sources

  /** 回查标的 type（脚本未显式传入时的兜底路由信息）。 */
  const ledgerType = (symbol: string): AssetType | undefined => {
    try {
      return ledger.list().find((s) => s.symbol === symbol)?.type
    } catch {
      return undefined
    }
  }

  const symbols: PtcBindingNamespace = {
    global: 'symbols',
    functions: {
      list: async (): Promise<PtcJsonValue> => toJsonValue(ledger.list()),
    },
  }

  const quote: PtcBindingNamespace = {
    global: 'quote',
    functions: {
      realtime: async (args): Promise<PtcJsonValue> => {
        const symbol = requireSymbol('quote.realtime', args)
        const type = typeOf(args) ?? ledgerType(symbol)
        return toJsonValue(await quotes.realtime(symbol, type))
      },
      intraday: async (args): Promise<PtcJsonValue> => {
        const symbol = requireSymbol('quote.intraday', args)
        const type = typeOf(args) ?? ledgerType(symbol)
        return toJsonValue(await quotes.intraday(symbol, type))
      },
      history: async (args): Promise<PtcJsonValue> => {
        const symbol = requireSymbol('quote.history', args)
        const type = typeOf(args) ?? ledgerType(symbol)
        const days = daysOf(args, DEFAULT_HISTORY_DAYS)
        return toJsonValue(await quotes.history(symbol, days, type))
      },
    },
  }

  const ledgerNs: PtcBindingNamespace = {
    global: 'ledger',
    functions: {
      get: async (args): Promise<PtcJsonValue> => {
        const symbol = requireSymbol('ledger.get', args)
        return toJsonValue(ledger.query(symbol))
      },
    },
  }

  return [symbols, quote, ledgerNs]
}
