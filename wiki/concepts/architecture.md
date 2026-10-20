# 架构总览

> 插件按 dsh 原生维度拆成「提示 / Skill / 工具 / 定时任务」四类，加领域与日志两个公共包；所有能力在 `apply(ctx)` 内装配，生命周期由 `ctx.effect` 托管。

## 启动与装配链

```
src/index.ts
  └─ export { name, apply, inject } from './plugin.js'
       └─ apply(ctx)
            ├─ ensureAssetsRepo()            资产单仓就绪
            ├─ ensureSkillAssetsRepo()       幂等预置 5 个可进化 SKILL
            ├─ mountSkillFilesystemProvider() 挂 skill-filesystem（watch 热更新）
            ├─ 静态注册 3 个固件 SKILL
            ├─ applyAdvisorPrompt()          systemPrompt 注入 advisor.md
            ├─ applyScheduler()              loader → runner → waker + 7 工具
            ├─ applySessionEnsure()          固定会话 + 开场 notice
            ├─ 日志门面 + JSONL exporter
            └─ 惰性 import('./tools/index.js') 注册 15 个金融工具
```

顶层依赖契约固定为 `['tools', 'skills', 'fs']`；`systemPrompt`、`agents` 通过 `ctx.inject([...])` 动态声明，不进入顶层 `inject`。

## 分层职责

| 层 | 目录 | 职责 | 不该做什么 |
|---|---|---|---|
| 提示 | `src/prompts/` | `advisor.md` 人设注入 | 不写业务规则常量 |
| Skill | `src/skills/` | 方法论指令、种子、provider | 不承载引擎逻辑 |
| 工具 | `src/tools/` | 面向模型的 15 个金融工具 | 不直接读写文件，走 domain |
| 定时任务 | `src/scheduler/` | 任务定义、依赖安装、独立进程执行、唤醒投递 | 不解析任务业务语义 |
| 领域 | `src/domain/` | 纯 TS：台账 / 策略 / 预判 / 复盘 / 交易日历 | 不依赖 dsh API |
| 日志 | `src/log/` | 门面、分级、去敏、trace、JSONL 落地 | 不记录明文敏感字段 |

## 两条贯穿原则

1. **标的无关**：工具、数据模型、脚本都以 `symbol` 为维度；prompt / skill 只写方法论，具体阈值遵循该标的的策略文档，绝不写死价格或数值。
2. **标的类型驱动**：`symbols.type`（`etf` / `stock`）决定行情数据源路由与交易单位。

## 生命周期与降级

- 所有注册都绑定 `ctx.effect`，插件卸载或 HMR 时自动注销。
- 工具模块图较重，故在 `apply` 内惰性 `import()`；`ctx.tools` 不可用时安全跳过，不中断装载。
- 资产 git 失败、waker 不可达、日志导出失败一律**降级告警**，不中断主流程。

## 相关

- [[concepts/tool-layer|工具层]]
- [[concepts/skill-system|Skill 体系]]
- [[concepts/scheduler|定时任务层]]
- [[concepts/assets-and-versioning|资产与版本]]

## 来源

- `README.md`
- `src/plugin.ts`
- `src/index.ts`
- `src/prompts/README.md`
- `src/domain/README.md`
