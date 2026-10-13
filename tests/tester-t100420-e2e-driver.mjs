#!/usr/bin/env node
/**
 * t100420 E2E 驱动脚本（辅助，非生产代码）。
 *
 * 在**单个长驻 dsh 进程**内串起三条链路 + 固定会话能力闭环：
 *   A. 冷启动预置（全新 dataRoot）→ 5 个可进化 skill + 首版 commit（task-authorship 为固有 SKILL，不落盘）
 *   B. 热更新（同进程外改 SKILL.md，无需重启，下一轮生效）
 *   C. git 回滚（commit → revert，回退内容，热更新生效）
 *   D. 固定会话 investment-advisor 自身读/改 skill 文件 + git commit/revert
 *
 * 依赖：@deepseek-ai/dsh-sdk-client（harness workspace 内，绝对路径导入）。
 * 用法：node tester-t100420-e2e-driver.mjs
 */
import { spawn, execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync, readdirSync, statSync, realpathSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const HARNESS = process.env.DSH_HARNESS_DIR || '/Users/reachlucifer/project/opc/deepseek-harness'
const CLIENT = join(HARNESS, 'packages/sdk/client/lib/index.js')
const DSH = process.env.DSH_BIN || '/Users/reachlucifer/bin/dsh'
const HOME = homedir()
const FIN = join(HOME, '.dsh-ia')
const SKILLS = join(FIN, 'data', 'skills')
const TREND = join(SKILLS, 'trend-analysis', 'SKILL.md')
// 5 个「可进化 SKILL」= <dataRoot>/skills 落盘集合（固有 SKILL task-authorship 不落盘）。
const CORE = ['trend-analysis','grid-strategy','stop-rule','strategy-authorship','analysis-decision']
const PINNED = 'investment-advisor'
const SENT_A = 'HOTUPDATE-E2E-SENTINEL-ALPHA'
const SENT_B = 'CAPABILITY-E2E-SENTINEL-BETA'
const time = () => new Date().toISOString()

const EVID = []
function rec(kind, obj) { EVID.push({ t: time(), kind, ...obj }); }
function log(tag, msg) { const s = `[${time()}] ${tag} ${msg}`; console.log(s); rec('log', { tag, msg }) }

function git(args, cwd = SKILLS) {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env: { ...process.env, HOME } }).trim()
}
function skillDirs() {
  if (!existsSync(SKILLS)) return null
  return readdirSync(SKILLS).filter(n => n !== '.git' && statSync(join(SKILLS, n)).isDirectory()).sort()
}
function parseDesc(p) {
  const raw = readFileSync(p, 'utf8')
  const m = raw.match(/^description:\s*"?(.*?)"?\s*$/m)
  return m ? m[1] : null
}
function setDesc(p, desc) {
  let raw = readFileSync(p, 'utf8')
  raw = raw.replace(/^description:\s*".*"$/m, `description: "${desc}"`)
  writeFileSync(p, raw, 'utf8')
}

