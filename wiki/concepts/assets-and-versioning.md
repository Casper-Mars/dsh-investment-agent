# 资产与版本：一个仓库、路径即 ID、git 即历史

> `<assets>/.git` 是 skills / strategies / tasks / programs 的唯一仓库；资产变更“写入即 commit”，版本、作者、时间、回滚全部由 git 承担，资产文件本身不内嵌任何元数据。

## 资产层布局

```
<assets>/
├── .git/                  # 唯一仓库
├── .gitignore             # 只忽略系统/临时文件
├── skills/<name>/SKILL.md
├── strategies/<symbol>.md
├── tasks/
└── programs/
```

历史上 `assets/skills` 曾是嵌套独立仓库，导致外层只能记 gitlink、资产被切成两套历史；现已合并为单仓，`skills/` 只是普通目录。

## 三条硬规则

1. **写入即 commit**：任何写资产的模块都必须经过 `src/assets/commit.ts`。只接受 `skills/`、`tasks/`、`programs/`、`strategies/` 四个前缀的相对路径；拒绝绝对路径、`..`、`.git`、反斜杠。
2. **无变更不提交**：先 `git add -- <paths>`，再用 `git status --porcelain -- <paths>` 判断是否真有 staged 变更；没有就 no-op，不产生空 commit。
3. **失败降级**：git 不可用、非零退出、无写权限 → 告警并返回 `degraded: true`，不中断业务写入；只有路径非法才抛错（编程错误）。

## 元数据去哪了

| 信息 | 载体 |
|---|---|
| 身份 | 文件路径（路径即 ID） |
| 版本 / 时间 / 作者 | git commit |
| 变更原因 | commit message |
| 许可 / 分享范围 | 导出时声明 |

例外：`SKILL.md` 的 YAML frontmatter（`name` / `description` / `whenToUse`）保留，因为它是 dsh 的加载契约，不是治理新增的元数据。

## 历史回读

策略历史、skill 历史一律 `git log` / `git show`，不存在 `vNNN.md`、`.meta.json`、`current` 之类的版本链文件。项目未上线，因此不做旧版兼容、不做迁移脚本、不做只读回落。

## 相关

- [[decisions/0001-git-as-version-store|决策：git 承担版本]]
- [[decisions/0002-engine-vs-assets|决策：引擎 vs 资产]]
- [[decisions/0003-no-metadata-in-assets|决策：资产不内嵌元数据]]
- [[concepts/skill-system|Skill 体系]]

## 来源

- `README.md`
- `src/assets/repo.ts`
- `src/assets/commit.ts`
- `src/assets/git.ts`
- `CHANGELOG.md`
