# dsh-C1 工具注册表（阶段 C 第一章）

> 本章产物：`services/tools.ts`（ToolDefinition/ToolExec/ToolsService + 激活态与 truncate 收编）、`plugins/core-fs-tools.ts`（5 个文件工具）、`core-exec-tools.ts`（run_shell/web_fetch）、`core-meta-tools.ts`（tool_search + 魔法名 schema 占位）；`tools.ts` 瘦身为纯 schema 数据；agent.ts 起容器树、`executeToolCall` 的 switch 兜底改查注册表。
> 一句话：**12 个工具的 execute 逻辑从 import 耦合的 switch 迁进注册表，schema 单一来源不动，请求体 tools 数组逐字节不变。**
> 按 C 阶段纪律：开工基线 = 上章收工的 mock 22/22，收工再跑对齐。
> 参照物：`packages/core/tools/src/index.ts` 的 ToolDefinition 接口段、`docs/cookbook/adding-a-tool.md`。

---

## 1. 迁移切面：什么迁、什么留、为什么

这章的难度不在写新代码，在**决定每样东西的去留**。逐项裁决：

| 东西 | 去向 | 理由 |
|---|---|---|
| 12 个工具的 execute 函数体 | plugins/core-*（原样剪切） | 本章的正主——"注册即可调用"的主体 |
| 工具的全部辅助函数（diff/引号容错/grep 降级…） | 跟着各自工具走 | 剪切语义要求连根迁，不留共享残端 |
| 12 个 schema（toolDefinitions） | **留在 tools.ts** | 单一数据来源：subagent 筛选、customTools 缺省、插件 schemaOf 都读它；动它 = 三处消费方全要对齐，迁移面暴涨 |
| 激活态（activatedTools） | services/tools.ts 模块级 | "一次搜索，终身有效"是**跨 Agent 实例**的语义（主对话激活对子 agent 生效）——收进实例级 ToolsService 会静默破坏它 |
| truncateResult | services/tools.ts | roadmap 指定归属；行为零变化 |
| 魔法名链（plan/agent/skill/schedule_wakeup/mcp__） | agent.ts 原地不动 | 它们的执行体是 Agent 实例状态（mode/planFilePath/mcpManager），没有 ToolExec 足够的上下文前不迁 |

**Agent 侧的接线**：构造函数起一棵 mini-cordis 树——`new Context()` → `new ToolsService(ctx, 'tools')`（先行，插件要注入它）→ 按序 `ctx.plugin()` 三个工具插件。`executeToolCall` 的 switch 兜底换成：

```ts
const def = this.cordis.require<ToolsService>("tools").get(name);
if (!def) return `Unknown tool: ${name}`;        // 与旧 switch default 同话术
return await def.execute(input, { readFileState: this.readFileState });
```

`ToolExec` 是执行上下文的第一块砖（本章只有 readFileState），C2 的审批管线、后续章节的会话服务都会往里长。

## 2. 注册序 = 请求体数组序：一条隐形生命线

验收要求"请求体 tools 数组逐字节一致（顺序敏感）"。API 请求里的 tools 顺序影响 prompt 前缀缓存的命中——**顺序就是钱**。旧数组序是：

```
read_file → write_file → edit_file → list_files → grep_search
→ run_shell → web_fetch → enter_plan_mode → exit_plan_mode → skill → agent → tool_search
```

三个插件必须按这个序接力注册：fs 五件套（1-5）→ exec 两件套（6-7）→ meta 五件套（8-12）。**meta 插件里 tool_search 必须最后注册**——它在新代码里最"显眼"（唯一的真 execute），写的时候顺手放在了最前面，恰恰错位。这个错误 tsc 抓不到、mock 也抓不到（本章请求路径没切到注册表，走的还是旧 module 函数）——能抓住它的只有"注册序 = 旧数组序"这条结构契约本身，最后靠一条专门的测试钉死（`list()` 的名字序 deepEqual 旧数组名序）。

**魔法名工具为什么要注册**（schema 占位、execute 是路由异常自报）：不注册的话 `list()` 就缺 4 个，注册表不再是"模型能看到的一切"的完整镜像——tool_search 的 deferred 筛选、未来的 dump/诊断都会瞎。占位 execute 永远不该被走到（魔法链在更早处拦截），真走到说明路由出了洞，自报家门比静默返回强。

## 3. 与真框架的差距清单（C1 后）

| 能力 | 真 cordis/dsh | mini | 备注 |
|---|---|---|---|
| ToolDefinition 基本面（name/description/parameters/execute） | ✅ | ✅ | — |
| register 返回 disposer（插件卸载摘工具） | ✅ | ✅ 走 B3 effect | — |
| permissionHint | ✅ | ✅ 挂上未消费 | C2 用 |
| deferred + 激活态 | ✅ | ✅ 语义原样 | — |
| output.schema/render（结构化输出） | ✅ | ❌ | 记档，视需要 |
| isConcurrencySafe / timeoutMs | ✅ | ❌ | C 阶段暂无并发工具 |
| presentCall/presentResult（UI 渲染钩子） | ✅ | ❌ | UI 仍硬编码在 ui.ts |
| mcp__ 动态工具的类型面 | ✅ | ❌ 占位逻辑在 agent 侧不变 | — |

