# t100419 独立测试报告 —— dsh-finance 接入 dsh 原生 `skill-filesystem` provider（热更新）

- **任务编号**：t100419（[skill重构任务清单]任务-2）
- **被测交付物**：`dsh-finance` 接入 dsh 原生 `skill-filesystem` provider（指向 `<dataRoot>/skills`，`watch:true` 热更新），替换旧静态注册
- **项目路径**：`/Users/reachlucifer/project/opc/dsh-finance`
- **执行环境**：macOS（Reach 的 MacBook Pro），Node **v25.9.0**，pnpm **11.7.0**，vitest **3.2.7**，`hw.ncpu=12`
  - ⚠️ 执行期间宿主机上存在**另一并行 vitest 会话**（另一 subagent/前次尝试遗留的 `hc12`/`hc1`/`full11` 等实验进程，实测出现多个 `vitest run` 并发）。本报告将「安静机器」的测量作为权威基线，并在 §9 存档「存在并发争用」时的对照结果。
- **测试范围**：**运行时行为验证**（非静态/格式复查）
- **独立测试文件**：`tests/tester-t100419-skill-provider.INDEPENDENT.spec.ts`（15 用例，含真实 chokidar，30s 超时）
- **独立探针脚本**：`t100419-independent-probe.mjs`（临时，跑完已删；源码见附录 A，直接 `node` 运行，绕过 vitest）
- **执行时间**：2026-10-11 00:23 – 00:31（GMT+8）

---

## 0. 结论（TL;DR）

> ### ✅ **t100419 验收通过**
>
> 4 条验收标准（AC1–AC4）+ A–H 8 个独立验证点**全部通过**。核心热更新链路（改文件 → chokidar → invalidate → `skills/change` → 重列）、global 层 scope 可见性、降级对抗、卸载语义、与 preset provider 共存均以**真实装配**（真实 `SkillRegistry` + 真实 chokidar + 真实 `dsh-scope`）验证。
>
> **未发现生产代码缺陷**。仅有 1 条**低风险观察**（§H：`vitest.config.ts` 并发上限属合理的测试稳定性措施，非掩盖通病；另建议对 provider 类用例统一调高默认超时），详见 §9。

| 验收标准 | 结论 |
|---|---|
| AC1 改 `SKILL.md` 无需重启，下次会话生效（热更新闭环） | ✅ 通过 |
| AC2 固定会话与 workspace 会话均可见 6 个 skill（global 层） | ✅ 通过 |
| AC3 旧静态注册删除、无残留引用 | ✅ 通过 |
| AC4 `pnpm test` 全绿、`pnpm build` 通过 | ✅ 通过 |

---

## 1. 验证方法与环境隔离

- **数据隔离**：全部用例/探针使用 `mkdtempSync` 临时 `dataRoot`，并显式 `DSH_FINANCE_DATA_DIR` 指向临时目录；**不触碰** `~/.dsh-finance`。
  - 注：`~/.dsh-finance/data`（空目录）由**其它任务**的 `tests/tester-path-fixed-dir.INDEPENDENT.spec.ts` 有意创建（该用例专测真实 home 路径创建），与本任务无关，未在 t100419 流程中写入任何内容。
- **真实装配**：`new Context()` + `ctx.plugin(SkillRegistry)` 实例化真实注册表；`mountSkillFilesystemProviderAsync(ctx,{dataRoot})` 挂载真实 provider（`watch:true`，chokidar 稳定阈值 200ms）；scope 用真实 `@deepseek-ai/dsh-scope`（经 `@deepseek-ai/dsh-skill` 同侧 pnpm 路径解析）`createScope`。
- **不动生产代码**：仅新增/运行测试与报告。

---

## 2. 逐条验收标准结论

### AC1 热更新闭环 ✅

**链路证据链**（`list()` 侧刷新 + `skills/change` 事件，非 `get()` 的磁盘直读）:

独立探针（真实 chokidar）：

```
LIST after mount: 6 providers= [ 'dsh-finance-skills' ]
A1 hot-reload: OK 419ms changeEvents= 1 bodyOK= true
```

`tests/tester-t100419-skill-provider.INDEPENDENT.spec.ts` A1（证据行）：

```
[EVIDENCE A1] changeEvents=1, before="研判标的当前趋势方向、震荡区间与置信度，输出方向 + 区间 + 关键观测点。" after="TESTER-HOT-NEW-DESC"
```

