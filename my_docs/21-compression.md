# 第二十一章：Agent 骨架 II——四层压缩（进阶轮第 6 章）

## 为什么替换旧压缩

ch14 真机发现 5 给旧 maybeCompact 判了死刑，两个错各占一半：

- **仪表错了**：`COMPACT_THRESHOLD = 6` 条消息。历史体量由**工具结果**主导（一次 grep 就能塞进几万字符），消息条数和 token 体量根本不成比例
- **位置错了**：检查在 while 顶——工具轮的中间。历史末尾是 tool_result，摘要重写把它切掉，前面的 tool_use 就孤儿化了（400）；而且任何 2+ 工具轮的对话都反复触发，每次只留最近 2 条，工具上下文全丢

ch20 已经把新仪表装好：`lastInputTokenCount = 本轮 prompt 全量 + 本轮输出`。本章装上四层压缩：**T1 budget → T2 snip → T3 microcompact → T4 auto-compact**（Claude Code 公开设计的移植，对齐 src/agent.ts:1106-1335）。

## 全景与调用点（骨架已接好，你写四个判定函数）

```
utilization = lastInputTokenCount / effectiveWindow
effectiveWindow = getContextWindow(MODEL) - 20000   // 安全边际给摘要请求自己留

T1 budget        循环顶·每次发请求前   0.5 门   收缩超大 tool_result
T2 snip          循环顶·每次发请求前   0.6/0.75 双门   同文件旧读去重 + 保最近 3
T3 microcompact  循环顶·每次发请求前   冷缓存门   只保最近 3，其余清空
T4 auto-compact  turn 边界·一条 chat 一次   0.85 门   摘要重写历史（唯一花 API 的层）
```

- T1–T3 在 `runCompressionPipeline()` 里（while 顶，`this.messages` 原地改写，零 API 成本）
- T4 在 `chat()` 开头 push 用户消息之后（`checkAndCompact()` → `compactAnthropic()`）
- `lastApiCallTime` 每次响应后更新（已接）——它是 T2/T3 判断**缓存冷热**的钟
- 旧 context.ts（maybeCompact）本章退役，已删除

## 设计点（写之前想清楚）

**1. 四层的成本阶梯**：T1–T3 是本地数组操作，零 API 成本，但信息有损（结果被剪掉）；T4 要花一次摘要调用，但有"摘要兜底"不丢主线。顺序 = 便宜的先上：**能靠剪枝撑过去的绝不摘要**。utilization 低时四层全静默——压缩是救火，不是例行打扫。

**2. 四条线（0.5 / 0.6 / 0.75 / 0.85）各有分工**：0.5 起 T1 开始收缩超大结果（utilization > 0.7 时预算从 30000 收紧到 15000——越挤越紧）；0.6 起 T2 剪枝；0.75 是 T2 的**热缓存覆盖线**；0.85 才动 T4。三线夹着 T2/T4 的间隔不是巧合：先给 T1/T2 充分的机会把 utilization 压回去，压不回去才轮到 T4 摘要。

**3. 缓存冷热与改写前缀的矛盾（本章最核心的权衡）**：prompt cache 按"前缀逐字节没变"命中。T2/T3 改写老 tool_result = 前缀变了 = 整条缓存作废，下一轮全量按 1.25x 重新写入。而改写省下的钱是"少带一些 token"。两边都是钱，所以分档处理：缓存热（5 分钟内用过）→ T3 完全不动、T2 忍到 0.75 才动手（那时溢出风险比缓存重建更贵）；缓存冷（5 分钟没人用，缓存反正要过期）→ T2 在 0.6 就动手、T3 放心大扫除。
**T1 为什么无门控？**——它处理的是"不缩就装不下"的巨块头（30KB 级），这种块留着的溢出风险远大于重建一次缓存；而且 T1 只在 utilization ≥ 0.5 才动手，平常压根不跑。

**4. T2 的两类剪枝**：①**同文件旧读去重**——read_file 同一 file_path 只留最后一次读（模型重读说明旧读过时了，旧结果纯属占地方）；②**保最近 3 条**（KEEP_RECENT_RESULTS）。两条都用"收集下标集合 → 最后统一替换"的写法，别边遍历边改。反查 tool_use 拿工具名和 file_path 用 `findToolUseById`（已给）。
**为什么只剪 SNIPPABLE_TOOLS（read/grep/list/shell）？**——这些结果"可再取"：剪了最多 re-read 一下就回来了，placeholder 里的提示语 `[Content snipped - re-read if needed]` 就是告诉模型这件事。write/edit 的结果剪了，模型就不知道自己改过什么——不可再取的不剪。

