# A 股功能演变方案（总纲）

> 目标：在 mini-cordis 上长出**真实可用的 A 股能力**——全市场行情监控、实时消息面、买卖点裁决、模拟盘与实盘执行。接口层预留港美股扩展（symbol 词汇表带交易所前缀）。
> 本文档是本阶段的权威进度记录，随章更新。每章的详细讲解写入 `my_docs/stock-<章号>.md`。
> 基座：dsh 课程终态（F1–F6 + 检视修复轮）——插件树、审批瀑布、F5 远程审批、F6 投影、loop/goal 自主性全部现成，本项目是它们的第一个"真需求"消费者。

---

## 一、三个核心设计思想

dsh 课程的三个思想（一切皆插件 / 日志即真相 / 能力接缝）在这里各兑现一次，另加一条本项目特有的：

### 1. 数据面与模型面分离（LLM 不看全市场）
- 全市场约 5,300 只。监控全市场是**数据面的活**：插件服务定时轮询快照 + 代码规则筛选，模型只看筛出的异常短名单。
- 与 C7 的"工具 schema 汇入=目录页"同构：模型看到的永远是与当前决策相关的浓缩面，不是原始数据海。

### 2. 信号 = 规则引擎，裁决 = LLM，执行 = adapter
- 指标计算（均线 / 量比 / 涨跌幅异动 / 突破）在代码里做——便宜、确定、**可回测**。
- LLM 的位置是裁决：给定信号短名单 + 关联新闻上下文，输出结构化 verdict（action/confidence/reasons）。让它直接盯行情流 = 慢、贵、不可回测、无诚实 alpha 预期。
- 执行走 **BrokerAdapter 缝**——复刻 C6 LlmAdapter 的思路，第二次兑现"换 provider 即换产品"：`PaperBroker`（自建模拟盘）与 `QmtBroker`（实盘）实现同一接口。

### 3. 风控代码化，执行必过审批
- 每笔订单走 C2 审批瀑布 + F5 远程审批卡（网页/终端确认才落地）——这是审批机制最自然的真需求场景。
- 风控硬限制写死在 pre-execute 监听器，不写在提示词里：交易时段闸门、涨跌停/ST 排除、单票仓位上限、单日亏损上限、`/halt` 一键熔断。**LLM 说"全仓"也拦得住。**

### 4. 日志即真相（沿用，不新造）
- 持仓/成交流水/净值注记进 SessionLog，F6 投影侧栏消费；模拟盘账本独立 JSONL（可脱离会话重放对账）。

---

## 二、四步需求可行性判定（2026-10-18 记档）

| 步 | 需求 | 判定 | 关键约束 |
|---|---|---|---|
| 1 | 监控全 A 股实时走势 | ✅ 可行 | 免费 L1 快照（东财 push2 分页全量，3–5s 一轮）；**重构为数据面+筛选器**，非 LLM 面 |
| 2 | 实时市场消息 | ✅ 可行（最简单） | 财联社电报/新浪 7x24/东财快讯轮询+去重；先过滤再进模型（token 纪律） |
| 3 | 判断买卖点 | ✅ 可行，需校准预期 | 规则出信号、LLM 裁决；**分钟级决策支持系统**，非印钞机；T+1/涨跌停/100 股整手/费用进策略层 |
| 4 | 真实平台买卖（模拟+实盘） | ⚠️ 最难 | A 股无官方散户 API；三条路径见下 |

第 4 步路径判定：
- **miniQMT / QMT / PTrade**（券商托管）：个人程序化实盘的合规通道，各券商资金门槛不同（几万~几十万），需 Windows 客户端常驻。实盘走这条路。
- **easytrader 类**（模拟券商客户端协议）：能跑但违反券商条款，有封号与监管风险——**只可用于研究，不用于实盘**。
- **自建模拟盘**：完全可行且应最先做。PaperBroker 账本走 JSONL，确定性可测试。

---

## 三、关键决策

