# S9：盯盘编排（P3 总验收——一个会话跑完一个交易日）

> stock 课程第九章。总纲见 `stock-00-plan.md` §四（P3 阶段收官）。
> 交付：`plugins/market-watch.ts`（tick 状态机 + 三 wake 源 + /watch 命令）+ `skills/review/`（收盘复盘 product 技能）+ memory 写口（`save_memory` 工具，config 门控）+ PaperBroker `get_trades`/当日盈亏行 + market-data `clock()` 公共读口 + baseRows 占位行 + stock/web-stock 四形态接线 + 10 条单测 + mock 场景 41（三 turn 全 wake 驱动，零用户输入）。
> 验收线：**全链路走查 + 复盘报告产出** ✅ / cordis 252/252 / mock 36 场景 / snapshot 36/36 ×2。

---

## 1. 本章要解决的问题

S1–S8 攒下的能力是**应答式**的：用户问一句，链路跑一截。但盯盘的产品形态是反过来——**没人说话，系统自己知道什么时候该干活**：开盘看一眼、有异动裁一下、收盘盘一顿。

这就是编排层（orchestration）：它不新增任何领域能力，只回答一个问题——**什么时候、用什么提示词、把 LLM turn 叫醒**。S1 轮询是数据面的自动化，S9 是 turn 面的自动化；至此 P3 的"信号 → 裁决 → 模拟盘 → 风控 → 编排"五环闭合，一个会话能跑完一个完整交易日。

## 2. 设计讲解

### 2.1 数据面/模型面分离的 turn 侧推论：LLM 只在有内容时醒

总纲 §一第一条在 S1 的形态是"模型不看全市场"，在 S9 的形态是"模型不在没事件时醒"。三个 wake 源，每个都是一次有内容的 turn：

| wake 源 | 触发 | 提示词要点 | 节流 |
|---|---|---|---|
| ① 开盘巡检 | 进入 open 后第一个 tick | /brief → get_signals → 有信号则 /adjudicate → 今日盯盘计划 | 每日一次（patrolled 标记） |
| ② 盘中信号 | `market/signal` 事件 | /adjudicate <code>；verdict 为 buy-candidate 才小仓位 place_order | 冷却 3 分钟 + 熔断静默 |
| ③ 收盘复盘 | 当日巡检过且转入 closed | /review 五段复盘 | 每日一次（reviewed 标记） |

②的边界最讲究：信号引擎一轮快照能广播几十条（S5 真机冒烟单轮 102 条），每条都叫醒一个 turn 就是拿 LLM 当行情流刷——冷却窗把它们折叠成"至多每 3 分钟看一眼"；**halt 熔断时静默**更是语义正确而非省话费：熔断的意思就是"别再产生新决策"，叫醒裁决只会产出无法执行的 verdict。

### 2.2 状态机：观察迁移，不描墙钟

开盘/收盘的判定有两种写法：

- **算时刻**："9:30 到点巡检、15:00 到点复盘"——把墙钟时刻写死进逻辑；
- **观察迁移**：每个 tick 读 `marketPhase(market.clock())`，看到 open 且未巡检 → 巡检；看到 closed 且已巡检未复盘 → 复盘。

观察迁移赢在三个场景：①注入钟（测试/回放）任意快进，状态机自动跟上；②时钟跳变/系统休眠恢复，不会因为"错过了 9:30"永远不巡检；③日键 `cnDay()` 跨日重置标记——**一个长驻会话连盯多日**，周一巡检过、周二再巡检是状态机自己的事，不用重启。

跨日重置还有个细节：`reviewed` 只在跨日时清——如果周一到收盘都没武装过（没巡检），周一就不复盘（`patrolled && !reviewed` 的与门）——**没盯过的盘没有复盘资格**，复盘是对当日观察与动作的对账，不是对账本的泛泛总结。

### 2.3 时钟源纪律：watch 不带钟

watch 的每个时间判定（phase、日键、信号时间戳）全部走 `market.clock()`（S9 给 market-data 补的公共读口）。这条纪律的回报在场景 41 里直接兑现：**mock 换掉 market 的钟，watch、broker、guard 三者自动同钟**——"一把推到 15:30 收盘"一个赋值搞定。如果 watch 自带 `Date.now()`，同一个会话里两个钟各走各的，时序测试只能真等或各处打补丁。

### 2.4 /watch：显式武装，不是挂载即盯盘

stock profile 装配即含 watch 行，但**盯盘必须用户 `/watch` 显式启动**。理由：profile 是能力清单不是行为开关——同一个 stock 会话可能只是"帮我查一下浦发银行现价"，挂载就自动盯盘等于能力越权（一次性问价的会话不该被唤醒）。这与 S3"新闻不做时段 gating"是同一族判断：**装配决定"能做什么"，显式命令决定"开始做什么"**。

