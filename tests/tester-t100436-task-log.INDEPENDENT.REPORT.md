# 测试报告 — t100436「M3 任务进程日志独立采集」

- **结论：✅ 通过（PASS）**
- 被测分支/提交：`main` @ `5617847`（src/log/task-log.ts、src/scheduler/{runner,index,types}.ts）
- 执行节点：`Reach的MacBook Pro`（node v25.9.0 / pnpm 11.7.0）
- 项目路径：`/Users/reachlucifer/project/opc/dsh-finance`
- 独立测试文件：`tests/tester-t100436-task-log.INDEPENDENT.spec.ts`（52 用例，自成体系，不依赖 Developer 自测）
- 测试范围：真实 node 子进程 E2E + mock 边界 + 对抗性用例；**不复读** Developer 自测。

---

## 一、总体结果

| 项目 | 命令 | 结果 |
|------|------|------|
| 独立验收测试 | `vitest run tests/tester-t100436-task-log.INDEPENDENT.spec.ts` | **52 passed / 0 failed** |
| 被测模块既有回归 | `vitest run tests/task-log.test.ts tests/runner.test.ts tests/runner-real-process.test.ts` | **61 passed**（23+32+6） |
| 全量回归 | `vitest run` | **62 files / 1249 tests**（M3 相关全绿；EXIT=0 可复现不稳定，见下「稳定性说明」） |
| 类型门禁 | `tsc -p tsconfig.json --noEmit` | **EXIT=0** |
| 真实 home 污染 | `ls ~/.dsh-finance/logs` | **No such file or directory**（未污染） |

> 隔离：全部用例走临时目录（注入 `TaskLogOptions.dir` 或临时覆盖 `DSH_FINANCE_LOG_DIR`），afterEach 清理；未触碰真实 `~/.dsh-finance`。
> 既有未跟踪文件 `scripts/jev-news-demo.*` 未改动（`git status` 仅新增本 spec + 既有 demo 文件）。

### 稳定性说明（全量回归非确定性，均为**既有**用例，非 M3 回归）

`vitest run` 全量在 `maxWorkers=4` 下存在**已知抖动**（`vitest.config.ts` 已注明并发下 watcher/git/真实子进程资源竞争）。复跑观察：

| 复跑 | 结果 | 失败用例（均非 M3 相关） |
|------|------|--------------------------|
| 第 1 次 | 1 failed / 1248 passed | `tester-task11-scheduler-chain-integration`（cron 分钟边界对齐，约 1s/60s 概率） |
| 第 2 次 | 4 failed / 1245 passed | `tester-prompt-skills`（×2，watcher 装配）+ `runner-real-process`（×2，20× 循环超 5s 默认超时） |
| 单跑（隔离） | 全绿 | `tester-task11…`、`runner-real-process` 单文件隔离各 3–5 次全绿 |

- **归因**：`runner-real-process.test.ts` 调用 `runner.run(taskPath)`（**不传 taskId**）→ M3 代码路径**完全不启用**，零额外开销；其超时纯属并发负载。`tester-task11` 失败随墙钟分钟边界游走、每次运行命中的文件不同，属既有 flake。
- **M3 相关用例零失败**：`task-log.test.ts`(23)、本 spec(52)、`runner.test.ts`(32)、`t100411-taskid-contract`(3) 在两次全量复跑中**始终全绿**。
- 结论不变：**M3 未引入回归**；「全量 1249 全绿」为某次运气运行，非保证稳定结果。

---

## 二、验收标准逐条核验

### AC1 — 触发任务后 `logs/tasks/<taskId>/` 有日志文件，且不含结果 JSON 污染 ✅
- 覆盖用例：[1]a–k（末行判定矩阵）、[6]a、[9]a/b。
- 证据（[1]b）：`日志行A\n日志行B\n{"shouldWake":false}\n` → 日志文件内容恒为 `日志行A\n日志行B\n`，无 JSON。
- 证据（[1]a）：stdout 恰一行结果 JSON → 文件存在且**内容为空**（零污染）。
- 证据（[6]a/[9]a）：真实/ mock 集成下断言 `content` **不包含** `shouldWake` 与 `data` 值（`BTC 10w` / `REAL-E2E`）。

### AC2 — 三结局 / 超时 / 超限既有语义不变 ✅
- 覆盖用例：[7] 全组（quiet / woke / failed-parse / failed-exec-非零 / failed-exec-崩溃 / failed-exec-超时 / failed-exec-超限）+ [6]f（onClose 缺失回退 stdout close）。
- 与 `tests/runner.test.ts` 口径逐项一致：`woke{data,targets:[]}`、`quiet`、`failed{failureKind:'parse'|'exec'|'spawn'}`、超时 `kill('SIGTERM')`、`DEFAULT_MAX_STDOUT_BYTES=1048576`、`DEFAULT_TASK_TIMEOUT_MS=60000`。
- 导入并断言 `parseLastJsonLine` 语义未变（抽查 `'{"shouldWake":false}\ndone\n'` → `null`）。
- 证据：`runner-real-process.test.ts`（6 用例，含 20× 循环抗 exitCode 竞争）与 `runner.test.ts`（32 用例）全绿。