async function bootCapture(label) {
  const real = realpathSync(DSH)
  const out = []
  const p = spawn(process.execPath, [real, '--profile', 'e2e'], {
    cwd: FIN, env: { ...process.env, HOME },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  p.stdout.on('data', d => out.push('STDOUT ' + String(d)))
  p.stderr.on('data', d => out.push('STDERR ' + String(d)))
  await new Promise(r => setTimeout(r, 7000))
  try { p.stdin.end() } catch {}
  await new Promise(r => setTimeout(r, 2000))
  try { p.kill('SIGTERM') } catch {}
  await new Promise(r => setTimeout(r, 1500))
  try { p.kill('SIGKILL') } catch {}
  const text = out.join('')
  writeFileSync(join(FIN, `.boot-${label}.log`), text)
  return text
}

async function main() {
  mkdirSync(FIN, { recursive: true })

  // ---------- A. 冷启动 ----------
  log('A', `pre-state: SKILLS exists=${existsSync(SKILLS)}`)
  const pre = skillDirs()
  log('A', `pre-state: skillDirs=${JSON.stringify(pre)}`)
  const boot = await bootCapture('cold')
  const provLine = boot.split('\n').filter(l => /冷启动预置|插件加载|dsh-ia/.test(l)).join('\n')
  log('A', `boot-log plugin lines:\n${provLine || '(none captured)'}`)
  rec('A-bootlog', { text: boot })

  const dirs = skillDirs() || []
  const missing = CORE.filter(n => !dirs.includes(n))
  const extra = dirs.filter(n => !CORE.includes(n))
  const allHaveSkillMd = dirs.every(n => existsSync(join(SKILLS, n, 'SKILL.md')))
  const logLines = git(['log', '--oneline']).split('\n').filter(Boolean)
  const initMsg = git(['log', '-1', '--pretty=%s'])
  const status = git(['status', '--porcelain'])
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD'])
  log('A', `post: dirs=${JSON.stringify(dirs)} missing=${JSON.stringify(missing)} extra=${JSON.stringify(extra)} allSkillMd=${allHaveSkillMd}`)
  log('A', `post: branch=${branch} commits=${logLines.length} msg="${initMsg}" statusPorcelain="${status}"`)
  const A_pass = missing.length === 0 && extra.length === 0 && allHaveSkillMd && logLines.length === 1
    && initMsg.includes('init: skill 资产首版') && status === ''
  rec('A', { pass: A_pass, dirs, missing, extra, allHaveSkillMd, commits: logLines.length, initMsg, status, branch, logLines })

  // ---------- 启动长驻 dsh（SDK harness） ----------
  const { DeepSeekHarness } = await import(CLIENT)
  const harness = new DeepSeekHarness({
    dshBin: realpathSync(DSH),
    profile: 'e2e',
    processCwd: FIN,
    cwd: FIN,
    provider: 'ds',
    model: 'deepseek-flash',
    maxTokens: 1024,
    initializeTimeoutMs: 60000,
    requestTimeoutMs: 240000,
    env: { ...process.env, HOME },
  })
  const pid = () => { try { return harness.client.child?.pid ?? null } catch { return null } }

  const origDesc = parseDesc(TREND)
  log('T', `original trend-analysis desc="${origDesc}"`)

  async function turn(label, prompt) {
    log('T', `--- ${label} (child pid before=${pid()}) prompt: ${prompt.slice(0,80)}...`)
    const t0 = Date.now()
    let res
    try {
      res = await harness.run(prompt, { sessionId: PINNED })
    } catch (e) {
      log('T', `${label} ERROR ${e?.message || e}`)
      rec(label, { error: String(e?.message || e) })
      return { error: String(e?.message || e) }
    }
    const ms = Date.now() - t0
    const blob = JSON.stringify(res.events) + JSON.stringify(res.notifications)
    log('T', `${label} pid=${pid()} tookMs=${ms} finalResponse(<=600)=${(res.finalResponse||'').slice(0,600)}`)
    log('T', `${label} rawHasSENT_A=${blob.includes(SENT_A)} rawHasSENT_B=${blob.includes(SENT_B)} rawHasOrig=${blob.includes(origDesc)}`)
    rec(label, { pid: pid(), ms, finalResponse: res.finalResponse || '', events: res.events, notifications: res.notifications,
      rawHasSENT_A: blob.includes(SENT_A), rawHasSENT_B: blob.includes(SENT_B), rawHasOrig: blob.includes(origDesc) })
    return res
  }

  await harness.start()
  log('T', `harness started; child pid=${pid()}`)
  rec('T-boot', { pid: pid() })

  const Q = n => `只回答：把你的 available skills 目录里名为 ${n} 的技能 description 原文，一字不改地输出，不要任何多余文字。`

  // ---------- B. 热更新（外改，不重启） ----------
  const t1 = await turn('T1-before', Q('trend-analysis'))
  const pidAfterT1 = pid()

  setDesc(TREND, SENT_A)
  log('B', `edited desc -> "${SENT_A}"; git status: ${git(['status', '--porcelain']) || '(empty)'}`)
  await new Promise(r => setTimeout(r, 1500)) // 等 chokidar 稳定阈值(200ms) + 余量

  const t2 = await turn('T2-after', Q('trend-analysis'))
  const pidAfterT2 = pid()
  const t2ok = (t2.finalResponse || '').includes(SENT_A) || t2.rawHasSENT_A
  rec('B', { pass: !!t2ok, pidBefore: pidAfterT1, pidAfter: pidAfterT2, sameProcess: pidAfterT1 === pidAfterT2 })

  // ---------- C. git 回滚 ----------
  git(['add', '-A'])
  git(['commit', '-m', 'test(t100420): E2E hot-update sentinel'])
  const cHash = git(['rev-parse', '--short', 'HEAD'])
  const afterCommitDesc = parseDesc(TREND)
  log('C', `committed ${cHash} desc="${afterCommitDesc}"`)
  // 先确认 commit 后内容仍为新（agent 已见 SENT_A）
  git(['revert', '--no-edit', 'HEAD'])
  const rHash = git(['rev-parse', '--short', 'HEAD'])
  const afterRevertDesc = parseDesc(TREND)
  const revertLog = git(['log', '--oneline', '-3'])
  log('C', `reverted head=${rHash} fileDesc="${afterRevertDesc}" expected="${origDesc}"`)
  log('C', `git log -3:\n${revertLog}`)
  await new Promise(r => setTimeout(r, 1500))

  const t3 = await turn('T3-reverted', Q('trend-analysis'))
  const pidAfterT3 = pid()
  const t3ok = (t3.finalResponse || '').includes(origDesc) && !(t3.finalResponse || '').includes(SENT_A)
  const C_pass = afterRevertDesc === origDesc && t3ok
  rec('C', { pass: C_pass, commitHash: cHash, revertHash: rHash, afterRevertDesc, origDesc, pid: pidAfterT3, t3ok, revertLog })

  // ---------- D. 固定会话能力闭环（真实 LLM 轮次） ----------
  const Dprompt =
    `请在当前工作目录内用你的 shell/文件工具完成（不要问我，直接做，简洁汇报）：\n` +
    `1) 读取 ${TREND} 的 frontmatter description；\n` +
    `2) 把该 description 改成 "${SENT_B}"；\n` +
    `3) 在 ${SKILLS} 执行 git add -A && git commit -m "test(t100420): capability edit"；\n` +
    `4) 执行 git revert --no-edit；\n` +
    `5) 最后报告：最终文件里的 description、commit 短哈希、revert 短哈希。`
  const t4 = await turn('T4-capability', Dprompt)
  const dDir = git(['log', '--oneline', '-3'])
  const dStatus = git(['status', '--porcelain'])
  const dFinalDesc = parseDesc(TREND)
  const dOk = dFinalDesc === origDesc && dStatus === '' && dDir.split('\n').filter(Boolean).length >= 3
  log('D', `finalDesc="${dFinalDesc}" status="${dStatus}"\nlog:\n${dDir}`)
  rec('D', { pass: dOk, finalDesc: dFinalDesc, status: dStatus, log: dDir, finalResponse: t4.finalResponse || '' })

  log('T', `pids: start=${rec} afterT1=${pidAfterT1} afterT2=${pidAfterT2} afterT3=${pidAfterT3}`)
  const pidsSame = pidAfterT1 && pidAfterT1 === pidAfterT2 && pidAfterT2 === pidAfterT3
  rec('process-identity', { pidsSame, pidAfterT1, pidAfterT2, pidAfterT3 })

  await harness.close()
  log('T', 'harness closed')

  const summary = {
    time: time(),
    A_coldStart: A_pass,
    B_hotUpdate: !!t2ok,
    C_gitRevert: C_pass,
    D_pinnedCapability: dOk,
    singleProcessAcrossTurns: !!pidsSame,
    pids: { afterT1: pidAfterT1, afterT2: pidAfterT2, afterT3: pidAfterT3 },
    evidence: EVID,
  }
  writeFileSync(join(FIN, 'e2e-result.json'), JSON.stringify(summary, null, 2))
  console.log('\n===== SUMMARY =====')
  console.log(JSON.stringify({ A_coldStart: A_pass, B_hotUpdate: !!t2ok, C_gitRevert: C_pass, D_pinnedCapability: dOk, singleProcessAcrossTurns: !!pidsSame, pids: summary.pids }, null, 2))
}

main().catch(e => { console.error('FATAL', e); process.exit(1) })
