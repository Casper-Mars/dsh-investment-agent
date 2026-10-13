# 独立测试报告 — t100435 日志优化·任务-2（里程碑 M2「文件落地」）复验（含收口修复）

- **任务**：t100435（[日志优化]任务-2 / M2 文件落地）+ 收口修复复验
- **被验对象（工作区改动，未 commit）**：`src/log/file-exporter.ts`(新增)、`src/log/logger.ts`、`src/paths.ts`、`src/plugin.ts`、`vitest.config.ts`；Developer 自测 `tests/file-exporter.test.ts`(20 用例)；收口新增 `tests/setup.ts`
- **基线**：HEAD `4eeb7f7`（`feat(log): 统一日志门面替换散乱 console（t100434）`）；仓库 `main` 无 remote
- **独立测试文件**：`tests/tester-t100435-file-exporter.INDEPENDENT.spec.ts`（**47 用例，对抗 / 边界导向**；本轮按新语义修订）
- **环境**：节点 Reach的MacBook Pro；macOS；Node v25.9.0 / pnpm 11.7.0 / vitest v3.2.7 / cordis 4.0.4
- **判定日期**：2026-10-12
- **工作方式**：仅修订本方测试产物（spec / REPORT）；**未改 `src/`、未 commit / 未 push**；全程以临时 `DSH_IA_LOG_DIR`(+ 临时 `DSH_IA_HOME`/`DSH_IA_DATA_DIR`) 隔离

---

## 一、结论先行

**✅ 收口两处修复均达成预期：Fix 1（name 白名单）与 Fix 2（测试隔离）经独立验证通过；M2 原验收全部回归通过。**
**⚠️ 1 项需后续修复的非阻断缺陷：Fix 2 的临时目录清理在 vitest 下不生效（`process.on('exit')` 不触发），每次跑测残留 1 个临时目录/测试文件（不污染真实 home，但需清理）。**

- 修订后独立 spec：**47/47 通过**（此前旧语义下 18 用例与白名单冲突）。
- 全量回归三命令：`typecheck`=0、`build`=0、`test`：**run1=0、run2=0**、run3=1（**既有 chokidar flaky**，非本变更；隔离复跑该文件 33/33 绿）。
- 隔离（真实 `~/.dsh-ia/logs` 不被创建）：**通过**；临时目录清理：**未生效（见六/七节）**。

| 复验点 | 判定 | 关键证据 |
|---|---|---|
| B1 name 白名单 | ✅ 通过 | AC10-1…8：裸名/子 scope 落盘；host-core/svc/other-plugin/skill-filesystem/dsh-iax 不落盘；`options.names` 注入；空数组回落默认 |
| B2 级别过滤 × 白名单叠加 | ✅ 通过 | AC11-1…3 + AC3-1…6：仅白名单命中时级别过滤生效；两道过滤独立且须同时满足 |
| B3 真实 ctx 装配落隔离目录 | ✅ 通过 | AC2-1/2/3；实测真实 ctx 日志落 `$TMPDIR/dsh-ia-testlogs-*/<date>.jsonl`，含「插件加载」 |
| B4 测试隔离（重点） | ✅ 隔离生效 / ⚠️ 清理未生效 | 真实 home `~/.dsh-ia/logs` **不存在**；但 `$TMPDIR/dsh-ia-testlogs-*` **有残留**（详见第六节） |
| B5 回归 M2 原验收 | ✅ 通过 | AC1/AC4/AC5/AC6/AC7/AC9 全部复跑通过 |
| B6 全量回归 | ✅ 通过* | `typecheck`=0、`build`=0、`test` run1/run2=0；*run3 既有 flaky，见第五节 |

---

## 二、A · 本独立 spec 的修订（旧语义 → 新语义）

原 spec 按**旧语义（无白名单）**编写，默认消息 `name:'test'`、并显式断言「非 `dsh-ia` 名字也落盘（OBS-A-1，无 name 白名单）」。本轮按 Fix 1 新语义修订：

1. **默认消息名**：`msg()` 默认 `name` 由 `'test'` → **`'dsh-ia'`**（白名单命中，使默认用例可落盘）。
2. **AC6 宿主并列用例**：原 `app.logger('svc')` → **`app.logger('dsh-ia:svc')`**（文件 exporter 现只接本插件命名空间；宿主既有 exporter 仍收全量）。
3. **OBS-A 重写**：由「非本插件 name 也落盘」改为 **「白名单生效：非本插件 name 不再落盘」**，并配对照用例（本插件命名空间仍落盘）。
4. **新增 AC10（8 用例）/ AC11（3 用例）**：白名单正/反例、`options.names` 注入与空数组回落、白名单 × 级别叠加。

