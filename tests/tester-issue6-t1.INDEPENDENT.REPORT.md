# Issue #6 独立验收报告 —— `ledger_trade` A 股 T+1 校验

- **被测交付物**：`/Users/reachlucifer/project/opc/dsh-finance` 工作区（未提交变更，HEAD `cb9ad64`）
- **测试者**：Tester（独立测试，未修改 `src/**`、未修改既有测试、未 commit / push）
- **新增文件**：
  - `tests/tester-issue6-t1.INDEPENDENT.spec.ts`（21 个用例）
  - `tests/tester-issue6-t1.INDEPENDENT.REPORT.md`（本文件）
- **测试时间**：2026-10-21
- **运行环境**：macOS（Reach的MacBook Pro），Node v25.9.0，pnpm 11.7.0，vitest 3.2.7
- **测试方式**：真实 `Ledger` + `mkdtempSync` 临时数据目录 + 注入时钟；工具层走真实 `@deepseek-ai/dsh-tools` ToolRuntime registry（验证 `isError` 归一化），不是只读静态检查。

---

## 一、总体结论

| 项 | 结果 |
|---|---|
| 验收标准 AC1–AC7 | ✅ 全部通过（AC1 的字面措辞存在不可构造问题，见 §5-O1；按 AC2/AC5 语义验证通过） |
| `pnpm typecheck` | ✅ 通过（exit 0） |
| `pnpm build` | ✅ 通过（exit 0，dist-server 产物完整） |
| `pnpm test`（全量） | ⚠️ 9 个失败，**全部在基线 `cb9ad64` 同样失败**（逐项对比见 §4），本次变更新增失败数 = **0** |
| 独立用例（本文件） | ✅ 21/21 通过；`TZ=UTC` 复跑同样 21/21 通过 |
| 新发现缺陷 | ❌ **1 个（F1）**：`ledger_trade` 的 `reason` 可传 `'init'`，从而绕过 T+1 冻结（见 §5） |

**结论：Issue #6 的核心 T+1 拦截在 domain 层与工具层均按预期生效，零写入、跨日解冻、T+0、旧数据兼容均验证通过。但存在一个可绕过风控的入口（F1），建议 Leader 评估是否在本轮修复。**

---

## 二、用例清单与结果（21/21 通过）

### A. domain 层（真实 `Ledger` + 注入时钟 + 临时目录）

| # | 用例 | 对应 AC | 结果 |
|---|---|---|---|
| 1 | 同日买入 100 后卖 100 被拒；qty/cash/realizedPnl/trades 全不变 + 文件字节级零写入 | AC1 | ✅ |
| 2 | `init qty=0` 被拒（说明 AC1 字面场景需以「清仓后买入」构造） | AC1 前置 | ✅ |
| 3 | 期初 200 + 当日买 100：卖 200 成功；再卖 100 被拒（卖前可卖 200、卖后 0） | AC2 | ✅ |
| 4 | 跨日推进时钟：当日买入量清零、冻结部分可卖、卖 200 成功 | AC3 | ✅ |
| 5 | `settlement='T+0'`：买入后立即卖出 200 成功，回转后再买再卖仍成功 | AC4 | ✅ |
| 6 | `init` 期初 500 股当日可卖（`reason='init'` 不计入当日买入），realizedPnl=1000 | AC5 | ✅ |
| 7 | ETF 错误文案含「当日买入 100 份 / 可卖 100 份 / 持仓 200 份」 | AC6 | ✅ |
| 8 | 股票错误文案含「当日买入 100 股 / 可卖 100 股 / 持仓 200 股」 | AC6 | ✅ |
| 9 | 手写旧 `symbols.json`（无 settlement）→ 读为 T+1、按 T+1 拦截、`symbols.json` 字节不变 | AC7 | ✅ |
| 10 | 边界：23:59 买 / 次日 00:01 卖 → 放行（Asia/Shanghai 日界） | 边界 | ✅ |
| 11 | 边界：当日先卖后买再卖 —— 卖出不重置当日买入量 | 边界 | ✅ |
| 12 | 边界：当日买入后部分卖出 —— 剩余可卖 = 持仓 − 当日买入 | 边界 | ✅ |
| 13 | 边界：同日多笔买入累加（100+200），跨日后 400 全部解冻 | 边界 | ✅ |

