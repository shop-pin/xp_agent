# S1：行情快照插件（数据面开张）

> stock 课程第一章。总纲见 `stock-00-plan.md` §四（P1 阶段）。
> 交付：`plugins/market-data.ts`（501 行）+ `--profile stock` + 11 条 cordis 测试 + 3 份真实 fixture + 真机冒烟脚本。
> 验收线（总纲口径）：真接口冒烟 ✅ / fixture 回放测试 ✅ / 全市场拉取 <5s ✅（实测 5,576 只 / 1.73s）。

---

## 1. 本章要解决的问题

第一步需求"监控全 A 股实时走势"落成代码，要先回答三个设计题：

1. **谁来盯 5,900 只股票？** 不是 LLM。全市场监控是数据面的活：服务轮询快照 + 代码筛选，模型只看短名单（总纲 §一思想 1 的第一次落地）。
2. **数据从哪来？** A 股没有官方免费 API，公开接口都是非官方的（新浪/东财/腾讯），随时改版断供——所以数据源必须是**接缝**（`QuoteSource`），不是硬编码。
3. **模型面暴露什么？** 两个只读工具：`get_quote`（单票明细）+ `screen_market`（条件筛选返回短名单）。权限 `permissionHint: "read"`——静默放行，不进审批。

## 2. 设计讲解

### 2.1 QuoteSource：按能力划分的接缝（不是按供应商）

```ts
export interface QuoteSource {
    fetchMarketSnapshot(): Promise<Quote[]>;  // 全市场（约 5,600 只）
    fetchQuotes(codes: string[]): Promise<Quote[]>;  // 单票明细（实时）
}
```

接缝的两方法是**能力**（全市场快照 / 单票明细），不是供应商。默认实现 `sinaSource`：快照走新浪排行列表、明细走新浪 hq——但接缝不假设"一家供一切"：备源 `eastmoneySource`（快照=东财 push2）与它可互换。测试注入 `MockQuoteSource` 走同一个口。

这个划分在 C6（LlmAdapter）就定过调：消费者只依赖接口，换提供者即换能力。**本章它第一天就兑现了**——原计划主源东财，实测被 WAF 掐（§4-1），切新浪只动了 config 默认值，服务与工具零改。

### 2.2 数据词汇表：code 前缀 + 缺失归零

- `code` 带交易所前缀：`sh600000` / `sz000001` / `bj920196`——第一天就为港美股留位（`hk` / `us`），S10 前不需要任何迁移。
- **停牌/缺失数值一律归 0**（东财 `"-"`、新浪空串）。消费方判 0 跳过：`screenQuotes` 隐式过滤 `price<=0`（停牌行不可交易、涨跌幅无意义）。
- 单位统一：volume=**手**（东财原生；新浪股→手 ÷100）、amount/市值=元（新浪 mktcap/nmc 是**万元** ×1e4）。
- 字段语义两源对齐靠 fixture 对拍钉死（bj920006：价/涨幅/换手/市净率逐项一致，量的 1 手尾差=东财取整）。

### 2.3 分页并发：60 页 ≈ 8 波

两家接口单页都硬上限 100（`pz`/`num` 填 6000 也只回 100）。全市场 = 56 页 × 8 并发波。新浪分页用 `sort=symbol&asc=1` 固定序——**按涨跌幅排序翻页会在交易时段洗牌**，快照会重会漏。

### 2.4 MarketDataService：duty cycle + 缓存 + 环形缓冲

```
start() ──► 立即拉一轮（休市也拉：收盘快照可用）
        └─► setInterval(pollIntervalMs)：tick 时查 marketPhase(now())
                open/auction/lunch → refresh()
                closed             → 跳过（停摆）
工具面 ──► ensureFresh(maxAgeMs)：缓存新鲜直接用，过期拉一轮
        └─► detailQuotes(codes)：直连数据源实时取（不占快照节奏）
```

