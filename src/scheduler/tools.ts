/**
 * scheduler/tools.ts —— 定时任务层（感知层）工具：task_create / task_list / task_get /
 * task_update / task_delete / task_enable / task_disable。
 *
 * 唯一权威设计文档：《感知层详细设计（dsh-ia 插件）》 v0.7。
 *
 * 职责：把「定时任务清单」的增删改查暴露为 agent 工具。工具层**不重写持久化**，
 * 数据后端复用 `store.ts` 的 {@link TaskStore}（list/get/save/remove）；写类工具在
 * 落盘后调用 scheduler 的 {@link Scheduler#reload} 使变更即时生效（§7.2「任务变更
 * 即时生效」）。
 *
 * 关键安全约束（对齐 store.ts 与 path-guard.ts）：
 * - `id` 与 `task_path`（以及任何拼入文件路径的外部输入）必须经
 *   {@link assertSafeSegment} 校验，防目录穿越；工具层**复用**该守卫，不自造。
 * - `cron` 在 create/update 时经 {@link parseCron} 校验合法性，非法即抛错（不落盘）。
 *
 * 依赖注入（对齐 types.ts 可注入风格）：工厂 {@link createSchedulerTools} 接收
 * `store` 与 `scheduler`，不写死全局单例，保持可测试。
 *
 * 错误处理（对齐 tools/error.ts 的 {@link throwToolError}）：execute 内所有语义错误
 * （id 不存在 / 路径非法 / cron 非法 / 输入缺字段）一律抛错，不吞语义错误、不返回
 * `{ ok:false }`。
 *
 * 纯 TS，仅依赖 `@deepseek-ai/dsh-tools`（defineTool）+ 本域内 store / scheduler /
 * cron / types / path-guard，不 import dsh/cordis API。
 */
import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { TaskStore } from './store.js'
import type { Scheduler } from './scheduler.js'
import type { TaskDef } from './types.js'
import { parseCron } from './cron.js'
import { assertSafeSegment } from '../domain/path-guard.js'
import { throwToolError } from '../tools/error.js'

// ---------------------------------------------------------------------------
// output.schema（成功返回值严格校验，字段与 execute 返回逐字段对齐）
// ---------------------------------------------------------------------------

/** 单条任务记录（蛇形，镜像 TaskDef）。 */
const taskRecordSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string', required: true, description: '任务唯一标识' },
    name: { type: 'string', required: true, description: '人类可读名称' },
    cron: { type: 'string', required: true, description: 'cron 表达式（5 段，Asia/Shanghai）' },
    task_path: { type: 'string', required: true, description: '任务程序入口文件路径' },
    enabled: { type: 'boolean', required: true, description: '是否启用' },
  },
} as const

/** task_create / task_update / task_enable / task_disable 成功返回：`{ ok, task }`。 */
const taskWriteResultSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean', required: true, description: '是否写库成功（恒 true）' },
    task: { ...taskRecordSchema, required: true } as const,
  },
} as const

/** task_delete 成功返回：`{ ok, id }`。 */
const taskDeleteResultSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean', required: true, description: '是否删除成功' },
    id: { type: 'string', required: true, description: '被删除的任务 id' },
  },
} as const

/** task_list 成功返回：`{ tasks, corrupted }`。 */
const taskListResultSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    tasks: { type: 'array', items: taskRecordSchema, required: true, description: '有效任务清单' },
    corrupted: {
      type: 'array',
      items: { type: 'string' },
      required: true,
      description: '解析失败/结构非法的任务文件名（不含扩展名）',
    },
  },
} as const

/** task_get 成功返回：`{ task }`。 */
const taskGetResultSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    task: { ...taskRecordSchema, required: true } as const,
  },
} as const

// ---------------------------------------------------------------------------
// 内部辅助
// ---------------------------------------------------------------------------

/**
 * 校验并归一单个路径段（外部输入），复用 {@link assertSafeSegment}。
 * 仅用于 `id`（单段标识，如 `market-pulse`）。
 */
function safeSegment(value: unknown, label: string): string {
  return assertSafeSegment(value, label)
}

