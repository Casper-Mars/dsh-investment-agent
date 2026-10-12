# t100437 · M5「字段级去敏 + 泄密扫描」· Tester 独立验收报告（**复验**）

- **任务**：t100437（飞书待办）— M5 去敏运行时行为 + 对抗性验证
- **本轮性质**：Developer 修复后**复验**（上一轮判 ❌ 不通过）
- **被测交付物 HEAD**：`99f8e48`（`fix(log): t100437 M5 缺陷修复——文本级裸令牌扫描…`，已 commit）
  - 前序：`4521805`（M5 初版字段级去敏）
  - 修复点：文本级裸令牌扫描（`Bearer` / 已知前缀 `sk-` / `gh…` / `xox…` / `AKIA`）+
    文本级金额键并入 + 金融域敏感键扩展（`balance/total/equity/nav/cash/shares/pwd`）+
    `Error.message` / `Error.stack` 同走文本级去敏
- **执行节点**：`Reach的MacBook Pro`（Node v25.6.0 / pnpm 11.7.0，pnpm 为唯一包管理）
- **交付物**：
  - `tests/tester-t100437-redact.INDEPENDENT.spec.ts`（**55 用例，全正向断言**，自成体系，不复用 dev 用例）
  - 本报告
- **隔离**：全程临时目录 + `DSH_FINANCE_LOG_DIR` 覆盖，**未触碰真实 `~/.dsh-finance`**；
  `git diff src/` **为空**（`redact.ts` md5 `43081abd…` 与基线一致）；
  `scripts/jev-news-demo.*` **未触碰**（mtime 仍为 Oct 12 00:2x，保持未跟踪原样）。

---

## 结论：✅ **通过**

> M5 三条验收标准**全部达标**。上一轮的阻断项（文本级 free-form 明文泄漏：裸 `Bearer …` /
> 裸 `sk-…` / 文本形态金额 `cost=…`）**已修复并可复现地验证遮蔽**；`typecheck` / `build` / `test`
> 全 **EXIT=0**（66 文件 / 1393 用例全绿）。对抗补充与误伤反例均符合预期。

---

## 1. 验收标准逐条核验（M5 三条）

| # | 验收标准 | 结论 | 关键证据 |
|---|----------|------|----------|
| 1 | 日志**无明文密钥**、**无完整台账金额 / 策略全文** | ✅ **通过** | **结构化路径**：`apiKey/authorization/password/balance/…` → `[REDACTED]`；`cost/pnl/positionValue` 等 → `[REDACTED]`；`strategy` 600→200+`…[truncated]`。**文本级路径（本轮修复）**：裸 `Bearer …`、裸 `sk-`/`gh…`/`xox…`/`AKIA`、文本金额 `cost=…`、JSON 形状 `{"authorization":"Bearer …"}`、`Error.message/stack` 明文 → 全部遮蔽（§3 真实落盘样本） |
| 2 | redact 字段值被 `[REDACTED]` 替换 | ✅ 通过 | 敏感/金额键 `redact()` 逐键断言 `=== '[REDACTED]'` 且**键名保留**（A1/B1/A5）；端到端落盘出现 `[REDACTED]`；上下文键 `symbol/qty/op/side/sessionId/taskId/traceId/name` **逐字保留**（B2） |
| 3 | 泄密扫描测试通过；既有业务测试全绿 | ✅ 通过 | 落盘全文对 `sk-` / `AKIA` / `Bearer` / 明文 JSON 敏感字段 4 类正则**零命中**（H2/K7）；全量 **66 文件 / 1393 用例 EXIT=0**；`typecheck`/`build` **EXIT=0** |

---

## 2. 本轮对 spec 的变更

1. **3 个 `[GAP]`（原 `it.fails`）翻转为正向 `it`（`[修复验证]`）** —— 修复后应通过：
   - `D6 [修复验证] 无键名裸 Bearer <token>（free-form）→ 遮蔽`
   - `D7 [修复验证] 无键名裸 sk-…（free-form）→ 遮蔽`
   - `H5 [修复验证] 裸 sk- 令牌经 free-form msg 落盘 → 遮蔽`
