/**
 * 独立测试（t100435 · 复验 A：修订版）—— dsh-ia 文件落地 exporter（里程碑 M2「文件落地」）。
 *
 * 本轮为 **Fix 1（name 白名单）+ Fix 2（测试隔离）** 合并后的复验版本：
 *   - 实现现仅落盘本插件命名空间 `dsh-ia` / `dsh-ia:<scope>`（`DEFAULT_EXPORT_NAMES`，
 *     可经 `options.names` 扩展），`export()` 内**先 `matchesName` 再 `shouldEmit(type)`**；
 *   - 本 spec 已按**新语义**修订：默认消息 `name` 由 `'test'` 改为 `'dsh-ia'`；凡断言
 *     「非本插件 name 也落盘」的旧用例改为「白名单生效 + 反例不落盘」。
 *
 * 与开发者自测 `tests/file-exporter.test.ts` **独立**：本文件不复用其用例 / 辅助函数，
 * 自行构造**真实 cordis `Context`**（真相 `LoggerService`）与对抗性 / 边界输入，
 * 逐条对应任务卡验收标准 AC1–AC10 与观察项 A / B。全程以临时
 * `DSH_IA_LOG_DIR`（+ 临时 `DSH_IA_HOME` / `DSH_IA_DATA_DIR`）隔离，
 * 不污染真实 `~/.dsh-ia/`。
 *
 * 覆盖：
 *   AC1 JSONL 记录形状（含「真实 cordis logger 流经」端到端）
 *   AC2 真实 ctx 装配（真实 Context + apply；console 未兜底；mock 无 logger 降级）
 *   AC3 级别过滤（按 type 而非 cordis 数值 level；env；options 优先；构造期读取）
 *   AC4 按天轮转（跨天 / 同日小阈值 / 超大行 / 预置满文件；无丢行、无死循环）
 *   AC5 权限（umask 对抗；既有宽松目录 / 文件被收敛到 0o700 / 0o600）
 *   AC6 追加注册 / 注销（与宿主既有 exporter 并存、互不影响）
 *   AC7 降级（父路径为文件 / 目标为目录 / 不可写 / 循环引用序列化失败 → export 不抛）
 *   AC8 全量回归（typecheck / build / test，见 REPORT.md，本文件不重复）
 *   AC9 隔离（真实 home 无本 spec 的任何标记；默认目录解析不建目录）
 *   AC10 name 白名单（Fix 1）：裸名 / 子 scope 落盘；host-core/svc/other-plugin/
 *        skill-filesystem/dsh-iax 不落盘；options.names 注入；空数组合并回落默认
 *   AC11 白名单 × 级别叠加：级别仅对白名单命中的消息生效
 *   OBS-A 采集范围：已由 Fix 1 解决（现加白名单，非本插件命名空间不再落盘）
 *   OBS-B 日期口径：文件名取 `message.ts` 的 UTC 日期（本地凌晨会错位）
 */
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context, type Exporter, type Message } from '@deepseek-ai/cordis'
import {
  createFileExporter,
  DEFAULT_EXPORT_NAMES,
  DEFAULT_LOG_MAX_SIZE,
  LOG_MAX_SIZE_ENV,
  resolveLogMaxSize,
} from '../src/log/file-exporter.js'
import { LEVEL_RANK, LOG_LEVEL_ENV } from '../src/log/logger.js'
import { LOG_DIR_ENV, resolveFinanceLogDir } from '../src/paths.js'
import { apply } from '../src/plugin.js'

// ===========================================================================
// 基础设施（自建，不复用开发者用例）
// ===========================================================================

/** 固定时间点（UTC）：2026-10-12T12:00:00Z。 */
const T_DAY1 = Date.UTC(2026, 9, 12, 12, 0, 0)
/** 固定时间点（UTC）：2026-10-13T12:00:00Z（跨天）。 */
const T_DAY2 = Date.UTC(2026, 9, 13, 12, 0, 0)
/** 上海本地「次日凌晨」：2026-10-12T16:30Z === 本地 2026-10-13 00:30（+08:00）。 */
const T_LOCAL_NEXT_DAY = Date.UTC(2026, 9, 12, 16, 30, 0)

/** epoch ms → UTC `YYYY-MM-DD`（与实现口径一致的独立推算）。 */
const utcDate = (ts: number): string => new Date(ts).toISOString().slice(0, 10)

/**
 * 构造一条 cordis `Message`（仅覆盖本任务关心的字段，其余给默认）。
 *
 * **新语义（Fix 1）**：默认 `name` 取本插件命名空间 `'dsh-ia'`（白名单命中），
 * 使默认用例可直接落盘；需要断言白名单边界时显式传其它 `name`。
 */
function msg(partial: Partial<Message> & Pick<Message, 'type'>): Message {
  return { sn: 1, ts: T_DAY1, name: 'dsh-ia', level: 0, args: [], ...partial }
}

/** 读取某目录下某文件为 JSONL 记录数组（忽略空行）。 */
function readJsonl(dir: string, name: string): Array<Record<string, unknown>> {
  return readFileSync(join(dir, name), 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as Record<string, unknown>)
}

