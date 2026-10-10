/**
 * Task 5 验收测试：Prompt 注入（advisor.md）+ 6 个技术面 SKILL。
 *
 * 覆盖验收标准：
 *   1. advisor.md 含角色/原则/工作流/合规四块，末尾明确「本内容不构成投资建议」。
 *   2. 6 个 SKILL.md 均含 frontmatter 的 name/description/whenToUse，name 为 kebab-case。
 *   3. prompt 与 skill 全文不出现写死的标的价格/阈值（数值用「从配置读取」占位）。
 *   4. apply(ctx) 注册后 6 个 skill 可被 ctx.skills 发现、advisor.md 注入 system-prompt。
 *
 * 另含：frontmatter 解析器单测、copy-assets 产物路径可解析校验。
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, it, expect } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import {
  SKILL_NAMES,
  loadSkillMarkdown,
  parseSkill,
} from '../src/skills/index'
import { ensureSkillAssetsRepo } from '../src/skills/repo'
import {
  mountSkillFilesystemProviderAsync,
  SKILL_PROVIDER_NAME,
} from '../src/skills/provider'
import {
  parseSkillFile,
  SKILL_NAME_PATTERN,
} from '../src/skills/frontmatter'
import {
  ADVISOR_SECTION_NAME,
  ADVISOR_SECTION_ORDER,
  loadAdvisorMd,
  createAdvisorSection,
  registerAdvisorSection,
  applyAdvisorPrompt,
} from '../src/prompts/index'
import { apply, inject as topLevelInject } from '../src/plugin'

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))

const tmpDirs: string[] = []

/** 建临时 dataRoot 并预置 6 个 skill 资产（真实 git 仓库）。 */
function makeSeededDataRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-finance-prompt-skills-'))
  tmpDirs.push(dir)
  ensureSkillAssetsRepo({ dataRoot: dir, logger: () => {} })
  return dir
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

/* ------------------------------------------------------------------ *
 * 验收 1：advisor.md 四块结构 + 合规声明
 * ------------------------------------------------------------------ */