### B. settlement 纯函数复核

| # | 用例 | 结果 |
|---|---|---|
| 14 | `tradingDayKey`：`15:59Z` = 北京 23:59 → `2026-10-13`；`16:00Z`/`16:01Z` → `2026-10-14` | ✅ |
| 15 | `computeSellableQty`：T+1 扣当日买入、T+0 全额、异常数据非负 | ✅ |

### C. 工具层（真实 registry：`ledger_init` / `ledger_query` / `ledger_trade`）

| # | 用例 | 对应 AC | 结果 |
|---|---|---|---|
| 16 | `ledger_init` 缺省 settlement=T+1；`ledger_query` 返回 `settlement`/`sellable_qty`；渲染文本含「结算：T+1 / 可卖：1000」；`ledger_list` 含 settlement | AC1/AC7 | ✅ |
| 17 | 同日超卖 → `isError=true`，文案含 T+1/当日买入/可卖/持仓；query 状态与文件字节零变化 | AC1/AC6 | ✅ |
| 18 | `settlement='T+0'` → 买入后卖 200 成功，`isError=false`，`new_qty=0` | AC4 | ✅ |
| 19 | 工具层跨日：`vi.setSystemTime` 推进到次日 → `sellable_qty` 解冻、卖出成功 | AC3 | ✅ |
| 20 | 工具层旧 `symbols.json`（无 settlement）→ `settlement='T+1'`、按 T+1 拦截、文件不回写 | AC7 | ✅ |
| 21 | `ledger_init` 传非法 `settlement='T+2'` → 注册层参数校验 `isError`，且不产生数据目录 | 健壮性 | ✅ |

**TZ 独立性复跑**：

```
npx vitest run tests/tester-issue6-t1.INDEPENDENT.spec.ts        → 21 passed
TZ=UTC npx vitest run tests/tester-issue6-t1.INDEPENDENT.spec.ts → 21 passed
```

---

## 三、关键证据

### 3.1 拒绝路径错误文案（实测原文）

ETF：

```
T+1 限制：当日买入 100 份不可卖出，当前可卖 0 份（持仓 100 份）
```

股票（期初 100 + 当日买 100，卖 200）：

```
T+1 限制：当日买入 100 股不可卖出，当前可卖 100 股（持仓 200 股）
```

- 数量三要素齐全（当日买入量 / 可卖量 / 持仓量）；
- 单位随 `type` 切换：`etf → 份`、`stock → 股`；
- 工具层该错误经 registry 归一为 `isError=true`，错误文本即上述 message。

### 3.2 AC1「零写入」前后状态对比（文件级）

场景：`init 100 @2`（cash 100000）→ 卖 100 @2.2（期初存量，合法）→ 买 100 @2.1 → 卖 100 @2.3（被拒）。

```
拒绝前 query: {"symbol":"588000","type":"etf","name":"科创50ETF","qty":100,
               "avgCost":2.1,"cash":100010,"realizedPnl":20,
               "settlement":"T+1","sellableQty":0,"floatPnl":0}
拒绝后 query: 全字段同上（qty=100 / cash=100010 / realizedPnl=20 / sellableQty=0）
trades 长度：3 → 3
positions.json / accounts.json / trades.json 前后字节全等：true
positions.json: {"symbol":"588000","qty":100,"avgCost":2.1}
accounts.json:  {"symbol":"588000","cash":100010,"realizedPnl":20,"floatPnl":0}
```

工具层同场景复验：`isError=true` 之后三张表字节仍全等（用例 17）。

### 3.3 AC2：存量与当日买入的区分

