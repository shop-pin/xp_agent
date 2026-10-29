# 收盘收口链——复盘 turn 自退 + digest 钩子（2026-10-29）

> **本章做了什么**：修"收盘复盘 turn 两天断尾"的运营缺陷（方案 C，用户拍板）。
> 新链路：close wake 的复盘 turn 结束 → 自动跑 `digest-run` 编译当日 digest →
> 会话优雅自退。开关 = `watch.closeOutAfterReview`（默认关，交互会话行为不变）。
> 回归：cordis 298/298（+3 新锚）、snapshot 40/40、mock 冒烟过。

## 1. 问题与诊断

10-22 与 10-29 两个全天盯盘会话，收盘复盘 turn 都没跑成：

- 10-22：`close note → wake 投递 → turn/start` 之后转录戛然而止（turn 刚启动进程被关）
- 10-29：close note 是最后一条，连投递痕迹都没有（inbox 是内存信箱，落盘在 driver 取件时）

诊断结论：**wake 机制本身没坏**（10-22 有完整投递证据），两天都是 15:00 整进程被
外部终止（代码里没有收盘退出路径；退出只有 exit/quit、stdin EOF、双 Ctrl+C 三条
人为通道）。结构性矛盾 = **复盘 turn 恰好排在进程最可能被关掉的时刻之后**；
且 digest 文件是零 LLM 的 `digest-run` CLI 的产物，收盘后没有任何调用方。

## 2. 方案 C 设计：把收尾搬进进程自己的生命周期

```
15:00 相位迁移（tick 观察到 closed）
  → close wake（/review 复盘 turn）            ——原有，不变
  → turn 结束（agent/turn-end，仍处 closed）
  → 🌙 收口钩：spawn node dist/backtest/digest-run.js（零 LLM）
  → 👋 AppHost.requestExit → agent.close()（断 MCP 子进程/定时器）→ process.exit(0)
```

四层改动：

| 层 | 文件 | 内容 |
|---|---|---|
| 策略 | `plugins/strategy.ts` | `watch.closeOutAfterReview`（默认 false）+ 一页纸第六节 |
| 编排 | `plugins/market-watch.ts` | `awaitingReview` 闩 + `onTurnEnd()`（close wake 后的第一个 turn-end 且仍 closed 触发）；`closeOut` 缺省 spawnDigestRun（失败静默，不阻断自退）；`exit` 缺省无 = 只收口不退 |
| 宿主 | `agent.ts` + `cordis.config.ts` | `Agent.requestExit()`（复用 cli 双 SIGINT 收尾先例：先 close 再退，issue #8）→ `AppHost.requestExit?` → stock/web-stock 的 watch 行接入 |
| 锚 | `cordis-tests/s9-watch.test.ts` | 3 锚：默认关不触发；开启后 open 相位不触发、close 后先 digest 后 exit、awaitingReview 闩只一次；digest 抛错仍自退；无宿主只收口 |

**设计取舍**：
- 误触发面 = 收盘后用户手聊的第一个 turn 结束也会命中——挂机场景无此输入，
  交互模式默认关。不在 turn 级别做"这轮是复盘 turn"的精确追踪（引入标记
  穿透 inbox→driver→turn-end 的复杂度，对挂机场景无增益）。
- digest 在自退**之前** await——保证退出时 digest 已落盘；spawn 失败静默
  （digest 可事后手动补跑，`node dist/backtest/digest-run.js`）。
- 多日长驻会话：跨日重置后每天的 close 重新 armed 收口链，逐日生效。

## 3. 挂机 runbook（2026-10-30 起）

一次性开启（已写入 `~/.mini-claude/stocks/strategy.json`）：

```json
{ "watch": { "closeOutAfterReview": true } }
```

每日流程（无人值守）：

```bash
# ① 起网关（数据面）
cd mcp-tdx && .venv/Scripts/python.exe -m eltdx.http_server --port 7727
# ② 起盯盘会话（模型面 .mcp.json 自动挂载）
cd my_src && node dist/cli.js --profile stock-tdx
# 会话里：/watch
# ③ 人可以走开——15:00 收盘：巡检复盘 → digest → 会话自退
# ④ 收盘后随时查看：~/.mini-claude/stocks/data/digest/<day>.md
```

## 4. 翻车记档

- 测试时序：`await this.closeOut()` 之后的断言在微任务里跑——锚里 emit 后
  `settle()`（setTimeout 0）再断言，否则 seq 断言抢跑。
- 装配行变更涟漪：watch 行 config 加 `exit` 后 dump-config 输出会变——
  snapshot 40/40 复跑确认转录面无漂移（快照锚的是请求体不是装配表）。
