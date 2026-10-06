# dsh-D5 压缩四层的事件化——"日志即真相"的兑现章

> 本章产物：`plugins/compaction.ts`（CompactionService）；`message/replace` + `history/truncate` 两个投影事件；`SessionLog.fold()/nodes()`（带 seq 的折叠中间态）；`snippable` 工具元数据；agent.ts 的 `this.messages` 工作集与压缩仪表字段全部消亡，请求组装走 `derive()`。
> 一句话：**压缩不再改历史，只追加投影——日志本体从 C3 的"镜像"升格为唯一存储（single source of truth）**。
> 参照物：dsh 的 surface 替换投影（packages/core/session 的 replace 语义）。

---

## 1. 旧世界的结构性矛盾

C3 立的是双写：工作集 `this.messages` 发请求，日志做追加镜像。压缩四层（T1 budget → T2 snip → T3 microcompact → T4 compact）**原地改写工作集**——日志里存的永远是全文。于是：

1. **发散点即失真点**：请求里模型看到的是 budgeted/snipped 的内容，日志里是原文——"日志即真相"对压缩后的会话不成立。
2. **resume 丢压缩**：C8 的恢复走 `load(messages)` 回放，恢复出来的是日志全文 → 压缩成果在重启后清零，token 仪表归零但历史膨胀如初。
3. **仪表无家**：`lastInputTokenCount / lastApiCallTime / effectiveWindow` 挂在 agent 上，只服务压缩决策，却让 agent 类持续变胖。

## 2. 新机制：两个事件 + 一条折叠规则

```
T1 budget ─┐
T2 snip   ─┼─► append({type:"message/replace", target: seq, content})   零 API 成本
T3 micro  ─┘
T4 compact ──► append({type:"history/truncate"}) + 重建消息事件（user 摘要/assistant 确认/carry tail）
                                            │
                                            ▼
            fold(): 事件流 ──投影──► FoldedNode[]{ seq, message }   ← nodes()/derive() 的共同底座
```

- **`message/replace`**：按 `target = 事件在 events[] 里的下标` 定位一条消息事件，整条 content 换血。**链式**——后续 replace 看到前一 replace 之后的投影，与旧原地顺序语义一致（T1 截断后 T2 在截断结果上判剪）。
- **`history/truncate`**：投影清空（nodes/bySeq 双清），其后的消息事件从零累积。T4 的重建 = truncate + 三条新消息事件，与旧 `this.messages = [summary, ack, tail?]` 同形。
- **FoldedNode.seq 是稳定身份**：append-only 下事件下标永不变，replace 的 target 因此可靠；truncate 之后指向旧世界的 replace 被防御性跳过（`bySeq.get` 落空即弃）。
- **仪表跟层走**：三个压缩仪表字段迁入 CompactionService，agent 经 `recordUsage(usage)` 记账——agent 循环只剩一行，不再持有压缩状态。

**snippable 元数据**：硬编码 `SNIPPABLE_TOOLS = new Set(["read_file",...])` 变成 ToolDefinition 的 `snippable?: boolean`，注册点自报——T2 剪谁由 `tools.get(name)?.snippable` 判，与 deferred/permissionHint 同一模式（能力即注册表数据）。

## 3. 日志本体只增不改：红线与验收

replace/truncate 都是**追加**的事件，不是对旧事件的修改。验收锚：ch7/ch21 场景全部断言零变更照常通过（T4 门 0.85×108000、T2 双门控 0.60/0.75、T3 冷缓存 5min、KEEP_RECENT=3，数值一根未动）；resume 路径（ch4/ch32）在 derive 组装下照常续接。

旧 append 里的**就地合并被拆掉**是同一红线的延伸：`append()` 现在纯追加，合并语义整个迁去 `fold()`（见 §4）。

## 4. 问题记录：ch27 抓到的合并语义回归（本章最有价值的 review 发现）

**现象**：ch27 phase3 断言挂——queued followup 的请求 messageCount 8 ≠ 期望 7。

**根因**：连续 user 的合并（防 roles-must-alternate 400）原来长在 `append()` 入口，判据是"紧邻的上一条**事件**是 user/message"。但事件流里 user 消息之间常隔着注记事件：

```
12 user/message "cancel me"
13 turn/start          ← 注记隔断
14 turn/end(aborted)   ← 注记隔断
15 user/message "phase three a"   ← append 判"上一条是 turn/end"，不合！
```

老世界 `this.messages` 里**没有注记**，两条 user 在消息视图里相邻，`pushUser` 照合（7 条）；D5 后请求走 `derive()`，合并还盯事件相邻性 → 投影出 8 条。**这正是合并注释里要防的 400 场景**——ch27 的探针（abort 后紧跟新 turn）恰好踩中。

**修法与原则**：合并迁进 `fold()`——按**消息视图**判相邻（`nodes` 末节点是 user 即合），注记事件对合并透明；`mergeUserContent` 保持逐字节旧语义（字符串拼字符串 `\n\n`；批次宿主追加 text 块）。**为什么不能反过来改 append**：append 侧跨注记合并意味着回头改已落盘的事件，JSONL 重放时（事件逐条回放、注记照旧隔在中间）会判不出相邻——重放即发散。放 fold 则在线与重放执行同一条折叠规则，重放一致性是**构造出来**的，不是测出来的。

