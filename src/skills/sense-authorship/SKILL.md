---
name: "sense-authorship"
description: "如何为感知层编写/修改多标的感知脚本：感知维度、唤醒条件、脚本结构、归档规范。"
whenToUse: "需生成、修改或整体替换感知脚本时。"
---

# 感知脚本创作（sense-authorship）

指导 agent 如何为**感知层**编写 / 修改**多标的感知脚本**。感知脚本是常驻的「眼睛」，它定期采集行情、判断**是否值得唤醒 agent**，并在值得时汇报；它**不做交易判断**——买卖决策一律由 agent 依据其它 skill 作出。

## 目标：仅「采集 + 判断是否唤醒 + 汇报」

感知脚本的职责边界**只有三件事**：

1. **采集**：按标的清单拉取所需行情与台账数据。
2. **判断是否唤醒**：判断当前状态是否达到唤醒条件（是否「值得 agent 介入」）。
3. **汇报**：达到条件时输出结构化摘要（`summary` + `metrics`），未达到则安静退出。

> **不做交易判断**：感知脚本里**不得**出现买入 / 卖出 / 减仓等决策逻辑，也不得写死任何标的专属的阈值。决策属于 agent。

## 标的无关原则

- 脚本**遍历 `symbols` 清单**，对每个标的用**同一套**采集与判断逻辑，一视同仁。
- **增删标的只改清单，不改脚本本身**：标的的增减、改名、换品种，都不应要求改写感知脚本。
- 标的专属的阈值 / 区间 / 维度差异，通过**数据（配置 / 台账）** 传入，而非写死在脚本里。
- 单个标的出错不得影响其它标的的采集（逐标的隔离）。

## 脚本结构（ptc-runtime program）

感知脚本是一段运行在 **ptc-runtime** 中的**异步函数体**（program）。它通过运行时注入的 **bindings** 提供的 host 函数访问行情与数据，**不直接**发起网络 / 文件 IO：

| binding | 语义 |
|---------|------|
| `symbols.list()` | 返回当前跟踪的标的清单（标的无关遍历的入口） |
| `quote.realtime(symbol)` | 该标的实时行情（最新价 / 涨跌幅 / 量等） |
| `quote.intraday(symbol)` | 该标的分时序列（分时形态、均价线） |
| `quote.history({ symbol, days })` | 该标的近 `days` 日历史 K 线（用于均线 / 区间 / 量价） |
| `ledger.get(symbol)` | 该标的的台账（持仓、成本、历史操作） |

> **binding 成员均为单参数函数**（签名等价 `(args) => Promise<...>`）：运行时**只取第 1 个实参**，多实参写法（如 `quote.history(symbol, days)`）中后续实参会被静默丢弃。需要传多个值时，请打包为**单个对象**（或数组），例如 `quote.history({ symbol, days })`。

脚本体内遍历标的、采集、判断，最后返回：

- **需要唤醒**：
  ```ts
  { shouldWake: true, symbol, summary, metrics }
  ```
  - `symbol`：触发唤醒的标的。
  - `summary`：一句话摘要，说明「为什么值得介入」。
  - `metrics`：支撑判断的关键指标键值（如价、量、均线关系等），供 agent 研判。
- **无需唤醒**：
  ```ts
  { shouldWake: false }
  ```

> 一个脚本一次可只汇报**一个**最值得处理的标的（`shouldWake: true` 的单个结果）；多个标的同时达标时，按重要性择一汇报，其余留待后续轮次。

示意（维度示意，阈值一律来自配置 / 台账，**不写死**）：

```ts
async function sense() {
  const list = await symbols.list()
  for (const s of list) {
    const config = getSymbolConfig(s) // 该标的策略配置（维度 / 阈值，均从数据读取，不写死）
    const [rt, hist, book] = await Promise.all([
      quote.realtime(s),
      quote.history({ symbol: s, days: config.historyDays }),
      ledger.get(s),
    ])
    // 依据该标的 config 中的阈值判断是否唤醒（阈值不在此写死）
    if (exceedsWakeThreshold(rt, hist, book, config)) {
      const ip = await quote.intraday(s)
      return { shouldWake: true, symbol: s, summary: '……', metrics: { rt, hist, book, ip } }
    }
  }
  return { shouldWake: false }
}
```

## 变更类型：keep / patch / replace

每次「是否调整感知脚本」的结论只能是以下三种之一：

| 类型 | 语义 | 产物 |
|------|------|------|
| **keep** | 沿用当前版本，不产生新版本 | 无（`current` 不变） |
| **patch** | 只改**部分**维度 / 阈值 / 唤醒条件，其余沿用 | **新版本**，`parent` 指向上一版（保留演进链） |
| **replace** | **整体替换**实现思路 | **新版本**，`current` 指向新版本 |

- **keep**：现状足够，不折腾；不写入新版本。
- **patch**：局部演进（如新增一个感知维度、调整某类唤醒条件），务必记录**相对上一版改了什么、为什么**。
- **replace**：原思路不再适用（如从「只看均线」改为「均线 + 板块联动」），整体重写。

## 归档规范

**每一版**感知脚本都必须归档到独立目录：

```
sense_versions/<version>/
├── rationale.md   # 本次变更的推理理由（为什么改 / 改了什么 / 预期效果）
├── sensor.ts      # 本版感知脚本正文（ptc-runtime program）
└── meta.json      # 元信息：version、变更类型(keep|patch|replace)、parent、时间戳等
```

- `rationale.md`：用自然语言写清推理链，供后续复盘「当时的判断是否成立」。
- `sensor.ts`：可直接被运行时加载的脚本正文。
- `meta.json`：机器可读的版本登记信息，`patch` 时须记录 `parent` 以保留演进关系。

> 归档**必须**经感知归档工具（`sense_archive_*`）落库，保证 `current` 指针与历史版本一致、可回滚；不要绕过归档直接改文件。
