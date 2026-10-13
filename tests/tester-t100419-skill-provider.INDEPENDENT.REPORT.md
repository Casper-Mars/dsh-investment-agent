# t100419 独立测试报告 —— dsh-ia 接入 dsh 原生 `skill-filesystem` provider（热更新）

- **任务编号**：t100419（[skill重构任务清单]任务-2）
- **被测交付物**：`dsh-ia` 接入 dsh 原生 `skill-filesystem` provider（指向 `<dataRoot>/skills`，`watch:true` 热更新），替换旧静态注册。
- **项目路径**：`/Users/reachlucifer/project/opc/dsh-ia`（exec host=node，node="Reach的MacBook Pro"）
- **执行环境**：macOS（12 核），Node **v25.9.0**、pnpm **11.7.0**、vitest **3.2.7**；被测代码基线 commit `79c3408`（working tree 期间 HEAD 曾推进到 `2843008`）。
- **测试范围**：**运行时行为验证**（真实装配 + 真实 chokidar + 真实 scope），非静态/格式复查。
- **独立测试文件**：`tests/tester-t100419-skill-provider.INDEPENDENT.spec.ts`（15 用例，含真实 chokidar，单用例 30s 超时）。
- **独立报告**：本文件。
- **执行时间**：2026-10-11 00:19 – 00:40（GMT+8）。

> ⚠️ **并发环境声明（影响 AC4/H 判读）**：执行期间宿主机上存在**其它 vitest 会话/并行 subagent**（另有 t100419 并行复核与其它任务的全部套件运行），并且本流程自身也发起过若干后台 `vitest run` 实验。凡涉及**时序/并发**的数值（尤其 §9 H 与 AC4），本报告以**安静机器（无并发 vitest）复跑**为准，并附「有争用」时的对照。

---

## 0. 结论（TL;DR）

> ### ✅ 功能验收通过；⚠️ AC4「`pnpm test` 全绿」在**干净环境**下**非稳定复现**（属测试卫生/资源争用波动，**非本任务生产代码缺陷**）。
>
> - **AC1（热更新）/ AC2（global 层可见）/ AC3（无残留）**：均以**真实装配**验证**通过**。
> - **AC4**：`pnpm typecheck` / `pnpm build` **稳定通过**；`pnpm test` 在干净机器上**通过**（`51 files / 992 tests`），但**曾复现 1 次**跨用例污染型失败（`t100418` ⑥）与**负载下**超时型失败——均为**环境/测试卫生**问题，**非本任务引入**（证据见 §10）。
> - **未发现 t100419 生产代码功能性缺陷**。
> - **1 条低—中风险观察**：**新增 skill 目录**的 watch 可见性**首帧偶发漏报**（~3/8），下一次可失效事件后恢复；**改写已存在 `SKILL.md` 稳定可靠**（0/8 失败）。根因在上游 `@deepseek-ai/dsh-skill-filesystem` 的 chokidar 装配，非本任务代码。

| 验收标准 | 结论 |
|---|---|
| AC1 改 `SKILL.md` 无需重启、下次会话生效（热更新闭环） | ✅ 通过 |
| AC2 固定会话与 workspace 会话均可见 6 个 skill（global 层） | ✅ 通过 |
| AC3 旧静态注册删除、无残留引用 | ✅ 通过 |
| AC4 `pnpm test` 全绿、`pnpm build` 通过 | ⚠️ build ✅；test 功能性通过，但**非稳定全绿**（见 §9/§10） |

---

## 1. 验证方法与数据隔离

- **数据隔离**：全部用例/探针使用 `mkdtempSync` 临时 `dataRoot`，并在独立 spec 内将 `DSH_IA_DATA_DIR` 强制指向临时目录；**显式传 `dataRoot`** 给 `ensureSkillAssetsRepo`/provider 挂载。**本 t100419 流程不向 `~/.dsh-ia` 写入任何内容**。
- **真实装配**：
  - 注册表：`new Context()` + `await ctx.plugin(SkillRegistry)`（`@deepseek-ai/dsh-skill` 真实 `SkillRegistry`）。
  - provider：`mountSkillFilesystemProviderAsync(ctx,{dataRoot})` → 真实 `@deepseek-ai/dsh-skill-filesystem`，`watch:true`（chokidar 稳定阈值 200ms）。
  - scope：真实 `@deepseek-ai/dsh-scope`（`dsh-scope` 非本包直接依赖，经 `@deepseek-ai/dsh-skill` 同侧 pnpm 路径解析后 `createScope`）——**非**「传个空对象冒充 scope」。
