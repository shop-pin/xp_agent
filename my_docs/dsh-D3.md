# dsh-D3 subagent 插件化

> 本章产物：`plugins/subagent.ts`（AgentPreset + DEFAULT_EXCLUDES 排除表 + childModeOf 防洗白 + subagentPlugin 注册 agent 工具真身）；`AgentRegistry` 进 agent 树（create/get/list/disposeAll）；`executeAgentTool` 与 executeToolCall 的 agent 魔法拦截消亡；skill fork 走 `ctx.agents.create`。
> 一句话：**剥工具从散落的过滤条件变成一张排除表，创建从裸 `new Agent()` 变成 registry 登记的生命周期**。
> 参照物：dsh 的 agent 工具与 registry 分工（`packages/core/agent` + tool 层）。

---

## 1. 迁移前后

| 关注点 | 旧 | 新 |
|---|---|---|
| agent 工具执行 | executeToolCall 魔法拦截 → executeAgentTool（agent.ts 私有） | 注册表 def（subagent 插件）：查 preset → `ctx.agents.create` → runOnce → token 回滚 |
| 防递归 | `getSubAgentConfig` 里 `&& t.name !== "agent"`（三处散落） | `DEFAULT_EXCLUDES = {agent, schedule_wakeup}` 一张表，preset 构造统一应用 |
| 防洗白 | agent.ts 的 childPermissionMode | `childModeOf(parentMode)` 纯函数（preset 构造与 skill fork 共用） |
| 子 agent 创建 | 裸 `new Agent(...)`（无登记） | `ctx.agents.create(opts)`（登记 + disposeAll 收口） |
| skill fork | 自带一套过滤 + new Agent | `buildPresetFromSkill`（白名单在**父工具集**上解析 + 排除表） |

## 2. per-agent scope：mini 兑现到哪一层

roadmap 的理想形态（B5 红利）：子 agent 的工具注册在父树的子 scope，"剥工具"变成 scope 的 exclude 投影。**mini 的 B2 语义修正（全树共享服务表、同名 provide 冲突抛错）挡住了它**——子树共享父服务意味着子 agent 无法提供自己的 session-log/system-prompt（会撞名），而 dsh 的解法（isolate realm：服务行多实例）恰是 B2/B5 明确标注"真框架有、我们略"的部分。

D3 落地的是**双层隔离**（诚实的等价物）：

1. **插件层**：子 agent 不加载 subagentPlugin（`enabled: false`）——子树注册表里根本没有 agent 工具；
2. **数据层**：preset 排除表剥掉广告集与 fork 继承集里的 agent/schedule_wakeup。

隔离断言两层都钉（cordis：子树 `ctx.tools.get('agent') === undefined` + 广告集无 agent）。差距记档：真 isolate/iscope 过滤派发（含 Scoped\<Agent\> 的事件按 agent 过滤——goal 监听器只收本 agent 的 turn-stopping）在 mini 不可用，事件隔离目前靠"子树是独立 Context"这个更粗但有效的边界。

## 3. 顺手的偿还：注册表序的神话破产

C1 立过一条规矩："注册序必须与旧 toolDefinitions 数组序一致——请求体 tools 数组顺序的生命线"。D3 把 agent 工具挪进独立插件后这条规矩立刻不可满足（插件粒度插不进 core-meta 的中间）——才发现它**从来不是事实**：请求的 tools 数组一直来自 `this.tools` 静态数组（`getActiveToolDefinitions(this.tools)`），注册表只管 dispatch。C1 的断言锚了一个不存在的前提，D3 的断言变更（比集合不比序、按名映射比条目）把测试拉回真实不变式；广告字节等价由 mock 场景锚定（12/23/23b 零断言变更通过）。**教训：为"生命线"立规矩之前，先确认那条线真的承受载荷。**

## 4. 实现与验证记录

**文件**：`plugins/subagent.ts`（新增）；`services/agents.ts`（AgentHandle 增 runOnce/close；AgentRegistry 增 disposeAll）；`agent.ts`（registry+插件挂载、executeAgentTool/拦截删除、skill fork 走 registry、close 先收子）；`subagent.ts`（getSubAgentConfig 只解析白名单，agent 剥除迁 preset）；`plugins/core-meta-tools.ts`（agent 占位删除）；`cordis-tests/d3-subagent.test.ts`（新增 5 条）；`cordis-tests/c1-tools.test.ts`（断言变更，见 §3）。

**验证**：cordis **128/128**（D3 新增 5 条：childModeOf 映射、preset 排除（与旧硬过滤逐项一致 = 广告字节等价的锚）、skill preset 白名单、插件注册/enabled=false、registry 生命周期 + 双层隔离）；mock **28 场景全绿**——12（子 agent 全链路）、23（自定义 agent）、23b（skill fork）零断言变更。

**翻车记档**：
1. **C1 断言的连锁破产**（§3 正文）——改 agent 工具位置炸出三条 C1 断言，其中"注册序镜像广告序"是锚在错误前提上的测试。修法不是把新代码塞回旧形状（在 rig 里精心排序插件加载假装序还在），而是承认前提死亡、改比真实不变式。**给旧测试改断言时的第一问：它当年锚的前提今天还成立吗？**
2. **桥回调的 implicit any 三连**（C5、C6 之后第三次）：`addTokens: (input, output) =>` 又没标类型——ctx.plugin 的 config 是 unknown，结构化推导进不去。这条已经从"教训"降级成"肌肉记忆检查项"。

## 5. 自测三题（答案在文末）

1. 防洗白检查为什么放在 preset **构造期**而不是子 agent 运行期？
2. 双层隔离（插件不加载 + 排除表）各自防什么？只留一层会怎样？
3. registry 的 disposeAll 为什么挂在父的 close() 里？不给会怎样（提示：C8 之后 close 的调用时机）？

> **答案**：
> 1. 构造期是 preset 变成子 agent 身份的唯一入口——检查与身份绑定，绕不过；运行期检查则每个派生路径都要记得自查（skill fork、未来的 D6 wakeup 派生……漏一处就是洗白洞。集中在入口 = 单点防御。
> 2. 插件层防"子树注册表里有 agent 工具"（dispatch 层防递归——哪怕有人手工调 registry）；排除表防"广告集与继承集里有"（模型可见性与 fork 白名单）。只留插件层：广告集仍含 agent（模型会试着调它然后吃 Unknown tool）；只留排除表：dispatch 可达（构造期缺陷就是逃逸面）。
> 3. C8 之后 close 的调用时机散在 mock runner / one-shot / REPL 退出——子 agent 是 subagent（无 MCP），但 registry 登记着它的存在；不收口，子 agent 的 pending 定时器（loop 的 setTimeout）或未决 promise 会吊住事件循环。disposeAll 把"孩子谁带"从每个调用方收进 registry 一个所有者。

## 6. 下章预告（D4 memory 与上下文注入）

`AgentHandle.inject()`（下一请求注入，走 inbox 的 next-step 特殊项或专用队列——对齐 dsh agent.inject()）；memory prefetch 的循环内轮询改 turn 边界监听器注入；CLAUDE.md 专槽保持。验收：memory 场景绿 + "注入是否入日志"的设计决策讨论定夺（对齐 dsh 走 user/message 或专用事件）。
