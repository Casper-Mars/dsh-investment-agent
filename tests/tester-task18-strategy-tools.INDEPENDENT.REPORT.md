# Task-18「策略域工具层（strategy_get / strategy_set）」独立运行时验证报告

- **被测交付物（工具层，Ta***s）**：
  - 新增 `src/tools/strategy.ts`（`createStrategyTools` → `strategy_get` / `strategy_set`）
  - 改 `src/tools/schemas.ts`（+2 严格 schema）、`src/tools/context.ts`（`ToolContext.strategy`）、
    `src/tools/index.ts`（16→18）、`src/tools/README.md`、`src/plugin.ts`（仅注释）
  - 改既有测试 `tests/tools.test.ts` 等（16→18 计数 + 新增策略用例）——**未改它们**
- **独立测试**：`tests/tester-task18-strategy-tools.INDEPENDENT.spec.ts`（Tester 产出，未改 `src/` 与既有测试）
- **执行环境**：macOS node（Reach的MacBook Pro），pnpm 11.7.0 / node v25.9.0，vitest v3.2.7
- **命令**：`pnpm exec vitest run tests/tester-task18-strategy-tools.INDEPENDENT.spec.ts`
- **结果**：`Test Files 1 passed (1) | Tests 15 passed (15)`
  - 复核运行（含既有测试）：`tests/tools.test.ts`(30) + `tests/strategy.test.ts`(10) +
    `tester-task17-strategy`(11) + `tester-task18`(15) = **66 passed (66)**

---

## 逐条必验结论

### 必验点 1：注册与顺序 —— ✅ PASS

- `createAllTools()` 长度 = **18**，名称集合无重复（`new Set(names).size === 18`）。
- 名称集合包含 `strategy_get` / `strategy_set`。
- 顺序严格等于预期：`ledger_init/ledger_list/ledger_query/ledger_trade → strategy_get/strategy_set → predict_make/predict_verify/predict_get → review_check/review_report/review_get/review_metrics/review_retrospect → sense_archive_commit/sense_archive_list/sense_archive_rollback/sense_archive_get`（`names` 逐项 `toEqual` 全序断言）。
- 证据：运行时 `tools.map(t => t.name)` 输出与 `src/tools/index.ts:35-43`（`createAllTools` 五段展开顺序）一致。

### 必验点 2：参数契约 —— ✅ PASS

运行时读取 `tool.parameters`（defineTool 编译后的参数 JSON Schema）：

| 工具 | required | properties |
|------|----------|-----------|
| `strategy_get` | `['symbol']` | `symbol`, `version` |
| `strategy_set` | `['symbol','text','rationale']` | `symbol`, `text`, `rationale`, `parent_version` |

即：`strategy_get` = symbol(必填) + version(可选)；`strategy_set` = symbol/text/rationale(必填) + parent_version(可选)。与 `src/tools/strategy.ts:46-49 / 91-94` 声明一致。

### 必验点 3：行为（真实 execute，临时目录 dataRoot）—— ✅ PASS（5/5）

| 子项 | 期望 | 实测 |
|------|------|------|
| a. 未 `ledger_init` → `strategy_set` 抛错 | 错误含 `ledger_init` | ✅ `rejects.toThrow(/ledger_init/)`（`strategy.ts:115`） |
| b. 首版 → `{ok:true,version:'v001'}`；`strategy_get` 往返字段一致 | `{symbol,text,version,updated_at}` 且 text 与写入一致 | ✅ `s === {ok:true,version:'v001'}`；`g.symbol/text/version/updated_at` 全对齐，`updated_at` 为合法 ISO 时间；`expectMatchesOutputSchema` 通过 |
| c. 已注册未设定策略 → `strategy_get` 抛错 | 错误含 `strategy_set` | ✅ `rejects.toThrow(/strategy_set/)`（`strategy.ts:65`） |
| d. `parent_version:'v001'` → v002；`parent_version` 给错(v003 / 过期 v001) → 冲突 | v002 / 抛「不一致」 | ✅ v2 `=== {ok:true,version:'v002'}`；`v003` 与 `v001` 均 `rejects.toThrow(/不一致/)` |
| e. 落盘真实存在 | `strategy/<symbol>.md`、`strategy_versions/<symbol>/v00N.md`、`v00N.meta.json`、`current` | ✅ 逐文件 `existsSync` + 内容断言（current 指针 = v002，meta.parent 链 v001） |