/** 目录下全部文件的行数之和（用于「行不丢」守恒断言）。 */
function totalLines(dir: string): number {
  let n = 0
  for (const f of readdirSync(dir)) {
    const st = statSync(join(dir, f))
    if (!st.isFile()) continue
    n += readFileSync(join(dir, f), 'utf8').split('\n').filter((l) => l.trim() !== '').length
  }
  return n
}

/** 目录下全部文件内容拼接（用于包含性断言）。 */
function readAll(dir: string): string {
  let out = ''
  for (const f of readdirSync(dir)) {
    const p = join(dir, f)
    if (statSync(p).isFile()) out += readFileSync(p, 'utf8')
  }
  return out
}

/** 临时目录登记（afterEach 统一清理）。 */
const tmpDirs: string[] = []
function mkTmp(prefix = 'dsh-fin-t100435-'): string {
  const d = mkdtempSync(join(tmpdir(), prefix))
  tmpDirs.push(d)
  return d
}

/** 权限位（去类型位）。 */
const perms = (p: string): number => statSync(p).mode & 0o777

/** 本 spec 唯一标记（用于 AC9 断言真实 home 未被本 spec 触碰）。 */
const ISOLATION_MARKER = `T100435-MARKER-${Math.random().toString(36).slice(2)}`

// ---- 环境变量快照 / 还原 ------------------------------------------------
const ENV_KEYS = [
  LOG_DIR_ENV,
  LOG_LEVEL_ENV,
  LOG_MAX_SIZE_ENV,
  'DSH_IA_HOME',
  'DSH_IA_DATA_DIR',
  'DSH_IA_SESSION_ID',
] as const
let savedEnv: Record<string, string | undefined> = {}
let savedUmask = 0o022

beforeEach(() => {
  savedEnv = {}
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k]
    delete process.env[k]
  }
  savedUmask = process.umask()
})

