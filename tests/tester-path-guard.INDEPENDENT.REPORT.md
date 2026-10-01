# 路径加固（path-guard）独立运行时验证报告

- **被测交付物**：`/Users/reachlucifer/project/opc/dsh-finance`（基线 `84a0c46` + 未提交改动）
- **测试者**：Tester（独立运行时验证）
- **日期**：2026-10-02
- **验证方式**：真实文件系统（`mkdtemp` 临时目录作 baseDir，诱饵文件 + 目录前后快照比对）
- **独立产出**：`tests/tester-path-guard.INDEPENDENT.spec.ts`（43 用例，**未改** src 与既有测试）

## 结论总览

| # | 验证项 | 结果 |
|---|--------|------|
| 1 | 写路径被拒且零越界（9 种非法输入 × 3 写入口） | ✅ PASS |
| 2 | 读路径绝不越界读取（baseDir 之外放诱饵） | ✅ PASS |
| 3 | 合法值回归 E2E（588000 / 000001 / v001） | ✅ PASS |
| 4 | 入口覆盖审计（独立复核全部 `join(` 处） | ✅ PASS（无遗漏） |
| 5 | 回归与契约（typecheck / build / test / inject / patch） | ✅ PASS |

**缺陷清单**：无。

---

## 1. 写路径被拒且零越界 —— ✅ PASS

对 9 种非法输入逐一验证三个写入口，均被拒且 baseDir 之外（含父目录 sandbox 层）**不产生任何文件**：

| 输入 | `strategy_set` (StrategyRegistry.set) | `(sense) rollback` | `ledger_init` (Ledger.init) |
|------|---------------------------------------|--------------------|------------------------------|
| `''` 空字符串 | 抛 `[path-guard]` | 抛 `[path-guard]` | 抛 `[ledger] symbol 为空`（见备注） |
| `'.'` | 抛 `[path-guard]` | 抛 `[path-guard]` | 抛 `[path-guard]` |
| `'..'` | 抛 `[path-guard]` | 抛 `[path-guard]` | 抛 `[path-guard]` |
| `'../x'` | 抛 `[path-guard]` | 抛 `[path-guard]` | 抛 `[path-guard]` |
| `'../../esc2'` | 抛 `[path-guard]` | 抛 `[path-guard]` | 抛 `[path-guard]` |
| `'/abs'` | 抛 `[path-guard]` | 抛 `[path-guard]` | 抛 `[path-guard]` |
| `'a/b'` | 抛 `[path-guard]` | 抛 `[path-guard]` | 抛 `[path-guard]` |
| `'a b'` | 抛 `[path-guard]` | 抛 `[path-guard]` | 抛 `[path-guard]` |
| 65 字符 `'a'.repeat(65)` | 抛 `[path-guard]` | 抛 `[path-guard]` | 抛 `[path-guard]` |
| `'a\\b'` | 抛 `[path-guard]` | 抛 `[path-guard]` | 抛 `[path-guard]` |

**证据**（独立 spec 内，`describe.each` 逐输入跑）：
- 每个用例构造 `sandbox/base`，构造 registry 后 `snapshot(sandbox)` 记录基线树，执行写操作断言抛错，再 `snapshot(sandbox)` 断言 **前后树完全一致**（`toEqual`）。
- 显式断言越界产物不存在：`sandbox/esc2`、`sandbox/esc2.md`、`baseDir/esc2`、`baseDir/ledger` 均 `existsSync === false`。
- `sense_archive_commit` 的版本号由 `nextVersion()` 内部生成（`vNNN`，非外部输入），实测 `commit → read('v001') → rollback('../../esc2')抛[path-guard]` 全通过，无越界通道。

**备注（非缺陷）**：`ledger_init('')` 抛 `[ledger] symbol 为空` 而非 `[path-guard]` —— 因为 `Ledger.init` 在 `getSymbol` 之前有更早的 `symbol 为空` 校验。这是**同为拒绝、零越界**的域内校验，安全性质成立；`assertSafeSegment('')` 本身仍抛 `[path-guard]`（已单测）。其余非法输入 `ledger_init` 均由 `[path-guard]` 拦截（`getSymbol → readTable → tablePath → symbolDir` 路径上守卫在 `try` 块外，正常抛出）。

---

## 2. 读路径绝不越界读取 —— ✅ PASS

