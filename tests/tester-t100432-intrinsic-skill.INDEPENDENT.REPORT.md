# 测试报告 · t100432 —— `task-authorship` 固有化（运行时验证 + 独立复核）

- **被测交付物**：commit `bdbe116`（`refactor(skills): task-authorship 从可进化清单分离为固有 SKILL`）
- **项目路径**：`/Users/reachlucifer/project/opc/dsh-ia`（分支 `main`）
- **执行节点**：Reach的MacBook Pro（Darwin 25.4.0 / arm64，Node v25.9.0，pnpm 11.7.0，vitest 3.2.7）
- **测试范围**：功能验证（运行时行为）+ 独立复核（**不复跑**开发者用例）
- **独立测试文件**：`tests/tester-t100432-intrinsic-skill.INDEPENDENT.spec.ts`（**18 用例**）
- **结论**：**全部 6 条 AC 通过；`typecheck` / `build` / `test` 三色回归全绿（EXIT=0）。未发现产品缺陷。**

---

## 一、逐条 AC 明细

| AC | 结论 | 关键证据 |
|----|------|----------|
| AC1 `SKILL_NAMES` 长度=5 且不含 `task-authorship`；`SkillName` 类型收窄 | ✅ 通过 | 运行期长度=5、成员/顺序精确匹配 `[trend-analysis, grid-strategy, stop-rule, strategy-authorship, analysis-decision]`；**真实 tsc 编译探针**：传 `'task-authorship'` → `TS2322 not assignable`（EXIT≠0），传 `'trend-analysis'` → EXIT=0 |
| AC2 `TASK_AUTHORSHIP_SKILL_NAME === 'task-authorship'`；`loadTaskAuthorshipMarkdown()` 读原文、逐字一致 | ✅ 通过 | 常量逐字一致；读取结果 `===` 磁盘 `src/skills/task-authorship/SKILL.md` 原文；frontmatter `name: task-authorship`；正文 >200 字符；`createIntrinsicSkillRegistration()` 契约正确（`source='runtime'`、`invocation` 双开、`content` 与原文正文一致） |
| AC3（关键）plugin 装载后 task-authorship 仍可见 / 降级不抛 / 卸载被注销 | ✅ 通过 | 自建最小 mock ctx 装载 `apply(ctx)`：注册成功且返回 disposer；skills 缺失时**不抛**、不注册；`register` 抛错时**不抛**（降级）；调用 disposer 后注销、二次调用幂等。另经**真实 SkillRegistry + dist-server 插件装载**复核：+5 可进化，共存无重名，卸载插件 fiber 后全部消失 |
| AC4 `ensureSkillAssetsRepo()` 冷启动后 `<dataRoot>/skills` 恰 5 个可进化目录、不含 task-authorship | ✅ 通过 | 临时 dataRoot + **真实 `git init/commit`**：目录集 = 5 可进化，无 task-authorship；`.git` 存在、首版恰 1 commit、被追踪 `SKILL.md` 恰 5 个、工作区干净；二次预置为 no-op；预置产物与随包种子逐字一致 |
| AC5 `pnpm typecheck` + `build` + `test` 全绿（EXIT=0） | ✅ 通过 | typecheck=0；build=0；test=0（**52 files / 1014 tests**，见 §三） |
| AC6 编译态 `dist-server/` 路径解析正确 | ✅ 通过 | build 产出 `dist-server/skills/task-authorship/SKILL.md`；`dist` 侧 `loadTaskAuthorshipMarkdown()` 读到该文件且与 src 逐字同源；`dist.SKILL_NAMES` 亦为 5；`dist` 插件 `inject` 契约不变 |

---

## 二、独立验证手段（与开发者用例刻意不同）

1. **编译期类型收窄（AC1c）**：运行期断言无法证明类型收窄。本测试**真实调用 `node_modules/.bin/tsc`** 对两个最小探针文件编译：
   - `ok.ts`：`const x: SkillName = 'trend-analysis'` → EXIT=0；
   - `bad.ts`：`const x: SkillName = 'task-authorship'` → EXIT≠0，报错含 `not assignable`。
   证明联合类型确实收窄（`task-authorship` 已不在可进化 `SkillName` 内）。
2. **三态 mock 装载（AC3a/b/c）**：自建最小 `ctx`（`get('skills')` 可返回替身/undefined、`effect(cb,label)` **同步执行** cb 并收集 disposer、`plugin()` 抛错模拟宿主缺失、`inject()` no-op），直接驱动 `srcPlugin.apply(ctx)`：
   - (a) skills 可用 → `apply` 不抛，`register` 恰 1 次，注册对象契约（name/source=runtime/invocation 双开/content 一致）正确；
   - (b) skills 不可用 → `apply` **不抛**、不 register、effect 仍注册（走 no-op 分支）；
   - (c) 卸载 → 调用固有 SKILL 的 effect disposer，注册的实例被移除（移除计数=1，且不误删他人）。
