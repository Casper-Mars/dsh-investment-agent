# 测试报告：Task-19 阈值来源迁移（策略 front-matter 三级优先级）

- 被测交付物：`/Users/reachlucifer/project/opc/dsh-finance`（HEAD `add5a29` + 未提交改动）
- 被测文件：`src/domain/strategy.ts`（parseStrategyDoc）、`src/tools/context.ts`（getThresholds 三级优先级）、`src/domain/store.ts`（saveThresholds @deprecated）
- 独立测试：`tests/tester-task19-thresholds.INDEPENDENT.spec.ts`（新增，未改 src/** / 既有测试）
- 测试方式：真实 `createToolContext` + 真实文件落盘 + `createAllTools` 走工具 `execute` 链路，一律临时目录做 dataRoot（`mkdtempSync`），结束 `rmSync` 清理。
- 结果：**14 项断言，13 通过，1 失败（发现 1 处缺陷）**

---

## 逐条验收结果

### 1. 优先级①（策略 front-matter）—— ✅ PASS
写入带完整 `thresholds` 的策略文档后，`getThresholds` 返回该值。
证据：
```
[EVIDENCE] 优先级①完整阈值 = {"dirHitMin":0.6,"cumReturnMin":0.02,"missStreakMax":5}
```

### 2. 逐键回落 —— ✅ PASS
front-matter 只给 `dir_hit_min: 0.7` → `cumReturnMin`/`missStreakMax` 回落 `DEFAULT_THRESHOLDS`。
证据：
```
[EVIDENCE] 逐键回落 = {"dirHitMin":0.7,"cumReturnMin":0,"missStreakMax":3}
```

### 3. 非法值回落默认（部分 FAIL，见缺陷清单）
| 输入 | 期望 | 实际 | 结果 |
|------|------|------|------|
| `dir_hit_min: 1.5`（>1） | 回落默认 0.6 | 0.6 | ✅ |
| `miss_streak_max: -1` | 回落默认 3 | **-1（未回落）** | ❌ 缺陷 |
| `cum_return_min: "abc"` | 回落默认 0 | 0 | ✅ |
| `dir_hit_min: .inf` | 回落默认 0.6 | 0.6 | ✅ |
| `dir_hit_min: NaN` | 回落默认 0.6 | 0.6 | ✅ |

证据：
```
[EVIDENCE] dir_hit_min 1.5 = {"dirHitMin":0.6,"cumReturnMin":0.03,"missStreakMax":4}
[EVIDENCE] miss_streak_max -1 = {"dirHitMin":0.7,"cumReturnMin":0,"missStreakMax":-1}   ← 缺陷
[EVIDENCE] cum_return_min "abc" = {"dirHitMin":0.7,"cumReturnMin":0,"missStreakMax":3}
[EVIDENCE] dir_hit_min .inf = {"dirHitMin":0.6,"cumReturnMin":0,"missStreakMax":3}
[EVIDENCE] dir_hit_min NaN = {"dirHitMin":0.6,"cumReturnMin":0,"missStreakMax":3}
```
以上用例均未抛出异常（满足「不抛」）。

### 4. 优先级②（旧 thresholds.json 兼容回落）—— ✅ PASS
- 有策略文档但无 front-matter + 存在旧表 → 取旧表值：`{"dirHitMin":0.55,"cumReturnMin":0.01,"missStreakMax":4}`
- 无策略文档 + 存在旧表 → 取旧表值：`{"dirHitMin":0.5,"cumReturnMin":0.02,"missStreakMax":6}`

### 5. 优先级③（两者都无 → DEFAULT）—— ✅ PASS
证据：`[EVIDENCE] ③默认 = {"dirHitMin":0.6,"cumReturnMin":0,"missStreakMax":3}`

### 6. 解析失败不抛 + parseError 非空 —— ✅ PASS
`thresholds: [1,2`（流式集合未闭合）→ `getThresholds` 回落默认且不抛，`parseStrategyDoc` 返回 `parseError` 非空。
证据：
```
[EVIDENCE] parseError = "thresholds: 不支持流式集合：[1,2"
[EVIDENCE] 流式集合回落结果 = {"dirHitMin":0.6,"cumReturnMin":0,"missStreakMax":3}
```

### 7. 端到端影响（阈值真来自策略文档，非硬编码）—— ✅ PASS
构造 per-symbol 统计（dirHitRate=0.3、cumReturn=0），走 `review_retrospect` 工具 `execute` 链路：
- 默认阈值（dirHitMin=0.6）：`0.3 < 0.6` → 触发「方向命中率低于下限」。
- 写入策略 front-matter `dir_hit_min: 0.2` 后：`0.3 >= 0.2` → 「表现未劣于阈值，无需根因定位」，improvements 为空。
证据：
```
[EVIDENCE] 默认阈值 root_cause = "标的表现劣于阈值：方向命中率低于下限"
[EVIDENCE] 策略阈值 dirHitMin = 0.2
[EVIDENCE] 放宽后 root_cause = "表现未劣于阈值，无需根因定位"
```

### 8. 不再写 thresholds.json —— ✅ PASS
经 `strategy_set` 工具（标的先 `ledger_init`）写入策略后，`ledger/<symbol>/thresholds.json` 未创建，`strategy/<symbol>.md` 正常落盘。
证据：
```
[EVIDENCE] thresholds.json 是否存在 = false
[EVIDENCE] strategy 当前版文件是否存在 = true
```
补充：静态扫描确认 `saveThresholds` 已无任何调用方（仅 `src/domain/store.ts:208` 定义，全仓无写入 `thresholds` 表的其他路径）。

### 9. 契约未变 —— ✅ PASS
- 顶层 `inject` 四项：`['tools', 'skills', 'ptcRuntime', 'fs']`（`src/plugin.ts` 与 `cordis.patch.yml` 一致，测试读取 patch 文件断言通过）。
- `git diff --name-only` 仅含 4 个预期源文件（`src/domain/store.ts`、`src/domain/strategy.ts`、`src/tools/README.md`、`src/tools/context.ts`）；`cordis.patch.yml`、`package.json`、`pnpm-lock.yaml` **无 diff**。

---

## 缺陷清单

### 缺陷 1（高，违反 AC 第 3 条「非法值回落默认」）
- **文件/行**：`src/tools/context.ts:69-70`
  ```ts
  const miss = finiteNumber(map.miss_streak_max)
  if (miss !== undefined) result.missStreakMax = miss
  ```
- **现象**：front-matter 写 `miss_streak_max: -1` 时，`getThresholds` 返回 `missStreakMax: -1`，未回落默认值 `3`。
- **复现步骤**：
  1. `ctx.strategy.set('588000', { text: "---\nthresholds:\n  dir_hit_min: 0.7\n  miss_streak_max: -1\n---\n正文", rationale: 'r' })`
  2. `ctx.getThresholds('588000')` → 得到 `missStreakMax = -1`（期望 `3`）。
- **期望**：`miss_streak_max` 为负数时该键回落 `DEFAULT_THRESHOLDS.missStreakMax`（同 `dir_hit_min` 的 `∈[0,1]` 校验思路，对 `miss_streak_max` 增加「非负」守卫）。
- **影响**：负数 `missStreakMax` 会经 `getThresholds` 流入 `review_retrospect`，被 `metrics.isBelowThreshold`（`missStreakMax < 0`）判为「阈值配置异常」，把本应由「逐键回落默认」兜住的非法输入误判为用户阈值配置错误，触发错误根因归因。

---

## 未验证项 / 备注

- 无（9 条验收点均已给出运行时证据；缺陷 1 为实测失败，非推断）。
- 未 commit / push；临时目录均 `rmSync` 清理，未污染真实数据。

## 结论

- ✅ 通过项：优先级①、逐键回落、优先级②、优先级③、解析失败不抛、端到端触发切换、不再写 thresholds.json、契约未变。
- ❌ 未通过项：**非法值 `miss_streak_max: -1` 未回落默认**（缺陷 1，`src/tools/context.ts:69-70`）。
- ⚠️ 建议：为 `miss_streak_max`（必要时含 `cum_return_min` 按需求口径）补充非负校验，与 `dir_hit_min` 的区间校验对齐后重新下发。
