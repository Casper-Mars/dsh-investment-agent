/**
 * Prompt 注入层入口 ——「金融投资专家」人设（advisor.md）的**唯一注入出口**。
 *
 * 职责（对应 Task 5 §B）：
 *   1. 读取 `src/prompts/advisor.md`（随构建产物发布到 `dist-server/prompts/advisor.md`）；
 *   2. 组装为 `systemPrompt` 的一个 `PromptSection`（唯一 name、指定 order）；
 *   3. 经 `ctx.inject(['systemPrompt'], cb)` **动态声明依赖**后注入 —— 顶层插件
 *      `inject` 保持 `['tools','skills','fs']` 不变（Task 1 契约）。
 *
 * 路径策略：`new URL('./advisor.md', import.meta.url)` 在源码态
 *   （`src/prompts/index.ts`）与编译态（`dist-server/prompts/index.js`）下
 *   均指向同名相对文件；`.md` 由 `scripts/copy-assets.mjs` 搬运到 `dist-server`。
 *
 * 设计约束：
 *   - section 的 `name` 全局唯一；`order` 数值排序（persona 类靠前）。
 *   - **不使用 `complete: true`**：避免覆盖部署层 persona（会与之冲突）。
 *   - `systemPrompt` 未安装于本包依赖，故以**最小结构类型**描述其契约，
 *     避免引入对 `@deepseek-ai/dsh-system-prompt` 的硬依赖。
 */
import { readFileSync } from 'node:fs'
import type { Context } from '@deepseek-ai/cordis'
import { createLogger } from '../log/logger.js'

/** 人设注入日志出口（统一门面；无 `ctx` logger 注入位，走降级实现）。 */
const promptLog = createLogger('dsh-ia:prompt')

/** advisor 人设文件在运行时的绝对路径（源码态 / 编译态相对路径一致）。 */
const ADVISOR_URL = new URL('./advisor.md', import.meta.url)

/** 人设 section 的唯一名称。 */
export const ADVISOR_SECTION_NAME = 'dsh-ia:advisor'

/** 人设 section 的排序位（persona 类靠前）。 */
export const ADVISOR_SECTION_ORDER = 100

/**
 * `systemPrompt` 服务所需的最小结构契约（用于类型标注，不引入运行时依赖）。
 */
export interface PromptSectionLike {
  /** 唯一 name。 */
  readonly name: string
  /** 排序位。 */
  readonly order: number
  /** 静态文本或 provider（每次组装求值）。 */
  readonly text: string | ((context: unknown) => string)
  /** 是否插值（默认 true）。 */
  readonly interpolate?: boolean
  /** 是否作为完整系统提示（本插件**不使用**，避免与部署 persona 冲突）。 */
  readonly complete?: boolean
}

/** `systemPrompt` 服务的最小契约。 */
export interface SystemPromptLike {
  section(section: PromptSectionLike): () => void
}

/**
 * 读取 advisor 人设正文（Markdown）。
 *
 * @returns 人设 Markdown 正文。
 * @throws {Error} 文件缺失或不可读（属构建/打包缺陷，应显式暴露）。
 */
export function loadAdvisorMd(): string {
  return readFileSync(ADVISOR_URL, 'utf8')
}

/** 组装 advisor 人设的 `PromptSection`（纯函数，便于单测断言）。 */
export function createAdvisorSection(): PromptSectionLike {
  return {
    name: ADVISOR_SECTION_NAME,
    order: ADVISOR_SECTION_ORDER,
    text: () => loadAdvisorMd(),
  }
}

/**
 * 把 advisor 人设注册到给定的 `systemPrompt` 服务。
 *
 * @param systemPrompt `systemPrompt` 服务（或其最小结构替身）。
 * @returns 注销器（由服务注入层管理生命周期）。
 */
export function registerAdvisorSection(systemPrompt: SystemPromptLike): () => void {
  return systemPrompt.section(createAdvisorSection())
}

/**
 * 在插件上下文中注入 advisor 人设。
 *
 * 通过 `ctx.inject(['systemPrompt'], cb)` **动态声明**对 `systemPrompt` 的依赖
 * （不改顶层 `inject`），服务就绪时回调执行、fiber 卸载时自动注销。
 *
 * @param ctx 插件上下文。
 */
export function applyAdvisorPrompt(ctx: Context): void {
  ctx.inject(['systemPrompt'], (promptCtx) => {
    const systemPrompt = (promptCtx as unknown as { systemPrompt?: SystemPromptLike }).systemPrompt
    if (!systemPrompt || typeof systemPrompt.section !== 'function') {
      promptLog.warn('[dsh-ia] systemPrompt 服务不可用，跳过 advisor 人设注入')
      return
    }
    registerAdvisorSection(systemPrompt)
  })
}
