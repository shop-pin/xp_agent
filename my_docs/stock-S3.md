# S3：新闻插件（消息面开张）

> stock 课程第三章。总纲见 `stock-00-plan.md` §四（P2 阶段）。
> 交付：`plugins/news-feed.ts`（NewsSource 接缝 + NewsFeedService 轮询/去重/JSONL + latest_news 工具）+ `--profile stock` 增 news 行 + 6 条 cordis 测试 + fixture + mock 场景 35 + 真机冒烟脚本。
> 验收线：去重单测 ✅ / 真接口冒烟 ✅（270ms 拉一页 20 条）/ cordis 209/209 / mock 30 场景 / snapshot 30/30 ×2（ch35 新录）。

---

## 1. 本章要解决的问题

第二步需求"实时获取最新市场消息"。拆三个子问题：

1. **源**：财联社要签名参数（弃），新浪财经 7x24 直播流 node 直连可达（S1 同款 WAF 筛选的幸存者）——`zhibo.sina.com.cn/api/zhibo/feed`。
2. **"实时"的工程形态**：轮询（默认 60s）+ id 去重 + 追加存储。新闻 7x24 流动（美股/期货夜间也在跑，周日也验证过有活水），**不做交易时段 gating**——与 market-data 的 duty cycle 形成对照。
3. **模型面**：一个只读工具 `latest_news(query/codes/limit)`。关键词匹配正文+话题名，codes 匹配编辑标注的 A 股关联。

## 2. 设计讲解

### 2.1 NewsItem 词汇表：id/time/text/tags/codes

新浪每条快讯自带：数值 `id`（去重键）、`create_time`（北京时间字符串）、`rich_text`（正文，`【标题】` 开头）、`ext`（JSON 字符串，`stocks` 数组带话题关联）。

两个解析决策：

- **北京时间 → epoch 用 UTC 构造减 8h**，不经过本机时区——测试机/部署机时区无关。
- **tags 与 codes 分开收**：`ext.stocks` 的 `market` 字段有 cn/us/hk/global/fund 等值，`key` 是显示名（"石油"/"微软"）。**tags 收全部 market 的 key**（query 匹配面宽——查"锂"能命中期货锂、宁德时代关联）；**codes 只收 market==='cn' 的 symbol**（A 股个股过滤不掺港股美股）。

### 2.2 去重与存储：id 是唯一键，JSONL 是跨重启记忆

```
refresh(): fetchLatest()（新→旧）
         → filter(!seen)          ← 新增条目
         → 前插内存环（cap 500）
         → seen.add
         → appendToFile(老→新)    ← JSONL 追加，~/.mini-claude/stocks/news.jsonl
启动:    loadFromDisk()           ← 尾部 ~2000 行重建 seen + 内存环
```

- **追加顺序老→新**：文件天然成时间线，`tail` 即最新。
- 去重集在内存（Set）+ 落盘的是条目本体——重启后从文件重建 seen，**同一页重拉零新增**（测试钉住）。
- rotation 是 deferred（文件无界增长，S4 处理 /news-brief 时一起收口）——记档。

### 2.3 ensureFresh 的计龄基准：lastRefreshAt

消息流可能整轮无新增（夜间偶尔停流）——**不能用"最新条目时间"近似计龄**，否则"无新增"会被误判成"缓存过期"无限重拉。服务单记 `lastRefreshAt`（每次成功刷新打点）。

### 2.4 latest_news 输出形态

```
快讯 2 条（内存 20 条，最新 2026/10/18 14:57:30）
[14:57] ［金融街］【金融街论坛明日开幕…】正文…
```

头行给模型三个锚：命中数 / 内存池规模 / 时效。行前缀 `[HH:MM]` + 话题标签 `［…］`——模型引用时自带时间戳。单条截断 200 字（省 token，快讯的【标题】在前 100 字内）。

### 2.5 与 S1 的对仗（记档）

| | market-data | news-feed |
|---|---|---|
| 时段 | 交易时段 duty cycle，休市停摆 | 7x24 无 gating |
| 新鲜度 | 快照轮次 | lastRefreshAt 打点 |
| 持久化 | 内存环形缓冲（S5 再设计） | JSONL 追加 + 重启回读 |
| 去重 | 无需（全量快照覆盖） | id 集合 |
| 源 | 新浪列表 + 新浪明细（东财备源） | 新浪 7x24 |

## 3. 实现走查

| 文件 | 内容 |
|---|---|
| `my_src/plugins/news-feed.ts` | NewsItem/NewsSource/parseSinaZhibo/cnTimeToEpoch/stripTags/filterNews + NewsFeedService（refresh/ensureFresh/loadFromDisk/appendToFile）+ newsFeedPlugin |
| `my_src/cordis.config.ts` | 插件表 +news-feed；baseRows +news（disabled）；stock profile 两分支 +news 行 |
| `my_src/plugins/market-data.ts` | **S1 健壮性补修**：start()/tick 的后台 refresh 失败改吞不炸（离线环境 unhandled rejection 会杀进程） |
| `my_src/cordis-tests/s3-news.test.ts` | 6 测试：fixture 解析 / 坏行容错 / 过滤 / 去重+落盘序 / 重启回读+增量 / 工具+ensureFresh 短路 |
| `my_src/fixtures/sina-zhibo-p1.json` | 真实 7x24 页（20 条，2026-10-18 周日录制——消息面 7x24 的实证） |
| `my_src/run-mock.mjs` | 场景 35 + newsProbe 分支 |
| `my_src/s3-smoke.mjs` | 真机冒烟（真装配 + 真接口 + 工具链） |