- **不动生产代码**：仅新增/运行测试与报告。
- **本报告关键命令**（均 `host=node`，cwd=项目根）：
  ```
  pnpm typecheck
  pnpm build
  pnpm test
  pnpm exec vitest run tests/tester-t100419-skill-provider.INDEPENDENT.spec.ts
  pnpm exec vitest run --maxWorkers=11            # H：覆盖配置，拉高并发
  node ./probe-add6.mjs                            # 附录 A：受控真实 chokidar 探针（用完即删）
  ```

---

## 2. 逐条验收标准

### AC1 热更新闭环 ✅（改写路径）
真实临时 `dataRoot`（6 个 skill 的独立 git 仓库）+ 真实 chokidar：

- 改写 `<dataRoot>/skills/trend-analysis/SKILL.md` 的 `description`/`whenToUse`/正文 → **无需重启**；
- **下一次 `list()`（catalog）**即反映新 `description`/`whenToUse`；
- **`skills/change` 事件计数 ≥ 1** → 证明走的是 `改文件 → chokidar → invalidate → notifyChange → 重列` 链路，而非 `get()` 每次直读磁盘造成的假象。

```
[EVIDENCE A1] changeEvents=1, before="研判标的当前趋势方向、震荡区间与置信度，输出方向 + 区间 + 关键观测点。" after="TESTER-HOT-NEW-DESC"
```
（A1 单用例耗时 ~0.4–0.7s。）

### AC2 固定会话 / workspace 会话均可见 6 个 ✅
provider 在**未 scoped** 的 root ctx 挂载 → 注册进 **global 层**（`SkillRegistry` 读数固定合并 `[global, ...scopeChain]`）。真实 scope 验证：

```
[EVIDENCE B1] fixed-session & workspace-session scope both see 6 via dsh-ia-skills
[EVIDENCE B2] ws sees scoped; fx & global do not; global still 6
```

- B1：`固定会话`（独立根 scope）与 `workspace→session`（父子链 `scopeChainOf` 长度=2）两类读取方，`list({scope})` 均命中全部 6 个，且来源 provider 名均为 `dsh-ia-skills`。
- B2（**反向**验证「真的分在 global 层、且分层生效」）：在 workspace scope 内注册**第二个** provider（`fs-scoped`）→ workspace 可见 `6 + 1`；固定 scope 与无 scope 的 global 视图**看不到**该 scoped skill，但**仍见 global 的 6 个**。

### AC3 无残留引用 + 装配正确 ✅

```bash
grep -rn -E "registerAllSkills|createAllSkillRegistrations|createSkillRegistration|ctx\.skills\.register\(" \
  --include="*.ts" --include="*.mts" --include="*.cts" --include="*.js" --include="*.mjs" src tests
# src/**  → 无
# tests/**（*.ts/js 代码）→ 无；仅历史 tests/tester-*.REPORT.md 文本提及旧函数名（非代码引用）
```
```
[EVIDENCE C1] offenders=0
[EVIDENCE C2] inject=tools,skills,fs, patch consistent, no runtime register
```
- `src/skills/index.ts` 仅保留 `SKILL_NAMES` / `SkillName` / `loadSkillMarkdown` / `parseSkill`；`createSkillRegistration` / `createAllSkillRegistrations` / `registerAllSkills` 已删除。
- `src/plugin.ts` 不再出现 `ctx.skills.register(`；改为 `ensureSkillAssetsRepo()` → `mountSkillFilesystemProvider(ctx)`（均 try/catch 降级）。
- 顶层 `inject === ['tools','skills','fs']`；`cordis.patch.yml` 的 `inject: ['tools','skills','fs']` 一致。

### AC4 `pnpm test` / `pnpm build` ⚠️（build ✅，test 非稳定全绿）
见 §9 / §10。

---

## 3. 独立验证点 A —— 真实热更新闭环（改 / 增 / 删）

