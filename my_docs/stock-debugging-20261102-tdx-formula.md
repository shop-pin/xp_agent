# 11-02 用户 TDX 公式移植：指标/选股双文件架构 + 引擎高频件补齐

日期：2026-11-02（SC 章实战验收②的真实场景——用户首次投喂真实通达信公式）
讲解性质：SC 验收清单②③的落地轮 + 用户需求澄清后的架构对齐。

## 一、用户需求澄清（本轮最重要的一段对话）

用户原话拆解出三个要求：
1. **指标公式和选股公式的文件分开可装卸**——`~/.mini-claude/stocks/screeners.json` 的 `indicators` 节（指标公式区）+ `screeners` 节（选股公式区），每节条目独立装卸（enabled 开关）。
2. **多个指标公式一起工作**——同一选股判定里同时观察多个指标的值（例：股价在五日线上 + KDJ<50 + MACD 有值）。形态 = 选股公式里 `MA.MA5 > C AND KDJ.K < 50 AND MACD.DIF != 0` 跨引用组合。
3. **选股公式只需选出股票**——不做多选股公式结果二次筛选（SC5 的 autoRun/merge 已够用）。

引擎架构本来就是这个形态（SC2/SC3 设计），本轮补的是实战暴露的缺口。

## 二、探针实锤的兼容性判定（用户原公式 → 引擎）

### 直接可用（无需改动）
`:=` 赋值 / `:` 输出 / 中文变量名 / `AND OR NOT` 前缀 / `== <> !=` 比较符 /
REF EMA SMA HHV LLV MAX MIN COUNT EXIST BARSLAST / `MACD.DIF` 跨引用 /
布尔乘数 `(cond)*10>=10` 惯用法 / `AMOUNT`（注意不是 `AMO`）

### 本轮补进引擎的（高频四件 + 动态窗口）
| 件 | 语义 | 落点 |
|---|---|---|
| `IF(c,a,b)` | 条件选择，`DRAWNULL` 作 else=不画（null 传播） | formula.ts BUILTIN_FUNCS |
| `FILTER(x,n)` | 信号静默窗：发出后 n 根内不再发（手算锚：T,F,T,T,F,T n=2 → T,F,F,T,F,F） | 同上 |
| `BETWEEN(x,lo,hi)` | 区间判定，null 参与=false | 同上 |
| `TO`/`TURNOVER` | 换手率（**百分数口径** 2.5=2.5%），daily-k 路径才有（hist-k 腾讯源无此字段=null→false） | kseries 带 turnover + baseFromBars 注入 |
| `DRAWNULL` | 全 null 序列常量 | baseFromBars |
| `REF(X, BARSLAST(c))` | **动态窗口**——取上次条件成立时的值（用户公式 X_48/X_49 的核心用法） | REF eval 改统一逐点位移；编译期 BARSLAST 仅放行 REF 第二参（SC2 窗口参静态原则的受控破口，其他窗口函数仍严静态） |

### 不支持且用 universe 闸/删项替代的
| TDX 原件 | 替代 |
|---|---|
| `NAMELIKE('ST')` / `X_20X/X_21X` | `universe.excludeST`（引擎侧股票池闸，更干净） |
| `CODELIKE(3)` / `X_23` | `universe.excludeBJ` |
| `FINANCE(42)>120`（流通市值>120亿） | **无市值数据面——删除**（诚实边界：这条闸丢失，若需要须接市值数据源） |
| `SETCODE` / `CAPITAL` | 市场位/流通股本无数据。`X_9:=VOL/CAPITAL` 改 `TO/100`（换手率小数口径，量纲对齐回归系数）；`HSL` 改 `TO` |
| `FORCAST(VOL,n)` | 线性回归预测不做——`MA(VOL,n)` 近似（量能温和判定场景偏差可接受） |
| 画线属性 `,STICK,COLORRED,LINETHICK9` | 删（选股不需要显示属性） |
| `CONST(...)` / `X_53/X_54` | 死代码删除 |

### 语义保真注意
- `X_9X:=IF(cond,1,0)` 与布尔序列恒等，`COUNT(X_9X=1,4)` 原样可跑
- 涨幅腿的线性打分模型（X_10/X_11 回归系数）对量纲敏感——`TO/100` 是刻意的（TDX CAPITAL=手，VOL/CAPITAL=小数比率；我们 TO=百分数）
- **BZ（暴涨启动）腿的历史段几乎恒 false**：X_9 依赖 TO，而 hist-k 缓存没有换手率（只有 daily-k 最近 4 天有）——null→false 保守方向。当日判定不受影响（最后一根 bar 是 daily-k 覆盖日），历史回看腿失效是诚实边界。

