# dsh-F4 会话装配——事件注册表、通用工具卡、composer 的 accepted 语义

> 对应规格：`dsh-00-ui-plan.md` §3 F4。参照物：dsh `ui-conversation` 双注册表（事件 → Node、Node → 视图）+ `ui-tool` 的"wire 名注册、Runtime 配对"分工。
> 一句话：**UI 是日志的第二个投影——装配器把原始事件流折成 Nodes，presentation 只认 Node 数据；忙闲不轮询，界碑就在事件流里。**

## 1. 产物与边界

| 文件 | 层 | 变化 |
|---|---|---|
| `webui/conversation.ts` | 装配（新） | React-free、零依赖：`WireEvent`（SessionEvent 结构副本，客户端自有类型）→ `ConversationNode` 七型的纯 fold |
| `webui/views.tsx` | presentation（新） | 双注册表的第二张：nodeKind → 组件；`toolViews` wire 名注册表（空表起步 + 通用卡兜底 + `registerToolView` 扩展缝） |
| `webui/app-state.ts` | model | +`pendingPrompt`/`lastError`；界碑 fold 进写集（appendEvent/setBaseline 共用 `reconcilePending`） |
| `webui/app.tsx` | 壳 | 空壳 → 真装配：`assembleConversation` 挂 events 引用（useMemo）、composer（busy 禁用 + Enter 发送 + 错误行）、滚底 |
| `webui/main.tsx` | 装配 | +`sendText` action：`beginPrompt()` → `session.prompt` → RpcError 时 `failPrompt` |
| `plugins/host-webserver.ts` | Host | `session.prompt` 换 **accepted 语义**（send 不 await）；桥拒绝补 `meta/note`(prompt-error) |
| `webui/index.html` | 样式 | 气泡/工具卡/injection 折叠/turn 分隔线 |

**Node 七型**：`turn`（分隔线 + endReason 回填）/ `user` / `injection`（system-reminder 体）/ `assistant`（text 块 + usage）/ `tool`（callId 配对 + result）/ `orphan-result`（无主结果）/ `error`（prompt-error）。key 全部用 seq——D5/F2 同款身份在 React 的 diff 里继续当锚。

## 2. 设计决策记档

1. **UI = 原始日志视图，不跟投影**：`message/replace`、`history/truncate` 不渲染——压缩改写的是请求视图，不该改写用户已看见的历史。dsh surface 从 tool 事件重组出投影视图，口径差异记档（mini 的对话窗 = 真相，请求组装 = derive 另算）。
2. **双记事件只渲染一份**：tool 卡从 `tool/call` + `tool/result` 注记装配（id ↔ callId 配对，孤儿结果独立成行不静默）；user 消息里的 `tool_result` 宿主块（D5 批次）跳过——否则每个工具轮都多一条假"user 气泡"。E1 终端同款口径。
3. **system-reminder 拆 injection 节点**：环境 reminder（ch2）、技能目录（D1）、记忆召回（D4）都是"机制对用户说的话"，不冒充用户。一条消息可带多条 reminder（场景 9 首条 = env + catalog 两条），splitter 逐条拆、之间的正文归 user。
4. **accepted + 界碑 busy（F1 记档的脚手架退役）**：`session.prompt` 立即回 `{accepted:true}`；客户端 `busy = session.busy || pendingPrompt`。pendingPrompt 两个解除界碑——`turn/end`（正常结算 + abort 补注）与 `meta/note`(prompt-error)（桥拒绝，turn 根本没跑起来）。重连对账：`setBaseline` 末事件已是界碑则解挂，O(1) 不扫全量。
5. **prompt-error 是会话事实，走日志不走帧**：非 abort 失败从 `send` 直接抛、引擎不落 turn/end（`runDriver` 的 catch 只给 abort 补注记）——accepted 语义下客户端会吊死在 busy。Host 在桥的 `.catch` 里补 `meta/note` 进日志：重放/回放都看得见（F6 红利），在场客户端借事件流即时解除 busy。引擎外插件追加事件在 D5 有先例，不算开洞。
6. **纯工具轮不出 assistant 气泡**：assistant/message 只有 tool_use 块时跳过——卡片已讲完故事，usage 也跟随有文本的消息（口径记档）。
7. **token 级流式不做（记档）**：`emitText` 的增量走叙事面（ctx.ui），日志只有整条 `assistant/message`。web 的"增量渲染" = live 帧逐事件长出会话（turn 分隔线、tool 卡逐张出现）。真流式需要叙事面通道（dsh surfaceOp 同款），性价比低，不抄。

## 3. 实现与验证记录

**验证**：cordis **168/168**（f4 新增 7 条：fold 单元 ×3（reminder 拆分与连续 user 不合并 / tool 配对与孤儿 / 投影事件不渲染）+ store 界碑（含 baseline 对账）+ http 驱动场景 9 同款 + busy 竞态 + prompt-error 兜底）；mock **28 场景全绿**（零断言变更）；vite build 239KB / gzip 75.5KB；`--web` echo 冒烟：SPA 200、`session.prompt` 回 accepted、拉取事件尾为 turn/end、echo 回复在流里。

