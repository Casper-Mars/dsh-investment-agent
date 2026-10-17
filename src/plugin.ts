/**
 * dsh-ia 插件契约层 —— 金融投资专家 Agent。
 *
 * 本文件负责声明 Cordis 插件三要素（`name` / `apply` / `inject`）并在
 * `apply(ctx)` 内装配运行时贡献：
 *   - `name`：插件唯一标识 `investment-advisor`
 *   - `inject`：依赖服务 `['tools', 'skills', 'fs']`（**契约固定，不变**）
 *   - `apply(ctx)`：
 *       1. 经 `ctx.tools.register` 注册 14 个模型工具
 *          （4 ledger + 2 strategy + 3 predicts + 5 reviews，详见
 *          `src/tools/index.ts`）。工具模块图较重，故在 `apply` 内以
 *          `import('./tools/index.js')` **惰性加载**后注册（参照 dsh-tasks）；
 *          注销器绑定 `ctx.effect`，fiber 卸载（含 HMR 重载）时自动注销；
 *          另经 `applyScheduler` 注册 7 个 `task_*` 定时任务工具（详见
 *          `src/scheduler/tools.ts`），合计本插件注册 21 个工具；
 *       2. 挂载 dsh 原生 `skill-filesystem` provider（`src/skills/provider.ts`），
 *          指向资产层目录 `<assetsDir>/skills`（即 `~/.dsh-ia/assets/skills`）并开启 watch 热更新，
 *          发现 5 个「可进化 SKILL」
 *          （trend-analysis / grid-strategy / stop-rule / strategy-authorship / analysis-decision）；
 *          另将 2 个「固有 SKILL」（task-authorship / skill-authorship）经 `ctx.skills.register`
 *          **静态注册**（不进化）。provider 注册在插件自身 ctx（global 层），对固定会话与
 *          workspace 会话均可见；
 *       3. 经 `ctx.inject(['systemPrompt'], cb)` **动态注入** advisor.md 人设
 *          （详见 `src/prompts/index.ts`）。
 *
 * 依赖服务说明（已在 harness 源码核实）：
 *   - `tools`      —— dsh 工具注册表（`ctx.tools`，defineTool 注册面向模型的工具）
 *   - `skills`     —— dsh 技能注册表（`ctx.skills`，provider 注册/发现面向模型的 SKILL 操作指南）
 *   - `fs`         —— cordis 标准服务（`node:fs` 的文件系统访问）
 *
 * 注意：`systemPrompt` **不**加入顶层 `inject`，而是在 `apply` 内以
 *   `ctx.inject(['systemPrompt'], cb)` 动态声明依赖 —— 保证顶层契约
 *   `['tools','skills','fs']` 与 `cordis.patch.yml` 保持一致。
 */
import type { Context } from '@deepseek-ai/cordis'
import {
  createIntrinsicSkillRegistration,
  createSkillAuthorshipRegistration,
} from './skills/index.js'
import { ensureSkillAssetsRepo } from './skills/repo.js'
import { mountSkillFilesystemProvider } from './skills/provider.js'
import { applyAdvisorPrompt } from './prompts/index.js'
import { applyScheduler } from './scheduler/index.js'
import { applySessionEnsure } from './session-ensure.js'
import { createFinanceLogger } from './log/logger.js'
import { createFileExporter } from './log/file-exporter.js'

export { PINNED_SESSION_ID, type SessionPersistenceLike, type PinnedSessionId } from './session.js'
export {
  ensurePinnedSession,
  resolveAgentOptions,
  mountDefaultPresetSetup,
  applySessionEnsure,
  attachPinnedSessionToWorkspace,
  type SessionEnsureDeps,
  type EnsureAgent,
  type EnsureAgentOptions,
  type EnsureAgentHandle,
  type EnsureOutcome,
  type AgentDefaultModelLike,
  type AgentPresetsLike,
  type WorkspaceRegistryLike,
  type WorkspaceLike,
} from './session-ensure.js'
export {
  OPENING_NOTICE_TEXT,
  OPENING_NOTICE_SUMMARY,
  buildOpeningNoticeMessage,
  isSessionBlank,
  deliverOpeningNotice,
  type OpeningNoticeAgent,
  type OpeningNoticeAgents,
  type OpeningNoticeDeps,
  type OpeningNoticeResult,
  type SessionProjectionsLike,
} from './opening-notice.js'

/** Cordis 函数式插件标识。 */
export const name = 'investment-advisor'

/**
 * 依赖服务。
 *
 * 契约要求固定为 `['tools', 'skills', 'fs']`，均为 dsh/cordis
 * 合法可注入服务。其中 `tools` / `skills` 由 harness 提供，
 * `fs` 为 cordis 标准服务。
 */
export const inject: string[] = ['tools', 'skills', 'fs']

