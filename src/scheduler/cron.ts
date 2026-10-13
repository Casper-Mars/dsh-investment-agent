/**
 * scheduler/cron.ts —— 标准 5 段 cron 解析与「下一触发时刻」计算。
 *
 * 唯一权威设计文档：《感知层详细设计（dsh-ia 插件）》 v0.7。
 *
 * 硬约束（§2.2 / §7）：
 *   - **时区锁定 `Asia/Shanghai`**：next() 以 Asia/Shanghai 视角计算，与本机时区无关。
 *   - **最小粒度 = 分钟**：5 段 cron（分 时 日 月 周），无秒字段。
 *   - **零第三方 cron 库**：纯 TS，仅依赖 `node:` 内置。
 *   - **纯函数 + 时钟可注入**：`next(schedule, from)` 的 `from` 即时钟注入点，
 *     不依赖全局 `now()`，测试可注入任意起始时刻。无显式 Clock 对象（保持简单）。
 *
 * 语法范围（Linux / Vixie 标准）：
 *   1. `*`      通配（该字段未限制）
 *   2. `5`      具体值
 *   3. `a,b,c`  枚举（如 `0,30`）
 *   4. `a-b`    闭区间（如 `9-17`）
 *   5. 步进   `✱/n`（如 `✱/15`），亦支持 `a-b/n`（区间步进）
 *   6. DOM 字段支持 `?`（无特定日，常与 DOW 连用，Vixie 语义）
 *   7. DOM 字段的 `L`（当月最后一天）；DOW 可选 `L`（当月最后一个该星期几）
 *
 * 月份与星期双形式：
 *   - 月份：`1-12` / `JAN-DEC`（大小写不敏感）
 *   - 星期：`0-7`（0 与 7 均代表周日）/ `SUN-SAT`
 *
 * DOM/DOW 语义（Vixie 标准 OR）：
 *   当「日」与「周」字段**均被限制**（都不是 `*` 或 `?`）时，采用 **OR 语义**——
 *   任一字段匹配即触发；当某一字段是 `*` 或 `?`（未限制）时，仅按被限制字段判断。
 */

// ---------------------------------------------------------------------------
// 常量与时区
// ---------------------------------------------------------------------------

/** 时区锁（不可用本机时区）。§7 */
export const SHANGHAI_TIME_ZONE = 'Asia/Shanghai'

/** 各字段的允许值范围。 */
const MIN_MINUTE = 0
const MAX_MINUTE = 59
const MIN_HOUR = 0
const MAX_HOUR = 23
const MIN_DOM = 1
const MAX_DOM = 31
const MIN_MONTH = 1
const MAX_MONTH = 12
const MIN_DOW = 0
const MAX_DOW = 7 // 0 与 7 均代表周日

/** 月份英文/缩写名（索引即月份号 1-12）。 */
const MONTH_NAMES = [
  'JAN',
  'FEB',
  'MAR',
  'APR',
  'MAY',
  'JUN',
  'JUL',
  'AUG',
  'SEP',
  'OCT',
  'NOV',
  'DEC',
] as const

/** 星期英文/缩写名（索引对齐数字 0-6，0=周日）。 */
const DOW_NAMES = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'] as const

// ---------------------------------------------------------------------------
// 类型定义
// ---------------------------------------------------------------------------

/**
 * 单个字段的不可变调度描述：命中值集合 + 是否被「限制」。
 *
 * `restricted` 区分了 cron 通配/无特定（`*`、`?`）与真正被约束的字段，这是
 * DOM/DOW OR 语义判定的关键：仅当 DOM 与 DOW **都 restricted** 时采用 OR。
 */
export interface FieldSchedule {
  /** 命中的整数值集合（已按升序去重）。 */
  readonly values: readonly number[]
  /** 该字段是否被「限制」：`*` / `?` 为 false，其余为 true。 */
  readonly restricted: boolean
}

