# skills

技术面 SKILL 层（Task 5 已落地 6 个运行时 SKILL）。

## 内容

| 目录 | name | 作用 |
|------|------|------|
| `trend-analysis/` | trend-analysis | 研判趋势方向、震荡区间与置信度 |
| `grid-strategy/` | grid-strategy | 震荡区内网格高抛低吸 |
| `stop-rule/` | stop-rule | 止损线纪律（硬止损 / 趋势止损） |
| `strategy-authorship/` | strategy-authorship | 生成 / 迭代某标的策略文档的方法论 |
| `analysis-decision/` | analysis-decision | 对某标的做分析与决策的上层方法论（统筹 trend/grid/stop，可随复盘进化） |
| `task-authorship/` | task-authorship | 编写 / 修改定时任务任务程序的方法论 |

另有：

| 文件 | 说明 |
|------|------|
| `frontmatter.ts` | SKILL.md frontmatter 轻量解析器（无第三方 YAML 依赖） |
| `index.ts` | 6 个 SKILL 的随包种子读取 / 解析出口（`SKILL_NAMES` / `loadSkillMarkdown` / `parseSkill`） |
| `repo.ts` | 运行时数据目录 `<dataRoot>/skills` 的独立 git 仓库：冷启动幂等预置（种子落盘 + 首版 commit） |
| `provider.ts` | 挂载 dsh 原生 `skill-filesystem` provider（指向 `<dataRoot>/skills`，开启 watch 热更新） |

> 运行时注册：6 个 SKILL 不在本模块静态注册，而由 `provider.ts` 挂载的
> `skill-filesystem` provider 从 `<dataRoot>/skills` 发现；改 `SKILL.md` 经 chokidar
> watch → invalidate → 下次组装 prompt 生效（无需重启）。`index.ts` 的静态读取仅用于
> `repo.ts` 的冷启动种子预置。

## SKILL.md 格式（符合 dsh skill-filesystem 发现规范）

- 路径：`src/skills/<name>/SKILL.md`（目录 bundle），目录名 = frontmatter `name`（kebab-case）。
- YAML frontmatter：**必填** `name` / `description`，**可选** `whenToUse`。
- 注册：由 `skill-filesystem` provider 从运行时数据目录 `<dataRoot>/skills` 发现（目录 bundle，`source='custom'`，`invocation` 双开）。

## 内容红线

6 个 skill 是**面向模型的方法论指令**，必须**严格标的无关**：所有区间 / 阈值 / 数量一律写「遵循该标的策略文档」，**不得**出现写死的价格或阈值。

## 构建搬运

`SKILL.md` 由 `scripts/copy-assets.mjs` 复制到 `dist-server/skills/<name>/SKILL.md`，保证编译产物下可解析。
