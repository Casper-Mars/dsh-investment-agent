# T11 测试报告：scheduler 层（定时任务层）全套测试审计 + 补齐

- 任务卡：t100384（scheduler 层单测/集成/契约 + 全量回归）
- 被测路径：`/Users/reachlucifer/project/opc/dsh-finance`，branch `main`（HEAD `546f06e`）
- 唯一权威设计文档：《感知层详细设计（dsh-finance 插件）》 v0.7
- 结论：**审计通过 + 缺口补齐**。新增 2 个测试文件 / 18 用例；全量 `pnpm test` 全绿；`pnpm typecheck`、`pnpm build` 均 EXIT=0；旧测试零回归；**未改动任何 `src/**`**；**未 commit**。

---

## 一、审计结论（逐模块：已覆盖 / 新增补齐）

| 模块 | 既有测试 | 已覆盖判定 | 本次动作 |
|------|----------|------------|----------|
| `cron.ts` | `cron.test.ts` | ✅ **已足**：parseCron 合法/非法、next 基础/步进/区间/枚举、跨天/跨年、DOM `L`（含闰年 2/29、小月 30）、DOM/DOW OR 语义、周英文名与 `5L`、时区锁 Asia/Shanghai、环绕区间拒绝 | 不重写 |
| `store.ts` | `store.test.ts` | ✅ **基本足**：读写/remove/DI/corrupted 跳过/路径穿越拦截/跨实例恢复/同步落盘。**缺口**：落盘文件结构未做「恰含 TaskDef 五字段」级契约断言 | 新增契约用例（文件 B `T11-C1`） |
| `loader.ts` | `loader.test.ts` | ✅ **已足**：成功、非零退出/超时/spawn-error→`LoaderError(install)`、目录/package.json 缺失、`installTimeoutMs` 注入、真实超时时序 | 不重写；集成层复用以验证真实 loader 在链路中的行为 |
| `runner.ts` | `runner.test.ts` + `runner-real-process.test.ts` | ✅ **已足**：末行非空 JSON 解析、四结局映射、契约违约→skipped、failureKind（spawn/exec）、超时强杀时序、真实进程 e2e | 不重写；集成层用真实 runner + mock Spawner 复核 |
| `scheduler.ts` | `scheduler.test.ts` + `tester-scheduler-task.INDEPENDENT.spec.ts` + `tester-scheduler-real-faketimers.spec.ts` | ✅ **已足**：生命周期幂等、多 timer 独立、链式自调度、异常隔离、reload 全量重建、无泄漏、全可注入、真实定时器 | 不重写 |
| `tools.ts` | `scheduler-tools.test.ts` | ✅ **基本足**：7 工具、写后 reload、持久化复用、路径守卫、cron 校验、enabled、错误处理。**缺口**：用 **mock scheduler**（reload 仅计数），未验证「真实 Scheduler 在写库+reload 后确实调度新任务」 | 新增真实 tools→store→scheduler 端到端（文件 B `T11-I1`） |
| `wake.ts` | `scheduler-wake.test.ts` | ✅ **已足**：正文组装（+合规声明）、预算截断、摘要派生、定点投递、descriptor（dsh-finance/notice）、降级、冷却 | 不重写；集成层经由真实 Waker 复核投递 |
| `index.ts` | `tester-task9-scheduler-index.INDEPENDENT.spec.ts` | ✅ **基本足**：装配链、编排 runner 接线（mock runner）、软取降级、生命周期、真实 e2e、fake timers 触发链。**缺口**：T9 用 **mock runner**，从未让「真实 loader + 真实 runner」跑完 §4.3 全链路 | 新增真实全链路集成（文件 A `T11-I2`）+ failureKind 契约矩阵（文件 A `T11-C2`） |

**总览**：8 个模块的单测覆盖已相当完整，本次**未重写任何既有用例**，只做两类补齐——①「真实模块组合」的跨模块集成；②「文件结构 / failureKind」的契约固化。

---

## 二、新增清单

### 文件 B：`tests/tester-task11-scheduler-tools-store-integration.INDEPENDENT.spec.ts`（6 用例，无模块 mock，全真实模块 + 注入 timer/clock/runner）

- `T11-I1 tools→store→scheduler 端到端：写后即时生效`
  - `task_create` → 真实落盘 + `scheduler.reload()` → **新任务被真实 Scheduler 装上 timer**；到点触发 FakeRunner；`task_disable` → timer 清空（无泄漏）；`task_enable` → 重新调度；`task_update cron` → 按新 cron 重算到点时刻；`task_delete` → timer 清 + 磁盘记录消失。
  - 多任务并存：各自独立 timer；disable 其一不影响另一。
