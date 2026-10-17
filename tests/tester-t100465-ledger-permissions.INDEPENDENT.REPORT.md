# Tester 独立验证报告 — 任务-05 运行时数据确认 + 台账敏感加固（0o700）

| 项目 | 内容 |
|------|------|
| 被测分支 | `feat/task-5-ledger-permissions` |
| 基线提交 | `9384e26`（`feat(scheduler): 任务定义与任务程序迁出到 assets/tasks + assets/programs (t100461)`） |
| 变更范围 | `src/domain/store.ts`（+32/−4）、`README.md`（+2）、新增 `tests/ledger-permissions.spec.ts` |
| 执行节点 | `Reach的MacBook Pro`（macOS arm64，Node v25.9.0，pnpm 11.7.0，vitest 3.2.7，tsc 5.9.3） |
| 执行时间 | 2026-10-17 12:07–12:10（GMT+8） |
| 独立用例 | `tests/tester-t100465-ledger-permissions.INDEPENDENT.spec.ts`（31 用例） |
| **结论** | **✅ 通过**（验收 1–4、额外 5–10 全部通过；无阻塞/中危缺陷；3 项低风险建议） |

**过程声明**：未修改 `src/` 与 Developer 的测试文件；未执行 `git add/commit/push`；未运行全量 `pnpm test`；全部用例使用 `mkdtempSync` 且 `DSH_IA_HOME` 指向临时目录，**未 chmod / 读写真实 `~/.dsh-ia`**。

---

## 1. 验收结论总表

| # | 验收点 | 结论 | 关键证据 |
|---|--------|------|----------|
| 1 | 台账读写在 `data/ledger` 正常，内容结构不变 | ✅ 通过 | 8 张表写读值深等；落盘字节严格等于 `JSON.stringify(value, null, 2)`；**与基线 `9384e26` 同夹具差分：8 个文件 sha256 逐一相同**（`CONTENT_STRUCTURE_IDENTICAL=true`）；diff 复核确认表名/序列化/字段零改动 |
| 2 | `ledger/` 与 `<symbol>/` 均为 `0o700` | ✅ 通过 | `ensureSymbolDir` / `writeTable` 后两级目录 `stat.mode & 0o777 === 0o700`；**umask=022 对照**：改动前为 `755`，改动后为 `700` |
| 3 | `data/` 不进 git | ✅ 通过 | `git check-ignore -v data/x` → `.gitignore:6:/data/`；`git check-ignore -v data/ledger/588000/positions.json` 同样命中；`git ls-files -- data` 行数 = `0` |
| 4 | `tsc --noEmit` EXIT=0；相关台账测试通过 | ✅ 通过 | `pnpm exec tsc -p tsconfig.json --noEmit` → `TSC_EXIT=0`；`ledger-permissions.spec.ts` + `ledger.test.ts` + `path-guard.test.ts` = 42/42 通过 |
| 5 | 权限收紧对**已存在**目录生效 | ✅ 通过 | 预置 `ledger/`、`<symbol>/` 为 `0o755`，经 `ensureSymbolDir` / `writeTable` 后均回到 `0o700`；`0o777` / `0o750` / `0o711` 亦全部修正 |
| 6 | 写入路径不绕过 | ✅ 通过 | 目录不存在时 `writeTable` 建为 `0o700`；连续写 symbols/positions/accounts 后权限不变、三文件齐全、既有内容未被覆盖/丢失 |
| 7 | 路径不变、`dataRoot` 由构造注入决定 | ✅ 通过 | `tablePath('588000','positions') === <dataRoot>/ledger/588000/positions.json`，不含 `assets`；运行中改 `DSH_IA_HOME` 后路径与落点不变，且环境变量指向目录**未被创建** |
| 8 | 8 张表读写往返、2 空格缩进 | ✅ 通过 | symbols/positions/accounts/trades/predictions/reviews/metrics/thresholds 各一轮，值与结构一致；字节 = `JSON.stringify(value, null, 2)` 且无尾随换行 |
| 9 | 不触碰真实数据 | ✅ 通过 | 全部 `mkdtempSync`；`DSH_IA_HOME=<sandbox>/fake-home` 后断言 `fake-home` 不存在、`fake-home/data` 不存在；沙箱顶层仅 `data/`；`HOME` 未被改动 |
| 10 | 符号安全未被削弱 | ✅ 通过 | `'../evil'`、`'a/b'`、`'..'`、`'.'`、`''`、`'a\\b'`、`'x y'`、65 字符超长 均抛 `[path-guard]`；拒绝后不创建 `ledger/` 根、无越界文件；合法符号（`588000` / `000001.SZ` / `a_b-c.d`）仍可用且为 `0o700` |

