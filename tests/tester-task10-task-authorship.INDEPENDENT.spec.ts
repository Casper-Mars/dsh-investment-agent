/**
 * tester-task10-task-authorship.INDEPENDENT.spec.ts
 * ==================================================================
 * Tester 独立复验（飞书任务卡 t100386）：新增技术面 SKILL ——
 * `task-authorship`（任务程序创作），`SKILL_NAMES` 计数 4 → 5。
 *
 * 被测交付物：
 *   - 新增 `src/skills/task-authorship/SKILL.md`（按 §10.2 逐字落地）
 *   - `src/skills/index.ts`：SKILL_NAMES 追加 `'task-authorship'`（末尾）、计数 4 → 5
 *   - `src/skills/README.md`、`src/plugin.ts`：计数表述同步为 5
 *
 * 独立性声明：本文件由 Tester 独立编写，**不依赖** Developer 的
 * `tests/prompt-skills.spec.ts`。分两条独立证据链：
 *   1) 源码态：`src/skills/*` 逐要素比对 §10.2 要素清单（关键词 / 结构）；
 *   2) 装载态：真实 `@deepseek-ai/dsh-skill` SkillRegistry + 真实构建产物
 *      `dist-server/` 插件装载，观测 `ctx.skills` 恰好注册 5 个 SKILL。
 *
 * 覆盖 8 条验收点：
 *   1. SKILL.md 存在 + frontmatter（name=kebab / description / whenToUse）
 *   2. 正文要素齐全（对照 §10.2 清单）
 *   3. SKILL_NAMES 末尾含 task-authorship、长度 5、顺序正确
 *   4. parseSkill('task-authorship') 可解析、content 非空
 *   5. 真实装载后 ctx.skills 恰好注册 5 个，名称与 SKILL_NAMES 一致（含注销）
 *   6. index.ts / README.md / plugin.ts 计数表述为 5
 *   7. task-authorship 正文标的无关（无写死价格 / 阈值）
 *   8. 顶层 inject 契约仍为 [tools, skills, fs]
 * ==================================================================
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import ToolRuntime from '@deepseek-ai/dsh-tools'
// ★ 真实构建产物入口（dist-server），验证编译态同样注册 5 个 SKILL。
import * as pluginNs from '../dist-server/index.js'
import {
  SKILL_NAMES,
  loadSkillMarkdown,
  parseSkill,
  createSkillRegistration,
  createAllSkillRegistrations,
  registerAllSkills,
} from '../src/skills/index.js'
import { parseSkillFile, SKILL_NAME_PATTERN } from '../src/skills/frontmatter.js'
import { inject as srcInject } from '../src/plugin.js'

const PROJECT_ROOT = fileURLToPath(new URL('..', import.meta.url))

/** 期望的 5 个 SKILL（顺序 = 注册顺序）。 */
const EXPECTED_SKILLS = [
  'trend-analysis',
  'grid-strategy',
  'stop-rule',
  'strategy-authorship',
  'task-authorship',
] as const

const TA = 'task-authorship'

/* ================================================================== *
 * 验收 1：SKILL.md 存在 + frontmatter
 * ================================================================== */

describe('[验收1] task-authorship SKILL.md 存在与 frontmatter', () => {
  it('物理文件 src/skills/task-authorship/SKILL.md 存在', () => {
    expect(existsSync(`${PROJECT_ROOT}/src/skills/${TA}/SKILL.md`)).toBe(true)
  })

  it('frontmatter：name=task-authorship（kebab-case）、description / whenToUse 非空', () => {
    const raw = readFileSync(`${PROJECT_ROOT}/src/skills/${TA}/SKILL.md`, 'utf8')
    const { frontmatter, content } = parseSkillFile(raw)
    expect(frontmatter.name).toBe(TA)
    expect(SKILL_NAME_PATTERN.test(frontmatter.name)).toBe(true)
    expect(frontmatter.description.trim().length).toBeGreaterThan(0)
    expect(typeof frontmatter.whenToUse).toBe('string')
    expect((frontmatter.whenToUse ?? '').trim().length).toBeGreaterThan(0)
    // 正文非空且无 frontmatter 分隔符残留。
    expect(content.trim().length).toBeGreaterThan(200)
    expect(content.startsWith('---')).toBe(false)
    // description / whenToUse 语义与 §10.2 一致（“编写/修改任务程序”“生成/修改/替换”）。
    expect(frontmatter.description).toMatch(/任务程序/)
    expect(frontmatter.whenToUse).toMatch(/任务程序/)
  })

  it('目录名 = frontmatter.name（skill-filesystem 发现规范）', () => {
    const { frontmatter } = parseSkill(TA)
    expect(frontmatter.name).toBe(TA)
  })
})

