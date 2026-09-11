# 第 4 章：CLI 与会话 — 给内核装一张脸（学习笔记）

> 教材：docs/04-cli-session.md

## 核心原理

前三章的 agent 进程一关，聊过的全忘。本章加两个东西：

1. **会话持久化（session.ts）**——对话本来就是消息数组，存盘 = 写 JSON，没有任何数据库。
2. **命令行入口（cli.ts）**——薄壳：解析 argv → 调 Agent → 打印。CLI 不碰业务逻辑。

### 会话的关键设计

- **存什么**：整个 `messages` 数组原样 JSON 化。assistant 消息里的 tool_use 块、user 消息里的
  tool_result 块都原样保留——模型要求的协议结构不能丢，恢复后才能无缝续聊。
- **存哪**：`process.cwd()/.mini-session.json`（单文件、跟项目走）。
- **何时存**：每轮 `chat()` 结束后。`try/catch` **静默失败**——磁盘满不能让对话崩掉，
  这是"环境事实收集器"容错思路的存储版：保存是尽力而为，不是承诺。
- **怎么恢复**：`loadHistory(saved)` 直接把数组塞回 `agent.messages`，一个字段都不用转换。
- **恢复后的连锁反应**：agent.ts 里 reminder 注入条件是 `messages.length === 0`，恢复后
  length > 0，自动不再注入——"每次会话只注入一次"的语义免费延续；而且 run 1 存下的
  第一条 user 消息**自带**当时注入的 reminder，随会话一起持久化。

### CLI 的两种运行模式

```
mini-claude "做点事"      → 单次模式：chat 完退出（脚本/测试用）
mini-claude               → REPL 模式：readline 循环，逐行聊
mini-claude --resume ...  → 先恢复上次会话，再走上面任一模式
```

### REPL 的串行关键

`rl.question` 回调里 `await agent.chat()` 完成后**再递归调用 ask()** 注册下一行监听——
天然串行，杜绝两个 chat 并发修改消息历史。（教材提的 `rl.once` 是同一思想的另一写法。）
不能一行监听注册完就不管，否则用户连打两行，第二行不等第一轮跑完就进来并发改历史。

### Ctrl+C 双重语义（了解，mock 测不到）

- agent 处理中按 → 中断当前操作，回提示符（第 5 章流式时实现 abort）
- 空闲时按 → 第一次提醒，第二次退出（防手滑丢会话）

本章 REPL 版本先不做 SIGINT 定制，Node 默认行为够用。

## 文件规格

### 1. agent.ts 三个方法（第 1 步，2 分钟）

```ts
history(): Anthropic.MessageParam[]      // 返回 this.messages
loadHistory(messages: Anthropic.MessageParam[]): void   // 整体替换
clearHistory(): void                     // 置空数组
```

Agent 不感知"存盘"这回事——存取是 CLI 的职责，Agent 只暴露读写历史的口子。

### 2. session.ts（第 2 步，新文件）

```ts
import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";

const SESSION_FILE = join(process.cwd(), ".mini-session.json");

export function saveSession(messages: unknown[]): void
  // writeFileSync + JSON.stringify(messages, null, 2)，整体 try/catch 吞错
export function loadSession(): unknown[] | null
  // 不存在 → null；JSON.parse 失败（文件损坏）→ null，不抛
```

两个函数都是"尽力而为"：任何失败返回 null / 静默，绝不向上抛。

### 3. cli.ts（第 3 步，新文件，本章主菜）

```ts
export async function runCli(argv: string[] = process.argv.slice(2)): Promise<void>
```

流程（照 canonical 的简版，--plan/--yolo 是后面章节的，**现在只做 --resume**）：

1. `--resume` 检测：`argv.includes("--resume")`，然后 `argv = argv.filter(...)` 把它摘掉
   （剩下的重新当作 prompt 或进入 REPL）；resume 为真则 `loadSession()`，非 null 就
   `agent.loadHistory(saved)` 并打印 `(resumed N messages)`
2. **单次模式**：`const oneShot = argv.join(" ").trim()`，非空 → `agent.chat(oneShot)` →
   `saveSession(agent.history())` → return
3. **REPL 模式**：readline 循环——

```ts
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
await new Promise<void>((resolve) => {
  const ask = () => {
    rl.question("you: ", async (line) => {
      const input = line.trim();
      if (input === "exit" || input === "quit") { rl.close(); resolve(); return; }
      if (input === "/clear") { agent.clearHistory(); saveSession(agent.history()); console.log("(history cleared)"); ask(); return; }
      if (input) await agent.chat(input);   // try/catch 包住，别让一轮报错杀死 REPL
      if (input) saveSession(agent.history());
      ask();
    });
  };
  ask();
});
```

4. **main guard**（文件底部）——模块既可直接执行也可被 import 驱动：

```ts
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) runCli();
```

   需要 `import { pathToFileURL } from "url"`。没有这个 guard，测试驱动 import cli.js
   时会意外自己跑起来。

### 4. run-mock.mjs 第 4 章（我代搭，已完成）

