# T100462 独立测试报告 —— assets 层根目录（路径解析 + 幂等创建 + .gitignore 边界）

- **任务**：dsh-finance 数据治理第一步：`~/.dsh-ia` 下「assets / data / logs」三层物理分离地基
- **被测分支**：`feat/task-1-assets-layer-root`
- **基线 commit**：`57d5e7b`（工作区含未提交变更：`M .gitignore`、`M src/paths.ts`、`?? tests/paths.test.ts`）
- **被测产物**：`src/paths.ts`（`resolveAssetsDir()` / `ensureAssetsDir()`）、仓库根 `.gitignore`、`tests/paths.test.ts`（自测）
- **测试位置**：`/Users/reachlucifer/project/opc/worktrees/dsh-finance-feat-task-1-assets-layer-root`
- **执行节点**：Reach的MacBook Pro（macOS / arm64）
- **环境**：node v25.9.0 · pnpm 11.7.0 · vitest 3.2.7 · TypeScript 5.9.3
- **执行时间**：2026-10-17 11:00–11:01 CST
- **测试类型**：独立黑盒 + 静态检查 + 真实 git 验证（不复用 Developer 断言）
- **独立 spec**：`tests/tester-t100462-assets-path.INDEPENDENT.spec.ts`（23 用例，全绿）
- **结论**：**通过**（0 阻塞缺陷，3 条建议改进）

---

## 一、验收标准逐条结论

| # | 验收标准 | 结论 | 关键证据 |
|---|----------|------|----------|
| 1 | `resolveAssetsDir()` 返回 `~/.dsh-ia/assets`；`ensureAssetsDir()` 幂等创建（已存在 no-op） | ✅ 通过 | 实测默认返回 `/Users/reachlucifer/.dsh-ia/assets`（绝对、无 `~`）；`ensureAssetsDir()` 首次创建 `isDirectory()=true`，二次调用同路径不抛错，且 `ino` / `mtimeMs` 不变 |
| 2 | 代码中不含旧路径兜底只读分支 | ✅ 通过 | `grep -n existsSync src/paths.ts` → 无匹配；`resolveAssetsDir` 函数体仅 `join(resolveFinanceHomeDir(), 'assets')`；全 `src/` 无 assets 旧路径（`data/skills` / `data/strategy` / `data/tasks`）回落分支 |
| 3 | `.gitignore` 生效：`data/`、`logs/` 不进 git、`assets/` 进 git | ✅ 通过 | `git check-ignore -v data/x` → `.gitignore:6:data/` exit 0；`logs/x` → `.gitignore:7:logs/` exit 0；`assets/x` → exit 1 无输出；`git ls-files` 无 `data/`、`logs/` 已跟踪文件 |
| 4 | `tsc` 通过，相关路径单测通过 | ✅ 通过 | `tsc -p tsconfig.json --noEmit` exit 0；`vitest run tests/paths.test.ts tests/flags.test.ts` → 2 files / 24 tests 全绿；独立 spec 23 用例全绿 |

> 全部门禁项通过，未发现功能缺陷。以下用例为**实际执行结果**，非复述 Developer 结论。

---

## 二、用例明细（独立 spec，23 用例）

### AC1 默认路径解析（3/3 ✅）
| # | 用例 | 结果 |
|---|------|------|
| 1 | 未设 `DSH_IA_HOME` 时 `=== join(homedir(), '.dsh-ia', 'assets')` | ✅ |
| 2 | 返回绝对路径、以 `/` 开头、不含未展开 `~` | ✅ |
| 3 | `dirname(result) === getFinanceHome()`，assets 恒为 home 直接子目录 | ✅ |

### AC1 环境变量覆盖（4/4 ✅）
| # | 用例 | 结果 |
|---|------|------|
| 4 | `DSH_IA_HOME=<tmp>` → `<tmp>/assets` | ✅ |
| 5 | 相对路径输入经 `resolve()` 归一为绝对路径，不含 `..` / `.` 段，不以相对串开头 | ✅ |
| 6 | 尾部斜杠输入等价 | ✅ |
| 7 | 纯空白值 `'   '` 视为未设置 → 回落默认 home | ✅ |

### AC1 纯计算无副作用（2/2 ✅）
| # | 用例 | 结果 |
|---|------|------|
| 8 | 调用后 `assets` 与父 home 均不存在 | ✅ |
| 9 | 连续 3 次调用 `readdirSync(tmp)` 与调用前完全一致 | ✅ |

