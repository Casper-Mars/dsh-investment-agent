# dsh-ia（dsh-finance）

> 金融投资专家 Agent，以 DeepSeek Harness（dsh）Cordis 插件形式交付；只做分析、建议与模拟记账，不执行真实交易。

## 身份

| 项 | 值 |
|---|---|
| 项目目录 | `/Users/reachlucifer/project/opc/dsh-finance` |
| npm 包名 | `dsh-ia`（当前版本 `0.1.1`） |
| dsh 插件名 | `investment-advisor` |
| 仓库 | https://github.com/Casper-Mars/dsh-investment-agent |
| 技术底座 | DeepSeek Harness（dsh）/ Cordis 插件 |
| 运行时 | Node.js ≥ 22.19、pnpm ≥ 11.7、dsh `^0.2.0-rc.2` |
| 标的范围 | ETF + A 股，多标的统一管理，技术面起步 |
| 用户数据根 | `~/.dsh-ia`（`DSH_IA_HOME` 可覆盖） |

## 能力版图

| 维度 | 数量 | 载体 | 详见 |
|---|---|---|---|
| 金融工具 | 15 | `src/tools/` | [[concepts/tool-layer|工具层]] |
| 定时任务工具 | 7 | `src/scheduler/tools.ts` | [[concepts/scheduler|定时任务层]] |
| Skill | 8（5 可进化 + 3 固件） | `src/skills/` / `<assets>/skills` | [[concepts/skill-system|Skill 体系]] |
| 提示注入 | 1 | `src/prompts/advisor.md` | [[concepts/architecture|架构总览]] |
| 公共包 | 领域 + 日志 | `src/domain/`、`src/log/` | [[concepts/architecture|架构总览]] |

> 工具总数以代码为准：15 个金融工具 + 7 个 `task_*` = 22。`src/plugin.ts` 头注释仍写“14 个”，属于陈旧注释，尚未修正。

## 运行时布局

```
~/.dsh-ia/
├── assets/                  # 唯一资产 git 仓库（可共享）
│   ├── strategies/<symbol>.md
│   ├── skills/
│   ├── tasks/
│   └── programs/
├── data/                    # 私有运行时数据（台账），0o700，不进 git
├── logs/                    # JSONL 日志，0o700
└── workspace/               # 会话工作区
```

## 关键边界

- **不碰真实交易**：不做下单、不代客理财、不承诺收益；台账是 Agent 自己的模拟账户。
- **结算约束**：台账默认按 A 股 **T+1** 结算（当日买入当日不可卖），违规卖出被 `ledger_trade` 在写库前拦截且零写入；`T+0` 品种需在 `ledger_init` 时显式声明 `settlement`（存量标的改 `symbols.json`）。日界按 `Asia/Shanghai` 计算。工具总数不变：15 个金融工具 + 7 个 `task_*`。
- **资产 vs 数据**：`assets/` 可共享、进 git；`data/` 含成本与盈亏，私有、不进 git。
- **引擎不可自进化**：`finance-evolution` 是固件；可进化的只有策略、skill、任务程序。见 [[decisions/0002-engine-vs-assets|引擎 vs 资产]]。

## 相关

- [[concepts/architecture|架构总览]]
- [[concepts/assets-and-versioning|资产与版本]]
- [[guides/operate|安装与运维]]
- [[sources/index|证据索引]]
- [[decisions/0001-git-as-version-store|决策：git 承担版本]]

## 来源

- `README.md`
- `package.json`
- `src/plugin.ts`
- `src/paths.ts`
- `src/skills/README.md`
- `src/tools/README.md`
