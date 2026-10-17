/**
 * tester-t100434-logger.INDEPENDENT.spec.ts
 * ==================================================================
 * Tester 独立复验（t100434 · 日志优化任务-1 · M1「统一门面」）。
 *
 * 被测交付物（HEAD `7a7cb97` 之上的工作区改动）：
 *   - 新增：`src/log/logger.ts`（统一日志门面）
 *   - 修改：`src/plugin.ts` / `src/scheduler/index.ts` / `src/tools/context.ts`
 *           / `src/prompts/index.ts` / `src/session-ensure.ts`
 *           / `src/skills/repo.ts` / `src/skills/provider.ts` / `src/opening-notice.ts`
 *
 * 独立性声明（不复用 Developer 的 `tests/logger.test.ts` 用例）：
 *   1) **真实宿主**：门面「真走 native 出口」一项用**真实 cordis `Context`**
 *      （`new Context()` 自带 `ctx.logger` LoggerService）构造，并注册**自定义
 *      `Exporter`** 捕获结构化 `Message`；用 `console` spy 明确区分「native 出口」与
 *      「降级 console」两条路径，而非用自造假 logger。
 *   2) **真实装配**：`apply(ctx)` / `applyScheduler(ctx)` 用受控「模拟 ctx」（可回卷
 *      effect），并搭配**真实 `ctx.logger`** 验证装配层端到端确走 native 出口。
 *   3) **对抗用例**：覆盖 native 形态非法、缺 scope、child 深派生、meta 键冲突、
 *      非法 level env、native 路径不做二次过滤等边界/反例。
 *
 * 仅新增本测试文件；不改动 src/**、不 commit、不 push。
 * ==================================================================
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context, type Exporter, type Message } from '@deepseek-ai/cordis'
import {
  DEFAULT_LOG_LEVEL,
  LOG_LEVEL_ENV,
  createFinanceLogger,
  createLeveledLogFunction,
  createLogFunction,
  createLogger,
  resolveLogLevel,
} from '../src/log/logger.js'
import { apply, inject as topLevelInject, name as pluginName } from '../src/plugin.js'
import { applyScheduler } from '../src/scheduler/index.js'

/** 项目根（tests/ 的上一级）。 */
const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
/** 插件真实 finance home 环境变量（`src/flags.ts` 的 FINANCE_HOME_ENV）。 */
const FINANCE_HOME_ENV = 'DSH_IA_HOME'

// ---------------------------------------------------------------------------
// 通用夹具
// ---------------------------------------------------------------------------

/** 捕获式自定义 exporter：`levels.default=3` 放行全部四级（含 warn/debug）。 */
function captureExporter(): { exporter: Exporter; messages: Message[] } {
  const messages: Message[] = []
  const exporter: Exporter = {
    levels: { default: 3 },
    export: (m: Message) => {
      messages.push(m)
    },
  }
  return { exporter, messages }
}

/** 受控「模拟 ctx」：可回卷 `effect` 注册的 disposer，便于清理定时器/监听。 */
interface MockCtx {
  ctx: Record<string, unknown>
  disposeAll: () => void
}

function makeMockCtx(overrides: Record<string, unknown> = {}): MockCtx {
  const disposers: Array<() => unknown> = []
  const ctx: Record<string, unknown> = {
    effect(fn: () => unknown) {
      let out: unknown
      try {
        out = fn()
      } catch {
        out = undefined
      }
      const disposer = typeof out === 'function' ? (out as () => unknown) : () => {}
      disposers.push(disposer)
      return disposer
    },
    get() {
      return undefined
    },
    inject() {
      /* 服务缺失：回调从不触发（模拟 tools/skills/agents/systemPrompt 均未就绪） */
    },
    ...overrides,
  }
  return {
    ctx,
    disposeAll: () => {
      for (const d of disposers.splice(0)) {
        try {
          void d()
        } catch {
          /* ignore */
        }
      }
    },
  }
}

/** 递归收集目录下全部 .ts 文件。 */
function walkTs(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry)
    if (statSync(p).isDirectory()) walkTs(p, acc)
    else if (p.endsWith('.ts')) acc.push(p)
  }
  return acc
}

/** 剥离块注释与整行 `//` 注释（保留代码行）。 */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
}

