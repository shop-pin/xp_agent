# dsh-A0 建立体感（认知准备章）

> 本章不写代码。目标：在读 B 阶段源码之前，先在脑子里装上 dsh 的三个核心思想，并且**每个思想都看到实物证据**。
> 所有引用均出自 `deepseek-harness-master/`（下称 dsh 仓库），本文写作时逐文件核对过。

---

## 1. 思想一：一切皆插件 —— 212 行的 todo 插件全解剖

`packages/todo/tool-todo/src/index.ts` 是 dsh 里最小最完整的插件，212 行读完它，dsh 插件的四件套就全认识了：

```ts
export const name = 'tool-todo'                       // ← 实现名（loader 按 name 找到它）
export const inject = ['tools', 'sessionProjections'] // ← 依赖声明：没就绪就扣在 PENDING 不跑 apply
export const Config = z.object({                      // ← 配置 schema：cordis.yml 里写错的配置这里报错
  allowParallelInProgress: z.boolean().required(),
})
export function apply(ctx: Context, config: Config): void {  // ← 唯一入口
  ctx.sessionProjections.register({ key: 'todos', ... })    // 注册 1：会话投影（UI/回放读这个渲染清单）
  ctx.tools.register(defineTool({ name: 'todo_write', ... })) // 注册 2：模型工具
}
```

值得嚼三遍的细节：

1. **工具描述是配置的函数**（`describe(allowParallel)`，L63）：同一个工具，部署配置不同，模型看到的指令就不同。行为=代码+配置，插件的 config 不是摆设。
2. **execute 里没有一行"写 UI"或"写文件"**（L192-209）：它只做校验、然后 `exec.agent.session.append('todo/write', { todos })`——把事实追加进会话日志就返回。UI 从投影读，回放从日志读，工具本身谁也不认识。这就是"日志即真相"在工具侧的样子。
3. **output.schema + render 分离**（L158-191）：execute 返回 canonical JSON（`{todos, counts}`），`render` 纯函数把它投影成模型文本（"Updated todo list: 2 pending, ..."）。数据、展示、模型接口三样东西互不耦合——我们的 mini-claude 里工具返回 string，三样搅在一起。

对照：我们 my_src 的 `ToolDef` 只有 schema，执行在 tools.ts 的 switch 里。**C1 章的任务就是把这两半缝合成这样的 ToolDefinition。**

## 2. 思想二：日志即真相 —— 一份录制快照的逐行解读

`snapshots/acp/cancel/session.v3.jsonl`（3KB）是一个**录制好的完整会话日志**。节选：

```jsonl
{"type":"session","version":3,"id":"{{session:1}}","createdAt":0,"cwd":"{{cwd}}",...}   ← 文件头：格式版本
{"type":"permission/preset","data":{"preset":"danger-full-access"}}                      ← 权限策略也是事件
{"type":"agent/inbox/spliced","data":{"target":"next-turn","inserted":[...]}}            ← inbox 持久化！
{"type":"turn/start","data":{"turn":1}}
{"type":"step/start","data":{"turn":1,"step":1}}
{"type":"system/message","data":{...},"surfaceOp":"append"}                              ← system 也是日志事件
{"type":"user/message","data":{"content":[...],"source":{"kind":"user"},...},"surfaceOp":"append"}
{"type":"user/message","data":{"content":[{"type":"text","text":"Current runtime context. ..."}]}}  ← 运行时上下文走 user 消息
```

四个观察：

1. **`agent/inbox/spliced`**：连"待处理输入队列"都是事件。进程崩了重启，从日志重放，inbox 状态原样恢复。我们 C4 章的 inbox 就是它。
2. **`surfaceOp:"append"`**：每条消息事件带一个"表面操作"标记。模型看到的历史 = 对这些操作做投影（append/replace……）。压缩 = 追加 replace 操作遮住旧节点，**原始日志一个字节都不改**。这是 C3/D5 的地基。
3. **`{{session:1}}`、`{{cwd}}`、`{{system}}`**：录制时把每次都会变的值（id、时间戳、提示词全文）替换成占位符。回放时重放脚本喂回固定值——所以**不需要 API key 也能 100% 确定地重演整场会话**，并且 diff 的对象是"组装出的请求体 + 输出 + 落盘日志"三样。这个机制直接启发我们的 E3（snapshot 回归）。
4. **runtime context（文件策略、审批策略）走 user 消息而不是 system**：动态事实进 system 会打碎 prompt cache；跟着历史尾巴走就能吃满缓存。dsh 对缓存的执念到处都是。

`vitest.snapshot.config.ts` 的注释把三种模式说得很清楚：`replay`（默认，无 key，回放录制脚本）、`record`（真 API，重新录制）、`refresh`（回放但刷新期望输出）。**回放验证的不是"程序没崩"，而是"组装的请求、打印的输出、落盘的日志三者和录制时分毫不差"。**

## 3. 思想三：能力接缝 —— 策略是插进来的，不是写进去的

上一份快照开头三行就是证据：

```jsonl
{"type":"permission/preset","data":{...}}
{"type":"sandbox/mode","data":{...}}
{"type":"approval/policy","data":{"policy":"never"}}
```

