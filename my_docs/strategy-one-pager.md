# 策略一页纸（S14 交易系统成型）

> 权威链：本页 = 人读的策略；`plugins/strategy.ts DEFAULT_STRATEGY` = 机器读的同一策略；
> 用户覆盖 `~/.mini-claude/stocks/strategy.json`（节级深合并，坏配置明确拒读）。
> **改动纪律：先改本页，再改 DEFAULT，最后改代码**——三处不一致 = 缺陷。
> 验收锚（S14）：回测器（backtest/run）与盯盘系统（plugins/*）消费同一份配置产出一致行为。

## 一、入场（什么情况买）

| 规则 | 参数键（strategy.json） | 默认 |
|---|---|---|
| rapid-move：5min 涨速异动 | `signals.rapidMovePct` | 3% |
| volume-surge：放量+涨价 | `signals.volumeSurgeX / volumeSurgeChgPct` | 2.5 倍 / 1% |
| volume-surge 绝对量检验 | `signals.volumeSurgeAmountPerMin / volumeSurgeTurnover` | 30 万/分 或 换手 0.5% |
| breakout 双门槛（幅度按 tick 归一） | `signals.breakoutBaseSurgeX / breakoutMinPct / breakoutTicks / breakoutSurgeX` | 1.5 倍 / 0.5% / 2 tick / 2.5 倍 |
| book-pressure：盘口压力与价同向 | `signals.bookPressure / bookPressureChgPct` | 0.6 / 1% |
| 重发纪律（冷却/日上限/强度增长/翻转） | `signals.cooldownMs / dailyFireCap / refireGrowth / flipGrowth` | 5min / 2 次 / ×1.5 / ×2 |
| 宇宙闸（不北交所/永不 ST/流动性） | `universe.amountMin / excludeBJ / excludeST` | 1,000 万 / true / true |
| 裁决：LLM buy-candidate 且信心充足 | adjudicate 技能（T+1/逆势/真假摔条款） | — |

## 二、离场（什么时候卖）

| 规则 | 参数键 | 默认 | 现状 |
|---|---|---|---|
| **⚠ 无自动止损/止盈——当前最大缺口** | — | — | 离场靠裁决面（/adjudicate、/review）与人工；`risk` 节没有止损键。调试期第一优先：T+1 次日止损线进 guard 或 watch |
| 观察线/作废线（蘅东光 432 那类） | 裁决记忆（verdicts.jsonl，S10 事件层） | — | 人工消费；自动化挂 P2 裁决回流 |

## 三、仓位（买多少）

| 规则 | 参数键 | 默认 |
|---|---|---|
| 单票市值占净资产上限（guard ⑤） | `risk.maxPositionPct` | 20% |
| 微盘候选池容量 | `pool.topN` | 20 只 |
| 买入规模 | 小仓位模拟（裁决提示词约束），非配置 | — |

## 四、风控（红线，提示词拦不住的才算）

| 规则 | 参数键 | 默认 |
|---|---|---|
| /halt 熔断 | 人工命令 | — |
| 时段闸门（非 open 拒单） | 代码硬限制 | — |
| 标的排除（bj 前缀/ST/退市/触板价） | `universe.excludeBJ / excludeST` + guard ③ | true/true |
| 单日亏损上限（guard ④） | `risk.maxDailyLoss` | 50,000 元（挂账 #2：300k 账户建议 1.5 万） |
| fail-closed | 行情拿不到 = 拒单 | — |

## 五、选股池与回测（同一配置的第二个消费者）

| 规则 | 参数键 | 默认 |
|---|---|---|
| 池过滤（流动性/低价/PE/PB/次新/容量） | `pool.amountMin / priceMin / peMin / peMax / pbMin / recentDays / topN` | 3,000 万 / 2 元 / 0 / 300 / 0 / 365 天 / 20 |
| 回测滑点/初始资金 | `backtest.slippage / initialCash` | 0.2% / 100 万 |

## 缺口清单（调试期按序）

1. 自动止损/止盈（离场节空白——最大缺口）
2. 挂账 #1：paper-broker 快照价成交 + 漂移拒单
3. 挂账 #2：maxDailyLoss 收紧
4. 挂账 #8：创/科板块开关（2026 实跑候选 20 创/科占 9 席）
5. 择时层（S13 基线：裸轮动 3 年 −28.8%/回撤 −51.1%——择时是第一个改进方向）
