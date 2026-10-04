# dsh-B6 配置组装 loader（B 阶段收官）

> 本章产物：`cordis/loader.ts`（Row 行模型 + `loadRows` + `dumpTree`）、`cordis.config.ts`（第一版插件清单，用户侧产物）。
> 一句话：**"这个 app 装哪些插件"从代码里搬进行清单——id 管身份，name 管实现，激活仍走 B2 的依赖驱动老路。**
> 参照物：dsh 的 loader 行模型（`Row = { id, name, config, disabled }`）与分层 patch；真框架的动态 import、包清单校验、字段级 config 合并，mini 标注"略"。

---

## 1. 两个身份：id 是配置身份，name 是实现入口

Row 的四个字段里，`id` 和 `name` 的区分是本章的危险点，也是理解 dsh 配置系统的钥匙：

- **id——配置空间的名字**。分层叠加的去重键：base 层 `{ id: 'greeter', ... }` 被 cli 层 `{ id: 'greeter', disabled: true }` **整行替换**——patch 行连 name 都不用带，"注释掉一个插件"就是把它的行替换成 disabled。
- **name——实现空间的名字**。`resolve(name)` 查插件表找到实现；同 name 不同 id 合法（同一种插件装两份配置）。
- 两者在运行时相遇：同 name 的两行各自挂载，若实现都往**共享服务表** provide 同名服务，第二个触发 B2 的冲突抛错——配置层允许的组合，运行时用 fail-loud 拒绝。配置身份 ≠ 运行时身份，交界处由服务表的冲突语义把守（测试固化了这条）。

**整行替换 vs 字段合并**：roadmap 指定 mini 用整行替换（简版）。真 cordis 是**字段级 patch 合并**（config 经 schemastery 逐字段 deep-patch，`{ id: 'greeter', config: { title: 'x' } }` 只改 title 保留其余）。mini 选替换的代价：patch 想保留 base 配置就必须整行重抄；好处：语义一目了然、没有"哪些字段被继承了"的暗坑。测试专门固化了"patch 行省略 config 时**不会**继承 base 的 config"——防止未来有人无意识把它改成合并。

## 2. loader 只管"哪些行"，不碰"怎么活"

`loadRows` 的流水线短得可疑：

```
rows（调用方铺平 [...base, ...app, ...cliPatch]）
  → 同 id 后写胜（Map.set 覆盖 = 整行替换）
  → disabled 过滤（行根本不进挂载）
  → resolve(name) → Plugin（未知名 fail-loud）
  → ctx.plugin(plugin, config)   ← 激活逻辑全在这里面（B2 既有）
```

关键认知：**loader 没有任何激活逻辑**。依赖等待、provide 通知、fail-loud、级联卸载——全是 B2~B5 既有机制的复用。分层叠加也只是"调用方把数组铺平"（`[...base, ...app, ...cliPatch]`），loader 内部连"层"的概念都没有。组合断言三（书写顺序打乱）零成本通过：greeter 行排在 core 前面 → 扣 pending → core 落表触发通知 → 激活。**框架的前几章投资在这里兑现**——roadmap 把这章叫"B 阶段收官"的原因。

## 3. dumpTree：持引用，不持快照

行记录存的是 `fiber` 引用而非状态快照，dump 时读 `fiber.state`/`fiber.inject`——所以同一份记录能显示"加载时 pending、此刻 active"的实时状态（测试里两条 dump 断言分别取了 pending 和 active 两种时刻）。记录挂在**树根**上（WeakMap + rootOf），树内任意 ctx 调 dumpTree 看到同一份清单。输出格式：

```
<mini-cordis>
├─ [core] core → active
└─ [greeter] greeter → active (inject: config)
```

`--dump-config` 式诊断的最小形态。mini 的清单是平铺的（├─└─ 一层）；真框架输出按 fiber 树嵌套缩进（子插件在父行下缩进），mini 裁掉——需要 fiber 的父子链，收益仅 diagnostics 美观。

## 4. 真框架对照【略】与差距清单

| 能力 | 真框架 | mini | 备注 |
|---|---|---|---|
| 行模型 + disabled | ✅ | ✅ | — |
| 分层 patch | 字段级 config deep-patch | 同 id 整行替换 | 有意简版（第 1 节） |
| name→实现解析 | 动态 import + 包清单校验 | 静态映射表 | 标注"略" |
| config schema 校验 | schemastery | unknown 透传 | B2 已定，明确放弃 |
| dump 按树嵌套 | ✅ | 平铺 | 明确放弃 |
| 热更新（patch 触发已挂载行 reload） | ✅ loader.create/update | ❌ | C 阶段之后视需要 |

## 5. 实现与验证记录

**文件**：
- `cordis/loader.ts`（新增：Row/loadRows/dumpTree）
- `cordis.config.ts`（新增：core/greeter/clock 玩具插件 + 插件表 + baseRows）
- `cordis-tests/b6-loader.test.ts`（新增 8 条测试）

