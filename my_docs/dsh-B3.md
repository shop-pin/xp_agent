# dsh-B3 effect 模型：注册即可撤销

> 本章产物：`fiber.ts` 扩展（`Disposer`/`EffectExecute` 类型、`ctx.effect()`、`fiber.dispose()`、apply 回滚）、`context.ts` 的 `fiber` 字段与级联注册、provide 自动收集。
> 一句话：**插件在 apply 里做的每一次"注册"（服务/定时器/子插件），都自动配对一个撤销函数；fiber 卸载 = 全部注册逆序回滚。** 这是 HMR 与 per-agent 作用域（B5）的地基。
> 参照物：`vendor/cordis/src/fiber.ts`（Disposable/Effect 定义段、`_disposables`、内层 effect 的 dispose 链、`parent.extend({ fiber: this })`）。

---

## 1. 核心抽象：effect = 注册动作 + 撤销函数，成对出现

插件的 apply 本质上是一串"注册"：provide 服务、挂监听器、起定时器、挂子插件。B2 里这些注册只生不灭——fiber 没有卸载语义，"换插件"就无从谈起。B3 把每次注册规范成一个二元组：

```ts
ctx.effect(execute: () => Disposer | void, label?: string): void
// execute 立即执行；返回的撤销函数被 fiber 收集，dispose 时逆序执行
```

典型形状就是"借还配对"：

```ts
ctx.effect(() => {
  const timer = setInterval(tick, 1000)
  return () => clearInterval(timer)   // 借了什么，还什么
})
```

两条签名纪律（实现时被 TS 抓过一次，见第 8 节翻车 #1）：

1. **execute 必须同步返回 disposer**——effect 注册是登记行为，不允许"等一会儿再给你撤销函数"，那会让 dispose 窗口期出现"已卸载但撤销函数未登记"的漏洞。
2. **disposer 本身允许异步**（`void | Promise<void>`）——清理经常要等 IO；所以级联卸载的写法是 `effect(() => () => fiber.dispose())`，两层箭头：外层 execute 同步登记，内层 disposer 异步等待子清理结算。

## 2. dispose 的结算语义：幂等、逆序启动、并发执行、吞错记日志

```ts
dispose(): Promise<void> {
  this.disposeTask ??= this.beginDispose()   // 幂等闸：一次结算，重复调用共用同一个 promise
  return this.disposeTask
}
```

`beginDispose()` 的三步顺序是有讲究的：

1. **先置 `state = 'disposed'`**——清理期间任何读状态者看到的是"已卸载"，不会往一个正在拆迁的房子里搬家具；
2. **`untrackPending(this)`**——pending 中的 fiber 被级联卸载时立即出队，之后 provide 不会唤醒它（否则一个死 fiber 还挂在等待队列里，靠下次 provide 的扫除才被动清掉）；
3. **逆序启动、并发执行**：`splice(0).reverse()` 后逐个启动，单个抛错（同步 throw 或异步 reject）只 `console.error` 记日志，不阻断其他清理；`Promise.all` 等全部结算。

**与真 cordis 的一个诚实差异**：vendor 内层 effect 的 dispose 是**链式串行**（`task = task.then(() => runDisposable(d))`，逆序且逐个 await）；mini 版按 roadmap 选了逆序启动并发跑。并发更快，但**清理之间有顺序依赖时会踩脚**——真源码的注释写得很清楚："顺序敏感就放同一条 effect 里自己 await"。mini 版照抄这条纪律，并在测试里固化了"同步抛错 + 异步 reject + 正常清理三者共存、dispose 照常结算"的断言。

## 3. 级联卸载：子 fiber 的 dispose 就是父 fiber 的一条 effect

`ctx.plugin()` 在 B3 补上一段：

