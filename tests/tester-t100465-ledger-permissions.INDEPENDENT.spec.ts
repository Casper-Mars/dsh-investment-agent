/**
 * Tester 独立验证 —— 任务-05「运行时数据确认 + 台账敏感加固（0o700）」
 *
 * 与 Developer 的 `tests/ledger-permissions.spec.ts` **相互独立**（不复用其辅助函数、
 * 不导入其用例），逐条覆盖验收 1–4 与额外必测 5–10：
 *
 *   AC1 台账读写在 data/ledger 正常，内容结构不变（表名 / JSON 序列化 / 字段不变）
 *   AC2 ledger/ 与 <symbol>/ 均为 0o700
 *   AC3 data/ 不进 git（check-ignore 命中、ls-files 为空）
 *   AC4 tsc --noEmit EXIT=0（命令级验证，见 REPORT.md）+ 台账相关测试通过
 *   AC5 权限收紧对**已存在**目录生效（mkdir mode 不修正既有目录的回归）
 *   AC6 写入路径不绕过：不存在时创建 0o700；多次写入不改权限、不丢既有文件
 *   AC7 路径不变：<dataRoot>/ledger/<symbol>/<table>.json，不含 assets/；
 *       dataRoot 由构造注入，不受 DSH_IA_HOME 影响
 *   AC8 8 张表读写往返，结构与内容一致，JSON 为 2 空格缩进
 *   AC9 不触碰真实数据：全部 mkdtempSync；DSH_IA_HOME 指向 tmp 后断言未被创建
 *   AC10 符号安全：'../evil' / 'a/b' / '..' 仍被 path-guard 拒绝，且不产生越界目录
 *
 * 安全约束：一律 mkdtempSync；**绝不** chmod / 读写真实 `~/.dsh-ia`；仅本文件定向执行。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { JsonStore, LedgerStore, newTradeId } from '../src/domain/store.js'
import type { LedgerTable, SymbolRecord } from '../src/domain/store.js'
import type {
  MetricSnapshot,
  PredictionRecord,
  ReviewRecord,
  Thresholds,
  Trade,
} from '../src/domain/types.js'

let sandbox: string
let dataRoot: string
let fakeHome: string
let store: JsonStore
let ledger: LedgerStore
const originalHomeEnv = process.env.DSH_IA_HOME
const originalUserHome = process.env.HOME

/** 全部 8 张台账表（顺序即 §7.1 口径）。 */
const TABLES: LedgerTable[] = [
  'symbols',
  'positions',
  'accounts',
  'trades',
  'predictions',
  'reviews',
  'metrics',
  'thresholds',
]

/** 取路径权限位（去掉文件类型位）。 */
function modeOf(path: string): number {
  return statSync(path).mode & 0o777
}

beforeEach(() => {
  // 每个用例一个独立沙箱；dataRoot 为注入目录，fakeHome 仅用于证明未被使用。
  sandbox = mkdtempSync(join(tmpdir(), 'dsh-ia-t100465-'))
  dataRoot = join(sandbox, 'data')
  mkdirSync(dataRoot)
  fakeHome = join(sandbox, 'fake-home')
  process.env.DSH_IA_HOME = fakeHome
  store = new JsonStore(dataRoot)
  ledger = new LedgerStore(store)
})

afterEach(() => {
  rmSync(sandbox, { recursive: true, force: true })
  if (originalHomeEnv === undefined) delete process.env.DSH_IA_HOME
  else process.env.DSH_IA_HOME = originalHomeEnv
  if (originalUserHome === undefined) delete process.env.HOME
  else process.env.HOME = originalUserHome
})

// ---------------------------------------------------------------------------
// AC1 / AC8：读写正常 + 结构不变 + 8 表往返 + 2 空格缩进
// ---------------------------------------------------------------------------