afterEach(() => {
  vi.restoreAllMocks()
  for (const k of ENV_KEYS) {
    const v = savedEnv[k]
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  process.umask(savedUmask)
  for (const d of tmpDirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  }
})

// ===========================================================================
// AC1 · JSONL 记录形状
// ===========================================================================
describe('AC1 JSONL 记录形状（§4.2）', () => {
  it('AC1-1 真实 cordis logger 流经 exporter：ts/level/name/msg/pid/origin 全部正确', () => {
    const dir = mkTmp()
    const app = new Context()
    app.logger.exporter(createFileExporter({ dir, level: 'debug' }))

    // 经**真实** LoggerService 的命名 logger 投递（不是自造 Message）。
    app.logger('dsh-ia:demo').info('会话已确保', { id: 'sess-1' })

    const files = readdirSync(dir)
    expect(files).toHaveLength(1)
    expect(files[0]).toBe(`${utcDate(Date.now())}.jsonl`)

    const recs = readJsonl(dir, files[0])
    expect(recs).toHaveLength(1)
    const r = recs[0]
    // ts：合法 ISO 8601（UTC，Z 结尾），且可被 Date 反解析为近似当前时刻。
    expect(typeof r.ts).toBe('string')
    expect(String(r.ts)).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
    expect(Math.abs(new Date(String(r.ts)).getTime() - Date.now())).toBeLessThan(10_000)
    expect(r.level).toBe('info')
    expect(r.name).toBe('dsh-ia:demo')
    expect(r.msg).toBe('会话已确保')
    // meta 作为结构化 args 落地。
    expect(r.args).toEqual({ id: 'sess-1' })
    expect(r.pid).toBe(process.pid)
    expect(r.origin).toBe('host')
  })

  it('AC1-2 ts 与 message.ts 严格对应（ISO），文件名日期与 ts 同日（UTC）', () => {
    const dir = mkTmp()
    const exporter = createFileExporter({ dir, level: 'debug' })
    exporter.export(msg({ ts: T_DAY1, type: 'info', args: ['a'] }))
    exporter.export(msg({ ts: T_DAY2, type: 'info', args: ['b'] }))
    expect(readJsonl(dir, '2026-10-12.jsonl')[0].ts).toBe('2026-10-12T12:00:00.000Z')
    expect(readJsonl(dir, '2026-10-13.jsonl')[0].ts).toBe('2026-10-13T12:00:00.000Z')
  })

  it('AC1-3 printf 展开：%s/%d/%i/%f 按序消费；对象参数并入 args', () => {
    const dir = mkTmp()
    const exporter = createFileExporter({ dir, level: 'debug' })
    exporter.export(msg({ type: 'info', args: ['n=%d s=%s f=%f', 7, 'x', 2.5, { k: 1 }] }))
    const r = readJsonl(dir, '2026-10-12.jsonl')[0]
    expect(r.msg).toBe('n=7 s=x f=2.5')
    expect(r.args).toEqual({ k: 1 })
  })

  it('AC1-4 结构化 meta 浅合并（后者覆盖前者）；空 meta 不产生 args 字段', () => {
    const dir = mkTmp()
    const exporter = createFileExporter({ dir, level: 'debug' })
    exporter.export(msg({ type: 'info', args: ['m', { a: 1, x: 1 }, { b: 2, x: 9 }] }))
    exporter.export(msg({ type: 'info', args: ['plain'] }))
    const r = readJsonl(dir, '2026-10-12.jsonl')
    expect(r[0].args).toEqual({ a: 1, b: 2, x: 9 })
    expect(r[1]).not.toHaveProperty('args')
  })

  it('AC1-5 Error 首参：msg 取 stack/message', () => {
    const dir = mkTmp()
    const exporter = createFileExporter({ dir, level: 'debug' })
    exporter.export(msg({ type: 'error', args: [new Error('kaboom')] }))
    const r = readJsonl(dir, '2026-10-12.jsonl')[0]
    expect(String(r.msg)).toContain('kaboom')
    expect(r.level).toBe('error')
  })

  it('AC1-6 每条记录为单行合法 JSON（strict parse 全部通过）', () => {
    const dir = mkTmp()
    const exporter = createFileExporter({ dir, level: 'debug' })
    for (let i = 0; i < 5; i += 1) exporter.export(msg({ type: 'info', args: [`line ${i}`] }))
    const raw = readFileSync(join(dir, '2026-10-12.jsonl'), 'utf8')
    const lines = raw.split('\n').filter((l) => l !== '')
    expect(lines).toHaveLength(5)
    for (const l of lines) expect(() => JSON.parse(l)).not.toThrow()
  })
})

// ===========================================================================
// AC2 · 真实 ctx 装配（关键）
// ===========================================================================
describe('AC2 真实 ctx 装配（真实 cordis Context + apply）', () => {
  it('AC2-1 真实 Context 跑 apply：插件加载日志落入 DSH_IA_LOG_DIR 当日文件', () => {
    const home = mkTmp('dsh-fin-home-')
    const logDir = join(home, 'logs')
    process.env.DSH_IA_HOME = home
    process.env.DSH_IA_DATA_DIR = join(home, 'data')
    process.env[LOG_DIR_ENV] = logDir

    const app = new Context()
    // 真实 Context：ctx.logger(LoggerService) / effect / inject / plugin 齐全。
    expect(typeof app.logger).toBe('function')
    expect(typeof app.logger.exporter).toBe('function')

    expect(() => apply(app)).not.toThrow()

    expect(existsSync(logDir)).toBe(true)
    const content = readAll(logDir)
    expect(content).toContain('插件加载')
    expect(content).toContain('name=investment-advisor')
    expect(content).toContain(`"pid":${process.pid}`)
    expect(content).toContain('"origin":"host"')

    const files = readdirSync(logDir)
    expect(files.every((f) => f === `${utcDate(Date.now())}.jsonl`)).toBe(true)
  })

  it('AC2-2 非 console 兜底：apply 期间「插件加载」只进文件，不进 console', () => {
    const home = mkTmp('dsh-fin-home-')
    const logDir = join(home, 'logs')
    process.env.DSH_IA_HOME = home
    process.env.DSH_IA_DATA_DIR = join(home, 'data')
    process.env[LOG_DIR_ENV] = logDir

    const seen: string[] = []
    for (const m of ['log', 'warn', 'error', 'info', 'debug'] as const) {
      vi.spyOn(console, m).mockImplementation((...a: unknown[]) => {
        seen.push(a.map((x) => String(x)).join(' '))
      })
    }

    const app = new Context()
    apply(app)

    expect(readAll(logDir)).toContain('插件加载')
    expect(seen.some((s) => s.includes('插件加载'))).toBe(false)
  })

  it('AC2-3 mock ctx（无 logger）：降级不抛、不写盘', () => {
    const logDir = join(mkTmp('dsh-fin-home-'), 'logs')
    process.env.DSH_IA_HOME = logDir.replace(/\/logs$/, '')
    process.env.DSH_IA_DATA_DIR = join(logDir.replace(/\/logs$/, ''), 'data')
    process.env[LOG_DIR_ENV] = logDir

    const seen: string[] = []
    vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
      seen.push(a.map((x) => String(x)).join(' '))
    })
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})

    // 无 `logger` 字段的 mock ctx（降级路径）。
    const mockCtx = {
      effect(fn: () => unknown) {
        const out = fn()
        return typeof out === 'function' ? out : () => {}
      },
      get() {
        return undefined
      },
      inject() {
        /* systemPrompt 未就绪：不回调 */
      },
    }

    expect(() => apply(mockCtx as never)).not.toThrow()
    // 无 native logger → 无文件 exporter 注册 → 不落盘（目录未被创建）。
    expect(existsSync(logDir)).toBe(false)
    // 降级实现走 console（证明是门面兜底而非文件）。
    expect(seen.some((s) => s.includes('插件加载'))).toBe(true)
  })
})

