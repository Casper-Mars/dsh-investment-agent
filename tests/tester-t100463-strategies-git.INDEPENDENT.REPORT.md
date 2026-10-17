# 独立测试报告 —— Task-3「策略资产迁出到 assets/strategies，版本改由 git 承担」

| 项 | 内容 |
|---|---|
| 被测 worktree | `/Users/reachlucifer/project/opc/worktrees/dsh-finance-feat-task-3-strategies` |
| 分支 / HEAD | `feat/task-3-strategies` / `58485a8` |
| 目标节点 | Reach的MacBook Pro（macOS 26.4，Node v25.9.0，pnpm 11.7.0，git 2.50.1） |
| 独立 spec | `tests/tester-t100463-strategies-git.INDEPENDENT.spec.ts`（19 用例，全绿） |
| 测试日期 | 2026-10-17 |
| **结论** | **通过（12/12 验收项全部满足）**，无 P0/P1/P2 缺陷；发现 3 项低风险 + 3 项提示级观察，均不阻塞交付 |

> 说明：本报告结论全部来自 Tester 独立编写的 spec 与独立执行的命令，未复述 Developer 自检结论。
> 安全约束遵守情况：未运行全量 `pnpm test`；全部用例目录经 `mkdtempSync(join(tmpdir(),...))` + `DSH_IA_HOME`/显式 `assetsDir` 隔离；真实 `~/.dsh-ia` 仅只读断言，未被写入（证据见 §3.6）。

---

## 一、验收结论（验收 1–5）

| # | 验收标准 | 结论 | 关键证据 |
|---|---|---|---|
| 1 | 策略读写落 `assets/strategies/<symbol>.md`；不产生 `strategy_versions/`、`vNNN*`、`current` | ✅ 通过 | 3 次写入后磁盘仅 `strategies/588000.md`、`strategies/000001.md`、`.git`、`.gitignore`；全树正则扫描 `/(^|\/)v\d{3,}(\.|$)/`、`/(^|\/)current$/`、`*.meta.json` 命中 0；`assets/strategy_versions`、`assets/strategy`、`data/strategy*` 均不存在 |
| 2 | 正文与输入逐字节一致，无额外 frontmatter（首行非 `---`） | ✅ 通过 | CRLF + 尾随换行 + 中文 + emoji 正文：`readFileSync` 的 Buffer `.equals(Buffer.from(text,'utf8'))` 为 true，`git show HEAD:path` 字符串完全相等，首字节 `0x2d` 断言失败（即非 `-`）；实现只在 `set` 中 `writeFileSync(text)`，无任何拼接 |
| 3 | 每次变更产生恰好一次 git commit；历史可 `git log`/`git show` 回溯 | ✅ 通过 | 3 次变更 → `git rev-list --count --all` = 3；`git log --format=%H -- strategies/588000.md` 恰好 3 条；每个短 SHA 均可 `git show <sha>:path` 取回对应正文与 rationale；首次提交额外携带 `.gitignore` 仍为同一个 commit（无额外提交） |
| 4 | 历史回读按 git 实现（含回滚 = revert） | ✅ 通过 | `get(sym, v1)` 取回旧正文/旧 rationale；`list` 正序且 parent 链正确；真实执行 `git revert --no-edit <v2>` 后 `current()` 前进到 revert commit、正文回到 v1、`meta.rationale` 含 `Revert`，`get(sym, v2)` 仍返回 v2 正文，commit 数 3 |
| 5 | `tsc --noEmit` EXIT=0；策略/版本相关定向测试全绿 | ✅ 通过（含基线噪声说明） | `npx tsc -p tsconfig.json --noEmit` → `EXIT=0`；定向测试 283 passed / 1 failed，唯一失败为**与本任务无关的 main 既有噪声**（见 §5） |

---

## 二、额外必测项（6–12）

