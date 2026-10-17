/**
 * scheduler/store.ts —— 定时任务清单持久化（`assets/tasks/<id>.json`）。
 *
 * 唯一权威设计文档：《感知层详细设计（dsh-ia 插件）》 v0.7。
 *
 * 职责（§2.1 / 持久化）：把「任务清单」持久化在 `assets/tasks/<id>.json`，每条记录是
 * {@link TaskDef}。store 只负责机制的读写，不做调度、不做唤醒判读（那由 runner /
 * scheduler / wake 承担），故此处不出现在任何「定时 → 执行 → 判读」链路里，仅是
 * 一批「读/写任务清单」的纯函数集合。
 *
 * 关键约束：
 * - **数据目录依赖注入**：`tasksDir`（或 `baseDir`）通过工厂参数注入，不写死绝对 /
 *   相对路径。默认值 `~/.dsh-ia/assets/tasks`（经 {@link resolveAssetsTasksDir}
 *   展开，不再锚定 `process.cwd()`），可被覆盖。任务定义属于可分享资产。
 * - **id 防目录穿越**：所有 id 拼入路径前必须经 `assertSafeSegment(id, 'task-id')`
 *   校验（复用 `../domain/path-guard.js`，不自建守卫）。
 * - **损坏文件跳过**：`list()` 遍历目录时，遇到解析失败 / 结构非法的 JSON 跳过并继续，
 *   不中断整体加载、不抛异常。返回「损坏文件名」列表以示区分（静默跳过亦可）。
 * - **save 落盘 + 重启恢复**：save 后磁盘立即可读（同步落盘）；同一 tasksDir 重新
 *   new 一个 store 能读到已保存数据（跨实例恢复）。
 *
 * 纯 TS，仅依赖 `node:fs` / `node:path` / `node:process`，不 import dsh/cordis API。
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import type { TaskDef } from './types.js'
import { assertSafeSegment } from '../domain/path-guard.js'
import { resolveAssetsTasksDir } from '../paths.js'

/** `list()` 的返回结构：有效任务 + 损坏（无法解析为 TaskDef）的文件名清单。 */
export interface TaskListResult {
  /** 解析成功的任务（按 id 升序，稳定顺序）。 */
  readonly tasks: TaskDef[]
  /** 解析失败 / 结构非法的文件名（不含扩展名），供上层诊断，不抛异常。 */
  readonly corrupted: string[]
}

/** 任务清单文件扩展名（不含点）。 */
const TASK_FILE_EXT = '.json'

/** 默认任务清单目录：`~/.dsh-ia/assets/tasks`（固定目录，可被注入覆盖）。 */
export function defaultTasksDir(): string {
  return resolveAssetsTasksDir()
}

/**
 * 校验任务 id 是否可安全用于文件名段，并返回「不带扩展名的文件名骨架」。
 * 复用 {@link assertSafeSegment}，label 固定 `task-id`（沿用 path-guard 的
 * `[path-guard]` 错误风格）。
 */
function safeId(id: string): string {
  return assertSafeSegment(id, 'task-id')
}

/**
 * 判断一个未知对象是否具备 TaskDef 的最小结构。
 *
 * 结构校验（不抛异常）：仅做「字段存在且类型基本吻合」的守卫，确保 list 不会把
 * 结构非法的 JSON 当作有效任务返回。这里不做语义校验（如 cron 表达式合法性），
 * 那属于 loader / scheduler 的职责。
 */
function isTaskDef(value: unknown): value is TaskDef {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  return (
    typeof v.id === 'string' &&
    typeof v.name === 'string' &&
    typeof v.cron === 'string' &&
    typeof v.task_path === 'string' &&
    typeof v.enabled === 'boolean'
  )
}

/**
 * 任务清单持久化 store。
 *
 * 通过工厂函数 {@link createTaskStore} 创建（对齐 types.ts 的 Clock/Timer 可注入风格），
 * 亦可用 `new TaskStore(tasksDir)` 直接构造。dataDir 注入，不写死路径。
 */
export class TaskStore {
  /** 任务清单目录（绝对路径，构造时注入）。 */
  private readonly tasksDir: string

  constructor(tasksDir: string) {
    this.tasksDir = tasksDir
  }

  /** 某任务清单文件的绝对路径。id 为外部输入，先做路径段安全校验。 */
  private filePath(id: string): string {
    return join(this.tasksDir, `${safeId(id)}${TASK_FILE_EXT}`)
  }

  /** 列出所有已持久化任务（稳定顺序：按 id 升序），并归集损坏文件名。 */
  list(): TaskListResult {
    const tasks: TaskDef[] = []
    const corrupted: string[] = []

    if (!existsSync(this.tasksDir)) {
      return { tasks, corrupted }
    }

    let entries: string[]
    try {
      entries = readdirSync(this.tasksDir)
    } catch {
      // 目录不可读：视为无任务，不抛异常。
      return { tasks, corrupted }
    }

    for (const entry of entries) {
      if (!entry.endsWith(TASK_FILE_EXT)) continue
      const stem = entry.slice(0, -TASK_FILE_EXT.length)

      // id 本身非法（例如 `..` 或含 `/` 的文件名）——不该出现在受控目录，
      // 但为稳妥仍旧按损坏处理，跳过而非抛异常。
      let task: TaskDef | undefined
      try {
        const raw = readFileSync(join(this.tasksDir, entry), 'utf8')
        const parsed: unknown = JSON.parse(raw)
        if (isTaskDef(parsed)) task = parsed
      } catch {
        task = undefined
      }

      if (task) {
        tasks.push(task)
      } else {
        corrupted.push(stem)
      }
    }

    tasks.sort((a, b) => a.id.localeCompare(b.id))
    return { tasks, corrupted }
  }

  /** 读取单个任务，不存在或解析失败返回 undefined。 */
  get(id: string): TaskDef | undefined {
    const path = this.filePath(id) // 先做防穿越校验（失败抛 [path-guard] 错误）
    try {
      const raw = readFileSync(path, 'utf8')
      const parsed: unknown = JSON.parse(raw)
      return isTaskDef(parsed) ? parsed : undefined
    } catch {
      return undefined
    }
  }

  /** 写入 / 覆盖单个任务（TaskDef），同步落盘到 `assets/tasks/<id>.json`。 */
  save(task: TaskDef): void {
    const path = this.filePath(task.id)
    mkdirSync(join(this.tasksDir), { recursive: true })
    writeFileSync(path, JSON.stringify(task, null, 2), 'utf8')
  }

  /**
   * 删除单个任务文件。
   * @returns 是否删除成功；文件不存在返回 `false`（不抛错）。
   */
  remove(id: string): boolean {
    const path = this.filePath(id)
    if (!existsSync(path)) return false
    rmSync(path, { force: true })
    return true
  }
}

/**
 * 创建任务清单 store 的工厂函数（无副作用工厂，对齐可注入设计）。
 *
 * @param tasksDir 任务清单目录；省略时使用 {@link defaultTasksDir}。
 * @returns 就绪的 {@link TaskStore} 实例（目录在首次 save 时惰性创建，无需预建）。
 */
export function createTaskStore(tasksDir?: string): TaskStore {
  return new TaskStore(tasksDir ?? defaultTasksDir())
}

export type { TaskDef }