/**
 * 独立测试 —— Task-17「strategy-registry」运行时落盘验证（Task-3 迁移后复验）。
 *
 * 被测交付物：src/domain/strategy.ts（StrategyRegistry，git 版本化）。
 *
 * 迁移要点：策略正文落 `<assetsDir>/strategies/<symbol>.md`，版本由 assets 外层
 * git 仓库承担（短 SHA），`strategy_versions/` / `vNNN.*` / `current` 全部删除；
 * 策略文档为纯正文，不写 frontmatter。
 *
 * 本文件为 Tester 独立产出，所有用例用 mkdtemp 临时目录作为 assetsDir，
 * 不污染真实 ~/.dsh-ia。
 *
 * 覆盖：
 *   ① 落盘完整性  ② 内容一致性  ③ 版本不可变  ④ 读取语义  ⑤ 未设定
 *   ⑥ 错误路径(3) ⑦ 目录隔离    ⑧ 路径安全    ⑨ AC2 无 @deepseek-ai import
 */
import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  existsSync,
  rmSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { StrategyRegistry } from '../src/domain/strategy.js'

const SHA_RE = /^[0-9a-f]{12}$/

/** 造一个独立临时 assetsDir，返回 { baseDir, sandbox }。 */
function makeBaseDir(): { baseDir: string; sandbox: string } {
  const sandbox = mkdtempSync(join(tmpdir(), 'task17-sandbox-'))
  const baseDir = join(sandbox, 'base')
  mkdirSync(baseDir, { recursive: true })
  return { baseDir, sandbox }
}

/** 读取文件为 Buffer（逐字节比对用）。 */
function readBytes(p: string): Buffer {
  return readFileSync(p)
}

/** 读取文件为 utf8 字符串。 */
function readUtf8(p: string): string {
  return readFileSync(p, 'utf8')
}

function git(cwd: string, args: string[]): string {
  return execFileSync(
    'git',
    ['-c', 'user.name=dsh-ia', '-c', 'user.email=dsh-ia@localhost', ...args],
    { cwd, encoding: 'utf8' },
  )
}

describe('① 落盘完整性：set(sym, v1) 后正文 + git 提交齐备', () => {
  it('strategies/<sym>.md 存在且逐字节一致；无 strategy_versions/vNNN/current', () => {
    const { baseDir, sandbox } = makeBaseDir()
    try {
      const reg = new StrategyRegistry(baseDir)
      const sym = '588000'
      const text = '# 首版策略\n买入并持有\n'
      const rationale = '初始策略：长期持有'

      const v = reg.set(sym, { text, rationale, by: 'tester' })
      expect(v).toMatch(SHA_RE)

      const curDoc = join(baseDir, 'strategies', `${sym}.md`)
      expect(existsSync(curDoc)).toBe(true)
      expect(readUtf8(curDoc)).toBe(text)
      expect(readUtf8(curDoc).startsWith('---')).toBe(false)

      // git 提交可回溯：message = rationale，作者 = 注入身份。
      expect(git(baseDir, ['log', '-1', '--format=%s']).trim()).toBe(rationale)
      expect(git(baseDir, ['rev-parse', 'HEAD']).trim().slice(0, 12)).toBe(v)
      expect(git(baseDir, ['log', '-1', '--format=%an']).trim()).toBe('dsh-ia')

      // 自建版本链彻底消失。
      expect(existsSync(join(baseDir, 'strategy_versions'))).toBe(false)
      expect(existsSync(join(baseDir, 'strategy'))).toBe(false)
      const entries = readdirSync(join(baseDir, 'strategies'))
      expect(entries).toEqual([`${sym}.md`])
      expect(entries.some((n) => /^v\d{3,}/.test(n) || n === 'current')).toBe(false)

      // meta 与入参一致。
      const meta = reg.get(sym)?.meta
      expect(meta?.version).toBe(v)
      expect(meta?.rationale).toBe(rationale)
      expect(typeof meta?.ts).toBe('string')
      expect(Number.isNaN(Date.parse(meta!.ts))).toBe(false)
      expect(meta?.parent).toBeUndefined()
      expect(meta?.by).toBe('dsh-ia')
    } finally {
      rmSync(sandbox, { recursive: true, force: true })
    }
  })
})

describe('② 内容一致性', () => {
  it('工作区正文与 git blob 逐字节一致；meta.rationale 与入参一致', () => {
    const { baseDir, sandbox } = makeBaseDir()
    try {
      const reg = new StrategyRegistry(baseDir)
      const sym = '588000'
      const text = '# 正文\n- 要点 A\n- 要点 B\n'
      const rationale = '一致性质控'

      const v = reg.set(sym, { text, rationale })

      const curDoc = readBytes(join(baseDir, 'strategies', `${sym}.md`))
      const blob = execFileSync('git', ['show', `${v}:strategies/${sym}.md`], {
        cwd: baseDir,
        encoding: 'buffer',
      })
      expect(curDoc.equals(blob)).toBe(true)
      expect(reg.get(sym)?.meta.rationale).toBe(rationale)
    } finally {
      rmSync(sandbox, { recursive: true, force: true })
    }
  })
})