- 改写 `<dataRoot>/skills/trend-analysis/SKILL.md` 的 `description`/`whenToUse`/正文 → **无需重启**；
- 「目录侧」（catalog）在下一次 `list()` 即反映新 `description`（429/737ms 量级）；
- `ctx.skills.get()` 正文同步为新内容；
- `skills/change` 事件计数 ≥1 → 证明走的是 `invalidate → notifyChange → 重列`，而**非** `get()` 每次直读磁盘造成的假象。

### AC2 global 层可见性（固定会话 / workspace 会话均见 6 个）✅

- provider 在**未 scoped** 的插件 ctx 挂载 → 注册进 **global 层**；`SkillRegistry.collectFresh` 固定合并 `[global, ...scopeChain]`，故任意 scope 读取方均可见。
- 真实 scope 验证（A 探针；`B chainLen(ws-session)= 2` 表示 workspace→session 父子链成立）：

```
B fixed cores= 5 allProvider= true       # 该探针中先删过 stop-rule，故为 5（剩 5 个 core）
B ws-session cores= 5 allProvider= true   # 两类 scope 均命中，来源 provider 均为 dsh-finance-skills
```

- 独立 spec B1 用**全新** dataRoot（6 个）分别对「固定会话 scope」与「workspace→session 链 scope」断言：

```
[EVIDENCE B1] fixed-session & workspace-session scope both see 6 via dsh-finance-skills
```

- B2 反向验证分层语义：在 workspace scope 内注册的私有 provider **仅**该 scope 及子链可见；固定 scope 与 global 视图**看不到**它，但仍见 global 的 6 个。

### AC3 无残留引用 ✅

代码（`*.ts/mts/cts/js/mjs`，`src/**` + `tests/**`）grep：

```bash
grep -rn -E "registerAllSkills|createAllSkillRegistrations|createSkillRegistration|ctx\.skills\.register\(" \
  --include="*.ts" --include="*.mts" --include="*.cts" --include="*.js" --include="*.mjs" src tests
# → (NO code residual)
```

独立 spec `[EVIDENCE C1] offenders=0`。

- `src/plugin.ts`：不再出现 `ctx.skills.register(`；改为 `ensureSkillAssetsRepo()`（L146）→ `mountSkillFilesystemProvider(ctx)`（L156），均 try/catch 降级。
- 顶层 `inject` 严格等于 `['tools','skills','fs']`；`cordis.patch.yml` 的 `inject: ['tools', 'skills', 'fs']` 一致（`[EVIDENCE C2] inject=tools,skills,fs`）。
- 仅历史 `.md` 报告（如 `tests/tester-*.REPORT.md`）文本中存在旧函数名，**非代码引用**，不影响构建/运行。

### AC4 `pnpm test` 全绿 + `pnpm build` 通过 ✅

见 §8 回归基线（typecheck/build/test 退出码）。

---

## 3. 独立验证点 A —— 真实热更新闭环（改 / 增 / 删）✅

真实 dataRoot + 真实 chokidar（`watch:true`）：

| 场景 | 结果 | 耗时（隔离运行） |
|---|---|---|
| A1 改写 `SKILL.md`（description+whenToUse+正文）→ catalog 刷新 | ✅ `changeEvents=1` | ~0.4–0.7s |
| A2 新增合规 skill 目录 → catalog 出现 | ✅ provider=`dsh-finance-skills` | ~0.4–4.0s（FSEvents 抖动） |
| A3 删除 skill 目录 → catalog 消失 | ✅ 剩 5 个 core | ~0.7s |

证据（独立 spec）：

```
[EVIDENCE A2] added "tester-added-skill" via provider=dsh-finance-skills
[EVIDENCE A3] deleted "stop-rule" (remaining core=5)
```

独立探针（v2，真实 chokidar，直接 node 运行）：

```
A1 hot-reload: OK 419ms changeEvents= 1 bodyOK= true
A2 add-dir: OK 537ms
A3 del-dir: OK 658ms
```

> ⚠️ **低风险观察**：A2（新增目录）在 macOS 上依赖 FSEvents，判读延迟在隔离运行中实测 **0.37s–4.0s** 波动；在**极端并发压力**下（见 §H，8 个 vitest worker 争用）曾单次超过 12s 轮询预算而失败。属**环境性延迟**，非产品缺陷（链路最终一致）。

