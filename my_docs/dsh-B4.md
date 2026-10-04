# dsh-B4 事件系统：五种派发与 waterfall

> 本章产物：`cordis/events.ts`（isBailed + 五种派发 + onEvent）、`context.ts` 挂 `on/emit/parallel/serial/bail/waterfall` 六方法 + 整树共享事件域、`interface Events {}` 供 declaration merging。
> 一句话：**服务表解决"我需要什么"（拉），事件解决"谁关心发生了什么"（推）——控制反转的另一半。** dsh 里 session 更新、工具调用遥测、审批请求全走这条通道。
> 参照物：`vendor/cordis/src/events.ts`（EventsService 的 dispatch/parallel/serial/bail/waterfall/register 全段）。

---

## 1. 五种派发：一份监听器列表，五种"怎么调"

注册（`ctx.on`）只有一个，派发有五种——区别全在**等待策略**和**返回值怎么用**：

| 方法 | 等待 | 返回值语义 | 典型用途（dsh 场景） |
|---|---|---|---|
| `emit` | 不等，同步广播 | 忽略 | 遥测/日志：fire-and-forget |
| `parallel` | `Promise.allSettled` 全等 | 无；任一 reject → AggregateError 汇总 | 通知多个子系统（都完成才算完） |
| `serial` | 逐个 await | 第一个 **bail 值**即停并返回 | 责任链：谁认领谁接手 |
| `bail` | 同步逐个 | 同上（同步版） | 快速探测：第一个有答案的说了算 |
| `waterfall` | 闭包链 | 最外层 listener 的返回值 | around 中间件：包住默认行为 |

**bail 判定铁律**（roadmap 预埋的危险点，真源码 `isBailed` 原样照抄）：

```ts
value !== null && value !== false && value !== undefined
```

写成 truthy 判定会把 `0`、`''`、`NaN` 误判为"有人接手了"——比如 serial 找"第一个返回下标的 listener"，下标 0 会被吞掉。测试里专门固化了 `false`/`undefined` 连续两个不停、第三个才停的断言。

错误策略的差异是刻意设计：`emit` 的同步抛错**照常上抛**（fail-loud，你在广播点上就知道）；`parallel` 把所有 rejection 收进 AggregateError 一次性报出（allSettled：一个失败不拖累其他监听器完成自己的清理）。

## 2. waterfall：一个 next 闭包走天下

真源码的 waterfall 段只有 10 行，机制值得逐行吃透：

```ts
const cbs = this.dispatch('waterfall', args)   // 监听器列表（注册序）
const inner = args.pop()                        // 调用者的最后一个参数 = 兜底行为
const next = () => {
  const cb = cbs.shift() ?? inner               // 逐个 shift，耗尽落到 inner
  return cb(...args)
}
args.push(next)                                 // next 成为最后一个参数
return next()                                   // 从最外层监听器开始
```

三个反直觉点：

1. **只有一个 next 函数**。不是每层新建——所有 listener 收到的是同一个 next，每次调用 shift 下一个。caller→L1→L2→inner 的链靠的是"next 自己 shift 自己的队列"。
2. **inner 是调用者传的**。`waterfall('evt', x, () => 默认行为)`——最后那个参数被 pop 出来做链的终点。**类型上它恰好占据事件签名里 `next` 的位置**（`'demo/flow'(input, next: () => string): string`），所以"调用方必须提供兜底行为"是类型逼你写出来的，不传编译不过。这是 dsh `internal/config`、`internal/update` 这类框架事件的调用姿势。
3. **不调 next = 否决**。listener 直接返回自己的值，后继监听器和 inner 都不执行——测试断言了"inner 的返回值没出现、后一个 listener 的 flag 没被置位"。这就是审批拦截（veto）的实现地基。

注册序 = 外层序：先注册的最先被调（最外层包最里面），返回值逐层包回去（`core>L2>L1`）。

## 3. 生命周期归属：on 就是 effect（B3 红利兑现）

```ts
const hooks = getHooks(events, name)
const hook = { callback: listener }
const disposer = () => unregister(hooks, hook)
if (fiber) {
  fiber.effect(() => { hooks.push(hook); return () => void disposer() }, `ctx.on(...)`)
} else {
  hooks.push(hook)
}
return disposer
```

与 provide 完全同款的归属规则：**插件内 on → disposer 进 fiber 的清理列表**，卸载自动摘除，级联卸载顺带清干净整个子树（测试：父卸载后，子插件和孙插件的监听器全部消失）；**root 上 on → 返回 disposer 手动管**，且 disposer 有回执（返回是否仍处于注册状态，重复摘除幂等返回 false）。

这里撞上了一条 B3 的纪律：effect 通道的 Disposer 是 `() => void | Promise<void>`，而 on 的公开 disposer 要返回 boolean（vendor 语义 "true if it was still registered"）。TS2322 当场打回。解法是**两条通道各说各话**：effect 里登记 `() => void disposer()` 的 void 包装，boolean 回执只留给 on 的直接调用者。"借还配对不带回执"是 effect 的内部纪律，回执是公开 API 的承诺，一个函数两个面目靠包装分开。

## 4. 事件域 = 一棵上下文树

监听器存哪？答案与 B2 的"服务表整树共享"同构：`ServiceBag` 加一个 `events: HookMap`，根部创建、子层拿引用。一棵树一个 bus，两棵树互不干扰（有测试）。

B2 曾预告"事件按 fiber 域过滤（B4）"——真 cordis 确实有这层：每个 Hook 记录注册时的 ctx，dispatch 时按 `Context.filter` 过滤（session 树只收自己的事件）。**mini 版裁掉了**：整树广播，Hook 只存 callback。裁剪理由：filter 依赖 isolate/作用域机制（B5 的主题），mini 版单树单会话场景下整树广播语义无损；等 B5 讲原理时把这层差异讲透。相应地，vendor dispatch 里那套 thisArg 首参探测（`typeof args[0] === 'object' ? args.shift() : null` 的启发式）也不抄——它是为 filter 服务的。

