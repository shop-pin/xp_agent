# 11-02 挂机首日检视：静默死亡、收盘链补跑、退出留痕

日期：2026-11-02（周一，SC5 后首个交易日，恢复挂机首日）
性质：检视 + 修复轮。起因：用户"已经填的监控跑完了，你检查一下"。

## 一、当天实况时间线（从日志还原）

| 时间 | 事件 | 证据 |
|---|---|---|
| 09:15 | eltdx 网关不可达 → fail-closed → **自动切 sina 兜底**（switched 闩） | session meta/note `data-degraded`，failCount=3 |
| 09:26 | 挂机起跑（watch-detail 首行 startedAt） | watch-detail/2026-11-02.jsonl 93,073 行 |
| 09:26–10:55 | 信号面/裁决面正常：signals +13,341 条、verdicts +14 条 | events/*.jsonl |
| 10:55:52 | watch-detail 最后一条（盘口轮询行） | jsonl 尾行 at 时间戳 |
| 10:57 | 最后一个 turn 正常 end-turn（58 笔静默处理），**进程随后整体消失** | session 05c09073.jsonl 尾行 + mtime |
| 10:57–17:51 | 无进程、无网关、收盘链无人触发 | tasklist 无 node；7727 无人听 |

对比 10-29 正常挂机：53 turns / 5.5 小时跑到 15:00 收盘自退；今天 60 turns / 1.5 小时即死。

## 二、三个发现

### 发现① 挂机进程 10:57 静默死亡（本次排查主线）

排除法记录：
- **close-out 自退链排除**：`onTurnEnd` 的收口链要求 `awaitingReview=true`，而它只在 close wake（phase 迁移 closed）后置位——今天会话 meta/note 里**没有 close kind**，链从未武装。
- **预算/轮数上限排除**：maxTurns 缺省 null（要 `--max-turns` 显式设置才生效），最后 turn 的 reason 是 `end-turn` 不是 `budget`。
- **数据面失败排除（作为死因）**：market refresh 失败吞不炸（10-31 修复语义）；当时源已是 sina（fallback 本尊），连切兜底都不会发生——断供只解释 watch-detail 10:55:52 停写，解释不了进程消失。
- 会话文件最后一行是完整的 `turn/end`，三个独立定时器（market 5s / watch 30s tick / datastore 10s 巡检）同时沉默 = 事件循环层面死亡。

**根因未能定位**——因为所有优雅退出路径（SIGINT×2、stdin EOF）和崩溃（uncaughtException 默认 stderr 即逝）**全部无痕**。用户确认没关过终端（"应该"语气，不排除误触 Ctrl+C 或窗口失焦断 stdin）。这个"死亡无痕"本身是真缺陷，本轮修掉（见三）。

**附带事实：sina 源 10:55:52 后断供**。10-29 tdx 全天跑 13,393 条信号 vs 今天 sina 1.5 小时就 13,341 条——sina 全市场轮询 5s/轮的请求密度可能是限流诱因（未证实，挂账）。此前 10-29 是 tdx 撑全天，今天第一天暴露 sina 长跑断供面。

### 发现② 网关又没起（runbook 第一条连两天失守）

10-30 的教训原话是"开盘前先起 eltdx 网关，且别放在会被关的 terminal 里"。今天网关从开盘前就没起来（09:15 degraded 是探测的结论），sina 兜底救了数据面——**兜底机制 10-31 落地后首次实战生效，管道没饿死，这是进步**；但 tdx 源白备了。本轮已重新起网关（7727 → ping/pong 验证）。

### 发现③ 收盘链产物缺失

进程 10:57 死 → 15:00 收盘无人触发收口 → daily-k/2026-11-02 与 digest/2026-11-02 双缺。**本轮补跑成功**（见三）。SC 验收清单①（digest §八选股行）今天只能算"半验"：§八节存在且正确显示"今日无选股产出"（autoRun 关 + 无 screeners.json = 预期文案），但 screener-run 本体没跑过收口链。

## 三、本轮修复（两件）

### 修复① 补收口：`my_src/closeout-repair.mjs`（一次性修复脚本，零 LLM）

路径：盘后拉一轮收盘快照（`market.start()` 语义本就是"休市也拉——收盘快照可用"）→ `dataStore.checkClose()` 走晚间重启补写路径 → 校验落盘。
实测：5576 只全市场 → `daily-k/2026-11-02.jsonl`（719KB，schema 头 count=5576）→ `digest-run --day 2026-11-02` 编译成功。
**诚实边界**：日K收口是完整收盘数据（盘后快照=全天收盘状态）；但盘中信号面只有 09:26–10:55 段（11:00–15:00 缺失），今天的 digest §二/§三/§四的对账样本偏半天。

### 修复② 退出留痕（agent.ts `noteShutdown` + crash recorder）

此前死亡无痕的三个面，全部补上落盘记录（`meta/note key:"host" value:{kind:"shutdown",how,...}`，直写会话文件绕过 SessionLog 生命周期——close 后 listeners 已摘，exit 钩子里走服务不可靠）：

| 退出方式 | how | 挂点 |
|---|---|---|
| Ctrl+C 两连 | `sigint` | cli.ts REPL handleInterrupt |
| stdin EOF / 终端断开 | `stdin-eof` | cli.ts rl.on("close") |
| web 模式 SIGINT | `sigint` | cli.ts web 分支 |
| 顶层崩溃 | `uncaught-exception` / `unhandled-rejection` | agent.ts 构造时挂 process 钩子（模块级守卫防多实例重复挂；记录后显式 exit(1) 保持 Node 默认语义——挂 listener 会抑制默认退出，必须手动补） |

**覆盖不到的**：直接关终端窗口/强杀进程（Windows 上无钩子可挂）仍无痕——要覆盖它得靠外部守护（PID 文件+巡检），属另一层，未做。

回归：cordis 378/378 + snapshot 40/40 + mock ch38（crash recorder 挂 process listeners 对测试进程无影响——无场景依赖崩溃默认行为，grep 证实）。

## 四、今天的裁决面值得记一笔（好的一面）

14 条 verdict 全 avoid/watch、零下单。三个机制首次实战显形：
- **信号死活现场判定**：09:36 金安国纪 book-pressure/down，4 分钟内现场 +5%，裁决标"信号已证伪，不追认"。
- **复核推翻**：09:42 光启技术复核把主力净流出 -1272万→-1810万 的恶化坐实，信心 0.55→0.6 维持 avoid。
- **learnings 进裁决（#9(b) 昨日落地，今日即用）**：裁决文本引用"10-22 掌阅科技同构先例"压 breakout 低基数信号、"10-30 金安国纪教训"做板块面警报。

digest 自动旗标里有一条金色证据：**`limit-approach(down) T+1 均 -3.75% / 胜率 24.39%`（全规则最差）**——距跌停极近的票次日平均继续大跌（弱势延续效应），= "不接飞刀/不抄贴跌停票"的第一条量化证据，进 learnings 候选面（周协议处理）。

## 五、遗留与挂账

1. **静默死亡根因未定位**——留痕是观测性修复，下一次死亡（若有）会留下 `shutdown` note 定位。若下次 note 显示 `sigint`/`stdin-eof`，则是人因；显示 `uncaught-exception` 则拿栈追代码。
2. **sina 长跑断供面（新挂账）**：10:55:52 后 snapshot 停写，未查根因（限流？接口变更？）。若坐实，tdx 网关稳定性的优先级要上调——备源不能是唯一能打的。
3. **挂机 runbook 再增补**：除"先起网关、别放会关的 terminal"外，加第三条——挂机进程的 terminal 输出重定向到文件（如 `node dist/cli.js --profile stock-tdx 2>&1 | tee watch-YYYYMMDD.log`），崩溃栈不再即逝。
4. screeners.json 待用户填（SC 验收清单②：无效命中公式先 `enabled:false`；③：看一周再决定 autoRun）。

## 六、commit message（my_src 侧）

`add shutdown notes on exit paths and crash recorder for silent death forensics`
（连同 closeout-repair.mjs 一起的话：`add shutdown notes and closeout repair script for watch session forensics`）
