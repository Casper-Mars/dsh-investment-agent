/**
 * 台账目录权限加固（0o700）与「运行时数据原地不动」回归测试。
 *
 * 覆盖任务-05 验收点：
 *   1. `ledger/` 与各 `<symbol>/` 目录权限严格为 `0o700`
 *   2. 已存在但权限过宽（如 0o755）时被收紧回 `0o700`
 *   3. `writeTable()` 自动建目录时同样收紧权限
 *   4. 台账路径与读写结构不变（不随资产层迁移到 `assets/`）
 *
 * 全部使用 `mkdtempSync` 临时 dataRoot，绝不触碰真实 `~/.dsh-ia`。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { chmodSync, existsSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { JsonStore, LedgerStore } from '../src/domain/store.js'
import type { PositionRecord, SymbolRecord } from '../src/domain/store.js'

let dataRoot: string
let store: JsonStore
let ledger: LedgerStore

beforeEach(() => {
  dataRoot = mkdtempSync(join(tmpdir(), 'dsh-ia-ledger-perm-'))
  store = new JsonStore(dataRoot)
  ledger = new LedgerStore(store)
})

afterEach(() => {
  rmSync(dataRoot, { recursive: true, force: true })
})

/** 取文件/目录的权限位（去掉文件类型位）。 */
function modeOf(path: string): number {
  return statSync(path).mode & 0o777
}

describe('台账目录权限加固（0o700）', () => {
  it('ensureSymbolDir 后 symbol 目录与 ledger 父目录权限均为 0o700', () => {
    const dir = store.ensureSymbolDir('588000')

    expect(modeOf(dir)).toBe(0o700)
    expect(modeOf(join(dataRoot, 'ledger'))).toBe(0o700)
  })

  it('writeTable 在目录不存在时自动创建，且权限为 0o700', () => {
    const rec: SymbolRecord = {
      symbol: '588000',
      name: '科创50ETF',
      type: 'etf',
      initPrice: 1.95,
    }
    store.writeTable('588000', 'symbols', rec)

    const symbolDir = join(dataRoot, 'ledger', '588000')
    expect(existsSync(join(symbolDir, 'symbols.json'))).toBe(true)
    expect(modeOf(symbolDir)).toBe(0o700)
    expect(modeOf(join(dataRoot, 'ledger'))).toBe(0o700)
  })

  it('已存在但权限过宽（0o755）时，ensureSymbolDir 收紧回 0o700', () => {
    const dir = store.ensureSymbolDir('588000')
    chmodSync(dir, 0o755)
    expect(modeOf(dir)).toBe(0o755)

    store.ensureSymbolDir('588000')
    expect(modeOf(dir)).toBe(0o700)
  })

  it('写入路径也收紧已存在的宽权限目录（writeTable → ensureSymbolDir）', () => {
    const dir = store.ensureSymbolDir('588000')
    chmodSync(dir, 0o750)
    expect(modeOf(dir)).toBe(0o750)

    store.writeTable<PositionRecord>('588000', 'positions', {
      symbol: '588000',
      qty: 1000,
      avgCost: 1.9523,
    })
    expect(modeOf(dir)).toBe(0o700)
  })

  it('路径不变：tablePath 仍为 <dataRoot>/ledger/<symbol>/<table>.json', () => {
    expect(store.tablePath('588000', 'positions')).toBe(
      join(dataRoot, 'ledger', '588000', 'positions.json'),
    )
  })

  it('台账不随资产迁移：路径不含 /assets/', () => {
    const dir = store.ensureSymbolDir('588000')
    expect(store.tablePath('588000', 'positions')).not.toContain('/assets/')
    expect(dir).not.toContain('/assets/')
  })

  it('读写往返结构不变：savePosition → getPosition', () => {
    const rec: PositionRecord = { symbol: '588000', qty: 1000, avgCost: 1.9523 }
    ledger.savePosition(rec)

    expect(ledger.getPosition('588000')).toEqual(rec)
  })
})
