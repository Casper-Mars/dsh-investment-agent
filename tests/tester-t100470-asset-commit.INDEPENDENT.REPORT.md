# t100470 任务-02「资产写入即 commit」独立运行时验证报告

- **被测仓库**：`/Users/reachlucifer/project/opc/dsh-finance`
- **被测版本**：`HEAD=274d713d6bf6`（`feat(assets): 资产写入即 commit（skills / tasks / programs）(t100470)`），分支 `main`；最终复跑时工作区干净
- **验证者**：Tester（独立运行时验证，深度 1 subagent）
- **验证日期**：2026-10-19（Asia/Shanghai）
- **环境**：macOS arm64，Node `v25.9.0`，pnpm `11.7.0`，vitest `3.2.7`
- **验证文件**：`tests/tester-t100470-asset-commit.INDEPENDENT.spec.ts`（63 用例）
- **隔离方式**：每个用例使用 `mkdtemp` 临时 home，`DSH_IA_HOME` 指向临时目录并在用例后还原；全部用真实 `git` 子进程取证；未读写真实 `~/.dsh-ia`
- **约束**：未修改 `src/**`，未 `git commit` / `git push`

## 结论

**AC1–AC7 全部 PASS；独立 spec 63/63 全绿；定向回归 113/113 全绿；未发现阻断性缺陷。**

| # | 验收标准 | 结果 |
|---|----------|------|
| AC1 | 改 task / program / skill 后各自有 commit，作者 `dsh-ia` | ✅ PASS |
| AC2 | 连续两次相同写入不产生空 commit | ✅ PASS |
| AC3 | 三种资产共享同一 assets git log | ✅ PASS |
| AC4 | 成功路径 + git 失败路径均覆盖 | ✅ PASS |
| AC5 | commit message 含相对路径与动作 create/update/delete | ✅ PASS |
| AC6 | git 失败降级告警、不中断业务（文件仍落盘） | ✅ PASS |
| AC7 | skill 直接写文件后有统一提交入口 `asset_commit` | ✅ PASS |

---

## 1. 执行命令与结果

### 1.1 独立验证 spec

```bash
pnpm vitest run tests/tester-t100470-asset-commit.INDEPENDENT.spec.ts
```

```text
 ✓ tests/tester-t100470-asset-commit.INDEPENDENT.spec.ts (63 tests) 16850ms
 Test Files  1 passed (1)
      Tests  63 passed (63)
   Duration  16.85s
EXIT:0
```

> 说明：首次执行时机器上另有一个全量测试进程并发运行，曾出现一次 Vitest 内部
> `Timeout calling "onTaskUpdate"` 且进程未自动退出；隔离复跑（上述结果）无该告警、
> 正常退出。这是测试运行器的资源竞争噪声，不是产品失败。

### 1.2 定向回归

```bash
pnpm vitest run \
  tests/assets-commit.test.ts \
  tests/store.test.ts \
  tests/tools.test.ts \
  tests/tester-tools-runtime.spec.ts \
  tests/plugin-tools-registration.spec.ts
```

```text
 ✓ tests/plugin-tools-registration.spec.ts (5 tests)   4045ms
 ✓ tests/tester-tools-runtime.spec.ts     (17 tests)   4419ms
 ✓ tests/store.test.ts                    (38 tests)     26ms
 ✓ tests/tools.test.ts                    (30 tests)   5682ms
 ✓ tests/assets-commit.test.ts            (23 tests)   8309ms
 Test Files  5 passed (5)
      Tests  113 passed (113)
   Duration  8.62s
EXIT:0
```

---

## 2. 逐条 AC 证据

### AC1 改 task / program / skill 后各自有 commit，作者 `dsh-ia` —— ✅ PASS

- **skill**：`commitAssets({paths:['skills/demo/SKILL.md']})` → `committed=true`，HEAD
  subject 为 `assets: create skills/demo/SKILL.md`，HEAD 只含该文件。
- **program**：经 `asset_commit` 工具提交 `programs/pulse/task.ts` →
  `assets: create programs/pulse/task.ts`。
- **task**：真实 `TaskStore.save` / `remove` 依次产生 3 次 commit：
  `create tasks/pulse.json` → `update tasks/pulse.json` → `delete tasks/pulse.json`。
- **作者/提交者**：`git log --pretty=%an <%ae>` 与 `%cn <%ce>` 均为
  `dsh-ia <dsh-ia@localhost>`；三类资产历史逐条核对一致。
