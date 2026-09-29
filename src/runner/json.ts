/**
 * runner 层：lossless-JSON 归一化工具。
 *
 * ptc-runtime 的 binding 参数与返回值必须为**无损 JSON**（`PtcJsonValue`）：
 * 含 `undefined` / 函数 / 符号 / 非有限数 / `Date` 等一律不可直接跨越序列化边界。
 * domain/lib 返回的领域对象（如 `Ledger.query` 的 `PositionSnapshot`、
 * `QuoteClient` 的 `Quote`）中可能存在可选字段（`name?: string` → `undefined`），
 * 故在组装 binding 返回值前统一经本函数清洗。
 */
import type { PtcJsonValue } from './types.js'

/**
 * 将任意值归一化为无损 JSON。
 *
 * 规则：
 *   - `null` / `boolean` / `string` → 原样；
 *   - `number` → 有限数原样，`NaN` / `±Infinity` → `null`（JSON 不允许）；
 *   - `bigint` → 十进制字符串（JSON 无 bigint）；
 *   - `Array` → 逐元素递归（`undefined` 元素按 JSON 语义落为 `null`）；
 *   - `Date` → ISO 字符串；
 *   - 普通对象 → 逐键递归，**跳过 `undefined` 值**的键；
 *   - `undefined` / 函数 / 符号 → `null`（顶层）/ 跳过（对象属性）。
 *
 * @param value 任意值。
 * @returns 无损 JSON 值。
 */
export function toJsonValue(value: unknown): PtcJsonValue {
  if (value === null) return null

  switch (typeof value) {
    case 'boolean':
    case 'string':
      return value
    case 'number':
      return Number.isFinite(value) ? value : null
    case 'bigint':
      return value.toString()
    case 'object':
      break
    default:
      // undefined / function / symbol
      return null
  }

  if (Array.isArray(value)) return value.map((item) => toJsonValue(item))
  if (value instanceof Date) return value.toISOString()

  const out: { [key: string]: PtcJsonValue } = {}
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (item === undefined) continue
    out[key] = toJsonValue(item)
  }
  return out
}