### AC1 幂等创建（2/2 ✅）
| # | 用例 | 结果 |
|---|------|------|
| 10 | 首次创建 → `isDirectory()=true`；二次调用返回同一路径且不抛错 | ✅ |
| 11 | 已存在目录上二次调用 `ino` / `mtimeMs` 不变（真 no-op，非重建） | ✅ |

### AC1 多级父目录递归创建（1/1 ✅）
| # | 用例 | 结果 |
|---|------|------|
| 12 | `DSH_IA_HOME=<tmp>/l1/l2/l3`（全部不存在）→ 递归创建 l1/l2/l3/assets 全链路 `isDirectory()` | ✅ |

### AC1 已存在非空目录（1/1 ✅）
| # | 用例 | 结果 |
|---|------|------|
| 13 | 预置 `skills.md` + `.hidden-keep` 后 `ensureAssetsDir()` 不抛错；文件内容逐字节一致、目录项集合不变（未删内容、未重置） | ✅ |

### AC3 .gitignore 真实 git 验证（6/6 ✅，cwd=仓库根，真实 `git` 子进程）
| # | 用例 | 结果 |
|---|------|------|
| 14 | `data/x` 命中，且规则确为 `.gitignore` 第 N 行 `data/` | ✅ `.gitignore:6:data/` |
| 15 | `logs/x` 命中，且规则确为 `.gitignore` 第 N 行 `logs/` | ✅ `.gitignore:7:logs/` |
| 16 | `assets/x` **不**命中（exit 1、stdout 为空） | ✅ |
| 17 | 嵌套路径：`data/tasks/x`、`logs/2026/x.log` 命中；`assets/skills/x.md` 不命中 | ✅ |
| 18 | `git ls-files` 中无 `(^|/)(data|logs)/` 已跟踪文件（无历史误提交） | ✅ 空集 |
| 19 | `.gitignore` 中 `data/`、`logs/` 各出现且仅出现一次（无重复/冲突条目） | ✅ |

### AC2 无旧路径兜底 / 无只读回落（4/4 ✅，静态检查）
| # | 用例 | 结果 |
|---|------|------|
| 20 | `resolveAssetsDir` 函数体内无 `existsSync`、无 `process.env` 直读、无 `data/(skills|strategy|tasks)`、无 `readdirSync`、无 `try {` | ✅ |
| 21 | `ensureAssetsDir` 函数体内无 `existsSync`、无旧路径判断、无 `copySync` / `renameSync` | ✅ |
| 22 | `resolveAssetsDir` 仅经 `resolveFinanceHomeDir()` 派生，不复用 `DATA_ROOT_ENV` / `resolveFinanceDataDir` | ✅ |
| 23 | 全文件中所有含 `assets` 的行不含 `legacy` / `migrat` / `fallback` / `backward` / `兼容旧` / `旧路径` / `existsSync` | ✅ |

---

## 三、实际执行命令与关键输出

### 1. 独立 spec（定向，非全量）
```bash
cd /Users/reachlucifer/project/opc/worktrees/dsh-finance-feat-task-1-assets-layer-root
pnpm vitest run tests/tester-t100462-assets-path.INDEPENDENT.spec.ts --reporter=verbose
```
```
 Test Files  1 passed (1)
      Tests  23 passed (23)
   Duration  544ms
```

### 2. 类型检查
```bash
pnpm exec tsc -p tsconfig.json --noEmit
# TSC_EXIT=0
```

### 3. 回归（路径 + flags 单测）
```bash
pnpm vitest run tests/paths.test.ts tests/flags.test.ts --reporter=verbose
```
```
 Test Files  2 passed (2)
      Tests  24 passed (24)
   Duration  167ms
```

### 4. .gitignore shell 独立验证
```bash
git check-ignore -v data/x    # .gitignore:6:data/	data/x        exit=0
git check-ignore -v logs/x    # .gitignore:7:logs/	logs/x        exit=0
git check-ignore -v assets/x  # (无输出)                            exit=1
git ls-files | grep -E '(^|/)(data|logs)/'   # 无输出，grep exit=1
```

### 5. 静态检查
```bash
grep -n "existsSync" src/paths.ts          # NO_existsSync
grep -rn "data/\(skills\|strategy\|tasks\)" src/   # 仅 scheduler 数据层既有注释/文档，无 assets 相关回落
git diff -- src/paths.ts                   # 仅追加 28 行（注释 + 2 个新函数）+ 2 行文档注释修改
```