- **不依赖宿主配置**：构造敌对全局 git config（`user.name=Host Machine`）与敌对
  `GIT_AUTHOR_*` / `GIT_COMMITTER_*` 后，提交身份仍为 `dsh-ia`；同时
  `git config --get user.name` 返回 `Host Machine`，证明敌对配置确实生效（排除假阳性）。

### AC2 连续两次相同写入不产生空 commit —— ✅ PASS

四条入口均验证第二次不再产生提交，`git rev-list --count HEAD` 保持不变：

| 入口 | 第二次结果 |
|------|------------|
| `commitAssets` | `committed=false`, `degraded=false`, `files=[]`, reason 含 `no-op` |
| `TaskStore.save`（同 TaskDef 两次；改名后再同值两次） | commit 数保持 1 / 2 |
| `TaskStore.remove`（第二次） | 返回 `false`，commit 数不变 |
| `asset_commit` 工具 | `committed=false`，commit 数保持 1 |

### AC3 三种资产共享同一 assets git log —— ✅ PASS

- skill / program / task 三次提交后 `commitCount=3`；
- `git log --pretty=%s --name-only` 同时包含 `skills/demo/SKILL.md`、
  `programs/pulse/task.ts`、`tasks/pulse.json`；
- `git rev-parse --show-toplevel` 与 `assetsDir` 的 `realpath` 相同，确认是单仓而非嵌套仓库。

### AC4 成功路径 + git 失败路径 —— ✅ PASS

成功侧覆盖 `create` / `update` / `delete` 三种动作，以及单 commit 混合三动作
（`create skills/new/SKILL.md`、`update strategies/s.md`、`delete programs/p/task.ts`）。

失败侧覆盖：

| 注入方式 | 结果 |
|----------|------|
| runner 始终抛错（add 阶段失败） | `degraded=true`、`committed=false`、0 新 commit |
| 仅 `commit` 子命令抛错（add/status 正常） | `degraded=true`、0 新 commit、文件仍在 |
| 仓库缺 `.git` | 降级返回、不抛、**不会自动 init** |
| `tasksDir` 不在 `assetsDir` 下 | 跳过提交、告警「不在资产目录内」、文件仍落盘 |

### AC5 commit message 含相对路径与动作 —— ✅ PASS

- 单动作：`assets: create skills/demo/SKILL.md`、
  `assets: update tasks/pulse.json`、`assets: delete tasks/pulse.json`。
- 混合动作：单条 message 同时包含 `update strategies/s.md`、
  `delete programs/p/task.ts`、`create skills/new/SKILL.md`。
- 自定义前缀保留且仍追加动作+路径：
  `feat(skill): demo 首版: create skills/demo/SKILL.md`。
- `files` 返回项的 `path` 均为相对 assets 根的 posix 路径，`action` 与 message 一致。

### AC6 git 失败降级、不中断业务 —— ✅ PASS

- `commitAssets` / `TaskStore.save` / `TaskStore.remove` / `asset_commit` 注入抛错
  runner 后：**均不抛异常**；文件已写入或已删除；告警文本含「降级」；commit 数不增。
- `asset_commit` 降级返回值仍通过 `validateJsonSchemaValue(output.schema)` 严格校验。
- 文件内容原样保留（读取回验），业务写盘不受 git 故障影响。

### AC7 skill 直接写盘后有统一提交入口 `asset_commit` —— ✅ PASS

- 直接写 `skills/direct/SKILL.md` 后状态为 `??`、commit 数 0；
- 调用 `asset_commit`（不传 `assetsDir`，走 `DSH_IA_HOME` 解析）→ `create`，工作区变 clean；
- 再次编辑 → `update`；`rm` 后调用 → `delete`；
- program + SKILL 可一次提交，正文逐字节不变（含中文与多行）；
- 指向不存在路径时**不会凭空创建文件**（`committed=false`）。

---

## 3. 重点对抗场景

### 3.1 只提交指定路径

| 场景 | 观察结果 | 结果 |
|------|----------|------|
| 无关未跟踪 `noise.txt` + `skills/other/SKILL.md` | HEAD 只含目标 `skills/target/SKILL.md`；无关文件仍为 `??` | ✅ |
| 无关文件已 staged（`A  noise.txt`） | HEAD 只含目标；`noise.txt` 仍为 `A  noise.txt`，`git ls-tree HEAD -- noise.txt` 为空 | ✅ |
| 无关文件是另一资产的 staged 修改（`strategies/other.md`） | HEAD 只含目标；该文件仍 `M  `；HEAD 中内容仍为 v1 | ✅ |
| 多个目标路径一次提交 | message 逐一列出；HEAD 恰含两个目标；`noise.txt` 仍 `??` | ✅ |

