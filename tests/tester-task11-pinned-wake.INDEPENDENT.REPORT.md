# Task-11（t100361）独立复验报告 —— 定点唤醒投递 + 调度仅装配一次

- 被测交付物：`dsh-finance`（分支 `main`，HEAD `87b2b64` + 未提交改动）
- 被测改动：`src/runner/wake.ts`、`src/runner/index.ts` + 5 个测试文件同步适配
- 执行环境：宿主机 Mac（node `Reach的MacBook Pro`），`deepseek-harness` 0.2.0-rc.2
- 独立测试文件：`tests/tester-task11-pinned-wake.INDEPENDENT.spec.ts`（22 用例，Tester 独立构造，未复用 Developer 单测作唯一依据）
- 结论：**全部验收标准通过，无阻断缺陷**；1 项非阻断观察（见 §5）

---

## 1. 逐条验收标准结论表

| AC | 验收标准 | 结论 | 证据 |
|----|----------|------|------|
| 1 | 唤醒只投递到 `PINNED_SESSION_ID` 对应会话（三条路径同此一路径） | ✅ 通过 | `createAgentWaker(agents, PINNED_SESSION_ID, log)` 仅 `agents.get(pinnedId)`；三条路径（pulse/review/prep）均经 `runner.run/runReview/runPrep → deliver → waker`。独立测试 ③ 用**真实** `createAgentWaker` 串真实 `createSensorRunner`，断言固定会话 agent 实际收到 3 次 followup，reason 序列 pulse→review→prep |
| 2 | 存在多个其它会话时不误投（其它 agent 零调用） | ✅ 通过 | 独立测试 ②「多会话不误投」+「【回归】registry 仍带 list/roots/currentInitiator 且返回其它 agent → 仍只投固定会话，零误投」 |
| 3 | 固定会话不可达时固定 skip：记日志、返回投递数 0、不抛、无配置开关 | ✅ 通过 | 未命中/get 抛错/followup 抛错三种不可达均返回 0、`not.toThrow()`、日志含「固定会话不可达 / 解析唤醒目标失败」。`wake.ts`/`index.ts` 无任何 env/config 读取路径（源码硬读确认无开关） |
| 4 | 调度只装配一次（多会话/重复触发不重复 `scheduler.start()`） | ✅ 通过 | mock `createScheduler`：effect 执行 3 次 → `start()` 恰 1 次；cleanup → `stop()` 恰 1 次 |
| 5 | 有单测覆盖定点投递与降级 | ✅ 通过 | Developer `runner-pinned-delivery.test.ts` + 本独立测试 22 用例 + `runner-sensor.test.ts` 同步覆盖 |
| 6 | 契约不变：顶层 `inject=['tools','skills','ptcRuntime','fs']`；`cordis.patch.yml` 未改 | ✅ 通过 | `plugin.ts` inject 未变；`git status` 7 个改动文件不含 `cordis.patch.yml`；`--dump-config` 识别 `id=dsh-finance` + inject 四项 |
| 7 | typecheck/build EXIT=0；`pnpm test` 全绿且用例数不降 | ✅ 通过 | typecheck EXIT=0；build EXIT=0；`pnpm test` 34 文件/558 用例全绿（Developer 交付后 33/536，基线 32/529，未降） |

---

## 2. 额外独立核查结论

### A. 既有独立 spec 改动是否「仅机械适配」—— 结论：✅ 是，未弱化

逐一审阅 4 个既有 Tester 独立 spec 的 diff：

| 文件 | 改动内容 | 判定 |
|------|----------|------|
| `tester-runner-task6.INDEPENDENT.spec.ts` | `resolveWakeTargets`→`resolveWakeTarget`；registry 形状由 `{list,get,roots,currentInitiator}` 收敛为 `{get}`；「initiator>roots>list 优先级」用例替换为「定点解析 + 过滤无 followup/未命中」。 | 机械适配。降级断言（不可达→0、followup 抛错→0）意图保留，未放宽 |
| `tester-runner-task7-e2e.INDEPENDENT.spec.ts` | agent id 由 `'a'`/`'agent-1'` 统一改为 `PINNED_SESSION_ID`。harness `agentsRegistry.get(id)=agentsList.find(id)` 按 id 命中。 | 机械适配。首条 E2E 断言 `followup` 被调用 1 次且 payload 为 plugin/notice/含 588000/盘中脉冲，**未弱化**（反而更贴合定点语义） |
| `tester-task8-e2e.INDEPENDENT.spec.ts` | agent id 改 `PINNED_SESSION_ID`；`createAgentWaker(agents)`→`createAgentWaker(agents, PINNED_SESSION_ID)` | 机械适配 |
| `tester-task09-session-const.INDEPENDENT.spec.ts` | agents 桩补 `get: () => undefined`；断言字符串由「唤醒通道已就绪（agents 服务）」改为「唤醒通道已就绪（定点投递：investment-advisor）」 | 机械适配（日志文案随实现变化，非放宽） |

**无弱化断言、无删除覆盖点、无放宽预期。**

### B. 「固定会话就绪后再装配调度」语义评估 —— 结论：语义上满足（非阻断）

任务要求「固定会话就绪后再装配调度」；实际实现为「调度在 apply 即启动 + 唤醒时定点解析（`agents.get` 在投递时求值）」。

逐点评估任务关注的三项：

- **未就绪时不误投**：✅ 满足。固定会话未创建时 `agents.get(pinnedId)` 返回 `undefined` → waker 返回 0 → skip，**不会**投到任何其它会话。
- **不可达时不抛不中断**：✅ 满足。`resolveWakeTarget` 内 `get` 抛错被 try/catch 吞掉返回 `undefined`；`createAgentWaker` 内 followup 抛错也被 catch，返回 0；调度链（scheduler）不被中断。
- **调度只装配一次（§9.5）**：✅ 满足。scheduler 在 `applyRunner` 顶层创建一次，`started` 幂等守卫保证多次 effect 执行不重复 `start()`；未放入任何 `ctx.inject` 回调，天然不会「多会话各自起调度」。

