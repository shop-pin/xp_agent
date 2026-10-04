# dsh-B5 子上下文与作用域（scope）

> 本章产物：`cordis/scope.ts`（ScopeKey + parent 链 + `createScope` + `ScopeLayers` 分层注册表）、`context.ts` 的 `parent` getter。
> 一句话：**scope = 一个匿名 fiber + 一个打标签的子上下文；"同名不同实现"的隔离不发生在服务表，发生在分层注册表（nearest scope wins）。**
> 参照物：`deepseek-harness-master/packages/core/scope/src/index.ts`（createScope/bindScopeParent/scopeTarget）与 `store.ts`（ScopedLayers 的 merge + effect 归属）。

---

## 1. 本章最重要的认知修正：隔离有两套机制，各管一类

读真源码前，我 B2/B3 的文档一直说"dsh 给一个 session 不同能力集靠 preset + isolate realm"。**对了一半**。读 `packages/core/scope` 后确认，dsh 的隔离分两层，根本不是同一套机制：

| 要隔离什么 | 用什么 | 层 |
|---|---|---|
| 服务行的多实例（两个 session 各一个 `ctx.shell` 实例） | cordis 的 `isolate` realm + `cordis:group` row（group 把 provider 和它的 consumers 圈进同一 realm） | 框架层（服务表） |
| 注册表的多视图（每个 agent 一套自己的工具表） | **scope-key 分层**（`ScopedLayers`：global 层 + 每 key 一层，merge 时 nearest wins） | 领域层（注册表） |

`architecture.md:147` 那句 "a service row there needs an `isolate` realm" 说的是第一类。而 per-agent 工具表——B 阶段真正要支撑的东西——走的是第二类：**注册表是领域结构，不是服务表**，它的"子遮蔽父"发生在 merge 顺序里，与 B2 确立的"服务表同名冲突抛错"互不干扰。

于是 B1 → B2 → B5 形成了一次完整的认知螺旋：B1 直觉"子层遮蔽父层"在 B2 被推翻（服务表是共享的）——B5 发现这个直觉**没有全错，只是放错了层**：遮蔽真实存在，但住在分层注册表里。roadmap B5 的危险点"作用域查找顺序（子遮蔽父）与 Proxy 原型链要对齐"真正的含义是：**别把服务表的父链 fallback 和注册表的层覆盖搞混**——前者永远取同一个共享实例，后者按 scope 视图逐层覆盖。

## 2. dsh 真 scope 解读：本体薄得惊人

`createScope`（index.ts:137）拆开只有三步：

```ts
const fiber = ctx.plugin(scope)                 // scope = function(){} 匿名空插件
const scoped: Context = fiber.ctx.extend({ [kScope]: key })   // 子 ctx 打上 scope 标签
return { ctx: scoped, rawDispose: fiber.dispose, dispose: () => (disposing ??= quiesceFiber(fiber)) }
```

三个设计点：

1. **scope 的壳 = 匿名 fiber**。没有任何新机制——注册即撤销（B3）、事件归属（B4）全部免费复用：经 `scoped` ctx 做的每次注册自动落到这个 fiber 的 effect 列表，`dispose()` 一次回滚。dsh 的 `quiesceFiber` 多等一个 `fiber.inertia`（异步卸载进行中的 promise），mini 的 dispose 幂等闸（disposeTask）语义已覆盖。
2. **标签沿上下文继承**。dsh 的 `extend` 让 `scopeOf(child)` 沿 ctx 原型链读到 `[kScope]`——scope 里挂的子插件天然属于这个 scope。mini 的 WeakMap 没有继承，`scopeOf` 改为沿 `Context.parent` 链向上找标签（顺带给 Context 补了 `parent` getter——B5 主题就是子上下文，父链可读本来就该是公开 API）。
3. **parent 链在 key 世界里单独存在**。`scopeParents: WeakMap<ScopeKey, ScopeKey>` + `bindScopeParent`（一次性绑定 + 环检测）。它同时驱动两个方向：注册视图沿链**向下**继承（chainLayers），事件收容沿链**向上**扩展（scopeTarget 的 filter：祖先 scope 的监听器收得到子孙 scope 的事件，反之不行——"事件向上流，永不向下流"，这正是"一个常驻组合能观察它旗下每个 agent"的实现）。mini 实现了链与环检测；scopeTarget 载体依赖 B4 裁掉的 filter 机制，标注"略"。

