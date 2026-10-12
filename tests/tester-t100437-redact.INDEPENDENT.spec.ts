/**
 * 独立验收（t100437 · M5「字段级去敏 + 泄密扫描」）—— Tester 自成体系用例。
 *
 * 被测交付物（HEAD `99f8e48`，已 commit；含本轮 `99f8e48` 修复 + 前序 `4521805`）：
 *   - `src/log/redact.ts`：`redact` / `redactText` / `redactRecord` + 词表 +
 *     文本级裸令牌扫描（`Bearer` / `sk-` / `gh…` / `xox…` / `AKIA`）+ 文本级金额键 + `CircularReferenceError`
 *   - `src/log/file-exporter.ts`（改）：写盘前 `redactRecord`（`msg` 文本级 / `args` 深遍历）
 *   - `tests/redact.test.ts`（dev 自测 35 用例）
 *
 * 本文件**不复用** dev 自测的用例 / 辅助函数，独立构造对抗性 / 边界 / 端到端输入，
 * 逐条对应：原始验收标准 1–3 与任务卡列出的对抗性用例清单。
 *
 * 隔离：全程使用临时目录，并以 `DSH_FINANCE_LOG_DIR` 环境变量覆盖落盘目录，
 * 不触碰真实 `~/.dsh-finance`；`scripts/jev-news-demo.*` 未触碰。
 *
 * 说明：`[修复验证]` 前缀的用例，是上一轮判「❌ 不通过」的 GAP 用例（原以 `it.fails` 刻画
 * 已知缺陷）；Developer 提交 `99f8e48` 修复后，已翻转为**正向断言 `it`**（修复后应通过）。
 * 新增 ⑪ 组为修复后的对抗补充（前缀家族 / 大小写变体 / JSON 形状 / 一行多键金额 / 反例）。
 * 详见同目录 REPORT.md。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Message } from '@deepseek-ai/cordis'
import {
  AMOUNT_KEY_TOKENS,
  CIRCULAR_MARKER,
  CircularReferenceError,
  DEFAULT_MAX_ARRAY_LENGTH,
  DEFAULT_MAX_ENTRIES,
  DEFAULT_MAX_STACK_LINES,
  DEFAULT_MAX_TEXT_LENGTH,
  LONG_TEXT_KEYS,
  MAX_DEPTH_MARKER,
  REDACTED,
  SENSITIVE_KEY_TOKENS,
  TRUNCATED_SUFFIX,
  isAmountKey,
  isLongTextKey,
  isSensitiveKey,
  redact,
  redactRecord,
  redactText,
} from '../src/log/redact.js'
import { createFileExporter } from '../src/log/file-exporter.js'
import { LOG_DIR_ENV } from '../src/paths.js'

// ===========================================================================
// 自建基础设施（不复用开发者用例）
// ===========================================================================
const T1 = Date.UTC(2026, 9, 12, 12, 0, 0) // 2026-10-12T12:00Z → 文件名 2026-10-12.jsonl

function msg(partial: Partial<Message> & Pick<Message, 'type'>): Message {
  return { sn: 1, ts: T1, name: 'dsh-finance', level: 0, args: [], ...partial }
}

const dirs: string[] = []
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'dsh-t1 00437-'.replace(' ', '')))
  dirs.push(d)
  return d
}
afterEach(() => {
  for (const d of dirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  }
})

const LOG_FILE = '2026-10-12.jsonl'
function readLog(dir: string): string {
  return readFileSync(join(dir, LOG_FILE), 'utf8')
}
function readRecs(dir: string): Array<Record<string, unknown>> {
  return readLog(dir)
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as Record<string, unknown>)
}
function longStack(message: string, frames: number): Error {
  const e = new Error(message)
  e.stack = [`Error: ${message}`, ...Array.from({ length: frames }, (_, i) => `    at f${i} (a.ts:${i}:1)`)].join('\n')
  return e
}

/** 常见泄密形态（命中即泄漏）。 */
const LEAK_RX: RegExp[] = [
  /sk-[A-Za-z0-9]{10,}/,
  /AKIA[0-9A-Z]{8,}/,
  /Bearer\s+[A-Za-z0-9._-]{6,}/,
  /"(?:password|authorization|token|secret|apiKey|api_key|accessKey|privateKey|credential|cookie)"\s*:\s*"(?!\[REDACTED\])/i,
]