### AC3 — 单文件 10MB 上限约束磁盘占用，且只约束任务日志、不影响 stdout 结果解析 ✅
- 覆盖用例：[4]a–d、[9]d、[9]e。
- 证据（[4]a）：`DEFAULT_TASK_LOG_MAX_SIZE=10*1024*1024`；解析优先级 `显式 > DSH_FINANCE_LOG_MAX_SIZE > 默认`；非正值回退默认。
- 证据（[9]d，**真实子进程**）：`DSH_FINANCE_LOG_MAX_SIZE=8192` + 子进程狂写 ~512KB stderr → 日志文件 `size ≤ 8192`、`warn` 至少一次（含“上限”）、**结局仍为 `quiet`**（末行 JSON 完好解析）。
- 证据（[9]e）：`maxSize=1` 时日志文件 `size ≤ 1`，但 stdout 结果仍正确解析为 `woke/OK` → 上限仅约束日志文件。
- 实现取「**停写 + warn**」而非「tail 截断」，符合 AC3 二选一。

### AC4 — 落盘位置 / 权限 / 目录覆盖 ✅
- 覆盖用例：[3]a–e、[9]a。
- 证据（[3]a）：文件名为 `<ts>-<pid>.log`（注入 `now` 后精确等于 `2026-10-12T11-31-00-123Z-4242.log`）。
- 证据（[3]c / [9]a）：目录 `mode & 0o777 === 0o700`；文件 `=== 0o600`。
- 证据（[9]a）：**真实子进程**日志文件名中的 pid 与子进程自身 `process.pid`（脚本 `console.error('PID='+process.pid)` 交叉校验）**完全一致**。
- 证据（[3]d）：临时覆盖 `DSH_FINANCE_LOG_DIR` 后，不传 `dir` 的采集器落到该目录 `<envRoot>/tasks/<taskId>/`。
- 证据（[3]b）：`pid` 缺失 → `<ts>-unknown.log`，不抛异常。

### AC5 — 不引第三方依赖；顶层 `inject` 仍 `['tools','skills','fs']` ✅
- 覆盖用例：[10]a/b。
- 证据（[10]b）：静态解析 `src/log/task-log.ts` 的所有 `from '...'` 说明符，全部满足 `node:` 前缀或相对路径；无 `require(`。
- 证据（[10]a）：运行时导入 `src/plugin.ts` 的 `inject`，`toEqual(['tools','skills','fs'])`。
- `tsc -p tsconfig.json --noEmit` EXIT=0 佐证类型门禁。

### AC6 — 既有测试不回归 ✅
- 全量 `vitest run`：**62 files / 1249 tests**；M3 相关四个测试文件（`task-log`/本 spec/`runner`/`t100411`）两次复跑**始终全绿**。
- ⚠️ 全量整体存在**既有**非确定性（3 个无关文件在并发负载下偶发 flake，见「稳定性说明」）；经归因均与本任务无关，**不构成 M3 回归**。

---

## 三、对抗性用例重点结论（末行判定）

「延迟一行」策略被独立验证为**与 runner 的 `parseLastJsonLine` 语义一致**：

| 场景 | 输入 | 日志文件内容 | 结论 |
|------|------|--------------|------|
| 仅 JSON | `{"shouldWake":false}\n` | 空 | ✅ 零污染 |
| 日志+JSON | `日志行A\n日志行B\n{JSON}\n` | `日志行A\n日志行B\n` | ✅ 顺序保真 |
| JSON 后尾随空行 | `a\nb\n{JSON}\n\n   \n` | `a\nb\n` | ✅ 空行判定跳过 |
| JSON 无尾随换行 | `a\nb\n{JSON}` | `a\nb\n` | ✅ EOF 收尾正确 |
| JSON 跨 chunk 分片 | `logA\n{"shouldWa` + `ke":...}\n` | `logA\n` | ✅ 不误落 |
| 行跨 chunk 拆开 | `li`+`ne1\n...` | `line1\nline2\n` | ✅ 跨边界无损 |
| 中间空行 | `x\n\n\ny\n{JSON}\n\n` | `x\n\n\ny\n` | ✅ 顺序保真 |
| 末行非 JSON（失败结局） | `keep1\nkeep2\nlast\n` | `keep1\nkeep2\n` | ✅ 与 §5.3 既定策略一致 |

