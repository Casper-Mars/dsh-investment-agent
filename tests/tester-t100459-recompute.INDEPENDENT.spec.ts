/**
 * 独立验证 spec —— t100459「新旧口径兼容处理与回归」（cum_return 缓存重算脚本）。
 *
 * 本文件由 Tester 独立编写，**不复用** Developer 的 `tests/recompute-cum-return.test.ts`
 * 的断言与 seed 辅助函数。独立性体现在：
 *   1. fixture 全部**手写 raw JSON**（symbols/positions/accounts/trades/metrics.json），
 *      不经 `Ledger` 类、不经脚本导出的 helper，期望值由 Tester 独立手算（见文件内注释）；
 *   2. 行为核验走**真实 CLI 进程**（`node scripts/recompute-cum-return.mjs`，`spawnSync`），
 *      验的是端到端可运行性（参数解析 / 退出码 / stdout / 落盘副作用），而非仅导入纯函数；
 *   3. 幂等以**文件 sha256 + 字节比对**佐证；回滚以**原字节还原**佐证；
 *   4. AC5 漂移防护：脚本产物 vs 真实 `domain.Ledger.cumReturnState` +
 *      `cumReturnOnCapital`（domain 为唯一事实来源）。
 *
 * 被测改动（基线 b180188，工作区未 commit）：
 *   scripts/recompute-cum-return.mjs（新增）、tests/recompute-cum-return.test.ts（新增）、
 *   CHANGELOG.md、package.json（新增 npm script recompute:cum-return）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { spawnSync } from 'node:child_process'
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  readFileSync,
  writeFileSync,
  existsSync,
} from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { Ledger } from '../src/domain/ledger.js'
import { cumReturnOnCapital } from '../src/domain/metrics.js'

// ── 路径与工具 ──────────────────────────────────────────────────────────────
const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..')
const CLI = join(REPO, 'scripts', 'recompute-cum-return.mjs')

interface CliResult {
  code: number | null
  stdout: string
  stderr: string
}

/** 以真实子进程运行 CLI。 */
function runCli(args: string[], env?: Record<string, string>): CliResult {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...(env ?? {}) },
  })
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
}

function sha256File(p: string): string {
  return createHash('sha256').update(readFileSync(p)).digest('hex')
}

function readJson(p: string): any {
  return JSON.parse(readFileSync(p, 'utf8'))
}

let root: string
const roots: string[] = []

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 't100459-ind-'))
  roots.push(root)
})

afterEach(() => {
  for (const d of roots.splice(0)) rmSync(d, { recursive: true, force: true })
})

// ── 手写 raw fixture（独立于任何仓库代码） ──────────────────────────────────
interface RawTrade {
  id: string
  symbol: string
  side: 'buy' | 'sell'
  qty: number
  price: number
  ts: number
  reason?: string
}

interface RawSeed {
  symbol: string
  type?: string
  initPrice: number
  qty: number
  avgCost: number
  cash: number
  realizedPnl: number
  trades: RawTrade[]
  /** 旧口径 metrics 快照；null 表示不写 metrics.json。 */
  metrics: Record<string, unknown> | null
}

function writeSymbolDir(base: string, seed: RawSeed): string {
  const dir = join(base, 'ledger', seed.symbol)
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'symbols.json'),
    JSON.stringify(
      { symbol: seed.symbol, name: seed.symbol, type: seed.type ?? 'stock', initPrice: seed.initPrice },
      null,
      2,
    ),
    'utf8',
  )
  writeFileSync(
    join(dir, 'positions.json'),
    JSON.stringify({ symbol: seed.symbol, qty: seed.qty, avgCost: seed.avgCost }, null, 2),
    'utf8',
  )
  writeFileSync(
    join(dir, 'accounts.json'),
    JSON.stringify(
      { symbol: seed.symbol, cash: seed.cash, realizedPnl: seed.realizedPnl, floatPnl: 0 },
      null,
      2,
    ),
    'utf8',
  )
  writeFileSync(join(dir, 'trades.json'), JSON.stringify(seed.trades, null, 2), 'utf8')
  if (seed.metrics) {
    writeFileSync(join(dir, 'metrics.json'), JSON.stringify(seed.metrics, null, 2), 'utf8')
  }
  return dir
}

