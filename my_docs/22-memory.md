# 第二十二章：Memory 重构（进阶轮第 7 章）

## 为什么重构旧记忆系统

ch8 的记忆系统是"关键词打分"：cwd 下 `.mini-memory/`，把 query 和文件内容分词取交集，top-3 注入 system。真机视角下它有三个死穴：

- **语义盲**：查"部署到哪测试"，匹配不到写着 "deploy to staging" 的记忆（同义词全灭，中文更没戏）；反过来一个常见词就误召回。关键词相似 ≠ 语义相关
- **注入位置毒缓存**：召回内容拼进 system → 每轮内容不同 → system 前缀变 → ch20 刚建好的 cache_control 架构整段作废。缓存按"前缀逐字节没变"命中，把易变内容放进前缀是自毁
- **无隔离无类型无索引**：所有项目混一个目录；没有 user/feedback/project/reference 的分工；记忆多了模型不知道"自己记得什么"

本章换成 Claude Code 的公开设计：**4 类型文件记忆 + 项目隔离 + MEMORY.md 索引 + 语义召回 selector + 异步 prefetch 注入**（对齐 src/memory.ts 392 行）。

## 全景与数据流

```
写入路径（模型主动）：
  模型 write_file → 记忆目录/.md（YAML frontmatter: name/description/type）
                  → tools.ts autoUpdateMemoryIndex → updateMemoryIndex() 重建 MEMORY.md
                  （索引机器维护，模型绝不手动改）

召回路径（每轮自动）：
  chat() turn 边界 ── startMemoryPrefetchForTurn
    ├─ 排水：上一轮遗留的 prefetch 若已落定，现在消费（不排就丢）
    └─ 三道门：isQuerySubstantial（CJK≥2 或多词）→ 会话预算 <60KB → 目录有记忆
         全过 → 发起异步 selector（sideQuery：非流式/temp 0/256tok）
  while 顶（每次请求前）── consumeMemoryPrefetchIfReady（非阻塞轮询）
    └─ settled 且未消费 → 记忆内容注入末条 user 消息（<system-reminder> 包裹）
       + alreadySurfacedMemories 记账 + sessionMemoryBytes 累计

system 静态拼装：
  buildDynamicSystemContext() 追加 buildMemoryPromptSection()
    = 说明（4 类型/怎么存/别存什么）+ 当前索引（name/type/description 一行一条）
```

- 目录：`~/.mini-claude/projects/<sha256(cwd)前16>/memory/`——项目隔离；HOME 惰性求值规矩不变
- 两级节流：单文件 4KB 截断、会话累计 60KB 封顶（`MAX_SESSION_MEMORY_BYTES`）
- 索引本身也有帽：200 行 / 25KB（`loadMemoryIndex` 截断）

## 设计点（写之前想清楚）

**1. system 与注入的分工（本章最核心的权衡）**：索引（每条的 name/type/description）进 system，内容进末条 user 消息。为什么这样切？模型需要**随时**知道自己"记得什么"才能主动保存/引用——这要求索引常驻 system；而索引行是短描述，体量稳定，破坏缓存有限。反过来内容体量大、是否注入每轮都变，放进 system 前缀等于每轮都可能作废整段缓存。注入末条 user 消息还有个白赚的好处：天然保持 user/assistant 交替不变式（追加 text 块，不新增消息）。

**2. 为什么要花一次 selector 调用**：语义匹配的正确姿势就是让模型自己选。契约三条：JSON `{"selected_memories": [...]}`、最多 5 条、**fail-closed**——响应里正则抠不出 JSON、或抠出的文件名对不上清单，都静默返回空（召回失败绝不能挡主循环，也绝不误注入）。temperature 0 保证同输入同输出。用 sideQuery 而非主循环：独立小请求（256 tok 上限），不带工具不带历史，主对话历史一个字节不动。

