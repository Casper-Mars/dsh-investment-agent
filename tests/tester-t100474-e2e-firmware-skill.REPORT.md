# t100474 端到端验证报告：固件 skill 可见、可发现、可触发

- 结论：**PASS**
- 开始时间：2026-10-19T08:40:55.234Z
- 仓库：`/Users/reachlucifer/project/opc/dsh-finance`
- 仓库 HEAD：`cddf6a299661fad04760a3dec123742f24c3c0cf`
- 运行命令：`node tests/tester-t100474-e2e-firmware-skill.mjs`
- 耗时：37780ms

## 验收项

1. 3 个固件 skill 可见且 source=runtime：**PASS**
2. prompt 含 finance-evolution description：**PASS**
3. 最小触发产生 commit 且 message 含改了什么/为什么改：**PASS**

## 架构与隔离

- `finance` profile 是 web app，web-startup 抢占 cmdline，不能直接承载 SDK stdio JSON-RPC；sdk-app 与 web-app 同时 parseCmdline 会挂起（已实测）。
- 因此使用官方 `sdk` profile，并通过 `--patch` 插入与 finance profile 相同的 `dsh-ia` 入口（`dist-server/index.js`，即 finance profile link 的同一产物）。
- 每次运行独立 `DSH_IA_HOME` + `DSH_HOME`；真实 `~/.dsh-ia` 前后快照对比。
- 真实 ~/.dsh-ia 未被修改：**是**

## 阶段 A：可见性与 description

| skill | source | provider | path |
|---|---|---|---|
| analysis-decision | custom | dsh-ia-skills | /private/var/folders/nw/zfv1hqrn2r95tng60ttf1z2r0000gn/T/t100474-ia-LmEvKl/assets/skills/analysis-decision/SKILL.md |
| finance-evolution | runtime | runtime | (runtime) |
| grid-strategy | custom | dsh-ia-skills | /private/var/folders/nw/zfv1hqrn2r95tng60ttf1z2r0000gn/T/t100474-ia-LmEvKl/assets/skills/grid-strategy/SKILL.md |
| skill-authorship | runtime | runtime | (runtime) |
| stop-rule | custom | dsh-ia-skills | /private/var/folders/nw/zfv1hqrn2r95tng60ttf1z2r0000gn/T/t100474-ia-LmEvKl/assets/skills/stop-rule/SKILL.md |
| strategy-authorship | custom | dsh-ia-skills | /private/var/folders/nw/zfv1hqrn2r95tng60ttf1z2r0000gn/T/t100474-ia-LmEvKl/assets/skills/strategy-authorship/SKILL.md |
| task-authorship | runtime | runtime | (runtime) |
| trend-analysis | custom | dsh-ia-skills | /private/var/folders/nw/zfv1hqrn2r95tng60ttf1z2r0000gn/T/t100474-ia-LmEvKl/assets/skills/trend-analysis/SKILL.md |

- available_skills 目录包含：analysis-decision、finance-evolution、grid-strategy、skill-authorship、stop-rule、strategy-authorship、task-authorship、trend-analysis
- finance-evolution description（源码）：资产进化流程：发现问题→定位到 assets 下的具体资产→改→跑自检→不过继续改→通过后提交→下次出结果时看是否要撤。修改记录用 git。
- description 出现在模型 prompt：**是**
- description 与源码 frontmatter 逐字一致：**是**
- 3 个固件 skill 均不在 assets/skills 目录，却出现在 registry 且 source=runtime，证明来自静态 runtime 注册而非文件 provider。

模型最终回复（截断）：

````text
1) 工具返回的 JSON 原文如下：

```json
{"skills":[{"name":"analysis-decision","description":"对某标的做分析与决策：技术面研判 + 消息面/资金面/全球视角，综合给出方向、数量与价位。分析与决策的方法论，可随复盘迭代进化。","source":"custom","provider":"dsh-ia-skills","path":"/private/var/folders/nw/zfv1hqrn2r95tng60ttf1z2r0000gn/T/t100474-ia-LmEvKl/assets/skills/analysis-decision/SKILL.md","modelInvocable":true},{"name":"finance-evolution","description":"资产进化流程：发现问题→定位到 assets 下的具体资产→改→跑自检→不过继续改→通过后提交→下次出结果时看是否要撤。修改记录用 git。","source":"runtime","provider":"runtime","modelInvocable":true},{"name":"grid-strategy","description":"震荡区内网格高抛低吸的操作方法，网格点位遵循该标的策略文档生成。","source":"custom","provider":"dsh-ia-skills","path":"/private/var/folders/nw/zfv1hqrn2r95tng60ttf1z2r0000gn/T/t100474-ia-LmEvKl/assets/skills/grid-strategy/SKILL.md","modelInvocable":true},{"name":"skill-authorship","description":"编写/修改可进化 SKILL.md 的合规规范：frontmatter 三字段、whenToUse 写法、硬性红线与自检清单。","source":"runtime","provider":"runtime","modelInvocable":true},{"name":"stop-rule","description":"止损线纪律：按标的读取硬止损/趋势止损阈值并给出仓位动作。","source":"custom","provider":"dsh-ia-skills","path":"/private/var/folders/nw/zfv1hqrn2r95tng60ttf1z2r0000gn/T/t100474-ia-LmEvKl/assets/skills/stop-rule/SKILL.md","modelInvocable":tru
````

## 阶段 B：最小触发（定位 → 修复 → 提交）

- 故障：trend-analysis description -> `TODO_FIX_ME`，并已提交为 seed 故障 `056948e78b8579eae9fb89991530aad52a14629a`
- 修复：已恢复正确 description
- 新提交：`f283a651d5f84c50d17aef8e9707aaf850178cd4`（seed 之后 1 个提交）
- commit message：

```text
fix(trend-analysis): 修复 SKILL.md description 占位符 TODO_FIX_ME

