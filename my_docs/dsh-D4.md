# dsh-D4 memory 与上下文注入

> 本章产物：`AgentHandle.inject()`（next-step 排队、不唤醒）；`plugins/memory.ts`（语义召回插件化：turn 边界发起、落定即注入）；agent.ts 的 memory 字段/轮询/就地改写全部消亡；pre-step payload 增 `boundary`；**注入入日志**（C3 的 memory 盲区闭合）。
> 一句话：**落定是推（settle → inject），不是拉（step 顶 poll）**——注入走 inbox，claim 进消息与日志，model-visible ⟺ logged。
> 参照物：dsh 的 agent.inject() 契约与 memory 子系统的 turn 边界注入。

---

## 1. 旧机制的三宗罪

1. **轮询**：`consumeMemoryPrefetchIfReady` 挂在每个 step 顶——每个请求前问一句"selector 回来没"，落定时机与请求时机耦合。
2. **就地改写**：settled 后直接改 `messages` 末条（append 文本/块）——绕过 pushUser，绕过 SessionLog。
3. **日志盲区**：于是 C3 立的"model-visible ⟺ logged"对 memory 注入不成立——请求里有记忆文本，日志里没有；C8 的 resume 恢复后**丢注入**（derive 看不见它）。

## 2. 新机制：inject 缝 + 推式落定

```
pre-step(boundary: "turn") ──观察者──► startMemoryPrefetch(批文本)
                                            │ async（selector sideCall 走 ctx.llm）
                                            ▼ settle
                              bridge.inject(format(memories))
                                            │ next-step 排队，不唤醒
                                            ▼
                    最近的 claim 点（step 边界 claimStep / turn 开场 claimTurn）
                                            │ pushUser（合并器：批次数组追加 text 块）
                                            ▼
                    消息 + user/message 日志事件（盲区闭合）
```

**inject 与 steer 的唯一差别是唤醒**：都排 next-step、都经 claim→pushUser 同一管线；steer 会拉起 idle 驱动，inject 永不（dsh："idle drivers leave it pending until follow-up or steering wakes them"）。CLAUDE.md 专槽（首条消息 reminder）不动。

**晚归 prefetch 的"排掉"问题消失**：旧版 turn 开场要先 consume 上一轮遗留（否则永久丢失）；新版 continuation 照样 inject，由下一个 claim 点消费——代码少一条路径，语义多一种覆盖（跨 turn 晚归的记忆注入下一 turn 首条消息）。去重靠 alreadySurfaced（插件闭包，一个会话一条记忆只注一次）。

**位置语义**（场景 8 零断言变更的根据）：selector 在工具轮期间落定 → inject 排队 → step-2 边界 claimStep → pushUser 往 tool_result 批次追加 text 块——与旧"consume 改写批次"逐字节同形（merger 的 `blocks.push({type:'text'})` 正是当年 consume 的形状）。差异只在**晚归且 idle** 的情形：旧版 append 在下一 turn 用户文本之后，新版 claimTurn 顺序 [注入, 用户文本] 注入在前——记为已知语义微调（无场景锚定）。

## 3. 设计决策（roadmap 留白的问题）：注入入不入日志？

**入（user/message 事件）**。理由：dsh 的铁律"Model-visible content must use logged channels"——注入内容会出现在下一个请求里，它就是模型可见的；不入日志则 resume/fork/遥测全部缺一块（C8 的 resume 已经踩到）。入日志的代价（事件流多了 memory 文本）正是 D5 投影 replace 想管的东西——两章在这里接头。

## 4. 危险点兑现：注入与 pre-step 改写的先后

claim 的输入（含注入）会过 pre-step waterfall——改写者（skills 目录注入）在链上游或下游都会看到注入文本。两个观察：① memory 插件的 pre-step 监听器是**纯观察者**（先 next() 拿裁决、原样返回——D1 的礼仪教训写进注释）；② skills 的 historyEmpty 注入条件以"批内是否已有内容"为准，与 memory 注入共存不冲突（两者都追加文本块，顺序 = 注册序）。真正的先后裁决权在 dsh 是注入 vs pre-step 已 claim 的批次（"may miss a request whose pre-step already claimed its batch"）——mini 同语义：排晚了就等下一个 claim 点。

