/**
 * t100471 任务-03：`finance-evolution` 固有 SKILL 注册与内容契约测试。
 *
 * 定位：这是**固件**而非可进化资产 ——
 *   - 不进入可进化清单 `SKILL_NAMES`；
 *   - 由 `src/plugin.ts` 经 `ctx.effect` 静态注册（与 task-authorship /
 *     skill-authorship 并列，共 3 个固有 SKILL）；
 *   - 正文必须完整描述「四类触发 / assets 资产范围 / 修改记录＝git」的契约。
 *
 * 断言风格：只做**结构化 / 关键句正则**断言，不做全文快照，避免措辞微调即碎。
 */
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import {
  SKILL_NAMES,
  TASK_AUTHORSHIP_SKILL_NAME,
  SKILL_AUTHORSHIP_SKILL_NAME,
  FINANCE_EVOLUTION_SKILL_NAME,
  loadFinanceEvolutionMarkdown,
  createFinanceEvolutionRegistration,
} from '../src/skills/index'
import { parseSkillFile } from '../src/skills/frontmatter'
import { ensureSkillAssetsRepo } from '../src/skills/repo'
import { apply } from '../src/plugin'

const tmpDirs: string[] = []

/** 临时 finance home（避免 apply 时回落到真实 `~/.dsh-ia`）。 */
function makeTempFinanceHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'dsh-ia-finance-evolution-'))
  tmpDirs.push(home)
  ensureSkillAssetsRepo({ assetsDir: join(home, 'assets'), logger: () => {} })
  return home
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  }
})

/** 最小 mock ctx：只承载 `apply()` 所需的 skills / tools / systemPrompt。 */
function makeMockCtx() {
  const registeredSkills: Array<{ name: string; source: string; content: string }> = []
  const skillsService = {
    name: 'skills',
    register(skill: { name: string; source: string; content: string }) {
      registeredSkills.push(skill)
      return () => {}
    },
  }
  const ctx = {
    effect(body: () => unknown) {
      const d = body()
      return typeof d === 'function' ? (d as () => void) : () => {}
    },
    get(name: string) {
      return name === 'skills' ? skillsService : undefined
    },
    inject(_deps: string[], cb: (c: unknown) => void) {
      cb({
        systemPrompt: {
          section() {
            return () => {}
          },
        },
      })
      return {}
    },
    skills: skillsService,
    tools: { register: () => () => {} },
  } as unknown as Context
  return { ctx, registeredSkills }
}

/* ------------------------------------------------------------------ *
 * 1. 插件静态注册：恰好 3 个固有 SKILL，含 finance-evolution
 * ------------------------------------------------------------------ */

describe('静态注册：3 个固有 SKILL', () => {
  it('apply 后静态注册恰为 task-authorship / skill-authorship / finance-evolution', () => {
    const home = makeTempFinanceHome()
    const prev = process.env.DSH_IA_HOME
    process.env.DSH_IA_HOME = home
    try {
      const { ctx, registeredSkills } = makeMockCtx()
      expect(() => apply(ctx)).not.toThrow()

      expect(registeredSkills).toHaveLength(3)
      expect(registeredSkills.map((s) => s.name).sort()).toEqual(
        [
          TASK_AUTHORSHIP_SKILL_NAME,
          SKILL_AUTHORSHIP_SKILL_NAME,
          FINANCE_EVOLUTION_SKILL_NAME,
        ].sort(),
      )
      expect(registeredSkills.some((s) => s.name === 'finance-evolution')).toBe(true)
      for (const s of registeredSkills) expect(s.source).toBe('runtime')
    } finally {
      if (prev === undefined) delete process.env.DSH_IA_HOME
      else process.env.DSH_IA_HOME = prev
    }
  })
})

/* ------------------------------------------------------------------ *
 * 2. 注册对象契约
 * ------------------------------------------------------------------ */

describe('注册对象契约：createFinanceEvolutionRegistration()', () => {
  const reg = createFinanceEvolutionRegistration()

  it('name 为 finance-evolution，且带非空 description', () => {
    expect(reg.name).toBe(FINANCE_EVOLUTION_SKILL_NAME)
    expect(reg.name).toBe('finance-evolution')
    expect(reg.description.trim().length).toBeGreaterThan(0)
  })

  it('source === runtime，invocation 模型侧与用户侧双开', () => {
    expect(reg.source).toBe('runtime')
    expect(reg.invocation?.modelInvocable).toBe(true)
    expect(reg.invocation?.userInvocable).toBe(true)
  })

  it('resourceBase.kind === directory，且指向真实存在的 finance-evolution 目录', () => {
    expect(reg.resourceBase?.kind).toBe('directory')
    const rb = reg.resourceBase as { kind: 'directory'; path?: string }
    expect(typeof rb.path).toBe('string')
    expect(existsSync(rb.path as string)).toBe(true)
    expect(statSync(rb.path as string).isDirectory()).toBe(true)
    expect((rb.path as string).replace(/\\/g, '/').endsWith('/finance-evolution/')).toBe(true)
  })

  it('正文非空且已剥离 frontmatter', () => {
    expect(reg.content.trim().length).toBeGreaterThan(100)
    expect(reg.content.startsWith('---')).toBe(false)
  })
})

