# t100407 测试报告：runner 结局语义对齐 v0.7 §9.1（运行时验证）

- 任务卡：t100407（结局语义对齐验证·独立复跑）
- 被测路径：`/Users/reachlucifer/project/opc/dsh-ia`，branch `main`（工作区未提交改动）
- 改动范围（与自述一致）：`src/scheduler/index.ts`、`src/scheduler/runner.ts` + 4 个测试文件，**6 文件 / +91 / -28**
- 目标节点：Reach的MacBook Pro（宿主机 Mac）
- 结论：**5/5 验收 PASS；两处结局与 §9.1 一致；既有行为零回归。** 另有 5 条非阻塞观察（3 条文档陈旧 + 1 条检查点顺序 + 1 条 §9.1 措辞覆盖缺口），详见第六节。
- 独立性：新增 `tests/tester-t100407-outcome-alignment.INDEPENDENT.spec.ts`（26 用例），**不改动 `src/**`**；用真实 `TaskRunner` / 真实 `applyScheduler` + 可编程假进程 / spy，未复用 Developer 用例断言。

---

## 一、验收逐条判定

| # | 验收标准 | 判定 | 证据 |
|---|----------|------|------|
| 1 | 目录+package.json 存在、入口 task.ts 缺失 → `skipped`（非 failed），且不启动 runner | ✅ PASS | A1：`out.kind==='skipped'`、`reason` 含「任务程序文件缺失」、`detail===absTaskPath`、`run` spy **未被调用**；A3：入口存在时正常透传 `quiet`，runner 以正确 absPath 调用 |
| 2 | exit 0 但输出无有效结果 JSON → `failed`（`failureKind='parse'`） | ✅ PASS | B 组 12 种畸形输入（空 stdout / 纯日志 / 非法 JSON / JSON 数字·数组·null·字符串 / shouldWake 非 boolean / data 非 string / shouldWake=true 缺 data）+ 边界（中间行合法·末行日志）**全部** → `failed` + `failureKind='parse'` |
| 3 | `shouldWake:false` → `quiet`；非零退出/崩溃/超时 → `failed/exec` | ✅ PASS | C1 quiet；C2 woke；C3 exit=3→exec；C4 exit=null(崩溃)→exec；C5 spawn 抛错→spawn；C6 假 timer 超时→exec+SIGTERM；C6b **真实 spawner** 空转超时→exec |
| 4 | 新增单测覆盖「缺文件→skipped」；受影响旧测试同步 | ✅ PASS | dev C7 存在；`git diff` 显示 4 个旧测试文件已同步（parse→failed）；全仓 grep **无**「不可解析→skipped」残留断言 |
| 5 | `pnpm typecheck` + `pnpm test` 通过（基线 862→863） | ✅ PASS | 见第二节 |

---

## 二、独立复跑命令与结果

| 项 | 命令 | 结果 |
|----|------|------|
| 类型检查 | `pnpm typecheck` | **EXIT=0** |
| 开发者全量测试（未含本 Tester 文件） | `pnpm test` | **863 passed / 42 files**，EXIT=0（对齐基线 862→863，+1=C7） |
| Tester 独立用例 | `npx vitest run tests/tester-t100407-outcome-alignment.INDEPENDENT.spec.ts` | **26 passed** |
| 全量（含本 Tester 文件） | `pnpm test` | **889 passed / 43 files**，EXIT=0 |

> 说明：`+1` 文件 / `+26` 用例来自本 Tester 独立 spec（`??` 未跟踪）；**排除该文件后即开发者基线 863/42**。

---

## 三、反向验证（关键·覆盖力证明）

临时移除 `src/scheduler/index.ts` 的 `if (!existsSync(absTaskPath)) {...}` 校验后复跑：

- 开发者 `C7` → **FAIL**：`expected 'quiet' to be 'skipped'`（缺文件时 runner 被调用并返回 quiet）
- Tester `A1` → **FAIL**：`expected 'quiet' to be 'skipped'`

→ 证明 C7 / A1 对「缺文件→skipped」**具备真实覆盖力**（非恒真断言）。随后已从备份**完整恢复**，`git diff --stat` 回到 `index.ts | 10 ++++++++++`，工作区与交付物一致。

---

## 四、特别关注项核查

