# 证据索引

> wiki 的结论必须能回溯到这里。代码是最终事实来源；飞书文档是设计与决策背景；`CHANGELOG.md` 是变更时间线。

## 设计文档（飞书）

| 文档 | 用途 |
|---|---|
| [金融投资专家 · 详细设计（dsh 插件版）](https://ecn3asgw8dff.feishu.cn/wiki/OBPawk0criszdhk8EivcgcEznSf) | 总体设计、能力边界、工具契约 |
| [感知层详细设计（dsh-finance 插件）](https://ecn3asgw8dff.feishu.cn/wiki/HpFPwQSo3iAw39kovuDc6qAXnla) | scheduler：loader / runner / waker 语义 |
| [Skill 设计 · 可进化资产（dsh-finance 插件）](https://www.feishu.cn/wiki/EwGTwqoX8iVimLkSmDwcMPHrn7e) | Skill 分层与进化 |
| [技术方案 · 新增 skill-authorship 固件 skill](https://www.feishu.cn/docx/Np17d3Xm8oW0QoxbHIjcd86JnVK) | 固件 Skill 的编写规范 |
| [dsh-finance 数据治理技术方案 v1.0](https://ecn3asgw8dff.feishu.cn/wiki/H08SwfqcsiNZ2kkxt5bcjdp4nub) | 资产单仓、无元数据、git 版本 |
| [dsh-finance 一期技术方案](https://www.feishu.cn/wiki/D8JvwfME9io0gjk5Zlmcegennkh) | 一期范围与里程碑 |

## 代码入口

| 主题 | 入口 |
|---|---|
| 插件契约 | `src/plugin.ts` |
| 路径与环境变量 | `src/paths.ts`、`src/flags.ts` |
| 工具注册 | `src/tools/index.ts` |
| 领域逻辑 | `src/domain/` |
| Skill 注册与发现 | `src/skills/index.ts`、`src/skills/provider.ts` |
| 资产提交 | `src/assets/commit.ts` |
| 定时任务 | `src/scheduler/index.ts` |
| 日志 | `src/log/logger.ts`、`src/log/file-exporter.ts` |

## 变更时间线

- `CHANGELOG.md`：Keep a Changelog 格式，`Unreleased` 段记录未发版变更。
- `git log`：资产与代码的完整历史；回滚与追溯以它为准。

## 外部规范

- DeepSeek Harness 文档：https://deepseek-harness.github.io/deepseek-harness/
- Cordis 仓库：https://github.com/deepseek-ai/cordis

## 相关

- [[entities/dsh-ia|dsh-ia 项目]]

## 来源

- `README.md`
- `CHANGELOG.md`
- `src/plugin.ts`
