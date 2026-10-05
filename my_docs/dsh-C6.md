# dsh-C6 LLM 适配 seam

> 本章产物：`services/llm.ts`（StreamChunk 词汇表 / NormalizedRequest / Settlement / LlmAdapter / LlmRuntime / assembleStream 聚合器 + `llm/stream` 瀑布）；`plugins/llm-anthropic.ts`（SSE 事件→chunk + 非流式 sideCall）；`plugins/adapter-echo.ts`（二十行假后端）；agent.ts 五处 SDK 直调收拢；场景 31（echo 后端整循环）。
> 一句话：**agent 不认识任何 SDK**——它说 StreamChunk 方言，请求交给 `ctx.llm` 按路由分发，换后端 = 换一行路由配置。
> 参照物：`packages/llm/llm/src/{types,index,assembler}.ts`、`llm-deepseek/src/{adapter,serialize,translate}.ts`。

---

## 1. 为什么要 seam：五处直调的形状

迁移前 `new Anthropic(...)` 的调用散布五处：主循环 stream、T4 摘要、memory selector 的 sideQuery、goal 评估器、auto 分类器。它们共享同一个 client 字段，但**没有任何一处能回答**"换一家后端要动几个文件"——答案是五个。更深的问题：每处调用都自己知道 max_tokens 该给多少、temperature 该不该带、流式还是阻塞——**调用策略与线格式翻译搅在一起**。

seam 之后：调用方只填 `NormalizedRequest`（模型、预算、消息——它们关心的部分），线格式翻译归适配器，路由归 runtime。

## 2. mini 的中立面：只在响应侧

**这是本章最重要的裁剪决策**。真 dsh 连请求词汇表都中立（`ContentBlockMap`/`FinishReasonMap`/`ToolSchema`/`RequestMessage`，translate/serialize 双向翻译——llm-deepseek 里两个方向各一个文件）；mini 的请求侧保持 **Anthropic 线格式直通**：

- mock 的 22+ 个既有断言锚的全是 Anthropic 请求体（system 块形状、tools 数组、messageCount、`stream:false`）；
- C3 的会话日志、D5 的投影、C8 的持久化，事件类型里内嵌的都是 Anthropic 线格式；
- 在这两座地基上再立一层请求翻译，等于给"请求体逐字节等价"验收自造常量风险。

于是 mini 的中立词汇表只有**一张**：`StreamChunk`（六形：text-delta / tool-call-delta / block-start / block-end / usage / finish）。差距诚实记档：**接第二家线格式不同的 provider 时，请求侧翻译层必须补**（届时 NormalizedRequest 的字段一个个换成中立形，适配器加 serialize 方向——工作量和风险都收敛在适配器文件内）。

两处词汇表为必要信息让路（C3"验收 > 规格字面"同款裁决）：block-start 携带 tool_use 的 `id/name`（聚合器建块必需，dsh 的 chunk 更富）；NormalizedRequest.system 收 `string | TextBlockParam[]`（五处旧调用的线形状两种都有，直通才能字节等价）。

## 3. 组件图与数据流

```
调用方（agent.ts ×5 处）
   │ NormalizedRequest { route, model, maxTokens, system, tools?, messages, temperature? }
   ▼
LlmRuntime（ctx.llm）── route 查表 ──► LlmAdapter
   │ ctx.waterfall("llm/stream")          │  anthropic: SSE 事件 → chunk（for-await MessageStream）
   ▼                                      │            sideCall 覆写：messages.create（非流式线格式）
assembleStream（聚合器）◄── AsyncIterable<StreamChunk>
   │ onText 挂流式打印；tool 入参 block-end 时 JSON.parse（空串 → {}）
   ▼
Settlement { content, usage, finishReason }        SideResult { text, usage }
```

三个设计点：

