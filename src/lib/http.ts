/**
 * lib 层网络与重试公共工具。
 *
 * 仅使用 Node 原生 fetch（Node >= 22 内置），不引入 axios 等第三方依赖。
 * 提供：指数退避重试、GBK 文本解码、限时请求封装。
 */

/**
 * 指数退避重试。
 * @param fn     执行体（返回 Promise）。
 * @param retries  最多重试次数（默认 3，即初次 + 3 次重试）。
 * @param baseDelayMs 基础退避间隔（默认 200ms，按 2^n 递增）。
 * @param onRetry 每次重试前的回调（供告警/日志）。
 * @returns 成功返回 fn 结果；全部失败抛出最后一次错误。
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  retries = 3,
  baseDelayMs = 200,
  onRetry?: (attempt: number, err: unknown) => void,
): Promise<T> {
  let lastErr: unknown
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn()
    } catch (err) {
      lastErr = err
      if (attempt < retries) {
        onRetry?.(attempt + 1, err)
        const delay = baseDelayMs * 2 ** attempt
        await sleep(delay)
      }
    }
  }
  throw lastErr
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * 带超时的 fetch。超时抛出 AbortError。
 */
export async function fetchWithTimeout(
  url: string,
  init: RequestInit = {},
  timeoutMs = 8000,
): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(url, { ...init, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 读取响应体为文本；优先按指定编码解码，缺省（未指定 charset）时回退 utf-8。
 *
 * 腾讯行情接口返回 GBK 编码，Node 22+ 的 `TextDecoder('gbk')` 可直接使用
 * （依赖 ICU 的完整编码表，绝大多数运行环境已内置）。若运行环境不支持 GBK，
 * `TextDecoder` 构造会抛错，此时退回 utf-8 并在结果中保留原始字节的非 ASCII
 * 可能乱码——名称字段乱码不阻断行情数值解析（数值位于分隔结构，ASCII 安全）。
 */
export async function readText(
  res: Response,
  encoding: 'utf-8' | 'gbk' = 'utf-8',
): Promise<string> {
  const buf = new Uint8Array(await res.arrayBuffer())
  try {
    return new TextDecoder(encoding).decode(buf)
  } catch {
    return new TextDecoder('utf-8').decode(buf)
  }
}