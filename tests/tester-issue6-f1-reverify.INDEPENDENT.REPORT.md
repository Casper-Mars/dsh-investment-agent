# Issue #6 · F1 修复**独立复验**报告 —— `reason='init'` 绕过 T+1

- **被测交付物**：`/Users/reachlucifer/project/opc/dsh-finance` 工作区（未提交，HEAD 仍 `cb9ad64`）
- **复验者**：Tester（独立复验，未修改 `src/**`、未修改既有测试、未 commit / push）
- **新增文件**：
  - `tests/tester-issue6-f1-reverify.INDEPENDENT.spec.ts`（40 个用例）
  - `tests/tester-issue6-f1-reverify.INDEPENDENT.REPORT.md`（本文件）
- **运行环境**：macOS（Reach的MacBook Pro），Node v25.9.0，pnpm 11.7.0，vitest 3.2.7
- **复验方式**：只经**公开 API**（真实 `Ledger` + 注入时钟 + `mkdtempSync` 临时数据目录；工具层走真实 `@deepseek-ai/dsh-tools` ToolRuntime registry）。未采信实现方 `tests/settlement.test.ts` / `tests/ledger.test.ts` 的断言，全部结论由本轮独立用例与字节级证据支撑。

---

## 一、总体结论

| 项 | 结果 |
|---|---|
| F1 原绕过路径（当日买入后 `reason='init'` 卖出） | ✅ **已封死**：被拒 + `positions/accounts/trades` 字节零变化 |
| 变体绕过（大小写/空白/Unicode/`null`/缺失） | ✅ **无可用绕过**：等价写法全部被拒；非等价写法放行但**计入冻结** |
| 非首笔伪造 `init`（手工 trades.json） | ✅ 不获豁免，按当日买入计入冻结 |
| 正常路径回归（T+1 拦截 / T+0 回转 / init 存量 / 普通 reason） | ✅ 无回归 |
| 工具层 `ledger_trade` 传 `reason='init'` | ✅ `isError:true`、文案可读、三表零写入；且**先于**交易时段校验返回 |
| 原 21 个独立用例 | ✅ 21/21 通过（默认 TZ 与 `TZ=UTC` 均通过） |
| `pnpm typecheck` | ✅ exit 0 |
| `pnpm build` | ✅ exit 0（`dist-server/index.js` 产物存在） |
| 全量测试（单 worker 顺序跑） | ✅ 9 failed / 1931 passed（共 1940），**与基线 `cb9ad64` 失败集合逐条相同**，新增失败 **0** |
| 本次复验新发现缺陷 | **0** |

**结论：Developer 声称的 3 处改动（保留值常量+归一化判定、`trade()` 顶部拦截、工具层独立拦截）经独立验证均真实生效，F1 绕过路径已封闭，且未引入回归。** 另有 4 条非缺陷观察（§7），供 Leader 决定是否跟进修辞/防御性细节。

---

## 二、逐条复验结论（对齐 Leader 下发的 7 条重点）

### 1. 原绕过路径已封死 —— ✅ 通过

场景（与首轮 F1 复现路径完全一致）：`init 100@2` → 卖出 100@2（清掉期初存量，合法）→ 当日买 100@2.1（`sellableQty=0`）→ 卖出 100@2.3 且 `reason='init'`。

- 返回 `{ ok: false }`，错误文案：
  `reason「init」为建仓保留标记，不可由交易接口传入；请改用其他交易理由`
- `query()` 快照前后全等（`qty=100 / avgCost=2.1 / cash=99990 / realizedPnl=0 / sellableQty=0`）
- 三表**字节级**前后原文全等（见 §4.1），标的目录清单（文件集合）不变
- 用例：`F1-A1`

### 2. 变体绕过 —— ✅ 通过（无绕过面）

