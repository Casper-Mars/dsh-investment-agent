# 独立测试报告 —— t100460「对齐区间命中口径并清理无效必填参数」（Issue #2，P0）

- **被测交付物**：`/Users/reachlucifer/project/opc/dsh-finance`（仓库 `Casper-Mars/dsh-investment-agent`）
- **目标节点**：Reach的MacBook Pro（Node v25.9.0，TypeScript 5.9.3，vitest 3）
- **基线**：`7d5c194`（工作区未 commit，含 6 个被改文件）
- **采纳方案**：方案 A —— 区间命中锁定为「收盘价」口径；仅改对外契约/必填约束/注释/测试，**不改判定语义**
- **被测改动 6 文件**：`src/tools/schemas.ts`、`src/tools/predicts.ts`、`src/tools/reviews.ts`、`src/domain/types.ts`、`tests/predicts.test.ts`、`tests/tools.test.ts`
- **独立测试文件**：`tests/tester-t100460-range-semantics.INDEPENDENT.spec.ts`（14 用例，**全绿**）
- **结论**：✅ **通过验收（AC1–AC4 全部满足）**，无新增缺陷，无回归。

> 独立性：AC1 **不读源码注释**，而是独立读取 `defineTool` 注册后的**工具对象**上的模型可见契约
> （`ToolDefinition.parameters` = dsh-tools 编译出的参数 JSON Schema，含逐属性 `description` 与顶层
> `required` 列表；`ToolDefinition.output.schema` = 成功返回值的强校验 Schema）。AC2/AC3/AC4 自建
> 预测并直接调用 domain 纯函数交叉验证，**未复用** Developer 的任何断言或 seed。

---

## AC1 三处契约一致（工具对象独立读取）

**结论：✅ 通过。** 三处均指向「收盘口径」，且 `predict_verify` 的 `actual_high/actual_low` 已从 `required` 移除。

**实测命令**（vitest 用例内，独立读取工具对象）：
```ts
const p = createAllTools(ctx).find(t => t.name === 'predict_verify').parameters   // 编译后 JSON Schema
const out = createAllTools(ctx).find(t => t.name === 'review_metrics').output.schema
```

**实际读取到的字符串 / required 列表**（原文照录）：

| 读取位置（工具对象） | 值 |
|---|---|
| `predict_make.required` | `["symbol","date","dir","range_low","range_high","confidence","watch_points"]` |
| `predict_make.parameters.range_low.description` | `预期收盘区间下沿（收盘口径：判定时以实际收盘价是否 ≥ 本下沿为准）` |
| `predict_make.parameters.range_high.description` | `预期收盘区间上沿（收盘口径：判定时以实际收盘价是否 ≤ 本上沿为准）` |
| `predict_verify.required` | `["symbol","date","actual_close","prev_close"]` ← **不含 actual_high / actual_low** |
| `predict_verify.parameters.actual_close.description` | `实际收盘价（参与区间判定，收盘口径：收盘价落入 [range_low, range_high] 闭区间即命中）` |
| `predict_verify.parameters.actual_high.description` | `实际最高价（当前不参与判定：区间判定为收盘口径，本字段预留给日后高低价口径）` |
| `predict_verify.parameters.actual_low.description` | `实际最低价（当前不参与判定：区间判定为收盘口径，本字段预留给日后高低价口径）` |
| `predict_verify.output.schema.hit_range.description` | `区间是否命中（收盘口径：实际收盘价落入预测区间 [range_low, range_high] 闭区间即命中；与盘中最高/最低价无关）` |
| `review_check.parameters.hit_range.description` | `命中结果注入：区间是否命中（可选；收盘口径，见 predict_verify）` |
| `review_report.parameters.hit_range.description` | `区间是否命中（可选；收盘口径，见 predict_verify）` |
| `review_metrics.output.schema.range_hit_rate.description` | `区间命中率（0-1，收盘口径：按实际收盘价落入预测收盘区间计）` |

判定断言：`required` 不包含 `actual_high`/`actual_low`；三处 `hit_range` 描述均 `toContain('收盘')`；`actual_high/low` 描述均 `toContain('不参与判定')` —— **全部通过**。
（另核对：`predict_make` 的 `range_low/range_high` **仍为必填**，未误删。）

---

## AC2 可选参数可用（自建预测，传 / 不传对比 + 复现 Issue #2）

