# 第十五章：自治与续跑（autonomy.ts）

## 原理

三件套分工一句话：**/goal 决定要不要继续，/loop 决定什么时候跑下一次（本章只讲不做），Auto Mode 决定能不能放行动作。**

最小实现 = 两个旁路 LLM 调用 + 接线：

```
evaluateGoal(condition, transcript)  → "MET" | "NOT_MET: <reason>"     （前缀解析）
classifyAction(tool, input, transcript) → "<block>yes/no</block> ..."  （标签解析 + fail-closed）
agent.pursueGoal: chat(设目标) → 循环≤5次{ 评估 → met则return → reason回灌成下一turn }
agent auto拦截: mode==="auto" 且 write/edit/shell → 分类器裁决 → 拦则 Blocked tool_result
cli: --auto / --goal <condition> <prompt>
```

## 值得记住的思想

- **失败方向的对偶（本章核心）**：两个旁路判断的解析容错方向相反——评估器偏"没达成"
  （乱码→NOT_MET，宁可多跑一轮，不误清目标）；分类器偏"拦截"（乱码→BLOCK，fail-closed，
  错杀好过错放）。**解析层就是安全层**：API 层锁不住模型输出（没用 json_schema），
  "模型不守约时怎么办"完全由你的 if/else 决定，分支写反方向就反。
- **独立上下文防污染**：判断者只收一条 user 消息（条件+transcript 投影），不共享主循环
  messages——被评判的对话没法伪造 user/判定文本混进判断者视野。
- **旁路调用模式第三次出现**：ch7 摘要、ch11 子 agent、ch15 评估器/分类器。同一骨架
  （独立请求、投影输入、契约输出、容错解析），换 system 和解析即得新功能。
- **plan 与 auto 拦截的分工**：plan=无条件拦（一个表达式），auto=问了再拦（先 await 裁决）
  ——所以 auto 必须独立成块、放在 plan 检查之前。
- **mock 场景必须覆盖两条分支**：拦截+放行各一个 case，否则放行路径死了 mock 照样全绿
  （"Text" 大写案例：filter 恒空→永远拦截→场景恰好只要求拦截→全绿）。

## Review 记录

### 施工（2026-09-13）：骨架带填空 → 多处代填，mock 13 项 ✓，回归 ch1–12 全绿

- autonomy.ts evaluateGoal：抄骨架时**分号/逗号 3 处同型错**（对象字面量内分隔用逗号，
  分号是结束语句——"花括号内逗号、花括号外分号"）；max_tokens 4096→256；"Condition:"
  丢冒号、"so for" 拼写；startsWith/replace 填空不会——代填讲解。
- classifyAction：**缺 await**（Promise 上取 .content，运行时 TypeError）；**"Text" 大写**
  （filter 恒空→永远拦截，mock 全绿但放行路径死——为此给场景补 run3 放行 case）；
  tarting 拼写；if/reason 填空代填。
- **`}>` 打成 `>}`（L40）**：本轮最诡异 bug。泛型闭合两字符顺序颠倒；Read 显示"正常"
  （肉眼自动纠正）、od 十六进制又看反，最终 charCodeAt 码点程序判定 + 代码拼接替换定案。
  教训：编译器报错就是错；工具显示会骗人，码点不会。
- **两处 `reason: string` 陷阱**：L8（evaluateGoal 签名，正确）与 L40（classifyAction，
  错误）含同文本，正则/offset 全命中第一处导致 patch 白打。调试时先确认报错位置到底
  在哪个实例。
- agent.ts：chat() 丢参数、if() 空条件、**to.name 笔误**（tu=tool use，编译器抓）、
  回灌文案缺指令后半句（reason 说"差什么"，指令说"接着干"，缺一不可）。
- cli.ts：--auto 照 --plan 抄**全对**（第二次写同模式即掌握）；argv[gi+1]/splice(gi,2)
  填空不会——代填。
- 教学注记：本章"熟悉的旁路模式"判断过于乐观——ch7/ch11 写过的模式没有自主迁移成功，
  全程代填+讲解为主。下次陌生度评估应看"距上次写这类代码隔了几章"，而非"写过没有"。

## 验收

`npm run mock -- 15`：13 项 ✓。goal run 端到端闭环（NOT_MET → reason 回灌 → 写
done.txt → MET → 落盘）；auto run 一拦一放（secret.txt 不存在、notes-auto.txt 存在、
分类器看到 secret.txt、模型收到 Blocked）。回归 ch1–12 全绿。

## 结语：全教材完结

ch1–12 + 15 代码章全部完成，ch13 复盘章完成。ch14（22 个手动场景）待真 API key 后
做总验收（含 Test 20–22 自治三项）。823 行学习代码，一个完整的 coding agent。
