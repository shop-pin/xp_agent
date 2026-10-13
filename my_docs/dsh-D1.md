# dsh-D1 skills 插件化（D 阶段开篇）

> 本章产物：`plugins/skills-registry.ts`（SkillRegistry 服务 + user/project 两个文件 provider + 目录注入 pre-step 监听器）；skills.ts 收缩为纯函数层（解析/$ARGUMENTS/目录文本）；system 的 skills 节消亡——**catalog 改 user message**；场景 9 断言变更（正反两面锚）。
> 一句话：**描述进目录（user message），正文按需加载（skill 工具），来源进 provider（rank 竞争）**。
> 参照物：`packages/skill/` 的三层分工。

---

## 1. 三层化

| 层 | 旧（skills.ts 模块函数） | 新（plugins/skills-registry.ts） |
|---|---|---|
| 竞争 | discoverSkills 按加载顺序 Map.set 覆盖（user 先、project 后） | SkillRegistry：provider 注册（source 唯一）+ rank 竞争——user=10、project=20，**高 rank 后写胜** |
| 发现 | 模块级缓存（discoverSkills 一次进程） | 每次 list() 现扫（缓存消亡——registry 视图永远新鲜，目录几个 statSync 的微成本） |
| 注入 | buildSkillDescriptions 拼 system（C7 的 skills 节） | pre-step 监听器：会话首批输入（historyEmpty）末项追加 `<system-reminder>` 包裹的 catalog |

rank 的语义就是"谁覆盖谁"的显式化：旧的"加载顺序即优先级"是隐式契约，新代码里 `rank: 20 > rank: 10` 一眼可查、可测试（cordis 单测直接断言摘除高层后回退低层）。

## 2. catalog 迁居 user message（断言变更）

**变更**：`# Available Skills` 清单从 system 的动态块挪到首条 user 消息末尾，`<system-reminder>` 包裹（skill 描述与 CLAUDE.md 同属不可信仓库内容，同款待遇）。子 agent 不注入（system/白名单已定界，`catalogInjection: false`）。

**动机**（对齐 dsh）：system 的静态块是**缓存前缀**——技能清单进 system 意味着每次扫描结果变化（加一个 skill）都作废整个前缀缓存；进 user 消息则只影响当次请求。附赠：目录随会话历史持久化（C8 的日志里 user/message 事件原样带走了它，resume 后不再重复注入——historyEmpty 判定天然正确）。

**为什么挂在 pre-step**：C5 埋的事件第一次回报——注入是"对输入的改写"，正是 pre-step 的职责形状。不需要动 agent.ts 一行循环代码。

**场景 9 断言变更说明**：新增正面断言（firstUserText 含 `# Available Skills` 与 `/commit` 条目、`<system-reminder>` 包裹）与反面断言（system 不再含 `# Available Skills`）；原有 tool_result 断言（模板激活、$ARGUMENTS 展开、Unknown skill）零改动通过。

## 3. 翻车：around 中间件的礼仪

本章的真实事故值得单独一节。注入监听器第一版：

```ts
ctx.on("agent/pre-step", (payload, next) => {
    next();                                    // ← 调了，但丢了返回值
    if (...) return { input: payload.input };  // ← 无条件返回自己的 passthrough
    ...
});
```

场景 28 的 reject 探针当场揭发：**场景监听器的否决（不调 next、返回 reject）被 skills 监听器的 passthrough 翻案**——输入照常进消息，"拒绝零模型调用"断言爆红。这不是 skills 的 bug，是 waterfall 的礼仪问题：**调了 next() 就必须以 inner 的裁决为基线**——上游拒绝，你只能拒绝或加严，不能当没看见。修法：

```ts
const inner = next();
if (inner.reject !== undefined) return inner;   // 否决链不能被注入翻案
const input = [...(inner.input ?? payload.input)];  // 在 inner 改写的基础上追加
```

与 C2 的 monotonic guard 同源：around 链里"善意的中间件"最容易犯的不是恶意改写，而是**好心办坏事的覆盖**。cordis 单测立刻补了否决传播的断言（d1 测试的 reject 场景）。

## 4. 实现与验证记录

**文件**：`plugins/skills-registry.ts`（新增）；`skills.ts`（收缩：discoverSkills/loadSkillsFromDir/getSkillByName/executeSkill/缓存消亡，buildSkillDescriptions 参数化）；`services/agents.ts`（pre-step payload 增 `historyEmpty`）；`agent.ts`（skills 插件挂载 + `skills` getter + executeSkillTool 查 registry）；`plugins/prompt-sections.ts`（skills 节删除）；`cli.ts`（/skills 与 /<name> 走 `agent.skills`）；`cordis-tests/d1-skills.test.ts`（新增 5 条）；场景 9 断言升级。

