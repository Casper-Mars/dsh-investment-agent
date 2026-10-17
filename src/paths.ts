/**
 * 统一路径解析模块：workspace 归属目录 + dataRoot 的固定根目录 `~/.dsh-ia`。
 *
 * 背景：插件历史上以 `process.cwd()` 锚定 workspace 归属目录与数据根目录，
 * 导致「从不同目录启动 dsh web → 产生全新 workspace / 数据目录」的漂移问题。
 * 现统一固定到用户主目录下的 `.dsh-ia`：
 *
 *   ~/.dsh-ia                     # workspace 归属目录（会话 cwd）
 *   ~/.dsh-ia/assets              # 资产层（可共享、进 git）
 *   ~/.dsh-ia/data                # dataRoot（用户私有运行时数据，如台账）
 *   ~/.dsh-ia/data/tasks          # 定时任务清单目录
 *   ~/.dsh-ia/logs                # 日志层（不进 git）
 *
 * `~` 必须经 `os.homedir()` 展开为 fully-qualified 绝对路径（`workspaceRegistry.create`
 * 要求 path 必须是已存在的目录，且拒绝非全限定路径）。
 *
 * 根目录可经环境变量 `DSH_IA_HOME` 覆盖（见 `src/flags.ts`）；未覆盖时固定到
 * `~/.dsh-ia`。
 *
 * 本模块只依赖 `node:path` / `node:fs` 及同包的 `src/flags.ts`，不新增第三方包、
 * 不接触 dsh/cordis API。
 */
import { join, resolve } from 'node:path'
import { chmodSync, mkdirSync } from 'node:fs'
import { getFinanceHome } from './flags.js'

/** 固定根目录名（位于用户主目录下）。 */
export const FINANCE_HOME = '.dsh-ia'

/**
 * 固定根目录的绝对路径：环境变量 `DSH_IA_HOME`（非空）> 默认
 * `~/.dsh-ia`（`~` 经 `os.homedir()` 展开）。
 *
 * 纯计算，无副作用（不创建目录）。
 */
export function resolveFinanceHomeDir(): string {
  return getFinanceHome()
}

/**
 * 确保固定根目录存在并返回其绝对路径：`~/.dsh-ia`。
 *
 * `mkdirSync(dir, { recursive: true })` 幂等创建（已存在则 no-op）。
 * 这是「workspace 归属」的前置条件：`workspaceRegistry.create(path)` 要求
 * path 为**已存在的目录**，否则 reject。
 */
export function ensureFinanceHomeDir(): string {
  const dir = resolveFinanceHomeDir()
  mkdirSync(dir, { recursive: true })
  return dir
}

/**
 * 默认数据根目录绝对路径：`~/.dsh-ia/data`。
 *
 * 纯计算，无副作用。
 */
export function resolveFinanceDataDir(): string {
  return join(resolveFinanceHomeDir(), 'data')
}

/**
 * 确保默认数据根目录存在并返回其绝对路径：`~/.dsh-ia/data`。
 *
 * `mkdirSync` 幂等创建；`recursive: true` 会连带创建父目录 `~/.dsh-ia`。
 */
export function ensureFinanceDataDir(): string {
  const dir = resolveFinanceDataDir()
  mkdirSync(dir, { recursive: true })
  return dir
}

/**
 * 默认任务清单目录绝对路径：`~/.dsh-ia/data/tasks`。
 *
 * 纯计算，无副作用；目录由 `TaskStore.save` 首次写入时惰性创建。
 */
export function resolveFinanceTasksDir(): string {
  return join(resolveFinanceHomeDir(), 'data', 'tasks')
}

/**
 * 环境变量：覆盖默认数据根目录。
 *
 * 覆盖优先级（由 {@link resolveDataRoot} 落实）：构造注入 > 本环境变量 > 默认值。
 * 定义于此（叶子模块，仅依赖 node:*）以便 skill 资产层等复用同一套解析，
 * 无需向 `src/tools/` 反向依赖；`src/tools/context.ts` 重新导出以保持既有导入路径。
 */
export const DATA_ROOT_ENV = 'DSH_IA_DATA_DIR'

