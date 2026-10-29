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
| 止损线：现价市值 ≤ 含费成本 × (1−5%) → watch 持仓风控唤醒裁决（2026-10-22 用户定） | `exit.stopLossPct` | 5%（0 = 关） | ✅ 不自动卖——唤醒 /adjudicate 或 place_order 卖可卖部分；只对 T+1 可卖部分生效（当日买入不可卖，叫了也执行不了）；破线是持续状态，同 code 每日至多唤醒 1 次；熔断中静默 |
| 止盈 | — | — | ⚠ 未固化（裁决面人工掌握） |
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
| 单日亏损上限（guard ④） | `risk.maxDailyLoss` | 15,000 元（= 300k 账户 5%/日；挂账 #2 已收紧 ✅） |
| fail-closed | 行情拿不到 = 拒单 | — |

## 五、选股池与回测（同一配置的第二个消费者）

| 规则 | 参数键 | 默认 |
|---|---|---|
| 池过滤（流动性/低价/PE/PB/次新/容量） | `pool.amountMin / priceMin / peMin / peMax / pbMin / recentDays / topN` | 3,000 万 / 2 元 / 0 / 300 / 0 / 365 天 / 20 |
| 回测滑点/初始资金 | `backtest.slippage / initialCash` | 0.2% / 100 万 |

## 六、盯盘编排（会话运行参数——编排调参不入策略四节，权威在 DEFAULT_STRATEGY.watch）

| 规则 | 参数键 | 默认 |
|---|---|---|
| 收盘收口链：复盘 turn 结束 → digest-run 编译 → 宿主自退（挂机无人值守；digest 失败不阻断自退） | `watch.closeOutAfterReview` | false（交互会话关） |

## 缺口清单（调试期按序）

1. ~~自动止损（离场节空白——最大缺口）~~ ✅ 2026-10-21 `exit.stopLossPct` 落地（watch 持仓风控唤醒，不自动卖）；止盈仍未固化
2. 挂账 #1：paper-broker 快照价成交 + 漂移拒单
3. ~~挂账 #2：maxDailyLoss 收紧~~ ✅ 2026-10-21 DEFAULT 50,000 → 15,000
4. 挂账 #8：创/科板块开关（2026 实跑候选 20 创/科占 9 席）
5. 择时层（S13 基线：裸轮动 3 年 −28.8%/回撤 −51.1%——择时是第一个改进方向）
