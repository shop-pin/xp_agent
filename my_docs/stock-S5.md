# S5：信号引擎（P3 开工——规则出信号）

> stock 课程第五章。总纲见 `stock-00-plan.md` §四（P3 阶段）。
> 交付：`plugins/signal-engine.ts`（指标纯函数 ×5 + 规则注册表 + market/snapshot 事件驱动 + market/signal 广播 + get_signals 工具）+ market-data 升级（环形缓冲价格→三值、快照时间走注入时钟、refresh 尾发事件）+ 9 条 cordis 测试 + mock 场景 37 + 真机冒烟。
> 验收线：指标单测（手算对拍）✅ / 规则触发用例 ✅ / cordis 221/221 / mock 32 场景 / snapshot 32/32 ×2 / 真机冒烟：5,576 只单轮评估 102 条 limit-approach 真命中。

---

## 1. 本章要解决的问题

第三步需求"判断买卖点"的前半：**规则引擎出信号**（后半 S6 裁决）。总纲 §一思想 2 的落地现场：

- 指标计算在代码里做——便宜、确定、**可手算对拍**
- LLM 不盯盘，只看信号短名单（S6 的输入）
- 信号是**事件**——挂 cordis 事件面，S9 的 loop 编排从此订阅

## 2. 设计讲解

### 2.1 事件驱动接线：快照 → 评估 → 信号

```
MarketDataService.refresh() ──尾──► ctx.emit("market/snapshot", snap)
                                        │ 同步广播（fail-loud）
                                        ▼
SignalEngine.evaluateSnapshot(snap)   逐码 × 规则注册表（纯函数）
        │ 通过冷却 ──► recent 环 + ctx.emit("market/signal", s)
        ▼
消费面：get_signals 工具（模型/用户） · market/signal 监听器（S6/S9 预留）
```

选 `emit`（同步广播）而不是 `parallel`：评估是纯函数、微秒级，不需要并发等待；监听器抛错 fail-loud 上抛（B4 语义），正好把规则 bug 暴露在 refresh 路径上（start/tick 有吞错，工具面 ensureFresh 会把错误带给调用方）。

### 2.2 指标口径（全部手算对拍钉死）

| 指标 | 定义 | 手算样例 |
|---|---|---|
| windowChange | 窗口涨跌幅：(末价-基价)/基价，基价=窗口起点后首点 | 10→10.5/5min = +5% |
| volumeSurge | **日内量比近似**：近 probe 段量率 ÷ 观测期增量平均量率 | 平量=1.0；安静 10 轮+放量 1 轮=6.4 |
| vwapDeviation | 价 vs 当日均价：amount/(volume×100 股) | 10.5 vs 10.3 = +1.94% |
| breakout | 窗口极值突破幅度（窗口去近端带，防"突破自己"） | 10.45 > 窗高 10.3 = +1.46% |
| limitTier | 分板涨停位：ST 5 / 主板 10 / 双创 20 / 北交 30 | sz300750→20、*ST→5 |

三个关键口径决策（记档）：

1. **volumeSurge 的基线用增量** `(末量-首量)/跨度`——观测起点之前已积累的当日存量不是我们观测到的流量。盘中启动的会话若不剔除存量，平均量率被摊薄、surge 系统性偏低（§4-1 翻车）。真·量比（对过去 5 日）需要日线数据，本源没有——deferred，接口不变。
2. **窗口是观测窗不是交易所窗**：环形缓冲默认 60 轮 × 轮询间隔 ≈ 5 分钟视野；"5 分钟涨速"是观测窗内的 5 分钟。
3. **量能确认是硬门槛**：breakout 规则要求 surge ≥1.5 且 **surge 为 null（无量数据）同样不认**——零量序列的形态突破不裸奔。

### 2.3 规则注册表：同名后写胜

```ts
register: Map<name, rule>；构造时 defaultRules() + config.rules 依序写入
```

