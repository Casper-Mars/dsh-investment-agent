# Task 8（t100357）端到端联调与验收报告

- **被测交付物**：dsh-finance 插件全链路（Task 1~7.1 已完成模块）
- **技术底座**：deepseek-harness（dsh）v0.1.6-alpha，pnpm
- **权威依据**：《详细设计 v1.3》+ 任务 t100357
- **测试角色**：Tester（只测试与报告，不改业务代码）
- **日期**：2026-09-30

---

## 一、测试概览

| 项 | 结果 |
|----|------|
| 基线全量测试 | ✅ 24 files / 436 tests 全部通过（新增本报告前基线为 23/430） |
| 新增 E2E 测试文件 | `tests/tester-task8-e2e.INDEPENDENT.spec.ts`（6 个 describe 用例，对应 6 条验收点） |
| 测试白盒/黑盒比例 | 真实 ToolRuntime registry 管线 + 真实 cordis apply + 真实 createSensorRunner/createScheduler/createAgentWaker/SenseRegistry/Ledger/Predicts/Reviews；仅 mock ptcRuntime / agents registry / QuoteClient 数据源 |

**测试方式**：
1. 真实 ToolRuntime registry 管线（16 个 defineTool 经 `registerAllTools` 注册，走 defineTool 完整校验/归一/物化链路，复用 tester-tools-runtime 的 `bootRegistry` 模式）。
2. 真实 runner 装配（`createSensorRunner` + `createAgentWaker` + `SenseRegistry` 磁盘落盘核实）。
3. 注入式 mock QuoteProvider 模拟「正常行情 / 断供降级 / 恢复」，验证降级链。
4. 磁盘证据核实（`sense_versions/current` 指针文件、ledger JSON 表）。

---

## 二、逐条验收点明细

### AC1 · 首轮 588000（etf）全链路闭环 —— ✅ PASS

**验证链路**：感知 → 研判 → ledger_trade（etf 走「份」、100 整数倍）→ sense_archive_commit 生成 v003 且 current 指针正确 → 盘后 review 三件套产出记录。

| 子项 | 结果 | 证据 |
|------|------|------|
| ledger_init 588000（etf） | ✅ | `ledger_init → { ok: true, symbol: '588000' }` |
| ledger_trade etf 走「份」/ 100 整数倍 | ✅ | `qty=500 buy → new_qty=1500`（份）；`qty=120`（非 100 整数倍）被拒绝 `isError` |
| 非 100 整数倍被拒绝 | ✅ | `[EVIDENCE AC1] 非 100 整数倍 qty=120 被拒绝（isError）` |
| sense_archive_commit 生成 v003 | ✅ | 预提交 v001/v002 后 commit → `version='v003'`、`is_current=true` |
| current 指针指向正确（磁盘核实） | ✅ | `readFileSync(sense_versions/current) === 'v003'` |
| 盘后三件套产出记录 | ✅ | `predict_verify(hit_dir=true,hit_range=true)` + `review_check` + `review_metrics` 均非 isError |
| 闭环起点（runner 读 v003） | ✅ | runner 构造后 `senseRegistry.current()?.version === 'v003'` |

**结论**：首轮 etf 全链路闭环贯通，交易单位、版本归档与指针均符合验收标准。

---

### AC2 · review_metrics 命中率/cum_return/history 口径 —— ⚠️ 部分 PASS / 部分 FAIL

#### 2.1 dir_hit_rate 口径（方向命中数/已校验数）—— ✅ PASS

- 造 3 个交易日复盘（2 命中 1 未命中），`review_metrics` 返回 `dir_hit_rate=0.6667=2/3`、`range_hit_rate=1=3/3`，符合「命中数/已校验数」。
- 证据：`[EVIDENCE AC2] dir_hit_rate=0.6667=2/3、range_hit_rate=1=3/3`

#### 2.2 history 保留最近 30 个交易日 —— ✅ PASS