```ts
const child = new Context(this)
const fiber = new Fiber(this, child, resolvePlugin(pluginDef), config)
child.fiber = fiber                                  // 让子 ctx 知道自己的生命周期所有者
const parentFiber = this.fiber
if (parentFiber) parentFiber.effect(() => () => fiber.dispose(), `child <${fiber.name}>`)
```

三个设计点：

**fiber 怎么被 ctx 找到？** 真 cordis 用 `parent.extend({ fiber: this })`——child ctx 自带 fiber 指认。mini 版在 Context 上加了 `fiber?: Fiber` 字段（root 没有）。这是 effect 归属的钥匙：`ctx.effect()` 转发给 `this.fiber`，root 上调用直接 fail-loud 抛 `requires a plugin fiber`——**没有归属的注册就是泄漏，框架替你拒收**（对应 vendor 的 `INACTIVE_EFFECT`）。同理，disposed fiber 上再注册也抛错。副作用：服务名不能叫 `fiber`（与 get/provide 等自有成员同一族已知限制）。

**为什么是"挂 effect"而不是"父 fiber 维护 children 数组"？** 数组方案要在 Fiber 上新增一个概念（children），dispose 里多一段遍历；effect 方案零新概念——级联只是"注册"的一种，天然继承逆序、幂等、并发、吞错全套语义，且**孙随子**自动成立（子的 children 不需要存在，孙的 dispose 早挂在子的 effect 列表里了）。测试里三级嵌套的清理顺序 `grand → child → parent` 就是逆序语义免费送的。

**注册顺序：先挂级联、再 trackPending、最后 refresh。** 单线程同步模型里这个顺序不存在竞态窗口；反过来的话，refresh（apply）先跑，apply 里再挂的孙插件会先于"自己这条级联"登记——父卸载时逆序回滚依然正确，但 apply 抛错时子 fiber 的回滚与级联登记的交错会变得难推理。先登记归属、再执行用户代码，心智模型简单：**dispose 的时候，登记表里不会有"漏网"的子树**。

## 4. provide 自动收集：B1 的伏笔兑现

B1 注释里埋了一句"provide 返回 disposer，B3 起由 effect 统一收集"。B3 兑现：

```ts
const fiber = this.fiber
if (fiber && (fiber.state === 'loading' || fiber.state === 'active')) {
  fiber.collect(disposer, `provide("${name}")`)
}
return disposer
```

- 插件内 provide（apply 执行中，state 是 loading/active）→ disposer 自动进 fiber 的清理列表，fiber 卸载时服务自动从共享表摘除；
- root 上的手动 provide → 没有 fiber，维持 B1 语义（返回 disposer 自己管），B1/B2 的全部测试零改动通过；
- `collect()` 与 `effect()` 分开：effect 是"执行 + 收集"，collect 是"已有 disposer，纯登记"。disposed 后调用 collect 直接返回——不是防御，是这条路径在单线程模型下本就不可达（provide 的守卫先拦了），留一行空跑分支反而误导。

真 cordis 里 provide 本身就是一条 effect（reflect.ts 的 effect 树里就有 `ctx.provide("name")` 标签），mini 版用"provide 尾部挂 collect"达到了同一效果，代价是 provide 得知道自己被谁调用——`this.fiber` 就是那个答案。

## 5. apply 中途抛错：先回滚、再上抛

B2 的 catch 只置 `disposed`；B3 的 catch 换成：

```ts
catch (error) {
  this.disposeTask = this.beginDispose()   // 回滚已收集的 effect
  throw error                              // fail-loud 照旧
}
```

关键在**顺序**：同步 disposer 在 `beginDispose()` 的调用栈里当场执行完，然后错误才从挂载点抛出。挂载点拿到错误时，"半截插件"已经不留痕迹（provide 摘了、定时器停了）——测试断言 `cleaned === true` 和 `ctx.has('temp') === false` 都在 `assert.throws` 之后立即成立。异步 disposer 则进 `disposeTask`，错误上抛时清理"已启动未结算"——不阻塞报错路径，也不泄漏承诺（disposeTask 已挂账，幂等闸保证有人等它）。

