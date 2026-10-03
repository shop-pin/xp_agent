# dsh-B1 服务容器：Context 与 Service

> 本章开始手写 mini-cordis。产物只有两个文件（`cordis/context.ts` 约 120 行、`cordis/service.ts` 约 20 行），但它们是后面 20 章的地基：C 阶段每个服务（tools/session-log/llm…）都长在 Context 上。
> 参照物：`vendor/cordis/src/context.ts:42`（class Context）、`vendor/cordis/src/reflect.ts:134`（ReflectService.handler 的 get 陷阱）、`vendor/cordis/src/service.ts:41`（Service 构造器）。

---

## 1. 为什么需要服务容器

my_src 现在的模块关系是 **import 耦合**：agent.ts 顶部一排 `import { ... } from "./tools.js"`。模块在编译期就焊死了，想换实现只能改代码。

服务容器把"我需要什么"和"谁提供它"分开：

```ts
// 提供方（任何插件）
ctx.provide('llm', myAdapter)
// 消费方（不 import 提供者的文件，只认名字）
const llm = ctx.require('llm')
```

这就是 dsh "换 provider 即换产品"的前提：工具、模型适配器、审批策略互不 import，全靠 `ctx.<名字>` 相认。

## 2. Proxy：让"读属性"变成"查服务"

核心机关只有一个——**get 陷阱**：

```ts
const proxy = new Proxy(this, {
  get(target, prop) {
    if (服务表有 prop) return 服务表.get(prop)   // ctx.tools → ToolsService 实例
    // 沿父链找，仍没有 → throw
  },
})
```

`ctx.tools` 这行代码里没有任何"查找函数调用"——读属性本身触发了查找。真 cordis 的 get 陷阱（reflect.ts:134）多做的两件事：inject 声明校验（未声明就抛 `'cannot get property "x" without inject'`，B2 引入 Fiber 后我们补上）和 trace 诊断信息。

### 2.1 两个 this 绑定陷阱（你历史上的高频坑区，先讲透）

**陷阱一：方法调用的 this。** `proxy.provide(...)` 时，方法内部的 `this` 是 **proxy** 还是 raw 实例？取决于 get 陷阱返回时传的 receiver。我们的陷阱写的是：

```ts
if (Reflect.has(target, prop)) return Reflect.get(target, prop, target)  // receiver = target（raw）
```

receiver 传 `target` 而不是默认的 proxy，是为了让方法内的 `this` 是 WeakMap 挂过 key 的 raw 实例。真 cordis 同样在 handler 里精心处理了 `ctx` 与 `target` 的身份（`get: (target, prop, ctx) => ...` 三个参数分开用）。

**陷阱二：为什么不用 `#private` 字段。** 类私有字段靠"品牌检查"实现：`this.#field` 要求 `this` 拥有构造函数打上的品牌。Proxy 是新对象，没有品牌——方法一旦以 proxy 身份当 this 执行，`this.#field` 直接 `TypeError`。所以内部状态放 **WeakMap**，key 同时挂 raw 和 proxy 两个身份（构造函数里 `bags.set(this, bag); bags.set(proxy, bag)`），从哪个身份进来都能命中。

（附带你踩过的同类概念：`setInterval` 句柄当方法调用、`JSON.parse` 传文件名——都是"值的身份/语义与直觉不符"。Proxy 的 this 身份是同一族问题，只是更隐蔽。）

### 2.2 顺手的防御：thenable 安全

`await ctx` 时 JS 引擎会读 `ctx.then`。若 get 陷阱对未知名字一律抛错，一次误 await 就会变成莫名其妙的 rejection。所以陷阱里特判：`if (prop === 'then') return undefined`。

## 3. 父链查找 = 服务版原型继承

`new Context(parent)` 创建子上下文。查找规则与 JS 原型链一致：本层没有 → 查 parent → 一路向上 → 都没有才算不存在。

```ts
function lookup(ctx, name) {
  let cur = ctx
  while (cur) {
    if (bag.services.has(name)) return bag.services.get(name)
    cur = bag.parent
  }
  return MISSING
}
```

子层同名 provide 就是**遮蔽**（shadow）：`child.counter` 和 `parent.counter` 可以是不同实例，互不影响。B5 的 per-agent 作用域（"每个 agent 一棵私有工具注册树"）就是把这套机制用在工具注册表上——dsh 的 `packages/core/scope` 本质上是它的加强版。

> **【B2 修正】** 上面这段的"遮蔽"语义在 B2 被推翻：读真源码 `reflect.ts` 的 provide 后确认，真 cordis 是**全树共享一张服务表**（上下文树是"生命周期树"不是"服务表树"），子层同名提供是**冲突抛错**，不是遮蔽。父链查找保留（isolate 分槽时仍需要），但共享表下它只在 isolate 边界生效。详见 dsh-B2.md 第 1 节。

## 4. Service 基类与 declaration merging

```ts
class Service {
  constructor(ctx: Context, name: string) {
    this.ctx = ctx
    ctx.provide(name, this)   // 实例自己就是服务值
  }
}
```

子类两行完成注册：`super(ctx, 'greeter')` 之后 `ctx.greeter` 就是实例。真 cordis 的构造器（service.ts:41）还多做了 callable 包装和 tracker 诊断，语义核心相同。

**类型从哪来？** 运行时 `provide` 只是往 Map 里放值，`ctx.greeter` 的类型是插件方用 declaration merging 声明的：

```ts
declare module '../cordis/context.js' {
  interface Context { greeter: GreeterService }
}
```

