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

### 第五批需求判定（2026-10-20，用户四条 + 微盘轮动文章）

| 需求 | 判定 | 关键约束 |
|---|---|---|
| ① 明早 `/watch` 自动盯盘 | ✅ **已交付（S9）** | 巡检/信号唤醒/收盘复盘三 turn 编排已在跑；本批不新增代码，明早起会话 `/watch` 即可 |
| ② 买卖盘（五档盘口） | ✅ 可行且便宜 | **新浪 hq 明细接口自带五档量价**（parser 已在调此接口，只是没解析这些字段——增量是解析不是新源）；全市场排行列表**无盘口**——盘口只对关注面（watchlist+持仓+信号短名单）按需拉，≤50 只/批；真 L2/逐笔要付费，不做，定位仍是免费 L1 |
| ③ 多因子自动买卖点（T+1） | ✅ 骨架已在，扩因子 | S5 规则引擎 + S6 裁决 + S7 T+1 建模 + S8 风控已成环；扩容=因子表加项（盘口买卖压力/量价背离/均线排列）+ 裁决技能吃盘口上下文；预期校准不变（分钟级决策支持，非预测器） |
| ④ 数据留存（复盘/回测原料，可迁移） | ✅ 可行，必须分层 | 全市场 5s 快照全落地 ≈3GB/天，不可行。分三层：**日 K 收口**（每天收盘从实时快照写一条全市场日 K，~1MB/天——回测的原料，零额外请求）/ **明细层**（关注面 5s + 盘口）/ **事件层**（signals/verdicts 独立落地，现在只在 SessionLog 里）。JSONL + schema 版本头 + 数据根目录可配置 = 换机器拷目录即用 |
| ⑤ 交易系统成型 → 实盘 | ⚠️ 分两步走 | 成型 = 复盘/回测反馈环 → 参数固化（阈值/仓位/节奏）→ 策略文档化；实盘技术上可全自动（miniQMT/xtquant 支持程序化下单），监管上程序化交易需券商报备（通道承担），纪律上**先半自动（每单人工确认）跑稳定期**，全自动设独立开关 + 达标条件清单；高频级不碰 |
| ⑥ 微盘股轮动（文章学习 2026-10-20） | 选股小活 / 回测大活 | 选股：PE 字段差一行解析（新浪列表有 per 未取）、IPO 日期缺数据源（章内调研）；回测：历史日 K 源 + 按日重放引擎 + 绩效计算（年化/回撤/分层）完全新建；费用模型复用 PaperBroker computeFee；文章自述三大死穴（流动性/退市/容量）照录 |

---

## 三、关键决策

1. **profile 化接入**：股票功能做成独立 profile（E2 分层清单），`--profile stock` 装配；base 层零感知，不装就不加载任何股票代码。
2. **数据源 adapter**：`QuoteSource` 接口，默认东财 push2（全市场快照）+ 新浪 hq（单票明细），可换。非官方接口随时断供——**首次接入时录真实响应样本进 fixture**，测试永不依赖网络。
3. **BrokerAdapter 缝**：`PaperBroker` 先行（S7），`QmtBroker` 收官（S10），同接口换实现。订单结构（code/side/price/qty/reason）两盘共用。
4. **模拟盘先行**：P3 全链路闭环零真钱；**至少跑数周、有真实跟踪记录**后再开 P4。此条为硬纪律。
5. **A 股约束建模位置**：T+1 / 涨跌停 / 整手 / 费用（佣金+印花税）建模在 broker 与风控层，不进提示词。
6. **symbol 词汇表**：带交易所前缀（`sh600000` / `sz000001`，预留 `hk` / `us`），第一天的数据结构就为扩展留位。
7. **与收尾队列的关系**：本项目转为主线（2026-10-18 起）；思考题回补遇相关主题并入对应章；E1/F3–F6 手测清单、ch14 复验可随时插队。
8. **数据留存分层（2026-10-20）**：日 K 收口 / 关注面明细 / 事件层三档；JSONL + schema 版本头 + 根目录可配置（env，缺省 `~/.mini-claude/stocks/data`）——可迁移 = 拷目录；回测与复盘消费同一格式，回测器是留存层的第一个消费者。
9. **盘口范围纪律（2026-10-20）**：五档盘口只进关注面（watchlist + 持仓 + 信号股），全市场轮询仍只有成交快照；L2/逐笔付费数据不接。
10. **实盘自动性阶梯（2026-10-20）**：半自动（每单人工确认）→ 稳定期后全自动开关（配置双确认 + 回测与模拟盘双达标）；程序化报备由券商通道承担，不做高频。
11. **外部输入学习机制（2026-10-20）**：用户持续投喂 AI×股票文章/视频 → 拆解为能力清单 → 可行性判定（同 §二 格式）→ 并入课程表；第一例 = 微盘股轮动文章 → S12/S13。

