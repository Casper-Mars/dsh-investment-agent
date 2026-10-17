/**
 * 独立验收（Tester / t100468）：任务-06「日志治理（脱敏扩展 + 保留策略）」。
 *
 * 覆盖验收标准 1–3 与额外必测项 4–13。**不修改被测源码与 Developer 测试**。
 *
 * 安全约束：
 *   - 所有 fs 操作均在 `mkdtempSync(join(tmpdir(), ...))` 下，绝不触碰真实
 *     `~/.dsh-ia/logs`（用例内从不省略 `dir` 选项）；
 *   - 只跑定向文件，不跑全量测试。
 *
 * 说明：本文件中的「⚠️ 观察」用例断言的是**当前实际行为**，用于在报告中标注
 * 文档与实现的口径差异（非验收阻断项）；其余用例断言验收要求的期望行为。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Message } from '@deepseek-ai/cordis'
import {
  AMOUNT_KEY_TOKENS,
  isAmountKey,
  isSymbolKey,
  maskSymbol,
  redact,
  redactRecord,
  redactText,
  REDACTED,
  SYMBOL_KEY_TOKENS,
} from '../src/log/redact.js'
import {
  cleanupExpiredLogs,
  DEFAULT_LOG_RETENTION_DAYS,
  LOG_RETENTION_DAYS_ENV,
  resolveRetentionDays,
} from '../src/log/retention.js'
import {
  createFileExporter,
  DEFAULT_LOG_MAX_SIZE,
} from '../src/log/file-exporter.js'

/** 固定「现在」：2026-10-12T12:00:00Z。 */
const NOW = Date.UTC(2026, 9, 12, 12, 0, 0)
const DAY = 24 * 60 * 60 * 1000
/** 40 天前（相对 NOW）。 */
const OLD_MS = NOW - 40 * DAY

const tmpDirs: string[] = []
const lockedDirs: string[] = []

function mkTmp(prefix = 'tester-t100468-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tmpDirs.push(dir)
  return dir
}

/** 造文件并设置 mtime（非日期命名文件的过期判据）。 */
function touchFile(path: string, mtimeMs: number, content = '{}\n'): void {
  writeFileSync(path, content)
  utimesSync(path, new Date(mtimeMs), new Date(mtimeMs))
}

/** 相对**真实**当前时间的日期文件名（`YYYY-MM-DD`，UTC）。 */
function realDateOffsetDays(days: number): string {
  return new Date(Date.now() + days * DAY).toISOString().slice(0, 10)
}

function makeMessage(partial: Partial<Message> & Pick<Message, 'type'>): Message {
  return { sn: 1, ts: NOW, name: 'dsh-ia', level: 0, args: [], ...partial }
}

function modeOf(path: string): number {
  return statSync(path).mode & 0o777
}

const savedRetention = process.env[LOG_RETENTION_DAYS_ENV]

beforeEach(() => {
  delete process.env[LOG_RETENTION_DAYS_ENV]
})

afterEach(() => {
  if (savedRetention === undefined) delete process.env[LOG_RETENTION_DAYS_ENV]
  else process.env[LOG_RETENTION_DAYS_ENV] = savedRetention
  for (const dir of lockedDirs.splice(0)) {
    try {
      chmodSync(dir, 0o700)
    } catch {
      /* ignore */
    }
  }
  for (const dir of tmpDirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3 })
    } catch {
      /* ignore */
    }
  }
})

