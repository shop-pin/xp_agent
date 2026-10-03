# dsh 演变：分章实施规划

> 总纲见 `dsh-00-plan.md`（策略与差距地图）。本文是**操作层**：每章做什么、动哪些文件、按什么顺序、怎么算完成。
> 每章开工时再展开成 `dsh-<章号>.md`（原理讲解 + 当章问题记录 + 翻车记档 + 思考题），本文只保留规格。

---

## 0. 全局约定

### 0.1 目标目录结构（E3 完成时）

```
my_src/
  cordis/                 # mini-cordis 框架（B 阶段产物，~800 行）
    context.ts            #   Context、Proxy 服务表、Service 基类
    fiber.ts              #   插件生命周期、effect、级联 dispose
    events.ts             #   事件总线、五种派发、waterfall
    scope.ts              #   子上下文（per-agent 作用域）
    loader.ts             #   配置行组装 + dump-config
  services/               # 服务定义层（只有接口/注册表，不含具体能力）
    tools.ts              #   ctx.tools：注册表 + 执行管线（C1/C2）
    session-log.ts        #   ctx.sessionLog：事件日志 + deriveMessages（C3）
    llm.ts                #   ctx.llm：适配器路由 + StreamChunk 词汇表（C6）
    system-prompt.ts      #   ctx.systemPrompt：section 注册表（C7）
    agents.ts             #   ctx.agents：Agent 注册表 + scope（C4/D3）
    commands.ts           #   ctx.commands：slash 命令注册表（E1）
    schedule.ts           #   ctx.schedule：唤醒/排程（D6）
  plugins/                # 一切能力都是插件
    core-fs-tools.ts      #   read/write/edit/list/grep（C1）
    core-exec-tools.ts    #   run_shell/web_fetch（C1）
    core-meta-tools.ts    #   tool_search/enter/exit_plan（C1）
    approval.ts           #   权限九段 → pre-execute 监听器（C2）
    llm-anthropic.ts      #   Anthropic 适配器（C6）
    adapter-echo.ts       #   教学用最小适配器（C6）
    prompt-sections.ts    #   identity/env/claude-md/memory/skills sections（C7）
    session-jsonl.ts      #   JSONL 持久化提供者（C8）
    compaction.ts         #   四层压缩（D5）
    memory.ts             #   记忆 prefetch/inject（D4）
    mcp-bridge.ts         #   MCP 桥接（D2）
    skills-registry.ts    #   skill provider registry + tool-skill（D1）
    subagent.ts           #   agent 工具 + registry（D3）
    autonomy.ts           #   plan/goal/auto/loop 监听器（C5/D6）
    commands.ts           #   slash 命令注册（E1）
    ui.ts                 #   session/event 消费渲染（E1）
  agent.ts                # 收缩为 bootstrap：建根 ctx → loader 挂插件 → 暴露 handle
  cli.ts                  # REPL：读输入 → handle.send()；命令走 ctx.commands
  cordis.config.ts        # 插件清单（base 层 + app 层，B6 起、E2 分层化）
  …旧模块按章迁空后删除
```

### 0.2 迁移总纪律

1. **先立后破**：每章先加新机制并让旧旧路径并存，mock 全绿后再删旧路径。禁止一步到位式重写。
2. **每章验收线 = 22 个 mock 场景全绿**（`node run-mock.mjs`）+ 该章新增断言。语义升级必须改断言时，在当章 `dsh-<n>.md` 里写"断言变更说明"（改了哪条、为什么、等价性论证）。
3. **请求体是最高法官**：mock 锚 Anthropic 请求体。凡是"行为没变"的章，请求体必须逐字节一致；凡是"行为升级"的章（C4/C8/D1/D5），差异必须能逐条指认。
4. **框架章（B）不碰业务**：B 阶段只写 `cordis/` + 玩具插件测试，不动 my_src 业务代码，22 场景保持绿（业务根本没被碰）。
5. 大章（C3/C5）跨多次会话时，按"步骤"小节切段，每段结束跑一次回归。

### 0.3 参照源码速查（dsh 仓库内路径）

