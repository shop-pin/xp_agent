# dsh 演变教学方案（总纲）

> 目标：把 my_src（单体直调的 mini Claude Code，约 4100 行）演进为一个 **dsh（DeepSeek Harness）风格的 agent**——"一切皆插件"、事件驱动、日志即真相。
> 本文档是本阶段的权威进度记录，随章更新。每章的详细讲解写入 `my_docs/dsh-<章号>.md`。
> **操作层规划见 `dsh-00-chapters.md`**（每章交付物/步骤/验收/危险点 + 目标目录结构 + 迁移总纪律），开工前先读它的"0. 全局约定"。
> 参照物：`E:\xp_agent\deepseek-harness-master`（下称 dsh 仓库）。命名沿用上一轮惯例：我们手写的框架叫 **mini-cordis**。

---

## 一、dsh 是什么：三个核心思想

上一轮我们复现的是 Claude Code 的**功能面**（循环、工具、压缩、auto mode……）。dsh 的价值不在功能多，而在**结构**：同样的功能，全部长在同一个框架上。三个思想贯穿全部：

### 1. 一切皆插件（Cordis 框架）
- 程序 = 一棵插件树。模型适配器、工具注册表、会话日志、agent 循环本身，全都是插件，都能从配置里替换。
- 插件三形态：函数 `(ctx, config)` / 类 / `{ apply(ctx, config) }` 对象。`apply` 是唯一入口。
- **服务**：插件在 `ctx.<key>` 上认领一个名字（`ctx.tools`、`ctx.llm`、`ctx.agents`…），消费方用 `inject = ['tools']` 声明依赖，框架把插件扣住直到依赖就绪。
- **注册即可撤销（effect 模型）**：一切注册（工具、监听器、子插件）都是 effect，返回 disposer；插件卸载时按栈回滚。HMR、测试隔离、per-agent 作用域全靠它。
- **事件是扩展点**：五类派发（emit/parallel/serial/bail/waterfall）。其中 **waterfall = around 中间件**：监听器收到 `(...args, next)`，调 `next()` 委托，不调 = 否决。dsh 的权限审批、请求拦截、turn 停止全是它。

### 2. 日志即真相（model-visible ⟺ logged）
- my_src 里 `this.messages` 数组就是历史；dsh 里消息是**事件日志的投影**。压缩不是改历史，是加一层"replace 投影"遮住旧节点，日志永不改写。
- 好处：resume、fork、遥测、UI 回放全部从同一份日志推导，不需要各自存状态。
- 每条 `assistant/message` 内嵌完整流记录：一次模型调用 = 一条持久结算。

### 3. 能力接缝（capability seam）
- 任何能力 = 三角色：**服务定义**（接口）、**服务提供者**（实现）、**消费者**（常是工具）。换提供者即换整个能力：文件系统指向远程沙箱，Bash/PTY/LSP 跟着走，无需改消费者。
- 循环本身可替换：消费者只依赖 `Agent` 接口（`ctx.agents`），不依赖 `agent-loop` 包。

**参照地图**（dsh 仓库，学习时按图索骥）：
| 主题 | 文件 |
|---|---|
| Cordis 框架（约 2700 行） | `vendor/cordis/src/{context,service,registry,events,fiber,reflect}.ts` |
| Cordis 入门 | `docs/cordis-primer.md`、`docs/cordis-tutorial/01..07` |
| 总架构 | `docs/architecture.md`（turn flow 一节必读） |
| 循环（约 2400 行） | `packages/core/agent-loop/src/{agent,index,inbox,tool-calls,assistant-stream}.ts` |
| 会话日志 | `packages/core/session/src/index.ts`、`surface.ts` |
| 工具管线 | `packages/core/tools/src/index.ts`、`schema.ts` |
| LLM 接缝 | `packages/llm/llm/src/index.ts`、`types.ts`、`assembler.ts`；实例 `llm-deepseek/src/` |
| 系统提示词 | `packages/core/system-prompt/src/index.ts` |
| 插件范例 | `packages/todo/tool-todo/src/index.ts`（212 行，最佳入门样本） |
| 无 key 回放测试 | `pnpm run test:snapshot`（录制回放，自带 fixtures） |

---

## 二、差距地图：my_src 的硬编码点 → dsh 的机制