/**
 * 安装金融投资专家 Agent 能力。
 *
 * 加载策略（参照 dsh-tasks）：工具实现模块（`./tools/index.js`，含
 *   `@deepseek-ai/dsh-tools` 依赖，模块图较重）在 `apply` 内**惰性加载**，而非
 *   静态 import —— 静态引入会拖慢插件 fiber 的激活时序。惰性加载让插件本体
 *   立刻就绪、14 个模型工具随后注册；调度器另注册 7 个 `task_*` 工具，合计
 *   21 个工具。工具与 SKILL 的注销器均绑定 `ctx.effect`，fiber 卸载（含 HMR
 *   重载）时逆序自动注销。
 *
 * 步骤：
 *   1. 在 `ctx.effect` 内**惰性加载**并注册 14 个模型工具；注销器绑定到 effect，
 *      插件 fiber 卸载（含 HMR 重载）时自动注销。`tools` 经顶层 `inject` 保证
 *      就绪，但此处仍以 `ctx.get('tools')` 软取，使插件在「未提供 tools 服务的
 *      最小上下文」（如装载测试）下安全降级，不中断插件装载。
 *   2. 冷启动预置 skill 资产仓库（`ensureSkillAssetsRepo`），再挂载指向
 *      `<assetsDir>/skills`（即 `~/.dsh-ia/assets/skills`）的 `skill-filesystem` provider 并开启 watch 热更新
 *      （`mountSkillFilesystemProvider`）。provider 注册进插件自身 ctx（global 层），
 *      对固定会话与 workspace 会话均可见；注销器绑定 effect，插件 fiber 卸载时自动
 *      注销并关闭 watch。预置与挂载均 try/catch 降级，失败不中断插件装载。
 *   2b. 固有 SKILL `task-authorship`（任务程序方法论，不进化）与 `skill-authorship`（编写合规
 *      skill 的规范，不进化）经 `ctx.skills.register` 静态注册到插件自身 ctx（global 层）。
 *      注册失败 try/catch 降级，不中断装载。
 *   3. 经 `applyAdvisorPrompt(ctx)` 动态注入 advisor.md 人设到 system-prompt。
 *
 * @param ctx 插件上下文（已注入上述三项服务）。
 */
