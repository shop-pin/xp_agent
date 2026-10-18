# S7：PaperBroker 模拟盘（执行腿开张）

> stock 课程第七章。总纲见 `stock-00-plan.md` §四（P3 阶段）。
> 交付：`plugins/paper-broker.ts`（BrokerAdapter 缝 + 费用/T+1/整手/价带/资金建模 + 账本 JSONL 重放 + place_order/get_portfolio + broker/fill 事件 + trade 注记）+ F6 投影 trade fold（侧栏成交行）+ `--profile web-stock` 组合 + 11 条确定性单测 + mock 场景 39。
> 验收线：确定性单测（费用/T+1/整手边界）✅ / cordis 233/233 / mock 34 场景 / snapshot 34/34 ×2 / 投影手测通路（web-stock）✅。

---

## 1. 本章要解决的问题

第四步需求的**模拟盘半场**：裁决出了 buy-candidate，接下来要有一张能下单、能记账、能算盈亏的**假账户**——零真钱跑通全链，P4 实盘只是换 adapter。

`BrokerAdapter` 缝是 C6 LlmAdapter 思路的第二次兑现：PaperBroker 与（未来的）QmtBroker 实现同一接口，"换 adapter 即换盘"。

## 2. 设计讲解

### 2.1 建模口径（每条都对着真 A 股规则）

| 规则 | 实现 | 手算锚 |
|---|---|---|
| 费用 | 佣金 max(5, 万2.5) 双边 + 过户 0.001‰ 双边 + 印花税 0.05‰ 卖单 | 买 10 万=26；卖 11 万=83.6 |
| 整手 | 股数 floor 到 100；<100 拒单 | 150→100 |
| 价带 | 委托价超 [round2(昨收×(1±板%))] **拒单**（不钳制成交） | 10 昨收主板 [9,11] |
| T+1 | 当日买入不可卖；北京时间日历日切清零 | 当日卖拒、次日可卖 |
| 资金 | 买入含费校验现金 | 1000 元买 1 万拒 |
| 成本 | 加权成本含买入费；卖出按比例结转 basis | 两笔建仓→半仓卖 pnl=39.43 |

价带**拒单而非钳价**（修订了总纲"涨跌停成交价钳制"的原稿）：交易所对超带委托就是拒单——校验失败的兜底往窄倒（S3/S5 原则第三次生效）。成交价=委托价是无订单簿的诚实简化（记档）。

### 2.2 留痕双轨：账本是真相，注记是视图

```
成交 ──► paper-ledger.jsonl（HOME，跨会话真账——重启重放重建现金/持仓/序列号）
     ──► SessionLog meta/note(key:"trade")（会话内流——F6 投影侧栏 live 消费）
     ──► ctx.emit("broker/fill")（S8 审计/S9 编排的事件面）
```

重启语义：`loadLedger` 重放 fill 行——现金、持仓、已实现盈亏、订单序列号全恢复；重放后的日切用**当前钟**判定（历史买入自动可卖）。

### 2.3 place_order 的摩擦位：hint=exec

S8 审批风控还没落地，但订单不该是静默动作——`permissionHint: "exec"` 让它进既有 confirm 流程（终端确认/审批服务）。场景 39 里 `setConfirmFn(true)` 走的正是这条路径——**S8 会在同一个位置换成风控瀑布**，管线不变。

### 2.4 web-stock 组合 profile

F6 侧栏的 trade 行只在 web UI 有意义，而 broker 只在 stock profile——profile 单选，组合需求显式做成第四个名字 `web-stock`（web 工厂行 + stock 静立行拼接）。**不做多层组合语法**——两个真实需求之前不发明机制（YAGNI）。

### 2.5 F6 投影 trade fold

`webui/projection.ts` 增 `trades: {fills, fees, realizedPnl, cash, last}`——meta/note key:"trade" 的事件折叠，零 RPC 零新帧（F6 纪律延续）。侧栏一行：`¥ 2 笔 · 费 10.57 · 已实现 +89.43 · 现金 999099` + 末笔明细。

## 3. 实现走查

| 文件 | 内容 |
|---|---|
| `my_src/plugins/paper-broker.ts` | Order/Fill/Position/Rejection 词汇表 + computeFee/priceBand/cnDay 纯函数 + PaperBroker（submitOrder 校验链/settle 三轨留痕/loadLedger 重放）+ 两工具 + 插件 |
| `my_src/cordis.config.ts` | 插件表 + baseRows（broker disabled）+ stock 行 + **web-stock 组合 profile** |
| `my_src/webui/projection.ts` | ProjectionTrades + trade fold |
| `my_src/webui/app.tsx` | 侧栏 trade 行（fills/费用/已实现/现金/末笔） |
| `my_src/cordis-tests/s7-broker.test.ts` | 11 测试：费用/价带/日切手算 + 整手+T+1+成本/拒单三连/日切盈亏/资金/加权成本/账本重放/注记+工具/投影 fold |
| `my_src/run-mock.mjs` | 场景 39 + paperProbe 分支 |

依赖注记：paper-broker import signal-engine 的 `limitTier`（板位分档单源）——两个插件都常驻 stock profile，模块级纯函数共享无环。

