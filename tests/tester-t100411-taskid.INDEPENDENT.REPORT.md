# Tester 独立测试报告 —— t100411 调度契约收紧（携带 taskId）+ 去反查

- 被测交付物：`/Users/reachlucifer/project/opc/dsh-finance`（工作树未提交改动，branch=main）
- 改动文件：`src/scheduler/index.ts`、`src/scheduler/scheduler.ts` + 8 个既有 spec 同步签名 + 新增 `tests/t100411-taskid-contract.spec.ts`
- 目标节点：Reach的MacBook Pro（Node v25.9.0 / pnpm 11.7.0）
- 测试者：Tester（独立复跑 + 独立自建，不信任自述）
- 独立用例：`tests/tester-t100411-taskid.INDEPENDENT.spec.ts`（8 用例）

---

## 0. 结论速览

| 验收标准 | 判定 | 证据 |
|---|---|---|
| AC1 scheduler→orchestrator **不再按 task_path 反查 taskId** | ✅ PASS | 静态：`index.ts` 无 `store.list()`/`find`；动态：B2/B4 证明按入参执行；反向：旧实现 10 用例失败 |
| AC2 测试覆盖「同 task_path 两任务不串扰」 | ✅ PASS | A1/A2 + B3/B4 独立断言 id 各自独立；反向可复现串扰 |
| AC3 `pnpm typecheck` + `pnpm test` 通过（904→907） | ✅ PASS | typecheck EXIT=0；纯净交付物 44 files / **907** tests 全绿 |

**明确结论**：
- 反查是否彻底移除：**是**（源码零残留，仅注释提及）。
- 同路径是否零串扰：**是**（契约层 A1/A2、编排层 B3/B4 均各自命中自己的 id）。
- 既有行为是否零回归：**是**（907 全绿；epoch 守卫 / read-file 门禁 / 真实子进程 四结局 专项复跑均通过）。

---

## 1. 改动静态审阅

- `TaskRunnerLike.run(taskPath)` → `run(taskId, taskPath)`（`scheduler.ts:66-72`）。
- `Scheduler.fire()` 两条触发路径均透传 id：
  - `scheduler.ts:323` `this.fire(task.id, schedule, taskPath)`（`scheduleTask` 装配路径）
  - `scheduler.ts:413` `this.fire(id, schedule, taskPath)`（`rescheduleAfterFire` 链式自调度路径）
  - `scheduler.ts:356` `this.runner.run(id, taskPath)`
- `index.ts` 编排层：`orchestratedRunner.run(taskId, taskPath)` 直接用入参；`absTaskPath=resolve(dataRoot, taskPath)`；**删除**了 3a 的 `store.list().find(t => t.task_path === taskPath)` 及「未找到 → skipped」分支。
- `store.list()` 残留调用仅为合法路径：`scheduler.ts:278`（scheduler 自身 `rebuildFromStore` 读清单）、`tools.ts:260`（工具列举），与编排层反查无关。
- 真实 `TaskRunner.run(taskPath, args?)`（`runner.ts:302`）**未被改动**（`git diff HEAD -- src/scheduler/runner.ts` 为空）；编排层仍调 `taskRunner.run(absTaskPath)`（单参），进程执行路径无回归。

---

## 2. 独立复跑结果（不信任自述）

### 2.1 纯净交付物（未加 tester 用例）
```
pnpm typecheck   → EXIT=0
pnpm test        → Test Files 44 passed (44) | Tests 907 passed (907)   ✅ 基线 904→907 吻合
```
新增 `t100411-taskid-contract.spec.ts` 恰为 3 用例，落在 44 files / 907 tests。

### 2.2 加入 tester 独立用例后（45 files）
```
pnpm typecheck   → EXIT=0
pnpm test        → Test Files 45 passed (45) | Tests 915 passed (915)   ✅
```
> 说明：`915 = 907（Developer 基线）+ 8（Tester 独立用例）`。Tester 独立 spec 依本仓既有惯例（大量 `tester-*.INDEPENDENT.spec.ts`）保留。

---

## 3. 独立自建验证（运行时行为）

### 3.1 契约层（真实 Scheduler，替身 store/runner/timer/clock）
- **A1** 同 path 两任务（id=a/b，同 cron）同时到点 → `runner.run` 收到 `path=[SHARED,SHARED]`、`id={a,b}`；断言「path 恒为 SHARED、id 不出现错位」。**PASS**
- **A2** 链式自调度第二代（推进 1 分钟后 `rescheduleAfterFire` 重装的 timer 再 fire）→ 两代各含 a、b 一次，path 恒为 SHARED。**PASS**（覆盖 reload/链式两路的 id 透传）
- **A3** 单任务 → 收到 `{id:'solo', path:SHARED}`，顺序 id 在前（防签名错位回归）。**PASS**

