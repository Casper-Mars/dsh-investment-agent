# 测试报告 —— t100364 / §9.7 v1.6「开场 notice」修复（Task-15 AC1）

- 被测交付物：`/Users/reachlucifer/project/opc/dsh-finance`（`main`，HEAD `ed35231` + 未提交改动）
  - 新增 `src/opening-notice.ts`、改 `src/session.ts` / `src/session-ensure.ts` / `src/plugin.ts`
  - 新增/扩展 `tests/opening-notice.test.ts`、`tests/session-ensure.test.ts`
- 环境：宿主机 Mac（`Reach的MacBook Pro`）；harness `deepseek-harness` @ `0.2.0-rc.2`（`639ed01539`）
- 测试者：Tester（独立产出，未修改 `src/` 与既有测试）
- 独立测试文件：`tests/tester-task15-notice.INDEPENDENT.spec.ts`（20 用例，全绿）
- 结论：**AC1 未达成（阻断，根因：notice 消息 source 形态被 format v4 拒绝）；AC2 在真实宿主下随之失效；AC3/AC4/AC5 通过**

---

## 逐条验收结论

### AC1 会话脱离 blank 且左侧列表可见 —— ❌ 未通过（阻断）

**机制层（投递）✅ 正常**：`dsh web` 启动后，日志出现
```
[dsh-finance/session] 固定会话已持久化，resume 恢复：investment-advisor
[dsh-finance/notice] 已投递开场 notice（固定会话 investment-advisor）
```
说明「resume 分支 + 归属后补投 notice」链路确实触发，`deliverOpeningNotice` 未抛异常。

**但真实 turn ❌ 失败，会话未脱离 blank。** 浏览器打开 `dsh web` 打印的 URL 后，主面板出现：

```
处理失败
本轮运行失败format v4 message requires a producer-owned source kind
UNKNOWN
```

**会话文件复查 ❌ 仍为 blank（零事件、无 `turn/start`、无 notice 正文）**：
```bash
$ node -e 'const z=require("zlib"),fs=require("fs");...' \
    ~/.dsh/sessions/--Users-reachlucifer-project-opc-dsh-finance--/investment-advisor/session.v4.jsonl.zstd
total lines: 1        # 仅 session header
has turn/start: false
has opening notice text: false
# 文件仍为 378 字节，与测试前完全一致
```

**浏览器左侧会话树 ❌ 不见 `investment-advisor` 行**（DOM `innerText` 探测）：
```
工作区
dsh-finance
未命名          ← 固定会话（blank，因无 title 显示「未命名」，非「investment-advisor」）
10小时
dsh
```
`document.body.innerText.includes('investment-advisor')` → **false**；`includes('未命名')` → true。

**根因（本次发现的阻断缺陷，属 dsh-finance `src/` 实现 bug，非 harness）**：
- `src/opening-notice.ts` `buildOpeningNoticeMessage()` 复用了 `runner/wake.ts` 的 `WakeMessageSource`，构造的 notice 消息 source 为
  `{ kind: 'plugin', plugin: 'dsh-finance', form: 'notice', summary: '...' }`。
- harness **format v4 拒绝 `kind === 'plugin'`**（这是 v3 的「plugin 包装」形态，v4 已退役）：
  `packages/session/session-format-v3-to-v4/src/message-sources.ts:10`
  ```ts
  if (... || value['kind'] === 'plugin') {
    throw new SessionFormatError('format v4 message requires a producer-owned source kind')
  }
  ```
- 因此 `agent.followup(notice)` 触发的 turn 在把 `user/message`（notice）写入会话时被 codec 拒绝（`codec.ts` `assertV4RowAdmission` → `assertV4SourceRowAdmission`），turn 失败 → 会话不产生持久化的 `turn/start`/用户消息 → 仍 blank → 列表不可见。

> 修正方向（供 Leader 调度）：source.kind 应由 `'plugin'` 改为 producer-owned 形态 `'plugin:dsh-finance'`（并去掉 `plugin` 字段），或改用已注册的 producer kind（见 harness `sources.ts` `producerKind()`：未注册插件 → `plugin:<plugin>`）。

---

### AC2 一次性（重启不重复投递）—— ❌ 真实宿主下未达成（单位逻辑 ✅）

- **单位逻辑正确**：`isSessionBlank` / `deliverOpeningNotice` 判据为「会话是否 blank」而非 ensure 结局；非 blank → 返回 `not-blank` 不投（独立单测「重启自愈：第一次投递后第二次判读非 blank → 不重复投」✅）。
- **真实宿主失效**：由于 AC1 失败（turn 失败、会话始终 blank、notice 正文未落盘），**每次重启都会再次判读为 blank 并再次投递**。实测两次 `dsh web` 启动日志**均**出现 `[dsh-finance/notice] 已投递开场 notice`（`/tmp/tester-notice-web.log` 与 `/tmp/tester-notice-web2.log`）。「重启不再重复投递」在真实宿主下不成立，是 AC1 缺陷的直接后果。

