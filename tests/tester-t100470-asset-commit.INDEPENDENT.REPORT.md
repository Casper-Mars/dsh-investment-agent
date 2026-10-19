# t100470 任务-02「资产写入即 commit」独立运行时验证报告

- **被测交付物**：`/Users/reachlucifer/project/opc/dsh-finance`
  - 基线 `HEAD=6b53bd5`（`feat(assets): assets 单一仓库接管 skills，移除嵌套 git 仓 (t100469)`）+ 工作区未提交改动
  - 新增未提交：`src/assets/commit.ts`、`src/tools/assets.ts`、`tests/assets-commit.test.ts`
  - 修改未提交：`src/scheduler/store.ts`、`src/scheduler/index.ts`、`src/tools/index.ts`、`src/tools/schemas.ts` 等
- **验证者**：Tester（独立运行时验证，深度 1 subagent）
- **日期**：2026-10-19
- **环境**：macOS（`/private/var` 符号链接路径），Node `v25.9.0`，pnpm `11.7.0`，vitest `3.2.7`
- **验证方式**：全部使用 `mkdtemp` 临时 home + **真实 git 子进程**取证；`DSH_IA_HOME` 指向临时目录并在用例后还原；未读写真实 `~/.dsh-ia`
- **独立产出**：`tests/tester-t100470-asset-commit.INDEPENDENT.spec.ts`（63 用例）
- **约束遵守**：未修改 `src/**`、未 commit、未 push；仅新增本 spec 与本报告。

## 结论总览

| # | 验收标准 | 结果 | 关键证据（独立可观察事实） |
|---|----------|------|----------------------------|
| AC1 | 改 task / program / skill 后各有对应 commit，作者 `dsh-ia` | ✅ PASS | 三类资产各产生独立 commit；`%an <%ae>` 与 `%cn <%ce>` 均为 `dsh-ia <dsh-ia@localhost>`；全部历史逐条核对 |
| AC2 | 连续两次相同写入不产生空 commit | ✅ PASS | `commitAssets` / `TaskStore.save` / `TaskStore.remove` / `asset_commit` 四条路径均验证：第二次 `committed=false`，`rev-list --count HEAD` 不变 |
| AC3 | 三种资产都能在同一 assets git log 中查到 | ✅ PASS | 同一仓库 3 次提交，`git log --pretty=%s --name-only` 同时含 `skills/...`、`programs/...`、`tasks/...`；`rev-parse --show-toplevel` = assetsDir |
| AC4 | 覆盖成功与 git 失败两条路径 | ✅ PASS | 成功：create/update/delete 全动作；失败：add 阶段抛错、仅 commit 阶段抛错、缺 `.git` 三种注入 |
| AC5 | commit message 含相对路径与动作 create/update/delete | ✅ PASS | 单动作与单 commit 混合三动作均逐条命中：`assets: create …`、`assets: update …`、`assets: delete …` |
| AC6 | git 失败降级告警，不中断业务（文件仍落盘） | ✅ PASS | 注入抛错 runner 到 `commitAssets` / `TaskStore.save` / `TaskStore.remove` / `asset_commit`：全程不抛、文件存在/删除成功、告警含「降级」 |
| AC7 | skill 直接写文件后有统一提交入口 `asset_commit` | ✅ PASS | 直接写盘后为 `?? skills/...`，调用 `asset_commit`（不传 assetsDir，走 `DSH_IA_HOME`）→ create；再编辑 → update；删除 → delete |

**缺陷清单**：无 P0/P1/P2 缺陷。独立 spec **63/63 全绿**。

---

## 1. 成功路径与动作语义

| 场景 | 结果 |
|------|------|
| skill create（`commitAssets`） | ✅ `assets: create skills/demo/SKILL.md`，作者/提交者 `dsh-ia`，commit 仅含该文件 |
| program create（`asset_commit` 工具） | ✅ `assets: create programs/pulse/task.ts`，输出 `files=[{action:'create'}]` |
| task create → update → delete（真实 `TaskStore`） | ✅ 3 次 commit，subject 分别为 `create` / `update` / `delete tasks/pulse.json`，作者均为 `dsh-ia` |
| 单 commit 混合三动作 | ✅ 同时 `create skills/new/SKILL.md`、`update strategies/s.md`、`delete programs/p/task.ts`，`files` 长度 3 |
| 自定义 message 前缀 | ✅ `feat(skill): demo 首版: create skills/demo/SKILL.md`（前缀保留，动作+路径仍追加） |
| 三资产共享单一历史 | ✅ 3 次提交同属一个仓库，log 同时含三类路径 |

