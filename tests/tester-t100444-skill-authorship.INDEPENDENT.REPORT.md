# 独立测试报告 · t100444 · 固件 skill `skill-authorship`

- 被测交付物：`dsh-finance` 插件新增固件 skill `skill-authorship`（改动在工作区，**未 commit**）
- 项目路径：`/Users/reachlucifer/project/opc/dsh-finance`
- 测试文件：`tests/tester-t100444-skill-authorship.INDEPENDENT.spec.ts`（本文件由 Tester **独立编写**）
- 被测 HEAD：`4c3bead`（+ 工作区未提交改动：`src/skills/skill-authorship/SKILL.md`、`src/skills/index.ts`、`src/plugin.ts`、`src/skills/README.md` 及 Developer 同步修正的 6 个既有测试）
- 测试时间：2026-10-13

---

## 一、结论摘要

| 项 | 结果 |
|----|------|
| 独立用例总数 | 23 |
| 通过 | **23** |
| 失败 | 0 |
| 验收结论 | **通过（AC1–AC7 全部满足）** |
| 本次交付物相关缺陷 | **0** |

独立用例执行（`npx vitest run tests/tester-t100444-skill-authorship.INDEPENDENT.spec.ts --maxWorkers=1`）：
`Test Files 1 passed (1) · Tests 23 passed (23)`

---

## 二、逐条验收标准明细

### AC1 — 静态加载，不出现在 `data/skills/` 可进化清单 ✅
- **AC1a**：真实临时 dataRoot + 真实 `ensureSkillAssetsRepo()`，落盘目录集合 = `[...SKILL_NAMES].sort()`（动态派生，恰 5 个）；**不含** `skill-authorship` / `task-authorship`；递归文件树无 `skill-authorship` 路径；`SKILL.md` 恰 5 份。
  - 证据：`[EVIDENCE AC1a] dirs=analysis-decision,grid-strategy,stop-rule,strategy-authorship,trend-analysis`
- **AC1b**：真实 git——`git ls-files` 无 `skill-authorship/` 前缀文件；被追踪 `SKILL.md` 恰 5 份；`git status --porcelain` 空（工作区干净）；首版恰 1 个 commit。
  - 证据：`[EVIDENCE AC1b] tracked=6 commits=1`（6 = 5 SKILL.md + `.gitignore`）
- **AC1c（组合证据）**：磁盘可进化仓库**无** `skill-authorship`，却仍能静态组装注册对象（`source='runtime'`）→ 证明「随包静态加载」而非「数据目录发现」。

### AC2 — 静态注册对象契约 ✅
- **AC2a**：`name='skill-authorship'`、`source='runtime'`、`invocation={modelInvocable:true,userInvocable:true}`、`description` 非空、`whenToUse` 含 `data/skills/`。
- **AC2b**：`content` 与磁盘 `SKILL.md` 正文**逐字一致**——用**自写独立解析器**（正则+行切分，不 import 生产 `frontmatter.ts`）交叉核对；且与 `loadSkillAuthorshipMarkdown()` 正文一致（两解析器结论相同）。正文长度 1513 字节。
- **AC2c**：`description` / `whenToUse` 与磁盘 frontmatter 逐字一致。

### AC3 — 与 `task-authorship` 共存不冲突 ✅
- **AC3a（mock，store 版）**：`apply(ctx)` 后注册**恰 2 个**固件 skill（`task-authorship` + `skill-authorship`）；契约正确；两个 effect 标签齐备。
- **AC3c（mock）**：卸载 `skill-authorship` 的 effect → **只移除它**，`task-authorship` 保留；再卸载 `task-authorship` 才消失（互不误伤）。
- **AC-real1（真实）**：真实 `SkillRegistry` + 编译态 `dist-server` 装载：2 固件 `source=runtime` + 5 可进化 `source=custom` **共存**、名称唯一（无重名）；卸载插件 fiber 后**全部归零**（before=7 → after=0）。

### AC4 — SKILL.md frontmatter 合规 ✅
- **AC4a**：首行 `---`；`name='skill-authorship'`（= 目录名 = 常量），kebab-case；三字段 `name`/`description`/`whenToUse` 齐全非空。
- **AC4b**：`whenToUse` = 「即将创建或修改 data/skills/ 下的任何 SKILL.md 时。」——含具体触发场景（`data/skills/` + `SKILL.md`）+ 可判定动作（创建/修改）；**不含**泛泛措辞「需要时」。

### AC5 — 内容红线 ✅
- **AC5a**：正文含「结构契约 / whenToUse 写法规范 / 硬性红线 / 自检清单」骨架（`##` 标题齐备）。
- **AC5b**：全文**标的无关**——无 5/6 位数字串（股票代码）、无 `数字+（元|%|股|点|格|倍）` 价格/阈值、无 4 位以上连续数字。唯一数字为 Markdown 列表序号 `1.`/`2.`。
- **AC5c**：不塞固件实现细节——不含 `ctx.skills`、`createIntrinsicSkillRegistration`、`dist-server`、`plugin.ts`、`index.ts`、`readFileSync`、`ctx.effect` 等实现符号。

### AC6 — 与可进化 `strategy-authorship` 的区分 ✅
- **AC6a**：`SKILL.md` 正文点名 `strategy-authorship` 并标注「可进化 / 固件」区分（第 15–17 行「与 `strategy-authorship`（可进化）区分」）。
- **AC6b**：`README.md` 含「命名区分（勿混淆）」小节，同一行内配对标注 `skill-authorship … 固件` 与 `strategy-authorship … 可进化`。
- **AC6c**：`strategy-authorship` ∈ `SKILL_NAMES`（可进化清单），`skill-authorship` ∉ `SKILL_NAMES`。

