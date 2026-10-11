# 独立验证报告：t100430 测试对齐与全量回归

- 任务：t100430 ［task-authorship 固有化］ 任务-05：测试对齐与全量回归（产出 + 验证一体）
- 仓库：`/Users/reachlucifer/project/opc/dsh-finance`
- 目标节点：Reach的MacBook Pro（exec host=node）
- 起点：`HEAD=fd1f08c`，工作区干净
- **总结论：两目标测试文件已对齐，无残留错标 / 无「6 计数」断言 → 无需改动（no-op）；三命令全绿，无回归。**

---

## 一、侦察：对齐工作在 `bdbe116`（任务-01）已完成

```
$ git log --oneline -5 -- tests/tester-task10-task-authorship.INDEPENDENT.spec.ts
bdbe116 refactor(skills): task-authorship 从可进化清单分离为固有 SKILL

$ git log --oneline -5 -- tests/prompt-skills.spec.ts
bdbe116 refactor(skills): task-authorship 从可进化清单分离为固有 SKILL
```

`bdbe116`（任务-01）在重构源码的同时，已同步改写这两个测试文件，使其区分
「5 可进化（filesystem provider）＋ 1 固有（runtime embedded）」。本任务为核对 + 独立回归。

---

## 二、AC1：来源区分（5 filesystem + 1 embedded，均可见）—— ✅ 通过

### 证据 A：`tests/tester-task10-task-authorship.INDEPENDENT.spec.ts`

| 行 | 断言片段 | 含义 |
|----|----------|------|
| L207 | `expect(SKILL_NAMES).toHaveLength(5)` | 可进化清单收窄为 **5** |
| L215 | `expect(SKILL_NAMES as readonly string[]).not.toContain(TA)` | TA 已移出可进化清单 |
| L216 | `expect(SKILL_NAMES[SKILL_NAMES.length - 1]).toBe('analysis-decision')` | 末位非 TA |
| L282 | `expect(got).toHaveLength(5)` | provider 恰发现 **5** 个 |
| L284 | `for (const s of got) expect(s.provider).toBe(SKILL_PROVIDER_NAME)` | 5 个来源 = **filesystem provider**（`'dsh-finance-skills'`，见 `src/skills/provider.ts:39`） |
| L287 / L372 | `expect(after.some((s) => s.name === TA)).toBe(false)` | 固有 SKILL **不经 provider 发现** |
| L359-362 | `const intrinsic = (...).find(s => s.name === TA)` + `expect(intrinsic?.source).toBe('runtime')` | 1 个 **embedded（runtime 静态注册）** 可见，来源 = runtime |

关键：验收 5(b) 在**同一个已装载的 app 内**先断言 5 个可进化可见、再断言 `task-authorship` 可见
→ 两者 **均可见**（同一 context，来源互斥）。

### 证据 B：`tests/prompt-skills.spec.ts`

| 行 | 断言片段 | 含义 |
|----|----------|------|
| L105 | `expect(SKILL_NAMES).toHaveLength(5)` | 收窄为 5 |
| L112 | `expect(SKILL_NAMES as readonly string[]).not.toContain(TASK_AUTHORSHIP_SKILL_NAME)` | TA 不在清单 |
| L234 | `expect(s?.source).toBe('custom')` | 5 个 = provider 源 |
| L235 | `expect(s?.provider).toBe(SKILL_PROVIDER_NAME)` | 5 个来源 = 名为 filesystem 的 provider |
| L123 | `expect(reg.source).toBe('runtime')` | 固有 = runtime |
| L356-357 | `expect(registeredSkills).toHaveLength(1)` / `[0].name === TASK_AUTHORSHIP_SKILL_NAME` | `apply` **仅静态注册 1 个固有**；5 个改由 provider 承担 |

### 证据 C：残留「6 计数」断言扫描（严格模式）

```
$ grep -nE "toHaveLength\(6\)|toBe\(6\)|=== *6([^0-9.]|$)" \
    tests/tester-task10-task-authorship.INDEPENDENT.spec.ts tests/prompt-skills.spec.ts
(无输出)  → grep_exit=1
```

