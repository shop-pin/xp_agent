# SC5：收口链挂载 + watchlist 并入 + 实战验收（2026-11-01）

总纲 §三 L6 层收官。交付 = strategy.screener.autoRun 收口链挂载、watchlist
并入动作、digest 第八节、SC 轨全回归。**SC1–SC5 至此全部落地。**

## 设计决策

**1. autoRun 默认 false——未验证的公式不自动进链。**
`strategy.screener.autoRun`（节级深合并，缺省 false）：收口链 digest 之后追加
screener-run 步。先人工看一段报告，认可命中质量后再在 strategy.json 打开。
这是"研究面不自动驱动交易面"纪律的链上版。

**2. 缺省收口链 = 可注入的组合器。**
`defaultCloseOut(strategy, spawnDigest?, spawnScreener?)`：digest 恒跑、选股
autoRun 开才追加、顺序 digest→选股、选股失败向上 reject（收口链 catch 喊出
声，不阻断自退——与 digest 同语义，可事后手动补跑）。spawn 函数 DI——链路
组合是纯逻辑，测试不需要真进程。工厂在 `config.closeOut ?? defaultCloseOut(strategy)`
处接线——显式 closeOut 覆盖不受影响（s9 既有测试零改动通过 = 证明）。

**3. 并入是人工动作，不是自动管道。**
`screener-run --merge sh600089,sh600094 [--day]`：从报告里**挑中**的票才并
watchlist.txt——自动把 204 只金叉票塞清单不是把关是外包。去重、来源注记
（`code  # 选股 <day>`）、非法码剔除；既有行零改动。

**4. digest 第八节 = 选股摘要只读注入。**
`renderScreenerSection`（digest.ts 纯函数）：按公式归组、每公式点名截 8 只；
无产出时明确说"未跑或 autoRun 关"——不静默空过。digest 保持零 LLM 零网络
（只读 screener/<day>.jsonl）。

## 与计划的偏差（诚实记档）

- **mock 场景未新增**：计划写了"mock 场景覆盖链路"，实际链路覆盖走 cordis
  DI 测试（defaultCloseOut 组合/顺序/失败传播 3 例）——spawn 进程链不适合
  mock 场景（真实子进程不可复放），mock 侧价值 = 装配零漂移证明（40/40 零
  重录即证）。判定：等效覆盖，偏差记录在案。
- **实战验收顺延**：周日无盘。首个交易日（11-02）验收清单：①挂机收盘链
  产物齐全（digest.md §八有选股行）②报告命中率扫一眼有无效命中的公式先
  enabled:false ③看一周后决定 autoRun。

## 交付物

- `plugins/strategy.ts`：ScreenerConfig 节（autoRun 缺省 false）
- `plugins/market-watch.ts`：spawnScreenerRun + defaultCloseOut（导出，DI）+
  工厂接线
- `backtest/digest.ts`：renderScreenerSection 纯函数；`digest-run.ts` 第八节
- `backtest/screener-run.ts`：mergeIntoWatchlist + `--merge` 子命令
- `cordis-tests/sc5-chain.test.ts`（5 测试）

## 回归终态

cordis 378/378（+5）、mock 40/40、snapshot 40/40 零重录。
真数据冒烟：digest §八渲染 449 票 × 5 公式归组正常（2026-10-29 产物回放）。

## 自测题

1. autoRun 为什么默认 false 而不是"报告连续三天正常后自动开启"？把"研究
   面不自动驱动交易面"翻译成这条链上的具体约束。
2. defaultCloseOut 的 DI 面为什么注入 spawn 函数而不是注入"开关布尔"？
   （提示：测的是组合语义——顺序、条件、失败传播）
3. 并入 watchlist 为什么做成显式码列表参数而不是 `--merge-all`？想象 204
   只金叉票自动进清单后的下一个交易日，watch 关注面会变成什么样。
4. digest 第八节与 screener/<day>.md 报告的分工？为什么 digest 只放归组
   摘要而把全清单留在报告文件？