> 修订后 47 用例全绿（原 35 用例 → 现 47 用例）。旧 REPORT 中「18 failed」的根因即旧 spec 与 Fix 1 冲突，本已消除。

---

## 三、B · 复验点逐条证据

### B1 name 白名单（Fix 1）✅
实现：`export()` 内**先** `matchesName(message.name)`（`name === p` 或 `name.startsWith(p + ':')`，`p ∈ options.names`，默认 `DEFAULT_EXPORT_NAMES = ['dsh-ia']`）**再** `shouldEmit(type)`。

- **AC10-1**：`dsh-ia`（裸名）、`dsh-ia:tools`、`dsh-ia:scheduler:runner`（多级子 scope）均落盘，`name`/`msg` 顺序正确。
- **AC10-2（反例）**：`host-core` / `svc` / `other-plugin` / `other-plugin:sub` / `skill-filesystem` / 空串 → **目录内无任何文件**。
- **AC10-3（边界）**：`dsh-iax`（前缀但非 `:` 分隔）/ `dsh-ia-x` / `dsh` → **不落盘**。
- **AC10-4（真实 ctx）**：同一 `LoggerService` 上 `dsh-ia` / `dsh-ia:scheduler` 落盘，`host-core` / `skill-filesystem` 被丢弃。
- **AC10-5/6（注入）**：`names:['my-plugin']` 时仅 `my-plugin:*` 落盘、`dsh-ia` 不再匹配；`names:['dsh-ia','extra']` 多前缀可扩展。
- **AC10-7（回落）**：`names:[]` 与 `names:['  ','']`（全空白）→ **回落默认白名单**（避免误配全丢）。
- **AC10-8**：`DEFAULT_EXPORT_NAMES` 展开为 `['dsh-ia']`。

### B2 级别过滤 × 白名单叠加 ✅
- **AC11-1**：阈值 `debug`（cordis 侧全放行）下，`host-core`(debug) / `svc`(error) 仍**不落盘**，仅 `dsh-ia`(debug) 落盘 → 级别不凌驾白名单。
- **AC11-2**：阈值 `error` 下，`dsh-ia:session` 的 info 被抑制、error 落盘。
- **AC11-3**：仅白名单命中（info）× 仅级别达标（host-core error）→ 均不落盘；须**同时满足**才落（5 组真值表）。
- **AC3-1…6（原级别语义回归）**：默认 info → `[error,warn,info]`；env `error/warn/debug` 按方案严重度序；`options.level` 优先；`type` 与数值 `level` 故意不一致时以 `type` 为准；`LEVEL_RANK={error:0,warn:1,info:2,debug:3}`；阈值构造期解析。

### B3 真实 ctx 装配 → 隔离目录 ✅
- **AC2-1**：`new Context()` + `apply(ctx)` → 日志落入 `DSH_IA_LOG_DIR/<UTC-date>.jsonl`，含 `插件加载`、`name=investment-advisor`、`"pid":…`、`"origin":"host"`。
- **AC2-2**：`apply` 期间 console 全打桩 → 无一条 console 含「插件加载」，文件中有 → **非 console 兜底**。
- **AC2-3**：无 `logger` 的 mock ctx → 不抛、目录不创建、降级走 console。
- **实测（隔离目录内容）**：以真实 ctx 跑既有测试后，日志进入 `$TMPDIR/dsh-ia-testlogs-<rand>/2026-10-12.jsonl`，其 `name` 去重结果为 `dsh-ia`(×2) / `dsh-ia:skills`(×2) —— **白名单端到端生效**（旧实现会写入 `skill-filesystem` 条目）。

### B4 测试隔离（Fix 2）✅ 隔离生效 / ⚠️ 清理未生效
**核心目标（不污染真实 home）达成：**
- 单独运行 `tests/plugin-tools-registration.spec.ts`（以**真实 ctx** 调 `apply()` 且**未显式设置**日志目录）：
  - 运行前 `~/.dsh-ia/logs` 不存在；**运行后仍不存在**（`ls` 报 No such file or directory）。
  - 该次运行产生的日志出现在**隔离临时目录**（含「插件加载」）而**非**真实 home。
- 完整套件跑完后：真实 `~/.dsh-ia/` 仅含 `data/`（空），**无 `logs` 目录**。

**但清理目标未达成（详见第六节）**：`$TMPDIR/dsh-ia-testlogs-*` 在每次跑测后**残留**（约 1 个/测试文件）；`tests/setup.ts` 仅注册 `process.on('exit')`，而 vitest fork worker 以 **SIGTERM** 终止 → exit 回调不触发。