## 三、多指标协同的引擎增强（用户需求 2 的真缺口）

探针+真跑实锤：**indicator 编译时看不到其他指标的输出**（SRC 引用内置 MACD.DIF 被拒）。修法=顺序语义（TDX 先定义后引用同款）：
- `library.build`：指标按定义序编译，前序指标输出进后序的可见面
- `runIndicatorValues`：产出按序累积注入（后序指标运行期可消费前序产出）
- `screener-config` 配置面预检同缝（前序指标输出可见，顺序收集）

测试锚：sc3 加跨引用用例；sc2 加 IF/FILTER/BETWEEN/TO/动态 REF 五例（含 BARSLAST 只放行 REF 第二参的负例）。

## 四、公式文件形态（用户拍板：目录 + 每条公式一个 txt）

用户明确"目录放公式文件"后拍板目录形态（screeners.json 的用户层退役，公式迁为 txt）：

```
~/.mini-claude/stocks/formulas/
├── indicators/            ← 指标公式区
│   └── SRC.txt            ← 文件名（去后缀）= 指标 id；内容=原样多行公式（{} 注释可用）
└── screeners/             ← 选股公式区
    └── tdx-longtou.txt    ← 文件名=公式 id
```

装卸语义（零语法负担）：
- **放进去 = 装**，**删掉 = 卸**
- **改名加 `.off` 后缀 = 停用**：`vol-surge.off.txt` → 同名内置选股器进停用清单（原公式仍注册，报告面"停用 N 条"可见）；indicator 的 `.off.txt` 直接跳过装载（指标无停用清单概念）
- 合并顺序：**内置库 ← screeners.json（兼容旧入口）← formulas/ 目录**（后者覆盖前者同名 id；目录是用户工作面）
- env：`MINI_FORMULAS_DIR` 可覆盖目录位置（测试密封用）
- 指标引用内置/前序指标（`MACD.DIF`、`SRC.LT`）直接写；选股公式引用指标输出 = `指标ID.输出名`

SRC.txt 现身说法：素材链全部变量保留原名，段间 `{ }` 注释说明，末尾输出行 `LT/BD/MM/BZ/BO/DUAN`——选股公式 tdx-longtou.txt 只有一行判定 `XG:(SRC.LT OR SRC.BD) AND (SRC.MM OR SRC.BZ) AND C>3 AND C<50 AND V=HHV(V,6) AND TO>3 AND AMOUNT>100000000;`。

**真跑验收（2026-11-02）**：宇宙 4804、拒装 0、tdx-longtou 命中 18 只（json 形态与 txt 形态两次运行命中清单完全一致）。抽验三只逐项吻合公式条件：中原高速 +9.92%（涨幅腿）/换手 4.28%（TO>3）/成交额 4.09 亿（>1 亿）；沈阳机床涨停 +10.06%、富特科技 +10.3% 同构。

## 五、回归与遗留

- cordis 390/390（+12 新锚：sc2 十例 + sc3 跨引用 + sc4 目录装载）、snapshot 40/40
- 实现坑记档：`.off.txt` 后缀 8 字符（初次写 7 剪错位——测试锚逮住）；目录读取层 `.off` 的 indicator 跳过 vs screener 映射 enabled:false 的语义差异是有意的
- formula-probe.mjs 留作公式验证探针（改公式后先跑它再上 screener-run）

## 六、原版直读适配轮（用户公式逐字不改跑通，2026-11-02 晚二档）

用户把我改写的方言版删了、放回通达信原版（指标+选股两文件，带画线属性/STICKLINE/DRAWTEXT/FINANCE/NAMELIKE/SETCODE/FORCAST/CONST）——明确信号：**公式一字不改，引擎适配**。引擎补件：

| 件 | 落点 | 语义 |
|---|---|---|
| 词法 `\|\|` `&&` `'字符串'` | formula.ts lex | `\|\|`→OR、`&&`→AND；字符串供 NAMELIKE 参数 |
| 画线属性剥离 | parser 语句层 | `expr,STICK,COLORRED,LINETHICK9;` 的逗号属性列表丢弃 |
| 绘图语句忽略 | parser | STICKLINE/DRAWTEXT 等 12 种整条跳过（括号深度扫描） |
| CONST(x) | BUILTIN_FUNCS | 取末有效值→常量序列 |
| FORCAST(x,n) | indicators.ts | 线性回归外推下一根；窗口含 null→null |
| NAMELIKE/CODELIKE | BUILTIN_FUNCS | **恒 false**（ST/板块过滤由 universe 闸承担——净效果一致） |
| SETCODE | 基础名 | 恒 0（A 股沪深分支恒真） |
| AMO | 基础名 | AMOUNT 别名 |
| CAPITAL/FINANCE(7)/FINANCE(42) | 基础名+函数 | **从当日换手率反推**：股本(手)=VOL×100/TO；FINANCE(7)=股（TDX 单位）；FINANCE(42)=流通市值=C×股本×100 |
| 窗口参=本地变量 | walk+consts 提取 | `LLV(X_52,X_52)` 网文公式惯用死代码写法——运行期取变量末值当窗口常量 |