---

### AC3 降级（不抛异常、不中断装载）—— ✅ 通过

- 独立单测覆盖：`agents` 不可达 / `agents.get` 抛错 / `followup` 抛错 / `sessionPersistence.open` 缺失 / 判读未知 → 一律 `skipped`、不抛异常、ensure 与归属照常（`applySessionEnsure` 接线层 + `deliverOpeningNotice` 纯函数层）。
- 真实宿主日志：notice 投递未抛异常、插件装载完成、ensure（resume）与 workspace 归属不受影响。AC3 的「降级」语义本身成立。

---

### AC4 顶层 inject 与 cordis.patch.yml —— ✅ 通过

- `src/plugin.ts` 顶层 `inject` 仍为 `['tools','skills','ptcRuntime','fs']`（独立单测断言 + 源码确认）。
- `cordis.patch.yml` 无改动（`git diff` 未含该文件；`inject` 四项与顶层一致，独立单测断言 `inject: ['tools', 'skills', 'ptcRuntime', 'fs']`）。

---

### AC5 typecheck / build / test —— ✅ 通过

- `pnpm typecheck` → **EXIT=0**
- `pnpm build` → **EXIT=0**（`dist-server/opening-notice.js` 已产出，含 notice 文案）
- `pnpm test` → **38 文件 / 618 用例全绿**（基线 37/598 + 本独立文件 20 用例）

---

## 缺陷清单

| # | 严重度 | 缺陷 | 根因（file:line） |
|---|--------|------|-------------------|
| 1 | **阻断** | AC1 未达成：开场 notice 消息 source `kind='plugin'` 被 format v4 拒绝，触发 turn 报「format v4 message requires a producer-owned source kind」，会话不产生 `turn/start`、脱离不了 blank → 左侧列表不可见 | `src/opening-notice.ts` `buildOpeningNoticeMessage()` 构造 `source: { kind:'plugin', plugin:'dsh-finance', form:'notice', summary }`（复用 `src/runner/wake.ts` `WakeMessageSource` 形态）；harness `packages/session/session-format-v3-to-v4/src/message-sources.ts:10` 拒绝 `kind==='plugin'` |
| 2 | 高（关联） | 同一 source 形态的唤醒消息也携带该隐患：`src/runner/wake.ts` `buildWakeMessage()` 用 `source.kind='plugin'`。scheduler 在交易日盘中脉冲投递时，同样会被 format v4 拒绝（本次测试在非市场时段，scheduler 未脉冲、未暴露） | `src/runner/wake.ts` `buildWakeMessage()`（source `kind:'plugin'`） |

**缺陷说明（供 Leader 调度）**：ensure/归属/降级/一次性判据逻辑（AC3/AC4/AC5 及 AC2 单位逻辑）全部正确，阻断点集中在「消息 source 形态与 harness format v4 不兼容」这一处实现问题。修正 notice（及 wake）的 source.kind 后，AC1/AC2 应能恢复。

---

## 环境清理

- 已停止本人启动的 `dsh web` 进程；`sleep 300` 残留进程已清理；端口 3080/3090 已释放（`lsof -iTCP:3080/3090 -sTCP:LISTEN` 为空）。
- 数据影响：固定会话文件 `investment-advisor/session.v4.jsonl.zstd` 测试前后**完全一致**（378 字节，1 行 header，零事件，`isSeeded:false`），未被污染。workspace.json 中 dsh-finance 工作区记录为上一轮既有结果，本轮未增删。

## 附录：独立测试覆盖映射

`tests/tester-task15-notice.INDEPENDENT.spec.ts`（20 用例）：
- AC1：`isSessionBlank` 判读优先级（投影软取 / open 事件日志 / stat 兜底 / 判读未知）；`deliverOpeningNotice` blank→恰投一次 + 消息结构等价
- AC2：非 blank→不投；重启自愈（第二次判读非 blank 不重复投）
- AC3：`agents.get` 抛错 / 不可达 / `followup` 抛错 / 判读未知 → skipped 不抛
- 接线盲区（Developer 未覆盖）：**resume 分支补投**（AC1 关键路径）；web 宿主 `sessionProjections` 软取命中→不 open；ensure skipped→不投不归属；`open` 缺失→降级但 ensure/归属照常
- AC4：顶层 inject 四项 + cordis.patch.yml 一致
