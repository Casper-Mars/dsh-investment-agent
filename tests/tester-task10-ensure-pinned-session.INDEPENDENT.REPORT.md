# Task-10（t100360）固定会话「启动即 ensure」独立复验报告

- **被测交付物**：`/Users/reachlucifer/project/opc/dsh-finance`（分支 `main`，HEAD `d751abd` + 未提交改动）
- **被测改动**：新建 `src/session-ensure.ts`；修改 `src/plugin.ts`（apply 内新增装配调用 + re-export）、`src/session.ts`（仅头部注释同步）
- **测试者**：Tester（独立复验，不复用 developer 测试作为唯一依据）
- **独立测试文件**：`tests/tester-task10-ensure-pinned-session.INDEPENDENT.spec.ts`（18 用例）

---

## 一、验收标准逐条结论表

| AC | 内容 | 结论 | 证据 |
|----|------|------|------|
| 1 | 会话 live 时直接复用，不重复创建（不调用 create/resume） | ✅ PASS | 纯函数测试 `reuse`（get 命中 → outcome=reuse，create/resume 均未调用）；真实 cordis `AC4b`（get 命中 → create/resume 均未调用） |
| 2 | 已持久化未 live → resume 恢复，带 agentOptions（历史上下文保留） | ✅ PASS | 纯函数 + 真实 cordis `AC4c`：`resume({resumeSessionId, agentOptions})`，`create` 未调用 |
| 3 | 均不存在 → create 新建，带 meta.cwd 与 agentOptions | ✅ PASS | 纯函数 + 真实 cordis `AC4a`：`create({sessionId, agentOptions, meta:{cwd}})`，`resume` 未调用 |
| 4 | 归属：handle.dispose 绑定插件 fiber，卸载即拆除；已落盘再 apply 走 resume | ✅ PASS | 真实 cordis `AC4a`：`fiber.dispose()` 后 `handle.dispose` 恰调用一次；`AC4c` resume 后卸载亦拆除；纯函数「再次 apply」用例（create 落盘 → 重 apply 走 resume） |
| 5 | 三分支均有单元测试（注入 fake agents/sessionPersistence） | ✅ PASS | 独立测试覆盖 reuse/resume/create 三分支 + 4 类边界降级（get/stat 抛错、create/resume reject） |
| 6 | 顶层 inject 仍 `['tools','skills','ptcRuntime','fs']`；cordis.patch.yml 未改动 | ✅ PASS | 源码断言 + `--dump-config` 实测均确认；git status 确认 patch 未被修改 |
| 7 | typecheck/build EXIT=0；test 全绿且用例数不降 | ✅ PASS | typecheck EXIT=0；build EXIT=0；test 32 文件/529 用例全绿（交付基线 31/511，独立复验新增 1 文件 18 用例） |

**结论：7/7 条验收标准全部通过，无阻断缺陷。**

---

## 二、独立测试覆盖设计（与 developer 测试的关键差异）

1. **三分支 + 降级**：自建「调用记录」spy fake（`get`/`create`/`resume` 均 vi.fn 记录参数），断言各分支**只**走对应 API 且参数精确（`sessionId` / `resumeSessionId` / `meta.cwd` / `agentOptions`）。
2. **集成场景全部用真实 cordis Context**（`new Context()` + `ctx.provide` + `ctx.plugin`），而非 developer 测试中的手工 mock `ctx.inject`。
   - 真实 cordis 的 `ctx.inject([...], cb)` 语义是「依赖未提供 → 子 fiber 保持 inactive、回调**不触发**」；developer 测试用「无条件同步回调」的 mock，二者本质不同。
   - 因此独立测试对「服务缺失安全降级」的断言是：插件 fiber 仍装载（不抛、不中断），且 ensure 回调**不触发**（`create`/`resume` 不被调用）—— 这才是真实运行时行为。
