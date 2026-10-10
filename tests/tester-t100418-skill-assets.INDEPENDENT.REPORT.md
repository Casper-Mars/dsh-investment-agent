# 独立测试报告 — t100418 skill 资产迁移到运行时数据目录并 git 化

- **任务**：t100418
- **被验对象（工作树，未 commit）**：`src/skills/repo.ts`(新增)、`src/paths.ts`、`src/tools/context.ts`、`src/plugin.ts`、`tests/skill-assets-repo.spec.ts`(Developer)
- **独立测试文件**：`tests/tester-t100418-skill-assets.INDEPENDENT.spec.ts`（25 用例，对抗/边界导向）
- **环境**：节点 Reach的MacBook Pro；Node v25.9.0 / pnpm 11.7.0 / git 2.50.1(Apple Git-155)；macOS
- **判定日期**：2026-10-10

---

## 一、总体结论

**✅ 通过。** 4 条原始验收标准 + 全部额外约束逐条满足；独立测试 25/25 通过，全量回归 typecheck/build/test 全绿。
另有 1 处**非阻断性局限**（⚠ 见第五节）与 1 处**观察项**，均不构成验收失败。

| 验收标准 | 判定 | 关键证据 |
|---|---|---|
| 1. `<dataRoot>/skills` 下 6 skill 齐全（各含 `SKILL.md`），`git log` 有首版 commit | ✅ 通过 | E2E：tree 恰 6 目录；`git log --oneline` 恰 1 条 `init: skill 资产首版` |
| 2. 全新环境首启自动预置（幂等：再次不重复 init/commit） | ✅ 通过 | ①-3 调用序列断言「已就绪仅 `rev-parse --verify HEAD`，无 init/add/commit」；②-2 commit 数不增 |
| 3. 目录名 / 文件名 `SKILL.md` / frontmatter `name` 三者一致 | ✅ 通过 | ④ 落盘 6 份经 `frontmatter.ts` 解析：dir===name===期望名；源码目录集合===`SKILL_NAMES` |
| 4.（回归）`pnpm typecheck` / `pnpm test` / `pnpm build` | ✅ 通过 | 见第四节（独立复跑，非自述数字） |

---

## 二、额外约束逐条核验

| 约束 | 判定 | 证据（用例） |
|---|---|---|
| 幂等：已就绪再次调用 → 完全 no-op（commit 不增、内容不变） | ✅ | ①-3（调用序列）、②-2（commit 数 & 逐字节不变）、⑤-4（半初始化后二次 no-op） |
| 降级：git 不可用 / 命令失败 / 无写权限 / 种子异常 → 记日志、降级不抛、不中断装载 | ✅ | ③-1/2/3/4；⑦-2（插件层仍装载） |
| 6 份 `SKILL.md` 与随包种子逐字节一致 | ✅ | ②-1（同时对比 `src` 与 `dist-server` 种子）、②-3（编译态） |
| 不污染真实 `~/.dsh-finance`（用 `os.tmpdir()`） | ✅ | ⑥-3 断言产物均在 tmpdir 下、真实 `~/.dsh-finance/data/skills` 未被本文件新建 |

---

## 三、测试内容与通过/失败明细（25/25 通过）

### ① 独立 mock 断言：调用序列（注入 `gitRunner`）
- `全新目录 → init + add -A + 恰 1 次 commit`：✅ 序列含 `init -b main`、`add -A`，`commit` 计数 === 1。
- `init -b main 不支持时回落普通 git init，仍只 commit 一次`：✅ 观察到 `init -b main`（抛错）→ `init`（回落）。
- `已就绪仓库 → no-op：不调用 init/add/commit`：✅ 调用序列**精确等于** `['rev-parse --verify HEAD']`（仅 HEAD 探测）。

### ② 真实进程 / 真实 git E2E
- 冷启动：✅ 目录 `= <dataRoot>/skills`；`.git` 存在；落盘集合 === `SKILL_NAMES`(6)；6 份逐字节 === `src` 种子 且 === `dist-server` 种子；`git log --oneline` 恰 1 条、message=`init: skill 资产首版`、分支 `main`、`git status --porcelain` 空。
- 幂等：✅ 二/三次调用 `provisioned=false`、`degraded=false`、commit 数不变、内容逐字节不变、status 干净。
- **编译态 E2E（关键）**：✅ 独立 `node` 子进程 `import(dist-server/skills/repo.js)` 预置临时 dataRoot → `provisioned=true`、6 份逐字节 === 源码种子、commit 恰 1、status 干净（证明 `dist-server/skills/*.md` 种子可读可用）。

**原始证据（真实运行，dist-server 产物）：**
```
[dsh-finance/skills] 冷启动预置完成：/…/T/tmp.iCJrAxU9ye/skills（6 个 skill，message="init: skill 资产首版"）
=== git log --oneline ===
b3838b0 init: skill 资产首版
=== git status --porcelain (expect empty) ===
(end)
=== branch ===  main
=== tree ===  analysis-decision grid-strategy stop-rule strategy-authorship task-authorship trend-analysis
=== sha256 seed-identity ===  (6/6) IDENTICAL
=== rev-list --count HEAD ===  1
```

### ③ 降级独立验证（均「不抛 + degraded」）
- git 不可用（runner 抛 `ENOENT`）：✅ 不抛、`degraded=true`、无 `.git`、日志含「降级」。
- commit 阶段非零退出：✅ 不抛、`degraded=true`、提交数 0。
- 路径不可创建（`<repoDir>` 被普通文件占位，等价无写权限）：✅ 不抛、`degraded=true`、日志含「降级」。
- 种子读取异常（`vi.mock` 令 `loadSkillMarkdown` 抛错）：✅ 不抛、`degraded=true`、未落盘（无 `.git`）。

