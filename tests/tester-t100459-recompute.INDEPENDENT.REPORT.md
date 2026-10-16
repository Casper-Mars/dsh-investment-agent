# 独立测试报告 — t100459「新旧口径兼容处理与回归」

- **被测交付物**：`/Users/reachlucifer/project/opc/dsh-finance`（仓库 `Casper-Mars/dsh-investment-agent`，基线 `b180188`，工作区未 commit）
- **目标节点**：Reach的MacBook Pro（Node v25.9.0 / TypeScript 5.7 / vitest 3.2.7）
- **测试者**：Tester（subagent）
- **独立测试文件**：`tests/tester-t100459-recompute.INDEPENDENT.spec.ts`（15 例，自带 fixture，不复用 Developer 断言）
- **被测改动**：`scripts/recompute-cum-return.mjs`(新) / `tests/recompute-cum-return.test.ts`(新) / `CHANGELOG.md` / `package.json`

## 结论

**✅ 通过验收（AC1–AC5 全部满足）。** 未发现由本次改动引入的缺陷，未引入新的测试失败。

一句话：脚本可实跑、默认 dry-run 不落盘、`--write` 落盘并留 `.bak`、`--rollback` 逐字节回滚；连续 `--write` 幂等（第二次不重写）；CHANGELOG/package.json 留痕到位；`tsc --noEmit` 退出 0；脚本口径与 domain 层逐案一致。

---

## AC1 重算能力可用 — ✅ 通过

**独立 fixture（手写 raw JSON，期望值手算）**：Issue #3 台账
init 200@55.57 / sell 100@53.05 / buy 100@53.08 / sell 200@49.76 → 期末 qty=0、cash=59949、realized=−1165、期初资金 61114。手算：旧口径 `(0 + (−1165) − 61114)/61114 = −1.0191`；新口径 `(59949 + 0 − 61114)/61114 = −0.0191`。

**实测命令（真实 CLI 进程 `node scripts/recompute-cum-return.mjs`）：**

```
$ node scripts/recompute-cum-return.mjs --data-root <fixture>          # dry-run（默认）
[recompute-cum-return] 模式：dry-run
[recompute-cum-return] 已初始化标的：1 个（002156）
[002156] before=-1.0191 after=-0.0191 changed=yes
[recompute-cum-return] 完成：1 个标的，1 个口径变化，dry-run，未落盘（加 --write 生效）。
$ # metrics.json 仍为 -1.0191（sha256 不变），无 .bak

$ node scripts/recompute-cum-return.mjs --data-root <fixture> --write
    └─ 备份 …/metrics.json -> …/metrics.json.bak
[002156] before=-1.0191 after=-0.0191 changed=yes written=yes
$ # metrics.cumReturn = -0.0191 ；metrics.json.bak.cumReturn = -1.0191（.bak 与迁移前逐字节一致）

$ node scripts/recompute-cum-return.mjs --data-root <fixture> --rollback
[002156] 已回滚：…/metrics.json.bak -> …/metrics.json
$ # metrics.cumReturn 复原为 -1.0191（逐字节回到迁移前）
```

- dry-run：文件 sha256 前后不变、无 `.bak`；stdout `before=-1.0191 after=-0.0191 changed=yes` ✅
- `--write`：`metrics.json` → −0.0191；生成 `.bak`，内容为旧值 −1.0191（`Buffer.equals(原文件)` 为 true）✅
- `--rollback`：复原为 −1.0191，且与迁移前**逐字节一致** ✅

**附加边界（同 scope 内独立核验，均通过）：**
- `--write` + `--rollback` 互斥 → 退出码 1 且 stderr 含「互斥」✅
- dataRoot 解析：`DSH_IA_DATA_DIR` 环境变量生效；`--data-root` 优先级高于环境变量 ✅
- 无 `ledger/` 目录 → 优雅提示「未找到台账目录」、退出码 0（不抛）✅
- `--price 3.0`（持仓未清）→ `after=0.5`；缺省用最近成交价 2.5 代理 → `after=0.1667` ✅
- 无 `metrics.json` 的标的被跳过，其余标的照常处理 ✅

## AC2 幂等 — ✅ 通过

对同一台账连续 `--write` 两次：

```
$ node … --write          → [002156] before=-1.0191 after=-0.0191 changed=yes written=yes
$ node … --write（二次）  → [002156] before=-0.0191 after=-0.0191 changed=no written=no
```

- 第二次 `changed=no`、`written=no`；`metrics.json` **sha256 完全一致**、`readFileSync().equals()` 字节级一致 ✅
- 第二次**不新建/不覆盖** `.bak`（仍为最初迁移前快照）✅
- 已为新口径的标的再次 `--write` 亦 `changed=no`、文件不改 ✅

## AC3 留痕 — ✅ 通过