**诱饵构造**：`join(baseDir, '…', '../../esc2')` 归一化到 **`sandbox/esc2`**（即 baseDir 的父目录层，baseDir 之外）。在 `sandbox/esc2/` 与 `sandbox/esc2.md` 放置内容含哨兵 `__DECOY_LEAKED_PATHGUARD__` 的文件。

| 读操作 | 越界输入 | 期望 | 实测 |
|--------|----------|------|------|
| `StrategyRegistry.get` | symbol `'../../esc2'` | `undefined` | ✅ `undefined` |
| `StrategyRegistry.get` | symbol `'../esc2'` / `'/abs'` / `'a/b'` | `undefined` | ✅ `undefined` |
| `StrategyRegistry.current` | symbol `'../../esc2'` | `undefined` | ✅ `undefined` |
| `StrategyRegistry.list` | symbol `'../../esc2'` | `[]` | ✅ `[]` |
| `StrategyRegistry.get` | symbol 合法 `'588000'`，version `'../../esc2'` / `'../esc1'` | `undefined` | ✅ `undefined` |
| `SenseRegistry.read` | version `'../../esc2'` | 抛 `[path-guard]` | ✅ 抛 `[path-guard]`，错误信息不含哨兵 |
| `SenseRegistry.current` | （无指针） | `null` | ✅ `null` |
| `Ledger.query` | symbol `'../../esc2'` | 抛 `[path-guard]` | ✅ 抛 `[path-guard]`，错误不含哨兵 |

**证据**：
- 越界 symbol 的 `strategy_get` 一律返回 `undefined`；`readMeta` 内 `metaFile/versionFile` 的 path-guard 抛错被 `try/catch` 吞掉 → 返回 undefined，**不读诱饵**。
- `SenseRegistry.read('../../esc2')` 因 `versionDir` 调用位于 `readMeta` 的 `try` 块**之外**，path-guard 正常上抛 → 抛 `[path-guard]`（与 Developer 测试预期一致）。
- 合法 symbol `'588000'` 读到的是自己的正文（`首版`），**不含哨兵**；诱饵文件 `sandbox/esc2/v001.md`、`sandbox/esc2.md` 内容**原样未动**（仍为哨兵），证明读路径从未触碰诱饵。

---

## 3. 合法值回归 E2E —— ✅ PASS

- `assertSafeSegment` 合法值原样通过：`'588000'`、`'000001'`、`'v001'`、`'a-b_c.d'`、`'a'.repeat(64)`（边界 64 字符通过）。
- 完整流程实测通过：
  ```
  ledger.init('588000', {etf, qty:1000, cost:1.5, cash:100000})
    → strategy.set('588000', v1) → 'v001'
    → strategy.get('588000') → version='v001', text='v1 正文'
    → strategy.set('588000', v2, parentVersion='v001') → 'v002'
    → strategy.get('588000') → 'v002' / text='v2 正文'
    → strategy.get('588000', 'v001') → 'v1 正文'（历史版不可变）
  ```
- 第二标的 `'000001'`（stock）独立初始化 + 首版策略正常。
- 落盘结构正常：`strategy/588000.md`、`strategy_versions/588000/v002.md`、`ledger/588000/symbols.json` 均存在。
- `SenseRegistry` 合法版本 `commit → read('v001') → rollback('v001')` 正常。

---

## 4. 入口覆盖审计（独立复核）—— ✅ PASS，无遗漏

对 `src/domain` 全部 `join(` / 路径拼接逐一复核（`grep -rn "join(" src --include='*.ts'`）：

**已守卫的外部输入调用点（6 处，均经 `assertSafeSegment`）：**

| file:line | 方法 | 守卫 |
|-----------|------|------|
| `src/domain/store.ts:96` | `JsonStore.symbolDir` | `assertSafeSegment(symbol, 'symbol')` |
| `src/domain/strategy.ts:80` | `StrategyRegistry.symbolVersionsDir` | `assertSafeSegment(symbol, 'symbol')` |
| `src/domain/strategy.ts:85` | `StrategyRegistry.currentPath` | `assertSafeSegment(symbol, 'symbol')` |
| `src/domain/strategy.ts:92` | `StrategyRegistry.versionFile` | `assertSafeSegment(version, 'version')` |
| `src/domain/strategy.ts:100` | `StrategyRegistry.metaFile` | `assertSafeSegment(version, 'version')` |
| `src/domain/sense-registry.ts:72` | `SenseRegistry.versionDir` | `assertSafeSegment(version, 'version')` |