启停都注记 `meta/note(key:"watch")` 进 SessionLog（日志即真相：复盘时能查到"今天 9:31 武装、14:55 手动停止"）。

### 2.5 /review：复盘五段与 memory 落点

复盘的技能契约只有一条主线：**事实先于评价**——数字全部来自工具输出，不凭记忆报数。五段：账户体检（当日已实现盈亏是主数字）→ 成交回顾（对着 reason 字段回看当时理由）→ 信号对照（空仓错过的好信号、持仓躲过的坏信号都算产出）→ memory 更新 → 明日计划（≤3 条可执行）。

memory 更新是 S9 之前 LLM 面一直缺的半边：S1–S8 只有读（prefetch 注入），没有写。S9 补 `save_memory` 工具：

- **config 门控**（`writeTool: true`）：base/默认装配不见此工具——快照零扰动是门控的直接动机，但更深一层是**写口是盯盘工作流的需求，不是通用能力**：普通会话里模型自作主张写记忆，污染面大于收益面；
- **索引纪律不变**：工具内部走 `saveMemory()`（frontmatter + MEMORY.md 索引行一体维护）——模型永远不手改 MEMORY.md，这条从 dsh 复刻第一天起就没松过；
- **同名覆盖语义**（type+name 为键）：/review 每天写"模拟盘持仓 YYYY-MM-DD"？不——快照名固定（如"模拟盘持仓"），次日覆盖，**不留过期持仓记忆**；带日期的快照只在测试里用。这一条是 SKILL.md 里的明文契约（"覆盖更新旧的持仓快照"）。

配套的账本视图：`get_trades(day)` 直接扫账本 JSONL 按北京日过滤——**复盘视图与重放对账同一份数据**，`get_portfolio` 头部补"当日已实现"行（S8 的 `todayPnl()` 第一次进用户可见面）。

### 2.6 接线：memory 行整行替换与 wake 桥

- stock/web-stock 四形态里 memory 行都是**整行替换**（同 S2 skills 行纪律）：必须带上 app 层的 `bridge`/`enabled`，否则把宿主的注入桥丢了；
- watch 行的 `wake: host.wake` 从 profile 工厂拿宿主桥（C5 loop 同款 inbox next-turn 机制）——CLI 与 web 宿主各自的唤醒通路在工厂里分岔，插件无感；
- watch 在 baseRows 是 disabled 占位行（不参与瀑布，行位无约束——S8 行位学它的"只 inject commands"惯例，market/guard/schedule 惰性取）。

### 2.7 S6 挂账清算：fork 缺口未消费

S6 记档"fork 对插件工具白名单是断的（toolDefinitions 静态集），S9 再议"。本章结论：**三个 turn 全部不需要 fork**——adjudicate/review 都是 inline 技能，get_portfolio/get_trades/save_memory 都是主装配工具。缺口没被消费也就没修，继续挂账（S10 若实盘引入独立风控审计 turn 再议）。

## 3. 实现走查

| 文件 | 内容 |
|---|---|
| `my_src/plugins/market-watch.ts` | WatchService（armed/day/patrolled/reviewed 状态 + evaluate 状态机 + onSignal 节流 + fire 注记/唤醒）+ /watch 命令 + effect 收尾 stop |
| `my_src/skills/review/SKILL.md` | product 技能：五段复盘契约 + allowed-tools 五只读/写口 + 固定收尾条款 |
| `my_src/plugins/memory.ts` | save_memory 工具（writeTool 门控；inject 收回 ["llm"]，tools 支路 require 惰性取——见翻车 #1） |
| `my_src/plugins/paper-broker.ts` | get_trades（账本按日过滤 + 费用/盈亏合计）+ get_portfolio 当日已实现行 |
| `my_src/plugins/market-data.ts` | `clock()` 公共读口（注入钟单一来源） |
| `my_src/cordis.config.ts` | watch 占位行 + stock/web-stock 四形态（memory 整行替换带 writeTool + wake 桥） |
| `my_src/cordis-tests/s9-watch.test.ts` | 10 测试：状态机四（巡检/复盘+周末/跨日/停止）+ 信号三（冷却/静默/未武装）+ tick 链 + save_memory + get_trades 手算 |
| `my_src/run-mock.mjs` | 场景 41 + watchProbe（两态行情源 + 可变钟 + MINI_WATCH_TICK_MS 加速 + finally 显式 stop） |

## 4. 翻车记档

