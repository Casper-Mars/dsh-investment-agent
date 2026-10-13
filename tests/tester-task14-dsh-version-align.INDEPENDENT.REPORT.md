# Task-14 复验报告：依赖版本对齐 0.1.6-alpha.1 → 0.2.0-rc.2

- 被测交付物：`/Users/reachlucifer/project/opc/dsh-ia`（main @ `8ab4571` + 未提交 `package.json` / `pnpm-lock.yaml`）
- 复验方式：真实构建产物 `dist-server/**` + 真实 `@deepseek-ai/dsh-tools@0.2.0-rc.2` + 真实 cordis 4.0.4 + 真实 `dsh` CLI 0.2.0-rc.2
- 独立测试文件：`tests/tester-task14-dsh-version-align.INDEPENDENT.spec.ts`（12 用例，全部通过）
- 执行环境：宿主机 Mac（`exec host=node`），Docker/宿主机路径一致

## 结论总览：6/6 验收标准全部 PASS ✅

| # | 验收标准 | 判定 |
|---|---------|------|
| 1 | 版本声明与解析一致（4 处 + lock 无残留） | ✅ PASS |
| 2 | `pnpm typecheck` / `pnpm build` EXIT=0 | ✅ PASS |
| 3 | `pnpm test` 全绿，≥ 基线 27/473 | ✅ PASS |
| 4 | 真实 dsh 装载（plugin add + dump-config 识别插件/inject） | ✅ PASS |
| 5 | 运行时装配（dist-server + 16 工具 + dispose + skills/人设） | ✅ PASS |
| 6 | 回归：0.2.0-rc.2 依赖下契约关键断言 | ✅ PASS |

---

## 1. 版本声明与解析一致 — PASS

**package.json（git diff 核实，4 处变更全部为 0.2.0-rc.2）**

```diff
   "peerDependencies": {
     "@deepseek-ai/cordis": ">=4.0.0",
-    "@deepseek-ai/dsh-skill": "0.1.6-alpha.1",
-    "@deepseek-ai/dsh-tools": "0.1.6-alpha.1"
+    "@deepseek-ai/dsh-skill": "0.2.0-rc.2",
+    "@deepseek-ai/dsh-tools": "0.2.0-rc.2"
   },
   ...
   "devDependencies": {
     "@deepseek-ai/cordis": ">=4.0.0",
-    "@deepseek-ai/dsh-skill": "0.1.6-alpha.1",
-    "@deepseek-ai/dsh-tools": "0.1.6-alpha.1",
+    "@deepseek-ai/dsh-skill": "0.2.0-rc.2",
+    "@deepseek-ai/dsh-tools": "0.2.0-rc.2",
```

- `@deepseek-ai/cordis` 保持 `>=4.0.0` 未动 ✅
- `node_modules` 实际解析版本：
  - `@deepseek-ai/dsh-skill` → **0.2.0-rc.2**
  - `@deepseek-ai/dsh-tools` → **0.2.0-rc.2**
  - `@deepseek-ai/cordis` → **4.0.4**（满足 >=4.0.0）
- `pnpm-lock.yaml`：`grep -c "0.1.6-alpha.1"` = **0**（无残留）；含 `@deepseek-ai/dsh-skill@0.2.0-rc.2`、`@deepseek-ai/dsh-tools@0.2.0-rc.2` 条目（共 138 处 0.2.0-rc.2 出现）

**证据（测试 A1–A3）**：`[EVIDENCE A2] resolved: dsh-skill=0.2.0-rc.2 dsh-tools=0.2.0-rc.2 cordis=4.0.4`

---

## 2. typecheck / build — PASS

```bash
$ pnpm typecheck   # TYPECHECK_EXIT=0
$ pnpm build       # BUILD_EXIT=0（tsc + copy-assets，11 个资源文件搬运到 dist-server）
```

`dist-server/index.js` 生成正常，`exports["."].default = ./dist-server/index.js` 入口导出 `{ name, apply, inject }`。

---

## 3. pnpm test 全绿 — PASS

基线（新增本测试前）：**27 文件 / 473 用例全绿**，与基线 `27 / 473` 一致。

```
 Test Files  27 passed (27)
      Tests  473 passed (473)
```

新增 Task-14 独立测试后全量：**28 文件 / 485 用例全绿**。

```
 Test Files  28 passed (28)
      Tests  485 passed (485)
```

---

## 4. 真实 dsh 装载（关键，独立复验） — PASS

- `dsh --version` → **0.2.0-rc.2**（bin：`/Users/reachlucifer/bin/dsh` → `deepseek-harness/apps/cli/lib/bin.js`）
- harness 源码包版本：`apps/cli`、`packages/skill/skill`、`packages/core/tools` 均为 **0.2.0-rc.2**
- profile `opc-finance-verify` 已 link 到本仓库（`dsh-ia: link:/Users/reachlucifer/project/opc/dsh-ia`）

```bash
$ dsh plugin --profile opc-finance-verify add .
✓ Lockfile passes supply-chain policies (verified 1d ago)
Already up to date
Done in 227ms using pnpm v11.7.0
# ADD_EXIT=0
```

