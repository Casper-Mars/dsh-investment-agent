/**
 * 独立验收 —— Task-3「策略资产迁出到 assets/strategies，版本改由 git 承担」。
 *
 * 本文件由 Tester 独立编写，**不读取 Developer 的测试结论**，直接验证验收标准：
 *   1. 策略读写落在 `<assetsDir>/strategies/<symbol>.md`，运行后不产生
 *      `strategy_versions/`、`vNNN*`、`current`；
 *   2. 正文逐字节一致，无 frontmatter（首行不得为 `---`）；
 *   3. 每次变更恰好一次 git commit，任一历史版本可 `git log` / `git show` 回溯；
 *   4. 历史回读按 git 实现（含回滚 = revert 场景）；
 *   5. `tsc --noEmit` EXIT=0 + 定向测试全绿（tsc 由报告记录，本文件只覆盖运行时）；
 *   6. DSH_IA_HOME 隔离：不写 `<home>/data/strategy*`，不触碰真实 `~/.dsh-ia`；
 *   7. 外层仓库结构：`.git` / `.gitignore`（含 `skills/`）/ `git ls-files` 无 skills
 *      条目 / 无 gitlink（160000）/ 嵌套 `skills/.git` 历史不受影响；
 *   8. 并发乐观校验：同一 parentVersion 连续两次 set，第二次必须报错；
 *   9. 失败语义：gitRunner 抛错时 set 必须抛错（不降级为 false）；get 行为明确；
 *  10. 历史读取健壮性：非法 version（deadbeef / ../ / v001）→ undefined，不崩溃、
 *      不路径穿越；
 *  11. 内容一致 no-op：完全相同的 text+rationale 不产生新 commit，返回当前短 SHA；
 *  12. 工具层契约：strategy_set → `{ ok:true, version:<12位hex> }`；strategy_get
 *      默认当前版 / 指定旧 SHA 取历史正文；parent_version 不符报错而非覆盖。
 *
 * 安全：所有用例目录使用 `mkdtempSync(join(tmpdir(), ...))`，并通过 `DSH_IA_HOME`
 * 或显式 `assetsDir` 隔离；只**只读**真实 `~/.dsh-ia`（用于断言未被触碰），绝不写入。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
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
import { homedir, tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import { StrategyRegistry } from '../src/domain/strategy.js'
import { ensureAssetsRepo, ASSETS_GITIGNORE } from '../src/assets/repo.js'
import { commitAssetsChanges } from '../src/assets/repo.js'
import { ensureSkillAssetsRepo } from '../src/skills/repo.js'
import { createToolContext } from '../src/tools/context.js'
import { createAllTools } from '../src/tools/index.js'

// git 子进程在并行/低配环境下较慢：放宽超时，避免时序抖动产生假阴性。
vi.setConfig({ testTimeout: 60000 })

const SHA12 = /^[0-9a-f]{12}$/
const REAL_HOME = join(homedir(), '.dsh-ia')

let dir = ''
let assetsDir = ''
let reg: StrategyRegistry

/** 本地 git（显式身份，避免依赖宿主机全局 config）。 */
function git(cwd: string, args: string[]): string {
  return execFileSync(
    'git',
    ['-c', 'user.name=dsh-ia', '-c', 'user.email=dsh-ia@localhost', ...args],
    { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' } },
  )
}

/** 仓库内 commit 总数（含所有 ref）。 */
function commitCount(cwd: string): number {
  return Number.parseInt(git(cwd, ['rev-list', '--count', '--all']).trim(), 10)
}

/** 递归列出目录下所有文件（相对路径，posix 分隔符）。 */
function walk(root: string): string[] {
  const out: string[] = []
  const visit = (p: string): void => {
    for (const entry of readdirSync(p, { withFileTypes: true })) {
      const abs = join(p, entry.name)
      if (entry.isDirectory()) visit(abs)
      else if (entry.isFile()) out.push(relative(root, abs).split('\\').join('/'))
    }
  }
  visit(root)
  return out
}

/** 未跟踪 + 已跟踪的文件全清单（含 ignored 判定前的原始清单）。 */
function rawFiles(root: string): string[] {
  const out: string[] = []
  const visit = (p: string): void => {
    for (const entry of readdirSync(p, { withFileTypes: true })) {
      const abs = join(p, entry.name)
      if (entry.name === '.git') continue
      if (entry.isDirectory()) visit(abs)
      else if (entry.isFile()) out.push(relative(root, abs).split('\\').join('/'))
    }
  }
  visit(root)
  return out
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dsh-ia-t100463-'))
  assetsDir = join(dir, 'assets')
  mkdirSync(assetsDir, { recursive: true })
  reg = new StrategyRegistry(assetsDir)
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// 验收 1：落盘布局，无自建版本链
// ---------------------------------------------------------------------------
describe('验收 1：策略落 assets/strategies/<symbol>.md，无 strategy_versions / vNNN / current', () => {
  it('多次写入后仅有 strategies/<symbol>.md + .git/.gitignore，无任何旧版本链文件', () => {
    reg.set('588000', { text: 'v1', rationale: 'r1' })
    reg.set('588000', { text: 'v2', rationale: 'r2' })
    reg.set('000001', { text: 'v1', rationale: 'r1' })

    expect(existsSync(join(assetsDir, 'strategies', '588000.md'))).toBe(true)
    expect(existsSync(join(assetsDir, 'strategies', '000001.md'))).toBe(true)
    expect(existsSync(join(assetsDir, '.git'))).toBe(true)

    // 显式断言旧目录不存在（assets 与 data 两侧都不允许）。
    expect(existsSync(join(assetsDir, 'strategy_versions'))).toBe(false)
    expect(existsSync(join(assetsDir, 'strategy'))).toBe(false)
    expect(existsSync(join(dir, 'data', 'strategy_versions'))).toBe(false)
    expect(existsSync(join(dir, 'data', 'strategy'))).toBe(false)

    // 全树扫描：不存在 vNNN* / current / *.meta.json 等旧的版本链 artefact。
    const files = rawFiles(assetsDir)
    const legacy = files.filter(
      (f) =>
        /(^|\/)v\d{3,}(\.|$)/.test(f) ||
        /(^|\/)current$/.test(f) ||
        f.endsWith('.meta.json'),
    )
    expect(legacy, `发现旧版本链文件：${legacy.join(', ')}`).toEqual([])
    expect(readdirSync(join(assetsDir, 'strategies')).sort()).toEqual(['000001.md', '588000.md'])
  })
})

// ---------------------------------------------------------------------------
// 验收 2：逐字节一致 + 无 frontmatter
// ---------------------------------------------------------------------------
describe('验收 2：正文逐字节一致，无 frontmatter / 元数据块', () => {
  it('CRLF / 尾随换行 / Unicode / 首行非 --- 的正文原样落盘，读回一致', () => {
    const text = '# 策略标题\r\n\r\n阈值 0.6 —— 中文 & emoji 🚀\r\n末行无换行'
    reg.set('588000', { text, rationale: 'byte-exact' })

    const disk = readFileSync(join(assetsDir, 'strategies', '588000.md'))
    expect(disk.equals(Buffer.from(text, 'utf8')), '磁盘字节与输入不一致').toBe(true)
    expect(disk.toString('utf8')).toBe(text)
    expect(disk[0]).not.toBe(0x2d) // 首字节不是 '-'
    expect(disk.toString('utf8').split('\n')[0].startsWith('---')).toBe(false)

    // git 中的 blob 也必须逐字节一致（不被 commit 流程追加任何东西）。
    expect(git(assetsDir, ['show', 'HEAD:strategies/588000.md'])).toBe(text)
    expect(reg.get('588000')?.text).toBe(text)
  })

  it('即使正文自身以 --- 开头也只按原文保存，不额外包裹元数据', () => {
    const text = '---\nthresholds:\n  dir_hit_min: 0.7\n---\n正文'
    reg.set('588000', { text, rationale: '自带 front-matter 属原文' })
    expect(readFileSync(join(assetsDir, 'strategies', '588000.md'), 'utf8')).toBe(text)
    expect(git(assetsDir, ['show', 'HEAD:strategies/588000.md'])).toBe(text)
  })
})

// ---------------------------------------------------------------------------
// 验收 3：每次变更恰好一次 commit，历史可回溯
// ---------------------------------------------------------------------------
describe('验收 3：每次变更恰好一次 commit，历史可 git log / git show 回溯', () => {
  it('3 次变更 = 3 个 commit，且每个 commit 只影响对应文件一次', () => {
    // set 之前仓库尚未创建（惰性 init）：首次 set 必须同时完成 init + 首提交。
    expect(existsSync(join(assetsDir, '.git'))).toBe(false)

    const v1 = reg.set('588000', { text: 'A', rationale: 'rationale-1' })
    expect(existsSync(join(assetsDir, '.git'))).toBe(true)
    expect(commitCount(assetsDir)).toBe(1)
    const v2 = reg.set('588000', { text: 'B', rationale: 'rationale-2' })
    expect(commitCount(assetsDir)).toBe(2)
    const v3 = reg.set('588000', { text: 'C', rationale: 'rationale-3' })
    expect(commitCount(assetsDir)).toBe(3)

    expect([v1, v2, v3].every((v) => SHA12.test(v))).toBe(true)
    expect(new Set([v1, v2, v3]).size).toBe(3)

    // 文件历史提交数 = 变更次数（恰好一次，无重复提交）。
    const logShas = git(assetsDir, ['log', '--format=%H', '--', 'strategies/588000.md'])
      .split('\n')
      .filter((l) => l.trim() !== '')
    expect(logShas).toHaveLength(3)

    // 每个短 SHA 都能被 git log / git show 解析，且 rationale 原文出现在 commit message。
    for (const [sha, text, rationale] of [
      [v1, 'A', 'rationale-1'],
      [v2, 'B', 'rationale-2'],
      [v3, 'C', 'rationale-3'],
    ] as const) {
      expect(git(assetsDir, ['log', '-1', '--format=%H', sha]).trim()).toBe(logShas.find((l) => l.startsWith(sha)))
      expect(git(assetsDir, ['show', `${sha}:strategies/588000.md`])).toBe(text)
      expect(git(assetsDir, ['show', '-s', '--format=%B', sha]).trim()).toBe(rationale)
    }
  })
})

// ---------------------------------------------------------------------------
// 验收 4：历史回读 + 回滚（真实 git revert）
// ---------------------------------------------------------------------------
describe('验收 4：历史回读按 git 实现（含 revert 回滚）', () => {
  it('get(symbol, 旧SHA) 返回历史正文与 rationale；list 正序且 parent 链接正确', () => {
    const v1 = reg.set('588000', { text: '一版', rationale: 'r1' })
    const v2 = reg.set('588000', { text: '二版', rationale: 'r2' })

    expect(reg.get('588000', v1)?.text).toBe('一版')
    expect(reg.get('588000', v1)?.version).toBe(v1)
    expect(reg.get('588000', v1)?.meta.rationale).toBe('r1')
    expect(reg.get('588000', v2)?.text).toBe('二版')
    expect(reg.get('588000')?.text).toBe('二版')
    expect(reg.get('588000')?.version).toBe(v2)

    const list = reg.list('588000')
    expect(list.map((m) => m.version)).toEqual([v1, v2])
    expect(list[0].parent).toBeUndefined()
    expect(list[1].parent).toBe(v1)
  })

  it('真实 git revert 上一版：current 前进到 revert commit，正文回到 v1，历史仍可读', () => {
    const v1 = reg.set('588000', { text: '一版正文', rationale: 'r1' })
    const v2 = reg.set('588000', { text: '二版正文', rationale: 'r2' })

    // 真实 revert（不是「把旧文本再 set 一次」）。
    git(assetsDir, ['revert', '--no-edit', v2])
    const reverted = reg.current('588000')
    expect(reverted).toMatch(SHA12)
    expect(reverted).not.toBe(v2)

    expect(reg.get('588000')?.text).toBe('一版正文')
    expect(reg.get('588000')?.version).toBe(reverted)
    // revert 提交的 message 由 git 生成（Revert "r2"），应能被读到。
    expect(reg.get('588000')?.meta.rationale).toContain('Revert')

    // 历史不受影响。
    expect(reg.get('588000', v2)?.text).toBe('二版正文')
    expect(reg.get('588000', v1)?.text).toBe('一版正文')
    expect(reg.list('588000')).toHaveLength(3)
    expect(commitCount(assetsDir)).toBe(3)
  })
})

// ---------------------------------------------------------------------------
// 额外 6：DSH_IA_HOME 隔离 + 真实 home 不被触碰
// ---------------------------------------------------------------------------
describe('额外 6：DSH_IA_HOME 隔离，无旧路径写入，真实 ~/.dsh-ia 不被触碰', () => {
  let prevHome: string | undefined
  let prevData: string | undefined
  let homeDir = ''

  beforeEach(() => {
    prevHome = process.env.DSH_IA_HOME
    prevData = process.env.DSH_IA_DATA_DIR
    homeDir = mkdtempSync(join(tmpdir(), 'dsh-ia-t100463-home-'))
    process.env.DSH_IA_HOME = homeDir
    delete process.env.DSH_IA_DATA_DIR
  })

  afterEach(() => {
    if (prevHome === undefined) delete process.env.DSH_IA_HOME
    else process.env.DSH_IA_HOME = prevHome
    if (prevData === undefined) delete process.env.DSH_IA_DATA_DIR
    else process.env.DSH_IA_DATA_DIR = prevData
    rmSync(homeDir, { recursive: true, force: true })
  })

  it('createToolContext() 全默认解析下：策略只落 <home>/assets，data 无 strategy*', async () => {
    const symbol = 'T100463'
    const realLegacy = {
      strategy: existsSync(join(REAL_HOME, 'data', 'strategy')),
      versions: existsSync(join(REAL_HOME, 'data', 'strategy_versions')),
      assetDoc: existsSync(join(REAL_HOME, 'assets', 'strategies', `${symbol}.md`)),
      dataSymbol: existsSync(join(REAL_HOME, 'data', symbol)),
    }

    const ctx = createToolContext() // dataRoot / assetsDir 全走 env → homeDir
    const tools = createAllTools(ctx)
    const run = async (name: string, args: Record<string, unknown>) => {
      const t = tools.find((x) => x.name === name)
      if (!t) throw new Error(`未注册：${name}`)
      return t.execute(args, { signal: new AbortController().signal })
    }
    await run('ledger_init', {
      symbol,
      type: 'etf',
      init_qty: 100,
      init_cost: 1,
      init_cash: 1000,
    })
    const set = (await run('strategy_set', {
      symbol,
      text: '隔离验证正文',
      rationale: 'isolation',
    })) as { ok: boolean; version: string }

    expect(set.ok).toBe(true)
    expect(set.version).toMatch(SHA12)

    // 资产侧正确落盘。
    expect(readFileSync(join(homeDir, 'assets', 'strategies', `${symbol}.md`), 'utf8')).toBe(
      '隔离验证正文',
    )
    // data 侧不得出现旧策略路径。
    expect(existsSync(join(homeDir, 'data', 'strategy'))).toBe(false)
    expect(existsSync(join(homeDir, 'data', 'strategy_versions'))).toBe(false)
    expect(existsSync(join(homeDir, 'data', symbol))).toBe(false)
    expect(existsSync(join(homeDir, 'assets', 'strategy_versions'))).toBe(false)

    // 真实 home 完全未被本次运行触碰（唯一 symbol 探针）。
    expect(existsSync(join(REAL_HOME, 'data', 'strategy'))).toBe(realLegacy.strategy)
    expect(existsSync(join(REAL_HOME, 'data', 'strategy_versions'))).toBe(realLegacy.versions)
    expect(existsSync(join(REAL_HOME, 'assets', 'strategies', `${symbol}.md`))).toBe(
      realLegacy.assetDoc,
    )
    expect(existsSync(join(REAL_HOME, 'data', symbol))).toBe(realLegacy.dataSymbol)
  })
})

// ---------------------------------------------------------------------------
// 额外 7：外层仓库结构（单仓：skills 与策略同仓、同索引）
// ---------------------------------------------------------------------------
describe('额外 7：assets 单仓结构，skills 以普通文件进入外层索引', () => {
  it('.git 唯一、.gitignore 不排除 skills、ls-files 含 skills、无 160000 gitlink', () => {
    const outcome = ensureAssetsRepo({ assetsDir, logger: () => {} })
    expect(outcome.degraded).toBe(false)
    expect(existsSync(join(assetsDir, '.git'))).toBe(true)
    expect(readFileSync(join(assetsDir, '.gitignore'), 'utf8')).not.toContain('skills/')
    expect(ASSETS_GITIGNORE).not.toContain('skills/')

    // 放入 5 个 skill 种子（skill 层职责）。
    const seeded = ensureSkillAssetsRepo({ assetsDir, logger: () => {} })
    expect(seeded.provisioned).toBe(true)
    commitAssetsChanges({ dir: assetsDir, logger: () => {} })

    reg.set('588000', { text: '策略', rationale: 'init' })
    reg.set('588000', { text: '策略2', rationale: 'update' })

    // 外层索引包含 skills 下的普通文件与策略文件，且无 gitlink。
    expect(existsSync(join(assetsDir, 'skills', '.git'))).toBe(false)
    const lsFiles = git(assetsDir, ['ls-files']).split('\n').filter((l) => l !== '')
    expect(lsFiles.some((f) => f.startsWith('skills/') && f.endsWith('/SKILL.md'))).toBe(true)
    expect(lsFiles.includes('strategies/588000.md')).toBe(true)
    expect(lsFiles.includes('.gitignore')).toBe(true)

    const lsTree = git(assetsDir, ['ls-tree', '-r', 'HEAD']).split('\n').filter((l) => l !== '')
    expect(lsTree.some((l) => l.startsWith('160000'))).toBe(false)
    // skills 条目为普通文件（100644）。
    expect(lsTree.some((l) => /^100644 .*\tskills\//.test(l))).toBe(true)

    // 工作区干净：skills 不被忽略，也不产生 untracked 噪声。
    const porcelain = git(assetsDir, ['status', '--porcelain'])
    expect(porcelain.trim()).toBe('')
  })
})

// ---------------------------------------------------------------------------
// 额外 8：并发乐观校验
// ---------------------------------------------------------------------------
describe('额外 8：同一 parentVersion 连续两次 set，第二次必须报错（不静默覆盖）', () => {
  it('第二次 set 抛冲突，且文件内容仍为第一次写入的正文', () => {
    const v1 = reg.set('588000', { text: 'base', rationale: 'r0' })
    const v2 = reg.set('588000', { text: 'first-writer', rationale: 'r1', parentVersion: v1 })
    expect(v2).not.toBe(v1)

    expect(() =>
      reg.set('588000', { text: 'second-writer', rationale: 'r2', parentVersion: v1 }),
    ).toThrow(/parentVersion|不一致/)

    expect(readFileSync(join(assetsDir, 'strategies', '588000.md'), 'utf8')).toBe('first-writer')
    expect(reg.current('588000')).toBe(v2)
    expect(commitCount(assetsDir)).toBe(2)
  })
})

// ---------------------------------------------------------------------------
// 额外 9：失败语义
// ---------------------------------------------------------------------------
describe('额外 9：git 不可用时的失败语义', () => {
  it('set 在 gitRunner 抛错时抛错（不是返回 false / 静默成功）', () => {
    const broken = new StrategyRegistry(join(dir, 'broken-assets'), () => {
      throw new Error('spawn git ENOENT')
    })
    let caught: unknown
    try {
      const r = broken.set('588000', { text: 'x', rationale: 'r' })
      caught = r
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(Error)
    expect(String((caught as Error).message)).toMatch(/git|仓库/)
    // 未产生半写文件。
    expect(existsSync(join(dir, 'broken-assets', 'strategies', '588000.md'))).toBe(false)
  })

  it('get 在 git 不可用时行为明确：返回 undefined（不抛、不返回半成结果）', () => {
    // 先用正常 registry 建好仓库与正文。
    const v1 = reg.set('588000', { text: '正文', rationale: 'r1' })
    expect(reg.get('588000')?.version).toBe(v1)

    const broken = new StrategyRegistry(assetsDir, () => {
      throw new Error('spawn git ENOENT')
    })
    // 明确契约：git 不可用 → undefined（正文文件存在但无法确认版本身份，故不返回）。
    expect(broken.get('588000')).toBeUndefined()
    expect(broken.get('588000', v1)).toBeUndefined()
    expect(broken.list('588000')).toEqual([])
    expect(broken.current('588000')).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// 额外 10：历史读取健壮性
// ---------------------------------------------------------------------------
describe('额外 10：非法 / 不存在的 version 安全返回 undefined，不崩溃、不穿越', () => {
  it('deadbeef / ../ / v001 / current / 超长等一律 undefined', () => {
    reg.set('588000', { text: '正文', rationale: 'r1' })
    const bad = [
      'deadbeef',
      'deadbeefdeadbeefdeadbeef',
      '../escape',
      '../../escape',
      '..',
      '.',
      'v001',
      'v001.md',
      'current',
      ''.padStart(65, 'a'),
      'a/b',
      'a:b',
      'HEAD~1',
    ]
    for (const v of bad) {
      expect(() => reg.get('588000', v), `version=${v} 不应抛错`).not.toThrow()
      expect(reg.get('588000', v), `version=${v} 应返回 undefined`).toBeUndefined()
    }
    // 无路径穿越副作用。
    expect(existsSync(join(dir, 'escape.md'))).toBe(false)
    expect(existsSync(join(dir, 'escape'))).toBe(false)
    expect(existsSync(join(assetsDir, 'strategies', 'escape.md'))).toBe(false)
  })

  it('symbol 非法时 get 返回 undefined、set 抛 path-guard（不写出目录外）', () => {
    expect(reg.get('../../escape')).toBeUndefined()
    expect(() => reg.set('../../escape', { text: 'x', rationale: 'r' })).toThrow(/path-guard/)
    expect(existsSync(join(dir, 'escape.md'))).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 额外 11：内容一致 no-op
// ---------------------------------------------------------------------------
describe('额外 11：内容完全一致时 no-op，不产生空提交', () => {
  it('相同 text + rationale 连续两次：commit 数不变，返回同一短 SHA', () => {
    const v1 = reg.set('588000', { text: '同文', rationale: 'same' })
    const before = commitCount(assetsDir)
    const again = reg.set('588000', { text: '同文', rationale: 'same' })
    expect(again).toBe(v1)
    expect(commitCount(assetsDir)).toBe(before)
    expect(reg.current('588000')).toBe(v1)
  })

  it('相同 text 不同 rationale 也不产生新 commit（文本语义版本）', () => {
    const v1 = reg.set('588000', { text: '同文', rationale: 'r1' })
    const before = commitCount(assetsDir)
    expect(reg.set('588000', { text: '同文', rationale: 'r2-different' })).toBe(v1)
    expect(commitCount(assetsDir)).toBe(before)
  })
})

// ---------------------------------------------------------------------------
// 额外 12：工具层契约
// ---------------------------------------------------------------------------
describe('额外 12：工具层契约（strategy_set / strategy_get）', () => {
  let prevHome: string | undefined
  let homeDir = ''
  let tools: ToolDefinition[]

  const run = async (name: string, args: Record<string, unknown>) => {
    const t = tools.find((x) => x.name === name)
    if (!t) throw new Error(`未注册：${name}`)
    return t.execute(args, { signal: new AbortController().signal }) as Promise<any>
  }

  beforeEach(async () => {
    prevHome = process.env.DSH_IA_HOME
    homeDir = mkdtempSync(join(tmpdir(), 'dsh-ia-t100463-tools-'))
    process.env.DSH_IA_HOME = homeDir
    tools = createAllTools(createToolContext({ dataRoot: join(homeDir, 'data') }))
    await run('ledger_init', {
      symbol: '588000',
      type: 'etf',
      init_qty: 100,
      init_cost: 1,
      init_cash: 1000,
    })
  })

  afterEach(() => {
    if (prevHome === undefined) delete process.env.DSH_IA_HOME
    else process.env.DSH_IA_HOME = prevHome
    rmSync(homeDir, { recursive: true, force: true })
  })

  it('strategy_set → { ok:true, version:<12位hex> }，符合 output.schema', async () => {
    const setTool = tools.find((x) => x.name === 'strategy_set')!
    const res = await run('strategy_set', {
      symbol: '588000',
      text: '# 首版',
      rationale: '初始',
    })
    expect(res).toEqual({ ok: true, version: expect.stringMatching(SHA12) })
    expect(validateJsonSchemaValue(setTool.output.schema, res)).toEqual([])
    expect(Object.keys(res).sort()).toEqual(['ok', 'version'])
  })

  it('strategy_get 默认当前版；指定旧 SHA 返回历史正文；updated_at 为该 commit 时间', async () => {
    const v1 = (await run('strategy_set', {
      symbol: '588000',
      text: '一版正文',
      rationale: 'r1',
    })) as { version: string }
    const v2 = (await run('strategy_set', {
      symbol: '588000',
      text: '二版正文',
      rationale: 'r2',
      parent_version: v1.version,
    })) as { version: string }

    const cur = await run('strategy_get', { symbol: '588000' })
    expect(cur).toEqual({
      symbol: '588000',
      text: '二版正文',
      version: v2.version,
      updated_at: expect.any(String),
    })
    expect(validateJsonSchemaValue(tools.find((x) => x.name === 'strategy_get')!.output.schema, cur)).toEqual([])

    const old = await run('strategy_get', { symbol: '588000', version: v1.version })
    expect(old.text).toBe('一版正文')
    expect(old.version).toBe(v1.version)
    // updated_at 必须与对应 commit 的 author date 一致。
    expect(old.updated_at).toBe(git(join(homeDir, 'assets'), ['show', '-s', '--format=%aI', v1.version]).trim())
  })

  it('parent_version 不符报错而非覆盖；未 set 前 get 抛引导错误', async () => {
    await expect(run('strategy_get', { symbol: '588000' })).rejects.toThrow(/尚未|先调用 strategy_set|尚无策略/)

    const v1 = (await run('strategy_set', {
      symbol: '588000',
      text: '一版',
      rationale: 'r1',
    })) as { version: string }
    await run('strategy_set', {
      symbol: '588000',
      text: '二版',
      rationale: 'r2',
      parent_version: v1.version,
    })

    // 旧的 parent_version 再次提交 → 报错。
    await expect(
      run('strategy_set', {
        symbol: '588000',
        text: '三版-覆盖尝试',
        rationale: 'r3',
        parent_version: v1.version,
      }),
    ).rejects.toThrow(/parentVersion|不一致/)

    // 内容未被覆盖。
    const cur = await run('strategy_get', { symbol: '588000' })
    expect(cur.text).toBe('二版')
    expect(readFileSync(join(homeDir, 'assets', 'strategies', '588000.md'), 'utf8')).toBe('二版')
  })

  it('未在台账注册的标的 → strategy_set 抛错（不会写资产）', async () => {
    await expect(
      run('strategy_set', { symbol: '999999', text: 'x', rationale: 'r' }),
    ).rejects.toThrow(/台账|ledger_init/)
    expect(existsSync(join(homeDir, 'assets', 'strategies', '999999.md'))).toBe(false)
  })
})