function metricsPath(base: string, symbol: string): string {
  return join(base, 'ledger', symbol, 'metrics.json')
}

/**
 * Issue #3 台账（已清仓）——Tester 独立手算过程：
 *   init 200@55.57 cash=50000（init 流水为账面建仓，非现金流出）
 *   sell 100@53.05 → realized=(53.05-55.57)*100=-252; qty=100; cash=55305
 *   buy  100@53.08 → avg=(100*55.57+100*53.08)/200=54.325; qty=200; cash=49997
 *   sell 200@49.76 → realized+=（49.76-54.325)*200=-913 → 累计 -1165; qty=0; cash=59949
 *   期初资金 = 初始cash 50000 + 初始持仓成本 11114 = 61114
 *   旧口径 = (期末市值 0 + 累计realized -1165 − 61114)/61114 = -1.0191
 *   新口径 = (期末现金 59949 + 期末市值 0 − 61114)/61114     = -0.0191
 */
function seedIssue3(base: string): void {
  const s = '002156'
  const trades: RawTrade[] = [
    { id: 't_1', symbol: s, side: 'buy', qty: 200, price: 55.57, ts: 1000, reason: 'init' },
    { id: 't_2', symbol: s, side: 'sell', qty: 100, price: 53.05, ts: 2000 },
    { id: 't_3', symbol: s, side: 'buy', qty: 100, price: 53.08, ts: 3000 },
    { id: 't_4', symbol: s, side: 'sell', qty: 200, price: 49.76, ts: 4000 },
  ]
  writeSymbolDir(base, {
    symbol: s,
    type: 'stock',
    initPrice: 55.57,
    qty: 0,
    avgCost: 54.325,
    cash: 59949,
    realizedPnl: -1165,
    trades,
    metrics: {
      symbol: s,
      date: '2026-10-10',
      dirHitRate: 0.5,
      rangeHitRate: 0.5,
      cumReturn: -1.0191, // 旧口径落库值
      history: [],
    },
  })
}

