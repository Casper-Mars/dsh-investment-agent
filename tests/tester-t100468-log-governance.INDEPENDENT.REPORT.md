# 独立测试报告：任务-06「日志治理（脱敏扩展 + 保留策略）」

> **复验轮更新（2026-10-17 12:24）**：Developer 已修复 D1 / D2，独立 spec 全量 **62 passed / 0 failed**。最终判定 **✅ 通过**；初轮结论与缺陷明细保留作历史记录，详见文末「复验轮（D1 / D2 修复验证）」。

| 项目 | 内容 |
|------|------|
| 任务编号 | t100468 |
| 被测分支 | `feat/task-6-log-retention` |
| 基线 commit | `2130cbf`（工作区含本次未提交改动） |
| 被测目录 | `/Users/reachlucifer/project/opc/worktrees/dsh-finance-feat-task-6-log-retention` |
| 执行节点 | Reach的MacBook Pro（macOS，Node v25.6.0 / pnpm 11.7.0 / vitest 3.2.7） |
| 独立 spec | `tests/tester-t100468-log-governance.INDEPENDENT.spec.ts`（初轮 57 用例 → 复验轮 62 用例） |
| 执行时间 | 初轮 2026-10-17 12:20–12:22 / 复验轮 2026-10-17 12:24 (GMT+8) |
| 技术方案 | wiki `H08SwfqcsiNZ2kkxt5bcjdp4nub` §5 日志治理 |

## 一、结论摘要

**判定：❌ 不通过（1 个验收阻断缺陷）**

- ✅ 保留策略（30 天 / 按天 / mtime / 不跟随链接 / 降级）、500 MB 常量、按天与同日滚动、权限、环境变量、`tsc`、Developer 单测均通过。
- ❌ **D1（阻断）**：`redact()` 的 **Map 分支绕过全部键级脱敏**——`Map` 中的 `symbol` 不遮蔽、`token/password/cost` 明文输出，且该路径经 exporter 可**真实落盘**（端到端已复现）。
- ⚠️ D2（低）：`FileExporterOptions.now` 文档称用于「过期边界」，实现只用于跨天门控，截止线仍取真实 `Date.now`。
- ⚠️ R1（低，已知风险）：`taxonomy`（含 `tax`）、`feedback`（含 `fee`）等对象键因子串匹配被误伤为 `[REDACTED]`；文本级同名词却因词边界不误伤，两级口径不一致。

独立 spec 结果：**57 用例，54 通过 / 3 失败**（3 个失败同源于 D1）。

## 二、验收标准 1–3

| # | 验收项 | 结论 | 证据 |
|---|--------|------|------|
| 1 | 脱敏覆盖金额 / 标的代码等敏感字段，并有单测锁定 | ⚠️ 基本通过，Map 输入有缺口 | 普通对象/数组：金额 14 键全部 `[REDACTED]`，symbol 六口径全部命中；`tests/redact.test.ts` 42 例全绿。Map 输入见 D1 |
| 2 | 按天切割；单文件超 500 MB 滚动；超 30 天清理 | ✅ 通过 | `DEFAULT_LOG_MAX_SIZE=524288000`；注入 200B 得到 `2026-10-12.jsonl` / `-1` / `-2`；跨天生成新日期文件；40/31 天前删除、29 天前保留、今日保留 |
| 3 | `tsc --noEmit` EXIT=0；相关日志测试通过 | ✅ 通过 | `TSC_EXIT=0`；`log-retention.spec.ts + redact.test.ts + file-exporter.test.ts` → **79 passed / 3 files** |

## 三、额外必测项 4–13

