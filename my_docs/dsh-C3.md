# dsh-C3 会话事件日志 ★（本轮最核心）

> 本章产物：`services/session-log.ts`（SessionEvent 八类事件 + SessionLog：append 合并入口 / peekLastSystem / derive 纯投影 / load 回放 / clear）；agent.ts 全部消息操作改走日志（pushUser/pushAssistant 双写入口、system 对比去重 append、tool/turn/meta 注记）。
> 一句话：**会话 = 事件日志，请求参数是日志的投影而不是平行记账的另一份状态（model-visible ⟺ logged）。**
> 参照物：`packages/core/session/src/index.ts` 的 derive 段、`surface.ts`。

---

## 1. 八类事件与两种身份

| 事件 | 内容 | derive 消费？ | 身份 |
|---|---|---|---|
| `system/message` | **JSON 编码的 system 块数组**（含 cache_control） | ✅ 只取最新 | 线格式 |
| `user/message` | `string \| ContentBlockParam[]` | ✅ 原样 | 线格式 |
| `assistant/message` | content 块 + usage 四计数 | ✅ 原样 | 线格式 |
| `tool/call` | id/name/input | ❌ | 注记 |
| `tool/result` | callId/content/isError | ❌ | 注记 |
| `turn/start` / `turn/end(reason)` | 循环边界 | ❌ | 注记 |
| `meta/note` | mode 等非模型可见状态 | ❌ | 注记 |

**口径差异诚实记档**：真 dsh 的 derive 从 tool/call + tool/result **重组**消息（surface.ts），事件是唯一真相；mini 双记——user/assistant 事件携带线格式原样内容（请求体逐字节等价的最短路径），tool/turn/meta 是平行注记。代价是 tool 流量在日志里出现两次（assistant 的 tool_use 块 + tool/call 事件）；收益是 C3 的投影零重构风险。D5 压缩要**按块改写 tool_result** 时，tool/result 注记就是定位索引——双记的价值在那时兑现。

## 2. 双写架构与 D5 的缝

本章最难的决定：**请求体来源不换**。agent 的 `this.messages` 留在线上工作集，因为压缩层 T1–T4 会**原地改写**它（snip 置换、microcompact 清块、compact 重建）——而日志是 append-only 的。如果本章就把请求切到 derive()，ch21 的压缩场景立刻全挂（derive 会投影出改写前的原始内容）。

所以 C3 的架构是：**append 即双写**（`pushUser`/`pushAssistant` 统一入口，工作集与日志各进一份），压缩照旧改工作集，日志保留压缩前的原始流。两者的**发散点**被显式标注为 D5 的接管缝：

- derive 在 `user 事件 → MessageParam` 的映射处留挂点——届时按事件序号查投影表，被压缩改写的 tool_result 在投影层换皮，请求组装整体切到 derive；
- 本章用两条测试钉住缝的两端：derive 纯函数断言（重放一致）+ Agent 集成断言（loadHistory 后 `JSON(derive.messages) === JSON(history())`——无压缩会话中投影与工作集逐字节一致）。

## 3. derive 的三条规则

1. **纯函数**：只读事件流，重放任意次结果一致；返回深拷贝（调用方改写不污染日志）。测试对返回值动手脚后再 derive，内容不变。
2. **system 只取最新**：动态段（env/memory 索引/plan 提示）会变，旧 system 不进请求。append 侧配套**对比去重**——请求前 `JSON.stringify(buildAnthropicSystem())` 与 `peekLastSystem()` 比较，未变不重复 append（否则每次请求多一条事件，日志膨胀且违背"⟺"）。危险点的口径由此落实：日志里可能有历史 system 事件，derive 只取最新，请求体只有一份。
3. **注记不进请求**：tool/turn/meta 事件被 derive 显式忽略——测试验证"带注记的流与不带注记的流投影完全一致"。

**spec 偏差两处（类型为字节等价让路）**：
- `user/message.content` 收 `string | ContentBlockParam[]` 而非 spec 的纯数组——旧代码大量推 string 内容（chat 文本、contextCleared 重建消息），derive 原样输出才能逐字节等价；
- `system/message.content` 是 JSON 编码的块数组字符串而非裸文本+cacheBreakpoint 标志——system 是**两块结构**（静态块带 ephemeral 断点 + 动态块不带），单个 string+boolean 表达不了。

