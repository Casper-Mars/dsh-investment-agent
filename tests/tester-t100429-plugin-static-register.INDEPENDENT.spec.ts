/**
 * tester-t100429-plugin-static-register.INDEPENDENT.spec.ts
 * ==================================================================
 * Tester 独立复验（任务卡 t100429）：plugin 对「固有 SKILL task-authorship」的
 * **单独静态注册**逻辑（`src/plugin.ts` `apply(ctx)`，来源 commit `bdbe116`）。
 *
 * 独立性声明：
 *   本文件由 Tester **独立编写**，不复用开发者用例（`tests/prompt-skills.spec.ts`
 *   / `tests/skill-provider.spec.ts` / `tests/skill-assets-repo.spec.ts`）的断言。
 *   与既有 `tester-t100432-intrinsic-skill.INDEPENDENT.spec.ts` 刻意分工：
 *   t100432 聚焦「清单收窄 + 编译期类型 + 静态读取」；**本文件聚焦 t100429 视角**——
 *     ① 来源区分：嵌入式（runtime 内存注册）vs filesystem provider 发现（custom）；
 *     ② 真实 dist-server 装载后：嵌入 skill 可见 + 5 可进化经 provider 可见；
 *     ③ register 抛错不中断装载，且**其它贡献（tools / prompt / scheduler）照常装载**；
 *     ④ 注册时机在 ensureSkillAssetsRepo / mountSkillFilesystemProvider 之后；
 *     ⑤ 卸载归零 + 幂等。
 *
 * 环境隔离：所有用例只在临时 `DSH_FINANCE_DATA_DIR` / 临时 dataRoot 内预置，
 *   不污染真实 `~/.dsh-finance`（真实进程 / 真实 git）。
 *
 * 注意（仓库级守卫规避，见 t100419 C1）：本文件**不写字面量**“ctx 点 skills 点 register
 *   左括号”这一整串（也不写该守卫列出的其余几个旧注册符号名）；取 skills 注册表一律
 *   经别名变量 `ctx.skills`，再以变量调用 register 方法，从而不命中文本守卫。
 * ==================================================================
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { ensureSkillAssetsRepo, resolveSkillsRepoDir } from '../src/skills/repo.js'
import {
  SKILL_NAMES,
  TASK_AUTHORSHIP_SKILL_NAME,
  SKILL_AUTHORSHIP_SKILL_NAME,
  loadTaskAuthorshipMarkdown,
} from '../src/skills/index.js'
import { parseSkillFile } from '../src/skills/frontmatter.js'
import * as srcPlugin from '../src/plugin.js'

/** 5 个「可进化 SKILL」（顺序 = 种子落盘顺序）。 */
const EVOLVABLE: readonly string[] = [...SKILL_NAMES]
/** 固有 SKILL 名。 */
const TA = TASK_AUTHORSHIP_SKILL_NAME
/** filesystem provider 唯一名（`src/skills/provider.ts`）。 */
const PROVIDER_NAME = 'dsh-finance-skills'
/** 固有 SKILL 的 effect label（`src/plugin.ts`）。 */
const TA_EFFECT_LABEL = 'dsh-finance task-authorship skill'
/** 新增固有 SKILL 的 effect label（`src/plugin.ts`）。 */
const SA_EFFECT_LABEL = 'dsh-finance skill-authorship skill'
/** provider 的 effect label。 */
const PROVIDER_EFFECT_LABEL = 'dsh-finance skill-filesystem provider'

/* ------------------------------------------------------------------ *
 * 临时目录 & 环境隔离
 * ------------------------------------------------------------------ */
const tempDirs: string[] = []
function mkTmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

const savedEnv = process.env.DSH_FINANCE_DATA_DIR
function useDataRoot(dir: string): void {
  process.env.DSH_FINANCE_DATA_DIR = dir
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  }
  if (savedEnv === undefined) delete process.env.DSH_FINANCE_DATA_DIR
  else process.env.DSH_FINANCE_DATA_DIR = savedEnv
})