/* ================================================================== *
 * 验收 2：正文要素齐全（对照 §10.2 清单）
 * ================================================================== */

describe('[验收2] 正文覆盖 §10.2 全部要素', () => {
  const body = parseSkill(TA).content

  it('① 定位：指导 agent 编写/修改任务程序；职责只有执行 + 判读；交易判断属 agent；何时跑由 cron 决定', () => {
    expect(body).toMatch(/定位/)
    expect(body).toMatch(/编写\s*\/\s*修改|编写.*修改/)
    expect(body).toMatch(/任务程序/)
    expect(body).toMatch(/执行/)
    expect(body).toMatch(/判读/)
    expect(body).toMatch(/交易判断属于 agent|交易判断.*agent/)
    expect(body).toMatch(/cron/)
  })

  it('② 任务程序结构：ESM TS + export default async function task(): Promise<TaskScriptResult>；技术栈 TS + Node', () => {
    expect(body).toMatch(/ESM/)
    expect(body).toMatch(/TypeScript/)
    expect(body).toMatch(/export default async function task\(\)/)
    expect(body).toMatch(/Promise<TaskScriptResult>/)
    expect(body).toMatch(/Node/)
    // 技术栈能力：顶层 await / import npm 包 / fetch。
    expect(body).toMatch(/await/)
    expect(body).toMatch(/import/)
    expect(body).toMatch(/fetch/)
  })

  it('③ 返回值契约：TaskScriptResult 两分支；shouldWake 必须 boolean；data 为 string', () => {
    expect(body).toMatch(/TaskScriptResult/)
    expect(body).toMatch(/shouldWake/) // 契约核心字段
    expect(body).toMatch(/shouldWake:\s*true/)
    expect(body).toMatch(/shouldWake:\s*false/)
    expect(body).toMatch(/必须为\s*boolean|boolean/)
    expect(body).toMatch(/skipped/) // 非 boolean 的降级语义
    expect(body).toMatch(/data/)
    expect(body).toMatch(/字符串|string/)
  })

  it('④ 依赖声明：任务目录自己的 package.json，按任务隔离安装', () => {
    expect(body).toMatch(/package\.json/)
    expect(body).toMatch(/依赖/)
    expect(body).toMatch(/隔离/)
  })

  it('⑤ 结果回传：stdout 最后一行 JSON；异常降级 failed / skipped', () => {
    expect(body).toMatch(/stdout/)
    expect(body).toMatch(/最后一行/)
    expect(body).toMatch(/JSON/)
    expect(body).toMatch(/failed/)
    expect(body).toMatch(/skipped/)
  })

  it('⑥ 版本管理：git commit / checkout / revert；定时层直接跑工作区 task.ts', () => {
    expect(body).toMatch(/git/)
    expect(body).toMatch(/commit/)
    expect(body).toMatch(/checkout/)
    expect(body).toMatch(/revert/)
    expect(body).toMatch(/task\.ts/)
  })

  it('⑦ 反例：不做交易判断 / 不写死 cron / 不写全局数据目录 / 不超时久跑（默认 60s）', () => {
    expect(body).toMatch(/反例/)
    expect(body).toMatch(/不做交易判断/)
    expect(body).toMatch(/不写死\s*cron|cron/)
    expect(body).toMatch(/全局数据目录/)
    expect(body).toMatch(/超时/)
    expect(body).toMatch(/60/)
  })

  it('⑧ 与定时规则配合：写程序 + task_create 注册；改逻辑动程序、改频率动 cron', () => {
    expect(body).toMatch(/task_create/)
    expect(body).toMatch(/频率|cron/)
  })
})

