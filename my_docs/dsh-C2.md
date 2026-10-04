# dsh-C2 工具执行管线 + 权限瀑布

> 本章产物：`ToolsService.executeCall()` 管线（snapshot → pre-execute 瀑布 → 审批 → 执行 → truncate → post-execute 瀑布）、`monotonic` 单调守卫、`services/approval.ts`（ApprovalService 双 provider 槽 + 缓存）、`plugins/approval.ts`（九段流水线监听器化）、`plugins/auto-approval.ts`（auto 裁决监听器）；agent.ts 循环内权限代码整体删除。
> 一句话：**权限从"循环里的一段顺序逻辑"变成"事件域里的一组带守卫的监听器"——决策可以叠加、可以加严、不可被翻案。**
> 参照物：`packages/core/tools/src/index.ts` 管线段；逐段对照迁移自自家 `permissions.ts:checkPermission`。

---

## 1. 管线四段与 waterfall 优先级

`executeCall` 的完整流水线：

```
snapshotArgs（structuredClone，监听器/审批看到同一份不可变视图）
→ waterfall('tools/pre-execute', call, next = allow 默认)     ← 策略全部在这里
→ deny → 拒绝话术上抛；ask → ApprovalService.request（无服务 = fail-closed deny）
→ 执行（exec.dispatch 优先 = agent 的魔法名链；否则注册表 def.execute）
→ truncateResult
→ waterfall('tools/post-execute', result, next = 原样)        ← 监听器可改写输出
```

**注册序 = waterfall 层级**：先注册者在外层、最先裁决。agent 构造树的顺序就是安全架构：

```
ToolsService → core 工具插件 → approvalPlugin（外层）→ autoApprovalPlugin（内层）
```

"auto 优先"由 veto 链自然表达：approval 外层先做 deny 规则硬底线，然后 `next()` 放行进内层；auto 监听器可以直接返回裁决（否决后续），也可以透传。旧代码 `mode === 'auto' ? classify : checkPermission` 的分支选择，变成了"两个监听器在链上各让一步"——**加一种模式 = 加一个监听器，而不是改循环里的 if 树**。

## 2. 迁移边界：裁决路由迁，裁决机制留

auto 的分类器（两段式 LLM 裁决、拒绝上限、transcript 装配）**留在 Agent**——它需要 client、messages、denial 计数器。经 `call.autoAdjudicate` 句柄逐调用传给监听器，返回旧形 `{action}` 由监听器映射成 `PreExecDecision`（deny→deny、confirm→ask、allow→allow）。判定标准：**依赖 Agent 实例状态的机制不迁，纯路由与策略迁**。同款边界决策：dispatch 句柄（魔法名链）留在 agent，管线只管"批不批"，不管"怎么执行"。

## 3. guard 单调与"弃权式放行"（本章最重要的设计发现）

`monotonic` 包装器给每个监听器两条保证：

```ts
return async (call, next) => {
  let inner;                                  // 捕获 next() 的结果
  const guardedNext = () => { inner = next(); return inner; };
  const own = await listener(call, guardedNext);
  if (inner === undefined) return own;        // 不调 next = 否决：自己的裁决即终局（短路保持）
  return tighten(await inner, own);           // 调了 next：只能收紧（allow<ask<deny 取严）
};
```

测试当场抓出一个设计洞：**allow 不能是终局裁决**。第一版九段监听器的 allow 段直接 `return { type: 'allow' }`——否决式 allow 短路整条链，内层策略监听器永远没机会加严，"内层可以 deny"的测试直接挂掉。修正后 allow 段一律 `return next()`——**弃权式放行**：我这块没有意见，让内层说，guard 保证内层只能说得更严。九段里的三种态度就此分明：

| 裁决 | 形态 | 理由 |
|---|---|---|
| deny / ask | 否决式终局 | 已经够严，内层无从加严；ask 走审批 |
| allow（规则⑤⑥⑦⑨、plan 豁免） | `return next()` 弃权 | 防御纵深：未来的策略插件还能加严 |
| bypass 的 allow | 否决式终局（例外） | 用户明示的主权让渡，不受内层策略约束 |

对照测试：deny 后内层返回 allow 无法翻案；内层 deny 可以加严外层的弃权 allow。

## 4. 九段迁移对照（保序！）

