# 第 7 章：上下文管理 — 消息数组不能无限长（学习笔记）

> 教材：docs/07-context.md

## 核心原理

### 问题

消息数组每轮都在变长，迟早撑爆上下文窗口，API 直接报错。解法：超过阈值就把旧消息
**总结成一段摘要**替换掉，只留最近几条。

### maybeCompact 的四个设计决策

1. **数消息条数，不数 token**——教学简化。真实实现用 API 返回的 usage 当锚点（见选读）。
2. **transcript 渲染成纯文本，不发送原始 blocks**——older 里的 tool_use / tool_result
   变成 `"[tool call / result]"` 一行字。这是**协议安全**的关键：如果截取的消息子集里
   tool_use 没了配对的 tool_result（或反之），Anthropic API 直接 400。渲染成文本后
   辅助请求只是一条普通 user 消息，怎么切都不会破协议。
3. **辅助调用用 messages.create 而不是 stream**——内部调用，没有"给人看"的体验需求，
   非流式更简单。它也不带 tools、不带 CLAUDE.md reminder，system 是专用的一句话
   `"Summarize the conversation so far..."`——这个特征在 mock 里用来把辅助调用路由到
   独立轨道。
4. **压缩结果 = `[摘要 user 消息, ...recent]`**——摘要以 user 身份开头（对话总是以
   user 开头），recent 从 slice 边界接上。Anthropic 允许连续同角色消息（自动合并），
   所以边界切在哪都是合法的。

### 切在哪、留多少

```
COMPACT_THRESHOLD = 6   // 超过 6 条才压（教学阈值；真实版按 85% 窗口利用率触发）
KEEP_RECENT = 2         // 永远保留最近 2 条原文

older  = messages.slice(0, len - 2)   → 送去做摘要
recent = messages.slice(len - 2)      → 原样保留
```

阈值 6 / 保留 2 的数字不重要，重要的是**分层思想**：能用轻手段就不上重手段。
教材完整版是 4 层流水线（见选读），摘要压缩是最重的一层，只在窗口真要满时触发。

### 时机：每次调模型前

`maybeCompact` 放在 while 循环**顶部**（buildSystemPrompt 之前）——每轮模型调用前
检查一次，超了就先压再调。放在循环外只查一次会漏（工具循环内历史也在涨）。

## 文件规格

### 1. 新文件 context.ts

```ts
import type Anthropic from "@anthropic-ai/sdk";

const COMPACT_THRESHOLD = 6;
const KEEP_RECENT = 2;

export async function maybeCompact(
  messages: Anthropic.MessageParam[],
  client: Anthropic,
  model: string,
): Promise<Anthropic.MessageParam[]> {
  // 1. 不超阈值 → 原样返回
  // 2. older / recent 切片
  // 3. transcript：older 每条渲染成一行
  //    `${m.role}: ${typeof m.content === "string" ? m.content : "[tool call / result]"}`
  //    join("\n")
  // 4. 辅助调用 client.messages.create({ model, max_tokens: 1024,
  //    system: "Summarize the conversation so far in a few sentences, keeping key facts.",
  //    messages: [{ role: "user", content: transcript }] })
  // 5. summary = reply.content 过滤 text block 后 map(b => b.text).join("")
  // 6. console.log(`  (compacted ${older.length} messages into a summary)`)
  // 7. return [{ role: "user", content: `[Summary of earlier conversation]\n${summary}` }, ...recent]
}
```

参数把 `client` 和 `model` 传进来而不是 import——context.ts 保持纯函数形态，
不自己建客户端（和 session.ts 不 import Anthropic 类型同一个思路的反面：这里需要
类型和客户端，但都由调用方注入，方便测试）。

### 2. agent.ts 两处

1. `import { maybeCompact } from "./context.js";`
2. while 循环体第一行：
   `this.messages = await maybeCompact(this.messages, this.client, MODEL);`

## 验收标准

`npm run mock -- 7` 5 个 ✓。场景：连读 a/b/c 三个文件（4 次主循环调用），
第 4 次调用前历史 7 条 > 6 触发压缩：

