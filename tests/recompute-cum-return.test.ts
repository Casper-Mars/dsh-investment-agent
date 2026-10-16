/**
 * scripts/recompute-cum-return.mjs 单元测试（t100459）。
 *
 * 覆盖：
 *   1. 重算前后对比正确（旧口径落库值 -> 新口径重算值）
 *   2. 幂等：同一台账连续重算两次结果一致（第二次无变化、不重写）
 *   3. 备份 / 回滚：--write 生成 metrics.json.bak（内容为旧值），--rollback 可还原
 *   4. 漂移防护：脚本重算结果 === cumReturnOnCapital(ledger.cumReturnState(...))
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Ledger } from '../src/domain/ledger.js'
import { cumReturnOnCapital } from '../src/domain/metrics.js'
import {
  runRecompute,
  recomputeSymbol,
  computeInitialCapital,
  computeCumReturnFromState,
  listSymbols,
} from '../scripts/recompute-cum-return.mjs'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dsh-ia-recompute-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const silent = () => {}

/** 读 JSON（测试辅助）。 */
function readJson(path: string): any {
  return JSON.parse(readFileSync(path, 'utf8'))
}

/** metrics.json 路径。 */
function metricsPath(symbol: string): string {
  return join(dir, 'ledger', symbol, 'metrics.json')
}

/** 写一份「旧口径」metrics 快照。 */
function writeStaleMetrics(symbol: string, cumReturn: number): void {
  writeFileSync(
    metricsPath(symbol),
    JSON.stringify(
      {
        symbol,
        date: '2026-10-10',
        dirHitRate: 0.5,
        rangeHitRate: 0.5,
        cumReturn,
        history: [],
      },
      null,
      2,
    ),
    'utf8',
  )
}

/**
 * 重建 Issue #3 台账（已清仓账户，旧口径严重低估）：
 *   init 200@55.57（现金 50000）；sell 100@53.05；buy 100@53.08；sell 200@49.76
 *   期末 qty=0、期末现金 59949、期初资金 61114、累计 realized −1165。
 *   旧口径 = (0 + (−1165) − 61114)/61114 = −1.0191（−101.9%，严重低估）
 *   新口径 = (59949 + 0 − 61114)/61114 = −0.0191（−1.9%）
 */
function seedIssue3Ledger(): Ledger {
  const l = new Ledger(dir)
  l.init('002156', { type: 'stock', name: 'Iss3', qty: 200, cost: 55.57, cash: 50000 })
  l.trade('002156', { side: 'sell', qty: 100, price: 53.05 })
  l.trade('002156', { side: 'buy', qty: 100, price: 53.08 })
  l.trade('002156', { side: 'sell', qty: 200, price: 49.76 })
  return l
}

describe('recompute-cum-return：前后对比', () => {
  it('已清仓账户：旧口径 −1.0191 -> 新口径 −0.0191', () => {
    seedIssue3Ledger()
    writeStaleMetrics('002156', -1.0191)

    const results = runRecompute({ dataRoot: dir, log: silent }) // 默认 dry-run
    expect(results).toHaveLength(1)
    const r = results[0]
    expect(r.symbol).toBe('002156')
    expect(r.before).toBeCloseTo(-1.0191, 4)
    expect(r.after).toBeCloseTo(-0.0191, 4)
    expect(r.changed).toBe(true)
    expect(r.written).toBe(false)

    // dry-run 不落盘：文件仍是旧值
    expect(readJson(metricsPath('002156')).cumReturn).toBeCloseTo(-1.0191, 4)
    expect(existsSync(metricsPath('002156') + '.bak')).toBe(false)
  })

  it('未变更的标的：changed=false（已是新口径）', () => {
    seedIssue3Ledger()
    writeStaleMetrics('002156', -0.0191) // 已是新口径
    const results = runRecompute({ dataRoot: dir, log: silent })
    expect(results[0].changed).toBe(false)
  })

  it('无 metrics.json 的标的被跳过', () => {
    const l = new Ledger(dir)
    l.init('588000', { type: 'etf', qty: 1000, cost: 2.0, cash: 1000 })
    const results = runRecompute({ dataRoot: dir, log: silent })
    expect(results).toHaveLength(1)
    expect(results[0].skipped).toBe(true)
    expect(results[0].reason).toBe('no metrics.json')
  })
})

describe('recompute-cum-return：幂等', () => {
  it('连续两次 --write 结果一致，第二次无变化', () => {
    seedIssue3Ledger()
    writeStaleMetrics('002156', -1.0191)

    const first = runRecompute({ dataRoot: dir, write: true, log: silent })
    expect(first[0].written).toBe(true)
    const afterFirst = readFileSync(metricsPath('002156'), 'utf8')

    const second = runRecompute({ dataRoot: dir, write: true, log: silent })
    expect(second[0].changed).toBe(false)
    expect(second[0].written).toBe(false)
    const afterSecond = readFileSync(metricsPath('002156'), 'utf8')

    // 第二次不重写：字节级一致
    expect(afterSecond).toBe(afterFirst)
    expect(readJson(metricsPath('002156')).cumReturn).toBeCloseTo(-0.0191, 4)
  })
})

