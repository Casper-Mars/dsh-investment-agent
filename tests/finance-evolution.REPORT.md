# t100471 任务-03：finance-evolution 注册与内容契约测试报告

- 项目：`/Users/reachlucifer/project/opc/dsh-finance`
- 基线：`HEAD=badb55a`（工作区干净）
- 交付：`tests/finance-evolution.spec.ts`（仅新增测试，未改 `src/**`，未 commit/push）
- 运行环境：macOS（Reach的MacBook Pro），`vitest 3.2.x`

## 1. 用例统计

| 分组 | 用例数 |
|---|---|
| 静态注册：3 个固有 SKILL | 1 |
| 注册对象契约 `createFinanceEvolutionRegistration()` | 4 |
| frontmatter 契约 | 2 |
| 正文关键契约 | 8 |
| 不是可进化种子 | 2 |
| **合计** | **17** |

单文件结果：`17 passed (17)`。

## 2. 逐条验收

### 2.1 静态注册数量与名称 —— PASS
- `apply(ctx)`（mock ctx：`skills.register` / `tools.register` / `systemPrompt.section`）后，`registeredSkills` 长度恰为 **3**。
- 名称集合恰为 `task-authorship`、`skill-authorship`、`finance-evolution`。
- 三者 `source` 均为 `runtime`。
- 用例：`静态注册：3 个固有 SKILL > apply 后静态注册恰为 task-authorship / skill-authorship / finance-evolution`。

### 2.2 注册对象契约 —— PASS
直接调用 `createFinanceEvolutionRegistration()` 断言：
- `name === 'finance-evolution'`，`description` 非空；
- `source === 'runtime'`；
- `invocation.modelInvocable === true`；
- `invocation.userInvocable === true`；
- `resourceBase.kind === 'directory'`，且 `resourceBase.path` 真实存在、是目录、以 `/finance-evolution/` 结尾；
- `content` 已剥离 frontmatter，正文长度 > 100。

### 2.3 frontmatter —— PASS
- `name` / `description` / `whenToUse` 三字段齐全且非空。
- `frontmatter.name === 'finance-evolution'`，并与 `resourceBase.path` 的目录名一致。

### 2.4 正文关键契约 —— PASS（正则匹配，不做全文快照）
- **四类触发**：
  - `指标异常`
  - `同一失败[^\n]{0,20}第二次`
  - `能力缺陷[^\n]{0,20}可复现`
  - `某个做法明显有效`
- **assets 资产范围**：
  - 同一句覆盖 `` `skills` `` / `` `strategies` `` / `` `programs` `` / `` `tasks` ``；
  - `固件[^\n]*不可改`（固件虽在 assets 下但不可改）；
  - `assets` 之外不可改。
- **修改记录＝git 四要素**：
  - **载体**：`git 提交历史` + `不另建记录文件`；
  - **双仓/单仓**：`一个仓库统管` + `不单独建仓`；
  - **append-only**：`append-only` + `禁止 amend、rebase、force-push`；
  - **只记操作不判结果**：`只记操作[^\n]*不判结果`。
- 额外闭环断言：`最多 5 轮`、`撤销本身也是一条修改记录`。

### 2.5 不是可进化种子 —— PASS
- `SKILL_NAMES` 不含 `finance-evolution`。
- 三个固有 SKILL（task-authorship / skill-authorship / finance-evolution）均不在 `SKILL_NAMES` 中。

## 3. 变异测试证据（接线回归）

目标：临时移除 `src/plugin.ts` 中 finance-evolution 的 `ctx.effect` 静态注册块，验证 spec 会**报红**；随后原样恢复并验证**全绿**、`git diff -- src/plugin.ts` 为空。

### 3.1 临时变异

