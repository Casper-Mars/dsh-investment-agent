/**
 * Agent 工具层：共享常量。
 *
 * 合规声明（§ task 验收「所有输出末尾附」）：附在唤醒消息正文与关键写/决策类
 * 工具 render 输出末尾，避免硬编码散落。只读查询工具（ledger_list/query、
 * predict_get）不加，以免冗余。
 */

/** 输出末尾合规声明（醒目一行，供工具 render 与唤醒正文复用）。 */
export const RISK_DISCLAIMER = '本内容不构成投资建议'

/** 附注合规声明：`prefix` 为原有文本，返回追加声明后的文本（末尾一行）。 */
export function withDisclaimer(text: string): string {
  return `${text}\n\n> ${RISK_DISCLAIMER}`
}