| 主题 | 路径 |
|---|---|
| Context/Service/inject | `vendor/cordis/src/context.ts`、`service.ts`、`reflect.ts` |
| Fiber/effect/级联 | `vendor/cordis/src/fiber.ts` |
| 事件五派发/waterfall | `vendor/cordis/src/events.ts`、`docs/cordis-primer.md` |
| 插件三形态/registry | `vendor/cordis/src/registry.ts` |
| 循环主驱动 | `packages/core/agent-loop/src/agent.ts`、`index.ts` |
| inbox/claim | `packages/core/agent-loop/src/inbox.ts` |
| 工具调度 | `packages/core/agent-loop/src/tool-calls.ts` |
| 工具定义/管线/审批 | `packages/core/tools/src/index.ts`、`schema.ts` |
| 会话日志/投影 | `packages/core/session/src/index.ts`、`surface.ts` |
| LLM 接缝/词汇表 | `packages/llm/llm/src/index.ts`、`types.ts`、`assembler.ts` |
| 适配器实例 | `packages/llm/llm-deepseek/src/{adapter,serialize,translate}.ts` |
| system prompt | `packages/core/system-prompt/src/index.ts` |
| 最佳插件样本 | `packages/todo/tool-todo/src/index.ts`（212 行） |

---

## 阶段 A：认知准备

### A0 建立 dsh 体感（不写代码）

**交付物**：`my_docs/dsh-00-notes.md`（一页体感笔记）。

**步骤**：
1. 读 `docs/architecture.md` 的 **Turn flow** 一节（84-123 行附近），对照总纲第一节"三个核心思想"，画出一次 turn 的事件序列草图（手画或 ASCII，8-12 个事件）。
2. 读 `docs/cordis-primer.md` 全文，重点：插件三形态、inject、effect、waterfall 语义表。
3. 跑无 key 回放（在 dsh 仓库）：
   ```sh
   pnpm install && pnpm run build
   pnpm run test:snapshot -- -t session   # 任选一个 filter，看录制回放输出
   ```
   观察点：回放的不只是请求体，还有**事件序列**——这就是"日志即真相"的实物。
4. 打开 `packages/todo/tool-todo/src/index.ts`（212 行）通读一遍：name/inject/Config/apply/tools.register 四件套齐活，这是 B 阶段结束时你手写插件的模样。
5. 写笔记：三个核心思想各写一条"最意外的点" + turn 事件草图贴进去。

**验收**：笔记存在；能口头回答"waterfall 监听器不调 next() 会怎样"、"为什么压缩不用改日志"。
**危险点**：无。纯阅读章。

---

## 阶段 B：手写 mini-cordis（6 章）

> B 阶段产物是 `my_src/cordis/`，全部配玩具插件单测（新增 `run-cordis-test.mjs` 驱动，模式沿用 run-mock：断言行为而非打印）。

### B1 服务容器：Context 与 Service

**交付物**：`cordis/context.ts`、`cordis/service.ts`、`test/cordis-b1.*` 玩具插件。

**规格**（你写设计层，签名先定死）：
```ts
class Context {
  constructor(parent?: Context)
  // Proxy 陷阱：ctx.<name> → 服务表命中返回、未命中抛 Error('service not provided: <name>')
  // ctx.get<T>(name): T | undefined   // 可空读取，不抛
  internalDispatch(): ...            // on/emit/effect 先留空接口，后续章填
}
class Service {
  constructor(ctx: Context, name: string)  // 构造即 provide(name, this)
  protected ctx: Context
}
```
**步骤**：
1. （先讲概念）Proxy get 陷阱、Reflect.get、this 绑定丢失问题——你的历史坑点，先讲再写。
2. 写 `service.ts`：Service 基类，构造时写入父链服务表。
3. 写 `context.ts`：内部 `Map<string, unknown>` + `new Proxy(this, { get })`；子 Context 未命中沿 parent 链查。
4. 类型面：`declare module` merging 给 ctx 补类型（玩具 greeter：`ctx.greeter.greet()`）。**坑**：ESM 下 declaration merging 的模块说明符必须和 import 路径完全一致（含 `.js` 后缀），遇到问题记进当章文档。
5. 玩具测试：greeter 服务插件 + consumer 插件；未注入读取抛错断言。

**验收**：提供后可读、未提供抛错、子 ctx 继承父服务、tsc strict 通过。
**危险点**：Proxy 陷阱里返回方法时丢 this（用 `Reflect.get(target, prop, receiver)` 或绑定）；merging 不生效通常是模块说明符不匹配。

### B2 插件与 Fiber：生命周期与依赖等待

**交付物**：`cordis/fiber.ts`、`cordis/registry.ts`（挂到 Context：`ctx.plugin(P, config?)`）。

**规格**：
```ts
type PluginObject = { name?: string; inject?: string[]; apply(ctx: Context, config: unknown): void }
type Plugin = PluginObject | ((ctx, config) => void) | (new (ctx, config) => void)
type FiberState = 'pending' | 'loading' | 'active' | 'disposed'
class Fiber {
  state: FiberState
  constructor(parent: Context, plugin: Plugin, config?: unknown)
  refresh(): void   // inject 全部可解析 → 跑 apply（只跑一次）→ active；否则留在 pending
  inject: string[]
}
```
**步骤**：
1. 三形态归一化 `resolvePlugin(P) → PluginObject`（函数/类/对象）。
2. Fiber 状态机：构造→pending→refresh→loading→apply→active。
3. 依赖等待：`provide()` 发生后遍历所有 pending fiber 逐个 `refresh()`（真框架用 epoch 精确失效，我们用全量重查，讲清差异）。
4. `ctx.plugin()`：创建子 Fiber 并 refresh。
5. 时序测试三连：依赖先到/后到/永远不到（pending 挂起）。