字面差异（**非阻断**）：调度器在 apply 即 `start()`，未严格「等固定会话就绪后再 start」。但该实现**在语义上等价且更稳健**：投递时求值天然兼容 Task-10「启动即确保」的异步时序（ensure 完成后下一脉冲自然命中），且 §9.3 权威文本亦未要求「就绪后再装配调度」这一字面时序。可观测行为（不误投 / 不抛 / 不中断 / 单次装配）全部满足验收。

> 最小缺口（如需严格字面满足）：把 scheduler 的创建+start 移入 `ctx.inject(['agents'], cb)` 内、仅当 `agents.get` 命中固定会话后才 `start()`；但必须保留 `started` 守卫以防 cb 被多次触发，且注意与 §9.5「只装配一次」的张力。当前实现无需改动即可通过验收。

### C. 真实 dsh 装载回归 —— 结论：✅ 通过

- `dsh plugin --profile opc-finance-verify add .` → **EXIT=0**（pnpm 233ms，Already up to date）
- `dsh --profile opc-finance-verify --dump-config` → **EXIT=0**，末尾 `# == dsh-finance` 段识别 `id: dsh-finance` + `name: dsh-finance` + `inject: [tools, skills, ptcRuntime, fs]`（四项，与 `cordis.patch.yml` 一致）

---

## 3. 证据命令与原始输出（尾部）

### 3.1 typecheck
```
$ pnpm typecheck
$ tsc -p tsconfig.json --noEmit
TYPECHECK_EXIT=0
```

### 3.2 build
```
$ pnpm build
$ tsc -p tsconfig.json --noEmit && tsc -p tsconfig.server.json && node scripts/copy-assets.mjs
[dsh-finance-assets] 共搬运 11 个资源文件到 dist-server/
BUILD_EXIT=0
```

### 3.3 pnpm test（交付后 + 本独立测试）
```
 Test Files  34 passed (34)
      Tests  558 passed (558)
   Duration  1.79s
TEST_EXIT=0
```
（加入本独立测试前：33 files / 536 tests，全绿，与「Developer 交付后 33/536」一致）

### 3.4 真实 dsh 装载（C）
```
$ dsh plugin --profile opc-finance-verify add .
✓ Lockfile passes supply-chain policies (verified 41m ago)
Already up to date
Done in 233ms using pnpm v11.7.0
ADD_EXIT=0

$ dsh --profile opc-finance-verify --dump-config
...
# == dsh-finance
- id: dsh-finance
  name: dsh-finance
  inject:
    - tools
    - skills
    - ptcRuntime
    - fs
DUMP_EXIT=0
```

---

## 4. 缺陷清单

**阻断缺陷：无。**

**非阻断观察（1 项）：**

| # | 类型 | 描述 | 影响 | 建议 |
|---|------|------|------|------|
| N1 | API 签名 | `createAgentWaker` 导出签名第 2 参由 `logger` 变为 `pinnedId`（logger 移到第 3 参）。属规格要求的破坏性变更，内部调用点与测试均已同步，无内部断裂 | 若有**外部**调用方以 `createAgentWaker(agents, logger)` 二参形式调用会静默误用（logger 被当作 pinnedId）。当前仓库内无此类调用 | 如需向后兼容，可提供重载或独立命名；否则在发布说明标注签名变更即可 |

**备注（非缺陷）：** 任务文案描述 Developer 新文件为「自测 7 用例」，实际 `runner-pinned-delivery.test.ts` 含 5 个 `it` 块；交付后净增 7 用例 = 新文件 5 + `runner-sensor.test.ts` 净增 2（删 2 加 4）。总数 33/536 与「Developer 交付后 33/536」吻合，验收不受影响。

---

## 5. 测试方法与覆盖

独立测试 `tester-task11-pinned-wake.INDEPENDENT.spec.ts`（22 用例）分六组：

1. **① 定点解析 `resolveWakeTarget`（4）**：命中/未命中/无 followup/get 抛错/自定 pinnedId。
2. **② 定点投递 `createAgentWaker`（8）**：仅命中固定会话；payload 全字段（role/user、source.plugin='dsh-finance'、form='notice'、summary≤120 截断、单一 text 块、非空 id）；**动态解析已移除回归守卫**（registry 带 list/roots/currentInitiator 仍只投固定会话）；多会话零误投；默认 pinnedId（传 `undefined`）；未命中→0 记日志不抛；get 抛错→0 不抛；followup 抛错→0 不抛且日志含 agent id。
3. **③ 三条路径同走一个真实定点 waker（1）**：`createSensorRunner` + 真实 `createAgentWaker`，pulse/review/prep 均投到固定会话，各 `targets=1`，reason 序列正确。
4. **④ 装配幂等（2）**：mock `createScheduler`，多次 effect → `start()` 恰 1 次，cleanup → `stop()` 恰 1 次；agents 缺失时 scheduler 仍启动且记录降级日志。
5. **⑤ 真实 cordis 降级路径（3）**：真实 `Context` 装载插件，agents 含 get（就绪日志）/缺 get（降级日志）/完全缺失（不抛、无就绪日志）。
6. **⑥ 契约回归（3）**：顶层 inject 四项不变；`buildWakeMessage` 结构；`parseSensorResult` 无关回归护栏。

未修改 `src/` 或既有测试文件（仅新增本测试文件与本报告）。