### 3.2 编排层（真实 applyScheduler + 真实 store，替身 loader/runner/waker）
- **B1** 清单无该任务、入口存在 → 仍按入参 id 执行，`loader.installTaskDeps(taskId='standalone', taskDir)` 按入参调用。**PASS**
- **B2** 清单为空 + 入口存在 → `woke`，`wake('onlyarg')`。旧实现会因反查失败 → skipped。**PASS（证明反查已移除）**
- **B3** 同 path 两任务 a/b，`run('b', path)` → `wake('b')`（旧实现会取首个 a）。**PASS**
- **B4**（更强）store 里同 path 的却是 **另一个 id「x」**，以 `run('b', path)` 触发 → `wake('b')`（若仍反查必命中 x）。**PASS**
- **B5** 入口缺失 → `skipped` 且不触达 loader/runner（去反查不影响 §9.1 门禁）。**PASS**

---

## 4. 反向验证（关键）——临时恢复旧实现

方法：`git show HEAD:src/scheduler/{index,scheduler}.ts` 覆盖工作树（恢复 `run(taskPath)` + `store.list()` 反查），跑两套 spec，随后用备份原样还原（`diff` 校验干净）。

结果：
```
Test Files  2 failed (2)
     Tests  10 failed | 1 passed (11)
```
- Developer `t100411-taskid-contract.spec.ts`：3/3 失败。
- Tester 独立 spec：7/8 失败（唯一通过的 B5=入口缺失 skipped，与新旧无关）。
- 失败机理：旧 `run(taskPath)` 下，`orch().run('b', path)` 把 'b' 当 path → 反查 `task_path==='b'` 无果 → `skipped`；契约层则收到 `{id: path, path: undefined}` 错位。

⇒ **新契约确实消除了「按 task_path 反查」这一歧义来源**；上述用例对旧实现有真实检出能力（非恒真断言）。

还原校验：`diff 备份 工作树` 无差异；`grep runner.run` 恢复为 `run(id, taskPath)`；随后全量复跑 915 全绿。

---

## 5. 回归专项（命名证据）

```
tests/scheduler-reload-race.test.ts                              ✅ (t100406 epoch 代际守卫/reload-fire 竞态)
tests/tester-t100407-outcome-alignment.INDEPENDENT.spec.ts       ✅ (t100407 read-file 门禁 + 四结局对齐, 28)
tests/tester-task11-scheduler-chain-integration.INDEPENDENT.spec.ts ✅ (链路集成)
tests/tester-task9-scheduler-index.INDEPENDENT.spec.ts           ✅ (装配链完整性, 22)
tests/runner-real-process.test.ts                                ✅ (真实 node 子进程：woke/quiet/failed-exec)
→ Test Files 5 passed (5) | Tests 72 passed (72)
```
四结局（woke/quiet/failed(parse)/failed(exec)）、缺文件 skipped、超时 failed/exec、epoch 守卫、read-file 门禁均正常。

---

## 6. 风险 / 建议

- ⚠️ 语义变更提示（非缺陷）：「同 path 两任务」在旧实现下 store 反查取首个，属既有歧义；新实现按触发任务自身 id 投递，行为更正确。若存在依赖旧「取首个」行为的隐含假设（未见此类用例），需知会。
- ⚠️ 「定义过期」取舍：去掉现查后，安全性依赖「fire 携带的 id/path 与装配同源」+「写库触发 reload」+「epoch 守卫」。已由 A2/t100406 覆盖；建议保持该三点为不变量。
- ℹ️ 测试计数：纯净交付物 907（44 files）符合 AC；Tester 独立 spec 使总数达 915（45 files），如需与 AC 严格一致可移除 tester 独立文件。

---

## 7. 判定

| 项 | 结论 |
|---|---|
| AC1 去反查 | ✅ PASS（源码零残留 + 运行时证明 + 反向可复现） |
| AC2 同 path 不串扰覆盖 | ✅ PASS |
| AC3 typecheck + test | ✅ PASS（EXIT=0；907 全绿；44 files） |
| 反向验证 | ✅ 旧实现 10/11 失败，检出有效 |
| 回归 | ✅ 零回归（907/915 全绿，专项复跑通过） |

**总判定：PASS。** 反查已彻底移除，同路径零串扰，既有行为零回归。
