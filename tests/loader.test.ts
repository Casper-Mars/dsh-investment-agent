/**
 * scheduler/loader.ts 单元测试。
 *
 * 唯一权威设计文档：《感知层详细设计（dsh-ia 插件）》 v0.7。
 *
 * 覆盖任务卡验收点：
 * - 成功路径：exitCode 0 → resolve（mock spawner）
 * - 非零退出码 → 抛 LoaderError（failureKind='install'）
 * - 超时强杀 → 抛 LoaderError（reason='timeout'）
 * - spawn-error → 抛 LoaderError
 * - 任务目录不存在 → 抛 LoaderError
 * - 任务目录缺 package.json → 抛 LoaderError
 * - 无脑执行 pnpm install（不判断 node_modules，验证 mock spawner 一定被调用）
 * - installTimeoutMs 默认 120000 可注入覆盖
 *
 * 全部用 mock spawner + mock fs，不真跑 pnpm。
 * 断言错误 message 含 `[loader]` 前缀和 taskId。
 */
import { afterEach, describe, it, expect, vi } from 'vitest'
import type {
  InstallSpawner,
  InstallSpawnResult,
  LoaderFs,
} from '../src/scheduler/loader.js'
import {
  LoaderError,
  TaskLoader,
  createTaskLoader,
  ensureTaskDeps,
  DEFAULT_INSTALL_TIMEOUT_MS,
} from '../src/scheduler/loader.js'

/** 构造一个「约束 spawner 只安装一次」的 mock，记录 cwd / timeoutMs，并返回可编程结果。 */
function makeSpawner(result: InstallSpawnResult) {
  const install = vi.fn<(cwd: string, timeoutMs: number) => Promise<InstallSpawnResult>>()
  install.mockResolvedValue(result)
  const spawner: InstallSpawner = { install }
  return { spawner, install }
}

/** 构造一个「目录与 package.json 均存在」的 mock fs。 */
function makeFs(dirExists = true, packageJsonExists = true): LoaderFs {
  return {
    dirExists: () => dirExists,
    packageJsonExists: () => packageJsonExists,
  }
}

const TASK_ID = 'market-pulse'
const TASK_DIR = '/tmp/assets/programs/market-pulse'

describe('installTaskDeps：成功路径', () => {
  it('exitCode 0 → resolve（void），并调用 mock spawner', async () => {
    const { spawner, install } = makeSpawner({ exitCode: 0, killed: false, reason: 'exit' })
    const loader = new TaskLoader({ spawner, fs: makeFs() })

    await expect(loader.installTaskDeps(TASK_ID, TASK_DIR)).resolves.toBeUndefined()
    expect(install).toHaveBeenCalledTimes(1)
    expect(install).toHaveBeenCalledWith(TASK_DIR, DEFAULT_INSTALL_TIMEOUT_MS)
  })

  it('无脑执行：即使 node_modules 场景也一定调用 spawner（不判断是否已安装）', async () => {
    const { spawner, install } = makeSpawner({ exitCode: 0, killed: false, reason: 'exit' })
    // fs 抽象根本没有 node_modules 相关方法——loader 无从判断「是否已安装」，
    // 只可能无脑调用 spawner。此处用只含目录/package.json 校验的 fs 即证这一点。
    const loader = new TaskLoader({ spawner, fs: makeFs() })

    await loader.installTaskDeps(TASK_ID, TASK_DIR)
    expect(install).toHaveBeenCalledTimes(1)
  })
})

