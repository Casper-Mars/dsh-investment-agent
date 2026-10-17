/**
 * 日志保留策略（`src/log/retention.ts`）与 exporter 集成测试（任务-06）。
 *
 * 覆盖：
 *   1. 默认常量（单文件 500 MB / 保留 30 天）与环境变量覆盖；
 *   2. 按天文件名的日期判定（普通 / 滚动 `-N` 后缀）；
 *   3. 非日期命名（`tasks/<id>/*.log`）按 mtime 判定；
 *   4. 目录 / 符号链接不被删除；`scanned` / `deleted` 计数；
 *   5. 保留天数边界（`retentionDays` 可覆盖）；
 *   6. exporter 集成：创建时清理一次；同天不重复；跨天（UTC）再清理；
 *   7. 清理失败（只读目录）不抛异常、不影响写盘。
 *
 * 安全：所有用例均在 `mkdtempSync(join(tmpdir(), ...))` 下操作，绝不触碰真实
 * `~/.dsh-ia/logs`。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Message } from '@deepseek-ai/cordis'
import {
  cleanupExpiredLogs,
  DEFAULT_LOG_RETENTION_DAYS,
  LOG_RETENTION_DAYS_ENV,
  resolveRetentionDays,
} from '../src/log/retention.js'
import {
  createFileExporter,
  DEFAULT_LOG_MAX_SIZE,
} from '../src/log/file-exporter.js'

/** 固定“现在”：2026-10-12T12:00:00Z（UTC）。 */
const NOW = Date.UTC(2026, 9, 12, 12, 0, 0)
/** 40 天前：2026-09-02（早于 30 天保留线）。 */
const OLD_MS = NOW - 40 * 24 * 60 * 60 * 1000

const tmpDirs: string[] = []
function mkTmp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-ia-retention-'))
  tmpDirs.push(dir)
  return dir
}

/** 造一个文件并设置 mtime（用于非日期命名判定）。 */
function touchFile(path: string, mtimeMs: number, content = '{}\n'): void {
  writeFileSync(path, content)
  utimesSync(path, new Date(mtimeMs), new Date(mtimeMs))
}

/** 构造一条 cordis `Message`。 */
function makeMessage(partial: Partial<Message> & Pick<Message, 'type'>): Message {
  return { sn: 1, ts: NOW, name: 'dsh-ia', level: 0, args: [], ...partial }
}

const savedRetention = process.env[LOG_RETENTION_DAYS_ENV]

beforeEach(() => {
  delete process.env[LOG_RETENTION_DAYS_ENV]
})

afterEach(() => {
  if (savedRetention === undefined) delete process.env[LOG_RETENTION_DAYS_ENV]
  else process.env[LOG_RETENTION_DAYS_ENV] = savedRetention
  for (const dir of tmpDirs.splice(0)) {
    // 只读测试目录需先恢复权限，避免清理失败。
    try {
      chmodSync(dir, 0o700)
    } catch {
      /* ignore */
    }
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  }
})

// ===========================================================================
// ① 常量 / 解析
// ===========================================================================
describe('① 常量与环境变量', () => {
  it('单文件默认上限 = 500 MB；保留默认 30 天', () => {
    expect(DEFAULT_LOG_MAX_SIZE).toBe(500 * 1024 * 1024)
    expect(DEFAULT_LOG_RETENTION_DAYS).toBe(30)
  })

  it('resolveRetentionDays：显式 > env > 默认；非正数回落默认', () => {
    expect(resolveRetentionDays(7)).toBe(7)
    expect(resolveRetentionDays()).toBe(30)

    process.env[LOG_RETENTION_DAYS_ENV] = '14'
    expect(resolveRetentionDays()).toBe(14)
    // 显式优先于 env。
    expect(resolveRetentionDays(3)).toBe(3)

    for (const bad of ['0', '-5', 'bogus', '']) {
      process.env[LOG_RETENTION_DAYS_ENV] = bad
      expect(resolveRetentionDays()).toBe(30)
    }

    expect(resolveRetentionDays(0)).toBe(30)
    expect(resolveRetentionDays(-1)).toBe(30)
    expect(resolveRetentionDays(Number.NaN)).toBe(30)
  })
})