| # | 必测项 | 结论 | 关键证据 |
|---|---|---|---|
| 6 | `DSH_IA_HOME=<tmp>` 下无旧路径写入，真实 `~/.dsh-ia` 不被触碰 | ✅ 通过 | 只设 `DSH_IA_HOME`、清空 `DSH_IA_DATA_DIR`，`createToolContext()` 全默认解析 + `ledger_init` + `strategy_set` 后：`<tmp>/assets/strategies/T100463.md` 正确落盘；`<tmp>/data/strategy`、`<tmp>/data/strategy_versions`、`<tmp>/data/T100463` 均不存在；真实 `~/.dsh-ia` 下同名探针路径运行前后存在性一致；实测本机 `~/.dsh-ia` 仅含 `data/`（mtime 11:07，早于本次测试 11:34），无 `assets/`、无 `data/strategy*` |
| 7 | 外层仓库结构：`.git` 存在；`.gitignore` 含 `skills/`；`git ls-files` 无 skills 条目；无 gitlink `160000`；嵌套 `skills/.git` 历史不受影响 | ✅ 通过 | 先建独立 `assets/skills` 仓库（1 commit）再初始化外层仓库并写 2 版策略：`assets/.git` 存在；`.gitignore` 含 `skills/`；`git ls-files` 无任何 `skills/` 前缀条目，含 `strategies/588000.md`、`.gitignore`；`git ls-tree -r HEAD` 无 `160000` 模式、无 `skills/` 条目；`git status --porcelain` 为空（skills 被忽略，无 untracked 噪声）；`skills` 的 `rev-parse HEAD` 与 commit 数与操作前完全一致 |
| 8 | 并发乐观校验：同一 parentVersion 连续两次 set，第二次必须抛错 | ✅ 通过 | v1→v2（parent=v1）成功后，再用 parent=v1 写 third-writer：抛 `parentVersion ... 与当前版 ... 不一致`；磁盘正文仍为 `first-writer`，`current()` 仍为 v2，commit 数保持 2 |
| 9 | 失败语义：注入抛错 gitRunner 时 set 抛错；get 行为明确 | ✅ 通过 | `set` 抛 `Error`（消息含「资产层 git 仓库不可用 / git ... 失败」），不是返回 `false`，且未产生半写文件；`get`/`get(旧SHA)`/`list`/`current` 在 git 不可用时统一**返回 `undefined` / `[]`**（不抛、不返回半成结果）——本报告按「返回 undefined」这一分支确认 |
| 10 | 历史读取健壮性：`deadbeef`、`../`、`v001` 等 → `undefined`，不崩溃、不穿越 | ✅ 通过 | 13 个非法输入（`deadbeef`、12 位不存在 SHA、`../escape`、`../../escape`、`..`、`.`、`v001`、`v001.md`、`current`、65 字符超长、`a/b`、`a:b`、`HEAD~1`）全部不抛错且返回 `undefined`；无 `escape.md` 越界文件；非法 symbol 的 `get` 返回 `undefined`、`set` 抛 `[path-guard] symbol 非法` |
| 11 | 内容一致 no-op：不产生空提交，返回当前短 SHA | ✅ 通过 | 相同 text+rationale 连续两次：commit 数不变、返回同一 SHA；相同 text + 不同 rationale 同样不新增 commit（文本语义版本） |
| 12 | 工具层契约：`strategy_set` → `{ok:true, version:12hex}`；`strategy_get` 默认当前版 / 旧 SHA 历史正文；`parent_version` 不符报错而非覆盖 | ✅ 通过 | `strategy_set` 返回键恰为 `['ok','version']`，`version` 匹配 `/^[0-9a-f]{12}$/`，`validateJsonSchemaValue` 零违规；`strategy_get` 默认返回 `{symbol,text,version,updated_at}` 且 `updated_at === git show -s --format=%aI <sha>`；旧 SHA 返回旧正文/旧版本；旧 `parent_version` 提交被拒且磁盘内容未被覆盖；未 `ledger_init` 的标的被拒绝且不落盘 |

---

## 三、执行命令与关键输出

### 3.1 类型检查（验收 5）
```bash
cd /Users/reachlucifer/project/opc/worktrees/dsh-finance-feat-task-3-strategies
npx tsc -p tsconfig.json --noEmit
# → EXIT=0
```

### 3.2 独立 spec（交付物 1）
```bash
npx vitest run tests/tester-t100463-strategies-git.INDEPENDENT.spec.ts
# → Test Files  1 passed (1)
#   Tests  19 passed (19)          Duration 26.05s
```

### 3.3 策略/版本相关定向测试（验收 5）

| 批次 | 文件 | 结果 |
|---|---|---|
| A0 | `strategy.test.ts`(15) | 1 file / **15 passed** |
| A | `tools.test.ts`(30)、`tester-task18-strategy-tools`(15)、`tester-task17-strategy`(11) | 3 files / **56 passed** |
| B | `tester-t100462-assets-path`(23)、`tester-t100464-skills-assets`(12)、`tester-path-guard`(32)、`skill-assets-repo`(18) | 4 files / **107 passed** |
| B | `tester-strategy-feature`(23) | **22 passed / 1 failed**（基线噪声，见 §5） |
| C | `thresholds.test.ts`(21)、`tester-task19-thresholds`(25)、`tester-tools-runtime`(17)、`path-guard.test.ts`(20) | 4 files / **83 passed** |

合计定向执行：**283 passed / 1 failed（唯一失败为 main 既有噪声）**。

### 3.4 基线噪声核实（`prompt-skills.spec.ts`）
```bash
npx vitest run tests/prompt-skills.spec.ts
# → Tests  2 failed | 32 passed (34)
#   FAIL 验收 1 > 包含角色 / 原则 / 工作流 / 合规四大板块
#   FAIL 验收 1 > 体现「不执行真实交易」「趋势跟随」「防守优先」等核心约束
```
核实结论：
- `git diff main -- src/prompts/advisor.md tests/prompt-skills.spec.ts` **为空**（两文件与本任务分支前完全一致）；
- `git show main:tests/tester-strategy-feature.INDEPENDENT.spec.ts` 中存在同一条 `expect(steps).toHaveLength(6)` 断言，而 `git show main:src/prompts/advisor.md | grep -c "^[一二三四五六七]、"` = **0** → 该断言在 main 上同样必然失败；
- 故 `prompt-skills.spec.ts` 的 2 个失败与 `tester-strategy-feature` 的 1 个失败均为**基线噪声**，非本任务引入。

