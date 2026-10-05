# dsh-C4 Agent handle 与 inbox

> 本章产物：`services/agents.ts`（Inbox 双队列 + AgentHandle 接口 + AgentRegistry）；agent.ts 的 `chat()` 单入口拆成 **handle 面 + 驱动循环**（send/followup/steer/cancel/whenIdle，idle/running/maintenance 三态，step 边界认领插话）；cli.ts 输入改走 handle；run-mock 新增场景 27（mid-turn 注入）。
> 一句话：**输入是数据**——send/followup/steer 只是往两支队列里排队，什么时候进上下文由循环的 claim 边界决定，而不是由调用时机决定。
> 参照物：`packages/core/agent/src/runtime-types.ts`（Agent 接口段）、`agent-loop/src/inbox.ts`（claim 语义）、`agent-loop/src/agent.ts`（wake/latch 驱动段，43-330 行附近）。

---

## 1. 为什么要拆：chat() 单入口的三宗罪

上一轮的 `chat(userText)` 是唯一入口，它把三件事焊死在一起：

1. **输入只能出现在 turn 边界**。turn 进行中到达的文本（用户抢话、goal 回灌、未来的 UI 事件）没有去处——直接 push 会撞连续 user（靠 C3 合并器兜成拼接，但"拼进上一条"和"新指令"在模型眼里没有边界）。
2. **"忙"是二进制**。`isProcessing = abortController !== null` 只能回答"忙不忙"，回答不了"忙到哪一步、下一步会不会带上我新说的话"。
3. **循环与入口耦合**。goal/loop/subagent 各自在 chat 外面再包 while——"什么时候继续跑"这个机制问题被每个调用方各答一遍。

dsh 的答案是把 Agent 本身变成**公共 handle**：入口方法只负责"把输入路由到某条队列 + 按需唤醒驱动"，认领、注入、续 turn 全是循环内建语义。调用方（CLI、goal、未来的 UI）从此不必知道循环长什么样。

## 2. inbox 双队列与 claim 语义

| 队列 | 语义 | 谁在排 |
|---|---|---|
| `next-turn` | 每个条目**独占一个 turn**——"下一个完整对话轮的输入" | followup、idle 时的 send |
| `next-step` | 注入**当前 turn 的下一个 step 边界**——"打断插话" | running 时的 send、steer |

claim 两种（对照 `inbox.ts` 的 `claim(target, turn)`）：

- **turn 边界**：全部 `next-step` + **恰一条** `next-turn`，steer 在前、turn 输入在后——它们合并成该 turn 的首批 user 内容。为什么 next-turn 只取一条？turn 的所有权：一条 followup 就是一个完整对话轮，两条 followup 各开各的 turn，混在一起模型分不清"两个任务"还是"一个任务两句话"。
- **step 边界**：只取 `next-step`——插话不终结 turn，只是让模型在**下一双眼睛看世界的时候**看到它。

**注入的形状**（请求体等价的关键）：step 边界认领的文本经 `pushUser` 以 **text 块追加进 tool_result 批次**（C3 合并器的既定语义）。此刻历史末尾是 user(tool_result 批次)——新开 user 消息就是连续同角色 400；追加 text 块合法且语义准确：这一批 tool_result 和这条插话，就是模型下一步要一起消化的东西。

## 3. wake/latch 与 mini 的 drain 简化

dsh 的驱动收敛点有一套 latch 精确语义：`wakeDriver` 在 maintenance/aborted 相位不能直接投递，就记 `wakeRequested`，收敛时重放；活驱动自己认领队列无需 latch。还有配套的 turn-stopping 规则：收敛前看 inbox 有没有"新鲜插话"，有就**同一个 turn 再跑一个 step**。

mini 不做 latch，用**排空循环**等价替代：`runDriver: while (inbox.hasPending) { claimTurn; runOneTurn }`。差异对照：

| 场景 | dsh | mini | 请求体差异 |
|---|---|---|---|
| turn 运行中 followup | latch → 收敛重放开新 turn | while 顶看见 pending → 开新 turn | 无 |
| turn 运行中插话（还有后续 step） | 下个 step 边界认领 | 同 | 无 |
| 插话到达时末响应已无 tool_use | turn-stopping 发现新鲜插话 → 同 turn 续一个 step | 收敛点开**新 turn** 消费 | **无**——两种走法的消息流同形：[..., assistant(末响应), user(插话)]。mini 的 turn 注记本来就 per-request，连注记都没差 |
| step 被 pre-step 拒绝后插话 | parked 等下次唤醒 | 收敛即消费 | C5 引入 pre-step 后回头复核 |

记为口径差异（不逐字节对齐源码，对齐的是**消息流**）。