**单位事故（抽验逮住）**：FINANCE(7) 初版返回手、TDX 语义=股——HSL 被放大 100 倍、X5 换手闸失效，国金证券（换手 1.69%）误命中。修正后 FLZT_xuanguqi 命中 25→18，**与方言改写版（tdx-longtou 18 只）完全重合**——两种形态殊途同归，公式语义对齐验证通过。

**反推口径诚实边界**：股本/市值是从当日换手率反推的近似（与真实流通股本口径差 ~20%，A 股"流通"vs"自由流通"之差）；hist-k 历史段无换手率→null→X_19X(市值>120亿)/X5(换手>3%) 历史腿 false——当日判定（最后一根 bar 有 daily-k 换手）不受影响。

指标公式 FLZT_zhibiao.txt 装载即编译通过（波/段两个输出行 + 画线信号全剥离）；选股公式自包含不跨引用指标输出，两文件独立工作。

## 七、对数轮：缓存刷新 + 票池选项化（通达信对齐，2026-11-02 深夜三档）

用户反馈"选股数量与通达信对不上"（通达信口径：全部 A 股票池 + 前复权 + 剔 ST）。排查两个根因：

1. **hist-k 缓存截止 10-21**（SC1 时代建的）——中间 10 个交易日只有 daily-k 的 4 天，K 序列有 6 天的洞：HHV(V,6) 天量窗口、LLV/HHV 36 日窗、EMA/SMA 递归全部跨洞错位。修=`my_src/hist-refresh.mjs`（维护脚本：腾讯前复权源 4 路并发，5217 只×320 根 52 秒零失败）。EMA89 预热确认充足（缓存深度 641 根，不是当初记档的 120）。
2. **universe 叠加了通达信没有的 3000 万成交额闸**（DEFAULT_UNIVERSE.amountMin）——通达信选股范围只剔 ST。

票池选项化（用户拍板）：`strategy.json` 新增 `screener.universe` 节 = 通达信选股界面的 checkbox 等价物：

```json
"screener": { "universe": { "excludeST": true, "excludeBJ": true, "excludeCK": false, "amountMin": 0, "qfq": true } }
```

优先级分层：**缺省 ← strategy.screener.universe（用户常设）← configPath json 层显式值**（LoadedScreeners 新增 universeExplicit 裸值透传——configPath 显式配置最优先）。qfq 为口径声明（数据面当前固定前复权，标记进报告注记）。SC4 三个 runScreener 测试补 USERPROFILE 沙箱（loadStrategy 读家目录的非密封依赖——既有密封先例）。

**对数结果（2026-11-02）**：宇宙 5025（全部A股口径）→ FLZT_xuanguqi 命中 **31 只**，抽验三只全闸吻合（中视传媒涨停/换手 4.51%、巨人网络涨停/3.72%、中创环保 +9.65%/4.18%）。命中面传媒/文化板块扎堆=公式抓到当日板块齐动 ✓。snapshot 一轮 39/40 偶发红（挂账 #11 自愈型）重跑 40/40 ✓。与通达信对数的剩余预期差：EMA(89) 递归在 320 根 vs 通达信全历史的预热残差、换手率反推股本的 ~20% 口径差——边缘票可能翻转，量级应在个位数。

## 八、漏票追凶轮（用户反馈 31 ⊂ 通达信 40，差额 9 只）

用户确认 31 只全部在通达信名单内（零误选 ✓），漏 9 只。`flzt-diag.mjs` 诊断工具（五条腿拆开逐票判定+数值距离）抓出两只大鱼：

1. **科创板量纲 bug（确定性，漏 7 只）**：腾讯源对 sh68 的 volume 返回**股**、主板返回**手**——同一接口两种单位。合并后最后一根（daily-k 手）vs 历史根（腾讯股）差 100 倍 → HHV(V,6) 峰值虚高百倍 → **科创板全部卡死在"6 日天量"闸**。实锤：虹软科技 hist-k 10-29 vol=5604349（股）vs daily-k 同日 56043.49 手。修=`parseTencentKlines` 单位归一（sh68 ÷100）+ 测试锚。
2. **腾讯限频 501**（深度刷新触发连发冷却）→ **数据源整体切换到 eltdx 网关同源（TDX）**：`hist-refresh-tdx.py`（eltdx Python API，volume_lots=手原生正确、amount=真实成交额（比腾讯近似④准）、adjust=qfq 与通达信同族）。5216 只×800 根 129 秒零失败（1 只退市股空序列）。SC1 探针记档"TDX 探针零误差"在此兑现。

