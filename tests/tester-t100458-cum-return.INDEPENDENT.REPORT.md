# 测试报告 · t100458 —— 修复 Issue #3：`cum_return` 分子缺少「期末现金」

- **被测交付物**：`/Users/reachlucifer/project/opc/dsh-finance`（仓库 Casper-Mars/dsh-investment-agent）
- **基线 commit**：`fe31197`（工作区 8 个已改文件未 commit）
- **目标节点**：Reach的MacBook Pro（宿主机，Node v25.9.0，pnpm 11.7.0，typescript ^5.7，vitest 3.2.7）
- **测试范围**：运行时行为 / 口径正确性 / 回归
- **新口径**：`cum_return = (期末现金 + 期末市值 − 期初资金) / 期初资金`（期末总资产 vs 期初总资产）
- **旧口径（缺陷）**：`(期末市值 + 累计 realized − 期初资金) / 期初资金`（分子漏期末现金）
- **结论**：✅ **通过验收（AC1–AC4 全部满足；零回归）**

---

## 一、总览

| 验收项 | 结论 | 关键证据 |
|---|---|---|
| AC1（核心）Issue #3 台账复现 → ≈ −0.0191 | ✅ 通过 | 域层 + 工具层双路径独立复现 = **−0.0191** |
| AC2 三类场景（initialCash>0 / realizedPnl≠0 / finalQty=0） | ✅ 通过 | 独立用例 3 组，数据自洽校验通过 |
| AC3 旧公式断言已全部改写、无残留 | ✅ 通过 | grep 全仓无 `(marketValue + realizedPnl − ic)/ic` 残留 |
| AC4a `tsc -p tsconfig.json --noEmit` | ✅ 通过 | 退出码 **0** |
| AC4b `vitest run` 无**新增**失败 | ✅ 通过 | 失败文件集合与基线**逐字一致**，差异项经证明为既有 flaky |
| 工作区恢复 | ✅ 已恢复 | `git status` 仍为 8 个已改文件 + 2 个未跟踪 |

---

## 二、独立测试产出

