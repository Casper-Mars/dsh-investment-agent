/**
 * dsh-finance 插件入口：汇聚导出 Cordis 插件三要素（name / apply / inject）。
 *
 * 与同源插件 dsh-tasks（`src/agent/index.ts`）入口模式一致：
 * `package.json` 的 `exports["."]` 指向本文件编译产物，
 * 实际契约收敛在 `./plugin.js`。
 */
export { name, apply, inject } from './plugin.js'