权限、沙箱、审批是三个独立的策略服务，模型工具（消费者）根本不知道它们存在。工具作者写 `execute` 时不写一行权限判断；部署者在配置里换 approval 策略，工具代码零改动。接缝（seam）= 服务定义/提供者/消费者三角色，换提供者不动另外两个。

我们 my_src 的反面教材：`permissions.ts` 的九段流水线写在循环层，工具集合（READ_TOOLS 等）硬编码在文件顶部。C2 章把它们拆成"pre-execute 瀑布上的监听器"。

## 4. Turn flow 事件草图（背下来，C5 靠它）

对照 `docs/architecture.md` 的 Turn flow 一节 + `packages/core/agent-loop/src/agent.ts`，一次 turn 的骨架：

```text
turn/start                        ← 持久事件
  inbox.claim：认领输入（全部 next-step + 一条 next-turn）
  组装 prompt sections + tool schemas
  → agent/pre-step   [瀑布]  监听器可改写/拒绝输入；拒绝 → turn/end{blocked}，模型一次都不用调
  step/start                      ← 持久事件
  → agent/request    [瀑布]  拦截路由 → prepareCall 绑定适配器
  提交 system/message + user/message（此刻才落日志）
  deriveMessages() 从日志投影出模型历史 → deepFreeze
  流式调用 → llm/stream [瀑布] → agent/assistant-stream（瞬时帧，可丢）
  结算：assistant/message（内嵌完整流）或失败 assistant/attempt
  tool/call* → tools/pre-execute [瀑布] → tools/execute [瀑布] → tools/post-execute [瀑布] → tool/result*
  step/end                        ← 持久事件
  还有欠账（工具要再请求 / 来了新输入）？→ 回到 claim 开下一步
→ agent/turn-stopping  [serial，无 next]  最后的挽留机会（goal 评估就挂这里）
turn/end {reason}                 ← 持久事件，关闭必有理由
```

三个 [瀑布] 是扩展点（`agent/pre-step`、`agent/request`、`tools/*`），监听器不调 `next()` 就是否决；`turn-stopping` 是 serial（顺序 await，无 next）。**C5 章我们会把 plan/goal/auto/loop 全部改成挂在这几个点上的监听器，循环内的 if 分支全部消失。**

## 5. 体感笔记：三个最意外的点

1. **日志里没有"压缩后的消息"这回事。** 我原以为会话文件里存的是"模型看到的消息"，实际存的是"发生过什么"的全量事实流，模型看到什么只是投影结果。压缩、fork、resume、UI 回放全是同一份日志的不同投影——所以哪一种都不需要"修改历史"。
2. **插件小到没有存在感。** todo 工具 212 行里，真正的业务逻辑（校验+计数）不到 40 行，其余全是"声明"：我叫什么、我依赖谁、我的配置长什么样、我的结果怎么渲染。dsh 的复杂度不在插件里，在框架契约里——所以插件可以随时被替换。
3. **无 key 回放的确定性。** 录制时把挥发值归一化成 `{{占位符}}`，回放时 diff 三样东西（请求体/输出/日志）。这意味着测试断言的对象不是 stdout 装饰，而是**协议级的事实**。我们的 run-mock 断言请求体已经走在这条路上，E3 把它升级成完整的事件流快照。

## 6. 自测五题（答案在文末）

1. waterfall 监听器不调 `next()` 会发生什么？
2. 为什么 runtime context 走 user 消息而不是追加进 system prompt？
3. todo 插件的 execute 为什么不直接返回"给模型看的字符串"？
4. `agent/inbox/spliced` 是什么？进程崩溃后它如何发挥作用？
5. turn 的开启和关闭分别由什么决定？`turn/end` 为什么必须带 reason？

> **答案**：1. 否决——下游监听器和内建默认行为都不执行（around 中间件语义）。2. system 每次变化都会作废 prompt cache 前缀；user 消息跟在缓存历史后面，动态内容不伤缓存。3. 返回 canonical JSON，由 `output.render` 纯函数投影成模型文本、由 presenter 投影成 UI 卡片——数据/展示/接口三分离。4. inbox 的持久化事件；崩溃后从日志重放恢复待处理输入队列，输入不丢。5. 开启=inbox 有输入且 agent idle；关闭=无欠账（工具不再要求后续请求、无新输入），reason 记录关闭原因（completed/blocked/…），供 resume/fork/遥测判定。

---

## 附：本章验证方式

A0 无代码。验证=文档中所有论断均直接核对过实物：

- `packages/todo/tool-todo/src/index.ts` 全文 212 行已读（四件套/execute/render 的行号引用属实）
- `snapshots/acp/cancel/session.v3.jsonl` + `snapshot.yml` 已读（事件格式/surfaceOp/占位符属实）
- `vitest.snapshot.config.ts` 已读（replay/record/refresh 三模式属实）
- `docs/architecture.md` Turn flow 节已读（事件草图与之一致）

**未做**：未在本机跑 `pnpm run test:snapshot`（全量 monorepo build 代价大，快照实物已直接检视；想亲眼看回放可择日在 dsh 仓库跑 `pnpm install && pnpm run build && pnpm run test:snapshot -- -t cancel`）。
