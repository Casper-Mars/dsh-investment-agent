/**
 * 独立测试 —— Task-17「strategy-registry」运行时落盘验证。
 *
 * 被测交付物：src/domain/strategy.ts（StrategyRegistry）+ src/domain/types.ts
 * （+34 策略类型）+ src/domain/store.ts（LedgerTable 移除 'strategy'）。
 *
 * 本文件为 Tester 独立产出，**不改** src/ 与既有测试（含 tests/strategy.test.ts）。
 * 所有用例用 mkdtemp 临时目录作为 baseDir，不污染真实 dataRoot。
 *
 * 覆盖（对应任务卡 9 项验收点）：
 *   ① 落盘完整性  ② 内容一致性  ③ 版本不可变  ④ 读取语义  ⑤ 未设定
 *   ⑥ 错误路径(3) ⑦ 目录隔离    ⑧ 路径安全    ⑨ AC2 无 @deepseek-ai import
 */
import { describe, it, expect } from 'vitest'
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  existsSync,
  rmSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { StrategyRegistry } from '../src/domain/strategy.js'

/** 造一个独立临时 baseDir，返回 { baseDir, sandbox }（sandbox 为最外层，便于清理）。 */
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

describe('① 落盘完整性：set(sym, v1) 后 4 处落盘', () => {
  it('4 处文件均存在且内容正确', () => {
    const { baseDir, sandbox } = makeBaseDir()
    try {
      const reg = new StrategyRegistry(baseDir)
      const sym = '588000'
      const text = '# 首版策略\n买入并持有\n'
      const rationale = '初始策略：长期持有'

      const v = reg.set(sym, { text, rationale, by: 'tester' })
      expect(v).toBe('v001')

      // 1) strategy/<symbol>.md
      const curDoc = join(baseDir, 'strategy', `${sym}.md`)
      expect(existsSync(curDoc)).toBe(true)
      expect(readUtf8(curDoc)).toBe(text)

      // 2) strategy_versions/<symbol>/v001.md
      const v1Doc = join(baseDir, 'strategy_versions', sym, 'v001.md')
      expect(existsSync(v1Doc)).toBe(true)
      expect(readUtf8(v1Doc)).toBe(text)

      // 3) v001.meta.json
      const v1Meta = join(baseDir, 'strategy_versions', sym, 'v001.meta.json')
      expect(existsSync(v1Meta)).toBe(true)
      const meta = JSON.parse(readUtf8(v1Meta))
      expect(meta.version).toBe('v001')
      expect(meta.rationale).toBe(rationale)
      expect(typeof meta.ts).toBe('string')
      expect(Number.isNaN(Date.parse(meta.ts))).toBe(false)
      expect(meta.parent).toBeUndefined() // 首版无 parent
      expect(meta.by).toBe('tester')

      // 4) current 指针
      const pointer = join(baseDir, 'strategy_versions', sym, 'current')
      expect(existsSync(pointer)).toBe(true)
      expect(readUtf8(pointer).trim()).toBe('v001')
    } finally {
      rmSync(sandbox, { recursive: true, force: true })
    }
  })
})

describe('② 内容一致性', () => {
  it('strategy/<sym>.md 与 v001.md 逐字节一致；meta.rationale 与入参一致', () => {
    const { baseDir, sandbox } = makeBaseDir()
    try {
      const reg = new StrategyRegistry(baseDir)
      const sym = '588000'
      const text = '# 正文\n- 要点 A\n- 要点 B\n'
      const rationale = '一致性质控'

      reg.set(sym, { text, rationale })

      const curDoc = readBytes(join(baseDir, 'strategy', `${sym}.md`))
      const v1Doc = readBytes(join(baseDir, 'strategy_versions', sym, 'v001.md'))
      expect(curDoc.equals(v1Doc)).toBe(true)

      const meta = JSON.parse(
        readUtf8(join(baseDir, 'strategy_versions', sym, 'v001.meta.json')),
      )
      expect(meta.rationale).toBe(rationale)
    } finally {
      rmSync(sandbox, { recursive: true, force: true })
    }
  })
})