/**
 * 校验多级相对路径（如 `tasks/market-pulse/task.ts`），并逐段复用
 * {@link assertSafeSegment} 防目录穿越（§2.1 / §3.2 / §10.1 第 4 条）。
 *
 * 语义：`task_path` 是**多级相对路径**，不是单段。逐段校验意味着：
 * - 按 `/` 切分，每个段都必须是合法段（`^[A-Za-z0-9._-]+$`）；
 * - 任一段为 `.` / `..` / 空串 / 含非法字符 → 拒绝（防目录穿越）；
 * - 绝对路径（首段为空，如 `/abs/task.ts`）与 Windows 盘符（`C:\...`）
 *   因段内含 `:` 或空首段 / `\` 字符被拒绝。
 */
function safeTaskPath(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) {
    // 统一走 assertSafeSegment 抛 [path-guard]，保持错误风格一致。
    return assertSafeSegment(value, 'task_path')
  }
  // 拒绝反斜杠（Windows 分隔符），避免跨平台歧义与 `\` 逃过 RE。
  if (value.includes('\\')) {
    throw new Error(`[path-guard] task_path 非法：${JSON.stringify(value)}`)
  }
  const segments = value.split('/')
  const checked = segments.map((seg) => assertSafeSegment(seg, 'task_path'))
  return checked.join('/')
}

/**
 * 校验 cron 表达式合法性（复用 cron.ts 的 parseCron），非法抛 `[cron]` 错误。
 * 通过则原样返回。
 */
function validateCron(expr: unknown): string {
  if (typeof expr !== 'string' || expr.trim() === '') {
    throw new Error('[cron] <空表达式> 非法：cron 必须为非空字符串')
  }
  parseCron(expr) // 仅做校验；非法即抛。
  return expr
}

/** 构造一条 TaskDef（字段已校验），返回不可变记录。 */
function buildTask(args: {
  id: unknown
  name: unknown
  cron: unknown
  task_path: unknown
  enabled: unknown
}): TaskDef {
  if (typeof args.name !== 'string' || args.name.trim() === '') {
    throw new Error('[task] name 非法：必须为非空字符串')
  }
  if (typeof args.enabled !== 'boolean') {
    throw new Error('[task] enabled 非法：必须为 boolean')
  }
  const id = safeSegment(args.id, 'task-id')
  const cron = validateCron(args.cron)
  const taskPath = safeTaskPath(args.task_path)
  return { id, name: args.name, cron, task_path: taskPath, enabled: args.enabled }
}

/** 任务记录 → 暴露给 output.schema 的蛇形对象。 */
function toTaskView(task: TaskDef): {
  id: string
  name: string
  cron: string
  task_path: string
  enabled: boolean
} {
  return {
    id: task.id,
    name: task.name,
    cron: task.cron,
    task_path: task.task_path,
    enabled: task.enabled,
  }
}

// ---------------------------------------------------------------------------
// 工具工厂
// ---------------------------------------------------------------------------

/** 7 个 scheduler 工具的依赖注入配置（对齐可注入风格）。 */
export interface SchedulerToolsOptions {
  /** 任务清单持久化 store（复用 createTaskStore）。 */
  readonly store: TaskStore
  /** 调度引擎（写类工具落盘后调用 reload 即时生效）。 */
  readonly scheduler: Scheduler
}

/** task_create：新建定时任务，落盘 + reload。 */
function createTaskCreateTool(opts: SchedulerToolsOptions): ToolDefinition {
  const { store, scheduler } = opts
  return defineTool({
    name: 'task_create',
    description:
      '新建一条定时任务并立即生效。id 唯一（重复将覆盖）；id 与 task_path 仅允许 ' +
      '[A-Za-z0-9._-] 字符段；cron 为 5 段表达式（分 时 日 月 周，Asia/Shanghai，最小粒度分钟）。' +
      'enabled 缺省为 true（立即参与调度）。写操作。',
    parameters: {
      id: { type: 'string', required: true, description: '任务唯一标识（如 market-pulse）' },
      name: { type: 'string', required: true, description: '人类可读名称' },
      cron: { type: 'string', required: true, description: 'cron 表达式（5 段，Asia/Shanghai）' },
      task_path: { type: 'string', required: true, description: '任务程序入口文件路径（如 tasks/market-pulse/task.ts）' },
      enabled: { type: 'boolean', description: '是否启用（缺省 true）' },
    },
    output: {
      schema: taskWriteResultSchema,
      render: (_args, value) => [
        { type: 'text', text: `✅ 已创建任务 ${value.task.id}（enabled=${value.task.enabled}）` },
      ],
    },
    async execute(args) {
      try {
        const task = buildTask({
          id: args.id,
          name: args.name,
          cron: args.cron,
          task_path: args.task_path,
          enabled: args.enabled ?? true,
        })
        store.save(task)
        scheduler.reload()
        return { ok: true as const, task: toTaskView(task) }
      } catch (err) {
        throwToolError(err)
      }
    },
  })
}

