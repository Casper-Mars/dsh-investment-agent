/**
 * Task-15 AC1（t100364 §9.7 v1.6）开场 notice 单测。
 *
 * 覆盖（验收标准逐条）：
 *   ① blank（无 `turn/start`）→ 恰投递一次；
 *   ② 非 blank（已有 `turn/start`）→ 不投递；
 *   ③ `agents` 缺失 / `followup` 抛错 / 判读失败 → 降级 skip（不抛异常）；
 *   ④ 重启不重复投递（第二次判读非 blank → `not-blank`，不投）。
 */
import { describe, expect, it, vi } from 'vitest'
import {
  buildOpeningNoticeMessage,
  isSessionBlank,
  deliverOpeningNotice,
  OPENING_NOTICE_TEXT,
  OPENING_NOTICE_SUMMARY,
  type OpeningNoticeDeps,
} from '../src/opening-notice.js'
import { PINNED_SESSION_ID } from '../src/session.js'

/** 构造一个只读句柄：read 返回给定事件列表。 */
function makeReadHandle(events: Array<{ type: string }>) {
  const closeSpy = vi.fn(async () => {})
  return {
    handle: {
      read: vi.fn(async () => ({ events })),
      close: closeSpy,
    },
    closeSpy,
  }
}

describe('① buildOpeningNoticeMessage 形态', () => {
  it('产出 V4 producer-owned 形态的 UserMessage（kind=dsh-ia，非 plugin）', () => {
    const msg = buildOpeningNoticeMessage()
    expect(msg.role).toBe('user')
    expect(msg.content).toEqual([{ type: 'text', text: OPENING_NOTICE_TEXT }])
    expect(msg.source).toEqual({
      kind: 'dsh-ia',
      form: 'notice',
      summary: OPENING_NOTICE_SUMMARY,
    })
    // V4 契约：kind 非空且 ≠ 'plugin'，携带 form/summary。
    expect(typeof msg.source.kind).toBe('string')
    expect(msg.source.kind.length).toBeGreaterThan(0)
    expect(msg.source.kind).not.toBe('plugin')
    expect(msg.source.form).toBe('notice')
    expect(typeof msg.source.summary).toBe('string')
    expect(typeof msg.id).toBe('string')
    expect(msg.id.length).toBeGreaterThan(0)
  })
})

describe('② isSessionBlank 判读优先级', () => {
  it('投影软取命中（blank=true）→ 直接返回 true，且不 open', async () => {
    const openSpy = vi.fn()
    const persistence = {
      open: openSpy,
      stat: vi.fn(),
    }
    const projections = {
      stateOf: vi.fn(() => ({ blank: true })),
    }
    const result = await isSessionBlank(
      { sessionPersistence: persistence, sessionProjections: projections, pinnedId: PINNED_SESSION_ID },
      { id: PINNED_SESSION_ID },
    )
    expect(result).toBe(true)
    expect(openSpy).not.toHaveBeenCalled()
  })

  it('投影软取命中（blank=false）→ 返回 false', async () => {
    const persistence = { open: vi.fn(), stat: vi.fn() }
    const projections = { stateOf: vi.fn(() => ({ blank: false })) }
    const result = await isSessionBlank(
      { sessionPersistence: persistence, sessionProjections: projections, pinnedId: PINNED_SESSION_ID },
      { id: PINNED_SESSION_ID },
    )
    expect(result).toBe(false)
  })

  it('无事件日志（零事件）→ 无投影，open(read) 命中 → blank=true', async () => {
    const { handle, closeSpy } = makeReadHandle([])
    const openSpy = vi.fn(async () => handle)
    const persistence = { open: openSpy, stat: vi.fn() }
    const result = await isSessionBlank({ sessionPersistence: persistence, pinnedId: PINNED_SESSION_ID })
    expect(result).toBe(true)
    expect(openSpy).toHaveBeenCalledWith(PINNED_SESSION_ID, 'read')
    expect(closeSpy).toHaveBeenCalled()
  })

  it('有 turn/start 事件 → blank=false', async () => {
    const { handle } = makeReadHandle([{ type: 'turn/start' }])
    const persistence = { open: vi.fn(async () => handle), stat: vi.fn() }
    const result = await isSessionBlank({ sessionPersistence: persistence, pinnedId: PINNED_SESSION_ID })
    expect(result).toBe(false)
  })

  it('open 抛错 → 落到 stat.eventCount 兜底（eventCount=0 → true）', async () => {
    const persistence = {
      open: vi.fn(async () => { throw new Error('not found') }),
      stat: vi.fn(async () => ({ eventCount: 0 })),
    }
    const result = await isSessionBlank({ sessionPersistence: persistence, pinnedId: PINNED_SESSION_ID })
    expect(result).toBe(true)
  })

  it('open 抛错且 stat 无 eventCount → 判读未知（undefined）', async () => {
    const persistence = {
      open: vi.fn(async () => { throw new Error('not found') }),
      stat: vi.fn(async () => ({ header: {} })),
    }
    const result = await isSessionBlank({ sessionPersistence: persistence, pinnedId: PINNED_SESSION_ID })
    expect(result).toBeUndefined()
  })
})