## 4. 连续 user 合并迁居 append 入口

旧 chat() 里藏着一个防 400 的合并器：budget 截停后历史末尾停在 user（tool_result 拒绝批次），新文本若直接 push 就是连续同角色（API 400 roles must alternate）。旧语义两种形态——字符串拼字符串（`\n\n` 分隔）、批次数组追加 text 块。C3 把它迁进 `SessionLog.append` 入口（roadmap step 5"保持在 append 入口处理，C4 迁给 inbox"），同时 `pushUser` 在工作集侧镜像同一套规则——**双侧同语义**，合并后两侧仍然一致。C4 的 inbox 接管后，日志侧的合并入口不动。

## 5. 与真框架的差距清单（C3 后）

| 能力 | 真 cordis/dsh | mini | 备注 |
|---|---|---|---|
| 事件类型八类 | ✅ | ✅ | content 形状两处偏差（第 3 节） |
| deriveMessages 纯投影 | ✅ 从事件重组 | ✅ 线格式直出 + 注记忽略 | 口径差异记档 |
| 请求 = 投影 | ✅（天然） | ❌ 工作集仍是请求源 | **D5 投影 replace** |
| usage 挂事件 | ✅ | ✅ 四计数 | agent 仪表仍独立累计（成本显示不受影响） |
| 会话持久化 = 日志落盘 | ✅ | ❌ autosave 仍存 messages 快照 | D 阶段 |
| 压缩 = 投影 replace | ✅ | ❌ T1–T4 原地改写 | **D5** |

## 6. 实现与验证记录

**文件**：
- `services/session-log.ts`（新增：SessionEvent/TokenUsage/SessionLog + Context merging）
- `agent.ts`（修改：sessionLog 字段与构造、pushUser/pushAssistant 双写入口、chat() 合并迁移、循环内 system 对比去重 + turn/start|end、assistant 携 usage、tool/call|result 注记四处、budget 拒绝批次注记、loadHistory 回放、clearHistory/clearHistoryKeepSystem 双侧清空、restoreSession 走 loadHistory、setMode meta/note、deriveSession 公开）
- `cordis-tests/c3-session-log.test.ts`（新增 8 条）

**验证**：
- `npm run cordis`：**84/84 绿**（C3 新增 8 条：纯函数、最新 system、注记忽略、合并双形态、usage 四计数、回放 round-trip、Agent 集成×2）
- 全量 mock 回归：**22/22 绿**——请求体逐字节等价（含 ch21 压缩场景，验证了"工作集留线上"决策的正确性）。

**翻车记档**（实现过程中真实发生）：
1. **spec 与字节等价的两次冲突**：事件 content 类型照 spec 写，derive 输出就会变样（string→数组换形、单块→丢 cache_control）。裁决：**验收口径（逐字节等价）> 规格字面**，类型偏离并在事件注释与本章文档双处记档。规格是路线图早期写的，真实代码的形状优先。
2. **"全部消息操作改走日志"的字面陷阱**：第一反应是把请求切到 derive——两分钟推演就撞上 ch21（T1–T4 原地改写）。roadmap 其实早有答案（"压缩的投影 replace 本章不做（D5），derive 留缝"），读规格时要**把"不做"当成设计**而不是省略。
3. **合并器藏在意想不到的地方**：连续 user 合并不在循环里，在 chat() 开头——预算截停后的 followup 才会触发。不从消费端（API 400）反推，这个语义很容易在迁移中被当成死代码删掉。

## 7. 自测四题（答案在文末）

1. user/message 的 content 为什么收 `string | blocks` 而不是 spec 的纯数组？"验收 = 请求体逐字节等价"如何反过来支配类型设计？
2. derive 为什么只取最新一条 system？如果投影全部 system 事件，请求体会变成什么样？
3. 压缩 T1–T4 原地改写工作集，日志为什么不跟着改？发散点在 D5 怎么闭合？
4. tool/result 注记在 derive 里被忽略，它存在的意义是什么？

