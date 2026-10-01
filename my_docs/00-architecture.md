# my_src 整体架构 —— 26 章收尾审查版（2026-10-03）

> 目标读者：第一次打开这份代码的人。读完应该能回答两个问题：**这份代码做了什么**、
> **每个机制长在哪**。逐章的施工细节见对应章节笔记（08~26），本文只画全景。

## 一句话定位

**Mini Claude Code**：从零逐章复刻 Claude Code 核心机制的教学版编码 agent。约 4200 行
TypeScript，单进程 CLI，走 Anthropic Messages API 形状（官方 SDK + 兼容代理均可，
`ANTHROPIC_BASE_URL`/`ANTHROPIC_MODEL_ID` 切后端）。每章对应教材 docs/ 的一章，功能
按真实 CC 的架构逐件移植，但砍掉灰度/云排程/多后端等生产复杂度。

## 入口与运行形态

```
runCli(argv)                        # cli.ts —— 唯一入口
├─ one-shot：argv 里有任务文本 → chat() 一次 → close() 退出
├─ --goal <cond>：setGoal + pursueGoal → 退出
└─ REPL：readline 循环
   ├─ /clear /plan /cost /compact /memory /skills /goal /loop /<skill>
   ├─ Ctrl+C ×1：中断在途 turn/loop（abort + stop 标志位）
   └─ Ctrl+C ×2：退出（先断 MCP 子进程再 exit）
```

权限模式 5+1（`--plan/--auto/--yolo/--accept-edits/--dont-ask` 或 REPL /plan 切换）：
`default | plan | acceptEdits | bypassPermissions | dontAsk | auto`。
辅助环境变量：`MINI_CLAUDE_SDK_MAX_RETRIES=0` 封 SDK 自带重试（mock 测自研 withRetry 时用）。

## 模块地图（依赖方向：向下依赖）

| 文件 | 职责 | 关键出口 |
|---|---|---|
| `cli.ts` (333) | 参数解析、REPL、SIGINT 两连退出、readline 复用 | runCli |
| `agent.ts` (1336) | **核心**：主循环、压缩、plan 状态机、/goal、/loop、auto 分类器接线、子 agent 派发 | Agent |
| `tools.ts` (528) | 11 个内置工具的 schema + 执行；deferred 激活；read-before-edit 簿记；大结果截断 | executeTool, toolDefinitions |
| `permissions.ts` (177) | 九阶段权限流水线、settings.json 规则、危险命令清单 | checkPermission |
| `prompt.ts` (131) | 静态/动态 system 组装、CLAUDE.md 加载（@include 展开）、环境 reminder | buildStaticSystemPrompt 等 |
| `autonomy.ts` (369) | /goal 评估器、/loop 解析器、auto 分类器的规则资产与 transcript 投影（纯函数） | loadAutoModeRules 等 |
| `memory.ts` (382) | 四类型记忆 CRUD、MEMORY.md 索引、语义召回 selector + prefetch | startMemoryPrefetch |
| `subagent.ts` (179) | 内建三类型 + `.claude/agents/` 自定义定义发现 | getSubAgentConfig |
| `skills.ts` (166) | `.claude/skills/` 发现、$ARGUMENTS 解析、inline/fork 分流 | executeSkill |
| `mcp.ts` (240) | 裸 JSON-RPC stdio 客户端；三处配置合并；mcp__server__tool 前缀路由 | McpManager |
| `session.ts` (63) | 会话落盘 ~/.mini-claude/sessions/，--resume 恢复 | saveSession/loadSession |
| `frontmatter.ts` (41) | 简易 YAML frontmatter 解析（memory/skills 共用） | parseFrontmatter |
| `retry.ts` (38) | 瞬态错误识别（429/503/529/网络）+ 指数退避 | withRetry |
| `ui.ts` (211) | chalk 输出、spinner、plan 审批界面（Agent 类不依赖具体 UI） | print* 家族 |

## 一次 turn 的生命周期（agent.ts）

```
chat(userText)
├─ push user 消息（末条已是 user 则合并进去——历史自洁，见"不变式"节）
├─ checkAndCompact()            # T4 压缩门（0.85 窗口线，只在 turn 边界查）
├─ startMemoryPrefetchForTurn() # 语义召回旁路请求（异步，不挡循环）
├─ ensureMcp()                  # 幂等连接 MCP server
└─ runAgentLoop() —— while(true)
   ├─ runCompressionPipeline()  # T1 budget → T2 snip → T3 microcompact（零 API 成本）
   ├─ consumeMemoryPrefetchIfReady()  # selector 落定就把记忆注入末条 user 消息
   ├─ 请求：withRetry(流式 messages.stream)
   │    system = [静态核心(cache_control) | 动态环境+plan提示]   ← 前缀缓存设计
   │    tools  = 激活态工具 + MCP 工具（deferred 未激活的不广告）
   │    messages 末块打 cache_control 断点
   ├─ usage 四计数（input/output/cacheRead/cacheCreation）→ lastInputTokenCount
   ├─ push assistant 回复
   ├─ 无 tool_use → printCost + autoSave → break（turn 收敛）
   ├─ checkBudget（位置 B：响应已结算、工具未执行；超限给每个 tool_use 补拒绝结果再停）
   └─ 逐个 tool_use：
      printToolCall → 权限裁决 → （confirm 询问）→ 执行 → 大结果落盘 → push tool_result
      ——单工具全包 try/catch，任何抛错转 error tool_result，绝不孤儿化 tool_use
```