// ── AC1 重算能力可用 ────────────────────────────────────────────────────────
describe('AC1 脚本可运行：dry-run / --write / --rollback（真实 CLI 进程）', () => {
  it('默认 dry-run：stdout 报 before=-1.0191 after=-0.0191 changed=yes，且文件未被改、无 .bak', () => {
    seedIssue3(root)
    const mp = metricsPath(root, '002156')
    const beforeHash = sha256File(mp)

    const r = runCli(['--data-root', root])
    expect(r.code).toBe(0)
    expect(r.stdout).toContain('dry-run')
    expect(r.stdout).toContain('before=-1.0191')
    expect(r.stdout).toContain('after=-0.0191')
    expect(r.stdout).toContain('changed=yes')
    expect(r.stdout).toContain('未落盘')

    // 文件字节未变
    expect(sha256File(mp)).toBe(beforeHash)
    expect(readJson(mp).cumReturn).toBeCloseTo(-1.0191, 4)
    expect(existsSync(mp + '.bak')).toBe(false)
  })

  it('--write：metrics.json 变 -0.0191，且生成 .bak（内容=旧值 -1.0191）', () => {
    seedIssue3(root)
    const mp = metricsPath(root, '002156')
    const originalBytes = readFileSync(mp)

    const r = runCli(['--data-root', root, '--write'])
    expect(r.code).toBe(0)
    expect(r.stdout).toContain('after=-0.0191')
    expect(r.stdout).toContain('written=yes')

    expect(readJson(mp).cumReturn).toBeCloseTo(-0.0191, 4)
    const bak = mp + '.bak'
    expect(existsSync(bak)).toBe(true)
    // .bak 必须与迁移前文件逐字节一致
    expect(readFileSync(bak).equals(originalBytes)).toBe(true)
    expect(readJson(bak).cumReturn).toBeCloseTo(-1.0191, 4)
    // 其它字段（date / dirHitRate …）保留
    expect(readJson(mp).date).toBe('2026-10-10')
    expect(readJson(mp).dirHitRate).toBeCloseTo(0.5, 4)
  })

  it('--rollback：从 .bak 还原为旧值 -1.0191（逐字节回到迁移前）', () => {
    seedIssue3(root)
    const mp = metricsPath(root, '002156')
    const originalBytes = readFileSync(mp)

    expect(runCli(['--data-root', root, '--write']).code).toBe(0)
    expect(readJson(mp).cumReturn).toBeCloseTo(-0.0191, 4)

    const rb = runCli(['--data-root', root, '--rollback'])
    expect(rb.code).toBe(0)
    expect(rb.stdout).toContain('已回滚')
    expect(readJson(mp).cumReturn).toBeCloseTo(-1.0191, 4)
    expect(readFileSync(mp).equals(originalBytes)).toBe(true)
  })

  it('--write 与 --rollback 互斥：非零退出并报错', () => {
    seedIssue3(root)
    const r = runCli(['--data-root', root, '--write', '--rollback'])
    expect(r.code).toBe(1)
    expect(r.stderr).toContain('互斥')
  })

  it('dataRoot 解析：环境变量 DSH_IA_DATA_DIR 生效；--data-root 优先级高于环境变量', () => {
    seedIssue3(root)
    // 仅环境变量
    const viaEnv = runCli([], { DSH_IA_DATA_DIR: root })
    expect(viaEnv.code).toBe(0)
    expect(viaEnv.stdout).toContain('after=-0.0191')

    // --data-root 指向真目录，环境变量指向诱饵空目录 → 应以 --data-root 为准
    const decoy = mkdtempSync(join(tmpdir(), 't100459-decoy-'))
    roots.push(decoy)
    const viaFlag = runCli(['--data-root', root], { DSH_IA_DATA_DIR: decoy })
    expect(viaFlag.stdout).toContain('after=-0.0191')
  })

  it('无 ledger 目录：优雅提示、退出码 0（不抛）', () => {
    const empty = mkdtempSync(join(tmpdir(), 't100459-empty-'))
    roots.push(empty)
    const r = runCli(['--data-root', empty])
    expect(r.code).toBe(0)
    expect(r.stdout).toContain('未找到台账目录')
  })

  it('--price 显式现价生效（持仓未清，含期末市值项）', () => {
    // Tester 手算：init 1000@2.0 cash=1000；buy 1000@2.5 → qty=2000 avg=2.25 cash=-1500
    //   期初资金 = 初始cash 1000 + 初始成本 2000 = 3000
    //   --price 3.0 → (期末现金 -1500 + 市值 2000*3.0 − 3000)/3000 = 1500/3000 = 0.5
    const s = '588000'
    writeSymbolDir(root, {
      symbol: s,
      type: 'etf',
      initPrice: 2.0,
      qty: 2000,
      avgCost: 2.25,
      cash: -1500,
      realizedPnl: 0,
      trades: [
        { id: 't_1', symbol: s, side: 'buy', qty: 1000, price: 2.0, ts: 1000, reason: 'init' },
        { id: 't_2', symbol: s, side: 'buy', qty: 1000, price: 2.5, ts: 2000 },
      ],
      metrics: { symbol: s, date: '2026-10-10', dirHitRate: 0, rangeHitRate: 0, cumReturn: 0, history: [] },
    })
    const r = runCli(['--data-root', root, '--price', '3.0'])
    expect(r.code).toBe(0)
    expect(r.stdout).toContain('after=0.5')

    // 缺省（不传 --price）用最近一笔成交价 2.5 代理：
    //   (期末现金 -1500 + 2000*2.5 − 3000)/3000 = 500/3000 = 0.1667
    const r2 = runCli(['--data-root', root])
    expect(r2.stdout).toContain('after=0.1667')
  })

  it('无 metrics.json 的标的被跳过（不报错，仍有其它标的处理）', () => {
    seedIssue3(root)
    writeSymbolDir(root, {
      symbol: '000001',
      type: 'stock',
      initPrice: 10,
      qty: 100,
      avgCost: 10,
      cash: 900,
      realizedPnl: 0,
      trades: [{ id: 'x', symbol: '000001', side: 'buy', qty: 100, price: 10, ts: 1, reason: 'init' }],
      metrics: null,
    })
    const r = runCli(['--data-root', root])
    expect(r.code).toBe(0)
    expect(r.stdout).toContain('[000001] 跳过：无 metrics.json')
    expect(r.stdout).toContain('[002156] before=-1.0191 after=-0.0191')
  })
})

