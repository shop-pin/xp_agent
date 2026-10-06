# dsh-E1 UI/CLI 纯消费者化——引擎不再认识"长什么样"

> 本章产物：`services/commands.ts`（CommandService：斜杠解析 + 静态表 + 技能回退，dispatch 一个入口）；`plugins/commands.ts`（slash 命令=插件注册，cli 的 if 链整体消亡）；`services/ui-service.ts`（消息面订阅 session-log 渲染 + 叙事面 ctx.ui.*，渲染器可替换）；SIGINT→`cancel(cause)`（打断的报告收口进 agent）。
> 一句话：**消息面的事实由日志驱动渲染，叙事面的旁白经服务出口——引擎侧 48 个直印点清零，cli 只剩"查表 dispatch + 透传 send"**。
> 参照物：dsh 的"UI 是 session 事件的渲染器"（进程内版）与 ctx.commands。

---

## 1. 迁移前的两个"引擎认识 UI"

1. **cli.ts 的 slash if 链**：9 个命令的解析/打印/await 全长在 CLI 里（130 行）；欢迎横幅的命令清单也是硬编码——加一个命令要动两处。
2. **ui.ts 是被引擎 import 的打印库**：agent/plugins/services 共 48 个直印点（goal/loop 状态、分类器降级、压缩提示、工具调用……）。引擎不仅决定"说什么"，还决定"长什么样"——渲染器不可替换，测试无法静默。

## 2. 新机制：两个面，两条路

```
消息面（会话事实）：
  agent.append(tool/call) ──onAppend 同步回调──► UiService ──► renderer.toolCall
  （引擎的 printToolCall 直印消亡：日志里有的事实，UI 自己看得见；渲染顺序=日志顺序）

叙事面（状态旁白）：
  goal/loop/分类器/压缩的 status 行 ──ctx.ui.info/error──► renderer（默认=旧 ui.ts 逐字节同款）
  assistant 流式文本 ──ctx.ui.text(delta)──► renderer（不走日志：见自测题 2）

命令面：
  REPL 输入 ──► CommandService.dispatch ──► 静态表命中 → handler（runGuarded 包错误）
                                      └──► 技能回退（skills 注册表的投影，resolver 由插件注入）
                                      └──► 都不认 → false → 普通输入透传 agent.send

SIGINT：
  cli handleInterrupt ──► agent.cancel(cause)  busy 时 agent 自己经 ui 报告"(interrupted)"
```

**CommandService 的域逻辑**：斜杠解析（`/name args`）、静态表查找、技能回退（setSkillResolver 注入——技能是动态注册表，不是静态命令）都收在 service；cli 只剩 `exit/quit`（REPL 交互词）+ dispatch + 透传。欢迎横幅的命令清单消费 `commands.list()`——注册序即展示序。

**UiService 的两格渲染器**：`consoleRenderer` = 旧 ui.ts 实现的逐字节转接；`setRenderer(null)` = 静默（测试/未来 headless）。工具调用横幅从"agent 直印"改为"onAppend 驱动"——同函数同参数，视觉零变化（ch1 冒烟逐字节对照过）。

**cancel(cause)**：旧 cli 判 busy + 自己打印；新 cancel 里判 busy + 经 ui 报告 cause。CLI 仍保留的知识只剩 sigintCount 两连退出计数——那是 REPL 交互节奏，不是 agent 的事。

## 3. 设计决策记档

1. **两个面，不是一层**：把 48 个直印点全改成日志事件是过度工程——goal 状态行、分类器降级这类旁白不是会话事实（resume 不需要重放它们），硬塞进日志会污染"日志即真相"。分层后：事实走日志（resume/回放/UI 三方同源），旁白走服务（渲染器可换）。与 dsh 的差距（连叙事也是 surfaceOp 事件）记档，留真 dsh 对照。
2. **assistant 流式文本不走日志**：增量文本是传输过程不是会话事实，且日志里已有完整的 assistant/message 事件——走日志渲染必然双打。流式渲染 = ctx.ui.text(delta)，与日志解耦。
3. **require 严格读取不放松**：ui/tools/session-log 是 agent 树的保底公民，插件 apply 时 require 直说依赖；代价是 4 个测试文件 7 棵裸树补公民——D6 教训的延续："树的公民表也是缝的一部分"。
4. **USAGE（--help）保持静态**：它在 agent 构造前打印（--help 短路），消费不了注册表；横幅（REPL 内）才消费。

## 4. 实现与验证记录