| # | 项目 | 结论 | 关键证据 |
|---|------|------|----------|
| 4 | symbol 脱敏口径（含嵌套对象/数组/Map） | ❌ **部分失败（D1）** | `002156→00**56`、`588000→58**00`、`600519→60**19`、`AAPL→****`、`1→*`、`''→''` 全对；嵌套对象/数组、Map 值内对象均生效；**Map 直接键值对不生效**（`Map([['symbol','002156']])` → `002156`） |
| 5 | 防误伤 `code/errorCode/statusCode/httpCode` | ✅ 通过 | 结构化四键原值保留；文本级 `code=002156`、`errorCode=E1001 statusCode=404` 不变 |
| 6 | 金额键扩展 14 项 | ✅ 通过（附风险 R1） | `fee/commission/tax/stampDuty/transferFee/unrealized/realized/drawdown/turnover/principal/capital/invested/marketCap/initialCapital` 全部 `[REDACTED]`（`initialCapital` 由 `capital` 子串覆盖）；`taxonomy`/`feedback` **确认被误伤**，详见 R1 |
| 7 | 文本级脱敏 | ✅ 通过 | `symbol=002156→symbol=00**56`；`{"ticker":"AAPL"}→{"ticker":"****"}`；`token=abc123→token=[REDACTED]`；`?symbol=002156&x=1→?symbol=00**56&x=1`；一行多键与 Bearer/sk-/ghp_ 均正确 |
| 8 | 轮转 | ✅ 通过 | `maxSize=200` 同日 3 条 → 基础 / `-1` / `-2` 三文件，每文件 ≥200B 且逐行合法 JSON；`message.ts` 跨天 → 新文件且不串写 |
| 9 | 保留清理 | ✅ 通过 | `2026-08-01.jsonl`、`2026-08-01-2.jsonl`、整 40 天前 `2026-09-02.jsonl` 删除；今日保留；29/31 天边界正确；`tasks/t1/old.log` 按 mtime 删、新文件留、`.txt` 不动；目录/文件符号链接/目录链接均不删且不计 `scanned`；`scanned=4, deleted=3` 等计数准确 |
| 10 | exporter 集成 | ⚠️ 通过（附 D2） | 创建时清理一次；同日多次 `export()` 不重复；跨天首次写盘触发；只读子目录删除失败 `degraded=true` 且不影响写盘；另发现 Map 经 args 嵌套落盘时明文泄露（D1 端到端） |
| 11 | 常量与环境变量 | ✅ 通过 | `DEFAULT_LOG_MAX_SIZE === 500*1024*1024`；`DEFAULT_LOG_RETENTION_DAYS === 30`；`DSH_IA_LOG_RETENTION_DAYS=7 → 7`；`0/-5/NaN/空/空白/abc` 全部回落 30；显式 > env > 默认；小数向下取整 |
| 12 | 权限不变 | ✅ 通过 | 预置 0755 目录经 exporter 后 `0700`；新文件 `0600`；预置 0644 文件被 chmod 兜底为 `0600` |
| 13 | 不触碰真实 `~/.dsh-ia/logs` | ✅ 通过 | 全部用例 `mkdtempSync(join(tmpdir(),...))`；测试前后 `~/.dsh-ia/logs` 均 **ABSENT**（未被创建） |

## 四、缺陷与风险明细

### D1（阻断 / 中）：Map 分支绕过键级脱敏，敏感信息可明文落盘

- **位置**：`src/log/redact.ts` → `walk()` 的 `obj instanceof Map` 分支（仅 `mapped[String(k)] = walk(v)`，未对 `k` 做 `isSensitiveKey/isAmountKey/isSymbolKey` 判定）。
- **复现步骤**：
  1. `redact(new Map([['symbol','002156']]))` → 期望 `{symbol:'00**56'}`，实际 `{symbol:'002156'}`。
  2. `redact(new Map([['token','sk-secret-value'],['password','hunter2'],['cost',123.45]]))` → 实际 `{token:'sk-secret-value', password:'hunter2', cost:123.45}`，全部明文。
  3. 端到端：`createFileExporter({dir}).export({type:'info', args:['payload', {extra: new Map([['token','sk-secret-value']])}]})` → 落盘行实际为
     `{"ts":...,"msg":"payload","args":{"extra":{"token":"sk-secret-value"}}}`。
- **期望**：键级口径（敏感/金额 → `[REDACTED]`，symbol → 可读遮蔽）对 Map 键同样生效（AC4 明确要求「Map 内同样生效」；脱敏应为 fail-closed）。
- **实际**：Map 内所有键级规则失效，token/密码/金额/标的代码均原样输出；嵌套在普通对象里的 Map 可经 exporter 写入磁盘。
- **影响**：违反 AC4；使 M5「写盘前无明文凭证/金额」的保证在 Map 输入下失效（潜在敏感信息泄露）。当前 `src` 内 5 处 logger 调用未见传 Map，故现网触发面有限，但 `redact()` 是对外导出的公共能力，属契约级漏洞。
- **建议**：Map 分支复用 `walkObject` 同款键级判定（或先转 `Record` 再走 `walkObject`），并补 Developer 单测。

### D2（低）：`now` 注入未作用于过期截止线

- **位置**：`src/log/file-exporter.ts` → `maybeCleanupExpiredLogs()` 调用 `cleanupExpiredLogs({dir, retentionDays})`，未透传 `now`；`cleanupExpiredLogs` 内部回落 `Date.now()`。
- **复现**：注入 `now = Date.now()+400d`，目录内放「2 天前」日期文件 → 若按注入时钟应过期删除，实际保留。
- **影响**：仅影响测试注入语义（文档写明用于「过期边界」），生产不注入 `now`，无实际行为偏差。
- **建议**：`cleanupExpiredLogs({..., now: this.now()})`，并补一条边界断言。