| 段 | 旧 checkPermission | 新监听器 | 变化 |
|---|---|---|---|
| ① deny 规则 | `checkPermissionRules` | 同函数原样调用，deny 终局 | 无 |
| ② plan 契约 | `EDIT_TOOLS.has(name)` | `def.permissionHint === 'edit'` | 集合 → 元数据 |
| ③ bypass | allow | **终局 allow（不 next）** | 见第 3 节 |
| ④ allow 规则 | allow | `next()` 弃权 | 同上 |
| ⑤ READ_TOOLS | 集合 | `permissionHint === 'read'` | 元数据 |
| ⑥ plan 工具 | 名单 | 名单（同） | 无 |
| ⑦ acceptEdits | `EDIT_TOOLS` | `permissionHint === 'edit'` | 元数据 |
| ⑧ confirm 候选 | `{action:'confirm'}` | `{type:'ask'}`，dontAsk 分支 deny 终局 | 形状变化 |
| ⑨ 兜底 | allow | `next()` 弃权 | 同上 |

**FAST_PATH 集合刻意不改读 permissionHint**：roadmap 建议 READ/EDIT/FAST_PATH 都读元数据，前两个成立，FAST_PATH 不成立——`web_fetch` 的 hint 是 `'read'` 但被 auto fast-path **刻意排除**（URL 拉取可能带数据出境，分类器必须看到）。fast-path 是安全决策不是能力分类，显式集合比 hint 推导诚实，保持 `AUTO_MODE_FAST_PATH_TOOLS` 原样并记档。

顺序即安全语义没有动：显式禁令（①）> 模式契约（②）> 便捷快捷方式（③-⑦）> 默认行为（⑧⑨）。乱序事故的反例：若 bypass（③）提到 plan（②）之前，plan 模式下开 bypass 就绕过只读契约——"只读"从代码强制退化成建议。

## 5. ApprovalService：双 provider 槽与缓存迁居

```ts
request(call, message):
  cacheable = call.mode !== 'auto'
  缓存命中（且 cacheable）→ allow-always
  provider = interactive ?? fallback；两者皆无 → deny（fail-closed）
  verdict = provider(...)
  allow-once 且 cacheable → 写缓存，返回 allow-always
```

- **interactive 槽**：cli/mock 经 `agent.setConfirmFn` 注入（setConfirmFn 双写：confirmFn 留在 Agent 供 autoFallback 的 headless 判定，同时包装成 interactive provider）。
- **fallback 槽**：一次性 REPL 问答（旧 confirmDangerous 的 readline 兜底），审批插件 apply 时设置。
- **缓存语义**（旧 confirmedPaths 迁居）：auto 的 confirm 带的是动作摘要不是路径，一次批准绝不能给同类动作开白名单——`cacheable = mode !== 'auto'` 在 request 里按调用判定。测试固化：default 同 message 第二次免问，auto 每次都问。

失败闭合计完：ask 时无审批服务 → 直接拒；provider 双空 → 拒；auto 无裁决句柄 → headless deny（对齐旧 autoFallback 话术）。全部拒绝话术逐字节保留（`Denied: ...` / `User denied this action.` / `Blocked in plan mode: ...` / `Auto-denied (dontAsk mode): ...`），测试逐条对拍。

## 6. 与真框架的差距清单（C2 后）

| 能力 | 真 cordis/dsh | mini | 备注 |
|---|---|---|---|
| executeCall 管线四段 | ✅ | ✅ | — |
| pre/post 瀑布 + veto | ✅ | ✅ | — |
| 单调 guard | ✅（listener 只能收紧） | ✅ monotonic | — |
| Approval 服务抽象 | ✅ | ✅ 双槽 + 缓存 | — |
| 三层瀑布叠加（config/service/event 各一层 pre-execute） | ✅ | 单层 pre + 单层 post | 标注"略"，单层已表达优先级 |
| snapshotArgs 审计 | ✅ | ✅ structuredClone | — |
| 规则引擎监听器化内部 | — | 规则解析仍在 permissions.ts | 复用不重写，路由已监听器化 |

## 7. 实现与验证记录

**文件**：
- `services/tools.ts`（修改：PreExecDecision/PreExecCall/ExecOutcome/AutoVerdict、monotonic、executeCall 管线、Events 增 tools/pre|post-execute、ToolExec 增 dispatch/autoAdjudicate）
- `services/approval.ts`（新增：ApprovalService）
- `plugins/approval.ts`（新增：九段监听器 + ApprovalService 提供 + REPL fallback）
- `plugins/auto-approval.ts`（新增：auto 监听器）
- `agent.ts`（修改：循环权限段替换为 executeCall、classifyToolCall 去 base、setConfirmFn 双写、构造挂两个策略插件、confirmedPaths/confirmDangerous/readline 死代码清理）
- `cordis-tests/c2-approval.test.ts`（新增 10 条）

