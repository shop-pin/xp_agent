# dsh-C5 循环事件化 ★大章（第一段）

> 本章是本轮横切面最大的一章，按路线图分三段推进，**每段一回归**：
> **① 事件埋点 + concludeTurn + plan 迁移（本段）**；② goal 迁移（turn-stopping 挽留）；③ loop 迁移 + 失败补全 + autonomy 插件收口。
> 本段产物：agent 域三个事件（`agent/pre-step` / `agent/turn-stopping` / `agent/turn-end`）；`TurnConclusion`（工具自结 turn + 新输入注入）；`contextCleared` 布尔消亡；run-mock 场景 28（事件探针）。
> 一句话：**循环只懂机制，不懂政策**——plan 的"清历史重来"从 agent 私有布尔变成任何工具都能签发的结论对象，goal/loop/auto 的续命与改写全部长在事件上。
> 参照物：`docs/architecture.md` 的 Turn flow 节、`agent-loop/src/agent.ts` 的 `preStep()`/`turn()`、`agent/src/runtime-types.ts` 的事件注释（那是最详尽的规格书）。

---

## 1. turn/step 事件序列：dsh 在循环上开了哪些口

architecture.md 的 turn flow 图（缩排即时间）：

```
turn/start
  claim next-step input plus one queued message
  assemble prompt sections + tool schemas
  -> agent/pre-step                reject | enter(messages)
     reject, or a first enter rewritten empty -> close the turn with no step
     step/start
     agent/request -> prepareCall
     append entered messages as user/message
     stream -> agent/assistant-stream (start/chunk*/end)
     tool/call* -> tools/pre-execute -> tools/execute -> tools/post-execute -> tool/result*
     step/end
     tools owe another request, or next-step input arrived -> claim -> next step
  -> agent/turn-stopping
turn/end
```

三个要点：

1. **pre-step 管"进什么"**：每个被提出的 step（不论 turn 首步还是续步）先过 waterfall——监听器可改写 claimed 消息（auto 分类器、输入消毒）或拒绝（reject → turn 以 **blocked** 收敛，`turn()` 源码 `turnEnds = { kind: 'blocked' }`）。被拒的输入已 claim，**既不回队列也不进消息**——它就消失在边界上。
2. **turn-stopping 管"停不停"**：收敛前最后一个口（serial，无 next）。模型不再欠响应（无 tool 调用、无新鲜插话）时仍可能有第三方反对——监听器 `steer()` 一条文本，机器重读 inbox 再跑一个 step。goal 的"评估不达标就续命"就是它。
3. **注记与事件的分工**：`turn/*`、`step/*` 是**持久会话事件**（日志即真相）；`agent/*` 是**进程内扩展点**（UI/插件消费）。mini 的 turn/start|end 注记已在 C3 落盘，本段补的是扩展点那层。

## 2. mini 的三事件埋点

| 事件 | 派发 | 时机（mini 落点） | payload | 默认（无监听器） |
|---|---|---|---|---|
| `agent/pre-step` | waterfall | runOneTurn 首批入栈前；step 边界认领插话后 | `{ input: string[] }` | 原样通过 |
| `agent/turn-stopping` | serial | 末响应无 tool_use、end-turn 注记前 | `{ steer(text) }` | no-op |
| `agent/turn-end` | emit | 真实 turn 收敛处（end-turn/budget/aborted/blocked/concluded） | `{ reason }` | no-op |

**turn/end reason 词汇表**（注记层，C3 起累积 + 本段新增）：

| reason | 含义 | 引入 |
|---|---|---|
| `end-turn` | 模型正常停（无 tool_use） | C3 |
| `tool-use` | **step 级标记**（turn 继续）——只进注记，不发 `agent/turn-end` 事件 | C3 |
| `budget` | 预算截停（补拒绝 tool_result 后停） | C3 |
| `aborted` | cancel/abort | C4 |
| `blocked` | pre-step 拒绝（对齐 dsh `turnEnds = { kind: 'blocked' }`）；goal 判 impossible 复用它（第二段） | **C5** |
| `concluded` | 工具自结 turn（见第 3 节） | **C5** |

