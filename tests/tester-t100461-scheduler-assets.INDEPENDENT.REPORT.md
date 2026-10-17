# T100461 独立测试报告 — 任务-04 任务定义/任务程序迁出到 assets

- **被测交付物**：任务-04「任务定义与任务程序迁出到 `assets/tasks` + `assets/programs`」
- **代码位置**：`/Users/reachlucifer/project/opc/worktrees/dsh-finance-feat-task-4-tasks-programs-assets`
- **分支 / 基线**：`feat/task-4-tasks-programs-assets`，HEAD `89ef363`（25 文件改动未提交 + 新增 Developer spec）
- **环境**：macOS（Reach 的 MacBook Pro）｜Node v25.9.0｜pnpm 11.7.0｜vitest 3.2.7
- **独立 spec**：`tests/tester-t100461-scheduler-assets.INDEPENDENT.spec.ts`（11 用例，全绿）
- **报告生成时间**：2026-10-17

## 一、总体结论

**通过（含 1 项 P3 文案偏差 + 2 个已知基线噪声）**。

- 验收 1–4、额外 5–12 的**功能行为全部通过**独立验证。
- 唯一偏差：额外 7 中 3 条「结构非法」路径虽被正确拒绝，但错误信息不含验收原文要求的 `必须以 assets/programs/ 开头`（P3，文案/一致性）。
- `tester-t100438-trace-context` 与 `tester-task11-scheduler-chain-integration` 各 1 例「唤醒文本含风险声明」失败，已在 **main `89ef363` 原样复现**，确认与本次改动无关。

| # | 验收项 | 结论 | 关键证据 |
|---|--------|------|----------|
| 1 | 调度器读取 `assets/tasks` + `assets/programs`，触发/唤醒链路正常 | ✅ 通过 | 独立 spec 用 fake timers 驱动真实 Scheduler + 真实 TaskLoader/TaskRunner/Waker：`install(cwd)` → `spawn(abs task.ts)` → `shouldWake` → `wake(taskId,data)` → followup 投递 |
| 2 | `task_path` 指向新位置；程序/依赖件在 `assets/programs/`；非法前缀被拒 | ✅ 通过 | 绝对路径断言 `= <home>/assets/programs/alpha/task.ts`，不含 `/assets/assets/`、不含 `/data/`；程序 `package.json` + `lib/x.ts` 均在程序目录内；9 条前缀矩阵全部按预期接受/拒绝 |
| 3 | `tsc --noEmit` EXIT=0；调度/任务链定向测试全绿 | ✅ 通过 | `pnpm -s typecheck` → `EXIT=0`；18 个定向文件 **344/344 通过**（已知基线噪声 2 文件单独跑，见第五节） |
| 4 | `DSH_IA_HOME=<tmp>` 下不产生 `<tmp>/data/tasks` | ✅ 通过 | store / 工具 CRUD / 调度链路用例均断言 `<tmp>/data/tasks` 与 `<tmp>/data` 均不存在 |
| 5 | `defaultTasksDir()` = `<home>/assets/tasks` | ✅ 通过 | `DSH_IA_HOME=<tmp>` 时精确等于；未设置时 `~/.dsh-ia/assets/tasks`（纯计算） |
| 6 | 程序绝对路径 = `<home>/assets/programs/<id>/task.ts` | ✅ 通过 | 编排 runner 传给 loader 的 cwd = `<home>/assets/programs/alpha`；传给 runner 的路径 = `<home>/assets/programs/alpha/task.ts` |
| 7 | 前缀校验矩阵（create/update） | ✅ 行为通过 / ⚠️ P3 文案偏差 | 接受 2 条、拒绝 7 条均成立；4 条前缀违规含指定短语，3 条结构非法仅含 `[path-guard] task_path 非法`（详见第六节） |
| 8 | 工具 CRUD 往返，落盘 `assets/tasks` | ✅ 通过 | create → list → get → update → delete 全链路；文件路径 `<home>/assets/tasks/crud-1.json`；失败更新不改写原记录 |
| 9 | loader 工作目录 = `assets/programs/<id>/`，依赖件可解析 | ✅ 通过 | 注入 InstallSpawner 捕获 cwd，并在 cwd 内实测 `package.json` 与 `lib/x.ts` 均存在 |
| 10 | 唤醒链路：taskId / 文本正确 | ✅ 通过 | `wakeCalls = [{taskId:'alpha', data:'BUY 600519'}]`；消息 text 逐字等于 `BUY 600519`；第二次触发因按 taskId 的 5 分钟冷却不重复投递 |
| 11 | 旧任务目录导出无残留 | ✅ 通过 | `grep -rn "resolveFinance[T]asksDir" src tests` → **无输出** |
| 12 | 破坏性 `rmSync` 已修复 | ✅ 通过 | `tester-path-fixed-dir` 中 `rmSync` 仅作用于 `tmpHome`（mkdtemp）；diff 显示原 `rmSync(base)`（base=`~/.dsh-ia`）已删除 |