**验证**：
- `npm run cordis`：**59/59 绿**（B1 11 + B2 11 + B3 10 + B4 10 + B5 9 + B6 8；四条组合断言全过：disabled→能力消失、加行→能力出现、乱序→依赖驱动、dump 精确匹配）
- 全量 mock 回归：**22/22 绿**（业务代码零改动）

**翻车记档**（实现过程中真实发生）：
1. **联合类型吃掉上下文类型**：`const core: Plugin = { apply(ctx, rawConfig) {...} }` 报 TS7006 隐式 any——`Plugin` 是对象/函数/类三形态联合，联合类型的字面量方法参数拿不到上下文类型。B2 测试里其实早绕过一次（显式标 `apply: (_ctx: Context, ...) => {}`），这次在"生产"配置文件里又踩了一遍。教训固化：**联合类型字面量的方法参数一律显式标注**。
2. **凭空发明的导入路径**：loader.ts 头一行写了 `from './cordis-types.js'`——一个不存在的类型桶模块，手比脑快。tsc 当场打回，改回 context.js/fiber.js。模块越写越多之后，"我以为有个桶"是真实的惯性风险。
3. **测试标题跑在断言前面**：一条测试标题写"报出实现名与配置 id"，但 resolve 签名只收 name（loader 调 resolve 时没把 id 传进去），断言只能验证实现名。改标题向行为对齐，而不是给 resolve 加参数——加参数属于"为了一句报错扩接口"，不值。

## 6. 自测四题（答案在文末）

1. patch 行 `{ id: 'greeter', name: 'greeter', disabled: true }` 和 `{ id: 'greeter', disabled: true }` 效果一样吗？整行替换语义下后者缺 name 会出问题吗？
2. 同 name 不同 id 的两行为什么会在运行时打架？"配置层允许、运行时拒绝"说明两个身份空间的边界在哪？
3. dumpTree 若在加载时快照 state，哪种真实场景会给出过时信息？
4. 真框架的字段级 config 合并比整行替换多解决什么问题？mini 的替换语义牺牲了什么？

> **答案**：
> 1. 一样。disabled 过滤发生在 resolve 之前——行根本不会走到需要 name 的那步。整行替换下缺 name 完全合法：patch 行的职责只是"顶掉 base 的同 id 行"，补 name 反而画蛇添足。
> 2. 两行各自挂载，实现都在共享服务表 provide 同名服务 → 第二个触发 B2 冲突抛错。边界：配置空间管"装几份"（id 去重），运行时空间管"服务表只有一份"（同名冲突）——想真装两份同实现，用 B5 的 scope 分层给每份各自的领域注册表视图，或者 isolate 槽位（原理已记档）。
> 3. 依赖等待场景：行挂载时依赖未齐是 pending，另一行的 provide 落表后转 active。快照永远停在 pending，dump 会把已激活的行显示成没激活——诊断输出最忌讳"看起来对不对取决于你什么时候看"。
> 4. 字段合并让 patch 只写差异（改一个 title 不必重抄整行 config），多份 patch 叠加时各自贡献自己的字段——这对"产品默认配置 + 用户覆盖 + 命令行微调"的长配置链是刚需。mini 的整行替换牺牲了增量表达能力：patch 层必须自带完整 config，层数越多重复越多。C 阶段配置变长后如果痛感明显，值得回头补一个几十行的 deep-merge。

## 7. B 阶段总结：六章铸了一条什么链

| 章 | 产物 | 在链上的位置 |
|---|---|---|
| B1 | Context + Proxy 服务查找 | "我需要什么"与"谁提供它"解耦 |
| B2 | Fiber 状态机 + 依赖等待 | 插件有生死，依赖晚到不出错 |
| B3 | effect 模型 | 注册即可撤销，HMR/作用域的地基 |
| B4 | 事件系统 | 插件间"推"的通道，监听器随 fiber 走 |
| B5 | scope + 分层注册表 | 同名多实例/多视图，per-agent 的地基 |
| B6 | loader | 装什么由配置决定——**换 provider 即换产品** |

C 阶段从下一章起动真业务代码：agent.ts 的 12 个工具从 import 耦合迁到 `ToolsService` 注册表（C1），之后 session-log / llm / approval / session 等 C2~C8 逐章插件化。**从 C1 起每章开工先跑 `node run-mock.mjs` 记录基线，收工再跑对齐**（roadmap 阶段 C 纪律）。

## 8. 下章预告（C1 工具注册表）

`services/tools.ts` 的 ToolsService（`register(def) → disposer`、`get(name)`），12 个工具的 execute 逻辑从 tools.ts 迁出，agent.ts 的 `executeToolCall` switch 改查注册表——第一个"业务代码长在 B 阶段地基上"的样板：ToolDefinition 挂 permissionHint/deferred，register 的 disposer 走 B3 effect（卸载自动摘工具），mcp__ 动态名的占位逻辑保持不变。
