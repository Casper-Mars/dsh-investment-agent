# Task-13 独立复验报告 —— 16 个模型工具经 plugin.apply 注册

- **测试者**：Tester（独立复验，不复用 Developer 的 `tests/plugin-tools-registration.spec.ts`）
- **项目**：`/Users/reachlucifer/project/opc/dsh-finance`
- **被测提交**：`ae1e14f`（fix(task-13): 插件 apply 装配阶段补齐 16 个模型工具注册）
- **运行时**：Node v25.9.0 / pnpm 11.7.0 / vitest 3.2.7
- **独立 spec**：`tests/tester-task13-tools-registration.INDEPENDENT.spec.ts`（8 用例）
- **日期**：2026-09-30

---

## 一、总体结论

> ✅ **PASS —— 16 个模型工具确实经真实 `plugin.apply` 注册，并在真实 dsh-tools
> ToolRuntime registry 上对模型可用；注销、安全降级、契约一致性均通过；全量回归零失败。**

| # | 验收项 | 结论 |
|---|--------|------|
| 1 | 16 工具经 apply 注册、对模型可用（真实 Context + 真实 ToolRuntime） | ✅ PASS |
| 2 | dispose 插件 fiber 后 16 工具全部注销（`ctx.effect` 生效） | ✅ PASS |
| 3 | `ctx.tools` 不可用时 apply 不抛错（安全降级） | ✅ PASS |
| 4 | 顶层 `inject` 与 `cordis.patch.yml` 完全一致 | ✅ PASS |
| 5 | 调度参数实际生效值核对（附带项） | ✅ PASS（见 §六） |
| 6 | 全量回归 473 用例全绿、无回归 | ✅ PASS |

---

## 二、独立性与方法

- **装载路径独立**：本复验以 **ES module 命名空间整体装载** 真实插件
  （`import * as pluginNs` → `app.plugin(pluginNs)`），走 cordis 的
  `isApplicable()` 分支；Developer 用的是手写 `{ name, inject, apply }` 对象字面量。
  两条路径互为交叉验证。
- **契约核对独立**：本复验 **直接读取 `cordis.patch.yml` 原文**并解析 inject 数组，
  再与运行时 `pluginNs.inject` 比对，而非引用同一常量。
- **真实 registry 管线**：`new Context()` → `provide('systemPrompt')`（ToolRuntime 依赖）
  → `app.plugin(ToolRuntime)` 提供真实 `ctx.tools` → 真实插件注册 16 工具，全程无 mock。

---

## 三、逐项证据

### ✅ 1. 16 工具经 apply 注册、对模型可用

命令：`npx vitest run tests/tester-task13-tools-registration.INDEPENDENT.spec.ts`

断言（真实 ToolRuntime）：
- `ctx.tools.schemas()` 长度**恰好 16**；
- 名称集合去重后大小 **16**（无重名）；
- 与期望 16 名**排序后逐一相等**；
- 16 个名字**逐一 `ctx.tools.get(name)` 均 defined**；
- 每个 wire schema 的 `description` **非空**（模型可见）。

实测证据：
```
[EVIDENCE T13-1] ctx.tools.schemas() count=16 :: ledger_init, ledger_list,
ledger_query, ledger_trade, predict_get, predict_make, predict_verify,
review_check, review_get, review_metrics, review_report, review_retrospect,
sense_archive_commit, sense_archive_get, sense_archive_list, sense_archive_rollback
```
分组核对（4+3+5+4=16）：
- ledgers：`ledger_init / ledger_list / ledger_query / ledger_trade` ✔
- predicts：`predict_make / predict_verify / predict_get` ✔
- reviews：`review_check / review_report / review_get / review_metrics / review_retrospect` ✔
- sense_archives：`sense_archive_commit / sense_archive_list / sense_archive_rollback / sense_archive_get` ✔

插件契约：`pluginNs.name === 'investment-advisor'`，`apply` 为函数。
装载期日志：`[dsh-finance] 插件加载：name=investment-advisor inject=[tools, skills, ptcRuntime, fs]`。

### ✅ 2. 注销验证

`await pluginFiber.dispose()` 后：
```
[EVIDENCE T13-2] after pluginFiber.dispose(): schemas()=0, all 16 gone
```
- `ctx.tools.schemas()` → **0**；
- 16 个名字逐一 `ctx.tools.get(name)` → **undefined**。
- 结论：`registerAllTools` 返回的注销器已正确绑定 `ctx.effect`，fiber 卸载即逆序注销。

### ✅ 3. 安全降级

最小上下文（`ctx.get()` 恒返回 undefined、无 `ctx.tools`）：
```
[EVIDENCE T13-3] minimal ctx (no tools): apply() no-throw; warn emitted
```
- `apply(ctx)` **不抛错**；
- 触发 effect 返回的注销器亦不抛错；
- 捕获到告警 `"[dsh-finance] tools 服务不可用，跳过工具注册"`。

