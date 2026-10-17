# 独立测试报告 — 任务-02「skill 资产迁出到 assets/skills」（t100464）

- **测试时间**：2026-10-17 11:13–11:16 (CST)
- **测试节点**：Reach的MacBook Pro（macOS，Node v25.6.0 / pnpm 11.7.0 / git 2.50）
- **仓库**：`/Users/reachlucifer/project/opc/dsh-finance`
- **分支 / commit**：`feat/task-2-assets-skills` / `4b55eca`（`feat(paths): 新增资产层根目录解析…`）
- **工作区状态**：3 个源码文件 + 14 个测试文件为**未提交改动**；另有未跟踪目录 `src/skills/finance-evolution/`
- **测试方式**：独立编写 spec（不复用 Developer 断言）+ 定向执行既有测试 + 静态检查
- **安全声明**：未运行全量 `pnpm test`；未 `git add/commit/push`；未修改 `src/**` 与 Developer 的测试文件；所有用例目录均为 `mkdtempSync(tmpdir())`，未读写真实 `~/.dsh-ia`

## 一、总体结论

**通过。** 验收 1–3 与额外必测 4–8 全部成立，未发现阻塞性缺陷（P0/P1 = 0）。

发现 1 处**低优先级文档漂移**（`src/skills/index.ts` / `README.md` 注释仍写 `<dataRoot>/skills`，不影响运行与验收 6 的代码语义），以及 2 类**已知基线噪声**（均已独立核实，与本次改动无关）。

## 二、验收逐条结论

| 编号 | 验收项 | 结论 | 关键证据 |
|---|---|---|---|
| 1 | 冷启动 + 热更新 | ✅ 通过 | 冷启动后 provider 从 `<assetsDir>/skills` 列出**恰好 5 个**可进化 skill，正文与磁盘一致；改写 `trend-analysis/SKILL.md` 的 description/正文后，未重启、未重新 mount，`list()`/`get()` 在 ~1.4s 内取到新值 |
| 2 | 独立 git 仓库 + 显式作者 | ✅ 通过 | `rev-parse --show-toplevel` == `assets/skills`（独立于主仓库）；首版恰 1 commit，message = `init: skill 资产首版`；`GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null` 下作者/提交者均为 `dsh-ia <dsh-ia@localhost>`；用「敌意全局 config（HOST-ONLY-USER）」复测仍为 `dsh-ia`，证明不依赖宿主机 git config |
| 3 | 类型与定向测试 | ✅ 通过 | `pnpm typecheck` → `TSC_EXIT=0`；`skill-assets-repo.spec.ts` + `skill-provider.spec.ts` = **26/26 全绿**；扩展定向批（8 文件）**127 passed / 1 failed**，唯一失败为已知 `finance-evolution` 计数基线（见 §四） |
| 4 | 旧路径彻底消失 | ✅ 通过 | `ensureSkillAssetsRepo({assetsDir: <tmp>/assets})` 后 `<tmp>/data`、`<tmp>/data/skills` 均不存在；`DSH_IA_HOME=<tmp>` 时 `<tmp>/data/skills` 不存在；同时 `HOME` 指向假 home 验证 `fakeHome/.dsh-ia` 未被创建 |
| 5 | 环境变量语义 | ✅ 通过 | `DSH_IA_HOME=<tmp>/home` → 默认落点 `<tmp>/home/assets/skills`；**预置一个带旧 skills 内容的 `DSH_IA_DATA_DIR` 目录后仍写新路径**（`provisioned:true`，旧目录无 `.git`、无 `trend-analysis`），明确断言 `DSH_IA_DATA_DIR` 不再影响 skills 路径 |
| 6 | 无兼容别名 | ✅ 通过 | `grep -rn "dataRoot" src/skills/repo.ts src/skills/provider.ts src/plugin.ts` → **无输出（exit 1）**；独立 spec 另断言三文件不出现 `dataRoot` 与 `DSH_IA_DATA_DIR`，且均含 `assetsDir` |
| 7 | 幂等 | ✅ 通过 | 连续两次 ensure：第二次 `provisioned:false`、`degraded:false`，`git rev-list --count HEAD` 保持 1，5 份 SKILL.md 逐字节不变，`git status --porcelain` 为空 |
| 8 | 降级语义 | ✅ 通过 | 注入全程抛错的 `gitRunner` → 不抛异常、`degraded:true`、`provisioned:false`、无 `.git`；仅 `commit` 阶段失败 → 同样 `degraded:true`、commit 数 0 |

