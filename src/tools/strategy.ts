/**
 * Agent 工具层：策略域工具（strategy_get / strategy_set）。
 *
 * execute 一律走 domain/strategy 的 {@link StrategyRegistry}（本地 CRUD，无 HTTP 层）。
 *
 * 语义（对齐详细设计 §10.8）：
 *   策略是**你（agent）为该标的设定的**文本文档；首版凭经验生成，复盘后迭代。
 *   版本不可变：每次 strategy_set 都产生新版本（v001 → v002 → …），历史版本
 *   只读，current 指针始终指向最新版。
 *
 * 字段映射策略：domain 返回驼峰（meta.ts / meta.parent），§10.8 契约用下划线
 *   （updated_at / parent_version）。本工具层在 execute 内做**显式蛇形映射**，
 *   output.schema 与 execute 返回统一用蛇形，逐字段对齐（lossless JSON）。
 *
 * 返回形态：
 *   写类工具（strategy_set）成功返回 `{ ok, version }`；读类工具（strategy_get）
 *   返回无 ok 字段的数据对象（对照 §10.8 契约表）。错误不返回 `{ ok:false }`,
 *   而是 throw（registry 归一为 isError，跳过 schema 校验），见 ./error.ts。
 *
 * 行为约定：
 *   - strategy_set 要求标的已 `ledger_init` 注册（否则抛错）；
 *   - strategy_set 的 parent_version 与当前版不一致时，domain 抛冲突错误，
 *     工具层不吞掉该错误（防并发覆盖）；
 *   - strategy_get 在标的尚无策略文档时抛清晰可读的引导错误。
 *
 * exec.signal 可中断：写操作（strategy_set）落盘前检查 signal.aborted，中断即
 *   抛出（不产生半写状态）。
 */
import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { ToolContext } from './context.js'
import { assertNotAborted, throwToolError } from './error.js'
import { withDisclaimer } from './constants.js'
import {
  strategyGetResultSchema,
  strategySetResultSchema,
} from './schemas.js'

/** strategy_get：读取某标的的策略文档（默认当前版，可指定历史版本）。 */
export function createStrategyGetTool(ctx: ToolContext): ToolDefinition {
  return defineTool({
    name: 'strategy_get',
    description:
      '读取你（agent）为某标的设定的策略文档（Markdown）。默认返回当前版，可用 ' +
      'version 指定历史版本。策略是**你为该标的设定的**文本文档：首版凭经验生成，' +
      '复盘后迭代；版本不可变。只读操作。',
    parameters: {
      symbol: { type: 'string', required: true, description: '标的代码' },
      version: { type: 'string', description: '版本号（vNNN，可选；缺省取当前版）' },
    },
    output: {
      schema: strategyGetResultSchema,
      render: (_args, value) => [
        {
          type: 'text',
          text: `策略 ${value.symbol}（${value.version}，更新于 ${value.updated_at}）：\n${value.text}`,
        },
      ],
    },
    async execute(args) {
      try {
        const full = ctx.strategy.get(args.symbol, args.version)
        if (!full) {
          throwToolError(
            new Error(
              `[strategy] ${args.symbol} 尚无策略文档，请先调用 strategy_set 设定首版`,
            ),
          )
        }
        return {
          symbol: full.symbol,
          text: full.text,
          version: full.version,
          updated_at: full.meta.ts,
        }
      } catch (err) {
        throwToolError(err)
      }
    },
  })
}

/** strategy_set：写入策略文档的新版本（首版 v001 / 迭代版本需带 parent_version）。 */
export function createStrategySetTool(ctx: ToolContext): ToolDefinition {
  return defineTool({
    name: 'strategy_set',
    description:
      '为某标的写入策略文档（Markdown）的新版本。策略是**你（agent）为该标的设定的**' +
      '文本文档：首版凭经验生成（不带 parent_version），复盘后迭代（parent_version 必填 ' +
      '且须等于当前版）；版本不可变（历史版本只读）。标的须已 ledger_init 注册。写操作。',
    parameters: {
      symbol: { type: 'string', required: true, description: '标的代码（须已台账注册）' },
      text: { type: 'string', required: true, description: '策略文档正文（Markdown）' },
      rationale: { type: 'string', required: true, description: '本版理由（为什么这么写 / 迭代原因）' },
      parent_version: { type: 'string', description: '上一版本号（非首版必填；首版省略）' },
    },
    output: {
      schema: strategySetResultSchema,
      render: (_args, value) => [
        {
          type: 'text',
          text: withDisclaimer(`✅ 已保存策略版本 ${value.version}`),
        },
      ],
    },
    async execute(args, exec) {
      assertNotAborted(exec.signal)
      try {
        // 标的必须已在台账注册（先 ledger_init）。
        const registered = ctx.ledger
          .list()
          .some((s) => s.symbol === args.symbol)
        if (!registered) {
          throwToolError(
            new Error(
              `[strategy] 标的 ${args.symbol} 尚未在台账注册，请先调用 ledger_init`,
            ),
          )
        }
        const version = ctx.strategy.set(args.symbol, {
          text: args.text,
          rationale: args.rationale,
          parentVersion: args.parent_version,
        })
        return { ok: true as const, version }
      } catch (err) {
        throwToolError(err)
      }
    },
  })
}

/** 供 index 汇总使用。 */
export function createStrategyTools(ctx: ToolContext): ToolDefinition[] {
  return [createStrategyGetTool(ctx), createStrategySetTool(ctx)]
}