---

## 4. 独立验证点 B —— global 层可见性 ✅

见 AC2。补充：B2 已证明**分层**正确（scoped provider 不外泄、global provider 处处可见），即「provider 落在 global 层」这一设计成立。

---

## 5. 独立验证点 C —— 无残留 & 装配正确 ✅

见 AC3。另核对：
- `src/skills/index.ts` 仅保留 `SKILL_NAMES` / `SkillName` / `loadSkillMarkdown` / `parseSkill`（+ 内部 `parseSkillFile`），已删除 `createSkillRegistration` / `createAllSkillRegistrations` / `registerAllSkills`。
- `src/skills/provider.ts`：`SKILL_PROVIDER_NAME='dsh-finance-skills'`；`mountSkillFilesystemProviderAsync` 动态 `import('@deepseek-ai/dsh-skill-filesystem')` → `ctx.plugin(mod,{providerName,includeDefaultRoots:false,customSkillDirs:[<dataRoot>/skills],watch:true})`；`mountSkillFilesystemProvider` 同步入口经 `ctx.effect` 托管注销器、失败降级不抛。

---

## 6. 独立验证点 D —— 降级对抗 ✅

`[EVIDENCE D1] sync wrapper degraded-logged; async wrapper rejected`
`[EVIDENCE D2] unresolvable module → sync degraded, no throw`
`[EVIDENCE D3] apply not thrown; effect labels=dsh-finance tools|...|dsh-finance skill-filesystem provider|...|dsh-finance scheduler; skills degraded to 0`

- D1：`ctx.plugin` 抛错 → `mountSkillFilesystemProviderAsync` reject；同步入口 `mountSkillFilesystemProvider` **不抛**并打 `[dsh-finance] skill-filesystem provider 挂载失败（降级）`。
- D2：`vi.doMock('@deepseek-ai/dsh-skill-filesystem', ()=>{throw ...})`（模拟不可解析）→ 同上降级。
- D3：**真实** `apply(ctx)` 在模块不可解析时**不抛**；`ctx.effect` 标签仍登记 `dsh-finance tools` 与 `dsh-finance skill-filesystem provider`（其它贡献照常装载）；skill 发现降级为 0，且有明确 `console.error` 日志。

---

## 7. 独立验证点 E —— 卸载语义 ✅

独立探针直接观测 **OS 资源**（比 spec 里基于资源名过滤更硬）：

```
RES before mount: []
RES during mount: ["CloseReq","PipeWrap",... ×23 "FSEventWrap"]
LIST after dispose: 0
RES after dispose: ["PipeWrap","PipeWrap"]          # FSEventWrap 归 0 → watch 全关
E post-dispose rewrite → list= 0 changeDelta= 0      # 卸载后改写不再触发清单/事件
PROBE-DONE (process exits naturally => no leaked persistent watcher)
```

- 挂载期间出现 23 个 `FSEventWrap`（chokidar 真实 watcher 句柄）；
- `dispose()` 后 `FSEventWrap` **归 0**、`list()` 归 0、改写文件不再产生 `skills/change`（`changeDelta=0`）；
- 进程**自然退出**（未挂起）→ 无 `persistent:true` 句柄泄漏。
- spec E1/E2 补充：async/同步两条入口 dispose 后核心 skill 均从 catalog 消失。

---

## 8. 独立验证点 F —— 与 preset provider 共存 ✅

- F1：同层再注册 `providerName:'filesystem'` 的 provider → 与 `dsh-finance-skills` **互不冲突**，各自可见：
  `[EVIDENCE F1] coexisting providers: 6 core + preset-skill`（`preset-skill` 来源 `filesystem`）。
- F2：同层重复 `providerName='dsh-finance-skills'` → 按注册表「同层重名即抛」语义 **reject**：
  `[EVIDENCE F2] duplicate providerName "dsh-finance-skills" rejected`。

---

## 9. 独立验证点 G / H —— 回归基线与 `vitest.config.ts` 审查

### G. 回归底线（真实退出码）

