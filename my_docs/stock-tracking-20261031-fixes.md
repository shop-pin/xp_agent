# 调试期修复轮：数据面健康度 + 幽灵估值 + digest 显式日（2026-10-31 开发日）

10-30 空转日暴露的三缺陷一天修完（eltdx 网关死一天零告警 / /review 幽灵估值 / digest 静默重算旧日）。三缺陷同根：**数据面的死相没有被任何一层翻译成人能看见的信号**。

## 缺陷① 数据面健康度 + 自动兜底（主活）

### 病灶
`MarketDataService.refresh()` 的失败在 `start()` 里被 `.catch(() => {})` 吞掉（进程不死的代价是零声响）。10-30 网关全天不可达 → stock-tdx fail-closed → 快照管道饿死 → 0 信号、无 watch-detail、无 daily-k 收口，002636 从 -2.6% 拉到涨停全程没看见。

### 修复设计（market-data.ts）
- **健康度观察面**：连续失败计数 `failCount` / 最近错误 `lastError` / 最近成功时刻 `lastOkAt`，`market.health` 只读 getter——工具、编排、人查同一张表。
- **降级判定**：连续失败 ≥3 轮（默认轮询 5s → 约 15s）= degraded。为什么是 3 不是 1：单轮失败是网络抖动的常态，3 轮（15s 连续黑）才值得惊动人。
- **自动兜底**：`MarketConfig.fallback` 注入兜底源。达阈值时**当轮切换并立即重试**——管道不饿到下一轮询。切换后**不自动切回**：防主源半死不活时的反复横跳；挂机工作流日结进程每日重启，重置即切回，不需要更多机制。
- **告警通道**：首次降级发 `market/degraded` 事件（带 source/fallback/switched/error/failCount），UI error 限频每 30 分钟重复一次（挂机场景没人盯终端，日志里要持续喊）。
- **fail-closed 仍有声**：无兜底时事件 `switched=false` 照发——断供不再静默。
- **装配**：stock-tdx 显式配 `fallback: sinaSource`（cordis.config.ts）；stock profile 插件层缺省配 eastmoney 备源（显式注入 source 的装配不自作主张——测试 mock 不受影响）。
- **watch 联动**：订阅 degraded 事件记 `meta/note(kind:"data-degraded")` 进 SessionLog——**不唤醒 LLM turn**（断供无裁决可做，省 token 纪律），盘后追责有日志可查。

### 语义边界（记档）
兜底接管期数据口径漂移（TDX→新浪：估值字段 0=未知、无五档）——这是"有数据带注记"换"没数据无告警"的取舍，10-30 的教训站在前者一侧。池工具估值过滤兜底期同样退化，与 TDX 源常态一致。

## 缺陷② /review 幽灵估值

### 病灶
`get_portfolio` 的估值 `q?.price ?? 0`——缓存空按 0 元算 → "600000 市值 0 盈亏 -100%"。/review 技能数字全部来自工具输出，幽灵数字直接进复盘正文和 memory 持仓快照，污染下一轮裁决上下文。

### 修复（paper-broker.ts）
无行情行显示 `市值—（无行情，未计值）`，不显示浮盈；总市值只累有行情部分，header 注明 `（N 只无行情未计值）`。原则：**缺数据要显式缺，不许伪装成一个数**（0 也是个数）。

## 缺陷③ digest 静默重算旧日

### 病灶两半
watch 的 `spawnDigestRun` 不带 `--day`，且 `stdio: "ignore"` + error/close 全静默；digest-run 缺省取最新日K收口日——今日断供时静默把昨日 digest 重算一遍，"今日 digest 缺席"这个事实本身无告警。

### 修复（market-watch.ts + digest-run.ts）
- `closeOut(day)` 签名带收口日，spawn 显式 `--day`；stderr 捕获、非零退出 reject——digest 挂掉在收口链 catch 里喊出声。收口链本身仍不阻断自退（digest 可事后手动补跑）。
- digest-run 诚实语义：**显式 `--day` 该日无收口 → 明确报错 exit 1**（"指定日无 daily-k 收口——不静默重算旧日"）；缺省不带 `--day` 的手动补跑路径行为不变。
- 真机冒烟：`--day 2026-10-31`（周六无收口）exit 1 带人话；`--day 2026-10-29` 正常编译；缺省路径正常。

## 翻车记档

1. **`npx tsc --noEmit` 不产 dist，回归全白跑**：第一轮"全绿"（cordis 298/298 = 旧全量数、digest-run 旧语义、dump 无 fallback）跑的全是旧编译产物——298 这个数字本身就是破绽（新增 4 测试应为 302）。教训：本仓验证 = `npx tsc`（emit）→ 测试；`--noEmit` 只当类型检查用，**数字对不上基线先疑产物陈旧**。
2. **旧产物顺手写出了幽灵 digest**：digest-run 旧语义把 `--day 2026-10-31` 静默编译成文件——正是缺陷③的活体演示，删档。
3. **snapshot replay 偶发红一波三折**：重录后第一轮 39/40 复跑自愈；组合压测（mock 章循环后紧接 snapshot）3 轮内再现一次——ch37 `requests: line count 2 != 0`。抓根因：**actual 0 requests = 探针的 `agent.chat()` 抛错被 runs 循环 try-catch 吞掉**（设计如此——单 run crash 不中断后续 verify），触发条件 = 连环子进程高负载下回环 TCP/时序抖动突破探针的 50ms 竞速窗。**与本次改动正交**：ch37 只装配 market+signals（无 watch/broker/digest-run），market-data 改动在该场景全部行为差异 = health 字段纯内存维护。处置：单场景复跑绿即放行（12+20+2 连绿）；探针加固（chat 兜错显式化）挂账不在本轮修。

## 回归基线

- cordis **302/302**（+4：健康度兜底×2 / 幽灵估值 / degraded 注记）
- mock 28 章全绿（退出码判定，新 dist 复跑）
- snapshot **40/40**（ch34/39–44 重录：get_portfolio 描述等文案漂移，重录 diff 核对干净——仅 meta 时间戳 + 7 场景描述行）
- digest-run CLI 真机三态冒烟（显式有收口/显式无收口/缺省）

## 自测题

1. 为什么降级切换后不自动切回主源？如果要求"网关恢复后 5 分钟内自动切回"，需要补什么机制才不踩抖动坑？
2. get_portfolio 的总资产在"有持仓但全无行情"时会报多少？这个数字对 LLM 复盘有什么误导风险，修复后靠什么防？
3. digest-run 为什么只有显式 `--day` 才校验收口文件存在，缺省路径不校验？

## 建议 commit

```
add market health fallback with honest portfolio and digest day gating
```
