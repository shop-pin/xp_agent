# 第十一章：多 Agent 架构（subagent.ts）

## 原理

大任务塞进一个 agent，上下文很快爆。解法是 fork-return：主 agent 通过 `agent` 工具派生
子 agent——**自己干净的消息数组**，跑一个迷你工具循环，只把**最后那段文本**带回主对话。

核心洞察：**子 agent = 配置不同的循环实例**，不需要新类。最小实现两处：

- `subagent.ts`：`runSubAgent(task, client, model)` —— 只读白名单
  `["read_file", "list_files", "grep_search"]`（**白名单 filter，不是黑名单排除**——默认拒绝），
  `messages` 从 task 起步，`client.messages.create` 非流式（第 7 章辅助调用同款），
  白名单外的工具 in-loop 返回 `"Denied: the sub-agent is read-only."`。
- `agent.ts`：工具循环里 `if (tu.name === "agent")` 拦截（放在权限检查**之前**），
  调 `runSubAgent`，摘要作为 tool_result，`continue`。

最小版**不注册** `agent` 工具定义（mock 强制调用即可测）；生产必须广告 schema
（教材"关键代码"节），否则模型永远不会自发调用。

## 思考题参考答案（Claude 代答）：子 agent 循环比主循环少了哪四样

1. **流式打印**（`.stream` + `on("text")`）——子 agent 的输出要**收集后作为 tool_result
   回流**，刷屏主对话会污染交互。
2. **权限闸**（checkPermission）——只读约束在工具分发处以白名单强制，比权限闸更严
   （默认拒绝 vs 黑名单拦截）。
3. **maybeCompact**（第 7 章）——子 agent 任务短命一次性，上下文天然干净，压缩无意义。
4. **recallMemories**（第 8 章）——记忆服务主对话的用户交互；子 agent 收到的已是
   主 agent 消化过的具体指令。

（另有无 session 保存、无 plan mode 继承——后者在生产版是安全要点：plan 必须继承，
否则子 agent 成为绕过只读的后门。）

## Review 记录

### 施工（2026-09-12）：两轮提示 + 最终代填，mock 8 项 ✓，回归 ch1–10 全绿

用户写对的：`EXPLORE_TOOLS` 定义、白名单 filter、while 整体形状、退出判定的位置直觉。

代填修正清单（对账 8 处）：

1. **import 深层路径**（第二次提醒才改）→ 与 agent.ts 一致的默认导入。
2. **messages 初始化写成单个对象**而非数组——后续所有 push 语义全错。
3. **system 抄成字面省略号** `"...explore sub-agent..."`——骨架里的 `...` 是占位符。
   讽刺的是 mock 按子串路由**碰巧能过**（找的就是 "explore sub-agent"），
   但发给模型的是垃圾。**测试绿 ≠ 语义对**的活例。
4. **块④整块丢失**：assistant 回复没 push 回 messages——第二轮请求变成
   [user, user]，真实 API 会 400（roles must alternate），mock 不校验角色交替。
5. **循环变量改名改一半**：`for (const t of ...)` 但循环体引用 `tu.name`——TS 当场抓获；
   顺手给 filter 结果补了显式 `ToolUseBlock[]` 注解（与 chat() 一致）。
6. **退出返回丢 `.map(b => b.text)`**——TextBlock 对象直接 join 得 `"[object Object]"`。
   这个返回值是主 agent 唯一能看到的子 agent 产出，全函数最关键的一行。
7. **⑦⑧合并成一个错误 push**：tool_result 对象（无 role）直接进 messages，
   不合 MessageParam 结构。必须先收集 `results` 数组，再作为**一条** user 消息推入——
   与 chat() 第 76–78 行完全同构。
8. **while(true) 之后的死 return**——唯一出口是块⑥。

**本轮错误画像**：几乎全是"拼装丢失"——每一块单独都有原型（chat()、context.ts），
但 8 块同时保持在工作记忆里超载了。**对策**：写多块函数时，先把块注释写成空壳
（①–⑧），再逐块填肉——注释骨架是工作记忆的外置。下一章建议主动用这个方法。

### mock 场景设计（脚手架，run-mock.mjs "11"）

双轨道：main（fallback）+ sub（按 system 子串 "explore sub-agent" 路由，与主 system
无碰撞）。子轨道故意安排三个 turn：读文件 → **越权 write_file（测 in-loop deny）** →
文本收尾。八断言：主 2 子 3、只读工具集、上下文独立（messageCount=1）、system 独立
（含 explore 子串且不含 "Mini Claude Code"）、**主流式/子非流式**、
子内写被拒 + `evil.txt` 磁盘负证、摘要以 tool_result 回流主循环。

最终：`npm run mock -- 11` 8 项 ✓；回归 ch1–10 全过（45 断言）。第十一章完成。