// ===========================================================================
// AC3 · 级别过滤（按 type 的方案严重度序）
// ===========================================================================
describe('AC3 级别过滤（按 type 而非 cordis 数值 level）', () => {
  /** 用真实命名 logger 依次投递四级，返回文件中的 level 序列（name 走白名单内 scope）。 */
  function viaRealLogger(level?: string): string[] {
    const dir = mkTmp()
    const app = new Context()
    app.logger.exporter(createFileExporter({ dir, level }))
    const lg = app.logger('dsh-ia')
    lg.error('E')
    lg.warn('W')
    lg.info('I')
    lg.debug('D')
    const files = readdirSync(dir)
    return files.length === 0 ? [] : readJsonl(dir, files[0]).map((r) => String(r.level))
  }

  it('AC3-1 默认 info：{error,warn,info} 落盘、debug 丢弃（warn 未被数值序弄丢）', () => {
    expect(viaRealLogger()).toEqual(['error', 'warn', 'info'])
  })

  it('AC3-2 env error / warn / debug 按方案严重度序正确', () => {
    process.env[LOG_LEVEL_ENV] = 'error'
    expect(viaRealLogger()).toEqual(['error'])
    process.env[LOG_LEVEL_ENV] = 'warn'
    expect(viaRealLogger()).toEqual(['error', 'warn'])
    process.env[LOG_LEVEL_ENV] = 'debug'
    expect(viaRealLogger()).toEqual(['error', 'warn', 'info', 'debug'])
  })

  it('AC3-3 options.level 显式优先于 env', () => {
    process.env[LOG_LEVEL_ENV] = 'error'
    expect(viaRealLogger('debug')).toEqual(['error', 'warn', 'info', 'debug'])
  })

  it('AC3-4 关键：过滤依据是 type，与 cordis 数值 level 无关（不一致输入）', () => {
    const dir = mkTmp()
    // 阈值 warn（rank=1）。
    const exporter = createFileExporter({ dir, level: 'warn' })
    // type=info（rank2 > 1 → 应丢）但数值 level=0（若按数值过滤会被保留）。
    exporter.export(msg({ type: 'info', level: 0, args: ['numeric-trap-should-drop'] }))
    // type=error（rank0 ≤ 1 → 应留）但数值 level=3（若按数值过滤会被丢弃）。
    exporter.export(msg({ type: 'error', level: 3, args: ['numeric-trap-should-keep'] }))
    const r = readJsonl(dir, '2026-10-12.jsonl')
    expect(r.map((x) => x.level)).toEqual(['error'])
    expect(String(r[0].msg)).toBe('numeric-trap-should-keep')
  })

  it('AC3-5 LEVEL_RANK 表：error0<warn1<info2<debug3（方案口径，非 cordis 数值序）', () => {
    expect(LEVEL_RANK).toEqual({ error: 0, warn: 1, info: 2, debug: 3 })
  })

  it('AC3-6 阈值在构造期解析：构造后改 env 不影响已建实例', () => {
    const dir = mkTmp()
    process.env[LOG_LEVEL_ENV] = 'debug'
    const exporter = createFileExporter({ dir }) // 构造期读 debug
    process.env[LOG_LEVEL_ENV] = 'error' // 事后改为 error
    exporter.export(msg({ type: 'info', args: ['kept'] }))
    // 仍按构造期 debug 放行 → info 落盘。
    expect(readJsonl(dir, '2026-10-12.jsonl')[0].msg).toBe('kept')
  })
})

// ===========================================================================
// AC4 · 按天轮转 + 同日超阈值后缀
// ===========================================================================
describe('AC4 按天轮转 / 超阈值后缀', () => {
  it('AC4-1 跨天（伪造 message.ts）→ 不同日期文件，各行归属正确', () => {
    const dir = mkTmp()
    const exporter = createFileExporter({ dir, level: 'debug' })
    exporter.export(msg({ ts: T_DAY1, type: 'info', args: ['d1'] }))
    exporter.export(msg({ ts: T_DAY2, type: 'info', args: ['d2'] }))
    expect(readdirSync(dir).sort()).toEqual(['2026-10-12.jsonl', '2026-10-13.jsonl'])
    expect(readJsonl(dir, '2026-10-12.jsonl')[0].msg).toBe('d1')
    expect(readJsonl(dir, '2026-10-13.jsonl')[0].msg).toBe('d2')
  })

  it('AC4-2 同日超小阈值 → -1/-2 后缀；行不丢、无死循环', () => {
    const dir = mkTmp()
    const maxSize = 200
    const exporter = createFileExporter({ dir, maxSize, level: 'debug' })
    const N = 25
    for (let i = 0; i < N; i += 1) {
      exporter.export(msg({ type: 'info', args: [`l${i}-${'x'.repeat(40)}`] }))
    }
    const files = readdirSync(dir)
    expect(files).toContain('2026-10-12.jsonl')
    expect(files.some((f) => f.startsWith('2026-10-12-'))).toBe(true)
    // 行守恒（无丢行）。
    expect(totalLines(dir)).toBe(N)
    // 除至多 1 个封口文件外，其余文件均已达阈值。
    const notFull = files
      .map((f) => statSync(join(dir, f)).size)
      .filter((s) => s < maxSize)
    expect(notFull.length).toBeLessThanOrEqual(1)
  })

  it('AC4-3 单行 > 阈值（maxSize=1）：每行独立成文件，无死循环、行不丢', () => {
    const dir = mkTmp()
    const exporter = createFileExporter({ dir, maxSize: 1, level: 'debug' })
    exporter.export(msg({ type: 'info', args: ['a'] }))
    exporter.export(msg({ type: 'info', args: ['b'] }))
    exporter.export(msg({ type: 'info', args: ['c'] }))
    expect(readdirSync(dir).sort()).toEqual([
      '2026-10-12-1.jsonl',
      '2026-10-12-2.jsonl',
      '2026-10-12.jsonl',
    ])
    expect(totalLines(dir)).toBe(3)
  })

  it('AC4-4 预置「已满」文件 → 首条即轮转到 -1', () => {
    const dir = mkTmp()
    // 预先写一个已达阈值的当日文件。
    writeFileSync(join(dir, '2026-10-12.jsonl'), 'x'.repeat(500))
    const exporter = createFileExporter({ dir, maxSize: 300, level: 'debug' })
    exporter.export(msg({ type: 'info', args: ['rotated'] }))
    expect(existsSync(join(dir, '2026-10-12-1.jsonl'))).toBe(true)
    expect(readJsonl(dir, '2026-10-12-1.jsonl')[0].msg).toBe('rotated')
    // 原文件未被追加（保持 500 字节）。
    expect(statSync(join(dir, '2026-10-12.jsonl')).size).toBe(500)
  })
})