**验证**：
- `npm run cordis`：**76/76 绿**（C2 新增 10 条：六模式 × 12 工具对拍、话术逐字节、plan 豁免、guard 两向、ask 缓存双模式、fail-closed、auto fast-path/裁决映射、post-execute 改写）
- 全量 mock 回归：**22/22 绿**——permission（ch19 写确认）、plan（ch10/ch25）、auto（ch26）场景全过，验收达成。

**翻车记档**（实现过程中真实发生）：
1. **allow 短路设计洞**（第 3 节）：allow 段第一版是终局裁决，"内层加严"测试当场抓出。这条测试就是 guard 单调的存在证明——没有它，洞会一直睡到第一个策略插件想加严的那天。
2. **测试树缺工具插件**：buildTree 不注册 core 插件 → `def` undefined → permissionHint 读不到 → plan 分支整段失效，对拍 4 条齐挂，报错却是"User denied this action."（⑧ 的 ask 走到了批准桩）。**策略读元数据的前提是注册表有货**——测试 harness 也是一棵真树，少挂插件就是少元数据。
3. **逐调用句柄的传递路径**：auto 插件第一版想从 `ctx.tools` 上摸 autoAdjudicate——句柄是逐调用的（每圈决策上下文不同），应随 PreExecCall 走。教训：**树上的状态是配置，调用间的状态是参数**，放错位置要么取不到要么串场。
4. **测试桩自身挡路**：ask 缓存测试的 auto 分支被 exec() 默认的"恒 deny"adjudicator 挡住，confirm 永远浮不出来——stub 的默认值也是语义，换场景要显式覆盖。

## 8. 自测四题（答案在文末）

1. 为什么 allow 段必须 `return next()` 而不是直接返回 allow？bypass 为什么例外？
2. monotonic 包装器怎么同时保住"否决短路"和"单调收紧"两个看似矛盾的性质？
3. 九段顺序为什么不能乱？举一个乱序出安全事故的具体例子。
4. 分类器机制为什么留在 Agent？"什么该迁进监听器"的边界标准是什么？

> **答案**：
> 1. 否决式 allow 会短路整条链——内层策略监听器永远没机会加严，防御纵深失效。弃权式放行（next()）让 guard 对内层结果做单调收紧：内层弃权则 allow 兑现，内层加严则从严执行。bypass 例外：它是用户明示的"我负责"，若内层策略还能拦，bypass 语义就被背叛了。
> 2. 用 guardedNext 捕获区分两种行为：监听器没调 next → inner 为 undefined → 返回 own（否决短路，内层根本不执行，省掉分类器调用）；调了 next → tighten(await inner, own) 按严度序取严。矛盾消解在"否决是主动声明终局，弃权是显式咨询后继"——wrapper 只需要知道你调没调 next。
> 3. 顺序编码的是"显式禁令 > 模式契约 > 便捷 > 默认"。反例：bypass（③）若提到 plan（②）前，plan + bypass 组合会绕过只读契约——plan 模式的"只读"是代码强制，一旦可被 bypass 覆盖，plan 文件外的写入就只剩提示词恳求；同理 deny 规则（①）若落后于 allow 规则（④），用户 deny 的命令会被 allow 白名单捞回。
> 4. 边界标准：依赖 Agent 实例状态（client/messages/计数器）的机制不迁，纯路由与策略迁。分类器要 this.messages 装 transcript、this.client 发查询、denial 计数跨调用——迁出去要么把这些塞进 call 上下文（爆炸），要么服务反向依赖 Agent（倒挂）。监听器拿到的是裁决句柄，机制留在状态的所有者那里。

## 9. 下章预告（C3 会话事件日志 ★ 本轮最核心）

`services/session-log.ts`：SessionEvent 事件类型（system/user/assistant 消息、tool 调用与结果、turn 边界、meta/note）、`append/derive`——**model-visible ⟺ logged**，agent.ts 全部消息操作改走日志；derive 的实现位置为 D5 的压缩投影 replace 留缝。这是 dsh"会话即事件日志"世界观的地基，也是本轮最核心的一章。
