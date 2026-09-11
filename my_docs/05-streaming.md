# 第 5 章：流式输出 — 让答案一个字一个字蹦出来（学习笔记）

> 教材：docs/05-streaming.md

## 核心原理

### 为什么流式

模型生成速度 ~30-80 token/s，长回答要 10-30 秒；人对空白等待的容忍只有 2-3 秒。
流式让第一个字几百毫秒内出现，把"等 30 秒"变成"看着它写"，主观等待感≈零，
而且方向错了可以提前 Ctrl+C（中断成本 < 撤销成本）。

### 底层：SSE（Server-Sent Events）

一条持久 HTTP 连接，服务端持续推 `data:` 行。Anthropic 的事件序列：

```
message_start
content_block_start        （index=0, type=text 或 tool_use）
content_block_delta        ← 重复 N 次：text_delta（文本增量）/ input_json_delta（工具参数增量）
content_block_stop         （这个 block 完整了）
message_delta              （stop_reason）
message_stop
```

比 WebSocket 简单——LLM 场景单向推送就够。mock 的 `writeStreaming` 就是照这个序列
手写 SSE，把文本按 24 字符切块推，让"流式"肉眼可见。

### 本章最重要的设计决策

**流式只发生在边缘，数据模型不变**：`stream.finalMessage()` 返回和非流式 `create`
完全一样的 `Message` 对象。所以循环里其他代码（push 历史、filter tool_use、执行工具）
一行不用改。核心换传输协议，核心逻辑不感知——协议适配收敛在一个点。

### SDK 帮你做了什么

`client.messages.stream(request)` 返回 MessageStream 帮手对象：
`.on("text", t => ...)` 直接给文本增量（SDK 替你拼装 text_delta 事件），
`.finalMessage()` 等 message_stop 后 resolve 出完整消息。
教材里手动解析 SSE、累积 tool_calls JSON 的那一大坨（OpenAI 后端部分）SDK 全包了。

## 范围说明

教材第 5 章还有四块，**超出 canonical 最小范围，本章不做**（后面章节需要时再学）：

| 内容 | 为什么能砍 |
|------|-----------|
| OpenAI 双后端 | 用户只有 Anthropic 兼容端点；协议对比见教材 |
| withRetry 指数退避 | 独立模块，随时可加（见下方 bonus） |
| Extended Thinking | 需要 thinking 模型 + UI 展示配合 |
| 流式工具预执行 | 依赖权限系统（第 6 章）先存在 |

## 文件规格（agent.ts 只动一处）

chat() 循环里，把 `messages.create` 换成：

```ts
const stream = this.client.messages.stream({ ...原 request 参数原样... });
stream.on("text", (t) => process.stdout.write(t));
const response = await stream.finalMessage();
process.stdout.write("\n");
```

同时**删掉**旧的文本打印块：

```ts
for (const block of response.content) {
    if (block.type === "text") { console.log(`block.text: ${block.text}`); }
}
```

——文本现在由 stream handler 增量打印，finalMessage 里的 text block 不再重复打。
`process.stdout.write` 而不是 console.log：流式要的是无换行、无缓冲的直接写。

其余（push assistant 消息、filter toolUses、工具执行、push tool_result）全部不动——
这就是"finalMessage 同构"的意义。

## 验收标准

`npm run mock -- 5` 4 个 ✓：

- 两次模型调用（工具循环完好）
- 第 1、2 次请求都是流式（log 里 `stream: true`，mock 收到 `stream: true` 才走 SSE 分支）
- finalMessage 形状正确（tool_result 被正常送回——若 finalMessage 解析坏了这里会断）

肉眼验收：mock 输出里回答文本会分块蹦出来（24 字符一片），不再是整段一次性出现。

## 分步施工指南

**第 1 步：换流式调用**
- 按"文件规格"改 agent.ts 一处 + 删旧打印
- **检查点**：`npm run mock -- 5` 4 个 ✓，且输出里文本分块蹦

**第 2 步：回归**
- `npm run mock -- 4 && npm run mock -- 3 && npm run mock` 全过 → 叫我 review

## Bonus（可选）：withRetry 指数退避

教材第 5 章的重试机制值得做，10 行左右，独立于主线：

```ts
function isRetryable(error: any): boolean {
  const status = error?.status || error?.statusCode;
  if ([429, 503, 529].includes(status)) return true;         // 过载类
  if (["ECONNRESET", "ETIMEDOUT"].includes(error?.code)) return true;  // 网络瞬断
  return false;                                              // 400/401/404 重试无意义
}

async function withRetry<T>(fn: () => Promise<T>, maxRetries = 3): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try { return await fn(); }
    catch (error: any) {
      if (attempt >= maxRetries || !isRetryable(error)) throw error;
      const delay = Math.min(1000 * Math.pow(2, attempt), 30000) + Math.random() * 1000;
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}
```

要点：只重试**过载/瞬断**（429/503/529/ECONNRESET），不重试**配置错**（400/401/404）；
指数退避 + 随机抖动防"重试风暴"（所有客户端同时重试反而加剧过载）。
用法：`const response = await withRetry(() => stream 完成逻辑包成箭头函数)`。
想做就告诉我，mock 可以加一个"先 503 后成功"的测试轨道。

## Review 记录

### 第 1 步 + 回归（2026-09-11）：一次通过

改动与规格逐字吻合：stream 参数原样保留、`on("text")` → `stdout.write`、
`finalMessage()` 接回 `response`、删旧打印块、其余零改动。

一个值得点名的**正确顺序**：`stream.on("text", ...)` 注册在 `await stream.finalMessage()`
**之前**。事件是边推边来的，注册晚了开头几块就丢了——这是流式代码的经典竞态，用户没踩。

验收：ch5 4 项 ✓（两次调用、两次都流式、tool_result 正常回传）；回归 ch4（6 ✓）、ch3、ch1 全过。第五章完成。

### 未做（超出最小范围，见"范围说明"表）

OpenAI 双后端、withRetry（bonus 在本文档，想做随时加）、Extended Thinking、流式工具预执行。
