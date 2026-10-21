# Changelog

本项目所有值得记录的变更都写在此文件。

格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### Fixed

- **`ledger_trade` 增加 A 股 T+1 校验（Issue #6）**：此前只校验「100 整数倍」与「卖出不超持仓」，
  当日买入可当日卖出，会把现实中不存在的交易记成真账。现在卖出前按**当日累计买入量**校验：
  - 可卖量 = 持仓 − 当日买入量（`reason='init'` 的期初建仓流水不计入当日买入）；跨自然日
    （显式 `Asia/Shanghai` 时区）自动恢复，无需持久化冻结数量；
  - **拒绝路径零写入**：不写 `trades.json`，不改 `qty` / `cash` / `realizedPnl`；
  - 错误文案包含当日买入量、可卖量、持仓量，单位按标的分「股 / 份」，可直接转述给用户。
- **结算规则按标的可配置**：`symbols.json` 新增 `settlement`（`T+1` / `T+0`），`ledger_init` 增加
  可选参数 `settlement`（默认 `T+1`，ETF 同样保守默认 T+1，T+0 品种显式声明）。旧数据无该字段时
  读取按 `T+1` 兜底、**不回写**，无需迁移脚本。
- **`ledger_query` 输出扩展**：新增 `settlement` 与 `sellable_qty`（`ledger_list` 同时暴露 `settlement`），
  让 Agent 在下单前就能看到当前可卖量。工具总数不变（15 个金融工具 + 7 个 `task_*`）。
- **已知取舍**：存量 T+0 标的（旧 `symbols.json` 无 `settlement`）会按 T+1 处理，需人工编辑该
  `symbols.json` 加入 `"settlement": "T+0"`；历史同日买卖的错账本次**不修复**，只拦新增违规。

### Added

- **`finance-evolution` 固件 skill**：新增资产进化的唯一权威实现（固件约束，不进化）。
  - 四类触发：指标异常、同一失败第二次、能力缺陷可复现、某个做法明显有效。
  - 资产范围：`skills/`、`strategies/`、`programs/`、`tasks/`；固件（固有 SKILL 与引擎）不改。
  - 修改记录 = git：单仓、append-only、固定身份、只记操作不判结果。

### Changed

- **dsh 兼容性改为区间声明（修复 dsh 0.2.1-rc.2 启动时 profile bundle 被 skip）**：
  新增 `engines.dsh: ^0.2.0-rc.2` 作为 dsh 兼容性的唯一真源（dsh 存在该字段时不再比对
  peerDependencies）；四个 `@deepseek-ai/dsh-*` peer 由精确 `0.2.0-rc.2` 改为 `^0.2.0-rc.2`；
  `@deepseek-ai/cordis` 由 `>=4.0.0` 提升为 `^4.0.5`（0.2.1-rc.2 各包要求 `~4.0.5`）；
  devDependencies 升至 `0.2.1-rc.2`。**代码零改动**，仅版本声明变更。

- **`cum_return` 收益口径修正（BREAKING：历史值不可比）**：累计收益率口径由
  「期末市值 + 累计 realized」修正为「**期末现金 + 期末市值** − 期初资金」/ 期初资金
  （即期末总资产 vs 期初总资产）。旧口径分子漏掉**期末现金**，对已清仓账户会严重
  低估（可低至近 −100%）。
  ⚠️ **兼容性**：历史 `metrics.json` 中的 `cumReturn` 为**旧口径**落库值，与修复后
  **不可比**。消费方若直接做新旧对比，会得出错误的「策略变好 / 变坏」结论；
  请以下述**重算值**为准。

### Notes

- **历史 metrics 一次性重算（cum_return 回填）**：提供幂等、可回滚的重算脚本
  `scripts/recompute-cum-return.mjs`，按新口径重放台账流水并回填 `cum_return`。
  默认 **dry-run**（仅打印 before/after/changed，不落盘）；`--write` 落盘，并在
  落盘前把原 `metrics.json` 备份为 `metrics.json.bak`；`--rollback` 可还原。

  ```bash
  # 预览（dry-run，默认）
  node scripts/recompute-cum-return.mjs --data-root ~/.dsh-ia/data
  # 回填（落盘，自动备份 metrics.json -> metrics.json.bak）
  node scripts/recompute-cum-return.mjs --data-root ~/.dsh-ia/data --write
  # 回滚（从 .bak 还原）
  node scripts/recompute-cum-return.mjs --data-root ~/.dsh-ia/data --rollback
  ```

  亦可经环境变量提供 dataRoot：`DSH_IA_DATA_DIR=<dir> node scripts/recompute-cum-return.mjs`
  （缺省 `~/.dsh-ia/data`）。重算口径由单测与 `cumReturnOnCapital` 对齐，防口径漂移。