/**
 * cron 表达式的不可变调度描述（解析结果）。
 *
 * 五个字段分别对应 分 / 时 / 日(DOM) / 月 / 周(DOW)。DOM 与 DOW 额外携带
 * `restricted` 以支撑 OR 语义；分、时、月恒为 restricted=true（`*` 视为全范围命中，
 * 便捷起见 values 填满全范围，restricted 对这三字段无 OR 判定作用）。
 */
export interface CronSchedule {
  /** 原始表达式（诊断/回显用）。 */
  readonly expr: string
  /** 分（0-59）。 */
  readonly minute: FieldSchedule
  /** 时（0-23）。 */
  readonly hour: FieldSchedule
  /** 日 DOM（1-31），支持 `?` 与 `L`。 */
  readonly dayOfMonth: FieldSchedule
  /** 月（1-12）。 */
  readonly month: FieldSchedule
  /** 周 DOW（0-7，0/7=周日），可选 `L`。 */
  readonly dayOfWeek: FieldSchedule
}

// ---------------------------------------------------------------------------
// 字段解析（内部）
// ---------------------------------------------------------------------------

/** 生成值摘要（截断长串，对齐 [path-guard] 的 summarize 风格）。 */
function summarize(v: unknown, max = 24): string {
  if (typeof v !== 'string') return `<非字符串:${typeof v}>`
  if (v.length === 0) return '<空字符串>'
  const head = v.length > max ? `${v.slice(0, max)}…` : v
  return JSON.stringify(head)
}

/** 抛统一 cron 非法错误（对齐 [path-guard] / [ledger] 风格）。 */
function cronError(expr: string, reason: string): never {
  throw new Error(`[cron] ${summarize(expr)} 非法：${reason}`)
}

/**
 * 解析单个「值/枚举/区间」子项为数字集合。
 *
 * 支持 `a`、`a-b`、`a-b/n`；`*` 与 `✱/n`、`?`、`L` 由上层单独处理，
 * 不在此处出现。返回升序去重的数字数组。
 */
function parseRangeItem(
  item: string,
  min: number,
  max: number,
  expr: string,
  fieldLabel: string,
): number[] {
  if (item === '') cronError(expr, `${fieldLabel}字段出现空枚举项`)
  const fail = (why: string): never =>
    cronError(expr, `${fieldLabel}字段 ${summarize(item)} ${why}`)

  // 分解步进。
  let basePart = item
  let step = 1
  const slashIdx = item.indexOf('/')
  if (slashIdx !== -1) {
    if (slashIdx !== item.lastIndexOf('/')) fail('含多个斜杠')
    basePart = item.slice(0, slashIdx)
    const stepStr = item.slice(slashIdx + 1)
    if (!/^\d+$/.test(stepStr)) fail('步进非正整数')
    step = Number.parseInt(stepStr, 10)
    if (step < 1) fail('步进须 ≥1')
  }

  // 解析区间/单值。
  let start: number
  let end: number
  if (basePart === '*') {
    start = min
    end = max
  } else if (basePart.includes('-')) {
    const parts = basePart.split('-')
    if (parts.length !== 2) fail('区间应形如 a-b')
    const [a, b] = parts as [string, string]
    if (!/^\d+$/.test(a) || !/^\d+$/.test(b)) fail('区间端点非整数')
    start = Number.parseInt(a, 10)
    end = Number.parseInt(b, 10)
    if (start > end) {
      // Vixie 支持环绕区间（如 DOW `5-2`），此处不扩展，直接视为非法更保守。
      fail('区间起点大于终点')
    }
  } else {
    if (!/^\d+$/.test(basePart)) fail('含非法字符')
    start = Number.parseInt(basePart, 10)
    if (slashIdx !== -1) fail('单值不可带步进（应形如 a-b/n 或 */n）')
    end = start
  }

  if (start < min || end > max) {
    fail(`超出范围 ${min}-${max}`)
  }

  const out: number[] = []
  for (let v = start; v <= end; v += step) out.push(v)
  return out
}