---

## 四、课程表（六阶段，约 15 章）

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

### 阶段 P4：数据与策略深化（2026-10-20 扩充，原 P4 实盘顺延为 P5）

**S10 数据留存与历史落地** — 数据根目录（env 可配）+ 三层留存：日 K 收口（收盘从实时快照写全市场日 K，JSONL 按+schema 版本头）/ 关注面明细（watchlist+持仓+信号股的 5s 行情与盘口）/ 事件层（signals/verdicts 独立 JSONL，脱离 SessionLog 可独立消费）；重启回读、坏行跳过纪律沿用账本。验收：断电重启用昨天的数据文件重启无感 + 换目录 env 一改全通 + 一周数据体量记录。

**S11 盘口数据与买卖压力因子** — hq parser 扩展五档量价（buy1-5/sell1-5）→ Quote 增字段；关注面盘口轮询（≤50 只/批）；`get_quote` 返回盘口；信号引擎加买卖压力因子（如 (买五量−卖五量)/(买五量+卖五量)）与量价背离规则；裁决技能上下文加盘口。验收：盘口解析 fixture 对拍 + 压力因子手算用例 + T+1 下买卖点用例（当日买入不可卖在裁决提示中显式存在）。

**S12 选股池工具（微盘轮动·上）** — 数据面纯函数：`pick_pool`（按流通市值升序 head(N) + 七道过滤：停牌/ST/板块/流动性/低价/PE 区间/PB>0/次新）；`screen_market` 之外的第二只读工具；parseSinaList 补 per 字段；**IPO 日期源调研**（新浪列表无此字段，找免费 HTTP 源，fixture 照录）。验收：筛选纯函数手算用例 + 真接口冒烟 + "随机抽股核对过滤生效"（文章体检法）。

**S13 历史日 K 与回测引擎（微盘轮动·下）** — 历史 K 线数据源调研与接入（新浪/腾讯/东财 hist，Node 可达性逐一探测，fixture 照录）+ 按日重放引擎（选股规则逐日重放 → 订单流 → 净值序列，费用复用 computeFee）+ 绩效计算（年化/最大回撤/回撤持续与修复/分层）。验收：手算小样本对拍（10 个交易日）+ 微盘 20 轮动跑通近三年 + 净值/回撤文本曲线输出；**回测结果只进研究面，不直接驱动下单**。

### 阶段 P5：交易系统与实盘（独立开关——2026-10-21 用户定：暂无实盘资格，S14 止步，S15 等券商门槛与达标清单）

**S14 交易系统成型** — 复盘/回测反馈环：S10 留存数据 + S13 回测 → 参数固化（规则阈值/仓位上限/轮动节奏）→ 策略文档化（一页纸：入场/离场/仓位/风控四节）+ 参数进配置可调。验收：同一策略文档能让回测器与盯盘系统产出一致行为（策略即配置，不散落在提示词里）。

**S15 QmtBroker（原 S10 顺延）** — miniQMT 调研（券商门槛确认）+ BrokerAdapter 同接口第三实现 + 实盘开关（配置双确认 + 首笔人工盯盘）；自动性按决策 #10 阶梯：先半自动（每单人工确认），全自动等达标清单（模拟盘数周记录 + 回测达标 + 用户显式开闸）。前置：P3 模拟盘跟踪记录 review + S14 成型。验收：券商模拟环境下单成功 + 实盘最小单位一笔（用户亲自确认）。