其余裁剪（记入差距清单）：`prepend/global` 选项、`once`（三行糖，C 阶段需要再补）、`internal/*` 框架自事件（internal/listener、internal/update、internal/dispatch——它们是 cordis 自身 update waterfall 的机制件，mini 没有这需求）。

## 5. 与真 cordis 的差距清单（B4 后）

| 能力 | 真 cordis | mini-cordis | 补齐 |
|---|---|---|---|
| 五种派发 + isBailed | ✅ | ✅ 逐一断言 | — |
| waterfall 闭包链 | ✅ | ✅ 照抄结构 | — |
| on 的 effect 归属 | ✅ fiber.effect | ✅ | — |
| Events merging 类型 | ✅ | ✅ | — |
| parallel 错误汇总 | ✅ AggregateError | ✅ | — |
| thisArg 探测 + Context.filter 过滤 | ✅ | ❌ 整树广播 | B5 讲原理 |
| prepend/global/once | ✅ | ❌ | 视需要 |
| internal/* 框架自事件 | ✅ | ❌ | 明确放弃 |
| emit 快照 | dispatch 产新数组 | ✅ `[...hooks]` | — |

## 6. 实现与验证记录

**文件**：
- `cordis/events.ts`（新增：Parameters/ReturnType 工具型、Events 接口、isBailed、getHooks/onEvent/emitEvent/parallelEvent/serialEvent/bailEvent/waterfallEvent）
- `cordis/context.ts`（修改：ServiceBag 加共享 events 域、六个事件方法 + eventHooks 私有助手）
- `cordis-tests/b4-events.test.ts`（新增 10 条测试）

**验证**：
- `npm run cordis`：**42/42 绿**（B1 11 + B2 11 + B3 10 + B4 10；覆盖：五派发各一、AggregateError 汇总、bail 判定 false/undefined 不停、waterfall 改写链 + 否决、卸载/级联摘监听、root 手动 disposer 回执、双树隔离）
- 全量 mock 回归：**22/22 绿**（业务代码零改动）

**翻车记档**（实现过程中真实发生）：
1. **on 的第一版当场写乱**：想避免"取两次 bag"，在调用点现场发明了一个 `this.eventHooks(name).length >= 0 ? bags.get(this)!.events : undefined as never` 的乱码条件——本质是没想清楚 onEvent 该收 map（自己建列表）还是收数组（调用方建好）。重写定案：收数组，name 只用作 effect label。教训：接口边界先定，别在调用点补偿设计缺口。
2. **两条 disposer 纪律打架**（第 3 节）：effect 通道要 void、公开 API 要 boolean 回执，TS2322 打回后用 void 包装分开——不是绕过类型，是发现"一个函数两个面目"本来就该拆开。
3. **waterfall 的 inner 是 unknown**：`args.pop()` 出来不能调用，`cbs.shift() ?? inner` 推成 unknown。显式断言成监听器签名后才意识到一个更深的对应：**调用方的最后一个参数在类型上就是事件签名里的 next 位**——vendor 不用写这个断言（全 any），mini 版的 strict 反而逼出了这个语义澄清。

## 7. 自测四题（答案在文末）

1. serial 找"第一个返回下标的 listener"，为什么 truthy 判定会把下标 0 吞掉？isBailed 的准确规则是什么？
2. waterfall 里所有 listener 收到的 next 是同一个函数吗？链是怎么前进的？inner 从哪来、在类型上占什么位置？
3. 插件 apply 里 `ctx.on(...)` 的监听器，在父 fiber 卸载时经过了哪些机制才消失？
4. emit 与 parallel 的错误策略为何一个上抛一个汇总？如果 parallel 里 3 个 listener 同时 reject，调用者怎么拿到全部原因？

> **答案**：
> 1. 下标 0 是 truthy 假值（0、''、NaN 同族），truthy 判定会当作"没人接手"继续走。规则：`value !== null && value !== false && value !== undefined` 才算 bail——只有"明确的空"放行，其余一律视为有效答案。
> 2. 是同一个 next（闭包里共享 cbs 队列），每次调用 shift 下一个，耗尽落到 inner；inner 是调用方传的最后一个参数，被 pop 出来做链终点；类型上它恰好占据事件签名里 next 参数的位置，所以"兜底行为必须由派发方提供"是类型约束。
> 3. on 发现 `ctx.fiber` 存在 → 登记动作用 `fiber.effect()` 收进当前 fiber 的清理列表 → 级联卸载（B3：子 dispose 是父的一条 effect）逐层触发 → 各 fiber 的 beginDispose 逆序执行到 on 那条 disposer → unregister 按 identity 摘除。四个机制：effect 收集、级联、逆序、identity 摘除。
> 4. emit 是 fire-and-forget 的广播点，同步抛错静默吞掉等于失败不可见，所以直接上抛（fail-loud）；parallel 的语义是"等全部完成"，一个失败不该拖累其他监听器，所以 allSettled 收齐后用 AggregateError 汇总（`error.errors` 数组拿到全部原因）。

## 8. 下章预告（B5）

Context 树有了生命周期域和事件域，还差最后一块拼图：**同一个服务怎么在一个树里存在多个实例**（两组各配一个 shell、一个 session 一套工具）。B5 只讲原理不动手——isolate 的分槽 key（`root[isolate][name] ??= Symbol(name)`）、realm 的"分域再分组"、以及 dsh 的 preset 怎么组合它们；配套手写一个几十行的 createScope 体验"作用域即子上下文 + 注册入口"。
