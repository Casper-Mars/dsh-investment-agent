# 测试报告 — t100405：[P1] ledger_query 浮动盈亏 float_pnl

- 被测目录：`/Users/reachlucifer/project/opc/dsh-finance`
- 被测态：工作区未提交改动（6 文件），branch = `main`
- 目标节点：Reach的MacBook Pro
- 测试方式：独立复跑（typecheck / 全量 test）＋ 独立自建场景验证（不复用 Developer 断言）
- 独立 spec：`tests/tester-t100405-float-pnl.INDEPENDENT.spec.ts`（20 用例，全绿）

## 结论速览

| 维度 | 结论 |
|------|------|
| 口径正确性 `float_pnl=(price−avgCost)×qty`（4 位小数） | ✅ 正确 |
| 持久化未被污染（即时计算，不写库） | ✅ 确认 |
| 向后兼容（旧单参 `query(symbol)`） | ✅ 正常 |
| 边界（空仓 / 负值 / price=0） | ✅ 全部符合预期 |
| 整体判定 | **PASS（5/5 验收项通过）** |

## 验收标准逐条判定

| # | 验收标准 | 判定 | 独立证据 |
|---|---------|------|---------|
| 1 | 不传 price → `float_pnl = 0` | ✅ PASS | `query('588000')`→0；`query('588000', undefined)`→0；工具层 `ledger_query {symbol}`→`float_pnl=0` |
| 2 | 传 price=X → `float_pnl=(X−avg_cost)×qty`（4 位小数），含空仓/持仓 | ✅ PASS | 持仓：(2.5−2.0)×1000=**500**、(1.8−2.0)×1000=**−200**、(9.9−2.0)×1000=**7900**；第二标的 (11−10.5)×300=**150**；空仓 qty=0→**0**；4 位小数 (2.123456789−2.0)×1000=123.456789→**123.4568** |
| 3 | 新增单测覆盖两分支 | ✅ PASS | diff 新增 8 个 `it`（ledger.test.ts +5 / tools.test.ts +3），覆盖不传/传/空仓/舍入/不污染；独立复跑全绿 |
| 4 | 文档 §4.1 / §5.1 与实现逐字一致 | ✅ PASS（以任务契约为准） | 仓库内无 v1.9 设计文档（`grep float_pnl *.md` 无命中），按任务给出契约逐条比对实现：签名/公式/舍入/不写库/可选参数/schema 描述 —— 全部一致（详见下节） |
| 5 | `pnpm typecheck` + `pnpm test` 通过 | ✅ PASS | typecheck EXIT=0；全量 `838 passed (40 files)` EXIT=0，基线 830 → +8，与 Developer 自述一致 |

## 契约 vs 实现逐条比对（§4.1 / §5.1）

- **§5.1 签名** `query(symbol, price?)` → `ledger.ts:146` `query(symbol: string, price?: number): PositionSnapshot` ✅
- **§5.1 公式** `floatPnl = round((price − avgCost) × qty, 4)` → `ledger.ts:156` `typeof price === 'number' ? round((price - avgCost) * qty, 4) : 0` ✅
- **§5.1 不传 → 0（即时计算、不写库）** → 返回值即时计算，`accounts` 仅在 init/buy/sell 写占位 0，query 不触碰 store ✅
- **§4.1 工具增可选 price + execute 透传** → `ledgers.ts:138` price 省略 `required`；`ledgers.ts:157` `ctx.ledger.query(args.symbol, args.price)` ✅
- **§4.1 schema 补口径** → `schemas.ts` `float_pnl` description = 「浮动盈亏 =(现价−平均成本)×持仓数量，保留 4 位小数；未提供现价时为 0」 ✅
- **types.ts** `PositionSnapshot.floatPnl` 注释补口径 ✅

## 关键专项核验

- **持久化不污染**：带 price 查询前后 `ledger/588000/accounts.json` **原始字节完全一致**；持久化字段 `floatPnl` 恒为 0；带 price 查询后再不传 price 仍返回 0。买入后 `accounts.floatPnl` 仍写占用 0。
- **向后兼容**：`query('588000')` 单参正常返回完整快照且 `floatPnl=0`；`list()` 内部单参调用不受影响；全仓仅 2 处调用点（工具层可选透传 + list 内部单参），无破坏。
- **schema 一致性**：工具层返回经 `validateJsonSchemaValue(output.schema, v)` 严格校验，持仓/空仓/price=0 各返回均 0 违规；`parameters` 归一化后 `required=["symbol"]`，`price` 不在 required 列表（可选），typecheck EXIT=0 无编译报错。
- **边界**：
  - 空仓 qty=0 → `float_pnl=0`，且 `Object.is(floatPnl,-0)===false`（非 −0）
  - 负浮动符号正确（−200 / −150）
  - `price=0` → `typeof 0==='number'` 成立，参与计算 (0−2.0)×1000=**−2000**，未回落为 0

## 风险 / 建议

- ⚠️ 差异点（非缺陷）：持久化 `accounts.json` 字段为 **camelCase `floatPnl`**（store 内部结构），而工具/schema 对外契约为 **snake_case `float_pnl`**；由工具层显式映射，属既有设计，核对时勿混淆。
- ⚠️ `round()` 采用 `(value + Number.EPSILON)` 半进位；负数半数（如 −0.00035→−0.0003）非银行家舍入。当前契约仅示例均命中，未构成验收偏差，仅记录。
- 💡 建议：`price` 若传入 `NaN`/`Infinity` 会得到 `NaN`/`Infinity` 的 `float_pnl`（无入参有限性校验），如有需要可后续在工具层加有限数校验（当前非本任务验收范围）。

## 未通过项

无。

---
Tester 独立复核完成，无中间件启动，无需清理。
