# dsh-D6 goal/loop/auto 收口——自主性全面监听器化

> 本章产物：`services/schedule.ts`（ScheduleService：键控一次性定时器 + wakeup 意图槽）；goal 评估器、auto 分类器机制、schedule_wakeup 工具全部落进插件；`ToolExec.autoAdjudicate` 句柄与 `LoopService.pendingWakeup/timer` 字段协议消亡；**B5 的最后一个魔法名（schedule_wakeup）退役**。
> 一句话：**决策在监听器、定时归服务、状态归服务——agent 循环里不再有自主性的任何私有机制**。
> 参照物：dsh 的 schedule 服务与"服务持状态、监听器做决策、入口管生命周期"三分律。

---

## 1. D5 之后的三个残余口袋

C5 把 goal/loop 的**决策**迁成了监听器，但三样机制还长在 agent 身上：

1. **字段回传协议**：`schedule_wakeup` 工具执行时写 `LoopService.pendingWakeup`，turn-end 监听器 `takeWakeup()` 取走清空——读写两端隔着一个 turn 边界，靠约定同步；loop 的裸 `setTimeout` 还长在 `LoopState.timer` 上。
2. **借道句柄**：auto 分类器机制（两段 LLM 裁决、DENIAL_LIMITS 降级、headless 判定）是 agent 的私有方法，auto-approval 插件经 `call.autoAdjudicate` 句柄回调——C2 明说的"迁路由不迁机制"欠账。goal 评估器同理（`bridge.evaluate` 闭包 agent 私有方法）。
3. **魔法名尾款**：`executeToolCall` 里的 `schedule_wakeup` 分支是 B5"switch 改查注册表"的最后一个。

## 2. 新机制：三个口袋各自的归宿

```
schedule_wakeup 工具（autonomy 插件注册，注册表公民）
    │ schedule.requestWakeup（意图进槽）
    ▼
turn-end 监听器 ──takeWakeup──► 决策（收敛/预算/上限）──► schedule.after("loop-tick", ms, fireTick)
    │                                                      │ cancel 纪律：stop/finish 必 cancel
    ▼                                                      ▼
bridge.wake(directive) → inbox                      定时到点 → tick 注入，链收敛

auto: pre-execute 瀑布 ──► auto-approval 插件 ──► classify(ctx, call)
    transcript = session-log.derive()     旁调 = ctx.llm.sideCall(defaultRoute)
    headless = approval.hasInteractiveProvider()   信号 = call.signal

goal: turn-stopping 监听器 ──► evaluateGoal(ctx, condition)
    transcript 同上（extractLastAssistantText 随迁），fail-closed 原样
```

**ScheduleService 的两个职责**（都是"未来才发生的事"）：
- `after(key, ms, fn)` 键控一次性定时器：同 key 再排 = 顶替；`cancel/has` 给 stop 的两种收尾用。
- `requestWakeup/takeWakeup/clearWakeup` 意图槽：工具侧写、边界侧取走即清、finish 时兜底清。

**工具/监听器的分工**：wakeup 的**延迟起点是 turn 收敛点**（不是工具调用点），且收敛判定（没排 wakeup 即收敛、预算、上限）只能在 turn-end 做——所以工具只写意图，定时器由监听器排。`setScheduleWakeupToolVisible` 留在 agent：schema 广播走 `this.tools` 数组（广告线），时机仍是 runLoop 生命周期，场景 24 的门控锚不动。

**分类器的三个新信号源**（句柄消亡后的等价迁移）：
- transcript：`ctx.require("session-log").derive()` ≙ 旧 `this.history()`；
- headless：`approval.hasInteractiveProvider()` ≙ 旧 `this.confirmFn` 判定（setConfirmFn 本来就同时包装 interactive provider，两个信号源同真同假）；
- 中断：`call.signal`（ToolExec 新字段，agent 传 `abortController.signal`）≙ 旧直读 `this.abortController`。
- DENIAL_LIMITS 双计数器迁插件闭包——每棵 agent 树一份，粒度与旧实例字段相同。

**桥的收窄**：`AutonomyBridge` 从 4 个方法瘦到 3 个（getBudget/getMaxTurns/wake）——预算与轮数仪表还住在 agent（cost/token 计数，E 阶段再议），评估器与分类器都已是注册表公民。

## 3. 设计决策记档

1. **意图槽归 schedule 而非 loop**：定时和唤醒意图都是"对未来的预约"，归同一个家后 LoopService 退役为纯状态 + 收尾纪律（finish = cancel + clearWakeup + done），"字段协议"这个概念在 loop 上彻底消失。
2. **工具注册用 require 而非 get**：ToolsService 是 agent 树的保底公民（构造器第一行就建），插件对它严格；c2/c5 测试的裸树随之补公民——树的公民表也是缝的一部分。
3. **schema 双轨保持现状**：注册表 ToolDefinition 用 `parameters`（内部），线格式 Anthropic.Tool 用 `input_schema`（上线路）——SCHEDULE_WAKEUP_TOOL 常量保持线格式，注册时显式映射，不为了一个工具合并两套词汇。
4. **广告不动**：`this.tools` 数组仍是请求体 tools 数组的生命线（D3 已证"广告一直走数组"），schedule_wakeup 的进出 splice 留在 agent——插件管执行与意图，agent 管广播。

