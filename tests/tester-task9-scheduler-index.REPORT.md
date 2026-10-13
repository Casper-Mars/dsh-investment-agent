# 测试报告：`applyScheduler` 装配入口（飞书任务卡 t100385）

- **被测交付物**：`src/scheduler/index.ts` 的 `applyScheduler(ctx)` 装配入口 + `src/plugin.ts` 的接入
- **项目**：`/Users/reachlucifer/project/opc/dsh-ia`（Host = node「Reach的MacBook Pro」）
- **被测版本**：`main` 工作区（`src/plugin.ts` 已改、`src/scheduler/index.ts` 新增；`dist-server/` 已重建为含 scheduler 的产物）
- **测试环境**：Node v25.9.0 / pnpm 11.7.0 / vitest 3.2.7
- **测试人**：Tester（独立复验，未复用 Developer 用例、未做纯代码审查）
- **结论**：**全部验收点通过；`pnpm test` 全绿（EXIT=0）。未发现功能性缺陷；有 3 条可测性/健壮性建议（非阻断）。**

---

## 一、交付物清单

| 类型 | 文件 | 说明 |
|------|------|------|
| 新增 | `tests/tester-task9-scheduler-index.INDEPENDENT.spec.ts` | 独立装配层测试（21 用例） |
| 修改 | `tests/plugin-tools-registration.spec.ts` | 18→25 工具断言（2 失败用例） |
| 修改 | `tests/tester-strategy-feature.INDEPENDENT.spec.ts` | 18→25（1 失败用例；`bootRegistry` 的 18 为仅 `registerAllTools` 场景，保留） |
| 修改 | `tests/tester-task13-tools-registration.INDEPENDENT.spec.ts` | 18→25（2 失败用例；`REVIEW_MINUTE=18*60+30` 未误改） |
| 修改 | `tests/tester-task14-dsh-version-align.INDEPENDENT.spec.ts` | 18→25（2 失败用例；`REVIEW_MINUTE=18*60+30` 未误改） |
| 新增 | `tests/tester-task9-scheduler-index.REPORT.md` | 本报告 |

> 未改动 `src/**`；未 commit。

---

## 二、`pnpm test` 全量结果

```
Test Files  57 passed (57)
     Tests  1117 passed (1117)
  Duration  ~4.7s
EXIT=0
```

- 改造前基线：**7 failed / 1089 passed（共 1096）**（4 个文件，均为「恰好 18 工具」断言超时/失败）。
- 改造后：**0 failed / 1117 passed**（1089 + 修复 7 + 新增独立用例 21）。
- 附加：`pnpm typecheck`（`tsc -p tsconfig.json --noEmit`，仅 src）**EXIT=0**。

证据（节选）：
```
[EVIDENCE T13-1] ctx.tools.schemas() count=25 :: ledger_init,...,strategy_set,
                task_create,task_delete,task_disable,task_enable,task_get,task_list,task_update
[EVIDENCE T13-2] after pluginFiber.dispose(): schemas()=0, all 25 gone
[EVIDENCE B2]    ctx.tools.schemas() count=25 :: (dist-server 产物装载，同样 25)
[EVIDENCE B3]    after pluginFiber.dispose(): schemas()=0, 25 工具全部注销
[EVIDENCE 4]     plugin load -> tools=25, skills=5
```

---

## 三、逐条验收点结论

| # | 验收点 | 结论 | 证据/说明 |
|---|--------|------|-----------|
| 1 | `src/scheduler/index.ts` 存在，导出 `applyScheduler(ctx)` | ✅ 通过 | `T9-A`：`typeof applyScheduler==='function'`；源码含 `export function applyScheduler(` |
| 2 | `plugin.ts` 的 `apply()` 调用 `applyScheduler(ctx)`；顶层 inject 仍为四项 | ✅ 通过 | `T9-A`：源码匹配 `applyScheduler(ctx)` 与 `inject: string[] = ['tools','skills','ptcRuntime','fs']`；运行时 `plugin.inject` 相等 |
| 3 | 装配链完整（dataRoot→store→编排 runner→scheduler→软取 agents 建 waker→惰性注册 7 工具→effect start/stop） | ✅ 通过 | `T9-B`：`createScheduler` 入参含真实 `store.list` 与编排 `runner.run`；store 能读到由 `dataRoot` 派生的 `tasks/alpha`（不依赖 cwd）；7 工具惰性注册；两个 effect 标签齐备；`startCalls===1` 且 `running===true` |
| 4 | 编排 runner 运行时行为 | ✅ 通过 | 见下方「4.x」逐项 |
| 4.1 | taskId 反查（按 task_path → TaskDef.id） | ✅ 通过 | `T9-C1`：`loader.installTaskDeps('alpha', <dataRoot>/tasks/alpha)`、`runner.run(<dataRoot>/tasks/alpha/task.mjs)`；`T9-C2`：无匹配 → `skipped` 且不触达 loader/runner |
| 4.2 | loader 接入：LoaderError → `failed + failureKind='install'` | ✅ 通过 | `T9-C3`（loader 替身抛 LoaderError）、`T9-C3/真实`（**真实 loader**：任务目录不存在）、`T9-C3b/真实`（**真实 loader**：目录存在但缺 package.json）三例均 `kind='failed'`,`failureKind='install'`，且 runner 未被调用（未跑 pnpm） |
| 4.3 | runner 执行：四结局（quiet/woke/skipped/failed） | ✅ 通过 | `T9-C4`（quiet/skipped/failed 原样透传，含 failureKind）；`T9-F`（**真实 node 子进程**：quiet / woke(真实投递) / skipped(解析失败) / failed(exit=3,exec)） |
| 4.4 | woke 投递：`waker.wake(taskId, data)`，按 taskId 定点投递 | ✅ 通过 | `T9-C5`（**真实 createWaker** + 假 agents）：`targets` 含 `investment-advisor`，固定会话 `followup` 收到含 `data` 原文（`BUY 600519`）的消息 |
| 4.5 | 投递降级：waker 未就绪/`delivered:false` → skipped，不抛不中断 | ✅ 通过 | `T9-C6`：(a) agents 不可用→waker=undefined；(b) `delivered:false`；(c) `wake` 抛错。三例均 `kind='skipped'` 且不抛 |
| 5 | 软取降级：tools 不可用时 `applyScheduler` 不抛、不中断装载 | ✅ 通过 | `T9-D`：无 tools 服务 → 不抛且仍启动调度；最小上下文（`get` 全 undefined）→ 不抛、0 注册；`plugin.apply(最小 ctx)` 整体不抛 |
| 6 | 生命周期：卸载 `scheduler.stop()` 清 timer；幂等 start | ✅ 通过 | `T9-E`：apply 仅 `startCalls===1`；重复执行启停 effect body 不再 start；卸载 → `stopCalls===1`、`running===false`，二次卸载不再 stop；工具 effect 卸载 → 7 工具全注销。`T9-G`（**真实 scheduler + fake timers**）：到点触发→编排执行→链式重设；卸载后继续推进时间不再触发 |
| 7 | 顶层 inject 契约不变 | ✅ 通过 | `T9-A`：`plugin.inject === ['tools','skills','ptcRuntime','fs']`，源码字面量一致 |
| 8 | 旧 `src/runner/` 层（`applyRunner`）测试仍全过 | ✅ 通过 | `pnpm test` 全绿；`runner*.test.ts` 全部通过（含 `runner-real-process.test.ts` 真实进程四结局） |