### B5 回归 M2 原验收 ✅
- **AC4-1…4**：跨天轮转 / 同日小阈值 `-1/-2` 后缀（行守恒）/ 单行超阈值每行独立成文件 / 预置满文件首条即轮转。
- **AC5-1…3**：目录 `0o700` / 文件 `0o600`；`umask=0o000` 干扰下仍严格；既有宽松权限被 chmod 收敛。
- **AC6-1…3**：追加注册并存（宿主既有 exporter 与文件 exporter 同收、互不干扰）；dispose 文件 exporter 后文件不增长、宿主照收；dispose 宿主 exporter 后文件照写。
- **AC7-1…5**：ENOTDIR / EISDIR / 目录不可写 / 循环引用 meta → `export()` 均不抛，且同实例后续自愈。
- **AC9-1…3**：本 spec 唯一标记未写入真实 `~/.dsh-ia/logs`；`resolveFinanceLogDir()` 默认解析为 `~/.dsh-ia/logs` 且为纯计算（无副作用）。

### B6 全量回归 → 见第五节

---

## 四、观察项（如实报告）

### 观察项 A — 采集范围 ✅ **已由 Fix 1 解决（加白名单）**
- **旧行为**：文件 exporter 注册在共享 `ctx.logger`，无 name 白名单 → 宿主核心 / 其它插件（如 `skill-filesystem`）日志一并落盘（旧 REPORT 已在真实 home 观察到 `"name":"skill-filesystem"`）。
- **现行为**：`export()` 先 `matchesName` → 仅 `dsh-ia[:scope]` 落盘；`options.names` 可扩展。
- **本轮证据**：AC10-2/3/4 + OBS-A-1/2 → `host-core`/`svc`/`other-plugin:sub`/`skill-filesystem`/`dsh-iax` 均**不落盘**；真实 ctx 落盘日志 `name` 去重仅 `dsh-ia*`。**旧观察项 A 关闭。**

### 观察项 B — 日期口径（UTC）✅ 行为符合设计，可用性有取舍
- `message.ts = 2026-10-12T16:30:00Z`（**上海本地 2026-10-13 00:30**）→ 文件名取 UTC 日 = `2026-10-12.jsonl`，与本地日 `10-13` 错位；记录内 `ts` 同为 UTC（二者一致）。属**可用性取舍，非缺陷**，与上轮结论一致。

### 观察项 C — 非本期项（按任务卡声明，勿判失败）✅ 不变
- 去敏（M5）、`trace` 字段（M4）、任务进程日志（M3）均未实现；
- `prompts/index.ts`、`skills/provider.ts`、`tools/context.ts` 三处**模块级降级 logger** 不经 native exporter（走 console 兜底），日志不入文件 —— 与本轮 spec 中观察到的 `ctx.plugin is not a function`（provider 降级）经 console 输出一致。属**已知观察项，不变**。
- `scripts/jev-news-demo.*` 为开工前遗留，**本轮未触碰**。

---

## 五、全量回归（独立复跑，非采信自述）

| 命令 | 结果 | 退出码 |
|---|---|---|
| `pnpm typecheck` (`tsc -p tsconfig.json --noEmit`) | 无错误 | **0** |
| `pnpm build` (`clean && tsc --noEmit && tsc -p tsconfig.server.json && copy-assets`) | 成功，搬运 11 个资源 | **0** |
| `pnpm test`（run1） | **Test Files 60 passed / Tests 1174 passed** | **0** |
| `pnpm test`（run2） | **Test Files 60 passed / Tests 1174 passed** | **0** |
| `pnpm test`（run3） | 1 failed / 59 passed；**1173 passed / 1 failed** | **1** |
| 本独立 spec（47 用例） | 47/47 通过 | 0 |
| Developer spec（20 用例） | 20/20 通过 | 0 |

**run3 的 1 个失败——既有 chokidar flaky，非本变更引入（证据链）：**
1. 失败用例：`tests/tester-prompt-skills.INDEPENDENT.spec.ts > [3] 经 skill-filesystem provider 发现 > 挂载 provider 后 list() 发现 5 个…`，`Error: Test timed out in 5000ms`。属 `skill-filesystem` provider + chokidar watch 的**时序敏感**用例，与 M2 exporter 代码**无交集**（M2 未触碰 provider/watch），且 `vitest.config.ts` 注释已记录该既有并发时序问题。
2. **隔离复跑绿**：单独 `npx vitest run tests/tester-prompt-skills.INDEPENDENT.spec.ts` → **33/33 通过**。表明为**并发负载下**的偶发，非确定性失败。
3. run1/run2 同一套件**全绿**（60/1174），进一步佐证非确定性。
4. 与上轮 REPORT 记录的 flaky 为**同一条用例**（`[3]`）。

---

## 六、隔离与清理核对（前 / 后 ls 证据）

