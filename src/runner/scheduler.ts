/**
 * runner 层：最小自持调度器（详细设计 §8）。
 *
 * 设计约束：
 *   - **零第三方 cron 依赖**：仅用 Node 原生 `setTimeout` 链式自调度；
 *   - **时区锁定 `Asia/Shanghai`**：经 `Intl.DateTimeFormat('en-CA', { timeZone })`
 *     读取当地年月日时分，绝不使用本机时区；
 *   - **交易日挡板**：经 `isTradingDay` 跳过非交易日；
 *   - **盘中脉冲**：每 5 分钟，**仅** 9:30–11:30 / 13:00–15:00 窗口内触发；
 *   - **盘后复盘**：15:05；**盘前准备**（可选）：9:25；
 *   - `start()` 启动、`stop()` 清空所有 timer（进程退出无泄漏）；
 *   - 任何回调异常都不得中断链条。
 *
 * 实现要点：单调「单定时器链」。每次 arm 计算「下一个候选时刻」
 * （脉冲 / 复盘 / 盘前三者取最早），只保留一个在飞的 timer；到点后
 * 记录结局 → 重新 arm。Asia/Shanghai 无夏令时（恒定 UTC+8），故「墙钟时刻差」
 * 与「真实毫秒差」一致，可直接按分钟差换算延迟。
 */

/** 时区锁（不可用本机时区）。 */
export const SHANGHAI_TIME_ZONE = 'Asia/Shanghai'

/** 盘中脉冲步长（分钟）。 */
export const PULSE_STEP_MINUTES = 5

/**
 * 盘中脉冲窗口（以「当日分钟数」表示，含端点）：
 *   9:30–11:30（570–690）、13:00–15:00（780–900）。
 */
export const PULSE_WINDOWS: ReadonlyArray<readonly [number, number]> = [
  [9 * 60 + 30, 11 * 60 + 30],
  [13 * 60, 15 * 60],
]

/** 盘后复盘时刻：15:05。 */
export const REVIEW_MINUTE = 15 * 60 + 5

/** 盘前准备时刻：9:25。 */
export const PREP_MINUTE = 9 * 60 + 25

/** Asia/Shanghai 墙钟分解。 */
export interface ShanghaiParts {
  year: number
  month: number
  day: number
  hour: number
  minute: number
  second: number
  /** 当日分钟数（hour*60+minute）。 */
  minuteOfDay: number
}

const SHANGHAI_FORMATTER = new Intl.DateTimeFormat('en-CA', {
  timeZone: SHANGHAI_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
})

/**
 * 读取某时刻的 Asia/Shanghai 墙钟分量（锁定时区，与本机时区无关）。
 */
export function shanghaiParts(date: Date): ShanghaiParts {
  const parts = SHANGHAI_FORMATTER.formatToParts(date)
  const pick = (type: string): number => {
    const found = parts.find((p) => p.type === type)
    return found ? Number.parseInt(found.value, 10) : 0
  }
  const hour = pick('hour') % 24
  const minute = pick('minute')
  return {
    year: pick('year'),
    month: pick('month'),
    day: pick('day'),
    hour,
    minute,
    second: pick('second'),
    minuteOfDay: hour * 60 + minute,
  }
}

/** 某「当日分钟数」是否落在盘中脉冲窗口内（含端点）。 */
export function isPulseMinute(minuteOfDay: number): boolean {
  return PULSE_WINDOWS.some(([start, end]) => minuteOfDay >= start && minuteOfDay <= end)
}

/** 某时刻是否处于盘中脉冲窗口内（Asia/Shanghai）。 */
export function isInPulseWindow(date: Date): boolean {
  return isPulseMinute(shanghaiParts(date).minuteOfDay)
}

/** 墙钟「当日分钟数」的浮点表示（含秒）。 */
function fractionalMinute(parts: ShanghaiParts): number {
  return parts.minuteOfDay + parts.second / 60
}

/**
 * 下一个盘中脉冲时刻（严格在未来）：下一个 5 分钟对齐、且落在脉冲窗口内的时刻；
 * 若当日窗口已过，则顺延到次日 9:30。
 */
export function nextPulseInstant(now: Date): Date {
  const parts = shanghaiParts(now)
  const cur = fractionalMinute(parts)
  const step = PULSE_STEP_MINUTES
  const dayMinutes = 24 * 60
  // 严格未来的 5 分钟对齐分钟（可能 > 当日 1440，用 mod 回落到日内窗口判定）。
  let candidate = Math.ceil((cur + 1e-9) / step) * step
  const limit = candidate + dayMinutes + step
  while (candidate < limit && !isPulseMinute(candidate % dayMinutes)) {
    candidate += step
  }
  const delayMs = Math.max(0, Math.round((candidate - cur) * 60_000))
  return new Date(now.getTime() + delayMs)
}

/**
 * 下一个「指定 Asia/Shanghai 墙钟分钟数」的时刻（今日未到即今日，否则次日）。
 */
export function nextDailyInstant(now: Date, targetMinute: number): Date {
  const parts = shanghaiParts(now)
  const cur = fractionalMinute(parts)
  let diff = targetMinute - cur
  if (diff <= 1e-9) diff += 24 * 60
  return new Date(now.getTime() + Math.round(diff * 60_000))
}

/** 定时器句柄。 */
type TimerHandle = ReturnType<typeof setTimeout>