改了什么：将 assets/skills/trend-analysis/SKILL.md 首部 frontmatter 的 description 由 "TODO_FIX_ME" 恢复为正确描述「研判标的当前趋势方向、震荡区间与置信度，输出方向 + 区间 + 关键观测点。」；name / whenToUse 与正文均未改动，全仓无其它引用需同步。
为什么改：指标异常——description 被改成占位符，导致该技能无法被正确识别与路由（技能目录中显示为 TODO_FIX_ME）；正文能力本身完整，故只修复描述字段。下次 trend-analysis 被调用/被技能目录路由时即可复核是否恢复正常识别。: update skills/trend-analysis/SKILL.md
```

- 含「改了什么」：是
- 含「为什么改」：是
- 工作区干净：是

git log：

```text
f283a651d5f84c50d17aef8e9707aaf850178cd4	fix(trend-analysis): 修复 SKILL.md description 占位符 TODO_FIX_ME
056948e78b8579eae9fb89991530aad52a14629a	test(t100474): seed corrupted description (before)
be7ec5c6c9e23d973223229bb6e4e1bfa1f6d6af	init: 资产仓库首版
```

模型最终回复（截断）：

````text
已按 `finance-evolution` 流程完成修复并提交。

## 定位
- **资产**：`assets/skills/trend-analysis/SKILL.md`（本会话 assets 根目录下，`source=custom`）
- **根因**：frontmatter 第 3 行 `description: "TODO_FIX_ME"` 被改成占位符，技能目录因此显示为 `TODO_FIX_ME`，无法被正确路由。
- 正文能力完好，`name`、`whenToUse` 及全部正文均未受影响，故只修描述字段。

## 改动
```diff
-description: "TODO_FIX_ME"
+description: "研判标的当前趋势方向、震荡区间与置信度，输出方向 + 区间 + 关键观测点。"
```
全仓检索确认无其它位置引用该描述文本；`grid-strategy`、`analysis-decision` 对 `trend-analysis` 的引用走的是 skill 名（未变），无需同步。

## 自检结果（全过）
| 检查项 | 结果 |
|---|---|
| 四类触发之一（指标异常） | ✅ 可复现的具体事实 |
| 定位到 assets 具体资产 | ✅ 唯一改动文件 |
| frontmatter 三字段齐全 | ✅ `name` / `description` / `whenToUse` |
| `name` 与目录名一致 | ✅ `trend-analysis` |
| 占位符清除 | ✅ 0 处残留 |
| 正文骨架（输入/输出/准则/衔接） | ✅ 完整未动 |
| 未改固件、未改仓库源码 | ✅ 仅 1 个资产文件，1 行变更 |
| 引用同步 | ✅ 无描述文本引用 |
| 轮次 | 第 1 轮 / 上限 5 |

## 提交
- **commit**：`f283a65` — `fix(trend-analysis): 修复 SKILL.md description 占位符 TODO_FIX_ME`
- **提交身份**：`dsh-ia <dsh-ia@localhost>`（已设仓库级 `core.autocrlf=false`）
- **提交信息**：写明了「改了什么」（字段由占位符恢复为正确描述，其余未动）与「为什么改」（占位符导致技能无法识别/路由）
- 未使用 `git revert`；工作区已干净。

## 复核佐证与下次验证点
- 技能注册表已实时回读正常：`trend-analysis` → `研判标的当前趋势方向、震荡区间与置信度，输出方向 + 区间 + 关键观测点。`，路径指向本会话 assets。
- `~/.dsh-ia/assets` 未触碰（其 HEAD 仍为 `c252304`），确认改的是本会话指定根目录。
- **下次验证事件**：下一次 `trend-analysis` 被目录路由/调用时，看其是否按正确描述被选中；若再出现识别异常，即按进化流程撤销或再修。
````

## 真实 ~/.dsh-ia 快照

```json
{
  "before": {
    "exists": true,
    "mtimeMs": 1792209136984.2253,
    "assetsExists": true,
    "head": "c252304ea9c99ab09588386366ab902540605251",
    "status": ""
  },
  "after": {
    "exists": true,
    "mtimeMs": 1792209136984.2253,
    "assetsExists": true,
    "head": "c252304ea9c99ab09588386366ab902540605251",
    "status": ""
  },
  "untouched": true
}
```


## 复现

```bash
cd /Users/reachlucifer/project/opc/dsh-finance
node tests/tester-t100474-e2e-firmware-skill.mjs
```

> 真实 LLM e2e，耗时约 1-4 分钟。脚本每次使用全新临时 DSH_IA_HOME/DSH_HOME；成功 exit 0，失败 exit 1。