**http 驱动（新增的测试形态）**：`startMock` 进程内起 → `ANTHROPIC_BASE_URL` 指过去 → `Agent({profile:'web'})` → WS 客户端收流 → `assembleConversation` 断言 Nodes。mock 驱动从"直调 agent"（run-mock 子进程）升级出"http 驱动"一条——Host、accepted、流、装配全链在测。

**手测清单**（浏览器面，用户跑）：`npm run webui && node dist/cli.js --web --port 3080`（真模型需 ANTHROPIC_API_KEY；echo 冒烟加 `MINI_CLAUDE_LLM_ROUTE=echo`）→ 开 `http://127.0.0.1:3080`：
1. 头部绿点 live，composer 可输入；
2. 发一条消息 → user 气泡即现 + 输入框禁用（占位"turn 进行中…"）→ turn 分隔线/回复逐个长出 → composer 解禁；
3. 工作目录放 `.claude/skills/commit/SKILL.md` 再新会话 → 首条消息下"system 注入"折叠点开可见技能目录；
4. 让模型 `write_file` → 通用工具卡：黄点"运行中"→ 绿点"完成"，input/result 折叠展开；
5. Ctrl+C 断 Host → 黄点 reconnecting → 重启 → 绿点回来、历史完整重现、busy 不吊死；
6. （echo 路由下把 mock 弄挂较难，可跳）真模型下断网发消息 → 红色错误行 + composer 解禁（prompt-error 界碑）。

## 4. 翻车记档

1. **"等更多 X"写成了"找第一个 X"的死循环**：`waitTurnEnds` 用 `waitFor` 循环计数——`waitFor` 每次从帧序头扫描，第 2 轮起永远命中同一帧旧 turn/end，循环体永不等阻塞，微任务自旋把事件循环整个饿死（进程"卡住"其实是在烧 CPU）。**等待原语要订阅增量（cursor/计数监听），谓词查找只该消费一次。**
2. **`startMock` 返回 Promise，忘了 await**：`mock.url` = undefined → SDK 报 Invalid URL；`mock.close` 不是函数在 finally 里又把真错误顶掉。工厂函数返回 Promise 是常态——**返回值链上每个使用点都要核 await；finally 里抛错会吞掉原始异常，排障时先看 finally。**
3. **mock 的 `server.close` 吊死进程**：SDK fetch 的 keep-alive 空闲连接不主动断，`server.close` 回调等到天荒地老。run-mock 从不 close（进程直接退）所以从未暴露——**"只在进程退出前调用"的 API，被进程内复用时才露馅**。`closeAllConnections() + close()` 修复（node 18+ 标准姿势）。
4. **断言对着记忆写，三连改**：injection 期望 1 条实际 2 条（忘了首条消息还有环境 reminder）、Unknown skill 期望 isError=true 实际 false（引擎语义：未知技能是**正常返回**的 tool_result，模型读了自行纠正，throw 才标 error）、endReason 期望 `tool_use` 实际 `tool-use`（引擎有自己的 kebab 词表，不是 mock 的 snake）。**http 驱动的断言要对着引擎事实写——先打印真实事件流再落断言，比按 mock 场景的记忆猜快三倍。**

## 5. 自测三题（答案在文末）

1. `conversation.ts` 为什么用结构副本 `WireEvent` 而不 `import type { SessionEvent }`（type-only 擦除后零运行时成本）？
2. `pendingPrompt` 为什么进 store 写集而不是组件 `useState`？`setBaseline` 的对账为什么只看末事件就够？
3. prompt-error 为什么补 `meta/note` 进日志，而不是让 Host 直接广播一个 `error` 帧？

> **答案**：
> 1. 客户端自有类型（dsh client 同款）：wire 是 JSON，装配器只消费字段子集。`import type` 确实零运行时成本，但源码依赖方向会让"客户端可独立于引擎演化"从结构保证退化成自觉——webui 是要教分层的，分层红线靠 import 图不靠纪律。副本只写装配消费的字段，还顺带当了 wire 契约的文档。
> 2. 忙闲是"事件到达驱动的状态迁移"，写集是它的家：界碑规则可读、可独立单测（store 测试 4 个动作覆盖全部分支），且重连 baseline 整体替换时组件 useState 必然失同步（旧 pending 对着新世界）。对账只看末事件：baseline 是全量投影，"末事件是界碑" ⟺ 挂起期间 turn 已经收敛；mid-turn 的 tool/call 等非界碑末事件保持挂起——O(1) 且与 live 路径共用同一个 `reconcilePending`，不会长出两套判据。
> 3. 帧 = 传输层语义，日志 = 会话事实。失败的 prompt 是会话事实：走日志，F6 的历史回放天然携带、JSONL 落盘、derive 不受影响（meta 是注记）；走 error 帧只有"在场客户端"看得见，断线重连的客户端永远丢了这段历史，而且 `error` 帧的既有语义是"坏帧应答"，为业务失败复用会让客户端在传输层分支业务错误——F1 自测题 3 的语义/寻址分工在流方向的镜像。

## 6. 下章预告（F5 交互跨端）

approval/request 作 Remote 瀑布转发（Host 事件 → 浏览器接管 → 决策回传作答；超时/断线 fail-closed）+ `commands.list` RPC + `/` 补全 + plan 四选项审批卡。危险点：C2 的瀑布语义不能在传输层翻案——远程作答 = 注册一个 answerer listener，不是绕过瀑布。