- 4 次主循环调用 + **1 次辅助摘要调用**（mock 按 system 含 "Summarize" 路由到 compact 轨道）
- transcript 是纯文本（含 `[tool call / result]` 和 `user: `——工具对没被拆开）
- 最后一次请求 messageCount === 3（摘要 + recent 2 条，而不是 7 条——**历史真的缩了**）
- 摘要落在历史头部，且 mock 给辅助调用的摘要文本（"a.txt=alpha"）原样出现在
  最终请求里——**端到端验证摘要真的进了上下文**

## 分步施工指南

**第 1 步：context.ts**
- 按"文件规格"的 7 步注释写，每步一两行
- **检查点**：`npm run build`

**第 2 步：agent.ts 两处**
- import + while 循环顶部一行
- **检查点**：`npm run mock -- 7` 5 个 ✓

**第 3 步：回归**
- `npm run mock -- 6 && npm run mock -- 4` 全过 → 叫我 review

## 选读：教材完整版的分层流水线（本章只做最重的一层）

| 层 | 触发 | 手段 | 成本 |
|----|------|------|------|
| 0 执行时截断 | 单次结果 > 50K 字符 | 保留头尾砍中间 | 零（不可逆） |
| 0.5 大结果落盘 | 结果 > 30KB | 全量写磁盘，上下文只留预览+路径，模型可 read_file 取回 | 零（可恢复） |
| 1 Budget | 利用率 > 50%/70% | 历史里超大 tool_result 按预算截断 | 零 |
| 2 Snip | 利用率 > 60% | 同文件重复读取只留最新、旧搜索结果裁掉；**只清 tool_result 内容，保留 tool_use 元数据** | 零 |
| 3 Microcompact | 空闲 > 5min（缓存已冷） | 除最近 3 个外全部旧结果替换成占位符 | 零 |
| 4 Auto-compact | 窗口利用率 > 85% | 本章的 LLM 摘要 | 一次 API 调用 |

两个值得记住的思想：

- **前缀缓存和裁剪是矛盾的**：改了已缓存的前缀，那条消息往后的缓存全失效。
  缓存还热时宁可留着旧内容（命中只按 0.1× 计费，不亏多少）。Microcompact 挑
  "缓存已冷"（空闲 5 分钟）时才动手就是这个原因。
- **Snip 只清结果不清调用**：模型仍看得到"我读过 /src/main.ts"这个事实，
  需要时重新 read_file。保留元数据比保留数据重要。

前缀缓存的两个断点（system 静态块 + 最后一条消息打 `cache_control`）本章不实现，
但第 3 章"按变化频率切 prompt"的伏笔在这兑现——静态核心就是为打缓存断点准备的。

## Review 记录

### 施工（2026-09-11）：两轮修正后 5 项全过

写对的关键点：transcript 用循环累积（`lines.push` + join，与 canonical 的 map/join 等价）、
三元渲染占位符（协议安全核心行）、辅助调用 create 非流式、summary 抽取、
返回 `[摘要 user 消息, ...recent]`。

过程问题：
1. 阈值处硬编码 `6` 而非 `COMPACT_THRESHOLD`——常量定义了就要用；
2. 参数改名 `message`→`messages` 改一半，slice 两行漏改，TS `Did you mean` 当场抓获；
3. **写完函数忘了接线**：context.ts 完成后直接跑测试，4 项里 3 项 ✗——agent.ts 里
   没调 maybeCompact，压缩函数成了死代码。教训：本章交付物是"机制生效"，不是"函数存在"，
   mock 立刻暴露（辅助调用根本没发出去）。

验收链条完整：4 次主循环 + 1 次辅助调用（mock 按 system 路由到 compact 轨道）、
transcript 纯文本、历史 7→3、mock 的摘要文本"a.txt=alpha"端到端出现在最终请求里。

最终：`npm run mock -- 7` 5 项 ✓；回归 ch6/ch5/ch4/ch3/ch1 全过。第七章完成。
