/**
 * domain/strategy.ts 单元测试（Task-3：策略资产迁出到 assets/strategies）。
 *
 * 覆盖：
 *   - 策略正文落 `<assetsDir>/strategies/<symbol>.md`，**不产生** strategy_versions /
 *     vNNN / current 等自建版本链文件；
 *   - 正文逐字节一致且**无 frontmatter**（首行不是 `---`）；
 *   - 每次变更产生一次 git commit，version = 12 位短 SHA；
 *   - 历史版本可 `get(symbol, 旧SHA)` 回读，`list` 按时间正序；
 *   - parentVersion 乐观并发校验（可选）；
 *   - 回滚场景：checkout 旧版 + commit 后 current 前进、正文回到旧版。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { StrategyRegistry } from '../src/domain/strategy.js'
import { ensureAssetsRepo } from '../src/assets/repo.js'

// git 子进程在并行测试下较慢：放宽单测超时，避免时序抖动。
vi.setConfig({ testTimeout: 30000 })

const SHA_RE = /^[0-9a-f]{12}$/

let dir: string
let reg: StrategyRegistry

function git(args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=dsh-ia', '-c', 'user.email=dsh-ia@localhost', ...args], {
    cwd: dir,
    encoding: 'utf8',
  })
}

function commitCount(): number {
  return Number.parseInt(git(['rev-list', '--count', '--all']).trim(), 10)
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dsh-ia-strategy-'))
  reg = new StrategyRegistry(dir)
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('strategy-registry.set（git 版本）', () => {
  it('首版返回 12 位短 SHA，current 与之一致，且不产生自建版本链', () => {
    const v = reg.set('588000', { text: '首版', rationale: '初始策略', by: 'test' })
    expect(v).toMatch(SHA_RE)
    expect(reg.current('588000')).toBe(v)

    // 目录布局：strategies/<symbol>.md + .git，绝无 strategy_versions / vNNN / current。
    expect(readFileSync(join(dir, 'strategies', '588000.md'), 'utf8')).toBe('首版')
    expect(existsSync(join(dir, '.git'))).toBe(true)
    expect(existsSync(join(dir, 'strategy_versions'))).toBe(false)
    expect(existsSync(join(dir, 'strategy'))).toBe(false)

    const names = readdirSync(join(dir, 'strategies'))
    expect(names).toEqual(['588000.md'])
    expect(names.some((n) => /^v\d{3,}/.test(n) || n === 'current')).toBe(false)
  })

  it('正文逐字节一致（含 CRLF/尾随换行/Unicode），且无 frontmatter', () => {
    const text = '# 策略\r\n\r\n阈值：0.6 —— 不加任何 --- 头\n'
    reg.set('588000', { text, rationale: 'byte exact' })
    const onDisk = readFileSync(join(dir, 'strategies', '588000.md'), 'utf8')
    expect(onDisk).toBe(text)
    expect(onDisk.split('\n')[0].startsWith('---')).toBe(false)
    expect(reg.get('588000')?.text).toBe(text)
  })

  it('每次变更产生一次 commit，version 为新短 SHA', () => {
    const v1 = reg.set('588000', { text: '一版', rationale: 'r1' })
    expect(commitCount()).toBe(1)
    const v2 = reg.set('588000', { text: '二版', rationale: 'r2', parentVersion: v1 })
    expect(commitCount()).toBe(2)
    expect(v2).not.toBe(v1)
    expect(reg.get('588000')?.version).toBe(v2)
    expect(reg.get('588000')?.meta.parent).toBe(v1)
    expect(reg.get('588000')?.meta.rationale).toBe('r2')
  })

  it('内容与当前完全一致 → no-op，返回当前短 SHA 且不新增 commit', () => {
    const v1 = reg.set('588000', { text: '同文', rationale: 'r1' })
    const before = commitCount()
    expect(reg.set('588000', { text: '同文', rationale: '重复' })).toBe(v1)
    expect(commitCount()).toBe(before)
  })

  it('parentVersion 提供但文件尚不存在 → 抛错', () => {
    expect(() =>
      reg.set('588000', { text: 'x', rationale: 'r', parentVersion: '0123456789ab' }),
    ).toThrow(/parentVersion/)
  })

  it('parentVersion 与当前版不一致 → 抛冲突', () => {
    reg.set('588000', { text: '一版', rationale: 'r1' })
    const v2 = reg.set('588000', { text: '二版', rationale: 'r2' })
    expect(() =>
      reg.set('588000', { text: '三版', rationale: 'r3', parentVersion: v2 }),
    ).not.toThrow()
    expect(() =>
      reg.set('588000', { text: '四版', rationale: 'r4', parentVersion: v2 }),
    ).toThrow(/不一致/)
  })

  it('不提供 parentVersion 也可迭代（乐观校验为可选）', () => {
    reg.set('588000', { text: '一版', rationale: 'r1' })
    const v2 = reg.set('588000', { text: '二版', rationale: 'r2' })
    expect(v2).toMatch(SHA_RE)
  })

  it('提交失败（git 不可用）→ 抛中文错误，不静默成功', () => {
    const broken = new StrategyRegistry(dir, () => {
      throw new Error('git: command not found')
    })
    expect(() => broken.set('588000', { text: 'x', rationale: 'r' })).toThrow(
      /资产层 git 仓库不可用|git .*失败/,
    )
  })
})

describe('strategy-registry.get / list（git 历史）', () => {
  it('get 读旧版正文与 rationale，version 为短 SHA', () => {
    const v1 = reg.set('588000', { text: '首版内容', rationale: 'r1' })
    reg.set('588000', { text: '二版内容', rationale: 'r2', parentVersion: v1 })
    const old = reg.get('588000', v1)
    expect(old?.text).toBe('首版内容')
    expect(old?.version).toBe(v1)
    expect(old?.symbol).toBe('588000')
    expect(old?.meta.rationale).toBe('r1')
  })

  it('未设定时 get 返回 undefined；非法 version 安全返回 undefined', () => {
    expect(reg.get('588000')).toBeUndefined()
    reg.set('588000', { text: '首版', rationale: 'r' })
    expect(reg.get('588000', '../../esc2')).toBeUndefined()
    expect(reg.get('588000', 'deadbeefdead')).toBeUndefined()
  })

  it('list 按 commit 时间正序返回，parent 链接正确', () => {
    const v1 = reg.set('588000', { text: 'a', rationale: 'r1' })
    const v2 = reg.set('588000', { text: 'b', rationale: 'r2' })
    reg.set('588000', { text: 'c', rationale: 'r3' })
    const list = reg.list('588000')
    expect(list.map((m) => m.version)).toEqual([v1, v2, reg.current('588000')])
    expect(list[0].parent).toBeUndefined()
    expect(list[1].parent).toBe(v1)
    expect(list[2].parent).toBe(v2)
    expect(list.map((m) => m.rationale)).toEqual(['r1', 'r2', 'r3'])
    expect(list.every((m) => SHA_RE.test(m.version))).toBe(true)
  })

  it('list 在无策略时返回空数组', () => {
    expect(reg.list('588000')).toEqual([])
  })
})

describe('回滚场景（git revert / checkout 旧版）', () => {
  it('写 v1 → v2 → checkout v1 正文并 commit：current 前进、正文回到 v1', () => {
    const v1 = reg.set('588000', { text: '一版正文', rationale: 'r1' })
    const v2 = reg.set('588000', { text: '二版正文', rationale: 'r2' })
    expect(reg.current('588000')).toBe(v2)

    // 回滚 = 把历史版本恢复到工作区并提交（等价 git revert 的内容效果）。
    git(['checkout', v1, '--', 'strategies/588000.md'])
    git(['commit', '-m', 'revert: 回到一版'])

    const now = reg.current('588000')
    expect(now).toMatch(SHA_RE)
    expect(now).not.toBe(v2)
    expect(reg.get('588000')?.text).toBe('一版正文')
    expect(reg.get('588000')?.meta.rationale).toBe('revert: 回到一版')
    // 历史仍可回读，list 长度递增到 3。
    expect(reg.get('588000', v2)?.text).toBe('二版正文')
    expect(reg.list('588000')).toHaveLength(3)
  })
})

describe('assets 外层仓库', () => {
  it('ensureAssetsRepo 幂等：init 一次，.gitignore 排除 skills/，不产生提交', () => {
    const first = ensureAssetsRepo({ assetsDir: dir, logger: () => {} })
    expect(first.initialized).toBe(true)
    expect(first.degraded).toBe(false)
    expect(existsSync(join(dir, '.git'))).toBe(true)
    expect(readFileSync(join(dir, '.gitignore'), 'utf8')).toContain('skills/')
    expect(commitCount()).toBe(0)

    const second = ensureAssetsRepo({ assetsDir: dir, logger: () => {} })
    expect(second.initialized).toBe(false)
    expect(second.degraded).toBe(false)
  })

  it('git 不可用时 ensureAssetsRepo 降级不抛', () => {
    const outcome = ensureAssetsRepo({
      assetsDir: join(dir, 'assets'),
      logger: () => {},
      gitRunner: () => {
        throw new Error('git missing')
      },
    })
    expect(outcome.degraded).toBe(true)
    expect(outcome.initialized).toBe(false)
  })
})
