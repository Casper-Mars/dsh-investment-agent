/**
 * dsh-finance 插件契约层 —— 金融投资专家 Agent。
 *
 * 本文件负责声明 Cordis 插件三要素（`name` / `apply` / `inject`）并在
 * `apply(ctx)` 内装配运行时贡献：
 *   - `name`：插件唯一标识 `investment-advisor`
 *   - `inject`：依赖服务 `['tools', 'skills', 'ptcRuntime', 'fs']`（**契约固定，不变**）
 *   - `apply(ctx)`：
 *       1. 经 `ctx.skills.register` 注册 4 个技术面 SKILL
 *          （trend-analysis / grid-strategy / stop-rule / sense-authorship）；
 *       2. 经 `ctx.inject(['systemPrompt'], cb)` **动态注入** advisor.md 人设
 *          （详见 `src/prompts/index.ts`）。
 *
 * 依赖服务说明（已在 harness 源码核实）：
 *   - `tools`      —— dsh 工具注册表（`ctx.tools`，defineTool 注册面向模型的工具）
 *   - `skills`     —— dsh 技能注册表（`ctx.skills`，注册面向模型的 SKILL 操作指南）
 *   - `ptcRuntime` —— dsh 进程间/任务控制运行时（`ctx.ptcRuntime`，感知脚本执行）
 *   - `fs`         —— cordis 标准服务（`node:fs` 的文件系统访问）
 *
 * 注意：`systemPrompt` **不**加入顶层 `inject`，而是在 `apply` 内以
 *   `ctx.inject(['systemPrompt'], cb)` 动态声明依赖 —— 保证顶层契约
 *   `['tools','skills','ptcRuntime','fs']` 与 `cordis.patch.yml` 保持一致。
 */
import type { Context } from '@deepseek-ai/cordis'
import { registerAllSkills } from './skills/index.js'
import { applyAdvisorPrompt } from './prompts/index.js'

/** Cordis 函数式插件标识。 */
export const name = 'investment-advisor'

/**
 * 依赖服务。
 *
 * 契约要求固定为 `['tools', 'skills', 'ptcRuntime', 'fs']`，均为 dsh/cordis
 * 合法可注入服务。其中 `tools` / `skills` / `ptcRuntime` 由 harness 提供，
 * `fs` 为 cordis 标准服务。
 */
export const inject: string[] = ['tools', 'skills', 'ptcRuntime', 'fs']

/**
 * 安装金融投资专家 Agent 能力。
 *
 * 步骤：
 *   1. 在 `ctx.effect` 内注册 4 个技术面 SKILL；注销器绑定到 effect，
 *      插件 fiber 卸载（含 HMR 重载）时自动注销。`skills` 经顶层 `inject`
 *      保证就绪，但此处仍以 `ctx.get('skills')` 软取，使插件在「未提供 skills
 *      服务的最小上下文」（如装载测试）下安全降级，不中断插件装载。
 *   2. 经 `applyAdvisorPrompt(ctx)` 动态注入 advisor.md 人设到 system-prompt。
 *
 * @param ctx 插件上下文（已注入上述四项服务）。
 */
export function apply(ctx: Context): void {
  console.log(
    `[dsh-finance] 插件加载：name=${name} inject=[${inject.join(', ')}]`,
  )

  // ---- 技术面 SKILL（同步注册，注销器绑定 ctx.effect） ----
  ctx.effect(() => {
    let disposeSkills: (() => void) | undefined
    const skills = typeof ctx.get === 'function' ? ctx.get('skills') : undefined
    if (!skills) {
      console.warn('[dsh-finance] skills 服务不可用，跳过 SKILL 注册')
    } else {
      try {
        disposeSkills = registerAllSkills(ctx)
      } catch (err: unknown) {
        console.error('[dsh-finance] SKILL 注册失败：', err)
      }
    }
    return () => {
      disposeSkills?.()
    }
  }, 'dsh-finance skills')

  // ---- advisor.md 人设（动态 inject systemPrompt，不改顶层 inject） ----
  applyAdvisorPrompt(ctx)
}