## 2. 重点对抗场景

### 2.1 只提交指定路径（不被无关改动污染）

| 场景 | 断言 | 结果 |
|------|------|------|
| 仓库有无关未跟踪文件 `noise.txt` + `skills/other/SKILL.md` | HEAD 只含目标 `skills/target/SKILL.md`；无关文件仍为 `??` | ✅ |
| 无关文件已 `git add`（`A  noise.txt`） | HEAD 只含目标；`noise.txt` 仍为 `A  noise.txt`，`git ls-tree HEAD -- noise.txt` 为空 | ✅ |
| 无关文件是**另一资产**的 staged 修改（`strategies/other.md`） | HEAD 只含目标；该文件仍 `M  `；`git show HEAD:strategies/other.md` 仍为 v1 | ✅ |
| 多个目标路径一次提交 | message 逐一列出；HEAD 恰含两个目标；`noise.txt` 仍 `??` | ✅ |

### 2.2 幂等 / 无空 commit

| 入口 | 连续两次相同内容 | 结果 |
|------|------------------|------|
| `commitAssets` | 第二次 `committed=false`、`degraded=false`、`files=[]`、reason 含 `no-op` | ✅ |
| `TaskStore.save`（同 TaskDef 两次；改名后再同值两次） | commit 数分别保持 1 / 2 | ✅ |
| `TaskStore.remove` 第二次 | 返回 `false`，commit 数不变 | ✅ |
| `asset_commit` 工具第二次 | `committed=false`，commit 数保持 1 | ✅ |

### 2.3 作者身份不依赖宿主机配置

- 构造敌对全局 git config（`user.name=Host Machine`）+ 敌对 `GIT_AUTHOR_*` / `GIT_COMMITTER_*` 环境变量。
- 被测代码提交后：作者与提交者均为 `dsh-ia <dsh-ia@localhost>`。
- 同时用普通 `git config --get user.name` 证明敌对配置**确实生效**（返回 `Host Machine`），排除「配置未生效」造成的假阳性。
- task / program / skill 三次提交的历史作者逐条核对，全部 `dsh-ia`。

### 2.4 git 失败降级（不中断业务）

| 注入方式 | 断言 | 结果 |
|----------|------|------|
| `commitAssets` + 始终抛错 runner | `degraded=true`、`committed=false`、告警含「降级」、文件内容原样、commit 数 0 | ✅ |
| `TaskStore.save` + 抛错 runner | 不抛、`tasks/<id>.json` 落盘且可读、告警含「降级」 | ✅ |
| `TaskStore.remove` + 抛错 runner | 不抛、文件已删、第二次 remove 返回 false、无新 commit | ✅ |
| `asset_commit` + 抛错 runner | `degraded=true`、输出通过 output schema 严格校验、文件仍在 | ✅ |
| 仅 `commit` 子命令失败（add/status 正常） | `degraded=true`、无新 commit、文件仍在、告警 | ✅ |
| 仓库缺 `.git` | `commitAssets` / `asset_commit` 均降级返回不抛，且**不会自动 init** | ✅ |
| `tasksDir` 不在 `assetsDir` 下 | 跳过提交并告警「不在资产目录内」，文件仍落盘 | ✅ |

### 2.5 非法路径（抛错且零 commit）

15 种输入 × 2 个入口（`normalizeAssetPath`/`commitAssets` 与 `asset_commit` 工具）：

`/etc/passwd`、`C:/Windows/system.ini`、`../outside.txt`、`skills/../tasks/x.json`、
`skills/.git/config`、`.git/config`、`skills/.GIT/config`、`skills/demo\SKILL.md`、
`..\outside.txt`、`data/ledger.json`、`noise.txt`、`skills`、`skills//SKILL.md`、
`skills/./SKILL.md`、空字符串。

- 全部抛 `AssetPathError`；仓库 commit 数保持 0。
- 空 `paths` 数组同样抛 `AssetPathError`。
- 合法四前缀 `skills/ tasks/ programs/ strategies/` 全部接受；重复路径去重，message 不重复。
- 目标文件存在但传入非法路径时：仍 `??`，未被 add 进任何 commit。

### 2.6 真实链路

| 链路 | 结果 |
|------|------|
| 临时 `DSH_IA_HOME` + 真实 `TaskStore` + `createSchedulerTools`：`task_create` → `task_update` → `task_delete` | ✅ 3 次 commit、动作正确、作者 `dsh-ia`、`reload()` 恰 3 次、删除后 `task_list` 为空 |
| 直接写 SKILL → `asset_commit`（默认 env 解析）→ 再编辑 → 再提交 | ✅ create / update 两次提交，工作区状态由 `??` 变 clean |
| program + SKILL 一次 `asset_commit` | ✅ 单 commit 含两文件，正文逐字节不变（含中文与多行） |
| `asset_commit` 指向不存在路径 | ✅ `committed=false`，不会凭空创建文件 |
| `rm` skill 后 `asset_commit` | ✅ `delete skills/demo/SKILL.md` |