- 注入 >30 条复盘，`review_metrics.history.length=30`（≤30，`takeRecentHistory` 截断生效）。
- 证据：`[EVIDENCE AC2] 注入 >30 条后 history.length=30`

#### 2.3 cum_return 口径 —— ❌ FAIL（未端到端落地）

验收标准要求：`cum_return = (期末市值 + 累计 realized - 期初资金) / 期初资金`。

但**实测发现该口径未落地**，存在两层问题：

1. **`cumReturn` 从未被调用**：`src/domain/metrics.ts` 导出的 `cumReturn(trades)` 与 `hitRate()` 为公开函数，但 `cumReturn` 在 `src/` 全量 `grep` 中**无任何调用点**（仅 `isBelowThreshold` 被 reviews.ts import）。
2. **`review_metrics` 恒返回 cum_return=0**：`src/domain/reviews.ts` 的 `review_metrics` 在 metrics 表无缓存时直接 `cumReturn: 0`（注释自述「累计收益需 ledger 流水，domain 层不主动算」），而 `record_metrics` 方法虽存在，但**无任何 tool/runner 调用它**，即没有「从 ledger trades 计算 cum_return 并回写」的接线。

**复现步骤**：
```text
1. ledger_init 588000（init_cash=50000, init_qty=1000, cost=2.00）
2. ledger_trade buy qty=100 price=2.10
3. predict_make + predict_verify + review_report（落复盘）
4. review_metrics 588000
   → 返回 cum_return = 0（期望为按 (期末市值+realized-期初资金)/期初资金 计算的非零值）
```

**次要问题**：即便 `metrics.cumReturn` 被接线，其当前实现口径为 `realized / totalBuyCost`（见 metrics.ts 注释「采用已实现收益/累计买入成本」），**与验收标准的 `(期末市值+累计realized-期初资金)/期初资金` 公式不一致**（缺期末持仓市值项、分母不是期初资金）。

**结论**：AC2 的 cum_return 子项 FAIL，dir_hit_rate 与 history 子项 PASS。

---

### AC3 · lib/quotes 降级：断供可用、不崩溃、切回恢复 —— ✅ PASS

| 场景 | 结果 | 证据 |
|------|------|------|
| 正常行情 | ✅ | `realtime → source='primary', status='trading'` |
| 主源断供 → 备用源接管 | ✅ | `primary throw → source='fallback'` |
| 双源断供 → 缓存降级 | ✅ | 两源 throw → `source='cache', status='trading'`（不崩溃） |
| 无缓存全断 → unavailable 占位 | ✅ | `status='unavailable', source='unavailable'`（`cacheEnabled=false` 下不抛未捕获异常） |
| 切回源恢复 | ✅ | `source='primary', status='trading'` |

**测试说明**：QuoteClient 的 `withRetry` 内部 `sleep` 用真实 `setTimeout`，fake timers 会挂起，故 AC3 用例内 `vi.useRealTimers()` + `retries=0` 规避退避延迟，其余 AC4 用 fake timers 验证调度/冷却。

---

### AC4 · 幂等：唤醒冷却生效，短时重复脉冲不重复唤醒 —— ✅ PASS

| 子项 | 结果 | 证据 |
|------|------|------|
| 首次脉冲唤醒 1 次 | ✅ | `runner.run('pulse') → kind='woke'`，`followup` 调用 1 次 |
| 冷却内（<5min）重复脉冲不重复唤醒 | ✅ | 第二次脉冲 → `kind='skipped'`，`detail` 含「冷却」，`followup` 仍为 1 次 |
| 冷却窗口过后（>5min）再次唤醒 | ✅ | `vi.setSystemTime(+6min)` 后 → `kind='woke'`，`followup` 第 2 次 |

**关键实现**：`DEFAULT_WAKE_COOLDOWN_MS=5*60_000`，`lastWakeAt` Map（key=`reason:symbol`）驱动 `inCooldown` 判定。

---

### AC5 · 多标的：批处理上界/单次 token 预算可控 + A/B 隔离 —— ✅ PASS

