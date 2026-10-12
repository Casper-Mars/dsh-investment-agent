# 测试报告 · t100434 —— 日志优化任务-1（M1「统一门面」）

- **被测交付物**：`dsh-finance` 插件（宿主机 Mac，`/Users/reachlucifer/project/opc/dsh-finance`）
- **基线提交**：`7a7cb97`（工作区改动，**未 commit / 未 push**）
- **测试文件**：`tests/tester-t100434-logger.INDEPENDENT.spec.ts`（24 用例）
- **测试时间**：2026-10-12
- **测试者**：Tester（独立复验，未复用 Developer 的 `tests/logger.test.ts`）

---

## ✅ 结论先行：**全部通过（PASS）**

8 项验收标准 **逐条通过**，无失败项。全量三命令 `typecheck` / `build` / `test` 均 **EXIT=0**，业务零回归。

| # | 验收标准 | 结论 | 主要证据 |
|---|----------|------|----------|
| 1 | 门面契约（四级 + child + meta + 取原生） | ✅ 通过 | AC1a–c |
| 2 | 真实 ctx 下确走原生出口（关键） | ✅ 通过 | AC2a–d（真实 `Context` + 自定义 Exporter） |
| 3 | child / meta 合并 | ✅ 通过 | AC3a–d |
| 4 | level 过滤（含 native 不二次过滤核对） | ✅ 通过 | AC4a–d |
| 5 | 全仓无散乱 console | ✅ 通过 | AC5a–b |
| 6 | inject 契约不变 | ✅ 通过 | AC6a–b |
| 7 | 装配不回归 | ✅ 通过 | AC7a–c |
| 8 | 全量回归三命令 | ✅ 通过 | 见「全量回归」 |

---

## 1. 逐条验收点结论与证据

### AC1 门面契约（`src/log/logger.ts`）✅

- **AC1a**：`createFinanceLogger` 实例暴露 `error/warn/info/debug` 四级 + `child(scope)`；`child()` 返回门面（同样具备四级 + `child`）。
- **AC1b**：源码导出契约齐全（`createFinanceLogger` / `createLogger` / `createLogFunction` / `createLeveledLogFunction` / `FinanceLogger` / `LOG_LEVEL_ENV` / `DEFAULT_LOG_LEVEL`）。
- **AC1c**：真实 `new Context()` 的 `ctx.logger` 为**可调用函数**且具四级方法（结构判据满足，与 `cordis/src/logger.ts` 的 `LoggerService` 一致）。

### AC2 真实 ctx 下确走原生出口（关键）✅

用**真实 cordis `Context`**（自带 `ctx.logger` `LoggerService`）+ 注册**自定义 `Exporter`**（`levels.default=3` 放行全级）捕获结构化 `Message`，并用 `console` spy 区分两条路径：

- **AC2a**：`logger.info('加载完成', { part:'plugin' })` → exporter 收到 1 条，`message.name === 'dsh-finance'`、`type === 'info'`、`args = ['加载完成', { part:'plugin' }]`；**console 三级 spy 全未被调用**（证明是 native 出口，非 console 兜底）。
- **AC2b**：四级全部经 native 出口（`type` 逐级 `error/warn/info/debug`，`name` 恒为 `dsh-finance`），console 未被触碰。
- **AC2c（反例）**：同一真实 ctx 注册 exporter，但门面显式**不传 native**（模拟 `ctx.logger` 缺失）→ `console.log`/`console.error` 被调用，且该 exporter **收到 0 条**（反证降级路径不产 native 消息）。
- **AC2d（反例）**：native 形态非法（`{not:'a logger'}` 普通对象、`()=>{}` 纯函数缺四级）→ 同样降级 console，exporter 0 条。

> 两条路径被 spy/mock 明确区分：native 命中 → exporter 有输出、console 静默；降级命中 → console 有输出、exporter 静默。

### AC3 child / meta ✅

- **AC3a**：`child('tools')` → `name='dsh-finance:tools'`；`child('tools').child('registry')` → `'dsh-finance:tools:registry'`（`:` 逐级追加，真实 ctx 观测）。
- **AC3b**：根无 scope 时 `child('scheduler')` → `'scheduler'`（无前导 `:`）。
- **AC3c**：base `{a:1,b:1}` ⊕ 调用级 `{b:2,c:3}` → `{a:1,b:2,c:3}`（**调用级优先**）；`child()` 派生仍共享 base meta（`{a:1,b:1,extra:9}`）。
- **AC3d**：无任何 meta 时 `args` 仅含消息（不注入空对象）。

