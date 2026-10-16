/**
 * scripts/recompute-cum-return.mjs —— 一次性「cum_return 口径」重算 / 回填脚本。
 *
 * 背景（t100459，承接 t100458）
 * ---------------------------
 * t100458 把 `cum_return` 口径由「期末市值 + 累计 realized」修正为
 * 「**期末现金 + 期末市值** − 期初资金」/ 期初资金（期末总资产 vs 期初总资产）。
 * 历史 `metrics.json` 里的 `cumReturn` 是**旧口径**落库的，与修复后**不可比**：
 * 旧口径分子漏掉期末现金，对已清仓账户会算出接近 −100% 的严重低估（详见 Issue #3）。
 *
 * 本脚本按**新口径**重放台账流水，就地回填每个已初始化标的的 `metrics` 快照，
 * 使历史缓存重新可比。默认 **dry-run**（只对比、不落盘）；加 `--write` 才落盘，
 * 且落盘前把原 `metrics.json` 备份为 `metrics.json.bak` 以支持回滚。
 *
 * 单一事实来源 / 防漂移
 * --------------------
 * 本脚本**镜像**了 `src/domain/metrics.ts` 的公式与 `src/domain/ledger.ts` 的
 * `cumReturnState` 反推逻辑（因 dist-server 被 .gitignore 忽略、且 src 内部以
 * `./x.js` 后缀导入，直接 `node src/...ts` 跑不通，故脚本自包含、不依赖 build）。
 * 为保证口径不漂移，`tests/recompute-cum-return.test.ts` 含一条断言：
 *   脚本重算结果 === cumReturnOnCapital(ledger.cumReturnState(...))
 * 改动公式时须同步本脚本与该测试。
 *
 * 运行命令
 * --------
 *   # dry-run（默认，仅打印 before/after/changed，不落盘）
 *   node scripts/recompute-cum-return.mjs --data-root <dataRoot>
 *   # 落盘（自动备份 metrics.json -> metrics.json.bak）
 *   node scripts/recompute-cum-return.mjs --data-root <dataRoot> --write
 *   # 指定现价（缺省用最近一笔成交价作为现价代理，与 review_metrics 即时路径一致）
 *   node scripts/recompute-cum-return.mjs --data-root <dataRoot> --price 3.05
 *   # 回滚（把 metrics.json.bak 还原为 metrics.json）
 *   node scripts/recompute-cum-return.mjs --data-root <dataRoot> --rollback
 *   # 亦可用环境变量提供 dataRoot：DSH_IA_DATA_DIR=<dataRoot> node scripts/recompute-cum-return.mjs
 *
 * 亦可通过 npm script：`pnpm recompute:cum-return -- --write`（见 package.json）。
 *
 * dataRoot 解析优先级：`--data-root/位置参数` > 环境变量 `DSH_IA_DATA_DIR` > 默认
 * `~/.dsh-ia/data`（与 `src/paths.ts#resolveDataRoot` 一致）。
 */
