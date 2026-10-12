/**
 * 运行时配置解析：工作区根目录 + 固定会话 id 的覆盖与默认回落（环境变量方案）。
 *
 * 背景（为何不用启动 flag）：dsh 的 web-app 启动器（`web-startup`）的 commander
 * 为严格模式，会把 `--finance-home` / `--session-id` 当作 unknown option 直接
 * 拒绝并退出进程，而 profile patch 又无法覆盖插件的 apply 行为。故改用**环境变量**
 * 作为隔离开发/测试与正式数据的输入源。
 *
 * 两个可选环境变量：
 *   - `DSH_FINANCE_HOME`：覆盖工作区根目录（默认 `~/.dsh-finance`）。
 *     data/、tasks/、skills/、workspace 归属全部跟随该目录。
 *   - `DSH_FINANCE_SESSION_ID`：覆盖固定会话 id（默认 `investment-advisor`）。
 *     session 持久化文件、唤醒投递目标、开场 notice 目标全部跟随该 id。
 *
 * 优先级：环境变量（非空）> 默认值。
 *
 * 设计约束：
 *   - **叶子模块**：只依赖 `node:os` / `node:path`（不新增第三方包、不接触
 *     dsh/cordis API、不反向依赖 `src/paths.ts`）。`paths.ts` 依赖本模块取 home 值，
 *     避免循环依赖。
 *   - **进程级、幂等读取**：环境变量在模块加载时即可读，getter 每次调用读一次
 *     `process.env`（幂等且简单），无需「apply 时写入状态」这一层。
 *   - **向后兼容**：两个变量都不设置时，行为与现状完全一致（`~/.dsh-finance` +
 *     `investment-advisor`）。既有 `DSH_FINANCE_DATA_DIR`（dataRoot 单独覆盖，见
 *     `src/paths.ts`）行为不受影响。
 */

import { homedir } from 'node:os'
import { resolve } from 'node:path'

/** 环境变量：覆盖整个工作区根目录（默认 `~/.dsh-finance`）。 */
export const FINANCE_HOME_ENV = 'DSH_FINANCE_HOME'

/** 环境变量：覆盖固定会话 id（默认 `investment-advisor`）。 */
export const FINANCE_SESSION_ID_ENV = 'DSH_FINANCE_SESSION_ID'

/** 默认工作区根目录名（位于用户主目录下，`~/.dsh-finance`）。 */
export const DEFAULT_FINANCE_HOME_NAME = '.dsh-finance'

/** 默认固定会话 id（与插件 `name` 一致，`investment-advisor`）。 */
export const DEFAULT_PINNED_SESSION_ID = 'investment-advisor'

/**
 * 运行期工作区根目录：环境变量 `DSH_FINANCE_HOME`（非空，`resolve()` 为绝对路径）
 * > 默认 `~/.dsh-finance`。
 *
 * 纯计算，无副作用（不创建目录）。
 */
export function getFinanceHome(): string {
  const env = process.env[FINANCE_HOME_ENV]
  if (env && env.trim() !== '') return resolve(env.trim())
  return resolve(homedir(), DEFAULT_FINANCE_HOME_NAME)
}

/**
 * 运行期固定会话 id：环境变量 `DSH_FINANCE_SESSION_ID`（非空）> 默认
 * `investment-advisor`。
 */
export function getPinnedSessionId(): string {
  const env = process.env[FINANCE_SESSION_ID_ENV]
  if (env && env.trim() !== '') return env.trim()
  return DEFAULT_PINNED_SESSION_ID
}