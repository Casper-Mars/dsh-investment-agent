/**
 * scheduler/wake.ts 单元测试。
 *
 * 唯一权威设计文档：《感知层详细设计（dsh-finance 插件）》 v0.7，§8（定点投递 /
 * 消息源 / 正文组装）、§9.1~§9.3（降级 / 文本预算 / 冷却）。
 *
 * 覆盖验收标准（逐条）：
 *  1. 定点投递：agents.get('investment-advisor') 命中且 followup 可调用 → delivered:true/count:1/targets:['investment-advisor']
 *  2. 正文组装：buildWakeText('xxx') === 'xxx\n\n> 本内容不构成投资建议'
 *  3. 复用 message-source：followup 收到的消息 source.kind==='dsh-finance' && source.form==='notice'（禁 'plugin'）
 *  4. 降级（§9.1）：a) 无 investment-advisor；b) followup 非函数；c) followup 抛异常 → delivered:false/count:0/targets:[]，且不向外抛
 *  5. 文本预算（§9.2/§9.3）：超 budget 截断；budget<=0 不截断
 *  6. 冷却（§9.3）：窗口内同 taskId 二次 wake 不投递；cooldownMs<=0 关闭冷却；不同 taskId 互不影响；降级不写 lastDeliveredAt
 *  7. 依赖注入：mock agents + 可控 clock 手动推进，冷却判定随 clock 变化
 *  8. deriveSummary：首行空白回退占位；超长首行截断到 120 字符
 *
 * 全部通过注入的 mock agents 注册表 + 可控 clock，不依赖真实 harness / 文件系统。
 */
import { describe, expect, it } from 'vitest'

import {
  buildWakeText,
  boundPayload,
  createWaker,
  deriveSummary,
  WAKE_TARGET_ID,
  type Waker,
} from '../src/scheduler/wake.js'
import { createNoticeMessage } from '../src/message-source.js'
import type { AgentLike, AgentRegistryLike, Clock } from '../src/scheduler/types.js'

// ---------------------------------------------------------------------------
// 测试替身：可控 clock
// ---------------------------------------------------------------------------

/** 手动推进的时钟：固定 base 时刻，advance 增加毫秒。 */
class FakeClock implements Clock {
  private ms: number
  constructor(startMs = 1_000_000) {
    this.ms = startMs
  }
  now(): Date {
    return new Date(this.ms)
  }
  advance(deltaMs: number): void {
    this.ms += deltaMs
  }
}

// ---------------------------------------------------------------------------
// 测试替身：mock agent 注册表 / 会话
// ---------------------------------------------------------------------------

interface CapturedMessage {
  kind: string
  text: string
  content?: readonly { type: string; text?: string }[]
  source?: { kind?: string; form?: string; summary?: string }
}

/** 从 captured 消息提取正文（真实 harness 消息把正文放在 content[0].text）。 */
function textOf(m?: CapturedMessage): string | undefined {
  if (!m) return undefined
  if (typeof m.text === 'string') return m.text
  return m.content?.find((b) => b.type === 'text')?.text
}

function makeAgent(overrides: Partial<{ followup: unknown; id: string }> = {}): AgentLike {
  return {
    id: overrides.id ?? WAKE_TARGET_ID,
    followup: (overrides.followup as AgentLike['followup']) ?? (() => {}),
  }
}

function makeRegistry(getImpl: (id: string) => AgentLike | undefined): AgentRegistryLike {
  return { get: getImpl }
}

/** 捕获 followup 入参的会话，用于断言消息结构。 */
function makeCaptureAgent(onCapture?: (msg: CapturedMessage) => void): AgentLike {
  return {
    id: WAKE_TARGET_ID,
    followup: (msg) => {
      const m = msg as unknown as CapturedMessage
      onCapture?.(m)
    },
  }
}

// ---------------------------------------------------------------------------
// 验收点 2：正文组装 buildWakeText
// ---------------------------------------------------------------------------

