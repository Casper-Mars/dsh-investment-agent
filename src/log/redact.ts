/**
 * 字段级去敏（里程碑 M5「去敏」）。
 *
 * 目标：在日志**写盘前**（由文件 exporter {@link ./file-exporter.js} 的 `buildRecord`
 * 统一接入）做一次字段级去敏，保证落盘 JSONL：
 *   1. **无明文密钥 / 凭证**：字段名命中敏感词（`token/secret/key/password/...`）→
 *      其值替换为 {@link REDACTED}（`[REDACTED]`），**保留键名**便于排障结构；
 *   2. **无完整台账金额 / 成本**：金额 / 成本类键（`cost/amount/price/pnl/profit/value`…）
 *      → 值替换 `[REDACTED]`；**保留** `symbol / qty / op / type / side /
 *      sessionId / taskId / traceId` 等非敏感上下文键；
 *   3. **无策略全文**：长文本字段（`text/body/content/strategy/prompt/message`）超阈值
 *      （{@link DEFAULT_MAX_TEXT_LENGTH}，默认 200 字符）→ 截断 + 省略标记
 *      {@link TRUNCATED_SUFFIX}；
 *   4. **错误对象**：`Error` 实例 → 仅 `{ message, stack: 前 N 行 }`
 *      （{@link DEFAULT_MAX_STACK_LINES}，默认 10）。
 *   5. **文本级裸令牌 / 金额**：`msg` / `Error.message` / `Error.stack` 等**文本**再做
 *      文本级去敏——「裸令牌」（`Bearer <token>` 与已知前缀 `sk-` / `ghp_` / `xoxb-` /
 *      `AKIA` …）按**前缀 / 形态**判据整体遮蔽（不做通用高熵猜测）；敏感 / 金额键的
 *      `key=value` / `key:value` 赋值（支持一行内多键，空格 / 逗号分隔）值遮蔽。
 *
 * 设计要点（对齐技术方案《日志完善技术方案（dsh-finance 插件）v1.0》§7 / §10）：
 *   - **纯函数、零第三方依赖**：不引任何包，也不做 IO；
 *   - **护栏**：深度上限（防爆栈）、循环引用（防死循环）、超大数组 / 对象（防体积失控）；
 *   - **循环引用语义（关键）**：文件 exporter 既有行为是「循环引用 → `JSON.stringify`
 *     抛错 → 该行静默丢弃」（M2 独立验收 `AC7-5`）。为**保持该行为不变**，
 *     {@link redact} 默认 `onCircular: 'throw'`——命中循环引用即抛
 *     {@link CircularReferenceError}，由 exporter 的 `try/catch` 吞掉后丢弃整行；
 *     若调用方希望「以标记替换」，可显式传 `onCircular: 'marker'`。
 *
 * 键名匹配口径：把键名**归一化**为「小写 + 仅保留字母数字」，再按**子串**命中敏感 /
 * 金额词表。如此可统一覆盖 `apiKey` / `api_key` / `accessKey` / `privateKey`
 * （归一化后均含 `key`）、`costPrice`（含 `cost`/`price`）、`marketValue`
 * （含 `value`）等驼峰 / 下划线形态。**倾向「宁可多遮蔽」**（fail-closed）。
 */

/** 敏感值替换字面量。 */
export const REDACTED = '[REDACTED]'

/** 长文本截断后缀省略标记。 */
export const TRUNCATED_SUFFIX = '…[truncated]'

/** 循环引用（`onCircular: 'marker'` 模式）替换字面量。 */
export const CIRCULAR_MARKER = '[Circular]'

/** 超过深度上限的替换字面量。 */
export const MAX_DEPTH_MARKER = '[MaxDepth]'

/**
 * 敏感键子串词表（归一化后按子串命中）。
 *
 * 覆盖：`token, secret, key, password, passwd, authorization, auth, credential,
 * cookie, apiKey/api_key, accessKey, privateKey`。后三者归一化后均含 `key`，此处显式
 * 列出以自证口径。
 */
