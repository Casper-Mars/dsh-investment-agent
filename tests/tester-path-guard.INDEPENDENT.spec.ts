/**
 * 独立测试 —— 路径加固（path-guard）运行时落盘/读取验证。
 *
 * 被测交付物（基线 84a0c46 + 未提交改动）：
 *   - 新增 src/domain/path-guard.ts：assertSafeSegment(seg, label)
 *   - 调用点：store.ts symbolDir / strategy.ts(4)
 *
 * 本文件为 Tester 独立产出，**不改** src/ 与既有测试（含 Developer 的
 * tests/path-guard.test.ts）。所有用例用 mkdtemp 临时目录作 baseDir，不污染真实
 * 数据；测试结束清理诱饵文件与临时目录。
 *
 * 覆盖（对应任务卡 5 项验证）：
 *   ① 写路径被拒且零越界（9 种非法输入 × ledger_init / strategy_set）
 *   ② 读路径绝不越界读取（baseDir 之外放诱饵，越界 symbol/version 读不到）
 *   ③ 合法值回归 E2E（588000 / 000001 / v001；ledger_init→set v001→get→set v002）
 *   ④ 入口覆盖审计（静态源码复核：所有 join() 外部输入均经守卫）
 *   ⑤ 契约复核（inject 四项 + cordis.patch.yml 不变）
 */
import { describe, it, expect, afterEach } from 'vitest'
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  existsSync,
  rmSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assertSafeSegment } from '../src/domain/path-guard.js'
import { JsonStore } from '../src/domain/store.js'
import { Ledger } from '../src/domain/ledger.js'
import { StrategyRegistry } from '../src/domain/strategy.js'

/** 诱饵哨兵值：若发生越界读取，该值会出现在返回/错误中，用于断言「读不到」。 */
const DECOY_SENTINEL = '__DECOY_LEAKED_PATHGUARD__'

/** 记录本测试文件创建的所有临时目录，测试结束统一清理。 */
const createdSandboxes: string[] = []

/** 造一个独立沙箱：sandbox 为最外层，baseDir 位于其下（baseDir 的父目录即 sandbox）。 */
function makeSandbox(): { sandbox: string; baseDir: string } {
  const sandbox = mkdtempSync(join(tmpdir(), 'pathguard-sandbox-'))
  createdSandboxes.push(sandbox)
  const baseDir = join(sandbox, 'base')
  mkdirSync(baseDir, { recursive: true })
  return { sandbox, baseDir }
}

/** 递归快照目录（相对路径，含文件与目录），用于「零越界」前后比对。 */
function snapshot(root: string): string[] {
  if (!existsSync(root)) return []
  try {
    return (readdirSync(root, { recursive: true }) as string[]).sort()
  } catch {
    return []
  }
}

