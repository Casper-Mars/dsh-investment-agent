# T100445 独立测试报告：全仓重命名 `dsh-finance` → `dsh-ia`

- **被测交付物**：`/Users/reachlucifer/project/opc/dsh-finance`（工作区未 commit；`git diff` 132 文件 / 834 行）
- **测试文件**：`tests/tester-t100445-rename.INDEPENDENT.spec.ts`（20 用例，全部通过）
- **测试方式**：独立编写，不复用开发者改动；磁盘独立读取 + 正则校验（AC1/AC2/AC4/AC6），运行时真实 import（AC3/AC5）
- **测试时间**：2026-10-13
- **结论**：**✅ 通过（AC1–AC7 全绿）**，无阻断缺陷；1 处验收标准措辞需澄清（见 AC5 说明）。

---

## 逐条验收结论

| AC | 结论 | 依据 |
|----|------|------|
| AC1 残留为零 | ✅ | 覆盖范围内 `dsh-finance` = 0、`DSH_FINANCE_` = 0；大小写/分隔符变体 = 0；`dist-server/` 重建后 = 0 |
| AC2 发布标识 | ✅ | `package.json name="dsh-ia"`；`cordis.patch.yml` `id=dsh-ia`、`name=dsh-ia` |
| AC3 运行时标识 | ✅ | `PRODUCER_KIND='dsh-ia'`、`FINANCE_HOME='.dsh-ia'`、全部环境变量常量 `DSH_IA_*`；覆盖跟随验证通过 |
| AC4 无第三方误伤 | ✅ | 5 个 `@deepseek-ai/*` 依赖名原样；裸名 `dsh-llm`/`dsh-tools`/`dsh-skill` 原样；注释 `dsh-tasks`/`dsh-cron` 原样；无 `@deepseek-ai/dsh-ia-*` 误改 |
| AC5 运行时装配 | ✅（含 1 处澄清） | 最小 ctx `apply` 不抛；`inject=['tools','skills','fs']`；固有 SKILL 静态注册路径完好。**插件 Cordis `name` 实为 `investment-advisor`（非 `dsh-ia`）**，见下 |
| AC6 行为等价 | ✅ | `git diff --numstat` 插入 834 === 删除 834，纯 1:1 文本替换；kind 消费方一致 |
| AC7 全量回归 | ✅ | `pnpm typecheck` 0 错；`pnpm build` 0 错；`pnpm test` 69 文件 / 1464 用例全通过 |

---

## AC1 残留扫描证据

覆盖目标：`src/ scripts/ tests/ cordis.patch.yml package.json README.md vitest.config.ts tsconfig.json tsconfig.server.json pnpm-workspace.yaml`（递归）。

```
src/ scripts/ tests/ 配置文件集合内 `dsh-finance` 出现次数      = 0
同集合内 `DSH_FINANCE_` 出现次数                               = 0
大小写/分隔符变体 (dsh[_\-.]finance, 忽略大小写) 命中文件数     = 0
dist-server/ 重建后残留 (dsh-finance|DSH_FINANCE_)             = 0
全仓（排除 node_modules/.git、排除本轮 Tester 自建 spec）残留   = 0
```

> 说明：全仓 `grep` 唯一命中的 6 处均位于 Tester 自建 spec `tests/tester-t100445-rename.INDEPENDENT.spec.ts`（其内含待检模式字面量，属自指，非被测残留）。剔除后为 0。

- 构建产物 `dist-server/` 已由 `pnpm build` 重建（`rm -rf dist dist-server` → 重编译 + `[dsh-ia-assets]` 搬运 12 个资源文件），重建后 `dsh-ia` 引用 197 处、残留 0 处。

## AC2 发布标识证据

```jsonc
// package.json
"name": "dsh-ia"
```
```yaml
# cordis.patch.yml
- insert:
    - id: dsh-ia
      name: dsh-ia
      inject: ['tools', 'skills', 'fs']
```

## AC3 运行时标识证据（真实 import 断言）

| 断言项 | 实测值 |
|--------|--------|
| `PRODUCER_KIND`（`src/message-source.ts`） | `'dsh-ia'` |
| `FINANCE_HOME`（`src/paths.ts`） | `'.dsh-ia'` |
| 默认工作区根 `resolveFinanceHomeDir()` | `~/.dsh-ia`（`join(homedir(),'.dsh-ia')`） |
| 默认 dataRoot / tasksDir | `~/.dsh-ia/data`、`~/.dsh-ia/data/tasks` |
| `FINANCE_HOME_ENV` | `DSH_IA_HOME` |
| `FINANCE_SESSION_ID_ENV` | `DSH_IA_SESSION_ID` |
| `DATA_ROOT_ENV` | `DSH_IA_DATA_DIR` |
| `LOG_DIR_ENV` | `DSH_IA_LOG_DIR` |
| `LOG_LEVEL_ENV` | `DSH_IA_LOG_LEVEL` |
| `LOG_MAX_SIZE_ENV` | `DSH_IA_LOG_MAX_SIZE` |

对抗验证：
- 注入 `DSH_IA_HOME=/tmp/...` → `getFinanceHome()`/`resolveFinanceHomeDir()`/`resolveFinanceDataDir()` 全部跟随 ✅
- 注入 `DSH_IA_DATA_DIR=/tmp/...` → `resolveDataRoot()` 跟随（且优先于默认）✅
- 全仓 `src/` 内不存在非 `DSH_IA_` 的 `DSH_*` 环境变量引用 ✅