- `T11-C1 store 持久化结构契约`
  - 落盘 JSON **恰含** `id/name/cron/task_path/enabled` 五字段，round-trip（含跨实例）等价。
  - `list()` 对缺字段/类型不符记录判 `corrupted`；对多余字段记录仍接受（固化「结构守卫只做最小校验、不白名单裁剪」的既有行为）。
- `T11-B1 边界：月底 L cron 跨月`
  - `0 9 L * *`：2026-04-15 起算 → 4/30 09:00（Shanghai）触发 → 重设 5/31 09:00（跨月）。
  - 跨天：`0 0 * * *` 于 23:50 起算 → 次日 00:00 触发。全部经真实 cron 引擎 + 假 clock。

### 文件 A：`tests/tester-task11-scheduler-chain-integration.INDEPENDENT.spec.ts`（12 用例，`vi.mock` 仅换工厂产出、保留真实 Scheduler/编排 runner）

- `T11-I2 全链路（真实 loader/runner/waker + mock Spawner/InstallSpawner + 假 timer/clock）`
  - **到点 → 依赖就绪（真实 TaskLoader + mock InstallSpawner）→ 独立执行（真实 TaskRunner + mock Spawner）→ 解析 stdout → shouldWake=true → 真实 Waker 定点投递（mock agents）→ 链式重设**；第二轮因 5min 冷却不重复投递（附带验证 wake 冷却在链路中生效）。
  - `enabled=false` 不被调度；多任务同刻并发触发各自独立；卸载（`ctx.effect` dispose → `scheduler.stop`）后不再触发。
- `T11-C2 契约：failureKind 归因矩阵`
  - `install`（非零退出 / 超时强杀）→ `failed`/`failureKind=install`，且**不执行 runner**；
  - `spawn`（spawner 抛错）→ `failed`/`failureKind=spawn`；
  - `exec`（非零退出）→ `failed`/`failureKind=exec`；
  - `parse`（末行无有效 JSON / shouldWake 非 boolean）→ `skipped`（无 failureKind）；
  - `wake`（waker 未就绪 / 固定会话投递异常）→ `skipped`（不中断调度链）。

---

## 三、全量结果

| 项 | 命令 | 结果 |
|----|------|------|
| 全量单测 | `pnpm test` | **60 文件 / 1166 用例 全绿**（0 失败），EXIT=0 |
| 基线对比 | 基线 58 文件 / 1148 用例 | **≥ 基线**（+2 文件 / +18 用例），既有 1148 用例全部保持通过（逐文件全绿，无剔除/放宽） |
| 类型检查 | `pnpm typecheck` | EXIT=0 |
| 构建 | `pnpm build` | EXIT=0 |

改动范围：`git status` 仅两个新增测试文件，`src/**` 变更数 = 0；**未 commit**（留待 Leader 交付）。

---

## 四、缺口结论

- 单测维度（store/cron/loader/runner/scheduler/tools/wake/index）：**已达充分覆盖**，本次无重写。
- 集成维度：原 `scheduler-tools.test.ts`（mock scheduler）与 T9（mock runner）之间的**「真实模块 + 注入外设」组合缝**已由文件 A/B 补上——真实 `TaskStore`、真实 `Scheduler`、真实 `TaskLoader`、真实 `TaskRunner`、真实 `Waker` 与注入的 mock spawner / 假 timer / 假 clock 贯通，覆盖「写后即时生效」「到点→投递全链路」「失败归因矩阵」「月底/跨天边界」。
- 契约维度：`TaskDef` 落盘结构、`store.list` 容忍策略、`TaskRunOutcome` 四结局 × failureKind 归因已固化为断言。

## 五、产品缺陷

**未发现产品缺陷。** 两点**已确认符合设计的既有行为**（作为契约固化，非缺陷）：
1. `store.isTaskDef` 为最小结构守卫：**容忍多余字段**（不白名单裁剪），仅缺字段/类型不符判 `corrupted`。
2. `runner` 对「stdout 契约违约（无有效 JSON / shouldWake 非 boolean）」归为 **`skipped`** 而非 `failed`（§9「判定无效」语义），`failureKind` 仅用于 `failed`。

---

*报告路径：`tests/tester-task11-scheduler-tests.REPORT.md`（本文件）。新增测试：`tests/tester-task11-scheduler-chain-integration.INDEPENDENT.spec.ts`、`tests/tester-task11-scheduler-tools-store-integration.INDEPENDENT.spec.ts`。*