**修复后 38 只**（+7 全部是科创板：虹软科技/久日新材/盟升电子/联赢激光/海目星/凌志软件/视涯科技）——vs 通达信 40 差 2。诊断收敛后的边缘候选：**青岛金王（D4 量 501181 vs 6 日峰 504683，差 0.69%）**最像；其余边缘（D5 换手 2.4~2.6%、D6 额 0.90~0.94 亿）差距太大不像数据差能翻转的。未排除的公式语义差：FORCAST 外推语义（通达信文档两说）、FINANCE(42) 反推口径（TDX 真实流通市值表 vs 我们当日换手反推）。**待用户通达信名单 diff 做最终确认**。

## 九、终审轮（用户点名差额票：中原高速+锦江酒店，全对齐 40/40）

用户给出通达信名单中的 9 只（7 只 688 我们已有 + **中原高速 sh600020 + 锦江酒店 sh600754**）——差额精确=2。单票深查（信号链逐层输出）定位**两个引擎级 bug**：

1. **布尔序列参与数值比较被当 null（引擎 bug，锦江酒店卡这）**：`X_37:=EXIST(X_36>0,36)`——X_36 是 Cond，`X_36>0` 走 cmp 的 num() 把 boolean→null → 全 false → EXIST 恒 false → BD 腿（X_55=X_27 AND X_52 AND X_37）被错杀。**TDX 语义：条件=0/1 参与算术与比较（X_36>0 恒等 X_36）**。修=formula.ts bin op 的全部数值比较（> < >= <= = !=）前 s() 收缩（与 + - * / 同款）。
2. **FORCAST 语义差（中原高速卡这）**：放量日 FORCAST(V,4) vs FORCAST(V,12) 的 BETWEEN 判定——"外推下一根"语义=991195 超上限 887150（X_20=false→私募秘进腿死）；"当前位拟合"=729877 在区间内（X_20=true→FILTER 首发→私募=true→XS1=true）。通达信选了它 → **实锤 TDX FORCAST=当前位拟合值**（实现在窗口末位 t=n-1）。用真实数据反证语义，非文档猜。

**终审结果：40/40 与通达信完全对齐**（392/392 + snapshot 40/40）。方法论沉淀：差额票单票深查（信号链逐层 dump）比全宇宙边缘统计定位快得多——两只票、两个 bug、两种性质（一个是引擎布尔语义真 bug、一个是函数语义近似）。

## 十、收口链选股自动跑 + terminal 打印（用户需求：盯盘结束自动触发选股）

SC5 管道已铺好（收口链挂载 screener），缺两块拼图：

1. **autoRun 开关**：用户 strategy.json `"screener": { "autoRun": true }`——收盘收口链（复盘 turn → digest → 选股 → 自退）自动带上选股。
2. **terminal 打印（本轮新增）**：收口链 spawn 选股时 stdio 是 ignore——结果只在 screener/<day>.jsonl 文件里，terminal 看不到。新增 `screenerSummary(day)`（market-watch.ts）：onTurnEnd 在 closeOut 完成后、自退前读当日产物打印——**头行=全部公式命中计数；自定义公式（非内置库）打命中明细（cap 200 行防刷屏）；内置公式只计数**（kdj-golden 七百只级）。真实产物形态（42 行）：

```
🎯 选股完成 2026-11-02（breakout-high 23 / vol-surge 77 / kdj-golden 731 / macd-golden 273 / ma-golden 117 / FLZT_xuanguqi 40）
FLZT_xuanguqi 命中 40 只：
  sh600020 中原高速 收 4.32
  …
```

测试锚：sc5 screenerSummary（自定义明细/内置只计数/文件缺席静默）；WatchService 补 strategy 字段（apply 传入构造，构造不再重复 loadStrategy）。回归 cordis **393/393** + snapshot 40/40。明天挂机即全链生效：开盘 /watch → 收盘自动 复盘→digest→选股→**terminal 打印 40 只清单**→自退。

诊断工具自身翻车一次记档：初版裸 loadFormula 没注入指标产出——MACD.DIF 吃了 placeholder 空序列 → 信号腿全 false 的假诊断（真跑路径 runStock 是注入的）；修正=诊断与 runStock 同缝（runIndicatorValues + runFormula(compiled, base, produced)）。另记：中原高速"翻转"是记混 18 只旧清单所致，诊断无误。

## 六、commit message（my_src 侧）

`add tdx formula porting with if filter between dynamic ref and indicator cross reference`