**与 dsh 的两处偏差（记档）**：
- dsh 在 turn-stopping 前查"新鲜插话"（有则直接再跑一个 step，不问 turn-stopping）；mini 不查——插话一律经 C4 的排空循环以新 turn 消费。请求体逐字节相同（消息流同形，见 C4 §3 论证），turn 注记数不同。
- pre-step 拒绝在 turn 首步 = 整 turn 收敛（同 dsh）；在 step 边界 = 只丢插话、step 照常（dsh 会拒绝整个 step）。mini 简化：续步的存亡交给模型，插话的存亡交给监听器。

## 3. TurnConclusion：contextCleared 之死

旧机制：`exit_plan_mode` 审批过"clear-and-execute" → `executePlanModeTool` 清历史、置 `this.contextCleared = true` → runStepLoop 在工具批次循环里查这个**私有布尔**，查到就把 exit 输出改道为首条 user 消息（带 reminder）、丢弃本批其余 tool_result、跳过批次回灌。

问题不在功能在于**耦合方向**：循环必须认识 plan 的一个私有状态位。C5 把它反转成**循环机制 + 工具签发的结论对象**：

```ts
// services/tools.ts
interface TurnConclusion {
    concludeTurn: true      // 本 step 后 turn 收敛
    dropBatch?: boolean     // 跳过本批 tool_result 回灌（历史已清，批次会孤儿化）
    nextTurnInput?: string  // 注入文本排 next-turn，drain 循环开新 turn
}
// ExecOutcome: { kind: "result"; output: string; conclusion?: TurnConclusion }
```

clear-and-execute 现在的走法：工具返回 `{ concludeTurn: true, dropBatch: true, nextTurnInput: <exit 输出> }` → runStepLoop 见结论：跳过批次回灌、注记 `turn/end(concluded)`、把注入文本排进 inbox 的 next-turn → break → **runDriver 排空循环自然开新 turn** → runOneTurn 的 pushUser 给它首条消息的 reminder 待遇。

**逐字节等价论证**：旧路径 = 同一 while 循环的下一轮迭代，请求消息 = [u(exit 输出+reminder), ...]；新路径 = 新 turn，请求消息同构同内容（reminder 判定条件同为 `messages.length === 0 && !hasCustomPrompt`）。差异只有注记多一条 `turn/end(concluded)` 与一条 cordis 事件——都不进请求体。**`contextCleared`、`contextBreak` 两个循环内分支消亡**，plan 场景（10/25）的请求体断言原样通过即验收。

语义升级（记档，D4 回顾）：新 turn 开场会重过 maintenance 段——T4 对清空后历史 length<4 直接跳过；memory prefetch 的旧句柄若未消费会在新 turn 首请求注入（旧路径不注入）。记忆更早进场是合理方向，mock 场景无记忆不受影响。

dsh 对照：真框架的 concludeTurn 挂在 **tool result** 上且"不短路已提交的 next-step 工作"；mini 挂在 executeCall outcome 上且 clear-and-execute 明确短路（dropBatch）——破坏性清历史本来就是 mini 特有语义，记为口径差异。

## 4. 埋点后的循环骨架（增量）

```
runDriver: while (inbox.hasPending)
  └ runOneTurn(batch):
      waterfall agent/pre-step {input: batch}     ← 新增
        reject → endTurn("blocked"); return
      pushUser(改写后的 batch) → maintenance 段 → running
      └ runStepLoop:
          while:
            [非首步] claimStep → waterfall agent/pre-step {input: steers}   ← 新增
              reject → 丢插话继续
            turn/start 注记 → 请求 → assistant 结算
            无 tool_use → serial agent/turn-stopping {steer} → endTurn("end-turn") → break   ← 新增
            budget 超限 → 补拒绝批次 → endTurn("budget") → break
            turn/end("tool-use") 注记（step 标记，不发事件）
            工具批次循环：executeCall outcome 带 conclusion?                ← 新增
              → [dropBatch? 跳过回灌] → nextTurnInput 排 next-turn → endTurn("concluded") → break
```

## 5. 实现与验证记录（第一段）

**文件**：
- `services/agents.ts`（agent 域 Events merging + PreStepDecision）
- `services/tools.ts`（TurnConclusion + ExecOutcome 扩展 + dispatch 透传）
- `agent.ts`（三事件埋点、endTurn 辅助、conclusion 处理、contextCleared/contextBreak 删除、executePlanModeTool clear-and-execute 改签结论）
- `cordis-tests/c5-loop-events.test.ts`（新增）
- `run-mock.mjs`（场景 28 + events 探针 runner）