## 5. 实现与验证记录

**文件**：`plugins/memory.ts`（新增）；`services/agents.ts`（AgentHandle.inject + pre-step payload `boundary`）；`services/llm.ts`（MODEL 常量迁入——插件 selector 旁调同源）；`agent.ts`（memoryPrefetch/alreadySurfacedMemories/sessionMemoryBytes 字段、buildSideQuery/consumeMemoryPrefetchIfReady/startMemoryPrefetchForTurn 方法、两处循环内调用点——全部消亡；inject() 落地）；`cordis-tests/d4-memory.test.ts`（新增 3 条）；c5/d1 测试 payload 补 boundary。

**验证**：cordis **131/131**（D4 新增 3 条：inject 排队/不唤醒/可 claim、沙箱 HOME + 假适配器全链（turn 边界触发 → selector → 注入文本含 `<system-reminder>` 与记忆内容）、寒暄三道门零调用）；mock **28 场景全绿**——**场景 8 零断言变更**：selector 一次、注入落 mainReqs[1].lastUserText（tool 批次 text 块）、未选记忆不进上下文、索引重建，全部原样通过。

**翻车记档**：
1. **删常量的手滑**：把 agent.ts 的 `const MODEL = ...` 行"替换"成了下一行的开头——制造出两个连续的 `const MODEL_CONTEXT` 声明。tsc 会抓，但编辑时**看一眼上下文再松手**比等编译器骂快。
2. **假适配器挂错路由**：单测把 fake 注册在 `'fake'` 路由，而插件的 sideCall 走缺省 `'anthropic'`——查表扑空、selector 静默失败（memory 的 fail-silent 把错误吃掉了），症状只是"没注入"。**测旁路链路时，先问它走哪条路由**；fail-silent 的组件，测试更要锚"调用发生"而不是只锚"没崩"。
3. **frontmatter 手滑第二春**：测试fixture 的 ` type: project` 前导空格让清单解析丢条目——D2 的"锚错层"之后又一个"规格抄错字面"变体。fixture 也要 diff 检查。

## 6. 自测三题（答案在文末）

1. inject 为什么不做唤醒？如果它唤醒，哪个机制会立刻变形？
2. 晚归的 prefetch（turn 结束后才落定）在新旧机制下各去哪？为什么新版不需要"排掉"逻辑？
3. 注入走 pushUser 的合并器进 tool_result 批次——这与 C4 的 mid-turn steer 走的是同一条路吗？两条需求（用户插话 vs 系统注入）共用管线，省了什么、混了什么？

> **答案**：
> 1. 唤醒 = inject 要对"开一个模型请求"负责——那它就是 steer，memory 召回会在 idle 时凭一条记忆拉起一整个 turn（无人请求的 API 调用）。不唤醒让 inject 保持"纯供给"：内容就位，消费时机归驱动。
> 2. 旧：下一 turn 开场的 consume-first 排掉（追加在下一 turn 用户文本后）；不排就永久丢。新：continuation 照样 inject 排队，下一个 claim 点（无论 step 还是 turn 边界）消费——"排掉"逻辑被"晚到也有效"取代，因为队列不怕晚。
> 3. 同一条（next-step → claimStep → merger 的批次追加 text 块）。省的是一整条注入管线（位置/形状/日志语义三处对齐只写一次）；混的是**身份**——日志里两者的 user/message 事件不可区分（都是文本块）。dsh 有 additionalContexts 专用身份；mini 记入差距清单（E1 UI 若要区分渲染注入与插话，需要在此补事件元数据）。

## 7. 下章预告（D5 compaction 插件化）

C3 立的规矩兑现：`SessionLog.derive` 支持 replace 投影（事件带 generation，derive 只取每节点最新代）；T1–T4 四层压缩从"原地改 this.messages"改为"追加 replace 事件"；SNIPPABLE_TOOLS 变工具元数据；/compact 直调压缩插件。验收：压缩场景请求体等价 + **原始事件未被修改**断言（"日志即真相"的终极验收）。
