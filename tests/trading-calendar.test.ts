/**
 * trading-calendar.ts —— 交易时段硬闸门（第 1 层）独立验收测试。
 *
 * 覆盖验收标准（逐条）：
 *   AC1. 新增 `isTradingTime(date)`：A 股连续竞价时段
 *        9:30–11:30、13:00–15:00（含下边界、不含上边界）返回 true；
 *        其余（盘前/集合竞价/午休/收盘后）返回 false。
 *   AC2. `ledger_trade` 非连续竞价时段拒绝下单，不写流水、不重算持仓。
 *
 * 关键设计：闸门用 `new Date()` 实时判定，成功/拒绝分支依赖「运行时刻」，
 * 直接断言在非交易时段会偶发失败。本测试用 vitest 的 fake timers
 * （`vi.useFakeTimers()` + `vi.setSystemTime()`）把「当前时间」精确钉死，
 * 彻底消除真实系统时间漂移，使「拒绝分支」与「放行分支」均可稳定复现。
 *
 * 测试范围：
 *   - 纯函数 `isTradingTime(date)`：单测所有边界刻度（含/不含下/上边界 + 拒绝点）。
 *   - 工具层 `ledger_trade` 运行时行为：拒绝分支（抛错 + 不调用 ctx.ledger.trade +
 *     不写流水）、放行分支（正常成交）。
 *
 * 注意：本文件只测行为，不修改生产代码。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isTradingTime } from '../src/domain/trading-calendar.js'
import { Ledger } from '../src/domain/ledger.js'
import { createLedgerTradeTool } from '../src/tools/ledgers.js'
import type { ToolContext } from '../src/tools/context.js'

/**
 * 构造一个「真实文件落地」的 ctx，但 ledger 换成可 spy 的包装：
 * 我们直接实例化真实 Ledger（真实读写磁盘），再对 ctx.ledger.trade 做 spy，
 * 既能断言「trade 未被调用」，又能用真实 query/getTrades 断言「不写流水」。
 */
function makeCtx(dir: string): {
  ctx: ToolContext
  ledger: Ledger
} {
  const ledger = new Ledger(dir)
  const ctx = {
    dataRoot: dir,
    ledger,
    predicts: {} as ToolContext['predicts'],
    reviews: {} as ToolContext['reviews'],
    strategy: {} as ToolContext['strategy'],
    getThresholds: () => ({} as ReturnType<ToolContext['getThresholds']>),
  } as unknown as ToolContext
  return { ctx, ledger }
}

/** 用「本地时区」的整分刻度构造某个时刻的 Date。 */
function at(h: number, m: number, s = 0): Date {
  const d = new Date(2026, 0, 15, h, m, s, 0)
  return d
}

/** 断言未调用 ctx.ledger.trade 时，直接对 ledger.trade 打 spy。 */
function spyTrade(ledger: Ledger): ReturnType<typeof vi.spyOn> {
  return vi.spyOn(ledger, 'trade')
}

describe('AC1：isTradingTime —— 连续竞价时段判定', () => {
  describe('上午连续竞价 9:30–11:30', () => {
    it('9:30:00（下边界，含）→ true', () => {
      expect(isTradingTime(at(9, 30, 0))).toBe(true)
    })
    it('9:30:59 → true', () => {
      expect(isTradingTime(at(9, 30, 59))).toBe(true)
    })
    it('10:00:00（时段内）→ true', () => {
      expect(isTradingTime(at(10, 0, 0))).toBe(true)
    })
    it('11:29:59 → true', () => {
      expect(isTradingTime(at(11, 29, 59))).toBe(true)
    })
    it('11:30:00（上边界，不含）→ false', () => {
      expect(isTradingTime(at(11, 30, 0))).toBe(false)
    })
  })

  describe('下午连续竞价 13:00–15:00', () => {
    it('13:00:00（下边界，含）→ true', () => {
      expect(isTradingTime(at(13, 0, 0))).toBe(true)
    })
    it('13:00:59 → true', () => {
      expect(isTradingTime(at(13, 0, 59))).toBe(true)
    })
    it('14:30:00（时段内）→ true', () => {
      expect(isTradingTime(at(14, 30, 0))).toBe(true)
    })
    it('14:59:59 → true', () => {
      expect(isTradingTime(at(14, 59, 59))).toBe(true)
    })
    it('15:00:00（上边界，不含）→ false', () => {
      expect(isTradingTime(at(15, 0, 0))).toBe(false)
    })
  })

  describe('拒绝点：盘前 / 集合竞价 / 午休 / 收盘后', () => {
    it('9:00:00（盘前）→ false', () => {
      expect(isTradingTime(at(9, 0, 0))).toBe(false)
    })
    it('9:15:00（集合竞价）→ false', () => {
      expect(isTradingTime(at(9, 15, 0))).toBe(false)
    })
    it('9:25:00（集合竞价结束）→ false', () => {
      expect(isTradingTime(at(9, 25, 0))).toBe(false)
    })
    it('9:29:59（盘前最后 1 秒）→ false', () => {
      expect(isTradingTime(at(9, 29, 59))).toBe(false)
    })
    it('12:00:00（午休）→ false', () => {
      expect(isTradingTime(at(12, 0, 0))).toBe(false)
    })
    it('11:59:59（午休）→ false', () => {
      expect(isTradingTime(at(11, 59, 59))).toBe(false)
    })
    it('15:00:30（收盘后）→ false', () => {
      expect(isTradingTime(at(15, 0, 30))).toBe(false)
    })
    it('16:00:00（收盘后）→ false', () => {
      expect(isTradingTime(at(16, 0, 0))).toBe(false)
    })
  })
})