1. **检查点插入位置**：`existsSync` 位于 **3c(installTaskDeps) 之后、3d(runner.run) 之前** —— 见 `index.ts:188`。A2 实测：**入口缺失时 `installTaskDeps` 仍被调用一次**。即「缺文件」场景会**先装一遍依赖**再判 skipped。非语义违规（§9.1 只要求「读任务程序」降级），但若期望「程序不存在则连依赖都不装」，应把校验前移到 3c 之前。**待 Leader 决策**（见第六节 #4）。
2. **`existsSync` 边界（文件存在但不可读）**：本任务仅要求「缺失→skipped」。实测 D1（入口是目录）、D2（chmod 000 不可读）：`existsSync=true` → 放行 → 真实 node 非零退出 → **`failed/exec`（非 skipped）**。即 §9.1 措辞里的「**读取失败**→skipped」**未被覆盖**，实现只覆盖「缺失」。见第六节 #5。
3. **不影响正常路径**：A3 验证 entry 存在时 runner 被正确调用且结局原样透传；开发者真实端到端 T9-F 亦通过。

---

## 五、既有测试同步核验

`git diff` 中对 4 个旧测试文件的改动均为「原 `parse` 失败→`skipped`」改为「→`failed`/`failureKind='parse'`」：
- `tests/runner.test.ts`：3 处（无有效 JSON / shouldWake 非 boolean / data 非 string）
- `tests/runner-real-process.test.ts`：1 处（非法 JSON）
- `tests/tester-task11-scheduler-chain-integration.INDEPENDENT.spec.ts`：2 处（无有效 JSON / shouldWake 非 boolean）+ `writeTask` 补齐入口文件
- `tests/tester-task9-scheduler-index.INDEPENDENT.spec.ts`：新增 C7 + `writeTask` 补齐入口文件 + T9-F 断言同步

全仓检索 `无有效|不可解析|非法 JSON|parseLastJsonLine` 与 `skipped` 的共现断言 → **无残留**（仅命中本报告/我的 spec 文档性文字与 `tester-task11-scheduler-tests.REPORT.md` 历史报告）。

---

## 六、观察项 / 风险（均非阻塞，不影响验收）

| # | 类型 | 位置 | 说明 | 建议 |
|---|------|------|------|------|
| 1 | 文档陈旧 | `src/scheduler/types.ts:52` | 注释仍写「非 boolean（或缺省）→ 解析失败 → **`skipped`**」，与新行为 `failed/parse` 矛盾。types.ts **不在**本次 6 文件改动内 | 同步改为 `failed`（`failureKind='parse'`） |
| 2 | 文档陈旧 | `src/scheduler/runner.ts:2/8/14/33/203/231/288` | 模块头与行内注释仍称「**四结局** 映射」；runner 现仅产出 quiet/woke/failed（skipped 归编排层）。类型联合仍为四值，属命名陈旧 | 措辞对齐「结局映射（runner 产出 3 类）」 |
| 3 | 历史报告陈旧 | `tests/tester-task11-scheduler-tests.REPORT.md:50,78` | 历史报告仍记载旧语义「parse → skipped」。非测试、不参与跑分 | 可加「已被 t100407 修订」批注 |
| 4 | 顺序观察 | `src/scheduler/index.ts:188` | 存在性校验在依赖安装**之后**，缺文件仍触发一次 `installTaskDeps`（A2 实测） | 若要求「缺程序不装依赖」，前移校验 |
| 5 | 覆盖缺口 | `src/scheduler/index.ts:188` vs §9.1 | §9.1 措辞「程序文件缺失/**读取失败** → skipped」，实现仅覆盖「缺失」；「读取失败/非普通文件」落 `failed/exec`（D1/D2 实测） | 如属有意收窄范围，建议补注说明；如需覆盖，需扩展校验（如 `statSync` 判 `isFile`+可读） |

---

## 七、结论

- **两处结局对齐 §9.1**：
  - 编排层新增「任务程序文件缺失 → `skipped`」✅（缺失入口不再误起进程、不误归 `failed/exec`）
  - runner `parse` 失败由 `skipped` 改判 `failed` + `failureKind='parse'` ✅
- **既有行为零回归**：quiet / woke / exec(非零退出·崩溃·超时) / spawn 均未被误改，全量 863（基线）全绿。
- 5 条观察均为文档/措辞/范围类，**不改变验收结论**，建议 Leader 择机让 Developer 收敛 #1/#2 文档陈旧。

---

*本报告路径：`tests/tester-t100407-outcome-alignment.INDEPENDENT.REPORT.md`；独立用例：`tests/tester-t100407-outcome-alignment.INDEPENDENT.spec.ts`（26 用例）。*
