# stock-screener 总纲（选股器 = TDX 公式引擎，SC 章）

> 2026-11-01 立项。对标通达信桌面端选股器：指标可配可装卸、公式驱动、每日收盘
> 选出下一交易日候选。本文件 = 总纲（策略+章节表）；实现节奏照 stock/dsh 课程
> 模式分章推进，每章讲解进 `my_docs/stock-SC<n>.md` + 测试 + commit message。
> 参照物：通达信公式体系（用户给公式/参数）；`E:\deepseek-harness` 与本轨无关。

## 一、目标与定位

- **选股器 = 研究面**：每日收盘全市场跑公式 → 候选清单（报告+JSONL），**不自动交易**——候选人工把关后并入 watchlist（§五）。总纲 §六边界条款全文适用（非投资建议、模拟盘先行）。
- **与现有面的关系**：
  - signal-engine（分钟级五指标）= 盘中注意力钩子，不动；
  - 选股器 = **日/周/月 K 尺度的形态选股**（收盘后跑，服务次日），两者互补不重叠；
  - 回测面（S13）= 历史验证；选股器将来反哺回测（公式历史重放=公式回测，挂账）。
- **日内成交均线/分时类不在选股器 v1**——那是分钟面，signal-engine 已覆盖
  （vwapDeviation/volumeSurge）；本轨工作在日K/周K/月K 尺度。

## 二、数据面决策（2026-11-01 用户拍板）

- **周线/月线 = 从日线本地真重采样**（不是从 TDX 拉）：
  - 全市场 5,500 只 × 3 周期若走 `tdx_kline` ≈ 1.65 万请求/次、十几分钟起步、
    叠加网关可用性依赖（10-30 空转日教训）——批量面不可接受；
  - 日 K 语料（hist-k 缓存 642 日 + daily-k 收口增量）本来就是选股器的必需
    底座，本地重采样零边际成本、确定性、纯函数可手算；
  - **TDX 的角色 = 对账探针**（抽几只票 `tdx_kline period=week/month` 对拍
    重采样口径，M 轨验证手法）+ 模型面临时查询（16 工具照旧）。
- 序列合并沿用 digest buildSeries 模式：hist-k 打历史深度、daily-k 收口补当日
  之后的新收盘；周末协议 `run.js --refresh` 刷 hist-k 尾巴。
- 复权口径：hist-k 为腾讯 qfq（连续可比）；重采样在 qfq 序列上做（周内跨
  除权日由 qfq 平滑）；对账探针时 TDX 侧配 adjust 一致口径。