**验证**：
- `npm run cordis`：**92/92 绿**（C5-1 新增 3 条：conclusion 透传 + dispatch 纯字符串回归 + agent 域三事件注册/改写/steer/emit）
- 全量 mock 回归：**24 场景全绿**（23 既有 + 新场景 28 事件探针）。两个关键点：
  - 场景 10/25 的 clear-and-execute 断言**原样通过**（"rebuilt context as a single user message"、"3-msg history by then"）——TurnConclusion 路径与旧 contextCleared 改道逐字节等价的实证；
  - 场景 28：pre-step 改写进请求（req1 firstUserText 含 REWRITTEN 前缀）、拒绝零模型调用（请求数不增 + blocked 收敛 + 回 idle）、turn-stopping 挽留开新 turn（req3 lastUserText 含 KEEP-GOING）、turn-end 事件序列恰为 `end-turn,blocked,end-turn,end-turn`（tool-use 不发事件——事件层与注记层的分工立刻显形）。

**翻车记档**（第一段真实发生）：
1. **`next()` 是 0 参委托，不是 koa 的传参式 next**：探针监听器第一反应写成 `next({ input: 改写 })`（koa 中间件风格——把下游结果传进 next），tsc 一记 TS2554「Expected 0 arguments」当场拦下。mini-cordis B4 的语义：`next()` 调 inner/后继**取回**结果，监听器**返回**自己的裁决；否决 = 不调 next。两种协议都能表达 around 语义，但混用必错——好在监听器签名由 Events 类型表背书，编译期就抓。
2. **模块增强的全局性是隐形的**：c5 测试文件并没有 import `services/agents.js`，agent 域事件类型却可用——因为 c4 测试（同一编译单元）引入过，declaration merging 一旦进程序就全局生效。这也解释了为什么报错只有第 39 行（pre-step 的 next 调用）而注册 `agent/turn-end` 的那行不报错：类型在，语义错在调用姿势。

## 6. 自测四题（答案在文末）

1. pre-step 拒绝的输入去哪了？为什么"不回队列"是对的（提示：想想 goal 回灌文本被拒后重新排队会发生什么）？
2. `dropBatch` 为什么必须存在？没有它会 400 还是孤儿化？——从 tool_use/tool_result 配对不变式推。
3. turn-stopping 的 `steer` 与用户 mid-turn 的 `send` 走的是同一条队列吗？两条路径最终产生字节相同的请求，差异在哪一层？
4. dsh 把 concludeTurn 挂在 tool result 上、mini 挂在 executeCall outcome 上——这个选择让什么变简单了、什么变不可能了（提示：C8 重放、D5 投影）？

> **答案**：
> 1. 消失在边界上（已 claim、不进消息、不回队列）。若回队列：下一轮 claim 又拿到它、又被拒——死循环；拒绝的理由往往正是"这条输入不该再进来"（模式不符、注入嫌疑）。dsh 的设计是"认领即所有权"：claim 之后消息的命运由边界一锤定音。
> 2. 孤儿化。clear-and-execute 清掉了 assistant 的 tool_use 块，本批更早工具的 tool_result 若照常回灌，就是无 tool_use 对应的 tool_result——历史永久污染，之后每个请求都 400。dropBatch 是配对不变式的守门员。
> 3. 是同一条（next-step/插话队列）。turn-stopping 的 steer 在收敛点入队 → 排空循环开新 turn 消费；用户 send 在 step 中途入队 → step 边界认领并入批次。请求字节相同（都是 [.., assistant, user(插话)]），差异在 turn 注记粒度与消费时机——这就是 C4 §3 论证的"mini 注记 per-request，消息流才是请求体"。
> 4. 变简单：循环不用解析 tool_result 内容，签发点是类型化的 outcome，TS 能查。变不可能（暂时）：结论不进会话日志——C8 重放时无法从日志还原"当时 turn 是被工具结论结束的"（注记 turn/end(concluded) 有记录但结论对象本身没落盘）；D5 若要投影 replace 工具结论也够不着。dsh 挂 tool result 正因为 tool/result 是持久事件。mini 的债记在 C8 章清单。