```bash
$ dsh --profile opc-finance-verify --dump-config   # EXIT=0，识别插件：
# == dsh-ia
- id: dsh-ia
  name: dsh-ia
  inject:
    - tools
    - skills
    - ptcRuntime
    - fs
```

✅ 插件 `id=dsh-ia`、`inject=['tools','skills','ptcRuntime','fs']` 与契约一致。

> 观察（非缺陷）：profile `package.json` 实际依赖为绝对路径 link `link:/Users/reachlucifer/project/opc/dsh-ia`（任务描述写作相对路径 `../../../project/opc/dsh-ia`），二者均指向本仓库，语义等价，不影响复验结论。

---

## 5. 运行时装配（关键） — PASS

以真实 cordis `Context` + 真实 `@deepseek-ai/dsh-tools` ToolRuntime（0.2.0-rc.2）装载**真实构建产物 dist-server**：

- **apply 不抛异常**：`app.plugin(pluginNs)` 同步 apply 成功，无异常 ✅
- **16 工具逐一核对**：`ctx.tools.schemas()` 恰好 16 个，无重复，名称与分组契约完全一致：
  - ledgers(4)：`ledger_init, ledger_list, ledger_query, ledger_trade`
  - predicts(3)：`predict_make, predict_verify, predict_get`
  - reviews(5)：`review_check, review_report, review_get, review_metrics, review_retrospect`
  - sense_archives(4)：`sense_archive_commit, sense_archive_list, sense_archive_rollback, sense_archive_get`
- **dispose 注销**：`pluginFiber.dispose()` 后 `schemas()=0`，16 工具全部 `get()` 返回 undefined ✅
- **skills 4 个**：`trend-analysis, grid-strategy, stop-rule, sense-authorship`（顺序一致，description/content 非空）✅
- **人设 section**：`dsh-ia:advisor`（order=100，正文 1148 字符，含「金融」）✅

```
[EVIDENCE B2] ctx.tools.schemas() count=16 :: ledger_init, ledger_list, ledger_query, ledger_trade, predict_get, predict_make, predict_verify, review_check, review_get, review_metrics, review_report, review_retrospect, sense_archive_commit, sense_archive_get, sense_archive_list, sense_archive_rollback
[EVIDENCE B3] after pluginFiber.dispose(): schemas()=0, 16 工具全部注销
[EVIDENCE B4] skills registered=4 :: trend-analysis, grid-strategy, stop-rule, sense-authorship
[EVIDENCE B5] persona section name=dsh-ia:advisor order=100 textLen=1148
```

---

## 6. 回归 — PASS

**是否以 0.2.0-rc.2 依赖运行：是。** 测试内运行时读取 `node_modules/@deepseek-ai/dsh-tools/package.json` 确认 `0.2.0-rc.2`，ToolRuntime 即从此包装载（`[EVIDENCE A4] ToolRuntime 来自 @deepseek-ai/dsh-tools@0.2.0-rc.2 + cordis@4.0.4`）。

参考 `tester-task13-tools-registration.INDEPENDENT.spec.ts`，在 0.2.0-rc.2 依赖下复核调度契约关键常量（全部一致，无隐藏变化）：

- 盘中脉冲周期 `PULSE_STEP_SECONDS=30`；窗口 `[[570,690],[780,900]]`（9:30–11:30 / 13:00–15:00 含端点）✅
- 盘后复盘 `REVIEW_MINUTE=1110`（18:30）；盘前准备 `PREP_MINUTE=565`（9:25）✅
- 唤醒冷却 `DEFAULT_WAKE_COOLDOWN_MS=300000`（5min）；批处理上界 `DEFAULT_BATCH_LIMIT=20`；单次预算 `DEFAULT_SENSOR_TIMEOUT_MS=60000`；文本预算 `DEFAULT_WAKE_TEXT_BUDGET=2000` ✅

---

## 风险点 / 建议（无阻塞项）

1. **profile link 形态**：profile 依赖为绝对路径 link（非任务描述的相对路径），语义等价但若仓库迁移路径会失效，属环境配置层面，非本次变更缺陷。
2. **peerDependenciesMeta 仍标 optional**：`dsh-skill`/`dsh-tools` 的 peer 为 optional，devDependencies 承担实际安装；当前版本对齐正确，但若部署环境未显式安装 peer，插件运行时依赖（`defineTool`）可能缺失——建议部署侧确保 peer 显式安装或改为非 optional。
3. 本次复验未修改 `src/**` 与 `package.json`，仅在 `tests/` 下新增测试文件；未执行 git commit/push；测试数据使用临时目录（`mkdtempSync`），无真实数据污染。

---

**附：验收标准逐条证据索引**

- 验收 1 → 测试 A1/A2/A3 + `git diff package.json` + `grep` lock
- 验收 2 → `pnpm typecheck` / `pnpm build` 退出码 0
- 验收 3 → `pnpm test` 27/473 → 28/485
- 验收 4 → `dsh plugin add .` EXIT=0 + `dsh --dump-config` 输出 dsh-ia 段
- 验收 5 → 测试 B1/B2/B3/B4/B5
- 验收 6 → 测试 A4 + C1/C2/C3
