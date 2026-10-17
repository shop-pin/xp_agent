# dsh-F5 交互跨端——审批瀑布的远程 answerer、叙事面转发、斜杠命令面

> 对应规格：`dsh-00-ui-plan.md` §3 F5。参照物：dsh `ui-approval` 的 `ctx.remote.$on('approval/request')`（浏览器接管作答）+ `ui-commands` 四种 dispatch + `ui-plan`。
> 一句话：**三端同缝，只有 answerer 不同——web 不绕过 C2 瀑布，它只是注册了另一个作答人。**

## 1. 产物与边界

| 文件 | 层 | 变化 |
|---|---|---|
| `plugins/host-webserver.ts` | Host | 审批/plan/命令三个 RPC 面（`approval.decide`/`plan.decide`/`commands.list`/`commands.dispatch`）+ 帧表三增（`approval`/`approval-resolved`/`narrative`）+ 在途交互注册表（fail-closed 三连）+ 构造期自注册 interactive provider + tee 渲染器（叙事面转发）+ **清史重开基线（rebaseline，抓到 F2×C5 组合 bug）** |
| `services/commands.ts` | 服务 | +`handles(input)`：同步路由判定（fire-and-forget 分发的先决件，与 dispatch 同一套切词） |
| `cli.ts` | 入口 | `--web` 分支接线 `setPlanApprovalFn → host.requestPlanApproval`（REPL 分支两条 readline 接线的镜像） |
| `webui/connection.ts` | 传输 | StreamSink 三动作增（narrative/announceApproval/resolveApproval）；帧 switch 三 case |
| `webui/app-state.ts` | model | +`pendingApproval`/`narrative`（有界 100）/`commands`；baseline 新代清空瞬态 |
| `webui/main.tsx` | 装配 | +decide×2（乐观摘卡）/dispatchCommand（未认领透传模型）+ boot 拉 commands.list |
| `webui/app.tsx` | 壳 | `/` 补全弹窗（子串模糊 + 前缀优先，Tab/点击）+ 斜杠分流 + 审批卡挂载 + 叙事条 |
| `webui/views.tsx` | presentation | ApprovalCard：tool 双选项（message + input 折叠）/ plan 四选项（选项 4 展开反馈输入） |
| `webui/index.html` | 样式 | 审批卡/补全弹窗/叙事条 |

**引擎一行未改**（agent.ts / approval 插件 / tools 服务原样）——服务层只有 commands.ts 加一个查询方法。

## 2. 设计决策记档

1. **远程作答 = 换 answerer，不换瀑布（本章危险点的落法）**：Host 插件构造期把 `ApprovalService.setInteractiveProvider` 换成远程转发器——九段流水线（approval 插件）一行不动，`ask` 裁决照旧上浮到 provider，只是"谁作答"变成浏览器。deny 话术由 tools 服务的 ask 分支统一产出（`"User denied this action."`），Host 无亲手文案——测试逐字节断言。次序语义：REPL 若同时在（`--profile web` 不带 `--web` 的混合形态），cli 稍后的 `setConfirmFn` 覆盖这里——**最后接线者生效**，与 fallback provider 的既有次序同款。
2. **审批请求是瞬态帧，裁决事实才落日志**：`approval` 帧不进 session-log（asked 不是会话事实——可能没人答）；重连可见性由 **baseline 后重宣告**补偿（pending 是 Host 活状态，每代连接重新广播）。`decided` 落 `meta/note(key:approval, value:{id,kind,tool,verdict,by})`——裁决改变引擎行为走向，F6 回放可考"谁在哪端怎么裁的"（dsh "asked/decided 入日志"的 mini 裁剪：只记 decided）。与 F4 prompt-error 的分工同一把尺子：** settled 的事实走日志，在途的状态走帧**。
3. **fail-closed 三连 + 首个生效**：无客户端连着 → ask 即 deny（`no-client`）；最后一位浏览器断线 → 在途审批立刻 deny（`disconnect`，不等超时）；挂起超时 → deny（`timeout`，默认 120s，`MINI_WEB_APPROVAL_TIMEOUT_MS` 可调，0 关闭）。decide RPC 首个生效：pending Map 摘除后迟到者按"no pending"信封报错——瀑布天然串行（ask 阻塞着 turn），不需要幂等令牌。收口（dispose）也 fail-closed：挂着未决审批关机会吊死等待方的 turn fiber。
4. **plan 审批同管线、独立 RPC**：四选项（clear-and-execute/execute/manual-execute/keep-planning+feedback）不是 allow/deny，硬塞一个接口会丢词表校验——`plan.decide` 单独校验 choice 枚举、feedback 空串归 undefined（与终端选项 4 同款）。接线位置：plan 审批回调活在 Agent 宿主层（`setPlanApprovalFn` 不在树内），由 cli `--web` 分支接到 `host.requestPlanApproval`——**入口层决定 answerer**，与 REPL 分支互为镜像。`PlanChoice` 在 host 侧定义结构副本（agent 的内联类型不外导），两处词表靠类型同形对齐，注释标明"不许漂移"。
5. **叙事面 = 瞬态帧，不回放**：tee 渲染器（控制台照旧 + info/error/cost 加播 `narrative` 帧）。`toolCall`/`text` **不转发**——消息面事实在日志里，浏览器由装配器渲染，转发即双份；spinner/subagent 横幅是终端形态不转发；`confirmation` 在 web 档不可达（interactive 已被换成远程转发器）。叙事不进日志：旁白没有会话语义，重放不该改变你看见的历史（dsh surfaceOp 的全面事件化差距记档）。cost 帧口径与 `ui.printCost` 同公式（printCost 直印拿不到串，复制一份并注释耦合）。
6. **commands.dispatch fire-and-forget**：`handles()` 同步判定路由 → `{handled}` 立回；`run` 异步不吊 RPC——`/goal` `/loop` 长驻命令不能占死一元调用。输出与错误都走叙事面（runGuarded / dispatch 的 catch → ui.error → 帧）。`handled:false` 由客户端透传给模型（终端同款：没人认的斜杠就是普通文本）。已知限记档：goal/loop 期间的 busy 不上屏（`session.busy` 快照不推送——F6 投影的正戏）。
7. **清史重开基线（rebaseline，本章最大发现）**：C5 的 clear-and-execute 是**物理清史**（`sessionLog.clear()`，events 数组清空、seq 归零重启），而 F2 的补发管道按 `seq <= lastSent` 去重——清史后所有新事件 seq 都小于旧 lastSent，**全部被当重复帧丢弃，直连客户端永久冻结**。两个特性各自单测全绿，第一次在真链相遇就翻车（审批同意 plan 后浏览器定格）。修法：追加管道检测 seq 回落 → 对该客户端重发全量 baseline（代内重置，瞬态一并清空）——dsh"每代连接发完整投影 baseline"语义的移植：**谁破坏 append-only 假设，谁负责重开基线；传输层不猜引擎意图，只认 seq 连续性**。

