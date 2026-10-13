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

## 9. 代码执行流程图

> 对应提交 `5d360f7`。四条主线：两个投影事件与 fold 折叠规则 → append 纯追加化（合并迁投影层）→ CompactionService 四层与仪表 → agent 循环的 derive 驱动接线。

### 9.1 投影层：两个事件 + 一条折叠规则

```
新事件（SessionEvent 联合扩展）：
  { type:"message/replace", target: seq, content }   按 seq 定位，整条 content 换血
  { type:"history/truncate", reason }                投影清空，其后消息事件从零累积

fold()（derive()/nodes() 的共同底座）：
  system ← 最新一条 system/message
  nodes: FoldedNode[]、bySeq: Map<seq, node>
  for (evt, seq) of log:
    user/message | assistant/message:
      user 且 nodes 末节点也是 user？ → mergeUserContent 并入末节点   ★ 注记隔断也算相邻
      否则 → nodes.push({ seq, message })；bySeq.set(seq, node)
    message/replace:
      node = bySeq.get(target)；落空（truncate 后指向旧世界）→ 防御性跳过
      命中 → node.message = { ...node.message, content: clone(evt.content) }
             ★ 链式：后续 replace 看到前一 replace 之后的投影（T1 截断后
               T2 在截断结果上判剪——与旧原地顺序语义一致）
    history/truncate:
      nodes.length = 0；bySeq.clear()
    其余（tool/turn/meta）→ 注记，不进投影
  ★ seq = 事件下标，append-only 下永不重排——replace 的定位锚；
    消息序号会随 truncate/合并漂移，不能当身份用
```

### 9.2 append 纯追加化：合并迁投影层

```
旧 append()：
  onAppend（落盘）→ 连续 user 合并（判据：紧邻的上一条【事件】是 user/message）
  ★ 事件流里 user 之间常隔着注记（turn/start、turn/end）——
    事件视图 ≠ 消息视图，跨注记的两条 user 被判"不相邻" → 不合 → 400 隐患
    （ch27 探针：abort 后紧跟新 turn，投影 8 条 vs 期望 7）

新 append()：
  for fn of appendListeners: fn(evt)   落盘钩子照旧（原始流）
  this.log.push(evt)                    一行——纯追加，零合并

合并语义在 fold()：
  判据 = nodes 末节点是 user（【消息】视图），注记事件对合并透明
  mergeUserContent 逐字节旧语义：字符串拼字符串（\n\n）；批次宿主追加 text 块
  ★ 为什么不能改 append 救：append 侧合并要回改已落盘事件；JSONL 重放时
    注记照旧隔在中间、判不出相邻——在线视图 ≠ 重放视图，重放即发散。
    放 fold 则在线与重放执行同一条折叠规则，一致性是构造出来的
```

### 9.3 CompactionService：四层与仪表

```
仪表（自 agent 迁入）：
  lastInputTokenCount = usage.input + cacheRead + cacheCreation + output
  lastApiCallTime = Date.now()          recordUsage(usage)——每个 assistant 结算后
  effectiveWindow = getContextWindow(MODEL) - 20000（128k 模型 → 108000）

runPipeline()（每请求前，零 API 成本）：
  T1 budgetToolResults：util < 0.5 忍住；预算 = util > 0.7 ? 15000 : 30000
    tool_result 字符串超预算 → 掐头去尾（keepEach 各留一半 + 80 字节提示位）
    → appendReplace(node, next)
  T2 snipStaleResults：双门控——缓存热（<5min）且 util < 0.75 → return；
    util < 0.60 → return
    剪谁：tools.get(name)?.snippable（工具元数据自报——硬编码集合消亡）
    results.length <= KEEP_RECENT_RESULTS(3) → return（前 3 条期间同文件去重也不跑）
    ① 同 file_path 只留最后一次  ② 最老的 length-3 条
    → 按节点分组换 SNIP_PLACEHOLDER（别边遍历边改）
  T3 microcompact：缓存未冷（<5min）→ return
    所有 tool_result 只保最近 3 条，其余换 "[Old result cleared]"

checkAndCompact()（turn 边界，唯一花 API 的层）：
  lastInputTokenCount > effectiveWindow × 0.85？
    compact()：nodes < 4 → false
    尾部三分：纯文本 user → 摘要请求 = 历史去尾 + 指令，carryTail=true
             无工具 assistant → 历史全量 + 指令，carryTail=false
             tool 批次尾/未知 → fail-closed 不发（"ends mid-tool-batch"）
    sideCall 摘要（2048 tok）→ append 四连：
      history/truncate("compact") + user/message([Previous conversation summary]...)
      + assistant/message(text 确认) + [carryTail] user/message(tail 深拷贝)
    lastInputTokenCount = 0
```