- **时段判定**是纯函数（`marketPhase`：Intl 按 `Asia/Shanghai` 取钟表，只认周末不认节假日——节假日照跑但价格不动，staleness 自然揭示；调休上班的周末判 closed，与交易所一致）。
- **并发去重**：refresh 进行中复用同一个 in-flight Promise（启动首轮和首个工具调用撞车时只发一趟）。
- **环形缓冲** `history`（默认 60 轮 ≈ 5 分钟价格序列）是 S5 信号引擎的口粮。记档：当前实现每轮一个 `Map<code, price>`，60×5,600 ≈ 34 万条目，交易时段驻留约几十 MB——S5 设计正式序列存储时会重做（届时量比也从历史序列近似补上，主源接口无量比字段）。

### 2.5 profile 接线：base 零感知

`baseRows` 加一行 `{ id: "market", name: "market-data", disabled: true }`；`profiles.stock` 用行数组启用（纯数据面插件无需宿主桥，不用工厂形态）。效果：

- `--dump-config`（base）：market 行 disabled ✅
- `--dump-config --profile stock`：market 行启用 ✅
- base 产品（REPL/mock/snapshot 默认）不加载任何股票代码——mock 28 场景零断言变更、snapshot 28 章零变更（S1 自身不进快照体系，S2 技能章再进）。

## 3. 实现走查

| 文件 | 内容 |
|---|---|
| `my_src/plugins/market-data.ts` | Quote 词汇表 / QuoteSource 接缝 / marketPhase 纯函数 / parseEastmoneyDiff + parseSinaList + parseSinaResponse 三个纯解析器 / sinaSource（主）+ eastmoneySource（备）/ screenQuotes 纯筛选 / MarketDataService / marketDataPlugin（inject tools，注册 2 工具，effect 收口 timer） |
| `my_src/cordis.config.ts` | 插件表 +market-data；baseRows +market（disabled）；profiles.stock |
| `my_src/cordis-tests/s1-market.test.ts` | 11 测试：解析×4（fixture 回放+两源对拍+坏行容错）、时段边界、筛选×3、服务轮询/缓存/环形、工具接线 |
| `my_src/fixtures/` | em-clist-p1.json（东财全字段 100 行）/ sina-list-p1.json（新浪列表 100 行）/ sina-hq-raw.bin（新浪 hq GBK 原始字节） |
| `my_src/s1-smoke.mjs` | 真机冒烟：全量计数+耗时 / 涨跌异动榜 / 市场分布 / 单票明细（交易日复用） |
| `my_src/memory.ts` | **与 S1 无关的存量修复**（§4-4，ch8 偶发红根因） |

关键取舍记档：

- **get_quote 走新浪明细、screen_market 走快照缓存**：明细要实时（盘中秒级新鲜），筛选用全量快照（5,600 只明细没有单票接口能便宜地给）。两个工具各吃接缝的一个方法。
- **screen 默认排除 ST/bj**：北交所 30% 涨跌幅会污染沪深异动榜、ST 有摘帽/退市博弈噪音——默认干净榜，参数可开。
- **`volumeRatioMin` 当前不筛**（主源无量比，恒 0）：参数描述里明说"S5 补上后才生效"，不给模型假能力。

## 4. 翻车记档

### 4-1 东财 WAF 掐 Node（接缝第一天兑现）

原计划：快照=东财 push2（字段全，含量比）。真机冒烟第一跑直接 `UND_ERR_SOCKET`。排查矩阵：

| 探测 | 结果 |
|---|---|
| curl 同 URL（http/https、同 IP） | ✅ 200 |
| node fetch 裸/带 UA/浏览器全家桶头 | ✗ RST |
| node 原始 http.get / https.get（curl 同款头） | ✗ ECONNRESET |
| 东财编号镜像（82./1./push2delay） | ✗ 全灭 |
| **新浪两接口 from node** | ✅ 200 |

结论：东财 CDN 对 Node 的 TCP/TLS 指纹特征直接重置连接（不是头、不是 TLS 内容——plain http 也掐）。**不硬刚 WAF**：主源切新浪列表，东财降级备源（换个网络环境可能能用），解析器保留 + fixture 钉格式。改动量 = config 默认值一行——`QuoteSource` 接缝的价值当场兑现。

### 4-2 新浪数值全是字符串（测试抓到，冒烟坐实）

