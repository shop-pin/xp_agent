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