// ── AC2 幂等 ────────────────────────────────────────────────────────────────
describe('AC2 幂等：连续 --write 两次结果一致、第二次不重写', () => {
  it('第二次 changed=no、written=no；metrics.json 字节级不变（sha256 一致）', () => {
    seedIssue3(root)
    const mp = metricsPath(root, '002156')

    const r1 = runCli(['--data-root', root, '--write'])
    expect(r1.stdout).toContain('written=yes')
    const hash1 = sha256File(mp)
    const bytes1 = readFileSync(mp)

    const r2 = runCli(['--data-root', root, '--write'])
    expect(r2.code).toBe(0)
    expect(r2.stdout).toContain('changed=no')
    expect(r2.stdout).toContain('written=no')
    const hash2 = sha256File(mp)

    expect(hash2).toBe(hash1)
    expect(readFileSync(mp).equals(bytes1)).toBe(true)
    expect(readJson(mp).cumReturn).toBeCloseTo(-0.0191, 4)
    // 第二次不应产生新备份（.bak 仍是最初快照）
    expect(readJson(mp + '.bak').cumReturn).toBeCloseTo(-1.0191, 4)
  })

  it('已是新口径的标的：--write 亦 changed=no（不写）', () => {
    seedIssue3(root)
    const mp = metricsPath(root, '002156')
    // 先 --write 一次把值改成新口径
    runCli(['--data-root', root, '--write'])
    const hash = sha256File(mp)
    const r = runCli(['--data-root', root, '--write'])
    expect(r.stdout).toContain('changed=no')
    expect(sha256File(mp)).toBe(hash)
  })
})

// ── AC3 留痕 ────────────────────────────────────────────────────────────────
describe('AC3 CHANGELOG 留痕：口径变更声明可检索', () => {
  it('含「不可比 / 以重算值为准」语义 + 重算命令', () => {
    const md = readFileSync(join(REPO, 'CHANGELOG.md'), 'utf8')
    expect(md).toMatch(/\[Unreleased\]/)
    expect(md).toContain('cum_return')
    // 历史值不可比
    expect(md).toMatch(/不可比/)
    // 以重算值为准
    expect(md).toMatch(/重算值/)
    // 重算命令 / 脚本名
    expect(md).toContain('scripts/recompute-cum-return.mjs')
    expect(md).toContain('--write')
    expect(md).toContain('--rollback')
    expect(md).toContain('metrics.json.bak')
  })

  it('package.json 暴露 npm script recompute:cum-return 且指向脚本', () => {
    const pkg = readJson(join(REPO, 'package.json'))
    expect(pkg.scripts['recompute:cum-return']).toBe('node scripts/recompute-cum-return.mjs')
  })
})