上一轮盘点（14 模块、4116 行）：`agent.ts` 是 1311 行 god class，12 处硬编码耦合。它们就是本课程的改造对象：

| # | my_src 现状 | dsh 机制 | 章节 |
|---|---|---|---|
| 1 | 工具=数组+switch dispatch，新增工具要动 4 个文件 | `ctx.tools.register()` 注册表 + 插件 | C1 |
| 2 | 权限是 agent 循环里的九段 if 流水线 | `tools/pre-execute` 瀑布 + approval seam + 单调 guard | C2 |
| 3 | `this.messages` 直传 API，压缩原地改写 | SessionEvent 追加日志 + deriveMessages 投影 | C3 |
| 4 | `chat()` 单入口、`while(true)` 循环 | Agent handle + inbox/claim + turn/step 状态机 | C4/C5 |
| 5 | plan/goal/auto/loop 都是循环内 `if(mode===...)` 分支 | `agent/pre-step`、`agent/turn-stopping` 等事件监听器 | C5/D6 |
| 6 | Anthropic SDK 直调散布 5 处 | `LlmAdapter` + StreamChunk 词汇表 + `ctx.llm` | C6 |
| 7 | system prompt 手拼字符串 | section 注册表 + order + `{{var}}` + 工具 schema 自动汇入 | C7 |
| 8 | saveSession 存 JSON 快照 | JSONL 追加 + 日志重放恢复 | C8 |
| 9 | skills：工具+CLI slash+system 拼描述三处耦合 | provider registry + 目录注入 + 工具 | D1 |
| 10 | MCP：Agent 私有字段 + 名字前缀 dispatch | 独立插件 + syncTools 两代切换 | D2 |
| 11 | 子 agent：父类直接 `new Agent()` | `ctx.agents` registry + per-agent scope | D3 |
| 12 | memory prefetch 轮询注入末条 user 消息 | turn 边界监听器 + `agent.inject()` | D4 |
| — | CLI slash 命令 if 链、UI 直接 print | `ctx.commands` 注册表 + UI 纯消费 `session/event` | E1 |
| — | 插件清单写死在 import | bundle/profile 分层组合 + patch 覆盖 | E2 |

---

## 三、关键决策

1. **手写 mini-cordis**（B 阶段，约 600-900 行），以 `vendor/cordis` 源码为参照物——沿用上一轮"读懂→照结构写"的复现法。不建议直接 npm 依赖真 Cordis：框架是 dsh 一切设计的根，跳过它等于跳过本课程一半的认知量。读完真 Cordis 的 `fiber.ts`（754 行）后，手写版只取主干：Context/Service/inject/effect/事件五派发/waterfall/子 fiber 级联，**不做** HMR、epoch 重入加固、`isolate`/`intercept`（这两个在 B5 讲原理、标注"真框架有、我们略"）。
2. **my_src 原地演进**，不另起目录。新增 `my_src/cordis/`（框架）与 `my_src/plugins/`（插件），旧模块逐章迁空后删除。
3. **行为等价是每章验收线**：C 阶段每章结束，现有 22 个 mock 场景必须全绿（个别断言因语义升级需微调时，在该章文档中单独列出"断言变更说明"）。
4. **语言与运行时**：继续 TS + Node ESM；SDK 后端保持"mock 优先、glm 真机可选"（C6 后 dsh 式适配器让换后端变成一个配置行——这本身就是课程卖点）。
5. **与收尾队列的关系**：原队列（ch14 真机复验 → 思考题回补 → 真 CC 第二轮）中，真机复验可随时插入（与本章无关）；思考题回补遇到相关主题时并入对应章的"思考题"节；真 CC 第二轮被本课程取代。

---

## 四、课程表（五阶段，约 24 章）

> 约定：每章四件套——**原理讲解**（我讲，入 `my_docs/dsh-<n>.md`）、**动手**（设计层你写，我 review）、**代填**（卡住时我补实现并逐处讲解）、**验收**（mock 场景/新增断言）。标 ★ 的章是大章，允许跨多次会话。

### 阶段 A：认知准备（1 章，不写代码）

**A0 建立 dsh 体感**
- 做：读 `docs/architecture.md` + `docs/cordis-primer.md`（对照本方案第一节）；跑 `pnpm run test:snapshot -t <任一>` 看无 key 回放长什么样；`dsh --profile web --dump-config` 的输出样例在 docs 里找一张图看。
- 产出：`my_docs/dsh-00-notes.md` 体感笔记（一页即可）：三个核心思想各自的"最让你意外的点"。
- 不做：不装依赖、不跑需要 key 的东西。

