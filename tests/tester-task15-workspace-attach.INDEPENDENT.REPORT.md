# 测试报告 —— t100364 / Ta*** §9.7 固定会话 Workspace 归属修复

- 被测交付物：`/Users/reachlucifer/project/opc/dsh-ia`（分支 `main`，HEAD `ed35231` + 未提交改动）
- 环境：宿主机 Mac（`Reach的MacBook Pro`）；harness `deepseek-harness` @ `0.2.0-rc.2`（`639ed01539`）
- 测试者：Tester（独立产出，未修改 `src/` 与既有测试）
- 独立测试文件：`tests/tester-task15-workspace-attach.INDEPENDENT.spec.ts`（11 用例，全绿）
- 结论：**AC1 未达成（阻断）；AC2/3/4/5/6 通过**

---

## 逐条验收结论

### AC1 固定会话出现在左侧会话列表（重点）—— ❌ 未通过（阻断）

**实测结论：workspace 分组已出现，但固定会话行仍不可见。**

数据层（workspace.json，权威落盘）✅ 正确：

```bash
$ cd /Users/reachlucifer/project/opc/dsh-ia && dsh web --no-open --port 3080 \
    < /dev/null > /tmp/tester-web.log 2>&1 &
# 等待启动后：
$ python3 -c "import json; d=json.load(open('/Users/reachlucifer/.dsh/storages/workspace.json'));
[print(w, v['path'], v['sessionIds']) for w,v in d['tables']['workspaces'].items()]"
118df9a2-3b66-47c1-b2ef-392b136847f4 -> /Users/reachlucifer/project/opc/dsh-ia sessionIds= ['investment-advisor']   # ← 新增，归属正确
31e54df5-c056-4042-9e65-a88748416f7d -> /Users/reachlucifer/Documents/dsh sessionIds= [ ...10 项... ]               # 既有，未动
```

启动日志（`/tmp/tester-web.log`）✅ 归属链路成功、无降级告警：

```
[dsh-ia] 插件加载：name=investment-advisor inject=[tools, skills, ptcRuntime, fs]
[dsh-ia/session] 固定会话已持久化，resume 恢复：investment-advisor
dsh web: http://127.0.0.1:3080/?token=...
```

但**浏览器实测（真实 web 宿主）❌ 会话行不可见**。打开 `dsh web` 打印的 URL 后，左侧「会话」树 `innerText` 为：

```
dsh-ia        ← 工作区分组已出现（说明 workspace 注册成功）
新会话              ← 仅此一个 blank 占位行（selected）
dsh                ← 既有另一工作区（折叠）
```

DOM 探测确认：

```js
document.body.innerText.includes('investment-advisor')  // => false  ❌
document.body.innerText.includes('dsh-ia')         // => true   ✅（分组可见）
```

即：**固定会话 `investment-advisor` 已归属工作区（workspace.json 正确），但并未出现在左侧会话列表**，AC1 的「可点开查看内容」不成立。

**根因（非 dsh-ia `src/` 缺陷，是 §9.7 设计缺口）：**

1. 该会话经 `ctx.agents.create` 创建后，从未发生 `turn/start` 事件（会话文件仅含 seed 事件，无任何用户/助手轮次），因此会话列表投影里 `blank` 恒为 `true`：
   - `packages/api/session-controller/src/list.ts` → `applySessionListMetadata`：`init: () => ({ blank: true, ... })`，仅当 `event.type === 'turn/start'` 时才翻转为 `false`。
2. 侧边栏渲染时，非当前 blank 会话被过滤：
   - `packages/client/ui-workspace/src/client/tree.ts` → `sessionVisible`：`if (session.blank && session.id !== current) return false`。
3. §9.7 的修复只做了 `resolveByPath(cwd) ?? create(cwd)` → `attachSession(...)`，把会话变成 workspace 成员，但**没有让它非 blank / 可见**。因此「归属 workspace」是可见的必要不充分条件。

**最小复现**：`pnpm build` → 在 dsh-ia 目录 `dsh web --no-open --port 3080` → 浏览器打开打印的 URL → 左侧列表仅见「dsh-ia / 新会话」，不见 `investment-advisor`。

> 说明：非市场时段（测试于 23:29）scheduler 无脉冲、不产生 `turn/start`，会话保持 blank。即使市场时段投递消息使会话非 blank 后才可见，也仍不满足「**启动后**即出现在列表」的 AC1 要求。