---

## 2. 用例明细（31 条，全绿）

`tests/tester-t100465-ledger-permissions.INDEPENDENT.spec.ts` — `31 passed (31)`，约 0.35s。

### [AC1/AC8] 落点与结构不变（2）
1. 8 张表各写读一轮：值深等、文件名不变、**原文件字节等于 2 空格缩进序列化**；目录内文件集合恰为 8 个 `<table>.json`
2. `LedgerStore` 业务封装（saveSymbol/savePosition/saveAccount/appendTrade/saveThresholds + listSymbols）仍读写同一批表

### [AC2] 目录权限（4）
3. `ensureSymbolDir` 后 `ledger/` 与 `<symbol>/` 均 `0o700`
4. `writeTable` 建目录后两级均 `0o700`
5. **umask=022 对照**：无 mode 的 `mkdirSync` 对照组为 `0o755`；同 umask 下 `writeTable` 产物为 `0o700`（证明 chmod 兜底真实生效，而非仅靠当前 umask=077）
6. 不同 symbol 各自 `0o700` 且互不干扰

### [AC3] git 忽略（3）
7. `git check-ignore -v data/x` 命中 `.gitignore` 的 `/data/` 规则
8. `git ls-files -- data` 为空
9. `data/ledger/<symbol>/<table>.json` 运行时产物同样被忽略

### [AC5] 既有目录收紧（3）
10. `ledger/` + `<symbol>/` 预置 `0o755` → `ensureSymbolDir` 后 `0o700`/`0o700`
11. 预置 `0o755` 且已存在 `positions.json` → `writeTable` 后 `0o700`/`0o700`，旧文件未被误删且被正确覆盖
12. `0o777` / `0o750` / `0o711` 逐个验证均修正为 `0o700`

### [AC6] 写入路径（2）
13. 目录不存在 → 创建 `0o700`；连续三次写不同表，权限不变、三文件齐全、既有内容不丢
14. 覆盖写同一张表：权限保持 `0o700`，内容为最后一次值

### [AC7] 路径（3）
15. `tablePath` 等于 `join(dataRoot,'ledger','588000','positions.json')`，`endsWith('ledger/588000/positions.json')`，不含 `assets`
16. 运行中修改 `DSH_IA_HOME`：已构造实例的 `tablePath`/`symbolDir` 不变、落点仍在注入 root、env 指向目录未被创建
17. 两个不同注入 root 完全隔离

### [AC9] 隔离（3）
18. 构造 + 全表写入 + 第二 symbol 后：沙箱顶层仅 `['data']`、`fake-home` 不存在、`dataRoot` 自身权限未被改动
19. `DSH_IA_HOME=fakeHome` 时写入：`fakeHome/data`、`fakeHome/data/ledger` 均不存在
20. `process.env.HOME` 未被测试改动

### [AC10] 符号安全（11）
21–28. `'../evil'` / `'a/b'` / `'..'` / `'.'` / `''` / `'a\\b'` / `'x y'` / 65 字符超长 —— `writeTable`、`ensureSymbolDir`、`symbolDir`、`tablePath`、`readTable` 全部抛 `[path-guard]`
29. `'../evil'` 被拒后：`ledger/` 根未创建、`<sandbox>/evil` 与 `<dataRoot>/evil` 均不存在
30. `'a/b'` 被拒后：无嵌套目录产生
31. 合法边界符号 `588000` / `000001.SZ` / `a_b-c.d` 可用且目录 `0o700`