describe('installTaskDeps：失败路径 → LoaderError（failureKind=install）', () => {
  it('非零退出码 → 抛 LoaderError，message 含 [loader] 与 taskId', async () => {
    const { spawner } = makeSpawner({ exitCode: 1, killed: false, reason: 'exit' })
    const loader = new TaskLoader({ spawner, fs: makeFs() })

    const err = await loader.installTaskDeps(TASK_ID, TASK_DIR).then(
      () => null,
      (e: unknown) => e as LoaderError,
    )
    expect(err).toBeInstanceOf(LoaderError)
    expect((err as LoaderError).failureKind).toBe('install')
    expect((err as LoaderError).name).toBe('LoaderError')
    expect((err as LoaderError).message).toContain('[loader]')
    expect((err as LoaderError).message).toContain(TASK_ID)
    expect((err as LoaderError).message).toContain('1')
  })

  it('超时强杀 → 抛 LoaderError（reason=timeout 传播为超时错误）', async () => {
    const { spawner } = makeSpawner({ exitCode: null, killed: true, reason: 'timeout' })
    const loader = new TaskLoader({ spawner, fs: makeFs() })

    await expect(loader.installTaskDeps(TASK_ID, TASK_DIR)).rejects.toMatchObject({
      name: 'LoaderError',
      failureKind: 'install',
    })
    await expect(loader.installTaskDeps(TASK_ID, TASK_DIR)).rejects.toThrow(/\[loader\]/)
  })

  it('spawn-error → 抛 LoaderError', async () => {
    const { spawner } = makeSpawner({ exitCode: null, killed: false, reason: 'spawn-error' })
    const loader = new TaskLoader({ spawner, fs: makeFs() })

    await expect(loader.installTaskDeps(TASK_ID, TASK_DIR)).rejects.toMatchObject({
      name: 'LoaderError',
      failureKind: 'install',
    })
    await expect(loader.installTaskDeps(TASK_ID, TASK_DIR)).rejects.toThrow(/\[loader\]/)
  })

  it('任务目录不存在 → 抛 LoaderError（spawner 不被调用）', async () => {
    const { spawner, install } = makeSpawner({ exitCode: 0, killed: false, reason: 'exit' })
    const loader = new TaskLoader({ spawner, fs: makeFs(false, true) })

    await expect(loader.installTaskDeps(TASK_ID, TASK_DIR)).rejects.toMatchObject({
      name: 'LoaderError',
      failureKind: 'install',
    })
    await expect(loader.installTaskDeps(TASK_ID, TASK_DIR)).rejects.toThrow(/\[loader\]/)
    expect(install).not.toHaveBeenCalled()
  })

  it('任务目录缺 package.json → 抛 LoaderError（spawner 不被调用）', async () => {
    const { spawner, install } = makeSpawner({ exitCode: 0, killed: false, reason: 'exit' })
    const loader = new TaskLoader({ spawner, fs: makeFs(true, false) })

    await expect(loader.installTaskDeps(TASK_ID, TASK_DIR)).rejects.toMatchObject({
      name: 'LoaderError',
      failureKind: 'install',
    })
    await expect(loader.installTaskDeps(TASK_ID, TASK_DIR)).rejects.toThrow(/\[loader\]/)
    expect(install).not.toHaveBeenCalled()
  })
})

describe('installTimeoutMs 注入', () => {
  it('默认值为 120000', () => {
    expect(DEFAULT_INSTALL_TIMEOUT_MS).toBe(120_000)
  })

  it('可注入覆盖，并透传给 spawner 的 timeoutMs 参数', async () => {
    const { spawner, install } = makeSpawner({ exitCode: 0, killed: false, reason: 'exit' })
    const loader = new TaskLoader({
      spawner,
      fs: makeFs(),
      installTimeoutMs: 30_000,
    })

    await loader.installTaskDeps(TASK_ID, TASK_DIR)
    expect(install).toHaveBeenCalledWith(TASK_DIR, 30_000)
  })
})

describe('工厂入口（createTaskLoader / ensureTaskDeps）', () => {
  it('createTaskLoader 返回可用的 TaskLoader', () => {
    const loader = createTaskLoader({ fs: makeFs() })
    expect(loader).toBeInstanceOf(TaskLoader)
  })

  it('ensureTaskDeps 等价于 installTaskDeps（成功路径）', async () => {
    const { spawner } = makeSpawner({ exitCode: 0, killed: false, reason: 'exit' })
    await expect(
      ensureTaskDeps({ spawner, fs: makeFs() }, TASK_ID, TASK_DIR),
    ).resolves.toBeUndefined()
  })

  it('ensureTaskDeps 失败同样抛 LoaderError', async () => {
    const { spawner } = makeSpawner({ exitCode: 2, killed: false, reason: 'exit' })
    await expect(
      ensureTaskDeps({ spawner, fs: makeFs() }, TASK_ID, TASK_DIR),
    ).rejects.toBeInstanceOf(LoaderError)
  })
})