| 子项 | 结果 | 证据 |
|------|------|------|
| A(588000)、B(000001) 台账隔离 | ✅ | A.qty=1500、B.qty=600（独立） |
| 预判隔离 | ✅ | A 落预判后，`predict_get B → prediction=null` |
| 统计隔离 | ✅ | A 落复盘后，`review_metrics B → history.length=0` |
| 批处理上界（>20 标的截断） | ✅ | 构造 21 标的后 `runReview` 日志含「批处理标的超上界」 |
| 单次 token 预算 | ✅ | `DEFAULT_WAKE_TEXT_BUDGET=2000`，`boundPayload` 截断 summary/metrics（常量核实） |

**关键常量**：`DEFAULT_BATCH_LIMIT=20`、`DEFAULT_WAKE_TEXT_BUDGET=2000`（sensor-runner.ts）。

---

### AC6 · 合规：免责声明 + 仅模拟盘 —— ✅ PASS

| 子项 | 结果 | 证据 |
|------|------|------|
| 决策类输出末尾附声明 | ✅ | `ledger_trade` render 末尾含「本内容不构成投资建议」 |
| 唤醒消息正文末尾附声明 | ✅ | `buildWakeText` 输出含 `RISK_DISCLAIMER` |
| 仅模拟盘、无真实资金/券商 | ✅ | 源码核实：`ledger.ts` 仅依赖 `JsonStore` 本地落盘，无 broker/券商/下单/interact 引用 |

---

## 三、验收总结

| 验收点 | 结论 |
|--------|------|
| AC1 首轮 588000 全链路闭环 | ✅ PASS |
| AC2 dir_hit_rate / history 口径 | ✅ PASS |
| AC2 cum_return 口径 | ❌ FAIL（未端到端落地） |
| AC3 lib/quotes 降级 | ✅ PASS |
| AC4 唤醒冷却幂等 | ✅ PASS |
| AC5 多标的批处理/隔离 | ✅ PASS |
| AC6 合规 | ✅ PASS |

**总体结论**：6 条验收点中 5 条全量通过，AC2 的 cum_return 子项存在**未落地**缺陷。

---

## 四、缺陷明细（待 Leader 派 Developer 修复）

### Defect #1（严重）：cum_return 口径未端到端落地

- **现象**：`review_metrics` 的 `cum_return` 恒为 0（无 metrics 缓存时），验收标准要求的 `(期末市值+累计realized-期初资金)/期初资金` 口径未实现接线。
- **根因**：
  1. `src/domain/metrics.ts` 的 `cumReturn(trades)` 函数无任何调用点（`grep` 全量确认）；
  2. `src/domain/reviews.ts` 的 `review_metrics` 缺省 `cumReturn: 0`，`record_metrics` 方法无调用方，导致「从 ledger.getTrades 计算 cum_return 并回写 metrics 表」的链路缺失。
- **次要**：`metrics.cumReturn` 现有实现口径为 `realized/totalBuyCost`，与验收标准公式 `(期末市值+累计realized-期初资金)/期初资金` 不一致（缺期末持仓市值项、分母非期初资金）。
- **建议修复方向**（由 Developer 实施、非 Tester 职责）：
  1. 在 `review_metrics`（或新增接线点）读取 `ledger.getTrades(symbol)` + 期末持仓/价格，按验收公式计算 `cum_return = (期末市值 + 累计realized - 期初资金)/期初资金`；
  2. 通过 `record_metrics` 回写 metrics 表，使 `review_metrics` 返回非零值；
  3. 校准 `metrics.cumReturn` 实现或新增对照函数以匹配验收口径。

---

## 五、交付物

1. **测试文件**：`tests/tester-task8-e2e.INDEPENDENT.spec.ts`（6 个用例，对应 6 条验收点，含逐条 `[EVIDENCE ...]` 证据输出）。
2. **本报告**：`tests/tester-task8-e2e.INDEPENDENT.REPORT.md`。

**测试环境清理**：未启动中间件（纯本地 JSON + mock 运行时），无 docker compose 资源需清理。