// ===========================================================================
// AC5 · 权限
// ===========================================================================
describe('AC5 权限（0o700 / 0o600）', () => {
  it('AC5-1 正常创建：目录 0o700、文件 0o600（宽松 umask 下仍严格）', () => {
    const dir = join(mkTmp(), 'logs')
    const exporter = createFileExporter({ dir, level: 'debug' })
    exporter.export(msg({ type: 'info', args: ['p'] }))
    expect(perms(dir)).toBe(0o700)
    expect(perms(join(dir, '2026-10-12.jsonl'))).toBe(0o600)
  })

  it('AC5-2 umask=0o000 干扰下仍为 0o700 / 0o600', () => {
    process.umask(0o000)
    const dir = join(mkTmp(), 'logs')
    const exporter = createFileExporter({ dir, level: 'debug' })
    exporter.export(msg({ type: 'info', args: ['p'] }))
    expect(perms(dir)).toBe(0o700)
    expect(perms(join(dir, '2026-10-12.jsonl'))).toBe(0o600)
  })

  it('AC5-3 chmod 兜底：既有宽松目录(0o755)/文件(0o644) 被收敛到 0o700 / 0o600', () => {
    const dir = join(mkTmp(), 'logs')
    mkdirSync(dir, { recursive: true, mode: 0o755 })
    const file = join(dir, '2026-10-12.jsonl')
    writeFileSync(file, '') // 预置文件，默认 umask 下多为 0o644
    const exporter = createFileExporter({ dir, level: 'debug' })
    exporter.export(msg({ type: 'info', args: ['p'] }))
    expect(perms(dir)).toBe(0o700)
    expect(perms(file)).toBe(0o600)
  })
})

// ===========================================================================
// AC6 · 追加注册 / 注销
// ===========================================================================
describe('AC6 追加注册 / 注销（共享 LoggerService）', () => {
  it('AC6-1 宿主既有 exporter 与文件 exporter 同时收到，互不干扰', () => {
    const dir = mkTmp()
    const app = new Context()
    const captured: Message[] = []
    const host: Exporter = { levels: { default: 3 }, export: (m) => captured.push(m) }
    app.logger.exporter(host)
    app.logger.exporter(createFileExporter({ dir, level: 'debug' }))

    // 白名单内 name（Fix 1：宿主的**文件 exporter** 只接本插件命名空间）。
    app.logger('dsh-ia:svc').info('both')
    expect(captured.map((m) => m.args[0])).toEqual(['both'])
    expect(readAll(dir)).toContain('both')
  })

  it('AC6-2 dispose 文件 exporter：宿主 exporter 不受影响，文件不再增长', () => {
    const dir = mkTmp()
    const app = new Context()
    const captured: Message[] = []
    const host: Exporter = { levels: { default: 3 }, export: (m) => captured.push(m) }
    app.logger.exporter(host)
    const disposeFile = app.logger.exporter(createFileExporter({ dir, level: 'debug' }))

    app.logger('dsh-ia:svc').info('one')
    const before = readAll(dir)

    disposeFile()
    app.logger('dsh-ia:svc').info('after')
    expect(readAll(dir)).toBe(before) // 文件未变
    expect(captured.map((m) => m.args[0])).toEqual(['one', 'after']) // 宿主照收
  })

  it('AC6-3 dispose 宿主 exporter：文件 exporter 不受影响', () => {
    const dir = mkTmp()
    const app = new Context()
    const captured: Message[] = []
    const host: Exporter = { levels: { default: 3 }, export: (m) => captured.push(m) }
    const disposeHost = app.logger.exporter(host)
    app.logger.exporter(createFileExporter({ dir, level: 'debug' }))

    disposeHost()
    app.logger('dsh-ia:svc').info('file-only')
    expect(captured).toHaveLength(0)
    expect(readAll(dir)).toContain('file-only')
  })
})