1. **profile 化接入**：股票功能做成独立 profile（E2 分层清单），`--profile stock` 装配；base 层零感知，不装就不加载任何股票代码。
2. **数据源 adapter**：`QuoteSource` 接口，默认东财 push2（全市场快照）+ 新浪 hq（单票明细），可换。非官方接口随时断供——**首次接入时录真实响应样本进 fixture**，测试永不依赖网络。
3. **BrokerAdapter 缝**：`PaperBroker` 先行（S7），`QmtBroker` 收官（S10），同接口换实现。订单结构（code/side/price/qty/reason）两盘共用。
4. **模拟盘先行**：P3 全链路闭环零真钱；**至少跑数周、有真实跟踪记录**后再开 P4。此条为硬纪律。
5. **A 股约束建模位置**：T+1 / 涨跌停 / 整手 / 费用（佣金+印花税）建模在 broker 与风控层，不进提示词。
6. **symbol 词汇表**：带交易所前缀（`sh600000` / `sz000001`，预留 `hk` / `us`），第一天的数据结构就为扩展留位。
7. **与收尾队列的关系**：本项目转为主线（2026-10-18 起）；思考题回补遇相关主题并入对应章；E1/F3–F6 手测清单、ch14 复验可随时插队。

---

## 四、课程表（四阶段，约 10 章）

### 阶段 P1：数据面（只读，零风险）

**S1 行情快照插件** — `QuoteSource` 接口 + 东财实现（全市场分页快照）+ 新浪单票明细；`MarketDataService`（轮询 duty cycle：交易时段 3–5s、其余降频或停摆；环形缓冲存最近 N 轮）；工具 `get_quote`（单票）/ `screen_market`（条件筛选：涨跌幅/量比/换手/价格带，返回短名单）。验收：真接口冒烟 + fixture 回放测试 + 5,300 只全量拉取 <5s。

**S2 速览技能** — `/brief` skill：自选股一页纸（现价/涨跌/量比/关键位/最近新闻钩子）；watchlist 存放决策（memory vs 配置文件，章内定）。验收：mock 场景 + 真机一次速览。

### 阶段 P2：消息面（只读）

**S3 新闻插件** — `NewsFeedService`：财联社/新浪 7x24 轮询 + 去重 + 存储（JSONL）；工具 `latest_news(query/codes)`。验收：去重单测 + 真接口冒烟。

**S4 消息技能** — `/news-brief`：过滤后的新闻流 → LLM 摘要 + 个股关联（哪条影响哪只票）+ 情绪分级。验收：mock 场景锚请求体（token 预算上限断言）。

### 阶段 P3：信号 → 模拟盘闭环（零真钱）

**S5 信号引擎** — 指标计算（均线/量比/涨跌幅异动/突破，纯函数）+ 规则注册表（条件可配置）+ 信号事件（挂 cordis 事件面）。验收：指标单测（手算对拍）+ 规则触发用例。

**S6 裁决技能** — 信号短名单 + 关联新闻 → 结构化 verdict JSON（action/confidence/reasons/风险提示）。验收：mock 场景（含"新闻与信号矛盾"用例——真假摔）。

**S7 模拟盘** — `PaperBroker`：订单/成交/持仓/费用/T+1 建模，账本 JSONL（可重放对账）；持仓/成交流水/净值注记进 SessionLog → F6 投影侧栏。验收：确定性单测（费用/T+1/整手边界）+ 投影手测。

**S8 审批与风控** — 订单过 C2 瀑布 + F5 远程审批卡；风控监听器五件套（时段闸门/涨跌停与 ST 排除/单票仓位上限/单日亏损上限/`/halt` 熔断命令）。验收：**风控用例是验收主体**（每条硬限制一个用例，含"LLM 全仓指令被拦"）。

**S9 盯盘编排（P3 总验收）** — 开盘 loop 巡检 + 信号唤醒 turn + 收盘自动复盘（memory 记持仓与偏好）；一个会话跑完整交易日（真数据 + PaperBroker）。验收：全链路走查 + 复盘报告产出。

### 阶段 P4：实盘（独立开关）

**S10 QmtBroker** — miniQMT 调研（券商门槛确认）+ 同接口实现 + 实盘开关（配置双确认 + 首笔人工盯盘）。前置：P3 模拟盘跟踪记录 review。验收：券商模拟环境下单成功 + 实盘最小单位一笔（用户亲自确认）。

---

## 五、测试与回归策略

- **MockQuoteSource / MockNewsFeed**：真实响应样本录进 fixture，回放测试免网络、确定性（沿用 mock 优先纪律）。
- **paper broker**：确定性单测——费用计算、T+1 可卖判定、整手取整、涨跌停成交价钳制。
- **风控**：每条硬限制一个独立用例；负向用例（恶意/失控指令）为主。
- **LLM 面**：裁决/摘要技能 = 新 mock 场景；snapshot 体系照旧锚请求体。
- **真机**：东财/新浪/财联社真接口冒烟，纪律沿用 ch14（日志直写文件、一次性目标）。
- **每章验收线**：cordis 全绿 + mock 全绿 + 本章新增测试绿；S8 起风控用例不过 = 禁止进下一章。