### AC4 level 过滤 ✅

- **AC4a**：降级路径 `DSH_FINANCE_LOG_LEVEL=error` → `error` 输出（console.error×1）、`warn/info/debug` **全部抑制**。
- **AC4b**：默认 `info` → 放行 `error/warn/info`，**抑制 `debug`**（console.log 仅 1 次）。
- **AC4c**：`resolveLogLevel` 优先级 **显式 > env > 默认**，非法值（`bogus`）回落默认。
- **AC4d（关键核对·如实说明）**：**native 可用时门面不做二次过滤** —— 门面阈值设为最严 `error` 时，`debug/info/warn/error` 四级**仍全部到达 native exporter**（由 native 自身 level 决定；本例自定义 exporter 放行全级）。这与设计要点一致：门面在 native 路径只「换出口」，过滤交给 native。

### AC5 全仓无散乱 console ✅

- **AC5a**：遍历 `src/**/*.ts`（剥离块注释与整行 `//` 注释后）匹配 `console.` —— **除 `src/log/logger.ts`（门面内部唯一兜底出口）外 0 命中**；其余 `console` 字样全部位于注释中（`src/scheduler/runner.ts`、`src/log/logger.ts` 顶部说明）。
- **AC5b**：`src/scheduler/index.ts` **手写 `level→console` switch 已消失**（该文件无任何 `console.`），默认出口改为 `createLeveledLogFunction('dsh-finance:scheduler', ctx.logger)`。

### AC6 inject 契约不变 ✅

- **AC6a**：运行时 `plugin.inject === ['tools','skills','fs']`；`plugin.name === 'investment-advisor'`。
- **AC6b**：源码字面量仍为 `inject: string[] = ['tools', 'skills', 'fs']`；且**有意保留** `applyScheduler(ctx)` 字面调用（兼容既有规约 `tester-task9-scheduler-index` L283 的硬断言，属已知约束，不算缺陷）。

### AC7 装配不回归 ✅

- **AC7a**：`tools/skills/agents/logger` **均缺失**的最小 mock ctx 下 `apply(ctx)` 不抛异常，且加载日志/「tools·skills 不可用」告警经门面**降级 console** 输出（`console.log`/`console.warn` 均被调用）。
- **AC7b**：`applyScheduler(ctx, {dataRoot})` **不传 `options.logger`** 时默认走门面 —— 搭配**真实 native ctx** 验证：exporter 收到 `name='dsh-finance:scheduler'` 的 warn（「tools 服务不可用」），即默认出口确为门面。
- **AC7c**：**真实 native ctx 驱动 `apply`** —— `name='dsh-finance'` 的加载日志经 native exporter 收到（含「插件加载」文案），`console.error` 未被调用。

### 附加：既有注入位适配器（native 透传）✅

- `createLogFunction('dsh-finance:notice', ctx.logger)` → info 级、经 native 出口。
- `createLeveledLogFunction('dsh-finance:scheduler', ctx.logger)` → `error/warn/info` 逐级映射 native 四级，`name` 一致。

---

## 2. 全量回归（三命令）

| 命令 | EXIT | 结果 |
|------|------|------|
| `pnpm typecheck` | **0** | 通过 |
| `pnpm build` | **0** | 通过（11 个资源文件搬运到 dist-server） |
| `pnpm test` | **0** | **58 文件 / 1101 用例 全通过** |

- **基线（未加本测试文件）**：`57 文件 / 1077 用例`，EXIT=0。
- **加入本测试文件后**：`58 文件 / 1101 用例`（+1 文件 +24 用例），EXIT=0 → **业务零回归**，无超时（本次运行无 vitest 残留进程争用）。
- 受影响既有规约均保持全绿：`tests/tester-task9-scheduler-index.INDEPENDENT.spec.ts`、`tests/tester-t100419-skill-provider.INDEPENDENT.spec.ts`、`tests/plugin-tools-registration.spec.ts` 等（见全量输出）。

---

## 3. 覆盖率

仓库**未配置覆盖率 provider**（无 `@vitest/coverage-*`、`vitest.config.ts` 无 `coverage` 配置），故不产出自动覆盖率数字。改为对 `src/log/logger.ts` 做**人工分支清单核对**（本测试 24 用例覆盖如下分支）：

