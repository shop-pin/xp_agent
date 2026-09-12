# 第十章：Plan Mode（只读规划模式）

## 原理

agent 越来越会动手，但有时要先看方案再放行。Plan Mode = **只读开关**：能读能想，
写文件/跑 shell 全被拦。核心思想——「只读」**不靠提示词求模型，靠代码强制**：

```
执行工具前：blocked = 权限闸拒绝(第6章) || (plan 模式 && 工具 ∈ {write_file, edit_file, run_shell})
```

与第 6 章同一个模式：拒绝以 **tool_result** 送回模型而非抛错终止——模型看到
`Denied: ... (plan mode)` 才能改道（"那我先交方案"）。**拒绝消息带原因**是设计的一部分。

入口：`--plan`（CLI 解析 → `agent.setMode("plan")`）。实现只有三处：
agent 加 `mode` 字段 + `setMode` 方法 + 工具循环里的 `blocked` 两段式；cli 解析 `--plan`。

**本章未实现的扩展**（教材后半段，选读）：`enter_plan_mode` / `exit_plan_mode` 工具对、
plan 文件白名单（唯一可写例外）、四选项审批回调（clear+execute / execute / manual /
keep-planning）、`prePlanMode` 精确恢复。

## 思考题：shell 为什么整个禁掉

模型完全可能跑 `echo hi > report.txt` 这种"读命令夹带写"。为什么不对 shell 逐条分析？
因为**静态分析任意 shell 命令的读写语义不可靠**（重定向、管道、子命令嵌套、别名……），
而只读保证应该是**可证明的**而不是"尽力而为的"——用粒度换确定性。
保留 `read_file` / `list_files` / `grep_search` / `web_fetch` = 探索能力不受影响。

## Review 记录

### 施工（2026-09-12）：三轮检视，mock 6 项 ✓，回归 ch1–9 全绿（退出码验证）

一次写对的：agent.ts 全部（`mode` 字段、`setMode`、`blocked` 两段式、带模式的拒绝消息）。

过程问题：

1. **类方法当模块导出导入**：`import { Agent, setMode }` ——`setMode` 是实例方法，
   agent.ts 没这个 export，TS2305 编译报错。调用 `agent.setMode(...)` 才是对的用法。
2. **filter 比较符反了**：`filter(t => t === "--plan")` 把 `--resume` 模板的 `!==` 抄成
   `===`——只留下旗标本身，任务文本被整个丢掉，oneshot 变成字符串 "--plan"。
3. **改写三元时丢类型断言**：`checkPermission(tu.name, tu.input)` ——SDK 的
   `ToolUseBlock.input` 是 `unknown`，原代码的 `as Record<string, any>` 在两段式改写中
   被落下，编译期抓获。

### 两个值得记住的教训

- **mock 盲区：位置回放**。场景 turns 按"第几号请求回第几号 turn"驱动，不看 prompt 内容——
  所以 bug 2（任务文本没送达）下测试照样全绿（假绿）。解法：显式断言
  `firstUserText` 含任务原文（"the actual task reached the model"）。
  **凡是"输入是否正确送达"类问题，必须断言 firstUserText。**
- **测试驱动自身的正确性**。Claude 的回归命令用 `grep ✗ || all green` 判断——编译失败时
  输出里没有 ✗，被误报为"全绿"。改用**进程退出码**判断（断言失败和编译失败都会 exitCode=1）。
  脚手架的 bug 和被测代码的 bug 一样危险，甚至更隐蔽。

### mock 场景设计（脚手架，run-mock.mjs "10"）

`--plan Create a file report.txt with the plan.` 驱动 CLI；turn1 模型试写
`report.txt` → turn2 文本恢复。六断言：未落盘、两次调用、**任务送达 firstUserText**、
Denied、拒绝消息提到 plan、拒绝内容不是文件内容。

最终：`npm run mock -- 10` 6 项 ✓；回归 ch1–9 全过（退出码验证，ch10 6 断言 +
其余 39 断言）。第十章完成。