驱动 `dist/cli.js` 的 `runCli` 跑两遍：第一遍存会话，第二遍 `--resume` 续聊。
断言 7 项：session 文件存在、内容 2 条消息、两次模型调用、run 1 只发 1 条消息、
run 2 发 3 条消息（历史恢复成功的铁证）、run 2 第一条 user 消息是 run 1 的原话。

## 验收标准

`npm run mock -- 4` 7 个 ✓ 全亮。
注意 resume 没实现时测试**不会**全红——mock 有 stateful 计数照样返回第二轮文本，
露馅的是"run 2 发了 3 条消息"和"firstUserText 是 run 1 的话"这两条断言。

REPL 部分 mock 测不到，人肉测：

```
npm run build
node dist/cli.js          # REPL：随便聊两句 → /clear → 再聊 → exit
node dist/cli.js "hi"     # 单次模式
node dist/cli.js --resume "我们刚才聊了什么？"
```

## 分步施工指南

**第 1 步：agent.ts 三方法**
- history / loadHistory / clearHistory，一行一个
- **检查点**：无（和第 2 步一起验）

**第 2 步：session.ts**
- 两个函数 + SESSION_FILE 常量，注意双 try/catch
- **检查点**：`npm run build` 过编译

**第 3 步：cli.ts**
- runCli 框架：resume 处理 → 单次模式 → REPL（ask 递归）→ main guard
- **检查点**：`npm run mock -- 4` 7 项全亮

**第 4 步：回归**
- `npm run mock -- 3 && npm run mock` 不能坏（agent.ts 动过，prompt.ts 没动）
- REPL 人肉测一遍 → 叫我 review

卡在 readline / pathToFileURL / URL 比较，随时说，实现层我代填。

## Review 记录

### 第 1 步（2026-09-11）：一次通过

agent.ts 三方法与规格完全一致。

### 第 2 步（2026-09-11）：两个问题

1. 文件名漏点：`mini-session.json` → 应为 `.mini-session.json`（隐藏文件惯例；测试按此名断言）。
2. **括号错位（同类第 2 次）**：`JSON.parse(readFileSync(SESSION_FILE), "utf-8")`——`"utf-8"`
   被划给 JSON.parse 当 reviver（非函数被忽略），readFileSync 无 encoding 返回 Buffer，
   靠 JSON.parse 的 ToString 强转**两重巧合蒙对**。正确：encoding 在 readFileSync 括号内。

### 第 3 步（2026-09-11）：REPL 由 Claude 代填，用户自修其余

- REPL（readline 是用户陌生 API，授权代填）。讲解要点：
  `await new Promise` 桥接回调与 async 世界（resolve 开关握在回调手里）；
  **ask() 递归 = 天然串行**（一行处理完才注册下一行，杜绝并发 chat 改历史）；
  /clear 也要落盘（否则下次 resume 复活）；chat 包 try/catch（一轮报错不能杀死 REPL）；
  main guard 用 pathToFileURL 统一 URL 格式后比较。
- 用户自查修正三处：
  1. **filter 反转**：`filter(t => t === "--resume")` 只留下 flag 删光 prompt——filter 保留返回 true 的元素；
  2. 漏 `new Agent()`；
  3. async 函数返回类型必须 `Promise<void>`，不能 `void`。
- main guard 两处笔误：`input.meta.url`（import 手滑）+ `pathToFileURL(process.argv[1].href)`
  括号错位（.href 进了参数，取字符串的 .href = undefined）。
- **括号错位已三次**（第 3 章逗号表达式、session.ts 的 readFileSync、这里）——模式：
  多层嵌套调用时闭括号跟着参数列表走神。对策：写完嵌套调用数一遍括号配对。

### 冒烟测试抓到真 bug：EOF 后 ask 崩溃

管道喂 `hi/clear/exit` 复现：chat 报错期间 stdin 到 EOF → readline 自动 close →
之后的 `ask()` 调 `rl.question` 抛 `ERR_USE_AFTER_CLOSE`。**交互场景按 Ctrl+D 同样触发**。
修复（canonical 也没处理，超出教材）：`rl.on("close")` 设 closed 标志并 resolve，
`ask()` 前置 `if (closed) return;` 守卫。
局限：管道下所有行瞬间到达，pending question 之外的行被 readline 丢弃——只影响非交互管道，交互无碍。

### 测试驱动自己的 bug（Claude 写的）

verify 在**两轮跑完后**才检查 session 文件，断言"2 条"实际已是 4 条（2 恢复 + u2 + a2）。
改为断言 4 条——反而是更好的判据：resume 坏了 run 2 会从零开始只存 2 条。
教训：断言前先想清楚**检查的时点**上数据应该长什么样。

### 最终验收（2026-09-11）

`npm run mock -- 4` 6 项全亮；回归 `npm run mock -- 3`（9 ✓）与 `npm run mock`（第 1 章）正常；
REPL 冒烟（报错恢复 / /clear / EOF 退出）通过。第四章完成。
