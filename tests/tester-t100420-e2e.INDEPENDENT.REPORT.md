# t100420 独立测试报告：Skill 可进化资产 · 端到端联调验证（E2E）

- **任务编号**：t100420（[skill重构任务清单]任务-3）
- **任务类型**：端到端联调验证（E2E）
- **被测交付物**：`/Users/reachlucifer/project/opc/dsh-ia`（HEAD=`584bdba`，含任务-1/2 交付）
- **目标节点**：Reach的MacBook Pro（Node v25.9.0 / pnpm 11.7 / dsh v0.2.0-rc.2）
- **被测运行面**：`dsh --profile web`（真实 web profile，含 dsh-ia bundle）+ 固定会话 `investment-advisor`（workspace `~/.dsh-ia`）
- **结论**：**t100420 通过 ✅（4/4 验收项全部通过）**；另报告 3 条限制/风险（F1~F3），均为「会话驱动面/并发」范畴，**未发现 skill 三条链路本身的缺陷**。

---

## 0. 验证方法（及选择理由）

| 项 | 采用方式 | 理由 |
|---|---|---|
| 冷启动 | 真实 `dsh` 进程 boot（web / SDK 两路），采集**进程原始 stdout 日志** + 文件系统断言 | 任一 boot 都会跑插件 `apply → ensureSkillAssetsRepo`；日志是原始证据 |
| 热更新 / 回滚 | **单个长驻 `dsh --profile web` 进程**（PID 27853）内多轮对话，**进程不重启** | 直接证明「无需重启」；外部编辑文件后同一进程下一轮即刻生效 |
| 固定会话能力闭环 | 浏览器自动化驱动**真实 web UI**（`investment-advisor` 会话） | 固定会话只在 web 面可驱动（见 F2/F3）；UI 是用户真实使用面 |
| 辅助脚本 | `tests/tester-t100420-e2e-driver.mjs`（SDK 长驻进程驱动，辅助） | 长驻进程可脚本化；用于冷启动原始日志与 SDK 会话冲突取证 |

**为何不用 headless 驱动固定会话**：`dsh --profile headless --session-id investment-advisor` 直接报错（见 F2），无法采用。**为何不用 SDK 驱动固定会话**：SDK `session/prompt` 无法命中已持久化的固定会话（见 F3）。故固定会话改用真实 web UI 驱动。

**固定会话身份核对**：web UI 控制台请求 `/api/changes.summary?sessionId=investment-advisor`，确认所驱动会话 id 即 `investment-advisor`。

---

## 1. 逐条验收结论

| # | 验收标准 | 结论 | 关键证据 |
|---|---|---|---|
| AC1 | 冷启动：全新环境首启自动落 6 skill + 首版 commit | ✅ 通过 | 首启原始日志 + 6 目录 + `git log` 恰 1 条 `init: skill 资产首版` + `status` 干净 |
| AC2 | 热更新：改 SKILL.md 无需重启即生效 | ✅ 通过 | 同一进程 PID 27853：改前=原文，改后同会话下一轮=`HOTUPDATE-E2E-SENTINEL-ALPHA` |
| AC3 | 回滚：git revert 后内容回退且热更新生效 | ✅ 通过 | `commit 20ecc3a`→`revert 4efe781` 后文件回原文；下一轮 agent 又见原文 |
| AC4 | 固定会话可读/写 skill 文件并执行 git | ✅ 通过 | 固定会话 agent 自跑 read→edit→commit(`b7d5d89`)→revert(`b2ce0d1`)，工作区干净 |
| AC5 | 产出逐项验证报告 | ✅ 通过 | 本文件 |

---

## 2. 逐项证据与复现

### AC1 冷启动（全新环境）✅

