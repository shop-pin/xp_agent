# 第二十章：Agent 骨架 I——MCP / 重试 / token 预算（进阶轮第 5 章）

## 为什么是"骨架"章

前 19 章的 agent 能力都在长（工具、权限、会话、自治），但骨架有三块短板：

- **不可靠**：一次 429/断连就整个 `chat()` 炸掉。生产里限流是常态，必须有重试层
- **外部工具单一**：MCP 写死单连接 + env 变量启动，没有配置文件、没有超时、server 挂了挂起调用永远悬着
- **不经济**：没有 token 记账，没有预算上限——agent 陷入循环时只会无限烧钱

本章三件事相对独立：**withRetry**（可靠性）、**McpManager**（外部工具）、**token/预算**（经济性）。

## 你写的三处（骨架已在代码里）

| 部分 | 位置 | 骨架给到什么 |
|------|------|-------------|
| `isRetryable` + `withRetry` | `my_src/retry.ts`（新文件） | 完整契约注释；stub 直通（失败原样抛） |
| `withTimeout` | `my_src/mcp.ts` | 完整骨架三段式写在注释里，你抄懂再落笔 |
| budget 检查点 | `my_src/agent.ts` `chat()` | **没有任何代码标记**——选位本身就是题（见设计点 4） |

Claude 已完成：mcp.ts 全量重写（McpConnection/McpManager）、agent 其余接线（token 四计数、getCurrentCostUsd/checkBudget、cache_control、SDK 重试 env、close()）、cli `--max-cost/--max-turns`、驱动 failWith 注入、ch20 场景 + ch12 迁移。

## 设计点（写之前想清楚）

**1. isRetryable 的三层原料**
错误对象上可用的信息分三层，各一行 return：`status`（HTTP 层：429 限流、503 不可用、529 overloaded）、`code`（网络层：ECONNRESET/ETIMEDOUT——连接没走完，天然可重试）、`message`（兜底：部分网关把限流写进文本，含 "overloaded"）。为什么 401/400 不可重试：客户端错误重试一万次也是同一个错，重试只救**暂时性**失败。

**2. 退避公式：`Math.min(1000 * 2^attempt, 30000) + Math.random() * 1000`**
两个成分各有含义：指数增长但封顶 30s（第 5 次重试不该等 32 秒）；+0~1s 随机抖动防**惊群**——服务端恢复瞬间，一千个客户端同时重试会把它再次打挂。循环骨架：`for(;;) + try { return await fn() } catch`——循环没有出口条件，出口全在 catch 的 throw 里（重试满/不可重试）。

**3. SDK 双层重试陷阱（本章最重要的测试坑）**
Anthropic SDK 自带 maxRetries=2。注入 429 后 SDK 先吞掉自己重试——你的 withRetry **永远等不到失败**，mock 里场景会假绿（SDK 重试拿到的下一个 scripted turn 恰好是对的），真机上则是双层退避叠加拉长尾延迟。所以 `MINI_CLAUDE_SDK_MAX_RETRIES=0`（agent 构造器已接）在测试里隔离两层；生产里也可以用它关掉 SDK 层、只留自己这层。另注意调用点形状：`withRetry` 包住的是"**建流 + 等完整消息**"整个函数——重试时旧流已死，必须重建流，不能只重试 `finalMessage()`（我已接好，看 agent.ts chat()）。

**4. budget 检查点选位（没有代码标记，你定）**
`chat()` 的 while 循环里有两个候选位置：

- **A：循环顶（发请求前）**——上一轮 tool_result 已配对入历史，break 历史天然合法，**不需要 refusal 配对**；还省下一次请求。代价：检查发生时上轮的工具已执行完（无副作用工具无所谓，但若是 write 呢——钱花完了才停）
- **B：响应后、工具执行前（src 的位置，agent.ts:1718 附近）**——响应里躺着 N 个 `tool_use`，break 前必须给每个配对一条拒绝 `tool_result`（`Tool call not executed: <reason>`），否则历史里挂着没有回应的 tool_use，**下一次** API 调用直接 400

**解答（2026-09-18 补，选位前先读懂再落笔）**

①**"响应已解析、工具未执行"时刻 break，历史末尾悬着什么？**
一条 assistant 消息，里面挂着 N 个 `tool_use` 块，没有任何 `tool_result` 回应。这份历史的两个消费者命运不同：`transcriptText()`（goal 评估器用）是渲染层，容忍这种历史；但**下一次 `chat()` 会把它原样发回 API**——Anthropic 的硬约束是每个 tool_use 必须紧跟配对的 tool_result，否则 400 invalid_request_error。更隐蔽的是 `autoSave()` 会把这份非法历史写进 session，`--resume` 复用时再炸一次。所以 break 前必须给每个 tool_use 补一条拒绝 tool_result（内容 `Tool call not executed: <reason>`，reason 用 checkBudget 的返回值），作为一条 user 消息推进历史再停。这样历史自洽，模型若继续对话还能"看到"为什么没执行。

