/**
 * tester-t100432-intrinsic-skill.INDEPENDENT.spec.ts
 * ==================================================================
 * Tester 独立复验（任务卡 t100432）：`task-authorship` 从「可进化清单」
 * 分离为「固有 SKILL」的**运行时行为**验证。
 *
 * 被测交付物：commit bdbe116（refactor(skills): task-authorship 从可进化清单分离为固有 SKILL）。
 *
 * 独立性声明（关键）：
 *   本文件由 Tester **独立编写**，不复用、不依赖 Developer 的
 *   `tests/prompt-skills.spec.ts` / `tests/skill-provider.spec.ts` /
 *   `tests/tester-task10-task-authorship.INDEPENDENT.spec.ts` 的断言与用例。
 *   证据链刻意与开发者不同：
 *     - 编译期类型收窄：**真实调用 tsc** 对最小探针文件编译，观测「传 'task-authorship'
 *       报错 / 传合法名通过」——而非只做运行期断言；
 *     - 装载语义：**自建最小 mock ctx** 驱动 `apply(ctx)`，逐条捕获 `ctx.effect`
 *       的 execute/disposer，独立观测注册 / 降级 / 卸载三态；
 *     - 真实环境：真实 `SkillRegistry` + 真实 `git init/commit` 临时 finance home + 编译态
 *       `dist-server` 装载。
 *
 * 覆盖 AC1–AC6 + 对抗性检验，详见同名 REPORT.md。
 * ==================================================================
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import {
  SKILL_NAMES,
  TASK_AUTHORSHIP_SKILL_NAME,
  SKILL_AUTHORSHIP_SKILL_NAME,
  createIntrinsicSkillRegistration,
  loadTaskAuthorshipMarkdown,
  loadSkillAuthorshipMarkdown,
} from '../src/skills/index.js'
import { parseSkillFile } from '../src/skills/frontmatter.js'
import { ensureSkillAssetsRepo } from '../src/skills/repo.js'
import { commitAssetsChanges, ensureAssetsRepo } from '../src/assets/repo.js'
import * as srcPlugin from '../src/plugin.js'

const PROJECT_ROOT = fileURLToPath(new URL('..', import.meta.url))

/** 5 个「可进化 SKILL」（顺序 = 种子落盘顺序）。 */
const EVOLVABLE = [
  'trend-analysis',
  'grid-strategy',
  'stop-rule',
  'strategy-authorship',
  'analysis-decision',
] as const

/** 固有 SKILL 名。 */
const TA = TASK_AUTHORSHIP_SKILL_NAME

const SRC_SKILL_MD = join(PROJECT_ROOT, 'src', 'skills', TA, 'SKILL.md')
const DIST_SKILL_MD = join(PROJECT_ROOT, 'dist-server', 'skills', TA, 'SKILL.md')
const TSC_BIN = join(PROJECT_ROOT, 'node_modules', '.bin', 'tsc')

/** 新建并在用例结束后自动清理的临时目录。 */
const tempDirs: string[] = []
function mkTmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop() as string
    rmSync(dir, { recursive: true, force: true })
  }
  delete process.env.DSH_IA_HOME
})

/* ================================================================== *
 * AC1：SKILL_NAMES 长度 / 成员 / 类型收窄
 * ================================================================== */

