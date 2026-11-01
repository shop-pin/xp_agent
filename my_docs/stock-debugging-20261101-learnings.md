# 挂账 #9(b)：裁决吃 learnings 确立条目（2026-11-01）

## 要解决的问题

学习环的最后一环断着：教训库（learnings）有条目、digest 有对账，但 `/adjudicate`
裁决时看不见历史教训——同一个坑（比如"放量上攻 × 减持公告"的真假摔）每次都要
LLM 现场重新踩一遍。挂账原话：**裁决技能吃 learnings 确立条目（≤10 条进上下文）**。

## 设计决策（三处）

**1. 库真身迁产品数据面，my_docs 只留协议。**
`~/.mini-claude/stocks/learnings.md`——与 watchlist.txt / strategy.json 同区
（get_watchlist 先例）。my_docs/stock-learnings.md 改为协议与格式规范（状态机、
周末协议、消费口径），不再存条目。理由：产品运行时读的是 HOME 区，my_docs 是
教学面；两处存条目必然漂移。

**2. 工具搬运，不是模板内联。**
没把确立条目直接拼进 SKILL.md（模板是静态的，条目天天变），而是加只读工具
`get_learnings`（market-data 插件），取数链第一位调一次。数据文件用户可编辑、
代码零改。

**3. ≤10 上限放代码，不放提示词。**
`establishedLearnings(text, cap=10)` 纯函数：只吃 `状态：确立` 开头的条目、
日期新→旧、cap 截断。同 S4 token 纪律的"模板劝 + 代码钉"双层——提示词说
"≤10 条"模型未必听，代码 slice(0,10) 一定听。条目原行零改写输出（证据出处、
失效条件跟着条目一起进上下文）；判死条目留库但不进裁决（防复发是给人看的，
不是给裁决看的）。

## SKILL.md 三处接线

- `allowed-tools` 加 `get_learnings`（s6 契约测试深比较数组，同步改）
- 取数加第 1 步（一次调用，约束语义：矛盾→压信心+risks 带日期；同向→reasons 佐证）
- 裁决维度加"历史教训对照"（失效条件已触发的教训不再当约束）

verdict 契约**没动**——教训走 reasons/risks，不加新字段（record_verdicts 事件
层 schema 跟着契约走，加字段=事件层断代，不值）。

## 测试三层

| 层 | 锚 |
|---|---|
| 纯函数（s2） | 全角/半角冒号、非条目行跳过、确立/判死/候选/试用/观察中筛选、新→旧、cap 10/可调 |
| 工具（s2，HOME 沙箱） | 有确立返回原行、候选不进、无确立/无文件给指引 |
| mock ch38 | 取数链变五请求（skill→learnings→signals→news→verdict）；fixture 确立+候选各一条，断言确立进、候选不出 |

## 翻车记档

- **`(1)` vs `(1, cap 10)` 笔误 ×2**：s2 测试和 ch38 verify 都把头部锚写成
  `established learnings (1)`，实际输出是 `(1, cap 10)`——`(1)` 不是 `(1,` 的
  子串，两处先后红。教训：**锚输出头部时要么锚全、要么锚到逗号前**，"写到哪算哪"
  的 includes 锚是假阴温床。
- snapshot 漂移面 10 章（ch34/36-44）= 新工具进 tools 数组 + 裁决模板文案，
  同创科轮（excludeCK）形态，预期内；重录后 replay 40/40。

## 回归终态

cordis 310/310（+3）、mock 40/40（ch38 变五请求）、snapshot 40/40（十章重录）。
真机产品面：`~/.mini-claude/stocks/learnings.md` 已迁入现存 4 条（1 确立 + 1 观察 + 2 空层），
11-02 挂机日 /adjudicate 首次带教训裁决。

## 自测题

1. 为什么把 learnings 真身放 `~/.mini-claude/stocks/` 而不是 xp_agent 仓的 my_docs？
   （提示：运行时读哪、谁编辑、两处存会不会漂移）
2. `establishedLearnings` 为什么返回原始行而不是拆好的结构化字段？
   （提示：证据出处/失效条件对裁决的价值；再想：如果将来 digest 要统计条目，两种形态各缺什么）
3. 判死条目"留库不删但进不了裁决"——防复发给谁看？若想让裁决也警惕判死教训
   （反向约束），工具该怎么扩？（提示：第二个工具 vs 参数 vs 原行带状态前缀）
4. ≤10 上限为什么放 `slice` 不放 SKILL.md 提示词？回想 S4 的 token 双层纪律。