// ===========================================================================
// AC11 / AC2：常量与环境变量
// ===========================================================================
describe('AC11 常量与环境变量', () => {
  it('DEFAULT_LOG_MAX_SIZE = 500MB；DEFAULT_LOG_RETENTION_DAYS = 30', () => {
    expect(DEFAULT_LOG_MAX_SIZE).toBe(500 * 1024 * 1024)
    expect(DEFAULT_LOG_MAX_SIZE).toBe(524_288_000)
    expect(DEFAULT_LOG_RETENTION_DAYS).toBe(30)
  })

  it('环境变量名为 DSH_IA_LOG_RETENTION_DAYS', () => {
    expect(LOG_RETENTION_DAYS_ENV).toBe('DSH_IA_LOG_RETENTION_DAYS')
  })

  it('resolveRetentionDays：显式 > 环境变量 > 默认', () => {
    expect(resolveRetentionDays()).toBe(30)
    process.env[LOG_RETENTION_DAYS_ENV] = '7'
    expect(resolveRetentionDays()).toBe(7)
    expect(resolveRetentionDays(3)).toBe(3)
  })

  it('非法值（0 / 负数 / NaN / 空 / 空白 / 非数字）一律回落 30', () => {
    for (const bad of ['0', '-5', 'NaN', '', '   ', 'abc', '1e']) {
      process.env[LOG_RETENTION_DAYS_ENV] = bad
      expect(resolveRetentionDays(), `env=${JSON.stringify(bad)}`).toBe(30)
    }
    expect(resolveRetentionDays(0)).toBe(30)
    expect(resolveRetentionDays(-1)).toBe(30)
    expect(resolveRetentionDays(Number.NaN)).toBe(30)
    expect(resolveRetentionDays(Number.POSITIVE_INFINITY)).toBe(30)
  })

  it('小数天数向下取整（7.9 → 7）', () => {
    expect(resolveRetentionDays(7.9)).toBe(7)
    process.env[LOG_RETENTION_DAYS_ENV] = '14.9'
    expect(resolveRetentionDays()).toBe(14)
  })
})

// ===========================================================================
// AC4：symbol 脱敏口径
// ===========================================================================
describe('AC4 symbol 脱敏口径', () => {
  it('maskSymbol 精确口径：002156 / 588000 / 600519 / AAPL / 1 / 空串', () => {
    expect(maskSymbol('002156')).toBe('00**56')
    expect(maskSymbol('588000')).toBe('58**00')
    expect(maskSymbol('600519')).toBe('60**19')
    expect(maskSymbol('AAPL')).toBe('****')
    expect(maskSymbol('1')).toBe('*')
    expect(maskSymbol('')).toBe('')
  })

  it('maskSymbol 长度不变；≤4 位全 *', () => {
    for (const s of ['1', '12', '123', '1234', '12345', '002156', 'AAPL']) {
      expect(maskSymbol(s)).toHaveLength(s.length)
    }
    expect(maskSymbol('1234')).toBe('****')
    expect(maskSymbol('12345')).toBe('12*45')
  })

  it('SYMBOL_KEY_TOKENS 含 symbol/stockCode/securityCode/ticker 等，且不含裸 code', () => {
    for (const token of ['symbol', 'stockcode', 'securitycode', 'ticker']) {
      expect(SYMBOL_KEY_TOKENS).toContain(token)
    }
    expect(SYMBOL_KEY_TOKENS).not.toContain('code')
    expect(isSymbolKey('symbol')).toBe(true)
    expect(isSymbolKey('stockCode')).toBe(true)
    expect(isSymbolKey('ticker')).toBe(true)
    expect(isSymbolKey('code')).toBe(false)
    expect(isSymbolKey('errorCode')).toBe(false)
  })

  it('结构化对象：symbol 六个口径逐项命中', () => {
    expect(redact({ symbol: '002156' })).toEqual({ symbol: '00**56' })
    expect(redact({ symbol: '588000' })).toEqual({ symbol: '58**00' })
    expect(redact({ ticker: '600519' })).toEqual({ ticker: '60**19' })
    expect(redact({ ticker: 'AAPL' })).toEqual({ ticker: '****' })
    expect(redact({ symbol: '1' })).toEqual({ symbol: '*' })
    expect(redact({ symbol: '' })).toEqual({ symbol: '' })
  })

  it('嵌套对象 / 数组内生效：{a:{symbol}}, [{ticker}], [{symbol}]', () => {
    const out = redact({
      nested: { deep: { symbol: '002156' } },
      list: [{ ticker: 'AAPL' }, { symbol: '588000' }],
    }) as Record<string, unknown>
    expect(out.nested).toEqual({ deep: { symbol: '00**56' } })
    expect(out.list).toEqual([{ ticker: '****' }, { symbol: '58**00' }])
  })

  it('Map 值中的嵌套对象同样生效', () => {
    const out = redact(new Map([['k', { symbol: '002156' }]])) as Record<string, unknown>
    expect(out.k).toEqual({ symbol: '00**56' })
  })

  it('Map 的直接键值对（key=symbol）同样生效', () => {
    // 额外必测项 4 明确要求「嵌套对象/数组/Map 内同样生效」。
    const out = redact(new Map<string, unknown>([['symbol', '002156']])) as Record<string, unknown>
    expect(out.symbol).toBe('00**56')
  })

  it('Map 的直接键值对同样适用敏感 / 金额口径（不得明文落盘）', () => {
    // 纵深验证：Map 分支若绕过键级判定，token / 密码 / 金额会原样输出（fail-open）。
    const out = redact(
      new Map<string, unknown>([
        ['token', 'sk-secret-value'],
        ['password', 'hunter2'],
        ['cost', 123.45],
        ['symbol', '002156'],
      ]),
    ) as Record<string, unknown>
    expect(out).toEqual({
      token: REDACTED,
      password: REDACTED,
      cost: REDACTED,
      symbol: '00**56',
    })
  })

  it('非字符串 symbol 值 → [REDACTED]（数字 / null / 对象）', () => {
    expect(redact({ symbol: 600519 })).toEqual({ symbol: REDACTED })
    expect(redact({ symbol: null })).toEqual({ symbol: REDACTED })
    expect(redact({ symbol: { code: '002156' } })).toEqual({ symbol: REDACTED })
  })
})