## 7. 第二段：goal 迁移（turn-stopping 挽留）

旧 `pursueGoal` 是 Agent 里的一层 while：chat → 评估 → 未达则再 chat。第二段把它拆成**所有权三分**：

| 角色 | 落点 | 职责 |
|---|---|---|
| **状态** | `ctx.goal`（GoalService，plugins/autonomy.ts） | condition/iterations/startedAt/lastReason + stopped 标志 |
| **决策** | goal 插件的 turn-stopping 监听器 | 评估 → met 清状态 / impossible 清状态 + `block()` / 未达 steer 回灌 reason 续命（预算、迭代上限停机） |
| **生命周期** | `pursueGoal`（Agent） | 首 turn（chat directive）+ 收尾：stopped 打印 + **finally 清状态** |

finally 为什么必须在 pursueGoal：abort（SIGINT）从 runStepLoop 直接抛出、**绕过 turn-stopping**——监听器永远没机会清状态。发起方兜底是唯一覆盖所有出口的清法（旧版同一纪律，位置从"循环后的 finally"变成"入口的 finally"）。

**续命的机制路径**：监听器 `steer("Hooks: ... not met: ...\n\nKeep working toward the goal.")` → 文本排 next-step → 排空循环 claimTurn 开新 turn → 新 turn 收敛点再评估——while 循环没有消失，它化进了 C4 的 drain 循环 + C5 的 turn-stopping 这对组合。评估时序变化：旧在 turn **之间**（agent idle），新在收敛点**之内**（serial 期间）——请求序列逐条同序（场景 15 的 8 main + 3 goal 调用锚原样通过）。

**block 是 mini 扩展**：dsh 的 turn end reason 由机器独占（listener 只能 steer 或沉默）；mini 让 turn-stopping 监听器可把收敛注记从 end-turn 改成 blocked——impossible 是它的第一个也是（目前）唯一用户。评估器错误仍按未达处理（fail-closed，绝不误清 goal）——评估器的 try/catch 在 `evaluateGoal` 里，桥之外不变。

**C6 缝（记档）**：`GoalBridge { evaluate, getBudget }` 是 Agent 借给插件的桥——评估器还是 SDK 直调 + 读 messages。C6 的 `llm.sideCall` 落地后，evaluate 变成服务调用，桥只剩 getBudget（D6 一并收口）。

### 第二段实现与验证记录

**文件**：`plugins/autonomy.ts`（新增：GoalService + goalPlugin + Context.goal merging）；`services/agents.ts`（TurnStoppingState：steer + block）；`agent.ts`（activeGoal/goalStop 字段消亡、setGoal/showGoal/stopGoal 走服务、pursueGoal 收缩为首 turn + finally、turn-stopping 发 block）；`cordis-tests/c5-goal.test.ts`（新增 5 条）；`run-mock.mjs`（场景 29 + goalImpossible runner）。

**验证**：cordis **97/97**（第二段 +5：未达 steer、met 清态、impossible block、预算停机、stop 标志 + 无 goal no-op）；mock **25 场景全绿**——场景 15（三态 + auto 混跑）的 8 main + 3 goal 调用锚与场景 7（goal+压缩）原样通过 = 追逐请求序列逐字节等价；新场景 29 锚 impossible → turn/end 注记恰为 `blocked` + 驱动回 idle。

**翻车记档**（第二段）：
1. **runner 分支各管各的助手**：goalImpossible 分支用了 `sample` 但没定义——midturn/events 分支各自定义了自己的 sample，复制分支时只带了调用没带定义。三个分支三份本地助手已是坏味道，D6 加 schedule 探针时该提到 runner 顶层共享。
2. **plugin config 的类型推导断在 ctx.plugin 边界**：`evaluate: (condition) => ...` 报 implicit any——`ctx.plugin(P, config)` 的 config 形参是 unknown（B2 的宽签名），GoalBridge 的类型进不去箭头函数参数。显式标注 `(condition: string)` 即可。教训：跨插件边界的回调参数永远显式标类型，别指望结构化推导。

## 8. 第三段：loop 迁移 + 失败补全（章收官）