### ④ 一致性
- 种子：✅ 恰 6、kebab-case、目录名===frontmatter.name、description/正文非空。
- 源码目录集合 === `SKILL_NAMES`，每个目录含 `SKILL.md`：✅。
- 落盘后：✅ 目录名===文件名 `SKILL.md`===frontmatter.name；落盘目录集合 === `SKILL_NAMES`。

### ⑤ 空 / 半初始化 → 均预置且**恰一次**首版 commit
- 缺失目录、无 `.git`(空)、无 `.git`(有种子)、有 `.git` 无提交(有种子)、仅空目录、`git init` 后仅空目录：✅ 六种状态 `provisioned=true` 且 `commitCount===1`；半初始化场景二次调用 no-op 且 commit 仍 1。
- `.gitignore` 不忽略 skill 内容（`git check-ignore` 未命中）+ 工作区干净：✅。

### ⑥ 路径护栏 / 优先级 / 不污染
- `resolveDataRoot`：注入 > env > 默认（空白注入回落 env）：✅ 注入优先时 env 目录未被创建。
- env 生效：✅ 仓库落在 `<env>/skills`。
- 不污染：✅ 产物均在 `os.tmpdir()` 下；真实 `~/.dsh-finance/data/skills` 未被本文件新建。

### ⑦ 插件装配（`apply` 接线）
- 最小上下文 + env 指向临时目录：✅ `apply` 不抛，落盘 `<env>/skills`（`.git` + 6 skill + commit 1）。
- `<env>/skills` 被文件占位（预置必失败）：✅ `apply` 仍不抛，装载不中断（内部降级）。

---

## 四、全量回归数字（独立复跑）

| 命令 | 结果 | 退出码 |
|---|---|---|
| `pnpm typecheck` (`tsc -p tsconfig.json --noEmit`) | 无错误 | **0** |
| `pnpm build` (`clean && tsc --noEmit && tsc -p tsconfig.server.json && copy-assets`) | 成功，搬运 11 个资源（含 6 个 `SKILL.md`） | **0** |
| `pnpm test` (`vitest run`) | **Test Files 49 passed / Tests 979 passed / 0 failed** | **0** |
| 本独立 spec | **25/25 passed** | **0** |

> 注：构建顺序为先 `build`（生成 `dist-server` 供编译态 E2E）→ 再 `test`，二者独立复跑，未采信 Developer 自述。

---

## 五、反向验证（护栏有效性）

临时关闭两道幂等护栏（`inspectRepo` 恒 `needsProvision=true` + `provisionRepo` 恒提交），单独复跑「已就绪 → no-op」用例：
- 结果 **FAIL**：`expected true to be false`（`second.degraded`），证明 no-op 判据与「仅当有变更时提交」两道护栏**均为承载性逻辑**，非空转。
- 验证后 **原样还原**：`src/skills/repo.ts` sha256 `9cf4ce3f…67adf0` 编辑前后一致（`RESTORE_OK`），工作树无残留改动。

---

## 六、风险与遗留问题

1. **⚠ 非阻断局限 — 已就绪仓库的「部分缺失」不自动修复（未纳入本次验收标准）**
   `inspectRepo` 的「就绪」判据是 `有 .git + 有任一 skill 内容 + 有 HEAD`。若仓库已有提交但 6 个 skill **不齐**（如人为删掉 1 个已 commit），`ensureSkillAssetsRepo` 会判 no-op、**不补齐**缺失 skill。
   - 依据：`repo.ts` 设计注释明确「仅当**缺失或为空**时预置」；验收标准 1 只要求**正常预置后** 6 个齐全，未要求「自愈式修复」。
   - 建议：若未来需要「收敛到 6 个」语义，需显式扩展判定（超出本任务范围）。**不影响本次验收结论。**

2. **观察项 — 仓库「无 skill 内容但已有外部提交」时会产生第 2 个提交**
   该状态不在验收枚举内（枚举为「有 .git 但无提交」）。此时预置仍会 `add -A` 后提交一次，最终 commit 数 = 既有 + 1。功能正确（6 skill 齐、status 干净），但「首版 commit」语义在「已有外部提交」前提下不成立。属可接受的边界语义，记录备查。

3. **提示（非缺陷）** — `apply` 内另有独立 `try/catch` 包裹 `ensureSkillAssetsRepo()`；因该函数内部已「降级不抛」，外层 catch 为冗余保险带（未单独以 mock 触发，本次以真实降级路径 ⑦-2 验证装载不中断）。

4. **测试卫生** — 本独立 spec 全部使用 `os.tmpdir()` 临时目录、`afterEach` 清理，`DSH_FINANCE_DATA_DIR` 保存/还原；未产生项目内残留文件。

---

## 七、交付物

- `tests/tester-t100418-skill-assets.INDEPENDENT.spec.ts`（25 用例，全绿）
- `tests/tester-t100418-skill-assets.INDEPENDENT.REPORT.md`（本文件）
- **未 commit**（按约束由 Leader 统一提交）。

**工作树状态（供 Leader 核对）**：
```
 M src/paths.ts
 M src/plugin.ts
 M src/tools/context.ts
?? src/skills/repo.ts
?? tests/skill-assets-repo.spec.ts
?? tests/tester-t100418-skill-assets.INDEPENDENT.spec.ts
?? tests/tester-t100418-skill-assets.INDEPENDENT.REPORT.md
```