// ===========================================================================
// ② 按天 / 滚动文件
// ===========================================================================
describe('② 按文件名日期判定（普通 + 滚动后缀）', () => {
  it('40 天前的 2026-08-01.jsonl 被删；今天（2026-10-12）保留；滚动 -2 后缀同判', () => {
    const dir = mkTmp()
    const old = join(dir, '2026-08-01.jsonl')
    const oldRolled = join(dir, '2026-08-01-2.jsonl')
    const today = join(dir, '2026-10-12.jsonl')
    writeFileSync(old, '{}\n')
    writeFileSync(oldRolled, '{}\n')
    writeFileSync(today, '{}\n')

    const result = cleanupExpiredLogs({ dir, now: NOW })

    expect(result.scanned).toBe(3)
    expect(result.deleted.sort()).toEqual([old, oldRolled].sort())
    expect(result.degraded).toBe(false)
    expect(existsSync(old)).toBe(false)
    expect(existsSync(oldRolled)).toBe(false)
    expect(existsSync(today)).toBe(true)
  })

  it('retentionDays 可覆盖：保留 5 天时 2026-10-05（7 天前）被删', () => {
    const dir = mkTmp()
    const sevenDaysAgo = join(dir, '2026-10-05.jsonl')
    const twoDaysAgo = join(dir, '2026-10-10.jsonl')
    writeFileSync(sevenDaysAgo, '{}\n')
    writeFileSync(twoDaysAgo, '{}\n')

    const result = cleanupExpiredLogs({ dir, retentionDays: 5, now: NOW })
    expect(result.deleted).toEqual([sevenDaysAgo])
    expect(existsSync(sevenDaysAgo)).toBe(false)
    expect(existsSync(twoDaysAgo)).toBe(true)
  })

  it('非法日期名回退 mtime（不因文件名误删）', () => {
    const dir = mkTmp()
    const invalid = join(dir, '2026-13-40.jsonl')
    touchFile(invalid, NOW) // mtime 新 → 保留
    const result = cleanupExpiredLogs({ dir, now: NOW })
    expect(result.scanned).toBe(1)
    expect(result.deleted).toEqual([])
    expect(existsSync(invalid)).toBe(true)
  })
})

// ===========================================================================
// ③ 非日期命名（tasks/<id>/*.log）按 mtime
// ===========================================================================
describe('③ 任务日志按 mtime 判定', () => {
  it('老 mtime 删除、新 mtime 保留；目录 / 非日志扩展名忽略', () => {
    const dir = mkTmp()
    const tasks = join(dir, 'tasks', 't1')
    mkdirSync(tasks, { recursive: true })
    const oldLog = join(tasks, 'run-old.log')
    const newLog = join(tasks, 'run-new.log')
    const note = join(tasks, 'note.txt')
    touchFile(oldLog, OLD_MS)
    touchFile(newLog, NOW)
    touchFile(note, OLD_MS)

    const result = cleanupExpiredLogs({ dir, now: NOW })

    expect(result.scanned).toBe(2)
    expect(result.deleted).toEqual([oldLog])
    expect(result.degraded).toBe(false)
    expect(existsSync(oldLog)).toBe(false)
    expect(existsSync(newLog)).toBe(true)
    expect(existsSync(note)).toBe(true)
  })
})

// ===========================================================================
// ④ 目录 / 符号链接 / 计数
// ===========================================================================
describe('④ 不跟随符号链接；只删普通文件', () => {
  it('符号链接（文件 / 目录）不被删除也不计入 scanned；子目录正常递归', () => {
    const dir = mkTmp()
    const realOld = join(dir, '2026-08-01.jsonl')
    writeFileSync(realOld, '{}\n')
    const target = join(dir, 'target.bin')
    writeFileSync(target, 'keep')
    const linkFile = join(dir, '2026-08-02.jsonl')
    symlinkSync(target, linkFile)

    const realDir = join(dir, 'nested')
    mkdirSync(realDir)
    const nestedOld = join(realDir, '2026-08-03.jsonl')
    writeFileSync(nestedOld, '{}\n')
    // 指向真实子目录的符号链接：其内部文件不得被二次扫描 / 删除。
    const linkedDir = join(dir, 'linked-dir')
    symlinkSync(realDir, linkedDir)

    const result = cleanupExpiredLogs({ dir, now: NOW })

    // scanned：realOld + nestedOld（符号链接文件跳过；linked-dir 整体跳过）。
    expect(result.scanned).toBe(2)
    expect(result.deleted.sort()).toEqual([realOld, nestedOld].sort())
    expect(existsSync(realOld)).toBe(false)
    expect(existsSync(nestedOld)).toBe(false)
    // 链接本身与目标文件保留。
    expect(existsSync(linkFile)).toBe(true)
    expect(existsSync(target)).toBe(true)
    expect(existsSync(linkedDir)).toBe(true)
  })

  it('根目录不存在 / 为空 → 不抛、零计数、非降级', () => {
    const dir = join(mkTmp(), 'not-created')
    expect(() => cleanupExpiredLogs({ dir, now: NOW })).not.toThrow()
    expect(cleanupExpiredLogs({ dir, now: NOW })).toEqual({
      deleted: [],
      scanned: 0,
      degraded: false,
    })

    const empty = mkTmp()
    expect(cleanupExpiredLogs({ dir: empty, now: NOW })).toEqual({
      deleted: [],
      scanned: 0,
      degraded: false,
    })
  })
})