新浪列表的数值字段是字符串（`"trade":"22.560"`）。初版 `num()` 只认 `typeof === "number"` → **全场价格归 0** → cordis 新测试红（fixture 断言 price=13.1）+ 冒烟异动榜空（计数/分布对，价格 0 被 `price>0` 隐式过滤）。修法：`Number(v)` + `Number.isFinite` 容错（`"-"`/空串/undefined → 0，东财原生数、新浪串、两源通吃）。

教学点：fixture 断言先于真机冒烟红——这正是"录样本进 fixture，测试钉格式"的回报。

### 4-3 测试自身的三个坑

1. `fileURLToPath(import.meta.url)` 返回**文件**不是目录，`join(url, '..', '..')` 在 Windows 下歪成 `dist/fixtures` → 用 `dirname()`。
2. 预期写错两次，都是同一原因：**没过一遍默认值**——`excludeST` 默认 true 让"条件组合"用例少了 ST 行；`sortBy` 默认 changePercent 让"priceMax asc"用例的序按涨幅不按价格。写筛选断言前先默背默认项。
3. 时段头断言不能锚死 `closed`（测试跑在几点钟是不确定的）——锚"存在四个枚举值之一"。

### 4-4 ch8 snapshot 偶发红·第二根因（存量 bug，顺路抓获）

S1 验证跑 snapshot 时 ch8 闪红（4 红 2 绿）。逐字符对拍（借 capture 文件 + 同参 normalization 复算）抓到**两个**翻动点，与检视轮修的"跨轨到达序"是不同的病：

1. **MEMORY.md 索引行序**（`listMemories`）：排序键 mtimeMs 降序。批次内顺序执行的多次写，相邻两次写有时落同一 NTFS 时间片（mtime 平局 → 平局序 = readdir 序）、有时跨片（真实先后）——`editor→deploy→color` 闪成 `editor→color→deploy`。修：**索引排序键换文件名字典序**（索引是目录页不是时间线）。
2. **selector 候选清单行序**（`scanMemoryHeaders`）：同款 mtime 排序。这里要保新近度语义（`MAX_MEMORY_FILES` 截断优先近期），修成**秒级时间桶降序 + 文件名字典序决胜**——桶内确定，桶间近似新近。

ch8 重录后 6/6 稳绿、全量 28/28 ×2。此修独立于 S1（建议单独 commit，见 §7）。

## 5. 验证记录（终态）

| 线 | 结果 |
|---|---|
| cordis | **199/199**（188 + 本章 11） |
| mock | 28 场景全绿（S1 零断言变更） |
| snapshot | 28/28 × 2 轮（ch8 因 §4-4 重录） |
| 真机冒烟 | 5,576 只 / **1.73s**（验收线 >5,000 且 <5s）；异动榜/明细输出正常 |
| dump-config | base：market disabled；stock：启用 |

数据口径记档：新浪 `hs_a` 全量 5,576（sh 2,319 / sz 2,906 / bj 351）；东财 fs 口径 5,923——差 ~350（东财含更多边缘标的），两源各自口径稳定，跨源对数时用各自基准。

## 6. 代码执行流程图

### 6.1 插件装配（--profile stock）

```
cli --profile stock
  └─ buildRows({host, profile:'stock'})
       baseRows[...market(disabled)] ─┐
       appRows(host)                  ├─ mergeRows 同 id 后写胜
       profiles.stock[market 启用]   ─┘
  └─ loadRows → ctx.plugin(marketDataPlugin)
       └─ inject ['tools'] 等 ToolsService 就绪
            ├─ new MarketDataService(ctx,'market')   （ctx.market 可见）
            ├─ attachTools() → tools.register(get_quote / screen_market, read)
            ├─ start() → refresh() + setInterval(duty cycle)
            └─ ctx.effect(() => () => market.dispose())   （fiber 卸载清 timer）
```

### 6.2 全市场快照（sinaSource.fetchMarketSnapshot）

