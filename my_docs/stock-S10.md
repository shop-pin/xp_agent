# S10：数据留存与历史落地（P4 开章——回测器的口粮从今天开始攒）

> stock 课程第十章。总纲见 `stock-00-plan.md` §四（P4 阶段）。
> 交付：`plugins/data-store.ts`（三层留存 + schema 版本头 + record_verdicts/get_trades_csv 两工具）+ paper-broker `allFills()` 公共访问器 + profile 接线（base disabled，stock/web-stock 启用）+ adjudicate 技能入档条款 + `cordis-tests/s10-datastore.test.ts` 5 用例 + mock 场景 42（datastoreProbe）。
> 验收线：断电重启续写无感 ✅ / 换目录 env 一改全通 ✅（`MINI_STOCKS_DATA_DIR`）/ 一周数据体量 = **估算已记档（§4），真实值待跟踪期实跑一周后替换** ⏳。

---

## 1. 本章要解决的问题

S1–S9 的数据全是**易失的**：快照在环形缓冲里滚 5 分钟就被挤掉，信号留内存 200 条，裁决躺在会话日志里和杂讯混在一起。复盘靠回忆、回测没有原料、规则晋升（trading Day 1 复盘那条链路）没有数据底座。

S10 只做一件事：**把数据按消费方的需要分层落盘**——而且格式语言无关（JSONL + schema 版本头），这是"回测器是留存层第一个消费者"（决策 #8）和将来 Python 边车能读同一份数据的前提。

## 2. 设计讲解

### 2.1 三层分层：按消费节奏分层，不按数据类型堆砌

| 层 | 文件 | 写时机 | 消费方 |
|---|---|---|---|
| 日 K 收口 | `daily-k/<day>.jsonl` | 观察转入 closed 后**一次写全市场** | S13 回测、日线因子 |
| 关注面明细 | `watch-detail/<day>.jsonl` | 盘中每轮快照**追加**（宇宙 ∩ 快照） | 盘后回放、S11 盘口因子 |
| 事件层 | `events/signals.jsonl` / `events/verdicts.jsonl` | 事件发生即追加 | 复盘、规则晋升（今天 Day 1 复盘那种活的数据原料） |

分层的判据是**写入节奏 × 消费视野**：日 K 一天一次（写全市场不心疼），明细 5 秒一次（所以宇宙要收口——watchlist ∪ 持仓 ∪ 信号股，上限 100 码），事件低频但要求独立可消费（脱离 SessionLog，机器可读）。

**宇宙三腿**是 S11 盘口轮询（≤50 只/批）共用口径的雏形：watchlist 是用户意志，持仓是真金白银，信号股是盘中焦点——三腿并集就是"值得留明细"的定义。

### 2.2 收口是"观察到的迁移"，不是"算出来的时刻"

日 K 什么时候写？不描 15:00 的墙钟——10s 小步巡检 `marketPhase(market.clock())`，观察到 open→closed 的迁移才收口（watch 状态机同款纪律，时钟跳变/注入钟天然稳健）。由此白送两个行为：

- **晚间重启补收口**：20:00 重启，market.start() 首轮拉到收盘快照，checkClose 发现 closed + 快照同日 + 文件不存在 → 立即补写。"断电重启用昨天的数据文件重启无感"的验收就是这条路径（单测第二例钉死）。
- **幂等闸**：`dailyWrittenDay` 内存标记 + `existsSync` 文件存在双重检查——重复收口不重写，schema 头不重复。

### 2.3 账本纪律的沿用与一处升级

JSONL 追加、坏行跳过、落盘失败吞不炸（留存是尽力而为面，实时链路不依赖它）——全部沿用 paper-broker 的账本模式。**升级的一处**：schema 版本头。账本没有头（首行 account 是数据），留存层每个文件首行强制 `{"v":1,"schema":...}`，读侧 schema 不符**明确拒读**——§五的老规矩"旧文件 + 新代码 = 可读或明确拒读，不许静默错解"，在数据面第一次落地成通用读入口 `readSchemaJsonl`（回测器将来 import 这个函数，不自己开文件）。

### 2.4 verdicts 事件层：裁决记忆回流的第一个真通道

P1 复盘时挂起的"裁决记忆回流"（P2 降级项）需要一个裁决技能→代码的通道，本章把通道的**代码半边**建好了：`record_verdicts` 工具（字段校验：code 格式/action 四值/confidence 0-1，非法行跳过计数）+ adjudicate SKILL.md 加一节"输出解读前把本批 verdicts 调一次 record_verdicts"。verdict 从此和 signals 一样是**机器可读的事件**——规则晋升的原料面从"人读会话日志"升级为"程序读 verdicts.jsonl"。P2 那半边（watch 读 verdicts 静音同 code）等复跑数据再设计。

### 2.5 顺手件与体量

挂账 #3（账本 CSV 导出）→ `get_trades_csv`（read，数字逐字段 echo 账本，手算用例沿用 s9 的 fee 26/72.2、pnl −5098.2）；paper-broker 顺手抽了 `allFills()` 公共访问器（get_trades 内联扫描退役）。

**体量估算**（验收第三条的记档位，实跑一周后替换为实测）：明细行 ~110B × 50 码 × 2,880 轮/日 ≈ **16MB/日**；日 K 5,900 × ~130B ≈ **0.8MB/日**；事件层忽略不计。周 ≈ 120MB——news-feed 式折叠收口暂时不需要，涨到 GB 级再说。

## 3. 翻车记档

- **服务名 = ctx 严格读键**：DataStoreService 起名 "data-store"（和插件名一致），`ctx.dataStore` 直接炸——market/watch/signals 的惯例是服务名与 ctx 属性同名，插件的档案名可以带连字符，服务名不行。
- **s6 契约测试红得对**：改 adjudicate SKILL.md 让 allowed-tools 深等断言炸了——这正是"改模板的人放松了契约，先红这里"的守门语义；正确动作是把新条款（record_verdicts 入档）一并锚进契约测试，而不是放宽断言。

## 4. 验收对账

| 验收项（plan §四） | 结果 |
|---|---|
| 断电重启用昨天的数据文件重启无感 | ✅ 单测"断电重启"：同根新实例续写事件层不重发头、日K幂等不重写 |
| 换目录 env 一改全通 | ✅ `MINI_STOCKS_DATA_DIR`（config.rootDir > env > 缺省），测试全部走 temp root |
| 一周数据体量记录 | ⏳ 估算记档（16+0.8MB/日），实跑一周后替换实测——跟踪期顺带完成 |
| 回归 | cordis 265/265（s10 +5、s6 契约 +1 条款）/ mock 38 章全绿 / snapshot ch41+ch38 重录（工具表+技能目录变化）、ch42 新录后 37/37 |