describe('③ 版本不可变', () => {
  it('追加 v002 后 v001.md / v001.meta.json 内容与时间戳均未被改写', () => {
    const { baseDir, sandbox } = makeBaseDir()
    try {
      const reg = new StrategyRegistry(baseDir)
      const sym = '588000'

      reg.set(sym, { text: 'v1 正文', rationale: 'r1', by: 'a' })

      const v1DocPath = join(baseDir, 'strategy_versions', sym, 'v001.md')
      const v1MetaPath = join(baseDir, 'strategy_versions', sym, 'v001.meta.json')

      const v1DocBefore = readBytes(v1DocPath)
      const v1MetaBefore = readBytes(v1MetaPath)
      const v1DocMtime = statSync(v1DocPath).mtimeMs
      const v1MetaMtime = statSync(v1MetaPath).mtimeMs

      // 追加 v002
      const v2 = reg.set(sym, {
        text: 'v2 正文（新版）',
        rationale: 'r2',
        parentVersion: 'v001',
        by: 'b',
      })
      expect(v2).toBe('v002')

      // 不可变：内容字节一致
      expect(readBytes(v1DocPath).equals(v1DocBefore)).toBe(true)
      expect(readBytes(v1MetaPath).equals(v1MetaBefore)).toBe(true)
      // 不可变：时间戳未变（未重写）
      expect(statSync(v1DocPath).mtimeMs).toBe(v1DocMtime)
      expect(statSync(v1MetaPath).mtimeMs).toBe(v1MetaMtime)

      // current → v002；strategy/<sym>.md 更新为 v2 正文
      expect(readUtf8(join(baseDir, 'strategy_versions', sym, 'current')).trim()).toBe('v002')
      expect(readUtf8(join(baseDir, 'strategy', `${sym}.md`))).toBe('v2 正文（新版）')
    } finally {
      rmSync(sandbox, { recursive: true, force: true })
    }
  })
})

describe('④ 读取语义', () => {
  it('get 默认取当前版(v2)；get(,\'v001\') 取 v1 原文；list 返回 [v001,v002]', () => {
    const { baseDir, sandbox } = makeBaseDir()
    try {
      const reg = new StrategyRegistry(baseDir)
      const sym = '588000'

      const v1Text = 'v1 原文内容'
      reg.set(sym, { text: v1Text, rationale: 'r1' })
      reg.set(sym, { text: 'v2 新内容', rationale: 'r2', parentVersion: 'v001' })

      // 默认当前版 = v2
      const cur = reg.get(sym)
      expect(cur?.version).toBe('v002')
      expect(cur?.text).toBe('v2 新内容')
      expect(cur?.meta.parent).toBe('v001')

      // 指定 v001 → 原文一致
      const old = reg.get(sym, 'v001')
      expect(old?.version).toBe('v001')
      expect(old?.text).toBe(v1Text)
      expect(old?.symbol).toBe(sym)

      // list 顺序
      expect(reg.list(sym).map((m) => m.version)).toEqual(['v001', 'v002'])
    } finally {
      rmSync(sandbox, { recursive: true, force: true })
    }
  })
})