1. **聚合器 = dsh assembler.ts 的 mini 版**。主循环不再拿 SDK 的 `finalMessage()`（聚合是 SDK 替我们做的），改从 chunk 自建结算——这是付给中立面的代价，换回的是：任何适配器（含 echo）都免费获得与主循环同构的结算路径。空 JSON 串视作 `{}`（无参工具的合法形态，finalMessage 同义）。
2. **sideCall 是接缝可推导性的活证据**。`LlmAdapter.sideCall?` 可选：anthropic 覆写它保住 side call 的非流式线格式（mock 断言锚 `stream:false`）；echo 不覆写，runtime 用流聚合兜底——**旁路语义完全可以从 stream 推导出来**，覆写只是线格式优化。dsh 的 prepareCall/模型代绑定/重试策略注册是同一个方向上的完整版。
3. **retry 留在消费侧**。withRetry 继续包住"建流 + 聚合"整个闭包——重试时 async generator 重新进入，适配器重新 `messages.stream`，即"重建整个流"的旧语义（已打印的半截文本不缝合、重打）。`llm/stream` 瀑布是未来把 retry 迁成中间件的挂点，本章只立管道。

## 4. usage 四计数的线位置

input 与 cache_read/cache_creation 在 `message_start` 事件里，output 在 `message_delta`——适配器在 `message_stop` 时合成一个 usage chunk。这与 SDK finalMessage 的合并口径一致，所以 C3 起挂在 assistant 事件上的四计数、压缩仪表的 `lastInputTokenCount`、场景 21 的 T4 触发全部原样通过（数字不动 = 行为等价的实证）。sideCall 的 usage 同口径返回（旧代码本就丢弃旁路 usage，维持）。

## 5. 换后端 = 换一行路由（场景 31）

`MINI_CLAUDE_LLM_ROUTE=echo` → Agent 构造时把路由字段指向 echo → 整个循环（流打印、结算、注记、cost、autoSave）零改动跑在二十行假后端上，anthropic mock 收不到任何请求。E2 的 loader 配置行会把"环境变量"升级成"插件清单行"——本章先用环境变量把**语义**立住。echo 不带 sideCall 覆写，goal/compact 若在 echo 路由下触发会走流聚合兜底——正确但空转（复读 user 消息），教学适配器不需要更好。

## 6. 实现与验证记录

**文件**：
- `services/llm.ts`（新增：词汇表 + Settlement + LlmAdapter + LlmRuntime + assembleStream + `llm/stream` 瀑布 + Context/Events merging）
- `plugins/llm-anthropic.ts`（新增：AnthropicAdapter——SDK client 与 MINI_CLAUDE_SDK_MAX_RETRIES 逻辑整体迁入；插件 inject ["llm"]，业务代码首个 inject 依赖）
- `plugins/adapter-echo.ts`（新增）
- `agent.ts`（修改：`this.client` 字段消亡；llmRoute 字段；主循环改 chunk 消费 + 聚合；compact/sideQuery/评估器/分类器四路旁调 → `llm.sideCall`；auto 分类器的"无评估器"守卫改查 `hasRoute`）
- `cordis-tests/c6-llm.test.ts`（新增 5 条）
- `run-mock.mjs`（场景级 env 透传 + 场景 31 + echoBackend runner）

**验证**：
- `npm run cordis`：**102/102 绿**（C6 新增 5 条：聚合器 text/tool/空 json、onText 逐段、路由表三态、sideCall 兜底聚合、llm/stream 瀑布换实现）
- 全量 mock 回归：**27 场景全绿**。线格式锚全部原样通过——场景 7/15 的 side call `stream:false` 与评估器三消息形状、场景 20 的 429 重试（withRetry 消费侧语义）、场景 21 的 usage 注入驱动 T4、场景 26 的分类器双段。新场景 31：echo 后端零 anthropic 请求、结算文本复读、usage 经 Settlement 流转。

