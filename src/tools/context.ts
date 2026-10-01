/**
 * Agent 工具层：ToolContext 工厂 —— dataRoot 统一注入点。
 *
 * 18 个工具需共享同一份数据根目录。本工厂在构造时：
 *   1. 解析 dataRoot（构造注入优先，缺省回退到环境变量
 *      `DSH_FINANCE_DATA_DIR`，再回退到 `<cwd>/.dsh-finance/data`）；
 *   2. 用该 dataRoot 实例化五个 domain 类（Ledger / Predicts / Reviews /
 *      SenseRegistry / StrategyRegistry）各一次；
 *   3. 工具闭包通过捕获这些实例共享同一数据源，保证「single dataRoot」。
 *
 * dataRoot 与 plugin 层衔接：plugin.ts 后续可经 `ctx.get('fs')` 解析插件
 * 自有 fs/data 目录后传入（本任务先用构造注入 + 默认值）。
 *
 * 依赖约束参照 dsh-tasks：工具层唯一可依赖外部包是 `@deepseek-ai/dsh-tools`
 * （defineTool），domain 层仅依赖 node:fs，不接触 dsh/cordis API。
 */
import { resolve } from 'node:path'
import { Ledger } from '../domain/ledger.js'
import { Predicts } from '../domain/predicts.js'
import { Reviews } from '../domain/reviews.js'
import { SenseRegistry } from '../domain/sense-registry.js'
import { StrategyRegistry } from '../domain/strategy.js'
import { JsonStore } from '../domain/store.js'
import type { AssetType, Thresholds } from '../domain/types.js'

/** 环境变量：覆盖默认数据根目录。 */
export const DATA_ROOT_ENV = 'DSH_FINANCE_DATA_DIR'

/** 默认数据根目录（相对 cwd）。 */
export const DEFAULT_DATA_DIR = '.dsh-finance/data'

/**
 * 可选行情源（用于 review_metrics 的「现价」）。
 * 缺省不注入时，cum_return 的现价回落为台账最近成交价（确定性，无网络）。
 */
export interface QuotePriceSource {
  realtime(symbol: string, type?: AssetType): Promise<{ price: number; status: string }>
}

/** 默认阈值（标的未显式配置时回落）。 */
export const DEFAULT_THRESHOLDS: Thresholds = {
  dirHitMin: 0.6,
  cumReturnMin: 0,
  missStreakMax: 3,
}

/** 领域类实例容器：18 个工具闭包共享。 */
export interface ToolContext {
  /** 数据根目录（绝对路径）。 */
  readonly dataRoot: string
  /** 台账域。 */
  readonly ledger: Ledger
  /** 预测域。 */
  readonly predicts: Predicts
  /** 复盘域。 */
  readonly reviews: Reviews
  /** 感知版本注册表。 */
  readonly senseRegistry: SenseRegistry
  /** 策略文档注册表。 */
  readonly strategy: StrategyRegistry
  /** 可选行情源（用于 review_metrics 现价；缺省时不注入）。 */
  readonly quotes?: QuotePriceSource
  /** 读标的阈值配置（无则返回默认阈值）。 */
  getThresholds(symbol: string): Thresholds
  /**
   * 解析标的现价（用于 cum_return 的期末市值）。
   * 注入了行情源时取实时价（不可用则回落最近成交价）；未注入时直接回落。
   */
  resolvePrice(symbol: string): Promise<number | undefined>
}

/** 构造参数。 */
export interface ToolContextOptions {
  /** 数据根目录（可选）；省略时依次取环境变量 → 默认值。 */
  dataRoot?: string
  /** 可选行情源（用于 review_metrics 现价）；省略时不注入。 */
  quotes?: QuotePriceSource
}

/** 解析数据根目录（构造注入 > 环境变量 > 默认值）。 */
function resolveDataRoot(explicit?: string): string {
  if (explicit && explicit.trim() !== '') return resolve(explicit)
  const env = process.env[DATA_ROOT_ENV]
  if (env && env.trim() !== '') return resolve(env)
  return resolve(process.cwd(), DEFAULT_DATA_DIR)
}

/**
 * 构造 ToolContext：注入 dataRoot，实例化五大 domain 类。
 *
 * @param opts 数据根目录配置。
 * @returns 共享同一 dataRoot 的领域实例容器。
 */
export function createToolContext(opts: ToolContextOptions = {}): ToolContext {
  const dataRoot = resolveDataRoot(opts.dataRoot)
  const store = new JsonStore(dataRoot)
  const ledger = new Ledger(dataRoot)
  const quotes = opts.quotes
  return {
    dataRoot,
    ledger,
    predicts: new Predicts(dataRoot),
    reviews: new Reviews(dataRoot, ledger),
    senseRegistry: new SenseRegistry(dataRoot),
    strategy: new StrategyRegistry(dataRoot),
    quotes,
    getThresholds(symbol: string): Thresholds {
      const t = store.readTable<Thresholds>(symbol, 'thresholds')
      return t ?? DEFAULT_THRESHOLDS
    },
    async resolvePrice(symbol: string): Promise<number | undefined> {
      if (!quotes) return undefined
      try {
        const q = await quotes.realtime(symbol)
        if (q && q.price > 0) return q.price
      } catch {
        // 行情不可用：回落为缺省（最近成交价）。
      }
      return undefined
    },
  }
}