// ===========================================================================
// ① 敏感键 → [REDACTED]（保留键名）
// ===========================================================================
describe('① 敏感键全量与变体', () => {
  it('A1 逐一遍历要求键名 → 值均为 [REDACTED]，且键名保留', () => {
    const input: Record<string, unknown> = {
      token: 'sk-aaaaaaaaaaaaaaaa',
      secret: 's3cr3t-value',
      key: 'K123',
      password: 'hunter2',
      passwd: 'hunter2',
      authorization: 'Bearer eyJhbGciOi.zzz',
      auth: 'basic dXNlcjpwYXNz',
      credential: 'cred-value',
      cookie: 'sessionid=abc123',
      apiKey: 'AKIAIOSFODNN7EXAMPLE',
      api_key: 'AKIAIOSFODNN7EXAMPLE',
      accessKey: 'ACCESSKEYVALUE',
      privateKey: '-----BEGIN PRIVATE KEY-----',
    }
    const out = redact(input) as Record<string, unknown>
    for (const k of Object.keys(input)) expect(out[k], `键 ${k}`).toBe(REDACTED)
    expect(Object.keys(out).sort()).toEqual(Object.keys(input).sort())
  })

  it('A2 大小写 / 分隔符变体（API_KEY / api-key / ApiKey / Authorization / TOKEN）均命中', () => {
    for (const k of [
      'API_KEY',
      'api-key',
      'ApiKey',
      'api.key',
      'APIKEY',
      'Authorization',
      'AUTHORIZATION',
      'TOKEN',
      'Token',
      'Secret',
      'PASSWORD',
      'Private-Key',
      'Access_Key',
      'X-Auth-Token',
    ]) {
      expect(isSensitiveKey(k), `${k} 应命中`).toBe(true)
    }
  })

  it('A3 负例：非敏感键不命中（symbol/qty/op/type/side/sessionId/taskId/traceId/name）', () => {
    for (const k of ['symbol', 'qty', 'op', 'type', 'side', 'sessionId', 'taskId', 'traceId', 'name', 'level', 'msg']) {
      expect(isSensitiveKey(k), `${k} 不应命中`).toBe(false)
    }
  })

  it('A4 词表常量覆盖任务卡要求的全部键', () => {
    for (const need of [
      'token',
      'secret',
      'key',
      'password',
      'passwd',
      'authorization',
      'auth',
      'credential',
      'cookie',
      'apikey',
      'accesskey',
      'privatekey',
    ]) {
      expect(SENSITIVE_KEY_TOKENS).toContain(need)
    }
  })

  it('A5 值类型无关：数字 / 布尔 / 对象 / null / 数组 均整体替换为 [REDACTED]', () => {
    const out = redact({
      token: 123,
      secret: false,
      key: { nested: 'sk-deep' },
      password: null,
      auth: ['a', 'b'],
    }) as Record<string, unknown>
    expect(out).toEqual({ token: REDACTED, secret: REDACTED, key: REDACTED, password: REDACTED, auth: REDACTED })
  })

  it('A6 嵌套对象 / 数组元素中的敏感键也被去敏，非敏感键原样', () => {
    const out = redact({
      cfg: { headers: { authorization: 'Bearer x.y.z' }, symbol: '588000' },
      list: [{ token: 't' }, { apiKey: 'k' }, { safe: 1 }],
    }) as Record<string, unknown>
    expect(((out.cfg as any).headers as any).authorization).toBe(REDACTED)
    expect((out.cfg as any).symbol).toBe('588000')
    expect((out.list as any)[0].token).toBe(REDACTED)
    expect((out.list as any)[1].apiKey).toBe(REDACTED)
    expect((out.list as any)[2].safe).toBe(1)
  })

  it('A7 fail-closed：含敏感子串的键被「多遮蔽」（记录设计口径，非缺陷）', () => {
    // 归一化后按子串命中，故 monkey/hockey/keyword/author 等会命中 `key`/`auth`。
    for (const k of ['monkey', 'hockey', 'keyword', 'keyName', 'author', 'authentication']) {
      expect(isSensitiveKey(k), `${k}`).toBe(true)
    }
  })
})