- **通达信机制对照（2026-11-01 查证，设计依据）**：TDX 桌面端本地只持久化
  日线（vipdoc/lday/*.day，32 字节/天追加）+ 分钟线，**周/月线不存盘**——
  打开时从日线内存实时聚合；**指标从不落盘**，全部按需现算（指标=K 的纯
  函数，除权会改历史，预存反而要维护失效）。本轨同构：hist-k/daily-k ≙
  .day 文件，指标每次现算（AST 预编译），唯一落盘 = 选股结果 JSONL（对账
  原料非缓存）。

## 三、架构分层（自下而上）

```
L1 数据面   K 序列仓库：全市场日线（缓存优先）+ 周/月重采样器（纯函数）
L2 指标库   原语函数（MA/EMA/REF/HHV/LLV/CROSS/…，纯函数，手算锚）
L3 解释器   TDX 公式 DSL：词法 → 语法 → 求值（AST 预编译，逐票执行）
L4 公式库   技术指标公式（主图/副图，内置 = 公式库条目而非硬编码）
            + 选股公式（引用指标名，末行 XG 输出布尔）
L5 选股引擎 宇宙闸 → 逐票求值 XG → 候选清单（JSONL + md 报告）
L6 编排/配置 screeners.json（用户覆盖，节级深合并、装卸开关、坏配置拒读）
            + closeOut 链挂载（strategy.screener.autoRun，默认 off）
```

关键设计（TDX 同构）：**标准指标（MACD/KDJ/VOL…）本身就是公式库里的指标公式**，
由 L3 解释器求值——解释器能算标准指标 = 体系自证；用户自定义指标与内置指标
同机制、同装卸面。

## 四、TDX 公式语言 v1 支持面

- **行情引用**：O H L C V(=VOL) AMOUNT
- **时序引用**：REF(X,N) BARSLAST(COND) EVERY(C,N) EXIST(C,N) COUNT(C,N)
- **统计**：MA EMA SMA(X,N,M) HHV LLV HHVBARS LLVBARS SUM STD
- **信号**：CROSS(A,B)（上穿）；下穿 = NOT CROSS 形态表达
- **运算**：+ - * / 比较六符 AND OR NOT
- **语法**：`:=` 中间变量 / `:` 输出 / `;` 语句分隔 / `{}` 注释 /
  换行任意；**选股公式必须恰有一个 `XG:` 输出行**（显式、加载时可校验）。
- **参数**：公式体引用参数名，参数值在 screeners.json 的 params 里（DSL 与
  参数管道解耦——TDX 界面调参数的对应物）。
- v2 候选（挂账，不进 v1）：DYNAINFO/XG 剔除函数、板块引用、FINANCE 财务面、
  跨周期引用语法（"周线 MACD 金叉"以独立公式跑周线序列表达）。

## 五、配置与装卸（S14 策略即配置的姊妹篇）

- **配置文件** `~/.mini-claude/stocks/screeners.json`（节级深合并、坏配置
  明确拒读——loadStrategy 先例）：
  ```json
  {
    "indicators": { "my-dif": { "note": "…", "formula": "DIF:EMA(C,12)-EMA(C,26);" } },
    "screeners": [
      { "id": "ma-golden", "name": "均线金叉", "enabled": true,
        "params": { "N": 5, "M": 10 },
        "formula": "MA5:MA(C,N); MA10:MA(C,M); XG:CROSS(MA5,MA10);" }
    ],
    "universe": { "excludeST": true, "excludeBJ": true, "amountMin": 30000000 }
  }
  ```
- **内置公式库** `my_src/formulas/`（product 层随产品发货，同 skills 先例）：
  标准主图指标（MA 族）+ 副图指标（MACD/KDJ/VOL 量类）+ 示例选股公式；
  用户同名覆盖（rank 语义）。
- **装卸语义**：enabled=false = 注册但不参跑；加载期对每个公式做静态校验
  （语法/未知函数/未知指标引用/XG 存在性），坏的拒装并点名——不让一个坏公式
  毒全场。

## 六、选股结果去向（2026-11-01 缺省，用户可改）

- 输出 `<dataRoot>/screener/<day>.jsonl`（schema `stocks.screener`，版本头纪律）
  + `<day>.md` 报告（每公式：命中数/耗时/命中清单 code+name+关键读数）。
- **报告 + 人工并入**：人工把关后一键并入 `watchlist.txt`（并入动作 = 一条
  CLI/工具命令，不自动写）。自动进 watch 关注面（宇宙第四腿）作 v2 挂账——
  未验证的公式不该直接塑形盯盘面。

## 七、编排

- CLI：`node dist/backtest/screener-run.js [--day D] [--formula id]`（缺省 =
  最新收口日、全部 enabled 公式）。
- 挂机链：`strategy.screener.autoRun`（**默认 false**，公式库验证一段时间后
  由用户打开）→ closeOut 链 digest 之后追加 screener 步 → 自退。
- digest 第七节之后可加第八节引用当日选股摘要（只在 screener 当日有产出时）。

## 八、章节表

| 章 | 交付物 | 验收线 | 危险点 |
|---|---|---|---|
| SC1 | K 序列仓库 + 周/月重采样器（纯函数）+ TDX 对账探针 | 重采样手算对拍（跨除权周、不完整周、停牌周）；探针 ≥3 只票与 `tdx_kline` 逐根对上 | 周界口径（TDX 周=交易日周）；停牌缺根；qfq 除权落界 |
| SC2 | 指标原语库 + 公式解释器（词法/语法/AST/求值） | 每原语手算锚；解释器金例 ≥20（含错误公式拒装清单） | 浮点误差界；除零/空窗语义（TDX 返回空而非 0）；AST 复用性能 |
| SC3 | 公式库体系：内置主图/副图标准指标（MACD/KDJ/VOL…）+ 加载/校验/装卸 | MACD/KDJ 手算对拍 + 与通达信同参对照；内置=公式库条目自证 | 指标名冲突（用户覆盖 rank）；循环引用检测 |
| SC4 | 选股引擎 + screeners.json 配置面 + screener-run CLI | 一致行为锚测试（用户覆盖参数 → CLI 同源，S14 手法）；fixture 全链 | XG 多行/缺失静态校验；宇宙闸口径与 screen_market 一致 |
| SC5 | closeOut 链挂载（autoRun 开关）+ watchlist 一键并入 + 交易日实战验收 | cordis+mock+snapshot 全绿零重录（研究面纪律）；真实收盘日全市场跑通 + 报告可读 | autoRun 默认 off；并入动作必须人工触发；mock 场景覆盖链路 |

每章验收线：cordis 全绿 + mock 全绿 + 本章测试绿（snapshot 预期零重录——研究面
不进装配树）。

## 九、风险与边界

- **复权口径**：qfq 历史深度 642 日（2023-03 起）——年线 MA250 可算，更长周
  期指标（如两年线）超窗；weekly 探针发现口径分歧先停用对应公式（fail-closed）。
- **性能**：AST 预编译每公式一次；逐票求值向量化数组运算；目标全市场全公式
  < 30s（超出再优化，先正确后快）。
- **许可**：TDX 数据自用研究，License 条款沿用 mcp-tdx（Non-Commercial
  Research）；选股输出 = 研究输出非投资建议（主总纲 §六条款照抄适用）。
- **token 纪律**：选股器全程零 LLM；报告进研究面文件，LLM 只在复盘/裁决读它时进场。