### 阶段 B：手写 mini-cordis（6 章）★地基

**B1 服务容器：Context 与 inject**
- 原理：Proxy 包装的服务表；`ctx.x` 只许读注入过的服务（get 陷阱抛错）；`Service` 基类 + `super(ctx, 'name')`；`declare module` 补类型（declaration merging）。
- 参照：`vendor/cordis/src/context.ts`、`service.ts`、`reflect.ts`（get 陷阱）。
- 动手：`my_src/cordis/context.ts` + `service.ts`；写两个玩具插件互相注入。
- 验收：未注入读服务时抛错；注入后拿到实例；TS 类型检查通过。

**B2 插件与 Fiber**
- 原理：插件三形态；`ctx.plugin(P)` 创建子 Fiber；生命周期 `PENDING→LOADING→ACTIVE→DISPOSED`；`inject` 未就绪时 PENDING 等待。
- 参照：`vendor/cordis/src/registry.ts`、`fiber.ts`（状态机部分）。
- 动手：`cordis/fiber.ts` + `registry.ts`；依赖等待的时序测试。
- 验收：A 依赖 B 时，B 后挂 A 也能激活；B 缺席时 A 停在 PENDING。

**B3 effect 模型：注册即可撤销**
- 原理：`ctx.effect(fn)` 立即执行并收集 disposer；卸载时逆序并发执行；子插件的 dispose 挂在父 fiber 的 effect 上（级联）。
- 参照：`fiber.ts` 的 effect/unload 段。
- 动手：把 B2 的 Fiber 挂上 effect 收集与 `dispose()`；`ctx.on/register` 全部走 effect。
- 验收：挂载→卸载→所有副作用（监听器、子插件、定时器）消失；重复 dispose 安全。

**B4 事件系统**
- 原理：`Events` 接口 declaration merging；五类派发的语义差异（重点 serial 的 bail 条件、waterfall 的 around 语义）；**不调 next() = 否决**。
- 参照：`vendor/cordis/src/events.ts`、primer 的派发模式表。
- 动手：`cordis/events.ts`；一个用 waterfall 改写行为的示例插件（如"所有字符串事件翻大写"）。
- 验收：五类派发各一条断言；waterfall 不调 next 时默认行为不执行。

**B5 子上下文与作用域**
- 原理：`Fiber = parent.extend()` 原型继承父服务；agent 级 scope = 每个实体一个子 fiber；dispose 级联；`isolate`/`intercept` 原理讲清、实现略。
- 参照：`fiber.ts` 构造函数、`context.ts` 的 extend。
- 动手：`cordis/scope.ts`：`createScope(parent)` 返回子 ctx；模拟"每个 agent 一棵私有注册树"。
- 验收：scope 里注册的工具只在该 scope 可见；scope dispose 不影响父。

**B6 配置组装 loader（B 阶段收官）**
- 原理：cordis.yml 是 `{id, name, config, disabled}` 条目列表；id 是稳定身份；激活顺序由 inject 依赖驱动而非书写顺序；bundle/profile = 分层 patch（讲原理，实现做简版：数组叠加 + 按 id 定位）。
- 参照：primer 的 loader 配置节、`packages/bundle/base/cordis.patch.yml`。
- 动手：`cordis/loader.ts`：读 JS 配置数组（暂不解析 YAML）→ 排序挂载 → 输出已激活插件树（原型的 `--dump-config`）。
- 验收：**B 阶段总验收**——用 mini-cordis 组装一个"玩具 harness"：配置行增删即增删能力。

### 阶段 C：核心服务插件化（8 章）★把单体切开

**C1 工具注册表**
- 原理：`ToolDefinition` 全貌（dsh 比我们的 ToolDef 多什么：output.schema/render、isConcurrencySafe、timeoutMs、presentCall/Result）；注册表服务；插件注册工具。
- 参照：`packages/core/tools/src/index.ts`（接口定义）、`docs/cookbook/adding-a-tool.md`。
- 动手：`ctx.tools` 服务 + `ctx.tools.register(def)`；把 12 内置工具迁成 2-3 个插件（core-fs / core-exec / core-agent）；`executeTool` switch 消亡，dispatch 查注册表。
- 验收：mock 全绿；临时写个测试插件注册 `echo` 工具，模型可调用，插件卸载后消失。

