/**
 * Agent 工具层入口：装配并注册 15 个工具
 * （4 ledger + 2 strategy + 3 predicts + 5 reviews + 1 assets）。
 *
 * 数据访问：全部经 {@link ToolContext} 走 domain 层（本地 JSON CRUD），无 HTTP 层。
 *   domain 层仅依赖 node:fs；工具层唯一外部包依赖是 `@deepseek-ai/dsh-tools`（defineTool）。
 *
 * 资产写入语义：`asset_commit` 是 agent 写完 skill / 任务程序等资产后的统一提交入口，
 *   **写入即 commit**：只提交（不写文件），git 失败降级返回，路径非法才抛错。
 *
 * 注册形态：`ctx.tools.register(defineTool({...}))`。
 *
 * 加载时机：本模块及其依赖（context → domain → `@deepseek-ai/dsh-tools`）构成较重
 *   模块图，参照 dsh-tasks 的 plugin 加载策略，已由 plugin.ts 在 `apply` 内**惰性**
 *   `import('./tools/index.js')` 后调用 `registerAllTools(ctx)` 完成注册，避免拖慢插件
 *   fiber 激活时序；注销器绑定 `ctx.effect`，fiber 卸载（含 HMR 重载）时自动注销。
 */
import type { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { createToolContext, type ToolContext, type ToolContextOptions } from './context.js'
import { createLedgerTools } from './ledgers.js'
import { createStrategyTools } from './strategy.js'
import { createPredictTools } from './predicts.js'
import { createReviewTools } from './reviews.js'
import { createAssetTools, type AssetToolsOptions } from './assets.js'

/**
 * 构造 15 个工具定义（顺序即向模型暴露的顺序）：
 *   ledgers(4) → strategy(2) → predicts(3) → reviews(5) → assets(1)。
 *
 * 所有工具共享同一个 {@link ToolContext}（shared dataRoot）。
 *
 * @param ctx 共享工具上下文。
 * @param assetOptions assets 域可选注入（资产目录 / git 执行器 / 日志；测试用）。
 */
export function createAllTools(
  ctx: ToolContext,
  assetOptions: AssetToolsOptions = {},
): ToolDefinition[] {
  return [
    ...createLedgerTools(ctx),
    ...createStrategyTools(ctx),
    ...createPredictTools(ctx),
    ...createReviewTools(ctx),
    ...createAssetTools(assetOptions),
  ]
}

/** 在上下文中注册给定工具集，返回注销器（按注册逆序注销）。 */
function registerTools(ctx: Context, tools: ToolDefinition[]): () => void {
  const disposers = tools.map((tool) => ctx.tools.register(tool))
  return () => {
    for (let i = disposers.length - 1; i >= 0; i -= 1) disposers[i]?.()
  }
}

/**
 * 在当前上下文注册全部 15 个工具，返回注销器。
 *
 * @param ctx 插件上下文（已 `inject = ['tools', ...]`，`ctx.tools` 就绪）。
 * @param opts 数据根目录配置；默认 `createToolContext()`（dataRoot 取环境变量 / 默认值）。
 * @param assetOptions assets 域可选注入（资产目录 / git 执行器 / 日志）。
 * @returns 注销器：按注册逆序注销全部工具（由调用方绑定到 `ctx.effect`）。
 */
export function registerAllTools(
  ctx: Context,
  opts: ToolContextOptions = {},
  assetOptions: AssetToolsOptions = {},
): () => void {
  const toolCtx = createToolContext(opts)
  return registerTools(ctx, createAllTools(toolCtx, assetOptions))
}