### 独立性说明（避免只做代码审查）
- **装配层隔离**：以最小结构 ctx 替身（`get`/`inject`/`effect`）+ 真实 `TaskStore`（tmp 目录）+ `vi.mock` 注入的 loader/runner/waker **替身工厂**，捕获 `applyScheduler` 内部构造的「编排 runner」（`createScheduler({runner})` 入参）后**直接调用其 `run(taskPath)`** 逐链路验证。
- **不脱离真实**：`T9-F` 使用**真实 `createTaskRunner`（真实 node 子进程 spawn + stdout 解析）+ 真实 `createWaker`** 跑出四结局；`T9-C3/真实`、`C3b` 使用**真实 `createTaskLoader`** 触发 install 失败；`T9-G` 使用**真实 `Scheduler` + fake timers** 验证到点触发链。
- **契约核对**：`T9-A` 独立调用 `createSchedulerTools` 核对 7 个工具名，与真实装载注册的名称集合逐一致。

---

## 四、发现的缺陷 / 风险与建议

**未发现功能性缺陷。** 以下为可测性 / 健壮性建议（均非阻断，不影响本次验收）：

1. ⚠️ **`applyScheduler` 未暴露 loader/runner/waker/timer/clock 注入点（可测性）**
   `SchedulerApplyOptions` 仅含 `dataRoot / wakeTextBudget / wakeCooldownMs / logger`；编排 runner 是函数内部闭包，未导出。因此「用替身验证可注入性」只能通过**模块级 `vi.mock`** 达成（本报告即采用该方式），无法按任务书建议以「构造注入」直接替换。
   建议：为 `applyScheduler` 增加可选 `loader?/runner?/waker?/timer?/clock?` 注入项（默认走真实工厂），既保持生产行为不变，又便于上层装配测试与后续替换。

2. ⚠️ **每次触发全量 `store.list()` 反查 taskId（性能）**
   编排 runner 每次执行都读目录并按 `task_path` 线性匹配（O(n) 目录扫描 + JSON 解析）。任务量小可接受；若任务数增多，建议 store 侧增加按路径的索引/`getByPath`，避免每触发一次全量扫描。
   （行为正确性无问题：现查能感知 tools 写库后的最新清单。）

3. ℹ️ **`src/scheduler/index.ts` 顶部 `import { LoaderError }` 的绑定在函数体内未直接使用**（仅经 `export {...} from './loader.js'` 再导出）。
   当前 `tsconfig` 未开启 `noUnusedLocals`，`pnpm typecheck` 通过、运行无影响；如需整洁可移除该 import 绑定或改为 `import type`。

4. ℹ️ **首次触发时 agents 尚未就绪 → waker 为 undefined → 该次唤醒降级 skipped**。
   这是设计预期（§9 降级语义）而非缺陷；`waker` 为可变引用，agents 就绪后的后续触发即可正常投递。

---

## 五、备注

- 严格区分了两处「18」语义：工具数量断言已全部改为 25；`REVIEW_MINUTE === 18*60+30`（18:30 复盘）在 `task13/task14` 中**保持未改**。
- `tests/tester-strategy-feature.INDEPENDENT.spec.ts` 中 `bootRegistry` 辅助的 `toHaveLength(18)` 为**仅注册 `registerAllTools` 的基础场景**，非全插件装载，故保留 18（正确）。
- 未 commit（由 Leader 做最终交付）。