describe('③ deliverOpeningNotice：blank→投一次 / 非blank→不投 / 降级', () => {
  it('blank（空事件日志）→ 恰投递一次，返回 delivered', async () => {
    const followupSpy = vi.fn()
    const agent = { id: PINNED_SESSION_ID, followup: followupSpy }
    const deps: OpeningNoticeDeps = {
      agents: { get: vi.fn(() => agent) },
      sessionPersistence: {
        open: vi.fn(async () => makeReadHandle([]).handle),
        stat: vi.fn(async () => undefined),
      },
    }
    const result = await deliverOpeningNotice(deps)
    expect(result).toEqual({ kind: 'delivered', id: PINNED_SESSION_ID })
    expect(followupSpy).toHaveBeenCalledTimes(1)
    expect(followupSpy).toHaveBeenCalledWith(
      expect.objectContaining({ role: 'user', source: expect.objectContaining({ form: 'notice' }) }),
    )
  })

  it('非 blank（已有 turn/start）→ 不投递，返回 not-blank', async () => {
    const followupSpy = vi.fn()
    const agent = { id: PINNED_SESSION_ID, followup: followupSpy }
    const deps: OpeningNoticeDeps = {
      agents: { get: vi.fn(() => agent) },
      sessionPersistence: {
        open: vi.fn(async () => makeReadHandle([{ type: 'turn/start' }]).handle),
        stat: vi.fn(async () => undefined),
      },
    }
    const result = await deliverOpeningNotice(deps)
    expect(result).toEqual({ kind: 'not-blank', id: PINNED_SESSION_ID })
    expect(followupSpy).not.toHaveBeenCalled()
  })

  it('重启自愈：第一次投递后第二次判读非 blank → not-blank，不重复投', async () => {
    // 模拟「投递后产生 turn/start」：open 首次返回空，投递后返回带 turn/start。
    let delivered = false
    const followupSpy = vi.fn(() => { delivered = true })
    const agent = { id: PINNED_SESSION_ID, followup: followupSpy }
    const openSpy = vi.fn(async () =>
      makeReadHandle(delivered ? [{ type: 'turn/start' }] : []).handle,
    )
    const deps: OpeningNoticeDeps = {
      agents: { get: vi.fn(() => agent) },
      sessionPersistence: { open: openSpy, stat: vi.fn(async () => undefined) },
    }
    const first = await deliverOpeningNotice(deps)
    expect(first.kind).toBe('delivered')
    expect(followupSpy).toHaveBeenCalledTimes(1)

    const second = await deliverOpeningNotice(deps)
    expect(second.kind).toBe('not-blank')
    expect(followupSpy).toHaveBeenCalledTimes(1) // 仍只投一次
  })

  it('agents 不可达（get 返回 undefined）→ 降级 skip，不抛异常', async () => {
    const deps: OpeningNoticeDeps = {
      agents: { get: vi.fn(() => undefined) },
      sessionPersistence: {
        open: vi.fn(async () => makeReadHandle([]).handle),
        stat: vi.fn(async () => undefined),
      },
    }
    const result = await deliverOpeningNotice(deps)
    expect(result.kind).toBe('skipped')
  })

  it('agents.get 抛错 → 降级 skip，不抛异常', async () => {
    const deps: OpeningNoticeDeps = {
      agents: { get: vi.fn(() => { throw new Error('registry down') }) },
      sessionPersistence: {
        open: vi.fn(async () => makeReadHandle([]).handle),
        stat: vi.fn(async () => undefined),
      },
    }
    await expect(deliverOpeningNotice(deps)).resolves.toMatchObject({ kind: 'skipped' })
  })

  it('followup 抛错 → 降级 skip，不抛异常', async () => {
    const agent = {
      id: PINNED_SESSION_ID,
      followup: vi.fn(() => { throw new Error('followup boom') }),
    }
    const deps: OpeningNoticeDeps = {
      agents: { get: vi.fn(() => agent) },
      sessionPersistence: {
        open: vi.fn(async () => makeReadHandle([]).handle),
        stat: vi.fn(async () => undefined),
      },
    }
    const result = await deliverOpeningNotice(deps)
    expect(result.kind).toBe('skipped')
  })

  it('判读失败（open 抛错且无 stat）→ 降级 skip，不投递', async () => {
    const followupSpy = vi.fn()
    const agent = { id: PINNED_SESSION_ID, followup: followupSpy }
    const deps: OpeningNoticeDeps = {
      agents: { get: vi.fn(() => agent) },
      sessionPersistence: {
        open: vi.fn(async () => { throw new Error('open boom') }),
        stat: vi.fn(async () => undefined),
      },
    }
    const result = await deliverOpeningNotice(deps)
    // 判读未知 → 降级 skip（不投递，避免误判重复）。
    expect(result.kind).toBe('skipped')
    expect(followupSpy).not.toHaveBeenCalled()
  })
})
