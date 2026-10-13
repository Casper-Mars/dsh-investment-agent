# Task-09（t100359）独立复验报告

- 被测交付物：`/Users/reachlucifer/project/opc/dsh-ia`（分支 `main`，HEAD `ef18031`，含未提交改动）
- 复验人：Tester（独立，不复用 developer 的 `tests/session-const.test.ts` 作为唯一依据）
- 时间：2026-09-30
- 执行环境：宿主机 Mac（`Reach的MacBook Pro`）；harness `deepseek-harness` dsh `0.2.0-rc.2`

## 结论总览

| # | 验收标准 | 结论 |
|---|---------|------|
| 1 | 固定常量 `PINNED_SESSION_ID`（写死、无配置项、与插件身份一致） | ✅ PASS |
| 2 | `agents`/`sessionPersistence` 动态注入；服务缺失安全降级（真实 cordis） | ✅ PASS |
| 3 | 顶层 `inject` 四项不变；`cordis.patch.yml` 未被改动且一致 | ✅ PASS |
| 4 | 单测覆盖「常量引用 + 服务缺失降级」 | ✅ PASS |
| 5 | 回归：typecheck/build EXIT=0；test 全绿且用例数不降（≥ 29/493） | ✅ PASS（30/502） |
| 6 | 真实 dsh 装载：`add .` 成功、`--dump-config` 识别 id/inject 四项 | ✅ PASS |

**总体：6/6 通过，无缺陷。** 未把「尚未实现 ensure/创建会话（Task-10）」「唤醒定点投递（Task-11）」判为缺陷（符合任务范围界定）。

---

## 逐条证据

### ① 固定常量 `PINNED_SESSION_ID` — PASS

- `src/session.ts`：`export const PINNED_SESSION_ID = 'investment-advisor'`（写死字面量）。
- 与插件身份一致：`src/plugin.ts` `export const name = 'investment-advisor'`，且 `PINNED_SESSION_ID === name`。
- 无配置项 / 无环境变量：
  ```bash
  $ grep -rn "process.env" src/        # 仅 src/tools/context.ts:80 DATA_ROOT_ENV（与本任务无关的既有逻辑）
  $ grep -rn "env\|config\|Config" src/session.ts   # (none)
  ```
  源码中 `session.ts` 无 `process.env`、无 `DATA_ROOT_ENV`、无任何 `readConfig/getConfig/resolveConfig/loadConfig` 读取路径。
- `package.json` 未改动（git diff 无 package.json），未新增任何会话相关依赖/配置。

### ② 动态注入就绪 + 安全降级 — PASS

`src/runner/index.ts`：
- `ctx.inject(['agents'], cb)`（既有，唤醒通道）
- `ctx.inject(['sessionPersistence'], cb)`（本任务新增，会话持久化通道，回调内 `runner.setPinnedSessionId(PINNED_SESSION_ID)` + `runner.setSessionPersistence(...)`）

独立验证（真实 cordis `Context`，见 `tests/tester-task09-session-const.INDEPENDENT.spec.ts`）：
- (a) 服务齐全：`agents`/`sessionPersistence` 就绪回调均触发，日志含「唤醒通道已就绪（agents 服务）」「会话持久化通道已就绪（pinned session = investment-advisor）」。
- (b) `agents` 与 `sessionPersistence` 均缺失：插件仍装载、不抛异常、就绪回调不触发（动态依赖等待态）。
- (b2)/(b3) 单边缺失：任一服务缺失不影响另一服务就绪（分开注入）。

关键差异说明：真实 cordis 的 `ctx.inject([...], cb)` 在依赖未提供时**子 fiber 保持 inactive、回调不触发**（非 mock 的「无条件回调」），故「安全降级」的准确断言是「装载成功 + 不抛 + 回调不触发」。

### ③ 顶层契约未被改动 — PASS

- `src/plugin.ts`：`export const inject: string[] = ['tools', 'skills', 'ptcRuntime', 'fs']`（不变）。
- `cordis.patch.yml`（git diff 未涉及该文件）：
  ```yaml
  - insert:
      - id: dsh-ia
        name: dsh-ia
        inject: ['tools', 'skills', 'ptcRuntime', 'fs']
  ```
  与 `src/plugin.ts` 的 `inject` 完全一致。`sessionPersistence` 仅以 `ctx.inject([...])` 动态声明，**未**进入顶层 `inject`。

### ④ 单测覆盖 — PASS

- developer：`tests/session-const.test.ts`（8 用例，覆盖常量 + 动态注入/降级 + 顶层契约）。
- tester 独立：`tests/tester-task09-session-const.INDEPENDENT.spec.ts`（9 用例，用真实 cordis 独立构造断言，含常量源码无 env 校验 + 真实 cordis 四种注入/降级场景）。

### ⑤ 回归 — PASS

```bash
$ pnpm typecheck   # EXIT=0
$ pnpm build       # EXIT=0（tsc --noEmit + tsc server + copy-assets 11 文件）
$ pnpm test
  Test Files  30 passed (30)
       Tests  502 passed (502)
```
基线：28 文件 / 485 用例 → developer 交付后 29/493 → 本复验新增 1 文件 9 用例后 30/502。未删改既有测试。

### ⑥ 真实 dsh 装载复验 — PASS

```bash
$ dsh plugin --profile opc-finance-verify add .
✓ Lockfile passes supply-chain policies
Already up to date
Done in 209ms using pnpm v11.7.0
EXIT=0

$ dsh --profile opc-finance-verify --dump-config
# == dsh-ia
- id: dsh-ia
  name: dsh-ia
  inject:
    - tools
    - skills
    - ptcRuntime
    - fs
```
`--dump-config` 仍识别 `id=dsh-ia` 与 inject 四项，无回退，且 dsh-ia 段无新增 `config:` 会话配置项。

---

## 范围界定与风险

- 本任务仅基础层：常量 + 动态注入 + 安全降级 + 单测。`ensure/创建会话`（Task-10）、`唤醒定点投递`（Task-11）**不在本任务范围**，未判为缺陷。
- 未执行完整 profile boot（会启动 agent/session，属交互/需凭据的长驻进程），验收标准要求的 `add .` + `--dump-config` 两项均已实测通过。
- 回归测试在真实 cordis 场景会启动 scheduler 单定时器链，独立测试通过 fiber `dispose()`（触发 `scheduler.stop()`）清理，无 timer 泄漏、进程正常退出。
