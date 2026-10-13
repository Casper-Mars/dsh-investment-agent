# Tester 测试报告 —— dsh-ia tools 层（t100353）

- 被测：`src/tools/**`（16 个工具的 defineTool 契约 + output schema + 写/读形态 + 边界）
- 方式：**真实 `@deepseek-ai/dsh-tools` ToolRuntime registry 管线**
  （`new Context()` → `provide('systemPrompt')` → `plugin(ToolRuntime)` →
  `inject:['tools']` 插件经 `registerAllTools` 注册 → `registry.execute`）
- 新增测试：`tests/tester-tools-runtime.spec.ts`（26 用例，独立于 Developer 的 `tests/tools.test.ts`）
- 未改动 `src/**`；dataRoot 用临时目录 `/tmp/dsh-fin-t4-*`，用后清理
- 全量复跑：`pnpm test` → **13 files / 187 tests all passed**（基线 161 + 本文件 26）
- 结论：**全部验收点通过**；仅发现 2 处**文档级（非阻断）**不一致，无功能性缺陷

---

## 逐条验收结果

### 验收点 1：defineTool 注册 / schema 合法 / ctx.tools 可见 —— ✅ 通过
- 真实 registry 恰好暴露 **16** 个工具，名称/顺序与 §4 契约表逐一相符，无重复。
  证据：`registered count=16 names=ledger_init,...,sense_archive_get`
- 每个工具 `parameters` / `output.schema` 均通过 `assertSupportedJsonSchema`（合法受支持子集）。
- `parameters` 已被 `defineTool` 编译为 object-root 的受支持 JSON Schema（声明处为隐式 open object，
  编译后有 `type:'object'` + `properties` + `required`），证明经 `defineTool` 归一。
- `ctx.tools.get(name)` 可解析全部 16 个工具，且 `output.schema` 顶层字段集合与契约表严格相等。
- 卸载：`dispose` 插件后 `ctx.tools.schemas()` 归 0；`registerAllTools` 注销器按**注册逆序**注销全部工具。

### 验收点 2：execute 走 domain、lossless JSON、符合 output schema —— ✅ 通过
- 16/16 工具在真实 registry 中执行成功，返回值经 `validateJsonSchemaValue(def.output.schema, value)`
  校验 **0 violation**。
- **严格性**：对 `ledger_query` 构造「缺字段 / 多字段 / 类型错」三种坏值，均判失败（`additionalProperties:false` 生效）。
- **registry 强制力**：注册合成工具返回未声明字段，`registry.execute` 归一为 `isError=true`，
  `error.info.name = ToolOutputError`，原始违规信息：
  `"value.extra" is not a declared property (additionalProperties: false)`。
- **静态守卫**：四组工具文件均经 `ctx.<domain>.` 调用 domain 层，且不含 `fetch(` / `node:http(s)`；
  `context.ts` 装配 ledger/predicts/reviews/sense-registry 四大 domain。

### 验收点 3：写类返回 {ok,...}，读类无 ok —— ✅ 通过
- 6 个写工具（`ledger_init`/`ledger_trade`/`predict_make`/`review_report`/`sense_archive_commit`/
  `sense_archive_rollback`）成功值均含 `ok=true`。
- 10 个读工具（`ledger_list`/`ledger_query`/`predict_verify`/`predict_get`/`review_check`/`review_get`/
  `review_metrics`/`review_retrospect`/`sense_archive_list`/`sense_archive_get`）成功值均**不含** `ok` 字段。

### 验收点 4：sense_archive_commit 的 change_type / parent 校验 —— ✅ 通过（含核报）
| 场景 | 实际行为 | 结论 |
|------|----------|------|
| `patch` 缺 parent | `isError=true`，message `[sense-registry] patch 必须带 parent`，无新版本 | ✅ 报错 |
| `patch` parent 不存在 | `isError=true`（parent 不存在） | ✅ 报错 |
| `keep` 无 current | `isError=true`，message `[sense-registry] keep 但尚无 current 版本`，无版本目录 | ✅ 报错不产版本 |
| `keep` 有 current | 成功，返回**沿用版本**（v001）、`is_current=true`，版本目录数不变 | ✅ 不产新版本 |
| **`replace` 缺 parent（核报）** | **成功**，返回 `{ok:true, version:'v001', is_current:true}`（作首版引导） | ⚠️ 见下 |
| `replace` → `patch` 带 parent | 成功，version 递增 `v002`、`is_current=true` | ✅ |
| `rollback` | 成功，返回 `{ok:true, current:'v001'}`；磁盘 `sense_versions/current` 由 `v002` 回指 `v001` | ✅ |

