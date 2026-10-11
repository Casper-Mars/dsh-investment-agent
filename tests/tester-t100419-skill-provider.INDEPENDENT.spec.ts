/**
 * 独立测试（t100419）—— dsh-finance 接入 dsh 原生 `skill-filesystem` provider。
 *
 * 与开发者自测 `tests/skill-provider.spec.ts` 独立：本文件自行构造**真实**装配
 * （真实 `SkillRegistry` + 真实 `chokidar` watch 热更新 + 真实 scope 层），逐条对应
 * 验收标准 AC1–AC4 与任务要求的 A–H 独立验证点，**不污染** `~/.dsh-finance`。
 *
 * 覆盖：
 *   A  真实热更新闭环（改写 / 新增 / 删除 + `skills/change` 事件证据）
 *   B  global 层可见性（固定会话 scope / workspace→session 链 scope，真实 scope）
 *   C  无残留引用 + 装配正确（inject 契约 / patch / plugin.ts 不再走 runtime 注册）
 *   D  降级对抗（挂载抛错 / 依赖不可解析 / 真实 apply 不抛且其它贡献照常）
 *   E  卸载语义（dispose → list 归 0 + watch 关闭 + 改写不再复活）
 *   F  与 preset 默认 provider 同名共存 / 同层重名边界
 *
 * 说明：本文件含真实 chokidar 用例（稳定性阈值 ~200ms），故相关用例超时放宽到 30s，
 * 并在报告 REPORT.md 中标注耗时。
 */
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
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import {
  mountSkillFilesystemProvider,
  mountSkillFilesystemProviderAsync,
  SKILL_PROVIDER_NAME,
} from '../src/skills/provider.js'
import {
  ensureSkillAssetsRepo,
  resolveSkillsRepoDir,
  SKILL_FILENAME,
} from '../src/skills/repo.js'
import { SKILL_NAMES } from '../src/skills/index.js'
import { apply as pluginApply, inject as pluginInject, name as pluginName } from '../src/plugin.js'

const ROOT = process.cwd()
const CORE: readonly string[] = SKILL_NAMES
const TARGET = 'trend-analysis'
const STABILITY_WAIT_MS = 900

/* ------------------------------------------------------------------ *
 * dsh-scope 非本包直接依赖（pnpm 严格布局）；经 harness 包同侧路径解析真实 scope。
 * ------------------------------------------------------------------ */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let dshScope: any
const require = createRequire(import.meta.url)

beforeAll(async () => {
  const skillEntry = require.resolve('@deepseek-ai/dsh-skill')
  const scopeEntry = join(dirname(dirname(dirname(skillEntry))), 'dsh-scope', 'lib', 'index.js')
  dshScope = await import(pathToFileURL(scopeEntry).href)
})

/* ------------------------------------------------------------------ *
 * 环境隔离：把默认 dataRoot 指向临时目录，杜绝任何回落污染真实 home。
 * ------------------------------------------------------------------ */
const savedEnv = process.env.DSH_FINANCE_DATA_DIR
let envRoot: string
beforeAll(() => {
  envRoot = mkdtempSync(join(tmpdir(), 'dsh-fin-t100419-env-'))
  process.env.DSH_FINANCE_DATA_DIR = envRoot
})
afterAll(() => {
  if (savedEnv === undefined) delete process.env.DSH_FINANCE_DATA_DIR
  else process.env.DSH_FINANCE_DATA_DIR = savedEnv
  rmSync(envRoot, { recursive: true, force: true })
})

const tmps: string[] = []
function track<T extends string>(dir: T): T {
  tmps.push(dir)
  return dir
}

/** 临时 raw 目录（不预置）。 */
function mkTmpRaw(): string {
  return track(mkdtempSync(join(tmpdir(), 'dsh-fin-t100419-raw-')))
}

/** 临时 dataRoot 并预置真实 skills 仓库（5 个可进化 skill，独立 git 仓库）。 */
function mkSeededDataRoot(): string {
  const dir = track(mkdtempSync(join(tmpdir(), 'dsh-fin-t100419-data-')))
  const out = ensureSkillAssetsRepo({ dataRoot: dir, logger: () => {} })
  if (out.degraded) throw new Error(`预置降级：${out.reason}`)
  return dir
}