> **既定策略核验**：失败结局下最后一行为「结果候选」被丢弃，与设计 §5.3 完全一致，**不作为缺陷**。

---

## 四、发现的缺陷 / 与设计不符处

**无阻塞性缺陷（NONE blocking）。** 以下为需知悉的风险/硬化建议（均非本里程碑引入的回归）：

### ⚠️ R1（低-中）：跨 chunk 的多字节 UTF-8 字符会被解码损坏（**既有局限，非 M3 引入**）
- `runner.ts` 对每个 chunk 独立 `chunk.toString('utf8')`，若多字节字符（如中文）恰好被 pipe 读边界切开，会产生 `U+FFFD` 替换符。M3 之前该逻辑已存在（同时影响 stdout 结果解析）；M3 使该损坏**在落盘日志中可见**。
- 实测证据：
  - mock 将 `中` 从中间切开 → 日志 `"���文字符测试\n"`（首个汉字损坏）。
  - **真实子进程**单次 `process.stdout.write` 输出 40000 个 `中`（120KB）→ 日志 120007 字节中出现 **3 个 `U+FFFD`**（即 ~3 处 pipe 边界命中字符中间）。
- 影响：日志内容在该边界处出现少量乱码；若**结果 JSON 的 `data` 含多字节且恰被切开**，解析出的 `data` 可能含替换符（此为既有 stdout 解析风险，非 M3 新增）。
- 建议（可选，超出本任务范围）：在 runner 用 `StringDecoder`/`TextDecoder({stream:true})` 做跨 chunk 增量解码，可同时修复 stdout 与日志。
- 复现：见 `tests/tester-t100436-*` 之外的一次性 scratch（已在验证后删除）：mock 传 `Buffer.from('中文字符测试\n').subarray(0,1)` 与 `subarray(1)` 两段。

### ⚠️ R2（低）：`taskId` 为 `.` / `..` 时未净化，落盘目录上浮一级
- `sanitizeSegment` 仅剔除 `/ \ NUL`，保留 `.`/`..`。实测：
  - `taskId='.'` → 文件落在 `<logDir>/tasks/<ts>-<pid>.log`（跳过 `<taskId>` 段）；
  - `taskId='..'` → 文件落在 `<logDir>/<ts>-<pid>.log`（上浮出 `tasks/`）。
- 影响：**未逃逸 `logDir` 根**（均 `startsWith(root)` 为 true），无跨目录/越权风险；仅「一个任务一个目录」的归档结构被破坏。真实 `taskId` 来自 `TaskDef.id`，正常不含点段。
- 建议（可选）：`sanitizeSegment` 将纯 `.`/`..` 也回退为 `unknown`。

### ⚠️ R3（低）：任务日志上限与宿主日志 exporter 共用同一环境变量
- `TASK_LOG_MAX_SIZE_ENV === LOG_MAX_SIZE_ENV === 'DSH_FINANCE_LOG_MAX_SIZE'`。若用户为放宽宿主日志（默认 50MB）而设大该变量，会**同时放宽任务日志上限**（默认 10MB）。属设计耦合，非缺陷；仅提示运维注意。

### ⚠️ R4（信息）：同一 taskId 在同一毫秒内的两次运行会撞名追加
- 文件名时间戳精度为毫秒；极端同毫秒并发同 taskId 会落到同一文件并**追加**（非覆盖）。正常调度时间推进下不可复现。[8]a 用递增时钟验证了「同 taskId 多次运行 → 文件名互异、内容互不串扰」。

---

## 五、复现步骤（关键命令）

```bash
cd /Users/reachlucifer/project/opc/dsh-finance

# 独立验收（52 用例）
./node_modules/.bin/vitest run tests/tester-t100436-task-log.INDEPENDENT.spec.ts

# 被测模块既有回归（61 用例）
./node_modules/.bin/vitest run tests/task-log.test.ts tests/runner.test.ts tests/runner-real-process.test.ts

# 全量回归（62 files / 1249 tests）
./node_modules/.bin/vitest run

# 类型门禁
./node_modules/.bin/tsc -p tsconfig.json --noEmit
```

环境：node v25.9.0 / pnpm 11.7.0（`Reach的MacBook Pro`）。未见中间件依赖，无需 docker 清理。

---

## 六、结论

**通过。** 6 条验收标准全部满足；末行判定/延迟一行策略经对抗性验证与 `parseLastJsonLine` 一致；真实 node 子进程 E2E（含 pid 命名、0700/0600 权限、stderr 全落、10MB 封顶、结局解析）全部符合设计；无阻塞缺陷。风险项 R1–R4 均为低严重度，其中 R1 为**既有**解码局限（非本里程碑引入），建议后续排期用流式解码统一修复。
