# 跟踪期：digest 与裁决打分器（2026-10-27）

> 起因：GLM lite 套餐被看盘烧穿（Day1 信号→turn 放大 + LLM 轮询上下文滚雪球）。
> 定案：监控的编译活全部下放到代码面（零 LLM），LLM 只在裁决/复盘进场。
> 本篇记这轮交付的东西、口径和翻车。

## 交付物

| 件 | 位置 | 说明 |
|---|---|---|
| 纯函数核 | `my_src/backtest/digest.ts` | 收益窗 / 裁决打分聚合 / 规则聚合 / 持仓重建 / 市场概览 |
| CLI | `my_src/backtest/digest-run.ts` | `node dist/backtest/digest-run.js [--day D] [--fetch]` → stdout + `<dataRoot>/digest/<D>.md` |
| 手算对拍 | `my_src/cordis-tests/tracking-digest.test.ts` | 6 用例：停牌跳窗、窗口未满、信心档拆分、比例结转、卖超跳过、中位数奇偶 |
| 学习库 | `my_docs/stock-learnings.md` | 四层教训库（信号/裁决校准/历史/执行）+ 周末分析协议 |

## 学习环全景（谁吃什么）

```
盯盘会话(S9) ──信号/裁决──▶ events/*.jsonl ──┐
data-store ──日K收口──▶ daily-k/*.jsonl ────┤
账本 ──fill──▶ paper-ledger.jsonl ──────────┤
                                            ▼
                  digest-run.js（零 LLM）→ digest/<day>.md
                                            │
                    ┌───────────────────────┤
                    ▼                       ▼
            盘后复盘（读旗标定夺）      周末历史分析（回测+K线）
                    │                       │
                    └────▶ stock-learnings.md ◀────┘
                                │（挂账 #9：确立条目进裁决上下文）
                                ▼
                         /adjudicate 更准
```

## 口径（digest 头注同款，此处展开）

- **打分基准 = 信号/裁决当日收盘**：事发时刻的精确价在 watch-detail 里有，但 v1
  不做最近邻查找——收盘 14:57 集合竞价可成交、T+1 可卖，是 T+1 约束下最贴近
  可实现情况的口径。代价：尾盘信号的 T+1 被低估（基准已吃掉部分涨幅）。
- **T+N 按票自己的日历数**：停牌日不在序列 = 天然跳过，不按市场日历硬齐。
- **窗口未满记 null，n 只数已闭环**：样本量与均值分开说，不拿 1 笔下结论。
- **持仓重建与 broker 内存态允许分级舍入差**：账本重放是独立真相源，不追求逐分对齐。

## 首跑发现（2026-10-22 数据）

1. signals.jsonl 12,915 笔/日——崩盘日放大（跌 4,959 家）。P1 修复的冷却/日上限
   在 **wake 侧**，signals.jsonl 是引擎全量流水：信号写入多 ≠ turn 多。对账聚合
   正好吃全量流水（样本越多越快确立），不是问题。
2. **verdicts 0 条**——S10 起才有入档工具且从未被用过。学习环第一环是断的：
   从今天起每轮 /adjudicate 后必须 record_verdicts，否则裁决校准层永远空白。
3. 模拟仓 sh600000（10-19 建仓 @10.00）浮亏 -3.43%，逼近 -5% 止损线——digest
   第五节直接可见，不需要 LLM 盯盘。

## 翻车记档

1. **chg 单位 ×100 两次**：Quote.changePercent 本来就是百分数（-2.44 = -2.44%），
   digest 的 pct() 又乘 100 → 中位涨幅显示 -244.30%。真数据冒烟抓的（纯函数单测
   全绿——因为测试只喂了比值不喂 chg）。教训：**单位约定要在类型名或字段名上
   立字据**（`chg` vs `chgPct` vs fraction），跨层复用数字前先查源头单位。
   S5"浮点用误差界"、S11"数字对不上先查自己推导"的同族第三案。
2. **测试全绿 ≠ 对**：本次翻车发生在单测全绿之后的首跑——固定死 fixture 的
   单测验不出"字段单位理解错"这类契约级错误，真数据冒烟不可省（ch14 纪律再现）。

## 用法速查

```bash
cd my_src && npm run build
node dist/backtest/digest-run.js                # 最新收口日，零网络
node dist/backtest/digest-run.js --fetch       # 补 hist-k 老窗口（联网按需）
node dist/backtest/digest-run.js --day 2026-10-22
```

## 自测题

1. 为什么打分基准用"当日收盘"而不是 watch-detail 里离裁决时刻最近的那笔价？
   什么时候这个口径会明显失真？
2. aggregateVerdicts 里 `n` 为什么只数非 null 窗口？如果把 null 当 0 进均值，
   会系统性地把新裁决的表往哪个方向带？
3. `--fetch` 只对"序列末尾早于最新收口日"的票补 hist-k——这个条件防的是什么？
   如果无脑全补，会引入哪两类噪声？
