# dsh-C7 system prompt 服务

> 本章产物：`services/system-prompt.ts`（SystemPromptService：section 注册表 + 中央 order + `{{var}}` 严格插值 + assemble 两块结构）；`plugins/prompt-sections.ts`（identity/env/git/memory/skills/agents/deferred-tools 七节 + 四个环境变量）；agent.ts 的 `buildAnthropicSystem` 收缩为 assemble 委托；`buildDynamicSystemContext`/`getGitContext`/`staticSystemPrompt` 字段消亡。
> 一句话：**system 不是一根手拼字符串，是分节拼装**——加一节上下文源 = 注册一个 section，不碰任何既有代码。
> 参照物：`packages/core/system-prompt/src/index.ts`。

---

## 1. 迁移前：一根会长的字符串

`buildDynamicSystemContext()` 是模板字符串拼接的集大成：env（cwd/platform/shell）+ git 上下文 + memory 索引 + skills 目录 + 自定义 agent 目录 + deferred 工具目录页，六段以各自的前导分隔符（`\n\n` 或空）连成一个块；agent 侧再拼 plan 后缀、整体 trim。每加一个上下文源都要**改这个函数**（还有它的调用方注释链）——扩展开关长在拼接点，而不是长在新内容自己身上。

## 2. 模型：节自描述，服务管拼装

```
registerSection({ id, order, group: static|dynamic, render(vars) })
registerVariable(key, get)                      // assemble 时求值
assemble():
  order 升序（稳定排序，同序按注册序）
  static 组  → join("") → 一块，尾打 cache_control: ephemeral
  dynamic 组 → join("") → trim → 非空才成第二块（无断点）
  严格插值：{{未知}} 抛错（拼错名字静默上线路，比炸掉贵）
```

三个等价性命门（全部钉在场景回归上）：

1. **连接串是空 join**——各节自带前导分隔符（memory 以 `\n\n# Memory System` 开头、agents 以 `\n# Custom Agent Types` 开头……）。这不是漂亮设计，是**旧拼接的字节事实**：模板 `${git}${memory}${skills}` 本来就是零分隔符直连。节化后沿用"内容自带间距"的约定，join("") 就是逐字节复刻。
2. **两块结构不动**：静态块（identity 一节）尾打 ephemeral 断点吃前缀缓存；动态块整体 trim——纯空白（子 agent 无动态节）不出现第二块。断点策略从 agent.ts 收进 assemble，从此是服务的职责而不是每个调用方的常识。
3. **plan 节由 Agent 自注册**：它读 `this.mode`/`this.planFilePath` 私有状态（进出 plan 模式的瞬间才变，永远在动态组末尾——order 800）。这是"服务持有机制、状态持有者注册内容"的又一例：SystemPromptService 不认识 plan，plan 也不用认识别的节。

## 3. 变量通道：为什么保留两条

render(vars) 直取参数（`vars.cwd`）与 `{{cwd}}` 模板插值并存。env 节走模板通道（真实使用严格插值），其余节直取或闭包。这不是冗余设计而是**两个消费时机**：render 参数是"组装时的已知值"，`{{}}` 是"输出文本里的占位"——后者是守卫，把任何来源（包括未来插件拼的文本）里的未知占位符拦在 assemble 处 fail-loud。dsh 的 section 体系同样有运行时变量求值与模板两层。

## 4. 两处与 roadmap 的偏差（现状优先，C3 同款裁决）

1. **claude-md section 不存在**。roadmap 设想"loadClaudeMd→claude-md section"，但 mini 的 ch22 设计是 CLAUDE.md 走**首条 user 消息**（`buildUserContextReminder`）与分类器 user 槽——untrusted 仓库内容不进 system。把 CLAUDE.md 挪进 system 是行为变更（请求体结构变化），不属于本章的"等价改造"。@import 防环逻辑原样留在 prompt.ts。
2. **工具 schema 汇入 = deferred 目录页**。dsh 的工具 schema 是 system 里的 surface 节点；Anthropic 线格式里 schema 走请求 `tools` 参数，system 侧只需要 deferred 工具的名字目录（tool_search 机制）。"ToolsService 注册一个 order 靠后的 section"的思想落地为 deferred-tools 节——它确实读 ToolsService 的激活态，逐请求现算。

## 5. 与真框架的差距清单（C7 后）

