# dsh-B2 插件与 Fiber：生命周期与依赖等待

> 产物：`cordis/fiber.ts`（Fiber 状态机）、`cordis/registry.ts`（三形态归一化 + pending 队列）、`cordis/hooks.ts`（provide 通知），以及 context.ts 新增的 `ctx.plugin()`。
> 参照物：`vendor/cordis/src/fiber.ts`（状态机 + parent.extend）、`vendor/cordis/src/registry.ts`（插件归一化）、`vendor/cordis/src/reflect.ts:277`（provide 的 store/notify——本章最重要的证据）。

---

## 1. 本章最重要的认知修正：上下文树是"生命周期树"，不是"服务表树"

B1 我们按直觉实现了"子上下文各有一张服务表，子层提供同名服务=遮蔽父层"。**这个直觉是错的**。读真源码 `reflect.ts` 的 provide：

```ts
this.ctx.root[symbols.isolate][name] ??= Symbol(name)  // 根部为每个名字登记默认 isolate key
const key = this.ctx[symbols.isolate][name]            // 本 ctx 解析出的槽位 key
if (this.store[key]) {
  throw new Error(`service "${name}" has been registered at <${...}>`)  // 冲突抛错！
}
this.store[key] = impl                                  // 全树共享一个 store
```

三个事实：

1. **一个 store，全树共享**。isolate key 默认同名同 Symbol——所以默认情况下 `ctx.tools` 这类服务全树只有一个槽位、一个实例。
2. **同名提供是错误，不是覆盖**。想要两个实例（比如两组各配一个 shell），用 `isolate` 给子树换 key——那是例外机制，不是默认。
3. **树的意义在生命周期与事件域**：子 fiber 卸载级联（B3）、事件按 fiber 域过滤（B4），而服务解析永远是"沿树向上找到那一个共享实例"。

dsh 里"给一个 session 不同的能力集"靠 preset + isolate realm（architecture.md 的 "a service row there needs an isolate realm"），不是靠多张表。

**B1 的"遮蔽"测试在 B2 被重写成"冲突抛错"测试**——框架演进的先立后破，真实发生了一次。

## 2. 插件三形态与归一化

`resolvePlugin()` 把三种写法归一成 `{ name?, inject?, apply(ctx, config) }`：

| 形态 | 例子 | 入口 |
|---|---|---|
| 对象 | `{ name: 'tool-todo', inject: [...], apply(ctx, config) {...} }` | apply |
| 箭头函数 | `(ctx, config) => {...}` | 函数体即 apply |
| 类 | `class MyPlugin { constructor(ctx, config) {...} }` | 构造器（Service 子类插件在构造器里注册服务） |

判别依据：**箭头函数没有 `prototype` 属性**——`typeof plugin === 'function' && plugin.prototype !== undefined` 即按类处理。限制：带 prototype 的普通 function 会被误判为类（`new` 调用），所以函数形态一律写箭头函数（cordis 教程同样的约定）。

dsh 的 todo 插件（B0 读过）就是对象形态的完整范本：`name` 给 loader 认、`inject` 给框架扣留用、`Config` 给配置校验用（mini 版 B2 不做校验，config 以 `unknown` 透传）。

## 3. Fiber：插件实例的运行时与状态机

```
pending ──依赖齐备──→ loading ──apply 正常返回──→ active
   │                    │
   └── 依赖永远不到      └── apply 抛错 → disposed（fail-loud，错误从挂载点上抛）
```

Fiber 构造做三件事：归一化插件、领一个 **child Context**（`new Context(parent)`——它的意义是生命周期边界与 B4 的事件域，不是独立服务表）、初始状态 pending。

`refresh()` 是状态机的心脏：

```ts
refresh(): void {
  if (this.state !== 'pending') return          // 幂等闸
  for (const name of this.inject)
    if (!this.parentCtx.has(name)) return       // 依赖未齐 → 静默等待
  this.state = 'loading'
  try { this.pluginDef.apply(this.ctx, this.config); this.state = 'active' }
  catch (e) { this.state = 'disposed'; throw e }
}
```

**apply 恰好执行一次**——这是整章最强的约束。依赖晚到靠的是"通知 + 重查"，不是轮询，也不是反复执行 apply。

## 4. 依赖等待：provide 通知 → 全量重查

谁在等？`registry.ts` 维护一个全局 `pendingFibers` 集合。谁叫醒？`provide()` 落表后 `notifyProvided(name)`，registry 在模块加载时订阅了这个钩子，收到通知就重查整个 pending 集：依赖齐了就 refresh，状态离开 pending 即出队。

为什么 context.ts 不直接调用 registry？**依赖方向**：`context → registry → hooks`，`context → fiber`（fiber 只 type-import context）——把通知点抽成零依赖的 `hooks.ts`，四个模块之间没有一条运行时环。真 cordis 用 `internal/update` waterfall + fiber epoch 做精确失效（只重查受影响的 fiber）；mini 版全量重查，语义是超集，代价是每次 provide 扫一遍等待队列——对单树小规模场景无所谓，认知重点在"**provide 是事件，等待者被推着走**"。

