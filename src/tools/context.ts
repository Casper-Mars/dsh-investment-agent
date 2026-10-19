/**
 * Agent 工具层：ToolContext 工厂 —— dataRoot 统一注入点。
 *
 * 15 个工具需共享同一份数据根目录。本工厂在构造时：
 *   1. 解析 dataRoot（构造注入优先，缺省回退到环境变量
 *      `DSH_IA_DATA_DIR`，再回退到 `~/.dsh-ia/data`）；
 *   2. 用该 dataRoot 实例化 Ledger / Predicts / Reviews；StrategyRegistry 使用
 *      资产层根目录 `resolveAssetsDir()`（策略是资产，版本由 assets git 仓库承担）；
 *   3. 工具闭包通过捕获这些实例共享同一数据源，保证「single dataRoot」。
 *
 * dataRoot 与 plugin 层衔接：plugin.ts 后续可经 `ctx.get('fs')` 解析插件
 * 自有 fs/data 目录后传入（本任务先用构造注入 + 默认值）。
 *
 * 默认值不再锚定 `process.cwd()`（历史漂移问题），固定到 {@link DEFAULT_DATA_DIR}
 * 指向的 `~/.dsh-ia/data`。
 *
 * 依赖约束参照 dsh-tasks：工具层唯一可依赖外部包是 `@deepseek-ai/dsh-tools`
 * （defineTool），domain 层仅依赖 node:fs，不接触 dsh/cordis API。
 */
import { Ledger } from '../domain/ledger.js'
import { Predicts } from '../domain/predicts.js'
import { Reviews } from '../domain/reviews.js'
import { parseStrategyDoc, StrategyRegistry } from '../domain/strategy.js'
import { JsonStore } from '../domain/store.js'
import type { Thresholds } from '../domain/types.js'
import { resolveAssetsDir, resolveDataRoot } from '../paths.js'
import { createLogger } from '../log/logger.js'

/** 策略阈值解析日志出口（统一门面；无 `ctx` 注入位，走降级实现）。 */
const strategyLog = createLogger('dsh-ia:strategy')

/**
 * 环境变量：覆盖默认数据根目录。
 *
 * 定义于叶子模块 `src/paths.ts`（便于 skill 资产层复用同一解析），此处重新导出
 * 以保持既有导入路径（`../src/tools/context.js`）不变。
 */
export { DATA_ROOT_ENV } from '../paths.js'

/** 默认数据根目录（固定 `~/.dsh-ia/data`，由 {@link ensureFinanceDataDir} 确保存在）。 */
export const DEFAULT_DATA_DIR = '.dsh-ia/data'

/** 默认阈值（标的未显式配置时回落）。 */
export const DEFAULT_THRESHOLDS: Thresholds = {
  dirHitMin: 0.6,
  cumReturnMin: 0,
  missStreakMax: 3,
}

/** 取有限数（否则 undefined）。 */
function finiteNumber(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}

/**
 * 将策略文档 front-matter 的 `thresholds.*` 映射为 `Thresholds`。
 * 逐键校验：必须是有限数（拒 NaN / ±Infinity）；`dir_hit_min` 额外要求 ∈ [0,1]；
 * `miss_streak_max` 额外要求非负整数（`Number.isInteger`）；`cum_return_min` 允许负数。
 * 非法/缺失键回落默认。`thresholds` 非对象时返回 undefined（交由下一优先级回落）。
 */
function thresholdsFromFrontmatter(fm: unknown): Thresholds | undefined {
  if (fm === null || typeof fm !== 'object' || Array.isArray(fm)) return undefined
  const map = fm as Record<string, unknown>

  const result: Thresholds = { ...DEFAULT_THRESHOLDS }

  const dir = finiteNumber(map.dir_hit_min)
  if (dir !== undefined && dir >= 0 && dir <= 1) result.dirHitMin = dir

  const cum = finiteNumber(map.cum_return_min)
  if (cum !== undefined) result.cumReturnMin = cum

  const miss = finiteNumber(map.miss_streak_max)
  if (miss !== undefined && miss >= 0 && Number.isInteger(miss)) result.missStreakMax = miss

  return result
}

/** 领域类实例容器：15 个工具闭包共享。 */
export interface ToolContext {
  /** 数据根目录（绝对路径）。 */
  readonly dataRoot: string
  /** 台账域。 */
  readonly ledger: Ledger
  /** 预测域。 */
  readonly predicts: Predicts
  /** 复盘域。 */
  readonly reviews: Reviews
  /** 策略文档注册表。 */
  readonly strategy: StrategyRegistry
  /**
   * 读标的阈值配置。优先级：
   *   ① 策略文档 front-matter 的 `thresholds.*`（逐键校验，非法/缺失键回落默认）；
   *   ② 旧 `ledger/<symbol>/thresholds.json`（@deprecated 兼容回落）；
   *   ③ `DEFAULT_THRESHOLDS`。
   */
  getThresholds(symbol: string): Thresholds
}

/** 构造参数。 */
export interface ToolContextOptions {
  /** 数据根目录（可选）；省略时依次取环境变量 → 默认值。 */
  dataRoot?: string
}

/**
 * 构造 ToolContext：注入 dataRoot，实例化四大 domain 类。
 *
 * @param opts 数据根目录配置。
 * @returns 共享同一 dataRoot 的领域实例容器。
 */
export function createToolContext(opts: ToolContextOptions = {}): ToolContext {
  const dataRoot = resolveDataRoot(opts.dataRoot)
  const store = new JsonStore(dataRoot)
  const ledger = new Ledger(dataRoot)
  const strategy = new StrategyRegistry(resolveAssetsDir())
  return {
    dataRoot,
    ledger,
    predicts: new Predicts(dataRoot),
    reviews: new Reviews(dataRoot, ledger),
    strategy,
    getThresholds(symbol: string): Thresholds {
      // ① 策略文档 front-matter 的 thresholds.*（最高优先级）。
      try {
        const doc = strategy.get(symbol)
        if (doc) {
          const parsed = parseStrategyDoc(doc.text)
          // front-matter 解析失败时记录告警（否则阈值静默回落默认值，故障难排查）。
          if (parsed.parseError) {
            strategyLog.warn(
              `[dsh-ia][strategy] ${symbol} 策略文档 front-matter 解析失败，阈值回落默认值：${parsed.parseError}`,
            )
          }
          // thresholds 字段存在但形态非法（非对象，如写成数组/标量）时同样告警。
          const rawThresholds = parsed.structured.thresholds
          if (
            rawThresholds !== undefined &&
            (rawThresholds === null || typeof rawThresholds !== 'object' || Array.isArray(rawThresholds))
          ) {
            strategyLog.warn(
              `[dsh-ia][strategy] ${symbol} 策略文档 thresholds 字段形态非法（应为对象），已忽略并回落默认值：${JSON.stringify(rawThresholds)}`,
            )
          }
          const t = thresholdsFromFrontmatter(rawThresholds)
          if (t) return t
        }
      } catch (err) {
        // 策略文档不可读/解析异常：记录后降级到旧表。
        strategyLog.warn(
          `[dsh-ia][strategy] ${symbol} 策略文档读取异常，阈值回落默认值：${err instanceof Error ? err.message : String(err)}`,
        )
      }

      // ② 旧 ledger/<symbol>/thresholds.json（@deprecated 兼容回落）。
      try {
        const legacy = store.readTable<Thresholds>(symbol, 'thresholds')
        if (legacy) return legacy
      } catch {
        // 旧表不可读：降级到默认。
      }

      // ③ 默认阈值。
      return { ...DEFAULT_THRESHOLDS }
    },
  }
}