# Task 6 测试报告：感知脚本执行层 + 自持调度（runner）

- 被测：`dsh-ia` 插件 `src/runner/**` + `src/plugin.ts`
- 任务：飞书任务 t100358
- 环境：宿主机 `/Users/reachlucifer/project/opc/dsh-ia`（node v25.9.0 / pnpm / vitest 3.2.7）
- 独立测试文件：`tests/tester-runner-task6.INDEPENDENT.spec.ts`（57 用例，独立编写，未复用 Developer 的 `tests/runner-*.test.ts`）
- 结论：**6/6 验收点通过**。仅 1 项非阻断测试基建缺陷（见风险点）。

---

## 基线复跑

| 命令 | 结果 |
|------|------|
| `pnpm typecheck`（src） | ✅ exit 0 |
| `npx vitest run --no-file-parallelism`（全量） | ✅ 19 files / **357 passed**（基线 300 + 新增 57） |
| `pnpm test`（默认并行） | ⚠️ 偶发 1 失败（见风险点，非 runner 相关） |

---

## 验收点逐条结论

### ✅ AC1 — sensor-runner 读 current 脚本 → 只读 bindings → `ctx.ptcRuntime.run({program, bindings, sandboxPolicy})`

证据（`[AC1/#7]`）：
- 调用 `senseRegistry.current()` 取版本 → `read('v002').code` 作 `program`（`current()` 仅返回 meta，不含 code，需 `read()` 回读——与 `SenseRegistry` 接口一致，正确）。
- mock 运行时调用序列断言为 `['resolve','run']`（先 resolve 后 run）。
- request 携带 `bindings` 三个命名空间 `['symbols','quote','ledger']`；`sandboxPolicy === {mode:'read-only', workspaceRoot:'/data/root'}`；`cwd === dataRoot`。

### ✅ AC2 — bindings 仅暴露 5 个只读方法，无任何写方法

证据（`[AC2/#4]`）：
- 命名空间恰为 `symbols / quote / ledger`。
- 方法名集合 **严格等于** `{symbols.list, quote.realtime, quote.intraday, quote.history, ledger.get}`（集合相等 + 长度相等，杜绝多余方法）。
- 逐命名空间核查：`symbols` 仅 `list`；`quote` 仅 `realtime/intraday/history`；`ledger` 仅 `get`；无 `trade/init/commit/...` 写方法。
- 每个命名空间对象仅有 `global/functions` 两键（无 `errorClass`、无额外成员）。
- 所有方法 `length <= 1`（单参数契约）；返回值均为无损 JSON。

### ✅ AC3 — shouldWake 真/假两路径

证据（`[AC3/#5]`、`[AC3/#6]`）：
- `shouldWake:true` → `outcome.kind==='woke'`，waker 被调用一次，payload 含 `symbol='588000' / summary='偏离均线 3.2%' / version='v002' / metrics`。
- `shouldWake:false` → `outcome.kind==='quiet'`，waker **未**被调用。
- 返回值非法（缺 `shouldWake`）→ `skipped`，不投递。

### ✅ AC4 — 原生 setTimeout 链式自调度，零第三方 cron

证据（`[AC4/AC9]`）：
- `package.json` 的 dependencies / devDependencies / peerDependencies **无** node-cron / node-schedule / croner / cron / cron-parser / bree / agenda / toad-scheduler 等（命令 `grep -iE "cron|schedule" package.json` 无输出）。
- `src/runner/*.ts` 导入清单不含任何 cron 类库。
- 调度布置的是数值型延迟毫秒（`setTimer(handler, delayMs)`），非 cron 表达式。
- 默认路径确为全局 `setTimeout`：未注入定时器的 `[AC5·2]/[AC6]` 用例在 `vi.useFakeTimers()` 下 `vi.getTimerCount()===1` 生效，证明走的是原生 `setTimeout`。

### ✅ AC5 — 时间窗判定（09:30-11:30 / 13:00-15:00 Asia/Shanghai）+ isTradingDay 挡板

证据（`[AC5·1]`、`[AC5·2]`、`[AC5·3]`）：
- 边界：09:29→非、09:30→窗口、11:30→窗口、11:31→非、12:59→非、13:00→窗口、15:00→窗口、15:01→非（`isPulseMinute` + `isInPulseWindow` 双路径）。
- `PULSE_WINDOWS === [[570,690],[780,900]]`，步长 5，时区锁 `Asia/Shanghai`（`UTC 01:29Z → 上海 09:29`）。
- `nextPulseInstant` 严格未来 + 5 分钟对齐；跨午休 `11:30/11:31/12:00/12:59 → 13:00`；跨日收盘后 `15:00/15:01 → 次日 09:30`，盘前 `08:00 → 当日 09:30`。
- `nextDailyInstant`：当日未到即当日（15:05 / 9:25），已过即次日。
- isTradingDay 挡板：`false` → 到点不触发 `onPulse`（且 `running` 仍为 true，链条不断）；`true` → 触发。复盘 15:05 同样受挡板约束。
- 调度层窗口过滤：`11:31` 启动 → 午休区间 0 次触发，`13:00` 触发 1 次；盘中 `09:31` 起每 5 分钟连续触发（575,580,...,600 共 6 次）。

