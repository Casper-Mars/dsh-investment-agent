# 测试报告 —— Task-15 notice 复验（收尾轮 R2）

- 被测交付物：`/Users/reachlucifer/project/opc/dsh-ia`（HEAD `ed35231` + 未提交改动）
  - 本轮新增（对上一轮阻断的修复）：`src/message-source.ts`（V4 producer-owned source kind）+ `src/opening-notice.ts` 拆分。
- 复验范围：**仅真实运行复验**（`dsh web` + 浏览器 + 会话文件），静态三项（typecheck/build/test）复跑确认。
- 环境：宿主机 Mac（`Reach的MacBook Pro`）；harness `deepseek-harness` @ `0.2.0-rc.2`（`639ed01`）。
- 测试者：Tester（独立产出，未修改 `src/` 与既有测试）。
- **结论：上轮「V4 source kind 阻断」已闭环 ✅；AC1 / AC2 / AC5 均通过（AC1 附一条 ⚠️ 环境性 caveat，非代码缺陷）。**

---

## 上轮 V4 source kind 阻断 —— 已闭环 ✅

上一轮阻断根因：notice 消息 source 复用 `kind='plugin'`（V3 退役形态），被 harness `session-format-v3-to-v4` 的 format v4 校验拒绝，导致 turn 写会话失败、`turn/start` 不落盘、固定会话恒 blank。

本轮 `src/message-source.ts` 引入 producer-owned kind `'dsh-ia'`（经 `declare module '@deepseek-ai/dsh-llm'` 增补 `MessageSourceMap`，用官方 `createUserMessage` 构造）。真实落盘证据见下（AC1），`source.kind` 已为 `'dsh-ia'` 而非 `'plugin'`，codec 不再抛 `SessionFormatError`。

---

## 逐条验收结论

### AC1 首次启动：投递 notice + turn/start 落盘 + source.kind=dsh-ia + 列表可见 + blank=false —— ✅ 通过（附 ⚠️ 环境 caveat）

**1) 启动日志出现投递行 ✅**
```bash
$ dsh web --no-open --port 3080
...
[dsh-ia/session] 固定会话不存在，create 新建：investment-advisor（cwd=/Users/reachlucifer/project/opc/dsh-ia）
[dsh-ia/notice] 已投递开场 notice（固定会话 investment-advisor）
dsh web: http://127.0.0.1:3080/?token=0baLYMjLykkR6jWf6r1kzhtsVOa2MQMPNKeIYeg_HyY
```
> 说明：本轮为干净复验，事先已将上一轮残留（interrupted round）的会话文件重置为 blank（备份至 `/tmp/tester-notice-baseline-dirty.jsonl.zstd`），故走 **create 分支**。日志命中 `[dsh-ia/notice] 已投递开场 notice`。

**2) 固定会话产生 turn/start 并落盘 ✅**（多帧 zstd 逐帧解码，非朴素单帧解压）
```bash
$ node <decode> ~/.dsh/sessions/.../investment-advisor/session.v4.jsonl.zstd
file size 9074, frames: 5
frame[2]: type=turn/start   ← 落盘
frame[2]: type=agent/inbox/spliced（inserted 含 notice）
frame[3]: type=step/start / system/message / user/message(notice) / user/message(runtime-context) / request/header / request/context
frame[4]: type=assistant/attempt / step/end / turn/end
```
- `turn/start` 出现 1 次（turn 1），会话结构完整跑完 turn 生命周期（`turn/start` → … → `turn/end`）。
- 用方法：按 zstd magic `0xFD2FB528` 定位全部帧边界（offsets `[0,154,303,761,8713,9074]`），逐帧 `zstdDecompressSync` 后合并为 JSONL 再逐事件读 `type`。已注明「多帧 zstd，朴素整缓冲解压仅得首帧 header」。

**3) 落盘 notice 的 `source.kind='dsh-ia'`（非 'plugin'）✅**
```json
{"type":"user/message","seq":8,"data":{
  "content":[{"type":"text","text":"【投资顾问已就绪】固定会话已启动。..."}],
  "source":{"kind":"dsh-ia","form":"notice","summary":"固定会话已启动，等待在线确认"},
  "role":"user","id":"9ec987f9-c571-4bca-a678-95a73fd3fd5b"}}
```
- `source.kind === 'dsh-ia'`、`form === 'notice'`、`summary` 存在；**无 `plugin` 字段**。V4 阻断彻底消除。

**4) 浏览器左侧会话列表可见 investment-advisor 会话行 ✅**
- 打开打印 URL，左侧会话树 DOM 投影：
```
treeitem "dsh-ia" (workspace, expanded)
treeitem "未命名\n1分钟"（= investment-advisor 固定会话，因无用户 title 显示「未命名」）
treeitem "dsh"
```
- 会话行确实出现在左侧列表（`document.querySelectorAll('[role=treeitem]')` 第二条）。