describe('③ 版本不可变（git 历史）', () => {
  it('追加二版后，旧版本正文 / meta 仍按旧短 SHA 回读', () => {
    const { baseDir, sandbox } = makeBaseDir()
    try {
      const reg = new StrategyRegistry(baseDir)
      const sym = '588000'

      const v1 = reg.set(sym, { text: 'v1 正文', rationale: 'r1', by: 'a' })

      const v2 = reg.set(sym, {
        text: 'v2 正文（新版）',
        rationale: 'r2',
        parentVersion: v1,
        by: 'b',
      })
      expect(v2).toMatch(SHA_RE)
      expect(v2).not.toBe(v1)

      // 历史不可变：旧 SHA 仍取回旧正文 / 旧 rationale。
      const old = reg.get(sym, v1)
      expect(old?.text).toBe('v1 正文')
      expect(old?.meta.rationale).toBe('r1')

      // 当前版前进，工作区为 v2。
      expect(reg.current(sym)).toBe(v2)
      expect(readUtf8(join(baseDir, 'strategies', `${sym}.md`))).toBe('v2 正文（新版）')

      // commit 数 = 2。
      expect(git(baseDir, ['rev-list', '--count', 'HEAD']).trim()).toBe('2')
    } finally {
      rmSync(sandbox, { recursive: true, force: true })
    }
  })
})

describe('④ 读取语义', () => {
  it("get 默认取当前版；get(,旧SHA) 取旧原文；list 按时间正序", () => {
    const { baseDir, sandbox } = makeBaseDir()
    try {
      const reg = new StrategyRegistry(baseDir)
      const sym = '588000'

      const v1Text = 'v1 原文内容'
      const v1 = reg.set(sym, { text: v1Text, rationale: 'r1' })
      const v2 = reg.set(sym, { text: 'v2 新内容', rationale: 'r2', parentVersion: v1 })

      const cur = reg.get(sym)
      expect(cur?.version).toBe(v2)
      expect(cur?.text).toBe('v2 新内容')
      expect(cur?.meta.parent).toBe(v1)

      const old = reg.get(sym, v1)
      expect(old?.version).toBe(v1)
      expect(old?.text).toBe(v1Text)
      expect(old?.symbol).toBe(sym)

      expect(reg.list(sym).map((m) => m.version)).toEqual([v1, v2])
      expect(reg.list(sym)[1].parent).toBe(v1)
    } finally {
      rmSync(sandbox, { recursive: true, force: true })
    }
  })
})

describe('⑤ 未设定', () => {
  it('未 set 过的 symbol：get / current / list 均为空', () => {
    const { baseDir, sandbox } = makeBaseDir()
    try {
      const reg = new StrategyRegistry(baseDir)
      expect(reg.get('nonexistent')).toBeUndefined()
      expect(reg.current('nonexistent')).toBeUndefined()
      expect(reg.list('nonexistent')).toEqual([])
    } finally {
      rmSync(sandbox, { recursive: true, force: true })
    }
  })
})

describe('⑥ 错误路径（真实触发并断言抛错）', () => {
  it('① 文件尚不存在却提供 parentVersion → 抛错', () => {
    const { baseDir, sandbox } = makeBaseDir()
    try {
      const reg = new StrategyRegistry(baseDir)
      expect(() =>
        reg.set('588000', { text: 'v1', rationale: 'r1', parentVersion: '0123456789ab' }),
      ).toThrow(/parentVersion/)
    } finally {
      rmSync(sandbox, { recursive: true, force: true })
    }
  })

  it('② parentVersion ≠ 当前版 → 抛错', () => {
    const { baseDir, sandbox } = makeBaseDir()
    try {
      const reg = new StrategyRegistry(baseDir)
      const v1 = reg.set('588000', { text: 'v1', rationale: 'r1' })
      reg.set('588000', { text: 'v2', rationale: 'r2', parentVersion: v1 })
      expect(() =>
        reg.set('588000', { text: 'v3', rationale: 'r3', parentVersion: v1 }),
      ).toThrow(/不一致/)
    } finally {
      rmSync(sandbox, { recursive: true, force: true })
    }
  })

  it('③ 已有版本时不带 parentVersion 也可写（校验为可选），但内容一致则 no-op', () => {
    const { baseDir, sandbox } = makeBaseDir()
    try {
      const reg = new StrategyRegistry(baseDir)
      const v1 = reg.set('588000', { text: 'v1', rationale: 'r1' })
      // 不带 parent：允许（可选乐观校验），返回新提交。
      const v2 = reg.set('588000', { text: 'v2', rationale: 'r2' })
      expect(v2).toMatch(SHA_RE)
      expect(v2).not.toBe(v1)
      // 内容与当前完全一致：no-op 返回当前短 SHA，不新增提交。
      const count = git(baseDir, ['rev-list', '--count', 'HEAD']).trim()
      expect(reg.set('588000', { text: 'v2', rationale: 'again' })).toBe(v2)
      expect(git(baseDir, ['rev-list', '--count', 'HEAD']).trim()).toBe(count)
    } finally {
      rmSync(sandbox, { recursive: true, force: true })
    }
  })
})

