/**
 * assets 工具：`asset_commit` —— agent 写资产后的统一提交入口。
 *
 * 背景：skill 文件、任务程序（`assets/programs/**`）以及其它资产由 agent 直接用
 * 文件工具写入，没有 domain 层替它们提交。资产的价值在于进入 `<assetsDir>` 的
 * git 历史：**写完文件后必须调用本工具**，否则改动只存在于工作区，等于没发生。
 *
 * 语义边界：
 *   - 本工具**只提交、不写文件**；文件必须先由 agent 写入磁盘；
 *   - `paths` 为相对 assets 根的路径，仅允许 `skills/`、`tasks/`、`programs/`、
 *     `strategies/` 四个前缀；绝对路径 / `..` / `.git` / 反斜杠一律拒绝；
 *   - 路径非法 → 抛错（`throwToolError` 风格，registry 归一为 isError）；
 *   - git 不可用 / 非零退出 / 无写权限 → **降级返回**（`degraded: true`），
 *     不抛工具异常、不中断 agent 流程；
 *   - 无实际变更 → `committed: false` 的 no-op，不产生空 commit。
 *
 * 实现复用 `src/assets/commit.ts`，与 TaskStore 的自动提交共享同一套身份、
 * 路径校验与 commit message 规则。
 */
import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import { resolveAssetsDir } from '../paths.js'
import { commitAssets, normalizeAssetPaths, type AssetsCommitLogger } from '../assets/commit.js'
import type { GitRunner } from '../assets/git.js'
import { assertNotAborted, throwToolError } from './error.js'
import { assetCommitResultSchema } from './schemas.js'

/** `asset_commit` 依赖注入配置（默认取 `resolveAssetsDir()` + 系统 git）。 */
export interface AssetToolsOptions {
  /** 资产根目录；省略时取 `resolveAssetsDir()`（跟随 `DSH_IA_HOME`）。 */
  assetsDir?: string
  /** 自定义 git 执行器（仅测试注入）。 */
  gitRunner?: GitRunner
  /** 日志出口（默认统一日志门面）。 */
  logger?: AssetsCommitLogger
}

/**
 * `asset_commit`：把 agent 刚写入的资产文件提交到 assets 仓库。
 *
 * 参数 `paths` 必须相对 `<assetsDir>`；成功返回 `{ dir, committed, degraded,
 * commit?, reason, files }`，git 失败时 `degraded: true` 而非抛错。
 */
export function createAssetCommitTool(options: AssetToolsOptions = {}): ToolDefinition {
  return defineTool({
    name: 'asset_commit',
    description:
      '把刚写入的资产文件提交到 assets git 仓库（写入即 commit）。**写完 skill 文件 ' +
      '（skills/<name>/SKILL.md）、任务程序（programs/<task>/task.ts）或任何其它资产后必须调用**，' +
      '否则改动不会进入资产历史。paths 为相对 assets 根的路径数组，仅允许 skills/、tasks/、' +
      'programs/、strategies/ 前缀；本工具只提交、不写文件。无变更时不产生空 commit；' +
      'git 失败时降级返回（degraded=true），不中断流程。写操作。',
    parameters: {
      paths: {
        type: 'array',
        items: { type: 'string' },
        required: true,
        description:
          '相对 assets 根的资产路径数组（如 skills/foo/SKILL.md、programs/foo/task.ts）',
      },
      message: {
        type: 'string',
        description: '可选提交前缀（实际 message 仍会追加每个资产的动作与相对路径）',
      },
    },
    output: {
      schema: assetCommitResultSchema,
      render: (_args, value) => {
        if (value.degraded) {
          return [
            {
              type: 'text',
              text: `⚠️ 资产提交降级（文件已写入，但未进入 git）：${value.reason}`,
            },
          ]
        }
        if (!value.committed) {
          return [{ type: 'text', text: `ℹ️ 资产无变更（no-op）：${value.reason}` }]
        }
        const lines = value.files.map((f) => `  ${f.action} ${f.path}`).join('\n')
        return [
          {
            type: 'text',
            text: `✅ 已提交资产 ${value.commit ?? ''}\n${lines}`,
          },
        ]
      },
    },
    async execute(args, exec) {
      assertNotAborted(exec.signal)
      // 路径非法属于调用方错误，抛给模型修正；git 失败才降级。
      let paths: string[]
      try {
        paths = normalizeAssetPaths(args.paths)
      } catch (err) {
        throwToolError(err)
      }

      const outcome = commitAssets({
        assetsDir: options.assetsDir ?? resolveAssetsDir(),
        paths,
        message: args.message,
        gitRunner: options.gitRunner,
        logger: options.logger,
      })

      return {
        dir: outcome.dir,
        committed: outcome.committed,
        degraded: outcome.degraded,
        ...(outcome.commit !== undefined ? { commit: outcome.commit } : {}),
        reason: outcome.reason,
        files: outcome.files,
      }
    },
  })
}

/** 构造 assets 域工具集（当前仅 `asset_commit`）。 */
export function createAssetTools(options: AssetToolsOptions = {}): ToolDefinition[] {
  return [createAssetCommitTool(options)]
}
