/**
 * Agent 工具层：台账域工具（ledger_init / ledger_list / ledger_query / ledger_trade）。
 *
 * execute 一律走 domain/ledger 的 {@link Ledger}（本地 CRUD，无 HTTP 层）。
 *
 * 字段映射策略（蛇形 ↔ 驼峰）：
 *   domain 返回驼峰（avgCost / realizedPnl / floatPnl / tradeId / newQty），
 *   详细设计 §4.1 契约用下划线（avg_cost / realized_pnl / float_pnl /
 *   trade_id / new_qty）。本工具层在 execute 内做**显式蛇形映射**，
 *   output.schema 与 execute 返回统一用蛇形，逐字段对齐（lossless JSON）。
 *
 * 返回形态：
 *   写类工具（init / trade）成功返回 `{ ok, ... }`；读类工具（list / query）
 *   返回无 ok 字段的数据对象（对照 §4.1 契约表）。错误不返回 `{ ok:false }`，
 *   而是 throw（registry 归一为 isError，跳过 schema 校验），见 ./error.ts。
 *
 * exec.signal 可中断：写操作（init / trade）在落账前检查 `exec.signal.aborted`，
 *   中断即抛出（不产生半写状态）。
 */
import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { AssetType, PositionSnapshot, Side, SymbolSnapshot } from '../domain/ledger.js'
import type { ToolContext } from './context.js'
import type { LedgerPosition, LedgerSymbol } from './types.js'
import { assertNotAborted, throwIfFailed, throwToolError } from './error.js'
import { withDisclaimer } from './constants.js'
import {
  ledgerInitResultSchema,
  ledgerListResultSchema,
  ledgerQueryResultSchema,
  ledgerTradeResultSchema,
} from './schemas.js'

/** 蛇形映射：PositionSnapshot → LedgerPosition。 */
function toLedgerPosition(s: PositionSnapshot): LedgerPosition {
  return {
    symbol: s.symbol,
    type: s.type,
    name: s.name ?? null,
    qty: s.qty,
    avg_cost: s.avgCost,
    cash: s.cash,
    realized_pnl: s.realizedPnl,
    float_pnl: s.floatPnl,
  }
}

/** 蛇形映射：SymbolSnapshot → LedgerSymbol。 */
function toLedgerSymbol(s: SymbolSnapshot): LedgerSymbol {
  return {
    symbol: s.symbol,
    type: s.type,
    name: s.name ?? null,
    qty: s.qty,
    avg_cost: s.avgCost,
  }
}

/** ledger_init：新增标的 + 初始持仓 / 成本 / 资金。 */
export function createLedgerInitTool(ctx: ToolContext): ToolDefinition {
  return defineTool({
    name: 'ledger_init',
    description:
      '新增一个标的并建立初始持仓、成本与资金账户。symbol 重复将报错。' +
      '初始 qty 必须为 100 整数倍（份/股）。写操作，按 symbol 隔离。',
    parameters: {
      symbol: { type: 'string', required: true, description: '标的代码（如 588000 / 000001）' },
      type: {
        type: 'string',
        enum: ['etf', 'stock'],
        required: true,
        description: '标的类型：etf（份）/ stock（股）',
      },
      name: { type: 'string', description: '标的名称（可选）' },
      init_qty: { type: 'number', required: true, description: '初始持仓数量（100 整数倍）' },
      init_cost: { type: 'number', required: true, description: '初始成本（每股/份）' },
      init_cash: { type: 'number', required: true, description: '初始资金' },
    },
    output: {
      schema: ledgerInitResultSchema,
      render: (_args, value) => [
        { type: 'text', text: `✅ 已初始化标的 ${value.symbol}` },
      ],
    },
    async execute(args, exec) {
      assertNotAborted(exec.signal)
      try {
        ctx.ledger.init(args.symbol, {
          type: args.type as AssetType,
          name: args.name,
          qty: args.init_qty,
          cost: args.init_cost,
          cash: args.init_cash,
        })
        return { ok: true as const, symbol: args.symbol }
      } catch (err) {
        throwToolError(err)
      }
    },
  })
}

