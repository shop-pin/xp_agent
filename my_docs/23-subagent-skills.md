# ch23：Sub-agent 与 Skills 完整版

> 进阶轮第 8 章（ch16 起）。参照 `src/subagent.ts`（200 行）+ `src/skills.ts`（176 行）+ `src/agent.ts` fork 接线。
> my_src 现状：subagent.ts 34 行（ch11 简版，仅 explore）、skills.ts 19 行（ch9 简版，.mini-skills/*.md）。

## 一、原理：为什么要 Sub-agent（fork-return 模式）

**核心问题**：主对话的上下文有限。比如"这个 bug 在哪"这种探索任务，子 agent 要读十几个文件、grep 一堆结果——如果全发生在主对话里，搜索噪音把窗口塞满，真正干活的余量就没了。

**解法：fork-return（分叉-回传）**

```
父 Agent（主对话）
  │ new Agent({ customSystemPrompt, customTools, isSubAgent: true })
  ▼
子 Agent：独立的 messages 历史，自己跑完整 agent loop
  （模型↔工具循环，搜索噪音全留在子对话里）
  │ 跑完只回传两样东西：
  ▼
  ① 最终文本报告（作为 tool_result 进父对话）
  ② token 用量（累加进父 Agent 的四计数，费用统计才完整）
```

要点：
1. **上下文隔离**：脏活在隔间里干，只递结果出来。
2. **子 agent 不是独立进程**——就是同一个 Agent 类的另一个实例，`new` 一份，带定制参数。
3. **token 回传**：子对话的消耗也是真实成本，`runOnce` 用差值法（跑前跑后各记一次总量）把增量交回父级。

### 架构前提：Agent 必须可实例化

my_src 的 Agent 目前是无参单例（`constructor()`）。fork 的前提是构造参数化：

```ts
new Agent({
  customSystemPrompt: "...",  // 子 agent 的系统提示（替代默认的 static+dynamic 双块）
  customTools: [...],         // 裁剪过的工具集
  isSubAgent: true,           // 行为开关：不连 MCP、不 autoSave、不打 spinner/cost
})
```

`customSystemPrompt` 时：整个系统提示视为纯静态块（子 agent 一次性任务，缓存收益低），跳过 `buildDynamicSystemContext()`（env/git/memory 索引）和 `buildUserContextReminder()`（CLAUDE.md 进首条 user 消息）——子 agent 不需要项目上下文，它的"上下文"就是父 agent 传给它的任务描述。

### 自定义 agent 类型（.claude/agents/*.md）

```markdown
---
name: reviewer
description: Reviews code changes for quality
allowed-tools: read_file, grep_search, list_files
---
You are a code review specialist...（body 整个成为子 agent 的 system prompt）
```

发现顺序与覆盖：`~/.claude/agents/`（user 层，先加载）→ `<cwd>/.claude/agents/`（project 层，后加载**覆盖同名**）。实现上就是一个 Map 顺序 `set`——后 set 的同 key 自然覆盖。与 ch22 memory 的 user/project 双层同套路。

**白名单语义**（getSubAgentConfig）：
- `allowedTools` 有值 → `toolDefinitions.filter(t => allowedTools.includes(t.name))`
- 没值 → 全量工具但**去掉 agent**（子 agent 不许再生子 agent，防递归爆炸）
- 内置 explore/plan → 只给只读三件套（read_file/list_files/grep_search）

**缓存**：discover 一次后缓存（文件 IO 别每轮工具调用都跑），`resetAgentCache()` 供测试重置。

## 二、Skills：带元数据的提示词模板

Skill 与 sub-agent 的分工：
- **agent 工具**：模型自主派活（模型调用，任务导向）
- **skill**：主要用户 `/命令` 触发，模型也可经 skill 工具调用（流程导向——把一段预置的作业流程注入）

SKILL.md 结构（`.claude/skills/<name>/SKILL.md`）：

```markdown
---
name: commit
description: Create a git commit
user-invocable: true          # false 则只在系统提示里给模型自动调用
context: inline | fork        # inline=模板注入对话；fork=派给子 agent 隔离执行
allowed-tools: read_file, run_shell
---
提示词模板…… $ARGUMENTS …… ${CLAUDE_SKILL_DIR} ……
```

**两种执行模式**（双入口分流）：
- **inline**：把模板解析后的文本以 `[Skill "x" activated] + prompt` 返回为 tool_result——模型在主对话里看到后照做，共享主上下文。轻量，适合"提醒模型按某流程办事"。
- **fork**：`new Agent({ customSystemPrompt: 解析后模板, customTools: 白名单过滤 })` + `runOnce(args)`，像 sub-agent 一样隔离执行。适合"干一票完整的活"。

**占位符替换**：
- `$ARGUMENTS` / `${ARGUMENTS}` → 用户传入的参数串
- `${CLAUDE_SKILL_DIR}` → 技能目录绝对路径（模板里引用配套资源文件用）

## 三、agent.ts 改造规格

| 改造点 | 内容 |
|---|---|
| AgentOptions | 裁剪版（单 Anthropic 后端）：`permissionMode?` `customSystemPrompt?` `customTools?` `isSubAgent?` |
| 构造参数化 | `this.tools = options.customTools \|\| toolDefinitions`；customSystemPrompt → 纯静态，跳 dynamic/reminder |
| outputBuffer/emitText | 子 agent 的最终文本不打印，收进 buffer；`runOnce` 跑完拼出来返回 |
| runOnce(prompt) | 设 buffer → 记 token 基线 → `chat(prompt)` → 差值算增量 → `{text, tokens}` |
| isSubAgent 分支 | 跳 MCP 初始化、autoSave、printCost、spinner（子对话的 UI 噪音不进父终端） |
| executeAgentTool | `getSubAgentConfig(type)` → new Agent → runOnce → token 回传 → 返回文本 |
| executeSkillTool | executeSkill 拿结果 → context==="fork" 走隔离执行（白名单过滤 customTools）/否则 inline 文本返回 |
| childPermissionMode | plan→plan、auto→auto、其余→bypassPermissions。**安全设计**：plan/auto 必须穿透——否则主对话里被拦的操作可以借 `agent(prompt="rm -rf /")` 让子 agent 绕过分类器执行（权限洗白） |
| dispatch | `chat()` 里内联的 agent 处理迁出；`if (name === "agent")` / `if (name === "skill")` 走类方法 |

## 四、本章 JS/TS 语义提示

- **带连字符的 frontmatter key**：`meta["allowed-tools"]` 必须方括号访问——`meta.allowed-tools` 会被解析成 `meta.allowed - tools`（减法！）
- **Map 覆盖**：`map.set(key, v)` 对已有 key 直接覆盖值——user→project 覆盖靠这个，不用写 if
- **statSync(path).isDirectory()**：判断目录项是不是目录（skills 是 `<name>/SKILL.md` 两级结构，agent 是单层 `*.md`，发现逻辑不同）
- **String.prototype.replace + 正则**：`prompt.replace(/\$ARGUMENTS|\$\{ARGUMENTS\}/g, args)`——`g` 标志替换全部，没有 `g` 只换第一处
- **JSON.parse 的输入是字符串**：skills 的 allowed-tools 支持 JSON 数组格式，`raw.startsWith("[")` 后 parse 的是 frontmatter 值字符串本身

## 五、分步计划

| 步 | 内容 | 谁 |
|---|---|---|
| 1 | subagent.ts：类型 + discoverCustomAgents/loadAgentsFromDir + getSubAgentConfig 白名单 | 用户写 |
| 2 | subagent.ts：3 内置类型 prompt 常量 + getAvailableAgentTypes/buildAgentDescriptions | 我给（机械转录） |
| 3 | skills.ts：parseSkillFile + resolveSkillPrompt | 用户写 |
| 4 | skills.ts：discoverSkills/loadSkillsFromDir + executeSkill + buildSkillDescriptions | 引导写/我补 |
| 5 | agent.ts：AgentOptions + 构造参数化 + outputBuffer/emitText/runOnce + isSubAgent 分支 | 引导写 |
| 6 | agent.ts：executeAgentTool + executeSkillTool 双入口分流 + childPermissionMode | 用户写 |
| 7 | tools.ts schema 对齐+skill 工具、prompt.ts 拼接、cli.ts 接线 | 我搭 |
| 8 | mock：ch9/ch11 迁移 + 自定义 agent 白名单断言 + fork track | 我搭，用户验 |
| 收尾 | 讲解+问题入档、commit message | — |

## 六、实现记录与问题（2026-09-21 收尾）

> 本章为**代填轮**（ch21/22 模式延续，用户明确要求代填后续步骤）。Step 1-3 由用户亲手写（subagent.ts 发现逻辑+白名单、parseSkillFile、resolveSkillPrompt），Step 3.5 起代填。回补时按小节对照 src。

### 6.1 用户亲手写部分的 review 记录

**subagent.ts（Step 1）**——4 个问题：

1. **🔴 `systemPrompt: GENERAL_PROMPT`（应为 `body`）**：loadAgentsFromDir 组装 CustomAgentDef 时把 .md 正文丢弃、全部塞 general 提示词——自定义 agent 变成 general 克隆，用户写什么都没用。frontmatter=元数据、body=内容（ch22 memory 同构）。**这是本章核心语义，用户自查修正**。
2. **🟡 GENERAL_PROMPT 被编辑器换行污染**：抄写时长行被折成三行，模板字符串里换行是真实内容，发到 API 的 prompt 就带硬换行。教训：抄大段 prompt 粘贴后扫行宽。
3. **🟡 import 混乱**：fs/tools 各导入两次、`import process from "process"`（Node 有全局 process）、无关的 readFile。已整理。
4. **🟢 正确**：双层加载顺序（user 先 project 后）、缓存、`.md` 过滤、`meta["allowed-tools"]` 方括号、`||` 兜底、白名单 `!` 断言、default 落 general——架子全对。

**skills.ts（Step 3）**——4 个问题（用户授权直接改）：

1. **🔴 对象字面量里写分号**（`description: meta.description || "";`）：老坑再现（ch15 记档过）。伪装升级版——`|| ""` 后跟分号看起来像普通赋值语句。区分口诀：`属性名: 值` 用逗号，`变量 = 值` 用分号。
2. **🔴 `meta["userInvocable"]` key 名写错**（应为 `"user-invocable"`）：方括号访问记住了，但 key 抄成了 TS 接口字段名。**meta 的 key 就是文件里出现的字符串**，两个世界的名字不同步。后果链：恒 undefined → 恒 `!== "false"` → user-invocable:false 完全失效——编译不报错、运行时不炸、多数技能没写该 key 时碰巧正确，纯静默失效。
3. **🟡 IDE 自动补全误触**：`import { ParseArgsConfig } from "util"` 无关系。
4. **🟢 正确**：basename 兜底、context 判断、allowed-tools 三分支（JSON.parse/兜底/逗号拆）、whenToUse 双 key 兼容、$ARGUMENTS 正则（\$ 转义、或、g 标志）全对。

**Step 2 抄写**：两个函数名抄丢复数 s（`getAvailableAgentType`/`buildAgentDescription`）。编译期被 tsc 抓住（prompt.ts import 报错）——编译器是抄写错误的第一道网。

### 6.2 代填部分逐处讲解

**AgentOptions 与构造参数化**（agent.ts）：
- `my_src` 无自定义 ToolDef（tools.ts 用 `Anthropic.Tool[]`），src 的 `ToolDef` 类型不适用——AgentOptions.customTools 用 `Anthropic.Tool[]`。
- `hasCustomPrompt` 布尔必须单独存：不能用 `staticSystemPrompt !== buildStaticSystemPrompt()` 判断（恰好相同的 custom prompt 会歧义）。

**buildAnthropicSystem / chat() 首条消息**：
- customSystemPrompt 时 dynamic 段（env/git/memory 索引）与首条 user 消息的 CLAUDE.md reminder 全部跳过——子 agent 是一次性任务，项目上下文是噪音，它的"上下文"就是父级传的任务描述。

**runOnce 与差值法 token 回传**：
- 跑前记基线 → chat → `(total - prev)` 得本次增量。子对话的消耗也是真实成本，累回父级四计数费用才完整。outputBuffer 收集最终文本（emitText 统一出口：buffer 存在时收、否则打印）。

**isSubAgent 行为开关**（对照 src 六处守卫）：
- 不连 MCP（`ensureMcp` 守卫 + mcpTools 置空）、不 autoSave/printCost、不打 spinner、不跑 memory prefetch（子 agent 不该触发旁路查询）。
- **请求 tools 从 `[...toolDefinitions, ...mcpTools]` 改为 `[...this.tools, ...mcpTools]`**——这是白名单生效的物理通道：子 agent 广告什么工具完全由构造时传入的 customTools 决定。

**executeToolCall 分发器**：agent/skill/mcp/普通工具四路收敛。权限检查留在 chat 循环外层（src 同构）——agent/skill 工具本身 checkPermission 落 allow（无副作用名单外）。

**childPermissionMode**：plan/auto 必须穿透（防权限洗白：主对话被拦的操作借 agent(prompt="rm -rf /") 让 bypassPermissions 的子 agent 执行）；其余落 bypassPermissions。

**executeSkillTool 双入口**：fork 时 tools 从**父的 this.tools** 过滤（不是全量 toolDefinitions）——skill 在子 agent 里 fork 时拿到的应是父工具集的子集。inline 返回 `[Skill "x" activated] + 解析模板`。

**cli.ts 对齐决策**：one-shot **不再解析斜杠命令**（src 行为：skill 触发只在 REPL 的 `/<name>`）；REPL 加 `/skills` 列表 + `/<name>` 分流（fork 借模型之手：chat 提示语让模型调 skill 工具，由 executeSkillTool 派发）。

### 6.3 mock 场景设计决策

1. **ch9 迁移**：从"CLI 斜杠命令解析"改为"模型经 skill 工具 inline 调用"——src 对齐后 one-shot 不解析 skill，旧断言（args appended、未知 /name 透传）随旧行为退役。新断言锚 `[Skill "commit" activated]` 前缀 + `$ARGUMENTS` 替换 + Unknown skill 报错。CLI 的 /<name> 入口走 REPL（mock 驱动只测 agent 层），靠真机冒烟。
2. **ch11 迁移**：sub track match 从 "explore sub-agent"（旧简版固定提示词）改为 "file search specialist"（EXPLORE_PROMPT 特征）；旧断言 `!system.includes("Mini Claude Code")` 失效（EXPLORE_PROMPT 里就有这个词）；**stream 断言反转**——src 的子 agent 也走流式（callAnthropicStream 是唯一通道），旧"sub 非流式"随 runSubAgent 退役；**write 拒绝断言删除**（见决策 3）；sub track 3 轮 → 2 轮。
3. **白名单只管广告（软约束）**——src 真实行为：executeToolCall 直接落 executeTool，模型硬调未广告的工具（如 write_file）会**真执行**。旧版 runSubAgent 的执行侧拦截（EXPLORE_TOOLS.includes 否则 Denied）没有对齐过来。硬防线是权限层。已记教学思考题。
4. **ch23 新场景**：project 层 `.claude/agents/researcher.md`，断言"custom body 成为 system（且非内置提示词）+ 白名单恰好 2 工具（tools.length===2）+ fresh context + 结果回传"。
5. **ch23b 新场景**：context:fork 的 SKILL.md，断言"解析后模板成为 fork system（$ARGUMENTS 已替换）+ 白名单过滤 + 结果回 main"。track match "Audit task" 撞 main system 风险已排查（main 的 skillsSection 只有 description "Run a heavy audit"，无该字样）。

### 6.4 回归结果与遗留

- **19/19 全绿**（1-12,15,18-21,23,23b），ch9/ch11/23/23b 一次通过。
- 编译错误 4 处（ToolDef 未导出→改用 Anthropic.Tool、cli 残留 resolveSkill、函数名丢 s ×2），一轮修完。

### 6.5 思考题（回补时想）

1. agent 工具 schema 的 `type` enum 硬编码 `["explore","plan","general"]`——自定义类型名（researcher）不在 enum 里，真模型调 researcher 会被 enum 校验拒绝（mock 是脚本不受限）。**enum 应该动态拼接** `getAvailableAgentTypes()` 的名字。src 也有此粗糙点。怎么改？动态生成 schema 有什么代价（缓存/每次序列化）？
2. 白名单只管广告不管执行——如果要硬拦，在 executeToolCall 加 `this.tools.some(t => t.name === name)` 守卫行不行？会误伤什么？（提示：MCP 工具、skill fork 时父工具集的动态性）
3. 子 agent 复用整个 chat()（压缩 T1-T4、budget 检查全在跑）——子 agent 的 lastInputTokenCount 从 0 开始，压缩会对子对话独立生效。这是 feature 还是隐患？（提示：子对话一般短，T4 门槛高；但 runOnce 内 budget 未设所以不触发）
4. `runOnce` 里 outputBuffer 是实例字段且先置后清——如果 executeAgentTool 的子 agent 又调 agent 工具（嵌套 fork，虽然白名单挡了广告，但 custom.allowedTools 显式含 "agent" 时放行）会怎样？（提示：内层 runOnce 结束把 buffer 置 null，外层文本开始打印到终端——buffer 不是栈）

### 6.6 commit message

```
add fork-return sub-agents with custom agent types and SKILL.md skills
```