/* ------------------------------------------------------------------ *
 * 3. frontmatter：三字段齐全，name 与目录名一致
 * ------------------------------------------------------------------ */

describe('frontmatter 契约', () => {
  const parsed = parseSkillFile(loadFinanceEvolutionMarkdown())

  it('name / description / whenToUse 三字段齐全且非空', () => {
    expect(parsed.frontmatter.name).toBe('finance-evolution')
    expect(parsed.frontmatter.description.trim().length).toBeGreaterThan(0)
    expect(typeof parsed.frontmatter.whenToUse).toBe('string')
    expect(parsed.frontmatter.whenToUse?.trim().length).toBeGreaterThan(0)
  })

  it('frontmatter.name 与目录名 finance-evolution 一致', () => {
    const rb = createFinanceEvolutionRegistration().resourceBase as { path: string }
    const dirName = rb.path.replace(/\\/g, '/').replace(/\/$/, '').split('/').pop()
    expect(dirName).toBe(parsed.frontmatter.name)
  })
})

/* ------------------------------------------------------------------ *
 * 4. 正文关键契约（正则匹配，不做全文快照）
 * ------------------------------------------------------------------ */

describe('正文关键契约', () => {
  const body = parseSkillFile(loadFinanceEvolutionMarkdown()).content

  it('四类触发齐全：指标异常 / 同一失败第二次 / 能力缺陷可复现 / 某个做法明显有效', () => {
    expect(body).toMatch(/指标异常/)
    expect(body).toMatch(/同一失败[^\n]{0,20}第二次/)
    expect(body).toMatch(/能力缺陷[^\n]{0,20}可复现/)
    expect(body).toMatch(/某个做法明显有效/)
  })

  it('assets 资产范围覆盖 skills / strategies / programs / tasks', () => {
    expect(body).toMatch(
      /资产[^\n]*`skills`[^\n]*`strategies`[^\n]*`programs`[^\n]*`tasks`/,
    )
  })

  it('声明 assets 下的固件不可改、assets 之外不可改', () => {
    expect(body).toMatch(/固件[^\n]*不可改/)
    expect(body).toMatch(/assets`?\s*之外[^\n]*不可改/)
  })

  it('修改记录＝git：载体为 git 提交历史，不另建记录文件', () => {
    expect(body).toMatch(/git 提交历史/)
    expect(body).toMatch(/不另建记录文件/)
  })

  it('修改记录＝git：assets 一个仓库统管，skill 不单独建仓', () => {
    expect(body).toMatch(/一个仓库统管/)
    expect(body).toMatch(/不单独建仓/)
  })

  it('修改记录＝git：append-only，禁止 amend / rebase / force-push', () => {
    expect(body).toMatch(/append-only/)
    expect(body).toMatch(/禁止\s*amend[、,，]\s*rebase[、,，]\s*force-push/)
  })

  it('修改记录＝git：只记操作不判结果', () => {
    expect(body).toMatch(/只记操作[^\n]*不判结果/)
  })

  it('明确 5 轮上限与撤销也是一条修改记录（流程闭环）', () => {
    expect(body).toMatch(/最多\s*5\s*轮/)
    expect(body).toMatch(/撤销本身也是一条修改记录/)
  })
})

/* ------------------------------------------------------------------ *
 * 5. 不是可进化种子
 * ------------------------------------------------------------------ */

describe('不是可进化种子', () => {
  it('SKILL_NAMES 不含 finance-evolution', () => {
    expect(SKILL_NAMES as readonly string[]).not.toContain('finance-evolution')
    expect(SKILL_NAMES as readonly string[]).not.toContain(FINANCE_EVOLUTION_SKILL_NAME)
  })

  it('三个固有 SKILL 都不在可进化清单中', () => {
    for (const name of [
      TASK_AUTHORSHIP_SKILL_NAME,
      SKILL_AUTHORSHIP_SKILL_NAME,
      FINANCE_EVOLUTION_SKILL_NAME,
    ]) {
      expect(SKILL_NAMES as readonly string[]).not.toContain(name)
    }
  })
})