- 测试文件：`tests/tester-t100458-cum-return.INDEPENDENT.spec.ts`（**只新增，未改动任何 src/**）
- 独立性：Issue #3 台账用 `Ledger.init/trade` **公共 API 自行重建**后跑 `review_metrics` 观察产出；期望值全部由场景参数**手算**，不复用 Developer 断言、不调用被测实现反推。

```
 ✓ tests/tester-t100458-cum-return.INDEPENDENT.spec.ts (8 tests) 36ms
 Test Files  1 passed (1)
      Tests  8 passed (8)
```

---

## 三、AC1（核心）：Issue #3 真实台账独立复现

台账（自行重建）：`init 200@55.57（现金 50000）→ sell 100@53.05 → buy 100@53.08 → sell 200@49.76`

### 3.1 中间量（域层实测，非断言搬运）

| 量 | 实测 | 手算校验 |
|---|---|---|
| 期末 qty | `0` | 200−100+100−200 = 0 ✓ |
| 期末现金 | `59949` | 50000 +100×53.05 −100×53.08 +200×49.76 = 59949 ✓ |
| 已实现盈亏 | `−1165` | (53.05−55.57)×100 + (49.76−54.325)×200 = −252 −913 = −1165 ✓ |
| 期初资金 | `61114` | 初始现金 50000 + 初始成本 200×55.57 = 61114 ✓ |

### 3.2 `cum_return` 实测

```
[EVIDENCE AC1] default=-0.0191 explicit=-0.0191 expected=-0.0191 oldFormula=-1
   → review_metrics('002156')（缺省 price，回落最近成交价 49.76） = -0.0191
   → review_metrics('002156', 49.76)（显式现价）                 = -0.0191
[EVIDENCE AC1-TOOL] cum_return(no price)=-0.0191 explicit=-0.0191 expected=-0.0191
   → 工具层真实 ToolRuntime registry：review_metrics({symbol:'002156'})               = -0.0191
   → 工具层：review_metrics({symbol:'002156', price:49.76})                            = -0.0191
```

- **精确命中期望 −0.0191**（−1165/61114，round4）。
- 断言 `not.toBeCloseTo(-1.0191, 2)` 通过 → **不再是 −101.91%**。
- 附注：`(0 − 61114)/61114 = −1`（旧口径在本台账恰好整除为 −1），亦与实测不符，反证修复生效。

---

## 四、AC2：三类场景口径用例（数据自洽）

自洽约束：**期初资金 = 初始现金 + 初始持仓成本**（用例内独立校验 `initialCapital`）。

| 场景 | 构造（Ledger API） | 实测 cum_return | 手算 | 自洽校验 |
|---|---|---|---|---|
| ① 期初有现金（initialCash>0） | init 1000@2.0 现金 8000；现价 2.2 | `0.02` | (8000 + 1000×2.2 − 10000)/10000 = 0.02 | 期初资金 10000 = 8000 + 2000 ✓ |
| ② 期间有卖出（realizedPnl≠0） | init 1000@2.0 现金 50000；sell 500@3.0 | `0.0192` | (51500 + 500×3.0 − 52000)/52000 = 1000/52000 | realizedPnl=500≠0、cash=51500、qty=500 ✓ |
| ③ 已清仓（finalQty=0） | init 1000@2.0 现金 1000；sell 1000@6.0 | `1.3333` | (7000 + 0 − 3000)/3000 = 4000/3000 | qty=0、cash=7000、realizedPnl=4000 ✓ |

```
[EVIDENCE AC2-①] cum_return=0.02   expected=0.02
[EVIDENCE AC2-②] cum_return=0.0192 expected=0.0192
[EVIDENCE AC2-③] cum_return=1.3333 expected=1.3333
```

额外一致性用例：三场景下 `review_metrics().cumReturn === cumReturnOnCapital(cumReturnState())`（域层同源）均通过。

---

## 五、AC3：旧公式断言改写 & 无残留

```bash
# pattern A：旧分子形式（marketValue + … realizedPnl）
grep -rnE "marketValue \+[^)]*realizedPnl|realizedPnl - ic|state\.realizedPnl" tests/ src/
  → 无匹配

# 三个指名文件已改用 finalCash（新口径）
grep -c finalCash tests/metrics.test.ts tests/reviews.test.ts tests/tester-task8-fix-reverify.INDEPENDENT.spec.ts
  → metrics.test.ts:7   tester-task8-fix-reverify:3   reviews.test.ts:0（该文件走 ledger 端到端，不经纯函数）
```

- `-1.0191` 的全部出现均为**注释说明**或**反向护栏** `not.toBeCloseTo(-1.0191, 2)`，**未锁定旧公式**。
- `tests/metrics.test.ts` / `tests/reviews.test.ts` / `tests/tester-task8-fix-reverify.INDEPENDENT.spec.ts` 均已按新口径改写。
- 定向复跑（新口径下）：

```
 ✓ tests/metrics.test.ts
 ✓ tests/reviews.test.ts
 ✓ tests/tools.test.ts (28 tests)
 ✓ tests/tester-task8-fix-reverify.INDEPENDENT.spec.ts (11 tests)
 Test Files  4 passed (4)
      Tests  71 passed (71)
```

---

## 六、AC4：类型检查与全量回归

### 6.1 类型检查

```bash
npx tsc -p tsconfig.json --noEmit
  → TSC_EXIT=0   ✅
```

### 6.2 全量 `vitest run`（改动后工作区）

```
 Test Files  10 failed | 60 passed (70)
      Tests  15 failed | 1444 passed (1459)
```

失败文件（10）：`prompt-skills.spec.ts`、`scheduler-wake.test.ts`、`runner-real-process.test.ts`、`tester-prompt-skills.INDEPENDENT.spec.ts`、`tester-strategy-feature.INDEPENDENT.spec.ts`、`tester-t100418-skill-assets.INDEPENDENT.spec.ts`、`tester-t100433-seed-provision.INDEPENDENT.spec.ts`、`tester-t100438-trace-context.INDEPENDENT.spec.ts`、`tester-task11-scheduler-chain-integration.INDEPENDENT.spec.ts`、`tester-task14-dsh-version-align.INDEPENDENT.spec.ts` —— 均为 advisor.md 人设文本 / dist-server skill 产物 / scheduler wake 文本 / trace context / provider 时序类，**无一涉及 cum_return 计算逻辑**。

### 6.3 零回归证据（`git stash` 基线对照）

操作：`git stash push -m t100458-verify` → 工作树回到 `fe31197`（确认 `metrics.ts` 旧式 `round4((marketValue + state.realizedPnl - ic)/ic)` 已还原）→ 对**同一失败文件集合**复跑 → `git stash pop` 恢复。

```
# 基线（fe31197 工作树，9 失败文件）
 Test Files  9 failed | 1 passed (10)
      Tests  13 failed | 201 passed (214)

# 改动后（同集合）
 Test Files  9 failed | 1 passed (10)
      Tests  14 failed | 200 passed (214)

# 失败文件集合逐字 diff：
diff <(baseline FAIL 文件名) <(changed FAIL 文件名)   → 空（diff_exit=0，集合完全一致）
```

- 基线 13 failed / 9 files —— 与 Developer 报告一致。
- 改动后多出的 1 个失败位于**同一已失败文件** `tester-prompt-skills.INDEPENDENT.spec.ts`，且经复跑证明为**flaky**（该文件单独连跑 3 次：失败数在 1/2/1 间抖动，浮动项分别为 `[3] provider 发现` / `[5b] apply 端到端装配`，稳定项恒为 `[0] advisor.md 四大板块`）：

```
=== run 1 === FAIL [0] advisor.md 人设结构 → Tests 1 failed | 32 passed
=== run 2 === FAIL [3] 经 skill-filesystem provider 发现 … + [0] → Tests 2 failed | 31 passed
=== run 3 === FAIL [0] advisor.md 人设结构 → Tests 1 failed | 32 passed
```

- 同理，全量中第 10 个失败文件 `runner-real-process.test.ts`（真实进程 timing 类）单独连跑 2 次均 `6 passed` → **负载下 flaky**，非本次改动引入。
- 该 flaky 特性在 `vitest.config.ts` 注释中已被明确记录（provider/watcher 资源竞争超时，故限 `maxWorkers:4`），与本次 cum_return 修复无因果。

**→ 结论：失败集合零新增（零回归）。** 未能稳定复现的额外失败项均属既有 flaky，与本次改动无关。

### 6.4 工作区恢复确认

```
git status --short
 M src/domain/ledger.ts
 M src/domain/metrics.ts
 M src/tools/reviews.ts
 M src/tools/schemas.ts
 M tests/metrics.test.ts
 M tests/reviews.test.ts
 M tests/tester-task8-fix-reverify.INDEPENDENT.spec.ts
 M tests/tools.test.ts
?? src/skills/finance-evolution/
?? tests/tester-t100458-cum-return.INDEPENDENT.spec.ts
git stash list   → 空（已 pop）
```
✅ 8 个已改文件完好，未提交；未跟踪目录 `src/skills/finance-evolution/`（非本次产生）保持原样，未处理。

---

## 七、最终结论

- **AC1 ✅**：`review_metrics('002156')` 域层/工具层双路径独立复现均返回 **−0.0191**，而非 −1.0191，符合新口径。
- **AC2 ✅**：三类场景（期初有现金 / 期间卖出 / 已清仓）用例齐备、数据三者（流水/现金/持仓）数学自洽。
- **AC3 ✅**：三指名文件已改写为新口径，全仓无旧公式断言残留。
- **AC4 ✅**：`tsc --noEmit` 退出码 0；`vitest run` 失败集合与基线逐字一致，无新增失败。
- **无失败项需返修**；最小复现与根因不适用。

**验收判定：通过。** 无风险点需阻断交付；唯一提示为仓库既有 flaky（provider/真实进程时序类），非本次交付范围。
