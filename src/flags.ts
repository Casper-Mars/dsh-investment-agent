/**
 * 运行时配置解析：工作区根目录 + 固定会话 id 的覆盖与默认回落（环境变量方案）。
 *
 * 背景（为何不用启动 flag）：dsh 的 web-app 启动器（`web-startup`）的 commander
 * 为严格模式，会把 `--finance-home` / `--session-id` 当作 unknown option 直接
 * 拒绝并退出进程，而 profile patch 又无法覆盖插件的 apply 行为。故改用**环境变量**
 * 作为隔离开发/测试与正式数据的输入源。
 *
 * 两个可选环境变量：
 *   - `DSH_IA_HOME`：覆盖工作区根目录（默认 `~/.dsh-ia`）。
 *     data/、tasks/、skills/、workspace 归属全部跟随该目录。
 *   - `DSH_IA_SESSION_ID`：覆盖固定会话 id（默认 `investment-advisor`）。
 *     session 持久化文件、唤醒投递目标、开场 notice 目标全部跟随该 id。
 *
 * 优先级：环境变量（非空）> 默认值。
 *
 * 固定会话 id 的特殊策略：显式 `DSH_IA_SESSION_ID` 优先；未显式设置时，若
 * workspace home 被 `DSH_IA_HOME` 覆盖，则从该 home 确定性派生 session id
 * （`investment-advisor-<sha256(home) 前 8 位 hex>`），从而「只设 HOME 即自动隔离
 * session」；home 未覆盖时仍返回默认 `investment-advisor`（向后兼容）。
 *
 * 设计约束：
 *   - **叶子模块**：只依赖 `node:os` / `node:path`（不新增第三方包、不接触
 *     dsh/cordis API、不反向依赖 `src/paths.ts`）。`paths.ts` 依赖本模块取 home 值，
 *     避免循环依赖。
 *   - **进程级、幂等读取**：环境变量在模块加载时即可读，getter 每次调用读一次
 *     `process.env`（幂等且简单），无需「apply 时写入状态」这一层。
 *   - **向后兼容**：两个变量都不设置时，行为与现状完全一致（`~/.dsh-ia` +
 *     `investment-advisor`）。既有 `DSH_IA_DATA_DIR`（dataRoot 单独覆盖，见
 *     `src/paths.ts`）行为不受影响。
 */

import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { resolve } from 'node:path'

/** 环境变量：覆盖整个工作区根目录（默认 `~/.dsh-ia`）。 */
export const FINANCE_HOME_ENV = 'DSH_IA_HOME'

/** 环境变量：覆盖固定会话 id（默认 `investment-advisor`）。 */
export const FINANCE_SESSION_ID_ENV = 'DSH_IA_SESSION_ID'

/** 默认工作区根目录名（位于用户主目录下，`~/.dsh-ia`）。 */
export const DEFAULT_FINANCE_HOME_NAME = '.dsh-ia'

/** 默认固定会话 id（与插件 `name` 一致，`investment-advisor`）。 */
export const DEFAULT_PINNED_SESSION_ID = 'investment-advisor'

/**
 * 派生固定会话 id 的防御性长度上限（字符数）。
 *
 * dsh 的 `SessionId` 是「unvalidated branded string」，理论上无长度限制，且写盘时
 * 会经 `encodeSegment` 转为安全路径段；本上限仅为保护下游任何潜在限制而设，
 * 正常派生结果（`investment-advisor-` + 8 位 hex = 27 字符）远不会触达。
 */
export const MAX_DERIVED_SESSION_ID_LENGTH = 128

/**
 * 运行期工作区根目录：环境变量 `DSH_IA_HOME`（非空，`resolve()` 为绝对路径）
 * > 默认 `~/.dsh-ia`。
 *
 * 纯计算，无副作用（不创建目录）。
 */
export function getFinanceHome(): string {
  const env = process.env[FINANCE_HOME_ENV]
  if (env && env.trim() !== '') return resolve(env.trim())
  return resolve(homedir(), DEFAULT_FINANCE_HOME_NAME)
}

/**
 * 从（已 `resolve()` 规范化的）workspace home 路径确定性派生固定会话 id。
 *
 * 形如 `investment-advisor-<sha256(home) 前 8 位 hex>`；同一 home 路径恒定得到
 * 同一 id（`/tmp/foo` 与 `/tmp/foo/` 经 `resolve()` 归一后一致）。
 *
 * 使用 `node:crypto` 的 `createHash('sha256')`（无第三方依赖），输入为绝对路径，
 * 与随机数无关，保证确定性。最终结果按 `MAX_DERIVED_SESSION_ID_LENGTH` 截断兜底。
 */
function deriveSessionIdFromHome(home: string): string {
  const digest = createHash('sha256').update(home).digest('hex').slice(0, 8)
  const derived = `${DEFAULT_PINNED_SESSION_ID}-${digest}`
  return derived.length > MAX_DERIVED_SESSION_ID_LENGTH
    ? derived.slice(0, MAX_DERIVED_SESSION_ID_LENGTH)
    : derived
}

/**
 * 运行期固定会话 id。优先级：
 *   1. 环境变量 `DSH_IA_SESSION_ID`（非空）→ 返回其 trim 值（最高优先级）。
 *   2. 未覆盖 home（`getFinanceHome()` 等于默认 `~/.dsh-ia`）→ 返回默认
 *      `investment-advisor`（**向后兼容**，默认场景 id 不变，避免正式实例重启
 *      丢失既有会话上下文）。
 *   3. home 被显式覆盖 → 返回从 home 派生的 id
 *      `investment-advisor-<sha256(home) 前 8 位 hex>`，实现「只设
 *      `DSH_IA_HOME` 即自动隔离 session」。
 */
export function getPinnedSessionId(): string {
  const env = process.env[FINANCE_SESSION_ID_ENV]
  if (env && env.trim() !== '') return env.trim()
  const home = getFinanceHome()
  const defaultHome = resolve(homedir(), DEFAULT_FINANCE_HOME_NAME)
  if (home === defaultHome) return DEFAULT_PINNED_SESSION_ID
  return deriveSessionIdFromHome(home)
}