import {
  copyFileSync,
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 备份文件名（与原文件同目录）。 */
export const BACKUP_SUFFIX = '.bak'

/** 与被测实现同口径四舍五入到 4 位（`src/domain/metrics.ts#round4`）。 */
export function round4(value) {
  return Math.round((value + Number.EPSILON) * 10000) / 10000
}

/**
 * 反推期初资金（镜像 `Ledger.cumReturnState`）。
 *   init 时 accounts.cash 直接置为 init_cash（init 流水为账面流水、非现金流出），
 *   故初始 cash = 当前 cash + Σ其他买入 − Σ卖出；
 *   期初资金 = 初始 cash + 初始持仓成本（init 流水的 qty×price）。
 *
 * @param {number} accountCash 当前（期末）现金。
 * @param {Array<{side:string,qty:number,price:number,reason?:string}>} trades 全部流水。
 * @returns {{initialCapital:number, initialCash:number, initCost:number}}
 */
export function computeInitialCapital(accountCash, trades) {
  const list = trades ?? []
  let totalBuy = 0
  let totalSell = 0
  for (const t of list) {
    const amount = t.qty * t.price
    if (t.side === 'buy') totalBuy += amount
    else totalSell += amount
  }
  const initTrade = list.find((t) => t.reason === 'init')
  const initCost = initTrade ? initTrade.qty * initTrade.price : 0
  const otherBuy = totalBuy - initCost
  const initialCash = accountCash + otherBuy - totalSell
  return { initialCapital: initialCash + initCost, initialCash, initCost }
}

/**
 * 期末现价：显式注入优先；缺省用最近一笔成交价作为代理（与 `review_metrics`
 * 即时路径的缺省降级一致）；无流水则回落到 0。
 */
export function resolveFinalPrice(trades, explicitPrice) {
  if (typeof explicitPrice === 'number') return explicitPrice
  const last = trades && trades.length > 0 ? trades[trades.length - 1] : undefined
  return last ? last.price : 0
}

/**
 * 新口径累计收益率（镜像 `cumReturnOnCapital`）。
 *   `(期末现金 + 期末市值 − 期初资金) / 期初资金`，四舍五入 4 位；
 *   期初资金为 0 或非法即返回 0（防除零）。
 *
 * @param {{finalQty:number,finalPrice:number,finalCash:number,initialCapital:number}} state
 */
export function computeCumReturnFromState(state) {
  const ic = state.initialCapital
  if (!Number.isFinite(ic) || ic === 0) return 0
  const marketValue = state.finalQty * state.finalPrice
  return round4((state.finalCash + marketValue - ic) / ic)
}

/**
 * 依台账表（positions/accounts/trades）重算某标的的 cum_return。
 *
 * @param {{positions:object|undefined, accounts:object|undefined, trades:Array|undefined}} tables
 * @param {number|undefined} explicitPrice 显式现价（可选）。
 * @returns {{cumReturn:number, state:object}}
 */
export function recomputeSymbol(tables, explicitPrice) {
  const finalQty = tables.positions?.qty ?? 0
  const finalCash = tables.accounts?.cash ?? 0
  const trades = tables.trades ?? []
  const { initialCapital } = computeInitialCapital(finalCash, trades)
  const finalPrice = resolveFinalPrice(trades, explicitPrice)
  const state = { finalQty, finalPrice, finalCash, initialCapital }
  return { cumReturn: computeCumReturnFromState(state), state }
}

/** 读 JSON（不存在/损坏返回 undefined，不抛）。 */
function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return undefined
  }
}

/** 列出 dataRoot 下所有已初始化标的的目录名（存在 symbols.json 的目录）。 */
export function listSymbols(dataRoot) {
  const ledgerRoot = join(dataRoot, 'ledger')
  if (!existsSync(ledgerRoot)) return []
  try {
    return readdirSync(ledgerRoot).filter((entry) => {
      const p = join(ledgerRoot, entry)
      return statSync(p).isDirectory() && existsSync(join(p, 'symbols.json'))
    })
  } catch {
    return []
  }
}

/** 幂等备份：仅在 `.bak` 不存在时创建（保留最原始的迁移前快照）。 */
function backupIfAbsent(metricsPath, log) {
  const bak = metricsPath + BACKUP_SUFFIX
  if (existsSync(bak)) return { created: false, bak }
  copyFileSync(metricsPath, bak)
  log(`    └─ 备份 ${metricsPath} -> ${bak}`)
  return { created: true, bak }
}

/**
 * 遍历 dataRoot 下所有标的，重算并（可选）回填 cum_return。
 *
 * @param {object} opts
 * @param {string} opts.dataRoot 数据根目录。
 * @param {boolean} [opts.write=false] 是否落盘（默认 dry-run）。
 * @param {boolean} [opts.rollback=false] 回滚模式：把 `.bak` 还原为 `metrics.json`。
 * @param {number} [opts.price] 显式现价（可选）。
 * @param {(msg:string)=>void} [opts.log=console.log] 日志输出。
 * @returns {Array<{symbol:string, skipped?:boolean, reason?:string, before?:number|null, after?:number, changed?:boolean, written?:boolean, backedUp?:boolean, rolledBack?:boolean}>}
 */
