# 测试报告（复验轮 2）：Task-19 阈值来源迁移 —— `miss_streak_max` 守卫修复

- 被测交付物：`/Users/reachlucifer/project/opc/dsh-ia`（HEAD `add5a29` + 未提交改动）
- 被测文件：`src/tools/context.ts`（`thresholdsFromFrontmatter()` 守卫修复）、`src/domain/strategy.ts`（`parseStrategyDoc`）、`src/domain/store.ts`（`saveThresholds` @deprecated）
- 独立测试：`tests/tester-task19-thresholds.INDEPENDENT.spec.ts`（上轮 14 项 + 本轮新增 11 项边界，未改 `src/**` / 既有测试 / `thresholds.test.ts`）
- 测试方式：真实 `createToolContext` + 真实文件落盘 + `createAllTools` 走工具 `execute` 链路，一律临时目录做 dataRoot（`mkdtempSync`），结束 `rmSync` 清理。
- 结果：**上轮 1 处 High 缺陷已闭环；14 项全部 PASS；回归 typecheck/build/test 全绿。**

---

## 一、上轮 High 缺陷闭环（`miss_streak_max` 守卫）

上轮缺陷 1（`src/tools/context.ts:69-70`，`miss_streak_max` 负数未回落默认）本轮已修复。
当前守卫代码（`src/tools/context.ts:70-71`）：

```ts
const miss = finiteNumber(map.miss_streak_max)
if (miss !== undefined && miss >= 0 && Number.isInteger(miss)) result.missStreakMax = miss
```

独立复测（`miss_streak_max` 单键 front-matter，其余键回落默认）：

| 输入 | 期望 | 实际 | 结果 |
|------|------|------|------|
| `-1` | 默认 3，不抛 | 3 | ✅ |
| `-0.5` | 默认 3，不抛 | 3 | ✅ |
| `NaN` | 默认 3，不抛 | 3 | ✅ |
| `.nan` | 默认 3，不抛 | 3 | ✅ |
| `Infinity` | 默认 3，不抛 | 3 | ✅ |
| `.inf` | 默认 3，不抛 | 3 | ✅ |
| `2.5` | 默认 3，不抛 | 3 | ✅ |
| `0` | 采用 0 | 0 | ✅ |
| `5` | 采用 5 | 5 | ✅ |

证据（运行时输出，非推断）：
```
[EVIDENCE] miss_streak_max -1       = {"dirHitMin":0.6,"cumReturnMin":0,"missStreakMax":3}
[EVIDENCE] miss_streak_max -0.5     = {"dirHitMin":0.6,"cumReturnMin":0,"missStreakMax":3}
[EVIDENCE] miss_streak_max NaN      = {"dirHitMin":0.6,"cumReturnMin":0,"missStreakMax":3}
[EVIDENCE] miss_streak_max .nan     = {"dirHitMin":0.6,"cumReturnMin":0,"missStreakMax":3}
[EVIDENCE] miss_streak_max Infinity = {"dirHitMin":0.6,"cumReturnMin":0,"missStreakMax":3}
[EVIDENCE] miss_streak_max .inf     = {"dirHitMin":0.6,"cumReturnMin":0,"missStreakMax":3}
[EVIDENCE] miss_streak_max 2.5      = {"dirHitMin":0.6,"cumReturnMin":0,"missStreakMax":3}
[EVIDENCE] miss_streak_max 0        = {"dirHitMin":0.6,"cumReturnMin":0,"missStreakMax":0}
[EVIDENCE] miss_streak_max 5        = {"dirHitMin":0.6,"cumReturnMin":0,"missStreakMax":5}
```
以上非法输入均 `not.toThrow()` 通过（满足「不抛」）。

补充验证 `cum_return_min`（修复描述声称「负数合法、拒 NaN/±Infinity」）：
```
[EVIDENCE] cum_return_min -0.05    = {"dirHitMin":0.6,"cumReturnMin":-0.05,"missStreakMax":3}   ← 负数被采用
[EVIDENCE] cum_return_min Infinity = {"dirHitMin":0.6,"cumReturnMin":0,"missStreakMax":3}       ← 回落默认
```

---

## 二、上轮 14 项复测（对当前代码重新执行）

