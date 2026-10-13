/**
 * 字段级去敏（`src/log/redact.ts`，里程碑 M5「去敏」）单元 + 集成测试。
 *
 * 覆盖（对齐任务卡验收标准）：
 *   1. 敏感键（token/secret/key/password/authorization/apiKey/…）→ 值 `[REDACTED]`（保留键名）；
 *   2. 金额 / 成本键（cost/amount/price/pnl/profit/value/…）→ `[REDACTED]`；保留 symbol/qty/op/type/side/sessionId/taskId/traceId；
 *   3. 长文本键（strategy/content/text/…）超阈值 → 截断 + 省略标记；
 *   4. `Error` 实例 → 仅 `{ message, stack: 前 N 行 }`；
 *   5. 护栏：深度 / 超大数组 / 超大对象 / 循环引用（默认抛错以保持 exporter「丢弃整行」行为）；
 *   6. 集成：文件 exporter 写盘前统一去敏 → 落盘 JSONL **无明文密钥 / 无完整金额 / 无策略全文**；
 *   7. **全局泄密扫描**：对生成的 JSONL 全文做模式扫描（`sk-…`、`Bearer …`、明文口令等）零命中，
 *      且 `[REDACTED]` 确实出现（证明去敏生效、非空转）。
 */
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Message } from '@deepseek-ai/cordis'
import {
  AMOUNT_KEY_TOKENS,
  CIRCULAR_MARKER,
  CircularReferenceError,
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

/** 固定测试时间：2026-10-12T12:00:00Z。 */
const T1 = Date.UTC(2026, 9, 12, 12, 0, 0)

/** 构造一条 cordis `Message`（仅填本任务关心字段）。 */
function makeMessage(partial: Partial<Message> & Pick<Message, 'type'>): Message {
  return { sn: 1, ts: T1, name: 'dsh-ia', level: 0, args: [], ...partial }
}

const tmpDirs: string[] = []
function mkTmp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-ia-redact-'))
  tmpDirs.push(dir)
  return dir
}

afterEach(() => {
  for (const d of tmpDirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  }
})

/** 读取落地文件全文。 */
function readLog(dir: string): string {
  return readFileSync(join(dir, '2026-10-12.jsonl'), 'utf8')
}

/** 读取落地文件为记录数组。 */
function readRecords(dir: string): Array<Record<string, unknown>> {
  return readLog(dir)
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as Record<string, unknown>)
}

/** 造一个「栈足够长」的错误（用于验证 stack 裁剪）。 */
function makeLongStackError(message: string, frames: number): Error {
  const err = new Error(message)
  err.stack = ['Error: ' + message, ...Array.from({ length: frames }, (_, i) => `    at frame${i} (file.ts:${i}:1)`)].join('\n')
  return err
}

// ===========================================================================
// ① 敏感键 → [REDACTED]（保留键名）
// ===========================================================================
describe('① 敏感键去敏（保留键名）', () => {
  it('覆盖 token/secret/key/password/passwd/authorization/auth/credential/cookie/apiKey/api_key/accessKey/privateKey', () => {
    const input = {
      token: 'sk-abcdefghijklmnop',
      secret: 's3cr3t',
      key: 'K',
      password: 'hunter2',
      passwd: 'hunter2',
      authorization: 'Bearer eyJhbGciOi.J9',
      auth: 'basic',
      credential: 'cred',
      cookie: 'session=abc',
      apiKey: 'AKIA1234567890',
      api_key: 'AKIA1234567890',
      accessKey: 'ACCESS',
      privateKey: 'PRIVATE',
    }
    const out = redact(input) as Record<string, unknown>
    for (const k of Object.keys(input)) {
      expect(out[k], `键 ${k} 应被遮蔽`).toBe(REDACTED)
    }
    // 键名保留（结构可排障）。
    expect(Object.keys(out).sort()).toEqual(Object.keys(input).sort())
  })

  it('嵌套对象 / 数组内同样生效，且非敏感键原样保留', () => {
    const out = redact({
      outer: { secret: 'v', symbol: '588000' },
      list: [{ token: 't', qty: 100 }, { safe: 'ok' }],
    }) as Record<string, unknown>
    expect((out.outer as Record<string, unknown>).secret).toBe(REDACTED)
    expect((out.outer as Record<string, unknown>).symbol).toBe('588000')
    expect(((out.list as unknown[])[0] as Record<string, unknown>).token).toBe(REDACTED)
    expect(((out.list as unknown[])[0] as Record<string, unknown>).qty).toBe(100)
    expect(((out.list as unknown[])[1] as Record<string, unknown>).safe).toBe('ok')
  })

  it('键名匹配大小写 / 分隔符无关（API-KEY / ApiKey / api_key 均命中）', () => {
    for (const k of ['API-KEY', 'ApiKey', 'api_key', 'API_KEY', 'Token', 'PASSWORD']) {
      expect(isSensitiveKey(k), k).toBe(true)
    }
    expect(isSensitiveKey('symbol')).toBe(false)
    expect(isSensitiveKey('taskId')).toBe(false)
  })

  it('词表常量至少覆盖任务卡要求的键', () => {
    for (const need of ['token', 'secret', 'key', 'password', 'passwd', 'authorization', 'auth', 'credential', 'cookie', 'apikey', 'accesskey', 'privatekey']) {
      expect(SENSITIVE_KEY_TOKENS).toContain(need)
    }
  })
})