**3. prefetch 异步状态机**：selector 是一次真 HTTP 调用，如果同步 await，每个 turn 都要多等一个 RTT。prefetch 把它**发射后不管**：`{promise, settled, consumed}` 三字段句柄，主循环每次请求前非阻塞轮询，落定了才消费。两个状态位各司其职：`settled` = promise 完成了没（`.then` 里置位）；`consumed` = 这次结果用掉了没（防同一份结果注入两次）。跨轮的关键动作是**排水**——`startMemoryPrefetchForTurn` 开头先消费上一轮遗留：selector 若在上一轮最后一次 API 调用后才落定，不排走就永久丢了。

**4. 三道门的顺序就是成本顺序**：isQuerySubstantial（纯字符串判断，"hi" 这种寒暄直接出局）→ 会话预算（比较一个数字）→ 目录有记忆（一次 readdir）。全都过了才发 HTTP。注意 `getMemoryDir()` 有 mkdir 副作用——空目录的"没有记忆"是正常态，不算错误。

**5. alreadySurfacedMemories 防重复**：selector 只看描述不看注入历史，同一条记忆每轮都会被选回来。按**文件绝对路径**记账（filename 会撞，绝对路径不会），一个会话只注入一次；注入后累计 `sessionMemoryBytes`，逼近 60KB 就让后续 turn 的门直接关掉。

**6. freshness 新鲜度**：记忆是**时点观察**不是实时状态。>1 天的记忆注入时带头部警告（"claims about code behavior may be outdated"）——昨天记的"这个函数有 bug"今天可能已经被修了。≤1 天则用轻量的 `Memory (saved today):` 标注。`memoryAge` 的天数计算用 `Math.floor((now-mtime)/86400000)`，别用字符串比日期。

**7. 写时重建索引（tools.ts 接线）**：模型用 write_file 写记忆文件后，`autoUpdateMemoryIndex(absPath)` 检查路径落在记忆目录内且是 .md 且不是 MEMORY.md 本身 → 调 `updateMemoryIndex()` 全量重建。src 在这里用正则重解析 frontmatter——那是一个历史 bug 的伤疤（`require()` 在 ESM 里静默 throw 被外层 catch 吞掉，索引长期没重建过）。my_src 直接从 memory.ts 导出 `updateMemoryIndex` 复用 `parseFrontmatter`——一份解析逻辑，别处不重写。**用 resolve 后的绝对路径做 startsWith 判断**（input.file_path 可能是相对路径，startsWith 绝对目录会漏）。

**8. frontmatter.ts 复习点**：ch16 写的 `parseFrontmatter`/`formatFrontmatter` 就是为这章准备的——saveMemory 用 format 存，listMemories/scanMemoryHeaders 用 parse 读。这一章它终于有了第二个用户。

## mock 场景说明（ch8 迁移）

- **setup**：按运行时同款 `sha256(dir)` 前缀算出记忆目录，预置 project_deploy.md（内容含 staging.example.com）+ user_color.md（无关记忆）。**hash 必须与 process.cwd() 一致**——driver `process.chdir(workdir)` 之后 agent 的 `getProjectHash()` 才对得上
- **tracks 支持函数形式** `(dir) => tracks`：脚本化的 write_file 要写进记忆目录，路径含动态 hash，必须等 workdir 生成后才能算（driver 3 行改动）
- **main track 两轮**：t0 让模型写 user_editor.md（新记忆）+ 读 dummy.txt；t1 收尾文本。**t0 的真实作用是给 selector 留确定的落定窗口**——t0 请求发出时 poll 必然 settled=false（回环 RTT >> 微任务间隔），t0 响应+工具执行的毫秒级窗口足够 selector 回来，t1 的 while 顶 poll 稳定注入
- **memory aux track**：`match: "selecting memories"`（SELECT_MEMORIES_PROMPT 的开头——selector 的 system，与主请求的 "# Memory System" 互不包含，无歧义），返回 JSON 契约选 deploy
- **九断言**：selector 一次（非流式/单消息）；manifest 带查询和两条候选；t0 system 有 Memory System 说明但**无索引**（MEMORY.md 是首次写才诞生的）；t0 无注入（prefetch 在途）；t1 注入进末条 user 消息（staging URL + system-reminder + saved today）且 system 里没有 URL（内容 vs 描述的分界）；未选中记忆的内容全程不入上下文；新记忆文件落盘；重建后的索引（含新条目和旧记忆的描述）出现在 t1 system；磁盘 MEMORY.md 格式正确