| 输入 `reason` | 判定 | 结果 | 是否计入当日买入/被冻结 |
|---|---|---|---|
| `'init'` | 保留 | ❌ 拒绝 | —（零写入） |
| `'INIT'` / `'Init'` / `'inIt'` | 保留（小写归一化） | ❌ 拒绝 | — |
| `' INIT '` / `'  init  '` / `'init\t'` / `'\tinit\n'` | 保留（trim 归一化） | ❌ 拒绝 | — |
| `'ｉｎｉｔ'`（全角） | 非保留 | ✅ 放行 | ✅ 计入冻结（`todayBuyQty=100`，卖 200 被 T+1 拒） |
| `'init\u200b'` / `'\u200binit'`（零宽） | 非保留 | ✅ 放行 | ✅ 计入冻结 |
| `'init2'` / `'init init'` / `''` | 非保留 | ✅ 放行 | ✅ 计入冻结 |
| `null`（domain 层） | 非保留 | ✅ 放行 | ✅ 计入冻结（落库 `reason:null`） |
| 缺失（domain 层） | 非保留 | ✅ 放行 | ✅ 计入冻结（落库无 `reason` 字段） |
| `null`（**工具层**） | 参数类型非法 | ❌ `INVALID_ARGS`（`"reason" must be a string`） | —（零写入） |
| 缺失（工具层） | 合法 | ✅ 放行 | ✅ 计入冻结（卖 200 被 T+1 拒） |

关键点：**所有"能放行"的写法都不是特权写法**，落库后一律按普通买入累计进 `todayBuyQty`，因此当日仍不可卖（用例 `F1-A2`/`F1-A3`/`F1-A4`/`F1-A5`/`F1-C7`）。反向也成立：`' INIT '` 即便出现在**首笔**流水，也不享受豁免（偏保守，用例见 §二.3 与纯函数用例）。

### 3. 中间位置伪造 `init` —— ✅ 通过

手工构造 `trades.json`（`settlement=T+1`，`positions.qty=400`）：

```
[0] buy 200 @2.0  reason='init'   ← 首笔（唯一合法豁免）
[1] buy 100 @2.1  reason='加仓'
[2] buy 100 @2.2  reason='init'   ← 伪造：非首笔
```

结果：

- `todayBuyQty = 200`（不含首笔 200；**包含**伪造的 100）
- `query().sellableQty = 200`
- 卖 300 → 拒绝：`T+1 限制：当日买入 200 份不可卖出，当前可卖 200 份（持仓 400 份）`，且三表零写入
- 卖 200 → 成功（`newQty=200`）；再卖 100 → 拒绝
- 用例：`F1-B1`

### 4. 正常路径不回归 —— ✅ 通过

| 用例 | 场景 | 结果 |
|---|---|---|
| `R1` | 不传 reason 的 T+1 拦截 | ✅ 文案逐字为 `T+1 限制：当日买入 100 份不可卖出，当前可卖 0 份（持仓 100 份）` |
| `R2` | `settlement='T+0'` 当日回转 200 | ✅ 成功，`newQty=0` |
| `R3` | `init` 期初存量 500 当日可卖 | ✅ 成功，`realizedPnl=1000` |
| `R4` | 普通 reason（`'调仓'`）买入 200 | ✅ 仍被冻结（可卖 100，卖 300 被拒） |
| `R5` | 跨日解冻 | ✅ 次日 `sellableQty` 由 100 → 200，卖 200 成功 |
| `R6` | 同日多笔混合 reason（加仓 100 + 调仓 200） | ✅ `todayBuyQty=300`，仅 init 100 可卖 |

### 5. 工具层 —— ✅ 通过

- `ledger_trade` 传 `reason='init'`（交易时段）：`isError=true`，`error.info` 为 registry 归一化结果，文本：
  `Error: reason「init」为建仓保留标记，不可由 ledger_trade 传入；请改用其他交易理由（如「调仓」「止盈」），或使用 ledger_init 建仓`
- 三表字节零写入 + 目录清单不变（用例 `F1-C1`）；`' INIT '` 同样拒绝（`F1-C2`）
- **优先级验证（非交易时段 20:00）**（`F1-C4`）：
  - `reason='init'` → 返回**保留值错误**（不含「非连续竞价」）
  - `reason='调仓'` → 返回 `非连续竞价时段（9:30–11:30 / 13:00–15:00），拒绝下单`
  - 判定：**合理**。保留值是"调用契约违约"，与时钟无关；把它放在时段闸门之前，保证同一非法请求在任何时刻得到同一错误，不产生"白天报 A、夜里报 B"的时钟依赖行为。两条路径均零写入。