**复现命令**
```bash
rm -rf ~/.dsh-ia/data                     # 全新环境（dataRoot 无 skills/）
cd ~/.dsh-ia && dsh --profile web --no-open --port 7457
```
**原始证据（web 进程 stdout，`/tmp/t100420/web.log`）**
```
[dsh-ia] 插件加载：name=investment-advisor inject=[tools, skills, fs]
[dsh-ia/skills] 冷启动预置完成：/Users/reachlucifer/.dsh-ia/data/skills（6 个 skill，message="init: skill 资产首版"）
[dsh-ia/scheduler] 唤醒通道已就绪（定点投递）
dsh web: http://127.0.0.1:7457/?token=****
```
**文件系统断言**
```
$ ls ~/.dsh-ia/data/skills
analysis-decision  grid-strategy  stop-rule  strategy-authorship  task-authorship  trend-analysis   # 6 个，各含 SKILL.md
$ git -C ~/.dsh-ia/data/skills log --oneline
8195999 init: skill 资产首版                       # 恰 1 条，message 精确匹配
$ git -C ~/.dsh-ia/data/skills status --porcelain
                                                   # 空（干净）
$ git -C ~/.dsh-ia/data/skills branch --show-current
main
```
**独立复算（SDK 长驻进程冷启动，辅助脚本 `tests/tester-t100420-e2e-driver.mjs`）**：pre-state `SKILLS exists=false` → boot 后 `dirs=6 missing=[] extra=[] allSkillMd=true; commits=1 msg="init: skill 资产首版" status=""` → **A_pass=true**。

> 说明：任务描述「现状 `~/.dsh-ia/data` 存在但为空」；实测执行时 `~/.dsh-ia` 整个目录已不存在（视为更彻底的全新环境），故未额外清理即满足冷启动前提。

### AC2 热更新（同一长驻进程，无需重启）✅

**单进程**：`dsh --profile web --no-open --port 7457`（PID 27853），全程**未重启**。

**步骤与原始观测（固定会话 `investment-advisor` web UI）**
1. 轮1（改前）问「available_skills 里 trend-analysis 的 description 原文」→ agent 回答：
   `研判标的当前趋势方向、震荡区间与置信度，输出方向 + 区间 + 关键观测点。`
2. **外部**修改（不重启进程）：
   ```bash
   sed -i '' -E 's/^description: ".*"$/description: "HOTUPDATE-E2E-SENTINEL-ALPHA"/' \
     ~/.dsh-ia/data/skills/trend-analysis/SKILL.md
   git -C ~/.dsh-ia/data/skills status --porcelain   # → M trend-analysis/SKILL.md
   ```
3. 轮2（改后，同会话同进程）→ agent 回答：
   **`HOTUPDATE-E2E-SENTINEL-ALPHA`**（UI 用量由 12.5K→12.9K tok，`3 轮`）

**结论**：`SKILL.md` 改动后，**同一 dsh 进程**在下一轮即看到新 description（`agent/pre-step` 重新 `snapshot` → digest 变化 → 注入 replacement catalog），**无需重启**。

### AC3 git 回滚（commit → revert，热更新随之生效）✅

**步骤与原始观测（同一进程 PID 27853）**
```bash
cd ~/.dsh-ia/data/skills
git add -A && git commit -m "test(t100420): E2E hot-update sentinel"   # → 20ecc3a
git revert --no-edit HEAD                                             # → 4efe781
$ sed -n '3p' trend-analysis/SKILL.md
description: "研判标的当前趋势方向、震荡区间与置信度，输出方向 + 区间 + 关键观测点。"   # 已回退
$ git log --oneline -3
4efe781 Revert "test(t100420): E2E hot-update sentinel"
20ecc3a test(t100420): E2E hot-update sentinel
8195999 init: skill 资产首版
```
轮3（revert 后，同会话同进程）→ agent 回答又回到原文：
`研判标的当前趋势方向、震荡区间与置信度，输出方向 + 区间 + 关键观测点。`

**结论**：`git revert` 使文件回上一版，且**热更新随之生效**（同进程下一轮即见回退内容）。

### AC4 固定会话「读→改→commit / revert」闭环 ✅

