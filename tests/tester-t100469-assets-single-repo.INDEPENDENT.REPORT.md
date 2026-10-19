# t100469 任务-01｜assets 单一仓库初始化接入（含 skills）— 独立测试报告

- **测试者**：Tester（独立验收，未复用 Developer 断言）
- **被测代码**：`main` 工作区（HEAD `98acaad` + 未提交改动，15+ 文件；未 commit / 未 push / 未改 `src/**`）
- **测试文件**：`tests/tester-t100469-assets-single-repo.INDEPENDENT.spec.ts`（20 用例）
- **环境**：macOS（Reach的MacBook Pro）｜Node v25.9.0｜pnpm 11.7.0｜git 2.50.1
- **隔离**：全部写入 `mkdtempSync()` 临时目录，`DSH_IA_HOME` 指向临时 home；真实 `~/.dsh-ia/assets` 仅执行只读命令

---

## 一、结论摘要

| 项 | 结果 |
|---|---|
| 本次独立用例 | **20 / 20 通过**（约 14s） |
| 定向回归（12 个相关测试文件） | **226 / 226 通过**（`--maxWorkers=2`，EXIT 0） |
| `pnpm typecheck` | **通过**（EXIT 0，无输出） |
| 全量回归（`--maxWorkers=2`） | 1738 用例：**1730 通过 / 8 失败**，失败文件 **5 个 = 已知基线集合**，无新增失败 |
| 全量回归（默认 `maxWorkers=4`） | 1738 用例：1728 通过 / 10 失败；额外 2 个为 `tester-prompt-skills` **5s 超时**（单跑 33/33 全绿、定向批跑亦全绿，判定为并发负载抖动，非回归） |
| 验收标准 | **AC1–AC8 全部通过** |
| 阻塞缺陷 | **无** |
| 风险 | 3 项中/低风险（见第五节），均不阻塞本任务验收 |

---

## 二、逐条验收结论

### AC1 `~/.dsh-ia/assets/.git` 存在且为唯一仓，`assets/skills/.git` 不存在 —— ✅ 通过

- 临时 home 真实 `apply(ctx)` 冷启动后：
  - `existsSync(<assets>/.git) === true`
  - `existsSync(<assets>/skills/.git) === false`
- 全量 `git ls-files` 只含外层仓库条目，skills 下无子模块/gitlink。
- 本机真实目录只读核对：
  ```
  $ ls -ld ~/.dsh-ia/assets/skills/.git
  ls: .../assets/skills/.git: No such file or directory
  ```
  存在 `~/.dsh-ia/assets/.git`。

### AC2 `git status` 能看到 `skills` 下文件本身（不是 gitlink）—— ✅ 通过

- `git ls-files -s -- skills` 返回 5 条，mode **全部为 `100644`**，断言中显式 `not.toContain('160000')`。
- 冷启动后 `git --no-optional-locks status --porcelain` 为空（文件均已入库）。
- `git check-ignore -q -- skills/<name>/SKILL.md` 非零退出（未被忽略）。
- 本机真实目录：
  ```
  100644 4c9ca68... 0	skills/.gitignore
  100644 613f828... 0	skills/analysis-decision/SKILL.md
  100644 525a033... 0	skills/grid-strategy/SKILL.md
  100644 69303c6... 0	skills/stop-rule/SKILL.md
  100644 3f78089... 0	skills/strategy-authorship/SKILL.md
  100644 c25257b... 0	skills/trend-analysis/SKILL.md
  ```
  无 `160000`。

### AC3 首次提交包含 5 个 `skills/<name>/SKILL.md`（不含固有 SKILL）—— ✅ 通过

`git ls-tree -r --name-only HEAD` 精确等于：

```
.gitignore
skills/analysis-decision/SKILL.md
skills/grid-strategy/SKILL.md
skills/stop-rule/SKILL.md
skills/strategy-authorship/SKILL.md
skills/trend-analysis/SKILL.md
```

- commit 数 = 1，subject = `init: 资产仓库首版`。
- `task-authorship` / `skill-authorship` / `finance-evolution` 目录均不存在。
- 5 份 SKILL.md 的**磁盘内容与 HEAD 内容均逐字节等于随包种子**（`src/skills/<name>/SKILL.md`），无 CRLF 规范化。
- 本机真实仓库：`git rev-list --count HEAD = 1`，tracked 列表 = `.gitignore` + 5 个 `SKILL.md`（另有 1 个遗留 `skills/.gitignore`，见风险 R5）。

### AC4 二次启动 no-op，不产生新 commit —— ✅ 通过