> **答案**：
> 1. 旧代码的内容形状就是现状的一部分：chat 文本推 string、tool 批次推数组。derive 原样输出才能逐字节等价——把 string 规范化成 `[{type:'text'}]` 虽然语义相同，但请求体字节变了（还可能动缓存前缀）。**等价验收是最高约束，类型是它的下游**。
> 2. system 的动态段每轮可能变（memory 索引、plan 提示），请求只发一份；投影全部会把历史 system 全部塞进请求（体积爆炸 + 每次动态段变化都改变请求）。append 侧对比去重 + derive 侧取最新，两端合作保证"日志记了变化，请求只用当下"。
> 3. 日志是 append-only 的历史记录，压缩是对"当下上下文"的优化动作——历史不该被追改。D5 闭合：derive 在 user 事件 → MessageParam 映射处查投影表，被压缩改写的块在投影层换皮；届时请求组装整体切到 derive，工作集退役，发散点消失。
> 4. 三个用途：D5 压缩按 callId 精确定位要改写的 tool_result（线格式里的块没有稳定索引）；C5 循环事件化后工具遥测（耗时/结果元信息）挂在这里；诊断/回放时不用解析 assistant 块就能读出调用历史。双记的冗余是为这三件事预付的成本。

## 8. 下章预告（C4 Agent handle 与 inbox）

`services/agents.ts`：AgentRegistry + AgentHandle（send/followup/cancel，idle/running/maintenance 三态）；inbox 双队列（next-turn/next-step）与 claim 语义（turn 边界 = 全部 next-step + 恰一条 next-turn）；cli.ts 输入改走 handle；新增 mid-turn 注入场景验证"工具执行间隙 send 的文本出现在下一 step 请求体"。

## 9. 代码执行流程图

> 对应提交 `a8265e3`。三条主线：pushUser/pushAssistant 双写入口 → append 入口的连续 user 合并 → 循环内注记挂点 → derive 纯投影。

### 9.1 挂树与双写入口

```
Agent 构造（沿用 C1 7.1 的树）追加：
  new SessionLog(ctx, "session-log")     内部 log: SessionEvent[]，八类事件

消息操作统一入口（工作集 + 日志各进一份）：
  pushUser(content)
    ├─ 工作集：末条是 user？ ──是──→ 原地合并（string 拼 \n\n / 批次 push text 块）
    │                        └─否──→ messages.push({role:'user', content})
    └─ 日志：sessionLog.append({type:'user/message', content})
          ★ 两个分支都走 append——工作集合并了旧消息，日志侧在 append 入口
            做同一套合并（9.2）。双侧同语义，合并后仍逐字节一致
  pushAssistant(content, usage?)
    ├─ 工作集：messages.push({role:'assistant', content})
    └─ 日志：append({type:'assistant/message', content, usage})
          usage 四计数（input/output/cacheRead/cacheCreation）只挂日志事件，
          请求体不含 usage——仪表照旧走 agent 的独立累计

旁路操作（不产消息，只动状态）：
  setMode            → append(meta/note, key='mode')        注记，不进请求
  loadHistory(msgs)  → this.messages = msgs + sessionLog.load(msgs)   回放 9.4
  restoreSession     → 改走 loadHistory（恢复路径统一收口）
  clearHistory / clearHistoryKeepSystem → messages=[] + sessionLog.clear()  双侧清空
```

### 9.2 append 入口：连续 user 合并（防 API 400）

```
SessionLog.append(evt)
  evt.type === 'user/message'？
    └─ 是 → 末条事件也是 user/message？
          ├─ 是 → 原地合并，不 push：
          │     两侧都是 string → last.content += '\n\n' + evt.content
          │     否则（数组/混形）→ blocks.push({type:'text', text: evt.content})
          │     ★ 与迁移前 chat() 的合并行为逐字节一致（budget 截停后
          │       历史末尾停在 tool_result 批次上，followup 直推就是
          │       连续 user → roles must alternate 400）
          └─ 否 → 落入 push
  其余事件 → log.push(evt)

derive().messages 里只见一条 user——合并发生在事件层，投影天然不重复
```

### 9.3 循环挂点：runAgentLoop 的事件注记