### R1（低，已知风险）：`taxonomy` / `feedback` 被结构性误伤

- 结构化键按归一化子串命中：`taxonomy` 含 `tax`、`feedback` 含 `fee` → 值被替换 `[REDACTED]`（已实测确认）。
- 同一名词在**文本级**因 `tax|fee` 带词边界而不误伤：`redactText('taxonomy=tech feedback=good')` 原样保留。两级口径不一致。
- 方向为「过度遮蔽」（fail-closed），不构成泄露；损失的是排障可读性。建议将 `tax/fee` 改为整词匹配（与文本级对齐），或在 README 明确该已知行为。

## 五、用例明细（57）

| 分组 | 用例数 | 结果 |
|------|--------|------|
| AC11 常量与环境变量 | 5 | ✅ 5 |
| AC4 symbol 口径 | 9 | ❌ 7 ✅ / 2 ❌（Map 直接键、Map 敏感/金额） |
| AC5 防误伤 code 类 | 2 | ✅ 2 |
| AC6 金额键扩展 | 18 | ✅ 18 |
| AC7 文本级 | 6 | ✅ 6 |
| AC2/AC8 按天与滚动 | 2 | ✅ 2 |
| AC9 保留清理 | 6 | ✅ 6 |
| AC10 exporter 集成 | 6 | ❌ 5 ✅ / 1 ❌（Map args 落盘泄露） |
| AC12 权限 | 2 | ✅ 2 |
| AC13 tmp 隔离 | 1 | ✅ 1 |
| **合计** | **57** | **54 通过 / 3 失败** |

失败用例：
1. `AC4 > Map 的直接键值对（key=symbol）同样生效` — `expected '002156' to be '00**56'`
2. `AC4 > Map 的直接键值对同样适用敏感 / 金额口径（不得明文落盘）` — 四键全部明文
3. `AC10 > Map 作为 args 嵌套值经 exporter 落盘：敏感键不得明文（端到端）` — 落盘含 `sk-secret-value`

## 六、执行命令与关键输出

```bash
# 1) 类型检查
npx tsc -p tsconfig.json --noEmit
# → TSC_EXIT=0

# 2) Developer 相关日志测试（定向，非全量）
npx vitest run tests/log-retention.spec.ts tests/redact.test.ts tests/file-exporter.test.ts
# → Test Files 3 passed (3) / Tests 79 passed (79)

# 3) 独立验收 spec
npx vitest run tests/tester-t100468-log-governance.INDEPENDENT.spec.ts
# → Test Files 1 failed (1) / Tests 3 failed | 54 passed (57)

# 4) 真实日志目录隔离自证（测试前后）
ls -la ~/.dsh-ia/logs   # → ABSENT（未被创建）
```

## 七、测试纪律自证

- 未运行全量 `pnpm test`，仅执行上述 4 个定向文件。
- 未修改被测源码，未修改 Developer 的测试文件；仅新增本 spec 与本报告。
- 未执行 `git add / commit / push`。
- 所有 fs 用例均在 `mkdtempSync(join(tmpdir(), ...))` 下，显式传 `dir`，未触碰真实 `~/.dsh-ia/logs`。
- 已知基线噪声（`prompt-skills`、trace/scheduler 风险声明、advisor 工作流计数）未涉及，不影响本报告结论。

## 八、复现

```bash
cd /Users/reachlucifer/project/opc/worktrees/dsh-finance-feat-task-6-log-retention
npx vitest run tests/tester-t100468-log-governance.INDEPENDENT.spec.ts --reporter=verbose
```

---

# 复验轮（D1 / D2 修复验证）

| 项目 | 内容 |
|------|------|
| 复验时间 | 2026-10-17 12:24 (GMT+8) |
| 被测目录 | 同上（`dsh-finance-feat-task-6-log-retention`） |
| 基线 commit | `2130cbf`（工作区含 Developer 未提交修复） |
| 本轮改动 | 仅修正本 spec 中 1 条过时断言 + 追加 D1 定向用例；未改 `src/**` 与 Developer 测试 |

## 九、复验结论

**判定：✅ 通过（无阻断缺陷）**

- D1（Map 分支绕过键级脱敏）：**已修复**，五类场景全部为真实执行结果（非只读代码）。
- D2（`now` 仅控跨天门控）：**已修复**，注入时钟同时移动清理截止线。
- 原「⚠️ 观察：now 注入仅控跨天门控」用例已按新契约改写，原断言失效是预期的行为变更。
- R1（`taxonomy` / `feedback` 过度遮蔽）：**保持现状**，复验确认仍为 `[REDACTED]`，按 fail-closed 记录，不判失败。

### 9.1 D1 逐条复验（真实行为）