**5. T4 的硬不变式（与 ch20 refusal 配对同源：历史必须自洽）**：`compactAnthropic` 要 `slice(0, -1)` 把末尾消息摘出来最后塞回去——如果末尾是 tool_result，它前面的 tool_use 就没了配对，**摘要请求本身**直接 400。所以 T4 只能在 turn 边界调用（刚 push 完纯 user 文本），绝不能进 while 顶。重建完别忘了 `lastInputTokenCount = 0`——仪表不归零，下一轮立刻又超门，死循环触发摘要。`messages.length < 4` 也 return：太短的历史不值得花一次摘要调用。

**6. persistLargeResult：顺序是灵魂**——**先落盘，再生成预览/截断**。反过来的话：预览替换了上下文里的全量，而全量还没写盘，中途崩溃信息就真丢了。30KB 阈值；文件名带 `randomUUID().slice(0,8)` 防同一毫秒的并行写互相覆盖。落盘位置 `~/.mini-claude/tool-results/`（HOME 惰性求值的规矩不变）。
已知边界（思考题）：my_src 的 `executeTool` 在 50KB 就先截断了，所以 >50KB 的结果持久化的是截断版——src 是在截断**前**持久化的。要完全对齐，persist 应该放哪一层？想清楚记下来，ch22 前找我对答案。

**7. mock 的诚实盲区**：T3 要求"缓存冷 5 分钟"——mock 请求间隔是毫秒级，永远测不到 T3 真触发。这是测试驱动的已知边界，T3 靠 review 兜底（判定逻辑三层门控 + 排除两种 placeholder 的细节在 review 时逐条对）。能测的测透，测不了的承认，别造假绿。

## mock 场景说明

**ch7 迁移**（T4 沿 ch7 track）：旧场景的"4 次请求 + 文本 transcript"全部作废。新设计借 `--goal` 的 pursueGoal 循环制造多条 user turn（单 run 单次 chat 触发不了 turn 边界）：turn1 读三个文件（恰好 3 条结果——T2 保 3 静默、异文件不去重，**本场景零干扰只测 T4**），末响应注入 usage input=100000（100500 > 91800 = 0.85×108000）；evaluator 判 NOT_MET → 第二次 chat() 一进来 T4 触发 → 断言 compact aux 请求（新 contract anchor：system 含 `conversation summarizer`）携带真实 tool_result 块（不再是文本 transcript），重写后历史 = [summary, ack, feedback] 3 条。

**ch21 新场景两 run 共享 main track**（区间 t0-t2 / t3-t4，都是无条件消费，无 ch20 的轮次泄漏问题）：
1. **T1+T2**：bigfile ~20K 字符，t0/t1 响应注入 usage input=100000 → util ≈ 0.93 > 0.75（mock 毫秒级间隔缓存恒热，T2 只有越过热覆盖线才肯动）。断言：t1 请求旧读已被 T1 budget 化（T2 只有 1 条结果不剪）；t2 请求新读 budget 化、旧读整条变 placeholder（同文件去重——比"保 3"更精确地锚定判定逻辑）
2. **persist**：huge 45KB / 1000 行，usage 默认（压缩门全关）纯测持久化。断言上下文里只有预览（含首行、不含尾行——夹具必须多行，单行超长文件会让"200 行预览"变"全文"），HOME 沙箱 tool-results/ 落盘且含全量首尾

## 分步提示

1. `runCompressionPipeline`：三个调用各一行，顺序 T1→T2→T3（组装层 10 秒写完，但顺序错了后面全错）
2. `budgetToolResults`：先写两个 early return（utilization < 0.5；budget 分档 0.7），再双层循环（messages → Array.isArray(content) → tool_result 块），最后字符串替换。`block.content` 原地改写
3. `snipStaleResults`：双门控（cacheHot && utilization < 0.75 → return；utilization < 0.6 → return）→ 收集（带 msgIdx/blockIdx/toolName/filePath）→ 总数 ≤ 3 return → 两个剪枝下标集合 → 统一替换
4. `microcompact`：冷缓存门 → 收集（排除 SNIP_PLACEHOLDER 和 "[Old result cleared]" 两种）→ 保 3 清旧
5. `checkAndCompact`（门一行）+ `compactAnthropic`（照 agent.ts 注释七步骨架写）
6. `persistLargeResult`：契约四步照注释写，盯住"先落盘后预览"的顺序
7. `npm run build` → `node run-mock.mjs 21` → `node run-mock.mjs 7` → 全量 17 场景回归
8. 口答三题：①T1 为什么不用管缓存冷热而 T2 要？②T4 为什么不能放进 while 顶？③同文件去重为什么只对 read 这类工具有意义、对 write 意味着什么？

