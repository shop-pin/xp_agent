# 第 1 章：Agent Loop — 核心循环（学习笔记）

> 教材：docs/01-agent-loop.md ｜ 最小参考实现：steps/canonical/ts/{agent,tools}.ts

## 核心原理

Agent 的心脏是一个循环，判断逻辑只有一条：**响应里有 `tool_use` 就继续，没有就停**。
下一步做什么由模型决定，代码只负责转循环、递工具。

```
用户消息 ──► 调 API ──► 响应里有 tool_use？
                ▲              │是
                │              ▼
                └──── 执行工具，结果作为 user 消息喂回
                              │否
                              ▼
                         打印文本，结束
```

## Anthropic Messages API 协议 4 要点

1. 请求带 `tools`（name / description / input_schema），模型才知道有哪些工具可调
2. 响应 `content` 是块数组：`{type:"text", text}` 或 `{type:"tool_use", id, name, input}`
3. 工具结果必须作为 `role:"user"` 消息回传，每条 `{type:"tool_result", tool_use_id, content}`，靠 `tool_use_id` 认领
4. assistant 回复要**整个原样**推进历史（不能只推 text，会丢 tool_use 块）

## 文件规格

- `tools.ts`：`toolDefinitions: Anthropic.Tool[]` + `executeTool(name, input)` switch 分发；
  default 返回 `Unknown tool` 字符串（模型幻觉工具名时可自我纠正）；所有错误 catch 返回字符串，不 throw
- `agent.ts`：`Agent` 类（client + messages），`chat(userText)` 内 `while(true)` 循环

## Review 记录（2026-09-08，第一版）

### 编译错误（9 处）

| 位置 | 问题 | 修法 |
|------|------|------|
| agent.ts:13 | `api_key` / `base_url` 蛇形命名 | SDK 是驼峰：`apiKey` / `baseURL` |
| agent.ts:29 | `process.std.write` | `process.stdout.write` |
| agent.ts:37 | `process.env.write(...)` | `console.log(...)` 或 `process.stdout.write` |
| agent.ts:38 | `tu.input` 是 `unknown` | `tu.input as Record<string, any>` |
| agent.ts:38 | `executeTool` 返回 Promise 没 await | `await executeTool(...)` |
| tools.ts:17 | `required` 写在 Tool 顶层 | 移进 `input_schema` 内部，且值应为 `["file_path"]` |
| tools.ts:24 | `readFile(input)` 类型不匹配 | `readFile(input as { file_path: string })` |

### 逻辑问题（编译器抓不到）

1. **没有 while 循环（结构性，本章核心）**：chat() 只调了一次模型，工具结果推回 messages 后函数就结束
   ——模型永远看不到工具结果，给不出最终回答。mock 场景的第二轮响应永远不会被请求到。
2. `if (!toolUses) return` 判断错误：filter 返回数组永不为 null，空数组是 truthy 会继续往下走。
   应为 `toolUses.length === 0`。
3. `tool_result` 字段名错：`id: tu.id` → 应为 `tool_use_id: tu.id`；`name` 不是合法字段。
   协议靠 tool_use_id 认领对应调用，写错真 API 会 400。
4. 打印文本方式错：模板字符串直接嵌对象数组只会打出 `[object Object]`。
   应遍历 content，只打印 `block.type === "text"` 的 `block.text`。
5. readFile 的错误信息丢了 `e.message`：模型靠错误详情（如 ENOENT）自我纠正，应把 e.message 拼进去。

### Review 第 2 轮（2026-09-08）

已修对：apiKey/baseURL 驼峰、while 循环、`toolUses.length === 0`、`tool_use_id` 字段。

**编译错误（1 处）**
- agent.ts:39 `content: result` —— `executeTool` 是 async，第 38 行仍漏了 `await`，content 拿到的是 Promise。

**运行期陷阱（编译器抓不到）**
1. tools.ts:16 `required: ["read_file"]` —— 位置已挪进 input_schema，但**值**还是错的，应填参数名 `["file_path"]`。
2. tools.ts:24/30 调用与签名不匹配：`readFile(input.file_path)` 传的是字符串，
   但函数签名仍是 `readFile(input: { file_path: string })`，运行时 `input.file_path` 取到 undefined，
   `readFileSync(undefined)` 必然抛错。tsc 没报是因为 `Record<string, any>` 的 file_path 是 `any`，
   把类型检查抹掉了。修法：签名改成 `readFile(filePath: string)`，函数体内直接用 filePath。
3. tools.ts:35 `e.messages` —— 拼写错，应为 `e.message`。`e` 是 any 所以编译不报，
   运行时打印 "Error reading file: undefined"。
4. agent.ts:29 `console.log(\`response.content: ${response.content}\`)` —— 对块数组做字符串插值
   只会打出 `[object Object]`。应遍历 content，只打印 text 块的 text。
5. 建议：工具调用行改成 `` console.log(`  → ${tu.name}(${JSON.stringify(tu.input)})`) ``，
   顺带把入参也打出来，便于观察模型传了什么。

**教训：`any` 会抹掉类型检查。** 编译零错误 ≠ 运行正确，跨函数传参时调用端和签名要对上。

### Review 第 3 轮（2026-09-08）

已修对：`e.message`、工具调用行带上了入参。

仍未改到的 4 处：
1. agent.ts:38 仍漏 `await executeTool(...)`（TS2322）
2. tools.ts:16 `required` 值错成 `["read_path"]`，应为 `["file_path"]`（必须与 properties 的 key 一致）
3. tools.ts:24 调用改回 `readFile(input)`，重新触发 TS2345；
   修法：`readFile(input as { file_path: string })` 或把签名改成收 `filePath: string`
4. agent.ts:29 打印 content 数组（用户要了答案）：

```typescript
for (const block of response.content) {
  if (block.type === "text") process.stdout.write(block.text);
}
process.stdout.write("\n");
```

要点：content 是 text/tool_use 混合的块数组，逐块判型只打 text；`stdout.write` 不带换行、
最后补 `\n`——第 5 章流式输出沿用同一打印方式。

### 第 3 轮修复确认与运行（2026-09-08）

全部修对，mock 验证通过：

```
->read_file({"file_path":"greeting.txt"})
greeting.txt says: hello from step one.
```

## 运行方式

- `npm run mock` —— 无 key 演示：tsc 编译 → 启动本地 mock 模型（steps/mock-anthropic.mjs，
  说真 Anthropic API 协议）→ 把 ANTHROPIC_BASE_URL 指向它 → 在临时沙箱目录（含 greeting.txt）
  里 import dist/agent.js 调 `Agent.chat()`。mock 按请求中 assistant 消息的条数决定返回第几轮剧本。
- `npm run live -- "你的提示词"` —— 连真模型。读仓库根 .env 的
  ANTHROPIC_API_KEY / ANTHROPIC_BASE_URL / ANTHROPIC_MODEL_ID。
- `npm run build` —— 只编译。dist/ 是编译产物，源码改动后重新编译才生效（npm run mock/live 自带编译）。

### 验收标准

`npm run mock` 输出：

```
  → read_file({"file_path":"greeting.txt"})
greeting.txt says: hello from step one.
```

两行都要有：第一行证明工具回路接住了调用；第二行证明结果喂回后模型成功收尾（即循环真的转回来了）。