1. **inject 升级炸最小树（cordis 首跑抓获）**：给 memoryPlugin 的 inject 加 "tools"（为 save_memory 注册），d4 的两个用例没挂 ToolsService——fiber 的 inject 是硬等待（依赖不齐永久 pending），插件**根本没激活**：第二用例假阴（injected 0≠1），第三用例更险——**空过**（断言"零调用零注入"，插件死了也绿）。修法：inject 收回 ["llm"]，writeTool 支路 `require("tools")` 惰性取（不开写口的最小树不被迫挂服务，开了而缺服务 apply 抛错回滚 fail-loud）。教训：**改依赖声明要扫最小树消费者；负向断言（"什么都不发生"）的用例必须先锚"被测物活着"**。
2. **场景 41 假阳/假阴对（verify 首跑抓获）**：mock 的 `firstUserText` 是请求里**第一条** user 消息——多轮会话里永远是巡检首条。reqs[2]（信号 turn）因此必然假阴；reqs[4]（复盘 turn）却**假阳串门**——技能目录里有 `**/review**: 收盘复盘` 字样，firstUserText 检查"收盘"/"/review"碰巧全中（S4 泛锚教训复发）。修法：唤醒文本锚 `lastUserText`（本轮新 user 消息）。教训：**一个检查"碰巧过"要查它为什么过；锚"本轮输入"前先读 mock 记录函数的语义**。
3. **watch tick 链挂死进程（场景 41 首跑不退出）**：verify 全部打印完但进程挂着——ScheduleService 的 `after` 是裸 setTimeout（不 unref；对照 market-data 的轮询定时器 unref 了，所以 S7/S8 探针能退），探针手动 `watch.start()` 却只关 agent 不停 watch。修法：探针 finally 显式 `watch.stop()`。教训：**谁手动 start 谁 stop；挂在 schedule 上的键控定时器是事件循环的活句柄**。
4. **快照波及面**：加 /review 技能（目录）+ save_memory/get_trades（tools 数组）→ stock 装配的请求体全变 → 34/36/38/39/40 五章重录（与 S4/S6 的"目录演进重录"同型，product 技能层是共享面的第三次兑现）。ch41 首放即绿。
5. **snapshot runner record 模式尾行误报（记档不修）**：runner 的绿判定找 "✓ snapshot" 尾行，录制模式打的是 "⚑ snapshot recorded"——record 汇总恒显 ✗，文件实际落盘正常。改 runner 判定属工具修缮，遇下次批量重录再并。
6. **web 黑屏 = F3 时代旧雷（手测清单第 4 项踩响，独立修复）**：用户跑 `--profile web-stock --web` 全黑。诊断链：curl 静态面 200（排除服务端）→ 无头 Chrome 复现 `#root` 空 → 控制台抓 `TypeError: Cannot read properties of undefined (reading 'listeners')` → 定位 renderer.tsx 把**脱绑方法** `store.subscribe` 直传 `useSyncExternalStore`——React 裸调 `subscribe(fn)` 不绑接收者，ES module 严格模式 `this=undefined`，首帧抛错整树卸载，只剩暗色背景。修法：`useCallback` 包一层箭头再传。教训：**方法当回调传必问"this 谁绑"；这类雷 tsc 不报、只在首帧炸，浏览器手测要进验收线**（此前手测显然没复跑过 10-18 构建）。另带出观察：host 只实现 GET，HEAD 请求落 API 404（非本次成因，挂账）。webui 修复独立 commit。

## 5. 验证记录（终态）

| 线 | 结果 |
|---|---|
| cordis | **252/252**（242 + 本章 10；含 d4 回归修复复跑） |
| mock | 36 场景全绿（35 + 场景 41：8 项检查） |
| snapshot | **36/36 × 2 轮**（ch41 新录：6 请求 + 1 会话文件；34/36/38/39/40 重录） |
| vite build | 未动（无 webui 改动，沿用 S7 的 246.74 KB） |

## 6. 代码执行流程图

### 6.1 tick 状态机（evaluate——观察迁移，不描墙钟）

```
/watch ──► start(): armed=true + 立即 evaluate + 排 tick 链（30s，env 旋钮加速）
           │
每个 tick: evaluate()
  ├─ cnDay(clock) 跨日？──► day=今日, patrolled=false, reviewed=false   ← 连盯多日
  ├─ phase=open 且 !patrolled ──► patrolled=true, fire(开盘巡检)
  ├─ phase=closed 且 patrolled 且 !reviewed ──► reviewed=true, fire(收盘复盘)
  └─ 其他（lunch/weekend/已办）──► 静默
           │
/watch off ──► stop(): armed=false + cancel("watch-tick")   ← 唤醒中的 turn 照常跑完
```

### 6.2 信号唤醒的门（onSignal）