这个顺序回答了 roadmap 预埋的危险点"回滚顺序错导致清理时读到已卸载服务"：回滚用同一个 beginDispose，逆序保证深层注册先拆；先置 disposed 再跑 disposer，保证 disposer 里读 fiber 状态时看到的是终态。

## 6. 与真 cordis 的差距清单（B3 后）

| 能力 | 真 cordis | mini-cordis | 补齐 |
|---|---|---|---|
| effect 收集 + 逆序清理 | ✅ fiber.effect + _disposables | ✅ | — |
| dispose 幂等 / 级联 / 回滚 | ✅ | ✅ | — |
| dispose 执行模型 | 链式串行 await | 逆序启动并发 | 有意差异（顺序敏感放同一 effect） |
| epoch/inertia/setupBarrier 重入机制 | ✅ | ❌ 单线程同步模型无此窗口 | 明确放弃 |
| effect 诊断树（label 嵌套元数据） | ✅ EffectMeta 树 | 仅 label 进日志 | 明确放弃 |
| 异步 apply / 卸载期 intermission 状态 | ✅ UNLOADING 等中间态 | ❌ disposed 一步到位 | 视需要（C 阶段异步 apply 一起看） |
| on/事件监听的 effect 化 | ✅ | ❌（B3 只立地基） | **B4** |

## 7. 实现与验证记录

**文件**：
- `cordis/fiber.ts`（修改：`Disposer`/`EffectExecute` 类型、`_effects` 收集表、`effect`/`collect`/`dispose`/`beginDispose`、refresh 的 catch 改回滚）
- `cordis/context.ts`（修改：`fiber?` 字段、`ctx.effect()` 转发、plugin() 的 child.fiber 指认 + 级联注册、provide 尾部自动收集）
- `cordis/registry.ts`（修改：新增 `untrackPending`）
- `cordis-tests/b3-effect.test.ts`（新增 10 条测试）

**验证**：
- `npm run cordis`：**32/32 绿**（B1 11 + B2 11 + B3 10；覆盖：立即执行+逆序、async disposer 等待、dispose 幂等（并发双调/二次调用）、三连抛错不阻断、三级级联全撤销、pending 子级联卸载后不复活、apply 回滚、provide 自动收集边界、setInterval 实时清理、effect 归属 fail-loud ×2）
- 全量 mock 回归：**22/22 绿**（业务代码零改动）

**翻车记档**（实现过程中真实发生）：
1. **execute 与 disposer 的异步性搞反**：级联注册初版写成 `effect(() => fiber.dispose())`——execute 返回了 Promise，TS2322 直接打回。effect 签名的两层结构（execute 同步登记 → disposer 可异步执行）是本章最容易写错的一处，正确写法 `effect(() => () => fiber.dispose())` 的"两层箭头"不是炫技，是类型的硬约束。
2. **disposer 的箭头简写返回值泄漏**：`() => order.push('x')`、`setInterval(() => ticks++)`——push/自增返回 number，而 `Disposer = () => void | Promise<void>`，tsc 一口气抓出 5 处。教训：void 返回类型的回调一律写块体，表达式体箭头函数会把"最后一个表达式的值"漏出去。
3. **删了一处死防御**：`collect()` 初版带 `if (state === 'disposed') return`——推演后确认 provide 的 state 守卫使该路径不可达，删除。防御代码掩盖"这条路径到不了"的事实，比没有防御更糟。

## 8. 自测四题（答案在文末）

1. `ctx.effect(() => fiber.dispose())` 为什么类型报错？`ctx.effect(() => () => fiber.dispose())` 的两层箭头各承担什么？
2. dispose 时某个 disposer 抛错，为什么吞错记日志而不是中断循环？如果两条清理真有先后依赖，正确写法是什么？
3. 级联卸载为什么复用 effect 机制而不是给 Fiber 加 children 数组？三级嵌套的清理顺序是谁保证的？
4. apply 抛错时，同步回滚为什么必须发生在错误上抛之前？异步 disposer 此时处于什么状态，谁负责等它？