**验证**：cordis **117/117**（D1 新增 5 条：rank 竞争与回退、source 冲突、注入三态（末项追加/非首批不注/无 skills 原样）+ **否决传播**、子 agent 不注入、目录文本参数化）；mock **28 场景全绿**（9/23b 的 fork/inline 链路 + 场景 4 的 resume 路径都经 registry）。

**翻车记档**：
1. **around 礼仪事故**（第 3 节正文）——场景 28 揭发、单测钉死。
2. **废稿测试混进交付**：d1 测试第一版中段有一个自我怀疑的占位用例（写了 `assert.ok(true)` 的半成品），重写时整段清掉。教训：**对测试文件也要 review 一遍"这段在测什么"**——占位用例比没有用例更糟，它制造覆盖假象。
3. **（观察）场景 27 的偶发**：批跑一次失败、单跑与复跑全绿——Windows 下 abort 与未决句柄的 libuv 竞态旧疾（C4 期见过一次）。本次未复现，记档观察；若再现，方向是 mock close 时 drain 在途请求。

## 5. 自测三题（答案在文末）

1. rank=20 的 provider 摘除后，同名 skill 落到 rank=10 的版本——这个"回退"为什么是 registry 的性质而不是文件系统的性质？
2. catalog 进 user message 后，为什么加一个 skill 不再作废前缀缓存？代价是什么？
3. 注入监听器为什么必须读 `inner.input ?? payload.input` 而不是只读 payload.input？

> **答案**：
> 1. 因为解析视图每次 list() 都从 provider 全集现算（Map 逐层写入，高 rank 后写胜）——没有"已合并的缓存结果"可供污染。文件系统只提供原料，竞争与回退是 registry 的投影语义。
> 2. system 静态块是缓存前缀的一部分，清单在里面则清单变=前缀变；user 消息在断点之后按全价计。代价：目录文本进会话历史（token 上它从此常驻——所以只注一次，且 resume 不重复）。
> 3. 监听器链里上游可能已经改写过输入（重写、规范化）——inner.input 是**链上当前的最终形态**，payload.input 是链头快照。只读 payload 会把上游的改写静默回滚——和吞掉 reject 是同一类礼仪错误。

## 6. 下章预告（D2 MCP 插件化）

`plugins/mcp-bridge.ts`：McpManager 迁入插件；`mcp__<server>__<tool>` 命名抽成纯函数（64 字符规范化 + 碰撞加 SHA 后缀，照 `mcp-client/src/tools.ts`）；syncTools 两代切换（先建新代再撤旧代）；execute 走 callTool。验收：mcp 场景绿 + 名字规范化单测（超长/非法字符/碰撞）。

## 7. 代码执行流程图

> 对应提交 `fb05f72`。四条主线：provider registry（rank 竞争）→ 插件挂载与目录发现 → pre-step catalog 注入（waterfall 礼仪）→ skill 双入口分流（fork / inline / slash 同源）。

### 7.1 provider registry：rank 竞争的解析视图

```
SkillRegistry extends Service：
  providers: SkillProvider[]              source 唯一——重复注册直接 throw
  registerProvider(p) → () => void        返回退订函数（active 旗标防二次退订）
  list():
    byName = new Map
    for p of providers.sort(rank 升序):   ★ user=10 先写、project=20 后写
      for s of p.list(): byName.set(s.name, s)   同名高 rank 后写胜
    return [...byName.values()]           ——每次现算，没有"已合并的缓存"可被污染
  getByName(name) → list().find(...)       单点查询与注入目录同一份视图

skills.ts 收缩后的纯函数层（被 registry 与 agent 两头调用）：
  parseSkillFile   SKILL.md → SkillDefinition（frontmatter 解析）
  resolveSkillPrompt(skill, args)  正文 $ARGUMENTS 展开
  buildSkillDescriptions(skills)   参数化了！目录文本从"自扫目录"改"吃入参"
```

### 7.2 插件挂载：两个 provider + 子 agent 分岔

```
Agent 构造：
  this.cordis.plugin(skillsPlugin, { catalogInjection: !this.isSubAgent })
                                          ★ 子 agent 关目录注入——system/白名单已定界
  get skills() → cordis.require("skills")  CLI 侧句柄（/skills 与 /<name> 都走它）

skillsPlugin.apply(ctx, config)：
  reg = new SkillRegistry(ctx, "skills")
  registerProvider({ source:"user",    rank:10, list: () → scanSkillDir(~/.claude/skills) })
  registerProvider({ source:"project", rank:20, list: () → scanSkillDir(cwd/.claude/skills) })
  config.catalogInjection === false？ → return     ★ 子 agent 到此为止：只有 registry，无注入

scanSkillDir（自 skills.ts 原样迁入）：
  existsSync？否 → []    readdirSync 失败 → []    statSync 抛（坏符号链接）→ 跳过该 entry
  只处理目录（散文件跳过）→ 有 SKILL.md？→ parseSkillFile → 收集
  ★ 每次调用现扫——旧模块级缓存消亡，换 registry 视图永远新鲜
```