## 收尾记录（2026-09-20，代填轮）

- **本轮模式**：用户临时有事，明确要求代填整章实现层（"帮我完成代码的开发"）。按约定逐处讲解入档，供用户回补时对照；mock 场景与骨架此前已就位
- 交付：T1–T4 + persistLargeResult 全部落地（对齐 src/agent.ts 单后端等价），context.ts 退役，回归 **17/17 绿**（新 ch21 十断言 + 迁移 ch7 七断言 + 其余 15 章）

### 代填逐处讲解（回补时重点读）

1. **runCompressionPipeline**：三行组装，顺序 T1→T2→T3 = 便宜的先上；T4 不在这里（turn 边界专用）
2. **budgetToolResults**：两个 early return（util<0.5 直接走；>0.7 换 15K 档）→ 双层循环（user 消息 + Array.isArray(content) 才有块）→ 命中即**原地改写** `block.content`。`keepEach = (budget-80)/2` 的 80 是给标记字符串本身留的预算。无缓存门控的理由见设计点 3
3. **snipStaleResults**：双门控的**顺序**有讲究——cacheHot 是最便宜的布尔判断，放最前；收集时带 msgIdx/blockIdx 定位 + findToolUseById 反查工具名/file_path；两个剪枝来源（同文件去重、保 3）都往 `toSnip` 集合里塞下标，**最后统一替换**——边遍历边改会让下标错位
4. **microcompact**：收集时排除 SNIP_PLACEHOLDER **和** "[Old result cleared]" 两种占位符——已经清过的再收集会算进"最近 3 条"，把还活着的挤出去
5. **checkAndCompact/compactAnthropic**：门一行（`> effectiveWindow * 0.85`）；主体七步照骨架——`slice(0,-1)` 的不变式、摘要请求用非流式 create、重建 [summary, ack]、塞回末尾消息、**仪表归零**、`length < 4` 保护
6. **persistLargeResult**：`Buffer.byteLength`（字节 ≠ 字符串长度，中文内容差 3 倍）→ 落盘 → 才生成预览；文件名 `Date.now()-uuid8-toolName.txt`；返回值再过一遍 truncateResult 防单行超长的病态预览

### 场景设计三次翻车（教学价值最高的部分）

1. **T2 的提前 return 语义**：`results.length <= KEEP_RECENT_RESULTS` 时整个函数 return——**同文件去重在结果 ≤3 条时也不跑**（去重和保 3 是一票提前 return，不是两个独立开关）。原设计只读 2 次同文件，永远测不到 T2，改成 4 次读凑过阈值。教训：写场景前先把被测函数的所有 early return 列出来，别让断言锚在永远到不了的代码路径上
2. **多 run = 多进程 = 独立历史**：ch20 的"共享 main track"共享的是**轮次序列**，不是消息历史——每个 run 是独立 Agent 进程，历史各自从零开始。run2 的断言索引按"累计 5 条 tool_result"写（tr(6)[4]），实际 run2 只有 1 条（tr(6)[0]）
3. **ch7 消息计数**：3 轮工具 = 3 条 tool_result 消息（每轮 assistant+user 一对），compact 请求 = u1 + 3×(a,u) + a4 + 摘要指令 = 9 条，不是拍脑袋的 8。断言数字要么从消息流推出来，要么第一轮跑挂了看实际值对账

### 遗留与预告

- T3 microcompact 无 mock（要求真实 5 分钟时间流逝）——review 时逐条对过：冷缓存门、两种 placeholder 排除、保 3 清旧
- 思考题留档：>50KB 的结果会先被 executeTool 的 truncateResult 截断再进 persistLargeResult——持久化的是截断版，src 是截断**前**持久化。对齐修法（persist 挪进 tools 层或改 executeTool 返回结构）留给用户回补时定夺
- CONCURRENCY_SAFE_TOOLS 提前执行未纳入本章，顺延（不阻塞 22）
- 真机冒烟观察点（下次）：长对话下 T1/T2 改写历史的实际观感；persist 文件在真 HOME 的落盘

**commit message 建议**：`add four-layer compression and large result persistence`