// ===========================================================================
// ② 金额 / 成本键 → [REDACTED]；上下文键保留
// ===========================================================================
describe('② 金额 / 成本键去敏 + 上下文保留', () => {
  it('B1 逐一要求键名 → [REDACTED]', () => {
    const input: Record<string, unknown> = {
      cost: 12.345678,
      costPrice: 2.5,
      amount: 98765.43,
      price: 3.14,
      marketValue: 1234567.89,
      positionValue: 99999,
      pnl: -1234.56,
      profit: 777,
      value: 42,
    }
    const out = redact(input) as Record<string, unknown>
    for (const k of Object.keys(input)) expect(out[k], `键 ${k}`).toBe(REDACTED)
  })

  it('B2 上下文键逐字保留（symbol/qty/op/type/side/sessionId/taskId/traceId/name）', () => {
    const ctx = {
      symbol: '588000',
      qty: 500,
      op: 'trade',
      type: 'etf',
      side: 'buy',
      sessionId: 'sess-1',
      taskId: 'market-pulse',
      traceId: 'trace-1',
      name: '科创50ETF',
    }
    expect(redact(ctx)).toEqual(ctx)
  })

  it('B3 isAmountKey 判定 + 词表覆盖', () => {
    for (const k of ['cost', 'costPrice', 'amount', 'price', 'marketValue', 'positionValue', 'pnl', 'profit', 'value']) {
      expect(isAmountKey(k), k).toBe(true)
    }
    for (const k of ['symbol', 'qty', 'op', 'side', 'taskId']) expect(isAmountKey(k), k).toBe(false)
    for (const need of ['cost', 'amount', 'price', 'pnl', 'profit', 'value']) expect(AMOUNT_KEY_TOKENS).toContain(need)
  })

  it('B4 混合输入：金额遮蔽、上下文保留、深层金额也遮蔽', () => {
    const out = redact({
      symbol: '588000',
      qty: 100,
      cost: 1.95,
      nest: { price: 3.14, op: 'buy' },
      arr: [{ pnl: 5 }, { side: 'sell' }],
    }) as Record<string, unknown>
    expect(out.symbol).toBe('588000')
    expect(out.qty).toBe(100)
    expect(out.cost).toBe(REDACTED)
    expect((out.nest as any).price).toBe(REDACTED)
    expect((out.nest as any).op).toBe('buy')
    expect((out.arr as any)[0].pnl).toBe(REDACTED)
    expect((out.arr as any)[1].side).toBe('sell')
  })

  it('B5 fail-closed：含 `value` 子串的复合键（totalValue/netValue/marketValueX）被遮蔽', () => {
    for (const k of ['totalValue', 'netValue', 'positionValueCny']) {
      expect(isAmountKey(k), k).toBe(true)
    }
  })
})

// ===========================================================================
// ③ 长文本截断（防策略全文落盘）
// ===========================================================================
describe('③ 长文本键截断（边界）', () => {
  it('C1 恰好阈值(200)不动；阈值+1 截断为「前 200 + 标记」', () => {
    const exact = 'a'.repeat(DEFAULT_MAX_TEXT_LENGTH)
    const over = 'b'.repeat(DEFAULT_MAX_TEXT_LENGTH + 1)
    const out = redact({ strategy: exact, content: over }) as Record<string, unknown>
    expect(out.strategy).toBe(exact)
    expect(out.content).toBe('b'.repeat(DEFAULT_MAX_TEXT_LENGTH) + TRUNCATED_SUFFIX)
    expect((out.content as string).length).toBe(DEFAULT_MAX_TEXT_LENGTH + TRUNCATED_SUFFIX.length)
  })

  it('C2 长文本键集合覆盖 text/body/content/strategy/prompt/message；非长文本键不截断', () => {
    const long = 'x'.repeat(600)
    for (const k of ['text', 'body', 'content', 'strategy', 'prompt', 'message']) {
      expect(isLongTextKey(k), k).toBe(true)
      const o = redact({ [k]: long }) as Record<string, unknown>
      expect(o[k], k).toBe('x'.repeat(DEFAULT_MAX_TEXT_LENGTH) + TRUNCATED_SUFFIX)
    }
    expect(LONG_TEXT_KEYS).toContain('strategy')
    expect(isLongTextKey('msg')).toBe(false) // `msg` 由文本级处理，非「长文本键」
    // 非长文本键的字符串原样：
    expect((redact({ note: long }) as Record<string, unknown>).note).toBe(long)
  })

  it('C3 阈值可配（maxTextLength=10）', () => {
    const out = redact({ strategy: 'y'.repeat(50) }, { maxTextLength: 10 }) as Record<string, unknown>
    expect(out.strategy).toBe('y'.repeat(10) + TRUNCATED_SUFFIX)
  })

  it('C4 长文本键值为对象/数组 → 不截断，递归去敏', () => {
    const out = redact({ content: { token: 'sk-x', text: 'z'.repeat(600) } }) as Record<string, unknown>
    expect((out.content as any).token).toBe(REDACTED)
    // 内层 text 仍命中长文本键 → 截断
    expect((out.content as any).text).toBe('z'.repeat(DEFAULT_MAX_TEXT_LENGTH) + TRUNCATED_SUFFIX)
  })
})

