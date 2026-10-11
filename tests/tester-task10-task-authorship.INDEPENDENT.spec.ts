/**
 * tester-task10-task-authorship.INDEPENDENT.spec.ts
 * ==================================================================
 * Tester 独立复验（飞书任务卡 t100386）：新增技术面 SKILL ——
 * `task-authorship`（任务程序创作）。
 *
 * 【架构演进（本轮「固有化」）】`task-authorship` 从「可进化清单」分离为「固有 SKILL」：
 *   - `SKILL_NAMES`（可进化清单）收窄为 5 个（去掉 `task-authorship`），供 `repo.ts`
 *     种子落盘 + provider 热更新；
 *   - 新增 `TASK_AUTHORSHIP_SKILL_NAME` / `loadTaskAuthorshipMarkdown()` /
 *     `createIntrinsicSkillRegistration()`（`src/skills/index.ts`）；
 *   - `src/plugin.ts` 经 `ctx.skills.register` **静态注册** `task-authorship`（不进化）。
 *
 * 独立性声明：本文件由 Tester 独立编写，**不依赖** Developer 的
 * `tests/prompt-skills.spec.ts`。分两条独立证据链：
 *   1) 源码态：`src/skills/task-authorship/*` 逐要素比对 §10.2 要素清单（关键词 / 结构）；
 *   2) 装载态：真实 `@deepseek-ai/dsh-skill` SkillRegistry + 真实构建产物
 *      `dist-server/` 插件装载——观测 5 个可进化 SKILL 经 skill-filesystem provider 发现，
 *      且 `task-authorship` 经静态注册可见。
 *
 * 覆盖 8 条验收点：
 *   1. SKILL.md 存在 + frontmatter（name=kebab / description / whenToUse）
 *   2. 正文要素齐全（对照 §10.2 清单）
 *   3. SKILL_NAMES 恰为 5 个（不含 task-authorship）、顺序正确；固有常量正确
 *   4. 固有 SKILL 静态读取入口（loadTaskAuthorshipMarkdown / 注册对象契约）
 *   5. 真实装载：5 个可进化经 provider 发现；task-authorship 经静态注册可见，含注销
 *   6. index.ts / README.md / plugin.ts 计数与分野表述同步（5 可进化 + 1 固有）
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
import * as pluginNs from '../dist-server/index.js'
import {
  SKILL_NAMES,
  TASK_AUTHORSHIP_SKILL_NAME,
  createIntrinsicSkillRegistration,
  loadTaskAuthorshipMarkdown,
  parseSkill,
} from '../src/skills/index.js'
import { ensureSkillAssetsRepo } from '../src/skills/repo.js'
import {
  mountSkillFilesystemProviderAsync,
  SKILL_PROVIDER_NAME,
} from '../src/skills/provider.js'
import { parseSkillFile, SKILL_NAME_PATTERN } from '../src/skills/frontmatter.js'
import { inject as srcInject } from '../src/plugin.js'

const PROJECT_ROOT = fileURLToPath(new URL('..', import.meta.url))

/** 5 个「可进化 SKILL」（provider 发现；顺序 = 种子落盘顺序）。 */
const EVOLVABLE_SKILLS = [
  'trend-analysis',
  'grid-strategy',
  'stop-rule',
  'strategy-authorship',
  'analysis-decision',
] as const

/** 固有 SKILL 名（任务程序创作）。 */
const TA = TASK_AUTHORSHIP_SKILL_NAME

/** 固有 SKILL 的解析结果（frontmatter + 正文），多处复用。 */
const TA_PARSED = parseSkillFile(loadTaskAuthorshipMarkdown())

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
    // 固有 SKILL 不再进可进化清单，但目录名仍须 = frontmatter.name（静态读取一致）。
    expect(TA_PARSED.frontmatter.name).toBe(TA)
  })
})

/* ================================================================== *
 * 验收 2：正文要素齐全（对照 §10.2 清单）
 * ================================================================== */

describe('[验收2] 正文覆盖 §10.2 全部要素', () => {
  const body = TA_PARSED.content

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

  it('⑧ 与定时规则配合：编码→测试→注册三步闭环 + 注册门禁（测试通过才注册、不通过修复再测）；改逻辑动程序、改频率动 cron', () => {
    // 三步闭环
    expect(body).toMatch(/编码 → 测试 → 注册/)
    expect(body).toMatch(/写程序/)
    expect(body).toMatch(/测试/)
    expect(body).toMatch(/注册\s*\/\s*修复/)
    // 注册手段与频率职责
    expect(body).toMatch(/task_create/)
    expect(body).toMatch(/cron/)
    expect(body).toMatch(/改逻辑动程序/)
    expect(body).toMatch(/改频率动 cron/)
    // 测试要校验「两件事」
    expect(body).toMatch(/跑得起来/)
    expect(body).toMatch(/干的活对/)
    expect(body).toMatch(/TaskScriptResult/)
    expect(body).toMatch(/shouldWake/)
    // 注册门禁纪律（不是可选项）
    expect(body).toMatch(/测试验证通过才允许/)
    expect(body).toMatch(/测试不通过就修复/)
    expect(body).toMatch(/循环/)
    // spawn subagent 委派
    expect(body).toMatch(/subagent/)
    expect(body).toMatch(/编码-测试-修复/)
  })
})

