# prompts

提示注入目录（Task 5 已落地正文）。

## 内容

| 文件 | 说明 |
|------|------|
| `advisor.md` | 「金融投资专家」人设正文（角色 / 原则 / 工作流 / 合规四块，末尾附「本内容不构成投资建议」） |
| `index.ts` | 人设加载 + `systemPrompt` 注入出口（唯一注册出口） |

## 注入机制

- 读取 `advisor.md`（`new URL('./advisor.md', import.meta.url)`，源码态 / 编译态路径一致）。
- 组装为 `systemPrompt` 的一个 `PromptSection`：`name='dsh-ia:advisor'`、`order=100`、`text=() => advisorMd`，**不使用 `complete`**（避免覆盖部署 persona）。
- 经 `ctx.inject(['systemPrompt'], cb)` **动态声明依赖**注入 —— 顶层插件 `inject` 保持 `['tools','skills','fs']` 不变。

## 构建搬运

`advisor.md` 由 `scripts/copy-assets.mjs` 复制到 `dist-server/prompts/advisor.md`，保证编译产物下可解析。
