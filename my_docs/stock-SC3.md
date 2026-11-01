# SC3：公式库体系——标准指标 + 装卸（2026-11-01）

总纲 §三 L4 层。交付 = 内置公式库（MACD/KDJ/MA 族/VOL 量类 4 指标 + 5 个示
例选股公式）+ FormulaLibrary 装载器（编译/依赖解析/装卸/逐票求值）。

## 设计决策

**1. 标准指标 = 公式库条目，不是解释器硬编码。**
MACD 就是 `DIF:EMA(C,P1)-EMA(C,P2); DEA:EMA(DIF,P3); MACD:(DIF-DEA)*2;` 三行
公式——由 SC2 解释器编译求值。**解释器能算标准指标 = 体系自证**（TDX 同构：
内置指标与用户自定义指标同一机制）。TDX 同参：MACD(12,26,9)、KDJ(9,3,3)、
MA 族 5/10/20/60/120/250（月线=MA20 系对日线尺度的惯用读法；真·周线月线均线
= 重采样 K 上跑同一公式——SC1 的重采样在这里接上）。

**2. 指标引用语法 `指标ID.输出名`（MACD.DIF）。**
标识符词法放行 `.`；指标产出以复合键注册——两个指标同名输出天然隔离（测试
钉住）。选股公式引用未注册指标名 = 编译期 FormulaError。

**3. 装载器两段求值：指标先行 → 选股公式注入指标产出。**
per-stock：先跑全部指标收集产出（复合键 Map），再逐条选股公式 `runFormula(f,
base, produced)`。装卸 = `enabled:false` 注册不参跑。

**4. 命中语义钉死：`xg.some(Boolean)` 才算命中。**
`runStock` 第一版写 `if (out.xg)`——**`[false]` 是真值数组**，未命中的公式全
被当命中。这是本章最深的坑（见翻车记档）。

**5. 内置库坏定义 fail-fast，用户层按条拒装。**
内置公式是产品 bug——build 直接抛（测试钉住）；用户 screeners.json 的按条
拒装在 SC4 配置面（不让一个坏公式毒全场）。

## 翻车记档

- **正则锚优先级坑（本章最险）**：`/^A|B/` 的 `^` 只绑第一支——`IDENT_RE =
  /^[字母][字母数字.]*|\.[字母数字.]+/` 的第二支在任意位置命中，
  `":CROSS(MACD.DIF"` 被 exec 出 `".DIF"`（跳到 11 位），冒号和 CROSS 全被
  吞掉，解析器报"期望 :="（误导性极强）。修法：去掉第二支（标识符不该以点
  开头）。**教训：`^A|B` 永远写 `^(?:A|B)`；词法怪错误先打印记号流再猜。**
- **`[false]` 真值坑**：见上，`some(Boolean)` 钉契约。
- **手算错×2（第五、六连）**：KDJ 锚先错在"当前 bar 的 low 当 9 窗最低"，
  修正后又错在"忘了窗口滑动"（idx9 的 LLV=2 不是 1）——引擎逐个逮住。**手算
  KDJ/HHV 类指标必须逐 bar 重算窗口极值**；当实现与手算不一致时，现在已
  默认"先怀疑手算"（与 S11 时代相反——实现已被锚定过，信任级别反转了）。

## 交付物

- `backtest/formulas/builtin.ts`：BUILTIN_INDICATORS(MA/MACD/KDJ/VOL) +
  BUILTIN_SCREENERS(ma-golden/macd-golden/kdj-golden/vol-surge/breakout-high)
- `backtest/library.ts`：FormulaLibrary.build/runIndicatorValues/runStock/hasIndicator
- `backtest/formula.ts` 三处补缝：`.` 进标识符续字类；runFormula 第三参
  （逐票注入指标产出）；语法注释更新
- `cordis-tests/sc3-library.test.ts`（7 测试：自证/双锚手算/装卸/隔离/fail-fast/未注册引用）

## 回归终态

cordis 367/367（+7）、mock 40/40、snapshot 40/40 零重录。

## 自测题

1. 为什么指标产出用复合键而不是把输出名平铺进全局命名空间？举一个平铺会
   出事的场景（提示：两个用户指标都输出 K）。
2. `enabled=false` 为什么是"注册但不参跑"而不是"删除"？想想装卸的审计
   语义（复盘时要能看到"当时关着什么"）。
3. 正则 `/^A|B/` 的坑与运算符优先级哪个坑同族？写一个等价的安全形式。
4. KDJ 手算错两连的共同根因是什么？把"逐 bar 滑窗重算极值"变成手算流程
   里的一个固定步骤，描述它。