## 三、独立 spec 用例明细

文件：`tests/tester-t100464-skills-assets.INDEPENDENT.spec.ts`（新增，未提交）
执行：`npx vitest run tests/tester-t100464-skills-assets.INDEPENDENT.spec.ts`
结果：**12/12 passed（exit 0，4.9s）**

| # | 用例 | 结果 |
|---|---|---|
| 1 | AC1 冷启动 5 skill + 改写 SKILL.md 热更新（默认 watch） | ✅ |
| 2 | AC2 assets/skills 为独立 git 仓库、首版 1 commit、工作区干净 | ✅ |
| 3 | AC2 清空全局/系统 git config 后作者/提交者仍为 dsh-ia | ✅ |
| 4 | AC2 敌意宿主机 config 不被采用 | ✅ |
| 5 | AC4 显式 assetsDir 时不产生 `data/`、`data/skills` | ✅ |
| 6 | AC4 `DSH_IA_HOME` 默认路径不产生 `data/skills`，假 home 不被触碰 | ✅ |
| 7 | AC5 `DSH_IA_HOME` 决定 `<home>/assets/skills` | ✅ |
| 8 | AC5 `DSH_IA_DATA_DIR`（含旧 skills 残留）不影响落点 | ✅ |
| 9 | AC6 三文件无 `dataRoot` / `DSH_IA_DATA_DIR`，均有 `assetsDir` | ✅ |
| 10 | AC7 二次调用 `provisioned:false`、commit 数/内容不变 | ✅ |
| 11 | AC8 gitRunner 全程抛错 → 降级不抛 | ✅ |
| 12 | AC8 仅 commit 失败 → 降级不抛、0 commit | ✅ |

## 四、实际命令与关键输出

### 1) 类型检查

```bash
cd /Users/reachlucifer/project/opc/dsh-finance && pnpm typecheck
# TSC_EXIT=0（无任何错误输出）
```

### 2) 静态检查：兼容别名已消失

```bash
grep -rn "dataRoot" src/skills/repo.ts src/skills/provider.ts src/plugin.ts
# （无输出，GREP_EXIT=1）
```

### 3) 核心定向测试（repo / provider / 热更新）

```bash
npx vitest run tests/skill-assets-repo.spec.ts tests/skill-provider.spec.ts
```

关键输出：

```text
✓ tests/skill-provider.spec.ts (8 tests) 5672ms
  ✓ watch 热更新 > 改写 SKILL.md 的 description/正文 → watch invalidate → 下次 list()/get() 取到新内容
✓ tests/skill-assets-repo.spec.ts (18 tests) 9422ms
  ✓ ⑥ … 首版 commit 作者显式注入为 dsh-ia <dsh-ia@localhost>（不依赖宿主机 git config）
  ✓ ⑤ 与 DSH_IA_HOME 覆盖联动 > env 覆盖 home：仓库落在 <home>/assets/skills
Test Files  2 passed (2)
     Tests  26 passed (26)
```

### 4) 扩展定向批（8 个相关 spec）

```bash
npx vitest run \
  tests/skill-assets-repo.spec.ts tests/skill-provider.spec.ts \
  tests/tester-t100418-skill-assets.INDEPENDENT.spec.ts \
  tests/tester-t100419-skill-provider.INDEPENDENT.spec.ts \
  tests/tester-t100432-intrinsic-skill.INDEPENDENT.spec.ts \
  tests/tester-t100433-seed-provision.INDEPENDENT.spec.ts \
  tests/tester-t100444-skill-authorship.INDEPENDENT.spec.ts \
  tests/tester-t100429-plugin-static-register.INDEPENDENT.spec.ts
```

关键输出：

