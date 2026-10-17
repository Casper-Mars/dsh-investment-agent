/**
 * 【独立验证】Tester 复测：dsh-ia Prompt 与 Skills 层（飞书任务 t100355）。
 *
 * 本文件由 Tester 独立编写，**不依赖** Developer 已写的 tests/prompt-skills.spec.ts，
 * 从「外部行为 + 权威 harness 契约」角度重跑 5 条验收点，并对边界与运行时注册机制
 * 做更强的独立观测。
 *
 * 覆盖（对应建议测试方式 1-8）：
 *   1. frontmatter 解析边界（正常 / CRLF / BOM / 转义 / 缺 description / 非 kebab / 缺 whenToUse）
 *   2. 5 个可进化 SKILL.md 逐字段校验（含用 harness 权威 isSkillName 复核 kebab-case）
 *      + 固有 SKILL task-authorship 的静态读取入口正向校验
 *   3. 真实 SkillRegistry 注册 / 发现 / 注销
 *   4. system-prompt 注入契约（stub + 真实 cordis 双路）
 *   5. 顶层 inject 契约不变
 *   6. 验收点 3：全文数值扫描（写死价格 / 阈值）
 *   7. copy-assets 产物 + 编译态 new URL 可解析
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { afterEach, describe, it, expect } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SkillRegistry, { isSkillName } from '@deepseek-ai/dsh-skill'
import {
  SKILL_NAMES,
  TASK_AUTHORSHIP_SKILL_NAME,
  loadSkillMarkdown,
  loadTaskAuthorshipMarkdown,
  parseSkill,
} from '../src/skills/index'
import { ensureSkillAssetsRepo } from '../src/skills/repo'
import {
  mountSkillFilesystemProviderAsync,
  SKILL_PROVIDER_NAME,
} from '../src/skills/provider'
import { parseSkillFile, SKILL_NAME_PATTERN } from '../src/skills/frontmatter'
import {
  ADVISOR_SECTION_NAME,
  ADVISOR_SECTION_ORDER,
  loadAdvisorMd,
  createAdvisorSection,
  applyAdvisorPrompt,
  type PromptSectionLike,
  type SystemPromptLike,
} from '../src/prompts/index'
import { apply, inject as topLevelInject } from '../src/plugin'

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))

const tmpDirs: string[] = []

/** 建临时 finance home 并在其 assets/ 下预置 5 个可进化 skill（真实 git 仓库）。 */
function makeSeededFinanceHome(): { home: string; assetsDir: string } {
  const home = mkdtempSync(join(tmpdir(), 'dsh-ia-tester-prompt-skills-'))
  tmpDirs.push(home)
  const assetsDir = join(home, 'assets')
  ensureSkillAssetsRepo({ assetsDir, logger: () => {} })
  return { home, assetsDir }
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
const EXPECTED_SKILLS = [
  'trend-analysis',
  'grid-strategy',
  'stop-rule',
  'strategy-authorship',
  'analysis-decision',
]

/**
 * 固有 SKILL（任务程序方法论）：**不**落 `<assetsDir>/skills`，不参与 provider 发现，
 * 由 `plugin.ts` 静态注册，独立于 git 进化链。
 */
const INTRINSIC_SKILL = TASK_AUTHORSHIP_SKILL_NAME

/** 7 份待扫描全文（advisor.md + 5 个可进化 SKILL.md + 1 个固有 SKILL.md，验收点 3 的扫描面）。 */
function allTexts(): Array<[string, string]> {
  return [
    ['src/prompts/advisor.md', loadAdvisorMd()],
    ...SKILL_NAMES.map((n) => [`src/skills/${n}/SKILL.md`, loadSkillMarkdown(n)] as [string, string]),
    [`src/skills/${INTRINSIC_SKILL}/SKILL.md`, loadTaskAuthorshipMarkdown()],
  ]
}

/* ================================================================== *
 * 1. frontmatter 解析边界
 * ================================================================== */

describe('[1] frontmatter 解析边界', () => {
  it('正常 LF + 三字段（含无引号值）', () => {
    const raw = '---\nname: my-skill\ndescription: 一段描述\nwhenToUse: 何时用\n---\n\n# Body\ntext\n'
    const { frontmatter, content } = parseSkillFile(raw)
    expect(frontmatter).toEqual({ name: 'my-skill', description: '一段描述', whenToUse: '何时用' })
    expect(content).toBe('# Body\ntext')
  })

  it('CRLF 归一化后可解析', () => {
    const raw = '---\r\nname: crlf-skill\r\ndescription: d\r\nwhenToUse: w\r\n---\r\nbody\r\n'
    const { frontmatter, content } = parseSkillFile(raw)
    expect(frontmatter.name).toBe('crlf-skill')
    expect(frontmatter.whenToUse).toBe('w')
    expect(content).toBe('body')
  })

  it('BOM 前缀可解析', () => {
    const raw = '\uFEFF---\nname: bom-skill\ndescription: d\n---\nbody'
    expect(parseSkillFile(raw).frontmatter.name).toBe('bom-skill')
  })

  it('双引号值还原 \\" 与 \\n 转义', () => {
    const raw = '---\nname: "quoted-skill"\ndescription: "a \\"q\\" b\\nline2"\n---\nbody'
    const { frontmatter } = parseSkillFile(raw)
    expect(frontmatter.name).toBe('quoted-skill')
    expect(frontmatter.description).toBe('a "q" b\nline2')
  })

  it('单引号值还原 YAML 的 \'\' 转义', () => {
    const raw = "---\nname: single-skill\ndescription: 'it''s ok'\n---\nbody"
    expect(parseSkillFile(raw).frontmatter.description).toBe("it's ok")
  })

  it('缺 description → 抛错', () => {
    expect(() => parseSkillFile('---\nname: ok-name\n---\nx')).toThrow(/description/)
  })

  it('name 非 kebab-case → 抛错', () => {
    expect(() => parseSkillFile('---\nname: Bad_Name\ndescription: d\n---\nx')).toThrow(/kebab-case/)
    expect(() => parseSkillFile('---\nname: Bad-Name\ndescription: d\n---\nx')).toThrow(/kebab-case/)
    expect(() => parseSkillFile('---\nname: bad name\ndescription: d\n---\nx')).toThrow(/kebab-case/)
  })

  it('缺 whenToUse → 通过（可选）', () => {
    const { frontmatter } = parseSkillFile('---\nname: no-when\ndescription: d\n---\nbody')
    expect(frontmatter.whenToUse).toBeUndefined()
    expect(frontmatter.name).toBe('no-when')
  })

  it('缺 frontmatter / 未闭合 → 抛错', () => {
    expect(() => parseSkillFile('# no fm')).toThrow(/frontmatter/)
    expect(() => parseSkillFile('---\nname: x\ndescription: d')).toThrow(/未闭合|frontmatter/)
  })
})

/* ================================================================== *
 * 2. 5 个可进化 SKILL.md + 1 个固有 SKILL 校验
 * ================================================================== */

describe('[2] 5 个可进化 SKILL.md 逐字段校验', () => {
  it('SKILL_NAMES 恰为 5 个（顺序即注册顺序）', () => {
    expect(SKILL_NAMES).toHaveLength(5)
  })

  it('固有 SKILL task-authorship：常量正确、不在可进化清单、原文可读且 frontmatter 合法', () => {
    expect(INTRINSIC_SKILL).toBe('task-authorship')
    expect(SKILL_NAMES as readonly string[]).not.toContain(INTRINSIC_SKILL)
    const { frontmatter, content } = parseSkillFile(loadTaskAuthorshipMarkdown())
    expect(frontmatter.name).toBe(INTRINSIC_SKILL)
    expect(SKILL_NAME_PATTERN.test(frontmatter.name)).toBe(true)
    expect(isSkillName(frontmatter.name)).toBe(true)
    expect(frontmatter.description.trim().length).toBeGreaterThan(0)
    expect(content.trim().length).toBeGreaterThan(100)
  })

  it('SKILL_NAMES 与预期集合一致', () => {
    expect([...SKILL_NAMES].sort()).toEqual([...EXPECTED_SKILLS].sort())
  })

  it.each(EXPECTED_SKILLS)('%s：name=目录名、kebab-case（自校验 + harness 权威 double-check）、description/whenToUse 非空', (name) => {
    expect(SKILL_NAMES).toContain(name)
    const { frontmatter } = parseSkill(name)
    expect(frontmatter.name).toBe(name) // 与目录名一致
    expect(SKILL_NAME_PATTERN.test(frontmatter.name)).toBe(true) // 本地正则
    expect(isSkillName(frontmatter.name)).toBe(true) // harness 权威校验
    expect(frontmatter.description.trim().length).toBeGreaterThan(0)
    expect(typeof frontmatter.whenToUse).toBe('string')
    expect((frontmatter.whenToUse ?? '').trim().length).toBeGreaterThan(0)
  })

  it('每个目录的物理文件名确为 SKILL.md（skill-filesystem 发现规范）', () => {
    for (const n of EXPECTED_SKILLS) {
      expect(existsSync(`${REPO_ROOT}/src/skills/${n}/SKILL.md`)).toBe(true)
    }
  })
})

/* ================================================================== *
 * 3. 真实 SkillRegistry + skill-filesystem provider 发现 / 注销
 * ================================================================== */

describe('[3] 经 skill-filesystem provider 发现', () => {
  it('挂载 provider 后 list() 发现 5 个；get() 取回正文；注销后归 0', async () => {
    const { assetsDir } = makeSeededFinanceHome()
    const ctx = new Context()
    await (ctx.plugin(SkillRegistry as never) as Promise<unknown>)

    // 前置：干净上下文里没有这 5 个可进化 skill（固有 SKILL 不经 provider，亦无）。
    const before = await ctx.skills.list({})
    expect(before.filter((s) => EXPECTED_SKILLS.includes(s.name))).toHaveLength(0)

    const mount = await mountSkillFilesystemProviderAsync(ctx, { assetsDir })

    const after = await ctx.skills.list({})
    const got = after.filter((s) => EXPECTED_SKILLS.includes(s.name))
    expect(got.map((s) => s.name).sort()).toEqual([...EXPECTED_SKILLS].sort())
    for (const s of got) {
      expect(s.source).toBe('custom')
      expect(s.provider).toBe(SKILL_PROVIDER_NAME)
    }

    // 逐个 get 校验正文与 whenToUse。
    for (const n of EXPECTED_SKILLS) {
      const def = await ctx.skills.get(n)
      expect(def?.name).toBe(n)
      expect(def?.content).toBe(parseSkill(n).content)
      expect(def?.whenToUse).toBeDefined()
      expect(def?.invocation).toEqual({ modelInvocable: true, userInvocable: true })
    }

    await mount.dispose()
    const finalList = await ctx.skills.list({})
    expect(finalList.filter((s) => EXPECTED_SKILLS.includes(s.name))).toHaveLength(0)

    await ctx.fiber.dispose()
  })
})

/* ================================================================== *
 * 4. system-prompt 注入
 * ================================================================== */

describe('[4] advisor 人设注入 system-prompt', () => {
  it('stub 路径：ctx.inject 依赖仅为 [systemPrompt]，注册 1 个 section，未传 complete:true', () => {
    const capturedSections: PromptSectionLike[] = []
    const injectedDeps: string[][] = []
    const systemPrompt: SystemPromptLike = {
      section(s) {
        capturedSections.push(s)
        return () => {}
      },
    }
    const ctx = {
      inject(deps: string[], cb: (c: unknown) => void) {
        injectedDeps.push(deps)
        cb({ systemPrompt })
        return {}
      },
    } as unknown as Context

    applyAdvisorPrompt(ctx)

    // 动态声明依赖恰为 ['systemPrompt']（未动顶层 inject）。
    expect(injectedDeps).toHaveLength(1)
    expect(injectedDeps[0]).toEqual(['systemPrompt'])

    // 恰注册 1 个 section，契约正确。
    expect(capturedSections).toHaveLength(1)
    const s = capturedSections[0]
    expect(s.name).toBe(ADVISOR_SECTION_NAME)
    expect(ADVISOR_SECTION_NAME).toBe('dsh-ia:advisor')
    expect(typeof s.order).toBe('number')
    expect(s.order).toBe(ADVISOR_SECTION_ORDER)
    expect(typeof s.text).toBe('function')
    expect((s.text as () => string)()).toBe(loadAdvisorMd())
    // 明确：不使用 complete（避免覆盖部署 persona）。
    expect(s.complete).toBeUndefined()
    expect('complete' in s).toBe(false)
  })

  it('createAdvisorSection 惰性取值、非 complete', () => {
    const s = createAdvisorSection()
    expect(s.name).toBe('dsh-ia:advisor')
    expect(Number.isFinite(s.order)).toBe(true)
    expect(typeof s.text).toBe('function')
    expect((s.text as () => string)().length).toBeGreaterThan(300)
    expect(s.complete).toBeUndefined()
  })

  it('真实 cordis 路径：provide(systemPrompt) 后 applyAdvisorPrompt 注入成功', async () => {
    const ctx = new Context()
    const sections: Array<{ name: string; order: number }> = []
    ctx.provide('systemPrompt', {
      section(s: { name: string; order: number }) {
        sections.push(s)
        return () => {}
      },
    })
    applyAdvisorPrompt(ctx)
    await new Promise((r) => setTimeout(r, 0))
    expect(sections.some((s) => s.name === 'dsh-ia:advisor')).toBe(true)
    await ctx.fiber.dispose()
  })
})

/* ================================================================== *
 * 5. 顶层 inject 契约不变
 * ================================================================== */

describe('[5] 顶层 inject 契约', () => {
  it('严格等于 [tools, skills, fs]，不含 systemPrompt', () => {
    expect(topLevelInject).toEqual(['tools', 'skills', 'fs'])
    expect(topLevelInject).toHaveLength(3)
    expect(topLevelInject).not.toContain('systemPrompt')
  })

  it('apply(ctx) 后顶层 inject 未被改写', () => {
    // 防 ensureSkillAssetsRepo 回落到默认 `~/.dsh-ia`（污染 home）。
    const { home } = makeSeededFinanceHome()
    const prev = process.env.DSH_IA_HOME
    process.env.DSH_IA_HOME = home
    try {
      const ctx = {
        effect(body: () => unknown) {
          const d = body()
          return typeof d === 'function' ? (d as () => void) : () => {}
        },
        get: () => undefined,
        inject: () => ({}),
        tools: { register: () => () => {} },
      } as unknown as Context
      apply(ctx)
      expect(topLevelInject).toEqual(['tools', 'skills', 'fs'])
    } finally {
      if (prev === undefined) delete process.env.DSH_IA_HOME
      else process.env.DSH_IA_HOME = prev
    }
  })
})

/* ================================================================== *
 * 0. 验收点 1：advisor.md 四块结构 + 文末合规声明
 * ================================================================== */

describe('[0] advisor.md 人设结构', () => {
  const md = loadAdvisorMd()

  it('含 角色 / 原则 / 工作流 / 合规 四大板块', () => {
    expect(md).toMatch(/#+\s*角色/)
    expect(md).toMatch(/#+\s*原则/)
    expect(md).toMatch(/#+\s*工作流/)
    expect(md).toMatch(/#+\s*合规/)
  })

  it('末尾（最后一个非空行）以风险提示收尾，且不含已废弃的「本内容不构成投资建议」', () => {
    const lines = md.split('\n').map((l) => l.trim()).filter((l) => l.length > 0)
    // 当前实现（145a784 之后）：合规板块以风险提示收尾。
    expect(lines.at(-1)).toContain('市场有风险，决策需谨慎')
    // 防回归：被删除的「本内容不构成投资建议」声明不应再出现。
    expect(md).not.toContain('本内容不构成投资建议')
  })
})

/* ================================================================== *
 * 5b. 真实 cordis 装配：apply(ctx) 端到端
 * ================================================================== */

describe('[5b] 真实 cordis 下 apply(ctx) 端到端装配', () => {
  it('apply 后 5 个可进化 skill 经 provider 可发现（+ 固有 SKILL 静态注册），且 advisor section 被注入', async () => {
    const { home } = makeSeededFinanceHome()
    const prev = process.env.DSH_IA_HOME
    process.env.DSH_IA_HOME = home
    try {
      const ctx = new Context()
      await (ctx.plugin(SkillRegistry as never) as Promise<unknown>)

      const sections: Array<{ name: string; order: number }> = []
      ctx.provide('systemPrompt', {
        section(s: { name: string; order: number }) {
          sections.push(s)
          return () => {}
        },
      })

      apply(ctx)
      // provider 惰性加载 + 挂载：等待其就绪。
      await new Promise((r) => setTimeout(r, 0))

      let names: string[] = []
      for (let i = 0; i < 80; i += 1) {
        const summaries = await ctx.skills.list({})
        names = summaries
          .map((s) => s.name)
          .filter((n) => EXPECTED_SKILLS.includes(n))
          .sort()
        if (names.length === EXPECTED_SKILLS.length) break
        await new Promise((r) => setTimeout(r, 50))
      }
      expect(names).toEqual([...EXPECTED_SKILLS].sort())
      // 固有 SKILL task-authorship 经 apply 静态注册可见（source=runtime），不经 provider。
      const intrinsic = (await ctx.skills.list({})).find((s) => s.name === INTRINSIC_SKILL)
      expect(intrinsic, '固有 SKILL 应经静态注册可见').toBeDefined()
      expect(intrinsic?.source).toBe('runtime')

      expect(sections.some((s) => s.name === 'dsh-ia:advisor')).toBe(true)

      await ctx.fiber.dispose()
    } finally {
      if (prev === undefined) delete process.env.DSH_IA_HOME
      else process.env.DSH_IA_HOME = prev
    }
  })
})

/* ================================================================== *
 * 6. 验收点 3：全文数值扫描
 * ================================================================== */

describe('[6] 全文无写死价格 / 阈值', () => {
  it('不出现小数形态数值（价格典型特征）', () => {
    for (const [label, text] of allTexts()) {
      // 版本号（semver，如 1.0.0 / ^22.0.0）非价格：先剔除再扫描。
      const withoutSemver = text.replace(/\^?\d+\.\d+\.\d+/g, '')
      const m = withoutSemver.match(/(?<![`\w])\d+\.\d+(?![`\w])/g)
      expect(m, `${label} 含疑似小数价格: ${m}`).toBeNull()
    }
  })

  it('不出现「止损/止盈/突破 + 数字」「百分比」「元」等阈值写法', () => {
    const patterns: Array<[string, RegExp]> = [
      ['止损后跟数字', /止损[0-9]/],
      ['止盈后跟数字', /止盈[0-9]/],
      ['突破后跟数字', /突破[0-9]/],
      ['百分号阈值', /\d\s*%/],
      ['元表示价格', /\d\s*元/],
    ]
    for (const [label, text] of allTexts()) {
      for (const [pname, re] of patterns) {
        const m = text.match(re)
        expect(m, `${label} 命中「${pname}」: ${m}`).toBeNull()
      }
    }
  })

  it('全部数字 token 落在合规白名单内（序号 / 置信度 / 标的代码 / 名称）', () => {
    // 允许：列表序号 1-5、置信度标度 0-1、标的代码 588000、名称中的 50（科创50ETF）；
    // 以及 task-authorship 中非阈值字面量：依赖版本号片段 22（^22.0.0）、默认超时 60（60s）。
    const ALLOWED = new Set(['0', '1', '2', '3', '4', '5', '22', '50', '60', '588000'])
    for (const [label, text] of allTexts()) {
      const tokens = text.match(/\d+/g) ?? []
      const illegal = [...new Set(tokens.filter((t) => !ALLOWED.has(t)))]
      expect(illegal, `${label} 出现白名单外数值: ${illegal.join(', ')}`).toEqual([])
    }
  })

  it('阈值类表述一律指向「该标的策略文档」且声明不硬编码', () => {
    const joined = allTexts().map(([, t]) => t).join('\n')
    expect(joined).toMatch(/该标的策略文档/)
    expect(joined).toMatch(/不(写死|硬编|硬编码)/)
  })
})

/* ================================================================== *
 * 8. copy-assets 产物 + 编译态 new URL 解析
 * ================================================================== */

describe('[8] copy-assets 产物与编译态路径', () => {
  it('搬运后 dist-server 下 5 个可进化 .md 存在且与源码一致，编译态 new URL 可解析', async () => {
    execFileSync('node', ['scripts/copy-assets.mjs'], { cwd: REPO_ROOT, stdio: 'ignore' })

    const checks: Array<[string, string]> = [
      ['dist-server/prompts/advisor.md', 'src/prompts/advisor.md'],
      ...EXPECTED_SKILLS.map(
        (n) => [`dist-server/skills/${n}/SKILL.md`, `src/skills/${n}/SKILL.md`] as [string, string],
      ),
    ]
    for (const [distRel, srcRel] of checks) {
      const distAbs = `${REPO_ROOT}/${distRel}`
      expect(existsSync(distAbs), `缺产物 ${distRel}`).toBe(true)
      expect(readFileSync(distAbs, 'utf8')).toBe(readFileSync(`${REPO_ROOT}/${srcRel}`, 'utf8'))
    }

    // 编译态：以 dist-server/prompts/index.js 的 URL 为基准做 new URL 解析。
    const promptIdxUrl = pathToFileURL(`${REPO_ROOT}/dist-server/prompts/index.js`)
    const distAdvisor = new URL('./advisor.md', promptIdxUrl)
    expect(readFileSync(distAdvisor, 'utf8')).toBe(loadAdvisorMd())

    // 编译态：dist-server/skills/index.js 基准逐个解析 SKILL.md。
    const skillIdxUrl = pathToFileURL(`${REPO_ROOT}/dist-server/skills/index.js`)
    for (const n of EXPECTED_SKILLS) {
      const u = new URL(`./${n}/SKILL.md`, skillIdxUrl)
      expect(readFileSync(u, 'utf8')).toBe(loadSkillMarkdown(n as (typeof SKILL_NAMES)[number]))
    }
  })

  it('编译产物模块可直接加载 dist 下的资源（运行时闭环）', async () => {
    const promptMod = (await import(
      pathToFileURL(`${REPO_ROOT}/dist-server/prompts/index.js`).href
    )) as { loadAdvisorMd: () => string }
    expect(promptMod.loadAdvisorMd()).toBe(loadAdvisorMd())

    const skillMod = (await import(
      pathToFileURL(`${REPO_ROOT}/dist-server/skills/index.js`).href
    )) as { parseSkill: (n: string) => { frontmatter: { name: string } } }
    for (const n of EXPECTED_SKILLS) {
      expect(skillMod.parseSkill(n).frontmatter.name).toBe(n)
    }
  })
})