// ===========================================================================
// 复验轮 D1：Map 键级脱敏（真实行为，非只读代码）
// ===========================================================================
describe('复验 D1：Map 键级脱敏', () => {
  it('Map 直接键：symbol → 可读遮蔽', () => {
    expect(redact(new Map<string, unknown>([['symbol', '002156']]))).toEqual({
      symbol: '00**56',
    })
  })

  it('Map 直接键：token / cost → [REDACTED]', () => {
    expect(
      redact(new Map<string, unknown>([['token', 'sk-abcdef1234567890']])),
    ).toEqual({ token: REDACTED })
    expect(redact(new Map<string, unknown>([['cost', 123]]))).toEqual({
      cost: REDACTED,
    })
  })

  it('嵌套 Map -> 对象 -> Map：内层 symbol 与 token 均被处理', () => {
    const out = redact(
      new Map<string, unknown>([
        [
          'outer',
          {
            inner: new Map<string, unknown>([
              ['symbol', '002156'],
              ['token', 'sk-abcdef1234567890'],
            ]),
          },
        ],
      ]),
    )
    expect(out).toEqual({
      outer: { inner: { symbol: '00**56', token: REDACTED } },
    })
  })

  it('redactRecord：args 为 Map 时无明文（端到端入口）', () => {
    const out = redactRecord({
      msg: 'payload',
      args: new Map<string, unknown>([
        ['symbol', '002156'],
        ['token', 'sk-abcdef1234567890'],
        ['cost', 123],
      ]),
    })
    expect(out).toEqual({
      msg: 'payload',
      args: { symbol: '00**56', token: REDACTED, cost: REDACTED },
    })
    expect(JSON.stringify(out)).not.toContain('002156')
    expect(JSON.stringify(out)).not.toContain('sk-abcdef1234567890')
  })

  it('maxEntries 对 Map 仍生效：3 个键只输出前 2 个', () => {
    const out = redact(
      new Map<string, unknown>([
        ['symbol', '002156'],
        ['token', 'sk-abcdef1234567890'],
        ['cost', 123],
      ]),
      { maxEntries: 2 },
    ) as Record<string, unknown>
    expect(Object.keys(out)).toEqual(['symbol', 'token'])
    expect(out).toEqual({ symbol: '00**56', token: REDACTED })
  })
})

// ===========================================================================
// AC5：防误伤 code / errorCode / statusCode / httpCode
// ===========================================================================
describe('AC5 防误伤代码类字段', () => {
  it('结构化键 code/errorCode/statusCode/httpCode 原值保留', () => {
    const input = {
      code: '002156',
      errorCode: 'E1001',
      statusCode: 404,
      httpCode: 500,
      symbol: '002156',
    }
    expect(redact(input)).toEqual({
      code: '002156',
      errorCode: 'E1001',
      statusCode: 404,
      httpCode: 500,
      symbol: '00**56',
    })
  })

  it('文本级 code=… / errorCode=… 不被 symbol 口径误伤', () => {
    expect(redactText('code=002156')).toBe('code=002156')
    expect(redactText('errorCode=E1001 statusCode=404')).toBe(
      'errorCode=E1001 statusCode=404',
    )
  })
})

