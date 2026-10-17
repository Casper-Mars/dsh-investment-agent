/**
 * tester-t100462-assets-path.INDEPENDENT.spec.ts
 *
 * Tester 独立验证（不依赖 Developer 的 tests/paths.test.ts）：
 * dsh-finance 资产层根目录 `~/.dsh-ia/assets` 的路径解析、幂等创建、gitignore 边界。
 *
 * 被测产物：src/paths.ts（resolveAssetsDir / ensureAssetsDir）、仓库根 .gitignore
 *
 * 安全约束：
 *   - 所有创建类用例一律 `mkdtempSync(tmpdir())` + `DSH_IA_HOME` 指向临时目录，
 *     **绝不触碰真实 `~/.dsh-ia`**；
 *   - 不 mock git：gitignore 用例真实调用 git（cwd = 仓库根），与用户视角一致；
 *   - 不修改被测产物。
 */
import { spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FINANCE_HOME_ENV, getFinanceHome } from '../src/flags.js'
import {
  ensureAssetsDir,
  resolveAssetsDir,
  resolveFinanceHomeDir,
} from '../src/paths.js'

/** 仓库根（本文件位于 <repo>/tests/）。 */
const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

/** 用例开始前的真实环境值，模块级保存，afterAll 兜底恢复。 */
const SAVED_HOME_ENV = process.env[FINANCE_HOME_ENV]

const tmpDirs: string[] = []

function mkTmp(prefix = 'tester-t100462-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tmpDirs.push(dir)
  return dir
}

/** 真实执行 git，返回 { status, stdout, stderr }。 */
function git(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8' })
  return { status: r.status, stdout: (r.stdout ?? '').trimEnd(), stderr: (r.stderr ?? '').trimEnd() }
}

beforeEach(() => {
  delete process.env[FINANCE_HOME_ENV]
})

afterEach(() => {
  if (SAVED_HOME_ENV === undefined) delete process.env[FINANCE_HOME_ENV]
  else process.env[FINANCE_HOME_ENV] = SAVED_HOME_ENV
  for (const dir of tmpDirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      /* 清理失败不影响断言 */
    }
  }
})

afterAll(() => {
  if (SAVED_HOME_ENV === undefined) delete process.env[FINANCE_HOME_ENV]
  else process.env[FINANCE_HOME_ENV] = SAVED_HOME_ENV
})

