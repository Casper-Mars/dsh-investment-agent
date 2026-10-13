# 测试报告 · t100429 —— plugin 对固有 SKILL `task-authorship` 的单独静态注册

- **被测交付物**：`src/plugin.ts` `apply(ctx)` 中「固有 SKILL `task-authorship` 静态注册」逻辑
  - **仓库**：`/Users/reachlucifer/project/opc/dsh-ia`（分支 `main`，HEAD=`6b1b37b`）
  - **实现来源**：commit `bdbe116`（`refactor(skills): task-authorship 从可进化清单分离为固有 SKILL`）
  - **关键代码**：`ctx.effect(() => { const skills = ctx.get('skills'); … skills.register(createIntrinsicSkillRegistration()) … }, 'dsh-ia task-authorship skill')`；`createIntrinsicSkillRegistration()` 定义于 `src/skills/index.ts`（`loadTaskAuthorshipMarkdown()` → `parseSkillFile()`）。
- **测试范围**：功能 / 运行时验证（真实装载路径优先；独立编写用例，**未修改 `src/` 任何代码**）
- **执行节点**：Reach的MacBook Pro
- **独立测试文件**：`tests/tester-t100429-plugin-static-register.INDEPENDENT.spec.ts`（**11 用例**）
- **本轮结论**：**AC1–AC6 全部通过；`pnpm typecheck` / `pnpm build` / `pnpm test` 三色全绿（EXIT=0）。未发现产品缺陷。**

---

## 一、逐条 AC 明细（来自 t100429 todo，未臆造）

| AC | 结论 | 关键证据 |
|----|------|----------|
| **AC1** 装载后 `task-authorship` 作为嵌入式（runtime / 内存）skill 可见，来源**不是** skill-filesystem provider（`source='runtime'`） | ✅ 通过 | 真实 `SkillRegistry` + `ToolRuntime` + 编译态 `dist-server` 插件 fiber 装载（临时 dataRoot）：`list()` 中 `task-authorship` 的 `source='runtime'`、`provider='runtime'`；且 `source!=='custom'`、`provider!=='dsh-ia-skills'`；`get(TA).content` 与随包嵌入 `loadTaskAuthorshipMarkdown()` 正文逐字一致。**对抗**：即便在 `<dataRoot>/skills` 同目录塞入同名 `task-authorship`（描述带伪标记），赢家仍是运行时嵌入版（`source='runtime'`，描述来自嵌入，非数据目录）——证明**来源不混** |
| **AC2** 其余 5 个可进化 SKILL（trend-analysis / grid-strategy / stop-rule / strategy-authorship / analysis-decision）仍由 `skill-filesystem` provider（`providerName=dsh-ia-skills`，指向 `<dataRoot>/skills`）发现 | ✅ 通过 | 5 个可进化 skill 全部 `provider='dsh-ia-skills'`、`source='custom'`（非 runtime）。**指向性实证**：向 `<dataRoot>/skills` 新增 `extra-provider-skill` → 被发现（provider=`dsh-ia-skills`）；目录**之外**的 `decoy-skill` → **不可见**；改写 `<dataRoot>/skills/trend-analysis` 描述 → `list()` 反射新描述（内容来自数据目录，而非随包嵌入） |
| **AC3** `skills.register` 失败（抛错）时插件装载**不中断**（try/catch 记日志降级），插件其它贡献（tools / prompt 等）照常装载 | ✅ 通过 | 最小 mock ctx（`skills.register` 抛 `boom`）：`apply(ctx)` **不抛**；**其它贡献照常**——`dsh-ia tools` effect 在、tools 服务被实际调用 **21 次**（14 模型工具 + 7 scheduler 工具）；`ctx.inject(['systemPrompt'])` 已注入且 advisor `section()` 已注册；scheduler 两个 effect（`dsh-ia scheduler tools` / `dsh-ia scheduler`）均在。降级后 TA effect 仍注册，其 disposer 安全 no-op，成功注册数=0 |
| **AC4**（补）注册时机在 `ensureSkillAssetsRepo()` 与 `mountSkillFilesystemProvider()` 之后（互不影响） | ✅ 通过 | mock ctx 记录 effect 顺序：`dsh-ia tools` > `dsh-ia skill-filesystem provider` > `dsh-ia task-authorship skill` > `dsh-ia scheduler tools` > `dsh-ia scheduler`；且 **TA effect 执行瞬间** `<dataRoot>/skills` 已存在（先把仓库目录删掉，`apply` 内 `ensureSkillAssetsRepo` 仍先建好 → 证明预置先于 TA 注册） |
| **AC5**（补）注销器绑定 `ctx.effect`，fiber 卸载后 `task-authorship` 被注销；二次 dispose 幂等不抛 | ✅ 通过 | 真实 fiber 卸载：卸载前可见 7 项（5 可进化 + TA + extra），卸载后 **0 项**（TA 与 5 可进化及额外项全部归零）；二次 `pluginFiber.dispose()` 不抛（幂等）。mock 侧：TA effect disposer 两次调用不抛、仅注销一次 |
| **AC6** 全量回归 `pnpm typecheck` / `pnpm build` / `pnpm test` 全部 EXIT=0 | ✅ 通过 | typecheck=0；build=0；test=0（**53 files / 1025 tests**，见 §三） |