**结论：✅ 通过。**

### (a) 不传 `actual_high/actual_low` 与传入时逐字段一致
自建预测 `588001@2026-09-29 up [1.8,2.2]`，分别调用：
```ts
withHL    = predict_verify{actual_close:2.0, actual_high:2.5, actual_low:1.5, prev_close:1.8}
withoutHL = predict_verify{actual_close:2.0, prev_close:1.8}
```
实测输出（原文）：
```json
withHL    = { "hit_dir": true,  "hit_range": true, "deviation": 0 }
withoutHL = { "hit_dir": true,  "hit_range": true, "deviation": 0 }
```
`withoutHL` 与 `withHL` **逐字段一致**，且字段集合恰为契约三字段 `["deviation","hit_dir","hit_range"]`（无 `ok`、无多余字段），调用**不抛错**。

### (b) 独立复现 Issue #2 数字
`range_low=48.00, range_high=49.20, prev_close=49.75, actual_close=48.67, actual_high=51.16, actual_low=48.05`

| 构造 | 实测结果 | 说明 |
|---|---|---|
| `dir='up'` | `{ "hit_dir": false, "hit_range": true, "deviation": 0 }` | `close 48.67 < prevClose 49.75` → 实际方向 down；预判 up ⇒ 方向**未命中**；`48.67 ∈ [48.00,49.20]` ⇒ 区间命中 |
| `dir='down'` | `{ "hit_dir": true,  "hit_range": true, "deviation": 0 }` | 同上，实际方向 down 与预判 down 一致 ⇒ 方向**命中** |

> ⚠️ **任务书口径提示**：任务书原文「期望 hit_dir=false（预期 down？请按 dir=down 构造）」内部自相矛盾——
> 在给定数字（`close<prevClose`，实际方向为 down）下，**`hit_dir=false` 对应 `dir='up'`**，而
> **`dir='down'` 会得到 `hit_dir=true`**。两种构造均实测，`hit_range=true`、`deviation=0` 恒成立。
> 已按事实报告，未盲从括号内指示。

### (c) 交叉验证
`withoutHL` 与直接调用 `computeHit('up',48.0,49.2,{close:48.67,prevClose:49.75})` 的结果完全一致。

---

## AC3 口径锁定用例独立核验（high 越界但 close 命中 → hit_range=true）

**结论：✅ 通过（用例确为「有意取舍」，前提真实成立）。**

先独立断言前提：`high=51.16 > range_high=49.2`（**越上界**）、`low=47.8 < range_low=48.0`（**越下界**）、
`48.0 ≤ close=48.67 ≤ 49.2`（**命中**）。再直接调用 `computeHit` 与工具层同场景验证：
```json
computeHit('up',48.0,49.2,{close:48.67,high:51.16,low:47.8,prevClose:48.1}) = { "hitDir": true, "hitRange": true, "deviation": 0 }
工具层 predict_verify{actual_close:48.67, actual_high:51.16, actual_low:47.8, prev_close:48.1} = { "hit_dir": true, "hit_range": true, "deviation": 0 }
```
即断言确实表达了「**high 越界但 close 命中**」，且原因是收盘口径（只比较 close）——**有意取舍，非缺陷**。

---

## AC4 判定语义未变 + 类型/回归

**结论：✅ 通过。**

### (a) `computeHit` 未被改动
```bash
$ git diff -- src/domain/predicts.ts
（无任何输出）
```
判定核心 `src/domain/predicts.ts`（含 `computeHit`）**零改动**。
（`git diff --stat` 仅列出题述 6 文件：`src/domain/types.ts / src/tools/predicts.ts / src/tools/reviews.ts / src/tools/schemas.ts / tests/predicts.test.ts / tests/tools.test.ts`。）

### (b) 类型检查
```bash
$ npx tsc -p tsconfig.json --noEmit
TSC_EXIT=0
```
附加独立类型核验（`ActualitySnapshot.high/low` 可选）：
```bash
# 正向：仅 { close, prevClose } 应通过
$ npx tsc --noEmit ... /tmp/t100460-types.ts          → TYPE_EXIT=0
# 负向对照：缺少必填 prevClose 应报错（证明 typecheck 有效力）
$ npx tsc --noEmit ... /tmp/t100460-neg.ts            → NEG_EXIT=2
../../../../../tmp/t100460-neg.ts(3,7): error TS2741: Property 'prevClose' is missing in type '{ close: number; }' but required in type 'ActualitySnapshot'.
```
即：`high/low` 已可选，而 `prevClose` 仍为必填。

