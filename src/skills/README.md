# skills

技术面 SKILL 层（Task 5 落地；5 个「可进化 SKILL」+ 3 个「固有 SKILL」）。

## 内容

### 可进化 SKILL（5 个，`SKILL_NAMES`）

随 `repo.ts` 冷启动种子落盘到 `<assetsDir>/skills`（单仓普通目录，与 strategies 等共用
`<assetsDir>/.git`），由 `provider.ts` 挂载的 `skill-filesystem` provider 发现，改 `SKILL.md`
经 watch 热更新（无需重启）。

| 目录 | name | 作用 |
|------|------|------|
| `trend-analysis/` | trend-analysis | 研判趋势方向、震荡区间与置信度 |
| `grid-strategy/` | grid-strategy | 震荡区内网格高抛低吸 |
| `stop-rule/` | stop-rule | 止损线纪律（硬止损 / 趋势止损） |
| `strategy-authorship/` | strategy-authorship | 生成 / 迭代某标的策略文档的方法论 |
| `analysis-decision/` | analysis-decision | 对某标的做分析与决策的上层方法论（统筹 trend/grid/stop，可随复盘进化） |

### 固有 SKILL（3 个，`TASK_AUTHORSHIP_SKILL_NAME` / `SKILL_AUTHORSHIP_SKILL_NAME` / `FINANCE_EVOLUTION_SKILL_NAME`）

| 目录 | name | 作用 |
|------|------|------|
| `task-authorship/` | task-authorship | 编写 / 修改定时任务任务程序的方法论 |
| `skill-authorship/` | skill-authorship | 编写 / 修改可进化 SKILL.md 的合规规范（frontmatter 三字段 / whenToUse 写法 / 硬性红线 / 自检清单） |
| `finance-evolution/` | finance-evolution | 资产进化的唯一权威实现（定义 / 触发 / 流程 / 自检 / 修改记录规范见该 skill）；引擎自身不可进化 |

> 「固有 SKILL」定义**固件约束**（任务程序的结构契约 / 写 skill 的合规规范），属方法论层，
> **不进入** git 进化链与热更新时间线：它们**不落** `<assetsDir>/skills`，由 `src/plugin.ts` 经
> `ctx.skills.register` **静态注册**（`index.ts` 的 `createIntrinsicSkillRegistration` /
> `createSkillAuthorshipRegistration`）。

> **命名区分（勿混淆）**：
> - `strategy-authorship`（**可进化**）：怎么写某标的的**策略文档**——上方「可进化 SKILL」表。
> - `skill-authorship`（**固件**）：怎么写 **skill 本身**——本表。
> 两者命名相近、性质不同：前者可被复盘进化，后者固定不变。

另有：

| 文件 | 说明 |
|------|------|
| `frontmatter.ts` | SKILL.md frontmatter 轻量解析器（无第三方 YAML 依赖） |
| `index.ts` | 5 个可进化 SKILL 的随包种子读取 / 解析出口（`SKILL_NAMES` / `loadSkillMarkdown` / `parseSkill`）+ 3 个固有 SKILL 读取 / 注册入口（`TASK_AUTHORSHIP_SKILL_NAME` / `SKILL_AUTHORSHIP_SKILL_NAME` / `FINANCE_EVOLUTION_SKILL_NAME` / `loadTaskAuthorshipMarkdown` / `loadSkillAuthorshipMarkdown` / `loadFinanceEvolutionMarkdown` / `createIntrinsicSkillRegistration` / `createSkillAuthorshipRegistration` / `createFinanceEvolutionRegistration`） |
| `repo.ts` | 运行时目录 `<assetsDir>/skills` 的种子落盘：幂等补齐 5 个可进化 SKILL（不覆盖已有内容；不做 git 操作，仓库由 `assets/repo.ts` 统一管理） |
| `provider.ts` | 挂载 dsh 原生 `skill-filesystem` provider（指向 `<assetsDir>/skills`，开启 watch 热更新，发现 5 个可进化 SKILL） |

> 运行时注册：5 个可进化 SKILL 不在本模块静态注册，而由 `provider.ts` 挂载的
> `skill-filesystem` provider 从 `<assetsDir>/skills` 发现；改 `SKILL.md` 经 chokidar
> watch → invalidate → 下次组装 prompt 生效（无需重启）。`index.ts` 的静态读取仅用于
> `repo.ts` 的冷启动种子预置。固有 SKILL `task-authorship` / `skill-authorship` / `finance-evolution` 则由
> `plugin.ts` 静态注册。

## SKILL.md 格式（符合 dsh skill-filesystem 发现规范）

- 路径：`src/skills/<name>/SKILL.md`（目录 bundle），目录名 = frontmatter `name`（kebab-case）。
- YAML frontmatter：**必填** `name` / `description`，**可选** `whenToUse`。
- 注册：
  - 可进化 SKILL —— 由 `skill-filesystem` provider 从资产层目录 `<assetsDir>/skills` 发现（目录 bundle，`source='custom'`，`invocation` 双开）；
  - 固有 SKILL（task-authorship / skill-authorship / finance-evolution）—— 由 `plugin.ts` 静态注册（`source='runtime'`，`invocation` 双开）。

## 内容红线

全部 skill 是**面向模型的方法论指令**，必须**严格标的无关**：所有区间 / 阈值 / 数量一律写「遵循该标的策略文档」，**不得**出现写死的价格或阈值。

## 构建搬运

`SKILL.md` 由 `scripts/copy-assets.mjs` 复制到 `dist-server/skills/<name>/SKILL.md`，保证编译产物下可解析。