**⚠️ 核报（权威依据冲突）**：任务验收点 4 写「patch/replace 缺 parent 报错」，
但**实测 `replace` 缺 parent 不报错、成功作首版**（与详细设计 §4.4「仅 patch 强制 parent」一致）。
代码内 `sense-archives.ts` 头注释与工具 model-facing description 又称 replace「需带 parent」，
与实现不符（见下「非阻断问题」）。属**如实记录，不自行判定对错**。

### 验收点 5：写操作按 symbol 隔离 —— ✅ 通过
- 对 A(`588000`) ledger/predict/review 写入后，B(`000001`) 完全独立：
  A 持仓 qty=1500（1000+500）不受 B 影响；B qty=100、预判 `null`、复盘 `[]`、`dir_hit_rate=0`。
- 磁盘 `data/ledger/` 下为 `000001`、`588000` 两套独立目录。
- 反向验证：先写 A 取快照，再写 B，A 快照前后严格相等。

### 验收点 6：exec.signal 取消可中断、无半写 —— ✅ 通过
- registry 管线：传**已 abort** 的 signal → `isError=true`，`error.info.code=ABORTED_BEFORE_DISPATCH`；
  磁盘 `data/ledger/` 无标的目录残留，`ledger_list` 仍为空。
- `sense_archive_commit` 同上，无版本目录残留。
- 工具级守卫：直接 `execute` 且 signal 已 abort → 抛错（`/取消|abort/i`），不落盘。

### 端到端：标的全链路 —— ✅ 通过
`ledger_init` → `predict_make` → `predict_verify`（dirHit=true, rangeHit=true, deviation=0）
→ `review_report` → `review_metrics`（dir/range=1, history 合法）→ `review_retrospect`（root_cause/improvements 合法），
全程经工具层、全 `isError=false`、返回值均符合 output schema。

---

## 必报项（核报）

1. **实际工具数量 = 16**（非任务描述写的 15）。
   分组明细 4(ledgers)+3(predicts)+5(reviews)+4(sense_archives)=16，与 §4 契约表一致；
   与任务描述「共 15 个」冲突，实现取 16。
2. **`replace` 缺 parent 的实际行为 = 不报错、成功作首版**（`{ok:true, version:'v001', is_current:true}`）；
   `patch` 缺 parent 才报错；`keep` 无 current 报错且不产版本、有 current 不产新版本。

---

## 非阻断问题（文档/描述级，建议修复，不影响功能）

| # | 位置 | 问题 | 性质 |
|---|------|------|------|
| 1 | `src/tools/index.ts` L2/L22/L45、`src/tools/context.ts` L4/L38 | 注释写「15 个工具 / 15+ 工具」，实为 16（README 已注明并取 §4 契约表 16） | 非阻断（注释） |
| 2 | `src/tools/sense-archives.ts` 头注释「`patch`/`replace`：缺 parent 报错…replace…强制本层校验」；且 `sense_archive_commit` 工具 description「replace（整体替换，需带 parent）」 | 与实现不符：replace 缺 parent 实际**不报错**。该 description 面向模型，可能误导模型必填 parent | 非阻断（但 model-facing description 建议与实现对齐） |

> 无阻断性缺陷。写/读形态、schema 严格校验、symbol 隔离、取消语义、端到端链路均符合预期。

## 复跑命令
```bash
cd /Users/reachlucifer/project/opc/dsh-ia
pnpm test                                              # 187 passed
npx vitest run tests/tester-tools-runtime.spec.ts      # 26 passed（本报告依据）
```