## 4. 翻车记档

1. **手算两次漏项**：加权成本用例忘了卖出印花税（0.55 元，pnl 39.98→39.43）；现金正则写错（1M−1005.01 是 998,994.99 不是 999,894.99）。**费用类手算必须列全科目再落笔**——三费科目漏一个，差之毫厘。
2. **测试自删账本**：重放用例先 `cleanup()`（rmSync 账本目录）再"同账本"重放——读到空账。清理函数的语义边界（删资源 vs 卸插件）在多阶段用例里要分开：dispose 归 dispose，rm 归 rm。
3. **place_order 输出串拼接手误**（编译前自查发现）：中英引号混编的字符串拼接写崩——模板串重写。教训朴素：输出文案一律模板字面量。

## 5. 验证记录（终态）

| 线 | 结果 |
|---|---|
| cordis | **233/233**（222 + 本章 11） |
| mock | 34 场景全绿（33 + 场景 39） |
| snapshot | **34/34 × 2 轮**（ch39 新录：5 请求 + 会话文件含 trade 注记） |
| vite build | 246.74 KB（+trade fold 与侧栏行） |
| dump-config | stock：+broker 行；web-stock：host 桥 + 全套 stock 行 |

## 6. 代码执行流程图

### 6.1 下单校验链（submitOrder）

```
Order {code, side, price, qty, reason}
  ├─ 代码格式 ──✗→ Rejection
  ├─ price>0 / qty≥100（整手 floor）──✗→ Rejection
  ├─ quoteFor: market.ensureFresh → byCode ──缺→ Rejection（无行情）
  ├─ priceBand(code, name, 昨收) ──超带→ Rejection
  ├─ buy:  现金 ≥ amount+fee ──✗→ Rejection（资金不足）
  │    └─ 现金扣减；qty/boughtToday/cost 累加
  └─ sell: qty ≤ avail（T+1）──✗→ Rejection（可卖不足）
       └─ basis 按比例结转；realizedPnl 累加；清仓移除持仓
            ↓
       settle(fill)：账本 JSONL + SessionLog 注记 + broker/fill 事件
```

### 6.2 重启重放（loadLedger）

```
paper-ledger.jsonl
  account 行 → 起始现金
  fill 行（老→新）→ 重放同一条校验后路径的账务效果
       现金/持仓/加权成本/realizedPnl/订单序列号 全恢复
  当前钟 rollDay → 历史买入可卖（T+1 只对"今天"生效）
```

### 6.3 完整时序走查（mock 场景 39）

```
agent = Agent({extraRows:[market(mock 固定价), broker(now 固定)]})
agent.setConfirmFn(() => true)          ← place_order hint=exec 的审批位
chat("Run the paper trading checks.")
 req1 ──► place_order buy sh600000 10000@10
          └─ 价带 [9,11] ✓ 现金 ✓ → Filled P0001 费 26 元 现金 899,974
 req2 ──► place_order sell 10000@11 → Rejected 可卖不足（T+1 当日买入）
 req3 ──► place_order buy 50 股 → Rejected 不足一手
 req4 ──► get_portfolio → 现金 899,974 | 持10000股 可卖0 | 已实现 +0
 req5 ──► "paper trading checked."
（events.jsonl 含 trade 注记——F6 侧栏的口粮；快照逐字节锚定 ✓）
```

## 7. 交付与 commit

- 建议 commit：`add paper broker with fee t1 modeling and ledger replay`
- 手测清单（用户终端）：
  1. `node dist/cli.js --profile stock`——"帮我模拟买入 10000 股浦发银行，现价" → 确认对话出现（exec 摩擦）→ 成交回报；
  2. "现在卖掉" → 期望 T+1 拒绝话术；"查一下我的持仓" → get_portfolio；
  3. `node dist/cli.js --profile web-stock --web` 开浏览器——下单后侧栏 trade 行 live 出现（F6 投影验收）；
  4. 重启进程再查持仓——账本重放，现金持仓不丢。

## 8. 自测题

1. 价带拒单 vs 钳价成交：各自的"往窄倒"论证是什么？如果钳价，一笔 11.5 的买单在 [9,11] 带上会以什么价成交、这为什么危险？
2. T+1 用"北京时间日历日"判定，节假日会怎样？（提示：周六不 tick、周一 rollDay——周一卖的可用性对不对？周五买的票周一可卖吗？）
3. 账本重放为什么能恢复订单序列号？如果两台机器共用同一 HOME（账本并发追加），会发生什么？S10 实盘前需要什么保护？
4. settle 的三轨留痕（账本/注记/事件）各自服务于谁？哪一轨丢了用户体验最差、哪一轨丢了** correctness **最差？
5. web-stock 组合 profile 没有让 skills 行走工厂形态的 catalogInjection（写死 true）——对主 agent 对吗？对（未来的）web 子 agent 会怎样？
6. 100 万起始资金的模拟盘，佣金最低 5 元的边界对小单的费率影响有多大？算一笔 1000 元的单，费率是多少——这对 S5 信号的"小额高频"裁决意味着什么？
