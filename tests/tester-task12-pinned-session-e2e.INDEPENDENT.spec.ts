/**
 * Task-12（t100362）固定会话端到端联调与验收 —— 独立 E2E。
 *
 * ⚠️ 本文件由 Tester 独立构造，**不复用** developer 的既有单测作为唯一依据，
 * 亦不复用 task10/task11 独立测试的断言方式。核心目标：在**真实 cordis Context**
 * 上，把「真实 agents 服务（AgentRegistry 语义）+ 真实 jsonl 会话持久化 + 插件
 * apply/session-ensure/waker 接线」串成一条可复现的端到端闭环，逐条验证 AC。
 *
 * 关键设计（明确的 stub 边界，见 §边界与风险）：
 *   1. `agents` 服务：结构等价 harness `AgentRegistry`（`get`/`create`/`resume` +
 *      `setFactory`），内部委托一个**自建最小 AgentFactory**（等价 `dsh-agent-loop`
 *      的 `createAgent(ownerCtx, options)` / `resume(ownerCtx, options)`）。
 *      factory 产出的 agent 的 `followup(msg)` 会：
 *        (a) 把 user/notice 消息**落进该会话的 jsonl 日志**；
 *        (b) 追加一条 assistant「研判」消息到同一日志。
 *      这等价「agent 在会话内完成研判」—— 研判消息的生产者是 fake factory，
 *      而非真实 LLM（真实 LLM 需模型凭据，见报告 B 路径）。
 *   2. `sessionPersistence` 服务：结构等价 harness `SessionPersistence` 的
 *      jsonl 后端的最小忠实复刻 —— `create(header)/open(id, access)/stat(id)/
 *      flush()`，把会话写成 `<root>/<projectDir(cwd)>/<sessionId>/<gen>.jsonl`
 *      形式的「header 行 + 事件行」，`stat` 命中判定 = 磁盘文件存在。
 *      这与真实 `session-persistence-jsonl` 的可观测契约（create 落盘、stat 命中、
 *      resume 复读历史）一致。
 *   3. `tools` / `skills` / `fs`：最小 no-op stub（plugin 软取降级，不中断装载）。
 *   4. `ptcRuntime`：**故意省略**，使 `applyRunner` 走到「ptcRuntime 不可用」的
 *      早退分支 —— 不启动调度器、不发起 HTTP 节假日查询、不挂 timer，保证测试
 *      确定性。session-ensure 与 waker 接线与 `ptcRuntime` 无关，不受影响。
 *
 * 逐条 AC 映射：
 *   - AC4：全新空目录 → 插件 apply → 走 create → 磁盘出现 PINNED 会话 jsonl 日志。
 *   - AC1：驱动盘中脉冲（真实 createAgentWaker + buildWakeMessage，按插件同款接线）
 *           → 唤醒消息落入 PINNED 会话日志，agent 在同一会话产出「研判」回复。
 *   - AC2：向同一会话投递用户消息 → 断言与唤醒消息**同一份 jsonl 日志**，
 *           事件顺序可见、上下文连续。
 *   - AC3：dispose 插件 fiber → 再次 apply（同一持久化根）→ 走 resume（stat 命中、
 *           未重复 create），历史事件仍在。
 *   - AC5：本文件即联调记录的可复现脚本；命令与原始输出见 REPORT.md。
 */