---

## 3. 命令与关键输出

### 3.1 类型检查（验收 4）

```bash
cd /Users/reachlucifer/project/opc/worktrees/dsh-finance-feat-task-5-ledger-permissions
pnpm exec tsc -p tsconfig.json --noEmit
# TSC_EXIT=0
```

补充：项目 `tsconfig.json` 仅 `include: ["src/**/*.ts"]`，测试文件不在其内；故对独立 spec 另做一次显式类型检查：

```bash
pnpm exec tsc --noEmit --strict --skipLibCheck --target ES2022 \
  --module ESNext --moduleResolution Bundler --types node \
  tests/tester-t100465-ledger-permissions.INDEPENDENT.spec.ts
# SPEC_TSC_EXIT=0
```

### 3.2 定向测试（无全量运行）

```bash
pnpm exec vitest run tests/tester-t100465-ledger-permissions.INDEPENDENT.spec.ts --maxWorkers=1
# ✓ 31 tests passed

pnpm exec vitest run tests/ledger-permissions.spec.ts tests/ledger.test.ts tests/path-guard.test.ts --maxWorkers=2
# ✓ ledger.test.ts (15)
# ✓ ledger-permissions.spec.ts (7)
# ✓ path-guard.test.ts (20)
# Test Files 3 passed | Tests 42 passed

pnpm exec vitest run tests/thresholds.test.ts tests/tester-independent-verify.test.ts tests/tester-verify.test.ts --maxWorkers=2
# Test Files 3 passed | Tests 57 passed
```

### 3.3 git 忽略（验收 3）

```bash
git check-ignore -v data/x
# .gitignore:6:/data/	data/x

git check-ignore -v data/ledger/588000/positions.json
# .gitignore:6:/data/	data/ledger/588000/positions.json

git ls-files -- data | wc -l
# 0
```

### 3.4 关键回归：umask=022 下「改动前 755 → 改动后 700」

当前开发机默认 `umask=077`，仅测本分支会掩盖「mkdir mode 是否真的生效」。故额外在 `umask 022` 下用**基线 vs 分支**同一夹具做差分：

```bash
(umask 022; node /tmp/t100465-compare.mjs)
# MODES_BASE={"root":"700","ledger":"755","symbol":"755"}   ← 基线 9384e26
# MODES_HEAD={"root":"700","ledger":"700","symbol":"700"}   ← 本分支
# CONTENT_STRUCTURE_IDENTICAL=true
```

> 该差分脚本把基线 `9384e26` 的 `store.ts` / `types.ts` / `path-guard.ts` 用 esbuild 打包为 ESM，与本分支同源文件各自写同一夹具到独立 `mkdtemp` 目录，比对**相对路径 + 字节 sha256 + 字节数**：8 个文件全部一致，证明「权限加固未改变任何数据落点与内容结构」。

### 3.5 diff 复核

```text
2	0	README.md
32	4	src/domain/store.ts
```

`store.ts` 变更仅含：新增 `chmodSync` 导入、新增私有 `ensureLedgerRoot()`、`ensureSymbolDir()` 增加 `ensureLedgerRoot()` + `mode: 0o700` + `chmodSync` 兜底、`writeTable()` 改为先 `ensureSymbolDir()` 再写（删除原 `dirname(path)` 的 mkdir）。`readTable`、`symbolDir`、`tablePath`、`LedgerTable`、业务封装与 `JSON.stringify(value, null, 2)` 均未改动。

### 3.6 工作区状态（未提交、未污染）

```text
 M README.md
 M src/domain/store.ts
?? tests/ledger-permissions.spec.ts          # Developer 交付
?? tests/tester-t100465-ledger-permissions.INDEPENDENT.spec.ts  # 本报告用例
```