/**
 * 解析数据根目录（**构造注入 > 环境变量 `DSH_IA_DATA_DIR` > 默认值**）。
 *
 * - 显式注入非空字符串 → 以其 `resolve()` 后的绝对路径为准；
 * - 否则取环境变量 `DSH_IA_DATA_DIR`（非空）→ 同样 `resolve()`；
 * - 否则回落到默认值 `~/.dsh-ia/data`（经 {@link ensureFinanceDataDir}
 *   幂等创建目录后返回）。
 *
 * 说明：历史版本曾以 `process.cwd()` 锚定，导致「从不同目录启动 → 全新数据目录」
 * 的漂移问题，已修复为固定到用户主目录。
 *
 * @param explicit 构造注入的 dataRoot（可选）。
 * @returns dataRoot 绝对路径。
 */
export function resolveDataRoot(explicit?: string): string {
  if (explicit && explicit.trim() !== '') return resolve(explicit)
  const env = process.env[DATA_ROOT_ENV]
  if (env && env.trim() !== '') return resolve(env)
  return ensureFinanceDataDir()
}

/**
 * 环境变量：覆盖默认日志目录。
 *
 * 覆盖优先级（由 {@link resolveFinanceLogDir} 落实）：构造注入 > 本环境变量 > 默认值
 * `~/.dsh-ia/logs`。
 */
export const LOG_DIR_ENV = 'DSH_IA_LOG_DIR'

/**
 * 默认日志目录绝对路径：`~/.dsh-ia/logs`（与 `data/` 平级）。
 *
 * 覆盖优先级：**构造注入 > 环境变量 `DSH_IA_LOG_DIR` > 默认值**。
 * 纯计算，无副作用（不创建目录）；目录创建由 {@link ensureFinanceLogDir} 负责。
 *
 * @param explicit 构造注入的日志目录（可选）。
 * @returns 日志目录绝对路径。
 */
export function resolveFinanceLogDir(explicit?: string): string {
  if (explicit && explicit.trim() !== '') return resolve(explicit)
  const env = process.env[LOG_DIR_ENV]
  if (env && env.trim() !== '') return resolve(env)
  return join(resolveFinanceHomeDir(), 'logs')
}

/**
 * 确保日志目录存在并返回其绝对路径（默认 `~/.dsh-ia/logs`）。
 *
 * `mkdirSync(dir, { recursive: true, mode: 0o700 })` 幂等创建（已存在则 no-op）；
 * 因 `mode` 会受进程 umask 影响，创建后再显式 `chmod(dir, 0o700)` 兜底，保证目录
 * 权限严格为 `0o700`（仅属主可读写执行）。
 *
 * @param explicit 构造注入的日志目录（可选）；同 {@link resolveFinanceLogDir}。
 * @returns 日志目录绝对路径。
 */
export function ensureFinanceLogDir(explicit?: string): string {
  const dir = resolveFinanceLogDir(explicit)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  try {
    chmodSync(dir, 0o700)
  } catch {
    /* umask / 平台差异兜底：chmod 失败不致命（mkdir mode 已尽量收紧）。 */
  }
  return dir
}

/**
 * 资产层根目录绝对路径：`~/.dsh-ia/assets`（与 `data/`、`logs/` 平级）。
 *
 * 资产层存放**可共享、可进 git** 的资产（skills / strategies / programs / tasks），
 * 与用户私有的 `data/`（台账等运行时数据）、`logs/` 物理分离，便于整体导出。
 * 路径必须经 {@link resolveFinanceHomeDir} 派生，从而继承 `DSH_IA_HOME` 覆盖语义。
 *
 * 纯计算，无副作用（不创建目录）；目录创建由 {@link ensureAssetsDir} 负责。
 */
export function resolveAssetsDir(): string {
  return join(resolveFinanceHomeDir(), 'assets')
}

/**
 * 确保资产层根目录存在并返回其绝对路径：`~/.dsh-ia/assets`。
 *
 * `mkdirSync(dir, { recursive: true })` 幂等创建（已存在则 no-op）；
 * `recursive: true` 会连带创建父目录 `~/.dsh-ia`。
 */
export function ensureAssetsDir(): string {
  const dir = resolveAssetsDir()
  mkdirSync(dir, { recursive: true })
  return dir
}