### 8.1 loop 的驱动形状：while 化进事件对

goal 的续命是"当前 turn 停不停"；loop 相反——它要的是"**何时开下一个全新 turn**"。所以 loop 不挂 turn-stopping（那时 turn 已注定收敛，挽留没有意义），挂的是 **turn-end**：

```
runLoop: 解析 → intro → [dynamic: schedule_wakeup 上广告] → chat(tick 1) → await done
                                                                              │
   ┌──────────────────────────────────────────────────────────────────────────┘
   ▼
turn-end 监听器（每个 tick 收敛点）:
   stopFlag? → "Loop stopped." + finish
   dynamic 且无 wakeup → "converged" + finish
   预算 / --max-ticks / LOOP_MAX → 停机 + finish
   否则 → setTimeout(delay) → fire: wake(tick 指令) ──► inbox next-turn ──► 排空循环跑 tick ──► 又到 turn-end
```

旧 `runLoopInterval`/`runLoopDynamic` 的两个 while 与 `interruptibleSleep`（200ms 轮询的可中断睡眠）消亡；"睡眠"变成一个可 `clearTimeout` 的定时器，`interruptibleSleep` 与 cancel 的竞态问题随之消失——**轮询是给不可打断的等待模拟打断，定时器本来就可打断**。

与 goal 同律的三分：LoopService（`ctx.loop`）持状态（spec/iterations/prompt/timer/done-deferred/pendingWakeup）；turn-end 监听器做决策；runLoop 管生命周期（首 tick + finally 摘工具清状态）。schedule_wakeup 工具的执行守卫从 Agent 私有布尔（`scheduleWakeupEnabled`）变成服务查询（`loop.wakeupEnabled`）。

**done-悬挂陷阱（本段最重要的设计决策）**：tick N 的驱动若失败（abort/异常），turn-end 永远不会触发——`await done` 悬挂。双保险：① `cancel → stopLoop → service.stop()`（定时器期立即 finish，turn 期由监听器收尾）；② **bridge.wake 返回 settle promise**，定时器回调里 `void wake(...).catch(e => finish())`——tick 驱动的任何失败都在插件侧闭环。wake 若做成纯 fire-and-forget（把 catch 折进 Agent），循环状态就漏进了通用原语——D6 的 ctx.schedule 会复用 wake，那时耦合就是债。

### 8.2 失败补全（ToolCallRecovery 简化版）

C3 起的历史污染隐患：assistant 已结算 tool_use 批次、而批后代码（注记/推送）抛出非工具错误时，异常上抛、**批次留在历史里没有 tool_result**——之后每个请求都 400。单工具的 try/catch 罩不住批后注记这类位置。第三段给整批加外层护栏：**为每个无果 tool_use 补 `Tool call not executed: step failed (...)` 的 isError tool_result、pushUser 后原样上抛**——错误照报（调用方的 catch 语义不变），历史不留孤儿。场景 30 用注入的注记异常验证：两个 tool_use 的批次在批后注记处炸掉，下一请求里两个调用都有回应（真实结果 + 补齐的错误结果并存）。

dsh 对照：真框架的 ToolCallRecovery 监听 session 事件流做恢复（工具并行执行、恢复点更多）；mini 的简化版只在批次边界兜底——覆盖面小一档，但"**无孤儿**"这条不变式与验收口径一致。

### 8.3 autonomy 收口

goal + loop 合并为单一 `autonomyPlugin`（本文件第三段起 plugins/autonomy.ts 是唯一自主性插件；plan 的循环行为在 C2/C5-1 已机制化，无需监听器）。桥收窄为一张表：

| 桥 | 用途 | C6/D6 去向 |
|---|---|---|
| `evaluate(condition)` | goal 评估器（SDK 直调 + 读 messages） | C6 → `llm.sideCall` |
| `getBudget()` | goal/loop 共用的预算检查 | D6 → 服务 |
| `getMaxTurns()` | loop 的 --max-turns tick 上限 | D6 |
| `wake(text)` | tick 注入：inbox next-turn + 唤醒驱动，**返回 settle promise** | D6 → ctx.schedule/due |

### 第三段实现与验证记录