- 附加：`symbol` 不存在 + `reason='init'` → 仍返回保留值错误，且**不创建**该标的目录（`F1-C6`），说明拦截发生在任何 store 读写之前。

### 6. 原 21 个独立用例 —— ✅ 通过

```
npx vitest run tests/tester-issue6-t1.INDEPENDENT.spec.ts        → 21 passed (21)
TZ=UTC npx vitest run tests/tester-issue6-f1-reverify.INDEPENDENT.spec.ts → 40 passed (40)
```

（首轮用例未被我修改分毫；本轮新用例亦在 `TZ=UTC` 下 40/40 通过，证明判定不依赖宿主时区。）

### 7. 质量门禁 —— ✅ 通过

| 命令 | 结果 |
|---|---|
| `pnpm typecheck` | exit 0 |
| `pnpm build` | exit 0，`dist-server/index.js` 存在，13 个资源文件搬运完成 |
| 全量 `vitest run --maxWorkers=1 --minWorkers=1`（单实例顺序） | **6 failed files / 90；9 failed / 1931 passed（共 1940 用例）** |

失败清单（9 条，逐条与基线一致）：

| # | 文件 | 失败用例 | 类别 |
|---|---|---|---|
| 1–4 | `tests/scheduler-wake.test.ts` | `buildWakeText` ×3 + `Waker.wake` ×1 | buildWakeText 合规声明 |
| 5 | `tests/tester-t100438-trace-context.INDEPENDENT.spec.ts` | `buildWakeText/deriveSummary 逐字不变` | 同上 |
| 6 | `tests/tester-task11-scheduler-chain-integration.INDEPENDENT.spec.ts` | `T11-I2 全链路` | 同上（正文含合规声明） |
| 7 | `tests/prompt-skills.spec.ts` | `advisor.md 六大板块与合规约束` | advisor.md 文案 |
| 8 | `tests/tester-strategy-feature.INDEPENDENT.spec.ts` | `advisor.md 为 6 步工作流` | advisor.md 文案 |
| 9 | `tests/tester-task14-dsh-version-align.INDEPENDENT.spec.ts` | `B5 人设 section 含「金融」` | advisor.md 文案（dist-server） |

**基线对照（独立复现，非引用实现方结论）**：
用 `git archive cb9ad64 | tar -x -C /tmp/dsh-baseline` 拉出**未修复基线**，复用同一 `node_modules`，用 `tsc -p tsconfig.json --noEmit && tsc -p tsconfig.server.json && node scripts/copy-assets.mjs` 复刻构建（`pnpm build` 在符号链接 `node_modules` 上会触发 `ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY`，故绕过 pnpm 的 deps-status 检查，编译命令与 `package.json` 中 build 脚本一致），再以同样参数跑上述 6 个文件：

```
基线：Test Files 6 failed (6) | Tests 9 failed | 132 passed (141)
当前：同一 6 文件             | Tests 9 failed | 132 passed (141)
diff 失败用例名集合 → IDENTICAL_FAILURE_SET（9 vs 9，零差异）
```

→ **新增失败 = 0**；失败原因均为 `advisor.md` 文案与 `buildWakeText` 合规声明的文本期望不符（`expected ... to contain '本内容不构成投资建议'` / `to contain '金融'` / `to match /只做分析、建议与推演/`），与结算/T+1/F1 无关。

---

## 三、关键证据

### 3.1 domain 层拒绝路径：错误文案 + 三表字节对比

```
$reason='init' → error:
reason「init」为建仓保留标记，不可由交易接口传入；请改用其他交易理由
```

拒绝前后（原文，UTF-8 逐字节相等）：

```
BEFORE positions.json = {"symbol":"588000","qty":100,"avgCost":2.1}
       accounts.json  = {"symbol":"588000","cash":99990,"realizedPnl":0,"floatPnl":0}
       trades.json    = [ 3 条：init buy 100@2 / sell 100@2 / buy 100@2.1 ]
AFTER  同上（trades 仍 3 条，无新增流水）
EQUAL  true   （用例 F1-A1 断言 toEqual + 目录清单不变）
```