**提示**（固定会话 `investment-advisor`，真实 LLM 轮次）：让 agent 用其 shell/文件工具自行完成读 SKILL.md → 改 description → `git commit` → `git revert`。

**agent 原始回答**
> 已完成：把 trend-analysis 的 description 改为 CAPABILITY-E2E-SENTINEL-BETA 并提交（**b7d5d89**），随后 revert（**b2ce0d1**），最终文件里的 description 已恢复为原文「研判标的当前趋势方向、震荡区间与置信度，输出方向 + 区间 + 关键观测点。」，工作区干净。

**外部复核**
```
$ git -C ~/.dsh-ia/data/skills log --oneline -2
b2ce0d1 Revert "test(t100420): capability edit"
b7d5d89 test(t100420): capability edit
$ git show --stat b7d5d89   # trend-analysis/SKILL.md | 2 +-
$ git status --porcelain    # 空
```
**结论**：固定会话在具备 base preset（`standard`）的 fs/shell 工具后，确实能读/写 skill 文件并执行 git —— 闭环成立（印证 t100417 能力）。

### 补充：固定会话重启续用（resume）✅

`kill 27853` → 重启 `dsh --profile web`（PID 29663）：
```
固定会话已持久化，resume 恢复：investment-advisor          # 无告警、无跳过
```
UI 中该会话 5 轮历史完整保留；再发一轮 → agent 回 `OK`（`6 轮`）。**resume 分支工作正常**。

---

## 3. 缺陷 / 风险清单（不改生产代码，交 Developer 评估）

### F1（中/运维级）同一 dataDir 多实例并发 → 固定会话 resume 降级
- **现象**：本机存在用户先前启动的 `dsh web --port 8080`（PID 84979，起于 21:19）。当**另一** dsh 进程（本次的 web/driver/headless）对**同一** `~/.dsh-ia` 启动时，插件固定会话确保走 resume 分支并失败：
  ```
  [dsh-ia/session] 固定会话已持久化，resume 恢复：investment-advisor
  [dsh-ia/session] 警告 恢复固定会话失败：SessionAlreadyOwnedError: session "investment-advisor" is already owned by an active write handle
  [dsh-ia/session] 固定会话确保跳过：resume failed: SessionAlreadyOwnedError: ...
  ```
- **观测影响**：该（后启动）进程的 scheduler 没有可用固定会话；其 web UI 对 `investment-advisor` 发送消息不产生新轮次（新会话正常）。
- **根因**：`session-persistence-jsonl` 的会话写句柄在**进程内**独占（`storage.ts` `writers.has(id)` → `SessionAlreadyOwnedError`）；固定会话已被**另一进程/实例**打开时，`session-ensure.ts` 的 `resume` 抛错，插件按设计降级 skip（不崩溃、不中断）。
- **判定**：**非 skill 三条链路缺陷**，属「同一数据目录多实例」的并发/运维约束；插件降级行为本身符合其注释契约。
- **建议**：① 文档明确「同一 `DSH_IA_DATA_DIR` 同时只允许一个 dsh 实例持有固定会话」；② 若需多实例，应使用不同 `DSH_IA_DATA_DIR`；③ 可在降级日志中升级措辞（提示可能存在的并发实例），便于运维定位。

### F2（低）headless 无法驱动固定会话（preset 未组合）
- **现象**：`dsh --profile headless --session-id investment-advisor "..."` →
  ```
  dsh: session "investment-advisor" runs under agent preset "standard", which the one-shot runner does not compose
  ```
- **根因**：固定会话由 `session-ensure` 以 `meta.agentPreset='standard'` 创建（t100417 修复）；`headless`/`sdk`/`acp` profile 仅 base+mode bundle，**不组合 agent preset**（preset 由 `web-app` bundle 提供）。故 preset 承载的固定会话只能在 web/tui 面 resume。
- **影响**：任务建议的「headless `--session-id` 驱动固定会话」路径不可用；固定会话的 E2E 必须以 web 面进行。**非缺陷**，为组合面差异。
- **建议**：文档标注「固定会话仅 web 面可驱动」；若需无头驱动，需让 headless 组合 preset，或固定会话不依赖 preset（隐含改生产代码，交 Developer 决策）。