2. **新增 ⑪ 组对抗补充（K1–K7）**：
   - K1 已知前缀**全家族**（`sk-` / `sk-proj-` / `sk-ant-` / `gh[pousr]_` / `xox[bpoas]-` / `AKIA`）；
   - K2 `Bearer` **大小写变体**（`Bearer/BEARER/bearer/BeArEr`）；
   - K3 **JSON 形状** `{"authorization":"Bearer …"}` / `{"apiKey":"sk-…"}` / `{"pnl":-1}`；
   - K4 文本形态金额**一行多键**（空格 / 逗号 / 分号分隔）；
   - K5 `Error.message` 含明文令牌 + 金额；
   - K6 **误伤反例**（`Bearer of good news`、`task-driven`、`risk-adjusted-returns-2026`、`disk-usage-report`、普通长单词、`The cost of freedom…`、`The monkey ate a banana`）；
   - K7 JSON 形状 + 文本多键金额经真实 exporter 落盘 → 全文零命中。

用例统计：**55 用例**（48→55：GAP 3 条翻转 + 新增 7 条，**全部正向断言，无 `it.fails`**）。

---

## 3. 关键证据

### 3.1 ✅ 文本级（free-form）路径：真实 exporter 落盘样本（修复后，上一轮 3 条泄漏复现已消除）

命令：临时 probe 经真实 `createFileExporter` 写盘（`2026-10-12.jsonl`），**已删除 probe 文件并清理临时目录**。

```jsonc
{"ts":"2026-10-12T12:00:00.000Z","level":"info","name":"dsh-finance","msg":"upstream said: [REDACTED] (no key name)","pid":39491,"origin":"host"}
{"ts":"2026-10-12T12:00:00.000Z","level":"warn","name":"dsh-finance","msg":"cost=[REDACTED] pnl=[REDACTED] symbol=588000","pid":39491,"origin":"host"}
{"ts":"2026-10-12T12:00:00.000Z","level":"error","name":"dsh-finance","msg":"Error: fetch failed, leaked [REDACTED] (no key name)\n    at …",…}
{"ts":"2026-10-12T12:00:00.000Z","level":"info","name":"dsh-finance","msg":"{\"authorization\":\"[REDACTED]\"}",…}
```

对照上一轮（HEAD `4521805`）三条泄漏行 —— **均已遮蔽**：
`Bearer sk-BARE1234567890abc` → `[REDACTED]`；`cost=12.345678 pnl=-99999.5` → `cost=[REDACTED] pnl=[REDACTED]`（`symbol=588000` 保留）；
`leaked sk-BAREERR1234567890` → `[REDACTED]`。

### 3.2 ✅ 结构化路径（沿用上一轮证据，未回归）

`apiKey/authorization/password/...` → `[REDACTED]`；`cost/pnl/positionValue` → `[REDACTED]`；
`strategy` 600→200+`…[truncated]`；`symbol/qty/side` 保留；全文泄密正则零命中（H2）。

### 3.3 `redactText` 直探（node 类型剥离，等价运行时）

```
upstream said: Bearer sk-ABCDEFGHIJ1234567890  ->  upstream said: [REDACTED]
cost=12.345678 pnl=-99999.5 symbol=588000       ->  cost=[REDACTED] pnl=[REDACTED] symbol=588000
Bearer of good news                             ->  Bearer of good news          # 不误伤
Authorization Bearer eyJ… (无冒号)              ->  Authorization [REDACTED]       # 裸 Bearer 扫描兜底
balance=1000 equity=500 nav=7                   ->  balance=[REDACTED] equity=[REDACTED] nav=[REDACTED]
```

---

## 4. 变异验证（证明用例非空转）

在 `src/log/redact.ts` 临时注入变异，运行 `tests/tester-t100437-redact.INDEPENDENT.spec.ts + tests/redact.test.ts`，
随后**还原**并核对：