### 挂账清单（随相关章节并入，2026-10-20 建单）

1. ✅ **模拟盘成交建模两补丁**（治 stale-price fill 乐观偏差；2026-10-31 落地）：滑点成交——`fill = min(委托价, 最新快照×(1+slip))`（buy，sell 对称 max）——限价保护保留、不再按委托价乐观成交（到分 round2）；价格漂移拒单——委托价与下单时刻最新快照偏离 >1% 拒（stale 挂单 fail-closed）；`PaperConfig.slippage` 缺省走 `backtest.slippage`（同一配置驱动回测与模拟盘）。波及面：7 个测试场景借 stale 漏洞（卖单委托价离快照 10%）全部改为"卖前刷快照"——借漏洞本身证明补丁治的偏差真实存在
2. ✅ guard 单日亏损上限缺省 5 万，对 300k 账户偏松（16.7%/天）——已收紧（2026-10-22 随止损 exit 节落地：`risk.maxDailyLoss` 50k → 15k = 5%/日，进 strategy 配置）
3. ✅ 账本 CSV/Excel 导出小工具（S10 已落地：`get_trades_csv` 工具，CSV 逐字段 echo 账本）
4. ✅ 场景 29（S2 stockProbe，现为 ch34）挂 news 即真网络轮询（失败静默吞）→ 已修（2026-10-31 小尾巴轮）：extraRows 加 news mock 行覆盖 profile 的 news-feed（同 market 行手法）
5. ✅ snapshot runner record 模式尾行判定误报（找 "✓" 打的是 "⚑"）→ 已修（2026-10-31）：record 模式判定认 ⚑（录制完成即目标达成）——`--record` 不再恒红，可进 `&&` 链；replay 判定不变
6. ✅ host 仅实现 GET，HEAD 请求落 API 404 → 已修（2026-10-31）：serveStatic 加 headOnly（头照发 body 不写）
8. ✅ S12 候选池"板块"过滤目前=北交所红线剔，创业板/科创板在池内（Day1 候选 20 占 9 席）——**开关已加（2026-10-31）**：`pool.excludeCK`（pickPool 剔 sz30/sh68 前缀 + get_stock_pool 工具参数覆盖），**默认 false 行为零漂移**；要用主板纯微盘池时在 `~/.mini-claude/stocks/strategy.json` 的 pool 节开 `{"excludeCK": true}`
7. **S5/S9 信号管道修复轮**（2026-10-21 跟踪 Day 1 实跑复盘：80 信号→80 turn→0 下单、真涨停迟发 5.5h，根因与逐项清单见 `my_docs/stock-tracking-20261021-review.md`）——P0：宇宙闸（日成交额下限 + excludeBJ **默认 true**——2026-10-21 用户定：北交所现不买，以后配置放开；原"bj 单独收紧阈值"建议随之挂起）+ 重发纪律（同 code+rule 日上限 2 次 / 重发需 |strength|×1.5 / 方向翻转强证据）+ guard 标的排除加 bj 前缀（"不交易"交易面兜底，规则映射发现）；P1：机械门槛进引擎（breakout 双门槛 |pct|≥0.5% 或 surge≥2.5、volume-surge 绝对量 ≥30 万/分钟、N 前缀首日跳板位规则、低价股门槛按 tick 归一）+ 唤醒管道（冷却改"留最新/超龄丢弃"、同 code 当日已裁决不再 wake、攒批 digest 唤醒）+ 已裁决记忆回流（no-opinion/avoid 码当日静音）；P2 观察后定：信号分层 wake/log（防双门槛误杀广誉远式贴线真票，仍待观察）、~~数据面刷新失败可见性~~ ✅（2026-10-31 随三缺陷修复轮落地：`market/degraded` 事件 + 限频告警 + health 观察面，见 #10）。→ 跟踪期 S5/S9 修复轮，S10 前完成
9. **学习环·教训进裁决**（2026-10-27 建，起因 = GLM lite 套餐被看盘烧穿）：已落地零 LLM 的 digest/裁决打分器（`backtest/digest.ts` + `digest-run.ts`，events×日K×账本 → `digest/<day>.md` 一页：裁决按 action×信心档对账 T+1/T+3、规则 T+1 对账、持仓风控、自动旗标；手算对拍 `tracking-digest.test.ts`）+ 学习知识库 `my_docs/stock-learnings.md`（四层教训库 + 周末历史分析协议）。待办：(a) 纪律——每轮 /adjudicate 后 record_verdicts（首跑发现 verdicts 0 条，校准层断粮）；(b) 裁决技能吃 learnings 确立条目（≤10 条进上下文）；(c) 周末与用户跑首场历史分析（2026-10-31/11-01 候选）→ 跟踪期 P2
10. ✅ **10-30 空转日三缺陷修复轮**（2026-10-31 修，`stock-tracking-20261031-fixes.md`）：①数据面健康度（连续失败 ≥3 轮 = degraded：`market/degraded` 事件 + UI 限频 30 分钟告警 + `market.health` 观察面；watch 记 note 不唤醒 turn）+ 自动兜底（stock-tdx→sina 显式配、stock 缺省→eastmoney；当轮切换立即重试、**不自动切回**——挂机日结进程每日重启即重置）；②get_portfolio 无行情不按 0 元估（`市值—（无行情，未计值）` + 总市值只累有行情部分并注明缺口）；③digest 显式 `--day`（watch closeOut(day) 带 day + stderr 捕获非零 reject；digest-run 显式日无收口报错 exit 1 不静默编旧日）。回归：cordis 302/302、mock 28 章、snapshot 40/40（ch34/39-44 描述漂移重录）。翻车记档：`tsc --noEmit` 不产 dist 回归白跑（298→302 破绽）；snapshot replay 偶发红根因=探针 chat 抛错被吞+50ms 竞速窗（与改动正交，见下条）
11. ✅ **snapshot replay 偶发红（探针脆弱点）**（2026-10-31 观察，同日小尾巴轮加固）：三处治本——①`probeFetchGate` 确定性等待替换 8 处裸 `setTimeout(50)` 竞速窗（包裹 mock source 调用计数，2s 超时显式抛错走 crash 通道）；②crash 退出码收紧（`crashed → exit 1`，不再被"verify 绿"吃掉）+ runner 失败时带出 stderr 尾巴（可断因）；③**意外收获：ch41 watchProbe 的 finally `watch.stop()` ReferenceError 被吞数日**（try 内 const 让每次成功路径都崩、crash exit 0 静默）——声明提 try 外根治。ch41 因 close 流程完整化多一行事件重录。教训记档：**"crash 但退出 0"是最危险的静默吞模式**，收紧退出码是抓这类 bug 的手段

