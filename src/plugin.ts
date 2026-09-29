/**
 * dsh-finance 插件契约层 —— 金融投资专家 Agent。
 *
 * 本文件仅负责声明 Cordis 插件三要素（`name` / `apply` / `inject`），
 * 作为骨架任务（飞书任务 t100354）的交付主体：
 *   - `name`：插件唯一标识 `investment-advisor`
 *   - `inject`：依赖服务 `['tools', 'skills', 'ptcRuntime', 'fs']`
 *   - `apply(ctx)`：占位实现，保证 dsh 加载后调用不抛异常
 *
 * 依赖服务说明（已在 harness 源码核实）：
 *   - `tools`      —— dsh 工具注册表（`ctx.tools`，defineTool 注册面向模型的工具）
 *   - `skills`     —— dsh 技能注册表（`ctx.skills`，注册面向模型的 SKILL 操作指南）
 *   - `ptcRuntime` —— dsh 进程间/任务控制运行时（`ctx.ptcRuntime`，感知脚本执行）
 *   - `fs`         —— cordis 标准服务（`node:fs` 的文件系统访问）
 *
 * 当前阶段（骨架）：apply 仅做最小占位，不实现任何业务逻辑
 * （ledger / predicts / reviews / sense_archive 工具、prompt 人设正文、
 *   skill 正文、scheduler 等均属后续任务）。下方 `TODO` 标注即为后续扩展点。
 */
import type { Context } from '@deepseek-ai/cordis'

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
 * 当前为骨架占位：仅打印加载日志，不注册任何工具 / 技能 / 资源。
 * 后续任务将在 `ctx.effect` 内逐步接入：
 *   - `ctx.tools.register(defineTool({...}))`  注册记账 / 预测 / 复盘等工具
 *   - `ctx.skills.register({...})`             注册投资 SKILL 操作指南
 *   - 经 `ctx.ptcRuntime` 安排 scheduled/sensor-runner 感知脚本
 *
 * @param ctx 插件上下文（已注入上述四项服务）。
 */
export function apply(ctx: Context): void {
  console.log(
    `[dsh-finance] 插件加载：name=${name} inject=[${inject.join(', ')}]`,
  )

  // TODO(后续任务)：在此注册面向模型的金融工具、SKILL 指南与感知脚本调度。
  // 当前占位：不做任何破坏性操作，保证 dsh 加载后 apply 调用不抛异常。
  void ctx
}