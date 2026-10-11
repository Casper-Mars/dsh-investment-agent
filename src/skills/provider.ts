/**
 * dsh-finance SKILL provider 装配层 —— 接入 dsh 原生 `skill-filesystem` provider。
 *
 * 背景（skill 重构任务-2）：
 *   历史上 6 个技术面 SKILL 由 `src/skills/index.ts` 以「读文件 + `ctx.skills.register`」
 *   静态注册到运行时层。该路径无法热更新（改 SKILL.md 需重启），且把「资产发现」
 *   与「资产内容」耦合在本插件里。本模块改为挂载 dsh 原生 filesystem provider，
 *   指向运行时数据目录 `<dataRoot>/skills`（`src/skills/repo.ts` 的独立 git 仓库），
 *   并开启 `watch` 热更新。
 *
 * 范围：本 provider 发现的是 **5 个「可进化 SKILL」**（= `SKILL_NAMES`）。固有 SKILL
 *   `task-authorship` 不落数据目录、不参与本 provider 发现，改由 `src/plugin.ts` 静态注册。
 *
 * 挂载语义（已在 harness 源码核实）：
 *   - `@deepseek-ai/dsh-skill-filesystem` 是标准 cordis 插件（`name` / `inject=['skills']`
 *     / `Config` / `apply`）；其 `apply` 内部调 `ctx.skills.registerProvider(...)`，
 *     watch 由 chokidar 管理（默认稳定阈值 200ms）。
 *   - `ctx.skills.registerProvider` 的层归属由调用 ctx 的 scope 决定：**本插件 ctx 未
 *     scoped → 注册进 global 层**；读取时 global 层并入每个 agent 的 scope 链，故固定
 *     会话与 workspace 会话均可见。
 *   - `providerName` 取唯一名 {@link SKILL_PROVIDER_NAME}，避免与 preset 内默认的
 *     `filesystem` provider 同层重名冲突。
 *
 * 降级语义（对齐 `src/plugin.ts` / `src/skills/repo.ts` 风格）：
 *   - 依赖 `@deepseek-ai/dsh-skill-filesystem` 为**可选 peer**，故以动态 `import()`
 *     惰性加载；解析失败 / 挂载失败 → 记日志、降级不抛、不中断插件装载；
 *   - 注销器绑定 `ctx.effect`，插件 fiber 卸载（含 HMR 重载）时自动注销并关闭 watch。
 */
import type { Context } from '@deepseek-ai/cordis'
import { resolveDataRoot } from '../paths.js'
import { resolveSkillsRepoDir } from './repo.js'

/**
 * 本插件在 `ctx.skills` 注册表中的唯一 provider 名。
 *
 * preset 内 `skill-filesystem` 默认 providerName 为 `filesystem`；自定义 roots 覆盖由
 * 「同名 provider 冲突」决定，故取唯一名避免同层重名。
 */
export const SKILL_PROVIDER_NAME = 'dsh-finance-skills'

/** 挂载选项。 */
export interface MountSkillProviderOptions {
  /** 数据根目录（可选）；省略时依次取环境变量 `DSH_FINANCE_DATA_DIR` → 默认值。 */
  dataRoot?: string
  /** provider 名（默认 {@link SKILL_PROVIDER_NAME}）。 */
  providerName?: string
  /** 是否开启 watch 热更新（默认 `true`）。 */
  watch?: boolean
}

/** 已挂载的 provider 句柄。 */
export interface SkillProviderMount {
  /** 被扫描的 skills 目录（`<dataRoot>/skills`）。 */
  dir: string
  /** 注册进 `ctx.skills` 的 provider 名。 */
  providerName: string
  /** 注销器：卸载 provider 并关闭其 watch。可 await 以等待注销完成。 */
  dispose: () => Promise<void>
}

/**
 * 挂载 `skill-filesystem` provider（**异步**，等待插件加载完成）。
 *
 * 动态加载 `@deepseek-ai/dsh-skill-filesystem` 并 `ctx.plugin(...)` 到**当前 ctx**
 * （未 scoped → global 层）。config 固定为「只扫 customSkillDirs、指向
 * `<dataRoot>/skills`、开启 watch」。
 *
 * @param ctx 插件上下文（需 `skills` 服务就绪；`ctx.get('fs')` 缺失时 provider 回落 node fs）。
 * @param options 见 {@link MountSkillProviderOptions}。
 * @returns 挂载句柄（含注销器）。失败时**抛出**，由调用方决定降级。
 */
export async function mountSkillFilesystemProviderAsync(
  ctx: Context,
  options: MountSkillProviderOptions = {},
): Promise<SkillProviderMount> {
  const providerName = options.providerName ?? SKILL_PROVIDER_NAME
  const watch = options.watch ?? true
  const dataRoot = resolveDataRoot(options.dataRoot)
  const skillsDir = resolveSkillsRepoDir(dataRoot)

  // 惰性加载：可选 peer，模块图（chokidar / yaml）不随插件本体强制解析。
  const mod = await import('@deepseek-ai/dsh-skill-filesystem')

  // 仅扫自定义目录、不做 project/user 默认 roots 发现；指向运行时数据目录。
  const fiber = ctx.plugin(mod, {
    providerName,
    includeDefaultRoots: false,
    customSkillDirs: [skillsDir],
    watch,
  })
  await fiber

  return {
    dir: skillsDir,
    providerName,
    dispose: () => {
      return fiber.dispose()
    },
  }
}

/**
 * 挂载 `skill-filesystem` provider（**同步**装配入口，注销器绑定 `ctx.effect`）。
 *
 * 内部经 {@link mountSkillFilesystemProviderAsync} 惰性加载并挂载；任何失败（依赖
 * 不可解析 / 挂载失败）记日志、降级不抛，不中断插件装载。返回的注销器由 `ctx.effect`
 * 托管：插件 fiber 卸载时自动注销 provider 并关闭 watch。
 *
 * @param ctx 插件上下文（需 `skills` 服务就绪）。
 * @param options 见 {@link MountSkillProviderOptions}。
 * @returns 注销器（亦为 effect 的 disposer；可 await 以等待 provider 注销完成）。
 */
export function mountSkillFilesystemProvider(
  ctx: Context,
  options: MountSkillProviderOptions = {},
): () => Promise<void> {
  return ctx.effect(() => {
    let cancelled = false
    let mount: SkillProviderMount | undefined

    void mountSkillFilesystemProviderAsync(ctx, options)
      .then((m) => {
        // 插件可能在动态加载完成前已被卸载：跳过挂载，立即注销。
        if (cancelled) {
          void m.dispose()
          return
        }
        mount = m
      })
      .catch((err: unknown) => {
        console.error('[dsh-finance] skill-filesystem provider 挂载失败（降级）：', err)
      })

    return async () => {
      cancelled = true
      await mount?.dispose()
    }
  }, 'dsh-finance skill-filesystem provider')
}