| # | 场景 | 期望 | 实测 | 结果 |
|---|------|------|------|------|
| 1 | `redact(new Map([['symbol','002156']]))` | `{ symbol: '00**56' }` | 同期望 | ✅ |
| 2 | `redact(new Map([['token','sk-abcdef1234567890']]))` | `{ token: '[REDACTED]' }` | 同期望 | ✅ |
| 3 | `redact(new Map([['cost',123]]))` | `{ cost: '[REDACTED]' }` | 同期望 | ✅ |
| 4 | 嵌套 `Map -> 对象 -> Map`（内层 symbol/token） | `{ outer: { inner: { symbol:'00**56', token:'[REDACTED]' } } }` | 同期望 | ✅ |
| 5 | 端到端 `redactRecord({ args: new Map([['symbol','002156'],['token','sk-…'],['cost',123]]) })` | 无明文 `002156` / `sk-…`，金额遮蔽 | `args = { symbol:'00**56', token:'[REDACTED]', cost:'[REDACTED]' }` | ✅ |
| 6 | `maxEntries` 对 Map 仍生效（3 键 / `maxEntries:2`） | 仅前 2 键 | `['symbol','token']` | ✅ |

补充：原 AC4 两条 Map 用例（直接键 symbol、敏感/金额）与 AC10「Map 作为 args 嵌套值经 exporter 落盘」用例本轮均转绿，端到端落盘不再含 `sk-secret-value`。

### 9.2 D2 复验（真实行为）

- 场景：目录内置两个日期文件——`真实时间 - 2 天`（窗口外）与 `真实时间 + 20 天`（窗口内）；`createFileExporter({ retentionDays: 30, now: () => Date.now() + 40 天 })`。
- 期望截止线：`Date.now() + 40d - 30d = Date.now() + 10d`。
- 实测：创建 exporter 时窗口外文件**被删除**、窗口内文件**保留**。✅
- 结论：`maybeCleanupExpiredLogs()` 单次取 `this.now()` 并同时用于日期门控与 `cleanupExpiredLogs({ now })`，注入时钟语义一致。

### 9.3 R1 回归（记录不判失败）

- `redact({ taxonomy:'tech', feedback:'good' })` → `{ taxonomy:'[REDACTED]', feedback:'[REDACTED]' }`，仍为过度遮蔽；
- 文本级 `redactText('taxonomy=tech feedback=good')` 仍原样保留；两级口径差异保持；
- 方向为 fail-closed（不泄露），符合本轮「保持现状 + 注释说明」的处置。

### 9.4 全套用例统计

`npx vitest run tests/tester-t100468-log-governance.INDEPENDENT.spec.ts` → **62 passed / 0 failed**（1 file）。

| 分组 | 用例数 | 结果 |
|------|--------|------|
| AC11 常量与环境变量 | 5 | ✅ 5 |
| AC4 symbol 口径 | 9 | ✅ 9 |
| 复验 D1：Map 键级脱敏 | 5 | ✅ 5 |
| AC5 防误伤 code 类 | 2 | ✅ 2 |
| AC6 金额键扩展 | 18 | ✅ 18 |
| AC7 文本级 | 6 | ✅ 6 |
| AC2/AC8 按天与滚动 | 2 | ✅ 2 |
| AC9 保留清理 | 6 | ✅ 6 |
| AC10 exporter 集成（含改写后的 now 用例） | 6 | ✅ 6 |
| AC12 权限 | 2 | ✅ 2 |
| AC13 tmp 隔离 | 1 | ✅ 1 |
| **合计** | **62** | **62 通过 / 0 失败** |

回归（定向，非全量）：`npx vitest run tests/log-retention.spec.ts tests/redact.test.ts tests/file-exporter.test.ts` → **85 passed / 3 files**；`npx tsc -p tsconfig.json --noEmit` → **EXIT=0**。

### 9.5 剩余问题分级

| 编号 | 级别 | 状态 | 说明 |
|------|------|------|------|
| D1 | 阻断 | ✅ 已关闭 | 五类 Map 场景 + 端到端全部通过 |
| D2 | 低 | ✅ 已关闭 | 统一时间源生效 |
| R1 | 低（已知风险） | ⚠️ 保留 | `taxonomy` / `feedback` 过度遮蔽，fail-closed，不泄露 |

**是否仍有阻断缺陷：否。**

### 9.6 复验轮隔离自证

- 仅运行定向文件，未运行全量 `pnpm test`；
- 全部用例仍在 `mkdtempSync` 下，测试前后 `~/.dsh-ia/logs` 均为 `No such file or directory`；
- 未修改 `src/**` 与 Developer 测试文件，未执行 `git add / commit / push`。