**验收**：三个时序断言；apply 恰好执行一次；配置传参可达 apply。
**危险点**：provide 后忘通知 pending 队列（死等）；类形态插件 `new` 时 this 丢失。

### B3 effect 模型：注册即可撤销

**交付物**：fiber.ts 扩展（`ctx.effect`、`fiber.dispose()`）、`ctx.on` 前身接口。

**规格**：
```ts
ctx.effect(execute: () => void | (() => void | Promise<void>), label?: string): void
fiber.dispose(): Promise<void>   // 幂等；disposers 逆序启动、并发执行、单个抛错只记日志
// ctx.plugin 的子 fiber：其 dispose 注册为父 fiber 的一条 effect（级联卸载）
```
**步骤**：
1. Fiber 加 `_disposables` 数组；effect 立即执行并收集 disposer。
2. dispose：状态闸（disposed 后幂等返回）→ 逆序并发执行 → 吞错记日志（讲解：为什么并发、顺序敏感时怎么办——放同一 effect 自己 await）。
3. 接 B2 遗留：子 fiber dispose 挂父 effect；apply 中途抛错时回滚已注册 effect。
4. 测试：挂载（on + 子插件 + setInterval）→ dispose → 全消失；二次 dispose 安全；apply 抛错回滚。

**验收**：三条清理断言 + 幂等 + 回滚。
**危险点**：disposer 是 Promise 时未 await 就判完成；回滚顺序错导致清理时读到已卸载服务。

### B4 事件系统：五种派发与 waterfall

**交付物**：`cordis/events.ts`（挂 `ctx.on/emit/parallel/serial/bail/waterfall`），`interface Events {}` 供 merging。

**规格**（语义照抄 primer，逐一断言）：
```ts
interface Events { 'demo/text'(s: string): void }   // 用户自己 merge
ctx.on(name, listener): () => void                  // disposer 走 effect
ctx.emit(name, ...args): void                       // 同步广播不等待
ctx.parallel(name, ...args): Promise<void>          // 全并发 await
ctx.serial(name, ...args): Promise<void>            // 顺序 await；listener 返回非 null/false/undefined → 停（bail）
ctx.bail(name, ...args): ...                        // serial 的同步版
ctx.waterfall(name, ...args, inner): Promise<...>   // around 中间件：listener 收 (...args, next)
                                                    // 调 next() 委托（可改写返回值）；不调 = 否决（inner 也不执行）
```
**步骤**：
1. on/emit + Events merging（类型推导 listener 参数）。
2. parallel/serial/bail 三种 await 语义 + bail 判定。
3. waterfall：`next = () => cb(listeners.shift() ?? inner)` 闭包链——照 `vendor/cordis/src/events.ts` 的 waterfall 段抄结构。
4. on 注册改走 effect（B3 红利：插件卸载自动摘监听器）。
5. 测试：五派发各一条 + "不调 next() 连 inner 都不执行"否决断言 + 卸载后监听器消失。

**验收**：八条断言全绿。
**危险点**：waterfall listener 签名推导（`(...args, next)`）；serial 的返回值判定用 `!== undefined && !== null && !== false`，别写成 truthy。

### B5 子上下文与作用域（scope）

**交付物**：`cordis/scope.ts`。

**规格**：
```ts
function createScope(parent: Context): { ctx: Context; dispose(): Promise<void> }
// 内部 = 一个匿名 fiber：原型继承父链全部服务；scope 内的注册（工具/监听器/子插件）随 dispose 全部回滚
```
**步骤**：
1. 讲概念：fiber 树 = 作用域边界；dsh 的 per-agent scope 就是给每个 agent 一棵私有注册子树（参照 `packages/core/scope/src/index.ts`）。
2. 实现 createScope（基于 B2/B3 已有能力，几十行）。
3. 玩具 registry 服务 + 两个 scope 各注册同名不同实现 → 互不可见。
4. isolate/intercept **只讲原理不实现**（在当章文档记下真框架的行为，标注"略"）。

**验收**：scope 隔离断言 + scope dispose 不影响父断言。
**危险点**：作用域查找顺序（子遮蔽父）与 Proxy 原型链的实际行为要对齐测试。

### B6 配置组装 loader（B 阶段收官）