## 六大机制

### 1. 权限系统（permissions.ts + agent.ts 分类器接线）

**九阶段流水线**（顺序即安全语义），deny 规则连 --yolo 也拦：
① deny 规则 → ② plan 只读契约（写/编辑只放行 plan 文件本身，路径全等；shell 全拦）
→ ③ bypass 全放行 → ④ allow 规则 → ⑤ READ_TOOLS → ⑥ plan 进出工具 →
⑦ acceptEdits+编辑工具 → ⑧ confirm 候选（dontAsk 转 deny）→ ⑨ 兜底放行。
规则来自 `~/.claude/settings.json` + `.claude/settings.json` 的 permissions.allow/deny，
`run_shell(rm *)` 语法（前缀 * 或全等）。

**auto 模式**不走流水线的人工 confirm，改走 LLM 分类器（autonomy.ts，规则资产
`assets/auto-mode-rules.json`）：deny 规则仍前置硬拦；只读工具 fast-path 直放；其余
把对话投影成"推理盲"transcript（user 文本 + 工具调用，**丢弃 assistant 散文**——那是
可能被构造来操纵分类器的内容）→ stage 1 廉价闸（256tok，任一规则可能命中就拦）→
拦了才进 stage 2 审慎裁决（1024tok，可看用户意图解除拦截）。防注入三板斧：transcript
JSON 编码 + 尖括号转义（`safeJson`）、`<system-reminder>` 剥离（`stripReminder`）、
CLAUDE.md 只走 `<user_claude_md>` 专槽不进 system。连拦 3 次或累计 20 次 → 降级回
人工 confirm（无人值守则拒）。所有装配/解析错误一律 fail-closed 转 block。

### 2. Plan Mode（agent.ts 状态机）

进入（--plan / /plan / enter_plan_mode）→ 生成 plan 文件路径 → plan 提示在**请求时**
现算拼进动态 system 尾（不常驻，进出模式不伤缓存）→ 只读契约由权限层代码强制 →
exit_plan_mode 从磁盘读 plan 全文 → 四选项审批（CLI 注入回调；one-shot 走 fallback
直接恢复）：1 清历史重执行 / 2 保留上下文执行（1、2 落 acceptEdits）/ 3 手动确认 /
4 打回重做（反馈作为 tool_result 回灌，留在 plan 态）。选项 1 的清历史走 contextCleared
信号位：exit 结果作为重建上下文的首条 user 消息，本批更早的 tool_result 随旧历史作废。

### 3. 上下文管理（agent.ts 压缩管道）

| 层 | 触发 | 动作 | 成本 |
|---|---|---|---|
| T1 budget | util>0.5 | 超大 tool_result 掐头去尾（30K/15K 字符预算） | 0 |
| T2 snip | util>0.60 且（缓存冷 或 util>0.75） | 同文件旧读去重 + 只保最近 3 条 | 0 |
| T3 microcompact | 缓存冷（5 分钟没请求） | 所有 tool_result 只保最近 3 条 | 0 |
| T4 auto-compact | util>0.85，turn 边界 | 摘要重写整个历史（一次摘要请求） | 1 次调用 |

T2/T3 用 `lastApiCallTime` 判断缓存冷热——**缓存热时忍住不改历史**（改一个字节作废整个
前缀缓存），只有溢出风险压过缓存价值（越过 0.75 覆盖线）才动手。另有两件套：>30KB
工具结果落盘 `~/.mini-claude/tool-results/` 只留预览；`persistLargeResult` 先落盘再生成
预览（顺序即数据安全）。

**前缀缓存设计**：system 拆两块——静态核心（所有人所有会话一致）打 cache_control 断点；
动态环境（git/memory 索引/skill 名单/plan 提示）放断点后。消息列表末块打断点。memory
索引、plan 提示一旦进静态块，写一条记忆/进出一次 plan 就作废全部缓存。

### 4. 子 agent（agent.ts 派发 + subagent.ts 定义）

三条派发通道，同一套隔离原则（独立历史、独立 system、结果文本回传父级、token 差值
记回父级费用）：
- **agent 工具**：explore/plan（只读三件套）/ general（全工具），或 `.claude/agents/*.md`
  自定义类型（frontmatter: name/description/allowed-tools，body=system prompt）；
- **skill fork**：`context: fork` 的 SKILL.md → 解析后模板当 system，白名单过滤父工具集；
- 权限继承：plan/auto **必须穿透**（防权限洗白：主对话拦下的操作不能借 bypass 子 agent
  绕过），其余模式落 bypassPermissions（危险动作由父层工具集约束）。
- 硬防线：子 agent 一律拿不到 agent 工具和 schedule_wakeup（白名单写了也不给）——
  防递归失控、防 loop 内部工具泄漏。

