# dsh-D2 MCP 插件化

> 本章产物：`plugins/mcp-bridge.ts`（publicToolName 纯函数 + McpBridge 服务 + McpConnection/配置加载自 mcp.ts 迁入）；`mcp.ts` 删除；agent 走 `ctx.mcp`；executeToolCall 的 `mcp__` 魔法名分支消亡（MCP 工具成为注册表公民）。
> 一句话：**公共名是有损变换时要保唯一的契约，换代是失败也不能留下半代的原子动作**。
> 参照物：`packages/mcp/mcp-client/src/tools.ts`（publicToolName 与 syncTools 两阶段语义照抄）。

---

## 1. publicToolName：64 字符契约

```
joined     = mcp__<server>__<raw>
normalized = joined 的非法字符（[^A-Za-z0-9_-]）→ "_"
无损且 ≤64 → 原样返回（mcp__demo__add 零变化——广告字节等价的锚）
有损       → 截到 64-12-1 位 + "_" + sha256("<server>\0<raw>") 前 12 位
```

设计精髓在"**无损判据**"：哈希只在变换有损（非法字符替换、超长截断）时缀上——干净短名不加戏（字节等价），脏名/长名靠哈希保唯一（两个都截到同前缀的长名仍可区分）。哈希输入是 `server\0raw` 原名而非 joined——公共名不可逆也无所谓：**dispatch 用闭包捕获的 server/raw 名路由，公共名只是广告层**（旧代码要从公共名反解析，截断即断路）。

## 2. syncTools 两代切换

照 dsh 的两阶段语义（roadmap 的"先建新再撤旧"是它的简化说法）：

```
① 构建期：整代 ToolDefinition 就绪（纯数据，未注册）——重复公共名在此抛错，
   失败时注册表分毫未动
② 换代期：撤旧代 disposer → 注册新代；冲突（只能是外部 squat 本命名空间）
   → 回滚：新代已注册的逐个撤销 + 旧代定义重新注册恢复
```

mini 的 ToolsService.register 同名 fail-loud（B2 服务表语义的注册表同款），所以"新代注册中途撞名"必须走恢复路径——cordis 测试钉了最难的一条：squatter 占名 → 新代回滚 → 旧代恢复**恰一个不重复**。当前 ensure 幂等意味着 syncTools 一生只跑一次；两代机制是为重连/热更新预付的（dsh 里 server 断线重连就走这条）。

## 3. 危险点兑现：惰性时机

roadmap 预警"ensureMcp 的惰性时机变成插件激活时机的语义差异"——没有发生：McpBridge.ensure() 仍由 turn 开场 maintenance 段调用（`if (!this.isSubAgent) await mcp.ensure()`），插件激活只创建服务。子 agent 走 `disable()`（服务在、连接永不发起）——close() 不炸、广告为空，与旧 `isSubAgent ? [] : ...` 同语义。

## 4. 与真框架的差距清单（D2 后）

| 能力 | 真 dsh | mini | 备注 |
|---|---|---|---|
| 公共名规范化 + 哈希 | ✅ | ✅ | 语义照抄（含 \0 分隔的哈希输入） |
| 两代切换/冲突回滚 | ✅ | ✅ | restore 路径同构 |
| 重连/断线重同步 | ✅ 生命周期驱动 | ❌ ensure 幂等一生一次 | syncTools 可注入 raw，机制就绪 |
| projectContent 图片 | ✅ base64 基建 | ❌ 文本 only | roadmap 明示简化 |
| isError → 结果标记 | ✅ | ❌ 文本原样返回 | ExecOutcome 无 isError 通道（记 C 阶段缝） |
| MCP 配置热更 | ✅ | ❌ 三处合并一次读 | |

## 5. 实现与验证记录

**文件**：`plugins/mcp-bridge.ts`（新增，连接层原样迁入）；`mcp.ts` **删除**；`agent.ts`（mcpManager/ensureMcp 字段消亡、runOneTurn 走 ctx.mcp、close 委托、mcp__ 分支删除）；`cordis-tests/d2-mcp.test.ts`（新增 6 条）。

**验证**：cordis **123/123**（D2 新增 6 条：净名零变化、规范化/截断/哈希确定性与区分度、换代替换、构建期重复名不动表、squat 冲突回滚恢复、disabled no-op）；mock **28 场景全绿**——18/19（双 demo server：广告含 `mcp__demo__add`、调用路由、结果回灌）走新桥接零断言变更 = 广告字节等价坐实。

**翻车记档**：
1. **断言又锚错层**：首测断言"脏名长度 === 64"——实现对、锚错。短而脏的名字是"全前缀 + _ + 12 哈希"（28 字符），只有**截断**才顶满 64。dsh 的 `slice(0, 64-13)` 对短串是 no-op，不是 pad。连续两章（C4 firstUserText、D2 长度）都在"想当然的规格"上翻车——**抄语义要抄到分支条件，不是抄结论**。
2. **（无翻车，记一个取舍）**：dispatch 闭包捕获 raw 名后，旧 callTool 的"公共名反解析"（`slice(2).join("__")`）整段删除——它本来就是截断名的定时炸弹。删代码比搬代码更能说明 seam 的价值。

## 6. 自测三题（答案在文末）

1. 哈希为什么只在"有损"时缀？缀在所有名字上会怎样？
2. 换代冲突的恢复路径里，旧代是"定义数组重注册"而不是"disposer 复原"——为什么 disposer 不能复原？
3. dispatch 闭包捕获 server/raw 名后，注册表里的 def 与广告清单里的条目是什么关系？两者会发散吗？

> **答案**：
> 1. 干净短名零变化是广告字节等价的锚（场景 18/19 不断言变更的根基）；全都缀哈希则每个 MCP 工具名都变，且模型侧可读性下降。哈希是**冲突保险**，不是身份装饰——有损才有冲突风险，无损就零风险。
> 2. disposer 是"从注册表摘除"的单向操作——注册表没有"重新挂回"的 API，能挂回的只有定义本身。所以换代要同时持有 `generation`（disposer，用于撤）与 `generationDefs`（定义，用于恢复）两份账。
> 3. 同一事实的两个投影：广告清单（Anthropic.Tool 形状，字节对齐旧 getToolDefinitions）与注册表 def（含 execute 闭包）。两者都从 rawTools + publicToolName 现算/注册，一次 syncTools 原子更新——发散只会出现在"直接动注册表绕过 syncTools"，而那是本章之后就不再存在的合法操作。

## 7. 下章预告（D3 subagent 插件化）

`ctx.agents` registry 接管 `agent` 工具的 `new Agent()`（`ctx.agents.create({ preset })`）；B5 红利兑现：per-agent scope 让"剥 agent 工具防递归"变成 preset 的 exclude 列表；initiator 显式传参（讲 AsyncLocalStorage 原理，标注"略"）；token 回滚语义保留。验收：subagent 场景绿 + 子 scope 工具隔离断言。