export function runRecompute({
  dataRoot,
  write = false,
  rollback = false,
  price,
  log = console.log,
}) {
  const results = []
  const symbols = listSymbols(dataRoot)
  log(`[recompute-cum-return] dataRoot=${dataRoot}`)
  log(`[recompute-cum-return] 模式：${rollback ? '回滚（--rollback）' : write ? '落盘（--write）' : 'dry-run'}`)
  log(`[recompute-cum-return] 已初始化标的：${symbols.length} 个${symbols.length ? `（${symbols.join(', ')}）` : ''}`)

  for (const symbol of symbols) {
    const dir = join(dataRoot, 'ledger', symbol)
    const metricsPath = join(dir, 'metrics.json')
    const bakPath = metricsPath + BACKUP_SUFFIX

    if (rollback) {
      if (existsSync(bakPath)) {
        copyFileSync(bakPath, metricsPath)
        log(`[${symbol}] 已回滚：${bakPath} -> ${metricsPath}`)
        results.push({ symbol, rolledBack: true })
      } else {
        log(`[${symbol}] 跳过回滚：无 ${bakPath}`)
        results.push({ symbol, skipped: true, reason: 'no backup' })
      }
      continue
    }

    const metrics = readJson(metricsPath)
    if (!metrics) {
      log(`[${symbol}] 跳过：无 metrics.json`)
      results.push({ symbol, skipped: true, reason: 'no metrics.json' })
      continue
    }

    const tables = {
      positions: readJson(join(dir, 'positions.json')),
      accounts: readJson(join(dir, 'accounts.json')),
      trades: readJson(join(dir, 'trades.json')),
    }
    const { cumReturn } = recomputeSymbol(tables, price)
    const before = typeof metrics.cumReturn === 'number' ? metrics.cumReturn : null
    const changed = before === null || before !== cumReturn

    let backedUp = false
    let written = false
    if (write && changed) {
      const bk = backupIfAbsent(metricsPath, log)
      backedUp = bk.created
      const next = { ...metrics, cumReturn }
      writeFileSync(metricsPath, JSON.stringify(next, null, 2), 'utf8')
      written = true
    }

    log(
      `[${symbol}] before=${before === null ? '(缺)' : before} after=${cumReturn} changed=${changed ? 'yes' : 'no'}` +
        (write ? ` written=${written ? 'yes' : 'no'}` : ''),
    )
    results.push({ symbol, before, after: cumReturn, changed, written, backedUp })
  }

  const changedCount = results.filter((r) => r.changed).length
  const writtenCount = results.filter((r) => r.written).length
  const rolledBackCount = results.filter((r) => r.rolledBack).length
  if (rollback) {
    log(`[recompute-cum-return] 完成：回滚 ${rolledBackCount} 个标的。`)
  } else {
    log(
      `[recompute-cum-return] 完成：${symbols.length} 个标的，${changedCount} 个口径变化，` +
        (write ? `已落盘 ${writtenCount} 个。` : `dry-run，未落盘（加 --write 生效）。`),
    )
  }
  return results
}

/** 解析 dataRoot（`--data-root`/位置参数 > 环境变量 `DSH_IA_DATA_DIR` > 默认 `~/.dsh-ia/data`）。 */
export function resolveDataRoot(explicit) {
  if (explicit && String(explicit).trim() !== '') return resolve(String(explicit))
  const env = process.env.DSH_IA_DATA_DIR
  if (env && env.trim() !== '') return resolve(env)
  return join(homedir(), '.dsh-ia', 'data')
}

/** 解析命令行参数。 */
export function parseArgs(argv) {
  const opts = { write: false, rollback: false, price: undefined, dataRoot: undefined, help: false }
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (a === '--write') opts.write = true
    else if (a === '--rollback') opts.rollback = true
    else if (a === '--dry-run') opts.write = false
    else if (a === '--help' || a === '-h') opts.help = true
    else if (a === '--price') opts.price = Number(argv[(i += 1)])
    else if (a.startsWith('--price=')) opts.price = Number(a.slice('--price='.length))
    else if (a === '--data-root') opts.dataRoot = argv[(i += 1)]
    else if (a.startsWith('--data-root=')) opts.dataRoot = a.slice('--data-root='.length)
    else if (a.startsWith('-')) throw new Error(`未知参数：${a}`)
    else opts.dataRoot = a // 位置参数：dataRoot
  }
  return opts
}

const HELP = `用法：node scripts/recompute-cum-return.mjs [options]
  --write            落盘（默认 dry-run）；落盘前备份 metrics.json -> metrics.json.bak
  --rollback         回滚：把 metrics.json.bak 还原为 metrics.json
  --price <n>        指定现价（缺省用最近一笔成交价作为代理）
  --data-root <dir>  数据根目录（亦可用环境变量 DSH_IA_DATA_DIR；默认 ~/.dsh-ia/data）
  -h, --help         显示帮助`

/** CLI 入口。 */
function main() {
  const opts = parseArgs(process.argv.slice(2))
  if (opts.help) {
    console.log(HELP)
    return
  }
  if (opts.write && opts.rollback) {
    throw new Error('--write 与 --rollback 互斥，请二选一')
  }
  if (opts.price !== undefined && !Number.isFinite(opts.price)) {
    throw new Error(`--price 非法：${opts.price}`)
  }
  const dataRoot = resolveDataRoot(opts.dataRoot)
  if (!existsSync(join(dataRoot, 'ledger'))) {
    console.log(`[recompute-cum-return] 未找到台账目录：${join(dataRoot, 'ledger')}（无标的可重算）`)
    return
  }
  runRecompute({ dataRoot, write: opts.write, rollback: opts.rollback, price: opts.price })
}

const isMain =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (isMain) {
  try {
    main()
  } catch (err) {
    console.error(`[recompute-cum-return] 错误：${err instanceof Error ? err.message : err}`)
    process.exitCode = 1
  }
}
