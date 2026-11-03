# 调试讲解 · 2026-11-03 挂机第二轮：首单卡死 + 收口链三处补强 + 选股数据防线

一天查出四个独立缺陷，全部同根：**无人值守这条线以前只被"零下单"侥幸掩护着**。

## 一、13:09 place_order 卡死（主犯）

现场：会话 27 个 tool/call 对 26 个 tool/result，孤儿单是 13:09 的
`place_order sz002302 buy 100@4.57`；paper-ledger 无新 fill；此后 2 小时信号注记照写
（tick 链独立于 turn 驱动）、15:00 close wake 只进了 inbox 没跑 turn。

根因链：
- place_order 是 `permissionHint: "exec"` → auto 模式下进 D6 分类器（两段式 LLM 裁决）
- 分类器对"下单"这类动作判了 confirm → `autoFallback` 查 `hasInteractiveProvider()`——
  REPL 会话有人机通道 → 落 "ask" → **readline "Allow? (y/n)" 等键盘**
- 没人在家 → turn 永不收敛 → driver 永忙 → 后续所有 wake（含收盘收口）排队到天荒地老

关键认知：default 模式下 place_order 本来就走九段兜底放行（⑨），**只有 --auto 模式会卡**——
分类器的存在反而制造了交互等待。教训：无人值守路径上任何"等人"的分支都是死等。

修法（语义收窄，不是开大洞）：新增权限类 `"trade"`——
- `services/tools.ts`：PermissionHint 加 `"trade"`（模拟盘交易面）
- `plugins/paper-broker.ts`：place_order 改 `"trade"`
- `plugins/auto-approval.ts`：trade hint 直通 allow（分类器不惊动）
- TradeGuard 在 pre-execute 瀑布**最外层**、deny 是终局——代码级风控一条不少；
  实盘 broker（S15）不得声明此 hint（注释里钉死）

锚：c2-approval 新增"trade hint 跳过分类器直通"（分类器脚本故意给 block，
calls()===0 证明真直通）；s7 的 hint 锚同步改。

## 二、盘中启动次序（信号抢跑）

实录：13:00 会话第一条 turn 是信号唤醒，开盘巡检 wake 迟到 4 个 turn（line 21 注记、
line 36 才成 turn）。原因：**巡检是 tick 驱动、信号是快照事件驱动**，盘中 /watch 时
第一轮快照先到，`onSignal → flush` 直接开叫。

修法：`flush()` 加一道 `if (!this.patrolled) return;`——巡检未做，信号只攒信箱。
evaluate 的巡检轮同一 tick 兜底出账，顺序恒为 巡检 wake → 信号 wake。
锚：s9 新增"午休 armed → 盘后信号先到不叫醒 → evaluate 后 open 在前"。

## 三、收口链两处

1. **screenerSummary 改全量打印**（用户需求）：原来内置公式只打计数、自定义打明细
   cap 200——现在每条公式打全部命中（代码+名称+收盘），头行保留计数。
2. **defaultCloseOut 顺序翻转：选股先行**。旧序 digest→screener，digest §八读
   screener/<day>.jsonl——autoRun 当天 §八永远缺当日行（SC5 验收①在自动链下
   结构性落空，昨天全靠手工夜跑的旧文件撑着）。新序选股→digest；选股失败不阻断
   digest（复盘基础产物保住），错误最后再 reject 保持"catch 喊出声"语义。
   sc5 两个锚同步翻转。

## 四、选股数据防线（今晚实战抓出来的）

现象：今晚补跑选股，FLZT 命中 0（昨天 40）。追凶三层：

1. 今天的 daily-k 在 15:00 由挂机会话的 data-store 自动收口写入——用的盘中快照；
2. 今天网关是好的（会话零 degraded 注记）→ 快照全程走 eltdx TDX 源，
   而 **TDX 快照没有换手率字段**（market-data-tdx.ts 恒 0）→ daily-k `to` 全 0；
3. FLZT 的 CAPITAL/FINANCE(7) 市值股本是**从当日换手率反推**的（2026-11-02 轮的
   设计）→ to=0 → 反推废 → 闸全关 → 0 命中。昨晚修复脚本之所以拿到真实 to，
   是因为昨天会话 10:57 死了、没人写盘，晚上的补跑才用 sina 快照（带换手率）重写。
   今晚我的补跑被 `writeDailyK` 的 existsSync 幂等挡住，保留了毒文件。

处理：
- 数据面：删当日 daily-k → 重跑 repair（sina 收盘快照，to 恢复真实值）→ 重跑选股
  → FLZT 恢复 9 只（昨日 40 是传媒涨停潮，今日退潮，数量级合理）
- 代码面：screener-run 加数据防线——目标日 bar 换手率全零占比 >90% 时，
  md 头部 + stdout 喊出声"命中清单不可信"，不再静默产出 0 命中

挂账（未修）：TDX 源收盘日的自动链仍会写出 to=0 的 daily-k（防线只报警不治本）。
候选修法：FINANCE 反推时退化用序列里最近一根带换手率的 bar 反推流通股本
（股本日间变动极少，昨日 vol/to 即可）——下个开发窗口做，要配测试锚。

## 五、盘后精选 + 明日交易计划（2026-11-03 晚追加）

用户需求：收盘链打印完全量命中后，还要在这些票里做**精选**，并给出**明日交易计划**。
精选方法日后由用户的教程文档（Word/龙头战法体系）接管——现在先用默认规则：
盘面强度 + 板块联动 + 当日消息（latest_news）+ digest §三/§六/§七 + get_learnings。

实现：
- `strategy.watch.postCloseRefine`（默认 false 零漂移；用户 strategy.json 已开 true）
- 收口链顺序变为：复盘 turn → 选股 → digest → 全量打印 → **refine turn（新增）** → 自退
  ——自退从"复盘 turn 结束"推迟到"精选 turn 结束"（`awaitingExit` 闩，只退一次）
- `prompts.refine(pool, day)`：pool = 自定义公式命中池全量文本（cap 50 行，内置公式
  只在报告文件里留给 turn 自行 read_file）；空池=当日无选股产物，直接按盘面给计划
- 精选 turn 的最后输出直接进终端（精选清单 2–5 只：理由/风险/关注位 + 明日计划：
  持仓处理/开仓方向/仓位上限/风控纪律）

锚：s9 新增"refine wake 先于自退、awaitingExit 只退一次"；sc5 加 postCloseRefine
缺省 false 断言。回归 cordis 396/396 + snapshot 40/40。

## 回归

cordis 396/396（+3 新锚）· snapshot 40/40 · mock ch26（auto 分类器章）。
真数据：daily-k 5577 只（sina，to 真实）· 选股宇宙 5024 · FLZT 9 只 · digest §七/§八齐全。

## 明日（11-04）挂机预期能跑通的全链

起网关（可选）→ /watch --auto → 开盘巡检（盘中启动也不再抢跑）→ 信号/裁决/
place_order 直通下单（guard 把关）→ 收盘 close wake → /review → 选股 → digest
（§八有当日行）→ 终端打印全量命中 → 盘后精选 + 明日交易计划 → 自退。

**明日验证点（用户点名）**：下单功能——盘中裁决触发 place_order 后，
`get_trades` 应出现成交行、paper-ledger 有 fill、guard 拒单（价带/漂移/资金）
会以 "Rejected: ..." 出现在转录里，三种结果都算链路正常。