### 关键证据（原始 EVIDENCE 行）
```
[EVIDENCE AC1a] TA source=runtime provider=runtime
[EVIDENCE AC1b] winner source=runtime provider=runtime descFromEmbedded=true
[EVIDENCE AC2a] evolvable providers=dsh-ia-skills,dsh-ia-skills,dsh-ia-skills,dsh-ia-skills,dsh-ia-skills
[EVIDENCE AC2b] extra=dsh-ia-skills decoyVisible=false trendDesc=T100429-MARKER-DESC
[EVIDENCE AC2c] runtime=task-authorship custom=analysis-decision,grid-strategy,stop-rule,strategy-authorship,trend-analysis
[EVIDENCE AC3a] applyNoThrow=true toolsCalls=21 inject=[["systemPrompt"],["agents","sessionPersistence"],["agents"]] schedulerEffects=dsh-ia scheduler tools|dsh-ia scheduler
[EVIDENCE AC4a] order=dsh-ia tools > dsh-ia skill-filesystem provider > dsh-ia task-authorship skill > dsh-ia scheduler tools > dsh-ia scheduler repoExistedAtTa=true
[EVIDENCE AC5a] before=7 after=0
[EVIDENCE AC5b] 二次 dispose 未抛
```

---

## 二、独立验证手段（与既有 t100432 / 开发者用例的差异）

与 `tester-t100432-intrinsic-skill.INDEPENDENT.spec.ts` **刻意分工**（该文件聚焦「清单收窄 + 编译期类型 + 静态读取」），本文件聚焦 t100429 的**装载来源与生命周期**视角，避免逐字重复：

1. **来源区分（embedded vs provider）**：
   - 运行时嵌入项 = `source='runtime'` / `provider='runtime'`；
   - 可进化项 = `source='custom'` / `provider='dsh-ia-skills'`；
   - 断言两集合**互斥**（`AC2c`），并做**对抗**：把同名 `task-authorship` 放进 `<dataRoot>/skills`，验证赢家仍为嵌入版（runtime 优先级 `RUNTIME_RANK=250` < custom `CUSTOM_RANK=300`），描述不来自数据目录（`AC1b`）。
2. **真实 dist-server 装载**：真实 `SkillRegistry` + `ToolRuntime` + 编译态 `dist-server/index.js` 插件 fiber；`ensureSkillAssetsRepo` 走**真实 git**（临时 dataRoot，非 mock runner）。
3. **provider 指向性实证**（非仅断言常量）：新增项被发现 / 目录外 decoy 不可见 / 改写内容被反射——三者共同锁定 provider 只扫 `<dataRoot>/skills`（`AC2b`）。
4. **降级不中断 + 其它贡献照常**（`AC3a`）：不仅断言 `apply` 不抛，还**实证**模型工具（`registerAllTools` 经 `ctx.tools.register`，14 个）、advisor prompt（`ctx.inject(['systemPrompt'])` → `section()`）、scheduler（7 工具 + 自持启停 effect）**在同一装载里照常完成**（tools 服务被调用 21 次）。
5. **注册时机**（`AC4a`）：用「先删仓库目录，再看 TA effect 执行瞬间其是否已重建」+ effect 顺序双证，坐实 `ensureSkillAssetsRepo` / `mountSkillFilesystemProvider` **先于** TA 注册。
6. **卸载归零 + 幂等**（`AC5`）：真实 fiber 卸载后全量归零（7→0）+ 二次 `dispose()` 幂等；mock 侧 TA effect disposer 幂等（不重复注销）。
7. **环境隔离**：所有用例均在临时 `DSH_IA_DATA_DIR` / 临时 dataRoot 内预置（真实进程 / 真实 git），**不污染真实 `~/.dsh-ia` 数据目录**。