命令：
```bash
cp src/plugin.ts /tmp/plugin.ts.t100471.bak
# 用 node 脚本把从「// ---- 固有 SKILL（finance-evolution）静态注册」
# 到「}, 'dsh-ia finance-evolution skill')」的整段替换为一行注释
git diff --stat -- src/plugin.ts
```
变异 diff 统计：
```
 src/plugin.ts | 26 ++------------------------
 1 file changed, 2 insertions(+), 24 deletions(-)
```

### 3.2 变异后运行（必须报红）

命令：
```bash
./node_modules/.bin/vitest run tests/finance-evolution.spec.ts
```
关键结果：
```
 ❯ tests/finance-evolution.spec.ts:96:32
     96|       expect(registeredSkills).toHaveLength(3)
       |                                ^
 Test Files  1 failed (1)
      Tests  1 failed | 16 passed (17)
mutated_run_exit=1
```
失败点正是「静态注册数量应为 3（实际 2）」，符合预期。

### 3.3 恢复后运行（必须全绿）

命令：
```bash
cp /tmp/plugin.ts.t100471.bak src/plugin.ts
git diff -- src/plugin.ts | wc -l     # → 0
./node_modules/.bin/vitest run tests/finance-evolution.spec.ts
```
结果：
```
git_diff_plugin_lines=0
 Test Files  1 passed (1)
      Tests  17 passed (17)
restored_run_exit=0
```
最终校验：
```
git diff --quiet -- src/plugin.ts; echo $?   # → 0
git diff --stat -- src/plugin.ts             # → 无输出
git status --porcelain                       # → 仅新增测试/报告文件
```

## 4. 定向回归

命令：
```bash
./node_modules/.bin/vitest run \
  tests/prompt-skills.spec.ts \
  tests/tester-t100432-intrinsic-skill.INDEPENDENT.spec.ts \
  tests/tester-t100444-skill-authorship.INDEPENDENT.spec.ts
```
结果：
```
 Test Files  3 passed (3)
      Tests  75 passed (75)
regression_exit=0
```

## 5. 全量测试

命令：`pnpm test`

结果：
```
 Test Files  5 failed | 82 passed (87)
```
失败文件与用例数（与已知基线完全一致，无新增）：
1. `tests/scheduler-wake.test.ts` — 4 failed（`buildWakeText` 合规声明）
2. `tests/tester-t100438-trace-context.INDEPENDENT.spec.ts` — 1 failed
3. `tests/tester-task11-scheduler-chain-integration.INDEPENDENT.spec.ts` — 1 failed
4. `tests/tester-strategy-feature.INDEPENDENT.spec.ts` — 1 failed（advisor 6 步工作流断言）
5. `tests/tester-task14-dsh-version-align.INDEPENDENT.spec.ts` — 1 failed（B5 人设 section）

合计 **5 文件 / 8 失败**，与任务给出的基线一致。新增的 `tests/finance-evolution.spec.ts` 在全量运行中为 `✓ (17 tests)`，**没有新增失败**。

## 6. 风险与说明

1. **正文断言为关键句正则**：已尽量只匹配语义锚点（四类触发、git 四要素），但若未来重写这些关键句的措辞，用例可能需同步微调。这是刻意的取舍——避免全文快照导致任何措辞优化都碎。
2. **mock ctx 会产生降级日志**：`apply()` 中 session-ensure / scheduler / skill provider 在 mock ctx 下按设计降级打日志（`ctx.get is not a function` / `ctx.plugin is not a function`），不影响静态注册断言，也不使测试失败；与 `tests/prompt-skills.spec.ts` 的既有 mock 行为一致。
3. **临时目录隔离**：`DSH_IA_HOME` 指向 `mkdtemp` 临时目录并在 `afterEach` 清理，未触碰真实 `~/.dsh-ia`。
4. **未修改源码**：变异测试仅临时改写 `src/plugin.ts`，已从备份原样恢复，`git diff -- src/plugin.ts` 为空（exit 0）。
5. **未 commit/push**：按任务要求，改动仅存在于工作区的两个新增文件。