## 六、风险与合规（记档）

- 非官方行情/新闻接口随时改版断供 → adapter 可换 + fixture 测试不依赖网络；数据只自用不转售（行情再分发有牌照问题）。
- 免费 L1 + LLM 秒级延迟 = **分钟级波段工具定位**，不做秒级打法，不承诺收益。
- 信号与裁决为研究输出，**非投资建议**；实盘前模拟盘先行（硬纪律）；实盘只走券商合规通道（miniQMT/PTrade），程序化报备由券商通道承担。
- LLM 裁决必带 confidence 与理由留痕（SessionLog 可回溯）——亏了能查到当时为什么动。

---

## 七、进度表（随章更新）

| 章 | 状态 | 完成记录 |
|---|---|---|
| S1 | ✅ 完成（2026-10-18） | `stock-S1.md`；market-data 插件（QuoteSource 接缝——**主源新浪/备源东财，东财 WAF 掐 Node 记档 §4-1**、MarketDataService 时段 duty cycle + 环形缓冲、get_quote/screen_market 两只读工具）+ `--profile stock`（base 默认 disabled）+ 11 测试（fixture 回放 + 两源对拍）+ 真机冒烟 5,576 只/1.73s；顺路抓获 ch8 偶发红第二根因（memory 索引/selector 双排序竞态，独立修）；cordis 199/199、mock 28 全绿、snapshot 28/28×2（ch8 重录）；建议 commit：`add market data plugin with sina quote sources and stock profile`（ch8 修另立：`make memory index and selector ordering deterministic`） |
| S2 | ✅ 完成（2026-10-18） | `stock-S2.md`；**产品内置技能层**（skills-registry 增 product provider rank 5，`my_src/skills/` 随产品发货，productSkills 配置开关——base 目录注入零变化）+ `/brief` 技能（inline，只报事实边界条款）+ `get_watchlist` 工具（路径归属代码；`~/.mini-claude/stocks/watchlist.txt`）+ stock profile 工厂化（catalogInjection 跟宿主）+ **mock 场景 34**（stock 首个进快照体系：extraRows 注入 MockQuoteSource 的样板模式）；cordis 203/203、mock 29 场景、snapshot 29/29×2（ch34 新录）；翻车记档：parseWatchlist 剥 `#` 自相矛盾（测试抓获）；建议 commit：`add product skill layer with brief skill and watchlist` |
| S3 | ✅ 完成（2026-10-18） | `stock-S3.md`；news-feed 插件（新浪 7x24 源——**新闻不做时段 gating，与 market-data 的 duty cycle 对仗**；id 去重 + JSONL 追加/重启回读 + lastRefreshAt 计龄；latest_news 只读工具——tags 收全 market 话题名、codes 只收 cn 关联）+ S1 健壮性补修（后台 refresh 失败吞不炸）+ mock 场景 35（extraRows 单行最小装配）；cordis 209/209、mock 30、snapshot 30/30×2（ch35 新录）、真机冒烟 270ms/20 条；翻车记档：inject 依赖测试摆桌、filterNews 非法代码往窄倒原则；建议 commit：`add news feed plugin with dedup storage and latest news tool` |
| S4 | ⬜ 未开始 | /news-brief 消息技能 |
| S5 | ⬜ 未开始 | 信号引擎（指标+规则+信号事件） |
| S6 | ⬜ 未开始 | 裁决技能（verdict JSON） |
| S7 | ⬜ 未开始 | PaperBroker + 净值投影 |
| S8 | ⬜ 未开始 | 审批与风控五件套 |
| S9 | ⬜ 未开始 | 盯盘编排（P3 总验收） |
| S10 | ⬜ 未开始 | QmtBroker 实盘（独立开关） |

> 约定：每章完成时在本表打勾、写 `my_docs/stock-<n>.md`（含翻车记档 + 自测题）、给 commit message（用户自己提交）。
> 模式沿用 D5 起：Claude 写讲解 md → 实现代码 → 验证（cordis + mock + 本章测试）→ 复查文档 → commit message → 问是否开下一章。