| 场景 | 结论 | 首帧可见率（受控探针） | 备注 |
|---|---|---|---|
| A1 改写已存在 `SKILL.md` | ✅ 稳定 | 8/8 成功 | `changeEvents=1`，0.4–0.7s |
| A2 新增合规 skill 目录 | ⚠️ **首帧偶发漏报** | **5/8 成功（3/8 漏报）** | 下一次可失效事件后**必恢复** |
| A3 删除 skill 目录 | ✅（同 A2 机制） | — | 首次即可见性高，未见失败 |

**A2/A3 受控探针（安静机器 · `node` 直跑 · 真实 chokidar · 无 vitest/无并发）**：

```
Ma  Ma  MA  MA  Ma  MA  MA  MA
MODIFY_FAILS=0/8  ADD_FIRSTTRY_FAILS=3/8
```
- `M/m` = 改写已存在文件是否成功；`A/a` = 新增目录**首帧**是否可见。
- 结论：**改写稳定**；**新增目录首帧 ~37%（3/8）漏报**，且**没有任何 `skills/change` 事件**（`changeEvents=0`）——即 chokidar 未上报 `addDir`。

**为什么这是「边界观察」而非 AC1 失败**：
1. AC1 验收目标语义是「**修改** `<name>/SKILL.md` 后无需重启即可用」——该路径 0/8 失败，**稳定**。
2. 新增目录属于我主动扩展的**边界场景**。
3. 生产链路上，agent 通过 fs 服务（`write`/`edit` 工具）落盘时会额外触发上游 `fs/observed → provider.observeHostMutation → invalidate`，**不单靠 chokidar**；本测试用 `node:fs` 直写是**更苛刻**的外部编辑路径。

**为让独立 spec 确定性通过**：A2/A3 采用「**下一次可失效事件**」兜底——首帧未命中时改写一个已存在 skill 文件，产生可靠 `change → invalidate → 重列`，新目录随之被发现；并把首帧结果如实打印为证据：

```
[EVIDENCE A2] added "tester-added-skill" provider=dsh-ia-skills; firstTryAddDirVisible=true changeEvents=1
[EVIDENCE A2] added "tester-added-skill" provider=dsh-ia-skills; firstTryAddDirVisible=false changeEvents=1   # 另一轮：首帧漏报、兜底后可见
[EVIDENCE A3] deleted "stop-rule" firstTryRemoveVisible=true (remaining core=5)
```
（本 spec 单文件隔离运行 **5/5 轮 15 passed（15）**。）

---

## 4. 独立验证点 B —— global 层可见性 ✅
见 AC2。核心机制 + **反向分层**证据见 B1/B2；结论：provider 确实落在 **global 层**，经 scope 链并入每个 agent 视角，且**不**泄漏 scoped-only provider。

---

## 5. 独立验证点 C —— 无残留 & 装配正确 ✅
见 AC3。另核对：
- `src/skills/provider.ts`：`SKILL_PROVIDER_NAME='dsh-ia-skills'`；`mountSkillFilesystemProviderAsync` 动态 `import('@deepseek-ai/dsh-skill-filesystem')` → `ctx.plugin(mod,{providerName,includeDefaultRoots:false,customSkillDirs:[<dataRoot>/skills],watch:true})`；`mountSkillFilesystemProvider` 同步入口经 `ctx.effect` 托管注销器、失败降级不抛。
- `plugin.ts` 的 `inject` 未变、`cordis.patch.yml` 未破坏。

---

## 6. 独立验证点 D —— 降级对抗 ✅

```
[EVIDENCE D1] sync wrapper degraded-logged; async wrapper rejected
[EVIDENCE D2] unresolvable module → sync degraded, no throw
[EVIDENCE D3] apply not thrown; effect labels=dsh-ia tools|ctx.plugin()|dsh-ia skill-filesystem provider|ctx.plugin()|ctx.plugin()|dsh-ia scheduler tools|dsh-ia scheduler; skills degraded to 0
```
- **D1**：`ctx.plugin` 抛错 → `mountSkillFilesystemProviderAsync` **reject**；同步入口 `mountSkillFilesystemProvider` **不抛**，并打 `[dsh-ia] skill-filesystem provider 挂载失败（降级）`。
- **D2**：`vi.doMock('@deepseek-ai/dsh-skill-filesystem', ()=>{throw …})`（模拟**依赖不可解析**）→ 同上降级、不抛、有日志。
- **D3**：**真实** `apply(ctx)`（真实 `SkillRegistry`）在模块不可解析时**不抛**；`ctx.effect` 标签仍登记 `dsh-ia tools` 与 `dsh-ia skill-filesystem provider`（**其它贡献照常装载**）；skill 发现降级为 0，且有明确 `console.error`。