激活链是递归的：provide A → 唤醒 F1 → F1 的 apply 里 provide B → 再唤醒 F2……迭代快照（`[...pendingFibers]`）保证集合边遍历边改不出事。

## 5. provide 的两条铁律（B2 定稿语义）

1. **冲突即抛错**：`service "x" has been registered already`。disposer 释放槽位后可以重新提供。
2. **disposer 只删自己的**：`if (bag.services.get(name) === service) delete`。B1 已经修过一次（不恢复旧值），B2 补上冲突语义后，"不误删后来者"的防御依然必要——disposer 可能被延迟调用（B3 的卸载时机）。

## 6. 失败即响（fail-loud）

apply 抛错：fiber 置 disposed、从 pending 出队、错误包装上插件名从 `ctx.plugin()` 挂载点直接抛出：

```
Error: [mini-cordis] plugin <boom> apply failed: kaboom
```

一个插件挂载失败不污染后续挂载（下一个 plugin() 照常 active），但你**不可能不知情**。这是 dsh "Misconfiguration fails loud" 约定在框架层的体现。

## 7. 与真 cordis 的差距清单（B2 后）

| 能力 | 真 cordis | mini-cordis | 补齐 |
|---|---|---|---|
| 三形态 + inject 等待 + 状态机 | ✅ | ✅ | — |
| provide 冲突检测 + 通知 | ✅ store+notify | ✅ hooks 全量重查 | — |
| 异步 apply | ✅ LOADING 到 promise 结算 | ❌ 仅同步（C 阶段需要时再补） | 视需要 |
| epoch 精确失效 / 按树归队 | ✅ | ❌ 全局单集（假设单树） | 明确放弃 |
| 配置 schema 校验（Config） | ✅ schemastery | ❌ unknown 透传 | 明确放弃 |
| fiber 卸载（dispose/级联） | ✅ | ❌ 只有 failed→disposed | **B3** |

## 8. 实现与验证记录

**文件**：
- `cordis/hooks.ts`（新增，零依赖通知点）
- `cordis/fiber.ts`（新增：PluginObject/Plugin 类型 + Fiber）
- `cordis/registry.ts`（新增：resolvePlugin + pending 队列 + 顶层订阅）
- `cordis/context.ts`（修改：共享服务表、provide 冲突抛错 + notify、新增 plugin()）
- `cordis-tests/b2-fiber.test.ts`（新增 11 条测试）
- `cordis-tests/b1-context.test.ts`（修改：遮蔽测试→冲突测试、disposer 测试→冲突语义、新增通知测试）

**验证**：`npm run cordis` **22/22 绿**（B1 11 条 + B2 11 条）；全量 mock 回归 **22/22 绿**（业务代码零改动）。

**翻车记档**：
1. 匿名箭头函数的 `.name` 是 **`''` 不是 `undefined`**——`name ?? '<anonymous>'` 兜不住空串，改用 `||`。（又一例"值的身份与直觉不符"）
2. "apply 抛错"测试初版假设 `ctx.plugin()` 返回 disposed fiber，实际按 fail-loud 设计错误直接上抛——**测试要服从设计**，重写为 `assert.throws` 包挂载点。
3. TS 对函数联合类型的窄化不删除构造签名分支：`resolvePlugin` 的 else 分支仍可能是"类"，需显式 `as` 断言。
4. `ctx.require<T>('ping')` 返回的就是服务实例本身（不是工厂/函数）——初版测试写成 `require(...)().pong()` 多套了一层括号。

## 9. 自测四题（答案在文末）

1. 为什么 dsh 里两个插件不能各提供一个 `ctx.shell`？正确的做法是什么？
2. 依赖后到的插件为什么不会错过激活时机？通知链条经过哪几个模块？
3. fiber 的 child Context 和父 Context 的服务表是什么关系？那 child Context 存在的意义是什么？
4. `resolvePlugin` 用 `plugin.prototype !== undefined` 判类，哪个合法写法会被误判？怎么规避？

> **答案**：
> 1. 共享 store 里同名同槽，第二次 provide 抛错。需要两个实例时用 `isolate` 给子树换槽位 key（B5 讲原理）；多数场景其实应该做成同一服务的配置差异。
> 2. provide 落表后 `notifyProvided` → hooks 钩子 → registry 重查 pendingFibers → fiber.refresh()（幂等，激活即出队）。等待是推送不是轮询，apply 只会执行一次。
> 3. 同一张（共享服务表）。child Context 的意义在生命周期边界（B3 的级联卸载以它为单位）与事件域（B4 按域过滤），不在服务隔离。
> 4. 带 prototype 的普通 function（如 `function foo(ctx){}`）会被当类 `new` 调用。规避：函数形态一律写箭头函数。

## 10. 下章预告（B3）