3. **归属（AC4）用真实 fiber 卸载验证**：`fiber.dispose()` 后断言 `handle.dispose` 恰被调用一次（而非 developer 测试里手工捕获 effect body 返回的 disposer）。

---

## 三、证据命令与原始输出（尾部）

### 1. typecheck
```bash
$ pnpm typecheck
$ tsc -p tsconfig.json --noEmit
EXIT=0
```

### 2. build
```bash
$ pnpm build
$ tsc -p tsconfig.json --noEmit && tsc -p tsconfig.server.json && node scripts/copy-assets.mjs
[dsh-finance-assets] src/domain/README.md -> dist-server/domain/README.md
...
[dsh-finance-assets] 共搬运 11 个资源文件到 dist-server/
EXIT=0
```

### 3. 全量 test（交付基线 + 独立复验）
```bash
$ pnpm test
 Test Files  32 passed (32)
      Tests  529 passed (529)
   Duration  1.85s ...
EXIT=0
```
（developer 交付基线：31 文件 / 511 用例；本独立复验新增 1 文件 18 用例 → 32/529，未删改既有测试，用例数不降。）

### 4. 独立测试单文件
```bash
$ npx vitest run tests/tester-task10-ensure-pinned-session.INDEPENDENT.spec.ts
 ✓ tests/tester-task10-ensure-pinned-session.INDEPENDENT.spec.ts (18 tests) 149ms
 Test Files  1 passed (1)    Tests  18 passed (18)
EXIT=0
```

### 5. 真实 dsh 装载（沿用本项目既有验证手法）
```bash
$ dsh plugin --profile opc-finance-verify add .
✓ Lockfile passes supply-chain policies
Already up to date
Done in 205ms using pnpm v11.7.0
EXIT=0

$ dsh --profile opc-finance-verify --dump-config
# == dsh-finance
- id: dsh-finance
  name: dsh-finance
  inject:
    - tools
    - skills
    - ptcRuntime
    - fs
EXIT=0
```
`--dump-config` 仍识别 `id=dsh-finance` 与 inject 四项，无回退、无新增会话配置项。

---

## 四、缺陷清单

**阻断缺陷：无。**

### 观察项 / 非阻断（供 Leader 知悉，无需回改）

1. **[测试保真度] developer 单测「服务缺失安全降级」用 mock 而非真实 cordis**
   - 现象：`tests/session-ensure.test.ts` ⑤ 段用手工 mock `ctx.inject`（无条件同步回调），断言「agents 缺失 → 记日志跳过」。
   - 真实语义：cordis 的 `ctx.inject(['agents','sessionPersistence'], cb)` 在依赖未提供时**回调不触发**（子 fiber inactive），故 `applySessionEnsure` 内部的「`!agents` / `!sessionPersistence` 记日志跳过」分支在真实运行时**不可达**（回调触发了就说明双服务必已就绪）。
   - 影响：功能行为仍满足「降级跳过、不抛异常、不中断」；仅「记日志」这条软性要求在真实运行时不会发生（无日志输出），属**测试保真度差异**，非功能缺陷。独立测试已用真实 cordis 覆盖正确语义（回调不触发、不抛、不中断）。
   - 严重度：非阻断（观察项）。

2. **[防御性代码] `applySessionEnsure` 回调内 `typeof agents.get !== 'function'` / `typeof sessionPersistence.stat !== 'function'` 守卫**
   - 同上述，真实 cordis 下回调触发即双服务就绪，这些守卫为防御性死代码；无害，保留亦可。

---

## 五、范围界定与风险

- 本任务验证 ensure 层 + 装配/生命周期；「Task-11 唤醒定点投递尚未实现」**不在本任务范围**，未判为缺陷。
- 未执行完整 profile boot（会启动真实 agent/session，属需凭据的长驻交互进程）；验收要求的 `add .` + `--dump-config` 两项均已实测通过。
- 真实 cordis 集成场景通过 `fiber.dispose()` 清理，无 timer 泄漏、进程正常退出。
