#!/usr/bin/env node
/**
 * t100474 任务-06：端到端验证「固件 skill 真实装载后可见、可发现、可触发进化」。
 *
 * 验的三件事：
 *   A. 冷启动后 3 个固件 skill（task-authorship / skill-authorship / finance-evolution）
 *      出现在 skills 列表中，且 source=runtime、provider=runtime；5 个可进化 seed 同时可见。
 *   B. 组装后的模型 prompt（<available_skills> 目录）包含 finance-evolution 的 description 原文。
 *   C. 一次最小触发：assets 里的 trend-analysis description 被改坏并已入库 →
 *      agent 按 finance-evolution 流程定位资产、修复、提交；commit message 含「改了什么 / 为什么改」。
 *
 * 运行方式（真实 LLM，耗时约 1-4 分钟）：
 *   node tests/tester-t100474-e2e-firmware-skill.mjs
 *   node tests/tester-t100474-e2e-firmware-skill.mjs --keep     # 保留临时目录
 *
 * 隔离：
 *   - 每次运行 mkdtemp 一个 DSH_IA_HOME（资产/数据）和一个 DSH_HOME（会话/凭据副本）；
 *   - 真实 HOME 保留，仅从 ~/.dsh/.credentials.yaml 复制凭据到临时 DSH_HOME；
 *   - 运行前后快照真实 ~/.dsh-ia（HEAD / status / mtime），任何变化都判失败；
 *   - 成功默认清理临时目录，失败保留并在 /tmp 写诊断日志。
 *
 * 架构说明（重要）：
 *   dsh 的 `finance` profile 是 web app（web-startup 抢占 cmdline），不能直接承载 SDK
 *   stdio JSON-RPC；把 sdk-app 叠加到 finance 会因两个 app 同时 parseCmdline 而挂起。
 *   因此本脚本使用官方 `sdk` profile，并通过 --patch 插入与 finance profile 完全相同的
 *   `dsh-ia` 插件入口（指向本仓库 dist-server/index.js，即 finance profile link 的同一产物），
 *   再叠加一个仅测试用的 skill registry 探针工具，用于直接读取 source/provider。
 */
import { execFileSync } from 'node:child_process'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(SCRIPT_DIR, '..')
const REPORT_PATH = join(SCRIPT_DIR, 'tester-t100474-e2e-firmware-skill.REPORT.md')
const SUMMARY_PATH = join(SCRIPT_DIR, 'tester-t100474-e2e-firmware-skill.summary.json')

const FIRMWARE = ['task-authorship', 'skill-authorship', 'finance-evolution']
const EVOLVABLE = [
  'analysis-decision',
  'grid-strategy',
  'stop-rule',
  'strategy-authorship',
  'trend-analysis',
]
const FINANCE_EVOLUTION_SKILL = join(REPO_ROOT, 'src/skills/finance-evolution/SKILL.md')
const TREND_SEED = join(REPO_ROOT, 'src/skills/trend-analysis/SKILL.md')
// 期望值直接取自源码 frontmatter，避免脚本内复制一份后与源码漂移。
const FINANCE_EVOLUTION_DESC = readFrontmatterDescription(FINANCE_EVOLUTION_SKILL)
const TREND_DESC = readFrontmatterDescription(TREND_SEED)

const argv = process.argv.slice(2)
const KEEP = argv.includes('--keep')
const VERBOSE = argv.includes('--verbose')

const startedAt = new Date()
const runLog = []
function log(line = '') {
  const text = String(line)
  runLog.push(text)
  console.log(text)
}
function section(title) {
  log('')
  log(`===== ${title} =====`)
}

function fail(message) {
  throw new Error(message)
}

function whichDsh() {
  if (process.env.DSH_BIN) return process.env.DSH_BIN
  try {
    return execFileSync('which', ['dsh'], { encoding: 'utf8' }).trim()
  } catch {
    const fallback = join(homedir(), 'bin', 'dsh')
    if (existsSync(fallback)) return fallback
    fail('找不到 dsh：请设置 DSH_BIN 或把 dsh 放进 PATH')
  }
}

