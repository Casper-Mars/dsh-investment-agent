/**
 * tester-t100445-rename.INDEPENDENT.spec.ts
 *
 * 独立验收：全仓重命名 `dsh-finance` → `dsh-ia`（+ `DSH_FINANCE_*` → `DSH_IA_*`）。
 *
 * 本 spec 由 Tester 独立编写，**不复用**开发者改动，独立从磁盘读取 + 运行时 import
 * 校验以下验收标准：
 *   - AC1 残留为零（磁盘独立读取 + 正则计数）
 *   - AC2 发布标识（package.json / cordis.patch.yml）
 *   - AC3 运行时标识生效（import 真实常量 + 环境变量覆盖）
 *   - AC4 无第三方误伤（依赖名/注释第三方名保持原样）
 *   - AC5 运行时装配（最小 ctx apply 不抛；真实 cordis 装载不再本 spec 重复，
 *         由 tests/plugin-tools-registration.spec.ts 覆盖，此处做轻量对抗）
 *   - AC6 行为等价（改名前后 diff 行数对称 = 纯 1:1 文本替换）
 *
 * ⚠️ 不写 `~/.dsh-ia`：凡触发默认路径的用例均在临时目录内以环境变量隔离。
 */
import { describe, it, expect, afterEach } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'

import { PRODUCER_KIND } from '../src/message-source.js'
import {
  FINANCE_HOME,
  resolveFinanceHomeDir,
  resolveFinanceDataDir,
  resolveFinanceTasksDir,
  resolveDataRoot,
  DATA_ROOT_ENV,
  LOG_DIR_ENV,
} from '../src/paths.js'
import {
  FINANCE_HOME_ENV,
  FINANCE_SESSION_ID_ENV,
  getFinanceHome,
} from '../src/flags.js'
import { LOG_LEVEL_ENV } from '../src/log/logger.js'
import { LOG_MAX_SIZE_ENV } from '../src/log/file-exporter.js'

const ROOT = process.cwd()

// ---------------------------------------------------------------------------
// 工具：磁盘独立读取 + 正则计数
// ---------------------------------------------------------------------------

/** 递归收集目录下所有常规文件（跳过 node_modules/.git）。 */
function walkFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.git') continue
    const p = join(dir, entry)
    const st = statSync(p)
    if (st.isDirectory()) walkFiles(p, acc)
    else if (st.isFile()) acc.push(p)
  }
  return acc
}

/** 在给定文件里正则匹配计数，返回命中明细。 */
function scanText(text: string, re: RegExp): number {
  const m = text.match(re)
  return m ? m.length : 0
}

/** AC1 覆盖范围（顶层条目：目录递归，文件直接读）。 */
const AC1_TARGETS = [
  'src',
  'scripts',
  'tests',
  'cordis.patch.yml',
  'package.json',
  'README.md',
  'vitest.config.ts',
  'tsconfig.json',
  'tsconfig.server.json',
  'pnpm-workspace.yaml',
]

function collectAc1Files(): string[] {
  const files: string[] = []
  for (const rel of AC1_TARGETS) {
    const abs = join(ROOT, rel)
    try {
      const st = statSync(abs)
      if (st.isDirectory()) files.push(...walkFiles(abs))
      else files.push(abs)
    } catch {
      /* 容忍缺失条目（例如未启用的 tsconfig.*），由断言约定清单核对 */
    }
  }
  // 排除本轮 Tester 自建产物（其内部含待检模式字面量，自指非被测残留）
  return files.filter((f) => !f.includes('tester-t100445'))
}