// ===========================================================================
// ② 金额 / 成本键 → [REDACTED]；上下文键保留
// ===========================================================================
describe('② 金额 / 成本键去敏', () => {
  it('cost/costPrice/amount/price/marketValue/positionValue/pnl/profit/value → [REDACTED]', () => {
    const input = {
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
    for (const k of Object.keys(input)) {
      expect(out[k], `键 ${k} 应被遮蔽`).toBe(REDACTED)
    }
    expect(isAmountKey('cost')).toBe(true)
    expect(isAmountKey('marketValue')).toBe(true)
    expect(isAmountKey('symbol')).toBe(false)
    expect(AMOUNT_KEY_TOKENS).toContain('pnl')
  })

  it('保留 symbol/qty/op/type/side/sessionId/taskId/traceId 等上下文', () => {
    const input = {
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
    const out = redact(input) as Record<string, unknown>
    expect(out).toEqual(input)
  })
})

// ===========================================================================
// ③ 长文本键截断（防策略全文落盘）
// ===========================================================================
describe('③ 长文本键截断', () => {
  it('strategy 超阈值 → 前 200 字符 + 省略标记；短文本不动', () => {
    const long = 'x'.repeat(600)
    const out = redact({ strategy: long, content: 'short' }) as Record<string, unknown>
    const s = out.strategy as string
    expect(s.length).toBe(DEFAULT_MAX_TEXT_LENGTH + TRUNCATED_SUFFIX.length)
    expect(s.endsWith(TRUNCATED_SUFFIX)).toBe(true)
    expect(s).not.toContain('x'.repeat(300))
    expect(out.content).toBe('short')
  })

  it('长文本键集合覆盖 text/body/content/strategy/prompt/message', () => {
    for (const k of ['text', 'body', 'content', 'strategy', 'prompt', 'message']) {
      expect(isLongTextKey(k), k).toBe(true)
    }
    expect(LONG_TEXT_KEYS).toContain('strategy')
    expect(isLongTextKey('messageId')).toBe(false)
  })

  it('阈值可配', () => {
    const out = redact({ strategy: 'y'.repeat(50) }, { maxTextLength: 10 }) as Record<string, unknown>
    expect(out.strategy).toBe('y'.repeat(10) + TRUNCATED_SUFFIX)
  })
})

// ===========================================================================
// ④ Error 实例 → { message, stack: 前 N 行 }
// ===========================================================================
describe('④ Error 对象裁剪', () => {
  it('仅保留 message + 前 N 行 stack（默认 10），超出被裁', () => {
    const out = redact(makeLongStackError('boom', 30)) as Record<string, unknown>
    expect(out.message).toBe('boom')
    const stack = out.stack as string
    expect(stack.split('\n')).toHaveLength(DEFAULT_MAX_STACK_LINES)
    expect(stack).toContain('Error: boom')
    expect(stack).not.toContain('frame29')
  })

  it('N 可配；无 stack 时仅 message', () => {
    const out = redact(makeLongStackError('x', 30), { maxStackLines: 3 }) as Record<string, unknown>
    expect((out.stack as string).split('\n')).toHaveLength(3)

    const noStack = new Error('naked')
    noStack.stack = ''
    const out2 = redact(noStack) as Record<string, unknown>
    expect(out2).toEqual({ message: 'naked' })
  })

  it('Error 的 message 内敏感赋值也被文本级去敏', () => {
    const out = redact(new Error('token=sk-abcdefghijkl')) as Record<string, unknown>
    expect(out.message).toBe('token=[REDACTED]')
  })
})

// ===========================================================================
// ⑤ 护栏：深度 / 超大 / 循环引用
// ===========================================================================
describe('⑤ 护栏（深度 / 体积 / 循环）', () => {
  it('深度超限 → [MaxDepth] 标记（不爆栈）', () => {
    let deep: Record<string, unknown> = { leaf: 1 }
    for (let i = 0; i < 50; i += 1) deep = { nested: deep }
    const out = JSON.stringify(redact(deep))
    expect(out).toContain(MAX_DEPTH_MARKER)
  })

  it('超大数组截断并附 [+N more]', () => {
    const out = redact({ list: [1, 2, 3, 4, 5] }, { maxArrayLength: 2 }) as Record<string, unknown>
    expect(out.list).toEqual([1, 2, '[+3 more]'])
  })

  it('超大对象截断并附 [+N more keys]', () => {
    const out = redact({ a: 1, b: 2, c: 3, d: 4, e: 5 }, { maxEntries: 2 }) as Record<string, unknown>
    expect(out.__truncated__).toBe('[+3 more keys]')
    expect(Object.keys(out)).toHaveLength(3)
  })

  it('循环引用（默认）→ 抛 CircularReferenceError（保持 exporter 丢弃整行）', () => {
    const circular: Record<string, unknown> = { a: 1 }
    circular.self = circular
    expect(() => redact(circular)).toThrow(CircularReferenceError)
  })

  it('循环引用（marker 模式）→ 替换为 [Circular]', () => {
    const circular: Record<string, unknown> = { a: 1 }
    circular.self = circular
    const out = redact(circular, { onCircular: 'marker' }) as Record<string, unknown>
    expect(out.a).toBe(1)
    expect(out.self).toBe(CIRCULAR_MARKER)
  })

  it('非循环的共享引用（菱形）不误判为循环', () => {
    const shared = { x: 1 }
    const out = redact({ a: shared, b: shared }) as Record<string, unknown>
    expect(out).toEqual({ a: { x: 1 }, b: { x: 1 } })
  })

  it('Date → ISO；bigint → 字符串（保证 JSON 可序列化）', () => {
    const out = redact({ when: new Date('2026-10-12T12:00:00Z'), big: 10n }) as Record<string, unknown>
    expect(out.when).toBe('2026-10-12T12:00:00.000Z')
    expect(out.big).toBe('10')
    expect(() => JSON.stringify(out)).not.toThrow()
  })
})

// ===========================================================================
// ⑥ redactText / redactRecord
// ===========================================================================
describe('⑥ 文本级 / 记录级去敏', () => {
  it('key=value / key: value 形态敏感赋值 → 值 [REDACTED]', () => {
    expect(redactText('token=sk-abcdefghijkl')).toBe('token=[REDACTED]')
    expect(redactText('password: hunter2')).toBe('password: [REDACTED]')
    expect(redactText('authorization=Bearer eyJhbGciOi.J9')).toBe('authorization=[REDACTED]')
    expect(redactText('{"apiKey":"AKIA1234567890"}')).toBe('{"apiKey":"[REDACTED]"}')
  })

  it('非敏感赋值 / 普通文本不变', () => {
    expect(redactText('n=7 s=x f=2.5')).toBe('n=7 s=x f=2.5')
    expect(redactText('symbol=588000')).toBe('symbol=588000')
  })

  it('疑似 stack → 裁剪前 N 行；长文本 → 截断', () => {
    const stack = makeLongStackError('boom', 30).stack as string
    expect(redactText(stack).split('\n')).toHaveLength(DEFAULT_MAX_STACK_LINES)
    expect(redactText('z'.repeat(400))).toBe('z'.repeat(DEFAULT_MAX_TEXT_LENGTH) + TRUNCATED_SUFFIX)
  })

  it('redactRecord 同时覆盖 msg（文本级）与 args（深遍历）', () => {
    const rec = redactRecord({
      ts: 'T',
      msg: 'token=sk-abcdefghijkl',
      args: { password: 'hunter2', symbol: '588000', cost: 1.95 },
    })
    expect(rec.msg).toBe('token=[REDACTED]')
    expect(rec.args).toEqual({ password: REDACTED, symbol: '588000', cost: REDACTED })
    expect(rec.ts).toBe('T')
  })
})

// ===========================================================================
// ⑦ 集成：文件 exporter 写盘前统一去敏
// ===========================================================================
describe('⑦ 集成：exporter 落盘去敏（无明文密钥 / 金额 / 策略全文）', () => {
  it('密钥 / 金额 / 策略全文均不落盘；[REDACTED] 出现；上下文保留', () => {
    const dir = mkTmp()
    const exporter = createFileExporter({ dir, level: 'debug' })
    exporter.export(
      makeMessage({
        type: 'info',
        args: [
          'login token=sk-SECRETSECRET1234',
          {
            apiKey: 'sk-APIKEYAPIKEY1234',
            password: 'hunter2',
            authorization: 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9',
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

    const content = readLog(dir)
    // 明文一律不落盘。
    for (const leak of [
      'sk-SECRETSECRET1234',
      'sk-APIKEYAPIKEY1234',
      'hunter2',
      'topsecret',
      'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9',
      '12.345678',
      '98765.43',
      '1234567.89',
      'x'.repeat(300),
    ]) {
      expect(content, `不得出现明文: ${leak}`).not.toContain(leak)
    }
    // 去敏确实生效（非空转）。
    expect(content).toContain(REDACTED)
    // 上下文键保留。
    const rec = readRecords(dir)[0]
    expect(rec.msg).toBe('login token=[REDACTED]')
    expect(rec.args).toEqual({
      apiKey: REDACTED,
      password: REDACTED,
      authorization: REDACTED,
      nested: { secret: REDACTED, symbol: '588000' },
      cost: REDACTED,
      pnl: REDACTED,
      positionValue: REDACTED,
      strategy: 'x'.repeat(DEFAULT_MAX_TEXT_LENGTH) + TRUNCATED_SUFFIX,
      qty: 500,
      side: 'buy',
    })
  })

  it('嵌套 Error 参数 → 落盘仅 message + 前 N 行 stack', () => {
    const dir = mkTmp()
    const exporter = createFileExporter({ dir, level: 'debug' })
    exporter.export(
      makeMessage({ type: 'error', args: ['task failed', { error: makeLongStackError('kaboom', 30) }] }),
    )
    const rec = readRecords(dir)[0]
    const err = (rec.args as Record<string, unknown>).error as Record<string, unknown>
    expect(err.message).toBe('kaboom')
    expect((err.stack as string).split('\n')).toHaveLength(DEFAULT_MAX_STACK_LINES)
    expect(readLog(dir)).not.toContain('frame29')
  })

  it('Error 首参：msg 取 stack，但被裁剪至前 N 行（保留 message 行）', () => {
    const dir = mkTmp()
    const exporter = createFileExporter({ dir, level: 'debug' })
    exporter.export(makeMessage({ type: 'error', args: [makeLongStackError('boom', 30)] }))
    const rec = readRecords(dir)[0]
    const msg = String(rec.msg)
    expect(msg).toContain('Error: boom')
    expect(msg.split('\n')).toHaveLength(DEFAULT_MAX_STACK_LINES)
  })

  it('循环引用 args → 整行丢弃（保持 M2 既有行为），后续正常写入', () => {
    const dir = mkTmp()
    const exporter = createFileExporter({ dir, level: 'debug' })
    const circular: Record<string, unknown> = { a: 1 }
    circular.self = circular
    exporter.export(makeMessage({ type: 'info', args: ['bad', circular] }))
    exporter.export(makeMessage({ type: 'info', args: ['good'] }))
    const content = readLog(dir)
    expect(content).not.toContain('bad')
    expect(content).toContain('good')
  })

  it('redact 选项可注入 exporter（自定义 replacement）', () => {
    const dir = mkTmp()
    const exporter = createFileExporter({ dir, level: 'debug', redact: { replacement: '***' } })
    exporter.export(makeMessage({ type: 'info', args: ['x', { token: 'sk-abcdefghijkl' }] }))
    expect(readRecords(dir)[0].args).toEqual({ token: '***' })
  })
})

// ===========================================================================
// ⑨ 文本级裸令牌扫描 + 文本级金额键 + 扩展词表（t100437 缺陷修复回归）
// ===========================================================================
describe('⑨ 裸令牌 / 文本级金额 / 扩展词表（缺陷修复回归）', () => {
  it('裸 `Bearer <token>`（无键名）→ 整体遮蔽；正常短语不误伤', () => {
    const out = redactText('upstream said: Bearer sk-ABCDEFGHIJ1234567890')
    expect(out).not.toContain('sk-ABCDEFGHIJ1234567890')
    expect(out).toContain(REDACTED)
    expect(redactText('Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9')).toBe(
      'Authorization: [REDACTED]',
    )
    // 形态判据（最小长度）：正常短语里的 `Bearer` 不被误伤。
    expect(redactText('Bearer of good news')).toBe('Bearer of good news')
  })

  it('裸已知前缀令牌（sk-/sk-proj-/ghp_/xoxb-/AKIA）→ 遮蔽；词首边界不误伤正常词', () => {
    for (const raw of [
      'sk-ABCDEFGHIJ1234567890',
      'sk-proj-ABCDEFGHIJ1234567890',
      'sk-ant-ABCDEFGHIJ1234567890',
      'ghp_ABCDEFGHIJ1234567890ABCDEFGHIJ',
      'xoxb-123456789012-abcdefghijkl',
      'AKIAIOSFODNN7EXAMPLE',
    ]) {
      const out = redactText(`request failed, key was ${raw}`)
      expect(out, raw).not.toContain(raw)
      expect(out, raw).toContain(REDACTED)
    }
    // `sk` 前紧邻字母时无词边界 → 正常词 `task-driven-…` 不被误伤。
    expect(redactText('task-driven-architecture-2099')).toBe('task-driven-architecture-2099')
  })

  it('文本形态金额（cost=… / cost:…）；一行内多键（空格 / 逗号分隔）全部处理', () => {
    expect(redactText('cost=12.345678')).toBe('cost=[REDACTED]')
    expect(redactText('cost: 12.345678')).toBe('cost: [REDACTED]')
    expect(redactText('cost=12.345678 pnl=-99999.5')).toBe('cost=[REDACTED] pnl=[REDACTED]')
    expect(redactText('cost=1,pnl=2')).toBe('cost=[REDACTED],pnl=[REDACTED]')
    expect(redactText('amount=98765.43 price=3.14 profit=1 value=2')).toBe(
      'amount=[REDACTED] price=[REDACTED] profit=[REDACTED] value=[REDACTED]',
    )
    // 非金额 / 非敏感键不受影响。
    expect(redactText('symbol=588000 qty=100')).toBe('symbol=588000 qty=100')
  })

  it('扩展词表（balance/total/equity/nav/cash/shares/pwd）：结构化 + 文本级均遮蔽，上下文保留', () => {
    const keys = ['balance', 'total', 'equity', 'nav', 'cash', 'shares', 'pwd']
    const input: Record<string, unknown> = {}
    for (const k of keys) input[k] = 123
    const out = redact(input) as Record<string, unknown>
    for (const k of keys) {
      expect(out[k], k).toBe(REDACTED)
      expect(isSensitiveKey(k), k).toBe(true)
    }
    expect(redactText('balance=1000 equity=500 nav=7')).toBe(
      'balance=[REDACTED] equity=[REDACTED] nav=[REDACTED]',
    )
    // 既有上下文键仍保留。
    expect(redact({ symbol: '588000', qty: 100, side: 'buy', taskId: 't' })).toEqual({
      symbol: '588000',
      qty: 100,
      side: 'buy',
      taskId: 't',
    })
  })

  it('Error.message / stack 内裸令牌 → 文本级遮蔽', () => {
    const e = new Error('auth failed: Bearer sk-BAREMESSAGE1234567890')
    const out = redact(e) as Record<string, unknown>
    expect(String(out.message)).not.toContain('sk-BAREMESSAGE1234567890')

    const e2 = new Error('boom')
    e2.stack = [
      'Error: boom',
      '    at fetch (Bearer sk-BARESTACK12345678901234)',
      '    at main (a:1)',
    ].join('\n')
    const out2 = redact(e2) as Record<string, unknown>
    expect(String(out2.stack)).not.toContain('sk-BARESTACK12345678901234')
    expect((out2.stack as string).split('\n')).toHaveLength(3)
  })

  it('裸令牌 / 文本金额经真实 exporter 落盘 → 全文泄密扫描零命中 + [REDACTED] 出现', () => {
    const dir = mkTmp()
    const exporter = createFileExporter({ dir, level: 'debug' })
    exporter.export(makeMessage({ type: 'info', args: ['upstream header: Bearer sk-BARELEAK1234567890'] }))
    exporter.export(
      makeMessage({ type: 'warn', args: ['cost=12.345678 pnl=-99999.5 sk-job-ABC1234567890XYZ'] }),
    )
    exporter.export(makeMessage({ type: 'error', args: [new Error('failed with Bearer sk-ERRBARE12345678901234')] }))

    const content = readLog(dir)
    for (const leak of [
      'sk-BARELEAK1234567890',
      '12.345678',
      '-99999.5',
      'sk-ERRBARE12345678901234',
      'sk-job-ABC1234567890XYZ',
    ]) {
      expect(content, `不得出现明文: ${leak}`).not.toContain(leak)
    }
    for (const rx of [/sk-[A-Za-z0-9]{10,}/, /Bearer\s+\S+/, /AKIA[0-9A-Z]{8,}/]) {
      expect(rx.test(content), `泄密模式命中: ${rx}`).toBe(false)
    }
    expect(content).toContain(REDACTED)
  })
})

// ===========================================================================
// ⑧ 全局泄密扫描（落盘全文）
// ===========================================================================
describe('⑧ 全局泄密扫描', () => {
  /** 常见泄密形态正则（命中即视为泄漏）。 */
  const LEAK_PATTERNS: RegExp[] = [
    /sk-[A-Za-z0-9]{10,}/, // OpenAI 风格密钥
    /Bearer\s+\S+/, // Bearer 令牌
    /AKIA[0-9A-Z]{8,}/, // AWS Access Key
    /"password"\s*:\s*"(?!\[REDACTED\])/i, // 明文 password 字段
    /"authorization"\s*:\s*"(?!\[REDACTED\])/i,
    /"token"\s*:\s*"(?!\[REDACTED\])/i,
  ]

  it('混合输入落盘后全文扫描零命中，且 [REDACTED] 出现', () => {
    const dir = mkTmp()
    const exporter = createFileExporter({ dir, level: 'debug' })
    // 多种消息形态：文本级 + 结构化 + 错误 + 长文本。
    exporter.export(
      makeMessage({ type: 'info', args: ['auth token=sk-ABCDEFGHIJ1234567890 ok'] }),
    )
    exporter.export(
      makeMessage({
        type: 'warn',
        args: [
          'x',
          {
            apiKey: 'sk-ZZZZZZZZZZ1234567890',
            accessKey: 'AKIAIOSFODNN7EXAMPLE',
            authorization: 'Bearer eyJhbGciOi.J9.Sig',
            password: 'correct-horse-battery',
            cost: 123456.789,
            strategy: 'buy-and-hold '.repeat(100),
            symbol: '588000',
            qty: 1000,
          },
        ],
      }),
    )
    exporter.export(makeMessage({ type: 'error', args: ['boom', { error: new Error('token=sk-LEAKLEAKLEAK123') }] }))

    const content = readLog(dir)
    for (const rx of LEAK_PATTERNS) {
      expect(rx.test(content), `泄密模式命中: ${rx}`).toBe(false)
    }
    for (const leak of ['sk-ABCDEFGHIJ1234567890', 'sk-ZZZZZZZZZZ1234567890', 'AKIAIOSFODNN7EXAMPLE', 'correct-horse-battery', 'sk-LEAKLEAKLEAK123']) {
      expect(content, `不得出现明文: ${leak}`).not.toContain(leak)
    }
    expect(content).toContain(REDACTED)
    // 无显式设置 replacement，须为默认字面量。
    expect(content).toContain('[REDACTED]')
  })
})