### ✅ 4. 契约一致性

```
[EVIDENCE T13-4] yml inject=[tools, skills, ptcRuntime, fs] === plugin.inject
```
- `pluginNs.inject === ['tools','skills','ptcRuntime','fs']`；
- 独立解析 `cordis.patch.yml`（正则提取 `inject: [...]`）得到 `['tools','skills','ptcRuntime','fs']`；
- 二者**完全一致**。

---

## 四、调度参数核对（附带项，实测生效值）

来源：`src/runner/scheduler.ts` + `src/runner/sensor-runner.ts`（constants 在 §五 抽样断言）。

| 参数 | 生效值 | 常量/出处 |
|------|--------|-----------|
| 盘中脉冲周期 | **每 30 秒** | `PULSE_STEP_SECONDS = 30`（scheduler.ts） |
| 盘中脉冲窗口 | **9:30–11:30 / 13:00–15:00**（含端点） | `PULSE_WINDOWS = [[570,690],[780,900]]` |
| 盘后复盘时刻 | **18:30** | `REVIEW_MINUTE = 1110`（18×60+30） |
| 盘前准备时刻 | **9:25** | `PREP_MINUTE = 565`（9×60+25） |
| 唤醒冷却 | **5 分钟（300000ms）** | `DEFAULT_WAKE_COOLDOWN_MS = 5*60*1000` |
| 批处理上界 | **20 个标的/轮** | `DEFAULT_BATCH_LIMIT = 20` |
| 单次执行预算（附加） | 60s | `DEFAULT_SENSOR_TIMEOUT_MS = 60_000` |
| 单次唤醒文本预算（附加） | 2000 字符 | `DEFAULT_WAKE_TEXT_BUDGET = 2000` |

行为抽样（`[EVIDENCE T13-5/6/7]`）：
- `isPulseMinute(570)=true, (690)=true, (691)=false, (780)=true, (900)=true, (901)=false`；
- `REVIEW_MINUTE=1110`、`PREP_MINUTE=565`；
- `cooldown=300000ms, batch=20, timeout=60000ms, textBudget=2000`。

补充（`src/runner/index.ts` 的 `applyRunner`）：`onPrep` 默认启用
（`options.enablePrep === false ? undefined : () => runner.runPrep()`），
即默认存在 9:25 盘前准备回调；`isTradingDay` 默认接实时节假日源（失败降级为纯周末判定）。

---

## 五、回归结果（全量 `pnpm test`）

- **基线（加入本复验 spec 前）**：26 文件 / **465 用例全绿**。
- **加入本复验 spec 后全量**：27 文件 / **473 用例全绿**（= 465 + 8，无回归）。
- `pnpm typecheck`：**通过（exit 0）**。

重点回归域确认（均在 473 全绿内）：

| 回归域 | 对应文件 | 结果 |
|--------|----------|------|
| tools runtime | `tester-tools-runtime.spec.ts (26)` / `tools.test.ts (24)` | ✅ |
| skills 注册 | `prompt-skills.spec.ts (38)` / `tester-prompt-skills.INDEPENDENT.spec.ts (36)` | ✅ |
| advisor 注入 | `tester-prompt-skills.*`（含人设 section） | ✅ |
| runner 调度 | `runner-scheduler.test.ts` (14) / `tester-runner-task6*(57/31)` | ✅ |
| task8 | `tester-task8-e2e (6)` / `tester-task8-fix-reverify (14)` | ✅ |
| task7 | `task71-gaps (14)` / `task71-reverify (19)` / `tester-runner-task7-e2e (9)` | ✅ |

摘录：
```
Test Files  27 passed (27)
Tests  473 passed (473)
```

---

## 六、结论与建议

- **16 个模型工具确实对模型可用**：真实 cordis Context + 真实 `@deepseek-ai/dsh-tools`
  ToolRuntime 下，`plugin.apply` 通过惰性 `import('./tools/index.js') → registerAllTools(ctx)`
  注册，`ctx.tools` 恰好暴露 16 个工具（名称/分组逐一相符、可 `get`、`description` 非空）。
- 注销随 `ctx.effect` 生效；`tools` 服务不可用时安全降级；顶层 `inject` 与
  `cordis.patch.yml` 完全一致。
- **无回归**：全量 473 用例全绿（较基线 465 新增 8，均为本复验 spec），typecheck 通过。
- 未发现需要 Developer 修复的问题。后续建议：任务无阻塞，可进入验收归档。

---

## 附录：复现命令

```bash
cd /Users/reachlucifer/project/opc/dsh-finance
# 独立复验（8 用例）
npx vitest run tests/tester-task13-tools-registration.INDEPENDENT.spec.ts
# 全量回归
pnpm test
# 类型检查
pnpm typecheck
```