/** 调度器配置。 */
export interface SchedulerOptions {
  /** 盘中脉冲回调（到点且为交易日时调用）。 */
  onPulse: (at: Date) => void | Promise<unknown>
  /** 盘后复盘回调（15:05，交易日）。 */
  onReview: (at: Date) => void | Promise<unknown>
  /** 盘前准备回调（9:25，可选）。 */
  onPrep?: (at: Date) => void | Promise<unknown>
  /** 交易日判定（经 `lib/trading-calendar`；支持同步/异步）。 */
  isTradingDay: (date: Date) => boolean | Promise<boolean>
  /** 时钟（默认 `new Date()`；测试可注入）。 */
  now?: () => Date
  /** 定时器实现（默认 `setTimeout`；测试可注入）。 */
  setTimer?: (handler: () => void, delayMs: number) => TimerHandle
  /** 清定时器实现（默认 `clearTimeout`）。 */
  clearTimer?: (handle: TimerHandle) => void
  /** 日志（默认 `console.log`）。 */
  logger?: (message: string) => void
}

/** 调度器。 */
export interface Scheduler {
  /** 启动自持调度（幂等）。 */
  start(): void
  /** 停止并清空所有 timer（幂等）。 */
  stop(): void
  /** 是否运行中。 */
  readonly running: boolean
}

/**
 * 构造自持调度器。
 *
 * @param options 回调 / 交易日判定 / 时钟 / 定时器 / 日志。
 * @returns {@link Scheduler}。
 */
export function createScheduler(options: SchedulerOptions): Scheduler {
  const now = options.now ?? (() => new Date())
  const setTimer = options.setTimer ?? ((handler, ms) => setTimeout(handler, ms))
  const clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle))
  const log = options.logger ?? ((message: string) => console.log(message))

  let running = false
  const pending = new Set<TimerHandle>()
  let dayCache: { key: string; value: boolean } | undefined

  /** 交易日判定（按 Asia/Shanghai 日期缓存，避免每个脉冲重复拉取节假日）。 */
  const tradingDayCached = async (at: Date): Promise<boolean> => {
    const parts = shanghaiParts(at)
    const key = `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`
    if (dayCache?.key === key) return dayCache.value
    let value = false
    try {
      // 以「当地正午」构造 Date，使日历的本地日期分量恒等于 Shanghai 日期，
      // 避免宿主机时区导致 weekend/day 判定错位。
      const probe = new Date(parts.year, parts.month - 1, parts.day, 12, 0, 0)
      value = Boolean(await options.isTradingDay(probe))
    } catch (err: unknown) {
      log(`[dsh-finance/scheduler] 交易日判定失败，按非交易日处理：${String(err)}`)
      value = false
    }
    dayCache = { key, value }
    return value
  }

  /** 判定某时刻属于哪类事件。 */
  const classify = (at: Date): 'pulse' | 'review' | 'prep' | 'none' => {
    const minute = shanghaiParts(at).minuteOfDay
    if (minute === REVIEW_MINUTE) return 'review'
    if (minute === PREP_MINUTE) return 'prep'
    if (isPulseMinute(minute)) return 'pulse'
    return 'none'
  }

  /** 到点处理：交易日挡板 + 分发；异常不外溢。 */
  const dispatch = async (at: Date): Promise<void> => {
    const kind = classify(at)
    if (kind === 'none') return
    if (!(await tradingDayCached(at))) {
      log(`[dsh-finance/scheduler] 非交易日，跳过 ${kind}`)
      return
    }
    try {
      if (kind === 'review') await options.onReview(at)
      else if (kind === 'prep') await options.onPrep?.(at)
      else await options.onPulse(at)
    } catch (err: unknown) {
      log(`[dsh-finance/scheduler] ${kind} 处理异常：${String(err)}`)
    }
  }

  /** 计算并布置下一个候选时刻（脉冲 / 复盘 / 盘前三者最早）。 */
  const arm = (): void => {
    if (!running) return
    const base = now()
    const candidates: Date[] = [nextPulseInstant(base), nextDailyInstant(base, REVIEW_MINUTE)]
    if (options.onPrep) candidates.push(nextDailyInstant(base, PREP_MINUTE))

    let next = candidates[0]!
    for (const candidate of candidates) {
      if (candidate.getTime() < next.getTime()) next = candidate
    }
    const delayMs = Math.max(0, next.getTime() - base.getTime())

    let handle: TimerHandle | undefined
    handle = setTimer(() => {
      if (handle !== undefined) pending.delete(handle)
      void (async () => {
        await dispatch(next)
        if (running) arm()
      })()
    }, delayMs)
    pending.add(handle)
  }

  return {
    get running(): boolean {
      return running
    },
    start(): void {
      if (running) return
      running = true
      log(
        `[dsh-finance/scheduler] 启动（${SHANGHAI_TIME_ZONE}）：脉冲每 ${PULSE_STEP_MINUTES} 分钟 @ 9:30-11:30/13:00-15:00，复盘 15:05${options.onPrep ? '，盘前 9:25' : ''}`,
      )
      arm()
    },
    stop(): void {
      if (!running && pending.size === 0) return
      running = false
      for (const handle of pending) clearTimer(handle)
      pending.clear()
      log('[dsh-finance/scheduler] 已停止，定时器已清空')
    },
  }
}