// ===========================================================================
// ⑤ exporter 集成
// ===========================================================================
describe('⑤ exporter 集成：创建时清理 + 每天最多一次', () => {
  it('创建 exporter 即清理；同天多次 export 不重复清理；跨天再清理', () => {
    const dir = mkTmp()
    const oldAtCreate = join(dir, '2026-08-01.jsonl')
    writeFileSync(oldAtCreate, '{}\n')

    let clock = NOW
    const exporter = createFileExporter({
      dir,
      level: 'debug',
      retentionDays: 30,
      now: () => clock,
    })
    // 创建时已清理。
    expect(existsSync(oldAtCreate)).toBe(false)

    // 创建后再放一个过期文件；同一天内多次写盘不得再次清理。
    const oldAfterCreate = join(dir, '2026-08-02.jsonl')
    writeFileSync(oldAfterCreate, '{}\n')
    exporter.export(makeMessage({ type: 'info', args: ['a'] }))
    exporter.export(makeMessage({ type: 'info', args: ['b'] }))
    expect(existsSync(oldAfterCreate)).toBe(true)
    expect(existsSync(join(dir, '2026-10-12.jsonl'))).toBe(true)

    // 跨天（UTC）后首次写盘触发清理。
    clock = Date.UTC(2026, 9, 13, 9, 0, 0)
    exporter.export(makeMessage({ type: 'info', ts: clock, args: ['c'] }))
    expect(existsSync(oldAfterCreate)).toBe(false)
    expect(existsSync(join(dir, '2026-10-13.jsonl'))).toBe(true)
  })

  it('保留天数经 exporter 选项生效', () => {
    const dir = mkTmp()
    const sevenDaysAgo = join(dir, '2026-10-05.jsonl')
    writeFileSync(sevenDaysAgo, '{}\n')
    createFileExporter({ dir, retentionDays: 5, now: () => NOW })
    expect(existsSync(sevenDaysAgo)).toBe(false)
  })

  it('now 是统一时间源：注入「40 天后」时创建即按该时钟清理（截止线受控）', () => {
    const dir = mkTmp()
    const nowDay = join(dir, '2026-10-12.jsonl') // 相对注入时钟已超 30 天
    const withinWindow = join(dir, '2026-11-15.jsonl') // 注入时钟 - 6 天，应保留
    writeFileSync(nowDay, '{}\n')
    writeFileSync(withinWindow, '{}\n')

    const future = NOW + 40 * 24 * 60 * 60 * 1000 // 2026-11-21
    createFileExporter({ dir, retentionDays: 30, now: () => future })

    expect(existsSync(nowDay)).toBe(false)
    expect(existsSync(withinWindow)).toBe(true)
  })
})

// ===========================================================================
// ⑥ 降级
// ===========================================================================
describe('⑥ 清理失败降级（不抛 / 不影响写盘）', () => {
  it('只读子目录删除失败 → degraded=true；exporter 仍可正常写盘', () => {
    const dir = mkTmp()
    const locked = join(dir, 'locked')
    mkdirSync(locked)
    const lockedOld = join(locked, 'old.log')
    touchFile(lockedOld, OLD_MS)
    chmodSync(locked, 0o500) // 只读目录：readdir 可，unlink 不可

    try {
      // 直接清理：不抛、标记降级、文件保留。
      const result = cleanupExpiredLogs({ dir, now: NOW })
      expect(result.degraded).toBe(true)
      expect(result.deleted).toEqual([])
      expect(existsSync(lockedOld)).toBe(true)

      // exporter 创建 + 写盘不受清理失败影响。
      const exporter = createFileExporter({ dir, level: 'debug', now: () => NOW })
      expect(() =>
        exporter.export(makeMessage({ type: 'info', args: ['still ok'] })),
      ).not.toThrow()
      expect(existsSync(join(dir, '2026-10-12.jsonl'))).toBe(true)
    } finally {
      chmodSync(locked, 0o700)
    }
  })
})
