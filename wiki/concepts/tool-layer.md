# 工具层

> 15 个金融工具 + 7 个定时任务工具，全部经 `defineTool` 定义、`ctx.tools.register` 注册；输入输出用蛇形字段，错误用 throw 表达。

## 金融工具（15）

| 组 | 工具 | 读写 |
|---|---|---|
| 台账 `src/tools/ledgers.ts` | `ledger_init` / `ledger_list` / `ledger_query` / `ledger_trade` | 2 写 2 读 |
| 策略 `src/tools/strategy.ts` | `strategy_get` / `strategy_set` | 1 写 1 读 |
| 预判 `src/tools/predicts.ts` | `predict_make` / `predict_verify` / `predict_get` | 1 写 2 读 |
| 复盘 `src/tools/reviews.ts` | `review_check` / `review_report` / `review_get` / `review_metrics` / `review_retrospect` | 1 写 4 读 |
| 资产 `src/tools/assets.ts` | `asset_commit` | 1 写（只提交，不写文件） |

定时任务工具见 [[concepts/scheduler|定时任务层]]：`task_create` / `task_list` / `task_get` / `task_update` / `task_delete` / `task_enable` / `task_disable`。

### 台账的结算规则（T+1）

- `ledger_trade` 卖出前校验**当日买入量**：可卖量 = 持仓 − 当日买入量；违规直接 throw（registry 归一为 `isError`），**零写入**。
- 结算规则按标的存于 `symbols.json` 的 `settlement`（`T+1` / `T+0`），`ledger_init` 的可选参数 `settlement` 声明，缺省 `T+1`（股票 ETF 亦保守默认 T+1）。
- 旧数据缺字段时 `getSymbol()` 归一化为 `T+1` 且**读时不回写**；存量 T+0 品种需人工改 `symbols.json`。
- 日界显式取 `Asia/Shanghai`（`src/domain/settlement.ts` 纯函数，不依赖宿主 TZ）；`reason='init'` 的建仓流水不计入当日买入。
- `ledger_query` 输出 `settlement` / `sellable_qty`，`ledger_list` 一并暴露 `settlement`。工具总数不变（15 + 7）。

## 三条约定的契约

1. **统一上下文**：`createToolContext({ dataRoot })` 在构造时实例化 Ledger / Predicts / Reviews / StrategyRegistry 各一次，15 个工具闭包共享同一数据源。
2. **字段映射**：domain 返回驼峰，工具输出 schema 用蛇形；`execute` 内逐字段显式映射，保持 lossless JSON。
3. **错误语义**：错误一律 throw（registry 归一为 `isError` 并跳过 schema 校验），不返回 `{ ok: false }`；写类成功返回 `{ ok, ... }`，读类不返回 `ok`。写操作前检查 `exec.signal`，中断即抛，避免半写。

## 阈值从哪来

`review_retrospect` 的阈值由 `ToolContext.getThresholds(symbol)` 提供，来源是该标的策略文档头部的 `thresholds.*`（蛇形键），逐键校验（有限数、`dir_hit_min ∈ [0,1]`）；非法或缺失回落默认值。旧的 `ledger/<symbol>/thresholds.json` 仅作兼容回落，不再写入。

## 相关

- [[concepts/architecture|架构总览]]
- [[concepts/assets-and-versioning|资产与版本]]

## 来源

- `README.md`
- `src/tools/README.md`
- `src/tools/index.ts`
- `src/tools/context.ts`
- `src/tools/error.ts`
- `src/domain/settlement.ts`
- `src/domain/ledger.ts`