/** task_list：列出全部任务 + 损坏清单。 */
function createTaskListTool(opts: SchedulerToolsOptions): ToolDefinition {
  const { store } = opts
  return defineTool({
    name: 'task_list',
    description: '列出全部已持久化的定时任务（含损坏清单），按 id 升序。只读操作。',
    parameters: {},
    output: {
      schema: taskListResultSchema,
      render: (_args, value) => {
        if (value.tasks.length === 0) {
          const corrupted =
            value.corrupted.length > 0 ? `（另有 ${value.corrupted.length} 个损坏文件）` : ''
          return [{ type: 'text', text: `暂无定时任务。${corrupted}` }]
        }
        const lines = value.tasks.map(
          (t) => `${t.enabled ? '🟢' : '⚪'} ${t.id} — ${t.name} [${t.cron}] → ${t.task_path}`,
        )
        let text = `共 ${value.tasks.length} 个任务：\n${lines.join('\n')}`
        if (value.corrupted.length > 0) {
          text += `\n损坏文件（已跳过）：${value.corrupted.join(', ')}`
        }
        return [{ type: 'text', text }]
      },
    },
    async execute() {
      const { tasks, corrupted } = store.list()
      return { tasks: tasks.map(toTaskView), corrupted }
    },
  })
}

/** task_get：读取单个任务。 */
function createTaskGetTool(opts: SchedulerToolsOptions): ToolDefinition {
  const { store } = opts
  return defineTool({
    name: 'task_get',
    description: '读取单个定时任务。id 不存在时抛错。只读操作。',
    parameters: {
      id: { type: 'string', required: true, description: '任务唯一标识' },
    },
    output: {
      schema: taskGetResultSchema,
      render: (_args, value) => [
        {
          type: 'text',
          text:
            `${value.task.id} — ${value.task.name}\n` +
            `cron: ${value.task.cron}  enabled: ${value.task.enabled}\n` +
            `task_path: ${value.task.task_path}`,
        },
      ],
    },
    async execute(args) {
      try {
        const id = safeSegment(args.id, 'task-id')
        const task = store.get(id)
        if (!task) {
          throw new Error(`[task] 任务 ${id} 不存在`)
        }
        return { task: toTaskView(task) }
      } catch (err) {
        throwToolError(err)
      }
    },
  })
}

/** task_update：更新任务字段（覆盖写全量 TaskDef），落盘 + reload。 */
function createTaskUpdateTool(opts: SchedulerToolsOptions): ToolDefinition {
  const { store, scheduler } = opts
  return defineTool({
    name: 'task_update',
    description:
      '更新一条已有定时任务并立即生效。需提供 id 定位目标，name/cron/task_path 提供新值；' +
      'enabled 缺省保持原值（不传则不动）。目标不存在时抛错。写操作。',
    parameters: {
      id: { type: 'string', required: true, description: '任务唯一标识（定位目标）' },
      name: { type: 'string', description: '新名称（缺省保持原值）' },
      cron: { type: 'string', description: '新 cron 表达式（缺省保持原值）' },
      task_path: { type: 'string', description: '新任务入口路径（缺省保持原值）' },
      enabled: { type: 'boolean', description: '是否启用（缺省保持原值）' },
    },
    output: {
      schema: taskWriteResultSchema,
      render: (_args, value) => [
        { type: 'text', text: `✅ 已更新任务 ${value.task.id}（enabled=${value.task.enabled}）` },
      ],
    },
    async execute(args) {
      try {
        const id = safeSegment(args.id, 'task-id')
        const existing = store.get(id)
        if (!existing) {
          throw new Error(`[task] 任务 ${id} 不存在，无法更新`)
        }
        const task = buildTask({
          id,
          name: args.name ?? existing.name,
          cron: args.cron ?? existing.cron,
          task_path: args.task_path ?? existing.task_path,
          enabled: args.enabled ?? existing.enabled,
        })
        store.save(task)
        scheduler.reload()
        return { ok: true as const, task: toTaskView(task) }
      } catch (err) {
        throwToolError(err)
      }
    },
  })
}