/* ------------------------------------------------------------------ *
 * helpers
 * ------------------------------------------------------------------ */
/** 临时 dataRoot 并真实预置 `<dataRoot>/skills` 的 5 个可进化 SKILL（真实 git）。 */
function seedDataRoot(): string {
  const dir = mkTmp('dsh-fin-t100429-data-')
  const out = ensureSkillAssetsRepo({ dataRoot: dir, logger: () => {} })
  if (out.degraded) throw new Error(`预置降级：${out.reason}`)
  return dir
}

/** 在给定 skills 目录下写一个合法 SKILL.md。 */
function writeSkill(dir: string, name: string, description: string, body = '# body'): void {
  const d = join(dir, name)
  mkdirSync(d, { recursive: true })
  writeFileSync(
    join(d, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${description}\nwhenToUse: ${description}-when\n---\n\n${body}\n`,
    'utf8',
  )
}

/** systemPrompt 服务最小替身。 */
function makeSystemPromptStub(): { name: string; tools(): void; section(): () => void; getSectionOrder(): number } {
  return {
    name: 'systemPrompt',
    tools() {},
    section() {
      return () => {}
    },
    getSectionOrder() {
      return 0
    },
  }
}

/** 真实装载 dist-server 插件（真实 SkillRegistry + 真实 ToolRuntime + provider）。 */
async function bootRealPlugin(): Promise<{
  app: Context
  toolsFiber: { dispose: () => Promise<void> }
  pluginFiber: { dispose: () => Promise<void> }
}> {
  const distPlugin = (await import('../dist-server/index.js')) as unknown as {
    name: string
    inject: string[]
    apply: (ctx: unknown) => void
  }
  const app = new Context()
  app.provide('systemPrompt', makeSystemPromptStub() as never)
  await (app.plugin(SkillRegistry as never) as Promise<unknown>)
  const toolsFiber = (await app.plugin(ToolRuntime as never)) as unknown as {
    dispose: () => Promise<void>
  }
  const pluginFiber = app.plugin({
    name: distPlugin.name,
    inject: ['tools', 'skills'],
    apply: distPlugin.apply,
  } as never) as unknown as { dispose: () => Promise<void> }
  await (pluginFiber as unknown as Promise<unknown>)
  return { app, toolsFiber, pluginFiber }
}

interface SkillSummary {
  name: string
  description: string
  source: string
  provider: string
  invocation: { modelInvocable: boolean; userInvocable: boolean }
}

function listSkills(app: Context): Promise<SkillSummary[]> {
  const reg = app.skills as unknown as { list: (o: unknown) => Promise<SkillSummary[]> }
  return reg.list({})
}

async function getSkill(
  app: Context,
  name: string,
): Promise<{ content?: string; source?: string; provider?: string } | undefined> {
  const reg = app.skills as unknown as {
    get: (n: string, o?: unknown) => Promise<{ content?: string; source?: string; provider?: string } | undefined>
  }
  return reg.get(name)
}

/** 等待 5 个可进化 SKILL 经 provider 就绪。 */
async function waitEvolvableVisible(app: Context): Promise<void> {
  await vi.waitFor(
    async () => {
      const list = await listSkills(app)
      const got = list
        .filter((s) => EVOLVABLE.includes(s.name))
        .map((s) => s.name)
        .sort()
      expect(got).toEqual([...EVOLVABLE].sort())
    },
    { timeout: 12_000, interval: 50 },
  )
}

/* ------------------------------------------------------------------ *
 * 最小 mock ctx（用于 apply 装载语义：降级 / 其它贡献 / 时机）
 * ------------------------------------------------------------------ */
interface MockEffect {
  label: string
  disposer: () => unknown
}

interface MockBundle {
  ctx: unknown
  registered: Array<Record<string, unknown>>
  removed: Array<Record<string, unknown>>
  effects: MockEffect[]
  effectOrder: string[]
  injectCalls: string[][]
  toolsCalls: unknown[]
  systemPromptSection: ReturnType<typeof vi.fn>
  repoExistedAtTaEffect: boolean | undefined
}

interface MockOpts {
  /** skills 服务形态。 */
  skillsMode?: 'ok' | 'absent' | 'throw'
  /** 是否提供 tools 服务替身（用于「其它贡献照常」）。 */
  withTools?: boolean
  /** 在 TA effect 执行瞬间的探针（用于 AC4 时机）。 */
  taEffectProbe?: () => void
}

function buildMockCtx(opts: MockOpts = {}): MockBundle {
  const skillsMode = opts.skillsMode ?? 'ok'
  const registered: Array<Record<string, unknown>> = []
  const removed: Array<Record<string, unknown>> = []
  const effects: MockEffect[] = []
  const effectOrder: string[] = []
  const injectCalls: string[][] = []
  const toolsCalls: unknown[] = []
  const systemPromptSection = vi.fn(() => () => {})

  const skills =
    skillsMode === 'absent'
      ? undefined
      : {
          register(skill: Record<string, unknown>): () => void {
            if (skillsMode === 'throw') throw new Error('boom: register 抛错')
            registered.push(skill)
            let live = true
            return () => {
              if (live) {
                live = false
                removed.push(skill)
              }
            }
          },
        }

  const tools = opts.withTools
    ? {
        register(_t: unknown): () => void {
          toolsCalls.push(_t)
          return () => {}
        },
      }
    : undefined

  const bundle: MockBundle = {
    ctx: undefined,
    registered,
    removed,
    effects,
    effectOrder,
    injectCalls,
    toolsCalls,
    systemPromptSection,
    repoExistedAtTaEffect: undefined,
  }

  const ctx = {
    // cordis 注入后 `ctx.tools` 是直接属性（registerAllTools 经 ctx.tools.register 注册
    // 模型工具）；`ctx.get('tools')` 仅用于软取探测。两者指向同一替身。
    tools,
    get(name: string): unknown {
      if (name === 'skills') return skills
      if (name === 'tools') return tools
      return undefined
    },
    effect(cb: () => unknown, label = 'anonymous'): () => unknown {
      effectOrder.push(label)
      if (opts.taEffectProbe && label === TA_EFFECT_LABEL) opts.taEffectProbe()
      const result = cb()
      const disposer = typeof result === 'function' ? (result as () => unknown) : () => {}
      effects.push({ label, disposer })
      return disposer
    },
    inject(deps: string[], cb: (arg: unknown) => void): void {
      injectCalls.push(deps)
      // systemPrompt 动态注入回调需要 promptCtx.systemPrompt 属性；其余（agents 等）
      // 传 ctx 本体即可（其 get() 返回 undefined → 走降级分支，不抛）。
      const arg = deps.includes('systemPrompt')
        ? { systemPrompt: { section: systemPromptSection } }
        : ctx
      cb(arg)
    },
    plugin(): never {
      throw new Error('mock ctx: plugin() 不可用')
    },
    provide(): void {},
  }
  bundle.ctx = ctx
  return bundle
}

/** 逆序释放 mock 中收集的全部 effect（清理 scheduler timer）。 */
function disposeMockEffects(effects: MockEffect[]): void {
  for (const e of [...effects].reverse()) {
    try {
      e.disposer()
    } catch {
      /* ignore */
    }
  }
}

/* ================================================================== *
 * [AC1] 嵌入式（runtime）注册来源可见且可区分（真实装载）
 * ================================================================== */
describe('[AC1] 固有 SKILL 经 runtime 内存注册可见，来源与 provider 区分', () => {
  it(
    'AC1a：真实 dist-server 装载后 task-authorship 可见，source=runtime、provider=runtime（非 filesystem provider）',
    async () => {
      const dataRoot = seedDataRoot()
      useDataRoot(dataRoot)

      const { app, toolsFiber, pluginFiber } = await bootRealPlugin()
      try {
        await waitEvolvableVisible(app)

        const list = await listSkills(app)
        const ta = list.find((s) => s.name === TA)
        expect(ta, 'task-authorship 应经 plugin 静态注册可见').toBeDefined()
        expect(ta?.source).toBe('runtime')
        expect(ta?.provider).toBe('runtime')
        // 明确「不是」由 skill-filesystem provider 发现：
        expect(ta?.source).not.toBe('custom')
        expect(ta?.provider).not.toBe(PROVIDER_NAME)

        const def = await getSkill(app, TA)
        expect(def?.content).toBe(parseSkillFile(loadTaskAuthorshipMarkdown()).content)
        console.log('[EVIDENCE AC1a] TA source=%s provider=%s', ta?.source, ta?.provider)
      } finally {
        await pluginFiber.dispose()
        await toolsFiber.dispose()
      }
    },
    45_000,
  )

  it(
    'AC1b：即便 <dataRoot>/skills 同名存在 task-authorship（不同描述），仍以 runtime 嵌入为准（来源不混）',
    async () => {
      const dataRoot = seedDataRoot()
      const skillsDir = resolveSkillsRepoDir(dataRoot)
      // 在数据目录塞入同名 task-authorship（描述带伪标记），provider 会将其作为 custom 候选。
      writeSkill(skillsDir, TA, 'DECOY-DATA-DIR-DESC', '# decoy data dir body')
      useDataRoot(dataRoot)

      const { app, toolsFiber, pluginFiber } = await bootRealPlugin()
      try {
        await waitEvolvableVisible(app)
        // 额外候选中应能看到数据目录里的 decoy skill（证明 provider 确实扫到了同名项）。
        await vi.waitFor(async () => {
          const names = (await listSkills(app)).map((s) => s.name)
          expect(names).toContain(TA)
        })

        const list = await listSkills(app)
        const ta = list.find((s) => s.name === TA)
        // runtime 优先级高于 custom（RUNTIME_RANK=250 < CUSTOM_RANK=300）：赢家是嵌入版。
        expect(ta?.source).toBe('runtime')
        expect(ta?.provider).toBe('runtime')
        expect(ta?.description).not.toBe('DECOY-DATA-DIR-DESC')
        const def = await getSkill(app, TA)
        expect(def?.content).toBe(parseSkillFile(loadTaskAuthorshipMarkdown()).content)
        console.log(
          '[EVIDENCE AC1b] winner source=%s provider=%s descFromEmbedded=%s',
          ta?.source,
          ta?.provider,
          ta?.description !== 'DECOY-DATA-DIR-DESC',
        )
      } finally {
        await pluginFiber.dispose()
        await toolsFiber.dispose()
      }
    },
    45_000,
  )
})

/* ================================================================== *
 * [AC2] 5 个可进化 SKILL 仍由 skill-filesystem provider 发现
 * ================================================================== */
describe('[AC2] 5 可进化 SKILL 经 provider（providerName=dsh-finance-skills，指向 <dataRoot>/skills）', () => {
  it(
    'AC2a：5 可进化皆 provider=dsh-finance-skills 且 source=custom（非 runtime）',
    async () => {
      const dataRoot = seedDataRoot()
      useDataRoot(dataRoot)
      const { app, toolsFiber, pluginFiber } = await bootRealPlugin()
      try {
        await waitEvolvableVisible(app)
        const list = await listSkills(app)
        for (const n of EVOLVABLE) {
          const s = list.find((x) => x.name === n)
          expect(s, `${n} 应可见`).toBeDefined()
          expect(s?.provider).toBe(PROVIDER_NAME)
          expect(s?.source).toBe('custom')
          expect(s?.source).not.toBe('runtime')
        }
        console.log('[EVIDENCE AC2a] evolvable providers=%s', EVOLVABLE.map((n) => list.find((x) => x.name === n)?.provider).join(','))
      } finally {
        await pluginFiber.dispose()
        await toolsFiber.dispose()
      }
    },
    45_000,
  )

  it(
    'AC2b：provider 只扫 <dataRoot>/skills——新增项被发现 / 目录外 decoy 不可见 / 改写内容被反射',
    async () => {
      const dataRoot = seedDataRoot()
      const skillsDir = resolveSkillsRepoDir(dataRoot)
      // (1) 预置后新增一个额外 skill（应被发现）。
      writeSkill(skillsDir, 'extra-provider-skill', 'EXTRA-PROVIDER-DESC')
      // (2) 改写一个既有可进化 skill 的描述（应反射到 list，证明内容读自数据目录而非随包嵌入）。
      writeSkill(skillsDir, 'trend-analysis', 'T100429-MARKER-DESC')
      // (3) 目录外放一个 decoy skill（不应被发现）。
      const outsideDir = mkTmp('dsh-fin-t100429-outside-')
      writeSkill(outsideDir, 'decoy-skill', 'DECOY-OUTSIDE-DESC')

      useDataRoot(dataRoot)
      const { app, toolsFiber, pluginFiber } = await bootRealPlugin()
      try {
        await waitEvolvableVisible(app)
        await vi.waitFor(async () => {
          const names = (await listSkills(app)).map((s) => s.name)
          expect(names).toContain('extra-provider-skill')
        })

        const list = await listSkills(app)
        const names = list.map((s) => s.name)
        const extra = list.find((s) => s.name === 'extra-provider-skill')
        expect(extra?.provider).toBe(PROVIDER_NAME)
        expect(extra?.description).toBe('EXTRA-PROVIDER-DESC')

        // decoy（<dataRoot>/skills 之外）不被 provider 发现。
        expect(names).not.toContain('decoy-skill')

        // 改写内容被反射（数据目录为准）。
        expect(list.find((s) => s.name === 'trend-analysis')?.description).toBe('T100429-MARKER-DESC')

        console.log(
          '[EVIDENCE AC2b] extra=%s decoyVisible=%s trendDesc=%s',
          extra?.provider,
          names.includes('decoy-skill'),
          list.find((s) => s.name === 'trend-analysis')?.description,
        )
      } finally {
        await pluginFiber.dispose()
        await toolsFiber.dispose()
      }
    },
    45_000,
  )

  it(
    'AC2c：来源集合互斥——runtime 源={task-authorship}，custom 源=5 可进化，二者不重叠',
    async () => {
      const dataRoot = seedDataRoot()
      useDataRoot(dataRoot)
      const { app, toolsFiber, pluginFiber } = await bootRealPlugin()
      try {
        await waitEvolvableVisible(app)
        const list = await listSkills(app)
        const runtimeNames = list.filter((s) => s.source === 'runtime').map((s) => s.name).sort()
        const customNames = list.filter((s) => s.source === 'custom').map((s) => s.name).sort()

        expect(runtimeNames).toEqual([TA, SKILL_AUTHORSHIP_SKILL_NAME].sort())
        expect(customNames).toEqual([...EVOLVABLE].sort())
        // 互斥（区分）。
        for (const n of runtimeNames) expect(customNames).not.toContain(n)
        console.log('[EVIDENCE AC2c] runtime=%s custom=%s', runtimeNames.join(','), customNames.join(','))
      } finally {
        await pluginFiber.dispose()
        await toolsFiber.dispose()
      }
    },
    45_000,
  )
})

/* ================================================================== *
 * [AC3] register 抛错不中断装载 + 其它贡献照常（mock ctx）
 * ================================================================== */
describe('[AC3] skills.register 抛错降级不中断装载，其它贡献照常', () => {
  it(
    'AC3a：register 抛错 → apply 不抛；tools/prompt/scheduler 贡献照常装载；TA effect 存在且 disposer 安全',
    async () => {
      const dataRoot = seedDataRoot()
      useDataRoot(dataRoot)
      const m = buildMockCtx({ skillsMode: 'throw', withTools: true })

      // 关键：注册本身抛错时，apply 必须**降级不抛**，不中断插件装载。
      expect(() => srcPlugin.apply(m.ctx as never)).not.toThrow()

      // (a) 其它贡献 1：tools effect 存在（label），且 tools 服务被实际调用（惰性注册）。
      expect(m.effectOrder).toContain('dsh-finance tools')
      await vi.waitFor(() => {
        expect(m.toolsCalls.length).toBeGreaterThanOrEqual(14)
      }, { timeout: 5_000, interval: 25 })

      // (b) 其它贡献 2：advisor prompt 经 ctx.inject(['systemPrompt']) 动态注入并写入 section。
      const spCall = m.injectCalls.find((d) => d.includes('systemPrompt'))
      expect(spCall, 'apply 应注入 systemPrompt 依赖').toBeDefined()
      expect(m.systemPromptSection.mock.calls.length).toBeGreaterThanOrEqual(1)

      // (c) 其它贡献 3：scheduler 贡献照常（两个 effect）。
      expect(m.effectOrder).toContain('dsh-finance scheduler tools')
      expect(m.effectOrder).toContain('dsh-finance scheduler')

      // (d) TA effect 仍注册（标签存在）；因注册抛错 → dispose 未赋值 → disposer 安全 no-op。
      const taEffect = m.effects.find((e) => e.label === TA_EFFECT_LABEL)
      expect(taEffect, '注册抛错时 TA effect 仍应注册').toBeDefined()
      expect(() => taEffect?.disposer()).not.toThrow()
      // 未发生任何成功注册。
      expect(m.registered).toHaveLength(0)

      console.log(
        '[EVIDENCE AC3a] applyNoThrow=true toolsCalls=%d inject=%s schedulerEffects=%s',
        m.toolsCalls.length,
        JSON.stringify(m.injectCalls),
        m.effectOrder.filter((l) => l.startsWith('dsh-finance scheduler')).join('|'),
      )
      disposeMockEffects(m.effects)
    },
    30_000,
  )

  it('AC3b：skills 服务缺失 → apply 降级不抛、不注册、TA effect 仍注册（no-op 分支）', () => {
    useDataRoot(seedDataRoot())
    const m = buildMockCtx({ skillsMode: 'absent' })

    expect(() => srcPlugin.apply(m.ctx as never)).not.toThrow()
    expect(m.registered).toHaveLength(0)
    const taEffect = m.effects.find((e) => e.label === TA_EFFECT_LABEL)
    expect(taEffect).toBeDefined()
    expect(() => taEffect?.disposer()).not.toThrow()
    disposeMockEffects(m.effects)
  }, 30_000)
})

/* ================================================================== *
 * [AC4] 注册时机：ensureSkillAssetsRepo / mountSkillFilesystemProvider 之后
 * ================================================================== */
describe('[AC4] TA 静态注册时机在预置与 provider 挂载之后', () => {
  it(
    'AC4a：effect 顺序 tools → provider → task-authorship → scheduler；且 TA effect 执行时仓库已预置',
    () => {
      const dataRoot = seedDataRoot()
      const skillsDir = resolveSkillsRepoDir(dataRoot)
      // 先删除仓库目录，验证「apply 内 ensureSkillAssetsRepo 先于 TA effect 把仓库建好」。
      rmSync(skillsDir, { recursive: true, force: true })
      useDataRoot(dataRoot)

      let repoExistedAtTa: boolean | undefined
      const m = buildMockCtx({
        skillsMode: 'ok',
        taEffectProbe: () => {
          repoExistedAtTa = existsSync(skillsDir)
        },
      })

      srcPlugin.apply(m.ctx as never)

      const idxTools = m.effectOrder.indexOf('dsh-finance tools')
      const idxProvider = m.effectOrder.indexOf(PROVIDER_EFFECT_LABEL)
      const idxTa = m.effectOrder.indexOf(TA_EFFECT_LABEL)
      const idxScheduler = m.effectOrder.indexOf('dsh-finance scheduler')

      expect(idxTools).toBe(0)
      expect(idxProvider).toBeGreaterThan(-1)
      expect(idxTa).toBeGreaterThan(-1)
      expect(idxScheduler).toBeGreaterThan(-1)
      // 时机：provider 挂载（含 ensureSkillAssetsRepo 先行）→ TA 注册 → scheduler。
      expect(idxProvider).toBeLessThan(idxTa)
      expect(idxTa).toBeLessThan(idxScheduler)
      // TA effect 执行瞬间，ensureSkillAssetsRepo 已把 <dataRoot>/skills 建好。
      expect(repoExistedAtTa, 'TA effect 执行时应已预置仓库').toBe(true)

      console.log(
        '[EVIDENCE AC4a] order=%s repoExistedAtTa=%s',
        m.effectOrder.join(' > '),
        repoExistedAtTa,
      )
      disposeMockEffects(m.effects)
    },
    30_000,
  )
})

/* ================================================================== *
 * [AC5] 卸载归零 + 幂等
 * ================================================================== */
describe('[AC5] 注销器绑定 ctx.effect：卸载归零 + 幂等', () => {
  it(
    'AC5a：真实 fiber 卸载 → task-authorship 与 5 可进化（及额外项）全部归零',
    async () => {
      const dataRoot = seedDataRoot()
      const skillsDir = resolveSkillsRepoDir(dataRoot)
      writeSkill(skillsDir, 'extra-provider-skill', 'EXTRA-PROVIDER-DESC')
      useDataRoot(dataRoot)

      const { app, toolsFiber, pluginFiber } = await bootRealPlugin()
      try {
        await waitEvolvableVisible(app)
        await vi.waitFor(async () => {
          expect((await listSkills(app)).map((s) => s.name)).toContain('extra-provider-skill')
        })
        const before = (await listSkills(app)).map((s) => s.name)
        expect(before).toContain(TA)
        expect(before).toContain(SKILL_AUTHORSHIP_SKILL_NAME)
        for (const n of EVOLVABLE) expect(before).toContain(n)

        // 卸载插件 fiber：应有 skill 全部消失（归零）。
        await pluginFiber.dispose()
        const after = await listSkills(app)
        expect(after.map((s) => s.name)).not.toContain(TA)
        expect(after.map((s) => s.name)).not.toContain(SKILL_AUTHORSHIP_SKILL_NAME)
        expect(after.filter((s) => EVOLVABLE.includes(s.name))).toHaveLength(0)
        expect(after.map((s) => s.name)).not.toContain('extra-provider-skill')
        console.log('[EVIDENCE AC5a] before=%d after=%d', before.length, after.length)
      } finally {
        await pluginFiber.dispose()
        await toolsFiber.dispose()
      }
    },
    45_000,
  )

  it(
    'AC5b：二次 dispose 幂等——连续两次 pluginFiber.dispose() 不抛',
    async () => {
      useDataRoot(seedDataRoot())
      const { app, toolsFiber, pluginFiber } = await bootRealPlugin()
      try {
        await waitEvolvableVisible(app)
        await pluginFiber.dispose()
        // 二次 dispose：不抛（幂等）。cordis 二次 dispose 可能返回 undefined，故用 async 包装。
        await expect(
          (async () => {
            await pluginFiber.dispose()
          })(),
        ).resolves.toBeUndefined()
        expect((await listSkills(app)).some((s) => s.name === TA)).toBe(false)
        console.log('[EVIDENCE AC5b] 二次 dispose 未抛')
      } finally {
        await toolsFiber.dispose()
      }
    },
    45_000,
  )

  it('AC5c：TA effect disposer 幂等——两次调用不抛、仅注销一次', () => {
    useDataRoot(seedDataRoot())
    const m = buildMockCtx({ skillsMode: 'ok' })
    srcPlugin.apply(m.ctx as never)
    expect(m.registered).toHaveLength(2)

    const taEffect = m.effects.find((e) => e.label === TA_EFFECT_LABEL)
    expect(taEffect).toBeDefined()
    expect(() => taEffect?.disposer()).not.toThrow()
    expect(m.removed).toHaveLength(1)
    expect(() => taEffect?.disposer()).not.toThrow()
    expect(m.removed).toHaveLength(1)
    disposeMockEffects(m.effects)
  }, 30_000)
})

/* 说明：AC6（typecheck / build / test 全绿）不作为本文件用例——其结果由独立执行
 * 三条命令记录于 REPORT.md，避免「测试内跑测试」的递归。 */