**交付物**：`cordis/loader.ts`、`cordis.config.ts`（第一版插件清单）、`--dump-config` 式输出。

**规格**：
```ts
type Row = { id: string; name: string; config?: unknown; disabled?: boolean }
function loadRows(ctx: Context, rows: Row[], resolve: (name: string) => Plugin): void
function dumpTree(ctx: Context): string   // id / name / state / inject 的树状输出
// 分层叠加（讲原理+简版实现）：rows = [...base, ...app, ...cliPatch]，同 id 后写胜（整行替换）
```
**步骤**：
1. 行模型 + disabled 过滤 + id 去重（后写胜）。
2. name→Plugin 解析表（静态映射，讲真框架的动态 import 与包清单校验，标注"略"）。
3. dumpTree 输出已激活树。
4. **B 阶段总验收**：玩具 harness——配置行里注释掉某插件 → 能力消失；加一行 → 能力出现；书写顺序打乱 → 依赖驱动照常激活。

**验收**：四条组合断言 + dump 输出正确。
**危险点**：id 与 name 的身份区别（id 是配置身份、name 是实现入口）；同 id 整行替换而非字段合并。

---

## 阶段 C：核心服务插件化（8 章）

> 从本章起动业务代码。每章开工先跑 `node run-mock.mjs` 记录基线，收工再跑对齐。

### C1 工具注册表

**交付物**：`services/tools.ts`（ToolsService）、`plugins/core-fs-tools.ts`、`core-exec-tools.ts`、`core-meta-tools.ts`；`tools.ts` 中 12 个工具的 execute 逻辑迁出；agent.ts 的 `executeToolCall` switch 改查注册表。

**规格**：
```ts
interface ToolDefinition {
  name: string
  description: string
  parameters: JSONSchema            // 即现在的 input_schema
  permissionHint?: 'read' | 'edit' | 'exec' | 'meta'   // C2 用，本章先挂上
  deferred?: boolean                // 沿用现状语义
  execute(input: Record<string, any>, exec: ToolExec): Promise<string>
  // output.schema/render、isConcurrencySafe、timeoutMs、presentCall/Result 本章只讲不实现（当章文档记差距）
}
class ToolsService extends Service {
  register(def: ToolDefinition): () => void      // disposer
  get(name: string): ToolDefinition | undefined  // 含 mcp__ 动态名的占位逻辑不变
  list(): ToolDefinition[]                        // 顺序 = 注册序，必须与现在 toolDefinitions 数组序一致
}
```
**步骤**：
1. 讲 ToolDefinition 全貌 vs 我们的 ToolDef（参照 `packages/core/tools/src/index.ts` 接口段 + `docs/cookbook/adding-a-tool.md`）。
2. 写 ToolsService（register/get/list，register 返回 disposer）。
3. 三个插件把 12 工具迁入：**execute 函数体从 tools.ts 的 switch 原样剪切**，不改逻辑。`activatedTools` 全局态收进 ToolsService。
4. agent.ts：`executeTool` switch 调用点改为 `ctx.tools.get(name).execute(...)`；魔法名链（agent/skill/schedule_wakeup/mcp__）**本章不动**。
5. 回归 + 新断言：临时 echo 插件注册→可调用；dispose 后模型不可见（tools 数组里消失）。

**验收**：22 场景绿 + 请求体 tools 数组逐字节一致（顺序敏感！）。
**危险点**：工具 schema 顺序变化会破坏请求体等价（注册序=数组序要严格对齐旧 toolDefinitions）；truncateResult 的归属（收进 ToolsService，行为不变）。

### C2 工具执行管线 + 权限瀑布

**交付物**：ToolsService 增加 `executeCall()` 管线；`plugins/approval.ts`（permissions.ts 的监听器化）；agent.ts 循环内权限代码删除。

**规格**：
```ts
type PreExecDecision = { type: 'allow' } | { type: 'deny'; reason: string } | { type: 'ask'; message: string }
// 管线：snapshotArgs → waterfall('tools/pre-execute', call, next: allow 默认)
//     → guard 单调校验（listener 只能收紧：allow→ask/deny 可，反向不可）
//     → ask 走 ctx.approval.request()（无 approval 服务 = fail-closed deny）
//     → execute → waterfall('tools/post-execute', result) 可 block(带反馈)/accept
type Approval = { request(call, message): Promise<'allow-once' | 'deny' | 'allow-always'> }
```
**步骤**：
1. 讲 dsh 管线四段与三层瀑布（参照 `packages/core/tools/src/index.ts` 管线段）。
2. executeCall 管线骨架（本章瀑布只有 approval 一个 listener 也没关系，先把管道立起来）。
3. **九段流水线迁移**（本章主菜，逐段对照 `permissions.ts:checkPermission`）：deny 规则→plan 只读契约→bypass→allow 规则→READ_TOOLS→plan 工具→acceptEdits→confirm/dontAsk→兜底 allow，全部变成 approval 插件里**一个 pre-execute 监听器内部的判定序列**（保序！）。READ/EDIT/FAST_PATH 集合改读 `permissionHint` 元数据。confirmFn → Approval 服务（cli.ts 实现 provider）。
4. auto mode 的 `classifyToolCall` 分支变成另一个 pre-execute 监听器（挂在 approval 监听器之后，讲 waterfall 的 veto 链如何自然表达"auto 优先"）。
5. 回归 + 新断言：deny 后另一个监听器无法翻案（guard 单调）。