/** 在 tmp 下造一个「已预置」的 finance home（assets/skills），使 `ensureSkillAssetsRepo` 判定为 no-op。 */
function makeProvisionedFinanceHome(): string {
  const dir = mkdtempSync(join(tmpdir(), 't100434-home-'))
  const repo = join(dir, 'assets', 'skills')
  mkdirSync(join(repo, 'seed-skill'), { recursive: true })
  writeFileSync(
    join(repo, 'seed-skill', 'SKILL.md'),
    '---\nname: seed-skill\ndescription: tester seed\n---\nbody\n',
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

let logSpy: ReturnType<typeof vi.spyOn>
let warnSpy: ReturnType<typeof vi.spyOn>
let errSpy: ReturnType<typeof vi.spyOn>
const tmpDirs: string[] = []
let savedDataRoot: string | undefined

beforeEach(() => {
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
  errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  delete process.env[LOG_LEVEL_ENV]
  savedDataRoot = process.env[FINANCE_HOME_ENV]
})

afterEach(() => {
  vi.restoreAllMocks()
  delete process.env[LOG_LEVEL_ENV]
  if (savedDataRoot === undefined) delete process.env[FINANCE_HOME_ENV]
  else process.env[FINANCE_HOME_ENV] = savedDataRoot
  for (const d of tmpDirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  }
})

// ===========================================================================
// AC1 · 门面契约：四级 + child + 结构化 meta + 可从 ctx.logger 取原生
// ===========================================================================

describe('AC1 门面契约（src/log/logger.ts）', () => {
  it('AC1a：实例暴露 error/warn/info/debug 四级 + child(scope)，child 返回同构门面', () => {
    const logger = createFinanceLogger({ scope: 'dsh-ia' })
    for (const m of ['error', 'warn', 'info', 'debug'] as const) {
      expect(typeof logger[m]).toBe('function')
    }
    expect(typeof logger.child).toBe('function')
    const child = logger.child('tools')
    for (const m of ['error', 'warn', 'info', 'debug'] as const) {
      expect(typeof child[m]).toBe('function')
    }
    expect(typeof child.child).toBe('function')
  })

  it('AC1b：源码导出契约齐全（createFinanceLogger/createLogger/createLogFunction/createLeveledLogFunction + 四级类型）', () => {
    const src = readFileSync(join(PROJECT_ROOT, 'src/log/logger.ts'), 'utf8')
    expect(src).toMatch(/export\s+function\s+createFinanceLogger\s*\(/)
    expect(src).toMatch(/export\s+function\s+createLogger\s*\(/)
    expect(src).toMatch(/export\s+function\s+createLogFunction\s*\(/)
    expect(src).toMatch(/export\s+function\s+createLeveledLogFunction\s*\(/)
    expect(src).toMatch(/export\s+interface\s+FinanceLogger\b/)
    expect(src).toMatch(/export\s+const\s+LOG_LEVEL_ENV\b/)
    expect(src).toMatch(/export\s+const\s+DEFAULT_LOG_LEVEL\b/)
  })

  it('AC1c：真实 ctx.logger 可被门面原生接受（结构判据：可调用 + 四级方法）', () => {
    const app = new Context()
    expect(typeof app.logger).toBe('function')
    for (const m of ['error', 'warn', 'info', 'debug'] as const) {
      expect(typeof (app.logger as unknown as Record<string, unknown>)[m]).toBe('function')
    }
    // 门面据 ctx.logger 构造后，日志应进 native exporter（详见 AC2）。
  })
})

// ===========================================================================
// AC2 · 真实 ctx 下确走 native 出口（关键）
// ===========================================================================

describe('AC2 真实 cordis Context → native exporter（非 console 兜底）', () => {
  it('AC2a：门面委托 ctx.logger 派生的命名 Logger，exporter 收到 name=dsh-ia 且 type/args 正确', () => {
    const app = new Context()
    const { exporter, messages } = captureExporter()
    app.logger.exporter(exporter)

    const logger = createFinanceLogger({ native: app.logger, scope: 'dsh-ia' })
    logger.info('加载完成', { part: 'plugin' })

    expect(messages).toHaveLength(1)
    expect(messages[0].name).toBe('dsh-ia')
    expect(messages[0].type).toBe('info')
    expect(messages[0].args[0]).toBe('加载完成')
    expect(messages[0].args[1]).toEqual({ part: 'plugin' })
    // 关键反证：native 出口生效时绝不触碰 console（不是 console 兜底）。
    expect(logSpy).not.toHaveBeenCalled()
    expect(warnSpy).not.toHaveBeenCalled()
    expect(errSpy).not.toHaveBeenCalled()
  })

  it('AC2b：四级全部经 native 出口（name 一致，type 逐级正确）', () => {
    const app = new Context()
    const { exporter, messages } = captureExporter()
    app.logger.exporter(exporter)

    const logger = createFinanceLogger({ native: app.logger, scope: 'dsh-ia' })
    logger.error('E')
    logger.warn('W')
    logger.info('I')
    logger.debug('D')

    expect(messages.map((m) => m.type)).toEqual(['error', 'warn', 'info', 'debug'])
    expect(messages.map((m) => m.name)).toEqual([
      'dsh-ia',
      'dsh-ia',
      'dsh-ia',
      'dsh-ia',
    ])
    expect(messages.map((m) => m.args[0])).toEqual(['E', 'W', 'I', 'D'])
    expect(logSpy).not.toHaveBeenCalled()
    expect(warnSpy).not.toHaveBeenCalled()
    expect(errSpy).not.toHaveBeenCalled()
  })

  it('AC2c（反例）：native 缺失 → 门面降级走 console，同一真实 ctx 的 exporter 无任何输出', () => {
    const app = new Context()
    const { exporter, messages } = captureExporter()
    app.logger.exporter(exporter)

    // 模拟 ctx.logger 缺失：显式不传 native。
    const logger = createFinanceLogger({ scope: 'dsh-ia' })
    logger.info('降级信息')
    logger.error('降级错误')

    expect(logSpy).toHaveBeenCalledWith('降级信息')
    expect(errSpy).toHaveBeenCalledWith('降级错误')
    // 反证：降级路径不产生任何 native exporter 消息。
    expect(messages).toHaveLength(0)
  })

  it('AC2d（反例）：native 形态非法（普通对象 / 纯函数缺四级）→ 同样降级', () => {
    const { exporter, messages } = captureExporter()
    // 借真实 ctx 注册 exporter，用于反证非法 native 不会写它。
    const app = new Context()
    app.logger.exporter(exporter)

    const fake1 = createFinanceLogger({ native: { not: 'a logger' } })
    const fake2 = createFinanceLogger({ native: (() => undefined) as unknown })
    fake1.warn('obj-shape')
    fake2.warn('fn-shape')

    expect(warnSpy).toHaveBeenCalledWith('obj-shape')
    expect(warnSpy).toHaveBeenCalledWith('fn-shape')
    expect(messages).toHaveLength(0)
  })
})

// ===========================================================================
// AC3 · child / meta
// ===========================================================================

describe('AC3 child 命名 与 结构化 meta 合并', () => {
  it('AC3a：child 以 `:` 追加 scope（深派生逐级命名，真实 ctx 观测）', () => {
    const app = new Context()
    const { exporter, messages } = captureExporter()
    app.logger.exporter(exporter)

    const root = createFinanceLogger({ native: app.logger, scope: 'dsh-ia' })
    root.child('tools').info('t')
    root.child('tools').child('registry').warn('r')

    expect(messages.map((m) => m.name)).toEqual([
      'dsh-ia:tools',
      'dsh-ia:tools:registry',
    ])
  })

  it('AC3b：根无 scope 时 child 直接使用子 scope（无前导 `:`）', () => {
    const app = new Context()
    const { exporter, messages } = captureExporter()
    app.logger.exporter(exporter)

    const root = createFinanceLogger({ native: app.logger })
    root.child('scheduler').info('x')
    expect(messages[0].name).toBe('scheduler')
  })

  it('AC3c：base meta ⊕ 调用级 meta 浅合并，调用级优先；派生 child 共享 base meta', () => {
    const app = new Context()
    const { exporter, messages } = captureExporter()
    app.logger.exporter(exporter)

    const logger = createFinanceLogger({
      native: app.logger,
      scope: 'svc',
      meta: { a: 1, b: 1 },
    })
    logger.info('x', { b: 2, c: 3 })
    logger.child('child').info('y', { extra: 9 })

    expect(messages[0].args).toEqual(['x', { a: 1, b: 2, c: 3 }])
    expect(messages[1].args).toEqual(['y', { a: 1, b: 1, extra: 9 }])
  })

  it('AC3d：无任何 meta 时不注入空对象（args 仅消息）', () => {
    const app = new Context()
    const { exporter, messages } = captureExporter()
    app.logger.exporter(exporter)

    createFinanceLogger({ native: app.logger, scope: 'svc' }).info('plain')
    expect(messages[0].args).toEqual(['plain'])
  })
})

// ===========================================================================
// AC4 · level 过滤（降级路径）+ native 不二次过滤
// ===========================================================================

describe('AC4 level 过滤', () => {
  it('AC4a：降级路径 env=error → info/debug 抑制，error 输出', () => {
    process.env[LOG_LEVEL_ENV] = 'error'
    const logger = createLogger('dsh-ia:x')
    logger.error('e')
    logger.warn('w')
    logger.info('i')
    logger.debug('d')

    expect(errSpy).toHaveBeenCalledTimes(1)
    expect(errSpy).toHaveBeenCalledWith('e')
    expect(warnSpy).not.toHaveBeenCalled()
    expect(logSpy).not.toHaveBeenCalled()
  })

  it('AC4b：降级路径默认 info → 放行 error/warn/info，抑制 debug', () => {
    const logger = createFinanceLogger({}) // 无 native，无显式 level → 默认 info
    logger.error('e')
    logger.warn('w')
    logger.info('i')
    logger.debug('d')

    expect(errSpy).toHaveBeenCalledWith('e')
    expect(warnSpy).toHaveBeenCalledWith('w')
    expect(logSpy).toHaveBeenCalledWith('i')
    expect(logSpy).toHaveBeenCalledTimes(1) // debug 未追加
  })

  it('AC4c：options.level 显式覆盖 > env > 默认；非法值回落默认', () => {
    expect(resolveLogLevel('debug')).toBe('debug')
    expect(resolveLogLevel()).toBe(DEFAULT_LOG_LEVEL)
    process.env[LOG_LEVEL_ENV] = 'warn'
    expect(resolveLogLevel()).toBe('warn')
    expect(resolveLogLevel('error')).toBe('error') // 显式优先于 env
    process.env[LOG_LEVEL_ENV] = 'bogus'
    expect(resolveLogLevel()).toBe(DEFAULT_LOG_LEVEL)
  })

  it('AC4d（关键核对）：native 可用时门面不做二次过滤，由 native 自身 level 决定', () => {
    const app = new Context()
    const { exporter, messages } = captureExporter()
    app.logger.exporter(exporter)

    // 门面阈值设为最严 error，但 native 可用 → 门面不应拦截。
    process.env[LOG_LEVEL_ENV] = 'error'
    const logger = createFinanceLogger({ native: app.logger, scope: 'svc' })
    logger.debug('d')
    logger.info('i')
    logger.warn('w')
    logger.error('e')

    // 自定义 exporter levels.default=3 → native 侧全部放行（与门面阈值无关）。
    expect(messages.map((m) => m.type)).toEqual(['debug', 'info', 'warn', 'error'])
    expect(logSpy).not.toHaveBeenCalled()
  })
})

// ===========================================================================
// AC5 · 全仓无散乱 console
// ===========================================================================

describe('AC5 全仓无散乱 console（门面内部 + 注释除外）', () => {
  it('AC5a：src/**/*.ts 中除 src/log/logger.ts 外无真实 console.* 调用', () => {
    const files = walkTs(join(PROJECT_ROOT, 'src'))
    const offenders: string[] = []
    for (const f of files) {
      if (f.endsWith(join('log', 'logger.ts'))) continue
      const code = stripComments(readFileSync(f, 'utf8'))
      if (/console\./.test(code)) offenders.push(f.replace(PROJECT_ROOT + '/', ''))
    }
    expect(offenders).toEqual([])
    // 且门面内部确有唯一 console 兜底出口。
    expect(/console\./.test(readFileSync(join(PROJECT_ROOT, 'src/log/logger.ts'), 'utf8'))).toBe(true)
  })

  it('AC5b：src/scheduler/index.ts 手写 level→console switch 已消失', () => {
    const code = stripComments(
      readFileSync(join(PROJECT_ROOT, 'src/scheduler/index.ts'), 'utf8'),
    )
    expect(/console\./.test(code)).toBe(false)
    // 默认日志出口改为门面适配器。
    expect(code).toMatch(/createLeveledLogFunction\s*\(\s*'dsh-ia:scheduler'/)
  })
})

// ===========================================================================
// AC6 · inject 契约不变
// ===========================================================================

describe('AC6 顶层 inject 契约不变', () => {
  it('AC6a：运行时 plugin.inject === [tools, skills, fs]（且 name 不变）', () => {
    expect(topLevelInject).toEqual(['tools', 'skills', 'fs'])
    expect(pluginName).toBe('investment-advisor')
  })

  it('AC6b：源码字面量仍为三项原样', () => {
    const src = readFileSync(join(PROJECT_ROOT, 'src/plugin.ts'), 'utf8')
    expect(src).toMatch(/inject:\s*string\[\]\s*=\s*\[\s*'tools'\s*,\s*'skills'\s*,\s*'fs'\s*\]/)
    // 有意兼容：保留字面 applyScheduler(ctx)（见任务已知约束）。
    expect(src).toMatch(/applyScheduler\s*\(\s*ctx\s*\)/)
  })
})

// ===========================================================================
// AC7 · 装配不回归（模拟 ctx 降级路径 + 真实 native 日志）
// ===========================================================================

describe('AC7 apply(ctx) / applyScheduler(ctx) 装配不回归', () => {
  it('AC7a：tools/skills/agents/logger 均缺失的最小 mock ctx 下 apply 不抛，且走门面降级 console', () => {
    const home = makeProvisionedFinanceHome()
    tmpDirs.push(home)
    process.env[FINANCE_HOME_ENV] = home

    const { ctx, disposeAll } = makeMockCtx()
    try {
      expect(() => apply(ctx as never)).not.toThrow()
      // 降级：加载日志与「tools/skills 不可用」告警经 facade → console。
      expect(logSpy).toHaveBeenCalled()
      expect(warnSpy).toHaveBeenCalled()
    } finally {
      disposeAll()
    }
  })

  it('AC7b：applyScheduler 不传 options.logger 时默认走门面（真实 native ctx 收日志）', () => {
    const home = makeProvisionedFinanceHome()
    tmpDirs.push(home)

    const nativeCtx = new Context()
    const { exporter, messages } = captureExporter()
    nativeCtx.logger.exporter(exporter)

    const { ctx, disposeAll } = makeMockCtx({ logger: nativeCtx.logger })
    try {
      expect(() => applyScheduler(ctx as never, { dataRoot: home })).not.toThrow()
      // scheduler 的「tools 服务不可用」告警 → 经门面 native 出口，name=dsh-ia:scheduler。
      const sched = messages.filter((m) => m.name === 'dsh-ia:scheduler')
      expect(sched.length).toBeGreaterThan(0)
      expect(sched.some((m) => m.type === 'warn')).toBe(true)
    } finally {
      disposeAll()
    }
  })

  it('AC7c：真实 native ctx 驱动 apply，加载日志经 native 出口（name=dsh-ia），非 console', () => {
    const home = makeProvisionedFinanceHome()
    tmpDirs.push(home)
    process.env[FINANCE_HOME_ENV] = home

    const nativeCtx = new Context()
    const { exporter, messages } = captureExporter()
    nativeCtx.logger.exporter(exporter)

    const { ctx, disposeAll } = makeMockCtx({ logger: nativeCtx.logger })
    try {
      expect(() => apply(ctx as never)).not.toThrow()
      const load = messages.filter((m) => m.name === 'dsh-ia')
      expect(load.length).toBeGreaterThan(0)
      expect(load.some((m) => String(m.args[0]).includes('插件加载'))).toBe(true)
      // 健康路径不落 console。
      expect(errSpy).not.toHaveBeenCalled()
    } finally {
      disposeAll()
    }
  })
})

// ===========================================================================
// 附加：既有注入位适配器（native 透传）
// ===========================================================================

describe('AC2/AC7 附加：既有注入位适配器', () => {
  it('createLogFunction(scope, native) → info 级且经 native 出口', () => {
    const app = new Context()
    const { exporter, messages } = captureExporter()
    app.logger.exporter(exporter)

    createLogFunction('dsh-ia:notice', app.logger)('hi')
    expect(messages).toHaveLength(1)
    expect(messages[0].name).toBe('dsh-ia:notice')
    expect(messages[0].type).toBe('info')
    expect(messages[0].args[0]).toBe('hi')
  })

  it('createLeveledLogFunction(scope, native) → 按 level 映射 native 四级', () => {
    const app = new Context()
    const { exporter, messages } = captureExporter()
    app.logger.exporter(exporter)

    const log = createLeveledLogFunction('dsh-ia:scheduler', app.logger)
    log('error', 'E')
    log('warn', 'W')
    log('info', 'I')
    expect(messages.map((m) => m.type)).toEqual(['error', 'warn', 'info'])
    expect(messages.every((m) => m.name === 'dsh-ia:scheduler')).toBe(true)
  })
})