## 二、独立 spec 用例明细（11/11 通过）

文件：`tests/tester-t100461-scheduler-assets.INDEPENDENT.spec.ts`

| # | 用例 | 覆盖 | 结果 |
|---|------|------|------|
| 1 | `DSH_IA_HOME=<tmp>` 时 `defaultTasksDir()` = `<tmp>/assets/tasks` | AC5 | ✅ |
| 2 | 未设置 `DSH_IA_HOME` 时回落 `~/.dsh-ia/assets/tasks`（纯计算） | AC5 | ✅ |
| 3 | 默认 store 只写 `<home>/assets/tasks`，不产生 `<home>/data` | AC4 | ✅ |
| 4 | `task_create → list → get → update → delete` 全链路 | AC4/AC8 | ✅ |
| 5 | `task_create` 接受 `assets/programs/p1/task.ts`、`.../lib/x.ts` | AC7 | ✅ |
| 6 | `task_create` 拒绝 4 条前缀违规，且错误信息含指定短语 | AC7 | ✅ |
| 7 | `task_create` 拒绝 3 条结构非法路径（`..` / 绝对路径 / 反斜杠） | AC7 | ✅ |
| 8 | `task_update` 接受合法 / 拒绝非法，且失败不改写原记录 | AC7 | ✅ |
| 9 | `task_path` 绝对路径解析（非 assets/assets、非 data） | AC2/AC6 | ✅ |
| 10 | fake timers：cron → loader → runner → woke → waker；冷却按 taskId | AC1/AC9/AC10 | ✅ |
| 11 | `applyScheduler({dataRoot})` 已 deprecated，不改变 assets/tasks 落点 | AC4 | ✅ |

## 三、关键命令与输出

### 3.1 类型检查（验收 3）

```bash
cd .../dsh-finance-feat-task-4-tasks-programs-assets
pnpm -s typecheck; echo "EXIT=$?"
# EXIT=0
```

### 3.2 独立 spec

```bash
pnpm exec vitest run tests/tester-t100461-scheduler-assets.INDEPENDENT.spec.ts
# Test Files  1 passed (1)
# Tests       11 passed (11)
# EXIT=0
```

### 3.3 定向测试批次（排除已知基线噪声文件）

```bash
pnpm exec vitest run --maxWorkers=2 \
  tests/task04-assets-tasks-programs.spec.ts \
  tests/tester-t100461-scheduler-assets.INDEPENDENT.spec.ts \
  tests/scheduler.test.ts tests/store.test.ts tests/scheduler-tools.test.ts \
  tests/loader.test.ts tests/runner.test.ts tests/scheduler-reload-race.test.ts \
  tests/tester-scheduler-real-faketimers.spec.ts \
  tests/tester-scheduler-task.INDEPENDENT.spec.ts \
  tests/tester-task9-scheduler-index.INDEPENDENT.spec.ts \
  tests/tester-task11-scheduler-tools-store-integration.INDEPENDENT.spec.ts \
  tests/tester-t100407-outcome-alignment.INDEPENDENT.spec.ts \
  tests/tester-t100411-taskid.INDEPENDENT.spec.ts \
  tests/t100411-taskid-contract.spec.ts \
  tests/tester-t100440-finance-home-path.INDEPENDENT.spec.ts \
  tests/tester-path-fixed-dir.INDEPENDENT.spec.ts \
  tests/tester-path-guard.INDEPENDENT.spec.ts

# Test Files  18 passed (18)
# Tests       344 passed (344)
# EXIT=0
```

### 3.4 已知基线噪声（worktree vs main）

worktree（本次分支）：

```bash
pnpm exec vitest run --maxWorkers=1 \
  tests/tester-t100438-trace-context.INDEPENDENT.spec.ts \
  tests/tester-task11-scheduler-chain-integration.INDEPENDENT.spec.ts
# Test Files  2 failed (2)
# Tests       2 failed | 46 passed (48)
# EXIT=1
```

main `89ef363`（`/Users/reachlucifer/project/opc/dsh-finance`）原样复现：

```bash
# 同样 2 个用例失败、46 passed；失败原因逐字一致：
# expected 'BUY 600519' to contain '本内容不构成投资建议'
# expected 'BUY...' to be 'BUY...\n\n> 本内容不构成投资建议'
```

