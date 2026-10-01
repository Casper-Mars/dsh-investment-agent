/**
 * domain/path-guard.ts —— 路径段安全校验。
 *
 * 统一防线：所有「外部输入（symbol / version）拼入文件路径」的入口，必须先经
 * {@link assertSafeSegment} 校验，防止目录穿越（path traversal）与非法路径段。
 * 历史上 `symbol` 未做校验即拼入 `path.join`，`../../esc2` 可逃出 baseDir 父
 * 目录写出文件（Tester 实测），此处收口为唯一守卫。
 *
 * 校验规则（对齐任务卡）：
 * - 必须为非空字符串；
 * - 匹配 `^[A-Za-z0-9._-]+$`（仅字母/数字/点/下划线/连字符）；
 * - 禁止 `.` 与 `..`（目录穿越语义）；
 * - 长度上限 64；
 * - 因此天然拒绝含 `/`、`\`、空白与控制字符的段。
 *
 * 不通过时抛出 `[path-guard] <label> 非法：<值摘要>`，风格与 `[ledger]` /
 * `[strategy-registry]` 等既有错误一致。
 *
 * 纯 TS，仅 `node:path` 可选；不引入第三方依赖。
 */

/** 合法路径段字符集：字母/数字/点/下划线/连字符。 */
const SAFE_SEGMENT_RE = /^[A-Za-z0-9._-]+$/

/** 路径段长度上限。 */
const MAX_SEGMENT_LEN = 64

/** 生成值摘要（截断长串、JSON 转义控制字符，避免污染日志）。 */
function summarize(seg: unknown): string {
  if (typeof seg !== 'string') return `<非字符串:${typeof seg}>`
  if (seg.length === 0) return '<空字符串>'
  const head = seg.length > 24 ? `${seg.slice(0, 24)}…` : seg
  return JSON.stringify(head)
}

/** 抛出统一的路径段非法错误（返回 never，供调用点控制流收窄）。 */
function fail(seg: unknown, label: string): never {
  throw new Error(`[path-guard] ${label} 非法：${summarize(seg)}`)
}

/**
 * 校验单个路径段（symbol / version 等外部输入），通过则原样返回。
 *
 * @param seg 待校验的路径段（外部输入）。
 * @param label 语义标签（如 `symbol` / `version`），用于错误信息。
 * @returns 校验通过的原字符串。
 * @throws 路径段非法时抛出 `[path-guard] <label> 非法：<值摘要>`。
 */
export function assertSafeSegment(seg: unknown, label: string): string {
  if (typeof seg !== 'string' || seg.length === 0) fail(seg, label)
  if (seg === '.' || seg === '..') fail(seg, label)
  if (seg.length > MAX_SEGMENT_LEN) fail(seg, label)
  if (!SAFE_SEGMENT_RE.test(seg)) fail(seg, label)

  return seg
}