```
while (true) {
  append(turn/start)
  runCompressionPipeline()      T1–T4 原地改写工作集；日志不动——发散点即 D5 缝
  systemBlocks = buildAnthropicSystem()
  JSON.stringify(systemBlocks) !== peekLastSystem()？
    ├─ 是（含首轮 undefined）→ append(system/message, 编码块数组)
    └─ 否 → 跳过                对比去重：动态段未变不重复记
  stream 请求：messages = withCacheBreakpoints(this.messages)
                              ★ 请求源仍是工作集，不是 derive()——D5 前不动
  响应完成 → usage 四计数 → pushAssistant(response.content, usage)
  toolUses.length === 0？
    └─ 是 → append(turn/end, 'end-turn') → 打印成本 / autoSave → break
  checkBudget() 超限？
    └─ 是 → append(turn/end, 'budget')
            pushUser(toolUses.map(tu => {
              append(tool/result, callId, 'not executed', isError)   拒绝批次注记
              return {type:'tool_result', ...}
            }))
            autoSave → break        日志顺序：turn/end → tool/result×n → user 批次
  append(turn/end, 'tool-use')
  for tu of toolUses:
    append(tool/call, id, name, input)
    executeCall → denied / 抛错 / 正常 三出口，各自 append(tool/result, isError?)
  pushUser(toolResult 批次) → 回循环顶（下一轮 turn/start）
}
```

### 9.4 derive / load / clear：投影与回放

```
derive()  纯投影：事件流 → 请求参数
  for evt of log:
    system/message → system = JSON.parse(evt.content)   逐条覆盖 → 天然只剩最新
    user/message   → messages.push({role:'user',   content: clone(...)})
    assistant/...  → messages.push({role:'assistant', content: clone(...)})
    其他（tool/call|result、turn/*、meta/note）→ 忽略
  clone = JSON round-trip → 调用方改写不污染日志；重放任意次结果一致

load(messages)  回放（session 恢复路径）：
  log 清空 → 逐条 append(user/message | assistant/message)
  usage 不可考，不带——round-trip 验收只对消息形状

clear()  清空 log——clearHistory / clearHistoryKeepSystem 双侧清空的日志半边
```

### 9.5 完整时序走查：一轮带工具调用的会话

```
场景：用户发 "run it" → 模型调 run_shell(echo hi) → 回灌结果 → 模型回 'done' 收尾
（消息形状即 c3-session-log.test.ts「注记事件不进请求投影」那条）

动作（工作集）                    日志事件（按 append 顺序）
──────────────────────────      ────────────────────────────────────
chat('run it') → pushUser       E1  user/message('run it')        末条非 user，直推
轮 1 循环顶                     E2  turn/start
system 首次：peekLastSystem()   E3  system/message(JSON 块数组)
  = undefined ≠ 编码 → append
模型回 [tool_use t1]            E4  assistant/message(content, usage 四计数)
  pushAssistant
有工具 → 预算未超               E5  turn/end(reason:'tool-use')
executeCall(t1)                 E6  tool/call(t1, run_shell, {command:'echo hi'})
                                E7  tool/result(t1, 'hi')
toolResult 批次回灌             E8  user/message([{tool_result t1,'hi'}])
  pushUser(批次)：末条是 assistant → 工作集直推，日志无合并
轮 2 循环顶                     E9  turn/start
system 对比：编码 === E3 内容    （跳过——对比去重，未重复 append）
模型回 'done'（无 tool_use）    E10 assistant/message('done', usage)
  pushAssistant                 E11 turn/end(reason:'end-turn') → break

derive() 投影（消费 E1/E3/E4/E8/E10，注记 E2/E5/E6/E7/E9/E11 全忽略）：
  system   = [静态块(ephemeral 断点), 动态块]        ← 只剩最新一条（仅 E3）
  messages = [
    {role:'user',      content:'run it'}                        ← E1
    {role:'assistant', content:[tool_use t1]}                   ← E4
    {role:'user',      content:[tool_result t1 'hi']}           ← E8
    {role:'assistant', content:[text 'done']}                   ← E10
  ]
  ★ Agent 集成断言：JSON(derive.messages) === JSON(history())——
    无压缩会话里投影与工作集逐字节一致，双写的两端被测试钉死
```