## 分步提示（回补时照此重写）

1. `memory.ts` 骨架：类型（MemoryType/MemoryEntry/SideQueryFn/RelevantMemory/MemoryHeader/MemoryPrefetch）→ 路径（getProjectHash/getMemoryDir/getIndexPath，**惰性求值**）→ slugify
2. CRUD：listMemories（parseFrontmatter、缺 name/type 跳过、非法 type 落 project、mtime desc）→ saveMemory/deleteMemory（都顺手 updateMemoryIndex）
3. 索引：updateMemoryIndex（导出给 tools.ts！）→ loadMemoryIndex（200 行/25KB 双帽截断）
4. 轻扫描：scanMemoryHeaders（**只读前 30 行** frontmatter，200 文件帽）→ formatMemoryManifest（一行一条：`- [type] filename (ISO时间): description`）
5. 召回：SELECT_MEMORIES_PROMPT（锚点 "You are selecting memories"）→ selectRelevantMemories（**全包 try/catch 返回 []**；正则 `/\{[\s\S]*\}/` 抠 JSON；文件名映射回 headers；≤5、4KB 截断、freshness 头）→ isQuerySubstantial → startMemoryPrefetch（三道门 + settled 置位句柄）
6. 注入与 system：formatMemoriesForInjection（system-reminder 包裹）→ buildMemoryPromptSection（说明+索引，前导 \n\n）
7. `prompt.ts`：buildDynamicSystemContext 追加 memorySection；buildSystemPrompt 拆成 buildStaticSystemPrompt（缓存）+ 动态块
8. `tools.ts`：import getMemoryDir/updateMemoryIndex → autoUpdateMemoryIndex（startsWith/endsWith 判断）→ write_file 的 writeFileSync 后一行接线
9. `agent.ts`：三字段（memoryPrefetch/alreadySurfacedMemories/sessionMemoryBytes）→ buildSideQuery（create 非 stream/temp 0/256tok/text 块拼接）→ consumeMemoryPrefetchIfReady（三条件短路→注入→记账）→ startMemoryPrefetchForTurn（先排水再发起）→ chat() 两处接线（turn 边界 + while 顶）→ buildAnthropicSystem 双块化（去 userText 参数、去 recallMemories 尾巴）
10. `npm run build` → `node run-mock.mjs 8` → 全量回归

## 收尾记录（2026-09-20，代填轮）

- **本轮模式**：延续 ch21，用户要求"设计好教学 + 开发好代码 + commit message"。讲解逐处入档供回补
- 交付：memory.ts 全量重写（对齐 src/memory.ts）+ prompt/tools/agent 三处接线 + mock 驱动改造（lastUserText 字段、tracks 函数形式）+ ch8 迁移九断言。回归 **17/17 绿**（ch8 九断言 + 其余 16 章全绿）

### 代填逐处讲解（回补时重点读）