```
slFetchPage(1..8) ──► 波式并发（8 页/波，Promise.all）
   每页: GET vip.stock.finance.sina.com/...getHQNodeData?page=N&num=100&sort=symbol&asc=1
         └─ JSON.parse → parseSinaList → Quote[]（字符串数值 → num() 归一）
见到短页/空页 ──► 到尾，break
pages.flat() ──► MarketDataService.refresh()
   ├─ byCode Map 索引
   ├─ history.push({at, prices})，超 historyRounds 先进先出
   └─ refreshCount++（测试可见）
```

### 6.3 工具调用（盘中一次 screen_market）

```
模型 tool_use: screen_market {changePercentMin:5}
  └─ executeCall（C2 管线）
       ├─ waterfall('tools/pre-execute')  ── approval 插件：hint=read → allow
       ├─ execute(input)
       │    ├─ ensureFresh(15s) ── 缓存新鲜？──否──► refresh()（in-flight 去重）
       │    ├─ screenQuotes(snap.quotes, filter)
       │    │    price>0 → 排除ST/bj → 数值条件 → sortBy 排序 → limit 截断
       │    └─ 组表头（全市场 N/命中 M/快照时间/当前时段）+ 行文本
       └─ waterfall('tools/post-execute') → truncateResult → tool_result
```

### 6.4 完整时序走查（休市冒烟，s1-smoke.mjs）

```
node s1-smoke.mjs
 1. sinaSource.fetchMarketSnapshot()
    page1..8 并发 → …共 56 页 7 波 → 5,576 只 Quote（1.73s）
 2. screenQuotes(quotes, {changePercentMin:3, amountMin:2e8, limit:10})
    命中 10 行：20cm 创业板领跑（华力创通 +20.04% 额8.46亿 …）
 3. screenQuotes({changePercentMax:-3, order:'asc', limit:5})
    C联亚 -28.33% 领跌（次新股无涨跌幅限制——真实盘面特征）
 4. fetchQuotes([sh600000, sz300750, sh688981])
    新浪 hq：GBK 解码 → parseSinaResponse → 3 行明细，quotedAt=2026-10-16 15:3x
    （周末休市 → 返回周五收盘值：快照与明细同为收盘口径，交叉一致）
```

盘中同一脚本的差异只在：数据在动、`marketPhase` 返回 open——duty cycle 每 5s 自动刷，`ensureFresh` 大概率命中缓存（0 请求）。

## 7. 交付与 commit

- 建议 commit（S1 本体）：`add market data plugin with sina quote sources and stock profile`
- 建议 commit（§4-4 存量修，独立于 S1）：`make memory index and selector ordering deterministic`
- 手测清单（交易日，用户终端）：
  1. `node dist/cli.js --profile stock`，问"今天涨幅超过 7%、成交额超过 10 亿的股票有哪些"——期望模型调 screen_market 返回短名单；
  2. 追问"浦发银行现在什么价"——期望 get_quote(sh600000)；
  3. 观察启动横幅后约 2s 完成首轮快照（休市也拉收盘值）；`/cost` 看 token 消耗（两个工具输出都是紧凑文本）。

## 8. 自测题

1. 为什么 `QuoteSource` 的两方法按能力划分而不是按供应商划分？如果按供应商划分（`SinaApi` / `EastmoneyApi` 各给全套），§4-1 的 WAF 事故修复会变成什么样？
2. 新浪分页为什么必须 `sort=symbol` 固定序？改成按涨跌幅排序分页，交易时段的快照会发生什么？（提示：翻页窗口在动）
3. `ensureFresh(15_000)` 在休市的周日仍然会发请求吗？这个行为对"周一早上第一次使用"意味着什么？
4. `screenQuotes` 为什么把 `price<=0` 做成隐式过滤而不是可选条件？停牌股的 changePercent=0 会怎样污染"跌幅榜"？
5. §4-4 的两处排序，为什么索引用纯字典序、selector 用"秒桶+字典序决胜"而不是统一用一种？（提示：`MAX_MEMORY_FILES` 截断语义）
6. 东财被掐的证据链里，哪一条探测最能排除"请求头问题"这个解释？为什么 plain http 的 ECONNRESET 比 https 的 UND_ERR_SOCKET 信息量更大？