describe('⑦ 目录隔离', () => {
  it('两个不同 symbol 的策略互不干扰（同一 assets 仓库、独立文件历史）', () => {
    const { baseDir, sandbox } = makeBaseDir()
    try {
      const reg = new StrategyRegistry(baseDir)

      const a1 = reg.set('A0001', { text: 'A-v1', rationale: 'ra1' })
      const b1 = reg.set('B0002', { text: 'B-v1', rationale: 'rb1' })
      const a2 = reg.set('A0001', { text: 'A-v2', rationale: 'ra2', parentVersion: a1 })

      expect(reg.current('A0001')).toBe(a2)
      expect(reg.list('A0001').map((m) => m.version)).toEqual([a1, a2])
      expect(reg.get('A0001')?.text).toBe('A-v2')

      expect(reg.current('B0002')).toBe(b1)
      expect(reg.list('B0002').map((m) => m.version)).toEqual([b1])
      expect(reg.get('B0002')?.text).toBe('B-v1')

      expect(existsSync(join(baseDir, 'strategies', 'A0001.md'))).toBe(true)
      expect(existsSync(join(baseDir, 'strategies', 'B0002.md'))).toBe(true)
    } finally {
      rmSync(sandbox, { recursive: true, force: true })
    }
  })
})

describe('⑧ 路径安全评估（越界 symbol 一律被拒）', () => {
  it('symbol 含 ../ 或 / 一律被拒且不落盘', () => {
    const { baseDir, sandbox } = makeBaseDir()
    try {
      const reg = new StrategyRegistry(baseDir)

      const probe = (sym: string): { threw: boolean; msg: string; escapedOut: string[] } => {
        const before = new Set(readdirSync(sandbox, { recursive: true }) as string[])
        try {
          reg.set(sym, { text: 'probe', rationale: 'probe' })
        } catch (e) {
          return { threw: true, msg: (e as Error).message, escapedOut: [] }
        }
        const after = readdirSync(sandbox, { recursive: true }) as string[]
        const created = after.filter((p) => !before.has(p))
        return { threw: false, msg: 'ok', escapedOut: created }
      }

      const r1 = probe('../esc1')
      const r2 = probe('../../esc2')
      const r3 = probe('/absfoo')

      console.log('[task17-path-safety] ../esc1  threw=%s msg=%s created=%s',
        r1.threw, r1.msg, JSON.stringify(r1.escapedOut))
      console.log('[task17-path-safety] ../../esc2 threw=%s msg=%s created=%s',
        r2.threw, r2.msg, JSON.stringify(r2.escapedOut))
      console.log('[task17-path-safety] /absfoo threw=%s msg=%s created=%s',
        r3.threw, r3.msg, JSON.stringify(r3.escapedOut))

      expect(r1.threw).toBe(true)
      expect(r1.escapedOut.length).toBe(0)
      expect(r2.threw).toBe(true)
      expect(r2.escapedOut.length).toBe(0)
      expect(r3.threw).toBe(true)
      expect(r3.escapedOut.length).toBe(0)
    } finally {
      rmSync(sandbox, { recursive: true, force: true })
    }
  })
})

describe('⑨ AC2 复核：strategy.ts 无 @deepseek-ai/* import', () => {
  it('仅 import node:fs / node:path / 本地模块', () => {
    const src = readUtf8(join(__dirname, '..', 'src', 'domain', 'strategy.ts'))
    expect(/import\s+[^'"]*['"]@deepseek-ai\//.test(src)).toBe(false)
    expect(/from\s+['"]@deepseek-ai\//.test(src)).toBe(false)
    expect(/require\(\s*['"]@deepseek-ai\//.test(src)).toBe(false)
    expect(/from\s+['"]node:fs['"]/.test(src)).toBe(true)
    expect(/from\s+['"]node:path['"]/.test(src)).toBe(true)
  })
})