/* ================================================================== *
 * 验收 3：SKILL_NAMES 长度 / 顺序 / 末尾
 * ================================================================== */

describe('[验收3] SKILL_NAMES 恰为 5 个且顺序正确', () => {
  it('长度 = 5', () => {
    expect(SKILL_NAMES).toHaveLength(5)
  })

  it('顺序：trend-analysis → grid-strategy → stop-rule → strategy-authorship → task-authorship', () => {
    expect([...SKILL_NAMES]).toEqual([...EXPECTED_SKILLS])
  })

  it('末尾为 task-authorship；原 4 个位置不变', () => {
    expect(SKILL_NAMES[SKILL_NAMES.length - 1]).toBe(TA)
    expect([...SKILL_NAMES].slice(0, 4)).toEqual([...EXPECTED_SKILLS].slice(0, 4))
  })

  it('每个名称均为 kebab-case', () => {
    for (const n of SKILL_NAMES) expect(SKILL_NAME_PATTERN.test(n)).toBe(true)
  })
})

/* ================================================================== *
 * 验收 4：parseSkill 契约
 * ================================================================== */

describe('[验收4] parseSkill(task-authorship) 可解析', () => {
  it('返回 frontmatter.name = task-authorship 且 content 非空', () => {
    const { frontmatter, content } = parseSkill(TA)
    expect(frontmatter.name).toBe(TA)
    expect(content.trim().length).toBeGreaterThan(200)
    expect(loadSkillMarkdown(TA)).toContain('task-authorship')
  })

  it('createSkillRegistration：runtime 来源 + 双开调用 + content = 正文', () => {
    const reg = createSkillRegistration(TA)
    expect(reg.name).toBe(TA)
    expect(reg.description.length).toBeGreaterThan(0)
    expect(reg.source).toBe('runtime')
    expect(reg.invocation).toEqual({ modelInvocable: true, userInvocable: true })
    expect(reg.content).toBe(parseSkill(TA).content)
  })

  it('createAllSkillRegistrations 返回 5 个，名称与 SKILL_NAMES 一致', () => {
    const regs = createAllSkillRegistrations()
    expect(regs).toHaveLength(5)
    expect(regs.map((r) => r.name)).toEqual([...SKILL_NAMES])
  })
})

/* ================================================================== *
 * 验收 5：真实装载注册 5 个（SkillRegistry + dist 插件）
 * ================================================================== */

describe('[验收5] 真实装载后 ctx.skills 恰好注册 5 个', () => {
  it('真实 SkillRegistry：registerAllSkills 后 5 个可发现，注销后归 0', async () => {
    const ctx = new Context()
    await (ctx.plugin(SkillRegistry as never) as Promise<unknown>)

    const before = await ctx.skills.list({})
    expect(before.filter((s) => (EXPECTED_SKILLS as readonly string[]).includes(s.name))).toHaveLength(0)

    const dispose = registerAllSkills(ctx)

    const after = await ctx.skills.list({})
    const got = after.filter((s) => (EXPECTED_SKILLS as readonly string[]).includes(s.name))
    expect(got).toHaveLength(5)
    expect(got.map((s) => s.name).sort()).toEqual([...EXPECTED_SKILLS].sort())

    for (const n of EXPECTED_SKILLS) {
      const def = await ctx.skills.get(n)
      expect(def?.name).toBe(n)
      expect(def?.content).toBe(parseSkill(n).content)
      expect(def?.invocation).toEqual({ modelInvocable: true, userInvocable: true })
    }

    dispose()
    const finalList = await ctx.skills.list({})
    expect(
      finalList.filter((s) => (EXPECTED_SKILLS as readonly string[]).includes(s.name)),
    ).toHaveLength(0)

    await ctx.fiber.dispose()
  })

  it('真实构建产物 dist-server 装载：skills 注册 5 个，顺序与 SKILL_NAMES 一致', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-fin-ta-'))
    process.env.DSH_FINANCE_DATA_DIR = dir

    const registered: Array<{ name: string; description: string; content: string }> = []
    const skillsService = {
      name: 'skills',
      register(s: { name: string; description: string; content: string }) {
        registered.push(s)
        return () => {
          const i = registered.indexOf(s)
          if (i >= 0) registered.splice(i, 1)
        }
      },
    }
    const systemPromptStub = {
      name: 'systemPrompt',
      tools() {},
      section() {
        return () => {}
      },
      getSectionOrder() {
        return 0
      },
    }
    const app = new Context()
    app.provide('systemPrompt', systemPromptStub as never)
    app.provide('skills', skillsService as never)
    app.provide('fs', { name: 'fs' } as never)

    const toolsFiber = (await app.plugin(ToolRuntime as never)) as unknown as {
      dispose: () => Promise<void>
    }
    const pluginFiber = app.plugin(pluginNs as never) as unknown as {
      dispose: () => Promise<void>
    }

    try {
      await vi.waitFor(() => expect(registered).toHaveLength(5), { timeout: 5000, interval: 10 })
      expect(registered.map((s) => s.name)).toEqual([...SKILL_NAMES])
      for (const s of registered) {
        expect(s.description.length, `${s.name} description 非空`).toBeGreaterThan(0)
        expect(s.content.length, `${s.name} content 非空`).toBeGreaterThan(0)
      }
      // 最后一个恰为 task-authorship。
      expect(registered[4].name).toBe(TA)

      // 注销：dispose 插件 fiber 后 5 个全部消失。
      await pluginFiber.dispose()
      expect(registered).toHaveLength(0)
    } finally {
      await toolsFiber.dispose()
      rmSync(dir, { recursive: true, force: true })
      delete process.env.DSH_FINANCE_DATA_DIR
    }
  })
})