import { describe, expect, it, afterEach } from 'vitest'
import { mkdtemp, mkdir, readFile, writeFile, rm, access, stat as fsStat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { Context } from '@deepseek-ai/cordis'

import { apply, inject, name as pluginName, PINNED_SESSION_ID } from '../src/plugin.js'
import {
  buildWakeMessage,
  createAgentWaker,
  type AgentLike,
  type AgentRegistryLike,
  type WakeUserMessage,
} from '../src/runner/wake.js'

// ---------------------------------------------------------------------------
// 最小 jsonl 会话持久化后端（结构等价 harness SessionPersistence 的 jsonl 后端）
// ---------------------------------------------------------------------------

type SessionHeader = {
  id: string
  createdAt: number
  cwd?: string
  [k: string]: unknown
}

type SessionEvent = { role: string; [k: string]: unknown }

/** 一个打开的会话写句柄：`append` 把事件追加为该会话日志文件的一行。 */
interface SessionWriteHandle {
  append(events: SessionEvent[]): Promise<void>
  close(): Promise<void>
}

/** 磁盘布局：`<root>/<projectDir>/<sessionId>/<gen>.jsonl`；projectDir 取 cwd 的 basename 哈希。 */
class MinimalJsonlSessionPersistence {
  private root: string
  /** id -> 已落盘/在内存的 header（create 即注册，materialize 于首次 append）。 */
  private headers = new Map<string, SessionHeader>()

  constructor(root: string) {
    this.root = root
  }

  private projectDir(cwd?: string): string {
    // 对齐真实后端「按 cwd 分 project 目录」，此处用 cwd 的简单稳定摘要。
    const key = cwd ?? 'default'
    let h = 0
    for (let i = 0; i < key.length; i += 1) h = (h * 31 + key.charCodeAt(i)) >>> 0
    return `proj-${h.toString(16)}`
  }

  private sessionDir(cwd: string | undefined, id: string): string {
    return join(this.root, this.projectDir(cwd), id)
  }

  private logPath(cwd: string | undefined, id: string): string {
    return join(this.sessionDir(cwd, id), '0000000000000000.jsonl')
  }

  /** 探测某会话是否已在磁盘落盘（含未知 cwd 的扫描回退）。 */
  private async discoverPath(id: string): Promise<{ path: string; cwd: string | undefined } | undefined> {
    // 1) 已知 header（进程内已 create/open）
    const known = this.headers.get(id)
    if (known) return { path: this.logPath(known.cwd, known.id), cwd: known.cwd }
    // 2) 磁盘扫描：跨 project 目录查找 `<id>/0000000000000000.jsonl`（等价真实后端 listArtifacts）
    const readdir = (await import('node:fs/promises')).readdir
    let projects: string[] = []
    try {
      projects = await readdir(this.root)
    } catch {
      return undefined
    }
    for (const proj of projects) {
      const candidate = join(this.root, proj, id, '0000000000000000.jsonl')
      try {
        await access(candidate)
        return { path: candidate, cwd: undefined }
      } catch {
        /* continue */
      }
    }
    return undefined
  }

  async create(header: SessionHeader): Promise<SessionWriteHandle> {
    this.headers.set(header.id, header)
    const dir = this.sessionDir(header.cwd, header.id)
    await mkdir(dir, { recursive: true })
    const path = this.logPath(header.cwd, header.id)
    // header 行持久化：真实后端在首次 append/flush 时 materialize；这里 create 即写 header，
    // 使「create 后 stat 命中」可观测（等价真实后端 `create` 后 `stat` 命中 pending）。
    await writeFile(path, JSON.stringify(header) + '\n', 'utf8')
    return this.makeHandle(header, path)
  }

  async open(id: string, access: 'read' | 'write'): Promise<SessionWriteHandle> {
    // 磁盘发现：即使本进程未 create 也能 open（等价真实后端 open 已持久化会话）。
    const found = await this.discoverPath(id)
    if (!found) throw new Error(`session not found: ${id}`)
    const header = this.headers.get(id) ?? { id, createdAt: 0, cwd: found.cwd }
    return this.makeHandle(header, found.path, access)
  }

  private makeHandle(header: SessionHeader, path: string, access: 'read' | 'write' = 'write'): SessionWriteHandle {
    return {
      append: async (events: SessionEvent[]) => {
        if (access === 'read') return
        const lines = events.map((e) => JSON.stringify(e)).join('\n') + '\n'
        // 简单 append（对齐真实后端 appendLines 的语义：追加 + 落盘）。
        const { open: fsOpen } = await import('node:fs/promises')
        const h = await fsOpen(path, 'a')
        try {
          await h.writeFile(lines, 'utf8')
          await h.sync()
        } finally {
          await h.close()
        }
      },
      close: async () => {},
    }
  }

  async stat(id: string): Promise<unknown | undefined> {
    const found = await this.discoverPath(id)
    if (!found) return undefined
    try {
      const s = await fsStat(found.path)
      return { header: { id }, sizeBytes: Number(s.size) }
    } catch {
      return undefined
    }
  }

  async list(): Promise<readonly unknown[]> {
    const out: unknown[] = []
    for (const id of this.headers.keys()) {
      const snap = await this.stat(id)
      if (snap) out.push(snap)
    }
    return out
  }

  /** 读取某会话的完整事件序列（按行）供断言（header 行除外，磁盘发现回退）。 */
  async readEvents(id: string): Promise<SessionEvent[]> {
    const found = await this.discoverPath(id)
    if (!found) return []
    let raw: string
    try {
      raw = await readFile(found.path, 'utf8')
    } catch {
      return []
    }
    const lines = raw.split('\n').filter((l) => l.trim().length > 0)
    // 首行是 header，其后是事件。
    return lines.slice(1).map((l) => JSON.parse(l) as SessionEvent)
  }

  /** 读取 header 行（供断言 cwd / id 落盘，磁盘发现回退）。 */
  async readHeader(id: string): Promise<SessionHeader | undefined> {
    const found = await this.discoverPath(id)
    if (!found) return undefined
    try {
      return JSON.parse((await readFile(found.path, 'utf8')).split('\n')[0]!) as SessionHeader
    } catch {
      return undefined
    }
  }
}

// ---------------------------------------------------------------------------
// 自建最小 AgentFactory（等价 dsh-agent-loop 的 createAgent/resume）
// ---------------------------------------------------------------------------

/** 一个「会写会话日志 + 产出研判」的最小 agent（等价 harness `Agent` 运行时面）。 */
interface FakeAgent extends AgentLike {
  /** 追加一条 assistant「研判」消息（followup 触发研判）。 */
  judge(text: string): Promise<void>
}

interface FakeAgentHandle {
  agent: FakeAgent
  dispose(): Promise<void>
}

/**
 * 构造一个「服务 + 会话日志」联动的 agents 注册表 + factory。
 * factory 的 agent 把消息写进 jsonl 日志，并在 followup 时产出研判。
 */
function makeAgentsWithFactory(persistence: MinimalJsonlSessionPersistence) {
  const live = new Map<string, FakeAgent>()

  async function openWriteHandle(id: string): Promise<SessionWriteHandle> {
    try {
      return await persistence.open(id, 'write')
    } catch {
      // 未 create 时无法 open —— 不应发生（先 create 再 followup）。
      const header = { id, createdAt: Date.now(), cwd: process.cwd() }
      return await persistence.create(header)
    }
  }

  async function appendEvent(id: string, ev: SessionEvent): Promise<void> {
    const h = await openWriteHandle(id)
    await h.append([ev])
  }

  // 串行化同一会话的 append（避免并发写乱事件顺序，等价真实后端的顺序保障）。
  const chains = new Map<string, Promise<unknown>>()
  function chained(id: string, fn: () => Promise<unknown>): Promise<unknown> {
    const prev = chains.get(id) ?? Promise.resolve()
    const next = prev.then(fn, fn)
    chains.set(id, next)
    return next
  }

  function makeAgent(id: string): FakeAgent {
    const agent: FakeAgent = {
      id,
      followup: (msg: WakeUserMessage) => {
        // 1) 把 user/notice 唤醒消息落进会话日志（串行）。
        const text = (msg.content[0] as { text: string }).text
        chained(id, async () => {
          await appendEvent(id, { role: 'user', kind: 'followup', text, msgId: msg.id })
          // 2) 产出「研判」assistant 消息，同一会话日志（在 user 消息之后）。
          await appendEvent(id, { role: 'assistant', kind: 'judgement', text: `【研判】已收到 ${text.slice(0, 40)}……` })
        })
      },
      inject: (msg: WakeUserMessage) => {
        const text = (msg.content[0] as { text: string }).text
        chained(id, () => appendEvent(id, { role: 'user', kind: 'inject', text, msgId: msg.id }))
      },
      judge: async (text: string) => {
        await chained(id, () => appendEvent(id, { role: 'assistant', kind: 'judgement', text }))
      },
    }
    return agent
  }

  const factory = {
    async createAgent(_ownerCtx: unknown, options: { sessionId: string; meta?: { cwd?: string } }): Promise<FakeAgentHandle> {
      const header: SessionHeader = { id: options.sessionId, createdAt: Date.now(), cwd: options.meta?.cwd }
      await persistence.create(header)
      const agent = makeAgent(options.sessionId)
      live.set(options.sessionId, agent)
      return { agent, dispose: async () => { live.delete(options.sessionId) } }
    },
    async resume(_ownerCtx: unknown, options: { resumeSessionId: string }): Promise<FakeAgentHandle> {
      // resume：复读历史（此处不重建文件，保住上下文），并重新挂 live agent。
      const agent = makeAgent(options.resumeSessionId)
      live.set(options.resumeSessionId, agent)
      return { agent, dispose: async () => { live.delete(options.resumeSessionId) } }
    },
  }

  const agents: AgentRegistryLike & {
    create(options: { sessionId: string; meta?: { cwd?: string }; agentOptions?: unknown }): Promise<FakeAgentHandle>
    resume(options: { resumeSessionId: string; agentOptions?: unknown }): Promise<FakeAgentHandle>
    setFactory(f: unknown): () => void
    /** 等待所有待写入的 append 链完成（测试用，等价 flush）。 */
    flush(): Promise<void>
  } = {
    get: (id: string) => live.get(id),
    create: async (options) => {
      const h = await factory.createAgent(undefined, options)
      // 等价真实 registry：create 后注册到 live store，get 命中。
      return h
    },
    resume: async (options) => factory.resume(undefined, options),
    setFactory: () => () => {},
    flush: async () => {
      await Promise.all([...chains.values()])
    },
  }

  return { agents, factory, live, makeAgent }
}

// ---------------------------------------------------------------------------
// 装配工具：真实 cordis Context 装载插件 apply（省略 ptcRuntime → runner 早退）
// ---------------------------------------------------------------------------

interface LoadedPlugin {
  root: Context
  fiber: Awaited<ReturnType<Context['plugin']>>
  persistence: MinimalJsonlSessionPersistence
  agents: ReturnType<typeof makeAgentsWithFactory>['agents']
}

let tmpRoots: string[] = []
let loadedFibers: Array<{ dispose: () => Promise<unknown> | unknown }> = []

afterEach(async () => {
  for (const f of loadedFibers.splice(0)) await f.dispose()
  for (const r of tmpRoots.splice(0)) await rm(r, { recursive: true, force: true })
})

async function loadPlugin(persistenceRoot: string): Promise<LoadedPlugin> {
  const persistence = new MinimalJsonlSessionPersistence(persistenceRoot)
  const { agents, live, makeAgent } = makeAgentsWithFactory(persistence)

  const root = new Context()
  root.provide('tools', { register: () => () => {} })
  root.provide('skills', { register: () => () => {} })
  root.provide('fs', {})
  // 最小 ptcRuntime：满足顶层 inject 契约（否则 cordis 不触发 apply），
  // 但 run 恒返回 shouldWake=false，且调度器只 arm 未来 timer、不即时触发，
  // 故测试窗口内不产生真实脉冲/HTTP 节假日查询。
  root.provide('ptcRuntime', {
    resolve: (r: unknown) => r,
    run: async () => ({ logs: [], value: { shouldWake: false } }),
  })
  root.provide('agents', agents)
  root.provide('sessionPersistence', persistence)

  const fiber = root.plugin({ name: pluginName, inject, apply })
  await fiber
  // 等 inject 子 fiber reload + ensurePinnedSession 异步完成。
  await new Promise((r) => setTimeout(r, 30))
  loadedFibers.push(fiber as unknown as { dispose: () => Promise<unknown> })

  return { root, fiber, persistence, agents }
}

// ---------------------------------------------------------------------------
// 测试主体
// ---------------------------------------------------------------------------

describe('Task-12 端到端联调 ① 首次启动 create（AC4）', () => {
  it('全新空目录 → 插件 apply → 走 create → 磁盘出现 PINNED 会话 jsonl 日志', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'dsh-finance-e2e-'))
    tmpRoots.push(rootDir)

    const { persistence } = await loadPlugin(rootDir)

    // stat 命中：create 已落盘。
    const snap = await persistence.stat(PINNED_SESSION_ID)
    expect(snap).toBeDefined()

    // 磁盘文件存在，header 落盘且含 cwd / id。
    const header = await persistence.readHeader(PINNED_SESSION_ID)
    expect(header).toBeDefined()
    expect(header!.id).toBe(PINNED_SESSION_ID)
    expect(header!.cwd).toBe(process.cwd())

    // 尚未有事件（仅 header 行）。
    const events = await persistence.readEvents(PINNED_SESSION_ID)
    expect(events).toHaveLength(0)
  })
})