> **答案**：
> 1. execute 的返回类型是 `Disposer | void`，`fiber.dispose()` 返回 Promise，不是函数——"等一会儿再登记撤销函数"会留卸载窗口漏洞，所以 execute 必须同步返回 disposer。两层箭头：外层是 execute（登记时同步执行，返回内层），内层是 disposer（dispose 时执行，允许返回 Promise，级联借此等待子清理结算）。
> 2. 清理路径上抛错若中断循环，剩下的资源全部泄漏，且 dispose 的 promise 永不正常结算——清理的完成度比单条失败更重要。真有依赖就放同一条 effect：`ctx.effect(() => { a(); return async () => { await cleanA(); cleanB() } })`，顺序在自己的闭包里，框架只管逆序启动。
> 3. children 数组要新增概念 + dispose 里加遍历段，而且孙级还得自己再实现一遍；effect 方案里"挂子插件"就是一种注册，逆序/幂等/并发/吞错全套免费继承。三级顺序由"逆序 + 级联也是 effect"联合保证：孙的 dispose 挂在子的列表里，子先于父拆，孙先于子拆。
> 4. 挂载点的调用者拿到错误时，"半截插件"必须已无痕迹，否则 catch 到错误的人还要猜哪些注册还活着——fail-loud 的前提是失败状态干净。同步 disposer 在 beginDispose 的调用栈里当场执行完才 throw；异步 disposer 的 promise 挂在 `disposeTask` 上，幂等闸保证任何后续 `dispose()` 等的都是同一个结算。

## 9. 下章预告（B4）

注册可以撤销了，但插件之间还没有"说话"的通道。B4 落**事件系统**：`cordis/events.ts` 提供 `ctx.on/emit/parallel/serial/bail/waterfall` 五种派发，`interface Events {}` 走 declaration merging 让用户声明事件表；`on` 的 disposer 走 B3 的 effect——**插件卸载自动摘监听器**，级联卸载顺带把整个插件树上的监听器一并清干净。参照 `vendor/cordis/src/events.ts` 的派发段与 waterfall 的 `next = () => cb(listeners.shift() ?? inner)` 闭包链。

## 10. 代码执行流程图

> 对应提交 `1f4f41c`。四条主线：effect 注册 → provide 自动收集 → dispose 结算 → 级联/回滚。

### 10.1 注册：`ctx.effect(execute)` 与 provide 自动收集

```
插件 apply 内：ctx.effect(() => { 启动 setInterval; return () => clearInterval(id) })
 │
 ├─ ctx.effect → this.fiber？
 │      ├─ 无（root context）→ throw "requires a plugin fiber"     fail-loud
 │      └─ 有 → fiber.effect(execute, label)
 │             ├─ state === 'disposed'？ ──是──→ throw "cannot create effect on disposed fiber"
 │             ├─ disposer = execute()          ★ 立即执行，注册动作当场生效
 │             └─ 返回值是函数？ → _effects.push({ run: disposer, label })
 │                                  （返回 void 的 effect 只执行、无撤销）
 │
 插件 apply 内：ctx.provide('todo', svc)   （B1 的 provide 多了收集一步）
 │
 ├─ 落共享表 + notifyProvided（同 B2 11.3）
 └─ this.fiber 存在且 state ∈ {loading, active}？
        └─ 是 → fiber.collect(disposer, 'provide("todo")')   ★ 不执行动作，只收集
               （fiber 外的手动 provide 维持 B1 语义：disposer 由调用者自理）
```

### 10.2 卸载：`fiber.dispose()` 结算