describe('[AC1/AC8] 台账落点 data/ledger、结构不变、8 表读写往返', () => {
  const symbol = '588000'
  const symbolsRec: SymbolRecord = {
    symbol,
    name: '科创50ETF',
    type: 'etf',
    initPrice: 1.9523,
    settlement: 'T+1',
  }
  const positionsRec = { symbol, qty: 1000, avgCost: 1.9523 }
  const accountsRec = { symbol, cash: 12345.67, realizedPnl: -12.5, floatPnl: 88.8 }
  const tradesRec: Trade[] = [
    {
      id: newTradeId(),
      symbol,
      side: 'buy',
      qty: 1000,
      price: 1.95,
      ts: 1700000000000,
      reason: '建仓',
    },
  ]
  const predictionsRec: PredictionRecord[] = [
    {
      id: 'p_1',
      symbol,
      date: '2026-10-16',
      dir: 'up',
      rangeLow: 1.9,
      rangeHigh: 2.0,
      confidence: 0.63,
      watchPoints: ['放量突破 1.98'],
      ts: 1700000000001,
    },
  ]
  const reviewsRec: ReviewRecord[] = [
    {
      id: 'r_1',
      symbol,
      date: '2026-10-16',
      hitDir: true,
      hitRange: false,
      decisionTriggered: true,
      decisionExecuted: false,
      notes: '区间上沿偏保守',
      summary: '方向命中、区间未命中',
      report: '## 复盘\n- 方向正确',
      ts: 1700000000002,
    },
  ]
  const metricsRec: MetricSnapshot[] = [
    {
      symbol,
      date: '2026-10-16',
      dirHitRate: 0.75,
      rangeHitRate: 0.5,
      cumReturn: 0.0812,
      history: [],
    },
  ]
  const thresholdsRec: Thresholds = {
    dirHitMin: 0.6,
    cumReturnMin: -0.05,
    missStreakMax: 3,
  }

  it('8 张表各写读一轮：值深等、表名与文件名不变、原文件字节等于 2 空格缩进序列化', () => {
    const fixtures: Record<LedgerTable, unknown> = {
      symbols: symbolsRec,
      positions: positionsRec,
      accounts: accountsRec,
      trades: tradesRec,
      predictions: predictionsRec,
      reviews: reviewsRec,
      metrics: metricsRec,
      thresholds: thresholdsRec,
    }

    // 写入前断言表名集合与任务卡一致（防止悄悄改名/增删）。
    expect(Object.keys(fixtures).sort()).toEqual([...TABLES].sort())

    for (const table of TABLES) {
      store.writeTable(symbol, table, fixtures[table])

      // 1) 读回值深等
      expect(store.readTable(symbol, table)).toEqual(fixtures[table])

      // 2) 落点文件名未变
      const path = join(dataRoot, 'ledger', symbol, `${table}.json`)
      expect(existsSync(path)).toBe(true)

      // 3) JSON 序列化口径未变：2 空格缩进、无尾随换行
      const raw = readFileSync(path, 'utf8')
      expect(raw).toBe(JSON.stringify(fixtures[table], null, 2))
      expect(raw).toBe(raw.trimEnd())
    }

    // 目录内文件集合恰好是 8 张表，无额外/重命名文件。
    expect(readdirSync(join(dataRoot, 'ledger', symbol)).sort()).toEqual(
      TABLES.map((t) => `${t}.json`).sort(),
    )
  })

  it('LedgerStore 业务封装仍读写同一批表（saveSymbol/savePosition/saveAccount/appendTrade/getThresholds）', () => {
    ledger.saveSymbol(symbolsRec)
    ledger.savePosition(positionsRec)
    ledger.saveAccount(accountsRec)
    ledger.appendTrade(symbol, tradesRec[0])
    ledger.saveThresholds(symbol, thresholdsRec)

    expect(ledger.getSymbol(symbol)).toEqual(symbolsRec)
    expect(ledger.getPosition(symbol)).toEqual(positionsRec)
    expect(ledger.getAccount(symbol)).toEqual(accountsRec)
    expect(ledger.getTrades(symbol)).toEqual(tradesRec)
    expect(ledger.getThresholds(symbol)).toEqual(thresholdsRec)
    expect(ledger.listSymbols()).toEqual([symbol])
  })
})

// ---------------------------------------------------------------------------
// AC2：目录权限 0o700
// ---------------------------------------------------------------------------

