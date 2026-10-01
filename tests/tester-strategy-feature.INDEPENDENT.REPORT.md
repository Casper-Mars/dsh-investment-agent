# 策略域改造统一独立复验 + 全量回归 —— Tester 独立报告

- 被测交付物：`/Users/reachlucifer/project/opc/dsh-finance`
- 被测 HEAD：`c1debcf`（`c1debcfc87e82d5178b2ab4cd57215e9becfb47a`，工作区干净，仅新增本复验文件）
- 复验时间：2026-10-02（Asia/Shanghai）
- 复验文件：`tests/tester-strategy-feature.INDEPENDENT.spec.ts`（24 用例，全部经**真实 ToolRuntime registry** 走工具层）
- 结论：**8 / 8 通过，1 项低风险措辞观察（非功能缺陷）**

---

## 总览（逐条）

| # | 验收项 | 结论 |
|---|--------|------|
| 1 | 策略版本链 E2E | ✅ PASS |
| 2 | 阈值来源 E2E（三级优先级 + 非法键回落） | ✅ PASS |
| 3 | review_retrospect 端到端（阈值驱动可翻转） | ✅ PASS |
| 4 | 运行时可见性（工具 18 / SKILL 5） | ✅ PASS |
| 5 | 旧功能全量回归 | ✅ PASS |
| 6 | Prompt/Skill 文本 | ✅ PASS（⚠️ 1 项措辞观察） |
| 7 | 契约未变（inject / patch / 依赖） | ✅ PASS |
| 8 | typecheck / build / test 全绿 | ✅ PASS |

---

## 1. 策略版本链 E2E —— ✅ PASS

真实 `ToolContext` + `createAllTools()` + ToolRuntime registry，走工具层
`ledger_init → strategy_set(首版) → strategy_get → strategy_set(parent_version=首版) → strategy_get`。

证据（`tests/tester-strategy-feature.INDEPENDENT.spec.ts` 描述块 1）：

- `strategy_set` 首版返回 `{ ok: true, version: 'v001' }`；`strategy_get` 返回 `{ symbol, text:'首版策略正文', version:'v001' }`。
- 第二次 `strategy_set(parent_version='v001')` 返回 `{ ok: true, version: 'v002' }`；`strategy_get` 返回 `version:'v002'`。
- 落盘：`strategy/588000.md` == `二版策略正文`；`strategy_versions/588000/v001.md` == `首版策略正文`；`v002.md` == `二版策略正文`；`current` 指针文件 == `v002`；`v002.meta.json.parent == 'v001'`。
- 版本不可变：写 v002 前后 `v001.md` 与 `v001.meta.json` 字节一致；`strategy_get(version='v001')` 仍返回首版正文。
- `parent_version` 给错（声明 v001 而当前已 v002）→ `isError=true`，报错含「不一致」。
- 未 `ledger_init` 就 `strategy_set`（symbol=999999）→ `isError=true`，报错含「台账注册 / ledger_init」。
- 已 init 但未设定就 `strategy_get` → `isError=true`，报错含「尚无策略文档 / strategy_set」。

原始输出摘要：
```
[EVIDENCE 1a] strategy version chain v001 -> v002 via tool layer
[EVIDENCE 1b] disk layout correct: strategy/588000.md=v002 body, current pointer=v002, v002.meta.parent=v001
[EVIDENCE 1c] v001.md / v001.meta.json immutable across v002 write
[EVIDENCE 1d] wrong parent_version -> conflict: ... 与当前版 v002 不一致
[EVIDENCE 1e] strategy_set without ledger_init -> error: ... 尚未在台账注册，请先调用 ledger_init
[EVIDENCE 1f] strategy_get without set -> error: ... 尚无策略文档，请先调用 strategy_set 设定首版
```

---

## 2. 阈值来源 E2E —— ✅ PASS

证据（描述块 2，`src/tools/context.ts` `getThresholds` 三级优先级）：

1. ① 策略文档 front-matter `thresholds`（`dir_hit_min:0.7 / cum_return_min:0.05 / miss_streak_max:5`）→ 取值 `{0.7, 0.05, 5}`。
2. ② 策略无 front-matter → 回落旧 `ledger/<symbol>/thresholds.json`（写 `{0.55,0.01,4}`）→ 取旧值。
3. ③ 无策略无旧表 → 回落 `DEFAULT_THRESHOLDS`（`{0.6, 0, 3}`）。
4. 非法键逐键回落默认且不抛（8 例）：`dir_hit_min:-0.2 / 1.5 / NaN / Infinity`、`miss_streak_max:2.5 / NaN / Infinity / -1`。

原始输出摘要：
```
[EVIDENCE 2a] front-matter thresholds read: {0.7,0.05,5}
[EVIDENCE 2b] no front-matter -> legacy thresholds.json fallback
[EVIDENCE 2c] no strategy/no json -> DEFAULT_THRESHOLDS
[EVIDENCE 2d] 8 illegal keys all fall back to default without throwing
```

---

## 3. review_retrospect 端到端 —— ✅ PASS

证据（描述块 3）：构造 per-symbol 统计 `dir_hit_rate = 0.5`（两条复盘：一命中一未命中），
证明「触发检讨」确实由策略文档阈值决定、可翻转，而非硬编码：

