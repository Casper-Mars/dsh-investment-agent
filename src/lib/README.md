# lib

公共包目录：可复用子包，纯 TS 实现，不依赖 dsh/cordis API，不接触领域存储。

## 结构

| 文件 | 说明 |
|------|------|
| `quote-types.ts` | 统一 `Quote` 结构、`QuoteProvider` 接口、市场/类型推断 |
| `quotes.ts` | `QuoteClient`：按 type 路由 + 多源备用 + 重试/缓存/降级 |
| `http.ts` | Node 原生 fetch 封装：指数退避重试、超时、GBK 解码 |
| `providers/eastmoney.ts` | 东财行情适配（主源）：实时 / 分时 / 日 K |
| `providers/tencent.ts` | 腾讯行情适配（备用源）：实时（GBK） |
| `trading-calendar.ts` | A 股交易日历：周末 + 法定节假日，失败降级周末判定 |
| `holiday-provider.ts` | 交易日历 HTTP 节假日数据源（实时获取） |

## 设计要点

- **数据源抽象**：`QuoteProvider` 为最小契约，`QuoteClient` 内按 type 维护
  「主源 → 备用源」链，依次尝试，全部失败返回缓存或 `unavailable` 占位，
  绝不抛未捕获异常。
- **重试**：N 次指数退避（默认 3 次），仅对 provider 调用，不重试解析结果。
- **停牌/涨跌停**：解析时标记 `status`（trading/suspended/limit_up/limit_down/unavailable）。
- **交易日历**：`HolidayProvider` 抽象，默认 HTTP 实时拉取；失败降级为纯周末判定。