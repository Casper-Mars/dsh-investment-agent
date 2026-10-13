/**
 * skill 重构任务-2 验收测试：`skill-filesystem` provider 装配 + watch 热更新。
 *
 * 覆盖验收标准：
 *   1. 挂载指向 `<dataRoot>/skills` 的 provider 后，真实 `ctx.skills.list()` 能发现
 *      5 个可进化 skill，`get()` 正文与文件内容一致；
 *   2. 改写某 `SKILL.md` → chokidar watch → invalidate → 再次 `list()` 取到新内容
 *      （无需重启，热更新链路成立）；
 *   3. provider 注册进**插件自身 ctx（unscoped → global 层）**，故任意 scoped 读取
 *      方经 scope 链均可见（固定会话与 workspace 会话均可见）；
 *   4. 注销（dispose）后 provider 从注册表移除，不得残留。
 *
 * 数据隔离：所有用例使用临时目录作为 dataRoot，**不污染** `~/.dsh-ia`。
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import {
  mountSkillFilesystemProvider,
  mountSkillFilesystemProviderAsync,
  SKILL_PROVIDER_NAME,
} from '../src/skills/provider.js'
import { ensureSkillAssetsRepo, SKILLS_REPO_DIRNAME, SKILL_FILENAME, resolveSkillsRepoDir } from '../src/skills/repo.js'
import { SKILL_NAMES, parseSkill } from '../src/skills/index.js'
import { parseSkillFile } from '../src/skills/frontmatter.js'

/** 挂载 + chokidar 就绪在并行负载下可能超过默认 5s，故放宽用例超时。 */
const TEST_TIMEOUT = 30000

const tmpDirs: string[] = []

/** 建临时 dataRoot 并预置 `<dataRoot>/skills` 内的 5 个可进化 skill（真实 git 仓库）。 */
function makeSeededDataRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-ia-provider-'))
  tmpDirs.push(dir)
  const outcome = ensureSkillAssetsRepo({ dataRoot: dir, logger: () => {} })
  expect(outcome.degraded, `预置降级：${outcome.reason}`).toBe(false)
  expect(outcome.provisioned).toBe(true)
  return dir
}