### 2.7 插件装载可见性

| 断言 | 结果 |
|------|------|
| 真实 `Context` + `ToolRuntime` + 真实插件 `apply`：`ctx.tools.schemas()` 恰好 **22** 个，名称唯一，含 `asset_commit` 与 `task_create` | ✅ |
| dispose 插件 fiber 后工具数归 0 | ✅ |
| `createAllTools` 恰好 **15** 个且含 `asset_commit`，不含 `task_*`（scheduler 工具） | ✅ |

> stderr 中 `skill-filesystem provider 挂载失败（INACTIVE_EFFECT）` 来自插件 dispose 与异步 provider 挂载的既有竞态，不影响工具注册断言，属既有噪声。

---

## 3. 用例统计

| 分组 | 用例数 |
|------|--------|
| AC1/AC3/AC5 成功路径 | 6 |
| AC2 幂等 / 无空 commit | 4 |
| 只提交指定路径 | 4 |
| 作者身份 | 2 |
| AC4/AC6 降级 | 7 |
| 非法路径对抗（15×2 + 3） | 33 |
| 真实链路 task_create/update/delete | 1 |
| AC7 program / SKILL 直写 + asset_commit | 4 |
| 插件装载（22 / 15） | 2 |
| **合计** | **63** |

独立执行：`63 passed (63)`，耗时约 17.2s。

```bash
pnpm exec vitest run tests/tester-t100470-asset-commit.INDEPENDENT.spec.ts --reporter=dot
# Test Files  1 passed (1)
#      Tests  63 passed (63)
```

全量回归（含本 spec）：

```bash
pnpm exec vitest run --reporter=dot
# Test Files  5 failed | 81 passed (86)
#      Tests  8 failed | 1816 passed (1824)
```

8 条失败与任务说明给出的**已知基线完全一致**，无新增回归：

- `tests/scheduler-wake.test.ts`（4 条，历史文案漂移）
- `tests/tester-t100438-trace-context.INDEPENDENT.spec.ts`（1 条）
- `tests/tester-task11-scheduler-chain-integration.INDEPENDENT.spec.ts`（1 条）
- `tests/tester-strategy-feature.INDEPENDENT.spec.ts`（1 条）
- `tests/tester-task14-dsh-version-align.INDEPENDENT.spec.ts` B5（1 条）

---

## 4. 问题与建议

### 4.1 阻断性缺陷

无。

### 4.2 非阻断观察（不改变本次 AC 结论）

1. **`asset_commit` 指向不存在路径时被归类为「降级」而非 no-op。**
   实测：`git add -- skills/ghost/SKILL.md` 因 pathspec 不存在而失败 → `degraded=true`，
   工具 render 文案为「文件已写入，但未进入 git」，但文件实际并不存在。
   本次 AC 未要求该行为；若希望语义更精确，可在 `git add` 前做 `existsSync` 判定，
   或将该类 pathspec 错误映射为 `committed=false, degraded=false` 的 no-op。
   当前行为安全（不写文件、不产生 commit），仅文案略有误导。

2. **仅隔离了 git 身份，未隔离其它可能影响 commit 的宿主机配置。**
   作者/提交者已固定为 `dsh-ia`，不依赖 `user.name` / `user.email`。但若用户全局启用
   `commit.gpgsign=true`、失败的 `commit-msg` hook 等，commit 仍会失败并走 AC6 降级
   （业务不中断，但资产不会进入历史）。这是 AC6 允许的降级路径，不是本次缺陷；
   若希望资产提交在任意宿主配置下都稳定成功，可考虑追加
   `-c commit.gpgsign=false` 与 `--no-verify`（当前实现未加）。

3. **`git commit -- <paths>` 会保留无关文件的 staged 状态。**
   这是期望行为（本次对抗用例已验证不会带走），但意味着提交后工作区可能仍有
   `A/M ` 状态；使用方不应把「提交成功」等同于「工作区干净」。

---

## 5. 交付物

1. `tests/tester-t100470-asset-commit.INDEPENDENT.spec.ts`（63 用例，全绿）
2. `tests/tester-t100470-asset-commit.INDEPENDENT.REPORT.md`（本文件）

未修改 `src/**`，未执行 `git commit` / `git push`。
