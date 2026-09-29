/**
 * Agent 工具层：感知归档域工具（sense_archive_commit / sense_archive_list /
 * sense_archive_rollback / sense_archive_get）。
 *
 * execute 一律走 domain/sense-registry 的 {@link SenseRegistry}。脚本标的无关，
 * 归档不区分标的（registry 全局唯一）。
 *
 * 字段映射策略：domain meta 驼峰（changeType/rationale），§4.4 契约用下划线
 * （change_type/rationale_extract）。execute 做显式蛇形映射，output.schema 与
 * 返回统一蛇形。
 *
 * 返回形态：写类 commit / rollback 成功返回 `{ ok, ... }`；读类 list / get 返回
 *   无 ok 字段的数据对象（对照 §4.4 契约表）。错误 throw（见 ./error.ts）。
 *
 * 变更类型与 parent 校验（验收点 4）：
 *   - `keep`：不产生新版本（返回沿用 current），无 current 时报错；
 *   - `patch` / `replace`：缺 parent 报错（patch 强制；replace 建议并强制本层校验）；
 *   - parent 给出但不存在时报错。
 *   上述规则 domain 已实现，tools 层兜底信号取消检查，并在返回中带 `is_current`
 *   （commit 后新版本即 current）。
 *
 * exec.signal 可中断：commit / rollback 写操作前检查 signal.aborted，中断即抛出
 *   （不产生半写状态）。domain 版本目录一次写就（不可变），中断发生在写入前即无半写。
 */
import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { ToolContext } from './context.js'
import type { SenseVersionFull, SenseVersionMeta } from '../domain/sense-registry.js'
import type {
  ChangeType,
  SenseArchiveListResult,
  SenseVersionFullView,
  SenseVersionMetaView,
} from './types.js'
import { assertNotAborted, throwToolError } from './error.js'
import {
  senseArchiveCommitResultSchema,
  senseArchiveGetResultSchema,
  senseArchiveListResultSchema,
  senseArchiveRollbackResultSchema,
} from './schemas.js'

/** 推理理由摘要截断长度（避免 schema 承载过长）。 */
const RATIONALE_EXTRACT_LEN = 160

/** 蛇形映射：meta → 版本链元素。 */
function toVersionMetaView(meta: SenseVersionMeta): SenseVersionMetaView {
  const raw = meta.rationale ?? ''
  return {
    version: meta.version,
    change_type: meta.changeType as ChangeType,
    ts: meta.ts,
    rationale_extract:
      raw.length > RATIONALE_EXTRACT_LEN ? `${raw.slice(0, RATIONALE_EXTRACT_LEN)}…` : raw,
  }
}

/** 蛇形映射：full → 全文视图。 */
function toVersionFullView(full: SenseVersionFull): SenseVersionFullView {
  return {
    rationale: full.rationale,
    code: full.code,
    meta: {
      version: full.meta.version,
      change_type: full.meta.changeType as ChangeType,
      parent: full.meta.parent ?? null,
      trigger: full.meta.trigger ?? null,
      ts: full.meta.ts,
    },
  }
}

