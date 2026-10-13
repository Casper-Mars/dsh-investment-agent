/**
 * 独立测试 —— t100364 / §9.7 v1.6「开场 notice」修复（Task-15 AC1 补丁）。
 *
 * 被测交付物：未提交改动中的 `src/opening-notice.ts`（纯函数）+
 * `src/session-ensure.ts`（`deliverOpeningNoticeSafely` 接线）。
 *
 * 本文件为 Tester 独立产出，**不改** `src/` 与既有测试；聚焦行为判读与
 * 降级/一次性语义，用注入 fake 验证，不依赖真实 harness 服务。
 *
 * 覆盖（对应验收标准 AC1 的单元面 + AC2 一次性 + AC3 降级）：
 *   ① isSessionBlank 判读优先级：投影软取 / open(read) 零事件 / open 有 turn/start /
 *     open 抛错 + stat.eventCount 兜底 / 全部失败 → undefined；
 *   ② deliverOpeningNotice：blank → 恰投一次 / 非 blank → 不投 / 二次 apply 自愈不重复；
 *   ③ 降级：agents.get 抛错 / agent 不可达 / followup 抛错 / open 抛错无兜底
 *     → 一律 skip、返回结果、绝不抛异常；
 *   ④ buildOpeningNoticeMessage 形态（结构等价 UserMessage：role/source.form=notice）。
 */
import { describe, expect, it, vi } from 'vitest'
import {
  buildOpeningNoticeMessage,
  deliverOpeningNotice,
  isSessionBlank,
  OPENING_NOTICE_TEXT,
  OPENING_NOTICE_SUMMARY,
  type OpeningNoticeDeps,
} from '../src/opening-notice.js'
import { PINNED_SESSION_ID } from '../src/session.js'

/** 造只读句柄：read 返回给定事件序列（判读 blank 用）。 */
function makeReadHandle(events: Array<{ type: string }>) {
  const closeSpy = vi.fn(async () => {})
  return {
    handle: { read: vi.fn(async () => ({ events })), close: closeSpy },
    closeSpy,
  }
}

describe('① isSessionBlank 判读优先级', () => {
  it('投影软取命中 blank=true → 直接返回 true，且不 open', async () => {
    const openSpy = vi.fn()
    const persistence = { open: openSpy, stat: vi.fn() }
    const projections = { stateOf: vi.fn(() => ({ blank: true })) }
    const r = await isSessionBlank(
      { sessionPersistence: persistence, sessionProjections: projections, pinnedId: PINNED_SESSION_ID },
      { id: PINNED_SESSION_ID },
    )
    expect(r).toBe(true)
    expect(openSpy).not.toHaveBeenCalled()
  })

  it('投影软取命中 blank=false → false', async () => {
    const projections = { stateOf: vi.fn(() => ({ blank: false })) }
    const persistence = { open: vi.fn(), stat: vi.fn() }
    const r = await isSessionBlank(
      { sessionPersistence: persistence, sessionProjections: projections, pinnedId: PINNED_SESSION_ID },
      {},
    )
    expect(r).toBe(false)
  })

  it('零事件（既存 blank 会话）→ open(read) 命中 → blank=true，且关闭句柄', async () => {
    const { handle, closeSpy } = makeReadHandle([])
    const openSpy = vi.fn(async () => handle)
    const r = await isSessionBlank({ sessionPersistence: { open: openSpy, stat: vi.fn() }, pinnedId: PINNED_SESSION_ID })
    expect(r).toBe(true)
    expect(openSpy).toHaveBeenCalledWith(PINNED_SESSION_ID, 'read')
    expect(closeSpy).toHaveBeenCalled()
  })

  it('含 turn/start → blank=false', async () => {
    const { handle } = makeReadHandle([{ type: 'turn/start' }])
    const r = await isSessionBlank({ sessionPersistence: { open: vi.fn(async () => handle), stat: vi.fn() }, pinnedId: PINNED_SESSION_ID })
    expect(r).toBe(false)
  })

  it('open 抛错 → stat.eventCount=0 兜底 → blank=true', async () => {
    const persistence = {
      open: vi.fn(async () => { throw new Error('not found') }),
      stat: vi.fn(async () => ({ eventCount: 0 })),
    }
    const r = await isSessionBlank({ sessionPersistence: persistence, pinnedId: PINNED_SESSION_ID })
    expect(r).toBe(true)
  })

  it('open 抛错 + stat 无 eventCount → 判读未知（undefined）', async () => {
    const persistence = {
      open: vi.fn(async () => { throw new Error('boom') }),
      stat: vi.fn(async () => ({ header: {} })),
    }
    const r = await isSessionBlank({ sessionPersistence: persistence, pinnedId: PINNED_SESSION_ID })
    expect(r).toBeUndefined()
  })
})

