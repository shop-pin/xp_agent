# S4：/news-brief 消息技能（P2 阶段收官）

> stock 课程第四章。总纲见 `stock-00-plan.md` §四（P2 阶段）。
> 交付：`skills/news-brief/SKILL.md`（product 层，token 硬预算条款）+ news.jsonl 折叠（S3 的 deferred 收口）+ 3 条 cordis 测试 + mock 场景 36（token 预算锚）。
> 验收线：mock 场景锚 token 预算 ✅（30 条池 limit=15 生效 + 输出长度上限）/ cordis 212/212 / mock 31 场景 / snapshot 31/31 ×2。

---

## 1. 本章要解决的问题

第二步需求的模型面收口：新闻流有了（S3），但直接把 20 条快讯甩给用户不是"简报"。`/news-brief` 做三件事：**摘要、个股关联、情绪分级**——并且要带 token 纪律（总纲 §五：过滤层不设上限=烧钱事故）。

顺带收掉 S3 的 deferred：news.jsonl 无界增长。

## 2. 设计讲解

### 2.1 token 预算：写进模板的硬条款 + 场景断言的双重锚

预算的执行分两层：

1. **模板层**："latest_news **一次取数，limit 不超过 15**——这是硬预算，不许为了'更全'多拉"。技能正文是模型的行为约束。
2. **验收层**（场景 36 断言）：mock 池 30 条 → 工具结果**恰 15 行** + 输出总长 <4000 字符。模板是"劝"，断言是"钉"——模板被人改动放松了预算，场景不会红（它锚的是工具行为，模型照旧 limit 15）；但**取数层若无上限**，这里立刻红。

分层的原因：提示词不是硬约束（模型可能不听），真正的硬闸是工具参数默认值/上限（filterNews 的 limit 上限 50）。模板把模型的"意愿"压到 15，工具把"能力"压到 50，两层之间的空隙就是防御纵深。

### 2.2 产出结构：三段式 + 防火墙条款

```
1. 要闻速览   5–10 条，每条 ≤40 字，带时间戳，宏观/行业/公司自然分组
2. 个股关联   逐只一行：代码 名称 方向[利好|利空|中性] 一句理由——只关联真实出现的
3. 整体情绪   偏多|偏空|中性 三选一 + 条数结构依据
```

与 /brief 同款边界条款："不给买卖点和仓位建议——那是信号与裁决环节的职责"。P2 两个技能（brief/news-brief）都只报事实与结构化观察，**判断权留给 P3**——提示词层防火墙在 S6/S8 会有代码层对应物。

### 2.3 空参分支：watchlist 优先

`$ARGUMENTS` 为空 → 先 `get_watchlist`：有清单用 codes 过滤（关注自家持仓相关），无清单落全流要闻。这让 /news-brief 和 /brief 共享同一份自选股语义——用户维护一次清单，两个技能都受益。

### 2.4 news.jsonl 折叠：保半而不是截尾

```ts
maybeCompact(): size < maxStorageBytes(默认 2MB) → return
               lines.slice(floor(n/2)) 重写   // 丢最旧一半
```

**折半而非截到固定条数**：若每次折叠都回到固定水位，追加很快又触顶，重写频率与流入速率成正比（抖动带）；保半让触发间隔随剩余容量指数增长——均摊 O(1)。折叠不清去重集（seen 在内存），同页重拉仍零新增（测试钉住）。

## 3. 实现走查

| 文件 | 内容 |
|---|---|
| `my_src/skills/news-brief/SKILL.md` | 技能本体（inline；allowed-tools=[latest_news, get_watchlist]；三段产出 + 硬预算 + 防火墙条款） |
| `my_src/plugins/news-feed.ts` | `maybeCompact` 折叠（config `maxStorageBytes` 默认 2MB）+ 头注记档更新 |
| `my_src/cordis-tests/s4-newsbrief.test.ts` | 3 测试：技能在场+预算条款钉模板 / 折叠保半+去重集不受影响 / 上限内不误伤 |
| `my_src/run-mock.mjs` | 场景 36 + newsBriefProbe 分支（skills+market+news 三行 extraRows，全 mock 零网络） |

装配零接线：product 技能层（S2）自动发现 `my_src/skills/news-brief/`——stock profile 的目录注入自动多出 `/news-brief`，**config 一个字没改**。这就是 S2 基建投资的第一笔回报。

## 4. 翻车记档

