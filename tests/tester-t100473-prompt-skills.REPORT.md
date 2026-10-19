# t100473 任务-05：修复 prompt-skills 过期断言 — 测试报告

- 项目：`/Users/reachlucifer/project/opc/dsh-finance`
- 基线：HEAD `5f60bd7`，工作区干净
- 改动文件：`tests/prompt-skills.spec.ts`（仅测试）
- 未改动：`src/prompts/advisor.md`、其他测试；未 commit / push

## 一、改动说明

对照现行 `src/prompts/advisor.md`（六大板块：角色 / 思维与能动性 / 自我进化 / 能力 / 工作流 / 合规）更新「验收 1」：

1. **板块断言**
   - 旧：仅校验「角色 / 思维与能动性 / 工作流 / 合规」四块，使用宽松的 `/#\s*角色/` 匹配。
   - 新：校验六大顶级板块，使用行锚定 `^#\s*...\s*$`（`m` 模式），避免把 `##` 子标题或正文误判为顶级板块。
   - 覆盖：`角色`、`思维与能动性`、`自我进化`、`能力`、`工作流`、`合规`。

2. **核心约束断言**
   - 新增 `不夸大收益`，保留 `不执行真实交易`、`攻守依实际情势`、`只做分析、建议与推演`。
   - 与原「合规板块以风险提示收尾」用例并存，覆盖更完整。

3. **标题与注释同步**
   - describe 改为「验收 1：advisor.md 六大板块与合规约束」。
   - 用例标题同步为六大板块 / 四项核心约束。
   - 文件头注释由「角色/原则/工作流/合规四块」更新为现行六大板块表述。
   - 清理残留旧文案引用：`趋势跟随`、`防守优先`、`# 原则` 均已确认不再出现于该测试文件。

## 二、验证命令与结果

### 1. 目标 spec

```bash
./node_modules/.bin/vitest run tests/prompt-skills.spec.ts
```

结果：**1 file passed，34/34 tests passed**（约 1.4s）。

### 2. advisor.md 未被修改

```bash
git diff -- src/prompts/advisor.md
```

结果：**无任何输出**（diff 为空）。

### 3. 定向回归

```bash
./node_modules/.bin/vitest run tests/prompt-skills.spec.ts tests/finance-evolution.spec.ts tests/tester-prompt-skills.INDEPENDENT.spec.ts
```

结果：**3 files passed，84/84 tests passed**。

### 4. 全量回归

```bash
./node_modules/.bin/vitest run --maxWorkers=2
```

结果：**87 files（82 passed / 5 failed），1841 tests（1833 passed / 8 failed）**。

失败清单（与任务给定基线完全一致，未新增失败）：

| 文件 | 失败数 | 已知基线 |
| --- | ---: | --- |
| `tests/scheduler-wake.test.ts` | 4 | ✅ 4 |
| `tests/tester-t100438-trace-context.INDEPENDENT.spec.ts` | 1 | ✅ 1 |
| `tests/tester-task11-scheduler-chain-integration.INDEPENDENT.spec.ts` | 1 | ✅ 1 |
| `tests/tester-strategy-feature.INDEPENDENT.spec.ts` | 1 | ✅ 1 |
| `tests/tester-task14-dsh-version-align.INDEPENDENT.spec.ts`（B5） | 1 | ✅ 1 |
| **合计** | **8** | **8** |

结论：无新增失败；失败集合与基线一致，按要求未修复。

## 三、AC 结论

| 验收点 | 结论 |
| --- | --- |
| 断言 1 覆盖六大板块 | ✅ 通过（行锚定校验六个 `#` 顶级标题） |
| 断言 2 覆盖 `不执行真实交易` / `不夸大收益` | ✅ 通过 |
| 保留 `攻守依实际情势` / `只做分析、建议与推演` | ✅ 通过 |
| 清理「趋势跟随」「防守优先」「# 原则」残留 | ✅ 已确认无残留 |
| 未修改 `src/prompts/advisor.md` | ✅ `git diff` 为空 |
| 目标 spec 全绿 | ✅ 34/34 |
| 定向回归全绿 | ✅ 84/84 |
| 全量无新增失败 | ✅ 8 failed = 已知基线 |

**总体结论：任务完成，可交付。**