// ===========================================================================
// AC6：金额键扩展
// ===========================================================================
describe('AC6 金额键扩展', () => {
  const keys = [
    'fee',
    'commission',
    'tax',
    'stampDuty',
    'transferFee',
    'unrealized',
    'realized',
    'drawdown',
    'turnover',
    'principal',
    'capital',
    'invested',
    'marketCap',
    'initialCapital',
  ]

  it('词表（子串口径）覆盖全部新增金额键（含 initialCapital ← capital）', () => {
    for (const key of keys) {
      const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, '')
      const covered = AMOUNT_KEY_TOKENS.some((token) => normalized.includes(token))
      expect(covered, `not covered by AMOUNT_KEY_TOKENS: ${key}`).toBe(true)
      expect(isAmountKey(key), `isAmountKey(${key})`).toBe(true)
    }
  })

  it.each(keys)('键 %s → [REDACTED]', (key) => {
    const out = redact({ [key]: 123.45 }) as Record<string, unknown>
    expect(out[key]).toBe(REDACTED)
  })

  it('非金额上下文键保留（qty / side / taskId / traceId / sessionId）', () => {
    const input = {
      qty: 100,
      side: 'buy',
      taskId: 't1',
      traceId: 'tr1',
      sessionId: 's1',
      op: 'add',
      type: 'trade',
    }
    expect(redact(input)).toEqual(input)
  })

  it('⚠️ 已知风险：taxonomy / feedback 等对象键因子串命中被误伤', () => {
    // 归一化后按子串匹配：taxonomy 含 tax、feedback 含 fee。
    expect(isAmountKey('taxonomy')).toBe(true)
    expect(isAmountKey('feedback')).toBe(true)
    expect(redact({ taxonomy: 'tech', feedback: 'good' })).toEqual({
      taxonomy: REDACTED,
      feedback: REDACTED,
    })
    // 文本级反之：tax/fee 有词边界，不误伤（口径不完全一致）。
    expect(redactText('taxonomy=tech feedback=good')).toBe(
      'taxonomy=tech feedback=good',
    )
  })

  it('文本级新增金额键赋值 → [REDACTED]', () => {
    expect(redactText('fee=12.5')).toBe(`fee=${REDACTED}`)
    expect(redactText('stampDuty=0.1 transferFee=5')).toBe(
      `stampDuty=${REDACTED} transferFee=${REDACTED}`,
    )
    expect(redactText('drawdown=0.2 marketCap=1000')).toBe(
      `drawdown=${REDACTED} marketCap=${REDACTED}`,
    )
  })
})

// ===========================================================================
// AC7：文本级脱敏
// ===========================================================================
describe('AC7 文本级脱敏', () => {
  it('symbol=002156 → symbol=00**56', () => {
    expect(redactText('symbol=002156')).toBe('symbol=00**56')
  })

  it('{"ticker":"AAPL"} → {"ticker":"****"}', () => {
    expect(redactText('{"ticker":"AAPL"}')).toBe('{"ticker":"****"}')
  })

  it('既有 token=… → [REDACTED] 不被破坏', () => {
    expect(redactText('token=abc123')).toBe(`token=${REDACTED}`)
    expect(redactText('password=hunter2')).toBe(`password=${REDACTED}`)
    expect(redactText('api_key=xyz')).toBe(`api_key=${REDACTED}`)
  })

  it('查询串不吞后续参数：symbol=002156&x=1', () => {
    expect(redactText('?symbol=002156&x=1')).toBe('?symbol=00**56&x=1')
  })

  it('一行多键：symbol=588000 qty=100 cost=1.5', () => {
    expect(redactText('symbol=588000 qty=100 cost=1.5')).toBe(
      `symbol=58**00 qty=100 cost=${REDACTED}`,
    )
  })

  it('裸令牌（Bearer / sk- / ghp_）整体遮蔽', () => {
    expect(redactText('Authorization: Bearer sk-abcdefghijklmnop')).not.toContain(
      'sk-abcdefghijklmnop',
    )
    expect(
      redactText('key ghp_abcdefghijklmnopqrst'),
    ).not.toContain('ghp_abcdefghijklmnopqrst')
  })
})