export function apply(ctx: Context): void {
  // ---- 统一日志门面（M1）：最早期创建，取自 dsh 原生 `ctx.logger`；缺失则降级 ----
  // 顶层 inject 契约不变（`ctx.logger` 是 Context 内置服务，不算顶层依赖）。
  const nativeLogger = typeof ctx.logger === 'function' ? ctx.logger : undefined
  const logger = createFinanceLogger({ native: nativeLogger, scope: 'dsh-ia' })
  const logTools = logger.child('tools')
  const logSkills = logger.child('skills')
  const logSession = logger.child('session')
  const logScheduler = logger.child('scheduler')

  // ---- 文件落地 exporter（M2「文件落地」）：追加注册，早于业务装配 -------
  // 经 `ctx.logger.exporter(...)` **追加**一个 JSONL 文件 exporter（宿主既有 exporter
  // 不受影响）；注销器已绑定 ctx.effect，fiber 卸载时自动注销。注册失败 / ctx.logger
  // 不可用（如最小 mock 上下文）→ 记日志、降级不抛，不中断插件装载。
  // 注意：本行置于下方「插件加载」info 之前，使装载日志也能落入文件。
  try {
    if (nativeLogger && typeof nativeLogger.exporter === 'function') {
      nativeLogger.exporter(createFileExporter())
    } else {
      logger.warn('[dsh-ia] ctx.logger 不可用，跳过文件 exporter 注册（降级）')
    }
  } catch (err: unknown) {
    logger.error('[dsh-ia] 文件 exporter 注册失败（降级）', { error: err })
  }

  logger.info(`[dsh-ia] 插件加载：name=${name} inject=[${inject.join(', ')}]`)

  // ---- 14 个模型工具（惰性 import，异步注册，注销器绑定 ctx.effect） ----
  ctx.effect(() => {
    let cancelled = false
    let disposeTools: (() => void) | undefined

    // 安全降级：tools 服务不可用（最小上下文 / 装载测试）时跳过，不中断装载。
    const tools = typeof ctx.get === 'function' ? ctx.get('tools') : undefined
    if (!tools) {
      logTools.warn('[dsh-ia] tools 服务不可用，跳过工具注册')
    } else {
      // 惰性加载：模块图较重（context → domain → @deepseek-ai/dsh-tools），
      // 动态 import 避免拖慢插件 fiber 激活时序（参照 dsh-tasks 做法）。
      void import('./tools/index.js')
        .then(({ registerAllTools }) => {
          // 插件可能在动态加载完成前已被卸载：跳过，避免在失活 ctx 上注册。
          if (!cancelled) disposeTools = registerAllTools(ctx)
        })
        .catch((err: unknown) => {
          logTools.error('[dsh-ia] 工具注册失败', { error: err })
        })
    }

    return () => {
      cancelled = true
      disposeTools?.()
    }
  }, 'dsh-ia tools')

  // ---- advisor.md 人设（动态 inject systemPrompt，不改顶层 inject） ----
  applyAdvisorPrompt(ctx)

  // ---- skill 资产仓库冷启动预置（幂等；资产层内独立 git 仓库，§任务-1） ----
  // 保留随包发布的「首版种子」（src/skills/<name>/SKILL.md → dist-server/skills/），
  // 仅当其资产层副本（<assetsDir>/skills，即 ~/.dsh-ia/assets/skills）缺失或为空时预置；
  // 已就绪则完全 no-op。
  // 预置失败（git 不可用 / 命令失败 / 无写权限）→ 记日志、降级不抛，不中断装载。
  try {
    ensureSkillAssetsRepo({ logger: (message) => logSkills.info(message) })
  } catch (err: unknown) {
    logSkills.error('[dsh-ia] skill 资产仓库预置装配失败（降级）', { error: err })
  }

  // ---- skill-filesystem provider（指向 <assetsDir>/skills + watch 热更新，§任务-2） ----
  // 挂载 dsh 原生 filesystem provider，注册进插件自身 ctx（global 层 → 对固定会话与
  // workspace 会话均可见）。依赖为可选 peer，故惰性加载；解析/挂载失败 → 记日志、降级
  // 不抛。注销器绑定 ctx.effect，fiber 卸载时自动注销并关闭 watch。
  try {
    mountSkillFilesystemProvider(ctx)
  } catch (err: unknown) {
    logSkills.error('[dsh-ia] skill-filesystem provider 装配失败（降级）', { error: err })
  }

  // ---- 固有 SKILL（task-authorship）静态注册（不进化，独立于 provider 发现） ----
  // `task-authorship` 是「固有资产」（任务程序方法论：结构 / 返回值契约 / 自测纪律），
  // 不落入 <assetsDir>/skills 的 git 进化链与热更新时间线。故不经 provider 发现，而是
  // 直接以 `ctx.skills.register` 静态挂到插件 ctx（unscoped → global 层），对固定会话
  // 与 workspace 会话均可见。注销器绑定 ctx.effect，fiber 卸载时自动注销。
  // 注册失败（文件缺失 / frontmatter 非法 / skills 服务不可用）→ 记日志、降级不抛。
  ctx.effect(() => {
    const skills = typeof ctx.get === 'function' ? ctx.get('skills') : undefined
    if (!skills) {
      logSkills.warn('[dsh-ia] skills 服务不可用，跳过 task-authorship 静态注册')
      return () => {}
    }
    let dispose: (() => void) | undefined
    try {
      dispose = skills.register(createIntrinsicSkillRegistration())
    } catch (err: unknown) {
      logSkills.error('[dsh-ia] task-authorship 静态注册失败（降级）', { error: err })
    }
    return () => {
      try {
        dispose?.()
      } catch {
        /* ignore */
      }
    }
  }, 'dsh-ia task-authorship skill')

  // ---- 固有 SKILL（skill-authorship）静态注册（固件：编写合规 skill 的规范，不进化） ----
  // `skill-authorship` 与 `task-authorship` 同机制同生命周期：固件、不参加进化、不落
  // <assetsDir>/skills，直接以 `ctx.skills.register` 静态挂到插件 ctx（global 层）。
  // 注销器绑定 ctx.effect，fiber 卸载时自动注销；注册失败降级不抛、不中断装载。
  ctx.effect(() => {
    const skills = typeof ctx.get === 'function' ? ctx.get('skills') : undefined
    if (!skills) {
      logSkills.warn('[dsh-ia] skills 服务不可用，跳过 skill-authorship 静态注册')
      return () => {}
    }
    let dispose: (() => void) | undefined
    try {
      dispose = skills.register(createSkillAuthorshipRegistration())
    } catch (err: unknown) {
      logSkills.error('[dsh-ia] skill-authorship 静态注册失败（降级）', { error: err })
    }
    return () => {
      try {
        dispose?.()
      } catch {
        /* ignore */
      }
    }
  }, 'dsh-ia skill-authorship skill')

  // ---- 固定会话确保（Task-10：检查 → 恢复 → 新建，§9.5） ----
  try {
    applySessionEnsure(ctx, { logger: (message) => logSession.info(message) })
  } catch (err: unknown) {
    logSession.error('[dsh-ia] 会话确保装配失败', { error: err })
  }

  // ---- 定时任务多任务调度（loader → runner → waker 编排 + 7 工具，§4.3） ----
  try {
    // scheduler 默认日志出口已统一接入门面（内部经本 ctx 取原生 logger）。
    applyScheduler(ctx)
  } catch (err: unknown) {
    logScheduler.error('[dsh-ia] scheduler 装配失败', { error: err })
  }
}