---

### AC2 归属幂等 —— ✅ 通过

- 单测：`attachPinnedSessionToWorkspace` 命中即复用 → `create` 0 次、`attach` 幂等；连续两次命中 → `create` 始终 0 次。
- 真实宿主：kill 后重启 `dsh web`，`workspace.json` 仍为 **2 个工作区**、dsh-ia 工作区 id 不变（`118df9a2...`）、`sessionIds` 仍 `['investment-advisor']`（无重复登记）。

### AC3 服务缺失 / reject / attach 失败降级 —— ✅ 通过

- 单测覆盖：`workspaceRegistry` 缺失 → 记日志「workspaceRegistry 服务不可用」不抛；`resolveByPath` reject → 记「会话归属失败」不抛；`attachSession` 抛错 → 记「会话归属失败」不抛；三者均不中断 `agents.create`（ensure 仍成功）。
- 真实宿主日志：无任何「归属失败 / 服务不可用」告警，说明归属静默成功。

### AC4 ensure 只执行一次（D1 回归）—— ✅ 通过

- 单测：非 live、未持久化 → `agents.create` 仅 1 次、`resume` 0 次、`attach` 1 次，无并发重复 create。
- 与 Developer 测试 ⑧ 结论一致。

### AC5 顶层 inject 与 cordis.patch.yml —— ✅ 通过

- `src/plugin.ts` `inject` 仍为 `['tools','skills','ptcRuntime','fs']`（单测断言 + 源码确认）。
- `git diff --stat` 显示 `cordis.patch.yml` **无改动**；单测断言其 inject 四项与顶层一致。

### AC6 typecheck / build / test —— ✅ 通过

- `pnpm typecheck` EXIT=0；`pnpm build` EXIT=0。
- `pnpm test`：基线 35 文件 / 570 用例全绿；加入本独立文件后 **36 文件 / 581 用例全绿**（无降级）。

---

## 缺陷清单

| # | 严重度 | 缺陷 | 根因（file:line） |
|---|--------|------|-------------------|
| 1 | **阻断** | AC1 未达成：固定会话已归属工作区，但不出现在左侧会话列表（仅「新会话」占位可见） | 会话 `blank=true`（无 `turn/start`）→ `sessionVisible` 过滤非当前 blank 会话：`packages/client/ui-workspace/src/client/tree.ts`（`if (session.blank && session.id !== current) return false`）；`blank` 来源 `packages/api/session-controller/src/list.ts` `applySessionListMetadata`（`init blank=true`，仅 `turn/start` 翻转）。§9.7 仅做 attach，未使会话可见 |

**缺陷说明（供 Leader 调度）**：这是 §9.7 设计缺口而非 `src/` 实现 bug——`attachSession` 正确、幂等、降级到位（AC2/3/4/5/6 全绿）。要让 AC1 成立，需在归属之外补足「让固定会话在列表可见」的措施（例如：ensure 成功后对固定会话补一个可标记非 blank 的首轮事件 / 或提供显式非 blank 标记 / 或 UI 侧放宽对已归属固定会话的 blank 过滤）。**不建议在本层自行改 `src/`。**

---

## 环境清理与数据影响说明

- 已停止 `dsh web` 进程（两次启动均已 kill，端口 3080 已释放）。
- 数据影响：测试在 `~/.dsh/storages/workspace.json` **新增**了 1 条工作区记录（`118df9a2...` → `/Users/reachlucifer/project/opc/dsh-ia`，sessionIds 含 `investment-advisor`）。这是修复的正常落盘结果，**未删除/未改动**任何用户既有 workspace 记录（原 `31e54df5...` 保持不变）。如需回滚到测试前状态，可由 Leader 决定删除该新增记录（我未擅自删除）。
- 未污染既有会话：`investment-advisor` 会话文件本就是被测固定会话，未改动其内容。

---

## 附录：独立测试文件覆盖映射

`tests/tester-task15-workspace-attach.INDEPENDENT.spec.ts`（11 用例）：
- AC2：命中复用 / 连续两次幂等 / 完整 apply 命中不 create
- AC3：缺失 / resolveByPath reject / attach 失败 三路降级
- AC4：apply 流程 `agents.create` 仅一次
- 盲区补充：skipped 不触发归属；归属 cwd 与 ensure cwd 一致
- AC5：顶层 inject 四项 + cordis.patch.yml 一致