// ===========================================================================
// AC8：按天 + 500MB 口径的轮转（注入小 maxSize 验证滚动）
// ===========================================================================
describe('AC2/AC8 按天切分与同日滚动', () => {
  it('注入 maxSize=200B：同日 3 条 → 基础 / -1 / -2 三个文件', () => {
    const dir = mkTmp()
    const exporter = createFileExporter({
      dir,
      level: 'debug',
      maxSize: 200,
      now: () => NOW,
    })
    const big = 'X'.repeat(180)
    for (let i = 0; i < 3; i += 1) {
      exporter.export(makeMessage({ type: 'info', args: [big, { i }] }))
    }
    const names = readdirSync(dir).filter((n) => n.endsWith('.jsonl')).sort()
    expect(names).toEqual(['2026-10-12-1.jsonl', '2026-10-12-2.jsonl', '2026-10-12.jsonl'])
    for (const name of names) {
      const content = readFileSync(join(dir, name), 'utf8').trim()
      expect(content.split('\n').length).toBeGreaterThan(0)
      for (const line of content.split('\n')) expect(() => JSON.parse(line)).not.toThrow()
      expect(statSync(join(dir, name)).size).toBeGreaterThanOrEqual(200)
    }
  })

  it('跨天（message.ts 日期变化）→ 新日期文件，日间不串写', () => {
    const dir = mkTmp()
    const exporter = createFileExporter({ dir, level: 'debug', maxSize: 1024 * 1024, now: () => NOW })
    exporter.export(makeMessage({ type: 'info', args: ['day1'] }))
    exporter.export(makeMessage({ type: 'info', ts: NOW + DAY, args: ['day2'] }))
    expect(existsSync(join(dir, '2026-10-12.jsonl'))).toBe(true)
    expect(existsSync(join(dir, '2026-10-13.jsonl'))).toBe(true)
    expect(readFileSync(join(dir, '2026-10-12.jsonl'), 'utf8')).toContain('day1')
    expect(readFileSync(join(dir, '2026-10-13.jsonl'), 'utf8')).toContain('day2')
  })
})