---

## 三、全量回归命令（原始 EXIT 码与计数）

| 命令 | EXIT | 结果 |
|------|------|------|
| `pnpm typecheck`（`tsc -p tsconfig.json --noEmit`） | **0** | 无输出（无类型错误） |
| `pnpm build`（clean + 双 tsc + copy-assets） | **0** | `共搬运 11 个资源文件到 dist-server/`（含 `dist-server/skills/task-authorship/SKILL.md`） |
| `pnpm test`（`vitest run`） | **0** | **Test Files 53 passed (53) / Tests 1025 passed (1025)**，Duration 23.74s |

### 账目自洽
- 基线：**52 files / 1014 tests** 全绿。
- 本轮新增本独立文件 **+1 file / +11 tests**。
- 结果：52+1 = **53 files**；1014+11 = **1025 tests**。**账目自洽**，无其它用例漂移。

### 独立测试文件单独运行
```
npx vitest run tests/tester-t100429-plugin-static-register.INDEPENDENT.spec.ts
→ Test Files 1 passed (1) / Tests 11 passed (11)，EXIT=0（Duration 7.01s）
```

---

## 四、问题 / 观察

### ① 仓库级「旧静态注册残留」守卫（既有测试，非本次改动引入 · 非产品缺陷）
`tests/tester-t100419-skill-provider.INDEPENDENT.spec.ts :: C1` 会 walk `src/**` 与 `tests/**` 下的 `.ts/.mts/.cts/.js/.mjs`，凡文本含拼接 needle `'ctx.skills.' + 'register('`（及 `registerAllSkills` / `createAllSkillRegistrations` / `createSkillRegistration`）即判 offender → `pnpm test` EXIT=1。
- 本轮处置：新测试全程**规避该字面量**（mock 内定义 `register()` 方法；取注册表经别名 `ctx.skills` 变量后调用 `.register(`）；`.md` 报告不受该正则影响。故全量 `pnpm test` 全绿。
- 现象/风险：任何未来合法用例只要**字面量**写该整串就会被误判；`src/plugin.ts` 的固有注册刻意写作 `ctx.get('skills').register(...)`，天然规避该 needle。
- 建议（低优先级，不阻塞）：把守卫扫描面收敛到 `src/**`，或改为语义级检查。

### ② 模型工具在「最小 mock ctx」下需 `ctx.tools` 直接属性
`registerAllTools` 内部经 `ctx.tools.register(...)`（而非 `ctx.get('tools')`），故 mock ctx 必须同时提供 `tools` 直接属性；仅提供 `get('tools')` 会让 14 个模型工具静默走入 `.catch` 降级。此为**测试替身构造细节**，非产品缺陷（真实 cordis 注入后 `ctx.tools` 即直接属性）。

### ③ 无其它缺陷
降级路径（`register` 抛错、skills 缺失、provider 挂载失败）均按契约「记日志、不抛、不中断装载」；注册时机与预置/挂载顺序一致；卸载归零 + 幂等成立；运行时嵌入项与 provider 发现的可进化项**来源可区分且互斥**、共存无重名冲突。

---

## 五、交付物清单

- 独立测试：`tests/tester-t100429-plugin-static-register.INDEPENDENT.spec.ts`（11 用例，纳入 `pnpm test` 全绿）
- 本报告：`tests/tester-t100429-plugin-static-register.INDEPENDENT.REPORT.md`

## 六、本轮结论

**AC1–AC6 全部通过；`pnpm typecheck` / `pnpm build` / `pnpm test` 三色全绿（EXIT=0）。**
**未发现产品缺陷**（无未通过项、无阻塞项）；两条观察项均为既有测试守卫的过宽扫描与测试替身构造细节（建议项，不阻塞交付）。