`CHANGELOG.md` 新增 `## [Unreleased]` → `### Changed` / `### Notes`，可检索到：
- `cum_return` 口径变更 + **「历史值不可比」** 语义（«历史 …不可比»）✅
- **「以重算值为准」**（«请以下述重算值为准»）✅
- 重算命令：`scripts/recompute-cum-return.mjs`、`--write`、`--rollback`、`metrics.json.bak` ✅
- `package.json`：`"recompute:cum-return": "node scripts/recompute-cum-return.mjs"` ✅

## AC4 类型与回归 — ✅ 通过

**类型**：`npx tsc -p tsconfig.json --noEmit` → **退出码 0** ✅

**回归对比（改动前 vs 改动后，各跑全量 `npx vitest run`）：**

| | 失败文件 | 失败用例 | 说明 |
|---|---|---|---|
| 基线（stash 4 项改动后） | 9 | 13 | 与已知背景一致 |
| 当前（含本次改动 + 本报告 spec） | 9 | 14 | 失败文件集合完全相同 |

- 用例总数 1459 → 1485（+26 = Developer 11 例 + 本报告 15 例，**全部通过**）。
- **失败集合差异仅 1 条**：`tests/tester-prompt-skills.INDEPENDENT.spec.ts :: [3] 经 skill-filesystem provider 发现…`（当前出现、基线未现）。**该用例单跑即过**（隔离复跑：该文件 32 passed / 1 failed，失败的是既有的 advisor.md 板块用例；provider 发现用例通过）→ 判定为**已知并发 flaky**，**非本次改动引入**。
- 无任何「基线过 → 当前挂」的其它用例；无 Developer/本 spec 用例失败。

**既有失败（基线与当前均在，均非本次引入）**：`prompt-skills.spec.ts`(advisor.md 文案 2)、`scheduler-wake.test.ts`(合规声明 4)、`tester-prompt-skills`(advisor 板块 1)、`tester-strategy-feature`(advisor 6 步 1)、`tester-t100418-skill-assets`(源码目录集合 1)、`tester-t100433-seed-provision`(dist-server 计数 1)、`tester-t100438-trace-context`(1)、`tester-task11-scheduler-chain-integration`(链路 flaky 1)、`tester-task14-dsh-version-align`(dist-server 装配 1)。

## AC5 防漂移 — ✅ 通过

**「脚本产物 === `cumReturnOnCapital(ledger.cumReturnState(...))`」**，用真实 `domain.Ledger` 建账（domain 为唯一事实来源），对脚本 CLI 的落盘结果逐案比对：

| 场景 | 断言 | 结果 |
|---|---|---|
| 已清仓（Issue #3，缺省代理价 49.76） | 脚本值 === domain 值 === −0.0191 | ✅ |
| 持仓未清（`--price 3.0`） | 脚本值 === domain 值 === 0.5 | ✅ |
| 多标的混合（已清仓 + 持仓中） | 逐标的 === domain 值 | ✅ |

脚本缺省现价（最近一笔成交价代理）与 domain 传入同一价，二者逐案等值。

---

## 风险 / 建议

1. **⚠️ 工作区存在一处与 t100459 无关的未跟踪目录** `src/skills/finance-evolution/`（不在 Leader 列出的 4 个交付文件内，`git status` 多了这一项）。它使 `tests/tester-t100418-skill-assets.INDEPENDENT.spec.ts` 的「源码目录集合 === 5 可进化 + 固有 SKILL」断言失败（基线与当前均失败，**非 t100459 引入**）。**建议 Leader 核实该目录归属**：若属其它任务，请勿与 t100459 一并提交；如非预期，请清理。
2. **ℹ️ 并发 flaky**：`tester-prompt-skills`、`tester-t100418-skill-assets`、`tester-task11-scheduler-chain-integration` 在全量并发下偶发失败、单跑即过，属既有测试基建噪声，非口径改动引入。
3. **ℹ️ 脚本口径为「镜像」实现**（自包含、不依赖 build），与 `metrics.ts`/`ledger.ts` 存在**复制式漂移风险**。当前由 Developer 的 11 例 + 本报告 AC5 双重对齐；后续若改公式，务必同步脚本与该对齐测试（CHANGELOG 已就此留痕）。
4. **ℹ️ 备份幂等语义**：`.bak` 仅在不存在时创建，保证「最原始迁移前快照」不被二次覆盖 —— 语义正确；但若用户先手动改过 `metrics.json` 再 `--write`，备份的是「手动改后」值。属可接受设计，建议保持。

## 工作区卫生

- 回归对比用 `git stash push -- CHANGELOG.md package.json` + 临时移出 2 个新文件，**已 `git stash pop` 复原**；`git stash list` 为空。
- 4 个改动文件 md5 前后一致：`CHANGELOG.md=4478cde8…`、`package.json=5692a2a9…`、`scripts/recompute-cum-return.mjs=672d114f…`、`tests/recompute-cum-return.test.ts=90289c1d…`。
- 结束时 `git status` 仍为 `CHANGELOG.md`/`package.json` 已改 + 新文件未跟踪（未 commit、未改动被测源码与 Developer 产物）。
- **未 commit。**