// ---------------------------------------------------------------------------
// 真实 realInstall 的超时时序（驱动 node:child_process，验证 timedOut 归因）
//
// 既有用例全部 mock 了 InstallSpawner，从未驱动真实 realInstall，故未暴露「超时 timer
// 触发 SIGTERM 后、进程快速响应 SIGTERM 退出时，exit 监听器抢先结算为 reason='exit'」
// 的时序缺陷。此处用 vi.mock('node:child_process') + 可控假 child 覆盖两类真实时序。
// ---------------------------------------------------------------------------

type ExitHandler = (code: number | null, signal: NodeJS.Signals | null) => void
type ErrorHandler = (err: Error) => void

/** 可控假 child：记录 kill 调用，`exit`/`error` 监听器由测试主动 emit。 */
function makeFakeChild() {
  const signals: NodeJS.Signals[] = []
  const exitHandlers: ExitHandler[] = []
  const errorHandlers: ErrorHandler[] = []
  return {
    signals,
    kill(signal?: NodeJS.Signals) {
      if (signal) signals.push(signal)
    },
    on(event: string, handler: (a: unknown, b?: unknown) => void) {
      if (event === 'exit') exitHandlers.push(handler as ExitHandler)
      else if (event === 'error') errorHandlers.push(handler as ErrorHandler)
      return this
    },
    emitExit(code: number | null, signal: NodeJS.Signals | null) {
      for (const h of exitHandlers) h(code, signal)
    },
    emitError(err: Error) {
      for (const h of errorHandlers) h(err)
    },
  }
}

// 模块级可变假 child 持有：mock 的 spawn 由它返回，测试前重置并注入。
let currentFakeChild: ReturnType<typeof makeFakeChild> | null = null

vi.mock('node:child_process', () => ({
  spawn: () => {
    if (!currentFakeChild) throw new Error('spawn 未注入假 child')
    return currentFakeChild
  },
}))

describe('realInstall 超时时序（真实 child_process）', () => {
  afterEach(() => {
    currentFakeChild = null
    vi.useRealTimers()
  })

  it('超时 timer 触发 SIGTERM 后进程快速退出（code=null）→ 仍归因 timeout，非 exit', async () => {
    vi.useFakeTimers()
    currentFakeChild = makeFakeChild()
    const fakeChild = currentFakeChild

    const loader = createTaskLoader({ fs: makeFs(), installTimeoutMs: 120_000 })
    const pending = loader.installTaskDeps(TASK_ID, TASK_DIR).then(
      () => null as LoaderError | null,
      (e: unknown) => e as LoaderError,
    )

    // 推进到超时 timer 触发（timedOut=true + SIGTERM）。
    expect(fakeChild.signals).toEqual([])
    await vi.advanceTimersByTimeAsync(120_000)
    expect(fakeChild.signals).toContain('SIGTERM')
    // 进程响应 SIGTERM 立即退出（exit 监听器此时 timedOut 已 true，应归因 timeout）。
    fakeChild.emitExit(null, 'SIGTERM')

    // 清理宽限 1s 的 SIGKILL timer（结算已被 settle 守卫挡掉，仅排空 timer 避免泄漏）。
    await vi.runAllTimersAsync()

    const err = await pending
    expect(err).toBeInstanceOf(LoaderError)
    expect((err as LoaderError).failureKind).toBe('install')
    // 归因超时（非 exit）：message 表达「超过 … 未完成 + 已强杀」，绝不落到「退出码 null」。
    expect((err as LoaderError).message).toContain('超过')
    expect((err as LoaderError).message).toContain('已强杀')
    expect((err as LoaderError).message).not.toContain('退出码 null')
  })

  it('进程在超时前自行退出（exit 0）→ 归因 exit，正常 resolve', async () => {
    vi.useFakeTimers()
    currentFakeChild = makeFakeChild()
    const fakeChild = currentFakeChild

    const loader = createTaskLoader({ fs: makeFs(), installTimeoutMs: 120_000 })
    const pending = loader.installTaskDeps(TASK_ID, TASK_DIR).then(
      () => 'OK' as const,
      (e: unknown) => e as LoaderError,
    )

    // 未到超时，进程自行退出（exit 0）——应正常 resolve，且未发出任何 kill 信号。
    fakeChild.emitExit(0, null)
    const result = await pending
    expect(result).toBe('OK')
    expect(fakeChild.signals).toEqual([])

    await vi.runAllTimersAsync()
  })
})