## 4. AgentHandle 面：mini 子集 vs dsh

| dsh Agent | mini（Agent 类直接实现 AgentHandle） | 备注 |
|---|---|---|
| `send(message, target, wakeup)` | `send(text)`：idle→next-turn+唤醒，running→next-step | mini 的 target 由状态推导 |
| `followup(message)` | `followup(text)`：next-turn + 唤醒 | 同形 |
| `steer(message)` | `steer(text)`：next-step；idle 也开 turn | 同形（"An idle driver starts a turn"） |
| `inject(message)` | 不做 | D4（memory 注入）再加 |
| `cancel(cause, {keepInbox})` | `cancel(cause?)`：stopLoop + stopGoal + **inbox.clear()** + abort | clear = dsh 默认（不带 keepInbox）；先清 next-step 再清 next-turn |
| `whenIdle()` | 有 | waiter 列表，收敛时冲水 |
| `runMaintenance(task)` | 不做独立相位 | mini 的 maintenance = turn 开场段（见下） |
| `status: idle \| running` | `idle \| running \| maintenance` | mini 显式三态；dsh 的 maintenance 是内部 phase、对外只报 idle/running |

**三态在 mini 的落点**：

- `maintenance` = turn 开场段：首批消息入栈之后的 T4 检查（checkAndCompact）、memory prefetch 发起、MCP 连接——这些是"为 step 做准备"的边界工作，没有 step 在跑；
- `running` = step 循环（请求 + 工具执行）；
- `idle` = 无驱动。

诚实记档：dsh 的 runMaintenance 能**从 idle 独立起**维护任务（压缩、checkpoint），插话输入在任务期间排队等它结束；mini 的 maintenance 只是状态标签，compact 仍内联在 turn 开场——独立维护相位留给 C8（持久化时机重构）再议。

**abort 语义保持**：驱动被 cancel 后，settle promise 以 abort 错误 reject 给 awaiter（chat/send 的调用方）——旧 chat() 的抛错路径原样保留，REPL 的 isAbort 捕获、one-shot 的向上传播都不用动。与 dsh 的差别：dsh 的 cancel 带 cause 区分 user/supervisor/disposed，mini 的 cause 参数暂只做透传记录。

## 5. driver 结构图（agent.ts 新骨架）

```
send / followup / steer / chat(兼容= followup + await)
          │ inbox.append
          ▼
  Inbox { next-turn[], next-step[] }
          │ ensureDriver()（已活则返回同一个 settle promise）
          ▼
runDriver: while (inbox.hasPending)          ← 唤醒循环（排空即收敛）
          │ claimTurn() = 全部 next-step + 恰 1 条 next-turn
          ▼
runOneTurn(batch)                            ← 旧 chat() 的开场【maintenance】
  pushUser(batch) → T4 → memory prefetch → MCP → abortController
          ▼
runStepLoop(mcpTools)                        ← 旧 runAgentLoop【running】
  while: [step 边界 claimStep → text 块并入批次] → 请求 → 工具 → 回灌
          ▼
settle：排空 → idle（冲水 whenIdle waiters）；abort → 补 turn/end 注记 → idle → reject
```

**请求体等价论证**：22 个既有场景没有任何 mid-turn 输入——claimStep 恒为空、claimTurn 恒单条，消息流与旧 chat() 逐字节一致；开场段顺序（push → T4 → prefetch → MCP）照抄旧 chat()，T4 对"末条是纯 user 文本"的不变式不破坏。行为升级只发生在场景 27：step 边界多出的 text 块（差异逐条指认，见验证记录）。

## 6. 实现与验证记录

**文件**：
- `services/agents.ts`（新增：Inbox / AgentHandle / AgentRegistry）
- `agent.ts`（修改：handle 面与驱动循环；`runAgentLoop` 更名 `runStepLoop` 并在 step 边界插 claim；`abort()`/`isProcessing` 被 `cancel()`/`busy` 取代）
- `cli.ts`（修改：REPL/one-shot/skill 输入走 `send`；SIGINT 走 `cancel`）
- `cordis-tests/c4-agents.test.ts`（新增 5 条）
- `run-mock.mjs` + `mock-anthropic.mjs`（场景 27、`delayMs` 选项、abort 后写死 socket 的 error 防护）

**验证**：
- `npm run cordis`：**89/89 绿**（C4 新增 5 条：claimTurn 组合序、claimStep 不动 next-turn、clear 顺序、Agent 出厂 handle 面、Registry create/get/list）
- 全量 mock 回归：**23 场景全绿**（22 既有 + 新场景 27）。场景 27 三阶段探针（delayMs 卡响应，时序确定）：mid-turn 注入 5 条断言（messageCount 仍 3 = 插话并入批次而非新开消息、lastUserText 含标记、tool_result 同消息、running 状态、收敛回 idle）、cancel 2 条（settle 以 abort reject、回 idle）、followup 自动续 turn 2 条（运行中排队、req5 以新 user 消息开 turn + messageCount 7）
- 请求体等价：22 既有场景零改动全绿——claimStep 恒空时消息流与旧 chat() 逐字节一致，论证兑现