两文件内**唯一**含「6」的命中为 `tests/prompt-skills.spec.ts:89`
`expect(idx).toBeGreaterThan(md.length * 0.6)`——是「章节行号 > 全文行数 × 0.6」的比例阈值，
**与 skill 计数无关**，不构成未对齐断言。

> **AC1 结论**：既有断言已完整覆盖「5 filesystem + 1 runtime embedded，来源区分，均可见」；
> 无残留未对齐断言，**无需改动**。

---

## 三、AC2：三命令全绿 —— ✅ 通过

| 命令 | EXIT | 说明 |
|------|------|------|
| `pnpm typecheck` | **0** | `tsc -p tsconfig.json --noEmit` |
| `pnpm build` | **0** | `clean + tsc + tsc(server) + copy-assets`；搬运 11 个资源（含 6 个 `SKILL.md`） |
| `pnpm test` | **0** | **54 files / 1035 tests 全通过** |

全量测试尾部统计：

```
 Test Files  54 passed (54)
      Tests  1035 passed (1035)
   Duration  24.95s
```

定向复跑两目标文件（独立佐证）：

```
$ pnpm vitest run tests/tester-task10-task-authorship.INDEPENDENT.spec.ts tests/prompt-skills.spec.ts
 Test Files  2 passed (2)
      Tests  60 passed (60)
```
→ 两文件 60 用例全绿；无回归。

---

## 四、是否需要改动 —— 否（no-op，含核对证据）

- 两文件在 `bdbe116` 已对齐；本次逐项核对**未发现**残留「6 计数」断言或错标来源的断言。
- 依任务要求「若结论是无需改动，必须给出核对证据（grep 命中 + 文件片段）」：见 §二 证据 A / B / C。
- **未修改任何文件**；工作区保持干净，`HEAD` 仍为 `fd1f08c`。

```
$ git status --short
(空)   # 工作区干净
$ git rev-parse --short HEAD
fd1f08c
```

---

## 五、守卫 / 风险说明

- **C1 守卫**（`tester-t100419 :: C1`，`tests/tester-t100419-skill-provider.INDEPENDENT.spec.ts:436`）：
  其扫描面为 `src/**`、`tests/**` 下 **`\.(ts|mts|cts|js|mjs)$`** 文件，纯文本 needle
  `registerAllSkills` / `createAllSkillRegistrations` / `createSkillRegistration` / `ctx.skills.register(`。
  本报告为 `.md`，**不进入扫描面**；且本次未改任何 `.ts/.js`，故**不触发 C1**。
  本次运行 `[EVIDENCE C1] offenders=0`。→ 无需改动守卫。
- ⚠️ 历史文档：`tests/tester-task10-task-authorship.REPORT.md` 仍描述「第 6 个技术面 SKILL / 计数 6」。
  那是 `task-authorship` 尚在可进化清单时期的**历史报告**（非测试代码、不参与回归），本任务未改动。
- ⚠️ 构建产物 `dist-server/skills/` 含 6 个 `SKILL.md`（5 可进化 + `task-authorship`）属**预期**：
  固有 SKILL 需随包分发、编译态可静态读取。`dist-server` 已在 `.gitignore` 中，`build` 不污染工作区。

---

## 六、结论

| 验收标准 | 结论 | 依据 |
|----------|------|------|
| **AC1** 区分 filesystem 5 个 + embedded 1 个，均可见 | ✅ 通过 | 证据 A：L207/L282/L284/L287/L359-362；证据 B：L105/L234-235/L123/L356-357；证据 C：零「6 计数」残留 |
| **AC2** typecheck / build / test 全绿、无回归 | ✅ 通过 | 三命令 EXIT=0；`54 files / 1035 tests`；定向 2 files / 60 tests |

- 交付物：本报告（`tests/tester-t100430-tests-align.INDEPENDENT.REPORT.md`）。
- **未自行 `git commit`**（提交由 Leader 统一处理）。