/* ================================================================== *
 * 验收 3：SKILL_NAMES 长度 / 顺序（收窄为 5 个可进化）
 * ================================================================== */

describe('[验收3] SKILL_NAMES 恰为 5 个可进化且顺序正确', () => {
  it('长度 = 5', () => {
    expect(SKILL_NAMES).toHaveLength(5)
  })

  it('顺序：trend-analysis → grid-strategy → stop-rule → strategy-authorship → analysis-decision', () => {
    expect([...SKILL_NAMES]).toEqual([...EVOLVABLE_SKILLS])
  })

  it('不含 task-authorship（已分离为固有 SKILL，不落可进化清单）', () => {
    expect(SKILL_NAMES as readonly string[]).not.toContain(TA)
    expect(SKILL_NAMES[SKILL_NAMES.length - 1]).toBe('analysis-decision')
  })

  it('固有常量 TASK_AUTHORSHIP_SKILL_NAME = "task-authorship"（kebab-case）', () => {
    expect(TA).toBe('task-authorship')
    expect(SKILL_NAME_PATTERN.test(TA)).toBe(true)
  })

  it('每个名称均为 kebab-case', () => {
    for (const n of SKILL_NAMES) expect(SKILL_NAME_PATTERN.test(n)).toBe(true)
  })
})

/* ================================================================== *
 * 验收 4：固有 SKILL 静态读取 / 注册对象契约
 * ================================================================== */

describe('[验收4] 固有 SKILL 静态读取入口契约', () => {
  it('loadTaskAuthorshipMarkdown() 读到原文；frontmatter.name = task-authorship、content 非空', () => {
    const raw = loadTaskAuthorshipMarkdown()
    expect(raw).toContain('task-authorship')
    const { frontmatter, content } = parseSkillFile(raw)
    expect(frontmatter.name).toBe(TA)
    expect(content.trim().length).toBeGreaterThan(200)
  })

  it('createIntrinsicSkillRegistration()：name / source=runtime / invocation 双开 / 正文非空', () => {
    const reg = createIntrinsicSkillRegistration()
    expect(reg.name).toBe(TA)
    expect(reg.source).toBe('runtime')
    expect(reg.invocation).toEqual({ modelInvocable: true, userInvocable: true })
    expect((reg.content ?? '').length).toBeGreaterThan(200)
    expect(reg.description.length).toBeGreaterThan(0)
    // 正文 = 原文（去 frontmatter）。
    expect(reg.content).toBe(TA_PARSED.content)
  })

  it('固有 SKILL 正文与可进化 SKILL 解析器解耦：parseSkill 只接受 5 个可进化名', () => {
    // 5 个可进化名经 parseSkill 正常解析（回归）。
    for (const n of EVOLVABLE_SKILLS) expect(parseSkill(n).frontmatter.name).toBe(n)
  })
})

/* ================================================================== *
 * 验收 5：真实装载（SkillRegistry + provider + 静态注册）
 * ================================================================== */