**文件**：`services/commands.ts`、`services/ui-service.ts`、`plugins/commands.ts`（新增）；`cli.ts`（slash 链 130 行 → dispatch 一处；横幅消费注册表；SIGINT 交 cause）；`agent.ts`（print* 直印清零、printToolCall 消亡、cancel(cause)、commands 公开访问器）；`plugins/{autonomy,auto-approval,compaction,approval,subagent}.ts`（print* → ctx.ui.*，approval 的 fallback provider 改闭包 ui 的工厂）；`ui.ts`（死函数清退：printWelcome/printToolResult/printUserPrompt/printDivider）；`cordis-tests/{c1,c2,c5,d3}`（7 棵裸树补 ui 公民；c2 分类器桩维持 llm 缝）。

**验证**：cordis **131/131**；mock **27 场景全绿**（E1 不动引擎语义，全部零断言变更）；ch1 输出人工对照（工具调用横幅改由日志驱动后逐字节如常）。**REPL 全功能手测留给用户终端**（验收另一半）：清单见下。

**REPL 手测清单**（`npx tsc && node dist/cli.js`）：
1. 横幅命令清单来自注册表：`/clear /plan /cost /compact /goal /loop /memory /skills`
2. `/cost`、`/memory`、`/skills` 即打即回；`/clear` 出 "(history cleared)"
3. `/plan` 切换后提示词变化；`/compact` 空会话安全（太短不值得摘要）
4. 处理中 Ctrl+C → "(interrupted)" 回提示符；空闲单击 → 提示两连、双击 → Bye! 退出
5. `/<skill-name>` 技能回退（有 skills 目录时）；未知 `/foo` 透传给模型
6. `exit` / `quit` / Ctrl+D 正常退出

**翻车记档**：
1. **sed -i 两次把文件清空成 0 字节**（autonomy.ts、compaction.ts，同一天同死法）——本环境（Git Bash/Windows + 沙箱写路径）的 `sed -i` 不可信。两次都靠 `git checkout --` 从 HEAD 救回，**前一章及时提交是唯一的救命稻草**。教训：机械替换改用 Edit 的 replace_all；任何 sed 后立刻 `wc -l` 验尸。
2. **死函数清退漏了根目录模块**：删 printRetry 时 grep 范围只写了 agent/cli/plugins/services，retry.ts 在根目录漏网（tsc 抓住）。教训：删"无人引用"前 **repo 全域 grep**（`--include` 全后缀、含根目录散文件）。
3. **tsc 是这条流水线的最后一道闸**：两次事故都没能溜进构建产物——类型检查在，手滑就只是"慢"而不是"坏"。别绕过它。

## 5. 自测三题（答案在文末）

1. 工具调用横幅改为日志驱动后，"渲染顺序 = 日志顺序"靠什么保证？如果 UI 渲染是异步的会怎样？
2. assistant 流式文本为什么必须走 ctx.ui.text 而不是消费 assistant/message 事件？
3. cancel(cause) 之后，CLI 对中断还剩什么知识？为什么这点留在 CLI 是对的？

> **答案**：
> 1. onAppend 是同步回调、按 append 序触发——渲染函数只是 console.log，无排队无重排，顺序天然等于日志序。若渲染异步化（批量 flush/IPC），顺序要靠事件里带序号在渲染端重排——dsh 的 surface 层带 surfaceOp 就是为跨进程渲染准备的；进程内同步回调把这整层省了。
> 2. 双打：流式增量打一遍，settle 后 assistant/message 事件再打一遍全文。且增量不是会话事实——resume 重放不需要"重新流式一次"。日志驱动适合"终态事实"（tool/call 的横幅），流式是"过程画面"，两者物理上是两个通道。
> 3. 只剩 sigintCount（两连退出计数）。因为那是**交互节奏**：两次 Ctrl+C 的间隔判断是 readline REPL 的 UX 约定，agent 不该有"第几次 Ctrl+C"的概念；而"打断要报告、报告长什么样"是引擎+渲染器的事——cancel(cause) 收走了后者，CLI 只管节奏。

## 6. 遗留与下章（E2）

- `retry.ts` 的 printRetry 是引擎侧最后一个直印（模块无树访问，改造要动 withRetry 签名传回调）——记档，顺手章再收。
- dsh 全事件化（叙事也是 surfaceOp）与跨进程渲染差距已记档，真 dsh 对照时再议。
- **E2 bundle/profile 简版**：插件清单分层（base + app patch）+ `--patch` 覆盖 + `--dump-config`。验收：同一份 my_src 两条配置组装出"全功能"与"无 auto-mode"两个 agent。
