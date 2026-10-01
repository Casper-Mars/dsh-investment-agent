# tools

模型工具层（已完成，t100353）：以 `@deepseek-ai/dsh-tools` 的 `defineTool` 定义 18 个金融工具，
经 `ctx.tools.register` 注册。

## 目录结构

```
src/tools/
├── context.ts          # ToolContext 工厂：dataRoot 统一注入 + 五大 domain 类实例化
├── error.ts            # 统一错误归一化（throw + 取消检查）
├── schemas.ts          # output.schema 值 schema DSL（蛇形字段，§4 契约）
├── types.ts            # 工具层蛇形实体类型（镜像 schema）
├── ledgers.ts          # 台账域 4 工具
├── strategy.ts         # 策略域 2 工具
├── predicts.ts         # 预测域 3 工具
├── reviews.ts          # 复盘域 5 工具
├── sense-archives.ts   # 感知归档域 4 工具
└── index.ts            # createAllTools / registerAllTools 统一入口
```

## 工具清单（18 个，§4 契约表 + §10.8 策略域）

| 组 | 工具 | 类别 |
|----|------|------|
| ledgers | ledger_init / ledger_list / ledger_query / ledger_trade | 2 写 + 2 读 |
| strategy | strategy_get / strategy_set | 1 写 + 1 读 |
| predicts | predict_make / predict_verify / predict_get | 1 写 + 2 读 |
| reviews | review_check / review_report / review_get / review_metrics / review_retrospect | 1 写 + 4 读 |
| sense_archives | sense_archive_commit / sense_archive_list / sense_archive_rollback / sense_archive_get | 2 写 + 2 读 |

> 注：任务标题写「15 个」，但 §4 契约表实为 4+3+5+4 = 16 个（以契约表为准）；
> 后续并入策略域 strategy_get / strategy_set（§10.8），现为 18 个。

## 关键设计

- **dataRoot 统一注入**：`createToolContext({ dataRoot })` 构造时实例化 Ledger / Predicts /
  Reviews / SenseRegistry / StrategyRegistry 各一次，18 个工具闭包共享同一数据源。dataRoot 缺省取
  `DSH_FINANCE_DATA_DIR` 环境变量，再回退 `.dsh-finance/data`。
- **字段映射**：domain 返回驼峰，output.schema 用蛇形（§4 契约），execute 内做显式蛇形映射，
  二者逐字段对齐（lossless JSON）。
- **错误处理**：错误通过 throw 表达（registry 归一为 isError、跳过 schema 校验），
  不返回 `{ ok:false }`；写类成功返回 `{ ok, ... }`，读类返回无 ok 字段的数据对象。
- **exec.signal 可中断**：写操作前 `assertNotAborted(exec.signal)`，中断即 throw，不产生半写。
- **阈值来源（反向检讨）**：`review_retrospect` 的阈值由 `ToolContext.getThresholds(symbol)` 供给，
  来源已迁移到策略文档 front-matter（`strategy/<symbol>.md` 顶部 `---` 内的 `thresholds.*`，蛇形键），
  逐键校验（有限数 + `dir_hit_min ∈ [0,1]`），非法/缺失键回落默认；旧 `ledger/<symbol>/thresholds.json`
  仅作兼容回落（@deprecated，不再写入）。

## 接入方式

plugin.ts 已在 `apply(ctx)` 内惰性 `import('./tools/index.js')` 并调用
`registerAllTools(ctx)`（参照 dsh-tasks 的加载策略）：模块图较重，惰性加载避免拖慢
插件 fiber 激活时序；注销器绑定 `ctx.effect`，fiber 卸载（含 HMR 重载）时自动注销。
`ctx.tools` 服务不可用时（最小上下文 / 装载测试）安全跳过，不中断插件装载。