| 命令 | 退出码 | 结果 |
|---|---|---|
| `pnpm typecheck` | **0** | 通过，无输出 |
| `pnpm build` | **0** | 通过（`tsc --noEmit` + `tsc -p tsconfig.server.json` + 搬运 11 个资源到 `dist-server/`） |
| `pnpm test`（安静机器，config `maxWorkers:4`） | **0** | `Test Files 51 passed (51)` / `Tests 992 passed (992)`，Duration 23.59s |
| `pnpm test tests/skill-provider.spec.ts`（开发者自测） | **0** | `8 passed (8)`，3.44s |
| `pnpm test tests/tester-t100419-...INDEPENDENT.spec.ts`（本独立 spec，隔离 ×3） | **0** | 3/3 次 `15 passed (15)` |

### H. `vitest.config.ts`（`maxWorkers:4`）审查 —— **合理的稳定性措施，非掩盖真实失败**

**复现实验**：

1. 机器核数 `sysctl -n hw.ncpu` = **12**（即 vitest 默认并发 ≈ 12）。
2. **全量套件 @ 配置并发（4）**：`992 passed (992)`，退出码 0。
3. **全量套件 @ 显式拉高并发（`--maxWorkers=12`，覆盖配置）**：

   ```
   Test Files  1 failed | 50 passed (51)
   Tests       2 failed | 990 passed (992)
   FAIL tests/tester-prompt-skills.INDEPENDENT.spec.ts > [3] 经 skill-filesystem provider 发现 > 挂载 provider 后 list() 发现 6 个…
        → Test timed out in 5000ms.
   FAIL tests/tester-prompt-skills.INDEPENDENT.spec.ts > [5b] 真实 cordis 下 apply(ctx) 端到端装配 > apply 后 6 个 skill 可经 ctx.skills 发现…
        → Test timed out in 5000ms.
   ```

4. **穿插另一次全量运行（`maxWorkers:4`，但宿主机上有**另一并发 vitest 进程**争用 CPU）**：仅本独立 spec 的 A2 失败，`expected [...] to include 'tester-added-skill'`——即 12s 轮询预算被吃掉后触发的**超时型**失败。
5. **隔离单跑**（同一 spec，单文件 → 单 worker）：3/3 全绿；开发者 spec 单独跑全绿；且在有并行会话争用时重跑本 spec 仍 `15 passed (15)`、`EXIT=0`。
6. **重复全量运行（含并行会话争用）**：多次测得 `990/992`，失败用例**稳定落在** `tester-prompt-skills.INDEPENDENT.spec.ts [5b]` 的 `Test timed out in 5000ms`（其 provider 用例仍用默认 5s 超时）——再次印证「超时型、非断言型」。
7. **安静机器的权威基线**：`Test Files 51 passed (51)` / `Tests 992 passed (992)`，`Duration 23.59s`（日志 `/tmp/t100419-full-test2.log`）。

**判定依据**：
- 高并发下的失败**全部是 `Test timed out in …`**，即**资源竞争/时序**（CPU 12→12 但每 worker 跑真实 git/chokidar/FSEvents），**从无断言/逻辑失败**；
- 失败用例**每次不同**（一次是本 spec A2，一次是 `tester-prompt-skills` 的两个 provider 用例）→ **非确定性**，符合竞争特征；
- 降低并发即恢复全绿 → 支持「降低并行度稳定时序」的说法。

**结论**：`maxWorkers:4` 是**合理的测试稳定性措施**（不改变任何生产代码，仅降并行度）；**未发现**它在掩盖确定性缺陷。

**改进建议（非阻塞，交 Developer 评估）**：
- 该配置**全局**下调并发，会连带影响所有测试的并行收益；建议改为**只对实时/RT（真实 fs/git/chokidar）用例**做隔离或调高超时（如 vitest `testTimeout` / 项目级 30s），而非全局降并发。
- `tests/tester-prompt-skills.INDEPENDENT.spec.ts` 的 provider 用例仍用**默认 5s** 超时（高并发下最先超时）；建议对齐 `skill-provider.spec.ts` 的 30s 预算。
- 配置注释里的用例数「977」与本机实测「992」略有出入（属注释陈旧，无害）。

---

## 10. 关键命令与产物索引

```bash
# 被测代码静态核对（只读）
grep -rn -E "registerAllSkills|createAllSkillRegistrations|createSkillRegistration|ctx\.skills\.register\(" \
  --include="*.ts" --include="*.js" src tests        # → 无

# 回归
pnpm typecheck && pnpm build && pnpm test            # → 全 0 退出

# 独立用例
pnpm test tests/tester-t100419-skill-provider.INDEPENDENT.spec.ts   # → 15 passed
pnpm exec vitest run --maxWorkers=12                 # 高并发对比实验（见 §9-H）
```