// ===========================================================================
// ④ 文本级去敏（redactText）
// ===========================================================================
describe('④ 文本级去敏 redactText', () => {
  it('D1 key=value / key: value 形态敏感赋值 → 值替换，键名保留', () => {
    expect(redactText('token=sk-abcdefghijklmnop')).toBe('token=[REDACTED]')
    expect(redactText('password: hunter2')).toBe('password: [REDACTED]')
    expect(redactText('{"apiKey":"AKIA1234567890"}')).toBe('{"apiKey":"[REDACTED]"}')
    expect(redactText("secret='q'")).toBe("secret='[REDACTED]'")
    expect(redactText('a token=sk-1 b password=p2 c')).toBe('a token=[REDACTED] b password=[REDACTED] c')
  })

  it('D2 非敏感赋值 / 普通文本逐字不变', () => {
    expect(redactText('n=7 s=x f=2.5 symbol=588000')).toBe('n=7 s=x f=2.5 symbol=588000')
    expect(redactText('hello world')).toBe('hello world')
  })

  it('D3 敏感键 + Bearer 值 → 整体替换（不留 `Bearer ` 前缀）', () => {
    expect(redactText('authorization=Bearer eyJhbGciOi.J9.Sig')).toBe('authorization=[REDACTED]')
    expect(redactText('Authorization: Bearer abc.def.ghi')).toBe('Authorization: [REDACTED]')
  })

  it('D4 `Error: xxx` 中的 `Error` 不被当作键误吞（仅吃敏感段）', () => {
    expect(redactText('Error: token=sk-abcdefghijkl')).toBe('Error: token=[REDACTED]')
    expect(redactText('TypeError: password=abc failed')).toBe('TypeError: password=[REDACTED] failed')
  })

  it('D5 疑似 stack → 裁剪前 N 行；超长普通文本 → 截断', () => {
    const st = longStack('boom', 30).stack as string
    expect(redactText(st).split('\n')).toHaveLength(DEFAULT_MAX_STACK_LINES)
    expect(redactText('z'.repeat(400))).toBe('z'.repeat(DEFAULT_MAX_TEXT_LENGTH) + TRUNCATED_SUFFIX)
  })

  it('D6 [修复验证] 无键名裸 `Bearer <token>`（free-form）→ 遮蔽', () => {
    // 99f8e48 前：ASSIGN_RX 仅识别「敏感键 + 分隔符」，裸 Bearer 可明文；修复后由裸令牌扫描遮蔽。
    const out = redactText('upstream said: Bearer sk-ABCDEFGHIJ1234567890')
    expect(out).not.toContain('sk-ABCDEFGHIJ1234567890')
    expect(out).toContain(REDACTED)
  })

  it('D7 [修复验证] 无键名裸 `sk-…`（free-form）→ 遮蔽', () => {
    const out = redactText('request failed, key was sk-ABCDEFGHIJ1234567890')
    expect(out).not.toContain('sk-ABCDEFGHIJ1234567890')
    expect(out).toContain(REDACTED)
  })
})