// ── AC5 防漂移：脚本产物 === domain 层口径 ─────────────────────────────────
describe('AC5 防漂移：脚本重算结果 === cumReturnOnCapital(ledger.cumReturnState())', () => {
  it('已清仓（Issue#3）：经真实 Ledger 建账 → CLI --write 产物 vs domain 计算', () => {
    // 用真实 domain.Ledger 建账（不手写 JSON），保证与运行期同一事实来源
    // 多日序列：用可推进时钟跨日，避免被 A 股 T+1 拦截（Issue #6）。
    let clock = Date.parse('2026-10-13T10:00:00+08:00')
    const DAY = 24 * 60 * 60 * 1000
    const l = new Ledger(root, () => clock)
    l.init('002156', { type: 'stock', name: 'Iss3', qty: 200, cost: 55.57, cash: 50000 })
    l.trade('002156', { side: 'sell', qty: 100, price: 53.05 })
    clock += DAY
    l.trade('002156', { side: 'buy', qty: 100, price: 53.08 })
    clock += DAY
    l.trade('002156', { side: 'sell', qty: 200, price: 49.76 })
    // 写一份旧口径 metrics 供脚本处理
    writeFileSync(
      metricsPath(root, '002156'),
      JSON.stringify({ symbol: '002156', date: '2026-10-10', dirHitRate: 0, rangeHitRate: 0, cumReturn: -1.0191, history: [] }, null, 2),
      'utf8',
    )

    const trades = l.getTrades('002156')
    const lastPrice = trades[trades.length - 1].price // 49.76，脚本缺省代理价
    const domainVal = cumReturnOnCapital(l.cumReturnState('002156', lastPrice)!)

    // CLI 缺省现价（最近一笔成交价代理）应与 domain 一致
    const r = runCli(['--data-root', root, '--write'])
    expect(r.code).toBe(0)
    const scriptVal = readJson(metricsPath(root, '002156')).cumReturn
    expect(scriptVal).toBe(domainVal)
    expect(scriptVal).toBeCloseTo(-0.0191, 4)
  })

  it('持仓未清：脚本 --price X 产物 vs domain（含期末市值项）', () => {
    const l = new Ledger(root)
    l.init('588000', { type: 'etf', qty: 1000, cost: 2.0, cash: 1000 })
    l.trade('588000', { side: 'buy', qty: 1000, price: 2.5 })
    writeFileSync(
      metricsPath(root, '588000'),
      JSON.stringify({ symbol: '588000', date: '2026-10-10', dirHitRate: 0, rangeHitRate: 0, cumReturn: 0, history: [] }, null, 2),
      'utf8',
    )

    const domainVal = cumReturnOnCapital(l.cumReturnState('588000', 3.0)!)
    const r = runCli(['--data-root', root, '--write', '--price', '3.0'])
    expect(r.code).toBe(0)
    const scriptVal = readJson(metricsPath(root, '588000')).cumReturn
    expect(scriptVal).toBe(domainVal)
    expect(scriptVal).toBeCloseTo(0.5, 4)
  })

  it('多标的混合（已清仓 + 持仓中）：逐标的与 domain 一致', () => {
    const l = new Ledger(root)
    // A：已清仓
    l.init('AAA111', { type: 'stock', qty: 100, cost: 10, cash: 1000 })
    l.trade('AAA111', { side: 'sell', qty: 100, price: 12 })
    // B：持仓中
    l.init('BBB222', { type: 'etf', qty: 100, cost: 5, cash: 500 })
    l.trade('BBB222', { side: 'buy', qty: 100, price: 6 })

    for (const s of ['AAA111', 'BBB222']) {
      writeFileSync(
        metricsPath(root, s),
        JSON.stringify({ symbol: s, date: '2026-10-10', dirHitRate: 0, rangeHitRate: 0, cumReturn: 999, history: [] }, null, 2),
        'utf8',
      )
    }

    const r = runCli(['--data-root', root, '--write'])
    expect(r.code).toBe(0)

    for (const s of ['AAA111', 'BBB222']) {
      const trades = l.getTrades(s)
      const lastPrice = trades[trades.length - 1].price
      const domainVal = cumReturnOnCapital(l.cumReturnState(s, lastPrice)!)
      expect(readJson(metricsPath(root, s)).cumReturn).toBe(domainVal)
    }
  })
})