另：任务卡提到的「未跟踪目录 `src/skills/finance-evolution/` 导致计数失败」在本 worktree **未复现**——`src/skills/` 下无该目录，`git status --short` 除本报告新增的 spec 外干净。

### 3.5 独立探针（仅用于风险定性，探针文件已删除）
| 探针 | 观察结果 | 定性 |
|---|---|---|
| `set({by:'tester-xxx'})` | `meta.by === 'dsh-ia'` | `by` 入参被忽略（commit 作者恒为 dsh-ia） |
| 注入「commit 阶段抛错」的 gitRunner | `set` 抛错，但工作区正文已是新文本；随后 `get()` 返回「新正文 + 旧 SHA」 | commit 失败会留下脏工作区，版本/正文可能不一致 |
| `core.autocrlf=input` + CRLF 正文 | 磁盘文件仍为 CRLF；`git show HEAD:path` 返回 LF | 历史回读的字节一致性依赖宿主机 git 配置 |
| `rationale: ''` | 抛错（git 原始错误 `Aborting commit due to empty commit message`） | 可用但报错信息偏底层 |

---

## 四、问题分级

| 级别 | 问题 | 说明 / 建议 |
|---|---|---|
| P0–P2 | 无 | 12 项验收全部满足 |
| **P3（低）** | R1：commit 阶段失败会留下未提交的新正文，`get()` 此时返回「新正文 + 旧版本 SHA」 | 仅当 git commit 失败（pre-commit hook 拒绝 / 磁盘满 / 权限）时出现。建议 `set` 在 commit 失败时回滚工作区文件到 HEAD 版本，或 `get` 在 worktree 与 HEAD 不一致时以 HEAD 为准（并在 meta 上暴露 dirty 标记）。不影响正常路径 |
| **P3（低）** | R2：`StrategyVersionInput.by` 成为死参数 | `set` 未使用 `by`，`meta.by` 恒为 git 作者 `dsh-ia`。若契约仍承诺 `by`，建议删除该字段或在 commit 时映射为作者/尾注；若已废弃请在类型注释标注 deprecated |
| **P3（低，环境相关）** | R3：历史正文的字节一致性依赖宿主机 git 配置 | `defaultGitRunner` 未固定 `core.autocrlf=false`。在 `core.autocrlf=input/true` 的机器上，CRLF 会被规范化进 blob，`git show` 回读为 LF（工作区文件仍逐字节一致）。建议 `-c core.autocrlf=false -c core.eol=lf` 固定，或在文档声明该前提。本机（未设置 autocrlf）无此问题 |
| P4（提示） | R4：不存在的历史 SHA 与「尚未设定策略」返回同一条引导错误 | `strategy_get(sym, 'deadbeefdead')` 报「尚无策略文档，请先 strategy_set」，对“版本不存在”场景略有误导。建议区分「该版本不存在」与「尚无策略」 |
| P4（提示） | R5：空 `rationale` 报 git 原始错误 | 建议工具层前置校验非空并给出中文提示 |
| P4（提示） | R6：`version` 接受合法 ref 名 | `assertSafeSegment` 允许字母，`get(sym,'HEAD')`/`'main'` 会返回当前版。无安全影响（不越界、不写盘），如要求严格 SHA 可加 `/^[0-9a-f]{7,40}$/` 校验 |

**残留风险（说明性）**：`parent_version` 校验为「读 HEAD → 比较 → 提交」，跨进程无锁；两个进程同时以同一 parent 写入时理论上都可能通过校验（后提交者覆盖）。串行场景（验收 8 口径）已严格报错；如需强并发保证需引入文件锁。当前设计（乐观校验为可选）可接受。

---

## 五、交付物清单

| 文件 | 状态 |
|---|---|
| `tests/tester-t100463-strategies-git.INDEPENDENT.spec.ts` | 新增，**untracked**（未 `git add`/`commit`，留给 Leader 提交）；19 用例全绿 |
| `tests/tester-t100463-strategies-git.INDEPENDENT.REPORT.md` | 本报告 |

未修改任何被测源码（`src/**`）与 Developer 测试文件；`git status --short` 仅显示上述两个 untracked 文件，HEAD 仍为 `58485a8`。

---

## 六、结论

**通过。** 验收 1–5 与额外 6–12 全部满足，实现质量良好：git 单一执行器抽象清晰、正文零污染、提交粒度精确、历史/revert 回读可靠、路径与非法版本防护到位、工具层契约与 schema 对齐。发现的问题均为低风险健壮性/一致性打磨项（R1–R3）与提示级体验项（R4–R6），不阻塞本任务验收，建议由 Leader 决定是否纳入后续清理。