/** 建真实 SkillRegistry 上下文。 */
async function newSkillContext(): Promise<Context> {
  const ctx = new Context()
  await (ctx.plugin(SkillRegistry as never) as Promise<unknown>)
  return ctx
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

describe('skill-filesystem provider：发现 / 正文', () => {
  it('挂载后 list() 发现 5 个 skill，get() 正文与数据目录文件一致', async () => {
    const dataRoot = makeSeededDataRoot()
    const skillsDir = resolveSkillsRepoDir(dataRoot)
    const ctx = await newSkillContext()

    const mount = await mountSkillFilesystemProviderAsync(ctx, { dataRoot })
    expect(mount.providerName).toBe(SKILL_PROVIDER_NAME)
    expect(mount.dir).toBe(skillsDir)

    const summaries = await ctx.skills.list({})
    const names = summaries
      .filter((s) => (SKILL_NAMES as readonly string[]).includes(s.name))
      .map((s) => s.name)
      .sort()
    expect(names).toEqual([...SKILL_NAMES].sort())
    expect(summaries).toHaveLength(SKILL_NAMES.length)

    for (const s of summaries) {
      expect(s.provider).toBe(SKILL_PROVIDER_NAME)
      expect(s.source).toBe('custom') // customSkillDirs 根 → source 'custom'
      expect(s.description.length).toBeGreaterThan(0)
      expect(s.whenToUse).toBeTruthy()
      expect(s.invocation).toEqual({ modelInvocable: true, userInvocable: true })
    }

    // 正文与数据目录文件（frontmatter 之后的 body）逐一致。
    for (const name of SKILL_NAMES) {
      const def = await ctx.skills.get(name)
      expect(def, `skill ${name} 未取回`).toBeDefined()
      expect(def?.provider).toBe(SKILL_PROVIDER_NAME)
      const fileBody = parseSkillFile(
        readFileSync(join(skillsDir, name, SKILL_FILENAME), 'utf8'),
      ).content
      expect(def?.content).toBe(fileBody)
      // 与随包种子解析结果一致（目录名 = name），确保迁移未改内容语义。
      expect(def?.content).toBe(parseSkill(name).content)
    }

    await mount.dispose()
    await ctx.fiber.dispose()
  }, TEST_TIMEOUT)

  it('includeDefaultRoots:false：不发现 default roots 的 skill（仅扫 customSkillDirs）', async () => {
    const dataRoot = makeSeededDataRoot()
    const ctx = await newSkillContext()
    const mount = await mountSkillFilesystemProviderAsync(ctx, { dataRoot })

    const summaries = await ctx.skills.list({})
    // 卸载后清零，验证「本 provider 是唯一来源」。
    await mount.dispose()
    const after = await ctx.skills.list({})
    expect(after.filter((s) => (SKILL_NAMES as readonly string[]).includes(s.name))).toHaveLength(0)
    expect(summaries).toHaveLength(SKILL_NAMES.length)

    await ctx.fiber.dispose()
  }, TEST_TIMEOUT)
})

describe('skill-filesystem provider：watch 热更新', () => {
  it('改写 SKILL.md 的 description/正文 → watch invalidate → 下次 list()/get() 取到新内容', async () => {
    const dataRoot = makeSeededDataRoot()
    const skillsDir = resolveSkillsRepoDir(dataRoot)
    const target = 'trend-analysis'
    const ctx = await newSkillContext()

    const mount = await mountSkillFilesystemProviderAsync(ctx, { dataRoot })

    // 初值。
    const before = await ctx.skills.list({})
    const beforeSummary = before.find((s) => s.name === target)
    expect(beforeSummary).toBeDefined()
    const beforeDesc = beforeSummary!.description

    // 改写数据目录中的 SKILL.md（正文 + description），无需重启。
    const updated = `---\nname: ${target}\ndescription: HOT-RELOAD-DESC\nwhenToUse: HOT-RELOAD-WHEN\n---\n\n# HOT-RELOAD-BODY\n新正文标记\n`
    writeFileSync(join(skillsDir, target, SKILL_FILENAME), updated, 'utf8')

    // 轮询等待 watch 触发 invalidate → 目录刷新（真实 chokidar，稳定阈值 ~200ms）。
    await vi.waitFor(
      async () => {
        const list = await ctx.skills.list({})
        const s = list.find((x) => x.name === target)
        expect(s?.description).toBe('HOT-RELOAD-DESC')
      },
      { timeout: 8000, interval: 100 },
    )

    // description 已热更新（区别于初值）。
    expect(beforeDesc).not.toBe('HOT-RELOAD-DESC')

    // get() 正文同步为新内容。
    const after = await ctx.skills.list({})
    expect(after.find((s) => s.name === target)?.whenToUse).toBe('HOT-RELOAD-WHEN')
    const def = await ctx.skills.get(target)
    expect(def?.content).toContain('HOT-RELOAD-BODY')
    expect(def?.content).toContain('新正文标记')

    await mount.dispose()
    await ctx.fiber.dispose()
  }, TEST_TIMEOUT)
})

describe('skill-filesystem provider：global 层可见性', () => {
  it('provider 注册进 unscoped ctx（global 层）：任意 scoped 读取方经 scope 链均可见', async () => {
    const dataRoot = makeSeededDataRoot()
    const ctx = await newSkillContext()
    const mount = await mountSkillFilesystemProviderAsync(ctx, { dataRoot })

    // 未 scoped 读取：命中 global 层。
    const globalView = await ctx.skills.list({})
    expect(globalView.filter((s) => (SKILL_NAMES as readonly string[]).includes(s.name))).toHaveLength(
      SKILL_NAMES.length,
    )

    // scoped 读取：scope 自身无任何注册（空 scope key），仅能经 scope 链看到 global 层
    // 的 provider——这正是「固定会话 + workspace 会话均可见」的机制（provider 不在
    // 任一 scope 的私有层，而在两者共享的 global 层）。
    const scopedView = await ctx.skills.list({ scope: {} })
    const scopedNames = scopedView
      .map((s) => s.name)
      .filter((n) => (SKILL_NAMES as readonly string[]).includes(n))
      .sort()
    expect(scopedNames).toEqual([...SKILL_NAMES].sort())
    expect(scopedView.every((s) => s.provider === SKILL_PROVIDER_NAME)).toBe(true)

    await mount.dispose()
    await ctx.fiber.dispose()
  }, TEST_TIMEOUT)
})

describe('skill-filesystem provider：卸载', () => {
  it('dispose 后 provider 注销，5 个 skill 从目录消失（无残留）', async () => {
    const dataRoot = makeSeededDataRoot()
    const ctx = await newSkillContext()
    const mount = await mountSkillFilesystemProviderAsync(ctx, { dataRoot })

    expect((await ctx.skills.list({})).length).toBe(SKILL_NAMES.length)

    await mount.dispose()
    const after = await ctx.skills.list({})
    expect(after.filter((s) => (SKILL_NAMES as readonly string[]).includes(s.name))).toHaveLength(0)

    await ctx.fiber.dispose()
  }, TEST_TIMEOUT)

  it('同步入口 mountSkillFilesystemProvider 经 ctx.effect 装配；注销后 provider 移除', async () => {
    const dataRoot = makeSeededDataRoot()
    const ctx = await newSkillContext()

    // 同步入口不抛错（惰性加载 + 降级）。
    const disposeMount = mountSkillFilesystemProvider(ctx, { dataRoot })

    // 等待惰性加载 + provider 就绪后即可发现 5 个 skill。
    await vi.waitFor(
      async () => {
        const list = await ctx.skills.list({})
        expect(list.filter((s) => (SKILL_NAMES as readonly string[]).includes(s.name))).toHaveLength(
          SKILL_NAMES.length,
        )
      },
      { timeout: 8000, interval: 50 },
    )

    // 调用 effect 注销器 → 注销 provider + 关闭 watch。
    await disposeMount()
    const after = await ctx.skills.list({})
    expect(after.filter((s) => (SKILL_NAMES as readonly string[]).includes(s.name))).toHaveLength(0)

    await ctx.fiber.dispose()
  }, TEST_TIMEOUT)
})

describe('skill-filesystem provider：降级', () => {
  it('skills 服务不可用的最小 ctx 下挂载不抛错（降级不中断装载）', () => {
    const ctx = {
      effect(body: () => unknown) {
        const d = body()
        return typeof d === 'function' ? (d as () => void) : () => {}
      },
    } as unknown as Context
    // mountSkillFilesystemProvider 内部惰性加载 + try 降级；此处 skills 缺失。
    expect(() => mountSkillFilesystemProvider(ctx, { dataRoot: '/tmp/does-not-matter' })).not.toThrow()
  })
})

describe('数据目录隔离', () => {
  it('测试只在临时 dataRoot 内预置，不触碰默认 ~/.dsh-ia', () => {
    const dataRoot = makeSeededDataRoot()
    expect(existsSync(join(dataRoot, SKILLS_REPO_DIRNAME, SKILL_NAMES[0], SKILL_FILENAME))).toBe(true)
  })
})