describe('[AC2] ledger/ 与 <symbol>/ 权限严格 0o700', () => {
  it('ensureSymbolDir 后两级目录均为 0o700', () => {
    const dir = store.ensureSymbolDir('588000')
    const ledgerRoot = join(dataRoot, 'ledger')

    expect(dir).toBe(join(ledgerRoot, '588000'))
    expect(modeOf(ledgerRoot)).toBe(0o700)
    expect(modeOf(dir)).toBe(0o700)
  })

  it('writeTable 建目录后两级目录均为 0o700（写入路径同样加固）', () => {
    store.writeTable('588000', 'symbols', {
      symbol: '588000',
      type: 'etf',
      initPrice: 1.95,
    } satisfies SymbolRecord)

    expect(modeOf(join(dataRoot, 'ledger'))).toBe(0o700)
    expect(modeOf(join(dataRoot, 'ledger', '588000'))).toBe(0o700)
  })

  it('umask=022 下仍为 0o700（证明 chmod 兜底生效，而非仅靠 umask）', () => {
    const prev = process.umask(0o022)
    try {
      // 对照组：无 mode 的 mkdir 在 umask 022 下是 0o755（即改动前的行为）。
      const control = join(sandbox, 'umask022-control')
      mkdirSync(control, { recursive: true })
      expect(modeOf(control)).toBe(0o755)

      const root = join(sandbox, 'umask022')
      const s = new JsonStore(root)
      s.writeTable('588000', 'symbols', {
        symbol: '588000',
        type: 'etf',
        initPrice: 1.95,
      } satisfies SymbolRecord)

      expect(modeOf(join(root, 'ledger'))).toBe(0o700)
      expect(modeOf(join(root, 'ledger', '588000'))).toBe(0o700)
    } finally {
      process.umask(prev)
    }
  })

  it('不同 symbol 各自 0o700，且互不干扰', () => {
    store.writeTable('588000', 'symbols', { symbol: '588000', type: 'etf', initPrice: 1 })
    store.writeTable('000001', 'symbols', { symbol: '000001', type: 'stock', initPrice: 10 })

    expect(modeOf(join(dataRoot, 'ledger'))).toBe(0o700)
    expect(modeOf(join(dataRoot, 'ledger', '588000'))).toBe(0o700)
    expect(modeOf(join(dataRoot, 'ledger', '000001'))).toBe(0o700)
  })
})

// ---------------------------------------------------------------------------
// AC3：data/ 不进 git
// ---------------------------------------------------------------------------

describe('[AC3] data/ 不进 git', () => {
  function repoRoot(): string {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: process.cwd(),
      encoding: 'utf8',
    }).trim()
  }

  it('git check-ignore -v data/x 命中 .gitignore 的 /data/ 规则', () => {
    const out = execFileSync('git', ['check-ignore', '-v', '--', 'data/x'], {
      cwd: repoRoot(),
      encoding: 'utf8',
    })
    expect(out).toContain('.gitignore')
    expect(out).toContain('/data/')
    expect(out.trim().endsWith('data/x')).toBe(true)
  })

  it('git ls-files 中不存在 data/ 下的受跟踪文件', () => {
    const out = execFileSync('git', ['ls-files', '--', 'data'], {
      cwd: repoRoot(),
      encoding: 'utf8',
    }).trim()
    expect(out).toBe('')
  })

  it('台账运行时产物（data/ledger/...）同样被忽略', () => {
    // 即便真实仓库里出现台账文件，也不应被 git 纳入。
    const out = execFileSync(
      'git',
      ['check-ignore', '-v', '--', 'data/ledger/588000/positions.json'],
      { cwd: repoRoot(), encoding: 'utf8' },
    )
    expect(out).toContain('/data/')
  })
})

// ---------------------------------------------------------------------------
// AC5：权限收紧对**已存在**目录生效（关键回归）
// ---------------------------------------------------------------------------

describe('[AC5] 已存在但过宽的目录被收紧回 0o700', () => {
  it('ledger/ 与 <symbol>/ 预置为 0o755：ensureSymbolDir 后均回到 0o700', () => {
    const ledgerRoot = join(dataRoot, 'ledger')
    const symbolDir = join(ledgerRoot, '588000')
    mkdirSync(symbolDir, { recursive: true })
    chmodSync(ledgerRoot, 0o755)
    chmodSync(symbolDir, 0o755)
    expect(modeOf(ledgerRoot)).toBe(0o755)
    expect(modeOf(symbolDir)).toBe(0o755)

    store.ensureSymbolDir('588000')

    expect(modeOf(ledgerRoot)).toBe(0o700)
    expect(modeOf(symbolDir)).toBe(0o700)
  })

  it('writeTable 对预置 0o755 的两级目录同样收紧（写入路径不绕过）', () => {
    const ledgerRoot = join(dataRoot, 'ledger')
    const symbolDir = join(ledgerRoot, '588000')
    mkdirSync(symbolDir, { recursive: true })
    chmodSync(ledgerRoot, 0o755)
    chmodSync(symbolDir, 0o755)
    // 预置一个旧文件，确认收紧权限不误删数据。
    writeFileSync(join(symbolDir, 'positions.json'), '{"legacy":true}', 'utf8')

    store.writeTable('588000', 'positions', { symbol: '588000', qty: 1, avgCost: 1 })

    expect(modeOf(ledgerRoot)).toBe(0o700)
    expect(modeOf(symbolDir)).toBe(0o700)
    expect(store.readTable('588000', 'positions')).toEqual({
      symbol: '588000',
      qty: 1,
      avgCost: 1,
    })
  })

  it('0o777 / 0o750 / 0o711 等宽权限均被修正为 0o700', () => {
    const symbolDir = join(dataRoot, 'ledger', '588000')
    mkdirSync(symbolDir, { recursive: true })

    for (const wide of [0o777, 0o750, 0o711]) {
      chmodSync(symbolDir, wide)
      expect(modeOf(symbolDir)).toBe(wide)
      store.ensureSymbolDir('588000')
      expect(modeOf(symbolDir)).toBe(0o700)
    }
  })
})