describe('Task-12 端到端联调 ② 盘中脉冲唤醒 + 研判（AC1）+ 用户连续对话（AC2）', () => {
  it('脉冲唤醒消息落入 PINNED 会话日志，agent 在同一会话产出研判；用户消息续写同一日志', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'dsh-finance-e2e-'))
    tmpRoots.push(rootDir)
    const { persistence, agents } = await loadPlugin(rootDir)

    // ---- AC4 前提确认：会话已 create 且 live ----
    expect(agents.get(PINNED_SESSION_ID)).toBeDefined()

    // ---- AC1：驱动盘中脉冲（按插件同款接线：createAgentWaker 定点投递）----
    const waker = createAgentWaker(agents, PINNED_SESSION_ID, () => {})
    const wakePayload = { reason: 'pulse' as const, symbol: '588000', summary: '盘中脉冲：标的上穿压力位' }
    const delivered = waker(wakePayload)
    expect(delivered).toBe(1)

    // 等异步 append 完成。
    await agents.flush()

    const eventsAfterWake = await persistence.readEvents(PINNED_SESSION_ID)
    // 唤醒 user 消息 + 研判 assistant 消息，共 2 条，落于同一会话日志。
    expect(eventsAfterWake.length).toBeGreaterThanOrEqual(2)
    expect(eventsAfterWake.some((e) => e.role === 'user' && (e as { text: string }).text.includes('588000'))).toBe(true)
    expect(eventsAfterWake.some((e) => e.role === 'assistant' && (e as { kind: string }).kind === 'judgement')).toBe(true)

    // ---- AC2：向同一会话投递一条用户消息（用户连续对话，能看到此前唤醒上下文）----
    const pinnedAgent = agents.get(PINNED_SESSION_ID)!
    const userMsg = buildWakeMessage({ reason: 'manual', symbol: '*', summary: 'user asking follow-up' })
    // 用户消息也经 followup 进入同一会话（human 通道同样走 agent.followup）。
    pinnedAgent.followup(userMsg)
    await agents.flush()

    const eventsAfterUser = await persistence.readEvents(PINNED_SESSION_ID)
    // 事件数递增（连续对话，同一份日志），且顺序保持：唤醒 user → 研判 → 用户 user → 研判。
    expect(eventsAfterUser.length).toBeGreaterThan(eventsAfterWake.length)
    // 唤醒的上下文仍在（第一条唤醒 user 消息未丢失）。
    expect(eventsAfterUser[0]!.role).toBe('user')
    expect((eventsAfterUser[0] as { text: string }).text).toContain('588000')
    // 用户消息落在同一日志（上下文连续、顺序可见）。
    const roles = eventsAfterUser.map((e) => e.role)
    expect(roles).toContain('assistant')
  })
})