export const SENSITIVE_KEY_TOKENS: readonly string[] = Object.freeze([
  'token',
  'secret',
  'key',
  'password',
  'passwd',
  'pwd',
  'authorization',
  'auth',
  'credential',
  'cookie',
  'apikey',
  'accesskey',
  'privatekey',
  // 金融域常见敏感键（保守 fail-closed；结构化键级同样生效）：
  'balance',
  'total',
  'equity',
  'nav',
  'cash',
  'shares',
])

/**
 * 金额 / 成本类键子串词表（归一化后按子串命中）。
 *
 * 覆盖：`cost, costPrice, amount, price, marketValue, positionValue, pnl, profit,
 * value`（`costPrice` 含 `cost`/`price`；`marketValue`/`positionValue` 含 `value`）。
 */
export const AMOUNT_KEY_TOKENS: readonly string[] = Object.freeze([
  'cost',
  'costprice',
  'amount',
  'price',
  'marketvalue',
  'positionvalue',
  'pnl',
  'profit',
  'value',
])

/**
 * 长文本键（归一化后**精确**命中）；其字符串值超阈值即截断（防「策略全文」落盘）。
 */
export const LONG_TEXT_KEYS: readonly string[] = Object.freeze([
  'text',
  'body',
  'content',
  'strategy',
  'prompt',
  'message',
])

/** 默认深度上限（防爆栈）。 */
export const DEFAULT_MAX_DEPTH = 10

/** 默认长文本阈值（字符数）。 */
export const DEFAULT_MAX_TEXT_LENGTH = 200

/** 默认错误 stack 保留行数。 */
export const DEFAULT_MAX_STACK_LINES = 10

/** 默认单数组元素上限（防体积失控）。 */
export const DEFAULT_MAX_ARRAY_LENGTH = 1000

/** 默认单对象键数上限（防体积失控）。 */
export const DEFAULT_MAX_ENTRIES = 1000

/** 循环引用处理策略：`throw`（默认，抛错 → exporter 丢弃整行）/ `marker`（替换为标记）。 */
export type OnCircular = 'throw' | 'marker'

/** {@link redact} / {@link redactText} / {@link redactRecord} 选项。 */
export interface RedactOptions {
  /** 深度上限（> 0）；超限的子树替换为 {@link MAX_DEPTH_MARKER}。默认 {@link DEFAULT_MAX_DEPTH}。 */
  maxDepth?: number
  /** 长文本阈值（字符数）；`<= 0` 视为不截断。默认 {@link DEFAULT_MAX_TEXT_LENGTH}。 */
  maxTextLength?: number
  /** 错误 stack 保留行数（> 0）。默认 {@link DEFAULT_MAX_STACK_LINES}。 */
  maxStackLines?: number
  /** 单数组元素上限（> 0）。默认 {@link DEFAULT_MAX_ARRAY_LENGTH}。 */
  maxArrayLength?: number
  /** 单对象键数上限（> 0）。默认 {@link DEFAULT_MAX_ENTRIES}。 */
  maxEntries?: number
  /** 替换字面量。默认 {@link REDACTED}。 */
  replacement?: string
  /** 循环引用策略。默认 `'throw'`（保持 exporter 既有「丢弃整行」行为）。 */
  onCircular?: OnCircular
  /** 敏感键子串词表覆盖。默认 {@link SENSITIVE_KEY_TOKENS}。 */
  sensitiveKeyTokens?: readonly string[]
  /** 金额键子串词表覆盖。默认 {@link AMOUNT_KEY_TOKENS}。 */
  amountKeyTokens?: readonly string[]
  /** 长文本键覆盖。默认 {@link LONG_TEXT_KEYS}。 */
  longTextKeys?: readonly string[]
}