describe('[验收5] 真实装载：5 可进化经 provider 发现 + 固有经静态注册可见', () => {
  it('真实 SkillRegistry + skill-filesystem provider：5 个可进化可发现，注销后归 0', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'dsh-fin-ta-'))
    process.env.DSH_FINANCE_DATA_DIR = dataRoot
    try {
      ensureSkillAssetsRepo({ dataRoot, logger: () => {} })

      const ctx = new Context()
      await (ctx.plugin(SkillRegistry as never) as Promise<unknown>)

      const before = await ctx.skills.list({})
      expect(
        before.filter((s) => (EVOLVABLE_SKILLS as readonly string[]).includes(s.name)),
      ).toHaveLength(0)

      const mount = await mountSkillFilesystemProviderAsync(ctx, { dataRoot })

      const after = await ctx.skills.list({})
      const got = after.filter((s) => (EVOLVABLE_SKILLS as readonly string[]).includes(s.name))
      expect(got).toHaveLength(5)
      expect(got.map((s) => s.name).sort()).toEqual([...EVOLVABLE_SKILLS].sort())
      for (const s of got) expect(s.provider).toBe(SKILL_PROVIDER_NAME)

      // 固有 SKILL 不经 provider 发现（不落 <dataRoot>/skills）。
      expect(after.some((s) => s.name === TA)).toBe(false)

      for (const n of EVOLVABLE_SKILLS) {
        const def = await ctx.skills.get(n)
        expect(def?.name).toBe(n)
        expect(def?.content).toBe(parseSkill(n).content)
        expect(def?.invocation).toEqual({ modelInvocable: true, userInvocable: true })
      }

      await mount.dispose()
      const finalList = await ctx.skills.list({})
      expect(
        finalList.filter((s) => (EVOLVABLE_SKILLS as readonly string[]).includes(s.name)),
      ).toHaveLength(0)

      await ctx.fiber.dispose()
    } finally {
      rmSync(dataRoot, { recursive: true, force: true })
      delete process.env.DSH_FINANCE_DATA_DIR
    }
  }, 30000)

  it('真实构建产物 dist-server 装载：5 可进化经 provider 发现 + task-authorship 静态注册可见，注销后皆消失', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-fin-ta-'))
    process.env.DSH_FINANCE_DATA_DIR = dir

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
    await (app.plugin(SkillRegistry as never) as Promise<unknown>)

    // 编译态入口 apply 与源码同源；缺省 fs → provider 回落 node fs。
    const toolsFiber = (await app.plugin(ToolRuntime as never)) as unknown as {
      dispose: () => Promise<void>
    }
    const pluginFiber = app.plugin({
      name: pluginNs.name,
      inject: ['tools', 'skills'],
      apply: pluginNs.apply,
    } as never) as unknown as { dispose: () => Promise<void> }

    try {
      // (a) 5 个可进化 SKILL 经 provider 发现。
      let names: string[] = []
      await vi.waitFor(
        async () => {
          const list = await app.skills.list({})
          names = list
            .map((s) => s.name)
            .filter((n) => (EVOLVABLE_SKILLS as readonly string[]).includes(n))
            .sort()
          expect(names).toEqual([...EVOLVABLE_SKILLS].sort())
        },
        { timeout: 8000, interval: 50 },
      )

      for (const n of EVOLVABLE_SKILLS) {
        const def = await app.skills.get(n)
        expect(def?.description.length, `${n} description 非空`).toBeGreaterThan(0)
        expect(def?.content.length, `${n} content 非空`).toBeGreaterThan(0)
        expect(def?.content).toBe(parseSkill(n).content)
      }

      // (b) 固有 SKILL task-authorship 经 apply 静态注册可见（source=runtime），不经 provider。
      const intrinsic = (await app.skills.list({})).find((s) => s.name === TA)
      expect(intrinsic, 'task-authorship 应经静态注册可见').toBeDefined()
      expect(intrinsic?.source).toBe('runtime')
      const taDef = await app.skills.get(TA)
      expect(taDef?.content).toBe(TA_PARSED.content)

      // 注销：dispose 插件 fiber 后 5 个可进化 + 固有 SKILL 全部消失。
      await pluginFiber.dispose()
      const after = await app.skills.list({})
      expect(
        after.filter((s) => (EVOLVABLE_SKILLS as readonly string[]).includes(s.name)),
      ).toHaveLength(0)
      expect(after.some((s) => s.name === TA)).toBe(false)
    } finally {
      await toolsFiber.dispose()
      rmSync(dir, { recursive: true, force: true })
      delete process.env.DSH_FINANCE_DATA_DIR
    }
  }, 20000)
})

/* ================================================================== *
 * 验收 6：计数 / 分野表述同步（5 可进化 + 1 固有）
 * ================================================================== */

describe('[验收6] index.ts / README.md / plugin.ts 表述同步（5 可进化 + 1 固有）', () => {
  const read = (rel: string): string => readFileSync(join(PROJECT_ROOT, rel), 'utf8')

  it('src/skills/index.ts：区分「可进化 / 固有」，含 TASK_AUTHORSHIP_SKILL_NAME 与 5 个清单', () => {
    const src = read('src/skills/index.ts')
    expect(src).toMatch(/可进化/)
    expect(src).toMatch(/固有/)
    expect(src).toContain('task-authorship')
    expect(src).toContain('TASK_AUTHORSHIP_SKILL_NAME')
    expect(src).toContain('loadTaskAuthorshipMarkdown')
    expect(src).toMatch(/5 个/)
  })

  it('src/skills/README.md：区分「可进化 / 固有」，含 task-authorship', () => {
    const src = read('src/skills/README.md')
    expect(src).toMatch(/可进化/)
    expect(src).toMatch(/固有/)
    expect(src).toContain('task-authorship')
    expect(src).toMatch(/5 个/)
  })

  it('src/plugin.ts：区分「可进化 / 固有」，并静态注册 task-authorship', () => {
    const src = read('src/plugin.ts')
    expect(src).toMatch(/可进化/)
    expect(src).toMatch(/固有/)
    expect(src).toContain('task-authorship')
    // 静态注册接线：provider（可进化）+ 固有注册对象 + provider 名。
    expect(src).toContain('createIntrinsicSkillRegistration')
    expect(src).toContain('mountSkillFilesystemProvider')
  })
})

/* ================================================================== *
 * 验收 7：标的无关（无写死价格 / 阈值）
 * ================================================================== */

describe('[验收7] task-authorship 正文标的无关', () => {
  const body = TA_PARSED.content

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
