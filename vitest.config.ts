import { defineConfig } from 'vitest/config'

/**
 * Vitest 配置。
 *
 * 背景：本仓库测试包含多处**真实** fs / git / chokidar 装配（如
 * `tests/skill-provider.spec.ts` 挂载 dsh 原生 `skill-filesystem` provider 并开启
 * watch；`tests/skill-assets-repo.spec.ts` 真实 `git init/commit`）。vitest 默认按
 * CPU 核数（本机 12）并行跑 50 个测试文件，会因 git 进程 / 文件监视器资源竞争相互
 * 饿死，使依赖「watcher ready」的异步装配用例集体超时（本地复现：默认并发下 9 个
 * provider 用例超时，`--maxWorkers=4` 时 977 用例全绿）。
 *
 * 故限制并发上限以稳定时序：不改变任何生产代码，仅降低测试并行度。
 *
 * `setupFiles`：`tests/setup.ts` 在测试侧隔离日志目录 —— 以真实 ctx 跑 `apply()`
 * 的用例默认写入本次运行的临时目录，避免污染开发者真实 `~/.dsh-finance/logs`
 * （显式设置 `DSH_FINANCE_LOG_DIR` 的用例不受影响）。
 */
export default defineConfig({
  test: {
    maxWorkers: 4,
    setupFiles: ['tests/setup.ts'],
  },
})
