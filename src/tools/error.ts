/**
 * Agent 工具层：统一错误归一化。
 *
 * defineTool 的 `output.schema` 只对**成功返回值**做严格校验；错误通过**抛出**表达
 * （registry 捕获 execute 抛出的异常，归一为 `isError` 结果，跳过 schema 校验）。
 * 这与 dsh-tasks 的 `toToolError` 一致：execute 内不再「返回 { ok:false }」，
 * 而是把 domain 层的「抛错」或「{ ok:false, error } 返回」统一 throw 归一化错误，
 * 保证错误信息携带可读 message 透出给模型，且不产生未捕获异常。
 */

/** 把 execute 内的任意错误值统一抛出为携带可读 message 的 Error（不返回）。 */
export function throwToolError(err: unknown): never {
  if (err instanceof Error) throw err
  throw new Error(String(err))
}

/** 从 domain 的 `{ ok: false, error }` 结果中提取错误并抛出。 */
export function throwIfFailed(res: { ok: boolean; error?: string }): void {
  if (!res.ok) {
    throw new Error(res.error ?? '操作失败')
  }
}

/** 写操作前的取消检查：已取消则抛出（registry 归一为 ABORTED 类错误）。 */
export function assertNotAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new Error('已取消')
  }
}