// ===========================================================================
// ⑤ Error 对象 → { message, stack: 前 N 行 }
// ===========================================================================
describe('⑤ Error 对象裁剪', () => {
  it('E1 仅 message + 前 10 行 stack；超出行被裁', () => {
    const out = redact(longStack('boom', 30)) as Record<string, unknown>
    expect(out.message).toBe('boom')
    expect((out.stack as string).split('\n')).toHaveLength(DEFAULT_MAX_STACK_LINES)
    expect(out.stack as string).toContain('Error: boom')
    expect(out.stack as string).not.toContain('f29')
    expect(Object.keys(out).sort()).toEqual(['message', 'stack'])
  })

  it('E2 maxStackLines 可配；无 stack 时仅 message', () => {
    const out = redact(longStack('x', 30), { maxStackLines: 3 }) as Record<string, unknown>
    expect((out.stack as string).split('\n')).toHaveLength(3)
    const naked = new Error('naked')
    naked.stack = ''
    expect(redact(naked)).toEqual({ message: 'naked' })
  })

  it('E3 message 内敏感赋值被文本级去敏', () => {
    const out = redact(new Error('token=sk-abcdefghijkl')) as Record<string, unknown>
    expect(out.message).toBe('token=[REDACTED]')
  })

  it('E4 stack 内敏感赋值被去敏（先文本去敏再裁剪）', () => {
    const e = new Error('x')
    e.stack = ['Error: token=sk-LEAKLEAK12345', ...Array.from({ length: 20 }, (_, i) => `    at f${i} (a:${i})`)].join('\n')
    const out = redact(e) as Record<string, unknown>
    expect(out.stack as string).not.toContain('sk-LEAKLEAK12345')
    expect((out.stack as string).split('\n')).toHaveLength(DEFAULT_MAX_STACK_LINES)
  })

  it('E5 嵌套在 args 中的 Error 同样被裁剪', () => {
    const out = redact({ error: longStack('kaboom', 30) }) as Record<string, unknown>
    const err = out.error as Record<string, unknown>
    expect(err.message).toBe('kaboom')
    expect((err.stack as string).split('\n')).toHaveLength(DEFAULT_MAX_STACK_LINES)
    expect(JSON.stringify(out)).not.toContain('f29')
  })
})

// ===========================================================================
// ⑥ 深遍历 / 护栏 / 可序列化
// ===========================================================================
describe('⑥ 深遍历、护栏与可序列化', () => {
  it('F1 深层嵌套中的敏感键也去敏', () => {
    let v: any = { token: 'sk-deep' }
    for (let i = 0; i < 4; i += 1) v = { child: v }
    const out = redact(v)
    expect(JSON.stringify(out)).not.toContain('sk-deep')
    expect(JSON.stringify(out)).toContain(REDACTED)
  })

  it('F2 数组元素（含对象数组）中的敏感 / 金额键去敏', () => {
    const out = redact([{ token: 't' }, { cost: 1 }, { ok: 1 }]) as any[]
    expect(out[0].token).toBe(REDACTED)
    expect(out[1].cost).toBe(REDACTED)
    expect(out[2].ok).toBe(1)
  })

  it('F3 深度超限 → [MaxDepth]（不爆栈）', () => {
    let deep: any = { leaf: 1 }
    for (let i = 0; i < 60; i += 1) deep = { nested: deep }
    const s = JSON.stringify(redact(deep))
    expect(s).toContain(MAX_DEPTH_MARKER)
  })

  it('F4 数组元素上限 → 截断并附 [+N more]', () => {
    const out = redact({ list: [1, 2, 3, 4, 5] }, { maxArrayLength: 2 }) as Record<string, unknown>
    expect(out.list).toEqual([1, 2, '[+3 more]'])
  })

  it('F5 对象键数上限 → 附 __truncated__', () => {
    const out = redact({ a: 1, b: 2, c: 3, d: 4, e: 5 }, { maxEntries: 2 }) as Record<string, unknown>
    expect(out.__truncated__).toBe('[+3 more keys]')
    expect(Object.keys(out)).toHaveLength(3)
  })

  it('F6 Date → ISO；bigint → 字符串；结果 JSON.stringify 不抛', () => {
    const out = redact({ when: new Date('2026-10-12T12:00:00Z'), big: 10n }) as Record<string, unknown>
    expect(out.when).toBe('2026-10-12T12:00:00.000Z')
    expect(out.big).toBe('10')
    expect(() => JSON.stringify(out)).not.toThrow()
  })

  it('F7 菱形共享引用不误判为循环', () => {
    const shared = { x: 1 }
    expect(redact({ a: shared, b: shared })).toEqual({ a: { x: 1 }, b: { x: 1 } })
  })
})

// ===========================================================================
// ⑦ 循环引用
// ===========================================================================
describe('⑦ 循环引用', () => {
  it('G1 默认策略 → 抛 CircularReferenceError（供 exporter 丢弃整行）', () => {
    const c: any = { a: 1 }
    c.self = c
    expect(() => redact(c)).toThrow(CircularReferenceError)
  })

  it('G2 marker 模式 → 替换为 [Circular]', () => {
    const c: any = { a: 1 }
    c.self = c
    expect(redact(c, { onCircular: 'marker' })).toEqual({ a: 1, self: CIRCULAR_MARKER })
  })

  it('G3 exporter：循环 args → 整行丢弃、不抛、后续正常写入', () => {
    const dir = tmp()
    const ex = createFileExporter({ dir, level: 'debug' })
    const c: any = { a: 1 }
    c.self = c
    expect(() => ex.export(msg({ type: 'info', args: ['bad', c] }))).not.toThrow()
    ex.export(msg({ type: 'info', args: ['good-line'] }))
    const content = readLog(dir)
    expect(content).not.toContain('bad')
    expect(content).toContain('good-line')
  })
})