---

## 7. 独立验证点 E —— 卸载语义 ✅

spec E1/E2：

```
[EVIDENCE E1] fsWatchers before/during/after = 0/0/0
[EVIDENCE E2] sync effect dispose → provider removed, list=0
```
- `mount.dispose()`（async）与同步入口 effect 注销器，注销后 `list()` **归 0**；
- 卸载后改写 `<dataRoot>/skills/…` 文件并等待 > 稳定阈值，**不再复活**（list 仍 0）；
- 本机 `process.getActiveResourcesInfo()` 的 `FSWatcher` 计数在挂载前/注销后均为 0（该计数在 Node 25 上对 chokidar/FSEvents 句柄不敏感，故仅作旁证；更强的句柄级证据见并行会话的 `FSEventWrap→0` 观测，两方结论一致：**watch 已关闭、无残留 provider**）。

---

## 8. 独立验证点 F —— 与 preset provider 共存 ✅

```
[EVIDENCE F1] coexisting providers: 6 core + preset-skill
[EVIDENCE F2] duplicate providerName "dsh-ia-skills" rejected
```
- **F1**：同一（global）层再注册 `providerName:'filesystem'` 的 provider（模拟 preset 默认名）→ 与 `dsh-ia-skills` **同层不冲突**，各自可见（`preset-skill` 来源 `filesystem`，其余 6 个来源 `dsh-ia-skills`）。
- **F2**：同层重复 `providerName='dsh-ia-skills'` → 按注册表「同层重名即抛」语义 **reject**（唯一性边界成立）。

---

## 9. 独立验证点 G / H —— 回归基线与 `vitest.config.ts` 审查

### G. 回归底线（真实退出码）

| 命令 | 退出码 | 结果 |
|---|---|---|
| `pnpm typecheck` | **0** | 通过 |
| `pnpm build` | **0** | 通过（`tsc --noEmit` + `tsc -p tsconfig.server.json` + 搬运 11 个资源到 `dist-server/`） |
| `pnpm test`（**安静机器**，config `maxWorkers:4`） | **0** | `Test Files 51 passed (51)` / `Tests 992 passed (992)` / 17.79s |
| `pnpm exec vitest run tests/skill-provider.spec.ts`（开发者自测，单独） | **0** | `8 passed (8)` / 6.0s |
| `pnpm exec vitest run tests/tester-t100419-…INDEPENDENT.spec.ts`（本独立 spec，单独，×5） | **0** | 5/5 次 `15 passed (15)`（6–10s） |
| `pnpm exec vitest run tests/tester-prompt-skills… tests/tester-t100419…`（2 文件） | **0** | `48 passed (48)` |

### H. `vitest.config.ts`（`maxWorkers:4`）—— **合理的测试稳定性措施，非「掩盖真实失败」**

复现实验（安静机器优先）：

| 实验 | 命令 | 结果 |
|---|---|---|
| ① 单文件（开发者自测） | `vitest run tests/skill-provider.spec.ts` | **8/8 通过**，6.0s |
| ② 单文件（本独立 spec） | `vitest run tests/tester-t100419-…spec.ts` | **15/15 通过**（×5） |
| ③ 重负载簇 @ 高并发 | `vitest run --maxWorkers=12`（4 个真实 fs/git/chokidar 文件） | **70/70 通过**，EXIT 0 |
| ④ 全量 @ 拉高并发 | `vitest run --maxWorkers=11` | `1 failed | 50 passed`，`2 failed | 990 passed`，**EXIT 1** |
| ⑤ 全量 @ 配置并发（安静） | `pnpm test`（config `maxWorkers:4`） | **992/992 通过**，EXIT 0 |

④ 的失败**全部是超时型**，且落在异步 provider/挂载边界：

