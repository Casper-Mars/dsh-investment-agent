# t100438 · M4 trace 上下文（AsyncLocalStorage）· Tester 独立验收报告

- **任务**：t100438（飞书待办）— M4 `trace 上下文` 运行时行为 + 对抗性验证
- **被测交付物 HEAD**：`8fab3b2`（`feat(log): t100438 M4 trace 上下文…`，已 commit）
  - `src/log/trace.ts`（新增）、`src/log/logger.ts`（改）、`src/scheduler/index.ts`（改）、
    `src/message-source.ts`（改）、`src/scheduler/wake.ts`（改）、`tests/trace.test.ts`（新增，dev 自测 18 用例）
- **执行节点**：`Reach的MacBook Pro`（Node v25.9.0 / pnpm 11.7.0）
- **交付物（本次）**：
  - `tests/tester-t100438-trace-context.INDEPENDENT.spec.ts`（**36 用例**，自成体系）
  - 本报告
- **环境隔离**：全程用临时 `DSH_IA_HOME` + 临时 `DSH_IA_LOG_DIR` 覆盖，**未触碰真实 `~/.dsh-ia`**；未改动任何 `src/**`（复验后 `git diff src/` 为空）；`scripts/jev-news-demo.*` 未触碰。

## 结论：✅ **通过**

> 未发现「同链路 traceId 不一致 / 并发串号 / 唤醒消息未携带 traceId」中的任一问题。
> 四条验收标准全部满足；无回归。

---

## 1. 验收标准逐条核验

| # | 验收标准 | 结论 | 关键证据 |
|---|----------|------|----------|
| 1 | 同一次唤醒链路的日志行 `traceId` 一致，可串联 | ✅ 通过 | 真实 `Context`+`applyScheduler`，注入「链路内模块」替身跨 `await` 打 3 条门面日志 → 3 条全部带**同一** `traceId`（set.size===1），且与 waker 实际投递消息 `source.traceId` **相等**；两个 fire 各自 `traceId` **不同**（都符合 UUIDv4） |
| 2 | 跨进程唤醒后 `traceId` 不丢失（经消息显式传递） | ✅ 通过 | 真实 `createWaker` + mock agents 捕获 `followup`：投递消息 `source.traceId` == 该 fire 的 `traceId`（断言相等，非仅「非空」）；`source.kind==='dsh-ia'`、`form==='notice'`；全真实 runner（mock spawner 产 `woke`）路径同样携带有效 `traceId`，且不同 fire 不同 |
| 3 | **无第三方依赖**：AsyncLocalStorage 用 `node:async_hooks`；测试可驱动 | ✅ 通过 | 静态核验 `src/log/trace.ts` 的全部 `import` 均以 `node:` 开头，且含 `node:async_hooks`/`node:crypto`；`package.json` 无 `pino`/`winston`/`cls-hooked`；`logger.ts`/`wake.ts`/`message-source.ts` 无第三方日志库 import |
| 4 | 既有测试不回归（基线 63 文件 / 1267 用例；typecheck/build/test 全 EXIT=0） | ✅ 通过 | 复现基线 **63 文件 / 1267 用例 EXIT=0**；`pnpm typecheck` **EXIT=0**；`pnpm build` **EXIT=0**；加入本用例后全量 **64 文件 / 1303 用例 EXIT=0**（+1 文件 / +36 用例，零失败） |

---

## 2. 对抗性用例矩阵（36 用例，全绿）

### ① trace 原语（9）
- `newTraceId` 严格匹配 **UUID v4** 正则且 1000 个两两不同；无上下文 `getTrace()→undefined`。
- 上下文经 `await` / `setTimeout` / `queueMicrotask` / `process.nextTick` **均传播**（4/4 命中）。
- 嵌套 run 内层覆盖/退出恢复；`enterWithTrace` 在当前执行生效、退出恢复无上下文。
- `runWithTrace` **不吞异常**（同步 throw 原样抛、异步 reject 原样 reject）。

### ② 并发/嵌套隔离（2，重点）
- **5 条并发链交错 await**（各 5 条日志）：每条链自证 `getTrace()===自身 id`，日志 meta 无串号，退出后无残留。
- **嵌套并发**：外层 `OUT` 内并发开 `IN-A`/`IN-B`（含不同 await），内外层互不污染，退出恢复外层。

### ③ 门面合并（7）
- 无 trace：`args` **逐字等于现状**（无 meta→单参；有 meta→原样，含显式 `traceId:undefined` 也不被门面篡改）。
- 有 trace：error/warn/info/debug **四级 + 两层 `child` 深派生**均附加 `traceId/taskId/sessionId`。
- trace 仅含 `traceId` 时**不注入**缺失可选字段（无空值键）。
- 优先级：**调用级 meta > trace > 基础 meta**（同名键逐层覆盖）；调用级新字段与 trace/base 共存。
- 降级路径（无 native→console）同样合并 trace 且不抛；真实 `ctx.logger` exporter 收到的 `Message.args[1]` 含 trace。

### ④ 唤醒显式携带（8）
- 上下文内 `wake` → 消息 `source.traceId==当前`；**显式入参优先于上下文**；**显式 undefined 时回落 `getTrace()`**；无上下文且未显式 → 消息**不含** `traceId` 字段。
- 契约不破：`kind==='dsh-ia'`、`form==='notice'`、`summary ≤ 120`；`buildWakeText`/`deriveSummary` 输出**逐字不变**；超长单行（5000 字符）`summary` 精确截断为 120。
- `createNoticeMessage(text,summary)` 第 3 参缺省行为兼容。