| 变异 | 破坏点 | 结果 | 还原后 |
|---|---|---|---|
| **A** `redactTextCore` 去除 `redactBareTokens`（裸令牌扫描失效） | 修复点① | **10 个用例失败**（本 spec 6：D6/D7/H5/K1/K2/K5；dev 4） | md5 回基线，`git diff src/` 空 |
| **B** `redactAssignments` 判定去除 `isAmountKey`（文本金额失效） | 修复点② | **6 个用例失败**（本 spec 4：K3/K4/K5/K7；dev 2） | md5 回基线，`git diff src/` 空 |

- 基线 md5：`43081abde7edd1b7cf51438bcd9d8255`；变异 A `fa3dc956…`，变异 B 变更后均**还原**。
- 还原验证：`md5(redact.ts)` = `43081abd…`（与基线一致）；`git diff --stat src/` = **空**。

---

## 5. 全量回归

| 命令 | 结果 |
|---|---|
| `pnpm typecheck` | **EXIT=0** |
| `pnpm build` | **EXIT=0**（11 个资源文件搬运） |
| `pnpm test`（含本独立用例） | **66 文件 / 1393 用例 EXIT=0**（全绿） |

用例数核对：dev 自测 `tests/redact.test.ts` **35**（29 + 修复回归 6）；本独立 spec **55**；
合 66 文件 / 1393 用例，与 Developer 报「66 文件 / 1386 用例（其中仅你 spec 3 个 `it.fails` 意外通过失败）」+ 本轮新增 7 条一致。

---

## 6. flake 归因（如实记录）

- 全量跑第 1 次：**66 / 1393 全绿**；第 3 次：**66 / 1393 全绿**。
- 全量跑第 2 次：1 失败 —— `tests/tester-prompt-skills.INDEPENDENT.spec.ts > [3] …`，
  `Error: Test timed out in 5000ms.`（真实 cordis E2E **临界超时**，已知 flake；该次运行与其它
  `pnpm test` 存在负载叠加）。
- **单跑复验**：`pnpm vitest run tests/tester-prompt-skills.INDEPENDENT.spec.ts` → **33/33 通过 EXIT=0**
  （环境 5ms，无超时）。
- **结论**：该失败为**并行负载下的既有 flake**，与本轮 M5 去敏修复**无关**（未触碰相关代码路径）。

---

## 7. 残留风险（均为低，不阻断；供后续可选优化）

| # | 现象 | 复现 | 严重度 | 说明 |
|---|------|------|--------|------|
| R1 | 值内含空格时仅遮蔽首个词元 | `redactText('password=abc def')` → `password=[REDACTED] def` | 低 | 值分支在空白处收束；`abc` 已遮蔽，`def` 残留（沿用上一轮「风险 3」，未变化） |
| R2 | `key=` 后接 JSON 对象值部分残留 | `redactText('token={"a":1}')` → `token=[REDACTED]"a":1}` | 低 | 值分支遇 `"` 收束；键名/嵌套敏感键仍会被后续全局扫描处理，非高价值 secret 场景 |
| R3 | 非标准 `bearer:`（冒号无空格）形态不遮蔽 | `redactText('bearer:eyJ…')` → 原样 | 低 | 标准 Authorization 形态为 `Bearer <空格><token>`，已被覆盖 |
| R4 | 低于长度阈值的短令牌不遮蔽（形态判据） | `redactText('sk-ABC')` | 低 | 设计取舍：阈值（`sk-`≥10 续字符 / `Bearer`≥16）用于规避误伤，非通用高熵猜测 |

> fail-closed 过度遮蔽（`monkey/hockey/keyword/author` 等含敏感子串的键）为**设计声明口径**，接受（A7 记录）。

---

## 8. 结论与建议

- **总体**：✅ **通过**。M5 三条验收标准达标；上一轮阻断缺陷（文本级 free-form 明文泄漏）已修复并有可复现证据；对抗用例 + 误伤反例齐备；变异验证证明用例可检出回归；全量回归与构建全绿。
- **建议动作（可选，不阻断）**：按 §7 R1/R2 收口「带空格 / JSON 值」的文本级边界，进一步减少残留形态。
- **复验状态**：`git diff src/` **为空**；`redact.ts` md5 `43081abd…` 未残留任何改动；
  临时 probe 文件已删除；`scripts/jev-news-demo.*` 未触碰。
