# Skill 体系：可进化 5 + 固件 3

> 方法论 Skill 是 Agent 可自主进化的资产；固件 Skill 定义“怎么写资产”的约束，不参与进化。区分标准是**能否被复盘改写**，不是内容长短。

## 两类 Skill

| 类别 | 数量 | 位置 | 注册方式 | 热更新 |
|---|---|---|---|---|
| 可进化 | 5 | `<assets>/skills/<name>/SKILL.md` | `skill-filesystem` provider 发现 | 有（chokidar watch） |
| 固件 | 3 | `src/skills/<name>/SKILL.md` | `plugin.ts` 静态注册 | 无（随插件版本） |

### 可进化（5）

| name | 作用 |
|---|---|
| `trend-analysis` | 研判趋势方向、震荡区间与置信度 |
| `grid-strategy` | 震荡区内网格高抛低吸 |
| `stop-rule` | 止损线纪律（硬止损 / 趋势止损） |
| `strategy-authorship` | 生成 / 迭代某标的策略文档的方法论 |
| `analysis-decision` | 上层分析与决策方法论，统筹 trend / grid / stop |

### 固件（3）

| name | 作用 |
|---|---|
| `task-authorship` | 编写 / 修改定时任务程序的结构契约 |
| `skill-authorship` | 编写 SKILL.md 的合规规范（frontmatter 三字段、红线、自检） |
| `finance-evolution` | 资产进化的唯一权威实现：触发、归因、证据门槛、变更纪律 |

> 命名陷阱：`strategy-authorship`（可进化，写**策略文档**）≠ `skill-authorship`（固件，写 **skill 本身**）。

## 运行机制

1. 冷启动：`ensureSkillAssetsRepo()` 把包内 5 个种子**幂等**写入 `<assets>/skills`，已存在则不覆盖。
2. 发现：`provider.ts` 挂载 dsh 原生 `skill-filesystem`，指向 `<assets>/skills`，`source='custom'`，双开 invocation。
3. 热更新：修改 `SKILL.md` → watch 触发 invalidate → 下次组装 prompt 生效，无需重启。
4. 固件：由 `plugin.ts` 调 `ctx.skills.register` 静态注册，`source='runtime'`，不进资产 git。

## 内容红线

- 全部 Skill 面向模型，必须**严格标的无关**：区间、阈值、数量一律写“遵循该标的策略文档”，不得出现写死的价格或阈值。
- 固件 Skill 不得复制引擎逻辑；引擎缺陷只能出“改进提案”，不能靠改 Skill 绕过。
- 可进化 Skill 的修改必须经 `finance-evolution` 流程（单变量、预注册、留痕）。

## 构建

`scripts/copy-assets.mjs` 把 `src/skills/**/SKILL.md` 复制到 `dist-server/skills/`，保证编译产物可解析。

## 相关

- [[concepts/assets-and-versioning|资产与版本]]
- [[decisions/0002-engine-vs-assets|决策：引擎 vs 资产]]

## 来源

- `src/skills/README.md`
- `src/skills/index.ts`
- `src/skills/repo.ts`
- `src/skills/provider.ts`
- `scripts/copy-assets.mjs`