/** 校验一个数字是否在字段范围内。 */
function inRange(v: number, min: number, max: number): boolean {
  return v >= min && v <= max
}

/**
 * 解析月名字面量（大小写不敏感，返回 1-12 或 undefined 表示非名字）。
 */
function parseMonthName(tok: string): number | undefined {
  const up = tok.toUpperCase()
  const idx = (MONTH_NAMES as readonly string[]).indexOf(up)
  return idx === -1 ? undefined : idx + 1
}

/**
 * 解析星期名/数字字面量（大小写不敏感，返回 0-6，`7` 归一为 `0`=周日）。
 */
function parseDowToken(tok: string): number | undefined {
  const up = tok.toUpperCase()
  const nameIdx = (DOW_NAMES as readonly string[]).indexOf(up)
  if (nameIdx !== -1) return nameIdx
  if (/^\d$/.test(tok)) {
    const n = Number.parseInt(tok, 10)
    if (n > 7) return undefined // 0-7 合法（8+ 越界非命名）
    return n === 7 ? 0 : n // 7 与 0 均代表周日，归一为 0
  }
  return undefined
}

/** 展开一个字段（含名字/数值枚举）为命中数字集合（不处理 * ? L）。 */
function expandTokens(
  tokens: string[],
  expr: string,
  fieldLabel: string,
  resolve: (tok: string) => number | undefined,
  min: number,
  max: number,
): number[] {
  const out = new Set<number>()
  for (const tok of tokens) {
    if (tok === '') cronError(expr, `${fieldLabel}字段出现空枚举项`)
    let resolved: number[] | undefined
    const named = resolve(tok)
    if (named !== undefined) {
      resolved = [named]
    } else {
      // 数值/区间/步进解析（resolve 未命中说明是纯数字形式）。
      resolved = parseRangeItem(tok, min, max, expr, fieldLabel)
    }
    for (const v of resolved) {
      if (!inRange(v, min, max)) cronError(expr, `${fieldLabel}字段值 ${v} 超出范围 ${min}-${max}`)
      out.add(v)
    }
  }
  return [...out].sort((a, b) => a - b)
}

/** 解析「分/时」字段（纯数值，无 ? L，支持全部范围语法）。 */
function parseNumericField(
  raw: string,
  min: number,
  max: number,
  expr: string,
  fieldLabel: string,
): FieldSchedule {
  const tokens = raw.split(',')
  if (tokens.some((t) => t === '')) cronError(expr, `${fieldLabel}字段空枚举项`)
  // 分/时字段不支持 ? 与 L。
  if (tokens.some((t) => t === '?')) cronError(expr, `${fieldLabel}字段不支持 '?'（仅日/周字段支持）`)
  if (tokens.some((t) => /\bL\b/.test(t))) cronError(expr, `${fieldLabel}字段不支持 'L'`)

  const values: number[] = []
  let restricted = false
  for (const tok of tokens) {
    if (tok === '*') {
      restricted = false // 通配：不限制（但分/时实际仍按全范围值命中）
      // `*` 单独出现时展开全范围；`*/n` 由 parseRangeItem 处理。
      if (!tok.includes('/')) {
        for (let v = min; v <= max; v++) values.push(v)
      } else {
        values.push(...parseRangeItem(tok, min, max, expr, fieldLabel))
        restricted = true
      }
    } else {
      restricted = true
      values.push(...parseRangeItem(tok, min, max, expr, fieldLabel))
    }
  }
  const uniq = [...new Set(values)].sort((a, b) => a - b)
  return { values: uniq, restricted }
}

