# 安装与运维

> 一个 dsh profile 插件：装进宿主、用环境变量隔离数据、按目录分层排查。没有自定义启动参数。

## 安装

前置：Node.js ≥ 22.19、pnpm ≥ 11.7、可用的 dsh 宿主。

```sh
# 在当前目录（本包）安装到指定 profile
dsh plugin --profile <name> add .
```

安装后由 profile 的 bundle patch（`cordis.patch.yml`，裸包名 `dsh-ia`）自动加载。

## 配置

dsh 启动器为严格模式，不接受自定义 flag，全部走环境变量：

| 变量 | 作用 | 默认 |
|---|---|---|
| `DSH_IA_HOME` | 工作区根目录（assets / data / logs / workspace 全部跟随） | `~/.dsh-ia` |
| `DSH_IA_SESSION_ID` | 固定会话 id | `investment-advisor` |
| `DSH_IA_DATA_DIR` | 单独覆盖 dataRoot | `<home>/data` |
| `DSH_IA_LOG_RETENTION_DAYS` | 日志保留天数 | `30` |
| `DSH_IA_LOG_MAX_SIZE` | 单日志文件上限 | `500 MB` |

只设 `DSH_IA_HOME` 时，会话 id 会确定性派生为 `investment-advisor-<sha256(home) 前 8 位>`，天然隔离两套数据。

## 目录与权限

| 路径 | 内容 | 权限 / 版本 |
|---|---|---|
| `<home>/assets` | 策略 / skill / 任务 / 程序，单 git 仓 | 可共享 |
| `<home>/data` | 台账（持仓、成本、流水） | `0o700`，不进 git |
| `<home>/logs` | JSONL 日志，按 UTC 日切 | `0o700`，文件 `0o600` |
| `<home>/workspace` | 会话工作区 | 私有 |

日志单文件超过上限会滚动为 `-1` / `-2`；过期日志在 exporter 创建时清理一次，之后每天（UTC）首次写盘前清理。

## 开发命令

```sh
pnpm build        # 类型检查 + 编译 + 搬运 .md 资源
pnpm typecheck    # 仅类型检查
pnpm test         # vitest（--maxWorkers=4）
pnpm clean        # 清理 dist / dist-server
pnpm wiki         # 重建 wiki 索引与 lint 报告
pnpm wiki:check   # 校验断链 / 缺来源
```

## 排障顺序

1. **插件没加载**：看 `package.json` 的 `engines.dsh` 是否覆盖当前 dsh 版本；dsh 存在该字段时不再比对 peerDependencies。
2. **数据“丢了”**：确认 `DSH_IA_HOME` 是否被覆盖，以及会话 id 是否因 home 变化而派生变化。
3. **资产没历史**：检查 `<home>/assets/.git` 是否存在；git 失败是降级语义，只在日志里告警。
4. **Skill 没生效**：可进化 Skill 看 `<home>/assets/skills` 与 watch；固件 Skill 必须重装插件版本。
5. **定时任务不跑**：按 loader（install）→ runner（exec）→ waker（投递）三段分别看日志与 `failureKind`。

## 相关

- [[concepts/scheduler|定时任务层]]
- [[concepts/assets-and-versioning|资产与版本]]

## 来源

- `README.md`
- `src/flags.ts`
- `src/paths.ts`
- `src/log/file-exporter.ts`
- `package.json`
