# ch25：ToolSearch 与 Plan Mode 完整版

> 进阶轮第 10 章（代填轮，延续 ch21/22/24 模式）。参照 `src/tools.ts`（ToolDef/deferred 机制/tool_search/checkPermission plan 分支）+ `src/agent.ts`（Plan Mode 状态机/executePlanModeTool/contextCleared 改道）+ `src/cli.ts`（--plan 构造期注入/planApprovalFn/plan REPL）+ `src/ui.ts`（审批 UI，ch16 已预埋）。
> 回归：**21/21 绿**（ch10 迁移 + ch25 新场景 + 原 19 场景）。

## 一、deferred 机制：工具清单的 token 经济学

### 问题

工具 schema 全量随请求发送，每个工具几十 token。绝大多数会话用不到 Plan Mode 的一对工具——但它们常年占着提示词空间，还吃缓存前缀。

### 机制（tools.ts）

三件套：

1. **`ToolDef = Anthropic.Tool & { deferred?: boolean }`**——deferred 只是标记，API 不认识，发送前要剥掉；
2. **激活集合** `activatedTools: Set<string>`（模块级全局）——`getActiveToolDefinitions()` 过滤"非 deferred 的全量 + 已激活的 deferred"，并剥标记；`getDeferredToolNames()` 给出还没激活的名单；
3. **tool_search 工具**（本身永远广告）——按名字/描述子串匹配 deferred 工具，命中即激活并返回完整 schema（JSON.stringify null 2）。模型拿到 schema 就能立刻调用。

### 两个设计点

- **system 里的"目录页"**：schema 不广告，但名字必须说，否则模型不知道去搜什么（prompt.ts 的 deferredSection）。每次请求现算——激活一个，它就从名单里消失，且这句从 system 里整体退场（mock 断言验证了这一动态性）。
- **激活态是模块级全局**（对齐 src）：主对话 tool_search 一次，deferred 工具对**后续所有请求、包括子 agent** 永久可见。一次搜索终身有效；`resetActivatedTools()` 导出但无人调用（测试隔离用）。

## 二、Plan Mode：四变量状态机

| 变量 | 职责 |
|---|---|
| `prePlanMode` | 进入前的模式——退出时**精确恢复**（acceptEdits 进 plan，出来还是 acceptEdits，不是掉回 default） |
| `planFilePath` | `~/.mini-claude/plans/plan-<sessionId>.md`，构造期（--plan）或 enter 时生成 |
| `contextCleared` | 审批选项 1 的信号位，主循环读它改道（见 §四） |
| `planApprovalFn` | 注入的审批回调——Agent 类不依赖具体 UI，子 agent 没有它就走 fallback |

### 提示注入的位置（与 src 的一处结构性差异）

src 有常驻 `systemPrompt` 字段，进出 plan 时同步改写它（还要顺手改 openaiMessages[0]）。my_src 自 ch22 起没有这个字段——system 每次请求在 `buildAnthropicSystem()` 现算：

```ts
const planSuffix = this.mode === "plan" ? this.buildPlanModePrompt() : "";
const dynamicText = ((this.hasCustomPrompt ? "" : buildDynamicSystemContext()) + planSuffix).trim();
```

plan 提示拼在**动态尾巴**：进出 plan 它就变，混进静态块等于每次进出 plan 作废一次前缀缓存。等效、少一处状态、天然双后端无关。

### 提示词做了三件事

约束行为（MUST NOT edit）＋声明 plan 文件（唯一可写路径）＋规定工作流（Explore→Design→Write→Exit）。最后一句 "Do NOT ask the user to approve — exit_plan_mode handles that" 是经验教训：没有它模型写完计划会问"这样可以吗"而不是调用工具，审批流程永远不触发。

## 三、权限集成：只读是代码强制，不是提示词恳求

permissions.ts `checkPermission()` 加第 4 参 `planFilePath`，plan 分支压在 allow 规则和 bypass 之上（阶段②）：

- **EDIT_TOOLS**：目标路径与 planFilePath **字符串全等**才放行（唯一豁免），否则 deny；
- **run_shell**：一律 deny（shell 是万能写通道）；
- 阶段⑥：enter/exit_plan_mode 本身永远 allow（纯状态切换，agent 层处理）。

双重保障：提示词劝住模型少发无效写请求；真发了，权限层拦下并回 `Blocked in plan mode: <tool>` 的 tool_result，模型自己看到后改道。

## 四、exit_plan_mode：四选项状态迁移

```
exit_plan_mode
  ├─ 无 planApprovalFn（one-shot/子 agent）→ fallback：恢复 prePlanMode，返回 plan 内容
  └─ 有 → await planApprovalFn(planContent)   ← plan 内容从磁盘读（clear 后历史没了，底稿还在）
       ├─ keep-planning    → 模式**留在 plan**，feedback 作为 tool_result 回灌，模型改方案
       ├─ execute          → acceptEdits，保留历史
       ├─ manual-execute   → 恢复 prePlanMode（每个编辑重新人工确认）
       └─ clear-and-execute → acceptEdits + 清历史 + contextCleared=true
```

四个选项是四种使用场景：计划完善但上下文已长（1）、计划完善直接干（2）、想逐步盯梢（3）、方案要改（4）。1/2 落 acceptEdits 是信任对价——既然批准了计划，就不该每个编辑再确认一遍。

### contextCleared 的主循环改道（本章最精巧的一处）