| 能力 | 真 dsh | mini | 备注 |
|---|---|---|---|
| section 注册表 + order | ✅ SECTION_ORDERS | ✅ | mini 中央表 8 节 |
| 严格插值 | ✅ | ✅ 双通道 | 未知变量抛错 |
| system = 日志 surface 节点 | ✅（多块、in-history 更新、缓存代际） | ❌ 两块结构（静态断点 + 动态） | Anthropic 线格式的断点语义所限 |
| CLAUDE.md 进 system | ✅ 专节 | ❌ user 消息 | ch22 设计，untrusted 隔离 |
| 条件渲染 | ✅ | ✅ render 返回 null | 空白动态块整块不出现 |

## 6. 实现与验证记录

**文件**：`services/system-prompt.ts`、`plugins/prompt-sections.ts`（新增）；`prompt.ts`（拆掉 buildDynamicSystemContext/getGitContext，保留 CLAUDE.md 加载/reminder/静态主体）；`agent.ts`（构造期挂服务+插件+plan 节；`buildAnthropicSystem` 委托 assemble；`staticSystemPrompt` 字段消亡）；`cordis-tests/c7-system-prompt.test.ts`（新增 5 条）。

**验证**：
- `npm run cordis`：**107/107 绿**（C7 新增 5 条：order/null/trim/断点结构、严格插值与冲突、disposer、插件默认形状=buildStaticSystemPrompt、子 agent 单块）
- 全量 mock 回归：**27 场景全绿**——所有 system 相关断言（ch22 memory 索引进 system、ch23 子 agent system 主体、ch26 分类器 track 的 system 匹配、plan 场景的后缀）全走新拼装路径，system 字段等价达成。

**翻车记档**：
1. **本章零红灯**——但等价性险些藏暗礁：第一版把 dynamic 组的 trim 写在"逐节"上（每节各自 trim），拼接后节间分隔符会被剥掉。自测"纯空白动态块不出现"用例时发现 trim 必须在**组级**（与旧 `(...+planSuffix).trim()` 同位）。教训：**从旧代码搬语义时，锚点是表达式的求值位置，不是语义名词**——"trim"这个词哪都能放，`.trim()` 那个位置只有一个。
2. **（设计期）plan 节差一点进插件**：想在 prompt-sections 里加 plan 节（配置传入 mode/planFilePath）——但 mode 是活状态（togglePlanMode 随时改），配置是构造期快照。闭包 render 读实时字段才对。**节读活状态的正确姿势：状态持有者自注册 render 闭包，而不是把状态拍扁成配置**。

## 7. 自测三题（答案在文末）

1. 连接串为什么是空 join 而不是 `"\n\n"`？这个"丑约定"守住的是什么？
2. plan 节为什么由 Agent 自注册而不是进 prompt-sections 插件？换成"配置传 mode"会坏在哪个场景？
3. 严格插值（未知 `{{var}}` 抛错）在什么时机触发？为什么说"静默上线路比炸掉贵"？

> **答案**：
> 1. 守住旧拼接的字节事实——各节内容自带前导分隔符，`join("")` 是对 `${git}${memory}${skills}` 直连的逐字节复刻。若统一用 `"\n\n"` join，节内容里的前导分隔符会翻倍，system 字段逐字节等价立即破。
> 2. mode 是运行时可变状态（REPL /plan、enter/exit_plan_mode 工具都会改），配置是构造期快照——快照会让"进 plan 模式后的下一个请求"继续用旧 mode 渲染，plan 场景（10/25）的 system 断言直接红。render 闭包每次 assemble 现读 `this.mode`。
> 3. assemble() 内、replace 扫到未注册占位符的瞬间。静默风险：占位符原文（`{{cwd}}`）随请求上线——模型看到乱码提示、且没有任何报错指向拼错的键名；炸掉的修复成本是一条错误消息，静默的排查成本是一次真机对话。

## 8. 下章预告（C8 会话持久化 JSONL）

`plugins/session-jsonl.ts`：SessionLog 加 onAppend 订阅逐事件落盘 `~/.mini-claude/sessions/<id>.jsonl`；loadSession 变重放（derive 恢复请求历史 + meta/note 恢复 mode/cost/激活工具——超越旧版 resume）；崩溃修复（半行丢弃、turn/start 无配对补合成 turn/end）；autoSave 快照路径消亡。新场景：save→load→continue 请求体一致 + 崩溃 tail 修复断言。