### ✅ AC6 — apply 启动调度、stop() 清空所有 timer（无泄漏）

证据（`[AC6]`、`[AC6·集成]`）：
- `start()` 后有且仅有 1 个定时器；`stop()` → `vi.getTimerCount()===0`；二次 `stop()` 幂等（不抛、仍为 0）；推进 120 分钟无任何触发。
- 重复 `start()` 不叠加定时器（仍 1 个）。
- 注入 `setTimer/clearTimer` 计数：start 后 pending 计数=1，stop 后=0，二次 stop 不再调用 `clearTimer`。
- 集成：`applyRunner(ctx, ...)` 后 `vi.getTimerCount()===1`；执行 `ctx.effect` 注销器（即 `scheduler.stop()`）后归 0 —— 对应「apply 即启动，fiber/进程退出自动清空」。
- `ptcRuntime` 软取失败 → 不启动调度、不抛异常。

---

## 任务书建议项 1–11 覆盖对照

| # | 建议验证项 | 覆盖用例 | 结果 |
|---|-----------|---------|------|
| 1 | 时间窗边界 + nextPulseInstant 跨午休/跨日 | `[AC5·1]`（12 用例） | ✅ |
| 2 | isTradingDay 挡板 | `[AC5·2]`（3 用例） | ✅ |
| 3 | stop 清 timer + 幂等 | `[AC6]`（3 用例） | ✅ |
| 4 | bindings 只读面严格相等 | `[AC2/#4]`（7 用例） | ✅ |
| 5 | sensor-runner 真/假两路径 | `[AC3/#5]`（3 用例） | ✅ |
| 6 | 错误路径（error 字段 / resolve 抛错 / 无 waker） | `[AC3/#6]`（5 用例） | ✅ |
| 7 | resolve→run 顺序 + read-only + cwd | `[AC1/#7]` | ✅ |
| 8 | 顶层 inject 严格相等 | `[AC8/#8]`（2 用例） | ✅ |
| 9 | 零第三方 cron | `[AC4/AC9]`（3 用例） | ✅ |
| 10 | 冷却（同 symbol 连续两次第二次 skipped） | `[#10]`（2 用例） | ✅ |
| 11 | 唤醒降级（无会话→0、告警、不抛） | `[#11]`（4 用例） | ✅ |
| 附加 | 复盘/盘前固定唤醒、唤醒消息结构、toJsonValue、parseSensorResult | 各用例 | ✅ |

---

## 缺陷与风险

### ⚠️ 风险点 1（非阻断，测试基建）：`copy-assets` 并发竞态导致 `pnpm test` 偶发失败

- **现象**：`pnpm test`（默认文件级并行）偶发 1 失败：`tests/prompt-skills.spec.ts` 或 `tests/tester-prompt-skills.INDEPENDENT.spec.ts` 中 `execFileSync('node', ['scripts/copy-assets.mjs'])` 报 `Error: Command failed`；而 `--no-file-parallelism` 串行运行 **357/357 稳定通过**。
- **根因（已复现定位）**：两个测试文件在同一时刻各自 `spawn node scripts/copy-assets.mjs`，Node `fs.cpSync` 内部先 `getStats(dest)` 再 `cpSyncOverrideFile`，两进程对同一 `dist-server/**` 目标文件竞态写入，抛 `EEXIST`（复现脚本 40 次并发中 28 次失败，栈指向 `node:internal/fs/cp/cp-sync:86`）。属脚本 `scripts/copy-assets.mjs` 用同步 `cpSync` 且被两个测试并发调用所致。
- **性质**：**非阻断**，与 Task 6（runner 层）交付物无关；不影响 runner 任一验收点。属既有测试基建问题（`prompt-skills.spec.ts` 早已存在，`tester-prompt-skills.INDEPENDENT.spec.ts` 为更早测试期新增）。
- **建议**：CI 用 `--no-file-parallelism`；或将 `copy-assets` 测试合并/串行（`describe.sequential`），或脚本改用幂等写入（`rmSync(dest,{force:true})` 后再 `cpSync`，或写入临时文件再原子 rename）。

### 说明（非缺陷）：AC1 措辞 vs 实现

需求写「读 `sense_registry.current()` 拿 code」。`SenseRegistry.current()` 实测仅返回 **meta**（不含 code），故实现用 `current()` 取 version、再 `read(version).code` 回读正文——与域接口设计一致，行为正确，不属于缺陷。

---

## 结论

- **通过**：AC1–AC6 全部 6 个验收点。
- **未通过**：无（功能层面）。
- **风险**：1 项非阻断测试基建竞态（copy-assets 并发），建议按上述方式整改，不影响本任务验收通过判定。
- 未改动 `src/**`，仅新增 `tests/tester-runner-task6.INDEPENDENT.spec.ts`。