| 步骤 | qty | sellable | 结果 |
|---|---|---|---|
| init 200（`reason=init`） | 200 | 200 | — |
| 当日 buy 100 | 300 | 200 | ✅ |
| 卖 200 | 100 | 0 | ✅ 成功（只卖存量） |
| 再卖 100 | 100 | 0 | ❌ 拒绝（文案「当前可卖 0 份」） |

### 3.4 AC3：跨日解冻

- 10-13 10:00：init 100 + buy 100 → `sellable=100`；
- 时钟推进到 10-14 10:00：`todayBuyQty=0`，`sellable=200`，卖 200 成功，`newQty=0`；
- 工具层用 `vi.setSystemTime` 复验同结果（用例 19）。

### 3.5 AC4 / AC5

- T+0：init 100（`settlement='T+0'`）+ 当日买 100 → `sellable=200`，卖 200 成功；回转后再买 100 再卖 100 仍成功；
- T+1 期初存量：stock init 500 当日 `sellable=500`，卖 500 成功，`realizedPnl=(12−10)×500=1000`。

### 3.6 AC7：旧 `symbols.json` 兼容

手写 `symbols.json = {symbol,name,type,initPrice}`（**无 `settlement`**）+ positions 300 / cash 50000：

- `query.settlement = 'T+1'`、`sellable = 300`（归一化生效）；
- 读取、买入 100、被拒卖 400、成功卖 300 —— 四次操作后 `symbols.json` 字节**完全未变**，且仍不含 `settlement` 字段（读不回写）；
- 被拒卖 400 时 `trades.json` 字节亦未变。

---

## 四、全量校验与基线 `cb9ad64` 对比

### 4.1 静态/构建

| 命令 | 结果 |
|---|---|
| `pnpm typecheck` | ✅ exit 0 |
| `pnpm build` | ✅ exit 0（含 `clean` + `tsc` 双配置 + 资源搬运 13 个文件） |

### 4.2 `pnpm test` 全量

```
Test Files  6 failed | 83 passed (89)
Tests       9 failed | 1884 passed (1893)
```

失败的 6 个文件 / 9 个用例，逐项与基线对比（基线用 `git archive cb9ad64` 独立目录 + 软链 node_modules + 构建 dist-server 后运行相同文件）：

| 测试文件 | 基线 `cb9ad64` | 当前工作区 | 判定 |
|---|---|---|---|
| `tests/prompt-skills.spec.ts` | 1 failed（advisor.md 缺「只做分析、建议与推演」） | 1 failed（同断言） | 基线已有 |
| `tests/scheduler-wake.test.ts` | 4 failed（合规声明文本） | 4 failed（同断言） | 基线已有 |
| `tests/tester-strategy-feature.INDEPENDENT.spec.ts` | 1 failed（advisor.md 6 步工作流） | 1 failed（同断言） | 基线已有 |
| `tests/tester-t100438-trace-context.INDEPENDENT.spec.ts` | 1 failed（buildWakeText 逐字不变） | 1 failed（同断言） | 基线已有 |
| `tests/tester-task11-scheduler-chain-integration.INDEPENDENT.spec.ts` | 1 failed（waker 定点投递） | 1 failed（同断言） | 基线已有 |
| `tests/tester-task14-dsh-version-align.INDEPENDENT.spec.ts` | 1 failed（B5：advisor.md 断言含「金融」） | 1 failed（同一断言） | 基线已有 |
| **合计** | **8 test-level failed + 1 文件收集失败**（基线快照无 dist-server；补齐构建后复跑同样 9 failed） | **9 failed** | **新增 = 0** |

补充说明：

- 基线目录补齐 `dist-server` 构建后，`tester-task14` 的 B5 复现**完全相同**的断言失败（`expected ... to contain '金融'`），与本次 T+1 变更无关；
- 失败集中在 `advisor.md` 文案与 scheduler `buildWakeText` 合规声明，均不涉及 `src/domain/ledger.ts` / `settlement.ts` / `src/tools/ledgers.ts`；
- 本次新增的 21 个独立用例全部通过（含在 1893 总数内），`TZ=UTC` 复跑亦全部通过。