## [0.1.0] - 2026-10-13

首个发布版本。`dsh-ia` 是一个基于 [DeepSeek Harness（dsh）](https://deepseek-harness.github.io/deepseek-harness/)
的 Cordis 插件，以 system-prompt 注入「精通计算机技术的 A 股投资专家」人设，
配套面向模型的金融工具、可进化的方法论 SKILL，以及一个独立进程的定时任务（感知）层，
让 Agent 能自主完成「监听 → 研判 → 制定策略 → 记账 → 复盘 → 迭代」全链路。
标的范围覆盖 ETF + A 股，当前以技术面分析起步；插件**不执行真实交易**，台账为 Agent 自身的模拟账户。

### Added

- **投资专家人设**：`advisor.md` 注入 system-prompt，定义角色、原则、工作流、自我进化与合规边界。
- **14 个金融工具**（经 `defineTool` 注册）：台账 4（`ledger_*`）、策略 2（`strategy_*`）、
  预判 3（`predict_*`）、复盘 5（`review_*`）。
- **交易日历与行情层**：A 股交易日历与行情数据结构。
- **策略域**：策略文档存储与版本链、阈值来源迁移到策略文档 front-matter
  （`strategy_get` / `strategy_set`）。
- **预判 / 复盘闭环**：预测命中验证与复盘（含 `cum_return` 收益口径）。
- **定时任务（感知）层**：独立 `loader → runner（独立 Node 进程）→ waker（定点唤醒投递）` 编排；
  自实现标准 5 段 cron 解析与下一触发时刻计算；任务清单持久化；多任务独立调度引擎
  （多 timer + 链式自调度 + 幂等启停 + 异常隔离）；任务进程 stdout/stderr 独立采集（10MB 封顶，防宿主 OOM）。
- **7 个定时任务工具**：`task_create` / `task_list` / `task_get` / `task_update` /
  `task_delete` / `task_enable` / `task_disable`（`defineTool` 注册 + 写后 reload + 路径防穿越校验）。
- **7 个 SKILL**：
  - 5 个「可进化 SKILL」（方法论，随复盘迭代）：`trend-analysis`、`grid-strategy`、
    `stop-rule`、`strategy-authorship`、`analysis-decision`；
  - 固有 SKILL（固件约束，不进化）：`task-authorship`、`skill-authorship`。
- **skill 可进化资产**：可进化 SKILL 落运行时数据目录的独立 git 仓库，冷启动幂等预置；
  经 `chokidar` watch 热更新，改 `SKILL.md` 无需重启。
- **固定会话 + 开场 notice**：冷启动自动确保定点会话（检查 → 恢复 → 新建）并投递引导性开场消息。
- **统一日志 + 文件落地**：分级日志门面替换散乱 `console`；JSONL 文件 exporter（轮转 + 插件白名单）；
  字段级去敏（敏感/金额键 `[REDACTED]` + 长文本截断 + `Error` 裁剪）；`AsyncLocalStorage` 打通的 trace 上下文。
- **路径安全**：统一路径段安全校验，封堵目录穿越。
- **环境变量配置**：工作区与会话隔离（`DSH_IA_HOME` 等）。
- **交易时段纪律**：`ledger_trade` 连续竞价时段（9:30–11:30、13:00–15:00）硬闸门兜底校验。

### Notes

- 依赖注入契约固定为 `['tools', 'skills', 'fs']`；运行时 peer 依赖 `@deepseek-ai/cordis`（>=4.0.0）
  与 `@deepseek-ai/dsh-llm`、`@deepseek-ai/dsh-tools`、`@deepseek-ai/dsh-skill`、
  `@deepseek-ai/dsh-skill-filesystem`（均 `0.2.0-rc.2`，后三者为可选 peer）。
- 全部输出仅用于辅助决策，不构成投资建议或收益承诺。

[0.1.0]: https://github.com/Casper-Mars/dsh-investment-agent/releases/tag/v0.1.0