- 运行日志（宿主机 /tmp，临时）：`/tmp/t100419-full-test2.log`（安静全量）、`/tmp/t100419-mw12.log`（高并发）、`/tmp/ind-run.log`（独立 spec 隔离 ×3）。
- **临时资源清理**：探针脚本与 `<TMPDIR>/dsh-fin-t100419-*` 临时目录已删除；`~/.dsh-finance` 未被 t100419 写入。

---

## 11. 未通过项 / 缺陷清单

**无。** 生产代码未发现缺陷，无阻塞项。

**低风险观察（1 条，非缺陷）**：
- **[Low] A2 新增 skill 目录的可见性延迟在 macOS FSEvents 下抖动较大（0.37–4.0s），极端并发下可超过测试轮询预算。** 根因：chokidar + macOS FSEvents 的事件投递延迟（环境性），链路本身为最终一致。建议：将 provider 类用例的超时统一放宽至 ≥20–30s（测试侧加固），无需改生产代码。

---

## 附录 A —— 独立探针源码（`t100419-independent-probe.mjs`，已运行后删除）

```js
import { createRequire } from 'node:module'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import { mountSkillFilesystemProviderAsync, SKILL_PROVIDER_NAME } from './dist-server/skills/provider.js'
import { ensureSkillAssetsRepo, resolveSkillsRepoDir, SKILL_FILENAME } from './dist-server/skills/repo.js'

const require = createRequire(import.meta.url)
const skillEntry = require.resolve('@deepseek-ai/dsh-skill')
const scopeEntry = join(dirname(dirname(dirname(skillEntry))), 'dsh-scope', 'lib', 'index.js')
const dshScope = await import(pathToFileURL(scopeEntry).href)

const CORES = ['trend-analysis','grid-strategy','stop-rule','strategy-authorship','analysis-decision','task-authorship']
const TARGET = 'trend-analysis'
const dataRoot = mkdtempSync(join(tmpdir(), 't100419-probe-'))
const skillsDir = resolveSkillsRepoDir(dataRoot)
process.env.DSH_FINANCE_DATA_DIR = dataRoot
ensureSkillAssetsRepo({ dataRoot, logger: () => {} })

const ctx = new Context(); await ctx.plugin(SkillRegistry)
const rawRes = () => (process.getActiveResourcesInfo ? process.getActiveResourcesInfo() : ['<unsupported>'])
const listOf = async (scope) => ctx.skills.list(scope === undefined ? {} : { scope })
const core = (all) => all.map(s => s.name).filter(n => CORES.includes(n)).sort()
const mkSkill = (dir, name, desc) => { const d = join(dir, name); mkdirSync(d, { recursive: true }); writeFileSync(join(d, SKILL_FILENAME), `---\nname: ${name}\ndescription: ${desc}\n---\n\n# ${name} body\n`, 'utf8') }

console.log('RES before mount:', JSON.stringify(rawRes()))
const mount = await mountSkillFilesystemProviderAsync(ctx, { dataRoot })
console.log('LIST after mount:', (await listOf()).length, 'providers=', [...new Set((await listOf()).map(s => s.provider))])
console.log('RES during mount:', JSON.stringify(rawRes()))

let changes = 0; ctx.on('skills/change', () => { changes += 1 })
const t0 = Date.now()
writeFileSync(join(skillsDir, TARGET, SKILL_FILENAME), `---\nname: ${TARGET}\ndescription: PROBE-HOT-DESC\nwhenToUse: PROBE-HOT-WHEN\n---\n\n# PROBE-HOT-BODY\n`, 'utf8')
let hotMs = -1
for (let i = 0; i < 150; i++) { const l = await listOf(); if (l.find(s => s.name === TARGET)?.description === 'PROBE-HOT-DESC') { hotMs = Date.now() - t0; break } await new Promise(r => setTimeout(r, 100)) }
const def = await ctx.skills.get(TARGET)
console.log('A1 hot-reload:', hotMs >= 0 ? `OK ${hotMs}ms` : 'FAIL', 'changeEvents=', changes, 'bodyOK=', def.content.includes('PROBE-HOT-BODY'))