**C2 工具执行管线与权限瀑布**
- 原理：prepare/dispatch/finalize/finish 四段；`tools/pre-execute`（allow/deny/cancel/ask）→ approval seam → 单调 guard（listener 不能把别人的 deny 翻回 allow）；权限策略与工具能力正交。
- 参照：`tools/index.ts` 管线段、`docs/subsystems/tools.md`。
- 动手：`permissions.ts` 九段流水线重写为 pre-execute 监听器；READ_TOOLS 等硬编码集合变成工具元数据字段；confirmFn 变成 approval 提供者。
- 验收：mock 权限相关场景全绿；新增一条测试"deny 后另一个 listener 无法翻案"。

**C3 会话事件日志 ★本轮最核心认知跃迁**
- 原理：SessionEvent 追加日志；五种消息事件；`deriveMessages()` 投影；"model-visible ⟺ logged"；压缩即投影 replace（先立规矩，D5 才真正迁移压缩）。
- 参照：`packages/core/session/src/index.ts`（deriveMessages）、`surface.ts`。
- 动手：`session-log.ts`：事件类型 + append + derive；`agent.ts` 的 `this.messages` 改为 derive 缓存；所有 push 消息的代码改为 append 事件。
- 验收：**请求体逐字节等价**——mock 断言锚请求体，本章derive 出的请求必须与改造前完全一致（差异只允许来自显式列出的语义升级）。

**C4 Agent handle 与 inbox**
- 原理：Agent 接口（id/inbox/status/ctx/send/cancel…）；inbox 的 next-turn/next-step 两队列与 claim；wake/latch 驱动（idle 才开 turn）。
- 参照：`packages/core/agent/src/{types,runtime-types}.ts`、`agent-loop/src/inbox.ts`、`agent.ts`（phase/wakeDriver）。
- 动手：`AgentHandle` 类替换 `chat()` 入口：`send()`/`followup()`/`steer()`/`cancel()`；循环改 claim 驱动。
- 验收：mock 全绿；新断言：turn 进行中 send 的消息进入 next-step（下一步注入）而非丢失。

**C5 循环事件化 ★大章**
- 原理：turn/step 事件序列（对照 architecture.md turn flow 图）；`agent/pre-step`（改写/拒绝输入）、`agent/request`（拦截模型调用）、`agent/turn-stopping`（挽留续命）；失败补 missing tool results。
- 参照：`agent-loop/src/agent.ts`（turn/step/preStep）、`docs/agent-lifecycle.md`。
- 动手：plan mode / goal / auto mode / loop 的硬编码分支全部改挂事件：plan=pre-step 改写+工具白名单、goal=turn-stopping 评估挽留、auto=pre-step 分类器、loop=wakeup 注入；`contextCleared` 布尔、mode 状态机分支消亡。
- 验收：goal/loop/auto/plan 全部 mock 场景全绿；新增断言"goal 评估 reject 时 turn 以 blocked 关闭"。

**C6 LLM 适配 seam**
- 原理：中立词汇表（ContentBlock/StreamChunk/FinishReason/TokenUsage）；`LlmAdapter` 抽象（只有 stream() 必须）；`ctx.llm.registerAdapter` 路由；prepareCall 绑定模型代；`llm/stream` 瀑布；`withRetry` 迁为 retry 中间件。
- 参照：`packages/llm/llm/src/{index,types,assembler}.ts`、`llm-deepseek/src/{adapter,serialize,translate}.ts`。
- 动手：`llm.ts` + `adapter-anthropic.ts`（现有 SDK 逻辑整体搬入）；5 处直调收拢为 `ctx.llm` 调用。
- 验收：mock 全绿；写一个 20 行的 `adapter-echo`（复读最后一个 user 消息）验证换后端=换配置。

**C7 system prompt 服务**
- 原理：section 注册表 + 中央 order + `{{var}}` 严格插值；工具 schema 由 tools 服务自动汇入（provider 注册到 prompt 服务）；缓存断点策略上收到请求组装层。
- 参照：`packages/core/system-prompt/src/index.ts`。
- 动手：`prompt.ts` 分解为 section 插件（identity/memory/env/skills…）；`buildDynamicSystemContext` 消亡。
- 验收：mock 全绿（请求体 system 字段等价，允许顺序由 order 表显式控制的微调）。