```
market/signal 事件
  ├─ !armed ──────────────✗ 静默（没 /watch 就不盯）
  ├─ phase ≠ open ────────✗ 静默（休市时刻的迟到信号）
  ├─ guard.isHalted() ────✗ 静默（熔断=不再产生新决策）
  ├─ 距上次信号唤醒 < 3min ─✗ 静默（turn 经济性：信号流折叠）
  └─ 通过 ──► fire("[盯盘 盘中信号 HH:MM] code name：note…→ /adjudicate")
```

### 6.3 完整时序走查（mock 场景 41——三 turn 全 wake 驱动）

```
Agent({profile:"stock", extraRows:[news 禁用, market 两态源+可变钟, broker/guard 同钟]})
首轮快照落定（平静：sh600000 @10）
watch.start() ──────────────① 巡检 turn（2 请求）
  wake[开盘巡检] → req1: get_signals（信号 0 条）→ req2: "今日盯盘计划…"
market.refresh() ───────────② spike @10.35（+3.5%）
  snapshot 事件 → 信号引擎 → market/signal(rapid-move) → onSignal 过三门
  → wake[盘中信号] → req3: skill adjudicate → req4: verdict JSON（watch 0.4）
t = 15:30 CST（钟一拨）────③ tick 观察到 closed
  → wake[收盘] → req5: get_portfolio + get_trades + save_memory
  → req6: 复盘五段收尾
锚定：6 请求、三段 wake 文本（lastUserText）、持仓快照落沙箱 HOME
```

### 6.4 /review turn 的取数与落盘

```
get_portfolio ──► 现金/持仓/浮盈 + 当日已实现（todayPnl 惰性日切）
get_trades    ──► 账本 JSONL 按北京日过滤（复盘视图=重放对账同源）
get_signals   ──► 今日信号短名单（对照实际走势）
latest_news   ──► 仅持仓股 limit 5（token 纪律）
save_memory   ──► saveMemory(): frontmatter 文件 + MEMORY.md 索引行（同名覆盖）
```

## 7. 交付与 commit

- 建议 commit：`add watch orchestration with day cycle and review skill`
- 手测清单（用户终端，建议交易日跑一次）：
  1. 交易时段 `node dist/cli.js --profile stock` → `/watch`：期望开盘巡检 turn（brief 概览 + 信号 + 计划）；`/watch off` 停止话术；
  2. 盯盘中等一条真实信号（或把 watch 配置的 cooldown 调小试验）：期望盘中信号 turn 自动跑 /adjudicate；
  3. 收盘后保持武装：期望自动 /review turn——当日盈亏主数字、memory 里出现持仓快照（`~/.mini-claude/projects/.../memory/`），次日开盘再巡检（连盯多日）；
  4. `--profile web-stock --web`：同样的三 turn，F6 侧栏看 trade fold 与 watch 注记。

## 8. 自测题

1. 巡检/复盘用"观察迁移"而不用"9:30 到点触发"——把注入钟从 10:00 一把拨到 15:05，两种写法各会发生什么？系统时钟因休眠回拨 20 分钟呢？
2. watch 不注入自己的钟、全走 `market.clock()`——如果 watch 内部有一处 `Date.now()`（比如冷却计时），场景 41 的"一把推到收盘"会在哪一步走岔？找找代码里 `cnHm` 用的是哪个钟。
3. 冷却窗 3 分钟内来了 5 条不同代码的信号——为什么折叠是对的？反过来，为什么巡检和复盘**不需要**冷却窗？（提示：它们各自的状态标记就是节流器——那信号为什么不用"标记+复位"而用时间窗？）
4. halt 期间信号静默，`/halt off` 解除后下一发信号立即唤醒（冷却窗可能已过）——这是 bug 还是特性？从"熔断的语义是停止新决策"角度论证。
5. `save_memory` 为什么 config 门控而不是 base 永远开？如果永远开，普通会话（非 stock profile）的快照体系会发生什么？模型在非复盘 turn 里随手 save_memory 该由什么拦？（permissionHint="edit" 在 C2 判定序里走哪段？）
6. 复盘写持仓快照"同名覆盖"而不是每天新建带日期的记忆——如果每天新建，一周后 /brief 的 memory 注入会变成什么样？索引行 150 字符上限和这个设计有什么关系？
7. 场景 41 的 reqs[4] 假阳是因为技能目录里有 "**/review**: 收盘复盘" 字样——设计一个不可能被目录串门的锚（提示：close 唤醒文本里有什么是目录里永远不会有的？）。
8. d4 第三用例（"寒暄类零调用"）在插件未激活时空过——给 s9 的 save_memory 用例借个思路：怎么写一个"插件死了也红"的前置锚？
