# 0001 · 版本、记录、回滚一律由 git 承担

- **状态**：已采纳（2026-10-17）
- **影响面**：策略、Skill、任务定义、任务程序、资产层整体

## 背景

早期方案为策略设计了物化版本链：`strategies_versions/vNNN.md` + `vNNN.meta.json` + `current` 指针，另外还规划了 `manifest.json` 做资产清单。项目尚未上线，这套机制没有历史包袱需要承接。

## 决策

1. 不建版本链文件，不建 `manifest.json`，不建独立进化日志。
2. 版本、时间、作者、变更原因、回滚，全部由 **git** 承担：
   - 当前版本 = 工作区文件
   - 历史 = `git log` / `git show`
   - 回滚 = `git revert` / `git checkout`
3. 资产身份 = 路径即 ID。

## 后果

- 少一套需要同步、会漂移的状态机；不会出现“文件版本与 meta 不一致”。
- 任何资产读取方都必须接受“历史在 git 里”，不能假设存在 `vNNN` 文件。
- 因为项目未上线，不提供旧版本链的迁移脚本与兼容回落。

## 替代方案与为何否决

| 方案 | 否决原因 |
|---|---|
| 物化版本链 + current 指针 | 与 git 重复，双写必然漂移 |
| manifest.json 资产清单 | 可由目录扫描得出，属于冗余状态 |
| 数据库记录版本 | 资产要可共享、可 diff、可 PR，数据库不适合 |

## 相关

- [[concepts/assets-and-versioning|资产与版本]]
- [[decisions/0002-engine-vs-assets|0002 引擎 vs 资产]]

## 来源

- `src/assets/repo.ts`
- `src/assets/commit.ts`
- `CHANGELOG.md`