describe('buildWakeText（正文组装，验收点 2）', () => {
  it('在 data 末尾追加合规声明（"\n\n> 本内容不构成投资建议"）', () => {
    expect(buildWakeText('xxx')).toBe('xxx\n\n> 本内容不构成投资建议')
  })

  it('空 data 也要保留合规声明', () => {
    expect(buildWakeText('')).toBe('\n\n> 本内容不构成投资建议')
  })

  it('多行 data 声明紧跟末尾', () => {
    expect(buildWakeText('line1\nline2')).toBe('line1\nline2\n\n> 本内容不构成投资建议')
  })
})

// ---------------------------------------------------------------------------
// 验收点 5：文本预算 boundPayload
// ---------------------------------------------------------------------------

describe('boundPayload（文本预算，验收点 5）', () => {
  it('data 长度 <= budget 时原样返回', () => {
    expect(boundPayload('abc', 10)).toBe('abc')
    expect(boundPayload('abc', 3)).toBe('abc')
  })

  it('data 超 budget 时截断到前 budget 字符', () => {
    const data = '0123456789'
    expect(boundPayload(data, 4)).toBe('0123')
    expect(boundPayload(data, 4).length).toBe(4)
  })

  it('budget <= 0 不截断', () => {
    const data = '0123456789'
    expect(boundPayload(data, 0)).toBe(data)
    expect(boundPayload(data, -5)).toBe(data)
  })
})

// ---------------------------------------------------------------------------
// 验收点 8：deriveSummary
// ---------------------------------------------------------------------------

describe('deriveSummary（摘要派生，验收点 8）', () => {
  it('取 data 首行（去首尾空白）作为摘要', () => {
    expect(deriveSummary('  今日行情回顾  \n第二行')).toBe('今日行情回顾')
  })

  it('data 为空串 → 回退固定占位「感知唤醒」', () => {
    expect(deriveSummary('')).toBe('感知唤醒')
  })

  it('data 首行为全空白（仅换行/空格）→ 取下一个有效行', () => {
    expect(deriveSummary('\n\n  \n有效首行')).toBe('有效首行')
  })

  it('data 全空白 → 回退固定占位', () => {
    expect(deriveSummary('   \n  \n\t')).toBe('感知唤醒')
  })

  it('超长首行截断到 120 字符', () => {
    const long = 'x'.repeat(200)
    const s = deriveSummary(long)
    expect(s.length).toBe(120)
    expect(s).toBe('x'.repeat(120))
  })

  it('恰好 120 字符不截断', () => {
    const exact = 'y'.repeat(120)
    expect(deriveSummary(exact).length).toBe(120)
  })
})

// ---------------------------------------------------------------------------
// 验收点 1 / 3 / 4 / 6 / 7：Waker.wake 运行时行为
// ---------------------------------------------------------------------------

