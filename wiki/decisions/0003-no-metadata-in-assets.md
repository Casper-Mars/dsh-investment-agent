# 0003 · 资产文件不内嵌元数据

- **状态**：已采纳（2026-10-17）
- **影响面**：策略文档、任务定义、任务程序、Skill（特例）

## 背景

治理方案曾计划给每个资产加 frontmatter，记录 `version` / `updatedAt` / `author` / `changeReason`。但这些字段与 git 提供的信息完全重复，而且会污染资产正文——策略文档与任务程序是给模型读的，头部多一块元数据会改变语义。

## 决策

- **不加**治理性 frontmatter；资产正文即全部内容。
- 身份 = 路径；版本 / 时间 / 作者 / 原因 = git。
- 许可与分享范围在**导出时**声明，不写进资产本体。
- 各类型天然字段照常使用：`package.json` 的依赖、任务 JSON 的定义字段等。

## 特例

`SKILL.md` 的 `name` / `description` / `whenToUse` frontmatter **保留**。它由 dsh skill 加载器消费，是加载契约，不是治理元数据。

## 后果

- 资产可直接被模型整篇读取，无解析噪声。
- 元数据查询需要走 git，不能只看文件。
- 导出/分享时必须显式生成许可声明，避免“默认继承仓库许可”的误解。

## 相关

- [[concepts/assets-and-versioning|资产与版本]]
- [[decisions/0001-git-as-version-store|0001 git 承担版本]]

## 来源

- `src/assets/commit.ts`
- `src/skills/README.md`
- `src/skills/frontmatter.ts`