1. **getProjectHash/getMemoryDir**：`createHash("sha256").update(process.cwd())` 取 hex 前 16 位。惰性求值是硬规矩——提为模块常量的话 mock 的 HOME/chdir 沙箱就废了（ch17 教训的镜像）
2. **listMemories 的容错语义**：单文件 try/catch 跳过（坏文件不炸全列表）；缺 name 或 type 直接 continue（半成品文件不算记忆）；type 不在四类里**落到 project** 而不是丢弃（宽松入库）。排序用 statSync mtime——读两次盘换稳定排序，值
3. **selectRelevantMemories 的 fail-closed 细节**：正则抠 JSON 容忍 markdown 代码块包裹；`parsed.selected_memories || []` 容忍缺字段；`candidates.filter(h => filenameSet.has(h.filename))` 让**幻觉文件名自然过滤**（不 validate、不报错、就是选不上）；`slice(0,5)` 硬帽在映射之后（模型返回 10 条也只取 5）
4. **consumeMemoryPrefetchIfReady 的注入分支**：末条是 user 且 content 是 string → 字符串拼接；是数组 → push text 块；末条不是 user（理论上不发生）→ 单独 push 一条 user 消息兜底。三个分支都是为了让注入后的历史仍然合法（user/assistant 交替）
5. **buildSideQuery**：`client.messages.create`（**非 stream**——selector 是决策调用，不需要打字机效果，mock 断言 `stream === false` 锚的就是这个）；temperature 0；filter text 块再 join（工具调用响应没有 text 块，返回空串→fail-closed）
6. **buildAnthropicSystem 双块化**：static（STATIC_CORE，cache_control）+ dynamic（环境+memory 索引，无断点）。这是对 ch20 单块结构的修正：memory 索引会随写记忆变化，进了缓存块等于每次写记忆作废整段缓存。src 同款两块结构。`buildSystemPrompt` 合并函数就此退役
7. **prompt.ts 接缝**：memorySection 带前导 `\n\n`——src 的 `${gitContext}${memorySection}` 直接连排是它的格式瑕疵（Git status 行尾直接粘上 # Memory System），my_src 修正之；gitContext 前保留显式 `\n`（my_src 的 getGitContext 不带前导换行，与 src 不同）

### 场景设计两次翻车（教学价值最高的部分）

1. **索引的时序假设错了**：初版断言 t0 的 system 里就有 "Deploy target"（索引描述）——实际上 setup 只写了记忆**文件**，MEMORY.md 是首次 write 后才由 autoUpdateMemoryIndex 诞生的，t0 时 loadMemoryIndex 返回空串 → system 显示 "(No memories saved yet.)"。修正为：t0 断言"有说明无索引"，t1 断言"重建后新旧条目都在"。教训：断言前先问"这个文件此刻**真的存在吗**"——写入方是谁、什么时候触发
2. **磁盘断言漏了 `**`**：索引行格式是 `- **[name](file)** (type) — desc`，断言写成 `[My favorite editor](user_editor.md) (user)` 中间断了一层加粗标记，永远匹配不上。教训：断言锚定的字符串要从**生成代码**里抄，不要凭记忆手打

### 遗留与预告

- **回补自查题**（重写完口答）：①为什么 selector 的结果"选不上"比"选错了"安全？②alreadySurfacedMemories 若改记 filename 不记绝对路径，什么时候会误判？③T4 压缩（ch21）和 memory 注入都改历史，谁先谁后？为什么（提示：chat() 里两处接线的位置）
- sub-agent 无 isSubAgent 门：src 有（isSubAgent 跳过召回）；my_src 的 runSubAgent 不走 Agent.chat，召回天然不触发——结构差异，不用补
- CONCURRENCY_SAFE_TOOLS 提前执行继续顺延（不阻塞 23）
- 真机冒烟观察点（下次）：让真模型写一条记忆 → 查 `~/.mini-claude/projects/` 落盘与索引重建；换个 query 看语义召回是否比关键词版准；>1 天记忆的 freshness 头（手工 touch 一个旧 mtime）
- 沙盒 `test20-smoke/` 仍可清理
- 下一章 **ch23：Sub-agent 与 Skills 完整版**（3 类型+白名单+自定义 agents、SKILL.md fork/inline、$ARGUMENTS）——subagent.ts/skills.ts 是主体，frontmatter.ts 继续复用

**commit message 建议**：`add typed project memory with semantic recall and index rebuild`
