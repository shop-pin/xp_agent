# S6：裁决技能（信号 × 新闻 → verdict）

> stock 课程第六章。总纲见 `stock-00-plan.md` §四（P3 阶段）。
> 交付：`skills/adjudicate/SKILL.md`（verdict 契约 + confidence 保守阶梯 + 真假摔条款）+ 发货守门测试 + mock 场景 38（真假摔输入面）。
> 验收线：mock 场景含"新闻与信号矛盾"用例 ✅ / cordis 222/222 / mock 33 场景 / snapshot 33/33 ×2（ch38 新录；ch34/36 因目录演进重录）。

---

## 1. 本章要解决的问题

第三步需求"判断买卖点"的后半：**LLM 裁决**。输入两路都是现成的——S5 的信号短名单（get_signals）+ S3 的关联新闻（latest_news codes 过滤）。本章把它们的组合方式、判断纪律、输出契约写成技能。

定位重申（总纲 §一思想 2）：裁决是**决策支持**，不是印钞机。verdict 是可解释的候选判断，action 枚举里刻意没有 buy/sell——执行层（S8 之后）才有资格把候选变指令。

## 2. 设计讲解

### 2.1 形态决策：inline，不是 fork（探底记档）

裁决直觉上适合 fork（隔离子代理 + 工具白名单，跑完只回结论），但探底发现 fork 对插件工具是断的：

```
buildPresetFromSkill(skill, mode, base = toolDefinitions)   // subagent.ts:60
  tools = base.filter(t => allowedTools.includes(t.name))
```

白名单在**静态 toolDefinitions**上解析——get_signals/latest_news 是插件注册的工具，不在 base 里 → fork 裁决会拿到空工具集。且子 agent 自建装配树（app 层对 isSubAgent 关掉 mcp 等），插件行不进子树，服务实例也无法共享（fork 一个 market 插件 = 双份轮询）。

**修这个缺口需要"能力传递"机制**（子树共享父服务实例或白名单解析挂注册表）——是真实的引擎课题，但不是裁决的必要条件。S6 决策：**inline**（主对话全工具可用；verdict 即 assistant 消息 = 日志即真相的留痕），fork+插件能力传递记档为已知缺口，S9 盯盘编排若需要隔离评估再开工。技能 frontmatter 的 allowed-tools 保留 [get_signals, latest_news]——它此刻是文档语义（依赖面声明），也是未来 fork 化的预埋。

### 2.2 verdict 契约：枚举克制 + confidence 保守阶梯

```json
[{ "code": "...", "signal": "rapid-move", "direction": "up", "strength": 3.5,
   "action": "watch", "confidence": 0.4,
   "reasons": ["…"], "risks": ["…"], "news_refs": ["[14:52] …"] }]
```

两条硬纪律写进模板并被守门测试钉住：

- **action 四值**：watch / buy-candidate / avoid / no-opinion。buy-candidate 的命名本身就是防火墙——"候选"不是"指令"，S8 的订单管线才是指令的出生地。
- **confidence 阶梯**：无消息佐证 ≤0.4；消息矛盾 ≤0.3；强共振 ≤0.8。上限 0.8 是认识论纪律——免费 L1 数据 + 摘要级消息面撑不起九成把握。

### 2.3 真假摔条款

"信号与新闻方向矛盾时（放量上攻 + 负面公告），confidence 必须压低并写明矛盾点"——这是裁决区别于"信号复读机"的核心条款。场景 38 的输入面就是这个形态：rapid-move 向上 × 减持公告。

### 2.4 留痕：assistant 消息即日志

总纲要求"裁决必带 confidence 与理由留痕（SessionLog 可回溯）"。落地零成本：verdict 是 assistant 消息，天然进 SessionLog，resume/复盘可回放。不为记录加专用工具（meta/note）——等 S8 订单需要挂 verdict 引用时再看（YAGNI）。

## 3. 实现走查

| 文件 | 内容 |
|---|---|
| `my_src/skills/adjudicate/SKILL.md` | 技能本体（取数纪律：每人 ≤2 次 news 调用；裁决维度清单；verdict 契约；边界条款） |
| `my_src/cordis-tests/s6-adjudicate.test.ts` | 发货守门：契约条款（四值枚举/阶梯/真假摔/token 纪律）钉在模板上，改模板放松契约先红 |
| `my_src/run-mock.mjs` | 场景 38 + adjudicateProbe 分支（skills/market 两态/signals/news 全 mock） |