// ===========================================================================
// ⑧ 端到端落盘（env 变量覆盖）+ 全局泄密扫描
// ===========================================================================
describe('⑧ 端到端落盘与全局泄密扫描', () => {
  let saved: string | undefined
  beforeEach(() => {
    saved = process.env[LOG_DIR_ENV]
  })
  afterEach(() => {
    if (saved === undefined) delete process.env[LOG_DIR_ENV]
    else process.env[LOG_DIR_ENV] = saved
  })

  it('H1 `DSH_FINANCE_LOG_DIR` 覆盖生效（createFileExporter 无 dir 参数）', () => {
    const dir = tmp()
    process.env[LOG_DIR_ENV] = dir
    const ex = createFileExporter({ level: 'debug' })
    ex.export(msg({ type: 'info', args: ['hello'] }))
    expect(existsSync(join(dir, LOG_FILE))).toBe(true)
    expect(readLog(dir)).toContain('hello')
  })

  it('H2 复合输入（密钥 + 金额 + 长文本 + Error）落盘 → 全局扫描零命中 + [REDACTED] 出现 + 上下文保留', () => {
    const dir = tmp()
    process.env[LOG_DIR_ENV] = dir
    const ex = createFileExporter({ level: 'debug' })
    ex.export(
      msg({
        type: 'info',
        args: [
          'login token=sk-SECRETSECRET1234 ok',
          {
            apiKey: 'sk-APIKEYAPIKEY1234',
            accessKey: 'AKIAIOSFODNN7EXAMPLE',
            authorization: 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9',
            password: 'hunter2',
            nested: { secret: 'topsecret', symbol: '588000' },
            cost: 12.345678,
            pnl: 98765.43,
            positionValue: 1234567.89,
            strategy: 'x'.repeat(600),
            qty: 500,
            side: 'buy',
          },
        ],
      }),
    )
    ex.export(msg({ type: 'error', args: ['boom', { error: longStack('kaboom', 30) }] }))

    const content = readLog(dir)
    for (const rx of LEAK_RX) expect(rx.test(content), `泄密模式命中：${rx}`).toBe(false)
    for (const leak of [
      'sk-SECRETSECRET1234',
      'sk-APIKEYAPIKEY1234',
      'AKIAIOSFODNN7EXAMPLE',
      'hunter2',
      'topsecret',
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9',
      '12.345678',
      '98765.43',
      '1234567.89',
      'x'.repeat(300),
      'f29',
    ]) {
      expect(content, `不得出现明文：${leak}`).not.toContain(leak)
    }
    expect(content).toContain('[REDACTED]')

    const rec = readRecs(dir)[0]
    expect(rec.msg).toBe('login token=[REDACTED] ok')
    expect(rec.args).toEqual({
      apiKey: REDACTED,
      accessKey: REDACTED,
      authorization: REDACTED,
      password: REDACTED,
      nested: { secret: REDACTED, symbol: '588000' },
      cost: REDACTED,
      pnl: REDACTED,
      positionValue: REDACTED,
      strategy: 'x'.repeat(DEFAULT_MAX_TEXT_LENGTH) + TRUNCATED_SUFFIX,
      qty: 500,
      side: 'buy',
    })
  })

  it('H3 Error 首参：msg 取 stack 但裁剪至前 10 行（保留首行）', () => {
    const dir = tmp()
    process.env[LOG_DIR_ENV] = dir
    const ex = createFileExporter({ level: 'debug' })
    ex.export(msg({ type: 'error', args: [longStack('boom', 30)] }))
    const m = String(readRecs(dir)[0].msg)
    expect(m).toContain('Error: boom')
    expect(m.split('\n')).toHaveLength(DEFAULT_MAX_STACK_LINES)
  })

  it('H4 落盘权限：目录 0o700、文件 0o600', () => {
    const dir = tmp()
    process.env[LOG_DIR_ENV] = dir
    const ex = createFileExporter({ level: 'debug' })
    ex.export(msg({ type: 'info', args: ['perm'] }))
    expect(statSync(dir).mode & 0o777).toBe(0o700)
    expect(statSync(join(dir, LOG_FILE)).mode & 0o777).toBe(0o600)
  })

  it('H5 [修复验证] 裸 sk- 令牌经 free-form msg 落盘 → 遮蔽', () => {
    const dir = tmp()
    process.env[LOG_DIR_ENV] = dir
    const ex = createFileExporter({ level: 'debug' })
    ex.export(msg({ type: 'info', args: ['upstream header: Bearer sk-BARELEAK1234567890'] }))
    const content = readLog(dir)
    expect(content).not.toContain('sk-BARELEAK1234567890')
    expect(content).toContain(REDACTED)
  })
})