describe('验收 1：advisor.md 人设内容', () => {
  const md = loadAdvisorMd()

  it('包含角色 / 原则 / 工作流 / 合规四大板块', () => {
    expect(md.trim().length).toBeGreaterThan(300)
    expect(md).toMatch(/#\s*角色/)
    expect(md).toMatch(/#\s*原则/)
    expect(md).toMatch(/#\s*工作流/)
    expect(md).toMatch(/#\s*合规/)
  })

  it('末尾明确「本内容不构成投资建议」', () => {
    expect(md).toContain('本内容不构成投资建议')
    // 合规声明应出现在靠后位置（结构以合规收尾）。
    const idx = md.indexOf('本内容不构成投资建议')
    expect(idx).toBeGreaterThan(md.length * 0.6)
  })

  it('体现「不执行真实交易」「趋势跟随」「防守优先」等核心约束', () => {
    expect(md).toMatch(/不执行真实交易/)
    expect(md).toMatch(/趋势跟随/)
    expect(md).toMatch(/防守优先/)
  })
})

/* ------------------------------------------------------------------ *
 * 验收 2：6 个 SKILL.md 的 frontmatter
 * ------------------------------------------------------------------ */

describe('验收 2：6 个 SKILL.md frontmatter（name/description/whenToUse）', () => {
  it('SKILL_NAMES 恰为 6 个且均为 kebab-case', () => {
    expect(SKILL_NAMES).toHaveLength(6)
    for (const n of SKILL_NAMES) expect(SKILL_NAME_PATTERN.test(n)).toBe(true)
  })

  it.each(SKILL_NAMES)('%s：frontmatter 三字段齐全、name=kebab-case、与目录名一致', (name) => {
    const { frontmatter, content } = parseSkill(name)
    expect(frontmatter.name).toBe(name)
    expect(frontmatter.name).toMatch(SKILL_NAME_PATTERN)
    expect(frontmatter.description.length).toBeGreaterThan(0)
    expect(typeof frontmatter.whenToUse).toBe('string')
    expect(frontmatter.whenToUse?.length).toBeGreaterThan(0)
    expect(content.trim().length).toBeGreaterThan(100)
    // 正文不含 frontmatter 分隔符残留。
    expect(content.startsWith('---')).toBe(false)
  })
})

/* 说明：运行时注册已由 `src/skills/provider.ts` 的 skill-filesystem provider 承担，
 * 旧的静态注册函数（本次重构已全部移除）不再存在；
 * provider 路径的发现 / 正文 / 热更新 / 卸载由 `tests/skill-provider.spec.ts` 覆盖。 */

/* ------------------------------------------------------------------ *
 * 验收 3：全文无写死的价格 / 阈值
 * ------------------------------------------------------------------ */

describe('验收 3：prompt 与 skill 全文不出现写死的价格/阈值', () => {
  function readAllTexts(): Array<[string, string]> {
    const out: Array<[string, string]> = [['prompts/advisor.md', loadAdvisorMd()]]
    for (const n of SKILL_NAMES) out.push([`skills/${n}/SKILL.md`, loadSkillMarkdown(n)])
    return out
  }

  it.each(readAllTexts())('%s：不出现具体价格（如 3.14 / 12.5 元 之类）', (_label, text) => {
    // 形如「10.5」「3.14」的带小数点价格（排除区间闭区间记号 [低, 高]）。
    // 版本号（semver，如 1.0.0 / ^22.0.0）非价格：先剔除再扫描，保持红线真实语义。
    const withoutSemver = text.replace(/\^?\d+\.\d+\.\d+/g, '')
    expect(withoutSemver).not.toMatch(/(?<![`\w])\d+\.\d+(?![`\w])/)
  })

  it('阈值类表述一律指向「该标的策略文档」且声明不硬编码', () => {
    const joined = readAllTexts().map(([, t]) => t).join('\n')
    expect(joined).toMatch(/该标的策略文档/)
    expect(joined).toMatch(/不(写|硬编)/)
  })

  it('不含百分号形式的写死阈值（如 5% / -3%）', () => {
    for (const [, text] of readAllTexts()) {
      expect(text).not.toMatch(/\d\s*%/)
    }
  })
})

/* ------------------------------------------------------------------ *
 * frontmatter 解析器单测
 * ------------------------------------------------------------------ */

describe('frontmatter 解析器', () => {
  it('解析双引号值并还原转义', () => {
    const raw = '---\nname: "my-skill"\ndescription: "a \\"quoted\\" line"\nwhenToUse: "when"\n---\n\n# Body\ntext\n'
    const { frontmatter, content } = parseSkillFile(raw)
    expect(frontmatter.name).toBe('my-skill')
    expect(frontmatter.description).toBe('a "quoted" line')
    expect(frontmatter.whenToUse).toBe('when')
    expect(content).toBe('# Body\ntext')
  })

  it('支持无引号值与可选 whenToUse 缺省', () => {
    const raw = '---\nname: plain-skill\ndescription: 简单描述\n---\nbody'
    const { frontmatter, content } = parseSkillFile(raw)
    expect(frontmatter.name).toBe('plain-skill')
    expect(frontmatter.description).toBe('简单描述')
    expect(frontmatter.whenToUse).toBeUndefined()
    expect(content).toBe('body')
  })

  it('容忍 CRLF 与 BOM', () => {
    const raw = '\uFEFF---\r\nname: crlf-skill\r\ndescription: d\r\n---\r\nbody\r\n'
    const { frontmatter } = parseSkillFile(raw)
    expect(frontmatter.name).toBe('crlf-skill')
  })

  it('缺少 frontmatter / name 非法 / 缺 description 时抛错', () => {
    expect(() => parseSkillFile('# no frontmatter')).toThrow(/frontmatter/)
    expect(() => parseSkillFile('---\ndescription: d\n---\nx')).toThrow(/name/)
    expect(() => parseSkillFile('---\nname: Bad_Name\ndescription: d\n---\nx')).toThrow(/kebab-case/)
    expect(() => parseSkillFile('---\nname: ok-name\n---\nx')).toThrow(/description/)
  })
})

/* ------------------------------------------------------------------ *
 * 验收 5a：经 skill-filesystem provider 端到端发现 / 卸载
 * ------------------------------------------------------------------ */

async function newSkillContext(): Promise<Context> {
  const ctx = new Context()
  await (ctx.plugin(SkillRegistry as never) as Promise<unknown>)
  return ctx
}

describe('验收 5：经 skill-filesystem provider 发现 / 卸载 6 个 SKILL', () => {
  it('挂载 provider 后 6 个 skill 均可列出、get() 返回正文；注销后消失', async () => {
    const dataRoot = makeSeededDataRoot()
    const ctx = await newSkillContext()
    const mount = await mountSkillFilesystemProviderAsync(ctx, { dataRoot })

    const summaries = await ctx.skills.list({})
    for (const name of SKILL_NAMES) {
      const s = summaries.find((x) => x.name === name)
      expect(s, `skill ${name} 未出现在目录中`).toBeDefined()
      expect(s?.source).toBe('custom')
      expect(s?.provider).toBe(SKILL_PROVIDER_NAME)

      const def = await ctx.skills.get(name)
      expect(def?.content).toBe(parseSkill(name).content)
      expect(def?.whenToUse).toBeDefined()
      expect(def?.invocation).toEqual({ modelInvocable: true, userInvocable: true })
    }

    await mount.dispose()
    const after = await ctx.skills.list({})
    for (const name of SKILL_NAMES) {
      expect(after.some((x) => x.name === name)).toBe(false)
    }

    await ctx.fiber.dispose()
  }, 30000)
})

/* ------------------------------------------------------------------ *
 * 验收 5b：advisor 人设注入 system-prompt
 * ------------------------------------------------------------------ */

describe('验收 5：advisor 人设 section 契约', () => {
  it('createAdvisorSection 返回唯一 name / order / 惰性 text', () => {
    const section = createAdvisorSection()
    expect(section.name).toBe(ADVISOR_SECTION_NAME)
    expect(section.order).toBe(ADVISOR_SECTION_ORDER)
    expect(typeof section.text).toBe('function')
    expect((section.text as () => string)()).toBe(loadAdvisorMd())
    // 不使用 complete（避免覆盖部署 persona）。
    expect(section.complete).toBeUndefined()
  })

  it('registerAdvisorSection 调用 systemPrompt.section 一次并返回注销器', () => {
    const seen: unknown[] = []
    const sp = {
      section(s: unknown) {
        seen.push(s)
        return () => {}
      },
    }
    const dispose = registerAdvisorSection(sp)
    expect(seen).toHaveLength(1)
    expect((seen[0] as { name: string }).name).toBe(ADVISOR_SECTION_NAME)
    expect(typeof dispose).toBe('function')
  })

  it('applyAdvisorPrompt 经真实 cordis inject 注入（systemPrompt 已提供）', async () => {
    const ctx = new Context()
    const sections: Array<{ name: string; order: number }> = []
    ctx.provide('systemPrompt', {
      section(s: { name: string; order: number }) {
        sections.push(s)
        return () => {}
      },
    })

    applyAdvisorPrompt(ctx)
    // inject 回执为 fiber；等待其 settle。
    await new Promise((r) => setTimeout(r, 0))

    expect(sections.some((s) => s.name === ADVISOR_SECTION_NAME)).toBe(true)

    await ctx.fiber.dispose()
  })
})

/* ------------------------------------------------------------------ *
 * 插件 apply 接入：mock ctx 注册 5 skill + 1 prompt section
 * ------------------------------------------------------------------ */

describe('插件 apply 接入', () => {
  it('顶层 inject 契约不变', () => {
    expect(topLevelInject).toEqual(['tools', 'skills', 'fs'])
  })

  function makeMockCtx() {
    const registeredSkills: Array<{ name: string; source: string; content: string }> = []
    const injectedSections: Array<{ name: string; order: number }> = []
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
            section(s: { name: string; order: number }) {
              injectedSections.push(s)
              return () => {}
            },
          },
        })
        return {}
      },
      skills: skillsService,
      tools: { register: () => () => {} },
    } as unknown as Context
    return { ctx, registeredSkills, injectedSections }
  }

  it('apply 不再静态注册 SKILL（改由 provider 承担），注入 1 个 prompt section，且不抛异常', () => {
    // 防止 ensureSkillAssetsRepo 回落到默认 `~/.dsh-finance`（污染 home）。
    const dataRoot = makeSeededDataRoot()
    const prev = process.env.DSH_FINANCE_DATA_DIR
    process.env.DSH_FINANCE_DATA_DIR = dataRoot
    try {
      const { ctx, registeredSkills, injectedSections } = makeMockCtx()
      expect(() => apply(ctx)).not.toThrow()

      // 静态注册三件套已移除：不再有 `ctx.skills.register` 调用。
      expect(registeredSkills).toHaveLength(0)

      // advisor section 注入保持不变。
      expect(injectedSections).toHaveLength(1)
      expect(injectedSections[0].name).toBe(ADVISOR_SECTION_NAME)
    } finally {
      if (prev === undefined) delete process.env.DSH_FINANCE_DATA_DIR
      else process.env.DSH_FINANCE_DATA_DIR = prev
    }
  })

  it('缺失 skills 服务时不抛错（安全降级）', () => {
    const dataRoot = makeSeededDataRoot()
    const prev = process.env.DSH_FINANCE_DATA_DIR
    process.env.DSH_FINANCE_DATA_DIR = dataRoot
    try {
      const ctx = {
        effect(body: () => unknown) {
          body()
          return () => {}
        },
        get: () => undefined,
        inject: () => ({}),
        tools: { register: () => () => {} },
      } as unknown as Context
      expect(() => apply(ctx)).not.toThrow()
    } finally {
      if (prev === undefined) delete process.env.DSH_FINANCE_DATA_DIR
      else process.env.DSH_FINANCE_DATA_DIR = prev
    }
  })
})

/* ------------------------------------------------------------------ *
 * copy-assets：dist-server 下 .md 路径可解析
 * ------------------------------------------------------------------ */

describe('copy-assets 产物', () => {
  it('执行后 dist-server 下 prompts/skills 的 .md 均存在且与源码一致', () => {
    execFileSync('node', ['scripts/copy-assets.mjs'], { cwd: REPO_ROOT, stdio: 'ignore' })

    const checks: Array<[string, string]> = [
      ['dist-server/prompts/advisor.md', 'src/prompts/advisor.md'],
      ...SKILL_NAMES.map(
        (n) => [`dist-server/skills/${n}/SKILL.md`, `src/skills/${n}/SKILL.md`] as [string, string],
      ),
    ]
    for (const [distRel, srcRel] of checks) {
      const dist = `${REPO_ROOT}/${distRel}`
      const src = `${REPO_ROOT}/${srcRel}`
      expect(existsSync(dist), `缺少产物 ${distRel}`).toBe(true)
      expect(readFileSync(dist, 'utf8')).toBe(readFileSync(src, 'utf8'))
    }
  })
})