### ⑤ 端到端（6，重点；真实 cordis `Context` + 真实 `applyScheduler`/`tracedRunner`/`Scheduler`/`createWaker`）
- 触发一次：链路内 3 条日志同一 `traceId`，且 waker 投递消息携带**同一** traceId；`data` 内编码的 traceId 亦一致。
- 两个 fire：traceId 不同；同一 fire 内一致。
- **两任务同刻并发触发**：各自 traceId 独立、不串号。
- 全真实 runner（mock spawner 产出 `woke`）：消息携带有效 traceId，且不同 fire 不同。
- tracedRunner 捕获：进入即 `newTraceId()`，且 `taskId`/`sessionId` 正确（`sessionId===getPinnedSessionId()`）。
- **characterization**：scheduler 自身的「触发 / 结局消费」日志在 tracedRunner **之外**（不带 traceId），链路内日志才带 —— 精确刻画作用域边界（见 §5）。

### ⑥ 无第三方依赖（2） / ⑦ 降级（2）
- 静态：`trace.ts` 仅 `node:*` import；`package.json` 无第三方日志/上下文依赖。
- **模拟 `node:async_hooks` 构造抛错**（隔离模块图 `vi.doMock`+`resetModules`）：`getTrace()→undefined`、`runWithTrace` 直接执行 `fn` 且返回其值、`enterWithTrace` no-op，**全程不抛**。

---

## 3. 关键证据（端到端捕获，节选）

真实 `Context` + `applyScheduler`，注入链路内替身打日志，export 捕获到的 `Message`：

```jsonc
// 链路内（runner.run 内部）—— 全部同一 traceId
{"name":"fake-runner","type":"info","args":["step-0",{"traceId":"ff79e8cf-…-…","taskId":"alpha","sessionId":"investment-advisor-6773e454"}]}
{"name":"fake-runner","type":"info","args":["step-1",{"traceId":"ff79e8cf-…-…","taskId":"alpha","sessionId":"investment-advisor-6773e454"}]}
{"name":"fake-runner","type":"info","args":["step-2",{"traceId":"ff79e8cf-…-…","taskId":"alpha","sessionId":"investment-advisor-6773e454"}]}
// waker 实际投递的 notice 消息 —— source.traceId 与上面相等（跨进程显式携带）
// source = { kind:"dsh-ia", form:"notice", summary:"…", traceId:"ff79e8cf-…-…" }
```

> 说明：`ff79e8cf-…` 为随机生成（UUIDv4）；断言用「相等/不同」而非固定值，规避漂移。

## 4. 测试敏感性（变异验证 · 证明用例非空转）

临时对 `src/**` 做定向变异 → 跑本用例 → 记录失败数 → **立即用备份还原**（复验后 `git diff src/` 为空）：

| 变异 | 破坏点 | 结果 |
|------|--------|------|
| M1 | `logger.ts` `mergeEmitMeta` 改为不合并 trace（`return mergeMeta(base, meta)`） | **10 failed** / 25 passed |
| M2 | `wake.ts` 去掉 `getTrace()` 回落（`resolvedTraceId = traceId`） | **4 failed** / 31 passed |
| M3 | `scheduler/index.ts` tracedRunner 不经 `runWithTrace` | **5 failed** / 30 passed |

→ 三条核心性质（门面合并 / 唤醒回落携带 / 编排进入 trace）**均被本用例有效捕获**。

## 5. 风险点 / 建议（⚠️ 非阻断）

1. **作用域边界（已知设计取舍，非缺陷）**：trace 上下文由 `tracedRunner` **只包裹编排体**。`Scheduler.fire()` 在调用 runner **之前**的「`[scheduler] 任务 X 触发`」日志、以及 runner 结束后 `.then/.catch/.finally` 中的「结局消费」日志，均在 ALS 作用域**之外**，**不带 traceId**。
   - 影响：一次 fire 的**链路内**日志（orchestration/loader/runner/wake）可完整串联；但「触发/消费」两行需靠调度层其它维度关联。
   - 建议（如需全链路串联）：将 `fire` 的触发日志与结局消费日志一并纳入同一 traceId（例如把 `runWithTrace` 作用域上提到 `fire`，或在 `fire` 生成 traceId 并传入 runner）。**当前不影响验收通过**（AC1 要求的是「链路日志 traceId 一致」，已满足）。
2. **跨进程子进程日志**：任务子进程 stdout/stderr 由 runner 独立采集（M3），**不带** traceId（跨进程 ALS 天然失效）。本里程碑已按设计「不依赖 ALS 跨进程传播」，改由唤醒消息显式携带 traceId —— 与验收一致，无需修改。

## 6. 复现步骤

```bash
# 节点：Reach的MacBook Pro
cd /Users/reachlucifer/project/opc/dsh-ia
git rev-parse HEAD                      # 期望 8fab3b2…

# 独立用例（36）
npx vitest run tests/tester-t100438-trace-context.INDEPENDENT.spec.ts

# 门禁
pnpm typecheck     # EXIT=0
pnpm build         # EXIT=0
pnpm test          # 64 文件 / 1303 用例，EXIT=0（基线 63/1267）

# 隔离说明：用例内自设临时 DSH_IA_HOME / DSH_IA_LOG_DIR，结束自动清理；
# 真实 ~/.dsh-ia 不被写入。
```

---

*Tester 独立复验 | 不复读 Developer 自测 | 只测不改 | HEAD 8fab3b2*