②**`currentTurns` 递增点：A 请求前 vs B 响应后（src 选 B，agent.ts:1719）**
- **B**：currentTurns = 工具轮数，`--max-turns 3` = 最多 3 次"模型要求干活"。纯文本收尾轮不计数（它之后循环自然结束，计不计无所谓）。代价：检查时本轮响应的费用**已经付了**——但这不可免，费用数据只在响应后才存在，任何选位都一样
- **A**：currentTurns = 请求轮数，超限时连请求都不发（省一次调用），历史天然合法、无需配对。代价：拦的是"下一次请求"而不是"这批工具"，多执行的那轮工具已经跑完

两个位置都能过 ch20 的 mock 断言（read 是无副作用工具，多读一次不可见）。src 选 B 的理由：拦截语义更精确——预算管的是"干活的总账"，每个 tool_use 要么执行要么拿到明确的拒绝回执，历史永远自洽；A 省的那次请求费用有限，却让"拒绝"变成沉默的停机。**推荐按 B 写**（配对三件套正好是本题的陷阱教学点）：

```ts
this.currentTurns++;
const budget = this.checkBudget();
if (budget.exceeded) {
    printInfo(`Budget exceeded: ${budget.reason}`);
    this.messages.push({
        role: "user",
        content: toolUses.map((tu) => ({
            type: "tool_result" as const,
            tool_use_id: tu.id,
            content: `Tool call not executed: ${budget.reason}`,
        })),
    });
    return; // while(true) 里 break 等价
}
```

插的位置自己对照 agent.ts 的 268（assistant push）/ 272（空检查）/ 328（tool_result push）三行决定——选 B 就是 272 之后、工具循环之前。

**5. withTimeout 的无泄漏 race（mcp.ts）**
裸 `Promise.race([promise, 超时promise])` 的 bug：promise 先赢后 setTimeout **还在排队**——它会拖住 Node 事件循环直到毫秒到点（进程退不出去；mock 场景跑完后会凭空挂 15 秒才结束）。解法三段式：`try { return await Promise.race([...]) } finally { clearTimeout(timer) }`——finally 保证无论谁是赢家（含异常）定时器都被拆。超时只加在 `initialize`/`listTools` 上，**不加在 callTool**：长任务工具跑几分钟是合法的，工具调用超时是错误设计。

**6. token 四计数**
`input_tokens` 只算**未命中缓存的前缀**；`cache_read_input_tokens`（0.1x 计费）和 `cache_creation_input_tokens`（1.25x）单列。混在一起费用必错。费用公式：$3/M 输入、$0.3/M 缓存读、$3.75/M 缓存写、$15/M 输出。`lastInputTokenCount = 本轮 prompt 全量 + 本轮输出`（输出会成为下轮请求的一部分）——这是 ch21 压缩仪表的原料，本章只记账不使用。

**7. cache_control 两处断点**
`system` 从字符串升级为块数组：静态主体（指令+环境）打 `cache_control: ephemeral` 断点，动态尾巴（memory 召回）放断点后——断点前的所有内容（含工具 schema）命中服务端前缀缓存。消息侧：`withCacheBreakpoints` 返回**拷贝**，最后一条消息的最后一个 block 打断点——纯函数是硬约束，持久历史（session 存档/compact）掺进 cache_control 元数据就是数据污染。两个细节：thinking 块内容不稳定，跳过不标；每次请求 system 1 个 + 消息 1 个断点，远低于 API 上限 4。**真机观察点**：智谱 Anthropic 兼容层对 cache_control 的容忍度待冒烟验证，若报 400 需加 opt-out 门控。

**8. McpManager：三处合并与前缀路由**
配置三处合并后者覆盖：`~/.claude/settings.json` → `.claude/settings.json` → `.mcp.json`（Claude Code 惯例）。与 ch19 权限规则同一读取套路。工具名前缀 `mcp__<server>__<tool>` 拆解时用 `parts.slice(2).join("__")` 而非 `parts[2]`——tool 名自身可能含 `__`。对比 ch12 单连接版的升级：pending Map 从只存 resolve 升级为 `{resolve, reject}`，**进程 exit 时逐个 reject** 挂起请求（否则 server 死了调用永远悬着）；单 server 失败不拖垮整体。

## mock 场景说明（ch20）

一个场景三 run，共享 main track（同 ch19 模式），`envSdkRetries: 0` 全程封 SDK 重试。**run 顺序有讲究：retry 必须排在 max-cost 之前**（见收尾记录的教训）：

