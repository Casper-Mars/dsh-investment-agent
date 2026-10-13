# t100447 测试报告 —— 固件 skill resourceBase（独立验证）

- 被测交付物：`src/skills/index.ts` 为 2 个固件 skill 补齐 `resourceBase`
- 测试文件：`tests/tester-t100447-resourcebase.INDEPENDENT.spec.ts`
- 结论：✅ **全部通过**（5/5 用例，源码态 + 编译态双链路，typecheck 干净）

## 逐条验收结论

| AC | 验收标准 | 结论 |
|----|----------|------|
| AC1 | `createIntrinsicSkillRegistration()` 含 `resourceBase` 且 `kind === 'directory'` | ✅ 通过 |
| AC2 | `path` 绝对路径、指向目录（basename === skill 名、结尾无 SKILL.md） | ✅ 通过 |
| AC3 | 磁盘上 path 真实存在且是目录（`existsSync` + `statSync().isDirectory()`） | ✅ 通过 |
| AC4 | 源码态 `.../src/skills/<name>/`；编译态 `.../dist-server/skills/<name>/` | ✅ 通过 |
| AC5 | 两处 `resourceBase` 语义一致（都 directory、basename 各自匹配） | ✅ 通过 |
| AC6 | 其余契约字段不受影响（name/description/source='runtime'/invocation 双开/content 非空） | ✅ 通过 |

## 路径证据（实际运行输出）

**源码态（经 `src/skills/index.ts`）**
```
task-authorship  => {"kind":"directory","path":"/Users/reachlucifer/project/opc/dsh-finance/src/skills/task-authorship/"}
skill-authorship => {"kind":"directory","path":"/Users/reachlucifer/project/opc/dsh-finance/src/skills/skill-authorship/"}
```

**编译态（经 `dist-server/skills/index.js` import）**
```
task-authorship  => {"kind":"directory","path":"/Users/reachlucifer/project/opc/dsh-finance/dist-server/skills/task-authorship/"}
skill-authorship => {"kind":"directory","path":"/Users/reachlucifer/project/opc/dsh-finance/dist-server/skills/skill-authorship/"}
```

两态 path 均：
- 为绝对路径；
- basename === 各自 skill 名（`task-authorship` / `skill-authorship`）；
- 结尾不含 `SKILL.md`；
- 磁盘上真实存在且为目录（source 态与 dist 态各自目录下 `SKILL.md` 均可解析，`existsSync` 为 true）。

## 类型核对

`@deepseek-ai/dsh-skill` 的 `SkillResourceBase` 联合类型含 `{ kind: 'directory'; path: string }` 分支，被测值 `kind: 'directory'` + `path: absolute string` 与类型一致；`pnpm typecheck`（`tsc --noEmit`）通过，无类型回归。

## 测试方法与独立性说明

- 只 `import` 被测函数（`createIntrinsicSkillRegistration` / `createSkillAuthorshipRegistration`），配合 `node:fs/node:path` 做**语义断言**（`isAbsolute` / `basename` / `existsSync` / `isDirectory`），未硬编码整串绝对路径，也未复用 Developer 任何 spec。
- 对抗性：显式断言 `path` 的 basename 不含 `SKILL.md`，印证指向目录而非文件。
- 已知环境项（均与任务无关，未计入）：`tester-t100445-rename` 的 AC6 因工作区未提交改动而失败、`tester-prompt-skills` 全量并行偶发超时。

## 缺陷

无。未发现任何缺陷。