/** 循环引用错误（默认策略下抛出；由 exporter 的降级 `try/catch` 吞掉）。 */
export class CircularReferenceError extends Error {
  constructor(message = 'redact: circular reference detected') {
    super(message)
    this.name = 'CircularReferenceError'
  }
}

/** 解析后的选项（各字段均已就绪）。 */
interface ResolvedOptions {
  readonly maxDepth: number
  readonly maxTextLength: number
  readonly maxStackLines: number
  readonly maxArrayLength: number
  readonly maxEntries: number
  readonly replacement: string
  readonly onCircular: OnCircular
  readonly sensitiveKeyTokens: readonly string[]
  readonly amountKeyTokens: readonly string[]
  readonly longTextKeys: readonly string[]
}

/** 正整数归位：非有限 / `<= 0` 时回落 `fallback`。 */
function positiveInt(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback
}

/** 解析选项（缺省 / 非法值一律回落默认）。 */
function resolveOptions(options: RedactOptions | undefined): ResolvedOptions {
  return {
    maxDepth: positiveInt(options?.maxDepth, DEFAULT_MAX_DEPTH),
    maxTextLength:
      typeof options?.maxTextLength === 'number' && Number.isFinite(options.maxTextLength)
        ? Math.floor(options.maxTextLength)
        : DEFAULT_MAX_TEXT_LENGTH,
    maxStackLines: positiveInt(options?.maxStackLines, DEFAULT_MAX_STACK_LINES),
    maxArrayLength: positiveInt(options?.maxArrayLength, DEFAULT_MAX_ARRAY_LENGTH),
    maxEntries: positiveInt(options?.maxEntries, DEFAULT_MAX_ENTRIES),
    replacement: typeof options?.replacement === 'string' ? options.replacement : REDACTED,
    onCircular: options?.onCircular === 'marker' ? 'marker' : 'throw',
    sensitiveKeyTokens: options?.sensitiveKeyTokens ?? SENSITIVE_KEY_TOKENS,
    amountKeyTokens: options?.amountKeyTokens ?? AMOUNT_KEY_TOKENS,
    longTextKeys: options?.longTextKeys ?? LONG_TEXT_KEYS,
  }
}

/** 键名归一化：小写 + 仅保留字母数字（统一驼峰 / 下划线 / 连字符形态）。 */
function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '')
}

/** 键名是否命中敏感词（子串，大小写 / 分隔符无关）。 */
export function isSensitiveKey(key: string, tokens: readonly string[] = SENSITIVE_KEY_TOKENS): boolean {
  const n = normalizeKey(key)
  return tokens.some((t) => n.includes(t))
}

/** 键名是否命中金额 / 成本词（子串）。 */
export function isAmountKey(key: string, tokens: readonly string[] = AMOUNT_KEY_TOKENS): boolean {
  const n = normalizeKey(key)
  return tokens.some((t) => n.includes(t))
}

/** 键名是否为长文本键（归一化后精确命中）。 */
export function isLongTextKey(key: string, keys: readonly string[] = LONG_TEXT_KEYS): boolean {
  return keys.includes(normalizeKey(key))
}

/** 取文本前 `n` 行（`n >= 1`；行分隔符 `\n` / `\r\n` 归一为 `\n`）。 */
export function firstLines(text: string, n: number): string {
  return text.split(/\r?\n/).slice(0, Math.max(1, n)).join('\n')
}

/** 长文本截断：超阈值 → 前 `max` 字符 + {@link TRUNCATED_SUFFIX}。 */
function truncateText(text: string, max: number): string {
  if (max <= 0) return text
  if (text.length <= max) return text
  return text.slice(0, max) + TRUNCATED_SUFFIX
}

/** 判据：文本疑似 JS 错误 stack（含缩进 `at ` 帧行）。 */
function looksLikeStack(text: string): boolean {
  return /\n[ \t]+at[ \t]/.test(text)
}

