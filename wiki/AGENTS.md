# Wiki Agent Guide

给在本仓库工作的 Agent 的硬规则。

1. **先读 `index.md`，再按需读单页**。不要一次性加载整个 wiki。
2. 回答“为什么”时优先引用 `decisions/`，回答“怎么运作”时引用 `concepts/`，回答“事实是什么”时引用 `entities/` 与 `sources/`。
3. **wiki 不是事实来源**。页面与代码冲突时，以代码、测试、`CHANGELOG.md`、git 历史为准；随后修正页面。
4. 新增页面必须套 `_templates/page.md`，必须带 `## 来源`，且来源路径真实存在。
5. 不手工编辑 `index.md` 的生成块与 `reports/lint.md`；运行 `pnpm wiki`。
6. 不复制大段代码或飞书正文；写结论 + 指向来源。
7. 修改公开契约时，同一次提交内更新受影响的 concept 页。
8. 资产层（`~/.dsh-ia/assets`）的版本、回滚一律走 git；wiki 只描述机制，不复制资产内容。
