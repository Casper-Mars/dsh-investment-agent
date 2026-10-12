/**
 * Vitest 全局 setup：测试隔离（里程碑 M2「文件落地」收口）。
 *
 * 背景：插件 `apply(ctx)` 在**真实** `ctx.logger` 下会追加注册文件 exporter
 * （`src/log/file-exporter.ts`），其默认落盘目录为 `~/.dsh-finance/logs`。凡以真实
 * `ctx` 调用 `apply()` 且未隔离日志目录的既有测试（如
 * `tests/plugin-tools-registration.spec.ts`），都会向**开发者真实 home** 写日志。
 *
 * 本 setup 在**测试侧**（不改生产代码、不加 `NODE_ENV`/`VITEST` 分支）做隔离：
 *
 *   - 若 `DSH_FINANCE_LOG_DIR` **未被显式设置**，则把它指向**稳定的**临时目录
 *     `<tmpdir>/dsh-finance-testlogs`（首次见即 `mkdirSync({recursive:true})`，幂等）。
 *     这样「以真实 ctx 跑 `apply()`」的测试只写临时目录，不触碰真实 home。
 *   - 若该变量**已被显式设置**（如需要在用例内精确控制目录 / 断言落盘的
 *     `tests/file-exporter.test.ts`、`tests/tester-t100435-*.spec.ts`），则**不动**它。
 *
 * 为何用「稳定目录」而非「每次 `mkdtemp` + 退出清理」：vitest 的 fork worker 以
 * **SIGTERM** 终止，`process.on('exit')` 回调不会触发，`mkdtemp` 方案会**每次测试都
 * 残留一个新目录**（堆积）。改用固定目录后，无论跑多少次测试都**只复用同一个目录**，
 * 既无堆积、也不依赖任何退出/信号回调。
 */
import { mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** 与 `src/paths.ts` 的 `LOG_DIR_ENV` 一致（此处内联字面量，避免 setup 期引入 src）。 */
const LOG_DIR_ENV = 'DSH_FINANCE_LOG_DIR'

if (!process.env[LOG_DIR_ENV]) {
  // 稳定目录：mkdirSync recursive 幂等，多 worker 并发创建亦安全。
  const dir = join(tmpdir(), 'dsh-finance-testlogs')
  try {
    mkdirSync(dir, { recursive: true })
    process.env[LOG_DIR_ENV] = dir
  } catch {
    /* 极端环境（tmp 不可写）下保持未设置：由 exporter 自身的 fs 降级兜底，不阻断测试。 */
  }
}