/**
 * 敏感键词的正则分支（含驼峰 / 下划线 / 连字符形态；长词前置，避免短词抢先匹配）。
 *
 * 含金融域常见敏感键（`balance/total/equity/nav/cash/shares/pwd`）——文本级词表随之扩展。
 */
const SENSITIVE_WORD =
  '(?:api[_-]?key|access[_-]?key|private[_-]?key|authorization|credential|password|passwd|secret|token|cookie|balance|equity|shares|cash|total|auth|pwd|nav|key)'

/**
 * 金额 / 成本键词的正则分支（长词前置）。
 *
 * `costPrice` 由 `cost` 回溯命中、`marketValue` / `positionValue` 由 `value` 或
 * `market[_-]?value` / `position[_-]?value` 命中；文本级词表并入这些金额键。
 */
const AMOUNT_WORD = '(?:market[_-]?value|position[_-]?value|costprice|cost|amount|price|pnl|profit|value)'

/**
 * 敏感 / 金额赋值形态的正则：**仅匹配敏感或金额键** `key[:=]value`（可选引号包裹键 / 值）。
 *
 * 关键 1：直接把「敏感 / 金额词」写进模式（而非「任意键 + 回调判定」），保证在多词文本
 *   （如 `Error: token=sk-xxx`）中**只吃**命中段，不把 `Error` 当作键而吞掉其后的明文。
 * 关键 2：`g` 全局模式支持**一行内多键值**（如 `cost=1 pnl=2` / `cost=1,pnl=2`）——
 *   值分支在空白 / 逗号 / 分号 / 右括号处收束，故每个 `key=value` 独立成一次匹配，全部处理。
 *
 * 值分支（按序）：`Bearer <token>`（含空格凭证）｜双引号串｜单引号串｜无空白裸值。
 */
const ASSIGN_RX = new RegExp(
  `(["']?)(${SENSITIVE_WORD}|${AMOUNT_WORD})(["']?)(\\s*[:=]\\s*)("(?:[^"\\\\]|\\\\.)*"|'(?:[^'\\\\]|\\\\.)*'|Bearer\\s+\\S+|[^\\s,;)\\]}"']+)`,
  'gi',
)

/**
 * 文本级「裸 `Bearer <token>`」扫描：整体替换（默认不保留 `Bearer ` 前缀）。
 *
 * 判据为**形态**（词边界 + 令牌字符集 + 最小长度 16），**不**用通用高熵猜测，
 * 规避误伤形如 `Bearer of good news` 的正常文本（`of` 仅 2 字符，不达阈值）。
 */
const BEARER_TOKEN_RX = /\bBearer\b\s+[A-Za-z0-9\-._~+/=]{16,}/gi

/**
 * 文本级「已知前缀令牌」扫描（前缀 / 形态判据，不做通用高熵猜测）：
 *   - `sk-` / `sk-proj-` / `sk-ant-`（OpenAI 系，含 `_` / `-` 续体，≥ 10 续字符）；
 *   - `ghp_` / `gho_` / `ghu_` / `ghs_` / `ghr_`（GitHub 系，≥ 16）；
 *   - `xoxb-` / `xoxp-` / `xoxa-` / `xoxo-` / `xoxs-`（Slack 系，≥ 10）；
 *   - `AKIA…`（AWS Access Key ID，≥ 8）。
 * 均要求 `\b` 词首边界——规避 `task-based` / `risk-driven` 之类正常词被误判
 * （`sk` 前紧邻字母时无词边界）。
 */
const KNOWN_TOKEN_RX =
  /\bsk-[A-Za-z0-9_-]{10,}|\bgh[pousr]_[A-Za-z0-9]{16,}|\bxox[bpoas]-[A-Za-z0-9-]{10,}|\bAKIA[0-9A-Z]{8,}/g

/** 值包裹：被引号包裹的值保持同款引号（保持 JSON / 引号形态可读）。 */
function wrapReplacement(value: string, replacement: string): string {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) return `"${replacement}"`
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) return `'${replacement}'`
  return replacement
}

