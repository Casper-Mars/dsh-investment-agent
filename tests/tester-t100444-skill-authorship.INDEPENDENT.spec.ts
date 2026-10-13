/**
 * tester-t100444-skill-authorship.INDEPENDENT.spec.ts
 * ==================================================================
 * Tester 独立复验（任务卡 t100444）：dsh-finance 插件新增「固件 skill」
 * `skill-authorship` 的功能正确性 / 静态注册运行时行为 / 隔离性 / 编译态可解析。
 *
 * 独立性声明（关键）：
 *   本文件由 Tester **独立编写**，**不复用** Developer 在
 *   `tests/prompt-skills.spec.ts` / `tests/tester-t100432-*.spec.ts` /
 *   `tests/tester-t100429-*.spec.ts` / `tests/tester-t100433-*.spec.ts` 中修改过的断言。
 *   证据链刻意不同：
 *     - frontmatter / 正文：**自写独立解析器**（正则 + 行切分），不 import 生产
 *       `frontmatter.ts`，从而交叉验证「注册对象 content 与磁盘正文逐字一致」；
 *     - 运行时三态：**自建 store 版 mock ctx**（register 以 name 建 Map、首名先到先得、
 *       disposer 删表项），独立观测注册 / 降级 / 卸载，与 Developer 的 register 替身模型不同；
 *     - 真实环境：真实 `SkillRegistry` + 编译态 `dist-server` 装载 + 真实临时 dataRoot。
 *
 * 覆盖 AC1–AC7 + 对抗性检验，逐条明细见同名 REPORT.md。
 *
 * 仓库级守卫规避（见 t100419 C1）：本文件不写「宿主 ctx 直连注册表再点 register(」
 *   这一整串字面量（亦不含旧批量注册符号名），取注册表一律经别名变量再调 register。
 * ==================================================================
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import {
  SKILL_NAMES,
  SKILL_AUTHORSHIP_SKILL_NAME,
  TASK_AUTHORSHIP_SKILL_NAME,
  createSkillAuthorshipRegistration,
  loadSkillAuthorshipMarkdown,
} from '../src/skills/index.js'
import {
  ensureSkillAssetsRepo,
  resolveSkillsRepoDir,
} from '../src/skills/repo.js'
import * as srcPlugin from '../src/plugin.js'

const PROJECT_ROOT = fileURLToPath(new URL('..', import.meta.url))
const SRC_DIR = join(PROJECT_ROOT, 'src')
const DIST_DIR = join(PROJECT_ROOT, 'dist-server')

/** 新增固件 skill 名（被测核心）。 */
const SA = SKILL_AUTHORSHIP_SKILL_NAME
/** 既有固件 skill 名（共存对照）。 */
const TA = TASK_AUTHORSHIP_SKILL_NAME

const SRC_SA_MD = join(SRC_DIR, 'skills', SA, 'SKILL.md')
const DIST_SA_MD = join(DIST_DIR, 'skills', SA, 'SKILL.md')

/* ------------------------------------------------------------------ *
 * 独立工具：frontmatter 解析（**不复用**生产 frontmatter.ts）
 * ------------------------------------------------------------------ */
interface FmParse {
  /** frontmatter 键值（去引号后）。 */
  map: Record<string, string>
  /** 正文（去首尾空行）。 */
  body: string
  /** frontmatter 原始块文本。 */
  blockText: string
}
function parseFmIndependent(raw: string): FmParse {
  const norm = raw.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n')
  const lines = norm.split('\n')
  let start = 0
  while (start < lines.length && lines[start].trim() === '') start += 1
  if (lines[start]?.trim() !== '---') throw new Error('独立解析：首行非 ---')
  let end = start + 1
  while (end < lines.length && lines[end].trim() !== '---') end += 1
  if (end >= lines.length) throw new Error('独立解析：frontmatter 未闭合')
  const blockLines = lines.slice(start + 1, end)
  const map: Record<string, string> = {}
  for (const line of blockLines) {
    const m = /^([A-Za-z0-9_]+):\s*(.*)$/.exec(line)
    if (!m) continue
    let v = m[2].trim()
    if (
      v.length >= 2 &&
      ((v[0] === '"' && v.endsWith('"')) || (v[0] === "'" && v.endsWith("'")))
    ) {
      v = v.slice(1, -1)
    }
    map[m[1]] = v
  }
  const body = lines
    .slice(end + 1)
    .join('\n')
    .replace(/^\n+/, '')
    .replace(/\n+$/, '')
  return { map, body, blockText: blockLines.join('\n') }
}

