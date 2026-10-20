# 0002 · 引擎不可自进化，只有资产可以

- **状态**：已采纳
- **影响面**：`finance-evolution`、所有 Skill、策略与任务程序

## 背景

“自进化”很容易滑向“Agent 可以改任何东西”，包括改自己的进化规则。那会导致约束失效：Agent 可以修改判定标准来让自己的改动通过。

## 决策

把系统切成两层：

| 层 | 内容 | 谁能改 |
|---|---|---|
| 引擎 | 进化的规则本身：触发条件、归因分类、证据门槛、变更纪律 | 只有人类；以插件新版本发布 |
| 资产 | `skills/`、`strategies/`、`tasks/`、`programs/`、方法论与工具 | Agent 可在复盘后自主进化 |

`finance-evolution` 是引擎的**具体实现**，形态是固件 Skill：它描述规则，但自身不可被进化流程修改。

## 硬约束

1. 引擎逻辑不得复制进可进化资产（否则资产成了第二套引擎，改资产等于改规则）。
2. 引擎与具体工具解耦：可以依赖 git 这类基础设施，不能依赖某个业务工具。
3. 引擎缺陷只能产出“改进提案”，由人类决定是否发版。

## 后果

- 进化有边界：Agent 能改进方法，不能改进“什么算改进”。
- 固件 Skill 随插件版本走，不落 `<assets>/skills`，不进热更新链路。
- 每次引擎变更都需要人类介入，升级频率低但可控。

## 相关

- [[concepts/skill-system|Skill 体系]]
- [[concepts/assets-and-versioning|资产与版本]]

## 来源

- `src/skills/finance-evolution/SKILL.md`
- `src/skills/README.md`
- `src/plugin.ts`