| # | 验收点 | 结果 | 证据/说明 |
|---|--------|------|-----------|
| 1 | 优先级①：策略 front-matter 完整 thresholds 被采用 | ✅ PASS | `{"dirHitMin":0.6,"cumReturnMin":0.02,"missStreakMax":5}` |
| 2 | 逐键回落：仅给 `dir_hit_min` → 其余两键回落默认 | ✅ PASS | `{"dirHitMin":0.7,"cumReturnMin":0,"missStreakMax":3}` |
| 3 | `dir_hit_min: 1.5`（>1）回落默认 | ✅ PASS | `{"dirHitMin":0.6,"cumReturnMin":0.03,"missStreakMax":4}` |
| 4 | `miss_streak_max: -1`（负数）回落默认 | ✅ PASS | `{"dirHitMin":0.7,"cumReturnMin":0,"missStreakMax":3}`（上轮 FAIL → 本轮修复） |
| 5 | `cum_return_min: "abc"`（字符串）回落默认 | ✅ PASS | `{"dirHitMin":0.7,"cumReturnMin":0,"missStreakMax":3}` |
| 6 | `dir_hit_min: .inf` 回落默认且不抛 | ✅ PASS | `{"dirHitMin":0.6,"cumReturnMin":0,"missStreakMax":3}` |
| 7 | `dir_hit_min: NaN` 回落默认且不抛 | ✅ PASS | `{"dirHitMin":0.6,"cumReturnMin":0,"missStreakMax":3}` |
| 8 | 优先级②：策略无 front-matter + 旧表存在 → 取旧表 | ✅ PASS | `{"dirHitMin":0.55,"cumReturnMin":0.01,"missStreakMax":4}` |
| 9 | 优先级②：无策略 + 旧表存在 → 取旧表 | ✅ PASS | `{"dirHitMin":0.5,"cumReturnMin":0.02,"missStreakMax":6}` |
| 10 | 优先级③：两者都无 → DEFAULT | ✅ PASS | `{"dirHitMin":0.6,"cumReturnMin":0,"missStreakMax":3}` |
| 11 | 解析失败不抛 + parseError 非空（`thresholds: [1,2`） | ✅ PASS | `parseError = "thresholds: 不支持流式集合：[1,2"`；回落 `{"dirHitMin":0.6,"cumReturnMin":0,"missStreakMax":3}` |
| 12 | 端到端：`review_retrospect` 随策略阈值切换 | ✅ PASS | 默认阈值触发「方向命中率低于下限」；策略 `dir_hit_min:0.2` 后「表现未劣于阈值」 |
| 13 | `strategy_set` 不再写 `thresholds.json` | ✅ PASS | `thresholds.json 是否存在 = false`；`strategy 当前版文件是否存在 = true` |
| 14 | 契约未变（cordis.patch.yml inject 四项） | ✅ PASS | `["tools","skills","ptcRuntime","fs"]` |

关键证据摘录：
```
[EVIDENCE] 逐键回落 = {"dirHitMin":0.7,"cumReturnMin":0,"missStreakMax":3}
[EVIDENCE] miss_streak_max -1 = {"dirHitMin":0.7,"cumReturnMin":0,"missStreakMax":3}
[EVIDENCE] parseError = "thresholds: 不支持流式集合：[1,2"
[EVIDENCE] 默认阈值 root_cause = "标的表现劣于阈值：方向命中率低于下限"
[EVIDENCE] 策略阈值 dirHitMin = 0.2
[EVIDENCE] 放宽后 root_cause = "表现未劣于阈值，无需根因定位"
[EVIDENCE] thresholds.json 是否存在 = false
[EVIDENCE] strategy 当前版文件是否存在 = true
[EVIDENCE] cordis.patch.yml inject = ["tools","skills","ptcRuntime","fs"]
```

---

## 三、回归（typecheck / build / test）

| 命令 | 结果 |
|------|------|
| `pnpm typecheck` | exit 0（无 TS 错误） |
| `pnpm build` | exit 0（tsc noEmit + 服务端 emit + 11 资源文件搬运成功） |
| `pnpm test` | exit 0，**43 文件全过 / 698 用例全过** |

说明：回归基线为上轮口径（43 文件 / 687 用例）；本轮我在**自己的**独立 spec 中新增 11 项边界用例（`miss_streak_max` 7 个非法值 + `0`/`5` + `cum_return_min -0.05`/`Infinity`），故全量变为 43 文件 / 698 用例，全绿。

---

## 四、缺陷清单

- 本轮**未发现新缺陷**。
- 上轮缺陷 1（`miss_streak_max` 负数未回落默认）**已闭环**（见「一」）。

---

## 五、未验证项 / 备注

- 无。上轮 14 项 + 本轮边界 + 回归均给出运行时证据，非推断。
- 未 commit / push；临时目录均 `rmSync` 清理，未污染真实数据。
- 上轮独立测试文件 `tester-task19-thresholds.INDEPENDENT.spec.ts` 仅**追加** R2 边界用例（新增 11 个 `it`），未删改原有断言；`src/**`、`tests/thresholds.test.ts` 等非独立文件未改动。

## 结论

- ✅ 通过：上轮 High 缺陷已闭环；14 项全部通过；typecheck/build/test 全绿。
- ❌ 未通过：无。
- ⚠️ 建议：`miss_streak_max` 的 `Number.isInteger` + `>= 0` 守卫与 `dir_hit_min` 的 `∈[0,1]` 校验均已覆盖，无遗留风险；可下发下一环节。