/** 解析「月」字段（支持 `1-12` 与 `JAN-DEC` 双形式）。 */
function parseMonthField(raw: string, expr: string): FieldSchedule {
  const tokens = raw.split(',')
  if (tokens.some((t) => t === '')) cronError(expr, '月字段空枚举项')
  if (tokens.some((t) => t === '?' || /\bL\b/.test(t)))
    cronError(expr, '月字段不支持 ? 或 L')

  const values: number[] = []
  let restricted = false
  for (const tok of tokens) {
    if (tok === '*') {
      restricted = false
      if (!tok.includes('/')) {
        for (let v = MIN_MONTH; v <= MAX_MONTH; v++) values.push(v)
      } else {
        // */n：按月号步进。
        const stepStr = tok.slice(2)
        if (!/^\d+$/.test(stepStr)) cronError(expr, '月字段步进非正整数')
        const step = Number.parseInt(stepStr, 10)
        if (step < 1) cronError(expr, '月字段步进须 ≥1')
        for (let v = MIN_MONTH; v <= MAX_MONTH; v += step) values.push(v)
        restricted = true
      }
    } else if (tok.includes('-') && !tok.includes('/')) {
      // 月份区间：端点可为数字或英文名（如 JAN-MAR / 1-3 / JAN-3）。
      restricted = true
      const [a, b] = tok.split('-') as [string, string]
      const sa = parseMonthName(a) ?? (Number.parseInt(a, 10))
      const sb = parseMonthName(b) ?? (Number.parseInt(b, 10))
      if (Number.isNaN(sa) || Number.isNaN(sb)) cronError(expr, `月字段 ${summarize(tok)} 解析失败`)
      if (sa < MIN_MONTH || sb > MAX_MONTH) cronError(expr, `月字段 ${summarize(tok)} 超出范围 ${MIN_MONTH}-${MAX_MONTH}`)
      if (sa > sb) cronError(expr, `月字段区间环绕非法: ${summarize(tok)}`)
      for (let v = sa; v <= sb; v++) values.push(v)
    } else {
      restricted = true
      const named = parseMonthName(tok)
      if (named !== undefined) {
        values.push(named)
      } else {
        values.push(...parseRangeItem(tok, MIN_MONTH, MAX_MONTH, expr, '月'))
      }
    }
  }
  return { values: [...new Set(values)].sort((a, b) => a - b), restricted }
}