**验收**：权限/plan/auto 相关场景全绿；决策行为与旧 checkPermission 逐段等价（用旧函数跑对拍可作临时验收脚本）。
**危险点**：九段顺序不能乱（先规则后模式）；waterfall 监听器注册顺序=优先级，loader 里 approval 插件必须先于 auto 插件。

### C3 会话事件日志 ★（本轮最核心）

**交付物**：`services/session-log.ts`；agent.ts 全部消息操作改走日志。

**规格**：
```ts
type SessionEvent =
  | { type: 'system/message'; content: string; cacheBreakpoint?: boolean }
  | { type: 'user/message'; content: Anthropic.ContentBlockParam[] }
  | { type: 'assistant/message'; content: Anthropic.ContentBlockParam[]; usage?: TokenUsage }
  | { type: 'tool/call'; id: string; name: string; input: Record<string, any> }
  | { type: 'tool/result'; callId: string; content: string; isError?: boolean }
  | { type: 'turn/start' } | { type: 'turn/end'; reason: string }
  | { type: 'meta/note'; key: string; value: unknown }   // mode/cost 等非模型可见状态
class SessionLog extends Service {
  append(evt: SessionEvent): void
  events: readonly SessionEvent[]
  derive(): { system: Anthropic.TextBlockParam[]; messages: Anthropic.MessageParam[] }
}
```
**步骤**：
1. 讲"model-visible ⟺ logged"与 deriveMessages（参照 `packages/core/session/src/index.ts` 的 derive 段、`surface.ts`）。**先立规矩**：压缩的投影 replace 本章不做（D5），但 derive 的实现位置要为它留缝。
2. 写 SessionLog + derive（纯函数，从事件数组投影出请求参数）。
3. agent.ts 替换（按调用点逐个来）：`this.messages.push(user)` → append user/message；流结算 → append assistant/message；工具 → append tool/call + tool/result；`buildAnthropicSystem` 的产物 → append system/message（每轮构建前先对比上一条，未变不重复 append——保持请求体等价）。
4. `history()/loadHistory()/clearHistory()` 改为 derive/load(回放)/截断的薄封装。
5. 连续 user 合并（防 400）保持在 append 入口处理（C4 迁给 inbox）。

**验收**：22 场景请求体逐字节等价；新断言：derive 是纯函数（同一事件流重放两次结果一致）。
**危险点**：system 每轮动态段（env/time）的变化会多出 system/message 事件——对比逻辑要和旧行为对齐（旧版每请求现算 system，请求体里只有一份；新版日志里可能有历史 system 事件但 derive 只取最新，验收口径=derive 结果等价）；usage 四类计数从 assistant 事件提取。

### C4 Agent handle 与 inbox

**交付物**：`services/agents.ts`（AgentRegistry + AgentHandle）；cli.ts 输入改走 handle。

**规格**：
```ts
type InboxItem = { kind: 'next-turn' | 'next-step'; content: string }
class AgentHandle {
  id: string; status: 'idle' | 'running' | 'maintenance'
  send(text: string): Promise<void>        // idle→开新 turn；running→next-step 队列
  followup(text: string): Promise<void>    // next-turn 队列
  cancel(cause?: unknown): void
}
class AgentRegistry extends Service {
  create(opts): AgentHandle; get(id); list()
}
```
**步骤**：
1. 讲 inbox 双队列与 claim（turn 边界=全部 next-step+恰一条 next-turn；step 边界=只取 next-step）与 wake/latch（参照 `agent-loop/src/inbox.ts`、`agent.ts` 的 wakeDriver）。
2. Inbox 类（内存版即可，事件持久化走 C3 的 meta 或 tool 无关事件——记当章文档）。
3. AgentHandle：把 `chat()` 拆成 send 驱动 + turn 循环 claim；runAgentLoop 内部改从 inbox 认领输入。
4. cli.ts：REPL 输入 → handle.send()；SIGINT → handle.cancel()。
5. 回归 + 新断言：**mid-turn 注入**新场景（工具执行间隙 send 的文本出现在下一 step 请求体）——需在 run-mock 新增场景。