仓库内未生成 `data/`（`ls -d data` → 不存在）；全部测试产物已由 `afterEach` 删除。

---

## 4. 缺陷与风险

### 阻塞缺陷
无。

### 中危缺陷
无。

### 低风险 / 建议（不阻塞验收）

| ID | 风险 | 说明 | 建议 |
|----|------|------|------|
| R1 | 创建瞬间的权限窗口 | `mkdirSync(..., mode:0o700)` 受 umask 影响，在 `umask=022` 时为 `0o755`，随后 `chmodSync` 收紧。二者之间存在极短窗口，若同机其他用户在此时刻枚举可短暂进入目录。 | 本地单用户场景可接受；如需彻底消除，可在进程启动时 `process.umask(0o077)`（全局副作用，需评估）或用 `fs.open` + `O_DIRECTORY` 原子创建（Node 无直接等价 API）。 |
| R2 | 台账文件本身为 `0o644` | 目录 `0o700` 已阻断他人访问，文件权限未单独收紧；若未来目录权限被放宽、或文件被复制/打包，内容（盈亏/成本/流水）会随之暴露。 | 可选加固：`writeFileSync(..., { mode: 0o600 })`（注意：已存在文件不会被 mode 修正，需 `chmodSync`）。不属本任务验收范围。 |
| R3 | `chmod` 失败被静默吞掉 | 注释已说明「umask / 平台差异兜底」，但在不支持 chmod 的文件系统（如某些网络盘/FAT）上权限不会收紧且无任何日志，属静默降级。 | 可选：debug 级日志记录失败原因，便于运维发现。 |
| R4 | 符号链接目录被跟随 | 若 `<dataRoot>/ledger/<symbol>` 已是他人预置的 symlink，`mkdirSync` 为 no-op 且 `chmodSync` 会作用于链接目标目录，`writeFileSync` 也会写穿到目标。利用前提是攻击者已能写 `dataRoot`，超出本任务威胁模型（本地单用户私有目录）。 | 如后续提高威胁模型，可在 `ensureSymbolDir` 前 `lstatSync` 拒绝 symlink。 |

### 信息性说明
- `data/` 的忽略规则为 `.gitignore` 的 `/data/`（锚定仓库根），已用 `check-ignore` 验证对 `data/ledger/**` 同样生效。
- 基线噪声清单（`prompt-skills`、`tester-t100438-*`、`tester-task11-*`、`advisor.md` 计数）本次**未触发**：按红线只跑定向文件，未运行这些文件。

---

## 5. 复现步骤

```bash
cd /Users/reachlucifer/project/opc/worktrees/dsh-finance-feat-task-5-ledger-permissions

# 1) 类型检查
pnpm exec tsc -p tsconfig.json --noEmit; echo "TSC_EXIT=$?"          # 期望 0

# 2) 独立用例（31）
pnpm exec vitest run tests/tester-t100465-ledger-permissions.INDEPENDENT.spec.ts --maxWorkers=1

# 3) 相关台账用例（42）
pnpm exec vitest run tests/ledger-permissions.spec.ts tests/ledger.test.ts \
  tests/path-guard.test.ts --maxWorkers=2

# 4) git 忽略
git check-ignore -v data/x
git ls-files -- data | wc -l                                          # 期望 0

# 5) 复现「umask 022 下 755 → 700」
#    基线：git show 9384e26:{src/domain/store.ts,types.ts,path-guard.ts} → /tmp/base
#    用 node_modules/.pnpm/esbuild@*/node_modules/esbuild/bin/esbuild 打包为 ESM，
#    同夹具各写一个 mkdtemp 目录，比对 sha256；详见 §3.4。
```

**最终判定：✅ 通过。** 权限加固对「新建目录」与「既有宽权限目录」均生效，且未改变台账路径、表名、JSON 序列化与字段结构；`data/` 仍被 git 忽略；未发现阻塞问题。
