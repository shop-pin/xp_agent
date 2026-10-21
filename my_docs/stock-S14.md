# S14：交易系统成型（策略即配置——写到实盘前的最后一章）

> stock 课程第十四章。总纲见 `stock-00-plan.md` §四（P5 前的收官收敛章）。
> 交付：`plugins/strategy.ts`（六节策略配置 + `loadStrategy()` 用户覆盖加载器）+ 五处消费端接线（signal-engine 阈值参数化 / market-watch / trade-guard / get_stock_pool / backtest run+replay）+ `my_docs/strategy-one-pager.md` 一页纸 + `cordis-tests/s14-strategy.test.ts` 4 用例。
> 验收线：**同一策略配置让回测器与盯盘系统产出一致行为** ✅（两侧 import 同一 `loadStrategy()`；一致行为锚测试：池工具消费用户覆盖的 pool.topN，回测 CLI 同源）。

---

## 1. 本章要解决的问题

S5–S13 攒下的系统里，策略参数散在各处硬编码：引擎规则阈值在闭包里、watch 节流在配置缺省里、guard 上限在构造函数里、池过滤在纯函数缺省里、回测滑点在常量里。改一个阈值要动五处、回测与实盘可能各说各话——这正是 S14 验收线要消灭的状态："策略即配置，不散落在提示词里"（也不散落在代码里）。

## 2. 设计讲解

### 2.1 权威链（一条线，三层）

```
my_docs/strategy-one-pager.md        人读的策略（入场/离场/仓位/风控四节 + 缺口清单）
        ↓ 改动纪律：先改这页
plugins/strategy.ts DEFAULT_STRATEGY  机器读的唯一权威（TS 字面量、类型化）
        ↓ 节级深合并
~/.mini-claude/stocks/strategy.json   用户覆盖（调试期调参 = 改这一份文件）
```

五处消费端全部 `config.strategy ?? loadStrategy()`：插件显式 config > 用户覆盖文件 > DEFAULT。**默认值是各插件历史硬编码的零漂移搬家**——S14 合入当天全系统行为不变（cordis 282/282、mock 40、snapshot 39/39 零重录，就是零漂移的证明）。

### 2.2 一页纸的诚实：缺口比参数重要

四节里**离场节是空的**——没有自动止损/止盈，离场靠裁决面与人工。一页纸把它标成"调试期第一优先"而不是含糊带过：策略文档的价值一半在"已固化的规则"，另一半在**显式承认还没固化的规则**。S13 回测基线（裸轮动 3 年 −28.8%/回撤 −51.1%）在缺口清单里指向同一件事：择时/止损层缺位。

### 2.3 翻车记档（S14 的产出物恰好抓住的最后一个 bug）

spread 后显式赋 `topN: undefined` 会**把展开进来的策略默认值顶掉**——池工具的入参覆盖路径在 S12 就已失效（`{ ...defaults, topN: input.topN }` 当 input.topN 缺省时 = undefined 覆盖）。S14 的"一致行为锚"测试第一个抓到的就是它：策略写 topN=1，工具却返回 2 只。修复 = 仅对有值的入参覆写。教训：**展开 + 可选字段 = 隐式 undefined 覆盖**，是配置合并的经典暗坑。

### 2.4 浸入式确定性

插件缺省走 loadStrategy() 读真实家目录——用户调试期改 strategy.json 会让锚手算数字的单测变红。处理：所有阈值敏感测试挂 `strategy: DEFAULT_STRATEGY`（显式传默认，永远测权威值）；用户配置的行为由 s14 的覆盖/合并/一致锚用例在 HOME 沙箱里测。

## 3. 验收对账

| 验收项（plan §四） | 结果 |
|---|---|
| 参数固化（规则阈值/仓位上限/轮动节奏）进配置可调 | ✅ strategy.json 六节（universe/signals/watch/risk/pool/backtest）+ 用户覆盖深合并 |
| 策略文档化（一页纸：入场/离场/仓位/风控四节） | ✅ `strategy-one-pager.md`（规则→配置键映射表 + 缺口清单） |
| 同一策略配置让回测器与盯盘系统产出一致行为 | ✅ 一致行为锚测试（用户覆盖 pool.topN=1 → 池工具 1 只；backtest run.ts 同一 loadStrategy 源） |
| 回归 | cordis 282/282（s14 +4）/ mock 40 章全绿 / snapshot 39/39 零重录（默认零漂移的直接证明） |