### (c) 无新增失败（改动前后失败集合对比）
流程：`git stash push -m t100460-independent -- <6 文件>` → 跑基线全量 → `git stash pop` → 跑改后全量。

| 运行 | total | passed | failed | suites |
|---|---|---|---|---|
| 基线（6 文件 stash 回 `7d5c194`） | 1485 | 1472 | **13** | 480 |
| 改后（工作区含 6 改动 + 本独立 spec） | 1503 | 1490 | **13** | 485 |

**失败文件集合（逐文件，基线 ≡ 改后，完全一致）**：
```
tests/prompt-skills.spec.ts
tests/scheduler-wake.test.ts
tests/tester-prompt-skills.INDEPENDENT.spec.ts
tests/tester-strategy-feature.INDEPENDENT.spec.ts
tests/tester-t100418-skill-assets.INDEPENDENT.spec.ts
tests/tester-t100433-seed-provision.INDEPENDENT.spec.ts
tests/tester-t100438-trace-context.INDEPENDENT.spec.ts
tests/tester-task11-scheduler-chain-integration.INDEPENDENT.spec.ts
tests/tester-task14-dsh-version-align.INDEPENDENT.spec.ts
```
- **NEW failures（改后有、基线无）：无**
- **FIXED（基线有、改后无）：无**
- 测试总数 +18 = 本独立 spec(14) + Developer 新增(2+2=4)，**无一新增用例失败**。

> 该 9 文件为**既有背景失败**（advisor.md 文案、scheduler buildWakeText、trace-context、task11/task14 等），
> 与本次改动无因果；其中 `tester-prompt-skills`、`tester-t100418-skill-assets` 为任务书标注的并发 flaky，
> 两次运行均出现（不影响「无新增失败」结论）。

### (d) 其它回归
- `createAllTools` 仍返回 **14** 个工具（契约改动未增删工具）。
- 历史边界语义未变（独立复验）：上破 `close=2.3 ∈ [1.9,2.1]?` → `{hitDir:true,hitRange:false,deviation:0.2}`；
  下破 → `{hitDir:false,hitRange:false,deviation:0.05}`；flat 边界 → `{true,true,0}`；`close` 恰等于下沿 → 命中。

---

## 风险点 / 建议

1. **任务书 Issue #2 的 `hit_dir` 期望值有歧义**（见 AC2(b) 提示）：`dir='up'` 得 `hit_dir=false`、
   `dir='down'` 得 `hit_dir=true`。建议 Leader 明确 Issue #2 场景的预判方向，避免验收口径分歧。
   （本改动的核心口径 `hit_range=true / deviation=0` 不受影响。）
2. **`tsc -p tsconfig.json` 不覆盖 `tests/**`**（`tsconfig.json` 的 `exclude` 含 `**/*.test.ts`）。
   测试文件的类型错误不在 CI 基线门禁内；如需，可评估为 tests 增加类型检查配置（非本任务范围）。
3. **已知 flaky**（`tester-prompt-skills`、`tester-t100418-skill-assets`）在低并发单跑可过；建议 CI 关注
   并发度（`vitest.config.ts` 已限 `maxWorkers: 4`），不影响本次结论。
4. 本报告未评估 Developer 新增用例的写法（不重复其自检），仅做独立复验。

---

## 附：工作区恢复确认

```
$ git status --porcelain
 M src/domain/types.ts
 M src/tools/predicts.ts
 M src/tools/reviews.ts
 M src/tools/schemas.ts
 M tests/predicts.test.ts
 M tests/tools.test.ts
?? src/skills/finance-evolution/                       （改动前既存，未触碰）
?? tests/tester-t100460-range-semantics.INDEPENDENT.spec.ts   （本次新增独立测试）
?? tests/tester-t100460-range-semantics.INDEPENDENT.REPORT.md （本次新增报告）

$ git stash list
（空 —— 无遗留 stash）
```
- 未 commit；仅新增独立测试与报告两份产物，**未改动被测源码与 Developer 产物**。
- 独立测试：`npx vitest run tests/tester-t100460-range-semantics.INDEPENDENT.spec.ts` → **14 passed / 0 failed**。