// ===========================================================================
// AC7 · 降级（不抛、不中断）
// ===========================================================================
describe('AC7 降级（export 不抛）', () => {
  it('AC7-1 目录父路径是文件（ENOTDIR）→ 不抛', () => {
    const base = mkTmp()
    const asFile = join(base, 'f')
    writeFileSync(asFile, 'x')
    const exporter = createFileExporter({ dir: join(asFile, 'logs'), level: 'debug' })
    expect(() => exporter.export(msg({ type: 'info', args: ['boom'] }))).not.toThrow()
  })

  it('AC7-2 目标文件名是目录（EISDIR）→ 不抛', () => {
    const dir = mkTmp()
    mkdirSync(join(dir, '2026-10-12.jsonl'))
    const exporter = createFileExporter({ dir, level: 'debug' })
    expect(() => exporter.export(msg({ type: 'info', args: ['boom'] }))).not.toThrow()
  })

  it('AC7-3 日志目录不可写（0o500）→ 不抛', () => {
    const dir = join(mkTmp(), 'logs')
    mkdirSync(dir, { recursive: true })
    const exporter = createFileExporter({ dir, level: 'debug' })
    // 先正常写一次以确保路径逻辑就绪，再收紧为只读。
    exporter.export(msg({ type: 'info', args: ['ok'] }))
    process.umask(0o000)
    // 直接 chmod 收紧（用 fs 而非 exporter 私有方法）。
    chmodSync(dir, 0o500)
    try {
      expect(() => exporter.export(msg({ type: 'info', args: ['boom'] }))).not.toThrow()
    } finally {
      chmodSync(dir, 0o700)
    }
  })

  it('AC7-4 循环引用 meta（JSON.stringify 抛错）→ 不抛（该行静默丢弃）', () => {
    const dir = mkTmp()
    const exporter = createFileExporter({ dir, level: 'debug' })
    const circular: Record<string, unknown> = { a: 1 }
    circular.self = circular
    expect(() => exporter.export(msg({ type: 'info', args: ['m', circular] }))).not.toThrow()
  })

  it('AC7-5 降级不影响后续正常写入（同一实例自愈）', () => {
    const dir = mkTmp()
    const exporter = createFileExporter({ dir, level: 'debug' })
    const circular: Record<string, unknown> = {}
    circular.self = circular
    exporter.export(msg({ type: 'info', args: ['bad', circular] })) // 丢弃
    exporter.export(msg({ type: 'info', args: ['good'] })) // 正常
    expect(readAll(dir)).toContain('good')
    expect(readAll(dir)).not.toContain('bad')
  })
})

// ===========================================================================
// AC9 · 隔离（不污染真实 ~/.dsh-ia；默认目录解析不建目录）
// ===========================================================================
describe('AC9 隔离', () => {
  it('AC9-1 本 spec 的标记未写入真实 ~/.dsh-ia/logs', () => {
    const home = mkTmp('dsh-fin-home-')
    const logDir = join(home, 'logs')
    process.env.DSH_IA_HOME = home
    process.env.DSH_IA_DATA_DIR = join(home, 'data')
    process.env[LOG_DIR_ENV] = logDir

    const app = new Context()
    app.logger.exporter(createFileExporter({ dir: logDir, level: 'debug' }))
    app.logger('dsh-ia').info(`${ISOLATION_MARKER} hello`)

    expect(readAll(logDir)).toContain(ISOLATION_MARKER)

    const realLogs = join(homedir(), '.dsh-ia', 'logs')
    const real = existsSync(realLogs) ? readAll(realLogs) : ''
    expect(real).not.toContain(ISOLATION_MARKER)
  })

  it('AC9-2 默认目录解析为 ~/.dsh-ia/logs 且为纯计算（不创建目录）', () => {
    const realLogs = join(homedir(), '.dsh-ia', 'logs')
    const existedBefore = existsSync(realLogs)
    expect(resolveFinanceLogDir()).toBe(realLogs)
    expect(existsSync(realLogs)).toBe(existedBefore) // 解析不产生副作用
  })

  it('AC9-3 生产代码未被本 spec 修改（REPORT 约定：仅新增测试）', () => {
    // 断言被测源码文件存在且导出工厂（轻量存在性检查，非内容快照）。
    expect(typeof createFileExporter).toBe('function')
    expect(DEFAULT_LOG_MAX_SIZE).toBe(50 * 1024 * 1024)
  })
})