- 同一 home 连续两次 `apply()`：commit 数恒为 1，`rev-parse HEAD` 完全不变，`git log` 仅 1 条。
- 对抗：已有 HEAD + 修改 `SKILL.md` + 新增未跟踪文件 → 再启动：
  - commit 数 / HEAD 不变；
  - `git diff --cached --name-only` 为空（**未 add**）；
  - status 保留 ` M skills/...`、`?? agent-note.md`；
  - 磁盘保留 agent 编辑，HEAD 仍是种子原文。
- 已有 HEAD + 删除 SKILL.md → 启动按种子**补齐**（内容与 HEAD 一致，工作区仍干净），不产生新 commit。

### AC5 相关测试更新后全绿 —— ✅ 通过

```bash
pnpm typecheck
# → EXIT=0

npx vitest run --maxWorkers=2 \
  tests/skill-assets-repo.spec.ts \
  tests/tester-t100464-skills-assets.INDEPENDENT.spec.ts \
  tests/tester-t100418-skill-assets.INDEPENDENT.spec.ts \
  tests/tester-t100463-strategies-git.INDEPENDENT.spec.ts \
  tests/tester-t100433-seed-provision.INDEPENDENT.spec.ts \
  tests/tester-t100444-skill-authorship.INDEPENDENT.spec.ts \
  tests/tester-t100432-intrinsic-skill.INDEPENDENT.spec.ts \
  tests/plugin-tools-registration.spec.ts \
  tests/prompt-skills.spec.ts \
  tests/skill-provider.spec.ts \
  tests/tester-prompt-skills.INDEPENDENT.spec.ts \
  tests/tester-t100469-assets-single-repo.INDEPENDENT.spec.ts
# → Test Files 12 passed (12) | Tests 226 passed (226) | EXIT=0
```

全量对照：

```bash
npx vitest run --maxWorkers=2     # 84 文件 / 1738 用例
# → Test Files 5 failed | 79 passed (84) | Tests 8 failed | 1730 passed (1738)

npx vitest run                    # 默认 maxWorkers=4
# → Test Files 6 failed | 78 passed (84) | Tests 10 failed | 1728 passed (1738)
```

两轮失败的 5 个文件均落在任务给定的已知基线集合内（`scheduler-wake` 4、`tester-t100438` 1、
`tester-task11` 1、`tester-strategy-feature` 1、`tester-task14` 1）；
默认 4 worker 轮次额外多出的 2 个是 `tester-prompt-skills` 的 5s 超时，
该文件单跑 **33/33 全绿**、定向批跑亦全绿，属并发负载抖动，非本任务回归。

### AC6 本机存量 `~/.dsh-ia/assets/skills/.git` 已删除（只读核对）—— ✅ 通过

只读命令（未写入 / 未删除）：

```
$ ls -ld ~/.dsh-ia/assets/skills/.git
No such file or directory
$ git -C ~/.dsh-ia/assets rev-list --count HEAD
1
$ git -C ~/.dsh-ia/assets --no-optional-locks status --porcelain
（空）
$ ls -1 ~/.dsh-ia/assets/skills
analysis-decision  grid-strategy  stop-rule  strategy-authorship  trend-analysis
```

### AC7 `.gitignore` 不再排除 `skills/`，只留 `.DS_Store` / `*.tmp` 等 —— ✅ 通过

冷启动后 `.gitignore` 内容**逐字节等于** `ASSETS_GITIGNORE`：

```
# 仅忽略系统/临时文件；skills / strategies / programs / tasks 一律纳入版本管理。
.DS_Store
*.tmp
```

- 正则断言无 `^\s*\/?skills\/?\s*$` 匹配；
- 历史规则 `skills/` 与变体 `/skills/` 均被就地升级清除；
- 非历史自定义 `.gitignore`（不含 skills 排除）**原样保留**，不被重写；
- `check-ignore` 对 `skills/<name>/SKILL.md` 未命中。

### AC8 失败降级：git 不可用 / 无写权限 / 种子读取失败 → 装载不中断 —— ✅ 通过

| 场景 | 结果 |
|---|---|
| `PATH=''`（git 不可用，真实 spawn 失败） | `ensureAssetsRepo` 返回 `degraded:true`、`initialized:false`；`apply()` 不抛；5 个 SKILL.md 仍落盘；`commitAssetsChanges` `degraded:true, committed:false`；无 `.git` |
| 资产目录 `chmod 0555`（无写权限） | `ensureAssetsRepo` `degraded:true`；`apply()` 不抛；无 `.git`；恢复权限后清理正常 |
| `skills` 路径被普通文件占位（落盘失败） | `apply()` 不抛；占位文件内容未被破坏；外层仓库仍可初始化 |
| commit 阶段失败（存量嵌套仓导致 `git add -A` 失败） | `commitAssetsChanges` `degraded:true, committed:false`，不抛 |