---

## 五、测试与回归策略

- **MockQuoteSource / MockNewsFeed**：真实响应样本录进 fixture，回放测试免网络、确定性（沿用 mock 优先纪律）。
- **paper broker**：确定性单测——费用计算、T+1 可卖判定、整手取整、涨跌停成交价钳制。
- **风控**：每条硬限制一个独立用例；负向用例（恶意/失控指令）为主。
- **LLM 面**：裁决/摘要技能 = 新 mock 场景；snapshot 体系照旧锚请求体。
- **数据层（S10 起）**：JSONL 带 schema 版本头——旧文件 + 新代码 = 可读或明确拒读，不许静默错解；坏行跳过纪律沿用账本。
- **回测（S13 起）**：历史 K 线真响应录 fixture，回放测试永不依赖网络；手算小样本对拍是验收主体；回测输出只进研究面。
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
| S4 | ✅ 完成（2026-10-18，P2 收官） | `stock-S4.md`；/news-brief 技能（product 层自动发现——**config 零接线**；token 硬预算=模板劝+场景钉双层：30 条池 limit=15 恰数断言+输出长度上限；三段产出要闻/个股关联/整体情绪+防火墙条款）+ news.jsonl 折叠收口（2MB 保半重写，S3 deferred 兑现）；cordis 212/212、mock 31、snapshot 31/31×2（ch36 新录；**ch34 因目录演进重录——product 技能是共享面，加技能=全装配目录变化**）；翻车记档：mock 数据违反源契约方向、泛锚跨 tool_result 串门、allowed-tools=装配需求清单；建议 commit：`add news brief skill with token budget and feed rotation` |
| S5 | ✅ 完成（2026-10-18） | `stock-S5.md`；signal-engine 插件（**market/snapshot 事件驱动→market/signal 广播**——数据面到计算面唯一通道；五指标纯函数手算对拍：windowChange/volumeSurge 日内量比近似（**增量基线**，存量掺入是指标级 bug 被手算照出）/vwapDeviation/breakout（量能硬门槛：surge null 不认）/limitTier 分板；规则注册表同名后写胜；code#rule 冷却 5min）+ market-data 三升级（环形缓冲 p/v/a 三值、at 走注入时钟=快照确定性、refresh 尾发事件）；cordis 221/221、mock 32、snapshot 32/32×2、真机冒烟 5,576 只单轮 102 条 limit-approach 分板全命中；翻车记档：基线掺存量、null 穿闸、期望值必须逐项落笔、浮点用误差界；建议 commit：`add signal engine with indicator rules and market events` |
| S6 | ✅ 完成（2026-10-18） | `stock-S6.md`；/adjudicate 技能（**inline——fork 对插件工具白名单是断的（toolDefinitions 静态集），能力传递记档为已知缺口 S9 再议**；verdict 契约：action 四值无 buy/sell、confidence 保守阶梯 0.4/0.3/0.8、真假摔条款、每人 ≤2 次 news；留痕=assistant 消息即日志）+ 发货守门测试钉契约条款；引擎零改动；cordis 222/222、mock 33、snapshot 33/33×2（ch38 新录；ch34/36 目录演进重录）；建议 commit：`add adjudicate skill with verdict contract over signals and news` |
| S7 | ✅ 完成（2026-10-18） | `stock-S7.md`；PaperBroker（**BrokerAdapter 缝第二次兑现**——S10 QmtBroker 同接口；费用三科目手算锚/T+1 北京日历日切/整手/**价带拒单不钳价**（往窄倒第三效）/加权成本按比例结转；留痕三轨：账本 JSONL 重放=真相、SessionLog trade 注记=F6 侧栏 fold、broker/fill 事件=S8/S9 面；place_order hint=exec 走既有 confirm=S8 换瀑布的预留位）+ **web-stock 组合 profile**（F6 投影手测通路）+ 投影 trade fold；cordis 233/233、mock 34、snapshot 34/34×2（ch39 新录）、vite 246.74KB；翻车记档：费用科目漏项×2、测试自删账本；建议 commit：`add paper broker with fee t1 modeling and ledger replay` |
| S8 | ✅ 完成（2026-10-19） | `stock-S8.md`；trade-guard 五件套（halt 熔断/时段闸门/ST+退市与**触板**拒单（比 broker 出界拒严一档）/单日亏损上限（broker todayPnl 惰性日切口粮）/单票仓位上限——**"全仓"指令拦死**）+ **fail-closed 不变量**（无行情=拒单，翻车#1 抓获的 fail-open 缺陷）+ **审批卡补齐**（exec hint 在 C2 判定序无 ask 分支——S7"走 confirm"说法证伪；guard 通过后 default 模式自 ask，auto 弃权给分类器=弃审批不弃风控）+ 行位两件套（baseRows 占位行钉 approval 外圈 + inject 只 commands 即时激活/依赖惰性取）+ mock 场景 40（**confirm 计数锚定 deny 短路**：三单一确认）；cordis 242/242、mock 35、snapshot 35/35×2（ch40 新录）；翻车记档：fail-open 修复、摩擦要计数验证、ch9/10 负载偶发、场景 29 真网络记档；建议 commit：`add trade guard with five hard limits and order approval gate` |
| S9 | ✅ 完成（2026-10-20，P3 收官） | `stock-S9.md`；market-watch 插件（**三 wake 源**：开盘巡检/盘中信号（冷却 3min+halt 静默）/收盘复盘——"LLM 不在没事件时醒"；**tick 状态机观察迁移不描墙钟**——注入钟/时钟跳变天然稳健，cnDay 跨日重置连盯多日；watch 无自己的钟=market.clock() 单一来源；/watch 显式武装非挂载即盯）+ /review 技能（五段复盘、事实先于评价、持仓快照同名覆盖）+ **save_memory 写口**（writeTool config 门控、索引纪律 saveMemory 维护）+ get_trades/当日盈亏行 + memory 行整行替换（同 skills 行纪律）+ mock 场景 41（**三 turn 全 wake 驱动零用户输入**——编排即产品形态）；S6 fork 缺口未消费未修续挂账；cordis 252/252、mock 36、snapshot 36/36×2（ch41 新录；34/36/38/39/40 目录+工具演进重录）；翻车记档：inject 升级炸最小树（负向断言空过）、firstUserText 假阳/假阴对（泛锚复发）、schedule 裸 setTimeout 挂进程（手动 start 必手动 stop）；建议 commit：`add watch orchestration with day cycle and review skill` |
| S10 | ✅ 完成（2026-10-21，P4 开章） | `stock-S10.md`；data-store 插件（**三层留存**：日K收口=观察 open→closed 迁移后一次写全市场 10s 小步巡检/watch-detail=watchlist∪持仓∪信号股 三腿宇宙上限 100 码/events=signals+verdicts 独立 JSONL）+ **schema 版本头**（首行 {"v":1,"schema":...}，读侧 `readSchemaJsonl` 不符明确拒读——§五"不静默错解"首次落地通用读口）+ 账本纪律沿用（追加/坏行跳过/落盘失败吞不炸）+ 断电重启幂等（内存日键+existsSync 双闸，晚间重启补收口）+ env `MINI_STOCKS_DATA_DIR` 根目录可配 + **record_verdicts 工具 + adjudicate 入档条款**（裁决事件层=P2 记忆回流的代码半边）+ get_trades_csv（挂账#3 ✅）+ paper-broker `allFills()` 访问器 + mock 场景 42；翻车记档：服务名必须=ctx 严格读键（档案名可带连字符服务名不行）、s6 契约测试红得对（改模板先锚契约）；体量估算 16+0.8MB/日，一周实测待跟踪期替换；跟踪期修复轮 P0+P1 同日落地（宇宙闸/重发纪律/watch 信箱 digest，详见 stock-tracking-20261021-review.md）；cordis 265/265、mock 38、snapshot 37/37（ch41/38 重录、ch42 新录）；建议 commit：`add data store with three layer retention and verdict events` |
| S11 | ✅ 完成（2026-10-21） | `stock-S11.md`；五档盘口（market-data `Level`/`Book` + `parseBook` 解析 hq f[10..29] 量=股、Quote.book 可选、get_quote 五档行）+ `bookPressure` 纯函数 + **book-pressure 规则**（\|压力\|≥0.6 且与 5min 涨速同向且 \|chg\|≥1 三腿——单看比值会被托压单做出来）+ **volume-divergence 量价背离**（\|chg\|≥1.5 而 surge<0.8，方向取背离语义=警示）+ 引擎盘口缓存（market/book 事件，RuleContext.book 可选注入非关注面 null 让路）+ data-store 关注面盘口轮询（10s 心跳顺带、universe 前 50 只/批、盘口行进明细层）+ adjudicate 技能盘口佐证维度 + **T+1 显式条款**（当日买入不可卖，s6 契约锚定）+ mock 场景 43；翻车记档：背离用例手算错误被实现逮住（数字对不上先查自己推导）、verify 锚"单档形"假阴（锚真实产出形状）；cordis 270/270、mock 39、snapshot 38/38（ch37/38/41 重录、ch43 新录）；建议 commit：`add order book parsing with pressure factor and divergence rule` |
| S12 | ✅ 完成（2026-10-21） | `stock-S12.md`；`pickPool` 七道过滤纯函数（停牌/ST·退·北交所红线/流动性 3000 万/低价 2 元/PE 区间 0-300 未知剔除/PB>0/次新 365 天退化 N/C 前缀——阈值全部可调，默认=保守起点）+ `get_stock_pool` 只读工具（候选数/全市场数/IPO 源注记 + 流通市值升序）+ `Quote.pe`（parseSinaList 补 per=第五批判定兑现；东财补 f9）+ **`fetchIpoDays?` 可选能力**（东财 clist f26=YYYYMMDD，**2026-10-21 真机实测 Node 可达——2026-10-18 的 WAF RST 不复现，记档更新：东财对 Node 可用性时变，依赖前先探**；源失败退化 N/C 前缀且输出注记明说）+ mock 场景 44；板块口径=北交所红线剔（创/科在池内，20 候选中占 9 席，调试期按需加开关挂账）；真机冒烟：5,575 只/4.4s + IPO 5,922 只/0.7s → 候选 20（流通 8.3-13 亿）；翻车记档：map 直接引用带可选参函数签名隐雷、记档知识自带时效；cordis 274/274、mock 40、snapshot 39/39（ch44 新录，旧章零重录）；建议 commit：`add stock pool picker with seven filters and ipo dates` |
| S13 | ✅ 完成（2026-10-21，P4 收官） | `stock-S13.md`；backtest/ 研究面四模块（kline/replay/metrics/run CLI）+ **微盘 20 轮动近三年跑通**（866 交易日、5,920 笔调仓、总收益 −28.8%/回撤 −51.1%/2024 −25.4%=微盘流动性危机显形；缓存 hist-k/ 后重放 6.4s）+ 手算对拍（10 交易日 4 笔调仓净值逐日到分）+ 文本曲线；**源探测更正**：东财 IP 级间歇封锁当日实测（上午通/午后 curl+Node 双 000）——日K主源改腾讯 ifzq qfq（全天候稳定），东财 fetchIpoDays 保留供封锁窗；近似口径四条记档（静态缩放/收盘成交/滑点 ±0.2%/amount≈close×vol×100）；费用 computeFee 单源复用；挂账#1 实盘侧双补丁仍在账（回测侧滑点已内置）；翻车记档：手算名次错被引擎逮住（第三次同族）、metrics 恢复判定写反、Number("")=0 残行、初始资金 replace("_") 只换首个、"1_000_000"教训；回测=研究面不进插件树（零快照变化）；cordis 278/278、mock 40、snapshot 39/39；建议 commit：`add backtest engine with daily rotation replay and metrics` |
| S14 | ✅ 完成（2026-10-21，P4/P5 分界——实盘前最后一章） | `stock-S14.md` + `strategy-one-pager.md`（一页纸：入场/离场/仓位/风控四节+缺口清单，**离场=无自动止损标为调试期第一优先**）；`plugins/strategy.ts` 六节策略配置（DEFAULT_STRATEGY=历史硬编码零漂移搬家）+ `loadStrategy()` 用户覆盖（~/.mini-claude/stocks/strategy.json 节级深合并、坏配置明确拒读）+ 五处消费端接线（engine 阈值参数化 defaultRules(strategy)/watch/guard/池工具/回测 run+replay slippage）；**一致行为锚测试**（用户覆盖 pool.topN → 池工具生效，回测 CLI 同源）；翻车记档：spread 后显式赋 undefined 顶掉策略默认（池入参覆盖 S12 起就失效，一致锚首个战果）、阈值敏感测试挂 DEFAULT_STRATEGY 保浸入式；默认零漂移证明=cordis 282/282、mock 40、snapshot 39/39 全部零重录；建议 commit：`add strategy config with one page policy and parameter wiring` |

> 约定：每章完成时在本表打勾、写 `my_docs/stock-<n>.md`（含翻车记档 + 自测题）、给 commit message（用户自己提交）。
> 模式沿用 D5 起：Claude 写讲解 md → 实现代码 → 验证（cordis + mock + 本章测试）→ 复查文档 → commit message → 问是否开下一章。