function resolveSdkClient(dshBin) {
  if (process.env.DSH_SDK_CLIENT) {
    if (!existsSync(process.env.DSH_SDK_CLIENT)) fail(`DSH_SDK_CLIENT 不存在：${process.env.DSH_SDK_CLIENT}`)
    return process.env.DSH_SDK_CLIENT
  }
  try {
    // <harness>/apps/cli/lib/bin.js → <harness>/packages/sdk/client/lib/index.js
    const real = realpathSync(dshBin)
    const candidate = resolve(dirname(real), '../../..', 'packages/sdk/client/lib/index.js')
    if (existsSync(candidate)) return candidate
  } catch {
    /* fall through */
  }
  const fallback = '/Users/reachlucifer/project/opc/deepseek-harness/packages/sdk/client/lib/index.js'
  if (existsSync(fallback)) return fallback
  fail('找不到 @deepseek-ai/dsh-sdk-client 的 lib/index.js；请设置 DSH_SDK_CLIENT')
}

function git(cwd, args, options = {}) {
  return execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    ...options,
  })
}

function gitSafe(cwd, args) {
  try {
    return git(cwd, args).trim()
  } catch (err) {
    return `<<git failed: ${err?.message ?? String(err)}>>`
  }
}

function snapshotRealFinanceHome() {
  const dir = join(homedir(), '.dsh-ia')
  if (!existsSync(dir)) return { exists: false }
  const assets = join(dir, 'assets')
  return {
    exists: true,
    mtimeMs: statSync(dir).mtimeMs,
    assetsExists: existsSync(assets),
    head: existsSync(assets) ? gitSafe(assets, ['rev-parse', 'HEAD']) : null,
    status: existsSync(assets) ? gitSafe(assets, ['status', '--porcelain']) : null,
  }
}

function readFrontmatterDescription(file) {
  const text = readFileSync(file, 'utf8')
  const match = /^description:\s*"?(.*?)"?\s*$/m.exec(text)
  if (!match) fail(`无法从 ${file} 解析 description`)
  return match[1]
}

/** 从会话事件里取 <available_skills> 目录事件（source.kind = skill-catalog）。 */
function findSkillCatalog(events) {
  for (const event of events) {
    if (event.type !== 'user/message') continue
    const source = event.data?.source
    if (source?.kind !== 'skill-catalog') continue
    const text = (event.data.content ?? [])
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('\n')
    return { text, entries: source.entries ?? [] }
  }
  return undefined
}

/** 从会话事件里取某个工具调用对应的文本结果。 */
function findToolResult(events, toolName) {
  const callNames = new Map()
  for (const event of events) {
    if (event.type === 'tool/call') callNames.set(event.data.callId, event.data.name)
  }
  for (const event of events) {
    if (event.type !== 'tool/result') continue
    const callId = event.data.toolCallId ?? event.data.message?.toolCallId
    if (callNames.get(callId) !== toolName) continue
    return (event.data.message?.content ?? [])
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('\n')
  }
  return undefined
}

function findAssistantTexts(events) {
  return events
    .filter((event) => event.type === 'assistant/message')
    .flatMap((event) => event.data?.message?.content ?? [])
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
}

function buildProbePluginSource() {
  // 只测试用：直接把 ctx.skills.list() 的 source/provider 暴露给模型。
  // 不依赖任何 import，避免临时目录下的模块解析问题。
  return `export const name = 't100474-skill-registry-probe'
export const inject = ['skills', 'tools']
export function apply(ctx) {
  ctx.tools.register({
    name: 't100474_skill_registry',
    description: 'Test-only instrumentation: dump the current session skill registry, including source and provider.',
    parameters: { type: 'object', properties: {} },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          skills: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                name: { type: 'string' },
                description: { type: 'string' },
                source: { type: 'string' },
                provider: { type: 'string' },
                path: { type: 'string' },
                modelInvocable: { type: 'boolean' },
              },
            },
          },
        },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute() {
      const skills = await ctx.skills.list({ cwd: process.env.T100474_SESSION_CWD })
      return {
        skills: skills.map((s) => ({
          name: s.name,
          description: s.description,
          source: s.source,
          provider: s.provider,
          ...(s.path === undefined ? {} : { path: s.path }),
          modelInvocable: s.invocation.modelInvocable,
        })),
      }
    },
  })
}
`
}

function yamlQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`
}

function writeHarnessPatch(pluginFile) {
  return [
    '# t100474: use the same pi-ai route as the finance profile.',
    '- id: llm-pi-ai',
    '  config:',
    '    providers:',
    '      ds:',
    '        apiKeyEnv: DS_API_KEY',
    '        api: openai-responses',
    '        baseURL: https://api.deepseek.com',
    '        models:',
    '          - id: deepseek-flash',
    '            name: DeepSeek-V4.1-Flash',
    '            contextWindow: 1048576',
    '            maxTokens: 393216',
    '',
    '# t100474: insert the same dsh-ia plugin entry the finance profile links.',
    '- insert:',
    '    - id: dsh-ia',
    `      name: ${yamlQuote(join(REPO_ROOT, 'dist-server/index.js'))}`,
    '      inject:',
    '        - tools',
    '        - skills',
    '        - fs',
    '    - id: t100474-skill-registry-probe',
    `      name: ${yamlQuote(pluginFile)}`,
    '      inject:',
    '        - skills',
    '        - tools',
    '',
  ].join('\n')
}

function ensureBuiltArtifacts() {
  const entry = join(REPO_ROOT, 'dist-server/index.js')
  if (!existsSync(entry)) {
    fail(`缺少构建产物 ${entry}；请先在仓库根目录执行 pnpm build（本脚本不修改 src/**，也不负责构建）`)
  }
  for (const name of [...EVOLVABLE, ...FIRMWARE]) {
    const file = join(REPO_ROOT, 'dist-server/skills', name, 'SKILL.md')
    if (!existsSync(file)) fail(`缺少构建产物 ${file}；请先执行 pnpm build`)
  }
}

async function phaseA(h) {
  section('阶段 A：冷启动 + 可见性 + description')
  const sessionId = `t100474-a-${Date.now()}`
  const prompt = [
    '请直接执行以下三步，不要反问我，也不要修改任何文件：',
    '1) 调用 t100474_skill_registry 工具，并把工具返回的 JSON 原样输出（不要改写、不要省略）。',
    '2) 根据返回结果中的 source 字段，列出 source=runtime 的全部 skill 名称。',
    '3) 原样给出 finance-evolution 的 description 字段值。',
  ].join('\n')

  let result = await h.run(prompt, { sessionId })
  log(`第一轮结束：events=${result.events.length}，finalResponse 长度=${result.finalResponse.length}`)

  let registryRaw = findToolResult(result.events, 't100474_skill_registry')
  let registry
  if (registryRaw !== undefined) {
    try {
      registry = JSON.parse(registryRaw)
    } catch (err) {
      log(`registry 工具返回不是合法 JSON：${err?.message ?? String(err)}`)
    }
  }

  // 模型偶尔只输出技能清单、不调用探针；用新会话重试一次（证据取成功的那次）。
  if (registry?.skills === undefined) {
    log('未拿到 registry 工具结果，使用新会话重试一次…')
    const retry = await h.run(prompt, { sessionId: `${sessionId}-retry` })
    registryRaw = findToolResult(retry.events, 't100474_skill_registry')
    if (registryRaw !== undefined) {
      try {
        registry = JSON.parse(registryRaw)
      } catch (err) {
        log(`重试 registry 返回不是合法 JSON：${err?.message ?? String(err)}`)
      }
    }
    result = {
      ...retry,
      events: [...result.events, ...retry.events],
    }
    log(`重试结束：events=${retry.events.length}`)
  }

  const catalog = findSkillCatalog(result.events)
  if (catalog === undefined) fail('会话事件里没有 skill-catalog（<available_skills>）')
  if (registry?.skills === undefined) fail('两次尝试都没有拿到 t100474_skill_registry 返回')

  const byName = new Map(registry.skills.map((skill) => [skill.name, skill]))
  const firmwareEvidence = FIRMWARE.map((name) => {
    const skill = byName.get(name)
    return {
      name,
      found: skill !== undefined,
      source: skill?.source,
      provider: skill?.provider,
      description: skill?.description,
      path: skill?.path,
    }
  })
  const evolvableEvidence = EVOLVABLE.map((name) => {
    const skill = byName.get(name)
    return {
      name,
      found: skill !== undefined,
      source: skill?.source,
      provider: skill?.provider,
      path: skill?.path,
    }
  })

  for (const item of firmwareEvidence) {
    if (!item.found) fail(`registry 中缺少固件 skill：${item.name}`)
    if (item.source !== 'runtime') fail(`${item.name} 的 source 不是 runtime，而是 ${JSON.stringify(item.source)}`)
    if (item.provider !== 'runtime') fail(`${item.name} 的 provider 不是 runtime，而是 ${JSON.stringify(item.provider)}`)
  }
  for (const item of evolvableEvidence) {
    if (!item.found) fail(`registry 中缺少可进化 seed：${item.name}`)
  }

  const catalogNames = new Set(catalog.entries.map((entry) => entry.name))
  for (const name of FIRMWARE) {
    if (!catalogNames.has(name)) fail(`<available_skills> 目录中缺少固件 skill：${name}`)
  }
  const catalogFinance = catalog.entries.find((entry) => entry.name === 'finance-evolution')
  const descriptionInPrompt = catalog.text.includes(FINANCE_EVOLUTION_DESC)
  const descriptionInRegistry = catalogFinance?.description === FINANCE_EVOLUTION_DESC
  if (!descriptionInPrompt) fail('模型 prompt 的 <available_skills> 文本不含 finance-evolution description 原文')
  if (!descriptionInRegistry) fail('skill-catalog 条目中的 finance-evolution description 与源码 frontmatter 不一致')

  const assistantText = findAssistantTexts(result.events).join('\n')
  log(`registry 返回 ${registry.skills.length} 个 skill：`)
  for (const skill of registry.skills) {
    log(`  - ${skill.name.padEnd(22)} source=${String(skill.source).padEnd(7)} provider=${skill.provider}`)
  }
  log(`3 个固件 skill：${firmwareEvidence.map((item) => `${item.name}(source=${item.source})`).join('，')}`)
  log(`finance-evolution description 在 prompt 中：${descriptionInPrompt ? '是' : '否'}`)
  log(`finance-evolution description 与源码一致：${descriptionInRegistry ? '是' : '否'}`)
  log(`模型最终回复（截断 600 字）：${String(result.finalResponse).slice(0, 600)}`)

  return {
    ok: true,
    sessionId: result.sessionId,
    registry: registry.skills,
    firmware: firmwareEvidence,
    evolvable: evolvableEvidence,
    catalogNames: [...catalogNames],
    catalogTextLength: catalog.text.length,
    descriptionInPrompt,
    descriptionInRegistry,
    financeEvolutionDescription: catalogFinance?.description,
    assistantTextIncludesDescription: assistantText.includes(FINANCE_EVOLUTION_DESC),
    finalResponse: result.finalResponse,
  }
}

async function phaseB(h, home) {
  section('阶段 B：最小触发（定位 → 修复 → 提交）')
  const assetsDir = join(home, 'assets')
  const trendFile = join(assetsDir, 'skills/trend-analysis/SKILL.md')

  const before = readFileSync(trendFile, 'utf8')
  if (!before.includes(TREND_DESC)) fail(`seed 文件缺少预期 description：${trendFile}`)
  const corrupted = before.replace(/^description:.*$/m, 'description: "TODO_FIX_ME"')
  if (corrupted === before) fail('未能在 trend-analysis 中植入故障')
  writeFileSync(trendFile, corrupted, 'utf8')

  git(assetsDir, ['add', '-A'])
  git(assetsDir, [
    '-c',
    'user.name=dsh-ia',
    '-c',
    'user.email=dsh-ia@localhost',
    'commit',
    '-m',
    'test(t100474): seed corrupted description (before)',
  ])
  const seedHead = git(assetsDir, ['rev-parse', 'HEAD']).trim()
  const seedStatus = git(assetsDir, ['status', '--porcelain']).trim()
  log(`已植入并入库故障：HEAD=${seedHead.slice(0, 12)}，工作区=${JSON.stringify(seedStatus)}`)
  if (seedStatus !== '') fail('植入故障后工作区不干净')

  const prompt = [
    '发现一条指标异常：assets 资产中 trend-analysis 这个 skill 的 description 被改成了占位符 TODO_FIX_ME，导致该技能无法被正确识别。',
    `该 skill 的正确 description 是：「${TREND_DESC}」`,
    `请按 finance-evolution skill 的流程：定位到本会话的 assets 根目录 ${assetsDir}（由 DSH_IA_HOME 指定，不是 ~/.dsh-ia）下的具体资产，修复该 description，跑必要自检，然后提交。`,
    '不要用 git revert，直接编辑修复后提交。',
    '提交信息必须写清「改了什么」与「为什么改」。不要修改固件 skill，不要修改仓库源码。',
  ].join('\n')

  const t0 = Date.now()
  const result = await h.run(prompt, { sessionId: `t100474-b-${Date.now()}` })
  const durationMs = Date.now() - t0
  log(`阶段 B 结束：耗时 ${durationMs}ms，events=${result.events.length}`)

  const after = readFileSync(trendFile, 'utf8')
  const fixed = after.includes(TREND_DESC) && !after.includes('TODO_FIX_ME')
  const head = git(assetsDir, ['rev-parse', 'HEAD']).trim()
  const status = git(assetsDir, ['status', '--porcelain']).trim()
  const commitCount = Number(git(assetsDir, ['rev-list', '--count', `${seedHead}..HEAD`]).trim())
  const message = git(assetsDir, ['log', '-1', '--format=%B']).trim()
  const fullLog = git(assetsDir, ['log', '--format=%H%x09%s', '-5']).trim()

  const hasWhat = /(改了什么|修改|修复|恢复|将|变更|更新|update|fix|change)/i.test(message)
  const hasWhy = /(为什么改|原因|因为|导致|避免|防止|why|because)/i.test(message)
  const mentionsTarget = /(trend-analysis|description|SKILL\.md)/i.test(message)
  const statusClean = status === ''
  const committed = head !== seedHead && commitCount >= 1

  log(`文件修复：${fixed ? '是' : '否'}`)
  log(`新增提交：${committed ? `是（${commitCount} 个）` : '否'}`)
  log(`HEAD：${head}`)
  log(`commit message：\n${message}`)
  log(`工作区干净：${statusClean ? '是' : `否（${JSON.stringify(status)}）`}`)
  log(`message 含「改了什么」：${hasWhat}；含「为什么改」：${hasWhy}；提及目标资产：${mentionsTarget}`)
  log(`git log：\n${fullLog}`)

  if (!fixed) fail('agent 没有把 trend-analysis 的 description 修复回正确文本')
  if (!committed) fail('agent 没有产生新的 commit')
  if (!hasWhat) fail('commit message 没有写清「改了什么」')
  if (!hasWhy) fail('commit message 没有写清「为什么改」')
  if (!mentionsTarget) fail('commit message 没有提及 trend-analysis / description / SKILL.md')
  if (!statusClean) fail(`提交后工作区不干净：${status}`)

  return {
    ok: true,
    sessionId: result.sessionId,
    durationMs,
    seedHead,
    head,
    commitCount,
    message,
    status,
    statusClean,
    fixed,
    hasWhat,
    hasWhy,
    mentionsTarget,
    gitLog: fullLog,
    finalResponse: result.finalResponse,
  }
}

function renderReport(summary) {
  const ok = summary.ok
  const lines = []
  lines.push('# t100474 端到端验证报告：固件 skill 可见、可发现、可触发')
  lines.push('')
  lines.push(`- 结论：**${ok ? 'PASS' : 'FAIL'}**`)
  lines.push(`- 开始时间：${summary.startedAt}`)
  lines.push(`- 仓库：\`${REPO_ROOT}\``)
  lines.push(`- 仓库 HEAD：\`${summary.repoHead}\``)
  lines.push(`- 运行命令：\`node tests/tester-t100474-e2e-firmware-skill.mjs\``)
  lines.push(`- 耗时：${summary.durationMs}ms`)
  lines.push('')
  lines.push('## 验收项')
  lines.push('')
  lines.push(`1. 3 个固件 skill 可见且 source=runtime：**${summary.phaseA?.firmware?.every((item) => item.found && item.source === 'runtime') ? 'PASS' : 'FAIL'}**`)
  lines.push(`2. prompt 含 finance-evolution description：**${summary.phaseA?.descriptionInPrompt ? 'PASS' : 'FAIL'}**`)
  lines.push(`3. 最小触发产生 commit 且 message 含改了什么/为什么改：**${summary.phaseB?.ok ? 'PASS' : 'FAIL'}**`)
  lines.push('')
  lines.push('## 架构与隔离')
  lines.push('')
  lines.push('- `finance` profile 是 web app，web-startup 抢占 cmdline，不能直接承载 SDK stdio JSON-RPC；sdk-app 与 web-app 同时 parseCmdline 会挂起（已实测）。')
  lines.push('- 因此使用官方 `sdk` profile，并通过 `--patch` 插入与 finance profile 相同的 `dsh-ia` 入口（`dist-server/index.js`，即 finance profile link 的同一产物）。')
  lines.push('- 每次运行独立 `DSH_IA_HOME` + `DSH_HOME`；真实 `~/.dsh-ia` 前后快照对比。')
  lines.push(`- 真实 ~/.dsh-ia 未被修改：**${summary.realHome?.untouched ? '是' : '否'}**`)
  lines.push('')
  lines.push('## 阶段 A：可见性与 description')
  lines.push('')
  if (summary.phaseA) {
    lines.push('| skill | source | provider | path |')
    lines.push('|---|---|---|---|')
    for (const skill of summary.phaseA.registry) {
      lines.push(`| ${skill.name} | ${skill.source} | ${skill.provider} | ${skill.path ?? '(runtime)'} |`)
    }
    lines.push('')
    lines.push(`- available_skills 目录包含：${summary.phaseA.catalogNames.join('、')}`)
    lines.push(`- finance-evolution description（源码）：${FINANCE_EVOLUTION_DESC}`)
    lines.push(`- description 出现在模型 prompt：**${summary.phaseA.descriptionInPrompt ? '是' : '否'}**`)
    lines.push(`- description 与源码 frontmatter 逐字一致：**${summary.phaseA.descriptionInRegistry ? '是' : '否'}**`)
    lines.push(`- 3 个固件 skill 均不在 assets/skills 目录，却出现在 registry 且 source=runtime，证明来自静态 runtime 注册而非文件 provider。`)
    lines.push('')
    lines.push('模型最终回复（截断）：')
    lines.push('')
    lines.push('````text')
    lines.push(String(summary.phaseA.finalResponse).slice(0, 1200))
    lines.push('````')
  } else {
    lines.push('未执行完成。')
  }
  lines.push('')
  lines.push('## 阶段 B：最小触发（定位 → 修复 → 提交）')
  lines.push('')
  if (summary.phaseB) {
    lines.push(`- 故障：trend-analysis description -> \`TODO_FIX_ME\`，并已提交为 seed 故障 \`${summary.phaseB.seedHead}\``)
    lines.push(`- 修复：${summary.phaseB.fixed ? '已恢复正确 description' : '未恢复'}`)
    lines.push(`- 新提交：\`${summary.phaseB.head}\`（seed 之后 ${summary.phaseB.commitCount} 个提交）`)
    lines.push('- commit message：')
    lines.push('')
    lines.push('```text')
    lines.push(summary.phaseB.message)
    lines.push('```')
    lines.push('')
    lines.push(`- 含「改了什么」：${summary.phaseB.hasWhat ? '是' : '否'}`)
    lines.push(`- 含「为什么改」：${summary.phaseB.hasWhy ? '是' : '否'}`)
    lines.push(`- 工作区干净：${summary.phaseB.statusClean ? '是' : `否（${JSON.stringify(summary.phaseB.status)}）`}`)
    lines.push('')
    lines.push('git log：')
    lines.push('')
    lines.push('```text')
    lines.push(summary.phaseB.gitLog)
    lines.push('```')
    lines.push('')
    lines.push('模型最终回复（截断）：')
    lines.push('')
    lines.push('````text')
    lines.push(String(summary.phaseB.finalResponse).slice(0, 2000))
    lines.push('````')
  } else {
    lines.push('未执行完成。')
  }
  lines.push('')
  lines.push('## 真实 ~/.dsh-ia 快照')
  lines.push('')
  lines.push('```json')
  lines.push(JSON.stringify(summary.realHome, null, 2))
  lines.push('```')
  lines.push('')
  if (summary.error) {
    lines.push('## 失败诊断')
    lines.push('')
    lines.push('```text')
    lines.push(summary.error)
    lines.push('```')
    lines.push('')
    lines.push(`临时目录：\`${summary.temp?.home ?? ''}\`，\`${summary.temp?.dshHome ?? ''}\``)
  }
  lines.push('')
  lines.push('## 复现')
  lines.push('')
  lines.push('```bash')
  lines.push('cd ' + REPO_ROOT)
  lines.push('node tests/tester-t100474-e2e-firmware-skill.mjs')
  lines.push('```')
  lines.push('')
  lines.push('> 真实 LLM e2e，耗时约 1-4 分钟。脚本每次使用全新临时 DSH_IA_HOME/DSH_HOME；成功 exit 0，失败 exit 1。')
  lines.push('')
  return lines.join('\n')
}

async function main() {
  const dshBin = whichDsh()
  const sdkClient = resolveSdkClient(dshBin)
  ensureBuiltArtifacts()
  const { DeepSeekHarness } = await import(pathToFileURL(sdkClient).href)

  const stamp = startedAt.toISOString().replace(/[:.]/g, '-')
  const home = mkdtempSync(join(tmpdir(), 't100474-ia-'))
  const dshHome = mkdtempSync(join(tmpdir(), 't100474-dsh-'))
  const realCredentials = join(homedir(), '.dsh', '.credentials.yaml')
  if (!existsSync(realCredentials)) fail(`缺少凭据文件：${realCredentials}`)
  copyFileSync(realCredentials, join(dshHome, '.credentials.yaml'))
  const anonymousId = join(homedir(), '.dsh', '.anonymous-user-id')
  if (existsSync(anonymousId)) copyFileSync(anonymousId, join(dshHome, '.anonymous-user-id'))

  const pluginFile = join(home, 't100474-skill-registry-probe.mjs')
  writeFileSync(pluginFile, buildProbePluginSource(), 'utf8')
  const patchFile = join(home, 't100474-sdk-finance.patch.yml')
  writeFileSync(patchFile, writeHarnessPatch(pluginFile), 'utf8')

  const realHomeBefore = snapshotRealFinanceHome()
  log(`dsh：${dshBin}`)
  log(`sdk client：${sdkClient}`)
  log(`临时 DSH_IA_HOME：${home}`)
  log(`临时 DSH_HOME：${dshHome}`)
  log(`仓库 HEAD：${gitSafe(REPO_ROOT, ['rev-parse', 'HEAD'])}`)

  const harness = new DeepSeekHarness({
    dshBin,
    profile: 'sdk',
    patches: [patchFile],
    processCwd: home,
    cwd: home,
    dshHome,
    provider: process.env.T100474_PROVIDER ?? 'ds',
    model: process.env.T100474_MODEL ?? 'deepseek-flash',
    maxTokens: Number(process.env.T100474_MAX_TOKENS ?? 16384),
    initializeTimeoutMs: 120_000,
    requestTimeoutMs: 900_000,
    env: {
      ...process.env,
      HOME: process.env.HOME,
      DSH_IA_HOME: home,
      DSH_HOME: dshHome,
      T100474_SESSION_CWD: home,
    },
  })

  const summary = {
    ok: false,
    startedAt: startedAt.toISOString(),
    repoRoot: REPO_ROOT,
    repoHead: gitSafe(REPO_ROOT, ['rev-parse', 'HEAD']),
    dshBin,
    sdkClient,
    temp: { home, dshHome },
    realHome: { before: realHomeBefore, after: undefined, untouched: undefined },
    phaseA: undefined,
    phaseB: undefined,
    error: undefined,
    durationMs: 0,
  }

  try {
    await harness.start()
    section('冷启动')
    const assetsDir = join(home, 'assets')
    if (!existsSync(join(assetsDir, '.git'))) fail(`冷启动后缺少 assets/.git：${assetsDir}`)
    const seedDirs = readdirSync(join(assetsDir, 'skills')).sort()
    log(`assets/.git 存在；skills/${seedDirs.length} 个：${seedDirs.join(', ')}`)
    if (seedDirs.length !== EVOLVABLE.length) {
      fail(`assets/skills 应为 ${EVOLVABLE.length} 个 seed，实际 ${seedDirs.length} 个`)
    }
    for (const name of EVOLVABLE) {
      if (!seedDirs.includes(name)) fail(`assets/skills 缺少 seed：${name}`)
    }
    for (const name of FIRMWARE) {
      if (seedDirs.includes(name)) fail(`固件 skill 不应出现在 assets/skills：${name}`)
    }

    summary.phaseA = await phaseA(harness)
    summary.phaseB = await phaseB(harness, home)

    const realHomeAfter = snapshotRealFinanceHome()
    summary.realHome.after = realHomeAfter
    const untouched = JSON.stringify(realHomeBefore) === JSON.stringify(realHomeAfter)
    summary.realHome.untouched = untouched
    log(`真实 ~/.dsh-ia 前后一致：${untouched ? '是' : '否'}`)
    if (!untouched) fail('真实 ~/.dsh-ia 在运行期间发生变化（隔离失败）')

    summary.ok = true
  } catch (err) {
    summary.error = err?.stack ?? String(err)
    log('')
    log('FAILED:')
    log(summary.error)
    process.exitCode = 1
  } finally {
    summary.durationMs = Date.now() - startedAt.getTime()
    try {
      await harness.close()
    } catch (err) {
      log(`harness.close() 失败：${err?.message ?? String(err)}`)
    }

    // 再快照一次，防止 close 阶段污染；以最终快照为准。
    try {
      const realHomeAfter = snapshotRealFinanceHome()
      summary.realHome.after = realHomeAfter
      const untouched = JSON.stringify(summary.realHome.before) === JSON.stringify(realHomeAfter)
      summary.realHome.untouched = untouched
      if (!untouched) {
        summary.ok = false
        summary.error = summary.error ?? '真实 ~/.dsh-ia 在运行期间发生变化（隔离失败）'
        process.exitCode = 1
      }
    } catch (err) {
      summary.realHome.untouched = false
      summary.error = summary.error ?? `无法完成真实 ~/.dsh-ia 终态快照：${err?.message ?? String(err)}`
      summary.ok = false
      process.exitCode = 1
    }

    writeFileSync(REPORT_PATH, renderReport(summary), 'utf8')
    writeFileSync(SUMMARY_PATH, JSON.stringify(summary, null, 2), 'utf8')
    log('')
    log('===== SUMMARY =====')
    log(JSON.stringify({
      ok: summary.ok,
      phaseA: summary.phaseA && {
        ok: summary.phaseA.ok,
        firmware: summary.phaseA.firmware,
        descriptionInPrompt: summary.phaseA.descriptionInPrompt,
        descriptionInRegistry: summary.phaseA.descriptionInRegistry,
      },
      phaseB: summary.phaseB && {
        ok: summary.phaseB.ok,
        seedHead: summary.phaseB.seedHead,
        head: summary.phaseB.head,
        message: summary.phaseB.message,
        hasWhat: summary.phaseB.hasWhat,
        hasWhy: summary.phaseB.hasWhy,
        statusClean: summary.phaseB.statusClean,
      },
      realHomeUntouched: summary.realHome.untouched,
      durationMs: summary.durationMs,
    }, null, 2))
    log(`报告：${REPORT_PATH}`)

    if (summary.ok && !KEEP) {
      rmSync(home, { recursive: true, force: true })
      rmSync(dshHome, { recursive: true, force: true })
      log('临时目录已清理。')
    } else {
      const diagFile = `/tmp/t100474-e2e-${stamp}.log`
      writeFileSync(diagFile, runLog.join('\n') + '\n', 'utf8')
      log(`保留临时目录：${home}，${dshHome}`)
      log(`诊断日志：${diagFile}`)
    }
  }
}

main().catch((err) => {
  console.error(err?.stack ?? String(err))
  try {
    writeFileSync(
      `/tmp/t100474-e2e-crash-${Date.now()}.log`,
      runLog.join('\n') + '\n' + (err?.stack ?? String(err)) + '\n',
      'utf8',
    )
  } catch {
    /* ignore */
  }
  process.exitCode = 1
})