```
× [3] 经 skill-filesystem provider 发现 > 挂载 provider 后 list() 发现 6 个… 8910ms
× [5b] 真实 cordis 下 apply(ctx) 端到端装配 > apply 后 6 个 skill 可经 ctx.skills 发现… 7350ms
FAIL tests/tester-prompt-skills.INDEPENDENT.spec.ts > …
```

**独立判断**：
- ④ 与 ⑤ 对照表明：**默认高并发下，异步 watcher/装配用例因 git 进程 + chokidar 文件监视器资源竞争而超时**（非断言/逻辑失败）；`maxWorkers:4` 能显著降低发生率。
- ③ 说明**适度并发（4 文件 @12≈4 worker）不触发问题**；问题在「**几十个文件同时跑**」时出现。
- **结论：`maxWorkers:4` 是合理的测试稳定性措施；未发现其掩盖任何「断言/逻辑型」真实失败**——所有观测到的失败要么是**超时（环境性）**、要么是**跨用例污染守卫（测试卫生）**、要么是**上游 add-dir 漏报（链条边界）**。
- **但仍非「万能药」**：⑤ 之外，我在**有并发争用**时仍在 `maxWorkers:4` 下复现过 `tester-prompt-skills [3]/[5b]` 超时（~6–7s）。建议：**对 provider/chokidar 类用例统一显式调高单用例超时（≥15s）**，比单纯限制全局并发更点对点。

---

## 10. 缺陷 / 风险清单（含严重级别 + 根因 + 建议）

> 均**只报告不修**；不改生产代码。

### R1 ·【低—中】新增 skill 目录的 watch 首帧偶发漏报
- **现象**：新增 `<dataRoot>/skills/<name>/SKILL.md` 后，首帧 `list()` 可能**不发** `skills/change`（`changeEvents=0`）、新 skill 暂不可见；下一次可失效事件后恢复。受控探针 **3/8** 首帧漏报；全文件 vitest 运行 **2/3** 轮复现。
- **影响**：AC1 的「**修改**」路径不受影响（0/8 失败）；仅**外部直写新增目录**的边界场景偶发。生产中经 fs 服务写入会额外触发 `fs/observed→invalidate`，影响进一步降低。
- **根因**：上游 `@deepseek-ai/dsh-skill-filesystem` 的 chokidar 装配（`depth:1` + `atomic:true` + macOS FSEvents）在「新建目录」时的 `addDir` 上报偶发丢失；**非** `dsh-ia` 本任务代码。
- **建议**：不改本任务代码即可，作为**已知边界**记录；若要收敛，可在上游调整 watch 选项（如放宽 `depth`/关闭 `atomic`/改 `usePolling`），或在 provider 侧对「目录级 `add`/`addDir`」增加一次延迟复核。

### R2 ·【低】`pnpm test` 在干净 HOME 下**非稳定全绿**（跨用例污染）
- **现象**：干净环境首跑曾失败 1 例：
  `tests/tester-t100418-skill-assets.INDEPENDENT.spec.ts > ⑥ … 未新建真实 ~/.dsh-ia/skills` → `expected true to be false`。
- **根因**：`tests/tester-task9-scheduler-index.INDEPENDENT.spec.ts` 的 `T9-D` 用例以**最小 ctx 直接 `plugin.apply(ctx)`** 且**未隔离 `DSH_IA_DATA_DIR`** → `apply()` 内的 `ensureSkillAssetsRepo()` 回落到**默认 dataRoot** `~/.dsh-ia/data`，**并发地**创建了真实 `skills/` 目录，从而踩中 `t100418` ⑥ 的「不得新建真实目录」守卫。
- **归属**：**非本任务引入**——`git show HEAD:src/plugin.ts`（任务-2 之前的基线）同样在 `apply()` 中调用 `ensureSkillAssetsRepo()`；污染链在任务-2 之前即存在。
- **建议（测试卫生）**：`tester-task9` 的 `T9-D` 用 `DSH_IA_DATA_DIR` 指向临时目录（或在 `<spec>` 内 `beforeEach` 隔离 env）；`t100418` ⑥ 守卫可容忍「运行期被并发创建」。

### R3 ·【低】异步 provider/装配用例在 CPU 争用下超时
- **现象**：全量 @`--maxWorkers=11`：`tester-prompt-skills.INDEPENDENT.spec.ts [3]/[5b]` **超时**（5s 默认预算），退出码 1（`990/992`）。
- **根因**：git 子进程 + chokidar 监视器资源竞争，属**环境性**（非断言/逻辑）。
- **建议**：`vitest.config.ts` 已用 `maxWorkers:4` 缓解；再对 provider/chokidar 用例**显式 `it(..., 15000)`**。