```text
Test Files  1 failed | 7 passed (8)
     Tests  1 failed | 127 passed (128)
FAIL tests/tester-t100418-skill-assets.INDEPENDENT.spec.ts > ④ 三者一致 + SKILL_NAMES 对齐 > 源码目录集合 === 5 个可进化 SKILL + 固有 SKILL
  + "finance-evolution"
```

### 5) 独立 spec

```bash
npx vitest run tests/tester-t100464-skills-assets.INDEPENDENT.spec.ts --reporter=verbose
# Test Files  1 passed (1)
#      Tests  12 passed (12)
```

### 6) 基线噪声复核

```bash
git diff HEAD -- src/prompts/advisor.md      # 无改动
git show 4b55eca:src/prompts/advisor.md | grep -c "趋势跟随"   # 0
grep -n "趋势跟随" tests/prompt-skills.spec.ts                # 102 行仍断言
grep -n "幻方" src/prompts/advisor.md                         # 3 行：幻方量化基金经理
```

```bash
npx vitest run tests/prompt-skills.spec.ts tests/tester-prompt-skills.INDEPENDENT.spec.ts \
  tests/plugin-tools-registration.spec.ts tests/file-exporter.test.ts
# Test Files  2 failed | 2 passed (4)
#      Tests  3 failed | 95 passed (98)
# 失败全部为 advisor.md 基线：缺「趋势跟随」与「# 原则」板块
```

## 五、问题分级

| 级别 | 项 | 说明 | 建议 |
|---|---|---|---|
| P0 | 无 | — | — |
| P1 | 无 | — | — |
| P2（低，文档） | `src/skills/index.ts` 注释仍写 `<dataRoot>/skills`（2 处） | 仅注释漂移，运行语义与验收 6 均不受影响（`repo.ts`/`provider.ts`/`plugin.ts` 已无 `dataRoot`）；`src/skills/README.md` 第 9 行同 | 后续随文档同步改为 `<assetsDir>/skills` |
| 基线噪声 | `advisor.md` 人设变更导致 3 个测试失败 | 工作区 `src/prompts/advisor.md` 与 HEAD 一致（未改），HEAD 已是「幻方量化基金经理」，而测试仍断言「趋势跟随」/「# 原则」；main 基线即失败 | 与本任务无关，不计缺陷；建议另立任务同步测试或人设 |
| 基线噪声 | 未跟踪目录 `src/skills/finance-evolution/` 导致计数失败 | `tester-t100418` 的「源码目录集合」期望 7 个，实际 8 个（多 `finance-evolution`）；本批仅观察到 **1 个**此类计数失败（Leader 提到 2 个，其余定向 spec 均绿） | 属工作区未跟踪资产，不计本次缺陷；建议清理或纳入正式任务 |
| 噪声（非缺陷） | `ctx.plugin is not a function` stderr | 出现在 `skill-provider.spec.ts` 的 mock/最小 ctx 降级路径，用例本身通过，正是设计的「降级不抛」 | 无需处理 |

## 六、风险与建议

1. **热更新依赖 chokidar 时序**：本次实测 ~1.4s 内生效；仓库已有 `maxWorkers: 4` 约束，定向运行稳定。建议 CI 继续保留该并发上限。
2. **预置「已就绪」判定偏宽**：`inspectRepo` 只要「有任一 SKILL.md + 有 HEAD」即 no-op，若用户误删其中 1 个 skill，不会自动补回。属既有设计（幂等优先），非本次回归；如需自愈可另立任务。
3. **`pnpm typecheck` 不含 tests**：`tsconfig.json` 仅 include `src/**/*.ts`，独立 spec 由 vitest 转译执行（本次全绿），但不受 `tsc --noEmit` 静态检查覆盖；若要求测试也类型检查，可增补 `tsconfig.test.json`。
4. **清理**：未启动中间件；临时目录均由 `afterEach` 删除，无需 `docker compose down`。

## 七、交付物

- `tests/tester-t100464-skills-assets.INDEPENDENT.spec.ts` — 12 用例，全绿（未提交）
- 本报告：`tests/tester-t100464-skills-assets.INDEPENDENT.REPORT.md`