**5) blank=false —— 用投影/接口层证据证明（非「current 会话豁免」）✅**
- 接口层证据：`session-controller` 的 `applySessionListMetadata` 投影（`packages/api/session-controller/src/list.ts:49`）定义 `blank = state.blank && event.type !== 'turn/start'`，即**任一 `turn/start` 事件即把 `blank` 翻为 `false`**。本会话事件日志已含 `turn/start`（turn 1，见上），故投影 `sessionListMetadata.blank` 必为 `false`。
- 该判据独立于「是否当前会话」：前端过滤规则是 `blank && id !== current` 才隐藏；`blank=false` 本身由事件日志 `turn/start` 确立，与 current 豁免无关。

**⚠️ 环境性 caveat（非代码缺陷，如实标注）**
- 浏览器主面板显示 `处理失败 / 本轮运行失败 llm-deepseek: no API key for provider route "deepseek-official" ... MISSING_CREDENTIAL`。
- 根因：环境未提供 `DEEPSEEK_API_KEY`（`~/.dsh/.credentials.yaml` 中仅有 `DS_API_KEY`，与 provider route `deepseek-official` 期望的 key 名不匹配）。
- 影响面：**只影响 turn 内部 LLM 推理**（assistant 回复），**不影响** AC1 验收点——notice 投递、`turn/start`/`turn/end` 落盘、V4 source.kind 全部达成。这正是任务提示所说「真实 turn 因模型配额等环境原因跑不通」的情形，已如实标注，不做推断式通过（AC1 的通过依据是结构性落盘证据，不依赖 model 回复成功）。

---

### AC2 二次启动不重复投递 —— ✅ 通过

**1) 重启后日志无投递行（走 resume 分支，判读非 blank → 不投）✅**
```bash
$ dsh web --no-open --port 3080   # 第二次
...
[dsh-ia/session] 固定会话已持久化，resume 恢复：investment-advisor
dsh web: http://127.0.0.1:3080/?token=pzaM7JbOm3y5Pu6gHf4wps34YZOA7FuaILJ337I-VjI
# 无「[dsh-ia/notice] 已投递开场 notice」行
```

**2) 会话文件复查：开场 notice 正文仍只出现一次 ✅**（验证前已记录基线，验证后复查）
```bash
逻辑 notice 消息去重 id 数: 1  ->  9ec987f9-c571-4bca-a678-95a73fd3fd5b   # 仍为 1
turn/start 次数: 1                                                        # 仍为 1
```
- 基线（第一轮结束态）与复查（第二轮后）一致：逻辑 notice 消息（按 `id` 去重，`agent/inbox/spliced` 与 `user/message` 两条事件共享同一 `id`，属同一消息的两个视图，非重复投递）仍为 1 条；`turn/start` 仍为 1 次。
- blank 判读此时为 false（会话含 `turn/start`），`deliverOpeningNotice` 返回 `not-blank` 不投——真实宿主下一次性语义成立。

---

### AC5 typecheck / build / test 复跑 —— ✅ 通过

```bash
$ pnpm typecheck   # EXIT=0
$ pnpm build       # EXIT=0（dist-server/message-source.js + opening-notice.js 已产出）
$ pnpm test        # Test Files 38 passed (38) / Tests 612 passed (612)
```

---

## 缺陷清单

| # | 严重度 | 缺陷 | 结论 |
|---|--------|------|------|
| — | — | （本轮无代码缺陷） | 上轮 V4 source kind 阻断已闭环，本轮 AC1/AC2/AC5 全通过 |

**唯一遗留项（环境性，非被测代码缺陷，供 Leader 参考）：** 运行本仓库的 `dsh web` 时 provider route `deepseek-official` 期望 `DEEPSEEK_API_KEY`，但环境仅存 `DS_API_KEY`，导致 turn 内 LLM 推理报 `MISSING_CREDENTIAL`。与 Task-15 notice 修复无关，但会影响后续任何需要真实 model 回复的 e2e 验证。建议 Leader 在测试环境对齐 credentials key 命名或 provider route 配置。

---

## 环境清理

- 已停止两轮 `dsh web` 进程；端口 3080/3090 已释放（`lsof -iTCP:3080/3090 -sTCP:LISTEN` 为空）。
- 遗留进程清理：本轮开始前已 `pkill -f "dsh web"` 清除上一轮残留进程。
- 会话文件：本轮为干净复验，已重置为 blank 后重跑；第一轮结束态存档于 `/tmp/tester-notice-r2-web1-state.jsonl.zstd`、上轮残留 dirty 态备份于 `/tmp/tester-notice-baseline-dirty.jsonl.zstd`。当前会话文件仍为「1 条 notice + 1 个 turn/start」的验证后状态（非空白、可复现），如需恢复原始 blank 基线由 Leader 决定。
- 临时解码脚本（`tests/_tmp_*.mjs`）已删除。