---

## 三、对抗场景结果（全部通过）

| 场景 | 断言结果 |
|---|---|
| 有 `.git` 无 HEAD + 已有 agent 编辑的 SKILL.md | 首提 1 个，HEAD 保留编辑内容；其余 4 个由种子补齐；全 100644 |
| 有种子无 `.git` | 初始化 + 首提，既有种子不被覆盖，文件树精确匹配 |
| 只有空 `assets/` 目录 | 正常初始化 + 首提 |
| `assets/` 整体缺失 | 自动创建 + 首提 |
| 历史 `.gitignore` 含 `skills/` / `/skills/` | 就地移除，skills 入库 |
| 已有 HEAD + 修改 + 新增未跟踪文件 | 严格 no-op：不 add、不 commit、脏改动逐字节保留 |
| gitlink 检查 | 冷启动全链路 `ls-files -s` 无 `160000`，5 个 SKILL.md 全 `100644` |
| 真实进程验证 | 真实 `apply(ctx)`（最小 mock ctx）+ 真实 `git init/add/commit/rev-parse`，未使用 mock runner 替代核心链路 |

---

## 四、发现的问题

**无阻塞缺陷。** AC1–AC8 全部满足，无新增测试失败。

---

## 五、风险点与建议

### R1（中）存量嵌套 `skills/.git` 未自动清理，首提可能「静默降级」或产生 gitlink

代码只检查外层 `.git`，不处理存量 `<assets>/skills/.git`。实测两种存量形态：

1. **嵌套仓有提交** → 外层 `git add -A` 输出 `warning: adding embedded git repository: skills`，`git ls-files -s` 得到
   `160000 ... skills`（gitlink，内容不进外层历史）。
2. **嵌套仓无提交** → `git add -A` 直接失败：
   ```
   error: 'skills/' does not have a commit checked out
   fatal: adding files failed
   ```
   导致首次快照**永远不产生 HEAD**，每次启动都走降级分支（资产仓库长期无提交）。

本机已人工删除，故 AC1/AC6 通过；但这是「依赖人工迁移」的隐式前提。
**建议**：启动时若检测到 `<assets>/skills/.git`，显式告警并按既定迁移策略处理（删除嵌套 `.git` 后再 init/提交），或至少让降级原因在日志中足够醒目。

### R2（低）`.gitignore` 升级为整文件覆盖，会丢弃用户自定义规则

`ensureGitignore` 检测到 `skills/` 排除后直接 `writeFileSync(ASSETS_GITIGNORE)`。
实测输入 `skills/\nnode_modules/\n.DS_Store\n`，升级后 `node_modules/` 规则消失。
**建议**：改为「逐行删除 skills 规则 + 保留其余行」，或仅在文件内容与模板一致时才整体覆盖。

### R3（低）启动会把被删除的 SKILL.md 重新种回

幂等落盘语义是「缺就补」，因此 agent 若有意删除某个 SKILL.md，下次启动会被种子复活
（内容与 HEAD 一致时不留脏改动）。属设计取舍，但「删除类编辑」无法通过该路径持久化，
建议在 skill 进化流程文档中明确。

### R4（低）并发/多进程启动未覆盖

两个进程同时对同一空 home 执行 `apply()` 时，`git init` / 首次提交存在竞态窗口
（本次未测）。单进程场景（dsh 常规启动）不受影响。

### R5（信息）本机遗留 `skills/.gitignore`

真实仓库 tracked 列表含 `skills/.gitignore`（100644，内容仅 `.DS_Store` / `*.tmp`），
是旧嵌套仓遗留文件，无功能影响；如需纯净可人工删除后提交。

---

## 六、未覆盖 / 测试限制

1. **编译态（`dist-server`）E2E 未执行**：避免在未提交工作区触发构建产物变更。
   provider 路径以源码态 + mock `ctx.plugin` 捕获 `customSkillDirs` 验证为
   `<assetsDir>/skills`，`includeDefaultRoots:false`。
2. **「种子读取失败」未真实模拟**：需破坏随包 `SKILL.md` 或 mock ESM 模块；
   同一 `catch` 分支已由「skills 路径被普通文件占位」用例覆盖，降级语义一致。
3. **无写权限**以 `chmod 0555` 模拟，未覆盖磁盘满 / ACL / 只读挂载等系统级错误。
4. **真实 `~/.dsh-ia` 仅只读核对**，未做任何写入验证（符合任务要求）。
5. 全量回归在默认 4 worker 下存在既有并发抖动（provider/watch 类用例 5s 超时），
   与本次改动无关；判定以 `--maxWorkers=2` 结果为准。