两个 ESM 细节（都踩过才记住了）：
1. **模块说明符必须与 import 完全一致**。我们源码互导用 `.js` 后缀（NodeNext 规范），`declare module` 也必须写 `'../cordis/context.js'`——写 `.ts` 合并不上，静默失效。
2. 声明所在文件必须是模块（有 import/export），纯脚本文件里的 declare module 是 ambient 声明，语义完全不同。

Cordis 的教程（`docs/cordis-tutorial/03`）就是这么教用户的——**框架不认识你的服务类型，是你把类型"merge"进框架的**。这是 TS 扩展性的标准姿势，dsh 全仓库的 `SessionEventMap`、`Events`、`Context` 服务表全靠它长出来。

## 5. provide 的 disposer：一个被测试抓出来的设计 bug

初版 disposer 写的是"卸载时**恢复旧值**（undo 式）"。测试立刻抓出反例：

```
provide('x', 'first') → provide('x', 'second') → disposeSecond()
→ x 恢复成 'first'：一个已卸载的提供者复活了！
```

正确语义是"**只删除仍然是自己的注册**"：

```ts
return () => {
  if (disposed) return
  disposed = true
  if (bag.services.get(name) === service) bag.services.delete(name)
}
```

顺带想通一件事：子层卸载后"回落到父层同名服务"不需要 restore——lookup 是沿父链走的，子层删掉，查找自然落到父层。**恢复旧值是画蛇添足，删除即回落。** B3 的 effect 卸载（逆序执行）会天然得到正确的出栈顺序，这个 disposer 语义正好衔接。

## 6. 与真 cordis 的差距清单（B1 范围）

| 能力 | 真 cordis | mini-cordis B1 | 补齐章 |
|---|---|---|---|
| get 陷阱服务查找 | ✅ reflect.ts | ✅ | — |
| 父链继承 | ✅ extend | ✅ 构造传 parent | — |
| Service 基类 | ✅ + callable/tracker | ✅ 最小版 | 不补（诊断非核心） |
| 共享表 + provide 冲突抛错 | ✅ | ~~B1 各层独立表~~ → B2 已对齐 | 已在 B2 修正 |
| inject 未声明即抛错 | ✅ get 陷阱校验 | ❌ 不校验 | 明确放弃（见 B2） |
| effect/可撤销注册 | ✅ fiber.effect | ⚠️ provide 返回 disposer 但无人收集 | B3 |
| isolate/intercept 多实例 | ✅ | ❌ | 只讲原理（B5） |

## 7. 实现与验证记录

**文件**：
- `my_src/cordis/context.ts` —— Context + get/has 陷阱 + WeakMap 服务表 + 父链 lookup
- `my_src/cordis/service.ts` —— Service 基类
- `my_src/cordis-tests/b1-context.test.ts` —— 玩具插件（Greeter/Counter + declare module）+ 10 条测试
- `tsconfig.json` —— include 扩容（原配置只编根目录 `*.ts`，子目录根本不进编译）
- `package.json` —— 新增 `npm run cordis`

**验证**：
- `npm run cordis`：**10/10 绿**（覆盖：严格/可空读取、has、父链继承、遮蔽、disposer 幂等/不误删/不复活、方法名遮蔽限制、thenable 安全、declaration merging 类型断言）
- 全量 mock 回归：**22/22 绿**（业务代码零改动，确认新目录加入编译没有污染现有构建）

**翻车记档**（实现过程中真实发生）：
1. disposer "恢复旧值" 语义 bug（第 5 节）——被自己的测试抓出
2. `node --test dist/cordis-tests/` 在 Windows Node 24 下把目录当文件入口报 MODULE_NOT_FOUND，改用 glob 形式 `node --test "dist/cordis-tests/*.test.js"`
3. `Context as Record<string, unknown>` 直接转型报 TS2352，需经 `as unknown as` 两段式

## 8. 自测四题（答案在文末）

1. `new Proxy(this, handler)` 之后，`ctx.get` 这个方法内部的 `this` 是谁？由什么决定？
2. 为什么内部状态用 WeakMap 而不是 `#private` 字段？
3. 子上下文卸载掉自己 provide 的同名服务后，为什么不需要手动"恢复"父层的服务？
4. `declare module '../cordis/context.js'` 的 `.js` 后缀写错会发生什么？在哪个环节能发现？

> **答案**：
> 1. 是 raw 实例。get 陷阱 `Reflect.get(target, prop, target)` 把 receiver 显式设为 target，方法调用的 this 跟 receiver 走。若传 proxy，WeakMap 查找会 miss。
> 2. `#private` 靠构造函数品牌检查，proxy 没有 brand，方法以 proxy 为 this 时访问 `#field` 直接 TypeError；WeakMap 挂双身份 key 则两种 this 都能命中。
> 3. 查找是逐层走父链的实时查询，不是拷贝。子层删除后 lookup 自然穿透到父层；restore 反而会让已卸载的子服务"复活"旧值。
> 4. 合并静默失效——`ctx.greeter` 变成 any/报错取决于 strict 配置，运行时完全正常。发现环节在 **tsc**：消费方用了 `ctx.greeter.greet()` 时类型检查失败。这也是本测试文件"玩具插件同时是类型断言"的原因。

## 9. 下章预告（B2）

Context 现在有了"格子"（服务表），但还没有"住户管理"：插件三形态、生命周期状态机（PENDING→LOADING→ACTIVE→DISPOSED）、`inject` 依赖声明与等待、`ctx.plugin()`。B2 写 `cordis/fiber.ts` + `cordis/registry.ts`，参照 `vendor/cordis/src/fiber.ts` 的状态机段和 `registry.ts` 的插件归一化段。
