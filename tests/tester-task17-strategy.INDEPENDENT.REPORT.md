# Task-17「strategy-registry」独立运行时验证报告

- **被测交付物**：`src/domain/strategy.ts`（新增 `StrategyRegistry`）+ `src/domain/types.ts`（+34 策略类型）+ `src/domain/store.ts`（`LedgerTable` 移除 `'strategy'`）
- **独立测试**：`tests/tester-task17-strategy.INDEPENDENT.spec.ts`（Tester 产出，未改 `src/` 与既有测试）
- **执行环境**：macOS node（Reach的MacBook Pro），pnpm 11.7.0 / node v25.9.0，vitest v3.2.7
- **命令**：`pnpm exec vitest run tests/tester-task17-strategy.INDEPENDENT.spec.ts tests/strategy.test.ts`
- **结果**：`Test Files 2 passed (2) | Tests 21 passed (21)`（独立 11 + Developer 自有 10）

---

## 逐条验收结论

### ① 落盘完整性 —— ✅ PASS

`set('588000', {text:'# 首版策略\n买入并持有\n', rationale:'初始策略：长期持有', by:'tester'})` 返回 `v001`，4 处落盘验证：

| 路径 | 存在 | 内容断言 |
|------|------|----------|
| `strategy/588000.md` | ✅ | `===` 入参 text |
| `strategy_versions/588000/v001.md` | ✅ | `===` 入参 text |
| `strategy_versions/588000/v001.meta.json` | ✅ | `version='v001'`、`rationale` 与入参一致、`ts` 为合法 ISO 时间、`parent` 为 `undefined`、`by='tester'` |
| `strategy_versions/588000/current` | ✅ | 内容 `trim()==='v001'` |

### ② 内容一致性 —— ✅ PASS

- `strategy/588000.md` 与 `strategy_versions/588000/v001.md` 以 **Buffer 逐字节**（`Buffer.equals`）比对一致。
- `meta.rationale` 与入参 `rationale` 一致。

### ③ 版本不可变 —— ✅ PASS

追加 `set(sym, {text:'v2 正文（新版）', rationale:'r2', parentVersion:'v001'})` 返回 `v002`，验证：

- `v001.md` 与 `v001.meta.json` 内容字节 **未变**（写前/写后 `Buffer.equals` 均 true）。
- `v001.md` / `v001.meta.json` 的 `statSync().mtimeMs` **完全未变**（未被重写）。
- `current` 指针 → `v002`；`strategy/588000.md` 已更新为 `v2 正文（新版）`。

### ④ 读取语义 —— ✅ PASS

- `get(sym)` 默认返回当前版：`version='v002'`、`text='v2 新内容'`、`meta.parent='v001'`。
- `get(sym,'v001')` 返回 v1 原文（与写入一致），`symbol` 字段正确。
- `list(sym)` 返回 `['v001','v002']`（按版本号升序）。

### ⑤ 未设定 —— ✅ PASS

- 未 set 过的 `symbol`：`get(sym)` → `undefined`，`current(sym)` → `undefined`，`list(sym)` → `[]`。

### ⑥ 错误路径 —— ✅ PASS（3/3 均真实触发抛错）

| 场景 | 期望 | 实际 |
|------|------|------|
| ① 非首版不带 `parentVersion` | 抛错 | ✅ `toThrow(/parentVersion/)` |
| ② `parentVersion` ≠ 当前版 | 抛错 | ✅ `toThrow(/不一致/)` |
| ③ 已有版本再以「首版」（不带 parent）写入 | 抛错 | ✅ `toThrow(/parentVersion/)`，且落盘未破坏（`current` 仍 `v001`） |

### ⑦ 目录隔离 —— ✅ PASS

- `A0001`（v001→v002）与 `B0002`（仅 v001）版本链、`current` 指针、当前版文档相互独立，互不影响。

### ⑧ 路径安全评估 —— ⚠️ 发现风险（如实报告，未要求修复）

`symbol` 直接拼入 `path.join`（无任何校验/清洗），观测结果（原始输出）：

```
../esc1    threw=false  created=["base/esc1","base/esc1.md","base/esc1/current","base/esc1/v001.md","base/esc1/v001.meta.json"]
../../esc2  threw=false  created=["esc2","esc2.md","esc2/current","esc2/v001.md","esc2/v001.meta.json"]
/absfoo    threw=false  created=["base/strategy","base/strategy_versions","base/strategy/absfoo.md","base/strategy_versions/absfoo/..."]
```

**结论**：
- `symbol` 含 **单层 `../`**：逃出 `strategy/` 与 `strategy_versions/` 子目录，但仍在 `baseDir` 内（目录结构被污染，非越界）。
- `symbol` 含 **双层 `../../`**：**逃出 `baseDir` 本体**，把 `esc2/` 目录与 `esc2.md` 直接写到 baseDir 的父目录（`sandbox` 层）—— 构成**目录穿越（path traversal）**。
- `symbol` 含 **前导 `/`**：`path.join` 会剥离前导斜杠并归一化，落在 `baseDir` 内，**不越界**（无影响）。

> 风险定位：`src/domain/strategy.ts:78-80`（`symbolVersionsDir`）、`:83-85`（`currentPath`）直接将 `symbol` 拼入路径，`set()` 入口（`:176` 附近）无 symbol 合法性校验。

### ⑨ AC2 复核 —— ✅ PASS

`src/domain/strategy.ts` 无任何 `@deepseek-ai/*` import（正则断言 `import ...'@deepseek-ai/...'`、`from '@deepseek-ai/...'`、`require('@deepseek-ai/...')` 均不命中）。实际 import 仅 `node:fs`、`node:path`、本地 `./types.js`。文件中出现的 `@deepseek-ai/*` 字样仅在注释（说明「不 import」）。

---

## 附：store.ts 变更复核

- `LedgerTable` 已从 9 表移除 `'strategy'`（`src/domain/store.ts:53-57`），注释同步移除。
- `tsc -p tsconfig.json --noEmit` 通过（exit 0）。
- `grep -rn "'strategy'" src/` 仅命中 `strategy.ts:69`（注册表自身目录名，非 LedgerTable 引用）—— 移除干净，无残留引用。

---

## 缺陷清单

| # | 严重度 | 位置 | 说明 |
|---|--------|------|------|
| 1 | 🟠 Medium | `src/domain/strategy.ts:78-80`、`:83-85` | `symbol` 未做路径校验即拼入 `path.join`，含 `../` 可造成目录穿越（双层 `../` 可越界写入 `baseDir` 之外的路径）。若 `symbol` 来自工具层外部输入则构成安全风险；若上层（tool 层）已限制 symbol 为纯股票/ETF 代码，则风险降级为防御性缺口。**本次未要求修复，仅如实上报。** |

---

## 未验证项

- 无。任务卡 9 项验收点全部实测覆盖，无推断式通过。

## 环境清理

- 所有用例均使用 `fs.mkdtempSync` 临时 `baseDir`，`finally` 中 `rmSync(recursive)` 清理，未污染真实 `dataRoot`；未执行任何 `git commit/push`。