// ===========================================================================
// AC10 · name 白名单（Fix 1）
// ===========================================================================
describe('AC10 name 白名单（仅 dsh-ia[:scope] 落盘）', () => {
  it('AC10-1 裸名 `dsh-ia` 与子 scope `dsh-ia:<x>` 均落盘（含子级 child scope）', () => {
    const dir = mkTmp()
    const exporter = createFileExporter({ dir, level: 'debug' })
    exporter.export(msg({ type: 'info', name: 'dsh-ia', args: ['bare'] }))
    exporter.export(msg({ type: 'info', name: 'dsh-ia:tools', args: ['c1'] }))
    exporter.export(msg({ type: 'info', name: 'dsh-ia:scheduler:runner', args: ['c2'] }))
    const recs = readJsonl(dir, '2026-10-12.jsonl')
    expect(recs.map((r) => r.msg)).toEqual(['bare', 'c1', 'c2'])
    expect(recs.map((r) => r.name)).toEqual([
      'dsh-ia',
      'dsh-ia:tools',
      'dsh-ia:scheduler:runner',
    ])
  })

  it('AC10-2 反例：host-core / svc / other-plugin / skill-filesystem / 空名 一律不落盘', () => {
    const dir = mkTmp()
    const exporter = createFileExporter({ dir, level: 'debug' })
    for (const name of ['host-core', 'svc', 'other-plugin', 'other-plugin:sub', 'skill-filesystem', '']) {
      exporter.export(msg({ type: 'error', name, args: [`from-${name}`] }))
    }
    // 目录内不存在任何文件（连目录都不必创建 —— resolveTargetPath 先算路径再 ensureDir）。
    expect(readdirSync(dir)).toEqual([])
    expect(existsSync(join(dir, '2026-10-12.jsonl'))).toBe(false)
  })

  it('AC10-3 边界：`dsh-iax`（前缀但非 `:` 分隔）/ `dsh-ia-x` 不落盘', () => {
    const dir = mkTmp()
    const exporter = createFileExporter({ dir, level: 'debug' })
    exporter.export(msg({ type: 'info', name: 'dsh-iax', args: ['no'] }))
    exporter.export(msg({ type: 'info', name: 'dsh-ia-x', args: ['no2'] }))
    exporter.export(msg({ type: 'info', name: 'dsh', args: ['no3'] }))
    expect(readdirSync(dir)).toEqual([])
    expect(existsSync(join(dir, '2026-10-12.jsonl'))).toBe(false)
  })

  it('AC10-4 真实 ctx：白名单内落盘、白名单外丢弃（同一 LoggerService 上并存）', () => {
    const dir = mkTmp()
    const app = new Context()
    app.logger.exporter(createFileExporter({ dir, level: 'debug' }))
    app.logger('dsh-ia').info('mine')
    app.logger('dsh-ia:scheduler').warn('mine-sub')
    app.logger('host-core').error('not-mine')
    app.logger('skill-filesystem').error('not-mine-2')

    const files = readdirSync(dir)
    expect(files).toEqual([`${utcDate(Date.now())}.jsonl`])
    const recs = readJsonl(dir, files[0])
    expect(recs.map((r) => r.name)).toEqual(['dsh-ia', 'dsh-ia:scheduler'])
    expect(recs.map((r) => r.msg)).toEqual(['mine', 'mine-sub'])
  })

  it('AC10-5 options.names 注入：自定义前缀生效，原默认前缀不再匹配', () => {
    const dir = mkTmp()
    const exporter = createFileExporter({ dir, level: 'debug', names: ['my-plugin'] })
    exporter.export(msg({ type: 'info', name: 'my-plugin:svc', args: ['yes'] }))
    exporter.export(msg({ type: 'info', name: 'dsh-ia', args: ['no'] }))
    expect(readJsonl(dir, '2026-10-12.jsonl').map((r) => r.msg)).toEqual(['yes'])
  })

  it('AC10-6 options.names 多前缀注入：可扩展多个命名空间', () => {
    const dir = mkTmp()
    const exporter = createFileExporter({ dir, level: 'debug', names: ['dsh-ia', 'extra'] })
    exporter.export(msg({ type: 'info', name: 'dsh-ia:a', args: ['a'] }))
    exporter.export(msg({ type: 'info', name: 'extra', args: ['b'] }))
    exporter.export(msg({ type: 'info', name: 'other', args: ['c'] }))
    expect(readJsonl(dir, '2026-10-12.jsonl').map((r) => r.msg)).toEqual(['a', 'b'])
  })

  it('AC10-7 options.names 空数组 / 全空白 → 回落默认白名单（避免误配致全丢）', () => {
    const dir = mkTmp()
    const exporter = createFileExporter({ dir, level: 'debug', names: [] })
    exporter.export(msg({ type: 'info', name: 'dsh-ia:scheduler', args: ['yes'] }))
    expect(readJsonl(dir, '2026-10-12.jsonl').map((r) => r.msg)).toEqual(['yes'])

    const dir2 = mkTmp()
    const exporter2 = createFileExporter({ dir: dir2, level: 'debug', names: ['  ', ''] })
    exporter2.export(msg({ type: 'info', name: 'dsh-ia', args: ['yes2'] }))
    expect(readJsonl(dir2, '2026-10-12.jsonl').map((r) => r.msg)).toEqual(['yes2'])
  })

  it('AC10-8 DEFAULT_EXPORT_NAMES 常量即为 [dsh-ia]（默认单前缀）', () => {
    expect([...DEFAULT_EXPORT_NAMES]).toEqual(['dsh-ia'])
  })
})