## 3. 实现与验证记录

**验证**：cordis **181/181**（f5 新增 13 条：store 单元 ×2（审批卡挂摘/异 id 不误摘/baseline 清瞬态 + 叙事有界囤积）+ http 驱动 ×11——allow/deny 双闭环（deny 逐字节 = 终端）、fail-closed 三连（无客户端/超时/断线，各查裁决事实落日志）、迟到作答信封报错、重连重宣告、commands.list（静态+技能 kind 标记）、/cost /plan 分发双证（叙事帧 + 日志注记）、未知斜杠不认领、plan 四选项全流程）；mock **28 场景全绿**（零断言变更）；vite build 243.7KB / gzip 76.9KB。

**plan 四选项真链的时序发现**：mock 响应在**同一引擎 turn 内**连续消耗——keep-planning 打回后 r2（再 exit）还在 turn 1 里，clear-and-execute 自结 turn 后注入文本才开新 turn。两次审批发生在同一个 turn 内，第二张卡不等 turn/end。测试节奏按"LLM 请求"计数，不按"用户 prompt"计数。

**清史后零域的断言口径**：`setMode` 的 mode 注记先于 `clearHistoryKeepSystem` 落笔——跟着第一轮一起被清；目标模式的记载在重建输入文本里（`Permission mode: acceptEdits`）。keep-planning 的 tool_result 断言必须在 decide card2 **之前**完成（清史即消失）。

**手测清单**（浏览器面，用户跑）：`npm run webui && node dist/cli.js --web --port 3080`（echo 冒烟加 `MINI_CLAUDE_LLM_ROUTE=echo`；真模型需 ANTHROPIC_API_KEY）→ 开 `http://127.0.0.1:3080`：
1. 让模型写一个新文件 → composer 上方黄色审批卡（message + tool 名折叠 input）→「允许一次」→ 卡消失、工具卡黄点转绿；
2. 再来一次改点「拒绝」→ 工具卡红色结果 `User denied this action.`（与终端逐字节同话术）；
3. 临时 `MINI_WEB_APPROVAL_TIMEOUT_MS=10000` 重启 → 审批卡挂 10 秒自动消失（timeout deny，服务端 console 有日志）；
4. 审批卡挂着时刷新页面 → 卡还在（baseline 后重宣告）；答一次 → 两个都消失（resolved 广播）；
5. 审批卡挂着时关掉最后一个标签页 → 服务端 console 出现 `auto-denied (no client connected)`（fail-closed）；
6. 输入 `/` → 补全弹窗（静态命令 + 可调用技能，kind 徽标）→ Tab 或点击补全 → `/cost` 出 Tokens 叙事行、`/plan` 两次切换模式（叙事行 + 侧栏模式可见的 turn 行为变化）、`/commit "fix types"` 走技能；
7. `/plan` 进 plan 模式 → 让模型出 plan 调 `exit_plan_mode` → 蓝色四选项卡 → 选「4 继续规划」展开反馈输入 → 打回重做（模型收到反馈）→ 再 exit → 选「1 清空上下文并执行」→ 会话清空、新 turn 以 acceptEdits 重跑；
8. 两个浏览器标签同看一张卡，先答者赢，另一张卡自动消失。

## 4. 翻车记档

