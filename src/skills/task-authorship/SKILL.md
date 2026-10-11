---
name: "task-authorship"
description: "如何为定时任务层编写/修改任务程序：结构、返回值、依赖声明、结果回传、版本管理。"
whenToUse: "生成、修改或替换某个定时任务的任务程序时。"
---

# 任务程序创作（task-authorship）

## 定位

`task-authorship` 指导 agent 编写 / 修改**任务程序**——一段由 agent 生成、被定时任务层按 cron 在独立 Node 进程里执行的 TypeScript 代码。它回答一个问题：

> **「到点跑这一次，该做什么？做完之后，要不要唤醒 agent？」**

职责边界**只有两件事**：

1. **执行**：拉数据、处理、计算（自由 `import` 依赖、发 HTTP、调 SDK）。
2. **判读**：判断结果是否值得唤醒 agent，并给出唤醒正文（`data`）。

交易判断属于 agent（被唤醒后依据其它 skill 作出）；「何时跑」由 `data/tasks/*.json` 的 cron 决定，经 `task_create` 注册。

## 任务程序结构

标准 ESM TypeScript，默认导出一个 async 函数：

```typescript
// task.ts —— 任务程序入口
export default async function task(): Promise<TaskScriptResult> {
  const res = await fetch('https://api.example.com/quote')
  const data = await res.json()

  // ... 业务逻辑 ...

  return { shouldWake: true, data: '给 agent 看的正文' }
  // 或 return { shouldWake: false }
}
```

技术栈与 dsh 一致：TypeScript + Node，支持顶层 `await`、`import` 任意 npm 包、`fetch`。

## 返回值契约（`TaskScriptResult`）

`return` 值必须是以下两种之一：

```typescript
type TaskScriptResult =
  | { shouldWake: true; data: string }  // 需要唤醒；data 为唤醒正文
  | { shouldWake: false }               // 无需唤醒
```

- `shouldWake`：**必须为 boolean**，非 boolean（或缺省）→ 运行时报 `skipped`。
- `data`：**字符串**，仅在 `shouldWake=true` 时提供，逐字作为唤醒正文。

## 依赖声明（`package.json`）

用到的第三方包写进该任务目录自己的 `package.json`：

```json
{
  "name": "dsh-finance-task-<id>",
  "type": "module",
  "dependencies": {
    "cheerio": "^1.0.0",
    "puppeteer": "^22.0.0"
  }
}
```

依赖按任务隔离安装，`package.json` 变依赖随之变；首次跑某组合有安装延迟，之后命中缓存。

## 结果回传（stdout JSON）

把返回值写成一行 JSON 打印到 stdout：

```plaintext
（任务进程 stdout 最后一行）
{"shouldWake":true,"data":"..."}
```

进程非零退出、stdout 无有效 JSON、或结构非法 → 运行时走降级（`failed` / `skipped`）。

## 版本管理（git）

更新任务程序 → `git commit`；回滚 → `git checkout` / `git revert`。定时层直接跑工作区的 `task.ts`。

## 反例

- ❌ 不做交易判断（买 / 卖 / 减仓 / 仓位调整）。
- ❌ 不写死 cron 触发时间。
- ❌ 不写宿主的全局数据目录。
- ❌ 超时久跑（应在 `taskTimeoutMs` 默认 60s 内完成）。

## 与定时规则的配合

一个任务程序要生效，遵循「编码 → 测试 → 注册」三步闭环（均由 agent 完成）：

1. **写程序**：按本 SKILL 写好 `tasks/<id>/task.ts` + `package.json`。
2. **测试**：真实执行一次，校验两件事：
   - **跑得起来**：正常退出、无异常抛出、不超时（`taskTimeoutMs` 默认 60s 内）、返回结构符合 `TaskScriptResult` 契约、`shouldWake` 是合法 boolean。
   - **干的活对**：抓对数据、判读逻辑产生预期 `shouldWake`。由 agent 读程序输出的富信息（原始数据 + 中间指标 + 触发对比值）自行判断。
3. **注册 / 修复**：测试通过 → 经 `task_create({ id, name, cron, task_path })` 注册，`task_path` 指向该 `task.ts`；测试不通过 → 修复程序回到第 1 步，再测，直到通过。

纪律：**写完必须测试验证通过才允许 `task_create` 注册；测试不通过就修复、修复后再测，直到通过**。这是开发纪律，不是可选项。程序的正确性靠 agent 自测纪律保证，而非任何注册前的强制校验机制。

程序只管「跑一次做什么」，cron 只管「什么时候跑」；改逻辑动程序，改频率动 cron。

必要时，可 spawn 一个 subagent 独立执行「编码-测试-修复」循环：当任务程序较复杂、或希望获得独立复核视角时使用（经 dsh 官方 subagent 委派工具，由宿主装配，非本插件实现）。子 agent 交付后，agent 仍需复核其产出是否符合策略意图，再决定是否注册。
