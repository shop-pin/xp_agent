# dsh-F2 事件流——/api/stream WebSocket：follow-first 与 seq 补洞

> 对应规格：`dsh-00-ui-plan.md` §3 F2。参照物：dsh session-controller 的 follow 流（**先开 live 推送，再回填历史尾页**）+ 重连语义"尾页补 seq 空洞 + 每代连接发完整投影 baseline"；remote.mux 的帧语义（open/item/end + 心跳）简化成单流。
> 一句话：**拉取（session.events）变推送——每条连接 = 一次全量 baseline + 一根 live 管道；seq 是唯一的对账身份。**

## 1. 产物与边界

**文件**：`plugins/host-webserver.ts`（HostService 增 WebSocketServer + `streams` 连接表 + attach/flush/onFrame/broadcast 四个私有方法；HostConfig 增 `heartbeatMs`）；`package.json`（+`ws`、dev+`@types/ws`）；`cordis-tests/f2-stream.test.ts`（新增 7 条 + WsClient 测试客户端）。

**帧表**（dsh mux 的 open/item/end 语义单流简版）：

| 方向 | 帧 | 语义 |
|---|---|---|
| s→c | `{type:"baseline", lastSeq, events:[{seq,event}...]}` | open——每代连接的完整回填（mini 简化为全量；dsh 是 Turn 对齐尾页） |
| s→c | `{type:"event", seq, event}` | item——live 逐事件推送 |
| s→c | `{type:"heartbeat", lastSeq}` | 心跳，顺带播报进度（可配间隔，0 关闭） |
| s→c | `{type:"resumed", lastSeq}` | resume 回执（回放完成的界碑） |
| s→c | `{type:"error", error}` | 客户端帧非法（连接不断） |
| c→s | `{type:"resume", since}` | 补洞原语——回放 `(since, now]` |

**不变量**：baseline 事件的 seq 连续 `0..lastSeq`；live 帧的 seq 严格递增且都 `> baseline.lastSeq`；任何客户端看到的 seq 序列无洞无重。`session.events?since=` 拉取端点保留（调试与 F6 回放对照），`session.prompt` 语义不动（F3 客户端有流后再换 accepted + 看流）。

## 2. 设计决策记档

1. **follow-first 次序**：`attachStream` 先挂 `log.onAppend`（增量进 pending 缓冲），**再**拍 events 快照发 baseline，最后 flush 缓冲按 seq 去重补发。mini 里订阅与快照都是同步语句、窗口为零——但这是 dsh 的纪律：**F6 回放改成异步读盘后，"先订阅后回填"就是唯一防线**。测试锚行为（断连增量由 baseline 补齐），不锚实现时序。
2. **seq 身份吃 C8 的时序红利**：`SessionLog.append` 先调监听器再 push——监听器里 `log.events.length` 恰是新事件的 seq（D5 投影同款下标身份，不用改日志服务一行）。
3. **resume 不替换 baseline，是对账原语**：fresh 连接本来就拿全量 baseline，resume 服务于"客户端本地已有状态、只想要尾页"（带宽优化 + 状态对账）。回放逐 seq 发送并把 `lastSent` 推进到 now、清空 pending——与 live 管道并发的竞态由 seq 去重兜住。客户端若自认比服务端新（since ≥ now），回放为空——这是"客户端状态腐化"的信号，正确反应是重连拿新 baseline。
4. **心跳 = 单 interval 广播**，不是每连接一个 timer——多客户端共享同一心跳源（"广播"本来就是 F2 验收项）；JSON 帧而非 ws 协议层 ping，为了**应用层可见 + 捎带 lastSeq**；`unref()`——心跳不做进程存活的理由。
5. **upgrade 路径白名单**：同一 server 的 upgrade 通道只认 `/api/stream`，其余 socket 直接 destroy——loopback 也不给陌生协议开口子。
6. **依赖 ws@8**（dsh 同款）。`npm audit` 报的高危在 `glob` 的传递依赖 brace-expansion（ReDoS），与 ws 无关——记档不动依赖。

## 3. 实现与验证记录