describe('Waker.wake（唤醒投递）', () => {
  // --- 验收点 1：定点投递成功 ---

  it('命中 investment-advisor 且 followup 可调用 → delivered:true/count:1/targets:[investment-advisor]（验收点 1）', () => {
    let captured: CapturedMessage | undefined
    const agent = makeCaptureAgent((m) => (captured = m))
    const waker = createWaker({ agents: makeRegistry(() => agent) })

    const result = waker.wake('task-1', 'hello')
    expect(result.delivered).toBe(true)
    expect(result.count).toBe(1)
    expect(result.targets).toEqual([WAKE_TARGET_ID])
    expect(captured).toBeDefined()
  })

  // --- 验收点 2（经 wake 投递的正文同样带声明）---

  it('投递的正文包含 data + 合规声明（验收点 2 经 wake 链路）', () => {
    let captured: CapturedMessage | undefined
    const agent = makeCaptureAgent((m) => (captured = m))
    const waker = createWaker({ agents: makeRegistry(() => agent) })

    waker.wake('task-2', '市场速报')
    expect(textOf(captured)).toBe('市场速报\n\n> 本内容不构成投资建议')
  })

  // --- 验收点 3：复用 message-source（source.kind/form）---

  it('followup 收到的消息 source.kind==="dsh-finance" 且 form==="notice"，无 "plugin"（验收点 3）', () => {
    let captured: CapturedMessage | undefined
    const agent = makeCaptureAgent((m) => (captured = m))
    const waker = createWaker({ agents: makeRegistry(() => agent) })

    waker.wake('task-3', '今天行情波动')
    expect(captured).toBeDefined()
    expect(captured!.source?.kind).toBe('dsh-finance')
    expect(captured!.source?.form).toBe('notice')
    expect(captured!.source?.kind).not.toBe('plugin')
    // 显式断言不出现任何 'plugin' 字符串
    expect(JSON.stringify(captured!.source)).not.toContain('plugin')
  })

  it('createNoticeMessage 本身产出 dsh-finance/notice 源（辅助断言）', () => {
    const msg = createNoticeMessage('body', 'summary') as unknown as CapturedMessage
    expect(msg.source?.kind).toBe('dsh-finance')
    expect(msg.source?.form).toBe('notice')
    expect(JSON.stringify(msg.source)).not.toContain('plugin')
  })

  // --- 验收点 4：降级（三种情况均不抛异常）---

  it('a) agents 无 investment-advisor → delivered:false/count:0/targets:[]（验收点 4a）', () => {
    const waker = createWaker({ agents: makeRegistry(() => undefined) })
    const result = waker.wake('task-4', 'data')
    expect(result.delivered).toBe(false)
    expect(result.count).toBe(0)
    expect(result.targets).toEqual([])
  })

  it('b) followup 不是函数 → delivered:false/count:0/targets:[]（验收点 4b）', () => {
    const agent = makeAgent({ followup: 'not-a-function' })
    const waker = createWaker({ agents: makeRegistry(() => agent) })
    const result = waker.wake('task-5', 'data')
    expect(result.delivered).toBe(false)
    expect(result.count).toBe(0)
    expect(result.targets).toEqual([])
  })

  it('c) followup 抛异常 → delivered:false/count:0/targets:[]，且 wake 不向外抛（验收点 4c）', () => {
    const agent: AgentLike = {
      id: WAKE_TARGET_ID,
      followup: () => {
        throw new Error('boom')
      },
    }
    const waker = createWaker({ agents: makeRegistry(() => agent) })

    let result: ReturnType<Waker['wake']> | undefined
    expect(() => {
      result = waker.wake('task-6', 'data')
    }).not.toThrow()

    expect(result!.delivered).toBe(false)
    expect(result!.count).toBe(0)
    expect(result!.targets).toEqual([])
  })

  it('agents.get 本身抛异常 → 兜底降级不抛（验收点 4 兜底分支）', () => {
    const waker = createWaker({
      agents: {
        get: () => {
          throw new Error('registry broken')
        },
      },
    })
    let result: ReturnType<Waker['wake']> | undefined
    expect(() => {
      result = waker.wake('task-7', 'data')
    }).not.toThrow()
    expect(result!.delivered).toBe(false)
    expect(result!.count).toBe(0)
    expect(result!.targets).toEqual([])
  })

  // --- 验收点 5 / 6（wake 链路内预算 + 冷却）---

  it('数据超注入预算时，投递正文被截断到 budget 长度（验收点 5 经 wake）', () => {
    let captured: CapturedMessage | undefined
    const agent = makeCaptureAgent((m) => (captured = m))
    const waker = createWaker({ agents: makeRegistry(() => agent), wakeTextBudget: 10 })

    waker.wake('task-8', 'x'.repeat(100))
    // 正文 = 截断后的 data(10) + "\n\n> 本内容不构成投资建议"
    const text = textOf(captured)!
    expect(text.startsWith('x'.repeat(10))).toBe(true)
    expect(text.startsWith('x'.repeat(11))).toBe(false)
  })

  it('同 taskId 冷却窗口内二次 wake → 不投递（followup 只调一次），delivered:false（验收点 6）', () => {
    const clock = new FakeClock()
    let followupCalls = 0
    const agent: AgentLike = {
      id: WAKE_TARGET_ID,
      followup: () => {
        followupCalls += 1
      },
    }
    const waker = createWaker({
      agents: makeRegistry(() => agent),
      clock,
      wakeCooldownMs: 60_000,
    })

    const first = waker.wake('task-cooldown', 'data')
    expect(first.delivered).toBe(true)
    expect(followupCalls).toBe(1)

    const second = waker.wake('task-cooldown', 'data again')
    expect(second.delivered).toBe(false)
    expect(second.count).toBe(0)
    expect(second.targets).toEqual([])
    expect(followupCalls).toBe(1) // 未被二次调用
  })

  it('wakeCooldownMs<=0 关闭冷却 → 同 taskId 两次都投递（验收点 6）', () => {
    const clock = new FakeClock()
    let followupCalls = 0
    const agent: AgentLike = {
      id: WAKE_TARGET_ID,
      followup: () => {
        followupCalls += 1
      },
    }
    const waker = createWaker({ agents: makeRegistry(() => agent), clock, wakeCooldownMs: 0 })

    expect(waker.wake('t', 'a').delivered).toBe(true)
    expect(waker.wake('t', 'b').delivered).toBe(true)
    expect(followupCalls).toBe(2)
  })

  it('不同 taskId 冷却互不影响（验收点 6）', () => {
    const clock = new FakeClock()
    let followupCalls = 0
    const agent: AgentLike = {
      id: WAKE_TARGET_ID,
      followup: () => {
        followupCalls += 1
      },
    }
    const waker = createWaker({ agents: makeRegistry(() => agent), clock, wakeCooldownMs: 60_000 })

    expect(waker.wake('task-A', 'a').delivered).toBe(true)
    // 同窗口内不同 taskId 仍可投递
    expect(waker.wake('task-B', 'b').delivered).toBe(true)
    expect(followupCalls).toBe(2)
  })

  it('冷却失败（降级投递）不写入 lastDeliveredAt → 下次仍可投递（验收点 6 降级语义）', () => {
    const clock = new FakeClock()
    let followupCalls = 0
    let shouldThrow = true
    // 第一次投递异常，恢复为正常；验证失败不占冷却额度
    const agent: AgentLike = {
      id: WAKE_TARGET_ID,
      followup: () => {
        if (shouldThrow) throw new Error('transient')
        followupCalls += 1
      },
    }
    const waker = createWaker({ agents: makeRegistry(() => agent), clock, wakeCooldownMs: 60_000 })

    const failed = waker.wake('task-retry', 'a') // 降级，不写 lastDeliveredAt
    expect(failed.delivered).toBe(false)

    shouldThrow = false
    const ok = waker.wake('task-retry', 'b') // 未被冷却挡，仍投递成功
    expect(ok.delivered).toBe(true)
    expect(followupCalls).toBe(1)
  })

  // --- 验收点 7：clock 推进影响冷却判定 ---

  it('clock 推进超过冷却窗口后，同 taskId 可再次投递（验收点 7）', () => {
    const clock = new FakeClock()
    let followupCalls = 0
    const agent: AgentLike = {
      id: WAKE_TARGET_ID,
      followup: () => {
        followupCalls += 1
      },
    }
    const waker = createWaker({ agents: makeRegistry(() => agent), clock, wakeCooldownMs: 10_000 })

    expect(waker.wake('task-clock', 'a').delivered).toBe(true)
    expect(waker.wake('task-clock', 'b').delivered).toBe(false) // 窗口内

    clock.advance(9_999) // 仍在窗口内（now - last < 10000）
    expect(waker.wake('task-clock', 'c').delivered).toBe(false)

    clock.advance(1) // now - last === 10000，不再 < 窗口 → 出窗
    expect(waker.wake('task-clock', 'd').delivered).toBe(true)

    expect(followupCalls).toBe(2)
  })
})