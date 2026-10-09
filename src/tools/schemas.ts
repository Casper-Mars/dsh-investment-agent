/**
 * Agent 工具层：output.schema 值 schema DSL 定义。
 *
 * 本文件是工具层对「详细设计 §4 工具契约表」返回形态的独立声明。硬约束：
 *   - `output.schema` 会对**每个成功返回值**做严格校验（字段缺失 / 多余皆判失败），
 *     因此这里的 schema 必须与 `execute` 实际返回逐字段对齐；
 *   - 契约字段统一用**下划线命名**（avg_cost / hit_dir / range_hit_rate /
 *     cum_return / prediction_id / trade_id …），而 domain 层返回**驼峰**；
 *     `execute` 内部负责蛇形映射，schema 只认蛇形（详见各工具组文件注释）。
 *
 * 注意：objects 一律 `additionalProperties: false`，字段 `required: true` 收敛为
 * 精确契约；可空字段用 `oneOf(string ∨ null)` 表达。
 */

/* -------------------------------------------------------------------------- *
 * 4.x strategy 域（详细设计 §10.8）
 * -------------------------------------------------------------------------- */

/** strategy_get 成功返回：`{ symbol, text, version, updated_at }`。 */
export const strategyGetResultSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    symbol: { type: 'string', required: true, description: '标的代码' },
    text: { type: 'string', required: true, description: '策略文档正文（Markdown）' },
    version: { type: 'string', required: true, description: '版本号（vNNN）' },
    updated_at: { type: 'string', required: true, description: '该版本归档时间（ISO 8601）' },
  },
} as const

/** strategy_set 成功返回：`{ ok, version }`。 */
export const strategySetResultSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean', required: true, description: '是否落库成功（恒 true）' },
    version: { type: 'string', required: true, description: '新生成的版本号' },
  },
} as const

/* -------------------------------------------------------------------------- *
 * 4.1 ledger 域
 * -------------------------------------------------------------------------- */

/** ledger_init 成功返回：`{ ok, symbol }`。 */
export const ledgerInitResultSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean', required: true, description: '是否初始化成功（恒 true）' },
    symbol: { type: 'string', required: true, description: '新增标的代码' },
  },
} as const

/** 标的清单元素：`{ symbol, type, name, qty, avg_cost }`。 */
export const symbolSnapshotSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    symbol: { type: 'string', required: true, description: '标的代码' },
    type: {
      type: 'string',
      enum: ['etf', 'stock'],
      required: true,
      description: '标的类型（etf / stock）',
    },
    name: {
      oneOf: [{ type: 'string' }, { type: 'null' }],
      required: true,
      description: '标的名称，可为 null',
    },
    qty: { type: 'number', required: true, description: '当前持仓数量' },
    avg_cost: { type: 'number', required: true, description: '加权平均成本（4 位小数）' },
  },
} as const

/** ledger_list 成功返回：`{ symbols: SymbolSnapshot[] }`。 */
export const ledgerListResultSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    symbols: { type: 'array', items: symbolSnapshotSchema, required: true, description: '标的清单 + 持仓快照' },
  },
} as const

/** ledger_query 成功返回（单标台账快照）。 */
export const ledgerQueryResultSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    symbol: { type: 'string', required: true, description: '标的代码' },
    type: {
      type: 'string',
      enum: ['etf', 'stock'],
      required: true,
      description: '标的类型',
    },
    name: {
      oneOf: [{ type: 'string' }, { type: 'null' }],
      required: true,
      description: '标的名称，可为 null',
    },
    qty: { type: 'number', required: true, description: '当前持仓数量' },
    avg_cost: { type: 'number', required: true, description: '加权平均成本' },
    cash: { type: 'number', required: true, description: '账户现金' },
    realized_pnl: { type: 'number', required: true, description: '已实现盈亏' },
    float_pnl: {
      type: 'number',
      required: true,
      description:
        '浮动盈亏 =(现价−平均成本)×持仓数量，保留 4 位小数；未提供现价时为 0',
    },
  },
} as const

/** ledger_trade 成功返回：`{ ok, trade_id, new_qty, avg_cost }`。 */
export const ledgerTradeResultSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean', required: true, description: '是否成交成功' },
    trade_id: { type: 'string', required: true, description: '成交流水 ID' },
    new_qty: { type: 'number', required: true, description: '成交后持仓数量' },
    avg_cost: { type: 'number', required: true, description: '成交后加权平均成本' },
  },
} as const

/* -------------------------------------------------------------------------- *
 * 4.2 predicts 域
 * -------------------------------------------------------------------------- */