### AC7 — 编译态 `dist-server` 可解析 ✅
- **AC7a**：`dist-server/skills/skill-authorship/SKILL.md` 存在，且与 `src` **逐字一致**。
- **AC7b**：编译态动态 import `dist-server/skills/index.js`，`loadSkillAuthorshipMarkdown()` / `createSkillAuthorshipRegistration()` 均可解析；契约与源态一致（`source='runtime'`、`invocation` 双开、`content` = 独立解析正文）；`SKILL_AUTHORSHIP_SKILL_NAME='skill-authorship'`，`SKILL_NAMES` 不含它。

---

## 三、对抗性检验结果

| 检验 | 用例 | 结果 |
|------|------|------|
| 重复注册同名「先到先得」 | AC-adv3（**真实 `SkillRegistry`**）：二次注册同名 `skill-authorship` → 第二个 disposer 为 no-op，不移除赢家；第一个 disposer 才移除 | ✅ |
| 注册抛错降级不抛 | AC-adv1：`register` 抛错 → `apply` **不抛**，effect 仍存在、disposer 安全 no-op | ✅ |
| 卸载幂等 | AC-adv2：effect disposer 连续两次调用 → 不抛、只注销一次（disposed=1） | ✅ |
| skills 服务缺失降级不中断装载 | AC3b：`get('skills')` 返回 undefined → `apply` 不抛、不注册、标签仍在 | ✅ |

---

## 四、覆盖说明与证据链独立性

本文件 **不复用** Developer 在 `prompt-skills.spec.ts` / `tester-t100432` / `tester-t100429` / `tester-t100433` 中修改过的断言，刻意采用不同证据链：

1. **frontmatter/正文**：自写独立解析器（正则 + 行切分，**不 import** 生产 `frontmatter.ts`），与生产解析器结论交叉比对。
2. **运行时三态**：自建 **store 版** mock ctx（`register` 以 `Map<name,reg>` 为后端、首名先到先得、disposer 删表项），独立观测注册/降级/卸载，与 Developer 的 register 替身模型不同。
3. **真实环境**：真实 `SkillRegistry` + 真实 `git init/commit` 临时 dataRoot + 编译态 `dist-server` 装载。
4. **仓库级守卫规避**（t100419 C1）：本文件不含被禁字面量；补跑 `t100419 C1` → `offenders=0`（含本新文件）。

---

## 五、既有失败区分说明（**与本次交付物无关**）

### 5.1 本次交付物相关结果（全绿）
- 独立用例 23/23 通过；
- Developer 同步修正的既有测试（单独运行，`--maxWorkers=1`）**69/69 通过**：
  - `tester-t100432-intrinsic-skill.INDEPENDENT.spec.ts`（18）
  - `tester-t100429-plugin-static-register.INDEPENDENT.spec.ts`（11）
  - `tester-t100433-seed-provision.INDEPENDENT.spec.ts`（10）
  - `tester-t100418-skill-assets.INDEPENDENT.spec.ts`（25）
  - `plugin-tools-registration.spec.ts`（5）
- `prompt-skills.spec.ts` 中与 skill-authorship 相关的断言**全部通过**（含「固有 SKILL：skill-authorship 常量与原文可读」「skills/skill-authorship/SKILL.md：不出现具体价格」「apply 仅静态注册 2 个固有 SKILL」）。

### 5.2 既有失败（不作为本次验收失败）
- `prompt-skills.spec.ts > 验收 1：advisor.md 人设内容 > 末尾明确「本内容不构成投资建议」`：
  - 断言 `md` 含 `本内容不构成投资建议`，但该声明已被近期提交 `145a784`/`4c3bead` 删除 → **既有不同步**，与本次改动无关。
  - 复现：`npx vitest run tests/prompt-skills.spec.ts` → `1 failed | 33 passed`（唯一失败即此条）。
- 交易时段 wall-clock 失败（`tester-tools-runtime.spec.ts` 等）：依赖 9:30–11:30 / 13:00–15:00 连续竞价时段，当前为非交易时段 → 既有 wall-clock 依赖，未纳入本次执行范围。
- 并行下 chokidar+git flaky 超时：本报告全部命令均以 `--maxWorkers=1` 单独运行，无超时。

---

## 六、外部命令结果（避免「测试内跑测试」）

| 命令 | 结果 |
|------|------|
| `npx tsc -p tsconfig.json --noEmit`（typecheck） | **EXIT=0** |
| `npx vitest run tests/tester-t100444-*.spec.ts --maxWorkers=1` | **23/23 通过** |
| `dist-server` 产物 | 已就绪（Leader 已 `pnpm build`）；`dist-server/skills/skill-authorship/SKILL.md` 与 `index.js` 均存在且可解析 |
| `t100419 C1`（仓库守卫，含新文件） | offenders=0 ✅ |

> 注：`tsconfig.json` 的 `include` 仅含 `src/**/*.ts`（测试文件不在其内），故 typecheck 覆盖的是**生产代码**编译态；测试文件由 vitest 转译执行（已通过）。

---

## 七、未通过项 / 风险点

- **未通过项**：无。
- **风险/建议**：
  1. `prompt-skills.spec.ts` 的 advisor 声明断言属既有不同步失败，建议由 Leader 一并调度（删除该断言或补回声明），否则全量 `pnpm test` 仍会红。
  2. 全量并行（默认 `maxWorkers=4`）下 chokidar+git 用例偶发超时属既有 flaky，建议关键 provider 用例单独运行或维持当前并发上限。

---

## 八、交付确认

- 测试文件：`tests/tester-t100444-skill-authorship.INDEPENDENT.spec.ts`
- 本报告：`tests/tester-t100444-skill-authorship.INDEPENDENT.REPORT.md`
- **未 commit**（工作区改动保持原样）。