根因与任务说明一致：既有提交 `5f3d9bc` 移除唤醒文本自动附加合规声明后，这两个 spec 未同步；**非本次任务-04 缺陷**。

> 说明：独立 spec 的 AC10 文本断言按**当前实际契约**（wake 正文 = `data` 原文）编写，因此不会被上述基线噪声影响；「合规声明缺失」作为既有问题单独跟踪，不计入任务-04 结论。

### 3.5 验收 11：旧导出清理

```bash
grep -rn "resolveFinance[T]asksDir" src tests   # 字符类写法，等价精确匹配，且避免报告自身命中
# （无输出）
```

### 3.6 验收 12：破坏性 rmSync 复核

```bash
grep -n -B2 -A2 "rmSync" tests/tester-path-fixed-dir.INDEPENDENT.spec.ts
# 79:    if (tmpHome) rmSync(tmpHome, { recursive: true, force: true })
# 119:    rmSync(tmpHome, { recursive: true, force: true })

git diff tests/tester-path-fixed-dir.INDEPENDENT.spec.ts
# -  beforeAll(() => { if (existsSync(base)) rmSync(base, { recursive: true, force: true }) })
# +  beforeAll(() => { tmpHome = mkdtempSync(...); process.env[FINANCE_HOME_ENV] = tmpHome })
```

`tmpHome` 均由 `mkdtempSync(join(tmpdir(), ...))` 创建；文件内已无任何指向真实 `~/.dsh-ia` 的删除/写入。人工逐行确认：第一组 describe 仅做纯路径断言；其余落盘用例全部覆盖 `DSH_IA_HOME=<tmp>`。

## 四、前缀校验实测输出（验收 7）

对 `task_create` 逐条探测（`task_update` 行为一致，且失败不落盘）：

```text
PATH= "tasks/p1/task.ts"            MSG= [path-guard] task_path 非法：必须以 assets/programs/ 开头
PATH= "data/tasks/p1/task.ts"       MSG= [path-guard] task_path 非法：必须以 assets/programs/ 开头
PATH= "assets/tasks/p1/task.ts"     MSG= [path-guard] task_path 非法：必须以 assets/programs/ 开头
PATH= "assets/programs"             MSG= [path-guard] task_path 非法：必须以 assets/programs/ 开头
PATH= "assets/programs/../x.ts"     MSG= [path-guard] task_path 非法：".."
PATH= "/abs/assets/programs/x.ts"   MSG= [path-guard] task_path 非法：<空字符串>
PATH= "assets\\programs\\x.ts"      MSG= [path-guard] task_path 非法："assets\\programs\\x.ts"
```

- **接受**：`assets/programs/p1/task.ts`、`assets/programs/p1/lib/x.ts`。
- **拒绝**：7/7 全部拒绝，无落盘。
- **偏差**：后 3 条（结构非法）在进入前缀判断前即被 `assertSafeSegment` / 反斜杠守卫拦截，错误信息不含 `必须以 assets/programs/ 开头`。

## 五、问题分级

### P3（文案/验收一致性，不阻塞）

**AC7 三种结构非法路径的错误信息不含验收指定短语**。

- 复现：见第四节。
- 期望：按验收原文，7 条拒绝均含 `必须以 assets/programs/ 开头`。
- 实际：4 条前缀违规含；3 条结构非法仅含 `[path-guard] task_path 非法：<原因>`。
- 影响：安全行为正确（均拒绝、均不落盘），仅错误提示与验收措辞不一致。
- 建议（二选一）：① 在 `safeTaskPath` 的结构校验失败处统一追加前缀提示；② 验收标准放宽为「前缀违规必须含该短语，结构非法按 `[path-guard]` 处理」。

### ⚠️ 残余风险（建议，不属本次验收失败）

- 前缀校验仅存在于 `tools.ts`。若有人**手工编辑** `assets/tasks/<id>.json` 写入绝对路径或 `../`，`scheduler` 的 `resolve(financeHome, taskPath)` 不会再次校验（绝对路径会覆盖 base）。当前威胁模型是「本机用户编辑自己的资产」，风险低；若后续要求资产可跨人共享，建议 store/loader 侧做一次防御性复核。

## 六、安全与边界声明

- **未运行全量 `pnpm test`**；仅运行上述定向文件。
- 所有用例使用 `mkdtempSync(tmpdir())` + `DSH_IA_HOME` 隔离；**未读写真实 `~/.dsh-ia`**。
- 未修改 `src/**`、未修改 Developer 的测试文件；仅新增本报告与独立 spec。
- 未执行 `git add` / `commit` / `push`。
- Developer 的 `tests/task04-assets-tasks-programs.spec.ts` 4/4 通过，本报告结论均来自独立用例，未复述其断言。