/** sense_archive_commit：归档新版本。 */
export function createSenseArchiveCommitTool(ctx: ToolContext): ToolDefinition {
  return defineTool({
    name: 'sense_archive_commit',
    description:
      '归档感知脚本的一个新版本。change_type：keep（不产生新版本，沿用 current）/' +
      'patch（补丁，必须带 parent）/ replace（整体替换，需带 parent）。写操作。',
    parameters: {
      change_type: {
        type: 'string',
        enum: ['keep', 'patch', 'replace'],
        required: true,
        description: '变更类型',
      },
      rationale: { type: 'string', required: true, description: '推理理由（写入 rationale.md）' },
      code: { type: 'string', required: true, description: '感知脚本本体（写入 sensor.ts）' },
      parent_version: { type: 'string', description: 'patch/replace 时的父版本号（必填）' },
      trigger: { type: 'string', description: '触发本次调整的前因（可选）' },
    },
    output: {
      schema: senseArchiveCommitResultSchema,
      render: (_args, value) => [
        {
          type: 'text',
          text: `✅ 已归档版本 ${value.version}（current=${value.is_current}）`,
        },
      ],
    },
    async execute(args, exec) {
      assertNotAborted(exec.signal)
      try {
        const changeType = args.change_type as ChangeType
        const version = ctx.senseRegistry.commit({
          changeType,
          rationale: args.rationale,
          code: args.code,
          parent: args.parent_version,
          trigger: args.trigger,
        })
        const cur = ctx.senseRegistry.current()
        return {
          ok: true as const,
          version,
          is_current: cur?.version === version,
        }
      } catch (err) {
        throwToolError(err)
      }
    },
  })
}

/** sense_archive_list：列版本演化链。 */
export function createSenseArchiveListTool(ctx: ToolContext): ToolDefinition {
  return defineTool({
    name: 'sense_archive_list',
    description: '列出感知脚本版本演化链（version / change_type / ts / rationale 摘要）。只读操作。',
    parameters: {},
    output: {
      schema: senseArchiveListResultSchema,
      render: (_args, value) => {
        if (value.versions.length === 0) {
          return [{ type: 'text', text: '无归档版本。' }]
        }
        const lines = value.versions.map(
          (v, i) => `${i + 1}. ${v.version} [${v.change_type}] ${v.ts} — ${v.rationale_extract}`,
        )
        return [{ type: 'text', text: `共 ${value.versions.length} 个版本：\n${lines.join('\n')}` }]
      },
    },
    async execute() {
      const metas = ctx.senseRegistry.list()
      const result: SenseArchiveListResult = {
        versions: metas.map(toVersionMetaView),
      }
      return result
    },
  })
}

/** sense_archive_rollback：current 回指历史版本。 */
export function createSenseArchiveRollbackTool(ctx: ToolContext): ToolDefinition {
  return defineTool({
    name: 'sense_archive_rollback',
    description: '将 current 指针回指到历史版本（版本必须已存在）。写操作。',
    parameters: {
      version: { type: 'string', required: true, description: '目标版本号（vNNN）' },
    },
    output: {
      schema: senseArchiveRollbackResultSchema,
      render: (_args, value) => [
        { type: 'text', text: `✅ 已回滚，当前版本：${value.current}` },
      ],
    },
    async execute(args, exec) {
      assertNotAborted(exec.signal)
      try {
        ctx.senseRegistry.rollback(args.version)
        return { ok: true as const, current: args.version }
      } catch (err) {
        throwToolError(err)
      }
    },
  })
}

/** sense_archive_get：读某一版全文。 */
export function createSenseArchiveGetTool(ctx: ToolContext): ToolDefinition {
  return defineTool({
    name: 'sense_archive_get',
    description: '读取感知脚本某一版本的全文（推理理由 + 脚本本体 + 元数据）。只读操作。',
    parameters: {
      version: { type: 'string', required: true, description: '版本号（vNNN）' },
    },
    output: {
      schema: senseArchiveGetResultSchema,
      render: (_args, value) => [
        {
          type: 'text',
          text:
            `版本：${value.meta.version} [${value.meta.change_type}]\n` +
            `理由：${value.rationale}\n\n代码：\n${value.code}`,
        },
      ],
    },
    async execute(args) {
      const full = ctx.senseRegistry.read(args.version)
      return toVersionFullView(full)
    },
  })
}

export function createSenseArchiveTools(ctx: ToolContext): ToolDefinition[] {
  return [
    createSenseArchiveCommitTool(ctx),
    createSenseArchiveListTool(ctx),
    createSenseArchiveRollbackTool(ctx),
    createSenseArchiveGetTool(ctx),
  ]
}