clear-and-execute 在工具执行**中间**清掉了 `this.messages`。此刻本批 tool_result 面临双重尴尬：挂回去，前面的 assistant tool_use 已随历史被清，结果成了孤儿（下次请求 400——ch20 refusal 配对同源）；不挂回去，exit 的结果（含 plan 全文）就丢了。

解法（agent.ts 工具循环）：

```ts
const output = this.persistLargeResult(tu.name, await this.executeToolCall(...));
if (this.contextCleared) {
    this.contextCleared = false;
    const content = this.messages.length === 0 && !this.hasCustomPrompt
        ? `${output}\n\n${buildUserContextReminder()}` : output;
    this.messages.push({ role: "user", content });
    contextBreak = true;
    break;                       // 本批更早的 tool_result 随旧历史作废
}
toolResult.push({ ... });
...
if (!contextBreak && !this.contextCleared && toolResult.length > 0) { ... }
this.contextCleared = false;     // 与 src 相同的 belt-and-braces
```

exit 结果以**独立 user 消息**重建上下文，且首条消息补 CLAUDE.md reminder——与 chat() 首条消息同待遇（mock 断言 messageCount===1 + `<system-reminder>` 在场）。

## 五、CLI 接线

- **构造期注入**：模式 flag 先解析完再 `new Agent({ permissionMode })`——--plan 的 plan 文件路径在构造期生成（对齐 src 的 parseArgs→constructor 形态；my_src 旧版构造后再 setMode 的顺序撑不住这个时序）。
- **/plan REPL**：`agent.togglePlanMode()`，对称进出。
- **planApprovalFn**：复用 REPL 同一个 readline（同一 stdin 开两个 interface 的经典坑），选项 4 追问 feedback，无效输入原界面重问。
- **ui.ts**：printPlanForApproval/printPlanApprovalOptions 是 ch16 预埋的，本章零改动接线。

## 六、mock 场景设计与三次翻车（记档）

**ch10 迁移**（--plan one-shot：拦截→读→搜→fallback 退出→写盘成功）+ **ch25 新场景**（三 run 直调 agent 层，脚本化 planApprovalFn：execute / keep-planning / clear-and-execute）。

1. **report.txt 预置引来 read-before-write 门**：为避开"one-shot 无 confirmFn 悬 stdin"而预置已存在文件，结果恢复后的 write 被执行层的"must read before writing"拦下——权限放行了，执行层还有一道门（两层闸门语义分清）。修正：plan 模式里先读再退（顺手多测一条"plan 允许读"）。
2. **new-file write 的 confirm 候选**：one-shot 没 confirmFn，若场景让模型写新文件且模式没切到 acceptEdits，confirmDangerous 会在 stdin 上开 readline 挂死。ch25 驱动分支注入**自动否**的 confirmFn——模式逻辑坏了会干净失败，而不是挂住。
3. **plan 文件路径含随机 sessionId**：脚本化 write 够不着它——**写 plan 文件的豁免分支（全等放行）mock 测不到**，靠 review + 真机冒烟兜底（同 ch21 T3 处境）。

另：记忆旁路有"无记忆文件不发"的门控，沙箱场景不会误发 selector 请求（写场景前查过 memory.ts 三重门）。

## 七、与 src 的对齐/分歧清单

- 对齐：ToolDef/激活机制/tool_search 文案与执行、plan 双工具定义、checkPermission 分支与顺序（②plan 豁免在 allow/bypass 之上，⑥plan 工具放行在 READ_TOOLS 后）、executePlanModeTool 全部分支文案、contextCleared 三段改道、构造期 --plan、审批回调注入形态。
- 分歧（有意）：plan 文件目录 `~/.mini-claude/plans`（src 用 `~/.claude/plans`——教学版沿用 my_src 自己的命名空间，不碰真实 CC 目录）；planSuffix 请求时现算（src 改常驻字段）；src 的 `AUTO_MODE_FAST_PATH_TOOLS` 含 tool_search/enter/exit（auto 快路径属 ch26，届时补）。

## 八、思考题（回补用）

1. **激活态的作用域**：activatedTools 是模块级全局，跨 Agent 实例（含子 agent）共享。/clear 或 --resume 新会话时该不该重置？如果子 agent 的 allowed-tools 白名单里没有某 deferred 工具，父级激活的它会广告给子 agent 吗——读 getActiveToolDefinitions 的过滤顺序想想白名单和激活态谁先谁后。
2. **全等豁免的绕过**：planFilePath 豁免是 `filePath === planFilePath` 字符串全等。模型写 `../plans/plan-<id>.md` 或绝对路径（resolve 后同一文件）能绕过吗？src 也没防——normalize 再比较的成本与收益？真 CC 用 allowedPrompts/路径规范化做了哪一层？
3. **reminder 的边界**：clear-and-execute 后重建的首条消息带 CLAUDE.md reminder；选项 2（保留历史）不带——为什么？如果选项 2 也带，会出现什么重复注入？参考 chat() 首条消息的 `messages.length === 0` 条件。
4. **一次性激活 vs 逐请求计算**：真 CC 每请求动态算可用工具集，教学版一次激活终身可见。多轮对话里"搜过一次就不用再搜"省了什么？反过来，什么场景下会广告出模型其实用不到的 schema？

## 九、真机冒烟观察点（并入下次统一冒烟）

- /plan toggle 进出后缓存命中是否如预期（planSuffix 进出动态尾巴）；
- enter_plan_mode 真机自主动作：模型会不会先 tool_search 再 enter（目录页引导是否足够）；
- 四选项审批的真实交互流（1-4 输入、feedback 追问）；
- plan 文件真实落盘内容与 exit 时回灌的 plan 全文一致性。