1. **mock 数据违反源契约**（rotation 测试红）：`fetchLatest` 契约是**新→旧**，我的 `items(30)` 生成序恰好老→新——折叠"保新"变成"保旧"，断言'最新的保住了'抓到 id0。修：生成后反转。教训：**给带方向性契约的接口造 mock，先默写一遍方向**（内存环新→旧、落盘老→新、fetchLatest 新→旧——三个方向在 S3 文档里都有，造数前翻一眼）。
2. **泛锚找错 tool_result**（场景 36 断言红）：`.find(t => t.content.includes("快讯"))` 命中了**技能模板正文**——模板里也有"快讯"二字（"快讯是事件流"）。修：锚 latest_news 独有的头行 `/快讯 \d+ 条（内存/`。教训：**内容断言的锚必须是被测面独有的字符串**——公共词汇会跨 tool_result 串门。
3. **最小装配漏了工具的宿主插件**（场景 36 断言红）：get_watchlist 注册在 market-data 插件——技能空参分支要读清单，最小装配没挂 market 行 → "Unknown tool: get_watchlist"。修：补 market 行（34 场景同款 mock 源）。教训：**allowed-tools 列表就是装配需求清单**——技能声明用谁，场景就得把谁的宿主插件摆上桌（与 S3-4-1 的 inject 摆桌同构，一个是服务依赖一个是工具依赖）。
4. **新增 product 技能改变存量快照**：ch34 重录——场景 34 的目录注入多了 `/news-brief` 行。这不是事故是语义：product 目录是共享面，**每加一个技能 = 全部 productSkills 装配的目录变化**，相关快照要跟着录。S5+ 再加技能时先想着这笔账（记入章末纪律）。

## 5. 验证记录（终态）

| 线 | 结果 |
|---|---|
| cordis | **212/212**（209 + 本章 3） |
| mock | 31 场景全绿（30 + 场景 36） |
| snapshot | **31/31 × 2 轮**（ch36 新录；ch34 因目录演进重录） |
| 装配 | config 零改动——product 层自动发现新技能 |

## 6. 代码执行流程图

### 6.1 /news-brief 调用链（REPL 斜杠或 skill 工具）

```
用户: /news-brief [args?]
  └─ resolveSkillPrompt(news-brief, args)
  └─ inline 注入主对话
       模型读模板：
         args 空 ──► get_watchlist
                      ├─ 有清单 → codes 过滤
                      └─ 无清单 → 全流要闻
         args 有 ──► query/codes 过滤
  └─ latest_news {query?/codes?, limit: ≤15}      ← token 硬预算
  └─ 三段产出：要闻速览 / 个股关联 / 整体情绪
  └─ "消息面简报，非投资建议。"
```

### 6.2 折叠（appendToFile 尾部）

```
appendFileSync(batch 老→新)
  └─ maybeCompact():
       statSync.size < 2MB ──► return（绝大多数轮次零开销）
       超限 ──► 读全行 → slice(n/2) 丢最旧半 → writeFileSync
                （seen 不动——去重集在内存；下轮重启 loadFromDisk 读到的就是折叠后尾部）
```

### 6.3 完整时序走查（mock 场景 36）

```
agent = Agent({extraRows:[
  skills ← {productSkills:true},      // 目录注入 brief + news-brief
  market ← MockQuoteSource,           // get_watchlist 的宿主（空清单→引导）
  news   ← MockNewsSource(30 条)]})   // 30 条池，验证 limit
chat("Invoke the news-brief skill with no args.")
 req1  user+catalog(含 /news-brief) ──► skill{news-brief,""}
 req2  ──► get_watchlist{} → "No watchlist yet…"（空清单引导分支）
 req3  ──► latest_news{limit:15} → "快讯 15 条（内存 30 条…）"+15 行
 req4  ──► "news brief delivered."
断言：目录行 / 模板激活 / 引导分支 / 15 行恰数 / 长度<4000 ✓
```

## 7. 交付与 commit

- 建议 commit：`add news brief skill with token budget and feed rotation`
- 手测清单（用户终端，随时可测）：
  1. `node dist/cli.js --profile stock` 进 REPL；
  2. `/news-brief`——无清单时期望它转告创建指引后仍给全流简报；建好 watchlist 后期望个股关联段优先覆盖自选股；
  3. `/news-brief 锂`——期望 query 过滤的定向简报；
  4. 连续跑几轮后查 `~/.mini-claude/stocks/news.jsonl` 增长（2MB 内不折叠，长期使用后观测折叠水位）。

## 8. 自测题

1. token 预算的"模板劝"与"工具钉"各防什么？如果只有模板层（工具 limit 上限 50 不变），哪类失效它防不住？如果只有工具层，日常体验会差在哪？
2. 折叠为什么保半而不是"截到固定 1000 条"？用"流入速率恒定"前提算一下两种策略的重写频率量级差。
3. §4-4 说"每加一个 product 技能 = 全部 productSkills 装配的目录变化"。如果不重录 ch34 而是改 snapshot 规范层（把目录行排序/过滤掉），会失去什么锚定能力？
4. /news-brief 与 /brief 的边界条款几乎同文（不给建议）。到 S6 裁决技能出现时，这两个技能的"事实面"输出如何成为裁决的输入？设计上它们应该输出结构化数据还是自然语言，为什么？
5. §4-2 的"锚必须独有"与 S3-4-2 的"校验往窄倒"是同一类设计原则吗？各用一句话说出它们的共同抽象。