**翻车记档**（实现过程中真实发生）：
1. **`import type` 与值导入的边界**：services/agents.ts 首版把 `Agent` 写进 `import type`——Registry.create 里 `new Agent(opts)` 直接 TS1361。值导入才进运行时；而与 agent.ts（反向导入 Inbox）的环因此成立——两边都只在方法调用期取值，模块求值期无环序问题。环不可怕，**求值时机**才是判据。
2. **探针轮询撞上惰性创建**：waitMainReq 首轮 poll 时 mock 还没收到第一个请求，日志文件尚不存在——readFileSync 直接 ENOENT 炸掉探针。修法：容错缺文件返回空表继续轮询。教训：**轮询读一个由别人惰性创建的文件，"不存在"是正常态不是错误**。
3. **断言锚错列**：phase3 首版断言写 `firstUserText.includes("phase three b")`——mock 的 firstUserText 是**全会话首条** user 消息，不是当轮首条；phase-three-b 是末条，该锚 lastUserText。10/11 绿的时候最危险——差的那一条先怀疑自己的断言，再怀疑实现。
4. **cancel 不回滚已入栈的消息（对齐旧语义）**：phase2 揭示 abort 后 "cancel me" 仍留在历史（无 assistant 应答），phase3 的输入经合并器拼进它。旧 chat() 同样如此（push 在请求前，abort 只杀请求）——不是回归，是行为契约的一部分。若 cancel 要回滚消息，那是对 C3 双写入口的侵入式改写，收益（历史干净）抵不过成本（日志 append-only 被破坏）——记档不改。
5. **（元层）测试驱动器的误报**：用 grep "crashed" 判场景成败，而场景 20 恰有通过的断言名叫 "no run crashed"——全勾被判失败。跑批判定要看**退出码**，字符串匹配只配当辅助。

## 7. 自测四题（答案在文末）

1. `send` 和 `followup` 的差别只在哪个决定点？为什么 mid-turn 文本必须走 next-step 而不是直接 push？
2. mini 用"排空循环"取代了 dsh 的 wake/latch，为什么连"插话在末响应后到达"这种最刁钻的时序，两种实现的请求体都一样？
3. step 边界认领的插话为什么以 text 块追加进 tool_result 批次？这依赖 C3 立下的哪条规则？
4. `cancel()` 为什么要清 inbox（dsh 默认行为）？不清会在什么交互下出问题？

> **答案**：
> 1. 差别只在**状态判定**：idle 的 send 等价 followup（排 next-turn、开新 turn），running 的 send 排 next-step（等最近 step 边界认领）。mid-turn 直接 push 有两个问题：撞连续 user（靠合并器兜成拼接，但）；更本质的是**绕过了认领边界**——输入该在哪个 step 可见成了一场竞速。
> 2. dsh 走 turn-stopping：同 turn 续一个 step，消息流 [.., assistant, user(插话)]；mini 收敛后开新 turn 消费，消息流完全同形——因为"turn"在本轮 mini 里只是请求级注记，消息流才是请求体的全部。两个实现争的不是消息形状，是驱动归属；请求体只看消息形状。
> 3. 此刻历史末尾是 user(tool_result 批次)——新开 user 消息即连续同角色（API 400）。依赖 C3 合并器的"批次数组追加 text 块"分支：插话作为 text 块并入批次，一条 user 消息同时携带工具结果和新指令，形状合法且语义准确。
> 4. Ctrl+C 之后的下一条输入应该获得干净的上下文。不清的话：旧 turn 排队的插话会混进下一次 turn 的首批消息（或更糟——被下一个 turn 的 step 边界注入），用户以为打断了的指令还在暗处生效。dsh 把它做成默认行为并留 `keepInbox` 逃生口，mini 只取默认。

## 8. 下章预告（C5 循环事件化 ★大章）

turn/step 事件序列埋点（`agent/pre-step` 改写/拒绝、`agent/turn-stopping` 挽留、`turn/end reason`）；plan/goal/auto/loop 的硬编码分支迁为 `plugins/autonomy.ts` 监听器；`contextCleared` 布尔消亡。C4 的 runStepLoop 给它留好了位置：pre-step 挂在 claim 之后、请求组装之前；turn-stopping 挂在"末响应无 tool_use"的收敛判定处——正是本章"排空循环"看到 pending 之前的那一格。