**文件**：`plugins/autonomy.ts`（重写：LoopService + turn-end 监听器 + scheduleTick + goal/loop 合一）；`agent.ts`（runLoop 收缩为首 tick + await done、runLoopInterval/runLoopDynamic/interruptibleSleep/executeScheduleWakeup 与 loopStop/pendingWakeup/scheduleWakeupEnabled 字段消亡、schedule_wakeup 走服务、批次外层护栏）；`cordis-tests/c5-goal.test.ts`（桥扩容适配）；`run-mock.mjs`（场景 30 + recovery runner）。

**验证**：cordis **97/97**；mock **26 场景全绿**——场景 24（interval 真 1 秒定时 × 2 tick 上限、dynamic 唤醒 5s→60s 钳制 + 400ms 打断、广告门控三态）请求序列与断言原样通过 = loop 迁移逐字节等价；新场景 30 锚失败补全（错误逃逸 + 两 tool_use 均有回应 + 真实结果存活 + 回 idle）。

**翻车记档**（第三段）：
1. **最顺的一段，但有一个设计期自救**：wake 的错误处理第一反应是折进 Agent（catch 里顺手 stopLoop）——写桥表时发现这会把 loop 状态泄漏进通用原语。改法：wake 返回 settle promise，定时器回调自管 catch → finish。教训与第二段的"所有权三分"同源：**回调里的 catch 是谁的状态，就由谁那一侧收**。
2. **`await chat` 与 `await done` 的顺序依赖**：turn-end 监听器在 chat 的 settle **之前**运行（endTurn 在 drain 检查前发事件），所以 done 可能在 chat resolve 前就已 resolve（收敛场景）——`await chat; await done` 顺序无所谓，靠的是 finish 幂等（state 判空 + done 可重复调）。任何"先 A 后 B"的 await 链在这种事件驱动结构里都要问一句：回调可能比 awaiter 先跑完吗？

## 9. 章验收对照（C5 完结）

| 验收项（roadmap） | 结果 |
|---|---|
| plan/goal/loop/auto 全部场景绿 | 26 场景全绿（含 10/25 plan、15 goal+auto、24 loop、21 压缩） |
| goal 评估 reject → turn/end 带 blocked | 场景 29：impossible → 注记恰为 `blocked` |
| 循环埋点三事件 + turn/end reason | 场景 28（序列采样）+ 词汇表六词 |
| contextCleared 消亡 | 场景 10/25 的 clear-and-execute 断言原样通过 |
| 失败补全 | 场景 30 |
| `contextCleared` 布尔、mode 状态机分支消亡 | 布尔已删；mode 的循环内分支清零（plan 只读契约在 C2、退出在 conclusion） |

**C5 留给后章的债**：goal/loop 评估器与分类器的 SDK 直调（C6 收进 llm 服务）；schedule_wakeup 字段协议与裸 setTimeout（D6 换 ctx.schedule）；turn 注记的 per-request 粒度 vs dsh 的 turn/step 分层（D5/C8 重放时再对齐）。

## 10. 代码执行流程图

> 对应三段提交：`1690fee`（①事件埋点 + TurnConclusion）、`c1cf7af`（②goal 迁移）、`ed4a98c`（③loop 迁移 + 失败补全 + autonomy 收口）。三条主线：循环上开三个口（pre-step / turn-stopping / turn-end）→ 工具自结 turn → goal/loop 的"while 化进事件"。

### 10.1 三个扩展点的埋点位置

```
runOneTurn(batch)                          pre-step · turn 首步形态
  waterfall('agent/pre-step', {input: batch}, () => ({input: batch}))
    ├─ decision.reject ≠ undefined → endTurn('blocked') → return
    │     ★ 输入已 claim：不回队列、不进消息——消失在边界上，零模型调用
    └─ for text of (decision.input ?? batch): pushUser(text)   改写文本进消息

runStepLoop 非 firstStep（step 边界）       pre-step · step 边界形态
  steers = inbox.claimStep()
  有货 → waterfall('agent/pre-step', {input: steers}, () => ({input: steers}))
    ├─ reject → 丢插话、step 照常（mini 简化，偏差记档 §2）
    └─ 否则 → pushUser(改写后插话)——C3 合并器并进 tool_result 批次

末响应无 tool_use（收敛点）                 turn-stopping
  stopReason = 'end-turn'
  serial('agent/turn-stopping', {steer: t => this.steer(t),
                                  block: () => stopReason = 'blocked'})
    ├─ 监听器 steer(text) → 排 next-step → 排空循环开新 turn 消费
    └─ 监听器 block() → 收敛注记变 blocked（mini 扩展，goal impossible 专用）
  endTurn(stopReason)

endTurn(reason)  统一收敛出口：
  sessionLog.append(turn/end, reason)      持久注记（C3 日志）
  + cordis.emit('agent/turn-end', {reason})  进程内事件（插件消费）
  ★ tool-use 是 step 级标记——只进注记，不走 endTurn（不发事件）
```