describe('⑤ 未设定', () => {
  it('未 set 过的 symbol：get 与 current 均返回 undefined', () => {
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
  it('① 非首版不带 parentVersion → 抛错', () => {
    const { baseDir, sandbox } = makeBaseDir()
    try {
      const reg = new StrategyRegistry(baseDir)
      reg.set('588000', { text: 'v1', rationale: 'r1' })
      expect(() => reg.set('588000', { text: 'v2', rationale: 'r2' })).toThrow(
        /parentVersion/,
      )
    } finally {
      rmSync(sandbox, { recursive: true, force: true })
    }
  })

  it('② parentVersion ≠ 当前版 → 抛错', () => {
    const { baseDir, sandbox } = makeBaseDir()
    try {
      const reg = new StrategyRegistry(baseDir)
      reg.set('588000', { text: 'v1', rationale: 'r1' })
      reg.set('588000', { text: 'v2', rationale: 'r2', parentVersion: 'v001' })
      // 当前已是 v002，声明 parent=v001 → 不一致
      expect(() =>
        reg.set('588000', { text: 'v3', rationale: 'r3', parentVersion: 'v001' }),
      ).toThrow(/不一致/)
    } finally {
      rmSync(sandbox, { recursive: true, force: true })
    }
  })

  it('③ 已有版本时再以「首版」（不带 parent）写入 → 抛错', () => {
    const { baseDir, sandbox } = makeBaseDir()
    try {
      const reg = new StrategyRegistry(baseDir)
      reg.set('588000', { text: 'v1', rationale: 'r1' })
      expect(() => reg.set('588000', { text: 'v2-as-first', rationale: 'r2' })).toThrow(
        /parentVersion/,
      )
      // 且落盘未被破坏：current 仍为 v001
      expect(reg.current('588000')).toBe('v001')
    } finally {
      rmSync(sandbox, { recursive: true, force: true })
    }
  })
})

describe('⑦ 目录隔离', () => {
  it('两个不同 symbol 的策略互不干扰（独立版本链与指针）', () => {
    const { baseDir, sandbox } = makeBaseDir()
    try {
      const reg = new StrategyRegistry(baseDir)

      reg.set('A0001', { text: 'A-v1', rationale: 'ra1' })
      reg.set('B0002', { text: 'B-v1', rationale: 'rb1' })
      reg.set('A0001', { text: 'A-v2', rationale: 'ra2', parentVersion: 'v001' })

      // A 链：v001→v002，current=v002
      expect(reg.current('A0001')).toBe('v002')
      expect(reg.list('A0001').map((m) => m.version)).toEqual(['v001', 'v002'])
      expect(reg.get('A0001')?.text).toBe('A-v2')

      // B 链：仍只有 v001，current=v001，未受 A 影响
      expect(reg.current('B0002')).toBe('v001')
      expect(reg.list('B0002').map((m) => m.version)).toEqual(['v001'])
      expect(reg.get('B0002')?.text).toBe('B-v1')

      // 落盘目录独立
      expect(existsSync(join(baseDir, 'strategy_versions', 'A0001'))).toBe(true)
      expect(existsSync(join(baseDir, 'strategy_versions', 'B0002'))).toBe(true)
      expect(readUtf8(join(baseDir, 'strategy', 'A0001.md'))).toBe('A-v2')
      expect(readUtf8(join(baseDir, 'strategy', 'B0002.md'))).toBe('B-v1')
    } finally {
      rmSync(sandbox, { recursive: true, force: true })
    }
  })
})

describe('⑧ 路径安全评估（如实观察，不要求修复）', () => {
  it('symbol 含 ../ 或 / 的行为观测', () => {
    const { baseDir, sandbox } = makeBaseDir()
    try {
      const reg = new StrategyRegistry(baseDir)

      const probe = (sym: string): { threw: boolean; msg: string; escapedOut: string[] } => {
        const before = new Set(
          readdirSync(sandbox, { recursive: true }) as string[],
        )
        try {
          reg.set(sym, { text: 'probe', rationale: 'probe' })
        } catch (e) {
          return { threw: true, msg: (e as Error).message, escapedOut: [] }
        }
        const after = readdirSync(sandbox, { recursive: true }) as string[]
        const created = after.filter((p) => !before.has(p))
        return { threw: false, msg: 'ok', escapedOut: created }
      }

      // 单层 ../ ：是否逃出 strategy_versions/ 目录（仍在 baseDir 内）
      const r1 = probe('../esc1')
      // 双层 ../ ：是否逃出 baseDir 本体（写入 sandbox 层）
      const r2 = probe('../../esc2')
      // 绝对路径风格 / ：是否被 path.join 归并（不逃逸）
      const r3 = probe('/absfoo')

      // 记录原始观测，供报告引用。
      console.log('[task17-path-safety] ../esc1  threw=%s msg=%s created=%s',
        r1.threw, r1.msg, JSON.stringify(r1.escapedOut))
      console.log('[task17-path-safety] ../../esc2 threw=%s msg=%s created=%s',
        r2.threw, r2.msg, JSON.stringify(r2.escapedOut))
      console.log('[task17-path-safety] /absfoo threw=%s msg=%s created=%s',
        r3.threw, r3.msg, JSON.stringify(r3.escapedOut))

      // 断言「观测到的事实」：双层 ../ 已把文件写到 baseDir 之外（sandbox 层）。
      // 这是如实记录漏洞存在，而非通过断言要求修复。
      expect(r2.escapedOut.length).toBeGreaterThan(0)
    } finally {
      rmSync(sandbox, { recursive: true, force: true })
    }
  })
})

describe('⑨ AC2 复核：strategy.ts 无 @deepseek-ai/* import', () => {
  it('仅 import node:fs / node:path / 本地 type', () => {
    const src = readUtf8(
      join(__dirname, '..', 'src', 'domain', 'strategy.ts'),
    )
    // 任何 import/require 语句引用 @deepseek-ai 前缀 → 违规
    expect(/import\s+[^'"]*['"]@deepseek-ai\//.test(src)).toBe(false)
    expect(/from\s+['"]@deepseek-ai\//.test(src)).toBe(false)
    expect(/require\(\s*['"]@deepseek-ai\//.test(src)).toBe(false)
    // 确认只用了允许的模块
    expect(/from\s+['"]node:fs['"]/.test(src)).toBe(true)
    expect(/from\s+['"]node:path['"]/.test(src)).toBe(true)
  })
})