// ===========================================================================
// ⑨ redactRecord 语义
// ===========================================================================
describe('⑨ redactRecord', () => {
  it('I1 msg 文本级 + args 深遍历 + 其它字段原样保留', () => {
    const rec = redactRecord({
      ts: 'T',
      level: 'info',
      name: 'dsh-finance',
      msg: 'token=sk-abcdefghijkl',
      args: { password: 'hunter2', symbol: '588000', cost: 1.95, nested: { apiKey: 'k' } },
    })
    expect(rec.msg).toBe('token=[REDACTED]')
    expect(rec.args).toEqual({ password: REDACTED, symbol: '588000', cost: REDACTED, nested: { apiKey: REDACTED } })
    expect(rec.ts).toBe('T')
    expect(rec.name).toBe('dsh-finance')
  })

  it('I2 args 缺省 → 不新增 `args` 键；msg 非字符串 → 不动', () => {
    const rec = redactRecord({ ts: 'T', msg: 'plain' })
    expect('args' in rec).toBe(false)
    const rec2 = redactRecord({ msg: 123 as unknown as string })
    expect(rec2.msg).toBe(123)
  })

  it('I3 redactRecord 默认选项：长文本 msg 被截断；args 循环引用抛错', () => {
    const long = redactRecord({ msg: 'z'.repeat(400) })
    expect(long.msg).toBe('z'.repeat(DEFAULT_MAX_TEXT_LENGTH) + TRUNCATED_SUFFIX)
    const c: any = { a: 1 }
    c.self = c
    expect(() => redactRecord({ args: c })).toThrow(CircularReferenceError)
  })
})

// ===========================================================================
// ⑩ 护栏常量自洽
// ===========================================================================
describe('⑩ 常量与默认值自洽', () => {
  it('J1 默认值与文档一致', () => {
    expect(DEFAULT_MAX_TEXT_LENGTH).toBe(200)
    expect(DEFAULT_MAX_STACK_LINES).toBe(10)
    expect(DEFAULT_MAX_ARRAY_LENGTH).toBe(1000)
    expect(DEFAULT_MAX_ENTRIES).toBe(1000)
    expect(REDACTED).toBe('[REDACTED]')
    expect(TRUNCATED_SUFFIX).toBe('…[truncated]')
    expect(MAX_DEPTH_MARKER).toBe('[MaxDepth]')
    expect(CIRCULAR_MARKER).toBe('[Circular]')
  })

  it('J2 redact 为纯函数：不改动入参', () => {
    const input = { token: 'sk-x', symbol: '588000', nested: { cost: 1 } }
    const snapshot = JSON.parse(JSON.stringify(input))
    redact(input)
    expect(input).toEqual(snapshot)
  })
})