/** task_delete：删除任务，落盘 + reload。 */
function createTaskDeleteTool(opts: SchedulerToolsOptions): ToolDefinition {
  const { store, scheduler } = opts
  return defineTool({
    name: 'task_delete',
    description: '删除一条定时任务并立即生效。id 不存在时抛错。写操作。',
    parameters: {
      id: { type: 'string', required: true, description: '任务唯一标识' },
    },
    output: {
      schema: taskDeleteResultSchema,
      render: (_args, value) => [
        { type: 'text', text: `🗑️ 已删除任务 ${value.id}` },
      ],
    },
    async execute(args) {
      try {
        const id = safeSegment(args.id, 'task-id')
        const removed = store.remove(id)
        if (!removed) {
          throw new Error(`[task] 任务 ${id} 不存在，无法删除`)
        }
        scheduler.reload()
        return { ok: true as const, id }
      } catch (err) {
        throwToolError(err)
      }
    },
  })
}

/** task_enable：启用任务（enabled=true），落盘 + reload。 */
function createTaskEnableTool(opts: SchedulerToolsOptions): ToolDefinition {
  const { store, scheduler } = opts
  return defineTool({
    name: 'task_enable',
    description: '启用一条定时任务（enabled=true）并立即生效。id 不存在时抛错。写操作。',
    parameters: {
      id: { type: 'string', required: true, description: '任务唯一标识' },
    },
    output: {
      schema: taskWriteResultSchema,
      render: (_args, value) => [
        { type: 'text', text: `🟢 已启用任务 ${value.task.id}` },
      ],
    },
    async execute(args) {
      try {
        const id = safeSegment(args.id, 'task-id')
        const existing = store.get(id)
        if (!existing) {
          throw new Error(`[task] 任务 ${id} 不存在，无法启用`)
        }
        const task: TaskDef = { ...existing, enabled: true }
        store.save(task)
        scheduler.reload()
        return { ok: true as const, task: toTaskView(task) }
      } catch (err) {
        throwToolError(err)
      }
    },
  })
}

/** task_disable：禁用任务（enabled=false），落盘 + reload。 */
function createTaskDisableTool(opts: SchedulerToolsOptions): ToolDefinition {
  const { store, scheduler } = opts
  return defineTool({
    name: 'task_disable',
    description: '禁用一条定时任务（enabled=false）并立即生效。id 不存在时抛错。写操作。',
    parameters: {
      id: { type: 'string', required: true, description: '任务唯一标识' },
    },
    output: {
      schema: taskWriteResultSchema,
      render: (_args, value) => [
        { type: 'text', text: `⚪ 已禁用任务 ${value.task.id}` },
      ],
    },
    async execute(args) {
      try {
        const id = safeSegment(args.id, 'task-id')
        const existing = store.get(id)
        if (!existing) {
          throw new Error(`[task] 任务 ${id} 不存在，无法禁用`)
        }
        const task: TaskDef = { ...existing, enabled: false }
        store.save(task)
        scheduler.reload()
        return { ok: true as const, task: toTaskView(task) }
      } catch (err) {
        throwToolError(err)
      }
    },
  })
}

/**
 * 构造 7 个 scheduler 工具（依赖注入 store + scheduler）。
 *
 * @param options store 与 scheduler 实例；写类工具落盘后触发 scheduler.reload()。
 * @returns 按语义顺序排列的工具定义数组。
 */
export function createSchedulerTools(options: SchedulerToolsOptions): ToolDefinition[] {
  return [
    createTaskCreateTool(options),
    createTaskListTool(options),
    createTaskGetTool(options),
    createTaskUpdateTool(options),
    createTaskDeleteTool(options),
    createTaskEnableTool(options),
    createTaskDisableTool(options),
  ]
}