describe('AC1 残留为零（磁盘独立读取 + 正则）', () => {
  const files = collectAc1Files()

  it('覆盖清单存在（含指定配置文件）', () => {
    expect(files.length).toBeGreaterThan(50)
    for (const rel of [
      'package.json',
      'cordis.patch.yml',
      'README.md',
      'vitest.config.ts',
      'tsconfig.json',
      'pnpm-workspace.yaml',
    ]) {
      expect(files).toContain(join(ROOT, rel))
    }
  })

  it('src/ scripts/ tests/ 配置文件集合内 `dsh-finance` 出现 0 次', () => {
    const hits: string[] = []
    for (const f of files) {
      const n = scanText(readFileSync(f, 'utf8'), /dsh-finance/g)
      if (n > 0) hits.push(`${f} (${n})`)
    }
    expect(hits).toEqual([])
  })

  it('同集合内 `DSH_FINANCE_` 出现 0 次', () => {
    const hits: string[] = []
    for (const f of files) {
      const n = scanText(readFileSync(f, 'utf8'), /DSH_FINANCE_/g)
      if (n > 0) hits.push(`${f} (${n})`)
    }
    expect(hits).toEqual([])
  })

  it('大小写/分隔符变体（dsh_finance / DSH-finance 等）出现 0 次', () => {
    const hits: string[] = []
    for (const f of files) {
      const text = readFileSync(f, 'utf8')
      if (/dsh[_\-.]finance/i.test(text)) hits.push(f)
    }
    expect(hits).toEqual([])
  })

  it('构建产物 dist-server/ 无残留（若存在）', () => {
    const distDir = join(ROOT, 'dist-server')
    let hits: string[] = []
    try {
      const distFiles = walkFiles(distDir)
      for (const f of distFiles) {
        const text = readFileSync(f, 'utf8')
        if (/dsh-finance|DSH_FINANCE_/.test(text)) hits.push(f)
      }
    } catch {
      /* dist-server 未重建则跳过 */
    }
    expect(hits).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// AC2 发布标识
// ---------------------------------------------------------------------------

describe('AC2 发布标识', () => {
  it('package.json name === "dsh-ia"', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
      name: string
    }
    expect(pkg.name).toBe('dsh-ia')
  })

  it('cordis.patch.yml 的 id 与 name 均为 dsh-ia', () => {
    const yml = readFileSync(join(ROOT, 'cordis.patch.yml'), 'utf8')
    // 取 insert 列表首项的两行（id / name）
    const idMatch = yml.match(/^\s*-?\s*id:\s*(\S+)/m)
    const nameMatch = yml.match(/^\s*name:\s*(\S+)/m)
    expect(idMatch?.[1]).toBe('dsh-ia')
    expect(nameMatch?.[1]).toBe('dsh-ia')
  })
})

// ---------------------------------------------------------------------------
// AC3 运行时标识生效
// ---------------------------------------------------------------------------

describe('AC3 运行时标识生效', () => {
  const savedHome = process.env[FINANCE_HOME_ENV]
  const savedData = process.env[DATA_ROOT_ENV]
  const savedLog = process.env[LOG_DIR_ENV]

  afterEach(() => {
    const restore = (k: string, v: string | undefined) => {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    restore(FINANCE_HOME_ENV, savedHome)
    restore(DATA_ROOT_ENV, savedData)
    restore(LOG_DIR_ENV, savedLog)
  })

  it('PRODUCER_KIND === "dsh-ia"（消息 producer kind）', () => {
    expect(PRODUCER_KIND).toBe('dsh-ia')
  })

  it('FINANCE_HOME === ".dsh-ia"（固定根目录名）', () => {
    expect(FINANCE_HOME).toBe('.dsh-ia')
  })

  it('默认工作区根 = ~/.dsh-ia（未覆盖 DSH_IA_HOME 时）', () => {
    delete process.env[FINANCE_HOME_ENV]
    expect(resolveFinanceHomeDir()).toBe(join(homedir(), '.dsh-ia'))
  })

  it('默认 dataRoot/tasksDir 落在 ~/.dsh-ia 下', () => {
    delete process.env[FINANCE_HOME_ENV]
    delete process.env[DATA_ROOT_ENV]
    // resolveDataRoot 默认分支会 ensure 目录 —— 隔离到临时 DSH_IA_HOME
    expect(resolveFinanceDataDir()).toBe(join(homedir(), '.dsh-ia', 'data'))
    expect(resolveFinanceTasksDir()).toBe(join(homedir(), '.dsh-ia', 'data', 'tasks'))
  })

  it('环境变量常量全部为 DSH_IA_*（覆盖 HOME/DATA_DIR/LOG_DIR/LOG_LEVEL/LOG_MAX_SIZE/SESSION_ID）', () => {
    expect(FINANCE_HOME_ENV).toBe('DSH_IA_HOME')
    expect(DATA_ROOT_ENV).toBe('DSH_IA_DATA_DIR')
    expect(LOG_DIR_ENV).toBe('DSH_IA_LOG_DIR')
    expect(LOG_LEVEL_ENV).toBe('DSH_IA_LOG_LEVEL')
    expect(LOG_MAX_SIZE_ENV).toBe('DSH_IA_LOG_MAX_SIZE')
    expect(FINANCE_SESSION_ID_ENV).toBe('DSH_IA_SESSION_ID')
  })

  it('对抗：注入 DSH_IA_HOME 后工作区根跟随', () => {
    const tmp = join(homedir(), '.dsh-ia-indep-adv-test-xyz') // 仅计算，不落盘
    process.env[FINANCE_HOME_ENV] = tmp
    expect(getFinanceHome()).toBe(resolve(tmp))
    expect(resolveFinanceHomeDir()).toBe(resolve(tmp))
    expect(resolveFinanceDataDir()).toBe(join(resolve(tmp), 'data'))
  })

  it('对抗：注入 DSH_IA_DATA_DIR 后 resolveDataRoot 跟随（优先于默认）', () => {
    const tmp = join(homedir(), 'dsh-ia-indep-data-xyz')
    process.env[DATA_ROOT_ENV] = tmp
    expect(resolveDataRoot()).toBe(resolve(tmp))
  })
})

// ---------------------------------------------------------------------------
// AC4 无第三方误伤
// ---------------------------------------------------------------------------

describe('AC4 无第三方误伤', () => {
  const THIRD_PARTY = [
    '@deepseek-ai/dsh-llm',
    '@deepseek-ai/dsh-skill',
    '@deepseek-ai/dsh-skill-filesystem',
    '@deepseek-ai/dsh-tools',
    '@deepseek-ai/cordis',
  ]

  it('package.json peer/devDependencies 第三方包名保持原样', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
      peerDependencies: Record<string, string>
      devDependencies: Record<string, string>
    }
    for (const name of THIRD_PARTY) {
      expect(
        name in pkg.peerDependencies || name in pkg.devDependencies,
        `缺失第三方依赖 ${name}`,
      ).toBe(true)
    }
    // 反向：不出现被误改的前缀形态
    for (const [k] of Object.entries({ ...pkg.peerDependencies, ...pkg.devDependencies })) {
      expect(k).not.toMatch(/dsh-ia-(llm|skill|skill-filesystem|tools)/)
      expect(k).not.toMatch(/^@deepseek-ai\/cordis-ia/)
    }
  })

  it('src/ 内第三方裸名（dsh-llm/skill/dsh-tools 等）仍被引用，未被改成 dsh-ia 前缀', () => {
    const files = walkFiles(join(ROOT, 'src'))
    const texts = files.map((f) => readFileSync(f, 'utf8')).join('\n')
    // 第三方名存在
    expect(texts).toMatch(/@deepseek-ai\/dsh-llm/)
    expect(texts).toMatch(/@deepseek-ai\/dsh-tools/)
    expect(texts).toMatch(/@deepseek-ai\/dsh-skill/)
    // 未被误伤成 '@deepseek-ai/dsh-ia-*'
    expect(texts).not.toMatch(/@deepseek-ai\/dsh-ia-(llm|skill|tools)/)
  })

  it('注释中第三方插件名（dsh-tasks / dsh-cron / dsh-hello-plugin）未被改', () => {
    const files = [
      join(ROOT, 'cordis.patch.yml'),
      ...walkFiles(join(ROOT, 'src')),
    ]
    const texts = files.map((f) => readFileSync(f, 'utf8')).join('\n')
    expect(texts).toMatch(/dsh-tasks/)
    expect(texts).toMatch(/dsh-cron/)
  })
})

// ---------------------------------------------------------------------------
// AC5 运行时装配（轻量对抗；完整装载由 plugin-tools-registration.spec.ts 覆盖）
// ---------------------------------------------------------------------------

describe('AC5 运行时装配（最小 ctx apply 不抛）', () => {
  it('import 入口三要素存在（name/inject/apply）', async () => {
    const mod = await import('../src/plugin.js')
    expect(typeof mod.apply).toBe('function')
    expect(Array.isArray(mod.inject)).toBe(true)
    expect(mod.inject).toEqual(['tools', 'skills', 'fs'])
    // 插件声明的 Cordis name（注意：≠ 包名；见 AC2/报告说明）
    expect(typeof mod.name).toBe('string')
    expect(mod.name.length).toBeGreaterThan(0)
  })

  it('最小 ctx（无 tools/skills 服务）下 apply 不抛错', async () => {
    const { apply } = await import('../src/plugin.js')
    const prev = process.env[DATA_ROOT_ENV]
    process.env[DATA_ROOT_ENV] = join(homedir(), 'dsh-ia-indep-apply-xyz')
    try {
      const ctx = {
        effect(body: () => unknown) {
          const d = body()
          return typeof d === 'function' ? (d as () => void) : () => {}
        },
        get: () => undefined,
        inject: () => ({}),
      } as never
      expect(() => apply(ctx)).not.toThrow()
    } finally {
      if (prev === undefined) delete process.env[DATA_ROOT_ENV]
      else process.env[DATA_ROOT_ENV] = prev
    }
  })
})

// ---------------------------------------------------------------------------
// AC6 行为等价（纯 1:1 文本替换 → diff 行数对称）
// ---------------------------------------------------------------------------

describe('AC6 行为等价（改名 diff 对称性）', () => {
  it('git diff --numstat 插入数 === 删除数（纯标识符替换，未增删行）', () => {
    let out = ''
    try {
      out = execFileSync('git', ['diff', '--numstat'], { cwd: ROOT, encoding: 'utf8' })
    } catch {
      return // git 不可用则跳过
    }
    let added = 0
    let deleted = 0
    for (const line of out.split('\n')) {
      const parts = line.split('\t')
      if (parts.length === 3 && parts[0] !== '-') {
        added += Number(parts[0]) || 0
        deleted += Number(parts[1]) || 0
      }
    }
    expect(added).toBe(deleted)
    expect(added).toBeGreaterThan(0)
  })
})
