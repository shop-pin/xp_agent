# SC4：选股引擎 + 配置装卸 + CLI（2026-11-01）

总纲 §三 L5/L6 层。交付 = `loadScreeners` 配置面（覆盖合并+按条拒装）+
`runScreener` 引擎（宇宙闸→逐票求值→命中清单→JSONL+md 报告）+ `screener-run` CLI。

## 设计决策

**1. 配置 = 内置库之上的覆盖层（S14 手法）。**
用户 screeners.json 按 id 覆盖内置：params 键级深合并（改一个窗参不用抄全表）、
enabled/note/name 整字段覆盖、新条目自由添加。坏 JSON/非对象/字段类型错 =
**整份明确拒读**；坏公式（编译失败）= **按条拒装点名**——不让一个坏公式毒全场
（内置库不受用户坏条目牵连，测试钉住）。校验顺序：先指标（收集产出名）后
选股（带指标名集合做静态引用检查）。

**2. 命中语义 = 目标日（最后一根 bar）XG 为真。**
这是本章最重要的修正：SC3 的 `runStock` 第一版 `if (out.xg)`（`[false]` 是
真值数组），SC3 修成 `some(Boolean)`——两版都错。真数据冒烟当场逮住：ma-golden
命中 4444/4456 只——窗口内历史真值全部被当成"今天命中"。正确语义：**调用侧
把序列截到目标日，命中 = 最后一根 bar 的 XG === true**。修正后命中率回归
常识（金叉 204/4456、新高 17/4456）。

**3. 宇宙闸与 screen_market/pool 同口径**：剔ST/退市（名字现场判）、剔北交所
（红线）、excludeCK 可选（默认 false 同创科开关）、目标日有 bar（停牌不参跑）、
成交额下限 3000 万（可配）。名称表从最新 daily-k 收口文件构建。

**4. 产物两轨**：`screener/<day>.jsonl`（schema `stocks.screener` 版本头 +
逐行命中——复盘对账原料）+ `<day>.md`（人读报告：宇宙/公式/停用/拒装统计 +
逐公式命中清单含收盘价）。

## 翻车记档

- **fixture 违反 daily-k 格式**：我把 10 天数据塞进一个文件——daily-k 是
  **一天一文件、行内无 day 字段**（day=文件名），合并器按文件名归并后每票
  只剩 1 根 bar。报错形态（命中率全零）与数据缺陷（格式错）相距很远——
  **先 dump 中间态（bars.length）再猜**，一眼定位。
- **覆盖条目缺 formula 的合并**：`formula: u.formula` 会把 undefined 顶掉
  内置公式（S14 spread 教训同族第三次发作）——`u.formula ?? base?.formula`。
- **`[false]` 真值坑的二次进化**：SC3 修成 `some(Boolean)` 是过度修正——
  修 bug 时要把语义写进测试名，而不是换一个同样没写语义的表达式。
- **测试自己没跟上设计**：覆盖层语义（内置+用户合并）写成了替换语义的断言；
  fixture 成交额低于默认 3000 万闸。测试红先分清"实现错"还是"预期错"。

## 交付物

- `backtest/screener-config.ts`：loadScreeners（覆盖合并/按条拒装/坏配置拒读/
  universe 缺省）+ screenerConfigPath
- `backtest/screener-run.ts`：runScreener（引擎+落盘）+ CLI（--day/--formula）
- `backtest/schema.ts`：SCREENER = "stocks.screener"
- `cordis-tests/sc4-screener.test.ts`（6 测试：合并/拒装/坏配置/全链锚/边界/宇宙闸）

## 真数据冒烟（2026-10-29 收口日）

宇宙 4,456 只 · 金叉 204 / MACD 132 / KDJ 130 / 放量 84 / 新高 17 · 全程 15s
（<30s 目标 ✓）。数据注记：hist-k 缓存止于 10-21，10-22→10-29 间缺 3 个交易
日（daily-k 只收了 3 天）——MA 窗口按 bar 数不按日历，缺日影响幅度有限但
存在；周末协议缓存刷新（run.js --refresh）后消失。

## 回归终态

cordis 373/373（+6）、mock 40/40、snapshot 40/40 零重录。

## 自测题

1. 为什么"整份拒读"和"按条拒装"用在不同的错误上？把这两条线画清楚——
   哪类错误用户该改配置文件，哪类该改公式本体？
2. `some(Boolean)` → `xg[last] === true` 的语义修正，验证面应该是什么？
   （提示：不是单测——是全市场命中率回归常识。单测为什么防不住？）
3. 宇宙闸的成交额下限为什么用目标日 bar 的 amount 而不是均值？
4. JSONL 和 md 双产物的分工是什么？哪一个属于"日志即真相"？