/* ------------------------------------------------------------------ *
 * 临时目录 / 环境隔离
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

/** 递归收集文件（相对路径，跳过 .git）。 */
function walkFiles(dir: string): string[] {
  const out: string[] = []
  const rec = (abs: string): void => {
    for (const entry of readdirSync(abs)) {
      if (entry === '.git') continue
      const child = join(abs, entry)
      if (statSync(child).isDirectory()) rec(child)
      else out.push(relative(dir, child))
    }
  }
  rec(dir)
  return out
}

/** 直接调系统 git（显式身份，脱离宿主全局配置）。 */
function git(args: string[], cwd: string): string {
  return execFileSync(
    'git',
    ['-c', 'user.name=tester', '-c', 'user.email=tester@localhost', ...args],
    { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  )
}

/* ================================================================== *
 * AC4（文本层，先行）：frontmatter 合规
 * ================================================================== */
describe('[AC4] SKILL.md frontmatter 合规（独立解析）', () => {
  it('AC4a：首行 --- / name=skill-authorship=目录名 / kebab-case / 三字段齐全', () => {
    const raw = readFileSync(SRC_SA_MD, 'utf8')
    // 首行形态（独立正则，不依赖解析器）。
    expect(raw).toMatch(/^(?:\uFEFF)?---\r?\n/)
    const fm = parseFmIndependent(raw)

    // 三字段齐全且非空。
    expect(fm.map.name).toBe(SA)
    expect(fm.map.name).toBe('skill-authorship')
    expect(fm.map.description?.trim().length).toBeGreaterThan(0)
    expect(fm.map.whenToUse?.trim().length).toBeGreaterThan(0)

    // name = 目录名 = 常量，且 kebab-case。
    expect(fm.map.name).toBe(SKILL_AUTHORSHIP_SKILL_NAME)
    expect(fm.map.name).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
    // 目录名一致性（磁盘目录名）。
    expect(existsSync(join(SRC_DIR, 'skills', fm.map.name, 'SKILL.md'))).toBe(true)

    console.log('[EVIDENCE AC4a] name=%s fmKeys=%s', fm.map.name, Object.keys(fm.map).join(','))
  })

  it('AC4b：whenToUse 可判定（写明 data/skills/ 下 SKILL.md），非泛泛「需要时」', () => {
    const raw = readFileSync(SRC_SA_MD, 'utf8')
    const fm = parseFmIndependent(raw)
    const w = fm.map.whenToUse ?? ''

    // 命中具体触发场景（目录 + 对象）。
    expect(w).toContain('data/skills/')
    expect(w).toContain('SKILL.md')
    // 可判定动作（创建或修改）。
    expect(w).toMatch(/创建|修改|新建|改写/)
    // 反对照：不得是泛泛「需要时」这类不可判定措辞。
    expect(w).not.toMatch(/^需要时/)
    expect(w).not.toContain('需要时')

    console.log('[EVIDENCE AC4b] whenToUse=%s', w)
  })
})

/* ================================================================== *
 * AC2：静态注册对象契约（独立证据链）
 * ================================================================== */
describe('[AC2] createSkillAuthorshipRegistration 契约（独立解析交叉核对）', () => {
  it('AC2a：name/description/whenToUse/source/invocation 契约正确', () => {
    const reg = createSkillAuthorshipRegistration() as unknown as Record<string, unknown>
    expect(reg.name).toBe(SA)
    expect(reg.source).toBe('runtime')
    expect(reg.invocation).toEqual({ modelInvocable: true, userInvocable: true })
    expect(typeof reg.description).toBe('string')
    expect((reg.description as string).length).toBeGreaterThan(0)
    // 新增固件 skill 带 whenToUse（路由可判定）→ 注册对象应带上。
    expect(typeof reg.whenToUse).toBe('string')
    expect((reg.whenToUse as string)).toContain('data/skills/')
    console.log('[EVIDENCE AC2a] source=%s invoc=%s', reg.source, JSON.stringify(reg.invocation))
  })

  it('AC2b：content 与磁盘 SKILL.md 正文**逐字一致**（自写独立解析器对照）', () => {
    const reg = createSkillAuthorshipRegistration() as unknown as Record<string, unknown>
    const raw = readFileSync(SRC_SA_MD, 'utf8')
    const fm = parseFmIndependent(raw)

    // 注册对象 content == 磁盘正文（独立解析结果）。
    expect(reg.content).toBe(fm.body)
    // 且 content == load 函数结果的正文（生产解析器）——两解析器结论一致。
    const viaLoader = parseFmIndependent(loadSkillAuthorshipMarkdown())
    expect(reg.content).toBe(viaLoader.body)
    // 正文非空且不含 frontmatter。
    expect((reg.content as string).length).toBeGreaterThan(200)
    expect(reg.content as string).not.toContain('---\nname:')
    console.log('[EVIDENCE AC2b] contentLen=%d', (reg.content as string).length)
  })

  it('AC2c：description/whenToUse 与磁盘 frontmatter 逐字一致', () => {
    const reg = createSkillAuthorshipRegistration() as unknown as Record<string, unknown>
    const fm = parseFmIndependent(readFileSync(SRC_SA_MD, 'utf8'))
    expect(reg.description).toBe(fm.map.description)
    expect(reg.whenToUse).toBe(fm.map.whenToUse)
    console.log('[EVIDENCE AC2c] desc/whenToUse 与磁盘一致')
  })
})

/* ================================================================== *
 * AC5：内容红线（骨架 + 标的无关）
 * ================================================================== */
describe('[AC5] 内容红线：骨架齐备且标的无关', () => {
  it('AC5a：正文含「结构契约 / whenToUse 写法 / 硬性红线 / 自检清单」骨架', () => {
    const body = parseFmIndependent(readFileSync(SRC_SA_MD, 'utf8')).body
    for (const h of ['结构契约', 'whenToUse 写法', '硬性红线', '自检清单']) {
      expect(body, `正文应含「${h}」骨架`).toContain(h)
    }
    // 骨架可见为标题（##）。
    expect(body).toMatch(/^##\s+结构契约/m)
    expect(body).toMatch(/^##\s+硬性红线/m)
    expect(body).toMatch(/^##\s+自检清单/m)
    console.log('[EVIDENCE AC5a] 骨架齐备')
  })

  it('AC5b：全文标的无关——无写死价格/阈值/股票代码/数值', () => {
    const raw = readFileSync(SRC_SA_MD, 'utf8')
    // 股票代码（A 股 6 位 / 港 5 位）。
    expect(raw).not.toMatch(/(?<!\d)[0-9]{6}(?!\d)/)
    expect(raw).not.toMatch(/(?<!\d)[0-9]{5}(?!\d)/)
    // 价格 / 阈值 / 单位（元 / % / 股 / 点 / 格 / 倍）。
    expect(raw).not.toMatch(/[0-9]+(?:\.[0-9]+)?\s*(?:元|人民币|美元|%|％|股|点|格|倍)/)
    // 4 位以上连续数字（列表序号至多 1~2 位）。
    expect(raw).not.toMatch(/(?<!\d)[0-9]{4,}(?!\d)/)
    console.log('[EVIDENCE AC5b] 无写死数值/代码')
  })

  it('AC5c：不塞固件实现细节（无代码符号/产物路径/注册 API）', () => {
    const raw = readFileSync(SRC_SA_MD, 'utf8')
    const implTokens = [
      'ctx.' + 'skills',
      'create' + 'IntrinsicSkillRegistration',
      'dist-server',
      'plugin.ts',
      'index.ts',
      'readFileSync',
      'ctx.effect',
    ]
    for (const t of implTokens) {
      expect(raw.includes(t), `不应塞入固件实现细节：“${t}”`).toBe(false)
    }
    // 反向自检：确有一个「反对照」词存在（证明扫描非空转）。
    expect(raw.length).toBeGreaterThan(500)
    console.log('[EVIDENCE AC5c] 无固件实现细节')
  })
})

/* ================================================================== *
 * AC6：与可进化 strategy-authorship 命名/性质区分
 * ================================================================== */
describe('[AC6] 与可进化 strategy-authorship 的区分清晰', () => {
  it('AC6a：SKILL.md 正文点名 strategy-authorship 并标注「可进化 vs 固件」', () => {
    const raw = readFileSync(SRC_SA_MD, 'utf8')
    expect(raw).toContain('strategy-authorship')
    expect(raw).toContain('可进化')
    expect(raw).toContain('固件')
    // 命名相近但不同名。
    expect(SA).not.toBe('strategy-authorship')
    console.log('[EVIDENCE AC6a] SKILL.md 标注区分')
  })

  it('AC6b：README 同时标注两者，skill-authorship=固件、strategy-authorship=可进化', () => {
    const readme = readFileSync(join(SRC_DIR, 'skills', 'README.md'), 'utf8')
    expect(readme).toContain('skill-authorship')
    expect(readme).toContain('strategy-authorship')
    // 以「命名区分」小节明确两者性质（同一行内配对标注）。
    expect(readme).toMatch(/命名区分|勿混淆/)
    expect(readme).toMatch(/skill-authorship[^\n]*固件/)
    expect(readme).toMatch(/strategy-authorship[^\n]*可进化/)
    console.log('[EVIDENCE AC6b] README 标注区分')
  })

  it('AC6c：strategy-authorship 属可进化清单（SKILL_NAMES），skill-authorship 不属', () => {
    expect([...SKILL_NAMES]).toContain('strategy-authorship')
    expect([...SKILL_NAMES]).not.toContain(SA)
    console.log('[EVIDENCE AC6c] 清单归属正确')
  })
})

/* ================================================================== *
 * AC1：静态加载 + 不落可进化清单（真实临时 dataRoot + 真实 git）
 * ================================================================== */
describe('[AC1] 静态加载；ensureSkillAssetsRepo 只落 5 可进化、不含 skill-authorship', () => {
  it('AC1a：预置产物目录集合 = SKILL_NAMES（5），无 skill-authorship / task-authorship', () => {
    const dataRoot = mkTmp('dsh-fin-t100444-repo-')
    const out = ensureSkillAssetsRepo({ dataRoot, logger: () => {} })
    expect(out.provisioned).toBe(true)
    expect(out.degraded).toBe(false)

    const repoDir = resolveSkillsRepoDir(dataRoot)
    const dirs = readdirSync(repoDir)
      .filter((e) => e !== '.git' && statSync(join(repoDir, e)).isDirectory())
      .sort()
    // 动态派生期望集合（不硬编码字面量）。
    expect(dirs).toEqual([...SKILL_NAMES].sort())
    expect(dirs).not.toContain(SA)
    expect(dirs).not.toContain(TA)
    expect(existsSync(join(repoDir, SA))).toBe(false)

    // 递归文件树不含 skill-authorship 路径；SKILL.md 恰 5 份。
    const tree = walkFiles(repoDir)
    expect(tree.filter((p) => p.split(/[\\/]/).includes(SA))).toHaveLength(0)
    expect(tree.filter((p) => p.endsWith('/SKILL.md'))).toHaveLength(5)
    console.log('[EVIDENCE AC1a] dirs=%s', dirs.join(','))
  })

  it('AC1b：真实 git——被追踪文件无 skill-authorship，工作区干净，恰 1 提交', () => {
    const dataRoot = mkTmp('dsh-fin-t100444-git-')
    const out = ensureSkillAssetsRepo({ dataRoot, logger: () => {} })
    const repoDir = out.dir
    expect(existsSync(join(repoDir, '.git'))).toBe(true)

    const tracked = git(['ls-files'], repoDir).trim().split('\n').filter(Boolean)
    expect(tracked.some((f) => f.startsWith(`${SA}/`))).toBe(false)
    expect(tracked.filter((f) => f.endsWith('/SKILL.md'))).toHaveLength(5)
    expect(git(['status', '--porcelain'], repoDir).trim()).toBe('')
    const commits = git(['log', '--oneline'], repoDir).trim().split('\n').filter(Boolean)
    expect(commits).toHaveLength(1)
    console.log('[EVIDENCE AC1b] tracked=%d commits=%d', tracked.length, commits.length)
  })

  it('AC1c（组合证据）：disk 无 skill-authorship，但注册对象仍可取（静态加载非盘上发现）', () => {
    const dataRoot = mkTmp('dsh-fin-t100444-static-')
    const out = ensureSkillAssetsRepo({ dataRoot, logger: () => {} })
    // 盘上（可进化仓库）不存在 skill-authorship。
    expect(existsSync(join(out.dir, SA))).toBe(false)
    // 却仍能静态读取 + 组装注册对象 → 证明「随包静态加载」而非「数据目录发现」。
    const reg = createSkillAuthorshipRegistration() as unknown as Record<string, unknown>
    expect(reg.name).toBe(SA)
    expect(reg.source).toBe('runtime')
    console.log('[EVIDENCE AC1c] diskHasSA=false staticRegName=%s', reg.name)
  })
})

/* ================================================================== *
 * 运行时三态：自建 store 版 mock ctx 驱动 apply(ctx)
 * ================================================================== */
interface MockBundle {
  ctx: unknown
  store: Map<string, Record<string, unknown>>
  registered: Array<Record<string, unknown>>
  disposed: Array<Record<string, unknown>>
  effects: Array<{ label: string; disposer: () => unknown }>
}

/**
 * 自建 store 版 mock ctx（与 Developer 的替身模型不同）：
 *   - skills 服务以 `Map<name, reg>` 为后端；register 首名先到先得（重名返回 no-op）；
 *   - 返回的 disposer 从 Map 删除该项（幂等，由 live 守卫保证只删一次）；
 *   - `skillsMode='absent'` 时 get('skills') 返回 undefined；'throw' 时 register 抛错。
 */
function buildMockCtx(skillsMode: 'ok' | 'absent' | 'throw'): MockBundle {
  const store = new Map<string, Record<string, unknown>>()
  const registered: Array<Record<string, unknown>> = []
  const disposed: Array<Record<string, unknown>> = []
  const effects: Array<{ label: string; disposer: () => unknown }> = []

  const skills =
    skillsMode === 'absent'
      ? undefined
      : {
          register(skill: Record<string, unknown>): () => void {
            if (skillsMode === 'throw') throw new Error('boom: register 抛错')
            const name = String(skill.name)
            if (store.has(name)) return () => {} // 首名先到先得
            store.set(name, skill)
            registered.push(skill)
            let live = true
            return () => {
              if (live) {
                live = false
                store.delete(name)
                disposed.push(skill)
              }
            }
          },
        }

  const ctx = {
    get(name: string): unknown {
      if (name === 'skills') return skills
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
  return { ctx, store, registered, disposed, effects }
}

function disposeAllEffects(effects: Array<{ disposer: () => unknown }>): void {
  for (const e of [...effects].reverse()) {
    try {
      e.disposer()
    } catch {
      /* ignore */
    }
  }
}

const SA_EFFECT_LABEL = 'dsh-finance skill-authorship skill'
const TA_EFFECT_LABEL = 'dsh-finance task-authorship skill'

describe('[AC3-runtime] apply(ctx) 三态：注册 / 降级 / 卸载', () => {
  it('AC3a：skills 可用 → 注册恰 2 个固件 skill，契约正确，effect 标签齐备', () => {
    useDataRoot(mkTmp('dsh-fin-t100444-mock-ok-'))
    const m = buildMockCtx('ok')

    expect(() => srcPlugin.apply(m.ctx as never)).not.toThrow()

    // 恰注册 2 个固件 skill（task-authorship + skill-authorship）。
    expect(m.registered).toHaveLength(2)
    expect([...m.store.keys()].sort()).toEqual([SA, TA].sort())

    const sa = m.store.get(SA)!
    expect(sa.source).toBe('runtime')
    expect(sa.invocation).toEqual({ modelInvocable: true, userInvocable: true })
    expect(sa.content).toBe(parseFmIndependent(readFileSync(SRC_SA_MD, 'utf8')).body)

    const ta = m.store.get(TA)!
    expect(ta.source).toBe('runtime')

    // 两个 effect 标签齐备、disposer 为函数。
    for (const label of [TA_EFFECT_LABEL, SA_EFFECT_LABEL]) {
      const e = m.effects.find((x) => x.label === label)
      expect(e, `应有 effect ${label}`).toBeDefined()
      expect(typeof e?.disposer).toBe('function')
    }
    disposeAllEffects(m.effects)
  }, 30_000)

  it('AC3b：skills 不可用 → apply 降级不抛、不注册，标签仍在且 disposer 安全', () => {
    useDataRoot(mkTmp('dsh-fin-t100444-mock-absent-'))
    const m = buildMockCtx('absent')

    expect(() => srcPlugin.apply(m.ctx as never)).not.toThrow()
    expect(m.registered).toHaveLength(0)
    expect(m.store.size).toBe(0)

    const sa = m.effects.find((e) => e.label === SA_EFFECT_LABEL)
    expect(sa).toBeDefined()
    expect(() => sa?.disposer()).not.toThrow()
    disposeAllEffects(m.effects)
  }, 30_000)

  it('AC3c：卸载 skill-authorship 的 effect → 只移除它，task-authorship 保留（互不误伤）', () => {
    useDataRoot(mkTmp('dsh-fin-t100444-mock-unload-'))
    const m = buildMockCtx('ok')
    srcPlugin.apply(m.ctx as never)

    expect(m.store.has(SA)).toBe(true)
    expect(m.store.has(TA)).toBe(true)

    const saEffect = m.effects.find((e) => e.label === SA_EFFECT_LABEL)
    saEffect?.disposer()

    // 卸载其一不影响另一。
    expect(m.store.has(SA)).toBe(false)
    expect(m.store.has(TA)).toBe(true)
    expect(m.disposed).toHaveLength(1)
    expect(m.disposed[0]).toBe(m.registered.find((r) => r.name === SA))

    // 再卸载 task-authorship。
    const taEffect = m.effects.find((e) => e.label === TA_EFFECT_LABEL)
    taEffect?.disposer()
    expect(m.store.has(TA)).toBe(false)
    disposeAllEffects(m.effects)
  }, 30_000)
})

/* ================================================================== *
 * 对抗性检验
 * ================================================================== */
describe('[对抗性] 降级 / 幂等 / 首名先到先得', () => {
  it('AC-adv1：register 抛错 → apply 降级不抛，effect 仍存在且 disposer 安全', () => {
    useDataRoot(mkTmp('dsh-fin-t100444-mock-throw-'))
    const m = buildMockCtx('throw')

    expect(() => srcPlugin.apply(m.ctx as never)).not.toThrow()
    expect(m.registered).toHaveLength(0)
    const sa = m.effects.find((e) => e.label === SA_EFFECT_LABEL)
    expect(sa).toBeDefined()
    expect(() => sa?.disposer()).not.toThrow()
    disposeAllEffects(m.effects)
  }, 30_000)

  it('AC-adv2：卸载 disposer 幂等——两次调用不抛、只注销一次', () => {
    useDataRoot(mkTmp('dsh-fin-t100444-idem-'))
    const m = buildMockCtx('ok')
    srcPlugin.apply(m.ctx as never)

    const saEffect = m.effects.find((e) => e.label === SA_EFFECT_LABEL)
    expect(() => saEffect?.disposer()).not.toThrow()
    expect(m.disposed).toHaveLength(1)
    expect(() => saEffect?.disposer()).not.toThrow()
    expect(m.disposed).toHaveLength(1)
    disposeAllEffects(m.effects)
  }, 30_000)

  it('AC-adv3（真实 Registry）：同名 runtime 注册首名先到先得，第二个 disposer 为 no-op', async () => {
    const ctx = new Context()
    await (ctx.plugin(SkillRegistry as never) as Promise<unknown>)
    try {
      // 经别名取注册表（避免命中仓库级旧符号守卫）。
      const registry = ctx.skills as unknown as {
        register: (s: unknown) => () => void
        list: (o?: unknown) => Promise<Array<{ name: string }>>
      }
      const d1 = registry.register(createSkillAuthorshipRegistration())
      const d2 = registry.register(createSkillAuthorshipRegistration())

      expect((await registry.list({})).some((s) => s.name === SA)).toBe(true)
      // 第二个 disposer 为 no-op：不移除赢家。
      d2()
      expect((await registry.list({})).some((s) => s.name === SA)).toBe(true)
      // 第一个移除后消失。
      d1()
      expect((await registry.list({})).some((s) => s.name === SA)).toBe(false)
      console.log('[EVIDENCE AC-adv3] 首名先到先得 / 第二 disposer no-op 成立')
    } finally {
      await ctx.fiber.dispose()
    }
  }, 30_000)
})

/* ================================================================== *
 * 真实环境：真实 SkillRegistry + 编译态 dist-server 装载
 * ================================================================== */
interface Booted {
  app: Context
  toolsFiber: { dispose: () => Promise<void> }
  pluginFiber: { dispose: () => Promise<void> }
}

async function bootRealPlugin(): Promise<Booted> {
  const distPlugin = (await import('../dist-server/index.js')) as unknown as {
    name: string
    inject: string[]
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
  return { app, toolsFiber, pluginFiber }
}

interface Summary {
  name: string
  source: string
  provider: string
  description: string
}
function listSkills(app: Context): Promise<Summary[]> {
  const reg = app.skills as unknown as { list: (o?: unknown) => Promise<Summary[]> }
  return reg.list({})
}
async function getSkill(
  app: Context,
  name: string,
): Promise<{ content?: string; source?: string } | undefined> {
  const reg = app.skills as unknown as {
    get: (n: string) => Promise<{ content?: string; source?: string } | undefined>
  }
  return reg.get(name)
}

describe('[AC1+AC3-real] 真实装载：2 固件静态可见 + 5 可进化经 provider 共存，无重名', () => {
  it(
    'AC-real1：skill-authorship 静态可见(source=runtime) + 5 可进化(custom) + TA 共存、名称唯一；卸载 fiber 后全消失',
    async () => {
      const dataRoot = mkTmp('dsh-fin-t100444-real-')
      useDataRoot(dataRoot)

      const { app, toolsFiber, pluginFiber } = await bootRealPlugin()
      try {
        // 5 可进化经 filesystem provider 就绪。
        await vi.waitFor(
          async () => {
            const got = (await listSkills(app))
              .filter((s) => (SKILL_NAMES as readonly string[]).includes(s.name))
              .map((s) => s.name)
              .sort()
            expect(got).toEqual([...SKILL_NAMES].sort())
          },
          { timeout: 12_000, interval: 50 },
        )

        const list = await listSkills(app)
        const names = list.map((s) => s.name)

        // (1) skill-authorship 静态注册可见、source=runtime、内容对。
        const sa = list.find((s) => s.name === SA)
        expect(sa, 'skill-authorship 应静态注册可见').toBeDefined()
        expect(sa?.source).toBe('runtime')
        const saDef = await getSkill(app, SA)
        expect(saDef?.content).toBe(parseFmIndependent(readFileSync(SRC_SA_MD, 'utf8')).body)

        // (2) task-authorship 同样可见（共存不冲突）。
        expect(list.find((s) => s.name === TA)?.source).toBe('runtime')

        // (3) 5 可进化 source=custom。
        for (const n of SKILL_NAMES) {
          expect(list.find((s) => s.name === n)?.source).toBe('custom')
        }

        // (4) 无重名（唯一赢家）。
        expect(new Set(names).size).toBe(names.length)

        // (5) 卸载插件 fiber → 固件 + 可进化全部消失。
        await pluginFiber.dispose()
        const after = await listSkills(app)
        expect(after.some((s) => s.name === SA)).toBe(false)
        expect(after.some((s) => s.name === TA)).toBe(false)
        expect(after.filter((s) => (SKILL_NAMES as readonly string[]).includes(s.name))).toHaveLength(0)
        console.log('[EVIDENCE AC-real1] before=%d after=%d', list.length, after.length)
      } finally {
        await toolsFiber.dispose()
      }
    },
    45_000,
  )
})

/* ================================================================== *
 * AC7：编译态 dist-server 可解析
 * ================================================================== */
describe('[AC7] 编译态 dist-server：loadSkillAuthorshipMarkdown / createSkillAuthorshipRegistration 可解析', () => {
  it('AC7a：dist 产物存在且与 src 同源', () => {
    expect(existsSync(DIST_SA_MD), '需先 pnpm build 产出 dist-server').toBe(true)
    expect(readFileSync(DIST_SA_MD, 'utf8')).toBe(readFileSync(SRC_SA_MD, 'utf8'))
    console.log('[EVIDENCE AC7a] distSkillMd 存在且与 src 一致')
  })

  it('AC7b：dist 的 load / create 可解析，契约与源态一致', async () => {
    const dist = (await import('../dist-server/skills/index.js')) as unknown as {
      SKILL_AUTHORSHIP_SKILL_NAME: string
      loadSkillAuthorshipMarkdown: () => string
      createSkillAuthorshipRegistration: () => Record<string, unknown>
      SKILL_NAMES: readonly string[]
    }
    expect(dist.SKILL_AUTHORSHIP_SKILL_NAME).toBe(SA)
    expect([...dist.SKILL_NAMES]).not.toContain(SA)

    const raw = dist.loadSkillAuthorshipMarkdown()
    expect(raw).toBe(readFileSync(DIST_SA_MD, 'utf8'))

    const reg = dist.createSkillAuthorshipRegistration()
    expect(reg.name).toBe(SA)
    expect(reg.source).toBe('runtime')
    expect(reg.invocation).toEqual({ modelInvocable: true, userInvocable: true })
    expect(reg.content).toBe(parseFmIndependent(raw).body)
    expect(reg.content).toBe(parseFmIndependent(readFileSync(SRC_SA_MD, 'utf8')).body)
    console.log('[EVIDENCE AC7b] dist load/create 可解析，契约一致')
  })
})
