/**
 * Agent 工具层入口：装配并注册 15 个工具（4 ledger + 3 predicts + 5 reviews + 4 sense_archives）。
 *
 * 数据访问：全部经 {@link ToolContext} 走 domain 层（本地 JSON CRUD），无 HTTP 层。
 *   domain 层仅依赖 node:fs；工具层唯一外部包依赖是 `@deepseek-ai/dsh-tools`（defineTool）。
 *
 * 注册形态：`ctx.tools.register(defineTool({...}))`。
 *
 * 加载时机：本模块及其依赖（context → domain → `@deepseek-ai/dsh-tools`）构成较重
 *   模块图，参照 dsh-tasks 的 plugin 加载策略，应由 plugin.ts 在 `apply` 内**惰性**
 *   `import('./tools/index.js')`，避免拖慢插件 fiber 激活时序（详见 plugin.ts 后续接入）。
 */
import type { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { createToolContext, type ToolContext, type ToolContextOptions } from './context.js'
import { createLedgerTools } from './ledgers.js'
import { createPredictTools } from './predicts.js'
import { createReviewTools } from './reviews.js'
import { createSenseArchiveTools } from './sense-archives.js'

/**
 * 构造 15 个工具定义（顺序即向模型暴露的顺序）：
 *   ledgers(4) → predicts(3) → reviews(5) → sense_archives(4)。
 *
 * 所有工具共享同一个 {@link ToolContext}（shared dataRoot）。
 */
export function createAllTools(ctx: ToolContext): ToolDefinition[] {
  return [
    ...createLedgerTools(ctx),
    ...createPredictTools(ctx),
    ...createReviewTools(ctx),
    ...createSenseArchiveTools(ctx),
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
 * @returns 注销器：按注册逆序注销全部工具（由调用方绑定到 `ctx.effect`）。
 */
export function registerAllTools(
  ctx: Context,
  opts: ToolContextOptions = {},
): () => void {
  const toolCtx = createToolContext(opts)
  return registerTools(ctx, createAllTools(toolCtx))
}