/** predict_make 成功返回：`{ ok, prediction_id }`。 */
export const predictMakeResultSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean', required: true, description: '是否落库成功' },
    prediction_id: { type: 'string', required: true, description: '预判记录 ID' },
  },
} as const

/** predict_verify 成功返回：`{ hit_dir, hit_range, deviation }`。 */
export const predictVerifyResultSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    hit_dir: { type: 'boolean', required: true, description: '方向是否命中' },
    hit_range: { type: 'boolean', required: true, description: '区间是否命中' },
    deviation: { type: 'number', required: true, description: '偏差（区间命中为 0，否则为越界距离，恒非负）' },
  },
} as const

/** 预判原文：`{ dir, range_low, range_high, confidence, watch_points }`。 */
export const predictionSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    dir: {
      type: 'string',
      enum: ['up', 'down', 'flat'],
      required: true,
      description: '预测方向（up / down / flat）',
    },
    range_low: { type: 'number', required: true, description: '区间下沿（预测最低价）' },
    range_high: { type: 'number', required: true, description: '区间上沿（预测最高价）' },
    confidence: { type: 'number', required: true, description: '置信度（0-1）' },
    watch_points: { type: 'array', items: { type: 'string' }, required: true, description: '观察点列表' },
  },
} as const

/** predict_get 成功返回：`{ prediction: {...} | null }`。 */
export const predictGetResultSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    prediction: {
      oneOf: [predictionSchema, { type: 'null' }],
      required: true,
      description: '预判原文；无记录为 null',
    },
  },
} as const

/* -------------------------------------------------------------------------- *
 * 4.3 reviews 域
 * -------------------------------------------------------------------------- */

/** review_check 成功返回：`{ decision_triggered, decision_executed, notes }`。 */
export const reviewCheckResultSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    decision_triggered: { type: 'boolean', required: true, description: '前一日决策是否触发' },
    decision_executed: { type: 'boolean', required: true, description: '决策是否执行' },
    notes: { type: 'string', required: true, description: '校验说明' },
  },
} as const

/** review_report 成功返回：`{ ok, report_id }`。 */
export const reviewReportResultSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean', required: true, description: '是否落库成功' },
    report_id: { type: 'string', required: true, description: '复盘记录 ID' },
  },
} as const

/** 复盘回读项：`{ date, report, summary }`。 */
export const reviewReportItemSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    date: { type: 'string', required: true, description: '复盘对应交易日 YYYY-MM-DD' },
    report: { type: 'string', required: true, description: '复盘正文（markdown）' },
    summary: { type: 'string', required: true, description: '复盘摘要' },
  },
} as const

/** review_get 成功返回：`{ reports: ReviewReportItem[] }`。 */
export const reviewGetResultSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    reports: { type: 'array', items: reviewReportItemSchema, required: true, description: '复盘列表（单日/全量）' },
  },
} as const

/** 逐日统计项（history 元素）。 */
export const metricSnapshotSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    symbol: { type: 'string', required: true, description: '标的代码' },
    date: { type: 'string', required: true, description: '统计截止交易日' },
    dir_hit_rate: { type: 'number', required: true, description: '方向命中率（0-1）' },
    range_hit_rate: { type: 'number', required: true, description: '区间命中率（0-1）' },
    cum_return: {
      type: 'number',
      required: true,
      description:
        '累计收益率；即时计算路径（无 metrics 缓存）下本字段恒为 0（历史逐日累计收益需逐日重放流水，成本高，暂不回填），勿误认为当日亏损，真实累计收益见顶层 cum_return；有缓存时为缓存快照的真实值',
    },
  },
} as const

/** review_metrics 成功返回。 */
export const reviewMetricsResultSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    dir_hit_rate: { type: 'number', required: true, description: '方向命中率（0-1）' },
    range_hit_rate: { type: 'number', required: true, description: '区间命中率（0-1）' },
    cum_return: {
      type: 'number',
      required: true,
      description: '累计收益率（真实值，验收口径 cumReturnOnCapital；无台账/无流水时回落 0）',
    },
    history: { type: 'array', items: metricSnapshotSchema, required: true, description: '逐日统计历史' },
  },
} as const

/** review_retrospect 成功返回：`{ root_cause, improvements }`。 */
export const reviewRetrospectResultSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    root_cause: { type: 'string', required: true, description: '根因定位描述' },
    improvements: { type: 'array', items: { type: 'string' }, required: true, description: '改进建议列表' },
  },
} as const