// ===========================================================================
// AC9：保留清理
// ===========================================================================
describe('AC9 保留清理', () => {
  it('40 天前 2026-08-01.jsonl 删、今日保留；-2 滚动后缀按文件名日期删', () => {
    const dir = mkTmp()
    const old = join(dir, '2026-08-01.jsonl')
    const oldRolled = join(dir, '2026-08-01-2.jsonl')
    const exactly40 = join(dir, '2026-09-02.jsonl')
    const today = join(dir, '2026-10-12.jsonl')
    for (const p of [old, oldRolled, exactly40, today]) writeFileSync(p, '{}\n')

    const result = cleanupExpiredLogs({ dir, now: NOW })
    expect(result.scanned).toBe(4)
    expect(result.deleted.sort()).toEqual([old, oldRolled, exactly40].sort())
    expect(result.degraded).toBe(false)
    expect(existsSync(old)).toBe(false)
    expect(existsSync(oldRolled)).toBe(false)
    expect(existsSync(exactly40)).toBe(false)
    expect(existsSync(today)).toBe(true)
  })

  it('保留边界：29 天前保留、31 天前删除（默认 30 天）', () => {
    const dir = mkTmp()
    const d29 = join(dir, '2026-09-13.jsonl')
    const d31 = join(dir, '2026-09-11.jsonl')
    writeFileSync(d29, '{}\n')
    writeFileSync(d31, '{}\n')
    const result = cleanupExpiredLogs({ dir, now: NOW })
    expect(result.deleted).toEqual([d31])
    expect(existsSync(d29)).toBe(true)
  })

  it('tasks/t1/old.log 按 mtime 删、新文件留；非日志扩展名不动', () => {
    const dir = mkTmp()
    const tasks = join(dir, 'tasks', 't1')
    mkdirSync(tasks, { recursive: true })
    const oldLog = join(tasks, 'old.log')
    const newLog = join(tasks, 'new.log')
    const note = join(tasks, 'note.txt')
    touchFile(oldLog, OLD_MS)
    touchFile(newLog, NOW)
    touchFile(note, OLD_MS)

    const result = cleanupExpiredLogs({ dir, now: NOW })
    expect(result.scanned).toBe(2)
    expect(result.deleted).toEqual([oldLog])
    expect(result.degraded).toBe(false)
    expect(existsSync(oldLog)).toBe(false)
    expect(existsSync(newLog)).toBe(true)
    expect(existsSync(note)).toBe(true)
  })

  it('目录与符号链接不删；符号链接不计入 scanned', () => {
    const dir = mkTmp()
    const sub = join(dir, 'tasks', 't2')
    mkdirSync(sub, { recursive: true })
    const old = join(dir, '2026-08-01.jsonl')
    writeFileSync(old, '{}\n')
    const target = join(dir, 'target.bin')
    writeFileSync(target, 'keep')
    const linkFile = join(dir, '2026-08-02.jsonl')
    symlinkSync(target, linkFile)
    const linkedDir = join(dir, 'linked')
    symlinkSync(sub, linkedDir)

    const result = cleanupExpiredLogs({ dir, now: NOW })
    expect(result.scanned).toBe(1)
    expect(result.deleted).toEqual([old])
    expect(existsSync(old)).toBe(false)
    expect(existsSync(linkFile)).toBe(true)
    expect(existsSync(target)).toBe(true)
    expect(existsSync(linkedDir)).toBe(true)
    expect(existsSync(sub)).toBe(true)
  })

  it('非法日期文件名回落 mtime（新 mtime → 保留）', () => {
    const dir = mkTmp()
    const invalid = join(dir, '2026-13-40.jsonl')
    touchFile(invalid, NOW)
    const result = cleanupExpiredLogs({ dir, now: NOW })
    expect(result.scanned).toBe(1)
    expect(result.deleted).toEqual([])
  })

  it('目录不存在 / 空目录：不抛、零计数、非降级', () => {
    const dir = join(mkTmp(), 'nope')
    expect(() => cleanupExpiredLogs({ dir, now: NOW })).not.toThrow()
    expect(cleanupExpiredLogs({ dir, now: NOW })).toEqual({
      deleted: [],
      scanned: 0,
      degraded: false,
    })
    expect(cleanupExpiredLogs({ dir: mkTmp(), now: NOW })).toEqual({
      deleted: [],
      scanned: 0,
      degraded: false,
    })
  })
})