### 9.4 agent 循环接线：derive 驱动，工作集消亡

```
消亡清单：this.messages、SNIPPABLE_TOOLS、四层实现体、压缩仪表字段、
          findToolUseById、pushUser/pushAssistant 的合并逻辑（缩成一行 append）

接线点（runOneTurn）：
  turn 开场：await compaction.checkAndCompact()        T4 门（与旧时机一致）
  pre-step payload：historyEmpty = messages.length === 0
    → 改为 derive().messages.length === 0               消息视图现算
  每请求前：compaction.runPipeline()                    T1–T3（时机照旧）
  组装：withCacheBreakpoints(sessionLog.derive().messages)   ★ 请求走投影
  结算：compaction.recordUsage(usage)                   仪表一行记账

其它读取点同源：
  get messages（分类器 transcript 等）→ derive().messages
  resume：repairUnclosedTurn 后不回填任何工作集——usage 扫描直写
          compaction.lastInputTokenCount；printInfo 计数走 derive
  /clear：this.messages = [] → compaction.lastInputTokenCount = 0
```

### 9.5 完整时序走查：场景 7（T4 truncate + 重建）与场景 21（T1→T2 链式）

```
场景 7——T4 主线（--goal 读三文件，turn1 末 usage input=100000）：
  turn1（t0–t3）：逐个 read a/b/c.txt，每次结算 recordUsage
    （100000+500 = 100500 > 91800 = 108000×0.85——仪表越线）
    T2 静默的根据：恰好 3 条结果 ≤ KEEP_RECENT，三文件不同也不触发去重
  turn1 收敛 → 评估器判 NOT_MET（goal track 第 1 轮）→ pursueGoal 二次 chat()
  turn2 开场 → checkAndCompact：0.85 门过 → compact()
    尾部三分：末条是 goal feedback（纯文本 user）→ 摘要请求 = 历史去尾 + 指令，
    carryTail=true
  req(compact track, 非流式)：
    ✓ 恰一次、messageCount 9（8 条 turn1 历史 + 摘要指令）
    ✓ 携带真工具结果（alpha..gamma——投影层出来的就是消息视图）
  回来后 append 四连：truncate + summary + ack + tail(feedback)
  req(t4, main)：
    ✓ messageCount 3（summary/ack/feedback——truncate 清了旧投影，
      三条新事件从零累积）
    ✓ firstUserText 含 "[Previous conversation summary]" 与 "a.txt=alpha"
  → 评估器判 MET → 停机

场景 21——T1/T2 的链式 replace（run1 五读）：
  t1 请求前 runPipeline：util ≈ 0.93 > 0.5 → T1 预算 15000
    r0（bigfile 首读 ~20K）超预算 → message/replace(target=r0.seq)
    T2：仅 1 条结果 ≤ 3 → 静默
  t2：r1（bigfile 再读）同款 budget 化——★ replace 链式：T2 若此际启动，
    看到的 r0 已是 budgeted 投影（与旧原地顺序语义一致）
  t3：r2/r3 小结果不超预算；T2 仍 ≤ 3 条静默 ✓（断言 tr(2) 无 SNIP）
  t4 前：4 条结果 > 3 → T2 启动（缓存恒热但 util 0.93 > 0.75 覆盖线）
    同文件去重：bigfile 两次读，旧读 r0 剪 → SNIP_PLACEHOLDER
    保最近 3：剪最老 1 条（也是 r0——两个剪枝指向同一目标）
    r1（同文件最新读）存活仍 budgeted ✓；小结果原样 ✓
    → 全部经 message/replace 落事件，日志本体未动一字
（run2 验 persistLargeResult：45KB 全文落 HOME 沙箱 tool-results/，
  上下文只剩 200 行预览——"结果进上下文之前"的事，跟压缩层无关）
```