**验收**：22 场景绿 + mid-turn 断言。
**危险点**：claim 时机（当前 step 结束后、下次请求组装前）；SIGINT 两连退出语义必须保留（真机纪律积累的行为）。

### C5 循环事件化 ★大章（预计跨 2-3 次会话）

**交付物**：循环发事件（`agent/pre-step`、`agent/request`、`agent/turn-stopping`、`turn/end reason`）；`plugins/autonomy.ts` 第一版（plan/goal/loop 监听器化）；`contextCleared` 布尔消亡。

**规格**（mini-cordis Events merging 到 agent 域）：
```ts
interface Events {
  'agent/pre-step'(input: { messages: string[] }, next: (d?: { reject?: string; messages?: string[] }) => ...): ...
  'agent/request'(req: { model: string; messages: ... }, next): ...   // 可改路由/拒绝
  'agent/turn-stopping'(state: { steer(text: string): void }): Promise<void>   // serial，无 next
}
```
**步骤**（每步一回归）：
1. 讲 turn/step 事件序列（对照 architecture.md turn flow ↔ `agent-loop/src/agent.ts` 的 turn/step/preStep 函数）。
2. 循环埋点：pre-step（组装前，可改写/拒绝输入）、turn-stopping（收敛前，可挽留）、turn/end（带 reason）。
3. **plan mode 迁移**：mode 状态机 → 插件（pre-step 注入 plan 提醒已在 system/prompt 层的保持不动；工具只读契约已在 C2；exit_plan_mode 审批通过 → 结果带 concludeTurn 语义 + 新输入注入——`contextCleared` 布尔改道循环的机制在此消亡）。
4. **goal 迁移**：`pursueGoal` 外层 while → turn-stopping 监听器（评估→不达标则 steer 回灌 reason 续命；连续不过→blocked）。
5. **loop 迁移**：runLoopInterval/runLoopDynamic → 插件（interval 用 ctx.schedule 雏形；dynamic 的 schedule_wakeup 字段协议本章先保留，D6 换服务）。
6. 失败补全：step 抛错时为每个无果 tool/call 补 isError 的 tool/result（对齐 dsh ToolCallRecovery 思想，简化版）。

**验收**：plan/goal/loop/auto 全部场景绿；新断言：goal 评估 reject → turn/end 带 blocked reason。
**危险点**：这是横切面最大的一章——四个能力共用同一个循环，迁移顺序 plan→goal→loop，每迁一个跑全量；SIGINT 与 turn-stopping 挽留的交互要测。

### C6 LLM 适配 seam

**交付物**：`services/llm.ts`、`plugins/llm-anthropic.ts`、`plugins/adapter-echo.ts`；5 处 SDK 直调收拢。

**规格**：
```ts
type StreamChunk =
  | { t: 'text-delta'; text: string } | { t: 'tool-call-delta'; partialJson: string }
  | { t: 'block-start'; kind: 'text' | 'tool' } | { t: 'block-end' }
  | { t: 'usage'; usage: TokenUsage } | { t: 'finish'; reason: string }
abstract class LlmAdapter {
  abstract stream(req: NormalizedRequest, signal: AbortSignal): AsyncIterable<StreamChunk>
}
class LlmRuntime extends Service {
  registerAdapter(route: string, adapter: LlmAdapter): () => void
  stream(req, signal): AsyncIterable<StreamChunk>       // 按路由分发；llm/stream waterfall 挂点
  sideCall(req): Promise<{ text: string; usage }>       // 收拢 T4 摘要/sideQuery/goal 评估/auto 分类器四处
}
```
**步骤**：
1. 讲中立词汇表与适配器契约（参照 `packages/llm/llm/src/types.ts`、`llm-deepseek/src/adapter.ts`）。
2. 写 llm.ts（路由 + sideCall 便利层 + retry 中间件挂点——withRetry 迁为 stream 外层包装，语义保持"重建整个流"）。
3. llm-anthropic 插件：现在 `client.messages.stream` 的消费逻辑整体翻译成 chunk 流（emit text-delta → ui 打印的地方改订 chunk）。
4. 5 处直调替换：主循环 stream、compactAnthropic、buildSideQuery、evaluateGoal、auto 分类器 → llm.stream/sideCall。
5. adapter-echo（20 行，复读最后一条 user）验证"换后端=loader 加一行"。

**验收**：22 场景绿（mock 仍锚 anthropic 请求体，adapter 产出不变）；usage 计数与旧值一致。
**危险点**：usage 的四类计数（input/output/cache read/cache write）提取点变化；retry 重试时流已打印的半截文本（沿用旧行为：重建流重新打印，不做 delta 缝合）。