/** 解析「周 DOW」字段（`0-7` / `SUN-SAT`，`0`/`7` 归一周日，可选 `L`）。 */
function parseDowField(raw: string, expr: string): FieldSchedule {
  const tokens = raw.split(',')
  if (tokens.some((t) => t === '')) cronError(expr, '周字段空枚举项')
  if (tokens.some((t) => t === '?')) cronError(expr, "周字段不支持 '?'（仅日字段支持；Vixie 用 * 表无特定）")

  // L 语义：`5L` 表示「当月最后一个周五」。前缀可为数字(0-7)/星期名，或空(裸 L 按周日)。
  let lastDow: number | undefined
  const values: number[] = []
  let restricted = false

  const plainTokens = tokens.filter((t) => !/L$/i.test(t))
  const lTokens = tokens.filter((t) => /L$/i.test(t))

  for (const tok of lTokens) {
    // 末尾 L 去掉得前缀（如 `5L`→`5`、`FRIL`→`FRI`、`L`→``）。
    const dayTok = tok.slice(0, -1).trim()
    const parsed = dayTok === '' ? 0 : parseDowToken(dayTok)
    if (parsed === undefined) cronError(expr, `周字段 ${summarize(tok)} 解析失败`)
    if (lastDow !== undefined) cronError(expr, '周字段最多一个 L')
    lastDow = parsed
    restricted = true
  }

  for (const tok of plainTokens) {
    if (tok === '*') {
      restricted = false
      for (let v = MIN_DOW; v <= 6; v++) values.push(v)
    } else if (tok.includes('-') && !tok.includes('/')) {
      restricted = true
      const [a, b] = tok.split('-') as [string, string]
      const sa = parseDowToken(a)
      const sb = parseDowToken(b)
      if (sa === undefined || sb === undefined) cronError(expr, `周字段 ${summarize(tok)} 解析失败`)
      if (sa > sb) cronError(expr, `周字段区间环绕非法: ${summarize(tok)}`)
      for (let v = sa; v <= sb; v++) values.push(v)
    } else if (tok.includes('/')) {
      restricted = true
      // */n 或 a-b/n 按数值步进（DOW 名不参与步进，保守仅支持 */n 与 x-y/n）。
      const [base, stepStr] = tok.split('/') as [string, string]
      if (!/^\d+$/.test(stepStr)) cronError(expr, '周字段步进非正整数')
      const step = Number.parseInt(stepStr, 10)
      if (step < 1) cronError(expr, '周字段步进须 ≥1')
      let start: number
      let end: number
      if (base === '*') {
        start = 0
        end = 6
      } else if (base.includes('-')) {
        const [a, b] = base.split('-') as [string, string]
        const sa = parseDowToken(a)
        const sb = parseDowToken(b)
        if (sa === undefined || sb === undefined) cronError(expr, `周字段 ${summarize(tok)} 解析失败`)
        if (sa > sb) cronError(expr, `周字段区间环绕非法: ${summarize(tok)}`)
        start = sa
        end = sb
      } else {
        cronError(expr, `周字段 ${summarize(tok)} 步进须形如 */n 或 a-b/n`)
      }
      for (let v = start; v <= end; v += step) values.push(v)
    } else {
      restricted = true
      const parsed = parseDowToken(tok)
      if (parsed === undefined) cronError(expr, `周字段 ${summarize(tok)} 解析失败`)
      values.push(parsed)
    }
  }

  const uniq = [...new Set(values)].sort((a, b) => a - b)
  return { values: uniq, restricted, lastDow } as FieldSchedule & { lastDow?: number }
}

/** 解析「日 DOM」字段（`1-31`，支持 `?`、`L`、`✱/n` 等）。 */
function parseDomField(raw: string, expr: string): FieldSchedule {
  const tokens = raw.split(',')
  if (tokens.some((t) => t === '')) cronError(expr, '日字段空枚举项')

  const values: number[] = []
  let restricted = false
  let lastDay = false // `L`：当月最后一天

  for (const tok of tokens) {
    if (tok === '?') {
      // `?` = 无特定日，与 `*` 同义但不限制（Vixie 语义）。
      restricted = false
      continue
    }
    if (tok.toUpperCase() === 'L') {
      lastDay = true
      restricted = true
      continue
    }
    if (/^L/i.test(tok) || /L$/i.test(tok)) {
      // `L-n`（倒数第 n 天）非必需，此处不支持，视为非法。
      cronError(expr, `日字段 ${summarize(tok)}：仅支持裸 'L'（当月最后一天）`)
    }
    if (tok === '*') {
      restricted = false
      for (let v = MIN_DOM; v <= MAX_DOM; v++) values.push(v)
    } else {
      restricted = true
      values.push(...parseRangeItem(tok, MIN_DOM, MAX_DOM, expr, '日'))
    }
  }

  const uniq = [...new Set(values)].sort((a, b) => a - b)
  return {
    values: uniq,
    restricted,
    lastDay,
  } as FieldSchedule & { lastDay?: boolean }
}

// ---------------------------------------------------------------------------
// 公开 API：parseCron / isValidCron / next
// ---------------------------------------------------------------------------

/**
 * 解析标准 5 段 cron 表达式为不可变调度描述。
 *
 * @param expr cron 表达式（分 时 日 月 周）。
 * @returns {@link CronSchedule}。
 * @throws 解析失败时抛 `[cron] <expr> 非法：<原因>`。
 */
