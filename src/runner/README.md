# runner

感知脚本执行层 + 自持调度（详细设计 §6 / §8）。

## 模块

| 文件 | 职责 |
|------|------|
| `types.ts` | 与 harness 逐字对齐的**最小结构类型**（PTC / sandbox / 唤醒 / 结局），不引入对 `@deepseek-ai/dsh-ptc-runtime` 等的硬依赖 |
| `json.ts` | `toJsonValue`：领域对象 → 无损 JSON（binding 边界清洗） |
| `bindings.ts` | 组装**只读** bindings：`symbols.list` / `quote.realtime|intraday|history` / `ledger.get`（**无任何写方法**） |
| `sensor-runner.ts` | 读 `sense_registry.current()` → 组装 bindings → `ctx.ptcRuntime.run` → 解析 `shouldWake` → 投递唤醒（含冷却 / 降级） |
| `scheduler.ts` | 最小自持调度：原生 `setTimeout` 链式自调度、锁 `Asia/Shanghai`、交易日挡板、`stop()` 清 timer |
| `wake.ts` | 构造唤醒消息（`agent.followup`）+ 目标解析 + 降级 |
| `index.ts` | `applyRunner(ctx)`：装配并接入插件生命周期 |

## 执行链路（§6.2）

```
scheduler（盘中脉冲 5min / 复盘 15:05 / 盘前 9:25，Asia/Shanghai，交易日挡板）
  → sensor-runner: senseRegistry.current() → read(version).code
  → createSensorBindings（只读）
  → ptcRuntime.resolve(request) → ptcRuntime.run(spec)   // 先 resolve 再 run
  → 解析 result.value → { shouldWake, symbol, summary, metrics }
  → shouldWake=true（且非冷却）→ agent.followup(createUserMessage(...)) 投递该标的市场状态
  → false → 静默结束
```

## 关键契约（已核对 harness 源码）

- **`PtcBindingNamespace` 字段是 `functions`**（详细设计 §6.3 的 `members` 系笔误）。
- **`run` 必须先 `resolve`**：`ptc-runtime-node` 的 `run(spec)` 要求 spec 已含 `sandboxPolicy` / 绝对 `cwd` / 数值 `timeoutMs`，否则抛错。`error` 是 `PtcRunResult` 的**字段**，`run` 不 reject。
- **绑定成员是单参数函数**（`(args) => Promise<PtcJsonValue>`）：多值调用须由脚本打包为**单个对象/数组**，例如 `quote.history({ symbol, days })`；直接 `quote.history(sym, days)` 的第二个实参会被丢弃。
- **沙箱**：`{ mode: 'read-only', workspaceRoot: dataRoot }`，配合只读 bindings，脚本无法越权交易 / 破坏数据。
- **唤醒**：`ctx.get('agents')` 经 `ctx.inject(['agents'], cb)` 动态注入（顶层 inject 固定四项不变）；目标解析优先 `currentInitiator()` → `roots()` → `list()`；拿不到 agent 时**仅告警并跳过**，不中断调度。
- **调度**：零第三方 cron 依赖，仅原生 `setTimeout`；时区经 `Intl.DateTimeFormat(..., { timeZone:'Asia/Shanghai' })` 锁定；非交易日经 `TradingCalendar.isTradingDay` 跳过。

## 调用方式

插件在 `apply` 内自动调用 `applyRunner(ctx)`，无需显式启动；卸载时自动 `stop()`。