// ===========================================================================
// ⑪ 修复后对抗补充（t100437 · 99f8e48 修复回归）：
//    前缀家族 / Bearer 大小写变体 / JSON 形状 / 一行多键金额 / Error 明文 / 误伤反例
// ===========================================================================
describe('⑪ 修复后对抗补充（前缀家族/变体/JSON/多键/反例）', () => {
  it('K1 已知前缀全家族（sk- / sk-proj- / sk-ant- / gh[pousr]_ / xox[bpoas]- / AKIA）→ 遮蔽', () => {
    const tokens = [
      'sk-ABCDEFGHIJ1234567890',
      'sk-proj-ABCDEFGHIJ1234567890',
      'sk-ant-ABCDEFGHIJ1234567890',
      'ghp_ABCDEFGHIJ1234567890ABCDEF',
      'gho_ABCDEFGHIJ1234567890ABCDEF',
      'ghu_ABCDEFGHIJ1234567890ABCDEF',
      'ghs_ABCDEFGHIJ1234567890ABCDEF',
      'ghr_ABCDEFGHIJ1234567890ABCDEF',
      'xoxb-123456789012-abcdefghijkl',
      'xoxp-123456789012-abcdefghijkl',
      'xoxa-123456789012-abcdefghijkl',
      'xoxo-123456789012-abcdefghijkl',
      'xoxs-123456789012-abcdefghijkl',
      'AKIAIOSFODNN7EXAMPLE',
    ]
    for (const raw of tokens) {
      const out = redactText(`prefix ${raw} suffix`)
      expect(out, raw).not.toContain(raw)
      expect(out, raw).toContain(REDACTED)
    }
  })

  it('K2 `Bearer` 大小写变体（Bearer/BEARER/bearer/BeArEr）→ 遮蔽', () => {
    const secret = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9'
    for (const kw of ['Bearer', 'BEARER', 'bearer', 'BeArEr']) {
      const out = redactText(`${kw} ${secret}`)
      expect(out, kw).not.toContain(secret)
      expect(out, kw).toContain(REDACTED)
    }
  })

  it('K3 JSON 形状 {"authorization":"Bearer …"} / {"apiKey":"sk-…"} → 值整体遮蔽、键名保留', () => {
    expect(redactText('{"authorization":"Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9"}')).toBe(
      '{"authorization":"[REDACTED]"}',
    )
    expect(redactText('{"apiKey":"sk-ABCDEFGHIJ1234567890"}')).toBe('{"apiKey":"[REDACTED]"}')
    // 无引号裸值 → 替换后也不带引号（保持原形态；非 JSON 合法化目标，仅去敏）。
    expect(redactText('{"pnl":-1234.56}')).toBe('{"pnl":[REDACTED]}')
  })

  it('K4 文本形态金额一行多键（空格/逗号/分号分隔）逐个遮蔽；上下文键保留', () => {
    expect(redactText('cost=1 pnl=2')).toBe('cost=[REDACTED] pnl=[REDACTED]')
    expect(redactText('cost=1,pnl=2')).toBe('cost=[REDACTED],pnl=[REDACTED]')
    expect(redactText('cost=1;pnl=2')).toBe('cost=[REDACTED];pnl=[REDACTED]')
    expect(redactText('amount=98765.43 price=3.14 marketValue=1234567.89 positionValue=999')).toBe(
      'amount=[REDACTED] price=[REDACTED] marketValue=[REDACTED] positionValue=[REDACTED]',
    )
    expect(redactText('cost=1.5 pnl=-2 symbol=588000 qty=100')).toBe(
      'cost=[REDACTED] pnl=[REDACTED] symbol=588000 qty=100',
    )
  })

  it('K5 Error.message 内含明文令牌 + 金额 → 均遮蔽（结构化 Error 路径）', () => {
    const e = new Error('fetch failed with Bearer sk-ERRMSG1234567890123 and cost=12.345678')
    const out = redact(e) as Record<string, unknown>
    expect(String(out.message)).not.toContain('sk-ERRMSG1234567890123')
    expect(String(out.message)).not.toContain('12.345678')
    expect(String(out.message)).toContain(REDACTED)
  })

  it('K6 误伤反例：正常短语 / 普通长单词 / task-driven / Bearer of good news 均不被遮蔽', () => {
    for (const text of [
      'Bearer of good news',
      'bearer of good tidings',
      'The task-driven architecture is solid',
      'risk-adjusted-returns-2026',
      'disk-usage-report',
      'internationalization2030405060',
      'The cost of freedom is eternal vigilance',
      'The monkey ate a banana',
    ]) {
      expect(redactText(text), text).toBe(text)
    }
  })

  it('K7 JSON 形状 + 文本多键金额经真实 exporter 落盘 → 全文泄密扫描零命中 + [REDACTED]', () => {
    const dir = tmp()
    const ex = createFileExporter({ dir, level: 'debug' })
    ex.export(msg({ type: 'info', args: ['{"authorization":"Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9"}'] }))
    ex.export(msg({ type: 'warn', args: ['cost=1 pnl=2 amount=98765.43'] }))
    const content = readLog(dir)
    for (const rx of LEAK_RX) expect(rx.test(content), `泄密模式命中：${rx}`).toBe(false)
    expect(content).not.toContain('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9')
    expect(content).not.toContain('98765.43')
    expect(content).toContain(REDACTED)
  })
})