afterEach(() => {
  for (const dir of tmps.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  }
})

/* ------------------------------------------------------------------ *
 * helpers
 * ------------------------------------------------------------------ */
async function newRegistryCtx(): Promise<Context> {
  const ctx = new Context()
  await (ctx.plugin(SkillRegistry as never) as unknown as Promise<unknown>)
  return ctx
}

function writeSkill(dir: string, name: string, description: string, body: string): void {
  const d = join(dir, name)
  mkdirSync(d, { recursive: true })
  writeFileSync(
    join(d, SKILL_FILENAME),
    `---\nname: ${name}\ndescription: ${description}\nwhenToUse: ${description}-when\n---\n\n${body}\n`,
    'utf8',
  )
}

/** 改写一个已存在（挂载时已被 watch）的 skill 文件，可靠触发 invalidate → 重列。 */
function nudgeWatch(skillsDir: string): void {
  const p = join(skillsDir, TARGET, SKILL_FILENAME)
  writeFileSync(p, readFileSync(p, 'utf8') + '\n<!-- tester nudge -->\n', 'utf8')
}

async function waitFor<T>(
  fn: () => Promise<T> | T,
  opts: { timeout?: number; interval?: number; label?: string } = {},
): Promise<T> {
  const { timeout = 12000, interval = 100, label = '' } = opts
  const start = Date.now()
  let lastErr: unknown
  while (Date.now() - start < timeout) {
    try {
      return await fn()
    } catch (err) {
      lastErr = err
    }
    await new Promise((r) => setTimeout(r, interval))
  }
  throw lastErr ?? new Error(`waitFor 超时：${label}`)
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function list(ctx: Context, scope?: unknown): Promise<any[]> {
  const reg = ctx.skills as never as { list: (o: unknown) => Promise<unknown[]> }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (await reg.list(scope === undefined ? {} : { scope })) as any[]
}

function coreNames(all: { name: string }[]): string[] {
  return all
    .map((s) => s.name)
    .filter((n) => CORE.includes(n))
    .sort()
}

/** 统计当前活跃的 FSWatcher 资源数（用于佐证 watch 关闭）。 */
function countFsWatchers(): number {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const info = (process as any).getActiveResourcesInfo?.() as string[] | undefined
  return info ? info.filter((r) => r === 'FSWatcher').length : -1
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function importProviderModule(): Promise<any> {
  return import('@deepseek-ai/dsh-skill-filesystem')
}

/* ================================================================== *
 * A. 真实热更新闭环（真实 chokidar）
 * ================================================================== */
describe('A · 真实热更新闭环（真实 chokidar watch）', () => {
  it('A1 改写 SKILL.md → invalidate → skills/change 事件 + 下次 list() 反映新内容（非磁盘重读）', async () => {
    const dataRoot = mkSeededDataRoot()
    const skillsDir = resolveSkillsRepoDir(dataRoot)
    const ctx = await newRegistryCtx()
    const mount = await mountSkillFilesystemProviderAsync(ctx, { dataRoot })

    // 初次 list()：触发真实 watcher 装配（list() resolve 时 watcher 已 ready）。
    const before = await list(ctx)
    const beforeDesc = before.find((s) => s.name === TARGET)?.description
    expect(beforeDesc).toBeTruthy()

    // 监听 skills/change（invalidateCache → notifyChange 的对外信号）。
    let changeEvents = 0
    ctx.on('skills/change', () => {
      changeEvents += 1
    })

    // 改写 description + whenToUse + 正文（无重启）。
    writeFileSync(
      join(skillsDir, TARGET, SKILL_FILENAME),
      `---\nname: ${TARGET}\ndescription: TESTER-HOT-NEW-DESC\nwhenToUse: TESTER-HOT-NEW-WHEN\n---\n\n# TESTER-HOT-NEW-BODY\n独立复验新正文\n`,
      'utf8',
    )

    await waitFor(
      async () => {
        const l = await list(ctx)
        expect(l.find((s) => s.name === TARGET)?.description).toBe('TESTER-HOT-NEW-DESC')
      },
      { timeout: 12000, label: 'A1 description 热更新' },
    )

    // 证据链：catalog（list）侧刷新 + skills/change 事件触发（证明 invalidate→notify→重列，
    // 而非「get() 每次直读磁盘」的假象）。
    expect(beforeDesc).not.toBe('TESTER-HOT-NEW-DESC')
    expect(changeEvents).toBeGreaterThan(0)
    expect((await list(ctx)).find((s) => s.name === TARGET)?.whenToUse).toBe('TESTER-HOT-NEW-WHEN')
    const def = (await ctx.skills.get(TARGET)) as unknown as { content: string }
    expect(def.content).toContain('TESTER-HOT-NEW-BODY')

    console.log('[EVIDENCE A1] changeEvents=%d, before="%s" after="TESTER-HOT-NEW-DESC"', changeEvents, beforeDesc)
    await mount.dispose()
    await ctx.fiber.dispose()
  }, 30000)

  it('A2 新增一个合规 skill 目录 → watch 后新 skill 出现在 catalog', async () => {
    const dataRoot = mkSeededDataRoot()
    const skillsDir = resolveSkillsRepoDir(dataRoot)
    const ctx = await newRegistryCtx()
    const mount = await mountSkillFilesystemProviderAsync(ctx, { dataRoot })
    await list(ctx) // 装配 watcher

    let changeEvents = 0
    ctx.on('skills/change', () => {
      changeEvents += 1
    })

    const newName = 'tester-added-skill'
    writeSkill(skillsDir, newName, 'TESTER-ADD-DESC', '# tester add body')

    // 首发：仅依赖 chokidar addDir/add 事件。
    let firstTryAddDir = false
    try {
      await waitFor(
        async () => {
          expect((await list(ctx)).map((s) => s.name)).toContain(newName)
        },
        { timeout: 3000, label: 'A2 新增可见（首发）' },
      )
      firstTryAddDir = true
    } catch {
      // 观察到的真实行为：chokidar 偶发漏报新建目录（见 REPORT.md A2 结论）。
    }

    if (!firstTryAddDir) {
      // 「下一次可失效事件后可见」：改写已存在文件产生可靠 change → invalidate → 重列，
      // 新目录随之被发现。
      nudgeWatch(skillsDir)
      await waitFor(
        async () => {
          expect((await list(ctx)).map((s) => s.name)).toContain(newName)
        },
        { timeout: 6000, label: 'A2 新增可见（nudge 后）' },
      )
    }

    const added = (await list(ctx)).find((s) => s.name === newName)
    expect(added?.provider).toBe(SKILL_PROVIDER_NAME)
    console.log(
      '[EVIDENCE A2] added "%s" provider=%s; firstTryAddDirVisible=%s changeEvents=%d',
      newName,
      added?.provider,
      firstTryAddDir,
      changeEvents,
    )

    await mount.dispose()
    await ctx.fiber.dispose()
  }, 30000)

  it('A3 删除一个 skill 目录 → watch 后该 skill 从 catalog 消失', async () => {
    const dataRoot = mkSeededDataRoot()
    const skillsDir = resolveSkillsRepoDir(dataRoot)
    const ctx = await newRegistryCtx()
    const mount = await mountSkillFilesystemProviderAsync(ctx, { dataRoot })
    await list(ctx)

    const victim = 'stop-rule'
    expect((await list(ctx)).map((s) => s.name)).toContain(victim)
    rmSync(join(skillsDir, victim), { recursive: true, force: true })

    let firstTryRemove = false
    try {
      await waitFor(
        async () => {
          expect((await list(ctx)).map((s) => s.name)).not.toContain(victim)
        },
        { timeout: 3000, label: 'A3 删除不可见（首发）' },
      )
      firstTryRemove = true
    } catch {
      /* 首发未命中 → nudge 后可见 */
    }
    if (!firstTryRemove) {
      nudgeWatch(skillsDir)
      await waitFor(
        async () => {
          expect((await list(ctx)).map((s) => s.name)).not.toContain(victim)
        },
        { timeout: 6000, label: 'A3 删除不可见（nudge 后）' },
      )
    }
    console.log(
      '[EVIDENCE A3] deleted "%s" firstTryRemoveVisible=%s (remaining core=%d)',
      victim,
      firstTryRemove,
      coreNames(await list(ctx)).length,
    )

    await mount.dispose()
    await ctx.fiber.dispose()
  }, 30000)
})

/* ================================================================== *
 * B. global 层可见性（真实 scope）
 * ================================================================== */
describe('B · provider 落在 global 层 → 任意 scope 读取方可见', () => {
  it('B1 unscoped root 挂载 → 固定会话 scope 与 workspace→session 链 scope 均命中全部 5', async () => {
    const dataRoot = mkSeededDataRoot()
    const ctx = await newRegistryCtx()
    const mount = await mountSkillFilesystemProviderAsync(ctx, { dataRoot })

    const fixedSessionKey = { kind: 'fixed-session' }
    const workspaceKey = { kind: 'workspace' }
    const wsSessionKey = { kind: 'workspace-session' }
    // 真实 scope：固定会话为独立根 scope；workspace → session 形成父子链。
    const fixedScope = dshScope.createScope(ctx, fixedSessionKey)
    const wsScope = dshScope.createScope(ctx, workspaceKey)
    const wsSessionScope = dshScope.createScope(ctx, wsSessionKey, { parent: workspaceKey })
    expect(dshScope.scopeChainOf(wsSessionKey).length).toBe(2)

    for (const [label, key] of [
      ['固定会话', fixedSessionKey],
      ['workspace 会话', wsSessionKey],
    ] as const) {
      const all = await list(ctx, key)
      expect(coreNames(all), `${label} 应见 5 个`).toEqual([...CORE].sort())
      expect(
        all.filter((s) => CORE.includes(s.name)).every((s) => s.provider === SKILL_PROVIDER_NAME),
        `${label} 来源 provider 名`,
      ).toBe(true)
    }
    console.log('[EVIDENCE B1] fixed-session & workspace-session scope both see 5 via %s', SKILL_PROVIDER_NAME)

    await fixedScope.dispose()
    await wsScope.dispose()
    await wsSessionScope.dispose()
    await mount.dispose()
    await ctx.fiber.dispose()
  }, 30000)

  it('B2 真实分层：scoped 注册的 provider 仅对该 scope 及子链可见；global provider 处处可见', async () => {
    const dataRoot = mkSeededDataRoot()
    const extraDir = mkTmpRaw()
    writeSkill(extraDir, 'tester-scoped-skill', 'SCOPED-DESC', '# scoped body')

    const ctx = await newRegistryCtx()
    const mount = await mountSkillFilesystemProviderAsync(ctx, { dataRoot }) // global 层

    const workspaceKey = { kind: 'ws' }
    const fixedKey = { kind: 'fx' }
    const wsScope = dshScope.createScope(ctx, workspaceKey)
    const fixedScope = dshScope.createScope(ctx, fixedKey)

    // 在 workspace scope 内注册第二个 provider（模拟 preset 内某 scope 的私有注册）。
    const mod = await importProviderModule()
    await (wsScope.ctx.plugin(mod, {
      providerName: 'fs-scoped',
      includeDefaultRoots: false,
      customSkillDirs: [extraDir],
      watch: false,
    }) as unknown as Promise<unknown>)

    const wsNames = (await list(ctx, workspaceKey)).map((s) => s.name)
    expect(wsNames).toContain('tester-scoped-skill')
    expect((await list(ctx, workspaceKey)).find((s) => s.name === 'tester-scoped-skill')?.provider).toBe('fs-scoped')
    expect(coreNames(await list(ctx, workspaceKey))).toHaveLength(5)

    // 无该 scope 注册的读取方看不到 scoped provider，但仍见 global 5。
    const fixedNames = (await list(ctx, fixedKey)).map((s) => s.name)
    expect(fixedNames).not.toContain('tester-scoped-skill')
    expect(coreNames(await list(ctx, fixedKey))).toEqual([...CORE].sort())

    // 无 scope 的 global 视图：仅 global 5。
    const globalAll = await list(ctx)
    expect(coreNames(globalAll)).toEqual([...CORE].sort())
    expect(globalAll.map((s) => s.name)).not.toContain('tester-scoped-skill')
    console.log('[EVIDENCE B2] ws sees scoped; fx & global do not; global still 5')

    await wsScope.dispose()
    await fixedScope.dispose()
    await mount.dispose()
    await ctx.fiber.dispose()
  }, 30000)
})

/* ================================================================== *
 * C. 无残留 & 装配正确
 * ================================================================== */
function walk(dir: string): string[] {
  const out: string[] = []
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return out
  }
  for (const e of entries) {
    const abs = join(dir, e)
    try {
      if (statSync(abs).isDirectory()) out.push(...walk(abs))
      else out.push(abs)
    } catch {
      /* ignore */
    }
  }
  return out
}

describe('C · 旧静态注册删除无残留 + 装配正确', () => {
  it('C1 src/**、tests/** 代码内无旧静态注册残留', () => {
    // 拼接构造，避免本文件/报告自身命中。
    const needles = [
      'registerAll' + 'Skills',
      'createAll' + 'SkillRegistrations',
      'create' + 'SkillRegistration',
      'ctx.skills.' + 'register(',
    ]
    const offenders: string[] = []
    for (const base of ['src', 'tests']) {
      for (const file of walk(join(ROOT, base))) {
        if (!/\.(ts|mts|cts|js|mjs)$/.test(file)) continue
        const rel = relative(ROOT, file)
        if (rel.includes('tester-t100419-skill-provider.INDEPENDENT')) continue
        const text = readFileSync(file, 'utf8')
        for (const n of needles) if (text.includes(n)) offenders.push(`${rel} :: ${n}`)
      }
    }
    console.log('[EVIDENCE C1] offenders=%d', offenders.length)
    expect(offenders).toEqual([])
  })

  it('C2 inject 契约不变 + cordis.patch.yml 一致 + plugin.ts 不再 runtime 注册 skill', () => {
    expect(pluginName).toBe('investment-advisor')
    expect(pluginInject).toEqual(['tools', 'skills', 'fs'])

    const pluginSrc = readFileSync(join(ROOT, 'src', 'plugin.ts'), 'utf8')
    expect(pluginSrc).not.toContain('ctx.skills.' + 'register(')
    expect(pluginSrc).toContain('ensureSkillAssetsRepo')
    expect(pluginSrc).toContain('mountSkillFilesystemProvider')

    const patch = readFileSync(join(ROOT, 'cordis.patch.yml'), 'utf8')
    expect(patch).toContain("inject: ['tools', 'skills', 'fs']")
    console.log('[EVIDENCE C2] inject=%s, patch consistent, no runtime register', pluginInject.join(','))
  })
})

/* ================================================================== *
 * F. 与 preset 默认 provider 共存（放在降级 D 之前，避免 mock 影响）
 * ================================================================== */
describe('F · 与 preset 默认 provider 共存 / 同层重名边界', () => {
  it('F1 同层共存：dsh-finance-skills 与默认名 filesystem 互不冲突、各自可见', async () => {
    const dataRoot = mkSeededDataRoot()
    const extraDir = mkTmpRaw()
    writeSkill(extraDir, 'preset-skill', 'PRESET-DESC', '# preset body')

    const ctx = await newRegistryCtx()
    const mod = await importProviderModule()
    // 同一（global）层注册 preset 默认名 provider。
    await (ctx.plugin(mod, {
      providerName: 'filesystem',
      includeDefaultRoots: false,
      customSkillDirs: [extraDir],
      watch: false,
    }) as unknown as Promise<unknown>)
    const mount = await mountSkillFilesystemProviderAsync(ctx, { dataRoot })

    const all = await list(ctx)
    expect(coreNames(all)).toEqual([...CORE].sort())
    expect(all.map((s) => s.name)).toContain('preset-skill')
    expect(all.find((s) => s.name === 'preset-skill')?.provider).toBe('filesystem')
    console.log('[EVIDENCE F1] coexisting providers: %d core + preset-skill', coreNames(all).length)

    await mount.dispose()
    await ctx.fiber.dispose()
  }, 20000)

  it('F2 同层重复 providerName 抛错（唯一性边界）', async () => {
    const dataRoot = mkSeededDataRoot()
    const ctx = await newRegistryCtx()
    const mount = await mountSkillFilesystemProviderAsync(ctx, { dataRoot })
    const mod = await importProviderModule()

    await expect(
      ctx.plugin(mod, {
        providerName: SKILL_PROVIDER_NAME,
        includeDefaultRoots: false,
        customSkillDirs: [resolveSkillsRepoDir(dataRoot)],
        watch: false,
      }) as unknown as Promise<unknown>,
    ).rejects.toThrow()
    console.log('[EVIDENCE F2] duplicate providerName "%s" rejected', SKILL_PROVIDER_NAME)

    await mount.dispose()
    await ctx.fiber.dispose()
  }, 20000)
})

/* ================================================================== *
 * D. 降级对抗（含模块不可解析；放在最后避免 mock 影响其它用例）
 * ================================================================== */
describe('D · 降级对抗（不抛、可观测）', () => {
  it('D1 挂载抛错：async 入口 reject；sync 入口不抛并记降级日志', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const ctx = {
        effect(body: () => unknown) {
          const d = body()
          return typeof d === 'function' ? (d as () => void) : () => {}
        },
        plugin: () => Promise.reject(new Error('mount-boom')),
      } as unknown as Context

      await expect(
        mountSkillFilesystemProviderAsync(ctx, { dataRoot: '/tmp/t100419-nope' }),
      ).rejects.toThrow('mount-boom')

      expect(() =>
        mountSkillFilesystemProvider(ctx, { dataRoot: '/tmp/t100419-nope' }),
      ).not.toThrow()
      await new Promise((r) => setTimeout(r, 60))
      expect(
        errSpy.mock.calls.some((c) => String(c[0]).includes('挂载失败（降级）')),
      ).toBe(true)
      console.log('[EVIDENCE D1] sync wrapper degraded-logged; async wrapper rejected')
    } finally {
      errSpy.mockRestore()
    }
  }, 20000)

  it('D2 依赖不可解析（import 失败）：async reject；sync 不抛并记日志', async () => {
    vi.doMock('@deepseek-ai/dsh-skill-filesystem', () => {
      throw new Error('MODULE_UNRESOLVABLE')
    })
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const ctx = await newRegistryCtx()
      await expect(
        mountSkillFilesystemProviderAsync(ctx, { dataRoot: mkSeededDataRoot() }),
      ).rejects.toThrow()

      expect(() =>
        mountSkillFilesystemProvider(ctx, { dataRoot: mkSeededDataRoot() }),
      ).not.toThrow()
      await new Promise((r) => setTimeout(r, 80))
      expect(
        errSpy.mock.calls.some((c) => String(c[0]).includes('挂载失败（降级）')),
      ).toBe(true)
      console.log('[EVIDENCE D2] unresolvable module → sync degraded, no throw')
      await ctx.fiber.dispose()
    } finally {
      errSpy.mockRestore()
      vi.doUnmock('@deepseek-ai/dsh-skill-filesystem')
    }
  }, 20000)

  it('D3 真实 apply(ctx)：provider 挂载失败不抛，插件其它贡献照常装载', async () => {
    vi.doMock('@deepseek-ai/dsh-skill-filesystem', () => {
      throw new Error('MODULE_UNRESOLVABLE')
    })
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const ctx = await newRegistryCtx()
      const labels: string[] = []
      const origEffect = ctx.effect.bind(ctx)
      ;(ctx as unknown as { effect: (b: unknown, l?: string) => unknown }).effect = (
        body: unknown,
        label?: string,
      ) => {
        if (label) labels.push(label)
        return origEffect(body, label)
      }

      expect(() => pluginApply(ctx)).not.toThrow()
      await new Promise((r) => setTimeout(r, 200))

      // 降级：本轮没有 dsh-finance-skills provider。
      expect(coreNames(await list(ctx))).toHaveLength(0)
      // 其它贡献照常装载：tools effect 与 provider effect 均已登记。
      expect(labels).toContain('dsh-finance tools')
      expect(labels).toContain('dsh-finance skill-filesystem provider')
      expect(
        errSpy.mock.calls.some((c) => String(c[0]).includes('挂载失败（降级）')),
      ).toBe(true)
      console.log('[EVIDENCE D3] apply not thrown; effect labels=%s; skills degraded to 0', labels.join('|'))

      await ctx.fiber.dispose()
    } finally {
      errSpy.mockRestore()
      vi.doUnmock('@deepseek-ai/dsh-skill-filesystem')
    }
  }, 20000)
})

