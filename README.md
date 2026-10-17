# dsh-ia

> 金融投资专家 Agent 插件（dsh）：投资建议、持仓记账、行情/交易日历与市场感知。

`dsh-ia` 是一个基于 [DeepSeek Harness（dsh）](https://deepseek-harness.github.io/deepseek-harness/) 的 Cordis 插件。它以 system-prompt 注入一个「精通计算机技术的 A 股投资专家」人设，配套一套面向模型的金融工具、可进化的方法论 SKILL，以及一个独立进程的定时任务（感知）层，让 Agent 能自主完成「监听 → 研判 → 制定策略 → 记账 → 复盘 → 迭代」的全链路。

- 标的范围：ETF + A 股，多标的统一管理
- 分析方法：技术面起步
- Agent **不执行真实交易**；真实下单由用户离线完成，插件内的台账是 Agent 自己的模拟账户

## 核心特性

- **投资专家人设**：以 `advisor.md` 注入 system-prompt，定义角色、原则、工作流、自我进化与合规边界。
- **14 个金融工具**：台账（4）+ 策略（2）+ 预判（3）+ 复盘（5），经 `defineTool` 注册。
- **7 个定时任务工具**：`task_create` / `task_list` / `task_get` / `task_update` / `task_delete` / `task_enable` / `task_disable`。
- **7 个 SKILL**：5 个「可进化 SKILL」（方法论，随复盘迭代）+ 2 个「固有 SKILL」（固件约束，不进化）。
- **定时任务（感知）层**：独立的 loader → runner（独立 Node 进程）→ waker（定点唤醒投递）编排，支持 agent 动态注册任意 cron。
- **skill 可进化资产**：可进化 SKILL 落运行时数据目录的独立 git 仓库，`chokidar` watch 热更新，改 `SKILL.md` 无需重启。
- **固定会话 + 开场 notice**：冷启动自动确保定点会话并投递引导性开场消息。
- **统一日志 + 文件落地**：分级日志门面 + JSONL 文件 exporter + 字段级去敏 + trace 上下文。

## 架构总览

插件入口 `src/index.ts`，插件契约在 `src/plugin.ts`（导出 `name` / `inject` / `apply`）。能力按 dsh 原生维度组织为四类 + 一层公共包：

| 类别 | 目录 | 载体 | dsh 契约 |
|------|------|------|----------|
| 提示注入（投资专家人设） | `src/prompts/` | Markdown | system-prompt 注入 |
| 可复用指令（Skill） | `src/skills/`（种子）/ `<assetsDir>/skills`（运行时） | `<name>/SKILL.md` | `ctx.skills` |
| 模型工具 | `src/tools/` | `defineTool` | `ctx.tools` |
| 定时任务层（感知） | `src/scheduler/` | 独立定时任务层 | 见下 |
| 公共包 | `src/domain/` + `src/log/` | 纯 TS 模块 | 内部依赖 |

依赖注入契约固定为 `['tools', 'skills', 'fs']`（与 `cordis.patch.yml` 保持一致）；`systemPrompt` / `agents` 等经 `ctx.inject([...])` 动态声明，不加入顶层 `inject`。

**两个贯穿原则：**

1. **标的无关**：所有工具、脚本、数据模型以 `symbol` 为维度；prompt / skill 只在「策略方法论」层使用占位符号，具体数值一律**遵循该标的策略文档**，不写死任何单一标的。
2. **标的类型驱动**：`symbols.type`（`etf` / `stock`）决定行情数据源路由与交易单位；分析方法当前统一为技术面。

## 安装

前置：Node.js >= 22.19.0、pnpm >= 11.7.0，以及 dsh 宿主。

```sh
# 安装到某个 dsh profile（当前目录即本包）
dsh plugin --profile <name> add .
```

安装后由 profile 的 bundle patch（`cordis.patch.yml`，单插件包 `name` 写裸包名 `dsh-ia`）自动加载。

## 使用

在 dsh 会话中，Agent 会自动：

1. 以「金融投资专家」人设开场（固定会话冷启动时投递开场 notice，引导建立标的台账）。
2. 对每个关注标的：`ledger_init` 建账 → `strategy_set` 生成首版策略 → `task_create` 部署任务程序盯盘。
3. 收到任务程序唤醒回报后研判、按策略决策、在台账里 `ledger_trade` 执行并记账。
4. 盘后 `review_*` 复盘，双线迭代（更新策略文档 / 更新任务程序）。

> ⚠️ 交易时段纪律（A 股硬约束）：可下单时段为连续竞价 **9:30–11:30、13:00–15:00**。盘前（含集合竞价）、午休、收盘后禁止下单，工具层 `ledger_trade` 会兜底校验时段。

## 配置

全部经环境变量覆盖（dsh 启动器为严格模式，不接受自定义启动 flag）：

| 环境变量 | 作用 | 默认值 |
|----------|------|--------|
| `DSH_IA_HOME` | 工作区根目录（data / tasks / skills / workspace 归属全部跟随） | `~/.dsh-ia` |

## 数据目录

```
~/.dsh-ia/
├── assets/                            # 资产层（可共享、进 git；本身是一个 git 仓库）
│   ├── strategies/<symbol>.md         # 策略文档（纯正文；版本 = git 短 SHA）
│   └── skills/                        # 可进化 SKILL（独立 git 仓库，main=当前版本）
├── data/                              # dataRoot（用户私有运行时数据）
│   ├── ledger/<symbol>/…              # 台账（持仓 / 成本 / 流水）
│   └── tasks/                         # 定时任务清单
└── logs/                              # 运行日志（JSONL）
```

`data/` 为**用户私有运行时数据**（含盈亏 / 成本 / 流水，不可分享、不进 git）；`data/ledger` 目录权限 `0o700`（仅属主可访问），与 `logs/` 口径一致。

`assets/` 与 `data/` 及子目录均为**运行时动态创建**（非项目固有目录）。`assets/` 是外层 git 仓库（策略等资产共用，`.gitignore` 排除 `skills/`）；其中 `assets/skills/` 是嵌套的独立 git 仓库，由插件冷启动幂等预置。

## 开发

```sh
pnpm build        # 类型检查 + 编译 + 搬运 .md 资源到 dist-server
pnpm typecheck    # 仅类型检查
pnpm test         # 运行 vitest（--maxWorkers=4，避免 fs/git/chokidar 装配用例相互饿死）
pnpm clean        # 清理 dist / dist-server
```

## 目录结构

```
src/
├── index.ts            # 包入口
├── plugin.ts           # Cordis 插件契约（name / inject / apply）
├── paths.ts            # 路径解析（~/.dsh-ia、assets/data/logs）
├── flags.ts            # 环境变量解析（home / session id 覆盖与派生）
├── session.ts          # 会话类型与工具
├── session-ensure.ts   # 固定会话确保（检查 → 恢复 → 新建）
├── opening-notice.ts   # 开场 notice 投递
├── message-source.ts   # 消息构造（producer 自有 source kind）
├── tools/              # 14 个金融工具
├── scheduler/          # 定时任务层（load → run → wake + 7 工具）
├── skills/             # SKILL 种子 + provider + 固件 skill 注册 + git 仓库
├── prompts/            # advisor.md 人设 + systemPrompt 注入
├── domain/             # 纯 TS 领域逻辑（台账 / 策略 / 预判 / 复盘 / 交易日历）
└── log/                # 日志门面 + 文件 exporter + 去敏 + trace
tests/                  # vitest 用例与独立验收报告
scripts/copy-assets.mjs # 构建期 .md 资源搬运
```

## 依赖

- **运行时 peer**：`@deepseek-ai/cordis`（>=4.0.0）、`@deepseek-ai/dsh-llm`、`@deepseek-ai/dsh-tools`、`@deepseek-ai/dsh-skill`、`@deepseek-ai/dsh-skill-filesystem`（均 `0.2.0-rc.2`，后三者为可选 peer）。
- **开发**：TypeScript ^5.7、Vitest ^3.0。

## 合规声明

本插件的全部输出仅用于辅助决策，**不构成投资建议或收益承诺**。插件只做分析、建议、推演与自身台账内的**模拟执行**，不触碰真实交易、不代客理财、不承诺保本、不诱导加杠杆。市场有风险，决策需谨慎。