引擎零改动。裁决质量（真 LLM 的判断好坏）是手测面——mock 只锚取数链与输入面。

## 4. 翻车记档

1. **守门条款锚差一个反引号**：模板写 `` `action` 只允许四值 ``，测试锚 `"action" 只允许四值`——红。锚字符必须从模板原文复制，不能凭记忆重写（与 S4-4-2"锚必须独有"同族：锚要**精确**）。
2. **场景断言要求了输出里不存在的字段**：latest_news 的输出行不打印代码（只有 tags+正文），断言却要求 sh600000 在场。写断言前先看一次真实输出形态（哪怕 mock）——"输出长什么样"是断言的前提不是假设。

## 5. 验证记录（终态）

| 线 | 结果 |
|---|---|
| cordis | **222/222**（221 + 本章 1） |
| mock | 33 场景全绿（32 + 场景 38） |
| snapshot | **33/33 × 2 轮**（ch38 新录；ch34/36 因目录演进重录——S4 纪律的第二次执行） |

## 6. 代码执行流程图

### 6.1 /adjudicate 调用链（inline）

```
用户: /adjudicate [args?]        （或模型按目录自主调 skill 工具）
  └─ inline 注入主对话
       模型按模板取数：
         get_signals {live?, direction?, rule?}     ← S5 短名单（≤10 条）
           └─ market.refresh() → 评估 → 信号
         对每条信号：
           latest_news {codes:[code], limit:5}      ← S3 个股关联
           [latest_news {query:话题, limit:5}]      ← 可选，≤2 次/信号
       裁决（维度清单过一遍）→ verdict JSON 数组 + ≤5 行人话解读
       "裁决为研究输出，非投资建议。"
  └─ assistant 消息（含 verdict）→ SessionLog 持久（留痕）
```

### 6.2 完整时序走查（mock 场景 38：真假摔）

```
agent = Agent({extraRows:[skills(product) / market(两态+固定钟) / signals / news(利空 fixture)]})
（50ms 等 start() 首轮：平静快照 → 0 信号）
chat("Invoke the adjudicate skill.")
 req1  user+catalog(/adjudicate) ──► skill{adjudicate,""}
 req2  ──► get_signals{live:true} → market 刷 spike → rapid-move ↑3.5%
 req3  ──► latest_news{codes:[sh600000]} →
          [09:50] ［平平稳稳］控股股东拟减持不超过2%股份   ← 矛盾输入面
 req4  ──► verdict：confidence 0.25 + reasons 点破矛盾（脚本echo契约形态）
断言：链路四段 / 目录 / 契约进激活正文 / 短名单 / 利空新闻在场 ✓
```

## 7. 交付与 commit

- 建议 commit：`add adjudicate skill with verdict contract over signals and news`
- 手测清单（用户终端，真 LLM——裁决质量的主战场）：
  1. 交易日盘中 `--profile stock`，放几分钟积累信号后 `/adjudicate`；
  2. `/adjudicate direction:up`——期望只裁决向上信号；
  3. 找一只当日有明确公告的异动股，观察 verdict 是否点破消息共振/矛盾；
  4. 检查 confidence 是否守阶梯（无消息 ≤0.4）——违约是模板纪律问题，回来改模板。

## 8. 自测题

1. action 枚举为什么没有 buy/sell？如果 S8 的订单管线直接消费 buy-candidate，谁应该负责"候选→指令"的升级判定——裁决技能、审批瀑布、还是风控监听器？
2. confidence 阶梯的三档（0.4/0.3/0.8）各自防什么？为什么强共振封顶 0.8 而不是 0.95？
3. §2.1 的 fork 缺口如果将来要修：白名单解析挂注册表就能让子 agent **看到**插件工具，但执行还需要子树里有服务实例——"看到"和"能用"之间差的那一层是什么？
4. 场景 38 的 verdict 是脚本 echo 的——它验证了什么、没验证什么？如果要让"真假摔降信心"变成可自动验证的行为，需要什么测试设施？（提示：真 LLM 评定的判定式断言）
5. verdict 留痕走 assistant 消息（零成本）而不是 meta/note（结构化）——到 S9 收盘复盘时，从对话历史里捞 verdict 的代价是什么？什么时候这个代价会变得不可接受？