### 5. 记忆系统（memory.ts）

四类型（user/feedback/project/reference）markdown 文件，落
`~/.mini-claude/projects/<sha256(cwd)前16>/memory/`（项目隔离；HOME 沙箱可测）。写入走
write_file，MEMORY.md 索引**写时自动重建**（模型不许手动维护）。召回是异步 prefetch：
turn 边界发起 selector 旁路查询（三道门：查询够重/会话预算 60KB 未超/目录非空），
每轮请求前轮询一次，落定就把选中记忆包 `<system-reminder>` 注入末条 user 消息——
同一条记忆一个会话只注入一次，超期记忆附新鲜度警告。selector 是独立小请求，主对话
历史不掺和。

### 6. 自主循环（autonomy.ts 纯逻辑 + agent.ts 驱动）

- **/goal**（被动闸门）：会话级 Stop-hook 条件。每个 turn 结束后评估器（独立小请求，
  角色分离三消息：framing user / transcript-as-data assistant / judge user——被评审的
  turn 无法伪造 user 指令混进评估上下文）按三态 JSON 契约裁决：met → 停；impossible
  → 停；not-met → reason 回灌开下一轮。解析失败/评估器出错一律按 not-met（fail-closed，
  绝不误清 goal）。硬顶 25 轮 + --max-turns 预算双保险。
- **/loop**（主动自排程）：`interval` 模式（`5m` 前缀或尾部 `every N minutes`，可中断
  睡眠）每 N 秒重跑 prompt；`dynamic` 模式由主模型经 schedule_wakeup 工具自选节奏
  （[60,3600] 秒钳位），不调即收敛。schedule_wakeup 只在 dynamic loop 活跃期暴露，
  退出即摘——防裸调。

## 历史自洽不变式（收尾审查重点修复）

历史发给 API 的两条硬约束：**user/assistant 严格交替**（连发同角色 400）+ **tool_use
必须紧跟配对的 tool_result**（孤儿化 400）。官方 API 强制（2026-10 实测确认：本机 GLM
兼容代理宽松放行，但官方契约是 400；真 CC 靠 normalizeMessagesForAPI 客户端兜底）。
教学版没有归一化层，靠构造时维持。收尾审查修复了三处破坏点：

1. **budget 超限截停 → 下一条消息**：截停把历史末尾停在 user（tool_result 拒绝批次）上，
   原实现再 push 就是连续 user。修复：chat() 检测末条是 user 就把新文本并进去
   （字符串拼接，或往 tool_result 批次尾部追加 text 块——两者都是合法形状）。
2. **/compact 的请求形状**：原实现固定 `slice(0,-1)+摘要指令`，只在"末条是纯文本 user"
   （T4 turn 边界）时合法；REPL /compact 的常态是末条 assistant，会拼出连续 user。
   修复：按末条形态三分支——纯文本 user→顶替式（原样塞回）；无 tool_use 的 assistant→
   追加式；带 tool_result 的 user（budget 截停态）→ 拒绝压缩（宁少压一次，不发注定
   非法的请求）。
3. **工具循环异常隔离**：任何单工具意外抛错（畸形 input 打崩 UI 渲染、落盘失败等）
   原会逃出循环，历史里挂着无回应的 tool_use，之后每个请求都 400（永久污染）。修复：
   单工具全包 try/catch，转 error tool_result 回灌让模型自愈。

顺带修复：自定义 agent/skill fork 的 allowed-tools 白名单现在也滤掉 agent 工具（原来
只有默认工具集滤）；ui.ts run_shell 摘要对缺失 input 不再抛错。

## 安全设计一览（教学版的"真 CC 同款"点）

- deny 规则是铁闸：九阶段第一位，--yolo/bypass/auto 分类器都拦不住它。
- plan 只读是代码强制不是提示词恳求；唯一豁免是 plan 文件路径全等。
- CLAUDE.md 是不可信仓库内容：进 user 消息/reminder，绝不进 system；auto 分类器里
  走专用 JSON 编码槽位。
- 权限洗白防御：子 agent 权限模式 plan/auto 穿透继承。
- 评审/分类器的输入投影：JSON 编码 + 尖括号转义 + reminder 剥离 + assistant 散文丢弃
  （推理盲），被评审内容永远以"数据"角色出现。
- fail-closed 哲学：评估器坏→not-met；分类器坏→block；/compact 边界不对→不压。

## 测试

- **mock**（run-mock.mjs，免 key）：本地 HTTP server 按请求特征路由到脚本轨道（main/
  compact/goal/auto/memory/sub/fork），断言打在请求日志上（消息数、system 内容、
  tool_result 文本、流式与否），不只在最终输出上。21 个场景对应各章交付物，收敛命令：
  `npm run mock -- <章节>`。
- **真机**（run-live.mjs + 真实后端）：非交互 one-shot 场景冒烟；纪律见
  feedback_live_run_ops（--accept-edits、日志直写文件、破坏探针用一次性目标）。
- mock 测不到的角落（T3 缓存冷、plan 文件写入豁免等）靠 review + 真机兜底，各场景
  注释里有标注。