1. **物理清史 × seq 去重 = 直连客户端永久冻结（本章正戏）**：clear-and-execute 首次在直播流下运行——`sessionLog.clear()` 让 seq 归零重启，补发管道把清史后所有事件当重复帧丢弃（`seq <= lastSent`），浏览器永远定格在清史前最后一帧，心跳还报小 lastSeq（客户端以为没洞）。F2/F4 各自单测全绿——**单特性的测试不覆盖特性间的组合，跨代语义相遇必须真链测试**。修法 rebaseline（seq 回落检测 → 代内重开基线）。教训的普遍形：**"append-only"是契约不是巧合，谁破坏它谁负责发出不连续信号；下游靠连续性做的优化（去重/补洞）必须对不连续点有显式协议。**
2. **waitFor 从帧序头扫，二次踩坑（F4 翻车 #1 同款）**：第二张 plan 卡的等待谓词没排除第一张的 id——waitFor 每次从头扫描，永远命中旧帧 → 拿旧 id 去 decide → `no pending`。**谓词查找必须携带"排除已消费"条件**（或改订阅增量）；这条记过一次还会踩，说明正确姿势要变成默认写法。
3. **mock 响应按"LLM 请求"消耗，不按"用户 prompt"**：按"一次 prompt 一个 turn"排场景节奏 → keep-planning 打回后 r2 在同一 turn 里继续，第二次 prompt 撞 busy、mock 响应用尽报 Connection error。**http 驱动的场景脚本，节拍器是模型的响应次数。**
4. **断言"清史后还剩什么"之前，先问"什么先落笔"**：期望零域里有 `mode=acceptEdits` 注记，实际 `setMode` 在 `clearHistoryKeepSystem` 之前执行——注记跟第一轮一起被清。同段还有：`/cost` 走的是 `ui.info`（"Estimated cost"），`kind=cost` 帧来自引擎每轮 usage 旁白——**断言对着引擎事实写，不对着记忆猜**（F4 翻车 #4 的延续）。

## 5. 自测三题（答案在文末）

1. 审批请求为什么走瞬态帧 + 重宣告，而裁决结果走 meta/note 落日志？两者调换会各坏什么？
2. `commands.dispatch` 为什么加 `handles()` 同步判定，而不是让 RPC await `dispatch()` 或干脆也 fire-and-forget 到底（不回 handled）？
3. rebaseline 为什么在 Host 追加管道里检测，而不是让 session-log 发一个"cleared"事件、Host 订阅它？

> **答案**：
> 1. 尺子是"**settled 的事实 vs 在途的状态**"。请求在途（可能永远没人答），落日志会把"问过"变成事实、把超时/断线变成需要否定性事件来撤销的状态——瞬态帧 + baseline 后重宣告让"现在有什么待决"永远是 Host 活状态的投影，不需要删除语义。裁决一旦发生就不可逆地改变了引擎走向（工具执行与否、模式切换），是会话事实：落日志则 F6 回放可考、断线重连的客户端也能从拉取面看到"刚才谁裁了什么"。调换过来：请求落日志 → 超时 deny 要补"撤销"事件，日志变成可变状态机；裁决走帧 → 不在场客户端永远丢了"为什么这个工具被拒"，回放断史。
> 2. 三态对比：**await dispatch** —— `/goal` 长驻把 RPC 吊几分钟，一元调用的超时/重连语义全部失义（还占着 fetch）；**全 fire-and-forget 不回 handled** —— 客户端无法执行"没人认 → 透传给模型"的终端同款分流，未知斜杠要么吞掉要么双发；**handles() 同步判定 + run 异步** —— 路由判定（查表）本来就是同步知识，执行结果（可能几分钟、可能出错）本来就该走叙事面异步到达。`{handled}` 是路由语义不是执行语义，接口的返回时机应该匹配它承载的语义边界。代价是 `handles` 与 `dispatch` 的切词规则重复两份——所以注释里互相指认"同一套切词"，这是有意识的局部重复（三条类比一个过早抽象干净）。
> 3. 让 session-log 发"cleared"事件 = 引擎要认识"我的日志会被流消费"——日志是纯事实记录，它不该知道下游有谁在听着什么（C3 以来的分层成果）；而且破坏点不止 clear 一个（未来任何物理截断/重整都要记得发事件，靠人记）。Host 侧检测 seq 回落是**从自己依赖的契约（seq 单调）出发守自己的不变量**：不管上游谁、为什么破坏连续性，重开基线都是正确响应——防御放在依赖被破坏的地方，而不是假设破坏者会通知你。代价是检测信号比较隐晦（seq 回落复用了 append 时序），所以注释里把 C5 clear 点名。

## 6. 下章预告（F6 投影与收官）

`session.projections`（goal/loop/compaction 统计的快照 + 增量帧，快照带"反映到的最后 seq"）；侧栏（会话列表 + 历史回放：follow 帧重放进 UI）；`--profile web` 冒烟手测清单；差异记档收官文档 `dsh-final.md` 增补 UI 章。goal/loop 期间的 busy 上屏（F5 记档的已知限）也在投影里兑现。
