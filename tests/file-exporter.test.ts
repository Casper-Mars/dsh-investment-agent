/**
 * 文件落地 exporter（`src/log/file-exporter.ts`）单元测试（里程碑 M2「文件落地」）。
 *
 * 覆盖（对齐任务卡 §验收标准）：
 *   1. JSONL 记录形状（ts/level/name/msg/args/pid/origin + printf 展开）；
 *   2. 按天轮转（跨天 → 不同文件名）；
 *   3. 同日超阈值 → `-1`/`-2` 后缀轮转（小阈值，勿真写 50MB）；
 *   4. 级别过滤（方案严重度序：info / error / warn / debug，含 env 覆盖）；
 *   5. 目录 0o700、文件 0o600；
 *   6. 经 `ctx.logger.exporter(...)` 注册 / 注销；追加注册不影响宿主既有 exporter；
 *   7. 降级（fs 抛错吞掉、不中断）；
 *   8. `apply(ctx)` 装配后宿主日志落地到 `DSH_FINANCE_LOG_DIR`；
 *   9. 目录 / 阈值解析优先级；
 *  10. name 白名单（仅 `dsh-finance[:scope]` 落盘；非本插件 name 一律丢弃；与级别过滤叠加）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context, type Exporter, type Message } from '@deepseek-ai/cordis'
import {
  createFileExporter,
  DEFAULT_LOG_MAX_SIZE,
  LOG_MAX_SIZE_ENV,
  resolveLogMaxSize,
} from '../src/log/file-exporter.js'
import { LOG_LEVEL_ENV } from '../src/log/logger.js'
import { LOG_DIR_ENV, resolveFinanceLogDir } from '../src/paths.js'
import { apply } from '../src/plugin.js'

/** 项目无日期工具：文件名日期口径与记录 `ts` 一致，均取 UTC `YYYY-MM-DD`。 */
const utcDate = (ts: number): string => new Date(ts).toISOString().slice(0, 10)
const today = (): string => utcDate(Date.now())

/** 固定测试时间：2026-10-12T12:00:00Z。 */
const T1 = Date.UTC(2026, 9, 12, 12, 0, 0)
/** 另一天：2026-10-13T12:00:00Z。 */
const T2 = Date.UTC(2026, 9, 13, 12, 0, 0)

/** 构造一条 cordis `Message`（仅填本任务关心的字段）。 */
function makeMessage(partial: Partial<Message> & Pick<Message, 'type'>): Message {
  return {
    sn: 1,
    ts: T1,
    name: 'dsh-finance',
    level: 0,
    args: [],
    ...partial,
  }
}

/** 读取某文件为 JSONL 记录数组。 */
function readJsonl(dir: string, name: string): Array<Record<string, unknown>> {
  const content = readFileSync(join(dir, name), 'utf8')
  return content
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as Record<string, unknown>)
}

/** 读取目录下全部文件的 JSONL 行数之和。 */
function totalLines(dir: string): number {
  let n = 0
  for (const f of readdirSync(dir)) {
    n += readFileSync(join(dir, f), 'utf8')
      .split('\n')
      .filter((line) => line.trim() !== '').length
  }
  return n
}

const tmpDirs: string[] = []
function mkTmp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-finance-filelog-'))
  tmpDirs.push(dir)
  return dir
}

/** 造一个「已预置」的数据根，使 `ensureSkillAssetsRepo` 判定为 no-op（apply 集成用）。 */
function makeProvisionedDataRoot(): string {
  const dir = mkTmp()
  const repo = join(dir, 'skills')
  mkdirSync(join(repo, 'seed-skill'), { recursive: true })
  writeFileSync(
    join(repo, 'seed-skill', 'SKILL.md'),
    '---\nname: seed-skill\ndescription: t seed\n---\nbody\n',
  )
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' }
  execFileSync('git', ['init', '-q'], { cwd: repo, env })
  execFileSync('git', ['-c', 'user.email=t@t.local', '-c', 'user.name=t', 'add', '-A'], {
    cwd: repo,
    env,
  })
  execFileSync(
    'git',
    ['-c', 'user.email=t@t.local', '-c', 'user.name=t', 'commit', '-qm', 'seed'],
    { cwd: repo, env },
  )
  return dir
}

let savedLogDir: string | undefined
let savedLogLevel: string | undefined
let savedMaxSize: string | undefined
let savedDataDir: string | undefined