### 3.2 工具层拒绝路径（真实 registry）

```json
{"isError":true,
 "error":{"message":"reason「init」为建仓保留标记，不可由 ledger_trade 传入；请改用其他交易理由（如「调仓」「止盈」），或使用 ledger_init 建仓"},
 "content":[{"type":"text","text":"Error: reason「init」为建仓保留标记，不可由 ledger_trade 传入；…"}]}
```
`三表字节相等 = true`

非交易时段（20:00）优先级实测：

```
reason='init'  → Error: reason「init」为建仓保留标记，不可由 ledger_trade 传入；…
reason='调仓'  → Error: 非连续竞价时段（9:30–11:30 / 13:00–15:00），拒绝下单
```

### 3.3 非首笔伪造 init 的冻结计算（实测）

```
trades = [init 200@2.0, 加仓 100@2.1, init 100@2.2]   (均为当日)
todayBuyQty = 200            ← 首笔 200 豁免，伪造的 100 未豁免
sellableQty = 400 − 200 = 200
卖 300 → false: T+1 限制：当日买入 200 份不可卖出，当前可卖 200 份（持仓 400 份）
```

---

## 四、复验范围与方法（可复核性）

- 用例文件：`tests/tester-issue6-f1-reverify.INDEPENDENT.spec.ts`，40 个用例，分 5 组：
  1. 保留值归一化纯函数（18，含 8 个保留变体 + 6 个非保留变体参数化用例）
  2. domain 层原绕过 + 变体矩阵（7）
  3. 非首笔伪造 init（2）
  4. 正常路径回归（6）
  5. 工具层（7，含优先级与 `null`/缺失 reason）
- 未改动任何 `src/**`、未改动既有测试；`git status` 前后一致（仅新增本报告与用例文件）。未 commit / push。
- 复审代码仅用于**理解实现**，所有结论均由运行时行为与文件字节得出。

---

## 五、观察与建议（非缺陷，供 Leader 决策）

| # | 观察 | 影响 | 建议 |
|---|---|---|---|
| O1 | `isReservedTradeReason()` 归一化（trim+小写），而 `todayBuyQty()` 的豁免判定用**精确** `reason === 'init'` | 不对称但方向保守：老数据里若首笔写成 `'INIT'`/`' init '`，会被当作当日买入（冻结偏多，不会放开） | 可接受；若追求口径统一，可让 `todayBuyQty` 复用 `isReservedTradeReason()`，但须评估历史数据的一次性影响 |
| O2 | `cumReturnState` 收紧为"只认首笔 init"在本轮**不可观测** | `initialCapital = cash + Σ买入 − Σ卖出`，`initCost` 在公式中相消，故伪造 init 不改变返回值（`F1-B2` 实测 100830） | 纯防御性改动，无回归风险；不必额外验收 |
| O3 | 工具层保留值校验先于交易时段校验，也先于 symbol 存在性校验 | 非交易时段/不存在标的均优先报"保留值"错误；错误信息不泄露标的是否存在（略偏安全） | 合理，建议保持；若产品希望"时段错误优先"，需明确契约 |
| O4 | 全角/零宽等 Unicode 混淆写法不被识别为保留值 | 无绕过：此类买入照常计入冻结（`F1-A4`、`F1-C3` 已证） | 无需处理；如需"看起来像 init 就拒"，应做 NFKC 归一化，属可选加固 |
| O5 | 全量测试 9 个失败为 `advisor.md` / `buildWakeText` 文本期望不符（基线同样失败） | 与本次改动无关，但会长期污染 CI 红灯 | 建议单独立项对齐文案（本报告不涉及） |

---

## 六、复现命令

```bash
cd /Users/reachlucifer/project/opc/dsh-finance
npx vitest run tests/tester-issue6-f1-reverify.INDEPENDENT.spec.ts   # 40 passed
npx vitest run tests/tester-issue6-t1.INDEPENDENT.spec.ts           # 21 passed
pnpm typecheck                                                      # exit 0
pnpm build                                                          # exit 0
npx vitest run --maxWorkers=1 --minWorkers=1                        # 9 failed / 1931 passed（= 基线失败集合）
```