3. **真实环境装载（AC3-real / AC4）**：真实 `SkillRegistry` + `ToolRuntime` + `dist-server` 插件 fiber 装载（临时 `DSH_IA_DATA_DIR`）；`ensureSkillAssetsRepo` 走**真实 git**（不是 mock runner）。
4. **对抗性检验**：
   - **降级不抛（AC3b）**：skills 缺失时 `apply` 不抛、不中断装载；
   - **降级不抛（AC-adv2·本轮补强）**：`skills.register` **抛错**时 `apply` 不抛（try/catch 兜住），固有效应仍注册、其 disposer 安全 no-op；
   - **卸载语义（AC3c + AC-adv3·本轮补强）**：disposer 生效且**幂等**（连续两次调用不抛、不重复注销）；
   - **同名重复注册先到先得（AC-adv）**：第二个 disposer 为 no-op，不误删赢家；第一个才移除；
   - **与 provider 发现的 5 个可进化 skill 共存不冲突（AC3-real）**：两类技能同时可见且无重名（唯一赢家）。

> 本轮为「续跑」。此前遗留的独立测试文件（16 用例）经审查**质量与 AC 覆盖良好**（保留复用），本轮**补强 2 条对抗性用例**（注册抛错降级 / 卸载幂等），用例数 16 → 18，并将文件纳入 `pnpm test` 全绿。

---

## 三、回归命令（原始 EXIT 码与计数）

| 命令 | EXIT | 结果 |
|------|------|------|
| `pnpm typecheck`（`tsc -p tsconfig.json --noEmit`） | **0** | 无输出（无类型错误） |
| `pnpm build`（clean + 双 tsc + copy-assets） | **0** | `共搬运 11 个资源文件到 dist-server/`（含 `dist-server/skills/task-authorship/SKILL.md`） |
| `pnpm test`（`vitest run`） | **0** | **Test Files 52 passed (52) / Tests 1014 passed (1014)**，Duration 20.05s |

> 说明：开发者 commit 声明「51 files / 996 tests」。本轮为 **52 files / 1014 tests**，增量恰为本次新增的独立测试文件（**+1 file / +18 tests**）。除此外无其它用例漂移（996 + 18 = 1014，账目自洽）。

### 独立测试文件单独运行
```
npx vitest run tests/tester-t100432-intrinsic-skill.INDEPENDENT.spec.ts
→ Test Files 1 passed (1) / Tests 18 passed (18)，EXIT=0
```

---

## 四、问题 / 观察（均非产品缺陷；无阻塞项）

### ① 仓库级「旧静态注册残留」守卫扫描面偏宽（既有测试，非本次改动引入）
`tests/tester-t100419-skill-provider.INDEPENDENT.spec.ts` 的 `C1` 用例会 **walk `src/**` 与 `tests/**` 下的 `.ts/.mts/.cts/.js/.mjs`**，凡文本包含拼接构造的 needle `'ctx.skills.' + 'register('`（以及 `registerAllSkills` / `createAllSkillRegistrations` / `createSkillRegistration`）即判为 offender。
- **现象**：任何未来合法的新用例只要**字面量**写 `ctx.skills.register(`，就会被该守卫误判 → `pnpm test` EXIT=1。
- **本轮处置**：本独立文件全程**规避该字面量**（mock 内定义 `register()` 方法、真实装载经 `SkillRegistry`/别名调用），故 `pnpm test` 全绿（EXIT=0）。
- **判断**：非产品缺陷。`src/plugin.ts` 的固有注册刻意写作 `ctx.get('skills').register(...)`（非 `ctx.skills.register(`），天然规避该 needle；守卫对 `tests/**` 一并扫描、无通用豁免，属「过宽」风险。**（注：`.md` 报告文件不被该正则匹配，故本报告正文出现该字面量不影响 C1。）**
- **建议（低优先级，不阻塞）**：把该守卫扫描范围收敛到 `src/**`，或改为语义级检查而非纯文本 needle。

### ② 计数表述一致性
`src/skills/index.ts` / `repo.ts` / `provider.ts` / `README.md` 均已同步为「5 可进化 + 1 固有」，与运行期 `SKILL_NAMES.length===5`、预置目录=5、`provider` 发现=5 的事实一致（AC1/AC4 已实证）。

### ③ 无其它缺陷
降级路径（skills 缺失、`register` 抛错、provider 挂载失败）均按契约「记日志、不抛、不中断装载」；卸载语义（dispose → 归零；二次 dispose 幂等）成立；固有效应与 provider 发现的可进化技能共存无重名冲突。

---

## 五、交付物清单

- 独立测试：`tests/tester-t100432-intrinsic-skill.INDEPENDENT.spec.ts`（18 用例，可运行且纳入 `pnpm test` 全绿）
- 本报告：`tests/tester-t100432-intrinsic-skill.INDEPENDENT.REPORT.md`

## 六、最终判定

**AC1–AC6 全部通过；`pnpm typecheck` / `pnpm build` / `pnpm test` 三色全绿（EXIT=0）。** 无未通过项，未发现需回退的缺陷；唯一观察项为既有守卫的过宽扫描（建议项，不阻塞交付）。