**验证**：cordis **154/154**（F2 新增 7 条：baseline+live 无洞 / turn 中连接不重不漏 / kill 重连无洞无重 + resume 精确补洞 / 多客户端广播一致 / 心跳 / 坏帧容错连接存活 / 非 stream upgrade 拒绝；测试走 profile web 全装配链 + ws 客户端）；mock **28 场景全绿**（host 行默认 disabled，零影响）；CLI 冒烟：`--web --port 3199` + 一次性 WS 客户端——baseline(lastSeq=13) → prompt → live(seq 14–18) → `resume(since:0)` 精确回放 1–18 → resumed，全链通过。

## 4. 翻车记档

1. **竞态测试先要消灭自己的竞态**：turn 中连接测试最初 `void api(prompt)` 后直接连 WS——HTTP 请求与 WS 握手的 I/O 次序不定，WS 先到 → baseline 空 → "连接时已有前缀"断言炸。修法：先轮询 `session.events` 确认前缀落日志再连。**被测的缝是 baseline/live 之间的缝，不是 HTTP 与握手之间的缝——测试得先把无关的随机性钉死。**
2. **一次性 ws 冒烟脚本两连败（操作纪律）**：① 脚本放 Temp 目录，CJS `require('ws')` 按**脚本自身路径**解析——找不到 my_src/node_modules；② 日志写 `/tmp/...`，node 在 E: 盘把 `/tmp` 解析成 `E:\tmp`——目录不存在。修法：脚本复制进 my_src 跑、日志相对路径，跑完即删。**跨目录跑一次性脚本：依赖解析看脚本在哪，不看 shell 在哪。**
3. **type-only 导入的类当值用**：`import type { WebSocket }` 后取 `WebSocket.OPEN` 常量报 TS1361——类既是类型又是值，要取静态常量就得整类值导入。
4. **（重演确认）**全程 Edit 工具无 sed——连续三章零手滑。

## 5. 自测三题（答案在文末）

1. follow-first（先订阅后拍快照）在 mini F2 里"窗口为零"，为什么还坚持这个次序？哪一章会让它变成唯一防线？
2. resume 回放与 live 管道并发时如何做到不重不漏？客户端 resume 的 since 比 服务端 now 还新会发生什么？
3. 心跳为什么用 JSON 帧而不是 ws 协议层 ping/pong？各亏什么？

> **答案**：
> 1. mini 里订阅与快照是同一 tick 的同步语句，中间不可能插入 append——窗口为零。但次序是 dsh follow 流的纪律性保险：F6 回放从 JSONL **异步读盘**时，"读盘期间发生的增量"必须靠先挂好的 live 管道缓冲，先读后订就是洞。现在按纪律写 + 行为锚测试，将来换实现不用换不变量。
> 2. 回放按 seq 逐帧发送，完成后 `lastSent` 推进到 now 并清空 pending——pending 里未发的增量都 ≤ now，已包含在回放里，`lastSent` 过滤挡掉一切重复（flush 只发 `> lastSent`）。since ≥ now 时回放为空、`resumed.lastSeq = now-1`：合法协议下客户端不可能有服务端没有的 seq，出现即本地状态腐化——正确反应是断开重连拿全量 baseline，而不是对着空回放困惑。
> 3. JSON 帧：应用层可见（测试/调试能在流里直接看到）、可捎带 lastSeq 做进度播报——教学取可见性。协议层 ping：省字节、浏览器自动回 pong、能在连接假死时靠 pong 超时判死——mini 没做死连接判定，这两个收益暂时用不上；真要做判死，pong 超时才是对的工具，那时再换。

## 6. 下章预告（F3 client 基座）

`webui/` 三件套：`connection.ts`（unary fetch + WS + generation 重连——F2 的帧表在这里第一次被消费）、`store.ts`（React-free observable snapshot + selector + Immer draft，唯一 React 绑定 useSyncExternalStore）、`renderer.tsx`（vite SPA 壳 + root slot，Host serve 其 dist）。起步前置：`npm i react react-dom immer` + dev `vite @vitejs/plugin-react @types/react @types/react-dom`。