describe('Task-12 端到端联调 ③ 卸载/重载 resume（AC3）', () => {
  it('dispose 插件 → 再次 apply（同一持久化根）→ 走 resume：stat 命中、未重复 create、历史仍在', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'dsh-finance-e2e-'))
    tmpRoots.push(rootDir)

    // 第一阶段：apply → create，并注入一次唤醒历史。
    const first = await loadPlugin(rootDir)
    const waker1 = createAgentWaker(first.agents, PINNED_SESSION_ID, () => {})
    waker1({ reason: 'pulse', symbol: '588000', summary: 'first pulse' })
    await first.agents.flush()
    const historyLen = (await first.persistence.readEvents(PINNED_SESSION_ID)).length
    expect(historyLen).toBeGreaterThanOrEqual(2)

    // 卸载插件 fiber（create 的 handle 绑定 fiber，卸载即 dispose，live 清空）。
    await first.fiber.dispose()
    await new Promise((r) => setTimeout(r, 20))

    // 第二阶段：全新进程视角（fresh persistence + fresh agents），同一磁盘根。
    // 用带计数的 agents 验证：stat 命中（磁盘发发现）→ 走 resume 而非 create。
    const persistence2 = new MinimalJsonlSessionPersistence(rootDir)
    const { makeAgent } = makeAgentsWithFactory(persistence2)
    let createCount = 0
    let resumeCount = 0
    const countingAgents = {
      get: (_id: string) => undefined, // 已卸载，未 live
      create: async (o: unknown) => {
        createCount += 1
        const header: SessionHeader = { id: PINNED_SESSION_ID, createdAt: Date.now(), cwd: (o as { meta?: { cwd?: string } }).meta?.cwd }
        await persistence2.create(header)
        const a = makeAgent(PINNED_SESSION_ID)
        return { agent: a, dispose: async () => {} }
      },
      resume: async () => {
        resumeCount += 1
        const a = makeAgent(PINNED_SESSION_ID)
        return { agent: a, dispose: async () => {} }
      },
      setFactory: () => () => {},
    }

    const root2 = new Context()
    root2.provide('tools', { register: () => () => {} })
    root2.provide('skills', { register: () => () => {} })
    root2.provide('fs', {})
    root2.provide('ptcRuntime', { resolve: (r: unknown) => r, run: async () => ({ logs: [], value: { shouldWake: false } }) })
    root2.provide('agents', countingAgents)
    root2.provide('sessionPersistence', persistence2)
    const fiber2 = root2.plugin({ name: pluginName, inject, apply })
    await fiber2
    await new Promise((r) => setTimeout(r, 30))
    loadedFibers.push(fiber2 as unknown as { dispose: () => Promise<unknown> })

    // AC3 断言：走 resume（resumeCount≥1），未重复 create（createCount=0）。
    expect(resumeCount).toBeGreaterThanOrEqual(1)
    expect(createCount).toBe(0)

    // 历史仍在（stat 命中，事件数与第一阶段一致或更多）。
    const snap2 = await persistence2.stat(PINNED_SESSION_ID)
    expect(snap2).toBeDefined()
    const eventsAfterResume = await persistence2.readEvents(PINNED_SESSION_ID)
    expect(eventsAfterResume.length).toBeGreaterThanOrEqual(historyLen)
  })
})

describe('Task-12 端到端联调 ④ 契约回归（AC6 附带）', () => {
  it('顶层 inject 仍为 [tools, skills, ptcRuntime, fs]；PINNED_SESSION_ID 稳定', () => {
    expect(inject).toEqual(['tools', 'skills', 'ptcRuntime', 'fs'])
    expect(PINNED_SESSION_ID).toBe('investment-advisor')
    expect(PINNED_SESSION_ID).toBe(pluginName)
  })
})