// ===========================================================================
// AC10：exporter 集成
// ===========================================================================
describe('AC10 exporter 保留清理集成', () => {
  it('创建时清理一次（40 天前文件被删）', () => {
    const dir = mkTmp()
    const old = join(dir, `${realDateOffsetDays(-40)}.jsonl`)
    writeFileSync(old, '{}\n')
    createFileExporter({ dir, level: 'debug', retentionDays: 30, now: () => Date.now() })
    expect(existsSync(old)).toBe(false)
  })

  it('同一天多次 export() 不重复清理', () => {
    const dir = mkTmp()
    const exporter = createFileExporter({
      dir,
      level: 'debug',
      retentionDays: 30,
      now: () => NOW,
    })
    const oldAfter = join(dir, `${realDateOffsetDays(-40)}.jsonl`)
    writeFileSync(oldAfter, '{}\n')
    exporter.export(makeMessage({ type: 'info', args: ['a'] }))
    exporter.export(makeMessage({ type: 'info', args: ['b'] }))
    expect(existsSync(oldAfter)).toBe(true)
  })

  it('跨天首次写盘触发清理', () => {
    const dir = mkTmp()
    let clock = NOW
    const exporter = createFileExporter({
      dir,
      level: 'debug',
      retentionDays: 30,
      now: () => clock,
    })
    const oldAfter = join(dir, `${realDateOffsetDays(-40)}.jsonl`)
    writeFileSync(oldAfter, '{}\n')
    exporter.export(makeMessage({ type: 'info', args: ['same-day'] }))
    expect(existsSync(oldAfter)).toBe(true)

    clock = NOW + DAY
    exporter.export(makeMessage({ type: 'info', ts: clock, args: ['next-day'] }))
    expect(existsSync(oldAfter)).toBe(false)
    expect(existsSync(join(dir, '2026-10-13.jsonl'))).toBe(true)
  })

  it('清理抛错 / 删除失败不影响写盘（只读子目录降级）', () => {
    const dir = mkTmp()
    const locked = join(dir, 'locked')
    mkdirSync(locked)
    lockedDirs.push(locked)
    const lockedOld = join(locked, 'old.log')
    touchFile(lockedOld, OLD_MS)
    chmodSync(locked, 0o500)

    const result = cleanupExpiredLogs({ dir, now: NOW })
    expect(result.degraded).toBe(true)
    expect(result.deleted).toEqual([])
    expect(existsSync(lockedOld)).toBe(true)

    const exporter = createFileExporter({ dir, level: 'debug', now: () => NOW })
    expect(() => exporter.export(makeMessage({ type: 'info', args: ['ok'] }))).not.toThrow()
    expect(existsSync(join(dir, '2026-10-12.jsonl'))).toBe(true)
  })

  it('Map 作为 args 嵌套值经 exporter 落盘：敏感键不得明文（端到端）', () => {
    const dir = mkTmp()
    const exporter = createFileExporter({ dir, level: 'debug', now: () => NOW })
    exporter.export(
      makeMessage({
        type: 'info',
        args: ['payload', { extra: new Map<string, unknown>([['token', 'sk-secret-value']]) }],
      }),
    )
    const written = readFileSync(join(dir, '2026-10-12.jsonl'), 'utf8')
    expect(written).not.toContain('sk-secret-value')
    expect(written).toContain(REDACTED)
  })

  it('now 注入为统一时间源：截止线随之移动，窗口外删除、窗口内保留', () => {
    // 新契约（D2 修复后）：`now()` 既控制跨天门控，也作为清理截止线。
    // 注入 now = 真实时间 + 40 天、保留 30 天 → 截止线 = 真实时间 + 10 天。
    const dir = mkTmp()
    const outside = join(dir, `${realDateOffsetDays(-2)}.jsonl`)
    const inside = join(dir, `${realDateOffsetDays(20)}.jsonl`)
    writeFileSync(outside, '{}\n')
    writeFileSync(inside, '{}\n')
    const futureClock = Date.now() + 40 * DAY
    createFileExporter({ dir, level: 'debug', retentionDays: 30, now: () => futureClock })
    expect(existsSync(outside)).toBe(false)
    expect(existsSync(inside)).toBe(true)
  })
})

// ===========================================================================
// AC12：权限不变
// ===========================================================================
describe('AC12 目录 0700 / 文件 0600', () => {
  it('预置 0755 目录被收紧为 0700；新建文件 0600', () => {
    const dir = mkTmp()
    chmodSync(dir, 0o755)
    const exporter = createFileExporter({ dir, level: 'debug', now: () => NOW })
    exporter.export(makeMessage({ type: 'info', args: ['perm'] }))
    const file = join(dir, '2026-10-12.jsonl')
    expect(modeOf(dir)).toBe(0o700)
    expect(modeOf(file)).toBe(0o600)
  })

  it('已存在 0644 文件被 chmod 兜底为 0600', () => {
    const dir = mkTmp()
    const file = join(dir, '2026-10-12.jsonl')
    writeFileSync(file, '')
    chmodSync(file, 0o644)
    expect(modeOf(file)).toBe(0o644)
    const exporter = createFileExporter({ dir, level: 'debug', now: () => NOW })
    exporter.export(makeMessage({ type: 'info', args: ['chmod'] }))
    expect(modeOf(file)).toBe(0o600)
  })
})

// ===========================================================================
// AC13：tmp 隔离（结构性自证，不触碰真实 ~/.dsh-ia/logs）
// ===========================================================================
describe('AC13 全程 tmp 隔离', () => {
  it('本 spec 使用的目录均位于系统临时目录下', () => {
    const dir = mkTmp()
    expect(dir.startsWith(tmpdir())).toBe(true)
    // 所有 exporter 调用均显式传 dir（见各用例），不依赖默认 ~/.dsh-ia/logs。
    const exporter = createFileExporter({ dir, level: 'debug', now: () => NOW })
    exporter.export(makeMessage({ type: 'info', args: ['iso'] }))
    expect(readdirSync(dir).length).toBe(1)
  })
})