// ─────────────────────────────────────────────────────────────────────────────
// 1. 默认路径
// ─────────────────────────────────────────────────────────────────────────────
describe('[AC1] 默认路径解析', () => {
  it('未设置 DSH_IA_HOME 时 = join(homedir(), ".dsh-ia", "assets")', () => {
    expect(process.env[FINANCE_HOME_ENV]).toBeUndefined()
    const dir = resolveAssetsDir()
    expect(dir).toBe(join(homedir(), '.dsh-ia', 'assets'))
  })

  it('返回绝对路径，且不含未展开的 "~"', () => {
    const dir = resolveAssetsDir()
    expect(isAbsolute(dir)).toBe(true)
    expect(dir.startsWith('/')).toBe(true)
    expect(dir.includes('~')).toBe(false)
  })

  it('与 getFinanceHome() 派生关系一致（assets 恒为 home 的直接子目录）', () => {
    const dir = resolveAssetsDir()
    expect(dirname(dir)).toBe(getFinanceHome())
    expect(dir).toBe(join(resolveFinanceHomeDir(), 'assets'))
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 2. 环境变量覆盖 + 相对路径归一
// ─────────────────────────────────────────────────────────────────────────────
describe('[AC1] DSH_IA_HOME 覆盖', () => {
  it('DSH_IA_HOME=<tmp> → <tmp>/assets', () => {
    const tmp = mkTmp()
    process.env[FINANCE_HOME_ENV] = tmp
    expect(resolveAssetsDir()).toBe(join(tmp, 'assets'))
  })

  it('相对路径输入被 resolve() 归一为绝对路径（与 resolveFinanceHomeDir 语义一致）', () => {
    const rel = 'tester-t100462-rel-home/nested'
    process.env[FINANCE_HOME_ENV] = rel
    const expectedHome = resolve(rel) // 相对 vitest 进程 cwd（仓库根）
    expect(getFinanceHome()).toBe(expectedHome)
    expect(resolveFinanceHomeDir()).toBe(expectedHome)
    const dir = resolveAssetsDir()
    expect(isAbsolute(dir)).toBe(true)
    expect(dir).toBe(join(expectedHome, 'assets'))
    // 绝对路径必须以 '/' 开头、不以相对输入为起点，且不含未归一化的 ".."/"." 段
    expect(dir.startsWith('/')).toBe(true)
    expect(dir.startsWith(rel)).toBe(false)
    expect(dir.split('/')).not.toContain('..')
    expect(dir.split('/')).not.toContain('.')
  })

  it('尾部斜杠输入等价（resolve 归一）', () => {
    const tmp = mkTmp()
    process.env[FINANCE_HOME_ENV] = tmp + '/'
    expect(resolveAssetsDir()).toBe(join(tmp, 'assets'))
  })

  it('空白值视为未设置，回落默认 home', () => {
    process.env[FINANCE_HOME_ENV] = '   '
    expect(resolveAssetsDir()).toBe(join(homedir(), '.dsh-ia', 'assets'))
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 3. 纯计算无副作用
// ─────────────────────────────────────────────────────────────────────────────
describe('[AC1] resolveAssetsDir 纯计算、无副作用', () => {
  it('调用后目标目录仍不存在', () => {
    const tmp = mkTmp()
    const home = join(tmp, 'no-such-home')
    process.env[FINANCE_HOME_ENV] = home
    const dir = resolveAssetsDir()
    expect(dir).toBe(join(home, 'assets'))
    expect(existsSync(dir)).toBe(false)
    expect(existsSync(home)).toBe(false)
  })

  it('多次调用不产生任何 fs 变化', () => {
    const tmp = mkTmp()
    process.env[FINANCE_HOME_ENV] = tmp
    const before = readdirSync(tmp)
    resolveAssetsDir()
    resolveAssetsDir()
    resolveAssetsDir()
    expect(readdirSync(tmp)).toEqual(before)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 4. 幂等创建
// ─────────────────────────────────────────────────────────────────────────────
describe('[AC1] ensureAssetsDir 幂等创建', () => {
  it('首次创建、二次调用返回同一路径且不抛错', () => {
    const tmp = mkTmp()
    process.env[FINANCE_HOME_ENV] = tmp

    const first = ensureAssetsDir()
    expect(first).toBe(join(tmp, 'assets'))
    expect(existsSync(first)).toBe(true)
    expect(statSync(first).isDirectory()).toBe(true)

    let second: string | undefined
    expect(() => {
      second = ensureAssetsDir()
    }).not.toThrow()
    expect(second).toBe(first)
    expect(statSync(second as string).isDirectory()).toBe(true)
  })

  it('已有目录上调用不重置元数据（mtime 不变，确为 no-op）', () => {
    const tmp = mkTmp()
    process.env[FINANCE_HOME_ENV] = tmp
    const dir = ensureAssetsDir()
    const before = statSync(dir)
    ensureAssetsDir()
    const after = statSync(dir)
    expect(after.ino).toBe(before.ino)
    expect(after.mtimeMs).toBe(before.mtimeMs)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 5. 父目录连带创建
// ─────────────────────────────────────────────────────────────────────────────
describe('[AC1] 多级父目录递归创建', () => {
  it('DSH_IA_HOME 为不存在的多级路径时递归创建', () => {
    const tmp = mkTmp()
    const home = join(tmp, 'l1', 'l2', 'l3')
    process.env[FINANCE_HOME_ENV] = home
    expect(existsSync(home)).toBe(false)

    const dir = ensureAssetsDir()
    expect(dir).toBe(join(home, 'assets'))
    expect(statSync(dir).isDirectory()).toBe(true)
    expect(statSync(join(tmp, 'l1')).isDirectory()).toBe(true)
    expect(statSync(join(tmp, 'l1', 'l2')).isDirectory()).toBe(true)
    expect(statSync(home).isDirectory()).toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 6. 非空目录不报错、不破坏内容
// ─────────────────────────────────────────────────────────────────────────────
describe('[AC1] 已存在的非空 assets 目录', () => {
  it('再次 ensureAssetsDir() 不抛错，且保留既有文件内容', () => {
    const tmp = mkTmp()
    process.env[FINANCE_HOME_ENV] = tmp
    const dir = join(tmp, 'assets')
    mkdirSync(dir, { recursive: true })
    const payload = '# 既有资产内容\nkeep-me\n'
    writeFileSync(join(dir, 'skills.md'), payload)
    writeFileSync(join(dir, '.hidden-keep'), 'x')

    expect(() => ensureAssetsDir()).not.toThrow()

    expect(readFileSync(join(dir, 'skills.md'), 'utf8')).toBe(payload)
    expect(readFileSync(join(dir, '.hidden-keep'), 'utf8')).toBe('x')
    expect(readdirSync(dir).sort()).toEqual(['.hidden-keep', 'skills.md'])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 7. .gitignore 真实验证（shell 层面，不 mock）
// ─────────────────────────────────────────────────────────────────────────────
describe('[AC3] .gitignore 边界（真实 git）', () => {
  it('data/ 被忽略，且规则来自新增条目 data/', () => {
    const r = git(['check-ignore', '-v', 'data/x'])
    expect(r.status).toBe(0)
    expect(r.stdout).toMatch(/^\.gitignore:(\d+):\/?data\/\tdata\/x$/)
    const line = Number(r.stdout.match(/^\.gitignore:(\d+):/)![1])
    expect(readFileSync(join(REPO_ROOT, '.gitignore'), 'utf8').split('\n')[line - 1].replace(/^\//, '')).toBe('data/')
  })

  it('logs/ 被忽略，且规则来自新增条目 logs/', () => {
    const r = git(['check-ignore', '-v', 'logs/x'])
    expect(r.status).toBe(0)
    expect(r.stdout).toMatch(/^\.gitignore:(\d+):\/?logs\/\tlogs\/x$/)
    const line = Number(r.stdout.match(/^\.gitignore:(\d+):/)![1])
    expect(readFileSync(join(REPO_ROOT, '.gitignore'), 'utf8').split('\n')[line - 1].replace(/^\//, '')).toBe('logs/')
  })

  it('assets/ 不被忽略（exit 1，无输出）', () => {
    const r = git(['check-ignore', '-v', 'assets/x'])
    expect(r.status).toBe(1)
    expect(r.stdout).toBe('')
  })

  it('嵌套路径同样命中：data/tasks/x、logs/2026/x.log', () => {
    expect(git(['check-ignore', '-v', 'data/tasks/x']).status).toBe(0)
    expect(git(['check-ignore', '-v', 'logs/2026/x.log']).status).toBe(0)
    expect(git(['check-ignore', '-v', 'assets/skills/x.md']).status).toBe(1)
  })

  it('无已被跟踪的 data/ 或 logs/ 文件被误伤', () => {
    const tracked = git(['ls-files'])
    expect(tracked.status).toBe(0)
    const hit = tracked.stdout.split('\n').filter((f) => /(^|\/)(data|logs)\//.test(f))
    expect(hit).toEqual([])
  })

  it('.gitignore 中 data/ 与 logs/ 条目确实存在且各仅一次', () => {
    const lines = readFileSync(join(REPO_ROOT, '.gitignore'), 'utf8').split('\n')
    const normalized = lines.map((l) => l.replace(/^\//, ''))
    expect(normalized.filter((l) => l === 'data/')).toHaveLength(1)
    expect(normalized.filter((l) => l === 'logs/')).toHaveLength(1)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 8. 无兜底分支静态检查
// ─────────────────────────────────────────────────────────────────────────────
describe('[AC2] 无旧路径兜底 / 无只读回落', () => {
  const SRC = readFileSync(join(REPO_ROOT, 'src', 'paths.ts'), 'utf8')

  /** 抽取指定导出函数的源码块（到下一个顶层 `export` 或文件尾）。 */
  function fnBody(name: string): string {
    const start = SRC.indexOf(`export function ${name}`)
    expect(start).toBeGreaterThanOrEqual(0)
    const rest = SRC.slice(start)
    const next = rest.slice(1).search(/\nexport (function|const|class|interface|type)\b/)
    return next === -1 ? rest : rest.slice(0, next + 1)
  }

  it('resolveAssetsDir 内无 existsSync / 无环境变量直读 / 无旧路径判断', () => {
    const body = fnBody('resolveAssetsDir')
    expect(body).not.toContain('existsSync')
    expect(body).not.toContain('process.env')
    expect(body).not.toMatch(/data\/(skills|strategy|tasks)/)
    expect(body).not.toContain('readdirSync')
    expect(body).not.toContain('try {')
  })

  it('ensureAssetsDir 内无 existsSync 回落、无旧路径判断', () => {
    const body = fnBody('ensureAssetsDir')
    expect(body).not.toContain('existsSync')
    expect(body).not.toMatch(/data\/(skills|strategy|tasks)/)
    expect(body).not.toContain('copySync')
    expect(body).not.toContain('renameSync')
  })

  it('assets 实现仅经 resolveFinanceHomeDir 派生（不直读 env、不复用 dataRoot 覆盖变量）', () => {
    const body = fnBody('resolveAssetsDir')
    expect(body).toContain('resolveFinanceHomeDir()')
    expect(body).toContain("'assets'")
    expect(body).not.toContain('DATA_ROOT_ENV')
    expect(body).not.toContain('resolveFinanceDataDir')
  })

  it('全文件中 assets 相关代码不含旧路径迁移/兼容注释性分支标记', () => {
    const assetLines = SRC.split('\n')
      .map((l, i) => ({ l, i }))
      .filter(({ l }) => l.includes('ssets'))
      .map(({ l }) => l)
      .join('\n')
    expect(assetLines).not.toMatch(/legacy|migrat|fallback|backward|兼容旧|旧路径/i)
    expect(assetLines).not.toMatch(/existsSync/)
  })
})