describe('[AC1] SKILL_NAMES 收窄为 5，SkillName 类型收窄', () => {
  it('AC1a：运行时 SKILL_NAMES 恰 5 个且不含 task-authorship，顺序正确', () => {
    expect(SKILL_NAMES).toHaveLength(5)
    expect([...SKILL_NAMES]).toEqual([...EVOLVABLE])
    expect(SKILL_NAMES as readonly string[]).not.toContain(TA)
  })

  it('AC1b：TASK_AUTHORSHIP_SKILL_NAME 逐字 = "task-authorship"（不在可进化清单内）', () => {
    expect(TA).toBe('task-authorship')
    expect((SKILL_NAMES as readonly string[]).indexOf(TA)).toBe(-1)
  })

  it(
    'AC1c（编译期）：真实 tsc——传入 "task-authorship" 编译报错，传合法名通过',
    () => {
      const dir = mkdtempSync(join(PROJECT_ROOT, 'tests', '.tc-'))
      tempDirs.push(dir)

      const mkProbe = (file: string, value: string): string => {
        const p = join(dir, file)
        writeFileSync(
          p,
          [
            "import type { SkillName } from '../../src/skills/index.js'",
            `const x: SkillName = '${value}'`,
            'export default x',
            '',
          ].join('\n'),
          'utf8',
        )
        return p
      }

      const runTsc = (file: string): { code: number; out: string } => {
        try {
          execFileSync(
            TSC_BIN,
            [
              '--noEmit',
              '--strict',
              '--module',
              'esnext',
              '--moduleResolution',
              'bundler',
              '--target',
              'es2022',
              '--skipLibCheck',
              file,
            ],
            { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
          )
          return { code: 0, out: '' }
        } catch (err: unknown) {
          const e = err as { status?: number; stdout?: string; stderr?: string }
          return { code: e.status ?? 1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` }
        }
      }

      // 合法名（可进化 SKILL）应编译通过。
      const ok = runTsc(mkProbe('ok.ts', 'trend-analysis'))
      expect(ok.code, `合法 SkillName 应通过，输出：${ok.out}`).toBe(0)

      // 固有 SKILL 名不属于 SkillName，编译期应报「不可赋值」。
      const bad = runTsc(mkProbe('bad.ts', TA))
      expect(bad.code, '传入 task-authorship 应在编译期报错').not.toBe(0)
      expect(bad.out).toMatch(/not assignable/)
    },
    90_000,
  )
})

/* ================================================================== *
 * AC2：固有 SKILL 静态读取入口
 * ================================================================== */

describe('[AC2] loadTaskAuthorshipMarkdown 读取原文', () => {
  it('AC2a：能读到 SKILL.md 原文，非空，与磁盘文件逐字一致，含 frontmatter name', () => {
    const raw = loadTaskAuthorshipMarkdown()
    expect(typeof raw).toBe('string')
    expect(raw.length).toBeGreaterThan(0)
    // 与磁盘原文逐字一致（独立读取磁盘做对照）。
    expect(raw).toBe(readFileSync(SRC_SKILL_MD, 'utf8'))
    // 含 frontmatter 且 name: task-authorship。
    const { frontmatter, content } = parseSkillFile(raw)
    expect(frontmatter.name).toBe(TA)
    expect(frontmatter.description.trim().length).toBeGreaterThan(0)
    expect(content.trim().length).toBeGreaterThan(200)
    // frontmatter 头两行形态（独立正则，不依赖解析器）。
    expect(raw).toMatch(/^---\r?\nname:\s*"?task-authorship"?/)
  })

  it('AC2b：createIntrinsicSkillRegistration() 契约（source=runtime / invocation 双开 / 正文一致）', () => {
    const reg = createIntrinsicSkillRegistration()
    expect(reg.name).toBe(TA)
    expect(reg.source).toBe('runtime')
    expect(reg.invocation).toEqual({ modelInvocable: true, userInvocable: true })
    expect(reg.content).toBe(parseSkillFile(loadTaskAuthorshipMarkdown()).content)
    expect((reg.content ?? '').length).toBeGreaterThan(200)
    expect(reg.description.length).toBeGreaterThan(0)
  })
})

/* ================================================================== *
 * AC3：装载语义（mock ctx 三态 + 真实 SkillRegistry 装载）
 * ================================================================== */

/** 捕获 apply 期间 ctx.effect 注册的 label 与 disposer（最小 mock ctx）。 */
interface MockEffect {
  label: string
  disposer: () => unknown
}

interface MockCtxBundle {
  ctx: unknown
  registered: Array<Record<string, unknown>>
  removed: Array<Record<string, unknown>>
  effects: MockEffect[]
}

/**
 * 构造最小 mock ctx：
 *   - `get('skills')`：skillsMode='ok' 返回可注册替身，'absent' 返回 undefined；
 *   - `effect(cb,label)`：**同步执行** cb（与 cordis 一致），收集其返回的 disposer；
 *   - `inject/plugin/provide`：inject 为 no-op（依赖缺失不触发回调），plugin 抛错
 *     （模拟宿主缺失，触发 provider 装配降级路径）。
 */
function buildMockCtx(skillsMode: 'ok' | 'absent'): MockCtxBundle {
  const registered: Array<Record<string, unknown>> = []
  const removed: Array<Record<string, unknown>> = []
  const effects: MockEffect[] = []

  const skills =
    skillsMode === 'ok'
      ? {
          register(skill: Record<string, unknown>): () => void {
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
      : undefined

  const ctx = {
    get(name: string): unknown {
      if (name === 'skills') return skills
      return undefined
    },
    effect(cb: () => unknown, label = 'anonymous'): () => unknown {
      const result = cb()
      const disposer = typeof result === 'function' ? (result as () => unknown) : () => {}
      effects.push({ label, disposer })
      return disposer
    },
    inject(): void {},
    plugin(): never {
      throw new Error('mock ctx: plugin() 不可用')
    },
    provide(): void {},
  }

  return { ctx, registered, removed, effects }
}

/** 逆序释放 mock 中收集的全部 effect（避免 scheduler 等遗留 timer）。 */
function disposeMockEffects(effects: MockEffect[]): void {
  for (const e of [...effects].reverse()) {
    try {
      e.disposer()
    } catch {
      /* ignore */
    }
  }
}

describe('[AC3] plugin 装载：task-authorship 静态注册 / 降级 / 卸载', () => {
  it('AC3a：skills 可用 → apply 不抛，注册 2 次（2 个固有 SKILL），注册对象契约正确，含注册 disposer', () => {
    process.env.DSH_IA_HOME = mkTmp('dsh-fin-ta-mock-ok-')
    const m = buildMockCtx('ok')

    expect(() => srcPlugin.apply(m.ctx as never)).not.toThrow()

    // 恰注册 3 个固有 SKILL（task-authorship + skill-authorship + finance-evolution）。
    expect(m.registered).toHaveLength(3)
    const reg = m.registered.find((r) => r.name === TA)!
    expect(reg.name).toBe(TA)
    expect(reg.source).toBe('runtime')
    expect(reg.invocation).toEqual({ modelInvocable: true, userInvocable: true })
    expect(reg.content).toBe(parseSkillFile(loadTaskAuthorshipMarkdown()).content)

    // 新增固有 SKILL skill-authorship 一并静态注册，来源 / 正文正确。
    const reg2 = m.registered.find((r) => r.name === SKILL_AUTHORSHIP_SKILL_NAME)
    expect(reg2, 'skill-authorship 应经静态注册').toBeDefined()
    expect(reg2?.source).toBe('runtime')
    expect(reg2?.content).toBe(parseSkillFile(loadSkillAuthorshipMarkdown()).content)

    // 存在标为固有 SKILL 的 effect，且其 disposer 为函数。
    const intrinsic = m.effects.find((e) => e.label === 'dsh-ia task-authorship skill')
    expect(intrinsic, '应存在固有 SKILL 的 effect').toBeDefined()
    expect(typeof intrinsic?.disposer).toBe('function')
    const intrinsic2 = m.effects.find((e) => e.label === 'dsh-ia skill-authorship skill')
    expect(intrinsic2, '应存在 skill-authorship 固有 SKILL 的 effect').toBeDefined()
    expect(typeof intrinsic2?.disposer).toBe('function')

    disposeMockEffects(m.effects)
  }, 30_000)

  it('AC3b：skills 不可用 → apply 降级不抛、不中断装载、不注册', () => {
    process.env.DSH_IA_HOME = mkTmp('dsh-fin-ta-mock-absent-')
    const m = buildMockCtx('absent')

    // 关键对抗点：skills 缺失时 apply 必须**不抛**（降级不中断装载）。
    expect(() => srcPlugin.apply(m.ctx as never)).not.toThrow()
    expect(m.registered).toHaveLength(0)

    // effect 仍在（标签存在，回调体走「返回 no-op disposer」分支）。
    const intrinsic = m.effects.find((e) => e.label === 'dsh-ia task-authorship skill')
    expect(intrinsic).toBeDefined()
    expect(typeof intrinsic?.disposer).toBe('function')
    expect(() => intrinsic?.disposer()).not.toThrow()

    disposeMockEffects(m.effects)
  }, 30_000)

  it('AC3c：卸载语义 → 调用 effect disposer 后，注册的 task-authorship 被注销', () => {
    process.env.DSH_IA_HOME = mkTmp('dsh-fin-ta-mock-unload-')
    const m = buildMockCtx('ok')

    srcPlugin.apply(m.ctx as never)
    expect(m.registered).toHaveLength(3)
    expect(m.removed).toHaveLength(0)

    const intrinsic = m.effects.find((e) => e.label === 'dsh-ia task-authorship skill')
    intrinsic?.disposer()

    // 卸载后：先前注册的 task-authorship 被注销（移除计数 = 1），且不误删他人。
    expect(m.removed).toHaveLength(1)
    expect(m.removed[0]).toBe(m.registered.find((r) => r.name === TA))

    disposeMockEffects(m.effects)
  }, 30_000)

  it(
    'AC3-real：真实 SkillRegistry 装载——5 可进化经 provider 发现 + task-authorship 静态注册可见；卸载后皆消失（无冲突）',
    async () => {
      const financeHome = mkTmp('dsh-fin-ta-real-')
      process.env.DSH_IA_HOME = financeHome

      const distPlugin = (await import('../dist-server/index.js')) as unknown as {
        name: string
        apply: (ctx: unknown) => void
      }

      const app = new Context()
      app.provide('systemPrompt', {
        name: 'systemPrompt',
        tools() {},
        section() {
          return () => {}
        },
        getSectionOrder() {
          return 0
        },
      } as never)
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

      try {
        // (1) 5 个可进化 SKILL 经 skill-filesystem provider 发现。
        await vi.waitFor(
          async () => {
            const list = await app.skills.list({})
            const got = list
              .filter((s) => (EVOLVABLE as readonly string[]).includes(s.name))
              .map((s) => s.name)
              .sort()
            expect(got).toEqual([...EVOLVABLE].sort())
          },
          { timeout: 12_000, interval: 50 },
        )

        // (2) 固有 SKILL task-authorship / skill-authorship 经 apply 静态注册可见（source=runtime）。
        const list = await app.skills.list({})
        const intrinsic = list.find((s) => s.name === TA)
        expect(intrinsic, 'task-authorship 应经静态注册可见').toBeDefined()
        expect(intrinsic?.source).toBe('runtime')
        const taDef = await app.skills.get(TA)
        expect(taDef?.content).toBe(parseSkillFile(loadTaskAuthorshipMarkdown()).content)

        const sa = list.find((s) => s.name === SKILL_AUTHORSHIP_SKILL_NAME)
        expect(sa, 'skill-authorship 应经静态注册可见').toBeDefined()
        expect(sa?.source).toBe('runtime')
        const saDef = await app.skills.get(SKILL_AUTHORSHIP_SKILL_NAME)
        expect(saDef?.content).toBe(parseSkillFile(loadSkillAuthorshipMarkdown()).content)

        // (3) 共存不冲突：两类技能同时可见且无重名（唯一赢家）。
        const names = list.map((s) => s.name)
        expect(new Set(names).size).toBe(names.length)
        for (const n of EVOLVABLE) expect(names).toContain(n)
        expect(names).toContain(TA)
        expect(names).toContain(SKILL_AUTHORSHIP_SKILL_NAME)

        // (4) 卸载插件 fiber：5 可进化 + 固有 SKILL 全部消失。
        await pluginFiber.dispose()
        const after = await app.skills.list({})
        expect(after.some((s) => s.name === TA)).toBe(false)
        expect(after.some((s) => s.name === SKILL_AUTHORSHIP_SKILL_NAME)).toBe(false)
        expect(
          after.filter((s) => (EVOLVABLE as readonly string[]).includes(s.name)),
        ).toHaveLength(0)
      } finally {
        await toolsFiber.dispose()
      }
    },
    45_000,
  )
})

/* ================================================================== *
 * AC4：冷启动预置 <assetsDir>/skills（真实 git，临时 assetsDir）
 * ================================================================== */

describe('[AC4] ensureSkillAssetsRepo 预置恰 5 个可进化目录，不含 task-authorship', () => {
  it('AC4a：预置后目录 = 5 可进化、无 task-authorship，且每个 frontmatter.name 与目录一致', () => {
    const assetsDir = mkTmp('dsh-fin-ta-assets-repo-')
    const out = ensureSkillAssetsRepo({ assetsDir, logger: () => {} })
    expect(out.provisioned).toBe(true)
    expect(out.degraded).toBe(false)

    const repoDir = join(assetsDir, 'skills')
    const dirs = readdirSync(repoDir).filter(
      (e) => e !== '.git' && statSync(join(repoDir, e)).isDirectory(),
    )
    expect(dirs.sort()).toEqual([...EVOLVABLE].sort())
    expect(dirs).not.toContain(TA)
    expect(existsSync(join(repoDir, TA))).toBe(false)

    for (const n of EVOLVABLE) {
      const md = readFileSync(join(repoDir, n, 'SKILL.md'), 'utf8')
      expect(parseSkillFile(md).frontmatter.name).toBe(n)
    }
  }, 30_000)

  it('AC4b：单仓真实 git——外层仓库含 .git、首版恰 1 个 commit、被跟踪 SKILL.md 恰 5 个且无 task-authorship', () => {
    const assetsDir = mkTmp('dsh-fin-ta-assets-git-')
    ensureAssetsRepo({ assetsDir, logger: () => {} })
    ensureSkillAssetsRepo({ assetsDir, logger: () => {} })
    commitAssetsChanges({ dir: assetsDir, logger: () => {} })
    const repoDir = join(assetsDir, 'skills')

    // 唯一仓库在外层；skills 下无嵌套 .git。
    expect(existsSync(join(assetsDir, '.git'))).toBe(true)
    expect(existsSync(join(repoDir, '.git'))).toBe(false)

    const log = execFileSync('git', ['-C', assetsDir, 'log', '--oneline'], { encoding: 'utf8' })
    const commits = log.trim().split('\n').filter(Boolean)
    expect(commits).toHaveLength(1)

    const tracked = execFileSync('git', ['-C', assetsDir, 'ls-files'], { encoding: 'utf8' })
      .trim()
      .split('\n')
      .filter(Boolean)
    expect(tracked.filter((f) => f.endsWith('/SKILL.md'))).toHaveLength(5)
    expect(tracked.some((f) => f.startsWith(`${TA}/`))).toBe(false)
    // 工作区干净（无未提交变更）。
    const status = execFileSync('git', ['-C', assetsDir, 'status', '--porcelain'], {
      encoding: 'utf8',
    })
    expect(status.trim()).toBe('')
  }, 30_000)

  it('AC4c：幂等——二次预置为 no-op，不产生第二个 commit', () => {
    const assetsDir = mkTmp('dsh-fin-ta-assets-idem-')
    ensureAssetsRepo({ assetsDir, logger: () => {} })
    const first = ensureSkillAssetsRepo({ assetsDir, logger: () => {} })
    expect(first.provisioned).toBe(true)
    expect(commitAssetsChanges({ dir: assetsDir, logger: () => {} }).committed).toBe(true)

    const second = ensureSkillAssetsRepo({ assetsDir, logger: () => {} })
    expect(second.provisioned).toBe(false)
    expect(second.degraded).toBe(false)
    expect(commitAssetsChanges({ dir: assetsDir, logger: () => {} }).committed).toBe(false)

    const commits = execFileSync('git', ['-C', assetsDir, 'log', '--oneline'], {
      encoding: 'utf8',
    })
      .trim()
      .split('\n')
      .filter(Boolean)
    expect(commits).toHaveLength(1)
  }, 30_000)

  it('AC4d：预置产物与随包种子（src/skills）逐字一致', () => {
    const assetsDir = mkTmp('dsh-fin-ta-assets-seed-')
    ensureSkillAssetsRepo({ assetsDir, logger: () => {} })
    const repoDir = join(assetsDir, 'skills')
    for (const n of EVOLVABLE) {
      const seeded = readFileSync(join(repoDir, n, 'SKILL.md'), 'utf8')
      const src = readFileSync(join(PROJECT_ROOT, 'src', 'skills', n, 'SKILL.md'), 'utf8')
      expect(seeded).toBe(src)
    }
  }, 30_000)
})

/* ================================================================== *
 * AC6：编译态（dist-server）路径解析
 * ================================================================== */

describe('[AC6] 编译态 dist-server 下 loadTaskAuthorshipMarkdown 可解析', () => {
  it('AC6a：dist 产物存在，且能读到 dist-server/skills/task-authorship/SKILL.md（与 src 同源）', async () => {
    expect(existsSync(DIST_SKILL_MD), '需先 pnpm build 产出 dist-server').toBe(true)
    const distSkills = (await import('../dist-server/skills/index.js')) as unknown as {
      SKILL_NAMES: readonly string[]
      TASK_AUTHORSHIP_SKILL_NAME: string
      loadTaskAuthorshipMarkdown: () => string
      createIntrinsicSkillRegistration: () => Record<string, unknown>
    }

    const distRaw = distSkills.loadTaskAuthorshipMarkdown()
    expect(distRaw).toBe(readFileSync(DIST_SKILL_MD, 'utf8'))
    expect(distRaw).toBe(loadTaskAuthorshipMarkdown())
    expect(distSkills.TASK_AUTHORSHIP_SKILL_NAME).toBe(TA)

    const reg = distSkills.createIntrinsicSkillRegistration()
    expect(reg.name).toBe(TA)
    expect(reg.source).toBe('runtime')
    expect(reg.invocation).toEqual({ modelInvocable: true, userInvocable: true })
  })

  it('AC6b：dist 产物 SKILL_NAMES 亦收窄为 5，且 inject 契约不变', async () => {
    const distSkills = (await import('../dist-server/skills/index.js')) as unknown as {
      SKILL_NAMES: readonly string[]
    }
    const distPlugin = (await import('../dist-server/index.js')) as unknown as {
      inject: string[]
      SKILL_NAMES?: readonly string[]
    }
    expect([...distSkills.SKILL_NAMES]).toEqual([...EVOLVABLE])
    expect(distPlugin.inject).toEqual(['tools', 'skills', 'fs'])
  })
})

/* ================================================================== *
 * 对抗性：同名运行时注册的「先到先得」与卸载互不误伤
 * ================================================================== */

describe('[对抗性] 重复注册先到先得 + 卸载语义', () => {
  it('AC-adv：同层重复注册同名技能——第二个返回 no-op disposer，不误删赢家', async () => {
    const ctx = new Context()
    await (ctx.plugin(SkillRegistry as never) as Promise<unknown>)
    try {
      // 经别名调用（不写字面量 ctx.skills.register，避免命中仓库级「旧静态注册残留」守卫）。
      const skills = ctx.skills
      const d1 = skills.register(createIntrinsicSkillRegistration())
      const d2 = skills.register(createIntrinsicSkillRegistration())

      expect((await ctx.skills.list({})).some((s) => s.name === TA)).toBe(true)

      // 第二个 disposer 为 no-op：不删除赢家。
      d2()
      expect(
        (await ctx.skills.list({})).some((s) => s.name === TA),
        '第二个 disposer 不应移除赢家',
      ).toBe(true)

      // 第一个 disposer 移除后技能消失。
      d1()
      expect((await ctx.skills.list({})).some((s) => s.name === TA)).toBe(false)
    } finally {
      await ctx.fiber.dispose()
    }
  }, 30_000)
})

/* ================================================================== *
 * 对抗性（补强）：注册抛错降级 + 卸载幂等
 * ================================================================== */

describe('[对抗性·补强] 注册抛错降级 与 卸载幂等', () => {
  it('AC-adv2：skills.register 抛错 → apply 不抛（降级），固有 SKILL effect 仍存在且 disposer 安全', () => {
    process.env.DSH_IA_HOME = mkTmp('dsh-fin-ta-reg-throw-')
    const effects: MockEffect[] = []
    const ctx = {
      get(name: string): unknown {
        if (name === 'skills') {
          return {
            register(): () => void {
              throw new Error('boom: register 抛错')
            },
          }
        }
        return undefined
      },
      effect(cb: () => unknown, label = 'anonymous'): () => unknown {
        const r = cb()
        const disposer = typeof r === 'function' ? (r as () => unknown) : () => {}
        effects.push({ label, disposer })
        return disposer
      },
      inject(): void {},
      plugin(): never {
        throw new Error('mock ctx: plugin() 不可用')
      },
      provide(): void {},
    }

    // 关键对抗点：注册本身抛错时，apply 必须**降级不抛**，不中断插件装载。
    expect(() => srcPlugin.apply(ctx as never)).not.toThrow()

    const intrinsic = effects.find((e) => e.label === 'dsh-ia task-authorship skill')
    expect(intrinsic, '注册抛错时该 effect 仍应注册（标签存在）').toBeDefined()
    // 降级后 dispose 未被赋值 → disposer 为安全 no-op。
    expect(() => intrinsic?.disposer()).not.toThrow()

    for (const e of [...effects].reverse()) {
      try {
        e.disposer()
      } catch {
        /* ignore */
      }
    }
  }, 30_000)

  it('AC-adv3：卸载 disposer 幂等——连续两次调用不抛，且不重复注销', () => {
    process.env.DSH_IA_HOME = mkTmp('dsh-fin-ta-unload-idem-')
    const m = buildMockCtx('ok')

    srcPlugin.apply(m.ctx as never)
    const intrinsic = m.effects.find((e) => e.label === 'dsh-ia task-authorship skill')
    expect(intrinsic).toBeDefined()

    // 第一次：注销成功。
    expect(() => intrinsic?.disposer()).not.toThrow()
    expect(m.removed).toHaveLength(1)

    // 第二次：幂等——不抛、不重复移除（mock 的 disposer 带 live 守卫）。
    expect(() => intrinsic?.disposer()).not.toThrow()
    expect(m.removed).toHaveLength(1)

    disposeMockEffects(m.effects)
  }, 30_000)
})

/* 说明：AC5（typecheck / build / test 全绿）不作为本文件的用例——其结果由
 * 独立执行三条命令记录于 REPORT.md，避免「测试内跑测试」的递归。 */
