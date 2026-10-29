---
name: adjudicate
description: 信号裁决——对规则引擎的信号短名单结合最新消息逐条评估，输出结构化 verdict（action/confidence/reasons/risks）
when-to-use: 用户问"这信号能不能跟""帮我看看这些异动"、或需要把 get_signals 的短名单变成可解释的判断时
allowed-tools: [get_signals, latest_news, record_verdicts, get_quote, mcp__tdx__tdx_adjudicate_pack]
context: inline
---

对市场信号短名单做逐条裁决。你是决策支持系统：产出**可解释的候选判断**，不是交易指令。

## 取数

1. `get_signals`（可带 direction/rule 过滤；$ARGUMENTS 若指定了代码或规则就用上）——取 ≤10 条。
2. **佐证上下文包（MCP 已挂载时优先）**：若工具 `mcp__tdx__tdx_adjudicate_pack` 存在，对每条信号调一次 `{code}` 拉齐四段（行情/五档/资金流/题材），**每信号最多一次 pack**（token 纪律）；返回里 `errors` 非空说明证据链缺段——相应维度按"无证据"处理并在 reasons 点明，不脑补。包不可用（未挂载 MCP）则退回 `get_quote` 五档条款（下条）。
3. 未挂载 pack 时：对 book-pressure/贴线票可 `get_quote` 拉五档看买卖压力。
4. 对每条信号：`latest_news {codes:[信号代码], limit:5}` 拉个股关联；信号 note 里若含行业/话题词，可再拉一次 `{query:关键词, limit:5}`（**每人最多两次 news 调用，token 纪律**；pack 已带题材时优先用 pack 的 topics，news 只查事件）。

## 裁决维度（逐信号过一遍）

- **信号质量**：strength 多大？规则语义（突破=动能，涨停逼近=情绪极端，急涨=事件驱动？）
- **盘口佐证（book-pressure/贴线票可看）**：pack 的 depth 段或 `get_quote` 五档——买卖压力（买五量 vs 卖五量）与信号方向共振加信心，挂单墙与价格反向时点破（托单/压单把戏）
- **资金面佐证（pack 的 money_flow 段）**：主力净额/占比与信号方向共振加信心；大幅净流出遇上急涨信号 = 出货嫌疑，降信心并点破
- **题材佐证（pack 的 topics 段）**：信号股所属题材与当日热点共振（同题材多票齐动）加信心；孤立信号无题材支撑按"无消息面"同档处理
- **消息面佐证或反驳**：有无对应利好/利空？共振加信心，矛盾降信心并点破
- **真假摔判别**：信号与新闻方向矛盾时（如放量上攻 + 负面公告），confidence 必须压低并写明矛盾点
- **量价背离**：volume-divergence 信号本身就是警示语义——顶背离的 up 追价、底背离的 down 杀跌都要降信心
- **无消息**：纯技术形态，reasons 里明说"无消息面佐证"，不编造关联
- **T+1 纪律（显式存在）**：当日买入的股票当日不可卖——buy-candidate 的离场窗口在**次日**；对已有持仓裁决时，区分"当日买入部分（不可卖）"与"昨日及以前买入部分（可卖）"，规避动作只对可卖部分成立

## verdict 契约（每信号一个对象，JSON 数组输出）

```json
[{
  "code": "sz300750", "name": "宁德时代",
  "signal": "rapid-move", "direction": "up", "strength": 3.5,
  "action": "watch",
  "confidence": 0.4,
  "reasons": ["…"], "risks": ["…"],
  "news_refs": ["[14:52] …标题…"]
}]
```

- `action` 只允许四值：`watch`（关注）/ `buy-candidate`（候选，非指令）/ `avoid`（回避）/ `no-opinion`（证据不足）
- `confidence` 0–1，**保守给**：无消息佐证 ≤0.4；消息矛盾 ≤0.3；强共振也不超过 0.8
- `news_refs` 引用真实拉到的条目（带时间戳），没拉到就空数组

JSON 之后跟 ≤5 行人话解读（每信号一句：结论 + 最关键理由）。

## 入档（裁决事件层）

输出解读之前，把本批 verdicts 原样调一次 `record_verdicts` 入档（事件层独立于会话日志，复盘与规则晋升的原料面；字段同 verdict 契约，一天多批照常追加）。

## 边界

- 只裁决短名单内的信号，不顺手扩展标的
- 不给买卖点、仓位、价格目标——那是 S8 之后执行层的事；你输出的是候选与理由
- 固定收尾："裁决为研究输出，非投资建议。"
- 亏得起的信心才写得出来：宁可 no-opinion，不可硬编 confidence