// ---------------------------------------------------------------------------
// AC6：写入路径不绕过
// ---------------------------------------------------------------------------

describe('[AC6] writeTable 建目录 + 幂等写入', () => {
  it('目录不存在时创建为 0o700；连续多次写入权限不变、既有文件不丢失', () => {
    const symbolDir = join(dataRoot, 'ledger', '588000')

    store.writeTable('588000', 'symbols', {
      symbol: '588000',
      type: 'etf',
      initPrice: 1.95,
    } satisfies SymbolRecord)
    expect(modeOf(symbolDir)).toBe(0o700)

    store.writeTable('588000', 'positions', { symbol: '588000', qty: 100, avgCost: 2 })
    expect(modeOf(symbolDir)).toBe(0o700)

    store.writeTable('588000', 'accounts', {
      symbol: '588000',
      cash: 1,
      realizedPnl: 0,
      floatPnl: 0,
    })
    expect(modeOf(symbolDir)).toBe(0o700)
    expect(modeOf(join(dataRoot, 'ledger'))).toBe(0o700)

    // 既有文件未被后续写入波及。
    expect(store.readTable('588000', 'symbols')).toEqual({
      symbol: '588000',
      type: 'etf',
      initPrice: 1.95,
    })
    expect(store.readTable('588000', 'positions')).toEqual({
      symbol: '588000',
      qty: 100,
      avgCost: 2,
    })
    expect(readdirSync(symbolDir).sort()).toEqual([
      'accounts.json',
      'positions.json',
      'symbols.json',
    ])
  })

  it('覆盖写同一张表：权限保持 0o700，内容为最后一次值', () => {
    store.writeTable('588000', 'positions', { symbol: '588000', qty: 1, avgCost: 1 })
    const symbolDir = join(dataRoot, 'ledger', '588000')
    expect(modeOf(symbolDir)).toBe(0o700)

    store.writeTable('588000', 'positions', { symbol: '588000', qty: 2, avgCost: 2 })
    expect(modeOf(symbolDir)).toBe(0o700)
    expect(store.readTable('588000', 'positions')).toEqual({
      symbol: '588000',
      qty: 2,
      avgCost: 2,
    })
  })
})

// ---------------------------------------------------------------------------
// AC7：路径不变 + dataRoot 由构造注入决定
// ---------------------------------------------------------------------------