### 10.2 TurnConclusion：工具自结 turn（contextCleared 之死）

```
签发（executePlanModeTool 的 clear-and-execute 分支）：
  clearHistoryKeepSystem()                  工作集+日志双清
  return { concludeTurn: true, dropBatch: true,
           nextTurnInput: 'User approved the plan. ...' }
      ★ 返回类型 string | TurnConclusion——循环不认识任何工具的私有布尔

上浮（tools.executeCall）：
  exec.dispatch(...) → isTurnConclusion(dispatched)？
    └─ 是 → return { kind:'result', output: nextTurnInput ?? '', conclusion }
          结论文本不进 truncateResult（它就是注入文本，不是工具输出）

收束（runStepLoop 工具批次循环）：
  outcome.conclusion 非空 → conclusion = c → break（本批后续工具不再执行）
  批次循环后：
    !dropBatch && toolResult.length > 0 → pushUser(toolResult)   保留合法结果
    nextTurnInput ≠ undefined → inbox.append('next-turn', 注入文本)
    endTurn('concluded') → break
  → runDriver 排空循环顶：hasPending → claimTurn=[注入文本] → runOneTurn 开新 turn
      reminder 待遇由 runOneTurn 统一给（判定条件同旧 contextCleared 改道）

等价论证：旧路径 = 同一 while 的下一轮迭代；新路径 = 新 turn——消息流同构同内容，
差异只有注记多一条 turn/end(concluded) + 一条 cordis 事件（都不进请求体）。
contextCleared / contextBreak 两个循环内分支消亡。
```

### 10.3 goal 迁移：所有权三分（②）

```
构造：ctx.plugin(autonomyPlugin, bridge)
  bridge = { evaluate: evaluateGoal（SDK 直调，C6 收窄）, getBudget, getMaxTurns, wake }

状态（GoalService → ctx.goal）：
  active { condition, iterations, startedAt, lastReason } + stopped 标志

决策（turn-stopping 监听器，每个 turn 收敛点）：
  g = goal.active；!g || goal.stopped → return（沉默，不干预）
  verdict = await bridge.evaluate(g.condition)     评估器错误按未达处理（fail-closed）
    ├─ ok        → printInfo('✓ Goal achieved ...') → goal.clear() → 沉默
    ├─ impossible → printInfo(...) → goal.clear() → state.block()
    │              turn/end 注记 = blocked（场景 29 锚）
    └─ 未达       → iterations++ / lastReason = reason
          预算超限 / iterations ≥ GOAL_MAX_ITERATIONS → printInfo + clear + 沉默
          否则 → state.steer('Hooks: ...not met: <reason>\n\nKeep working toward the goal.')
                文本排 next-step → 排空循环 claimTurn 开新 turn → 新收敛点再评估
                ★ while 循环没消失——化进 C4 drain 循环 + 本监听器的组合

生命周期（pursueGoal）：
  goal.active？→ try { await chat(directive)      首 turn（设定即开启）
                       if (goal.stopped) printInfo('Goal pursuit interrupted.')
                   } finally { goal.clear() }
      ★ abort 绕过 turn-stopping——发起方 finally 是唯一覆盖所有出口的清法
```

### 10.4 loop 迁移 + 失败补全（③）