```
fiber.dispose()
 │
 ├─ disposeTask 已存在？ ──是──→ 返回同一个 promise     幂等闸（含清理进行中的并发调用）
 └─ 首次 → beginDispose()：
      ① state = 'disposed'            先置状态：清理期间读状态者看到"已卸载"
      ② untrackPending(this)          pending 中的 fiber 也立即出队（不会复活）
      ③ effects = _effects.splice(0).reverse()   ★ 逆序：后注册的先清理
      ④ effects.map(run) 并发启动：
           每个 run 包成 Promise：
             同步抛错 → onError 记 console.error，该任务照常 resolve
             异步拒绝 → 同上 catch
           （单个失败只记日志，不阻断其他清理）
      ⑤ return Promise.all(tasks)     全部结算后才 resolve → disposeTask
```

### 10.3 级联：子 fiber 的 dispose 挂在父 fiber 的 effect 上

```
父 apply 内：ctx.plugin(childDef)          （plugin() 的 B3 增量）
 │
 ├─ child = new Context(this)
 ├─ fiber = new Fiber(...)；child.fiber = fiber    ★ ctx.fiber 指认归属
 └─ parentFiber = this.fiber 存在？
      └─ 是 → parentFiber.effect(() => () => fiber.dispose(), `child <名>`)
             （外层箭头立即执行=无动作；返回值=子 dispose，进父的 _effects）
             root 上挂载的插件没有父 fiber → 不参与级联（root 不可卸载）

父.dispose() → 10.2 流程
  → 逆序栈（…先挂的子在后…）→ 子的 () => fiber.dispose() 被调用
  → 子走自己的 10.2：撤销子的 provide（共享表删键）、执行子的 effect
  → 孙随子，深度不限
  → 父的 Promise.all 等到子 disposeTask 结算才 resolve        ★ 异步清理被等待
```

### 10.4 apply 中途抛错：先回滚、再上抛

```
fiber.refresh()
 ├─ state = 'loading'
 ├─ apply(ctx, config)
 │      ├─ 第 1 个注册成功 → _effects = [d1]
 │      ├─ 第 2 个注册成功 → _effects = [d1, d2]
 │      └─ 第 3 个注册抛错！
 └─ catch：
      ├─ this.disposeTask = this.beginDispose()   ★ 复用 10.2：
      │     置 disposed → 出队 → 逆序 [d2, d1] 并发执行
      │     （同步 disposer 当场跑完 → 回滚顺序确定；异步的进 promise 等结算）
      └─ throw error    挂载点拿到错误时，清理已启动
```

### 10.5 完整时序走查：级联卸载测试（b3-effect 第 5 条）

```
准备：root.plugin(父) → 父 apply 内：
   ctx.effect(() => () => log.push('父cleanup'))        父._effects = [父cleanup]
   ctx.plugin(子) → 子.fiber 指认 + 父._effects 追加 [父cleanup, 子dispose闭包]
   子 apply 内：
   ctx.provide('svc', o)          → 共享表落键 + 子._effects 收集 [del("svc")]
   ctx.effect(() => () => log.push('子cleanup'))        子._effects = [del("svc"), 子cleanup]

parentFiber.dispose()
  父：state=disposed → 出队 → 逆序执行：
    ① 子dispose闭包 → 子.dispose()
         子：state=disposed → 出队 → 逆序执行：
              a. 子cleanup → log += '子cleanup'
              b. del("svc") → 共享表删 'svc'
         子 disposeTask resolve
    ② 父cleanup → log += '父cleanup'
  父 Promise.all([子task, 父cleanup]) 结算 → resolve

断言：log 顺序 ['子cleanup','父cleanup']（子先清完才轮到父的下一项）
      root.has('svc') = false；再 provide 同名不冲突（键已删，不会复活旧值）
```

对照第 6 条测试（pending 中的子被级联卸载）：子尚在 pendingFibers 里时父卸载 → beginDispose 的 ② untrackPending 出队 → 之后任何 provide 的唤醒循环都扫不到它——**死亡不可逆，没有复活路径**。