默认四规则：rapid-move（5min ±3%）、volume-surge（量率 ≥2.5 倍 + 同向 ≥1%）、breakout（5min 极值突破 + 量确认）、limit-approach（距分板 ≤0.5%，双向）。**自定义/替换 = 注册同名规则**——不改产品代码（与 product 技能层的覆盖语义同构）。

### 2.4 冷却：5s 流里的信号去抖

同 code+规则在冷却窗（默认 5min）内不重发。没有它，一个持续 10 分钟的急涨会在 5s 一轮的快照流里刷出 120 条同质信号——信号面变成噪音面。`suppressCount` 测试可见。

### 2.5 market-data 的三处升级（S1 债务清偿）

1. **环形缓冲三轮值**：`{p, v, a}` 取代裸价格——量类指标的口粮（S1 记档的"S5 重设计"兑现，内存量级不变）。
2. **快照时间走注入时钟**：`at: this.now().getTime()`——场景/快照确定性（工具输出里的时间戳不再依赖墙钟）。
3. **refresh 尾发事件**：`market/snapshot`——数据面到计算面的唯一通道。

## 3. 实现走查

| 文件 | 内容 |
|---|---|
| `my_src/plugins/signal-engine.ts` | seriesFor / 五指标纯函数 / SignalRule 接口 + defaultRules / SignalEngine（attach 订阅、evaluateSnapshot、冷却、recent 环）/ get_signals 工具（live 强刷 + 方向/规则过滤）/ fmtTime 固定 UTC+8（不经本机时区——输出进快照必须确定） |
| `my_src/plugins/market-data.ts` | HistoryRound 三值轮 / at 走注入时钟 / market/snapshot 事件 + Events 声明 |
| `my_src/cordis.config.ts` | 插件表 + baseRows（signals disabled，行序在 market 后=依赖就绪）+ stock profile 两分支 |
| `my_src/cordis-tests/s5-signal.test.ts` | 9 测试：五指标手算对拍 / 分板 / 规则触发与门槛 / 事件接线 + 冷却 + 工具 |
| `my_src/run-mock.mjs` | 场景 37 + signalProbe 分支（两轮演变 + 固定时钟） |
| `my_src/s5-smoke.mjs` | 真机冒烟（单轮真快照 → 102 条 limit-approach） |

性能口径：5,576 码 × 4 规则单轮评估，seriesFor 60 轮抽取——毫秒级，同步 emit 不挡 5s 轮询。

## 4. 翻车记档

1. **volumeSurge 基线掺存量**（手算对拍抓获）：初版 `avgRate = 末量/跨度`——观测起点的 1000 手存量被当成观测期流量，平量序列 surge 只有 0.107 而非 1.0。修：`(末-首)/跨度`。**手算对拍的价值就在这**：期望值是独立推导的，实现错了立刻红（§4-3 的手算错误则反过来——实现对、期望错，同样被照出）。
2. **量能闸的 null 语义**：初版 `surge !== null && surge < 1.5 → skip`——null（无量数据）**穿过闸门**，零量序列的突破形态裸奔成信号。修：`surge === null || surge < 1.5 → skip`。与 S3 的"往窄倒"原则同族：**门槛条件的缺省方向必须朝保守**。
3. **手算两次翻车**：突破窗内高点漏算 240s 的 10.3（期望写成 10.2）；平量 surge 的"1.0"没自己动笔算（初版实现下根本不是 1）。教训：**期望值必须逐项落笔**，"显然等于"四个字就是 bug 的温床。
4. **浮点等值**：`(10.2-10)/10×100 = 1.9999999999999927`——指标断言一律用误差界（`Math.abs(x-e) < ε`），`assert.equal` 只留给整值。

## 5. 验证记录（终态）