### 7.3 pre-step 注入：catalog 挂首条 user 消息

```
services/agents.ts：pre-step payload 增 historyEmpty = (this.messages.length === 0)
  ——首批输入的锚点；steer 路径硬编码 historyEmpty: false（中途不重注）

ctx.on("agent/pre-step", (payload, next) → {
  const inner = next()                     ① 先放行，取链上最终裁决
  if (!payload.historyEmpty
      || inner.reject !== undefined) return inner
                                           ② 非首批 / 上游否决 → 原样尊重（礼仪！）
  const catalog = buildSkillDescriptions(reg.list())
  if (!catalog) return inner               ③ 无 skills → 输入原样
  input = [...(inner.input ?? payload.input)]
                                           ④ 吃 inner 的改写形态——只读 payload
                                             会静默回滚上游中间件
  input[末项] += "\n\n<system-reminder>\n" + catalog + "\n</system-reminder>"
  return { input }                         ⑤ 只改输入；不调 reject（注入无否决权）
})

对照翻车现场（第一版）：next() 调了但丢返回值、无条件返回自己的 passthrough
  → 场景 28 的 reject 探针被翻案。修法只加两处：读 inner、以 inner 为基线。
prompt-sections.ts：skills 节删除——system 不再含 "# Available Skills"
```

### 7.4 skill 双入口分流：一个 registry，两条路

```
入口 A —— 模型调 skill 工具（agent.ts executeSkillTool）：
  skill = cordis.require("skills").getByName(input.skill_name)
  null → return `Unknown skill: <name>`
  prompt = resolveSkillPrompt(skill, input.args)
  skill.context === "fork"？
    ├─ 是 → 白名单过滤父工具集（allowedTools；agent/schedule_wakeup 强制摘除）
    │       new Agent({ customSystemPrompt: prompt, customTools, isSubAgent: true })
    │       subAgent.runOnce(args) → 结果作为 tool_result 回主对话
    └─ 否（inline）→ return `[Skill "<name>" activated]\n\n<prompt>`
            tool_result 进主对话 → 模型看到后照做

入口 B —— 用户 slash 直调（cli.ts）：
  /skills        → agent.skills.list()            列目录
  /<name> args   → agent.skills.getByName(name)
                   → resolveSkillPrompt → agent（与工具同源 registry，无第二份解析）

  ★ 旧 discoverSkills/getSkillByName/executeSkill/缓存 全部消亡——
    工具、slash、注入目录三处消费同一 registry 的同一 list()
```

### 7.5 完整时序走查：场景 9（inline 激活 + Unknown skill）

```
setup：.claude/skills/commit/SKILL.md（description: Create a conventional commit
message；正文 Write a conventional commit message for: $ARGUMENTS）
prompt："Invoke the commit skill with args: fix the login bug. Then invoke the
nosuch skill."

req0 前置：Agent 构造 → skillsPlugin 挂载（main agent，catalogInjection=true）
  首步 runOneTurn → pre-step waterfall，historyEmpty = (messages.length===0) = true
  skills 监听器：inner = next() 无 reject → catalog = "# Available Skills\n\n
  - **/commit**: Create a conventional commit message" → 首条 user 消息末尾追加
  <system-reminder> 包裹的目录

req1（模型第 1 调）：
  ✓ 正面锚：firstUserText 含 "# Available Skills"、"- **/commit**: ..."、
    "<system-reminder>"
  ✓ 反面锚：system 不含 "# Available Skills"（skills 节已消亡）
  → tool_use skill{ skill_name:"commit", args:"fix the login bug" }
  executeSkillTool：getByName("commit") 命中（project provider rank=20 现扫所得）
  → resolveSkillPrompt 展开 $ARGUMENTS → context=inline
  → tool_result `[Skill "commit" activated]\n\nWrite a conventional commit
    message for: fix the login bug`（无 $ARGUMENTS 残留）

req2（模型第 2 调）：
  toolResults 含上述激活模板 ✓ / $ARGUMENTS 已替换 ✓
  → tool_use skill{ skill_name:"nosuch" } → getByName → null
  → tool_result `Unknown skill: nosuch`

req3（模型第 3 调）：
  toolResults 含 "Unknown skill: nosuch" ✓ → 文本 "Done." → end-turn
  ✓ 三次 model call 收敛（reqs.length === 3）

（fork 分支不走本场景——场景 23b：fork 子 agent 用解析后模板当 system、白名单
工具集，且因 isSubAgent=true 挂载时无 pre-step 注入监听器）
```