afterEach(() => {
  // 逐个清理，容忍已删。
  for (const s of createdSandboxes.splice(0)) {
    try {
      rmSync(s, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  }
})

// ---------------------------------------------------------------------------
// ① 写路径被拒且零越界
// ---------------------------------------------------------------------------
describe('① 写路径被拒且零越界', () => {
  const BAD_INPUTS: ReadonlyArray<readonly [string, string]> = [
    ['空字符串', ''],
    ['单个点', '.'],
    ['双点', '..'],
    ['单层穿越', '../x'],
    ['双层穿越', '../../esc2'],
    ['前导斜杠', '/abs'],
    ['含斜杠', 'a/b'],
    ['含反斜杠', 'a\\b'],
    ['含空白', 'a b'],
    ['超64长度', 'a'.repeat(65)],
  ]

  it('assertSafeSegment 对全部非法输入抛 [path-guard]', () => {
    for (const [label, seg] of BAD_INPUTS) {
      expect(() => assertSafeSegment(seg, 'symbol'), label).toThrow(/\[path-guard\]/)
    }
  })

  describe.each(BAD_INPUTS)('非法输入 %s = %j', (_label, input) => {
    it('strategy_set（StrategyRegistry.set）抛 [path-guard] 且零越界', () => {
      const { sandbox, baseDir } = makeSandbox()
      const reg = new StrategyRegistry(baseDir)
      const before = snapshot(sandbox)

      expect(() => reg.set(input, { text: 'x', rationale: 'r' })).toThrow(
        /\[path-guard\]/,
      )

      const after = snapshot(sandbox)
      expect(after).toEqual(before)
      // 显式断言：sandbox 层与 baseDir 层均无越界产物。
      expect(existsSync(join(sandbox, 'esc2'))).toBe(false)
      expect(existsSync(join(sandbox, 'esc2.md'))).toBe(false)
      expect(existsSync(join(baseDir, 'esc2'))).toBe(false)
    })

    it('ledger_init（Ledger.init）被拒且零越界', () => {
      const { sandbox, baseDir } = makeSandbox()
      const ledger = new Ledger(baseDir)
      const before = snapshot(sandbox)

      // 空字符串在 Ledger.init 有更早的 [ledger] symbol 为空 校验（同为拒绝，
      // 零越界）；其余非法输入由 path-guard 拦截。
      let threw: unknown
      try {
        ledger.init(input, { type: 'etf', qty: 1000, cost: 1.5, cash: 100000 })
      } catch (e) {
        threw = e
      }
      expect(threw, `输入 ${JSON.stringify(input)} 应被拒`).toBeInstanceOf(Error)
      if (input === '') {
        expect((threw as Error).message).toMatch(/\[ledger\]/)
      } else {
        expect((threw as Error).message).toMatch(/\[path-guard\]/)
      }

      const after = snapshot(sandbox)
      expect(after).toEqual(before)
      expect(existsSync(join(sandbox, 'esc2'))).toBe(false)
      expect(existsSync(join(baseDir, 'esc2'))).toBe(false)
      expect(existsSync(join(baseDir, 'ledger'))).toBe(false)
    })
  })

  it('strategy_set 经 nextVersion 生成的版本号永远合法（无越界通道）', () => {
    // set 的 version 由 nextVersion 内部生成（vNNN），不来自外部输入；
    // 此处验证 set → get 正常，且 get 越界 version 被拒。
    const { sandbox, baseDir } = makeSandbox()
    const reg = new StrategyRegistry(baseDir)
    const v = reg.set('588000', { text: 'c1', rationale: 'r' })
    expect(v).toBe('v001')
    expect(reg.get('588000')?.text).toBe('c1')
    expect(reg.get('588000', '../../esc2')).toBeUndefined()
    expect(reg.get('588000', '../esc1')).toBeUndefined()
    expect(existsSync(join(sandbox, 'esc2'))).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// ② 读路径绝不越界读取（baseDir 之外放诱饵）
// ---------------------------------------------------------------------------
describe('② 读路径绝不越界读取', () => {
  it('strategy_get 越界 symbol 读不到 baseDir 之外的诱饵', () => {
    const { sandbox, baseDir } = makeSandbox()
    const reg = new StrategyRegistry(baseDir)

    // 诱饵落在 escape 解析后的目标：join(baseDir, 'strategy_versions', '../../esc2')
    //   = sandbox/esc2/（baseDir 的父目录层）。若守卫缺失，get 会读到该目录的
    //   current 指针（v001）→ v001.md 返回诱饵文本。
    const decoyDir = join(sandbox, 'esc2')
    mkdirSync(decoyDir, { recursive: true })
    writeFileSync(join(decoyDir, 'current'), 'v001', 'utf8')
    writeFileSync(
      join(decoyDir, 'v001.meta.json'),
      JSON.stringify({ version: 'v001', rationale: DECOY_SENTINEL }),
      'utf8',
    )
    writeFileSync(join(decoyDir, 'v001.md'), DECOY_SENTINEL, 'utf8')
    // 诱饵 current 文档：join(baseDir, 'strategy', '../../esc2.md') = sandbox/esc2.md
    writeFileSync(join(sandbox, 'esc2.md'), DECOY_SENTINEL, 'utf8')

    // 越界 symbol 一律读不到（返回 undefined），且哨兵值绝不出现。
    expect(reg.get('../../esc2')).toBeUndefined()
    expect(reg.get('../esc2')).toBeUndefined()
    expect(reg.get('/abs')).toBeUndefined()
    expect(reg.get('a/b')).toBeUndefined()
    expect(reg.current('../../esc2')).toBeUndefined()
    expect(reg.list('../../esc2')).toEqual([])

    // 显式越界 version（symbol 合法）也读不到：readMeta 内 path-guard 被吞，返回 undefined。
    reg.set('588000', { text: '首版', rationale: 'r' })
    expect(reg.get('588000', '../../esc2')).toBeUndefined()
    expect(reg.get('588000', '../esc1')).toBeUndefined()

    // 合法 symbol 读到的是自己的正文（首版），而非诱饵内容。
    const curDoc = join(baseDir, 'strategy', '588000.md')
    expect(existsSync(curDoc)).toBe(true)
    expect(readFileSync(curDoc, 'utf8')).toBe('首版')
    expect(readFileSync(curDoc, 'utf8')).not.toContain(DECOY_SENTINEL)
    // 诱饵文件未被守卫读写/改动（仍为哨兵原样）。
    expect(readFileSync(join(decoyDir, 'v001.md'), 'utf8')).toBe(DECOY_SENTINEL)
    expect(readFileSync(join(sandbox, 'esc2.md'), 'utf8')).toBe(DECOY_SENTINEL)
  })

  it('ledger_query 越界 symbol 抛错且读不到 baseDir 之外的诱饵', () => {
    const { sandbox, baseDir } = makeSandbox()
    const ledger = new Ledger(baseDir)

    // 诱饵：join(baseDir, 'ledger', '../../esc2') = sandbox/esc2/（父目录层）。
    const decoyDir = join(sandbox, 'esc2')
    mkdirSync(decoyDir, { recursive: true })
    writeFileSync(
      join(decoyDir, 'symbols.json'),
      JSON.stringify({
        symbol: DECOY_SENTINEL,
        type: 'etf',
        initPrice: 1,
        name: DECOY_SENTINEL,
      }),
      'utf8',
    )

    let msg = ''
    try {
      ledger.query('../../esc2')
    } catch (e) {
      msg = (e as Error).message
    }
    expect(msg).toMatch(/\[path-guard\]/)
    expect(msg).not.toContain(DECOY_SENTINEL)

    // 合法但不存在的 symbol：正常返回「不存在」错误，而非读到诱饵。
    let notExistMsg = ''
    try {
      ledger.query('999999')
    } catch (e) {
      notExistMsg = (e as Error).message
    }
    expect(notExistMsg).toMatch(/不存在/)
    expect(notExistMsg).not.toContain(DECOY_SENTINEL)
  })
})

// ---------------------------------------------------------------------------
// ③ 合法值回归 E2E
// ---------------------------------------------------------------------------
describe('③ 合法值回归 E2E', () => {
  it('assertSafeSegment 对合法值原样通过', () => {
    expect(assertSafeSegment('588000', 'symbol')).toBe('588000')
    expect(assertSafeSegment('000001', 'symbol')).toBe('000001')
    expect(assertSafeSegment('v001', 'version')).toBe('v001')
    expect(assertSafeSegment('a-b_c.d', 'symbol')).toBe('a-b_c.d')
    expect(assertSafeSegment('a'.repeat(64), 'symbol')).toBe('a'.repeat(64))
  })

  it('完整流程 ledger_init → strategy_set(v001) → get → set(v002, parent=v001)', () => {
    const { baseDir } = makeSandbox()
    const ledger = new Ledger(baseDir)
    const reg = new StrategyRegistry(baseDir)

    // ledger_init
    ledger.init('588000', { type: 'etf', qty: 1000, cost: 1.5, cash: 100000 })

    // strategy_set 首版 → v001
    expect(reg.set('588000', { text: 'v1 正文', rationale: 'r1' })).toBe('v001')

    // strategy_get 当前版
    const cur = reg.get('588000')
    expect(cur?.version).toBe('v001')
    expect(cur?.text).toBe('v1 正文')

    // strategy_set 迭代 → v002（parent=v001）
    expect(
      reg.set('588000', { text: 'v2 正文', rationale: 'r2', parentVersion: 'v001' }),
    ).toBe('v002')
    expect(reg.get('588000')?.version).toBe('v002')
    expect(reg.get('588000')?.text).toBe('v2 正文')
    expect(reg.get('588000', 'v001')?.text).toBe('v1 正文')

    // 另一个合法 symbol
    ledger.init('000001', { type: 'stock', qty: 100, cost: 10, cash: 50000 })
    expect(reg.set('000001', { text: 'z 正文', rationale: 'rz' })).toBe('v001')

    // 落盘正常
    expect(existsSync(join(baseDir, 'strategy', '588000.md'))).toBe(true)
    expect(existsSync(join(baseDir, 'strategy_versions', '588000', 'v002.md'))).toBe(true)
    expect(existsSync(join(baseDir, 'ledger', '588000', 'symbols.json'))).toBe(true)
  })

  it('StrategyRegistry 合法版本 set → get → set v002 正常', () => {
    const { baseDir } = makeSandbox()
    const reg = new StrategyRegistry(baseDir)
    const v1 = reg.set('588000', { text: '正文 v1', rationale: 'r1' })
    expect(v1).toBe('v001')
    expect(reg.get('588000')?.version).toBe('v001')
    expect(reg.get('588000')?.text).toBe('正文 v1')
    const v2 = reg.set('588000', { text: '正文 v2', rationale: 'r2', parentVersion: 'v001' })
    expect(v2).toBe('v002')
    expect(reg.get('588000')?.version).toBe('v002')
  })
})

// ---------------------------------------------------------------------------
// ④ 入口覆盖审计（静态源码复核，作为自动化证据）
// ---------------------------------------------------------------------------
describe('④ 入口覆盖审计', () => {
  const read = (rel: string): string =>
    readFileSync(join(__dirname, '..', 'src', rel), 'utf8')

  it('path-guard 在 4 处调用点均被引用（store/strategy）', () => {
    const store = read('domain/store.ts')
    const strategy = read('domain/strategy.ts')

    // store.ts:96 symbolDir
    expect(store).toContain('assertSafeSegment(symbol, \'symbol\')')
    // strategy.ts:80 symbolVersionsDir、:85 currentPath（symbol）、:92 versionFile、:100 metaFile（version）
    expect(strategy.match(/assertSafeSegment\(symbol, 'symbol'\)/g)?.length).toBeGreaterThanOrEqual(2)
    expect(strategy.match(/assertSafeSegment\(version, 'version'\)/g)?.length).toBeGreaterThanOrEqual(2)

    // 均 import 自 path-guard.js
    expect(store).toContain("import { assertSafeSegment } from './path-guard.js'")
    expect(strategy).toContain("import { assertSafeSegment } from './path-guard.js'")
  })

  it('path-guard 拒绝字符集与长度规则与任务卡一致', () => {
    const src = read('domain/path-guard.ts')
    expect(src).toContain('/^[A-Za-z0-9._-]+$/')
    expect(src).toContain('MAX_SEGMENT_LEN = 64')
    expect(src).toContain("seg === '.' || seg === '..'")
    expect(src).toContain('seg.length === 0')
    expect(src).toContain('seg.length > MAX_SEGMENT_LEN')
  })

  it('predicts/reviews 等其它 domain 模块经 JsonStore（symbolDir 守卫）读写，无裸路径拼接', () => {
    // 审计结论：predicts.ts / reviews.ts 均经 JsonStore.readTable/writeTable 落盘
    // （内部 tablePath→symbolDir 已守卫）；date 仅作 JSON 记录内键，不拼入路径。
    const predicts = read('domain/predicts.ts')
    const reviews = read('domain/reviews.ts')
    expect(predicts).toContain("from './store.js'")
    expect(reviews).toContain("from './store.js'")
    // 不直接 import node:path 做 join 拼接
    expect(predicts).not.toContain("from 'node:path'")
    expect(reviews).not.toContain("from 'node:path'")
  })
})

// ---------------------------------------------------------------------------
// ⑤ 契约复核（inject 四项 + cordis.patch.yml）
// ---------------------------------------------------------------------------
describe('⑤ 契约复核', () => {
  it('plugin.ts 顶层 inject 四项不变', () => {
    const src = readFileSync(join(__dirname, '..', 'src', 'plugin.ts'), 'utf8')
    expect(src).toContain(
      "export const inject: string[] = ['tools', 'skills', 'ptcRuntime', 'fs']",
    )
  })

  it('cordis.patch.yml 的 inject 与 plugin.ts 一致', () => {
    const patch = readFileSync(
      join(__dirname, '..', 'cordis.patch.yml'),
      'utf8',
    )
    expect(patch).toContain("inject: ['tools', 'skills', 'ptcRuntime', 'fs']")
    expect(patch).toContain('name: dsh-finance')
  })
})