## 4. 实现与验证记录

**文件**：
- `services/tools.ts`（新增：JSONSchema/PermissionHint/ToolExec/ToolDefinition、ToolsService、激活态模块级函数、truncateResult）
- `plugins/core-fs-tools.ts`、`core-exec-tools.ts`、`core-meta-tools.ts`（新增：execute 原样迁入）
- `tools.ts`（重写：只剩 ToolDef 类型 + 12 个 schema，逐字节未动）
- `agent.ts`（修改：cordis 字段 + 构造树、executeToolCall 兜底改查注册表、truncateResult 导入路径）
- `prompt.ts`（修改：getDeferredToolNames 导入路径）
- `tsconfig.json`（include 扩容 services/ plugins/）
- `cordis-tests/c1-tools.test.ts`（新增 7 条）

**验证**：
- `npm run cordis`：**66/66 绿**（C1 新增 7 条：注册序对齐、字节等价×两激活态、echo 注册/摘除、同名冲突、tool_search 激活语义、ToolExec 线程、魔法名兜底）
- 全量 mock 回归：**22/22 绿**——验收主门。请求体等价由断言请求内容的场景背书（如场景 3 的请求体断言、ch25 的 tool_search 全链路）。

**翻车记档**（实现过程中真实发生）：
1. **meta 插件注册序排错**（第 2 节）：tool_search 抢跑了位置 8。tsc 不报、mock 不炸（请求路径本章未切），靠结构契约自查抓住。教训：**迁移章最大的风险不是写错，是"迁得不像"而所有测试都在旧路径上**——顺序这类结构契约要显式写成测试，不能依赖回归网兜底。
2. **字节等价测试自身写错**：第一版拿注册表全量 12 个对比旧路径激活过滤后的 10 个，断言必挂。失败输出里两串 JSON 并排——差的就是两个 deferred 工具，一眼定位。修正为"激活视图 vs 旧路径"在激活前后两种状态下都比对。教训：写等价断言先想清楚**两边各是什么视图**，别让测试本身成为第三个实现。
3. **可选性摩擦两处**：`Anthropic.Tool.description` 可选而 ToolDefinition 必填（`?? ""` 补齐）；`execute` 返回 `string | Promise<string>` 联合，测试里对联合直接 `.then` 报错（`await` 化）。前者是 SDK 类型面与领域类型面的接缝成本，后者是"多数同步、少数异步"的老问题——B4 的 isBailed 早已示范：类型上诚实标注联合，调用侧统一 await。

## 5. 自测四题（答案在文末）

1. schema 为什么留在 tools.ts 而 execute 迁走？如果 schema 也搬进插件，哪三个消费方要跟着改？
2. 注册序错位为什么本章的 mock 抓不到？什么机制能抓住它？
3. 激活态收进模块级而不是 ToolsService 实例，保住了哪条行为语义？如果收进实例，什么场景会坏？
4. 魔法名工具注册进注册表的意义是什么？它们的 execute 被设计成自报路由异常而不是静默返回，理由何在？

> **答案**：
> 1. schema 是**数据**（三个消费方共读），execute 是**行为**（只有注册表消费）。schema 若搬进插件：subagent.ts 的筛选、agent.ts 的 customTools 缺省、prompt.ts 的 deferred 名单全要从"读静态数组"改成"拿到某棵树的注册表"——它们都还没有 ctx，改动态来源等于把这三个模块提前插件化，迁移面暴涨且验收风险不可控。
> 2. mock 的请求体走的是旧 module 函数（getActiveToolDefinitions(toolDefinitions)），本章没切到注册表——回归网罩着的是旧路径，新路径排错它看不见。抓住它的是把契约写成测试：`list()` 名字序 deepEqual 旧数组名序。未来请求数组切到 list() 后，mock 会开始罩新路径，但契约测试仍然值得留（防再排错时先炸测试再炸请求）。
> 3. "一次搜索，终身有效"：主对话 tool_search 激活的 deferred 工具，对后续**所有**请求（含子 agent 实例）可见。收进实例后每个 Agent 各自一套激活集，子 agent 看不到主对话激活的工具——请求数组在子 agent 场景直接变样，ch25 类场景会炸。
> 4. 注册表要成为"模型能看到的一切"的完整镜像：tool_search 的 deferred 筛选、未来的诊断输出都以 list() 为全集，缺 4 个就瞎。自报异常的理由：正常路由永远到不了这里，到了 = 路由链出了洞——fail-loud 把洞暴露成显式错误，静默返回（如空串）会把路由 bug 伪装成"工具执行了但没结果"。

## 6. 下章预告（C2 工具执行管线 + 权限瀑布）

ToolsService 增加 `executeCall()` 管线：snapshotArgs → `waterfall('tools/pre-execute', call, next)`（B4 的 waterfall 第一次派上真用场）→ guard 单调校验（listener 只能收紧 allow→ask/deny，不可反向）；`plugins/approval.ts` 把 permissions.ts 的检查监听器化，agent 循环内的权限代码删除——权限从"循环里的一段逻辑"变成"事件域里的一组监听器"。