describe('AC2：ledger_trade 时段闸门', () => {
  let dir: string
  let ctx: ToolContext
  let ledger: Ledger
  let tool: ReturnType<typeof createLedgerTradeTool>

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'dsh-ia-tradingcal-'))
    const m = makeCtx(dir)
    ctx = m.ctx
    ledger = m.ledger
    tool = createLedgerTradeTool(ctx)
    // 预置一个标的，供 trade 使用。
    ledger.init('588000', { type: 'etf', qty: 1000, cost: 2.0, cash: 100000 })
    // 记录初始流水数量（含 init 建仓 1 条）。
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    rmSync(dir, { recursive: true, force: true })
  })

  function makeExec(): { signal: AbortSignal } {
    return { signal: new AbortController().signal }
  }

  it('非连续竞价时段（12:00 午休）→ 抛错，且不调用 ctx.ledger.trade', async () => {
    vi.setSystemTime(at(12, 0, 0))
    const spy = spyTrade(ledger)

    await expect(
      tool.execute(
        { symbol: '588000', side: 'buy', qty: 100, price: 2.2 },
        makeExec(),
      ),
    ).rejects.toThrow(/非连续竞价时段/)

    // 核心断言：闸门命中 → 绝不调用 trade。
    expect(spy).not.toHaveBeenCalled()
  })

  it('非连续竞价时段（9:25 集合竞价）→ 抛错，且不写流水', async () => {
    vi.setSystemTime(at(9, 25, 0))
    const spy = spyTrade(ledger)
    const tradesBefore = ledger.getTrades('588000').length
    const posBefore = ledger.query('588000')

    await expect(
      tool.execute(
        { symbol: '588000', side: 'buy', qty: 100, price: 2.2 },
        makeExec(),
      ),
    ).rejects.toThrow(/非连续竞价时段/)

    expect(spy).not.toHaveBeenCalled()
    // 流水数量不变（未 appendTrade）。
    expect(ledger.getTrades('588000').length).toBe(tradesBefore)
    // 持仓快照不变（未重算成本 / qty）。
    const posAfter = ledger.query('588000')
    expect(posAfter.qty).toBe(posBefore.qty)
    expect(posAfter.avgCost).toBe(posBefore.avgCost)
    expect(posAfter.cash).toBe(posBefore.cash)
  })

  it('非连续竞价时段（15:30 收盘后）→ 抛错，trades.json 文件内容不变', async () => {
    vi.setSystemTime(at(15, 30, 0))
    const spy = spyTrade(ledger)
    const tradesPath = join(dir, 'ledger', '588000', 'trades.json')
    const contentBefore = readFileSync(tradesPath, 'utf8')

    await expect(
      tool.execute(
        { symbol: '588000', side: 'buy', qty: 100, price: 2.2 },
        makeExec(),
      ),
    ).rejects.toThrow(/非连续竞价时段/)

    expect(spy).not.toHaveBeenCalled()
    // 文件字节级不变（无任何流水落入磁盘）。
    expect(readFileSync(tradesPath, 'utf8')).toBe(contentBefore)
  })

  it('连续竞价时段（10:00 上午）→ 正常成交、写流水', async () => {
    vi.setSystemTime(at(10, 0, 0))
    const spy = spyTrade(ledger)

    const value = await tool.execute(
      { symbol: '588000', side: 'buy', qty: 100, price: 2.2 },
      makeExec(),
    )

    // 闸门放行 → 调用了 trade（真实写入）。
    expect(spy).toHaveBeenCalledTimes(1)
    expect(value).toMatchObject({ ok: true })
    expect(value.new_qty).toBe(1100)
  })

  it('连续竞价时段（14:30 下午）→ 正常成交', async () => {
    vi.setSystemTime(at(14, 30, 0))
    const value = await tool.execute(
      { symbol: '588000', side: 'sell', qty: 200, price: 2.5 },
      makeExec(),
    )
    expect(value).toMatchObject({ ok: true })
    expect(value.new_qty).toBe(800)
    expect(ledger.query('588000').qty).toBe(800)
  })

  it('连续竞价时段（9:30:00 下边界）→ 正常成交', async () => {
    vi.setSystemTime(at(9, 30, 0))
    const value = await tool.execute(
      { symbol: '588000', side: 'buy', qty: 100, price: 2.0 },
      makeExec(),
    )
    expect(value).toMatchObject({ ok: true })
  })

  it('连续竞价时段（15:00:00 上边界，不含）→ 抛错', async () => {
    vi.setSystemTime(at(15, 0, 0))
    const spy = spyTrade(ledger)
    await expect(
      tool.execute(
        { symbol: '588000', side: 'buy', qty: 100, price: 2.0 },
        makeExec(),
      ),
    ).rejects.toThrow(/非连续竞价时段/)
    expect(spy).not.toHaveBeenCalled()
  })

  it('连续竞价时段（11:30:00 上边界，不含）→ 抛错', async () => {
    vi.setSystemTime(at(11, 30, 0))
    const spy = spyTrade(ledger)
    await expect(
      tool.execute(
        { symbol: '588000', side: 'buy', qty: 100, price: 2.0 },
        makeExec(),
      ),
    ).rejects.toThrow(/非连续竞价时段/)
    expect(spy).not.toHaveBeenCalled()
  })
})