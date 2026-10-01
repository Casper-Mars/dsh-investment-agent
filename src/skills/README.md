# skills

技术面 SKILL 层（Task 5 已落地 5 个运行时 SKILL）。

## 内容

| 目录 | name | 作用 |
|------|------|------|
| `trend-analysis/` | trend-analysis | 研判趋势方向、震荡区间与置信度 |
| `grid-strategy/` | grid-strategy | 震荡区内网格高抛低吸 |
| `stop-rule/` | stop-rule | 止损线纪律（硬止损 / 趋势止损） |
| `strategy-authorship/` | strategy-authorship | 生成 / 迭代某标的策略文档的方法论 |
| `sense-authorship/` | sense-authorship | 编写 / 修改多标的感知脚本的方法论 |

另有：

| 文件 | 说明 |
|------|------|
| `frontmatter.ts` | SKILL.md frontmatter 轻量解析器（无第三方 YAML 依赖） |
| `index.ts` | 5 个 SKILL 的读取 / 解析 / 注册出口（`ctx.skills.register`） |

## SKILL.md 格式（符合 dsh skill-filesystem 发现规范）

- 路径：`src/skills/<name>/SKILL.md`（目录 bundle），目录名 = frontmatter `name`（kebab-case）。
- YAML frontmatter：**必填** `name` / `description`，**可选** `whenToUse`。
- 注册时读取并解析 frontmatter 组装 `SkillRegistration`（`content` = 正文，`source='runtime'`，`invocation` 双开）。

## 内容红线

5 个 skill 是**面向模型的方法论指令**，必须**严格标的无关**：所有区间 / 阈值 / 数量一律写「遵循该标的策略文档」，**不得**出现写死的价格或阈值。

## 构建搬运

`SKILL.md` 由 `scripts/copy-assets.mjs` 复制到 `dist-server/skills/<name>/SKILL.md`，保证编译产物下可解析。