/* ================================================================== *
 * 验收 6：计数表述同步为 5
 * ================================================================== */

describe('[验收6] index.ts / README.md / plugin.ts 计数表述为 5', () => {
  const read = (rel: string): string => readFileSync(join(PROJECT_ROOT, rel), 'utf8')

  it('src/skills/index.ts 注释计数为 5，且不再出现「6 个 …SKILL」', () => {
    const src = read('src/skills/index.ts')
    expect(src).toMatch(/5 个/)
    expect(src).not.toMatch(/6 个(运行时)?\s*SKILL/)
    expect(src).toContain("'task-authorship'")
  })

  it('src/skills/README.md 计数为 5，且不再出现「6 个 …SKILL」', () => {
    const src = read('src/skills/README.md')
    expect(src).toMatch(/5 个/)
    expect(src).not.toMatch(/6 个/)
    expect(src).toContain('task-authorship')
  })

  it('src/plugin.ts 注释计数为 5，且不再出现「6 个技术面 SKILL」', () => {
    const src = read('src/plugin.ts')
    expect(src).toMatch(/5 个技术面 SKILL/)
    expect(src).not.toMatch(/6 个技术面 SKILL/)
    expect(src).toContain('task-authorship')
  })
})

/* ================================================================== *
 * 验收 7：标的无关（无写死价格 / 阈值）
 * ================================================================== */

describe('[验收7] task-authorship 正文标的无关', () => {
  const body = parseSkill(TA).content

  it('不含具体价格形态的小数（剔除 semver 版本号后）', () => {
    // 版本号（如 1.0.0 / ^22.0.0）非价格：先剔除再扫描。
    const withoutSemver = body.replace(/\^?\d+\.\d+\.\d+/g, '')
    expect(withoutSemver).not.toMatch(/(?<![`\w])\d+\.\d+(?![`\w])/)
  })

  it('不含「元 / 百分号 / 止损停盈后跟数字」等阈值写法', () => {
    expect(body).not.toMatch(/\d\s*元/)
    expect(body).not.toMatch(/\d\s*%/)
    expect(body).not.toMatch(/止损[0-9]/)
    expect(body).not.toMatch(/止盈[0-9]/)
  })
})

/* ================================================================== *
 * 验收 8：顶层 inject 契约不变
 * ================================================================== */

describe('[验收8] 顶层 inject 契约不变', () => {
  it('src/plugin.ts 的 inject = [tools, skills, fs]', () => {
    expect(srcInject).toEqual(['tools', 'skills', 'fs'])
  })

  it('dist-server 产物 inject = [tools, skills, fs]', () => {
    expect(pluginNs.inject).toEqual(['tools', 'skills', 'fs'])
  })
})