## 3. ScopeLayers：分层注册表，遮蔽的正确位置

`store.ts` 的 `ScopedLayers` 是本章的语义核心，mini 版照抄结构：

- **写**（`register(ctx, name, value)`）：`scopeOf(ctx)` 决定落哪层——无标签进 global，有标签进自己的层（层不存在则建）。**同层同名冲突抛错，跨层同名不冲突**——后者就是"两个 scope 各注册同名不同实现"的位置。undo（删条目 + 空层回收）挂 `ctx.effect`，条目生命周期自动跟随 scope fiber。
- **读**（`resolve(scope)`）：global 铺底，然后沿 `scopeChainOf(scope)` **从最远祖先到本 scope** 依次覆盖。顺序就是语义：先到的让位后到的，nearest scope wins。root 视图（scope=undefined）只有 global。**读永远不建层**（dsh 的话："Reads never create scoped layers"）——查询是纯函数，不产生副作用。
- **effect 归属**（dsh 的 `effect(ctx, action)` 方法）：层的建与删、undo、空层回收全部包成一条 `ctx.effect`——scope 卸载时逆序执行，层自动回收，不留空壳。

对照 roadmap step 3 的测试就位：玩具 registry + 两个 scope 各注册同名 `'shell'` → 各自 resolve 只见自己的，root 视图都看不见；scope 遮蔽 global（scope 视图 scope 版胜，root 视图仍 global 版）；嵌套 scope 的链式 nearest wins（child > parent > global）——三条断言全部落在 ScopeLayers 上，服务表全程只有一个共享表。

## 4. isolate/intercept：只讲原理【略】

mini 不实现，这里把真框架的行为记档：

- **provide 的分槽**（vendor `reflect.ts`）：`this.ctx.root[isolate][name] ??= Symbol(name)`——根部为每个服务名登记默认槽位 key；provide 实际写入 `store[key]`。子树若声明了自己的 isolate map（`ctx[isolate][name] = 新 Symbol`），它范围内的同名服务就解析到**另一个槽位**——同名、不同实例、互不冲突。服务表的"多实例"从不靠多张表，靠同名多槽。
- **group row**（dsh app-boot）：配置行层面的封装，把一个 provider 和它的 consumers 圈进同一个 isolate realm——否则 provider 换了槽位，consumer 还在读默认槽，注入直接断裂。
- **不实现的理由**：需要把 get 陷阱/provide/查找全部从"名字寻址"改成"槽位 key 寻址"，改动面覆盖 B1~B4 全部路径；而 C 阶段（mini 单树单会话）用不到服务行多实例。投入产出不成立，原理记档即可。

## 5. 与真 cordis / dsh 的差距清单（B5 后）

| 能力 | 真 cordis / dsh | mini-cordis | 补齐 |
|---|---|---|---|
| scope 壳（匿名 fiber + 标签 ctx） | ✅ createScope | ✅ | — |
| scope 链 + 环检测 | ✅ bindScopeParent | ✅（rebind 裁剪） | — |
| 分层注册表（nearest wins） | ✅ ScopedLayers | ✅ ScopeLayers | — |
| 注册视图向下继承（标签沿 ctx 传） | ✅ extend 属性继承 | ✅ scopeOf 沿 parent 链 | — |
| 事件收容向上扩展（scopeTarget 载体） | ✅ filter | ❌ 依赖 filter 机制 | 标注"略" |
| rebind（blank-session recompose） | ✅ ScopeParentBinding | ❌ | 明确放弃 |
| isolate 槽位 / group row | ✅ | ❌ | **只讲原理** |
| quiesce（inertia 等待） | ✅ | ❌（disposeTask 语义覆盖） | 明确放弃 |

## 6. 实现与验证记录

**文件**：
- `cordis/scope.ts`（新增：ScopeKey/bindScopeParent/scopeChainOf/scopeOf/createScope/ScopeLayers）
- `cordis/context.ts`（修改：新增 `parent` getter）
- `cordis-tests/b5-scope.test.ts`（新增 9 条测试）

**验证**：
- `npm run cordis`：**51/51 绿**（B1 11 + B2 11 + B3 10 + B4 10 + B5 9；覆盖：形态与父链继承、全回滚含事件监听器、不影响父、双 scope 同名互不可见、scope 遮蔽 global、嵌套 nearest wins、同层冲突分层报错、服务表语义不放宽、dispose 幂等）
- 全量 mock 回归：**22/22 绿**（业务代码零改动）