beforeEach(() => {
  savedLogDir = process.env[LOG_DIR_ENV]
  savedLogLevel = process.env[LOG_LEVEL_ENV]
  savedMaxSize = process.env[LOG_MAX_SIZE_ENV]
  savedDataDir = process.env.DSH_FINANCE_DATA_DIR
  delete process.env[LOG_DIR_ENV]
  delete process.env[LOG_LEVEL_ENV]
  delete process.env[LOG_MAX_SIZE_ENV]
})

afterEach(() => {
  vi.restoreAllMocks()
  const restore = (k: string, v: string | undefined) => {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  restore(LOG_DIR_ENV, savedLogDir)
  restore(LOG_LEVEL_ENV, savedLogLevel)
  restore(LOG_MAX_SIZE_ENV, savedMaxSize)
  restore('DSH_FINANCE_DATA_DIR', savedDataDir)
  for (const d of tmpDirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  }
})

// ===========================================================================
// ① JSONL 记录形状
// ===========================================================================
describe('① JSONL 记录形状（§4.2）', () => {
  it('写单条 JSONL：ts/level/name/msg/args/pid/origin 齐全', () => {
    const dir = mkTmp()
    const exporter = createFileExporter({ dir, level: 'debug' })
    exporter.export(
      makeMessage({
        ts: T1,
        type: 'info',
        name: 'dsh-finance:scheduler.runner',
        args: ['task completed', { taskId: 'market-pulse' }],
      }),
    )

    const lines = readJsonl(dir, '2026-10-12.jsonl')
    expect(lines).toHaveLength(1)
    const rec = lines[0]
    expect(rec.ts).toBe('2026-10-12T12:00:00.000Z')
    expect(rec.level).toBe('info')
    expect(rec.name).toBe('dsh-finance:scheduler.runner')
    expect(rec.msg).toBe('task completed')
    expect(rec.args).toEqual({ taskId: 'market-pulse' })
    expect(rec.pid).toBe(process.pid)
    expect(rec.origin).toBe('host')
  })

  it('printf 展开：%s/%d/%i/%f/%o/%O 占位符按序消费参数', () => {
    const dir = mkTmp()
    const exporter = createFileExporter({ dir, level: 'debug' })
    exporter.export(
      makeMessage({ ts: T1, type: 'info', args: ['n=%d s=%s f=%f', 3, 'x', 1.5] }),
    )
    exporter.export(makeMessage({ ts: T1, type: 'info', args: ['obj=%o', { a: 1 }] }))

    const lines = readJsonl(dir, '2026-10-12.jsonl')
    expect(lines[0].msg).toBe('n=3 s=x f=1.5')
    expect(lines[1].msg).toBe('obj={"a":1}')
  })

  it('非字符串首参 → 字符串化；Error 首参 → stack；meta 合并为 args', () => {
    const dir = mkTmp()
    const exporter = createFileExporter({ dir, level: 'debug' })
    exporter.export(makeMessage({ ts: T1, type: 'info', args: [{ k: 2 }] }))
    exporter.export(makeMessage({ ts: T1, type: 'error', args: [new Error('boom')] }))
    exporter.export(makeMessage({ ts: T1, type: 'info', args: ['m', { a: 1 }, { b: 2 }] }))

    const lines = readJsonl(dir, '2026-10-12.jsonl')
    expect(lines[0].msg).toBe('{"k":2}')
    expect(String(lines[1].msg)).toContain('boom')
    expect(lines[2].msg).toBe('m')
    expect(lines[2].args).toEqual({ a: 1, b: 2 })
  })

  it('无附加参数时不写空 args；无参数时 msg 为空串', () => {
    const dir = mkTmp()
    const exporter = createFileExporter({ dir, level: 'debug' })
    exporter.export(makeMessage({ ts: T1, type: 'info', args: ['plain'] }))
    exporter.export(makeMessage({ ts: T1, type: 'info', args: [] }))
    const lines = readJsonl(dir, '2026-10-12.jsonl')
    expect(lines[0]).not.toHaveProperty('args')
    expect(lines[1].msg).toBe('')
  })
})

// ===========================================================================
// ② 按天轮转
// ===========================================================================
describe('② 按天轮转', () => {
  it('跨天写入不同日期文件；当日文件名为 <date>.jsonl', () => {
    const dir = mkTmp()
    const exporter = createFileExporter({ dir, level: 'debug' })
    exporter.export(makeMessage({ ts: T1, type: 'info', args: ['day1'] }))
    exporter.export(makeMessage({ ts: T2, type: 'info', args: ['day2'] }))

    expect(readdirSync(dir).sort()).toEqual(['2026-10-12.jsonl', '2026-10-13.jsonl'])
    expect(readJsonl(dir, '2026-10-12.jsonl')[0].msg).toBe('day1')
    expect(readJsonl(dir, '2026-10-13.jsonl')[0].msg).toBe('day2')
  })
})

// ===========================================================================
// ③ 同日超阈值后缀轮转
// ===========================================================================
describe('③ 超阈值轮转（小阈值）', () => {
  it('单文件达阈值后递增 -1/-2… 后缀，且不丢行', () => {
    const dir = mkTmp()
    const maxSize = 250
    const exporter = createFileExporter({ dir, maxSize, level: 'debug' })
    const total = 20
    for (let i = 0; i < total; i += 1) {
      exporter.export(
        makeMessage({ ts: T1, type: 'info', args: [`line-${i}-${'x'.repeat(48)}`] }),
      )
    }

    const files = readdirSync(dir).sort()
    expect(files).toContain('2026-10-12.jsonl')
    expect(files).toContain('2026-10-12-1.jsonl')
    expect(files).toContain('2026-10-12-2.jsonl')
    // 行不丢：全部行数守恒。
    expect(totalLines(dir)).toBe(total)
    // 除最后一个封口文件外，其余文件均已达阈值（>= maxSize）。
    const sized = files.map((f) => ({ f, size: statSync(join(dir, f)).size }))
    const notFull = sized.filter((s) => s.size < maxSize)
    expect(notFull.length).toBeLessThanOrEqual(1)
  })
})

// ===========================================================================
// ④ 级别过滤（方案严重度序）
// ===========================================================================
describe('④ 级别过滤（方案严重度序 error≤warn≤info≤debug）', () => {
  /** 依次投递四级消息，返回落盘记录里的 level 数组。 */
  function emitFour(dir: string, level?: string): string[] {
    const exporter = createFileExporter({ dir, level })
    const types = ['error', 'warn', 'info', 'debug'] as const
    for (const type of types) {
      exporter.export(makeMessage({ ts: T1, type, args: [type] }))
    }
    const file = join(dir, '2026-10-12.jsonl')
    if (!existsSync(file)) return []
    return readJsonl(dir, '2026-10-12.jsonl').map((r) => String(r.level))
  }

  it('默认 info：error/warn/info 落盘，debug 丢弃', () => {
    expect(emitFour(mkTmp())).toEqual(['error', 'warn', 'info'])
  })

  it('error：仅 error 落盘', () => {
    expect(emitFour(mkTmp(), 'error')).toEqual(['error'])
  })

  it('warn：error+warn 落盘，info/debug 丢弃', () => {
    expect(emitFour(mkTmp(), 'warn')).toEqual(['error', 'warn'])
  })

  it('debug：全留', () => {
    expect(emitFour(mkTmp(), 'debug')).toEqual(['error', 'warn', 'info', 'debug'])
  })

  it('env DSH_FINANCE_LOG_LEVEL=error 生效于构造缺省', () => {
    process.env[LOG_LEVEL_ENV] = 'error'
    expect(emitFour(mkTmp())).toEqual(['error'])
  })

  it('显式 level 优先于 env', () => {
    process.env[LOG_LEVEL_ENV] = 'error'
    expect(emitFour(mkTmp(), 'debug')).toEqual(['error', 'warn', 'info', 'debug'])
  })
})

// ===========================================================================
// ⑤ 权限
// ===========================================================================
describe('⑤ 文件权限', () => {
  it('目录 0o700、文件 0o600', () => {
    const dir = join(mkTmp(), 'logs')
    const exporter = createFileExporter({ dir, level: 'debug' })
    exporter.export(makeMessage({ ts: T1, type: 'info', args: ['perm'] }))

    expect(statSync(dir).mode & 0o777).toBe(0o700)
    const file = join(dir, '2026-10-12.jsonl')
    expect(statSync(file).mode & 0o777).toBe(0o600)
  })
})

// ===========================================================================
// ⑥ 注册 / 注销（真实 cordis Context）
// ===========================================================================
describe('⑥ 经 ctx.logger.exporter 注册 / 注销', () => {
  it('注册后宿主日志落盘；dispose 后注销（不再写）', () => {
    const app = new Context()
    const dir = mkTmp()
    const dispose = app.logger.exporter(createFileExporter({ dir, level: 'debug' }))

    app.logger('dsh-finance').info('hello', { a: 1 })
    const file = join(dir, `${today()}.jsonl`)
    expect(existsSync(file)).toBe(true)
    expect(readFileSync(file, 'utf8')).toContain('hello')
    const before = readJsonl(dir, `${today()}.jsonl`).length

    dispose()
    app.logger('dsh-finance').info('after-dispose')
    expect(readJsonl(dir, `${today()}.jsonl`).length).toBe(before)
    expect(readFileSync(file, 'utf8')).not.toContain('after-dispose')
  })

  it('追加注册：宿主既有 exporter 与文件 exporter 同时收到（互不干扰）', () => {
    const app = new Context()
    const dir = mkTmp()
    const captured: Message[] = []
    const existing: Exporter = {
      levels: { default: 3 },
      export: (m) => captured.push(m),
    }
    app.logger.exporter(existing)
    app.logger.exporter(createFileExporter({ dir, level: 'debug' }))

    app.logger('dsh-finance').info('both')
    expect(captured.map((m) => m.type)).toEqual(['info'])
    expect(readFileSync(join(dir, `${today()}.jsonl`), 'utf8')).toContain('both')
  })
})

// ===========================================================================
// ⑦ 降级：fs 抛错吞掉
// ===========================================================================
describe('⑦ 降级（fs 抛错吞掉，不中断）', () => {
  it('目录父路径是文件（mkdir ENOTDIR）→ export 不抛', () => {
    const base = mkTmp()
    const asFile = join(base, 'not-a-dir')
    writeFileSync(asFile, 'x')
    const exporter = createFileExporter({ dir: join(asFile, 'logs'), level: 'debug' })
    expect(() => exporter.export(makeMessage({ ts: T1, type: 'info', args: ['boom'] }))).not.toThrow()
  })

  it('目标文件名是目录（append EISDIR）→ export 不抛', () => {
    const dir = mkTmp()
    mkdirSync(join(dir, '2026-10-12.jsonl'))
    const exporter = createFileExporter({ dir, level: 'debug' })
    expect(() => exporter.export(makeMessage({ ts: T1, type: 'info', args: ['boom'] }))).not.toThrow()
  })
})

// ===========================================================================
// ⑧ apply(ctx) 集成
// ===========================================================================
describe('⑧ apply(ctx) 装配后日志落地', () => {
  it('插件加载日志写入 DSH_FINANCE_LOG_DIR 当日文件', () => {
    const logDir = mkTmp()
    const dataDir = makeProvisionedDataRoot()
    process.env[LOG_DIR_ENV] = logDir
    process.env.DSH_FINANCE_DATA_DIR = dataDir

    const app = new Context()
    const ctx = {
      effect(fn: () => unknown) {
        const out = fn()
        return typeof out === 'function' ? out : () => {}
      },
      get() {
        return undefined
      },
      inject() {
        /* systemPrompt 未就绪：回调不触发 */
      },
      logger: app.logger,
    }

    expect(() => apply(ctx as never)).not.toThrow()
    const file = join(logDir, `${today()}.jsonl`)
    expect(existsSync(file)).toBe(true)
    expect(readFileSync(file, 'utf8')).toContain('插件加载')
  })
})

// ===========================================================================
// ⑨ 解析优先级
// ===========================================================================
describe('⑨ 目录 / 阈值解析优先级', () => {
  it('日志目录：构造注入 > env > 默认', () => {
    expect(resolveFinanceLogDir('/tmp/dsh-explicit')).toBe('/tmp/dsh-explicit')
    process.env[LOG_DIR_ENV] = '/tmp/dsh-env'
    expect(resolveFinanceLogDir()).toBe('/tmp/dsh-env')
    expect(resolveFinanceLogDir('/tmp/dsh-explicit')).toBe('/tmp/dsh-explicit')
    delete process.env[LOG_DIR_ENV]
    expect(resolveFinanceLogDir()).toMatch(/\/logs$/)
  })

  it('阈值：显式 > env > 默认；非正 / 非法值回落', () => {
    expect(resolveLogMaxSize(1024)).toBe(1024)
    process.env[LOG_MAX_SIZE_ENV] = '2048'
    expect(resolveLogMaxSize()).toBe(2048)
    expect(resolveLogMaxSize(512)).toBe(512)
    process.env[LOG_MAX_SIZE_ENV] = 'bogus'
    expect(resolveLogMaxSize()).toBe(DEFAULT_LOG_MAX_SIZE)
    expect(resolveLogMaxSize(0)).toBe(DEFAULT_LOG_MAX_SIZE)
  })
})

// ===========================================================================
// ⑩ name 白名单（本插件命名空间）
// ===========================================================================
describe('⑩ name 白名单（仅 dsh-finance[:scope] 落盘）', () => {
  it('裸名 `dsh-finance` 与子 scope `dsh-finance:xxx` 都要落盘', () => {
    const dir = mkTmp()
    const exporter = createFileExporter({ dir, level: 'debug' })
    exporter.export(makeMessage({ ts: T1, type: 'info', name: 'dsh-finance', args: ['bare'] }))
    exporter.export(
      makeMessage({ ts: T1, type: 'info', name: 'dsh-finance:scheduler.runner', args: ['sub'] }),
    )
    exporter.export(makeMessage({ ts: T1, type: 'info', name: 'dsh-finance:session', args: ['sub2'] }))

    const lines = readJsonl(dir, '2026-10-12.jsonl')
    expect(lines.map((r) => r.msg)).toEqual(['bare', 'sub', 'sub2'])
    expect(lines.map((r) => r.name)).toEqual([
      'dsh-finance',
      'dsh-finance:scheduler.runner',
      'dsh-finance:session',
    ])
  })

  it('反例：非本插件 name（host-core / svc / other-plugin 等）一律不落盘', () => {
    const dir = mkTmp()
    const exporter = createFileExporter({ dir, level: 'debug' })
    for (const name of ['host-core', 'svc', 'other-plugin', 'skill-filesystem', '']) {
      exporter.export(makeMessage({ ts: T1, type: 'error', name, args: [`from-${name}`] }))
    }
    expect(existsSync(join(dir, '2026-10-12.jsonl'))).toBe(false)
    expect(readdirSync(dir)).toEqual([])
  })

  it('边界：`dsh-financex`（前缀但非 `:` 分隔）不落盘', () => {
    const dir = mkTmp()
    const exporter = createFileExporter({ dir, level: 'debug' })
    exporter.export(makeMessage({ ts: T1, type: 'info', name: 'dsh-financex', args: ['no'] }))
    exporter.export(makeMessage({ ts: T1, type: 'info', name: 'dsh-finance-x', args: ['no2'] }))
    expect(existsSync(join(dir, '2026-10-12.jsonl'))).toBe(false)
  })

  it('白名单与级别过滤叠加：本插件 name 但被级别抑制 → 仍不落盘', () => {
    const dir = mkTmp()
    const exporter = createFileExporter({ dir, level: 'error' })
    exporter.export(
      makeMessage({ ts: T1, type: 'info', name: 'dsh-finance:session', args: ['suppressed'] }),
    )
    exporter.export(
      makeMessage({ ts: T1, type: 'error', name: 'dsh-finance:session', args: ['kept'] }),
    )
    expect(readJsonl(dir, '2026-10-12.jsonl').map((r) => r.msg)).toEqual(['kept'])
  })

  it('names 可注入：自定义前缀生效，原默认前缀不再匹配', () => {
    const dir = mkTmp()
    const exporter = createFileExporter({ dir, level: 'debug', names: ['my-plugin'] })
    exporter.export(makeMessage({ ts: T1, type: 'info', name: 'my-plugin:svc', args: ['yes'] }))
    exporter.export(makeMessage({ ts: T1, type: 'info', name: 'dsh-finance', args: ['no'] }))
    expect(readJsonl(dir, '2026-10-12.jsonl').map((r) => r.msg)).toEqual(['yes'])
  })

  it('names 传空数组 → 回落默认白名单（避免误配全丢）', () => {
    const dir = mkTmp()
    const exporter = createFileExporter({ dir, level: 'debug', names: [] })
    exporter.export(makeMessage({ ts: T1, type: 'info', name: 'dsh-finance:scheduler', args: ['yes'] }))
    expect(readJsonl(dir, '2026-10-12.jsonl').map((r) => r.msg)).toEqual(['yes'])
  })
})