1. **双 server**：`.mcp.json` 声明 demo + demo2（同一 server 脚本起两个进程）。断言两个前缀都广告 + `mcp__demo2__add(20,22)` 的 42 正确回流（路由到对的连接）
2. **重试**：t2 注入 429（驱动新增 `failWith` 能力：响应错误体、计数器照常前进，重试自然落到下一 turn）。断言恰好一次 429 + 无 run crash + 重试后 read 真执行了
3. **max-cost 截停**：每轮 usage 压到 input=100000/out=500（$0.3075/轮），`--max-cost 0.5` → 第二轮响应后累计 $0.615 超限。断言 **t7 从未被请求**（超限后的收尾文本）+ 第一次 read 已执行（检查点不在"响应前"）

总请求数 7 = 2 + 3 + 2。

注意驱动侧三个配合改动：`run_crashed` 事件（单 run crash 不再中断后续 verify）；`firstUserText` 提取兼容 block 数组（cache_control 把最后一条消息的字符串 content 规范化成了块数组，ch3/ch9/ch10 曾因此误红）；修复 verify 双调用（runs 分支与尾部各调一次，ch20 断言打印两遍暴露）。

## 分步提示

1. `isRetryable`：三个检查各一行 return，顺序 status → code → message（最结构化的先判）
2. `withRetry`：先写骨架 `for(;;) + try/catch`，再填 catch 里的四件事：判满 → 判可重试 → 算退避打印 → 睡
3. `withTimeout`：注释里的三段式骨架照抄一遍，抄完合上注释自己再写一遍——这个模式要长在手上
4. budget 检查点：先口答设计点 4 的两个问题，再动笔；写完自问"超限那一刻历史里悬着什么"
5. `npm run build && node run-mock.mjs 20` → 全量回归 16 场景
6. 口答三题：①SDK 自带重试为什么在测试里必须关掉？②为什么 callTool 不加 15s 超时而 initialize/listTools 加？③选位 A 和 B 各牺牲了什么？

## 收尾记录（2026-09-18）

- 交付：isRetryable/withRetry（用户首写，review 两轮修 5 处后过）、withTimeout（用户首写，骨架三段式正确）、budget 检查点（解答写入设计点 4 后用户选择代填，位置 B 落地）、回归 16/16 绿
- 用户首写的坑（按教学价值排序）：
  1. **位或 `|` 冒充逻辑或 `||`**：`error?.status | error?.statusCode` 恰好对单字段场景"看起来能跑"（`429 | undefined = 429`），双字段不相等时产出怪值——巧合正确比报错更危险，判断逻辑永远用 `||`
  2. **可选链保护链断裂**：`error?.message.includes(...)` 的 `?.` 只护到 message 为止，message 为 undefined 时 `.includes` 照样炸——链上每个可空环节各自 `?.`
  3. **重试次数差一**：`attempt > maxRetries` 放行第 4 次重试（共 5 次调用）。钉死语义：attempt 是"已完成的重试次数"，允许重试的条件是已重试**少于**上限（`>=` 才对）
  4. 变量名错位（catch 起名 `e`、正文用 `error`——编译期就暴露）、withTimeout 尾部残留死代码 `return promise;`
- 代填讲解：
  1. budget 检查点（位置 B）：见设计点 4 解答——核心是 refusal 配对，"停下来"不难，"停下后历史仍然自洽"才是本题
  2. withRetry 调用点包"建流 + finalMessage"整体：重试时旧流已死必须重建流
- **场景设计教训（本章最大坑）**：共享 main track 的轮次计数器**不会跳过 turn**。原设计把 failWith 轮放在 max-cost 收尾轮之后——检查点正确地不消费收尾轮时，下一个 run 会把该轮捡走，429 永远注入不到（实测：run3 直接拿到收尾文本、fails=0）。修复：run 重排为 双server → retry → max-cost，各 run 的轮次区间（t0-1 / t2-4 / t5-6，t7 留给截停断言）互不越界。**教训：多 run 共享轮次时，"条件性消费"的 turn 会泄漏给后续 run——把不可控长度的 run 排最后，把截停断言锚在最后一轮**
- 驱动修复两处：verify 双调用（runs 分支内 + 尾部各一次，断言打印两遍暴露——改后两分支各自 close+verify）；firstUserText 兼容 block 数组（cache_control 副作用，ch3/9/10 误红）
- 真机冒烟观察点（下次冒烟必查）：智谱 Anthropic 兼容层对 cache_control 的容忍度——报 400 则加 opt-out 门控
- 下一章 ch21 预告：4 层压缩（T1 budget→T2 snip→T3 microcompact→T4 auto-compact），本章的 lastInputTokenCount 是它的仪表原料；CONCURRENCY_SAFE_TOOLS 提前执行落地时要回头重审 ch18 的单回合批量场景