- 无策略（默认 `dirHitMin=0.6`）→ `review_retrospect` 返回 root_cause 含「方向命中率低于下限」（触发）。
- 写策略文档 `dir_hit_min:0.4`（+ `cum_return_min:0`）→ `review_retrospect` 返回
  `root_cause == '表现未劣于阈值，无需根因定位'`（结论翻转，不触发）。

原始输出摘要：
```
[EVIDENCE 3a] default threshold -> retrospect triggered: 标的表现劣于阈值：方向命中率低于下限
[EVIDENCE 3b] strategy dir_hit_min=0.4 -> not triggered (flipped): 表现未劣于阈值，无需根因定位
```

---

## 4. 运行时可见性 —— ✅ PASS

证据（描述块 4）：真实插件装载（`new Context()` → `provide('systemPrompt'/'skills'/'ptcRuntime'/'fs')` →
`plugin(ToolRuntime)` → `plugin({name, inject:[...], apply})`）：

- 顶层 `inject` == `['tools','skills','ptcRuntime','fs']`。
- 真实装载后 `ctx.tools` 恰好 **18** 个工具。
- `ctx.skills.register` 实际注册 **5** 个 SKILL，顺序为
  `trend-analysis, grid-strategy, stop-rule, strategy-authorship, sense-authorship`。
- `createAllSkillRegistrations()` 产出 5 个，每个 frontmatter 合法。

原始输出摘要：
```
[EVIDENCE 4] plugin load -> tools=18, skills=5 (trend-analysis,grid-strategy,stop-rule,strategy-authorship,sense-authorship)
```

---

## 5. 旧功能全量回归 —— ✅ PASS

证据（描述块 5，工具层）：
- `ledger_*`：init / list / query / trade（买入加权平均 2.3333、卖出减仓）全链路 OK。
- `predict_*`：make / get / verify（`hit_dir:true, hit_range:true, deviation:0`）OK。
- `review_*`：check / report / get / metrics（`dir_hit_rate:1, range_hit_rate:1`）OK。
- `sense_archive_*`：commit(replace→patch) / rollback / list / get 全链路 OK。

另：全量 `pnpm test` 44 文件 / 726 用例全绿（含既有 ledger/predict/review/sense 全部用例），见第 8 项。

---

## 6. Prompt / Skill 文本 —— ✅ PASS（⚠️ 1 项措辞观察）

证据（描述块 6）：
- `src/prompts/advisor.md` 工作流 6 步（一「建立标的」→ … → 六「双线迭代」）；含
  「策略由你负责生成与迭代，不依赖用户输入」。
- `trend-analysis` / `grid-strategy` / `stop-rule` 三个 skill 均**无**「从该标的策略配置读取」残留，
  且均含「遵循该标的策略文档」。
- `strategy-authorship` 已注册（`SKILL_NAMES` 含之），frontmatter 合法（`name`/`description` 非空、kebab-case）。

⚠️ 措辞观察（低风险，非功能缺陷）：
- `src/skills/stop-rule/SKILL.md:13` 仍为 `## 两条止损线（各自从该标的配置读取）`。
  该行**不含**「策略配置」四个字（`grep 策略配置` 在 `src/` 已归零），故不命中任务 #6 的禁词
  「从该标的策略配置读取」；但「从该标的配置读取」语义上仍是旧措辞风格的残留（应为
  「遵循该标的策略文档」更一致）。建议 Developer 顺手把该标题改为
  「## 两条止损线（阈值均遵循该标的策略文档）」。

---

## 7. 契约未变 —— ✅ PASS

- 顶层 `inject` == `['tools','skills','ptcRuntime','fs']`（`src/plugin.ts:80`）。
- `cordis.patch.yml` 本轮（`6c1fb9a~1..HEAD`）**无 diff**（`git diff --name-only` 为空），
  inject 仍为 `['tools','skills','ptcRuntime','fs']`。
- `package.json` / `pnpm-lock.yaml` 本轮**无 diff**（无新增依赖；`dependencies` 键缺失 = 全为 peer/dev）。

---

## 8. typecheck / build / test —— ✅ PASS

命令与原始输出摘要：

```bash
pnpm typecheck
# $ tsc -p tsconfig.json --noEmit
# EXIT=0

pnpm build
# $ tsc -p tsconfig.json --noEmit && tsc -p tsconfig.server.json && node scripts/copy-assets.mjs
# 共搬运 12 个资源文件到 dist-server/
# EXIT=0

pnpm test
# Test Files  44 passed (44)
#      Tests  726 passed (726)
# EXIT=0
```

（726 = 既有 702 + 本复验新增 24。本复验单文件：`24 passed (24)`。）

---

## 缺陷清单（file:line）

| 严重度 | 位置 | 描述 | 建议 |
|--------|------|------|------|
| 低（措辞） | `src/skills/stop-rule/SKILL.md:13` | 标题 `## 两条止损线（各自从该标的配置读取）` 为旧措辞风格残留（不命中禁词「策略配置」，但语义上仍是「从…配置读取」而非「遵循…策略文档」） | 改为「## 两条止损线（阈值均遵循该标的策略文档）」 |

> 无功能性缺陷；无未验证项。全部 8 项验收逐条给了运行时证据（非代码审查）。

---

## 复验环境与清理

- 运行方式：真实 cordis `ToolRuntime` + `registerAllTools` + 真实插件 `apply`，全部走临时 `mkdtemp` dataRoot。
- 未修改 `src/**` 与任何既有测试；未 commit / push。
- 临时目录在 `afterEach` 中 `rmSync` 清理；进程无残留（无中间件 / 无常驻进程）。
