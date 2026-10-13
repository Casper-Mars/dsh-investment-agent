# Task 8（t100357）修复复验报告 — cum_return 口径

- **被测交付物**：dsh-ia 插件（cum_return 计算链路修复）
- **被测 commit**：`4c233b5d7bee6d146fa2da1fbc0056f06d5f6cdc`（fix(reviews): 打通 cum_return 计算链路并落地验收口径）
- **复验角色**：Tester（只测试与报告，**未改动任何 src/**）
- **日期**：2026-09-30
- **权威依据**：《详细设计 v1.3》+ 任务 t100357 AC2 + 上轮端到端报告 `tester-task8-e2e.INDEPENDENT.REPORT.md` 的 Defect #1

---

## 一、复验方法（独立性声明）

- 使用 **Tester 自写的独立用例**：`tests/tester-task8-fix-reverify.INDEPENDENT.spec.ts`（14 个用例）。
- **不复用** Developer 的 `tests/metrics.test.ts` / `tests/reviews.test.ts`。
- 所有期望值均由**场景参数手算**得出（不调用被测实现反推），核对 `review_metrics.cum_return`。
- 双通道验证：**域层直调**（`Ledger` + `Reviews` + `cumReturnOnCapital`）与 **工具层端到端**（真实 `ToolRuntime` registry，经 `registerAllTools` 注册 16 工具）。
- 运行环境：宿主机 Reach 的 MacBook Pro（darwin-arm64，node v25.9.0）。

---

## 二、AC2 复验结论 —— ✅ PASS

### 2.1 任务书给定场景（S1）

`ledger_init(init_cash=50000, init_qty=1000, init_cost=2.00)` → `ledger_trade(卖出 500 @ 3.0)` → `review_metrics`

- 期初资金 = 50000 + 1000×2.00 = **52000**
- 期末持仓 = 500，现价（缺省=最近成交价 3.0）→ 期末市值 = **1500**
- 累计 realized = (3.0−2.00)×500 = **500**
- 期望 cum_return = (1500 + 500 − 52000) / 52000 = **−0.9615**

| 通道 | 实测 cum_return | 结论 |
|------|----------------|------|
| 域层 `Reviews.review_metrics('588000')`（缺省现价） | **−0.9615** | ✅ 且 ≠ 0 |
| 域层 `review_metrics('588000', 3.0)`（显式现价） | **−0.9615** | ✅ 与缺省一致 |
| 工具层 `review_metrics`（行情源给价 3.0） | **−0.9615** | ✅ |

> `[EVIDENCE AC2-S1] cum_return=-0.9615 expected=-0.9615`
> `[EVIDENCE AC2-TOOL] cum_return=-0.9615（行情供给现价 3.0，期望 -0.9615）`

**口径精确落地**：分子含期末持仓市值项、分母为期初资金，与验收公式 `(期末市值 + 累计realized − 期初资金) / 期初资金` **逐项吻合**。

### 2.2 盈利方向场景（S2）

`ledger_init(init_cash=1000, init_qty=1000, init_cost=2.00)` → `ledger_trade(卖出 1000 @ 6.0)` → `review_metrics`

- 期初资金 = 1000 + 1000×2.00 = **3000**
- 期末持仓 = 0 → 期末市值 = **0**
- 累计 realized = (6.0−2.00)×1000 = **4000**
- 期望 cum_return = (0 + 4000 − 3000) / 3000 = **+0.3333**

实测 **+0.3333**（>0，正收益方向正确）。`[EVIDENCE AC2-S2] cum_return=0.3333 expected=0.3333`

### 2.3 除零 / 未初始化回落（S3）

| 场景 | 期望 | 实测 | 结论 |
|------|------|------|------|
| 未初始化标的 `review_metrics('999999')` | 0，不抛错 | 0，不抛错 | ✅ |
| 期初资金=0（`init cash=0` 且成本=0） | 0 | 0 | ✅ |
| `cumReturnOnCapital` initialCapital ∈ {0, NaN, Infinity} | 0 | 0 | ✅ |
| 工具层未初始化标的 | 0 且非 isError | 0 且非 isError | ✅ |

---

## 三、回归确认 —— ✅ 无回归

### 3.1 全量测试

```
Test Files  25 passed (25)
     Tests  460 passed (460)
```

- 基线（修复前，不含本报告新增用例）：24 文件 / 446 用例全绿；
- 加入本复验文件后：**25 文件 / 460 用例全绿**（446 + 14）。

### 3.2 已通过验收点未被破坏（逐文件核实）

| 验收点 / 领域 | 相关用例文件 | 结果 |
|--------------|-------------|------|
| AC1 全链路闭环（etf 份/100整数倍、v003归档+current、盘后三件套） | `tester-task8-e2e.INDEPENDENT.spec.ts`(6) / `tester-tools-runtime.spec.ts`(26) | ✅ |
| AC3 quotes 降级 | `quotes.test.ts`(10) / `providers.test.ts`(7) / `tester-task8-e2e`(6) | ✅ |
| AC4 唤醒冷却幂等 | `runner-scheduler.test.ts`(14) / `tester-runner-task7-e2e`(9) | ✅ |
| AC5 多标的批处理上界 + A/B 隔离 | `tester-tools-runtime.spec.ts`(26) / `tester-task8-e2e`(6) | ✅ |
| AC6 合规（免责声明 / 仅模拟盘） | `task71-gaps.test.ts`(14) / `task71-reverify.test.ts`(19) | ✅ |
| Task6/7 runner 回归 | `tester-runner-task6.INDEPENDENT.spec.ts`(57) / `tester-runner-task6-rev.INDEPENDENT.spec.ts`(31) | ✅ |
| 工具运行时/契约 | `tester-tools-runtime.spec.ts`(26) / `tools.test.ts`(24) | ✅ |

### 3.3 旧 `cumReturn(trades)` 语义未变（§5.2）

| 用例 | 期望 | 结果 |
|------|------|------|
| 买低卖高（1000@2 → 卖500@2.5 → 卖500@3.0） | 0.375 | ✅ |
| 买高卖低（1000@3 → 卖1000@2） | −0.3333 | ✅ |
| 空流水 | 0 | ✅ |
| `task71-reverify.test.ts` 全套 | — | ✅ 19/19 |

### 3.4 未接 ledger 回落 0（向后兼容）

- `new Reviews(dir)`（无 ledger）→ `review_metrics.cumReturn === 0` ✅；
- `tester-independent-verify.test.ts` 中「即时计算 cum_return 缺省 0」用例仍绿（20/20）✅。

---

## 四、复验总结

| 复验项 | 结论 |
|--------|------|
| AC2 cum_return 不再恒为 0 | ✅ PASS |
| cum_return 精确等于 `(期末市值+累计realized−期初资金)/期初资金` | ✅ PASS（S1=−0.9615、S2=+0.3333 逐项吻合） |
| 除零 / 未初始化回落 0 不抛错 | ✅ PASS |
| 工具层端到端透出非零 cum_return（含行情缺省回落） | ✅ PASS |
| 其余 5.5 条已通过验收点未被破坏 | ✅ 无回归（全量 460 绿） |
| 旧 `cumReturn(trades)` 语义未变 | ✅ PASS |
| 未接 ledger 回落 0（兼容） | ✅ PASS |

**最终结论：AC2（cum_return 口径）PASS，口径精确落地；未引入任何回归。** 上轮 Defect #1 已闭环。

---

## 五、交付物与环境

1. **独立复验用例**：`tests/tester-task8-fix-reverify.INDEPENDENT.spec.ts`（14 用例，含逐条 `[EVIDENCE ...]`）。
2. **本报告**：`tests/tester-task8-fix-reverify.REPORT.md`。
3. **改动范围**：仅新增测试文件，`src/**` 零改动（`git diff HEAD -- src/` 为空）。
4. **环境清理**：纯本地 JSON + 内存 registry，未启动中间件，无需 docker 清理。

---

## 六、风险点 / 建议（非阻塞）

1. **⚠️ `review_metrics` 的缓存优先级**：当 metrics 表存在 `record_metrics` 落库快照时，`review_metrics` 直接返回缓存 `cumReturn`，不再实时计算。当前无任何 tool/runner 调用 `record_metrics`，工具链路始终走实时计算，故不影响验收；若未来启用回写，需保证快照与实时口径一致（建议由 Leader 知会 Developer 关注）。
2. **ℹ️ 口径语义提示**：`期初资金` 采用「初始 cash + 初始持仓成本」口径，故在「初始建仓即满仓、现价不涨」的构造下 cum_return 天然为负（如 S1）。此为验收公式既定口径，非缺陷，已按任务书期望值核对通过。
