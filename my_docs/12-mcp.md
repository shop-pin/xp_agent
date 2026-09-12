# 第十二章：MCP 集成（mcp.ts）

## 原理

MCP = 动态挂载外部工具的开放协议。最小链路：

```
spawn 服务器子进程 → JSON-RPC over stdio 握手 → tools/list 发现
→ 带前缀（mcp__demo__）合并进工具表 → mcp__ 开头的调用路由回服务器
```

对 Agent Loop 来说 MCP 工具和内置工具无区别——名字 + schema + 执行函数。
agent 侧新增仅 ~15 行：守卫连接（ensureMcp）、快照整形（mcpTools）、增量广告（合并 tools）、
前缀路由（startsWith("mcp__") 拦截 + continue，与 ch11 的 agent 拦截同构）。

脚手架侧：`mcp-demo-server.mjs`（真 spawn 的子进程，switch 分发 initialize /
tools/list / tools/call，`add` 工具），`MINI_MCP_SERVER` 环境变量指路。

## 值得记住的思想（讲解沉淀）

- **类型即契约**。`McpTool` 三字段不是"MCP 工具的完整描述"，而是"能塞进 Anthropic
  请求体的最小整形结果"——协议适配器（inputSchema→input_schema）在边界完成，内部
  代码不再认识 MCP 方言。`McpConnection` 是对消费者视角的能力接口（tools/callTool/
  close 三件套），闭包实现，结构化类型自动满足；mcp.ts 不 import SDK 类型，两层解耦。
- **pending Map = 手写 Promise 化 RPC**。发送端四步顺序不可换：领 id → 挂 resolve →
  写 stdin（先存"怎么续上"再发，防响应先到竞态）；接收端按行 parse、按 id 配对、
  用完即焚。`JSON.stringify` 自动省略 undefined params；末尾 `\n` 是分帧符不是美化。
- **请求 vs 通知的唯一区别：进不进配对表**。initialize/tools/list await；
  notifications/initialized 直接写 stdin——无 id、无可等。
- **资源要能归还**。`McpConnection.close()` 在类型里存在但最小版无人调——"有 close
  无人调 = 资源泄漏"。测试驱动逼出了 `closeMcp()`：**申请方（ensureMcp, private）和
  归还方（closeMcp, public）往往不是同一角色**，归还口子必须公开。
- **两时间态读法**：connectMcp 12–46 行是连接时刻一次性的；48–57 行是之后每次调用的。
  agent.ts 同理：chat() 开头（连接+整形）一次，循环内（广告+路由）每轮。

## Review 记录

### 施工（2026-09-12）：类型壳 → 转录骨架带填空 → 三处修正，mock 4 项 ✓，回归 ch1–11 全绿

用户写对的：类型壳、pending Map 全套（on line / request / delete）、握手三连结构、
schema 改名映射、callTool 内容提取、agent.ts 四块的位置与时序。

过程问题：

1. **`decription` 拼写**（类型壳阶段，自查修掉）。
2. **`request("tool/list")`** 少个 s——demo 服务器 switch 落到 default 回 error，
   `listed.result.tools` 为空，工具注册不上。**测试抓获**。
3. **`"notificatios/initialized"`** 拼错——通知无 id，服务器静默，**测试抓不到**。
   ch11"mock 绿 ≠ 语义对"教训原样重现：这次是握手完成宣告从未送达。
4. **ensureMcp 调用丢失后画蛇添足**：先整行不调（this.mcp 恒 null），补的时候写成
   `this.mcp = await this.ensureMcp()`——void 赋给连接对象，双重错。"过程函数不需要
   接返回值"：ch8"函数 vs 函数调用"坑的变体。

### 脚手架的一课（Claude 侧）

MCP 子进程的管道让 run-mock 事件循环永不排空 → 先加 `process.exit` 强退 →
Windows libuv 断言（`UV_HANDLE_CLOSING`）**随机**触发，污染所有章节退出码——
断言全 ✓ 却报 FAIL。正确修法：agent 加公开 `closeMcp()`，run-mock 在 chat 后调用，
让子进程死亡 → 管道 EOF → 事件循环自然清空。**process.exit 是掩盖不是修复；
资源问题的正解是把资源真正关掉。** 修完 ch12 4 项 ✓ + ch1–11 全绿（52 断言）。

### mock 场景设计（脚手架，run-mock.mjs "12"）

非 CLI 直驱 Agent.chat；turn1 强制模型调 `mcp__demo__add(17,25)`，turn2 文本收尾。
四断言：两次调用、**mcp__demo__add 出现在广告表**、**内置工具仍在**（合并不许挤掉）、
**"42" 以 tool_result 回流**。真子进程真 JSON-RPC，无任何 mock 分支——
协议栈端到端只有 Anthropic API 一处是假的。

最终：`npm run mock -- 12` 4 项 ✓；回归 ch1–11 全过。第十二章完成。