### 6. 安全合规自检
```bash
ls -la ~/.dsh-ia            # NO ~/.dsh-ia —— 真实 home 未被任何用例创建/触碰
ls -la ~/.dsh-ia/assets     # NO ~/.dsh-ia/assets
git status --short          # 仅原有变更 + 本 spec + 本报告，未 add/commit/push
```

---

## 四、问题清单

### 阻塞缺陷
**无。** 4 条验收标准全部通过，23 条独立用例 + 24 条回归用例全绿，`tsc` exit 0。

### 建议改进（非阻塞，不影响本次验收）

1. **`.gitignore` 的 `data/` / `logs/` 未锚定仓库根**（低风险，未来潜在误伤）
   - 实测：`git check-ignore -v src/foo/data/x` → 命中 `.gitignore:6:data/`。
   - 即任意层级的同名目录都会被忽略；若后续在 `src/` 或测试目录下新增 `data/` 夹具目录，会被静默忽略而无法提交。
   - 建议改为根锚定：`/data/`、`/logs/`（如需同时覆盖任意层级可保留现状，但要接受该副作用）。

2. **`.gitignore` 文件末尾缺换行符**（极低风险）
   - 实测：`tail -c 1 .gitignore | xxd` → `2f`（`/`），即 `logs/` 后无 `\n`（该问题历史上已存在）。
   - 后续若用脚本 `>>` 追加条目，可能与 `logs/` 粘连成 `logs/xxx`。建议补一个行尾换行。

3. **`ensureAssetsDir()` 未收紧目录权限（`0o700`）**（设计待确认，非缺陷）
   - 同文件 `ensureFinanceLogDir()` 显式 `mode: 0o700` + `chmod` 兜底，而 assets 用默认 umask 权限（实测 `drwxr-xr-x` 视 umask 而定）。
   - 若 assets 的设计定位是「可共享、可整体导出」，当前默认权限合理；若未来含敏感策略配置，建议与 logs 对齐或明确文档化。**本次不阻塞。**

4. **文档残留旧路径语义**（范围外提示，供 Leader 决策）
   - `src/skills/skill-authorship/SKILL.md` 仍多处描述「创建或修改 `data/skills/` 下的 SKILL.md」，与本任务确立的 assets 层语义不一致。
   - 属后续迁移任务范围（本次仅地基，不涉及资产搬迁），**不计入本次缺陷**，仅提示避免后续实现按旧文档落盘。

---

## 五、测试过程说明（透明性）

- 本轮首次运行独立 spec 出现 1 条失败，定位为**测试自身断言写错**（`expect(dir).not.toContain(rel + '/assets')` —— 绝对路径必然包含该相对子串，被测实现实际正确）。已修正为「以 `/` 开头、不以相对串开头、无 `..`/`.` 段」三条断言后重跑全绿；**未修改任何被测产物**。
- 全程未运行 `pnpm test`（避免 `tests/tester-path-fixed-dir.INDEPENDENT.spec.ts` 的 `rmSync` 触碰真实 `~/.dsh-ia`）。
- 所有创建类用例均 `mkdtempSync(join(tmpdir(), 'tester-t100462-'))` + `DSH_IA_HOME` 隔离，`afterEach` 递归清理并恢复环境变量。
- 未执行 `git add` / `commit` / `push`；未修改 `src/paths.ts`、`.gitignore`、`tests/paths.test.ts`。

---

## 六、最终结论

**通过 ✅**

- 验收 1–4 全部满足，且有独立可复现证据（非复述 Developer 结论）。
- 隐患 0 项阻塞；3 条改进建议 + 1 条范围外文档提示，均可后续处理，不影响本次「三层物理分离地基」交付。

---

## Leader 修复记录（阶段 4，小问题）

- 采纳建议 1+2：`.gitignore` 的 `data/`、`logs/` 改为根锚定 `/data/`、`/logs/`，并补齐末尾换行。
  - 理由：避免误伤仓库内嵌套的 `src/**/data/` 目录；保留三层边界语义不变。
  - 复测：`check-ignore data/x`、`logs/x` 仍命中；`assets/x`、`src/foo/data/x` 均不命中。
- 同步将本 spec 中 4 处字面量断言改为容忍可选前导 `/`（不改变断言语义）。
- 复跑：`tsc --noEmit` exit 0；定向 3 文件 47/47 通过。