/** 文本级去敏：`key=value` 形态的敏感 / 金额赋值 → 值替换（一行内多键值逐个处理）。 */
function redactAssignments(text: string, opts: ResolvedOptions): string {
  return text.replace(ASSIGN_RX, (match, q1: string, key: string, q2: string, sep: string, val: string) => {
    if (!isSensitiveKey(key, opts.sensitiveKeyTokens) && !isAmountKey(key, opts.amountKeyTokens)) return match
    return `${q1}${key}${q2}${sep}${wrapReplacement(val, opts.replacement)}`
  })
}

/**
 * 文本级去敏：裸令牌扫描 —— `Bearer <token>`（整体）与已知前缀令牌（`sk-` / `ghp_` /
 * `xoxb-` / `AKIA` …）→ 整体替换为 `replacement`。
 *
 * 用函数式替换，规避 `replacement` 中含 `$` 被当作替换模式解释。
 */
function redactBareTokens(text: string, opts: ResolvedOptions): string {
  return text
    .replace(BEARER_TOKEN_RX, () => opts.replacement)
    .replace(KNOWN_TOKEN_RX, () => opts.replacement)
}

/** 文本级去敏核心（不含 stack / 长文本裁剪）：赋值去敏 → 裸令牌扫描。 */
function redactTextCore(text: string, opts: ResolvedOptions): string {
  return redactBareTokens(redactAssignments(text, opts), opts)
}

/** 文本级去敏实现（已解析选项）：赋值 / 裸令牌去敏 → stack 裁剪 → 长文本截断。 */
function redactTextWith(text: string, opts: ResolvedOptions): string {
  const redacted = redactTextCore(text, opts)
  if (looksLikeStack(redacted)) return firstLines(redacted, opts.maxStackLines)
  return truncateText(redacted, opts.maxTextLength)
}

/** `Error` 实例 → `{ message, stack: 前 N 行 }`（message / stack 均做文本级去敏）。 */
function redactError(err: Error, opts: ResolvedOptions): Record<string, unknown> {
  const rawMessage = typeof err.message === 'string' ? err.message : String(err)
  const out: Record<string, unknown> = { message: redactTextWith(rawMessage, opts) }
  if (typeof err.stack === 'string' && err.stack.length > 0) {
    // stack 首行会重复 message（可能含 `key=value` 或裸令牌明文），故先文本级去敏再裁剪行数。
    out.stack = firstLines(redactTextCore(err.stack, opts), opts.maxStackLines)
  }
  return out
}

/** 循环引用命中处理：`throw` 抛错 / `marker` 返回标记。 */
function onCircularHit(opts: ResolvedOptions): unknown {
  if (opts.onCircular === 'marker') return CIRCULAR_MARKER
  throw new CircularReferenceError()
}

/** 数组深遍历（护栏：元素上限）。 */
function walkArray(arr: readonly unknown[], depth: number, opts: ResolvedOptions, seen: Set<object>): unknown[] {
  const out: unknown[] = []
  const len = arr.length
  const n = Math.min(len, opts.maxArrayLength)
  for (let i = 0; i < n; i += 1) out.push(walk(arr[i], depth, opts, seen))
  if (len > n) out.push(`[+${len - n} more]`)
  return out
}

/** 普通对象深遍历（护栏：键数上限；键名命中词表按口径替换）。 */
function walkObject(
  obj: Record<string, unknown>,
  depth: number,
  opts: ResolvedOptions,
  seen: Set<object>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  const keys = Object.keys(obj)
  const n = Math.min(keys.length, opts.maxEntries)
  for (let i = 0; i < n; i += 1) {
    const key = keys[i]
    if (isSensitiveKey(key, opts.sensitiveKeyTokens) || isAmountKey(key, opts.amountKeyTokens)) {
      out[key] = opts.replacement
      continue
    }
    const value = obj[key]
    if (isLongTextKey(key, opts.longTextKeys) && typeof value === 'string') {
      out[key] = truncateText(value, opts.maxTextLength)
      continue
    }
    out[key] = walk(value, depth, opts, seen)
  }
  if (keys.length > n) out['__truncated__'] = `[+${keys.length - n} more keys]`
  return out
}