### 必验点 4：中断语义 —— ✅ PASS

- `exec.signal` 已 aborted → `strategy_set` 抛错（`rejects.toThrow(/取消/)`，来自 `assertNotAborted`，`strategy.ts:106`）。
- 写前检查：aborted 后 `strategy/588000.md` **不存在**、`strategy_versions/588000/` 目录**不存在**（无半写）。
- 后续 `strategy_get` 仍报「未设定」引导，落盘状态未污染。

### 必验点 5：schema 严格性 —— ✅ PASS（经同一 `validateJsonSchemaValue` 验证）

- `strategy_get` 合法返回 → `validateJsonSchemaValue(...) === []`；塞入多余字段 `extra_field` → 违规数 > 0；缺失 `updated_at` → 违规数 > 0。
- `strategy_set` 合法 `{ok,version}` → `[]`；塞入多余字段 `symbol` → 违规数 > 0。
- 依据：`output.schema` 的 `additionalProperties: false` + 逐字段 `required`（`src/tools/schemas.ts:26-48`）。
- **如实说明**：直接调用 `ToolDefinition.execute()` 走的是「工具体原始执行」路径，**不会经过 registry 的 `ToolRuntime.execute()` 管线**，因此无法在此触发 registry 抛 `ToolOutputError`（`createSuccessResult` 阶段）。但 registry 对成功值施加的正是**同一个** `validateJsonSchemaValue(schema, value)`，且我已用编译后的 `t.output.schema`（registry 实际持有的 schema）验证其严格拒绝多余/缺失字段，故「schema 严格性」成立；registry 层的端到端触发未在本测试覆盖（需完整 cordis ToolRuntime + agent 装配）。

### 必验点 6：契约未变 —— ✅ PASS

- 顶层 `inject` 四项：`src/plugin.ts` 仍为 `export const inject: string[] = ['tools', 'skills', 'ptcRuntime', 'fs']`（正则断言命中）。
- `cordis.patch.yml`：`git diff -- cordis.patch.yml` **无输出（无 diff）**；文件内 `inject: ['tools', 'skills', 'ptcRuntime', 'fs']` 未变。
- `src/tools/README.md`：工具表 18（标题声明「18 个」，五组 4+2+3+5+4；18 个工具名逐一 `toContain`）。
- `src/plugin.ts` diff 复核：**仅注释变更**（16→18 的注释数字 + `（4 ledger + 2 strategy + ...）`），`inject` 数组与 `apply` 逻辑未变。

---

## 缺陷清单

无（15 项独立用例全通过，未发现偏离详细设计 §10.8 契约的行为缺陷）。

> 旁注（非缺陷，设计内约束）：`strategy_set` 的 `parent_version` 虽标记「可选」，但**首版必须省略**、非首版必须等于当前版——这是 §10.8 的版本不可变语义（domain 层已在 `src/domain/strategy.ts:160-176` 强制），工具层正确透传，非 bug。

---

## 未验证项

- registry 端到端 schema 校验（`ToolOutputError` 触发路径）—— 需完整 cordis `ToolRuntime` + agent 管线，无法在直接 `execute()` 测试中触发；已用同源 `validateJsonSchemaValue` 对编译后 schema 验证严格性（见必验点 5 说明），如实标注。

## 环境清理

- 全部用例使用 `fs.mkdtempSync` 临时目录，`afterEach` 中 `rmSync(recursive)` 清理，未污染真实 `dataRoot`。
- 未执行任何 `git commit/push`；新增文件仅 `tests/tester-task18-strategy-tools.INDEPENDENT.spec.ts` 与本报告。