**教训**：C3 时代的"双侧镜像"要求两边语义逐字节一致，但注记事件的存在让"事件视图"与"消息视图"天然不同构——凡是语义应该以消息为准的规则（交替约束、合并），判据必须放在消息视图上。工作集退役后，这个视图的唯一来源是 fold。

## 5. 遗留与接线

- `pushUser/pushAssistant` 缩成一行 `append`——双写镜像的历史使命结束，注释同步改口。
- resume 路径不再 `derive()` 回填任何工作集，`repairUnclosedTurn` 后直接用日志；usage 扫描结果直写 `compaction.lastInputTokenCount`。
- T1–T3 每请求前跑 `runPipeline()`，T4 仍只在 turn 边界检查（`checkAndCompact`）——时机语义与旧世界一致，未动。
- persistLargeResult（>30KB 落盘）留 agent——它管的是"结果进上下文之前"的事，跟层无关。

## 6. 实现与验证记录

**文件**：`plugins/compaction.ts`（新增——四层 + 仪表整体迁入）；`services/session-log.ts`（`message/replace`/`history/truncate` 事件 + `FoldedNode`/`fold()`/`nodes()` + 投影层合并 `mergeUserContent`，append 纯追加化）；`services/tools.ts`（`snippable` 元数据）；`plugins/core-fs-tools.ts`/`core-exec-tools.ts`（read_file/list_files/grep_search/run_shell 自报 snippable）；`agent.ts`（this.messages、lastInputTokenCount/lastApiCallTime/effectiveWindow、SNIPPABLE_TOOLS、四层实现体、findToolUseById——全部消亡；compactionPlugin 挂树）。

**验证**：cordis **131/131**；mock **27 场景全绿**——场景 7（T4 门/摘要请求形状/重建后 3 条历史）与场景 21（T1 双档预算、T2 双门控 + 保最近 3 + 同文件去重、persistLargeResult）**零断言变更**，压缩语义等价的验收在此兑现；场景 4/32（resume/持久化）在 derive 组装下照常。ch15 一次偶发失败连跑 3 次复验排除（27 个进程连跑的资源抖动，非代码问题）。

**翻车记档**：
1. **合并语义的归属错位**（§4 详述）：append 按紧邻**事件**判相邻，注记隔断即失效——ch27 探针（abort 后紧跟新 turn）踩中，投影 8 条 vs 期望 7。修法：合并迁 `fold()` 按消息视图判。教训：**交替性约束这类"消息视图的规则"，判据必须放在消息视图上**；投影层是唯一合法的家。
2. **事件类型比消息类型严**：`assistant/message` 事件的 content 只收 `ContentBlockParam[]`（要挂 usage），裸字符串过不了 tsc——compact 重建的 ack 消息得包成 text 块。MessageParam 允许 string 是 API 层的宽容，事件层没理由继承。
3. **全量回归要连跑两遍**：循环里 ch15 的偶发失败（断言全过但 exit=1）单跑即消失。并行场景共用端口/临时目录时，**单跑复验再定性**，别急着改代码。

## 7. 自测三题（答案在文末）

1. 为什么 `message/replace` 的 target 用"事件下标（seq）"而不是"消息序号"？truncate 之后指向旧世界的 replace 会发生什么？
2. T2 snip 有两道门（0.60 阈值 + 0.75 热缓存覆盖线）。为什么缓存热时 0.60–0.75 之间要忍住、超过 0.75 又允许改写？
3. 连续 user 的合并在 fold 做、不在 append 做——如果反过来，JSONL 重放会怎么发散？

> **答案**：
> 1. append-only 下事件下标永不重排——seq 是日志本体的稳定身份；消息序号在投影里会随 truncate/合并漂移（合并后两条事件共享一个消息位），按它定位等于按漂移物定位。truncate 后 bySeq 清空，`bySeq.get(target)` 落空 → replace 被防御性跳过（旧世界的投影不再响应新事件，也不会误伤新世界的节点）。
> 2. 改写老结果 = 请求前缀变化 = 缓存失效重建（下一次请求按未缓存价重算整个前缀）。utilization 未过覆盖线时，溢出风险还没大到值得付重建成本——忍住；过了 0.75，再溢就要动 T4（花一次真 API 摘要）了，两害相权：便宜的一次缓存重建 < 贵的摘要请求 + 更早进入 compact 世界。三线（0.60/0.75/0.85）本质是"三种代价的排序"。
> 3. append 侧合并要把后到的 user 内容**回改进已落盘的事件**（前一条 user/message 的 content）。落盘在 append 前发生（onAppend 先于合并改动），磁盘上永远是合并前的样子；重放逐条 append，"跨注记找上一条 user"的扫描在重放时同样被注记隔断——在线视图（合并过）≠ 重放视图（没合并），resume 后请求体就变了。fold 侧合并则对同一事件流恒等，重放一致性是构造出来的。

## 8. 下章预告（D6 goal/loop/auto 收尾）

C5 已把 goal（turn-stopping 挽留）和 loop（turn-end 定时调度）迁成监听器，D6 清尾：`schedule_wakeup` 的字段回传协议换成 `ctx.schedule` 服务（loop 驱动读字段的缝消失）；三态 goal 评估器、两段 auto 分类器、动态 loop 以监听器身份收口——agent 循环里不再有 `if(mode===...)`/`if(goal)`/`if(loop)` 的分支残留。验收：对应场景（7/15/26/29 等）全绿。