**翻车记档**：
1. **SDK 类型名的想当然**：`Anthropic.RawMessageStreamDelta`——报错才想起本地 SDK 版本（0.52）的类型面窄于记忆里的新版本。教训：**引用 SDK 类型前先 grep 本地 .d.ts**，类型名是版本敏感的；改用结构窄化（`as { type; text?; partial_json? }`）后顺手把 `text ?? ""` 补上（strict 的 undefined 不肯进 chunk）。
2. **（设计期）sideCall 差一点做成必选**：首版想强制每个适配器实现 sideCall——写 echo 时发现它只能"复读"，非流式旁路对假后端毫无意义。改成可选 + runtime 兜底后，echo 二十行就够，且"接缝可推导"从口号变成被测试钉住的性质。**可选方法 + 框架兜底**是 seam 设计的常用张力解法：默认可推导，覆写是优化。

## 7. 自测四题（答案在文末）

1. mini 的中立面为什么只做响应侧？把这个裁剪反过来（请求侧也中立）会立刻碰到哪两座地基？
2. `sideCall` 为什么做成可选 + 兜底，而不是每个适配器必选？anthropic 覆写它的真实动机是什么？
3. retry 为什么留在消费侧（withRetry 包住聚合闭包）而不是适配器内部？提示：重试的"重建整个流"语义里，谁拥有"已打印的半截文本"？
4. 空 JSON 串视作 `{}` 这行防御，防的是哪种响应？没有它会炸在哪一步？

> **答案**：
> 1. 响应侧中立只影响消费方式（chunk 方言）；请求侧中立会动线格式——而 mock 断言锚的请求体、C3 事件类型内嵌的线格式内容，都假设 Anthropic 形状。翻译层每多一个方向，"逐字节等价"验收就多一类要论证的差异。
> 2. 必选会把"非流式旁路"变成每个适配器的负担，而它语义上可从 stream 推导（聚合 text-delta）；anthropic 覆写是为了线格式——side call 在线上就该是 `stream:false` 的阻塞请求，mock 断言锚定了它，走流聚合会改变请求体。
> 3. "已打印的半截文本"属于调用方（spinner 协调、emitText 都在 agent），适配器看不见打印状态。重试语义 = 打印不缝合、整流重打——这个决策的完整上下文在消费侧，中间件化（llm/stream 监听器）也要等打印状态有事件出口（E1）之后。
> 4. 无参工具：server 对空 input 只发 block-start/stop，不发 input_json_delta。聚合器 `JSON.parse("")` 会 SyntaxError，异常从 step 抛出——走 C5 的失败补全把整个批次标错。一行防御换一个响应类别的正确性。

## 8. 与真框架的差距清单（C6 后）

| 能力 | 真 dsh | mini | 备注 |
|---|---|---|---|
| 请求词汇表中立 | ✅ ContentBlockMap/ToolSchema 双向翻译 | ❌ Anthropic 线格式直通 | 接第二家 provider 时补 |
| 流词汇表 | ✅ StreamChunk（更富，含 reasoning 等） | ✅ 六形 | block-start 携 id/name |
| 适配器路由 | ✅ prepareCall 绑定模型代 + 重试策略注册 | ❌ 单 route 字符串 | D6/E2 再议 |
| 重试 | ✅ 适配器注册的 retry 策略 | 消费侧 withRetry | llm/stream 瀑布是迁移挂点 |
| sideCall | ✅ llm 服务内建分层 | ✅ 可选覆写 + 聚合兜底 | 口径一致 |
| 模型发现/多模态 | ✅ ModelDiscovery/Image pricing | ❌ | 超出课程范围，记档 |

## 9. 下章预告（C7 system prompt 服务）

`prompt.ts` 的 `buildDynamicSystemContext` 消亡：section 注册表（identity/env/claude-md/memory/skills 各成一节）+ 中央 order + `{{var}}` 严格插值；工具 schema 由 ToolsService 注册成 order 靠后的 section；C3 的 system/message append 改由 assemble 驱动，cache_control 断点策略收进 assemble（末块打断点，行为不变）。验收：22 场景 system 字段逐字节等价。