mkSkill(skillsDir, 'probe-added', 'PROBE-ADDED')
let addMs = -1
for (let i = 0; i < 150; i++) { if ((await listOf()).some(s => s.name === 'probe-added')) { addMs = Date.now() - t0; break } await new Promise(r => setTimeout(r, 100)) }
console.log('A2 add-dir:', addMs >= 0 ? `OK ${addMs}ms` : 'FAIL')

rmSync(join(skillsDir, 'stop-rule'), { recursive: true, force: true })
let delMs = -1
for (let i = 0; i < 150; i++) { if (!(await listOf()).some(s => s.name === 'stop-rule')) { delMs = Date.now() - t0; break } await new Promise(r => setTimeout(r, 100)) }
console.log('A3 del-dir:', delMs >= 0 ? `OK ${delMs}ms` : 'FAIL')

const fixedKey = { k: 'fixed' }, wsKey = { k: 'ws' }, wsSessKey = { k: 'ws-session' }
const s1 = dshScope.createScope(ctx, fixedKey), s2 = dshScope.createScope(ctx, wsKey), s3 = dshScope.createScope(ctx, wsSessKey, { parent: wsKey })
console.log('B chainLen(ws-session)=', dshScope.scopeChainOf(wsSessKey).length)
const vFixed = await listOf(fixedKey), vWs = await listOf(wsSessKey)
console.log('B fixed cores=', core(vFixed).length, 'allProvider=', vFixed.every(s => s.provider === SKILL_PROVIDER_NAME))
console.log('B ws-session cores=', core(vWs).length, 'allProvider=', vWs.every(s => s.provider === SKILL_PROVIDER_NAME))

await mount.dispose()
console.log('LIST after dispose:', (await listOf()).length)
const changesBefore = changes
await new Promise(r => setTimeout(r, 400))
console.log('RES after dispose:', JSON.stringify(rawRes()))
writeFileSync(join(skillsDir, TARGET, SKILL_FILENAME), `---\nname: ${TARGET}\ndescription: POST-DISPOSE\n---\n\nx\n`, 'utf8')
await new Promise(r => setTimeout(r, 1500))
console.log('E post-dispose rewrite → list=', (await listOf()).length, 'changeDelta=', changes - changesBefore)

await s1.dispose(); await s2.dispose(); await s3.dispose(); await ctx.fiber.dispose()
rmSync(dataRoot, { recursive: true, force: true })
console.log('PROBE-DONE (process exits naturally => no leaked persistent watcher)')
```

**探针实测输出**：

```
RES before mount: []
LIST after mount: 6 providers= [ 'dsh-finance-skills' ]
RES during mount: ["CloseReq","PipeWrap","PipeWrap","FSEventWrap", ... ×23 ]
A1 hot-reload: OK 419ms changeEvents= 1 bodyOK= true
A2 add-dir: OK 537ms
A3 del-dir: OK 658ms
B chainLen(ws-session)= 2
B fixed cores= 5 allProvider= true
B ws-session cores= 5 allProvider= true
LIST after dispose: 0
RES after dispose: ["PipeWrap","PipeWrap"]
E post-dispose rewrite → list= 0 changeDelta= 0
PROBE-DONE (process exits naturally => no leaked persistent watcher)
PROBE_EXIT=0
```

---

## 附录 B —— 独立测试文件覆盖映射

`tests/tester-t100419-skill-provider.INDEPENDENT.spec.ts`（15 用例）：

| 分组 | 用例 | 对应点 |
|---|---|---|
| A 真实热更新闭环 | A1 改写 / A2 新增 / A3 删除 | AC1、A |
| B global 层可见性 | B1 固定+workspace 会话 scope / B2 分层反向 | AC2、B |
| C 无残留&装配 | C1 代码 grep / C2 inject+patch+plugin | AC3、C |
| F 共存 | F1 同层共存 / F2 重名边界 | F |
| D 降级对抗 | D1 挂载抛错 / D2 不可解析 / D3 真实 apply | D |
| E 卸载语义 | E1 async dispose / E2 同步入口 dispose | E |
| 数据隔离 | 临时目录断言 | 隔离约束 |

> 说明：本独立 spec 由测试方自行构造（真实 `SkillRegistry` + 真实 chokidar + 真实 `dsh-scope`），非复跑开发者 `tests/skill-provider.spec.ts` 的用例；两者并存且各自通过。
