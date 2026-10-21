---
name: adjudicate
description: 信号裁决——对规则引擎的信号短名单结合最新消息逐条评估，输出结构化 verdict（action/confidence/reasons/risks）
when-to-use: 用户问"这信号能不能跟""帮我看看这些异动"、或需要把 get_signals 的短名单变成可解释的判断时
allowed-tools: [get_signals, latest_news, record_verdicts]
context: inline
---

对市场信号短名单做逐条裁决。你是决策支持系统：产出**可解释的候选判断**，不是交易指令。

## 取数

1. `get_signals`（可带 direction/rule 过滤；$ARGUMENTS 若指定了代码或规则就用上）——取 ≤10 条。
2. 对每条信号：`latest_news {codes:[信号代码], limit:5}` 拉个股关联；信号 note 里若含行业/话题词，可再拉一次 `{query:关键词, limit:5}`（**每人最多两次 news 调用，token 纪律**）。

## 裁决维度（逐信号过一遍）

- **信号质量**：strength 多大？规则语义（突破=动能，涨停逼近=情绪极端，急涨=事件驱动？）
- **消息面佐证或反驳**：有无对应利好/利空？共振加信心，矛盾降信心并点破
- **真假摔判别**：信号与新闻方向矛盾时（如放量上攻 + 负面公告），confidence 必须压低并写明矛盾点
- **无消息**：纯技术形态，reasons 里明说"无消息面佐证"，不编造关联

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