**C8 会话持久化**
- 原理：JSONL 追加文件 + 写句柄独占；resume = 日志重放投影；崩溃恢复=补合成 closers（简化版：补 turn/end）。
- 参照：`packages/core/session/src/` 持久化部分。
- 动手：`session.ts` 重写为 JSONL append；`loadSession` 变重放；resume 恢复 mode/费用/激活工具（超越旧版能力）。
- 验收：mock 全绿 + 新场景"save→load→继续对话，请求体一致"。

### 阶段 D：能力插件化（6 章）

**D1 skills 插件化** — provider registry（同名按 rank 竞争）/文件扫描/目录注入（catalog user message）/skill 工具；对照 dsh 三层分工（`packages/skill/`）。验收：inline/fork 场景全绿；写一个 rank 覆盖测试。
**D2 MCP 插件化** — `mcp__<server>__<tool>` 命名纯函数、syncTools 两代切换（先建新再撤旧）、`projectContent` 处理图片（简化：文本 only）。参照 `packages/mcp/mcp-client/src/tools.ts`。验收：mcp 场景全绿。
**D3 subagent 插件化** — `ctx.agents` registry、per-agent scope（B5 红利：剥 agent 工具变成 preset 能力而非 if）、initiator 归属（简化为显式传参，讲 AsyncLocalStorage 原理）。验收：subagent 场景全绿。
**D4 memory 与上下文注入** — `agent.inject()` 缝（注入下一步请求）；memory prefetch 变 turn 边界监听器；CLAUDE.md 走专槽。验收：memory 场景全绿。
**D5 compaction 插件化** — 四层压缩迁到投影 replace 语义（C3 立的规矩在这里兑现）；/compact 命令；SNIPPABLE_TOOLS 变工具元数据。验收：压缩场景请求体等价。
**D6 goal/loop/auto 收尾** — schedule_wakeup 字段回传协议换成 `ctx.schedule` 服务；三态 goal 评估器/两段 auto 分类器/动态 loop 全部监听器化收口。验收：对应场景全绿。

### 阶段 E：收尾（3 章）

**E1 UI/CLI 纯消费者化** — `ctx.commands` 命令注册表（slash 命令=插件注册）；ui.ts 改为消费 `session/event` 渲染（进程内即可）；SIGINT→cancel(cause)。验收：REPL 全功能手测 + mock 冒烟。
**E2 bundle/profile 简版** — 插件清单分层（base 层 + app 层 patch）+ `--patch` 覆盖 + `--dump-config`。验收：同一份 my_src，两条配置分别组装出"全功能"与"无 auto-mode"两个 agent。
**E3 snapshot 回归与收官** — 给自己搭录制回放（对齐 dsh `test:snapshot` 思路：录请求/事件序列，无 key 重放断言）；全量场景迁移总验收；收官文档：mini-cordis vs 真 Cordis 差异清单 + dsh 源码导读地图。

---

## 五、测试与回归策略

- **主线**：`run-mock.mjs` 现有 22 场景是回归安全网，C/D 每章必须全绿后再进下一章。
- **新增测试**：B 阶段为框架行为写单元场景（挂载/卸载/等待/瀑布）；C 阶段新增"行为升级"断言（如 C4 的 mid-turn send、C8 的 resume）。
- **mock 演进**：`mock-anthropic.mjs` 锚的是 Anthropic 请求体。C6 后请求组装走适配器，mock 语义不变（anthropic adapter 产出同样的请求体）；E3 的 snapshot 体系接管后可逐步退役部分 ad-hoc 断言。
- **真机**：C6 后可用 glm 适配器真机冒烟（沿用 ch14 纪律：`--accept-edits`、日志直写文件、破坏探针一次性目标）。

## 六、进度表（随章更新）

| 章 | 状态 | 完成记录 |
|---|---|---|
| A0 | 未开始 | — |
| B1..B6 | 未开始 | — |
| C1..C8 | 未开始 | — |
| D1..D6 | 未开始 | — |
| E1..E3 | 未开始 | — |

> 约定：每章完成时在本表打勾，并在 `my_docs/dsh-<n>.md` 末尾附"翻车记档 + 思考题"（沿用上一轮格式）。