Fiber 只能出生不能死亡——B3 落 **effect 模型**：`ctx.effect()` 收集注册产生的 disposer、`fiber.dispose()` 逆序并发执行、子 fiber 的 dispose 挂在父 fiber 的 effect 上（级联卸载）、apply 中途抛错回滚已注册的 effect。参照 `vendor/cordis/src/fiber.ts` 的 effect/unload 段。这是"注册即可撤销"的地基，也是 HMR/per-agent 作用域的前提。

## 11. 代码执行流程图

> 对应提交 `5c6c847`。三条主线：挂载（plugin）→ 激活（refresh 状态机）→ 唤醒（provide 通知链）。

### 11.1 挂载：`ctx.plugin(def, config)`

```
ctx.plugin(pluginDef, config)
 │
 ├─ ① child = new Context(this)
 │      └─ bag₂.services = parentBag.services   ★ 引用同一张 Map，不是拷贝
 │         （生命周期树 ≠ 服务表树：child 只是边界，表全树共享）
 ├─ ② fiber = new Fiber(this, child, resolvePlugin(pluginDef), config)
 │      └─ resolvePlugin 三形态归一化：
 │           对象 {name,inject,apply} → 原样返回
 │           箭头函数 → { name: fn.name, apply: fn }   （箭头函数无 prototype）
 │           类 → { name: Cls.name, apply: (ctx,cfg) => void new Cls(ctx,cfg) }
 │              （Service 子类插件：注册发生在构造器 super→provide，见 B1 10.2）
 ├─ ③ trackPending(fiber)      先挂进全局 pendingFibers（state='pending'）
 └─ ④ refreshPendingFibers()   立即重查一次 → 11.2
        依赖齐 → 当场激活；未齐 → 扣在集合里，返回 fiber 供检查状态
```

### 11.2 激活：`fiber.refresh()` 状态机

```
fiber.refresh()
 │
 ├─ state ≠ 'pending'？ ──是──→ return          幂等：apply 恰好执行一次
 ├─ 遍历 inject：任一 parentCtx.has(name) 为 false？
 │        └─ 是 → 静默 return（留在 pending，等 11.3 的通知再来）
 ├─ state = 'loading'
 ├─ pluginDef.apply(fiber.ctx, config)          注意传的是 child ctx
 │      ├─ 正常返回 → state = 'active'
 │      │     （apply 里的 ctx.provide 已落共享表，全树可读）
 │      └─ 抛错     → state = 'disposed'，原样上抛（fail-loud，不吞）
 └─ （B3 起：apply 期间的注册被 effect 收集，出错可回滚——见 B3 11.2）
```

### 11.3 唤醒链：provide 落表 → 重查等待队列

```
任意位置：ctx.provide('llm', adapter)
 │
 ├─ bag.services.has('llm')？ ──是──→ throw "has been registered already"
 │                                    （共享表全树同名同槽，冲突即抛，B1 的覆盖语义废弃）
 ├─ bag.services.set('llm', adapter)
 ├─ notifyProvided('llm')                        ← hooks.ts（防 import 环：
 │      │                                          context → hooks ← registry）
 │      └─ 遍历 provideHooks 快照 → registry 模块加载时订阅的 refreshPendingFibers
 │             for fiber of [...pendingFibers]    （快照迭代：钩子里可再 provide）
 │                  ├─ state ≠ 'pending' → 出队
 │                  ├─ fiber.refresh()   → 11.2
 │                  │    ├─ 激活 → 出队；apply 里若又 provide → 递归唤醒
 │                  │    │                  （递归深度 = 插件激活链长）
 │                  │    └─ 仍缺依赖 → 留在集合，下次再说
 │                  └─ apply 抛错 → 出队 + throw "plugin <name> apply failed"
 └─ return disposer（B3 起被 effect 接管）
```

等待是**推送**不是轮询：没有定时器，全靠"每次落表推一把"。

### 11.4 完整时序走查：依赖晚到的插件

```
时刻 1：ctx.plugin({ name:'todo', inject:['llm'], apply(ctx){ ctx.provide('todo', …) } })
  ① child = new Context(ctx)      bag₂.services === bag₁.services
  ② resolvePlugin → 对象形态原样
  ③ pendingFibers = { fiber }
  ④ refresh：has('llm') = false → 静默回 pending
  返回 fiber。此刻：ctx.todo 不存在，apply 一次都没跑

时刻 2：ctx.provide('llm', adapter)
  落共享表 → notifyProvided → refreshPendingFibers
  → fiber.refresh：has('llm') ✓ → loading
  → apply(child) → ctx.provide('todo', svc) → 落共享表
                 → 又一次 notifyProvided（pending 已空，空转一圈）
  → state = 'active' → 出队
  → ctx.todo 立即在全树可读（共享表，不分层）
```

对照测试 `b2-fiber.test.ts` 的"依赖齐备才 apply / 晚到唤醒"两条：时刻 1 断言 `fiber.state === 'pending'` 且 todo 不可读，时刻 2 之后全部翻转。