describe('recompute-cum-return：备份 / 回滚', () => {
  it('--write 生成 .bak 且内容为旧值；--rollback 可还原', () => {
    seedIssue3Ledger()
    writeStaleMetrics('002156', -1.0191)

    const results = runRecompute({ dataRoot: dir, write: true, log: silent })
    expect(results[0].written).toBe(true)
    expect(results[0].backedUp).toBe(true)

    const bak = metricsPath('002156') + '.bak'
    expect(existsSync(bak)).toBe(true)
    // .bak 内容为迁移前的旧值
    expect(readJson(bak).cumReturn).toBeCloseTo(-1.0191, 4)
    // metrics.json 已更新为新值
    expect(readJson(metricsPath('002156')).cumReturn).toBeCloseTo(-0.0191, 4)

    // 回滚
    const rb = runRecompute({ dataRoot: dir, rollback: true, log: silent })
    expect(rb[0].rolledBack).toBe(true)
    expect(readJson(metricsPath('002156')).cumReturn).toBeCloseTo(-1.0191, 4)
  })

  it('幂等备份：已存在 .bak 时不覆盖（保留最原始的迁移前快照）', () => {
    seedIssue3Ledger()
    writeStaleMetrics('002156', -1.0191)
    const bak = metricsPath('002156') + '.bak'
    writeFileSync(bak, JSON.stringify({ marker: 'pristine' }), 'utf8')

    const results = runRecompute({ dataRoot: dir, write: true, log: silent })
    expect(results[0].written).toBe(true)
    expect(results[0].backedUp).toBe(false) // 未新建备份
    expect(readJson(bak).marker).toBe('pristine') // 原始备份未被覆盖
  })

  it('无 .bak 时回滚被跳过', () => {
    seedIssue3Ledger()
    writeStaleMetrics('002156', -1.0191)
    const rb = runRecompute({ dataRoot: dir, rollback: true, log: silent })
    expect(rb[0].skipped).toBe(true)
    expect(rb[0].reason).toBe('no backup')
  })
})

describe('recompute-cum-return：漂移防护（与 domain 实现一致）', () => {
  it('脚本重算 === cumReturnOnCapital(ledger.cumReturnState(...))：已清仓', () => {
    const ledger = seedIssue3Ledger()
    const trades = ledger.getTrades('002156')
    const lastPrice = trades[trades.length - 1].price // 49.76

    const state = ledger.cumReturnState('002156', lastPrice)!
    const domainVal = cumReturnOnCapital(state)

    const tables = {
      positions: readJson(join(dir, 'ledger', '002156', 'positions.json')),
      accounts: readJson(join(dir, 'ledger', '002156', 'accounts.json')),
      trades,
    }
    const { cumReturn } = recomputeSymbol(tables, lastPrice)
    expect(cumReturn).toBe(domainVal)

    // 缺省现价（用最近一笔成交价代理）亦等价
    const { cumReturn: fallback } = recomputeSymbol(tables, undefined)
    expect(fallback).toBe(domainVal)
  })

  it('脚本重算 === domain：持仓未清（含期末市值项）', () => {
    const ledger = new Ledger(dir)
    ledger.init('588000', { type: 'etf', qty: 1000, cost: 2.0, cash: 1000 })
    ledger.trade('588000', { side: 'buy', qty: 1000, price: 2.5 })

    const state = ledger.cumReturnState('588000', 3.0)!
    const domainVal = cumReturnOnCapital(state)

    const trades = ledger.getTrades('588000')
    const tables = {
      positions: readJson(join(dir, 'ledger', '588000', 'positions.json')),
      accounts: readJson(join(dir, 'ledger', '588000', 'accounts.json')),
      trades,
    }
    const { cumReturn } = recomputeSymbol(tables, 3.0)
    expect(cumReturn).toBe(domainVal)
    // (期末现金 −1500 + 期末市值 2000×3.0 − 期初资金 3000)/3000 = 0.5
    expect(cumReturn).toBeCloseTo(0.5, 4)

    // 反推的期初资金与 domain 一致
    const { initialCapital } = computeInitialCapital(state.finalCash, trades)
    expect(initialCapital).toBe(state.initialCapital)
  })

  it('期初资金为 0 防除零（与 domain 同返回 0）', () => {
    const state = { finalQty: 0, finalPrice: 0, finalCash: 0, initialCapital: 0 }
    expect(computeCumReturnFromState(state)).toBe(cumReturnOnCapital(state))
    expect(computeCumReturnFromState(state)).toBe(0)
  })
})

describe('recompute-cum-return：列表与参数', () => {
  it('listSymbols 仅返回含 symbols.json 的目录', () => {
    const l = new Ledger(dir)
    l.init('588000', { type: 'etf', qty: 1000, cost: 2.0, cash: 1000 })
    l.init('000001', { type: 'stock', qty: 100, cost: 10, cash: 1000 })
    const syms = listSymbols(dir).sort()
    expect(syms).toEqual(['000001', '588000'])
  })
})