## 4. 翻车记档

1. **测试挂载漏 ToolsService**（4 个用例齐红）：news 插件 `inject: ['tools']`——依赖不就绪插件不挂载，`ctx.news` 严格读取直接抛。教训：**给带 inject 的插件写单测，先把它依赖的服务摆上桌**（S1 测试碰巧都先建了 ToolsService，掩盖了这个认知缝）。
2. **filterNews 的"非法代码"语义**：初版对 codes 做正则预校验、非法项剔除——用户传 `600000`（忘前缀）时过滤集变空 → `codes.length > 0` 不成立 → **退化成无过滤返回全流**。这比"查无结果"危险。修：不预校验，无前缀的代码天然匹配不到带前缀的 `item.codes`，结果为空。原则：**校验失败的兜底方向要往"更窄"倒，不能往"更宽"倒**。
3. **ensureFresh 计龄引用了未打点的字段**：写了 `lastRefreshAt` 判龄但 refresh 里忘了赋值——首查恒判过期。写状态字段的读端之前先写打点，自测第一条就该覆盖。
4. 剥标签预期又想当然（`<b>加粗</b>标题` 中间没有空白）——同 S2-4-1 的病，不赘述。

## 5. 验证记录（终态）

| 线 | 结果 |
|---|---|
| cordis | **209/209**（203 + 本章 6） |
| mock | 30 场景全绿（29 + 场景 35） |
| snapshot | **30/30 × 2 轮**（ch35 新录：2 请求 + 1 会话文件） |
| 真机冒烟 | 270ms 拉一页 20 条；latest_news 全链（装配→轮询→工具→过滤）输出正常 |
| dump-config | stock：market + news 两行启用 |

## 6. 代码执行流程图

### 6.1 插件生命周期

```
ctx.plugin(newsFeedPlugin, config)
  └─ inject ['tools'] 就绪
       ├─ new NewsFeedService(ctx,'news')
       │    └─ loadFromDisk(): news.jsonl 尾部 2000 行 → seen + items（新→旧）
       ├─ attachTools() → latest_news (read)
       ├─ start(): refresh().catch(吞) + setInterval(60s, 同款吞)
       └─ ctx.effect(() => () => dispose())   ← 清 timer
```

### 6.2 refresh 与工具调用

```
refresh():
  fetchLatest() ──► [n5,n4,n3,n2]（新→旧）
  filter(!seen) ──► 新增集 [n5,n4]
  items = [n5,n4, ...items].slice(0,500)
  seen += {n5,n4}
  appendToFile([n4,n5])          ← 老→新落盘

latest_news {query:'锂'}
  └─ ensureFresh(30s) ── lastRefreshAt 新鲜？──否──► refresh()
  └─ filterNews(items, {query})
  └─ 输出头（命中/内存/最新时刻）+ [HH:MM]［tags］正文…
```

### 6.3 完整时序走查（mock 场景 35）

```
agent = Agent({extraRows:[news ← MockNewsSource(4 条字面量，2 条带"锂")]})
       （不走 stock profile——market 保持 disabled，进程零网络）
chat("Check the latest news about lithium.")
 req1 ──► 模型: latest_news{query:"锂"}
          ├─ ensureFresh: lastRefreshAt=0 → refresh() → 4 条入库
          ├─ filterNews → 2 条（碳酸锂…、锂价继续上涨…）
          └─ tool_result: 快讯 2 条（内存 4 条…）+ [HH:MM]［锂、宁德时代］…
 req2 ──► 模型: "news checked."
snapshot: 2 请求 + 会话文件逐字节锚定 ✓
```

真机差异：req1 之前 start() 已先行拉过一轮（启动即有数据），ensureFresh 大概率命中缓存。

## 7. 交付与 commit

- 建议 commit：`add news feed plugin with dedup storage and latest news tool`
- 手测清单（用户终端，随时可测——消息面 7x24）：
  1. `node dist/cli.js --profile stock` 进 REPL；
  2. "现在有什么市场消息？"——期望 latest_news 全流 top20；
  3. "锂最近有什么新闻？"——期望 query 过滤命中（正文+话题名都算）；
  4. "宁德时代有什么动态？"——期望模型组合 get_quote + latest_news（codes=sz300750 走编辑关联，query=宁德时代 走话题名，两条路都该通）；
  5. 退出重启再问——期望去重生效（`~/.mini-claude/stocks/news.jsonl` 已存历史）。

## 8. 自测题

1. news 为什么不做交易时段 gating 而 market-data 做？如果给 news 也加 duty cycle，周一早上 8 点启动的会话会表现成什么？
2. `ensureFresh` 用"最新条目时间"计龄会发生什么？（提示：夜间停流 40 分钟、轮询间隔 60s 的组合）
3. JSONL 落盘为什么老→新、内存环为什么新→旧？两个方向反过来的代价各是什么？
4. §4-2 的"校验失败往窄倒"原则，还能举出 S1/S2 里的哪个同构例子？（提示：get_quote 的 codes 正则拒绝后返回 Error 而不是"尽力而为"）
5. `ext.stocks` 的 tags 收全部 market、codes 只收 cn——如果 S4 的 /news-brief 想支持"港股新闻"，该动哪一层、怎么动才不破坏 A 股过滤的语义？
6. 场景 35 刻意不用 stock profile（extraRows 单行启用）——与场景 34 的选择对比，什么情况下"最小装配"比"全装配+换源"更能隔离被测行为？