### 3.2 空 commit 抑制

`git add` 后仅对本次 paths 执行 `git status --porcelain -- <paths>`；输出为空即
`committed=false` 的 no-op，不执行 `git commit`。四种入口（见 AC2）均验证通过。

### 3.3 git 失败降级

见 AC4/AC6；覆盖 add 失败、仅 commit 失败、缺 `.git`、task 目录越界四类。

### 3.4 路径越界

15 种非法输入，分别经 `normalizeAssetPath` + `commitAssets` 与 `asset_commit` 工具
两个入口验证，全部抛 `AssetPathError` 且 commit 数保持 0：

```text
/etc/passwd                         C:/Windows/system.ini
../outside.txt                      skills/../tasks/x.json
skills/.git/config                  .git/config
skills/.GIT/config                  skills/demo\SKILL.md
..\outside.txt                      data/ledger.json
noise.txt                           skills
skills//SKILL.md                    skills/./SKILL.md
（空字符串）
```

另验证：空 `paths` 数组被拒绝；合法四前缀 `skills/ tasks/ programs/ strategies/`
全部接受；重复路径去重后 message 不重复；非法路径不会把已存在目标文件 add 进 commit。

---

## 4. 用例统计

| 分组 | 用例数 | 结果 |
|------|--------|------|
| AC1/AC3/AC5 成功路径 | 6 | ✅ |
| AC2 幂等 / 无空 commit | 4 | ✅ |
| 只提交指定路径（对抗） | 4 | ✅ |
| 作者身份不依赖宿主配置 | 2 | ✅ |
| AC4/AC6 git 失败降级 | 7 | ✅ |
| 非法路径对抗（15×2 + 3） | 33 | ✅ |
| 真实链路 task_create/update/delete | 1 | ✅ |
| AC7 program / SKILL 直写 + asset_commit | 4 | ✅ |
| 插件装载（22 / 15） | 2 | ✅ |
| **合计** | **63** | **63 passed** |

插件可见性证据：真实 `Context` + `ToolRuntime` + 真实插件 `apply` 后
`ctx.tools.schemas()` 恰好 **22** 个且含 `asset_commit`；dispose 后归 0；
`createAllTools` 恰好 **15** 个且含 `asset_commit`、不含 `task_*`。

---

## 5. 风险 / 未覆盖项（均非阻断）

1. **不存在路径被归为「降级」而非 no-op**：`git add -- skills/ghost/SKILL.md`
   在 git 2.x 返回 128（pathspec 不存在），因此 `commitAssets` 返回
   `degraded=true`，工具 render 文案为「文件已写入，但未进入 git」。实际文件并不存在，
   行为安全（不造文件、不产生 commit），仅文案略有误导。属非阻断观察。
2. **未隔离可影响提交的其它宿主 git 配置**：身份已通过 `-c` + 环境变量双重固定；
   但若宿主启用 `commit.gpgsign=true`、`commit-msg` hook 失败等，commit 仍会失败并按
   AC6 降级（业务不中断，但资产未入历史）。当前未加 `-c commit.gpgsign=false` /
   `--no-verify`；这是设计取舍，非本次缺陷。
3. **`git commit -- <paths>` 保留无关文件 staged 状态**：符合「只提交指定路径」的
   预期，但使用方不能把 `committed=true` 等同于「工作区干净」。
4. **未覆盖**：全量测试套件（本次只按任务要求跑 5 个定向回归文件）；Windows 实际
   文件系统；多进程并发写同一资产仓库的竞争；超大文件；含空格 / 换行 / 特殊引号的
   资产路径；符号链接 / 子模块；只读文件系统下的权限降级。
5. **测试运行器并发噪声**：与其它全量测试同时运行时出现过一次 Vitest RPC 超时；
   隔离运行无此问题，不影响产品结论。建议 CI / 验收时避免与全量套件并发执行。

---

## 6. 交付物

1. `tests/tester-t100470-asset-commit.INDEPENDENT.spec.ts`（63 用例，63 passed）
2. `tests/tester-t100470-asset-commit.INDEPENDENT.REPORT.md`（本文件）

未修改 `src/**`，未执行 `git commit` / `git push`，未污染真实 `~/.dsh-ia`。