| 分支/路径 | 覆盖用例 |
|-----------|----------|
| `isNativeLoggerService` → true（合法原生服务） | AC2a/b、AC3*、附加适配器 |
| `isNativeLoggerService` → false（非函数对象） | AC2d |
| `isNativeLoggerService` → false（函数缺四级） | AC2d |
| `native === undefined`（降级） | AC2c、AC4a/b、AC7a、适配器（无 native） |
| `resolveLogLevel`：显式合法 / 显式非法 / env 合法 / env 非法 / 缺失 | AC4c、AC4a |
| `mergeMeta`：base-only / extra-only / both / neither | AC3c、AC3d |
| `hasEntries`：true / false | AC3c（true）、AC3d（false） |
| `emit` native 分支：带 meta / 不带 meta | AC2a、AC2b |
| `emit` 降级分支：阈值放行 / 阈值拦截 | AC4a（error 放行、其余拦截）、AC4b |
| `child`：有 scope 追加 / 根空 scope | AC3a、AC3b |
| `bound()` 命名 logger 懒解析缓存 | 多次调用同 scope（AC2b 等） |
| 四级分派 + 适配器 level 映射 | AC2b、附加适配器 |

> 结论：门面公共 API 与其内部分支在本次用例集下**均被触达**（含 3 条反例路径）。

---

## 4. 观察项（如实记录，非失败）

1. **模块级 `createLogger(...)` 走降级 console（3 处）**：`src/prompts/index.ts`（`dsh-finance:prompt`）、`src/skills/provider.ts`（`dsh-finance:skills`）、`src/tools/context.ts`（`dsh-finance:strategy`）以**模块级**调用创建门面，**无 ctx 注入位** → 运行时恒走门面**降级（console）**。
   - 影响评估：这 3 处**未接入 native 出口**，因此 M1「统一出口」目标在这 3 条路径上**只是统一到门面，而非统一到 dsh 原生 logger**。功能与格式无碍（仍单一出口、仍可被 `DSH_FINANCE_LOG_LEVEL` 过滤），但若 M1 的目标含「全量经 native exporter 落盘/采集」，则这 3 处构成**后续里程碑待补齐项**。
   - 另：`src/opening-notice.ts` / `src/session-ensure.ts`（`ensurePinnedSession` 第 176 行）的**默认**适配器同样无 native（走降级）；但当经 `apply()` 装配时，`plugin.ts` 已显式注入 native 支撑的 logger（`logSession.info` / `logSkills.info`），故**装配路径**走 native。唯 `ensurePinnedSession` 若被**独立调用且不注入 logger**，则走降级 console。
2. **native 路径的级别过滤语义差异**：门面降级路径阈值序为 `error<warn<info<debug`；而 cordis 原生 `LoggerLevel` 序为 `ERROR=0, INFO=1, WARN=2, DEBUG=3`（warn 比 info「更低优先级」），且默认 `INFO` 级别下 native 自身会抑制 `warn/debug`。门面在 native 路径**不做过滤**（符合设计），故 native 下 warn 是否输出取决于 native 配置——属**既定行为**，非缺陷，仅提示对接时留意语义差异。
3. **AC7 中 mock ctx 缺 `plugin` 方法**引发的 `skill-filesystem provider 挂载失败（降级）` 异步告警（stderr）为**预期降级**，被门面捕获、不中断装载。

---

## 5. 未决 / 风险

- **无阻塞性未决项**。唯一需 Leader 决策的是观察项 1：M1 是否需要把 3 处模块级 `createLogger` 也接到 native（若要，需后续任务引入 ctx 注入位）。
- **风险（低）**：本测试未做真实落盘/exporter 采集端到端（属后续里程碑范围）；本轮只验证「出口统一 + native 委托 + 降级 + 装配不回归」。
- 本测试未 commit / 未 push，未改动 `src/**`。

---

## 6. 文件清单（本次新增，仅测试产物）

- `tests/tester-t100434-logger.INDEPENDENT.spec.ts`（新增，24 用例）
- `tests/tester-t100434-logger.INDEPENDENT.REPORT.md`（本报告）

> 未触碰生产代码；`scripts/jev-news-demo.*`、`src/log/`、`tests/logger.test.ts`、8 处 `src/*` 修改均为 Developer 既有工作区改动。