describe('② deliverOpeningNotice：blank→恰投一次 / 非blank→不投 / 二次自愈', () => {
  function depsFor(events: Array<{ type: string }>, agent?: { id: string; followup: () => void }) {
    const followupSpy = vi.fn()
    const a = agent ?? { id: PINNED_SESSION_ID, followup: followupSpy }
    const d: OpeningNoticeDeps = {
      agents: { get: vi.fn(() => a) },
      sessionPersistence: {
        open: vi.fn(async () => makeReadHandle(events).handle),
        stat: vi.fn(async () => undefined),
      },
    }
    return { d, followupSpy }
  }

  it('blank（零事件）→ 恰投递一次，返回 delivered', async () => {
    const { d, followupSpy } = depsFor([])
    const r = await deliverOpeningNotice(d)
    expect(r).toEqual({ kind: 'delivered', id: PINNED_SESSION_ID })
    expect(followupSpy).toHaveBeenCalledTimes(1)
    expect(followupSpy).toHaveBeenCalledWith(
      expect.objectContaining({ role: 'user', source: expect.objectContaining({ form: 'notice' }) }),
    )
  })

  it('非 blank（已有 turn/start）→ 不投，返回 not-blank', async () => {
    const { d, followupSpy } = depsFor([{ type: 'turn/start' }])
    const r = await deliverOpeningNotice(d)
    expect(r).toEqual({ kind: 'not-blank', id: PINNED_SESSION_ID })
    expect(followupSpy).not.toHaveBeenCalled()
  })

  it('重启自愈：第一次投递后第二次判读非 blank → not-blank，仅投一次', async () => {
    let delivered = false
    const followupSpy = vi.fn(() => { delivered = true })
    const agent = { id: PINNED_SESSION_ID, followup: followupSpy }
    const openSpy = vi.fn(async () => makeReadHandle(delivered ? [{ type: 'turn/start' }] : []).handle)
    const d: OpeningNoticeDeps = {
      agents: { get: vi.fn(() => agent) },
      sessionPersistence: { open: openSpy, stat: vi.fn(async () => undefined) },
    }
    expect((await deliverOpeningNotice(d)).kind).toBe('delivered')
    expect(followupSpy).toHaveBeenCalledTimes(1)
    expect((await deliverOpeningNotice(d)).kind).toBe('not-blank')
    expect(followupSpy).toHaveBeenCalledTimes(1)
  })
})

describe('③ 降级：一律 skip、不抛异常', () => {
  it('agents.get 抛错 → skipped', async () => {
    const d: OpeningNoticeDeps = {
      agents: { get: vi.fn(() => { throw new Error('registry down') }) },
      sessionPersistence: { open: vi.fn(async () => makeReadHandle([]).handle), stat: vi.fn(async () => undefined) },
    }
    await expect(deliverOpeningNotice(d)).resolves.toMatchObject({ kind: 'skipped' })
  })

  it('agent 不可达（get 返回 undefined）→ skipped', async () => {
    const d: OpeningNoticeDeps = {
      agents: { get: vi.fn(() => undefined) },
      sessionPersistence: { open: vi.fn(async () => makeReadHandle([]).handle), stat: vi.fn(async () => undefined) },
    }
    await expect(deliverOpeningNotice(d)).resolves.toMatchObject({ kind: 'skipped' })
  })

  it('followup 抛错 → skipped，不抛', async () => {
    const agent = { id: PINNED_SESSION_ID, followup: vi.fn(() => { throw new Error('followup boom') }) }
    const d: OpeningNoticeDeps = {
      agents: { get: vi.fn(() => agent) },
      sessionPersistence: { open: vi.fn(async () => makeReadHandle([]).handle), stat: vi.fn(async () => undefined) },
    }
    await expect(deliverOpeningNotice(d)).resolves.toMatchObject({ kind: 'skipped' })
  })

  it('判读失败（open 抛错且无 stat）→ skipped 且不投递', async () => {
    const followupSpy = vi.fn()
    const agent = { id: PINNED_SESSION_ID, followup: followupSpy }
    const d: OpeningNoticeDeps = {
      agents: { get: vi.fn(() => agent) },
      sessionPersistence: { open: vi.fn(async () => { throw new Error('open boom') }), stat: vi.fn(async () => undefined) },
    }
    await expect(deliverOpeningNotice(d)).resolves.toMatchObject({ kind: 'skipped' })
    expect(followupSpy).not.toHaveBeenCalled()
  })
})

describe('④ buildOpeningNoticeMessage 形态（V4 producer-owned source）', () => {
  it('kind=dsh-ia（非 plugin 且非空）、form=notice、summary 存在且 ≤120、单一 text 块、非空 id', () => {
    const msg = buildOpeningNoticeMessage()
    expect(msg.role).toBe('user')
    expect(typeof msg.id).toBe('string')
    expect(msg.id.length).toBeGreaterThan(0)
    expect(msg.content).toHaveLength(1)
    expect(msg.content[0]).toEqual({ type: 'text', text: OPENING_NOTICE_TEXT })
    // V4 契约：producer 自有 kind，非退役 'plugin'，且非空。
    expect(msg.source.kind).toBe('dsh-ia')
    expect(msg.source.kind).not.toBe('plugin')
    expect(msg.source.kind.length).toBeGreaterThan(0)
    // notice 形态：summary 必须存在且 ≤ 120。
    expect(msg.source.form).toBe('notice')
    expect(msg.source.summary).toBe(OPENING_NOTICE_SUMMARY)
    expect(msg.source.summary.length).toBeLessThanOrEqual(120)
    // 退役的 plugin 字段已被移除。
    expect('plugin' in msg.source).toBe(false)
  })
})