### F3（低）SDK `session/prompt` 无法命中已持久化会话
- **现象**：`@deepseek-ai/dsh-sdk-client` 以 `sessionId: 'investment-advisor'` 发 prompt →
  `session "investment-advisor" already exists`（`SessionAlreadyExistsError`，来自 `agents.create` → persistence.create）。
- **根因**：SDK server 的 `getOrCreateSession` 对未知 id 一律 `agents.create`；固定会话已持久化于磁盘 → create 因日志已存在而失败。SDK 无「按 id adopt/resume」语义。
- **影响**：SDK 面无法驱动固定会话（可用新会话）。**非缺陷**，为 SDK 会话创建语义限制。

---

## 4. 残留 / 数据保护

- **用户数据**：改动前已备份 `~/.dsh/sessions` → `~/.dsh/sessions.bak-20261011-004747`；测试期间为取得「全新固定会话」将原 `investment-advisor` 会话目录暂移，测试结束后**已恢复**到 `~/.dsh/sessions/--Users-reachlucifer-.dsh-ia--/investment-advisor/`（原始 325637 字节、含用户 002156 业务会话）。测试用会话存于 `/tmp/t100420/my-test-session-*`（可删）。
- **skill 数据仓库**：`git reset --hard 8195999`，现为**首版单 commit、工作区干净**（清除测试产生的 sentinel/revert 提交）。
- **临时 profile**：为 E2E 创建的 `~/.dsh/profiles/e2e`、`e2e-headless` 及自动初始化的 `sdk` profile **已删除**；保留用户原有 `web` / `headless` profile。
- **进程/端口**：本次起的 web 进程（7457）均已 kill；**未触碰**用户原有 `dsh web --port 8080`（PID 84979）。
- **日志**：`/tmp/t100420/`（web.log / web2.log / web3.log / driver.log）。
- **辅助脚本**：`dsh-ia/tests/tester-t100420-e2e-driver.mjs`（SDK 长驻驱动，用于冷启动原始日志与 F3 取证；`git revert` 已修为 `--no-edit HEAD`）。报告文件未提交 git（工作树产物）。

---

## 5. 附：关键原始日志摘录

**冷启动（首启）**
```
[dsh-ia/skills] 冷启动预置完成：/Users/reachlucifer/.dsh-ia/data/skills（6 个 skill，message="init: skill 资产首版"）
```
**全新固定会话创建（无并发占用时）**
```
[dsh-ia/session] 固定会话不存在，create 新建：investment-advisor（cwd=/Users/reachlucifer/.dsh-ia）
[dsh-ia/notice] 已投递开场 notice（固定会话 investment-advisor）
```
**并发占用时的 resume 降级（F1）**
```
[dsh-ia/session] 警告 恢复固定会话失败：SessionAlreadyOwnedError: session "investment-advisor" is already owned by an active write handle
[dsh-ia/session] 固定会话确保跳过：resume failed: SessionAlreadyOwnedError: ...
```
**正常 resume（重启后）**
```
[dsh-ia/session] 固定会话已持久化，resume 恢复：investment-advisor
```

**技能热更新对照（固定会话，单进程 PID 27853）**
| 轮次 | 触发 | agent 观测到的 trend-analysis description |
|---|---|---|
| 轮1 | 基线 | 研判标的当前趋势方向、震荡区间与置信度，输出方向 + 区间 + 关键观测点。 |
| 轮2 | 外部改 `SKILL.md`（未重启） | **HOTUPDATE-E2E-SENTINEL-ALPHA** |
| 轮3 | `git commit` 后 `git revert`（未重启） | 研判标的当前趋势方向、震荡区间与置信度，输出方向 + 区间 + 关键观测点。 |
| 轮4 | 固定会话自主 read→edit→commit→revert | 最终=原文；commit b7d5d89 / revert b2ce0d1 |