### C7 system prompt 服务

**交付物**：`services/system-prompt.ts`、`plugins/prompt-sections.ts`；`prompt.ts` 的 `buildDynamicSystemContext` 消亡。

**规格**：
```ts
class SystemPrompt extends Service {
  registerSection(sec: { id: string; order: number; render(vars: Vars): string | null }): () => void
  registerVariable(key: string, get: () => string): () => void
  assemble(): { system: Anthropic.TextBlockParam[] }   // order 升序拼块 + {{var}} 严格插值（未知变量抛错）
}
// 中央 order 表照 dsh SECTION_ORDERS 思想自建；tools schema 自动汇入 = ToolsService 注册一个 order 靠后的 section
```
**步骤**：
1. 讲 section 注册表 + order + 变量 + 缓存策略上收（参照 `packages/core/system-prompt/src/index.ts`）。
2. 写服务 + assemble。
3. prompt.ts 分解：STATIC_CORE→identity section、loadClaudeMd→claude-md section（@import 防环保留）、动态块→env/memory/skills sections；工具 schema 汇入 section。
4. C3 的 system/message append 改由 assemble 驱动；cache_control 断点策略收进 assemble（末块打断点，行为不变）。

**验收**：22 场景 system 字段逐字节等价。
**危险点**：section 输出 null（空块跳过）与旧版条件拼接的等价性；顺序微调必须显式记入断言变更说明。

### C8 会话持久化 JSONL

**交付物**：`plugins/session-jsonl.ts`；session.ts（旧 JSON 快照版）删除。

**规格**：
```ts
// SessionPersistence seam（简版）：append(evt) 逐行落盘 ~/.mini-claude/sessions/<id>.jsonl
// open(id) = 读全文件 → 逐行 parse → 回放进 SessionLog → derive 恢复请求历史
// meta/note 事件顺带恢复：mode、cost、activatedTools、goal 状态（超越旧版 resume 能力）
// 崩溃修复（简版）：读到半行丢弃；发现 turn/start 无配对 turn/end 时补合成 turn/end
```
**步骤**：
1. 讲 dsh 的 generation/独占写/migration 概念（不实现，当章文档记差距）。
2. append 钩子：SessionLog 加 onAppend 订阅，session-jsonl 插件订阅落盘。
3. loadSession→重放；restoreSession 消亡（重放即恢复）。
4. autoSave 时机改为"每事件即落盘"（turn 收敛 autoSave 消亡）。
5. 回归 + 新场景：save→load→continue 请求体一致 + 崩溃 tail 修复断言。

**验收**：22 场景 + 2 新场景绿。
**危险点**：Windows 追加写的 flush 时机；大 tool result（30KB 落盘机制）在重放时的路径还原。

---

## 阶段 D：能力插件化（6 章）

### D1 skills 插件化
**做什么**：`plugins/skills-registry.ts` 三层化——provider registry（同名按 rank 竞争，project 覆盖 user 的现状=rank 实现）/ 目录发现（skills.ts 的扫描逻辑迁入）/ skill 工具 + **目录注入改为 user message**（现状拼在 system → 改为 turn 开始注入一条带 catalog 的 user 消息，对齐 dsh "描述进目录、正文按需加载"）。
**验收**：inline/fork 场景绿 + rank 覆盖断言。**断言变更说明**必写（catalog 从 system 挪到 user message，请求体结构变化）。
**危险点**：slash 直调（CLI 侧）与工具调用两条路径都要走 registry；$ARGUMENTS 展开位置。

### D2 MCP 插件化
**做什么**：`plugins/mcp-bridge.ts`——McpManager 迁入插件；`publicToolName` 抽成纯函数（64 字符规范化 + 碰撞加 SHA 后缀，照 `mcp-client/src/tools.ts`）；syncTools 两代切换（先注册新代再 dispose 旧代，失败不动 registry）；execute 走 callTool、isError→isError 结果。
**验收**：mcp 场景绿 + 名字规范化单测（超长/非法字符/碰撞）。
**危险点**：ensureMcp 的惰性时机（首次 chat 前）变成插件激活时机的语义差异。

### D3 subagent 插件化
**做什么**：`ctx.agents` registry 接管——`agent` 工具的 execute 里 `new Agent()` 改为 `ctx.agents.create({ preset })`；per-agent scope（B5）：子 agent 的工具注册在子 scope，"剥 agent 工具防递归"变成 preset 的 exclude 列表；initiator 用显式参数传递（讲 AsyncLocalStorage 原理，标注"略"）；token 回滚语义保留。
**验收**：subagent 场景绿 + 子 scope 工具隔离断言。
**危险点**：childPermissionMode 防 plan/auto 洗白的检查要跟着迁到 preset 校验。