/** ledger_list：列标的清单 + 持仓快照。 */
export function createLedgerListTool(ctx: ToolContext): ToolDefinition {
  return defineTool({
    name: 'ledger_list',
    description:
      '列出全部已初始化标的及各自持仓快照（symbol / type / name / qty / avg_cost）。只读操作。',
    parameters: {},
    output: {
      schema: ledgerListResultSchema,
      render: (_args, value) => {
        const lines = value.symbols.map(
          (s, i) =>
            `${i + 1}. ${s.symbol} [${s.type}] ${s.name ?? ''} — qty=${s.qty} avg_cost=${s.avg_cost}`,
        )
        const text =
          value.symbols.length === 0
            ? '暂无标的。'
            : `共 ${value.symbols.length} 个标的：\n${lines.join('\n')}`
        return [{ type: 'text', text }]
      },
    },
    async execute() {
      const snapshots = ctx.ledger.list()
      return { symbols: snapshots.map(toLedgerSymbol) }
    },
  })
}

/** ledger_query：读单标台账快照。 */
export function createLedgerQueryTool(ctx: ToolContext): ToolDefinition {
  return defineTool({
    name: 'ledger_query',
    description:
      '读取单个标的的完整台账快照（持仓 / 成本 / 现金 / 已实现盈亏 / 浮动盈亏）。只读操作。',
    parameters: {
      symbol: { type: 'string', required: true, description: '标的代码' },
      price: {
        type: 'number',
        description:
          '现价（可选），用于计算浮动盈亏 float_pnl=(现价−平均成本)×持仓数量；缺省则不计算（float_pnl=0）',
      },
    },
    output: {
      schema: ledgerQueryResultSchema,
      render: (_args, value) => [
        {
          type: 'text',
          text:
            `${value.symbol} [${value.type}] ${value.name ?? ''}\n` +
            `持仓：${value.qty}  平均成本：${value.avg_cost}\n` +
            `现金：${value.cash}  已实现盈亏：${value.realized_pnl}  浮动盈亏：${value.float_pnl}`,
        },
      ],
    },
    async execute(args) {
      const snap = ctx.ledger.query(args.symbol, args.price)
      return toLedgerPosition(snap)
    },
  })
}

/** ledger_trade：模拟成交，写流水重算成本。 */
export function createLedgerTradeTool(ctx: ToolContext): ToolDefinition {
  return defineTool({
    name: 'ledger_trade',
    description:
      '对指定标的模拟成交（买入/卖出），写交易流水并重算加权平均成本。' +
      'qty 必须为 100 整数倍；卖出数量超过当前持仓将报错。写操作，按 symbol 隔离。',
    parameters: {
      symbol: { type: 'string', required: true, description: '标的代码' },
      side: {
        type: 'string',
        enum: ['buy', 'sell'],
        required: true,
        description: '交易方向：buy（买入）/ sell（卖出）',
      },
      qty: { type: 'number', required: true, description: '成交数量（100 整数倍）' },
      price: { type: 'number', required: true, description: '成交价格' },
      reason: { type: 'string', description: '交易理由（可选）' },
    },
    output: {
      schema: ledgerTradeResultSchema,
      render: (_args, value) => [
        {
          type: 'text',
          text: withDisclaimer(
            `✅ 成交（id=${value.trade_id}）\n` +
              `新持仓：${value.new_qty}  平均成本：${value.avg_cost}`,
          ),
        },
      ],
    },
    async execute(args, exec) {
      assertNotAborted(exec.signal)
      const res = ctx.ledger.trade(args.symbol, {
        side: args.side as Side,
        qty: args.qty,
        price: args.price,
        reason: args.reason,
      })
      throwIfFailed(res)
      return {
        ok: true as const,
        trade_id: res.tradeId!,
        new_qty: res.newQty!,
        avg_cost: res.avgCost!,
      }
    },
  })
}

// 供 index 汇总使用。
export function createLedgerTools(ctx: ToolContext): ToolDefinition[] {
  return [
    createLedgerInitTool(ctx),
    createLedgerListTool(ctx),
    createLedgerQueryTool(ctx),
    createLedgerTradeTool(ctx),
  ]
}