```
runLoop(rawInput)
  parseLoopInput → 非法直接返回
  done = loop.start(spec)                   ctx.loop 的 await 锚（done = resolve）
  dynamic → setScheduleWakeupToolVisible(true)   广告 schedule_wakeup（幂等）
  try
    await chat(dynamic ? dynamicLoopDirective(prompt) : prompt)    tick 1
    await done                             后续 tick 由监听器定时 wake 注入
  finally
    dynamic → setScheduleWakeupToolVisible(false)
    loop.finish()                          任何出口清状态（abort 绕过监听器）
  ★ runLoopInterval / runLoopDynamic / interruptibleSleep（200ms 轮询）消亡

决策（turn-end 监听器，每个 tick 收敛点 endTurn 之后）：
  !loop.state → return
  stopFlag → 'Loop stopped.' → finish()        turn 期中断；定时器期 stop() 自己收
  dynamic && !takeWakeup() → 'converged' → finish()   模型没排唤醒
  budget 超限 / iterations ≥ maxTurns / ≥ LOOP_MAX_ITERATIONS → finish()
  否则 → dynamic：prompt = wakeup.prompt || prompt；scheduleTick(delay×1000)
         interval：scheduleTick(interval×1000)

scheduleTick：setTimeout fire（state 还在且未 stop）：
  iterations++；directive = dynamic ? dynamicLoopDirective(prompt) : prompt
  void bridge.wake(directive).catch(e → 非 abort 打印；loop.finish())
      ★ wake 返回 settle promise——tick 驱动失败在插件侧闭环，done 不悬挂
  wake 桥（Agent 侧）：inbox.append('next-turn', text) + ensureDriver()

schedule_wakeup 执行守卫（executeToolCall 内）：
  !loop.wakeupEnabled（dynamic 未活跃）→ 'only available during /loop dynamic mode.'
  否则 clampWakeupDelay → loop.recordWakeup({delaySeconds, reason, prompt})

失败补全（runStepLoop 批次外层护栏，dsh ToolCallRecovery 简化版）：
  批后代码抛非工具错误 → catch：
    为每个无果 tool_use 补 'Tool call not executed: step failed (...)' isError
    → pushUser(toolResult) → 原样上抛——错误照报，历史不留孤儿（否则全 400）
```

### 10.5 完整时序走查：场景 28 循环事件探针（三阶段全串行）

```
探针挂三个 toy 监听器（phase 状态机 rewrite → reject → steer）：
  pre-step：rewrite → next() 取 inner 再返回 {input: 加 'REWRITTEN: ' 前缀}
            reject  → {reject: 'not allowed in this phase'}
            steer   → next() 透传
  turn-stopping：phase=steer 且首次 → state.steer('KEEP-GOING: do phase two now.')
  turn-end：reason 收进 turnEnds[]

Phase 1 改写：chat('hello there') → claimTurn → runOneTurn
  pre-step（首步）：next() 取回 {input:['hello there']}
    → 返回 {input:['REWRITTEN: hello there']} → pushUser(改写后)
  req1：firstUserText 含 'REWRITTEN: hello there' ✓
  模型回 'ok one'（无 tool_use）→ turn-stopping（phase=rewrite，沉默）
  → endTurn('end-turn')[#1] → 排空 → idle

Phase 2 拒绝：phase=reject；chat('should never run')
  → claimTurn=[文本] → runOneTurn → pre-step 返回 {reject:...}
  → endTurn('blocked')[#2] → return——请求数不增 ✓ / 驱动回 idle ✓
  ★ 文本已 claim：不回队列不进消息——zero 模型调用，'should never run' 真没跑

Phase 3 挽留：phase=steer；chat('first turn')
  → pre-step：next() 透传 → pushUser(M1) → req2 → 模型回 'ok two'
  → 无 tool_use → serial turn-stopping：首次 steer ✓ 'KEEP-GOING...' 排 next-step
  → endTurn('end-turn')[#3] → runStepLoop break
  → runDriver 排空循环顶：hasPending → claimTurn=['KEEP-GOING...']
      → 同一 settle 内开新 turn → pushUser(M3) → req3
      → lastUserText 含 'KEEP-GOING' ✓ → 模型回 'ok three'
      → turn-stopping（steered=true，沉默）→ endTurn('end-turn')[#4]
  → 排空 → idle → chat resolve → whenIdle resolve
  采样：turn-end-reasons = 'end-turn,blocked,end-turn,end-turn' ✓
      注记层两个 end-turn（挽留续的是新 turn）——与 dsh 同 turn 续 step 的
      粒度不同，消息流同形（偏差记档 §2）
```
