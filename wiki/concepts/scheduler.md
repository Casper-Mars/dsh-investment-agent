# 定时任务层（感知层）

> 独立于插件主进程的“定时执行 + 唤醒”链路：任务定义是资产，任务程序跑在独立 Node 进程，结果三结局映射后按需投递给固定会话。

## 链路

```
cron 触发
  └─ scheduler（多任务独立调度）
       └─ 编排 runner
            ├─ 任务程序可读性校验
            ├─ loader：任务目录内 pnpm install（按任务隔离依赖）
            ├─ runner：独立 Node 进程执行，取 stdout 最后一个非空行 JSON
            ├─ 解析 TaskRunOutcome（三结局）
            └─ shouldWake=true → waker.wake(taskId, data)
```

## 三个组件的边界

| 组件 | 知道什么 | 不知道什么 |
|---|---|---|
| `loader.ts` | 任务目录、package.json、pnpm | 任务业务语义 |
| `runner.ts` | 起进程、stdout 解析、超时与 OOM 防护 | 任务内容、依赖安装 |
| `wake.ts` | 固定会话、文本预算、冷却 | 任务如何产生结果 |

## 关键语义

- **依赖隔离**：每个任务目录独立 `pnpm install`，不做“是否已安装”判断，幂等执行；默认 120s 超时，失败归因 `install`。
- **执行隔离**：独立 Node 进程，无 bindings 白名单；默认 60s 超时；stdout 上限 1 MiB，超限强杀，归因 `exec`。
- **结果契约**：stdout 最后一个非空行必须是 JSON，映射为 `TaskRunOutcome` 联合类型。
- **唤醒护栏**：waker 不可达 / 投递异常 → `skipped`，不抛错；正文默认预算 2000 字符；同一 `task_id` 默认 5 分钟冷却。
- **资产落点**：`<assets>/tasks`（定义）与 `<assets>/programs`（程序）都是可共享资产，写入即 commit。

## 7 个工具

`task_create` / `task_list` / `task_get` / `task_update` / `task_delete` / `task_enable` / `task_disable`。

## 相关

- [[concepts/architecture|架构总览]]
- [[concepts/assets-and-versioning|资产与版本]]

## 来源

- `README.md`
- `src/scheduler/index.ts`
- `src/scheduler/loader.ts`
- `src/scheduler/runner.ts`
- `src/scheduler/wake.ts`
- `src/scheduler/tools.ts`