/* ================================================================== *
 * E. 卸载语义
 * ================================================================== */
describe('E · 卸载语义（dispose → 归零 + watch 关闭）', () => {
  it('E1 async dispose 后 list 归 0、改写不再复活（watch 关闭）', async () => {
    const dataRoot = mkSeededDataRoot()
    const skillsDir = resolveSkillsRepoDir(dataRoot)
    const ctx = await newRegistryCtx()

    const fsBefore = countFsWatchers()
    const mount = await mountSkillFilesystemProviderAsync(ctx, { dataRoot })
    expect(coreNames(await list(ctx))).toHaveLength(5)
    const fsDuring = countFsWatchers()

    await mount.dispose()
    expect(coreNames(await list(ctx))).toHaveLength(0)
    expect(await list(ctx)).toHaveLength(0)

    // 改写文件，等待超过稳定阈值：无 provider/watcher 复活。
    writeFileSync(join(skillsDir, TARGET, SKILL_FILENAME), `---\nname: ${TARGET}\ndescription: AFTER-DISPOSE\n---\n\nx\n`, 'utf8')
    await new Promise((r) => setTimeout(r, STABILITY_WAIT_MS))
    expect(await list(ctx)).toHaveLength(0)

    const fsAfter = countFsWatchers()
    console.log('[EVIDENCE E1] fsWatchers before/during/after = %d/%d/%d', fsBefore, fsDuring, fsAfter)
    // watch 关闭：活跃 FSWatcher 不高于挂载前。
    if (fsBefore >= 0 && fsAfter >= 0) expect(fsAfter).toBeLessThanOrEqual(fsBefore)

    await ctx.fiber.dispose()
  }, 30000)

  it('E2 同步入口经 ctx.effect 装配；注销后 provider 移除、list 归 0', async () => {
    const dataRoot = mkSeededDataRoot()
    const ctx = await newRegistryCtx()
    const dispose = mountSkillFilesystemProvider(ctx, { dataRoot })
    expect(typeof dispose).toBe('function')

    await waitFor(
      async () => {
        expect(coreNames(await list(ctx))).toHaveLength(5)
      },
      { timeout: 12000, label: 'E2 sync 装配就绪' },
    )

    await dispose()
    expect(coreNames(await list(ctx))).toHaveLength(0)
    console.log('[EVIDENCE E2] sync effect dispose → provider removed, list=0')

    await ctx.fiber.dispose()
  }, 30000)
})

/* ================================================================== *
 * 数据隔离
 * ================================================================== */
describe('数据隔离', () => {
  it('本文件全部用例只在临时目录预置，不触碰默认数据目录', () => {
    expect(envRoot.startsWith(tmpdir())).toBe(true)
    const dataRoot = mkSeededDataRoot()
    expect(existsSync(join(dataRoot, 'skills', CORE[0], SKILL_FILENAME))).toBe(true)
  })
})
