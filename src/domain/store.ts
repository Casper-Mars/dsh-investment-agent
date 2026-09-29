/**
 * domain 层本地 JSON 存储封装。
 *
 * 存储选型：JSON 文件优先（本地轻量、无原生依赖、易归档迁移）。
 * 按 `symbol` 隔离：每个标的落一个目录，目录下每个「表」各一个 JSON 文件。
 *
 * 目录结构（示例，标 `588000` / `000001`）：
 * ```
 * data/
 *   ledger/
 *     588000/
 *       symbols.json     # { symbol, name, type, init_price }
 *       positions.json   # { symbol, qty, avg_cost }
 *       accounts.json    # { symbol, cash, realized_pnl, float_pnl }
 *       trades.json      # Trade[]
 *       predictions.json # Prediction[]
 *       reviews.json     # Review[]
 *       metrics.json     # Metric[]
 *       thresholds.json  # Thresholds
 *       strategy.json    # Strategy
 *     000001/ ...
 * ```
 *
 * 读写接口设计为「可被后续 tools / runner 复用」：底层暴露泛型的
 * `readTable` / `writeTable`，上层按业务表封装带类型的读写函数。
 *
 * 注意：本模块只依赖 `node:fs` / `node:path`，不接触 dsh/cordis API。
 */
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  existsSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type {
  AssetType,
  PositionSnapshot,
  SymbolSnapshot,
  Thresholds,
  Trade,
} from './types.js'

/** 台账相关的九张表名（对应详细设计 §7.1）。 */
export type LedgerTable =
  | 'symbols'
  | 'positions'
  | 'accounts'
  | 'trades'
  | 'predictions'
  | 'reviews'
  | 'metrics'
  | 'thresholds'
  | 'strategy'

/** 标的元数据（symbols 表）。 */
export interface SymbolRecord {
  symbol: string
  name?: string
  type: AssetType
  initPrice: number
}

/** 持仓记录（positions 表）。 */
export interface PositionRecord {
  symbol: string
  qty: number
  avgCost: number
}

/** 资金账户记录（accounts 表）。 */
export interface AccountRecord {
  symbol: string
  cash: number
  realizedPnl: number
  floatPnl: number
}

/**
 * 存储封装：所有读写落在 `dataRoot` 下，按 symbol 隔离目录。
 *
 * @param dataRoot 数据根目录；台账数据落 `${dataRoot}/ledger/<symbol>/<table>.json`。
 */
export class JsonStore {
  constructor(private readonly dataRoot: string) {}

  /** 台账目录根。 */
  private get ledgerRoot(): string {
    return join(this.dataRoot, 'ledger')
  }

  /** 某标的的目录。 */
  symbolDir(symbol: string): string {
    return join(this.ledgerRoot, symbol)
  }

  /** 某标的某张表的文件路径。 */
  tablePath(symbol: string, table: LedgerTable): string {
    return join(this.symbolDir(symbol), `${table}.json`)
  }

  /** 确保某标的目录存在，返回目录路径。 */
  ensureSymbolDir(symbol: string): string {
    const dir = this.symbolDir(symbol)
    mkdirSync(dir, { recursive: true })
    return dir
  }

  /** 读某标的某张表（不存在返回 undefined）。 */
  readTable<T>(symbol: string, table: LedgerTable): T | undefined {
    const path = this.tablePath(symbol, table)
    try {
      const raw = readFileSync(path, 'utf8')
      return JSON.parse(raw) as T
    } catch {
      return undefined
    }
  }

  /** 写某标的某张表（自动建目录，ensure 序列化）。 */
  writeTable<T>(symbol: string, table: LedgerTable, value: T): void {
    const path = this.tablePath(symbol, table)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, JSON.stringify(value, null, 2), 'utf8')
  }

  /** 列出所有已初始化的标的（存在 symbols 表的目录）。 */
  listSymbolDirs(): string[] {
    if (!existsSync(this.ledgerRoot)) return []
    try {
      return readdirSync(this.ledgerRoot).filter((e) =>
        statSync(join(this.ledgerRoot, e)).isDirectory(),
      )
    } catch {
      return []
    }
  }
}

/**
 * 台账读取工具（供 ledger 及后续 tools/runner 使用）。
 * 封装「按 symbol 隔离」的各业务表读写，返回结构化的领域对象。
 */
export class LedgerStore {
  constructor(private readonly store: JsonStore) {}

  // ---- symbols ----
  getSymbol(symbol: string): SymbolRecord | undefined {
    return this.store.readTable<SymbolRecord>(symbol, 'symbols')
  }

  saveSymbol(rec: SymbolRecord): void {
    this.store.writeTable<SymbolRecord>(rec.symbol, 'symbols', rec)
  }

  // ---- positions ----
  getPosition(symbol: string): PositionRecord | undefined {
    return this.store.readTable<PositionRecord>(symbol, 'positions')
  }

  savePosition(rec: PositionRecord): void {
    this.store.writeTable<PositionRecord>(rec.symbol, 'positions', rec)
  }

  // ---- accounts ----
  getAccount(symbol: string): AccountRecord | undefined {
    return this.store.readTable<AccountRecord>(symbol, 'accounts')
  }

  saveAccount(rec: AccountRecord): void {
    this.store.writeTable<AccountRecord>(rec.symbol, 'accounts', rec)
  }

  /** 列出所有已初始化标的的 symbol。 */
  listSymbols(): string[] {
    const syms: string[] = []
    for (const dir of this.store.listSymbolDirs()) {
      const rec = this.store.readTable<SymbolRecord>(dir, 'symbols')
      if (rec) syms.push(rec.symbol)
    }
    return syms
  }

  // ---- trades ----
  getTrades(symbol: string): Trade[] {
    return this.store.readTable<Trade[]>(symbol, 'trades') ?? []
  }

  appendTrade(symbol: string, trade: Trade): void {
    const trades = this.getTrades(symbol)
    trades.push(trade)
    this.store.writeTable<Trade[]>(symbol, 'trades', trades)
  }

  // ---- thresholds ----
  getThresholds(symbol: string): Thresholds | undefined {
    return this.store.readTable<Thresholds>(symbol, 'thresholds')
  }

  saveThresholds(symbol: string, thresholds: Thresholds): void {
    this.store.writeTable<Thresholds>(symbol, 'thresholds', thresholds)
  }
}

/** 生成交易流水 id（本地唯一，无需外部依赖）。 */
export function newTradeId(): string {
  return `t_${randomUUID().replaceAll('-', '')}`
}

// Re-export common domain types for downstream convenience.
export type { AssetType, PositionSnapshot, SymbolSnapshot, Thresholds, Trade }