export function parseCron(expr: string): CronSchedule {
  if (typeof expr !== 'string' || expr.trim() === '') {
    throw new Error('[cron] <空表达式> 非法：表达式必须为非空字符串')
  }
  const trimmed = expr.trim()

  const fields = trimmed.split(/\s+/)
  if (fields.length !== 5) {
    throw new Error(
      `[cron] ${summarize(trimmed)} 非法：应含 5 段（分 时 日 月 周），实际 ${fields.length} 段`,
    )
  }
  const [minuteRaw, hourRaw, domRaw, monthRaw, dowRaw] = fields as [
    string,
    string,
    string,
    string,
    string,
  ]

  const minute = parseNumericField(minuteRaw, MIN_MINUTE, MAX_MINUTE, trimmed, '分')
  const hour = parseNumericField(hourRaw, MIN_HOUR, MAX_HOUR, trimmed, '时')
  const dayOfMonth = parseDomField(domRaw, trimmed)
  const month = parseMonthField(monthRaw, trimmed)
  const dayOfWeek = parseDowField(dowRaw, trimmed)

  return { expr: trimmed, minute, hour, dayOfMonth, month, dayOfWeek }
}

/**
 * 校验 cron 表达式是否合法。不抛异常，非法返回 false。
 */
export function isValidCron(expr: string): boolean {
  try {
    parseCron(expr)
    return true
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// 时区辅助（锁定 Asia/Shanghai）
// ---------------------------------------------------------------------------

/** Asia/Shanghai 当地日期时间分解（墙钟视角）。 */
interface LocalDT {
  year: number
  month: number // 1-12
  day: number // 1-31
  hour: number // 0-23
  minute: number // 0-59
  second: number // 0-59
  dow: number // 0-6，0=周日
  /** 当月天数。 */
  daysInMonth: number
}

const SHANGHAI_FORMATTER = new Intl.DateTimeFormat('en-US', {
  timeZone: SHANGHAI_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
})

/** 某月天数（含闰年判定）。 */
function daysInMonth(year: number, month: number): number {
  // month 1-12；日期以「当月第 0 天」取上月末，再取该日 day 即当月天数。
  return new Date(Date.UTC(year, month, 0)).getUTCDate()
}

/** 将 Date（绝对时刻）分解为 Asia/Shanghai 当地分量。 */
function toLocal(date: Date): LocalDT {
  const parts = SHANGHAI_FORMATTER.formatToParts(date)
  const pick = (type: string): number => {
    const found = parts.find((p) => p.type === type)
    return found ? Number.parseInt(found.value, 10) : 0
  }
  const year = pick('year')
  const month = pick('month')
  const day = pick('day')
  const hour = pick('hour') % 24
  const minute = pick('minute')
  const second = pick('second')
  // 周几：用 UTC 构造该当地日期，再取 getUTCDay（避免依赖本机时区）。
  const dow = new Date(Date.UTC(year, month - 1, day)).getUTCDay()
  return { year, month, day, hour, minute, second, dow, daysInMonth: daysInMonth(year, month) }
}

/** 将 Asia/Shanghai 当地分量（年/月/日/时/分）构造为绝对 Date（UTC 时刻）。 */
function fromLocal(y: number, m: number, d: number, hh: number, mm: number): Date {
  // 先以 UTC 构造「墙钟数值」，再减去 UTC+8 偏移得到绝对时刻。
  const utcMs = Date.UTC(y, m - 1, d, hh, mm, 0, 0)
  const offsetMs = 8 * 60 * 60 * 1000
  return new Date(utcMs - offsetMs)
}

/** DOW 字段是否命中某日（0-6），并处理可选 `L`（`5L` = 当月最后一个周五）。 */
function dowMatches(schedule: CronSchedule, local: LocalDT): boolean {
  if (schedule.dayOfWeek.values.includes(local.dow)) return true
  const dow = schedule.dayOfWeek as FieldSchedule & { lastDow?: number }
  if (dow.lastDow === undefined) return false
  // 当月最后一个「星期 lastDow」：位于 (daysInMonth - 7, daysInMonth] 区间且周几一致。
  return local.dow === dow.lastDow && local.day > local.daysInMonth - 7
}

/** DOM 字段是否命中某日（处理 L = 当月最后一天）。 */
function domMatches(schedule: CronSchedule, local: LocalDT): boolean {
  const dom = schedule.dayOfMonth as FieldSchedule & { lastDay?: boolean }
  if (dom.lastDay && local.day === local.daysInMonth) return true
  return schedule.dayOfMonth.values.includes(local.day)
}

/** 月/时/分字段是否命中。 */
function monthMatches(schedule: CronSchedule, local: LocalDT): boolean {
  return schedule.month.values.includes(local.month)
}
function hourMatches(schedule: CronSchedule, local: LocalDT): boolean {
  return schedule.hour.values.includes(local.hour)
}
function minuteMatches(schedule: CronSchedule, local: LocalDT): boolean {
  return schedule.minute.values.includes(local.minute)
}

/**
 * 判定某 Asia/Shanghai 当地时刻是否命中调度。
 *
 * DOM/DOW OR 语义（Vixie）：仅当两者都 `restricted` 时取 OR，否则只看被限制的那一个。
 */
function matches(schedule: CronSchedule, local: LocalDT): boolean {
  if (!minuteMatches(schedule, local)) return false
  if (!hourMatches(schedule, local)) return false
  if (!monthMatches(schedule, local)) return false

  const dom = schedule.dayOfMonth as FieldSchedule & { lastDay?: boolean }
  const domRestricted = schedule.dayOfMonth.restricted || dom.lastDay === true
  const dowRestricted = schedule.dayOfWeek.restricted

  const domOk = domMatches(schedule, local)
  const dowOk = dowMatches(schedule, local)

  if (domRestricted && dowRestricted) {
    // OR 语义：任一命中即可。
    return domOk || dowOk
  }
  if (domRestricted) return domOk
  if (dowRestricted) return dowOk
  // 两者都未限制（都是 * 或 ?）→ 恒命中。
  return true
}

/** 以「分钟」为步进推进 local（原地步进 1 分钟，含跨日/月/年）。 */
function advanceMinute(dt: LocalDT): void {
  dt.minute += 1
  if (dt.minute <= 59) return
  dt.minute = 0
  dt.hour += 1
  if (dt.hour <= 23) return
  dt.hour = 0
  dt.day += 1
  if (dt.day > dt.daysInMonth) {
    dt.day = 1
    dt.month += 1
    if (dt.month > 12) {
      dt.month = 1
      dt.year += 1
    }
    dt.daysInMonth = daysInMonth(dt.year, dt.month)
  }
  // 跨日即更新周几（始终同步）。
  dt.dow = new Date(Date.UTC(dt.year, dt.month - 1, dt.day)).getUTCDay()
}

/**
 * 计算严格大于 `from` 的下一次触发时刻（Asia/Shanghai 视角）。
 *
 * @param schedule {@link parseCron} 的解析结果。
 * @param from 起始时刻（时钟注入点）；返回严格大于它的下一触发时刻。
 * @returns 绝对 Date（UTC 时刻）。
 */
export function next(schedule: CronSchedule, from: Date): Date {
  // 从 from 的 Asia/Shanghai 当地时刻出发，先推进 1 分钟（保证严格大于），
  // 再向前搜索第一个命中时刻。步进上限 5 年（分钟级），防死循环。
  const local = toLocal(from)
  advanceMinute(local)

  const MAX_STEPS = 366 * 5 * 24 * 60 // 5 年分钟数上限
  for (let i = 0; i < MAX_STEPS; i++) {
    if (matches(schedule, local)) {
      return fromLocal(local.year, local.month, local.day, local.hour, local.minute)
    }
    advanceMinute(local)
  }
  throw new Error(
    `[cron] ${summarize(schedule.expr)} 非法：5 年内无法找到下一触发时刻`,
  )
}