## AC4 无第三方误伤证据

- `package.json` peer/devDependencies 保持：`@deepseek-ai/cordis`、`@deepseek-ai/dsh-llm`、`@deepseek-ai/dsh-skill`、`@deepseek-ai/dsh-skill-filesystem`、`@deepseek-ai/dsh-tools` ✅
- `src/` 内裸名引用保持：`@deepseek-ai/dsh-llm`、`@deepseek-ai/dsh-tools`、`@deepseek-ai/dsh-skill` ✅
- 注释中第三方插件名保持：`dsh-tasks`、`dsh-cron`、`dsh-hello-plugin` ✅
- 反向校验：无 `@deepseek-ai/dsh-ia-{llm,skill,tools}`、无 `@deepseek-ai/cordis-ia` 误改形态 ✅
- 本插件自有命名空间 `dsh-ia-skills`（`SKILL_PROVIDER_NAME`）、`dsh-ia-assets`（copy-assets 日志前缀）、`dsh-ia-task-<id>` 均为重命名后的正确目标，非第三方 ✅

## AC5 运行时装配 + ⚠️ 验收标准措辞澄清

- 最小 ctx（无 `tools`/`skills` 服务）下 `apply(ctx)` **不抛**，日志 `[dsh-ia] 插件加载：name=investment-advisor inject=[tools, skills, fs]`，各处降级分支正常 ✅
- 顶层 `inject === ['tools','skills','fs']` ✅
- 固有 SKILL 静态注册、scheduler / 日志 exporter 装配路径完好（真实 cordis 装载由既有 `tests/plugin-tools-registration.spec.ts` 覆盖：21 工具注册 + dispose 注销 + 最小 ctx 降级，全绿）✅

> ⚠️ **措辞澄清（非缺陷）**：AC5 写「插件 `name` 为 `dsh-ia`」。实测 **Cordis 插件声明 `name = 'investment-advisor'`**（`src/plugin.ts`，重命名**未改动**，且既有多个测试断言 `pluginName === 'investment-advisor'`，`PINNED_SESSION_ID`/`DEFAULT_PINNED_SESSION_ID` 亦为 `'investment-advisor'`）。`cordis.patch.yml` 的 `name: dsh-ia` 解析的是**包 exports 入口名（打包名）**，非插件自身 `name` 标识（该 yml 注释已明确说明此点）。
> 即：**「包/发布名」= `dsh-ia`（AC2 已验）；「插件 Cordis name」= `investment-advisor`（本次重命名不涉及）**。二者概念不同，AC5 表述若指前者成立，若字面指 `src/plugin.ts` 的 `name` 导出则不成立——建议 Leader 按「改名规则仅覆盖 `dsh-finance`/`DSH_FINANCE_`」澄清为前者。**本项按不构成缺陷处理。**

## AC6 行为等价证据

```
git diff --numstat 汇总： added=834  deleted=834   files=132
```
插入/删除行数严格对称 → 全仓改动为**纯 1:1 文本替换**，未增删行、未改逻辑结构。
kind 消费方一致：`message-source.ts` 定义 `kind:'dsh-ia'`；`opening-notice.ts` / `scheduler/wake.ts` 均复用 `createNoticeMessage`（producer kind `'dsh-ia'`）；`src/` 内对退役 kind `'plugin'` 的 7 处引用**全部为注释**，无运行时代码使用 ✅

## AC7 全量回归结果

| 命令 | 结果 |
|------|------|
| `pnpm typecheck` | ✅ 退出 0，0 错 |
| `pnpm build` | ✅ 退出 0（clean + 双 tsc + copy-assets 全通过） |
| `pnpm test` | ✅ **Test Files 69 passed (69)；Tests 1464 passed (1464)**，退出 0 |

（含交易时段用例，fake timers 固定后通过；`maxWorkers=4` 稳定时序配置生效。）

---

## 缺陷

无阻断/一般缺陷。

## 观察项（非缺陷，供参考）

1. **内部标识符仍含 `Finance` 字样**：`FINANCE_HOME`、`FINANCE_HOME_ENV`、`DEFAULT_FINANCE_HOME_NAME`、`getFinanceHome`、`resolveFinanceHomeDir`、`resolveFinanceDataDir`、`resolveFinanceLogDir`、`ensureFinance*Dir`、`createFinanceLogger` 等。**改名规则仅声明替换 `dsh-finance` 与 `DSH_FINANCE_`，未要求改 camelCase 符号名**，故不越界；但若后续追求命名一致性可评估（属重构，非本次验收项）。
2. **历史测试产物含 `dsh-fin-*` 临时目录前缀**（如 `tests/tester-t100435*`、`t100444*`、`tester-strategy-feature` 的 `mkdtemp('dsh-fin-*')`）。这些是早期任务的 mkdtemp 前缀/测试产物名，非包名 `dsh-finance`，**不在残留判定范围**；如需整洁可另行清理（不影响功能）。
3. 本轮新增未跟踪文件：`tests/tester-t100445-rename.INDEPENDENT.spec.ts`（及本报告），**未 commit**。

---

## 交付物

1. 独立测试文件：`tests/tester-t100445-rename.INDEPENDENT.spec.ts`（20 用例，通过）
2. 本报告：`tests/tester-t100445-rename.INDEPENDENT.REPORT.md`