| 线 | 结果 |
|---|---|
| cordis | **221/221**（212 + 本章 9） |
| mock | 32 场景全绿（31 + 场景 37） |
| snapshot | **32/32 × 2 轮**（ch37 新录：2 请求 + 1 会话文件） |
| 真机冒烟 | 5,576 只 / 2.6s；单轮评估 102 条 limit-approach（分板 × 双向全命中） |
| dump-config | stock：market + news + signals 三行启用 |

## 6. 代码执行流程图

### 6.1 装配与事件流

```
--profile stock
  └─ market 行 ──► MarketDataService（轮询）
  └─ signals 行（inject tools+market）──► SignalEngine
        └─ attach(market): ctx.on("market/snapshot", evaluateSnapshot)

轮询 tick / ensureFresh / get_signals{live}
  └─ refresh(): 拉源 → history.push({at, rows:Map{p,v,a}})
                → ctx.emit("market/snapshot")
                     └─ evaluateSnapshot: 逐码（price>0）
                          seriesFor(history, code)  ← 60 轮抽取
                          逐规则 evaluate({quote, series})
                          冷却查表 → 通过 → recent 环 + emit("market/signal")
```

### 6.2 完整时序走查（mock 场景 37）

```
agent = Agent({extraRows:[
  market  ← {source: 两态 MockQuoteSource, now: 固定周一10:00CST, poll:60s},
  signals ← 默认规则]})
（50ms 等 start() 首轮：fetch#1 平静快照 → 评估：changePercent 1.0/-0.5
   距板远、单轮无窗口 → 0 信号）
chat("Check the live market signals.")
 req1 ──► get_signals{live:true}
          └─ market.refresh() → fetch#2 spike（sh600000 10→10.35）
             → snapshot 事件 → 评估：5min 涨速 +3.5% ≥3 → rapid-move up
                （volumeSurge 跨零 null、breakout 无窗基线 → 不触发）
          tool_result: 信号 1 条 … [10:00] sh600000 平平稳稳
                       rapid-move ↑ 强度3.5 5分钟涨 3.5%
 req2 ──► "signals checked."
snapshot: 2 请求 + 会话文件逐字节锚定 ✓（固定时钟 → 时间戳确定）
```

真机差异：轮询在交易时段自动跑，历史逐轮累积——volume-surge/breakout 在第二轮起陆续可触发；冷却把持续形态压成首发一条。

## 7. 交付与 commit

- 建议 commit：`add signal engine with indicator rules and market events`
- 手测清单（用户终端；窗口类指标需交易日盘中多轮观测）：
  1. 交易日盘中 `node dist/cli.js --profile stock`，放 10 分钟让环形缓冲积累；
  2. "现在有什么信号？"——期望 get_signals 给出急涨急跌/放量/突破短名单；
  3. "刷新一下信号"——期望模型用 live:true 强刷；
  4. 休市时跑：只有 limit-approach 类（收盘快照口径），窗口类指标静默——这是口径设计而非故障。

## 8. 自测题

1. volumeSurge 为什么必须用增量基线？构造一个"开盘即启动 vs 盘中启动"的对照：两种启动方式在初版实现下对同一只票算出的 surge 差多少？
2. breakout 的窗口为什么去掉近端带（probeMs）？不去的话，"突破自己 30 秒前的高点"和"突破 5 分钟高点"在语义上差在哪？
3. 冷却键为什么是 `code#rule` 而不是 `code`？如果用 code，同一只票的 rapid-move 和 limit-approach 会怎么互相压制？
4. market/snapshot 选 emit 而不是 parallel——如果评估慢到毫秒级以上（比如未来加复杂指标），这个选择的代价是什么？迁移路径是什么？
5. 场景 37 用"固定时钟让两轮快照同刻"来确定性化——代价是量类指标全部 null。如果要场景同时测 volume-surge，时钟注入该改成什么形态？（提示：`now` 是闭包）
6. 真机冒烟 102 条 limit-approach 里 strength 有 0（已到板）也有 0.21——strength=0 意味着什么？S6 裁决时这两类应该同权重吗？