**翻车记档**（实现过程中真实发生）：
1. **root 没有 fiber**（本章最有价值的坑）：`ScopeLayers.register` 无条件挂 `ctx.effect`，测试在 root ctx 上注册 global 条目直接炸 `requires a plugin fiber`。dsh 没这个问题——**它的 root 有 root fiber，mini 没有**（B3 的归属规则在 root 上的空缺第一次反噬依赖方）。修正后语义三分：global 层 + 无 fiber → 直写（生存语义等同真 cordis 的 global 挂在永不卸载的 root fiber）；有 fiber → effect 归属；**有 scope 标签却无 fiber → fail-loud 拒绝**（否则条目会在 dispose 时静默泄漏）。"归属缺失"的三种态度（放行/直写/拒收）在同一函数里各就各位。
2. **`ScopeKey = object` 不收 symbol**：测试用 `Symbol('a')` 当 key 被全量打回——symbol 是原始值不是 object（es2022 类型库的 WeakMap 键也不含 symbol）。改用对象 key 后反而更贴 dsh 实际用法（session/agent 实例本身当 key，Symbol 只是测试里的偷懒）。
3. **ESM 里手写 require**：测试辅助函数里下意识写了 `require('../cordis/scope.js')`——ESM 模块里没有 require，tsc 当场报错，改回顶部静态 import。CJS 肌肉记忆的残留。另有一条**设计期**拦下的隐患（没来得及变成翻车）：WeakMap 标签天生没有继承语义（dsh 靠 extend 原型继承），scopeOf 若只查当前 ctx，scope 内子插件的注册会漏进 global 层——对照 dsh 语义时发现，写 scopeOf 时就用 parent 链补齐（第 2 节设计点 2）。

## 7. 自测四题（答案在文末）

1. "两个 agent 各一套自己的工具表"为什么不通过 `ctx.provide` 实现？隔离发生在哪个结构、靠什么保证互不可见？
2. `resolve` 的覆盖顺序为什么必须"从最远祖先到最近"？反过来写会得到什么？
3. scope 内挂一个子插件，它的注册却落到了 global 层——是哪条机制没生效？mini 与 dsh 各靠什么实现这条机制？
4. bindScopeParent 为什么既要"一次性"又要环检测？各防的是什么？

> **答案**：
> 1. 服务表整树共享、同名冲突抛错（B2 语义）——provide 表达的是"全局唯一的依赖"，不是"本 agent 的能力"。隔离发生在 ScopeLayers：global 层 + 每 scope key 一层，resolve 按 scope 视图 merge（nearest wins），各视图从各自的层取值，所以同名不同实现互不可见。
> 2. merge 是"后写覆盖先写"：global 铺底后按远→近依次覆盖，最近的 scope 最后写入所以胜出。反过来（近→远）会导致最远的祖先覆盖一切，"局部配置覆盖全局配置"的语义整个颠倒。
> 3. 标签继承没生效（子插件的 ctx 读不到 scope 标签，scopeOf 返回 undefined → 落 global）。dsh 靠 `extend` 的原型属性继承（child 沿原型链读到 `[kScope]`）；mini 靠 scopeOf 沿 `Context.parent` 链逐层找 WeakMap 标签，用 bag 链模拟属性继承。
> 4. "一次性"防的是身份被偷换：scope 的祖先关系是注册可见性的根基，谁都能改写它，就能把任意 scope 的条目挪进自己的视图——所以 rebind 权柄只给原始 binder（dsh 的 ScopeParentBinding）。环检测防的是遍历死亡：chainLayers、scopeChainOf、事件收容判定全都要沿链走到根，闭环让它们全部死循环。

## 8. 下章预告（B6，B 阶段收官）

框架件齐了（容器/fiber/effect/事件/scope），但"这个 app 装哪些插件"还写死在代码里。B6 落**配置组装 loader**：行模型（id/name/config/disabled）、分层叠加（base + app + cliPatch，同 id 后写胜 = 整行替换）、name→Plugin 静态解析表、`dumpTree` 树状输出；总验收是一道玩具 harness——**配置里注释掉某插件 → 能力消失；加一行 → 能力出现；书写顺序打乱 → 依赖驱动照常激活**。这正是 dsh "换 provider 即换产品"的最后一环。