---

## 五、缺陷与风险

### ❌ F1（缺陷，建议修复）：`reason='init'` 可绕过 T+1 冻结

- **严重程度**：中（风控可被绕过；需调用方传入特定 `reason`）
- **位置**：`src/domain/settlement.ts` `todayBuyQty()` 仅按 `t.reason === 'init'` 排除；而 `ledger_trade` 工具把 `reason` 作为**自由文本**透传给 `Ledger.trade`。
- **复现步骤**：
  1. `ledger_init 588000 qty=100`（期初存量）；
  2. `ledger_trade sell 100`（清仓，合法）；
  3. `ledger_trade buy 100 price=2.1 reason="init"`；
  4. `ledger_query` → `sellable_qty = 100`（应为 0）；
  5. `ledger_trade sell 100` → **成功**（应为 T+1 拒绝）。
- **实测输出**：`[PROBE] buyOk=true sellable=100 sellOk=true err=`
- **期望**：仅 `Ledger.init()` 生成的建仓流水免计入当日买入；普通成交即使 `reason` 文本为 `init` 也应冻结。
- **建议**（不自行修复）：区分「建仓流水」与「交易理由」——例如给 init 流水打独立标记（`kind: 'init'`）而非复用 `reason`；或在 `Ledger.trade` / `ledger_trade` 中拒绝/清洗 `reason === 'init'`。

### ⚠️ O1（验收标准措辞问题，非实现缺陷）：AC1 字面场景不可构造

- AC1 写「`init` 后 `buy 100` → `sell 100` 被拒绝」，但 `init qty` 必须 >0 且为 100 倍数（`init qty=0` 直接报错），此时期初存量本身可卖，卖 100 合法。
- 该语义与 AC2（存量 200 + 当日买 100 可卖 200）、AC5（期初存量当日可卖）一致；实现行为正确。
- 本报告用「init 100 → 清仓 → 当日买 100 → 卖 100」构造等价场景验证，建议后续把 AC1 措辞改为「无期初存量时，当日买入 100 后卖出 100 被拒」。

### ⚠️ R1（既有风险，非本次引入）：交易时段闸门用宿主本地时区

- `ledger_trade` 的 `isTradingTime(new Date())` 用 `getHours()/getMinutes()`（宿主本地时区），而本次结算日界已正确固定 `Asia/Shanghai`。
- 若生产宿主 TZ 非中国时区（如 UTC 容器），真实 A 股竞价时段会被整体误判为「非交易时段」，所有下单被拒。建议后续统一为 `Asia/Shanghai`（与 `settlement.ts` 口径一致）。

### ⚠️ R2（设计取舍，需知悉）：旧 `symbols.json` 永不回填 `settlement`

- `LedgerStore.getSymbol` 读时归一化为 T+1 且不回写（满足 AC7「读取不产生回写」）。
- 影响：其他**直接读 `symbols.json` 原始文件**的消费者看不到 `settlement` 字段。当前仓库内 `listSymbols()` 只用 `symbol` 字段，无实际影响；后续新增直读方需注意走 `getSymbol`。

### 说明（非缺陷）

- 23:59 买 / 00:01 卖在 domain 层放行，是「按自然日判定 T+1」的预期行为；工具层受连续竞价时段闸门约束，现实中不存在 23:59 成交，二者不冲突。
- `trades` 的 `ts` 与 T+1 判定统一取自注入时钟，跨日测试与生产行为一致。

---

## 六、复现命令

```bash
cd /Users/reachlucifer/project/opc/dsh-finance

# 独立用例（含 domain + 工具层）
npx vitest run tests/tester-issue6-t1.INDEPENDENT.spec.ts

# 时区独立性
TZ=UTC npx vitest run tests/tester-issue6-t1.INDEPENDENT.spec.ts

# 全量
pnpm typecheck
pnpm test
pnpm build
```

> 本轮未修改 `src/**`、未修改既有生产测试、未 commit / push；仅新增上述 spec 与本报告。