### D4 memory 与上下文注入
**做什么**：AgentHandle 加 `inject(text)`（下一请求注入，走 C4 inbox 的 next-step 特殊项或独立队列——对齐 dsh agent.inject()）；memory prefetch 的循环内轮询改为 turn 边界监听器注入；CLAUDE.md 专槽保持。
**验收**：memory 场景绿 + inject 不污染日志持久语义的断言（注入是瞬时的还是入日志——**设计决策**：对齐 dsh 走 user/message 或专用事件，当章讨论定夺并记录）。
**危险点**：注入时机与 pre-step 改写的先后。

### D5 compaction 插件化
**做什么**：`plugins/compaction.ts`——C3 立的规矩兑现：SessionLog.derive 支持 replace 投影（事件带 `generation`，derive 只取每节点最新代）；四层压缩（T1/T2/T3/T4）全部改为"追加 replace 事件"而非原地改 messages；SNIPPABLE_TOOLS 变工具元数据；/compact 命令直调压缩插件。
**验收**：压缩场景请求体等价 + **原始事件未被修改**断言（压缩前后 events 数组只增不改——这是"日志即真相"的终极验收）。
**危险点**：四层压缩交互复杂（budget→snip→microcompact→summary 的顺序），投影化后每层单独验收；旧断言锚的是压缩后的请求体，投影要产出与旧算法一致的结果。

### D6 goal/loop 收尾
**做什么**：`services/schedule.ts`——schedule_wakeup 的字段回传协议（pendingWakeup 字段）换成 ctx.schedule 服务（工具 execute 里 ctx.schedule.at(time, payload)，循环订阅 schedule/due 事件唤醒）；interval loop 用同一服务；DENIAL_LIMITS 熔断收口进 autonomy 插件；auto 两段分类器审计点补齐。
**验收**：loop dynamic/interval、goal 全绿。
**危险点**：interruptibleSleep 与 cancel 的竞态（SIGINT 期间排程到期）。

---

## 阶段 E：收尾（3 章）

### E1 UI/CLI 纯消费者化
**做什么**：`services/commands.ts` + `plugins/commands.ts`（slash 命令注册表：/cost /compact /memory /goal /loop /skills… 从 cli.ts 的 if 链迁为 `ctx.commands.register({name, description, run})`）；ui.ts 改为订阅 `session/*` 事件渲染（spinner/打印/审批卡片全部事件驱动）；SIGINT→cancel(cause) 收口。
**验收**：REPL 手测清单（沿用 ch14 交互 6 项清单顺手做真机复验）+ mock 冒烟。
**危险点**：渲染顺序（事件到达序 vs 完成序）；plan 审批的同步阻塞点改事件化后的交互等价。

### E2 bundle/profile 简版
**做什么**：cordis.config.ts 分层化——`baseRows`（全能力）+ `appPatch`（CLI 装配）分层叠加 + `--patch file` 覆盖 + `--dump-config` 打印最终树；交付两条配置：全功能版 / 无 auto-mode 版，同一份代码组装出两个 agent。
**验收**：双 profile 组装断言 + dump 输出正确。
**危险点**：patch 覆盖粒度（整行替换 vs 字段合并——对齐 dsh：整行）。

### E3 snapshot 回归 + 收官
**做什么**：给自己的录制回放——新增 `record-snapshot.mjs`（跑 mock 时录请求/事件序列存 `snapshots/`）+ `replay-snapshot.mjs`（无 SDK 重放断言，对齐 dsh `test:snapshot` 思想）；全量场景迁移总验收；收官文档 `my_docs/dsh-final.md`：mini-cordis vs 真 Cordis 差异清单、22+新场景终态、dsh 源码导读地图（哪些包我们读过了、哪些值得下一轮）。
**验收**：快照回放全绿；收官文档完成。
**危险点**：录制内容含时间戳/随机 id 的规范化。

---

## 附：章节依赖图（简）

```
A0 ─→ B1 ─→ B2 ─→ B3 ─→ B4 ─→ B5 ─→ B6
                                   │
     ┌─────────────────────────────┘
     └─→ C1 ─→ C2 ─→ C3 ─→ C4 ─→ C5 ─→ C6 ─→ C7 ─→ C8
                       │      │     │              │
                       │      │     │   D1 D2 D3 D4│
                       └──────┴─────┴──→ D5 ←───────┘
                                          └─→ D6 ─→ E1 ─→ E2 ─→ E3
```
C6 可与 D1/D2 并行（互不依赖）；D5 依赖 C3+C8；其余线性。