/** 深遍历入口：标量原样 / 复杂对象递归（含护栏与错误 / 日期特化）。 */
function walk(value: unknown, depth: number, opts: ResolvedOptions, seen: Set<object>): unknown {
  if (value === null) return null
  const type = typeof value
  if (type === 'string' || type === 'number' || type === 'boolean') return value
  if (type === 'bigint') return (value as bigint).toString()
  if (type === 'undefined') return undefined
  if (type === 'function') return '[Function]'
  if (type === 'symbol') return String(value)

  const obj = value as object
  if (obj instanceof Date) {
    return Number.isNaN(obj.getTime()) ? String(obj) : obj.toISOString()
  }
  if (obj instanceof Error) return redactError(obj, opts)
  if (depth >= opts.maxDepth) return MAX_DEPTH_MARKER
  if (seen.has(obj)) return onCircularHit(opts)

  seen.add(obj)
  try {
    if (Array.isArray(obj)) return walkArray(obj, depth + 1, opts, seen)
    if (obj instanceof Map) {
      const mapped: Record<string, unknown> = {}
      let count = 0
      for (const [k, v] of obj) {
        if (count >= opts.maxEntries) break
        mapped[String(k)] = walk(v, depth + 1, opts, seen)
        count += 1
      }
      return mapped
    }
    if (obj instanceof Set) return walkArray([...obj], depth + 1, opts, seen)
    return walkObject(obj as Record<string, unknown>, depth + 1, opts, seen)
  } finally {
    seen.delete(obj)
  }
}

/**
 * 深遍历去敏（纯函数）。
 *
 * @param value   任意值（对象 / 数组 / 标量 / `Error` / `Date`…）。
 * @param options 见 {@link RedactOptions}。
 * @returns 去敏后的**新**结构（键名保留；命中的值替换为 {@link REDACTED}）。
 * @throws {CircularReferenceError} 默认策略下命中循环引用时抛出
 *   （供 exporter 降级吞掉 → 丢弃整行，保持 M2 既有行为）。
 */
export function redact(value: unknown, options?: RedactOptions): unknown {
  return walk(value, 0, resolveOptions(options), new Set<object>())
}

/**
 * 文本级去敏（纯函数）：`key=value` 形态敏感赋值 → 值替换；疑似错误 stack → 裁剪前 N 行；
 * 其余长文本 → 截断到阈值。
 *
 * @param text    待处理文本。
 * @param options 见 {@link RedactOptions}。
 * @returns 去敏后的文本。
 */
export function redactText(text: string, options?: RedactOptions): string {
  return redactTextWith(text, resolveOptions(options))
}

/**
 * 记录级去敏（纯函数）：对 `{ msg, args }` 形状的日志记录统一处理——
 * `msg` 走 {@link redactText}（文本级），`args` 走 {@link redact}（深遍历）。
 * 其余字段原样保留。供文件 exporter 的 `buildRecord` 写盘前调用。
 *
 * @param record  日志记录（至少可含 `msg` / `args`）。
 * @param options 见 {@link RedactOptions}。
 * @returns 去敏后的**新**记录。
 * @throws {CircularReferenceError} 同 {@link redact}。
 */
export function redactRecord(
  record: Record<string, unknown>,
  options?: RedactOptions,
): Record<string, unknown> {
  const opts = resolveOptions(options)
  const out: Record<string, unknown> = { ...record }
  if (typeof out.msg === 'string') out.msg = redactTextWith(out.msg, opts)
  if (out.args !== undefined) out.args = walk(out.args, 0, opts, new Set<object>())
  return out
}