## 4. 实现与验证记录

**文件**：`services/schedule.ts`（新增）；`plugins/autonomy.ts`（评估器两函数迁入 + LoopService shed timer/pendingWakeup + schedule_wakeup 注册 + 监听器换 schedule.after）；`plugins/auto-approval.ts`（分类器机制整体迁入：classify/autoFallback/runClassifierQuery/denials 闭包）；`services/tools.ts`（ToolExec/PreExecCall 的 autoAdjudicate → signal，AutoVerdict 迁出）；`services/llm.ts`（defaultRoute getter——env 换后端的单一出处）；`agent.ts`（evaluateGoal/runEvaluatorQuery/extractLastAssistantText/classifyToolCall/autoFallback/runClassifierQuery/DENIAL 计数器/confirmFn 死字段/schedule_wakeup 魔法分支——全部消亡，-187 行）；`cordis-tests/c2-approval.test.ts`（桩从句柄缝移到 llm 缝：fakeClassifierLlm）；`cordis-tests/c5-goal.test.ts`（同：假适配器回脚本 verdict JSON + 补保底公民）。

**验证**：cordis **131/131**；mock **27 场景全绿**。零断言变更的锚：场景 7/15/26/29（goal 三态 + loop 收敛/上限 + auto 两段 + 拒绝上限）、场景 24（dynamic 门控：schedule_wakeup 只在 loop 期广告）、场景 19（permission deny 规则照旧硬拦）、场景 31（echo 路由——defaultRoute 同源验证）。话术逐字节保留：`schedule_wakeup is only available...`、`[Auto Mode] ${reason}`、`Auto Mode: denial limit reached...`、`⟳ next run in ...`。

**翻车记档**：
1. **sed 行号切割事故**：删 classifyToolCall 三方法块时按行号 `sed -i '1015,1101d'`，range 端点实际落在 childPermissionMode 的**签名行**上——注释+签名被吞、方法体成孤儿，tsc 一片 TS1005/TS1128。教训：**大段删除用 Edit 按内容锚定**；行号 sed 只给小且刚 `sed -n` 验过边界的范围。这已是本仓库第二次栽在"边界看了一眼但看错一行"（D4 手滑同源）。
2. **schema 字段名双轨擦肩**：注册 schedule_wakeup 时顺手 `...SCHEDULE_WAKEUP_TOOL`——它是线格式（`input_schema`），注册表定义要 `parameters`。靠先读 schemaOf 的 Pick 签名躲过；**两个词汇表并存的系统里，"形状像"不等于"是同一个"**。
3. **裸树缺公民**：评估器迁插件后 c5 rig 炸 `service "session-log" is not provided`——require 严格读取没毛病，是测试的树没跟真实 agent 树的保底公民对齐。桩挂在缝上（D4 教训）之外，**树的公民表也是缝的一部分**；c2 的分类器桩同理补了 session-log。

## 5. 自测三题（答案在文末）

1. 为什么 schedule_wakeup 工具执行时不能直接 `schedule.after` 排定时器？延迟的起点到底是谁？
2. `LoopService.stop()` 用 `schedule.has("loop-tick")` 区分两种收尾——两种分别是什么？旧代码用 `state?.timer` 判定，为什么等价？
3. headless 判定从 `this.confirmFn` 换成 `approval.hasInteractiveProvider()`——什么情况下两个信号源会错位？错位时往哪边倒，安全吗？

> **答案**：
> 1. 延迟起点是 **turn 收敛点**：turn-end 监听器先做收敛判定（dynamic 没排 wakeup → 直接收敛结束 loop；预算/上限 → 停机），活着才排 `after`。若工具直接排，定时器会在 turn 还没结束时开跑，且"没排 wakeup 即收敛"这条收敛路径就没了着落——意图必须先在边界被裁决。
> 2. 两种收尾：**定时器等待期**收到 SIGINT（stop）→ cancel + finish 立即收尾，runLoop 的 await 马上 resolve；**turn 进行中**（定时器不存在）→ 只举 stopFlag，turn-end 监听器见到旗子收尾。旧判定 `state?.timer` 与 `schedule.has("loop-tick")` 同真同假：timer 字段本来就是"当前有没有挂着的 loop 定时器"，只是住址从 LoopState 搬到了 schedule。
> 3. 错位仅当"setConfirmFn 被调但 interactive provider 没注册成功"（或反之）——但 setConfirmFn 是原子地做这两件事的，所以结构上不会错位；会错位的只有手写测试树只设其一。错位方向：provider 缺 → 分类器以为 headless → 直接拒（fail-closed，安全但体验降级）；confirmFn 缺而 provider 在 → 以为有人在，问一个没人答的 provider（approval.request 对无 provider 才 fail-closed，此处 provider 存在所以真能答）。安全侧倒向"拒"。

## 6. 遗留与下章（D 阶段收官 → E1..E3）

- 魔法名还剩 plan/skill 两个（B 阶段语义：plan 是模式机、skill 是双入口分流）——它们不是"漏网"，是本来就长在循环语义里；是否注册表化留给真 dsh 对照时再议。
- 预算（cost/token 计数）与轮数还在 agent 字段上——bridge 的 getBudget/getMaxTurns 是它们最后的缝，E 阶段若做仪表服务一并收。
- D1..D6 插件化收官。下一步按总纲进 E1..E3。
