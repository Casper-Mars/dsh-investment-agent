/**
 * 统一路径解析模块：workspace 归属目录 + dataRoot 的固定根目录 `~/.dsh-finance`。
 *
 * 背景：插件历史上以 `process.cwd()` 锚定 workspace 归属目录与数据根目录，
 * 导致「从不同目录启动 dsh web → 产生全新 workspace / 数据目录」的漂移问题。
 * 现统一固定到用户主目录下的 `.dsh-finance`：
 *
 *   ~/.dsh-finance                     # workspace 归属目录（会话 cwd）
 *   ~/.dsh-finance/data                # dataRoot（台账 / 策略 / 复盘数据）
 *   ~/.dsh-finance/data/tasks          # 定时任务清单目录
 *
 * `~` 必须经 `os.homedir()` 展开为 fully-qualified 绝对路径（`workspaceRegistry.create`
 * 要求 path 必须是已存在的目录，且拒绝非全限定路径）。
 *
 * 本模块只依赖 `node:os` / `node:path` / `node:fs`，不新增第三方包、不接触 dsh/cordis API。
 */
import { homedir } from 'node:os'
import { join } from 'node:path'
import { mkdirSync } from 'node:fs'

/** 固定根目录名（位于用户主目录下）。 */
export const FINANCE_HOME = '.dsh-finance'

/**
 * 固定根目录的绝对路径：`~/.dsh-finance`（`~` 经 `os.homedir()` 展开）。
 *
 * 纯计算，无副作用（不创建目录）。
 */
export function resolveFinanceHomeDir(): string {
  return join(homedir(), FINANCE_HOME)
}

/**
 * 确保固定根目录存在并返回其绝对路径：`~/.dsh-finance`。
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
 * 默认数据根目录绝对路径：`~/.dsh-finance/data`。
 *
 * 纯计算，无副作用。
 */
export function resolveFinanceDataDir(): string {
  return join(resolveFinanceHomeDir(), 'data')
}

/**
 * 确保默认数据根目录存在并返回其绝对路径：`~/.dsh-finance/data`。
 *
 * `mkdirSync` 幂等创建；`recursive: true` 会连带创建父目录 `~/.dsh-finance`。
 */
export function ensureFinanceDataDir(): string {
  const dir = resolveFinanceDataDir()
  mkdirSync(dir, { recursive: true })
  return dir
}

/**
 * 默认任务清单目录绝对路径：`~/.dsh-finance/data/tasks`。
 *
 * 纯计算，无副作用；目录由 `TaskStore.save` 首次写入时惰性创建。
 */
export function resolveFinanceTasksDir(): string {
  return join(resolveFinanceHomeDir(), 'data', 'tasks')
}