// ===========================================================================
// AC11 · 白名单 × 级别过滤叠加
// ===========================================================================
describe('AC11 白名单 × 级别过滤叠加（先 matchesName 再 shouldEmit）', () => {
  it('AC11-1 级别过滤仅对白名单命中的消息生效：白名单外的 debug/error 都不落盘', () => {
    const dir = mkTmp()
    // 阈值 debug（全量放行）→ 若仅按级别，非白名单消息也会落盘；实际应被白名单拦下。
    const exporter = createFileExporter({ dir, level: 'debug' })
    exporter.export(msg({ type: 'debug', name: 'host-core', args: ['x'] }))
    exporter.export(msg({ type: 'error', name: 'svc', args: ['x'] }))
    exporter.export(msg({ type: 'debug', name: 'dsh-ia', args: ['ok'] }))
    expect(readJsonl(dir, '2026-10-12.jsonl').map((r) => r.msg)).toEqual(['ok'])
  })

  it('AC11-2 白名单命中但被级别抑制 → 仍不落盘（error 阈值下 info 丢弃）', () => {
    const dir = mkTmp()
    const exporter = createFileExporter({ dir, level: 'error' })
    exporter.export(msg({ type: 'info', name: 'dsh-ia:session', args: ['suppressed'] }))
    exporter.export(msg({ type: 'error', name: 'dsh-ia:session', args: ['kept'] }))
    expect(readJsonl(dir, '2026-10-12.jsonl').map((r) => r.msg)).toEqual(['kept'])
  })

  it('AC11-3 两道过滤独立：仅白名单命中 + 仅级别达标 → 必须同时满足才落盘', () => {
    const dir = mkTmp()
    const exporter = createFileExporter({ dir, level: 'warn' })
    const cases: Array<[string, 'error' | 'warn' | 'info' | 'debug', string, boolean]> = [
      ['dsh-ia', 'warn', 'wl+lv', true],
      ['dsh-ia:s', 'error', 'wl+lv2', true],
      ['dsh-ia:s', 'info', 'wl-only', false],
      ['host-core', 'error', 'lv-only', false],
      ['host-core', 'debug', 'neither', false],
    ]
    for (const [name, type, m] of cases) exporter.export(msg({ name, type, args: [m] }))
    expect(readJsonl(dir, '2026-10-12.jsonl').map((r) => r.msg)).toEqual(['wl+lv', 'wl+lv2'])
  })
})

// ===========================================================================
// 观察项 A · 采集范围（已由 Fix 1 解决：加 name 白名单）
// ===========================================================================
describe('OBS-A 采集范围（Fix 1 已解决）', () => {
  it('OBS-A-1 白名单生效：非本插件命名的日志不再落盘（对比旧行为）', () => {
    const dir = mkTmp()
    const app = new Context()
    app.logger.exporter(createFileExporter({ dir, level: 'debug' }))
    // 旧语义下这两条会落盘（无白名单）；Fix 1 后应被拦下。
    app.logger('host-core').info('from host core')
    app.logger('other-plugin:sub').warn('from other plugin')

    // 目录内无任何文件（全部被白名单拦下）。
    expect(readdirSync(dir)).toEqual([])
  })

  it('OBS-A-2 对照：本插件命名空间的消息仍正常落盘', () => {
    const dir = mkTmp()
    const app = new Context()
    app.logger.exporter(createFileExporter({ dir, level: 'debug' }))
    app.logger('dsh-ia').info('from me')
    const recs = readJsonl(dir, `${utcDate(Date.now())}.jsonl`)
    expect(recs.map((r) => r.name)).toEqual(['dsh-ia'])
  })
})

// ===========================================================================
// 观察项 B · 日期口径（文件名取 UTC 日期）
// ===========================================================================
describe('OBS-B 日期口径', () => {
  it('OBS-B-1 文件名日期取 message.ts 的 UTC 日（本地已跨天时为「昨天」）', () => {
    const dir = mkTmp()
    const exporter = createFileExporter({ dir, level: 'debug' })
    exporter.export(msg({ ts: T_LOCAL_NEXT_DAY, type: 'info', args: ['local-midnight'] }))

    // 该时刻上海本地为 2026-10-13 00:30，但 UTC 仍是 2026-10-12。
    const localDate = new Date(T_LOCAL_NEXT_DAY).toLocaleDateString('en-CA', {
      timeZone: 'Asia/Shanghai',
    })
    expect(localDate).toBe('2026-10-13')
    const files = readdirSync(dir)
    expect(files).toEqual(['2026-10-12.jsonl']) // 文件名取 UTC 日 → 与本地日错位
    // 记录内 ts 亦为 UTC（与文件名一致）。
    expect(readJsonl(dir, files[0])[0].ts).toBe('2026-10-12T16:30:00.000Z')
  })
})
