# 测试报告 · dsh-finance Prompt 与 Skills 层（飞书任务 t100355）

- **被测交付物**：`/Users/reachlucifer/project/opc/dsh-finance`（Prompt + Skills 层）
- **测试范围**：Prompt/Skill 内容合规 + 注册机制运行时验证
- **测试人**：Tester（subagent）
- **测试方式**：独立复跑全量 + 新写 36 条独立用例（`tests/tester-prompt-skills.INDEPENDENT.spec.ts`）
- **结论**：✅ **全部 5 条验收点通过，无阻断/非阻断缺陷**

## 一、验收点逐条结论

| # | 验收标准 | 结论 | 关键证据 |
|---|----------|------|----------|
| 1 | advisor.md 含角色/原则/工作流/合规四块，末尾明确「本内容不构成投资建议」 | ✅ 通过 | 四个 `#` 板块正则命中；合规声明为**最后一个非空行** |
| 2 | 4 个 SKILL.md 均含 name/description/whenToUse，name 为 kebab-case，符合 skill-filesystem 发现规范 | ✅ 通过 | 逐个解析：name=目录名、`SKILL_NAME_PATTERN` 且 harness 权威 `isSkillName()` 双重为真；description/whenToUse 非空；物理文件名为 `SKILL.md` |
| 3 | prompt 与 skill 全文不出现写死的标的价格/阈值 | ✅ 通过 | 无小数价格、无 `%`/元/`止损N`/`突破N`；全部数字 token 落在白名单 `{0,1,2,3,4,5,50,588000}` |
| 4 | sense-authorship 完整描述脚本结构（bindings）、变更类型 keep/patch/replace、归档规范 | ✅ 通过 | 5 binding + keep/patch/replace + parent + `sense_versions/`、rationale.md/sensor.ts/meta.json 全部命中 |
| 5 | apply(ctx) 后 4 个 skill 可被 ctx.skills 发现，advisor.md 注入 system-prompt | ✅ 通过 | 真实 `SkillRegistry` + 真实 cordis `apply(ctx)` 端到端：list 出 4 个；section `dsh-finance:advisor` 注入 |

## 二、独立验证明细（对应建议测试方式 1-8）

1. **frontmatter 解析边界** ✅ 正常 / CRLF / BOM / 双引号转义 `\"`·`\n` / 单引号 `''` 全部正确；缺 description、name 非 kebab（`Bad_Name`/`Bad-Name`/`bad name`）、缺 frontmatter、未闭合 → 均按契约抛错；缺 whenToUse → 通过。
2. **4 个 SKILL.md 校验** ✅ name ∈ {trend-analysis, grid-strategy, stop-rule, sense-authorship}、name=目录名、description 非空、whenToUse 存在；并用 harness 导出的 `isSkillName` 独立复核 kebab-case。
3. **真实 SkillRegistry 注册发现** ✅ 真实 `new Context()` + `ctx.plugin(SkillRegistry)`：先前为空 → `registerAllSkills(ctx)` 后 `list()` 命中 4 个（source=`runtime`）→ `get()` 正文与 `parseSkill` 一致 → 注销器调用后归 0。
4. **system-prompt 注入** ✅ stub 路径捕获：`ctx.inject` 依赖**恰为 `['systemPrompt']`**，只注册 **1 个** section，`name='dsh-finance:advisor'`、`order` 为数值(=100)、`text` 为函数且求值等于 `advisor.md`；**`complete` 为 undefined（未传 `complete:true`）**。另跑真实 cordis `provide('systemPrompt')` 路径亦注入成功。
5. **顶层 inject 不变** ✅ `plugin.ts` 导出 `inject` 严格 `toEqual(['tools','skills','ptcRuntime','fs'])`，长度 4，**不含** `systemPrompt`；调用 `apply(ctx)` 后仍未被改写。
6. **验收点 3 内容扫描** ✅ 对 advisor.md + 4 个 SKILL.md 全文扫描 5 类可疑写法，**零命中**；数字 token 白名单校验通过。**已做负向对照**：人工样本 `3.14 元` / `回撤 5%` / `止损3` / `突破12` 均被检出，证明扫描有效。
7. **sense-authorship 完整性** ✅ 5 binding（`symbols.list/quote.realtime/quote.intraday/quote.history/ledger.get`）、keep/patch/replace、`sense_versions/`+rationale.md/sensor.ts/meta.json、`shouldWake` 返回契约、`不做交易判断` 边界全部命中。
8. **copy-assets** ✅ `pnpm build` 成功；`dist-server/` 下 advisor.md + 4 个 SKILL.md 存在且与源码逐字节一致；以编译产物 `dist-server/prompts/index.js`、`dist-server/skills/index.js` 的 URL 为基准 `new URL('./…')` 可解析；**动态 import 编译产物后 `loadAdvisorMd()` / `parseSkill()` 运行时闭环成功**。

## 三、回归与基线

| 项 | 结果 |
|----|------|
| 独立复跑全量测试（改动前） | ✅ 225/225 通过（14 files） |
| Developer 的 `tests/prompt-skills.spec.ts` | ✅ 38/38 通过 |
| 新增独立用例 `tests/tester-prompt-skills.INDEPENDENT.spec.ts` | ✅ 36/36 通过 |
| 改动后全量 | ✅ **261/261 通过（15 files）** |
| `pnpm build`（typecheck + tsc + copy-assets） | ✅ 退出码 0 |

## 四、缺陷与风险

- **阻断缺陷**：无。
- **非阻断缺陷**：无。
- **风险 / 建议（均非阻断）**：
  1. frontmatter 解析器为轻量实现，**不支持多行值/嵌套 YAML**；当前 4 个 SKILL 均为单行值，够用。若后续 description 需要多行，建议改用真实 YAML 解析或明确以 `|`/`>` 块标量支持。
  2. 顶层 `inject` 未含 `systemPrompt`，且 `apply` 内以 `ctx.inject` 软取 `systemPrompt`；**若部署层未挂载 systemPrompt 服务，advisor 人设会静默跳过**（已有 `console.warn`）。属设计取舍，建议部署侧确认 systemPrompt 服务必装。
  3. sense-authorship 的示意代码片段含 `getSymbolConfig` / `exceedsWakeThreshold` 等伪函数（属示意），**不构成写死阈值**；建议保留「示意」标注以免误读为实现契约。

## 五、范围合规

- 仅新增 `tests/tester-prompt-skills.INDEPENDENT.spec.ts` 与 `tests/tester-prompt-skills.REPORT.md`；**未修改任何 `src/**`**。
- 未启动中间件，无需容器清理。