**其余 `join(` 均为安全（常量 / 已守卫 / 内部目录列举）：**
- `store.ts:91` `ledgerRoot` = `join(this.dataRoot, 'ledger')`：`dataRoot` 为构造注入、`'ledger'` 常量，非外部输入。
- `store.ts:101` `tablePath` → 调 `symbolDir`（已守卫）。
- `store.ts:134` `listSymbolDirs` 的 `join(this.ledgerRoot, e)`：`e` 来自 `readdirSync(ledgerRoot)` 的**真实目录列举项**，不可能为 `..`/含 `/`；且后续 `listSymbols` 读回时再次经 `symbolDir` 守卫，双保险。
- `strategy.ts:70/75` `currentRoot/versionsRoot`、`sense-registry.ts:66/77` `root/pointerPath`、`sense-registry.ts:98/166/167/168/213/214`：均 join **已守卫的** `versionDir(dir)` 或常量后缀（`meta.json`/`rationale.md` 等），无外部输入。
- `tools/ledgers.ts:119`、`tools/predicts.ts:142`、`tools/reviews.ts:156/223`、`sense-archives.ts:139`、`plugin.ts:106`、`runner/wake.ts:103`、`domain/reviews.ts` 等 `.join(...)`：均为**数组/字符串 join**，非路径拼接。

**其它 domain 落盘模块：**
- `predicts.ts` / `reviews.ts`：均经 `JsonStore.readTable/writeTable`（内部 `tablePath→symbolDir` 已守卫），**不 import `node:path`**；`date` 仅作 JSON 记录内键，不拼入路径（`reviews.ts` 另对 date 有 `^\d{4}-\d{2}-\d{2}$` 校验）。
- `metrics.ts`：纯函数，无 fs/path。

**`src/tools` / `src/runner` / `src/skills` / `src/prompts` 复核：**
- `tools/context.ts:17` `resolve` 仅用于解析 `dataRoot`（构造注入/环境变量/默认值），非每请求外部输入。
- `skills/index.ts:44` `new URL(./${name}/SKILL.md)`：`name` 为内部固定技能名，非用户输入。
- `prompts/index.ts`：读取常量 URL。
- 结论：**无未守卫的外部输入路径拼接遗漏**。

---

## 5. 回归与契约 —— ✅ PASS

- `pnpm typecheck`：0 错误（`tsc -p tsconfig.json --noEmit` 通过）。
- `pnpm build`：通过（`tsc --noEmit` + `tsconfig.server.json` 编译 + copy-assets 12 个资源）。
- `pnpm test`：**基线 45 文件 / 747 用例全绿**（加入本独立 spec 后 46 文件 / 790 用例，全部通过）。
- 顶层 `inject`：`src/plugin.ts` 仍为 `export const inject: string[] = ['tools', 'skills', 'ptcRuntime', 'fs']`（四项，不变）。
- `cordis.patch.yml`：`inject: ['tools', 'skills', 'ptcRuntime', 'fs']` 与 `name: dsh-finance` 不变（git diff 确认未改动）。

---

## 附：Developer 改动合理性复核

1. `tests/tester-task17-strategy.INDEPENDENT.spec.ts` 的 ⑧ 由「如实观察」（断言越界漏洞存在）改为「越界一律被拒」（断言 `threw=true` + `escapedOut.length===0`）。**改法等价合理**：原观测点即为「双层 `../` 逃逸」漏洞，修复后断言方向正确反转，且保留 `probe` 的目录前后比对逻辑，未弱化证据强度。
2. `path-guard.ts` 的规则（非空 / `^[A-Za-z0-9._-]+$` / 禁 `.`·`..` / ≤64）与任务卡一致，且天然拒绝 `/`、`\`、空白与控制字符。
3. `src/` 改动仅 3 文件各 5~19 行（导入守卫 + 在 join 处包裹 `assertSafeSegment`），最小侵入，无副作用。

---

## 未验证项 / 约束遵守

- 全部验证均在**临时目录**完成，测试结束 `afterEach` 清理所有 sandbox 与诱饵文件；已确认 `tmp` 无 `pathguard-sandbox-*` 残留。
- **未修改** `src/`、Developer 的 `tests/path-guard.test.ts`、以及既有（含上一轮）测试文件；本轮使用新文件名 `tester-path-guard.INDEPENDENT.*`。
- 未 commit / push。
- 未做编码规范（lint）检查（非本任务范围）。