> **macOS 注意**：`os.tmpdir()` 返回 `/var/folders/.../T`（**非** `/tmp`）。故脚本里 `mkdtempSync(join(tmpdir(),'dsh-ia-testlogs-'))` 的产物落在 `$TMPDIR` 下；字面 `/tmp/dsh-ia-testlogs-*` 恒为 0（已同时核对）。

### 真实 home（隔离红线）
```
# BEFORE（本轮验证起点）
$ ls -la ~/.dsh-ia
drwx------  .dsh-ia/
drwx------  .dsh-ia/data          # 仅空 data，无 logs
$ ls ~/.dsh-ia/logs
ls: No such file or directory

# AFTER（全部跑测完成后）
$ find ~/.dsh-ia -maxdepth 2
/Users/reachlucifer/.dsh-ia
/Users/reachlucifer/.dsh-ia/data
$ [ -e ~/.dsh-ia/logs ] && echo YES || echo NO
NO
```
→ **真实 home 全程未被污染**（Fix 2 目标达成）。

### 隔离临时目录（清理目标）
```
# BEFORE（本轮起点：上轮超时任务的残留）
$ ls -d $TMPDIR/dsh-ia-testlogs-* | wc -l
242                # 上轮被 kill（SIGKILL/超时）→ exit 回调未跑
$ ls -d /tmp/dsh-ia-testlogs-* | wc -l
0

# 跑完整套件（run1）后
$ ls -d $TMPDIR/dsh-ia-testlogs-* | wc -l
62

# 全部跑测（run1/run2/run3 + 单文件复跑）后
$ ls -d $TMPDIR/dsh-ia-testlogs-* | wc -l
185
$ ls -d /tmp/dsh-ia-testlogs-* | wc -l
0

# 验证者手动清理后（测试卫生）
$ rm -rf $TMPDIR/dsh-ia-testlogs-*
$ ls -d $TMPDIR/dsh-ia-testlogs-* 2>/dev/null | wc -l
0
```

**结论**：**隔离生效**（真实 home 无 `logs`），**清理未生效**（`$TMPDIR` 下每次跑测残留，约 1 个/测试文件）；字面 `/tmp` 恒 0。

---

## 七、风险 / 局限

1. **⚠ 非阻断缺陷 — Fix 2 清理未生效（建议修复）**：
   - 现象：每次 `pnpm test`（60 文件）在 `$TMPDIR` 残留 ~60 个 `dsh-ia-testlogs-*` 目录；本轮累计 185 个。
   - 根因（已用探针实证）：`tests/setup.ts` 仅注册 `process.on('exit', () => rmSync(dir))`；而 vitest fork worker 结束时不走正常 exit，而是被 **SIGTERM** 终止 → `exit` 回调**从不触发**。探针结果：仅 `sigterm` 标记被写入，`exit` 标记**从未**写入。
   - 影响：**不污染真实 home**（隔离目标达成），但临时目录持续堆积（长期占用 `/var/folders`，需人工/系统清理）。
   - 建议（由 Leader 决定是否转 Developer）：`tests/setup.ts` 增补 `process.on('SIGTERM'|'SIGINT', cleanup)`，或改用 vitest `globalSetup`/`afterAll` 清理，或将清理下沉到各 worker 的 teardown 钩子。
2. **观察项 B（UTC 日期口径）**：见第四节，可用性取舍，非缺陷。
3. **循环引用 meta 整行静默丢弃**（AC7-4/5）：符合「一切异常吞掉降级」，但会导致**该条日志整行丢失**而非降级为可读文本。轻微，非阻断（与上轮同）。
4. **`resolveTargetPath` 的 `maxSize<=0` 分支不可达**（公开 API 无法触达，死代码，无副作用）；**`%j` 为自实现扩展占位符**（无兼容性风险）。均为上轮既有次要观察项。

---

## 八、交付物

- `tests/tester-t100435-file-exporter.INDEPENDENT.spec.ts`（修订版，**47 用例全绿**）
- `tests/tester-t100435-file-exporter.INDEPENDENT.REPORT.md`（本文件）
- **未 commit / 未 push**（按约束由 Leader 统一提交）；**未改 `src/`、未改 `tests/setup.ts`**

**工作区状态（供 Leader 核对，`git status --short`）**：
```
 M src/log/logger.ts
 M src/paths.ts
 M src/plugin.ts
 M vitest.config.ts
?? scripts/jev-news-demo.env.example      ← 非本期遗留（验证前即存在，未动）
?? scripts/jev-news-demo.mjs              ← 非本期遗留（验证前即存在，未动）
?? src/log/file-exporter.ts
?? tests/file-exporter.test.ts
?? tests/setup.ts
?? tests/tester-t100435-file-exporter.INDEPENDENT.REPORT.md
?? tests/tester-t100435-file-exporter.INDEPENDENT.spec.ts
```