describe('[AC7] 路径不变、dataRoot 注入决定', () => {
  it('tablePath = <dataRoot>/ledger/<symbol>/<table>.json，且不含 assets/', () => {
    expect(store.tablePath('588000', 'positions')).toBe(
      join(dataRoot, 'ledger', '588000', 'positions.json'),
    )
    expect(store.tablePath('588000', 'positions').endsWith('ledger/588000/positions.json')).toBe(
      true,
    )
    expect(store.tablePath('588000', 'positions')).not.toContain('assets')
    expect(store.symbolDir('588000')).not.toContain('assets')
    expect(store.ensureSymbolDir('588000')).not.toContain('assets')
  })

  it('DSH_IA_HOME 变化不影响已构造实例的路径与落点', () => {
    const before = store.tablePath('588000', 'positions')
    const beforeSymbolDir = store.symbolDir('588000')

    process.env.DSH_IA_HOME = join(sandbox, 'another-home')
    expect(store.tablePath('588000', 'positions')).toBe(before)
    expect(store.symbolDir('588000')).toBe(beforeSymbolDir)

    store.writeTable('588000', 'symbols', { symbol: '588000', type: 'etf', initPrice: 1 })
    // 落点仍在注入的 dataRoot 内，且未创建环境变量指向的目录。
    expect(existsSync(join(dataRoot, 'ledger', '588000', 'symbols.json'))).toBe(true)
    expect(existsSync(join(sandbox, 'another-home'))).toBe(false)
  })

  it('两个不同注入 root 完全隔离', () => {
    const otherRoot = join(sandbox, 'other-data')
    const other = new JsonStore(otherRoot)

    store.writeTable('588000', 'symbols', { symbol: '588000', type: 'etf', initPrice: 1 })
    other.writeTable('588000', 'symbols', { symbol: '588000', type: 'etf', initPrice: 2 })

    expect(other.tablePath('588000', 'symbols')).toBe(
      join(otherRoot, 'ledger', '588000', 'symbols.json'),
    )
    expect(store.readTable('588000', 'symbols')).toEqual({
      symbol: '588000',
      type: 'etf',
      initPrice: 1,
    })
    expect(other.readTable('588000', 'symbols')).toEqual({
      symbol: '588000',
      type: 'etf',
      initPrice: 2,
    })
    expect(existsSync(join(otherRoot, 'ledger'))).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// AC9：不触碰真实数据
// ---------------------------------------------------------------------------

describe('[AC9] 全部临时目录，未创建/修改 DSH_IA_HOME 指向的目录', () => {
  it('构造 + 全表写入后，沙箱内只出现注入的 data/，fake-home 不存在', () => {
    const dataRootModeBefore = modeOf(dataRoot)

    for (const table of TABLES) {
      store.writeTable('588000', table, { table })
    }
    store.ensureSymbolDir('000001')

    // 沙箱顶层只有注入的 data（fake-home 未被创建/写入）。
    expect(readdirSync(sandbox).sort()).toEqual(['data'])
    expect(existsSync(fakeHome)).toBe(false)

    // 所有产物都在注入 dataRoot 之内；dataRoot 自身权限未被本任务改动（仅 ledger 子层）。
    expect(existsSync(join(dataRoot, 'ledger'))).toBe(true)
    expect(modeOf(dataRoot)).toBe(dataRootModeBefore)
  })

  it('DSH_IA_HOME 被指到 tmp 时，模块路径解析跟随 env，但 JsonStore 不消费它', () => {
    // 仅证明隔离语义：env 指向临时 home，JsonStore 的写入不落在该 home 下。
    process.env.DSH_IA_HOME = fakeHome
    store.writeTable('588000', 'symbols', { symbol: '588000', type: 'etf', initPrice: 1 })

    expect(existsSync(join(fakeHome, 'data'))).toBe(false)
    expect(existsSync(join(fakeHome, 'data', 'ledger'))).toBe(false)
  })

  it('HOME 环境变量未被测试改动', () => {
    expect(process.env.HOME).toBe(originalUserHome)
  })
})

// ---------------------------------------------------------------------------
// AC10：符号安全（path-guard 未被削弱）
// ---------------------------------------------------------------------------

describe('[AC10] 非法 symbol 仍被 path-guard 拒绝', () => {
  const badSymbols = ['../evil', 'a/b', '..', '.', '', 'a\\b', 'x y', 'a'.repeat(65)]

  it.each(badSymbols)('writeTable/ensureSymbolDir/symbolDir 对 %j 抛 path-guard', (bad) => {
    expect(() => store.writeTable(bad, 'symbols', {})).toThrow(/\[path-guard\]/)
    expect(() => store.ensureSymbolDir(bad)).toThrow(/\[path-guard\]/)
    expect(() => store.symbolDir(bad)).toThrow(/\[path-guard\]/)
    expect(() => store.tablePath(bad, 'symbols')).toThrow(/\[path-guard\]/)
    expect(() => store.readTable(bad, 'symbols')).toThrow(/\[path-guard\]/)
  })

  it("'../evil' 被拒后：不创建 ledger 根、不产生越界文件", () => {
    expect(() => store.writeTable('../evil', 'symbols', { x: 1 })).toThrow(/\[path-guard\]/)

    expect(existsSync(join(dataRoot, 'ledger'))).toBe(false)
    expect(existsSync(join(sandbox, 'evil'))).toBe(false)
    expect(existsSync(join(dataRoot, 'evil'))).toBe(false)
    // 沙箱顶层仍只有注入的 data/。
    expect(readdirSync(sandbox).sort()).toEqual(['data'])
  })

  it("'a/b' 被拒：不创建嵌套目录", () => {
    expect(() => store.writeTable('a/b', 'symbols', { x: 1 })).toThrow(/\[path-guard\]/)
    expect(existsSync(join(dataRoot, 'ledger'))).toBe(false)
  })

  it('合法边界符号仍可用（588000 / 000001.SZ / a_b-c.d）', () => {
    for (const ok of ['588000', '000001.SZ', 'a_b-c.d']) {
      expect(store.ensureSymbolDir(ok)).toBe(join(dataRoot, 'ledger', ok))
      expect(modeOf(join(dataRoot, 'ledger', ok))).toBe(0o700)
    }
  })
})