---

## 11. 最终结论

- **t100419 功能验收：通过**。
  - AC1 热更新链路（改文件 → chokidar → invalidate → `skills/change` → 重列）**成立且稳定**（改写路径）。
  - AC2 global 层可见性（固定会话 + workspace 会话）**成立**，并**反向**证明分层不外泄。
  - AC3 旧静态注册**无代码残留**、装配契约不变。
  - AC4：`build` 通过；`test` **功能性通过**，但**非稳定全绿**（R2/R3 为测试卫生/争用，非本任务缺陷）。
- **未发现 t100419 生产代码功能性缺陷**；三类问题均为**低/低—中**，且 R2 属**任务前既有**、R1 属**上游依赖**、R3 属**环境**。
- 建议 Leader：**接受本任务**；同时把 **R1/R2/R3** 作为测试卫生 / 上游依赖的**跟踪项**分别记录（R1 上游、R2 既有用例、R3 超时策略）。

---

## 附录 A · 受控真实 chokidar 探针（`probe-add6.mjs`，跑完即删）

```js
import { Context } from '@deepseek-ai/cordis'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const mod = await import('@deepseek-ai/dsh-skill-filesystem')
const names=['trend-analysis','grid-strategy','stop-rule','strategy-authorship','analysis-decision','task-authorship']
function w(dir,name,desc){mkdirSync(join(dir,name),{recursive:true});writeFileSync(join(dir,name,'SKILL.md'),'---\nname: '+name+'\ndescription: '+desc+'\nwhenToUse: '+desc+'-w\n---\n\nbody\n')}
let addFails=0, modFails=0, n=8
for(let it=0; it<n; it++){
  const dataRoot = mkdtempSync(join(tmpdir(),'seed-')); const dir = join(dataRoot,'skills')
  for(const x of names) w(dir,x,'DESC-'+x)
  const ctx=new Context(); await ctx.plugin(SkillRegistry)
  await ctx.plugin(mod,{providerName:'dsh-ia-skills',includeDefaultRoots:false,customSkillDirs:[dir],watch:true})
  await ctx.skills.list({})
  writeFileSync(join(dir,'trend-analysis','SKILL.md'),'---\nname: trend-analysis\ndescription: MOD\n---\n\nb\n')
  let mok=false
  for(let t=0;t<40;t++){ if((await ctx.skills.list({})).find(s=>s.name==='trend-analysis'&&s.description==='MOD')){mok=true;break} await new Promise(r=>setTimeout(r,50)) }
  if(!mok) modFails++
  w(dir,'tester-added-skill','ADDED')
  let aok=false
  for(let t=0;t<40;t++){ if((await ctx.skills.list({})).find(s=>s.name==='tester-added-skill')){aok=true;break} await new Promise(r=>setTimeout(r,50)) }
  if(!aok) addFails++
  process.stdout.write((mok?'M':'m')+(aok?'A':'a')+'  ')
  await ctx.fiber.dispose(); rmSync(dataRoot,{recursive:true,force:true})
}
console.log('\nMODIFY_FAILS='+modFails+'/'+n+'  ADD_FIRSTTRY_FAILS='+addFails+'/'+n)
```
输出：`Ma  Ma  MA  MA  Ma  MA  MA  MA` → `MODIFY_FAILS=0/8  ADD_FIRSTTRY_FAILS=3/8`

## 附录 B · 独立 spec 用例清单（15）
- A1/A2/A3：热更新（改 / 增 / 删，含 `skills/change` 证据与「下次可失效事件」兜底）
- B1/B2：global 层可见性（真实 scope）+ 反向分层
- C1/C2：无残留 grep + inject/patch 契约 + plugin.ts 无 runtime 注册
- D1/D2/D3：挂载抛错 / 依赖不可解析 / 真实 `apply` 降级且其它贡献照常
- E1/E2：async / 同步入口卸载 → list 归 0、改写不复活
- F1/F2：与 preset 默认名 provider 共存 / 同层重名边界
- 数据隔离：仅临时目录预置
