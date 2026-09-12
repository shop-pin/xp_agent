# 第八章：记忆系统（memory.ts）

## 原理

到此为止 agent 的"记忆"只是 `this.messages` 数组，会话一关全忘。本章给它跨会话的长期记忆，最小闭环三步：

```
存（现有 write_file 工具即可，无需新代码）→ 召回（词重叠打分，零 API 调用）→ 注入（追加进 system prompt）
```

- **存储**：一条记忆一个 `.md` 文件。我们用 `MEMORY_DIR = .mini-memory`（cwd 相对，和第 4 章
  `.mini-session.json` 同风格）；教材生产版是 `~/.mini-claude/projects/{cwd sha256}/memory`，
  思想一致，只是路径哈希隔离了不同项目。
- **召回**：`recallMemories(query)` —— query 分词成集合，逐个记忆文件分词成集合，score = 交集大小；
  score > 0 才收集，降序取 top 3，拼 header 返回。**集合精确匹配，不是子串**："deploys" ≠ "deploy"。
- **注入**：`system += recallMemories(userText)`，追加在静态 system prompt 之后。
  传的是用户原话 `userText`，不是拼过 context reminder 的 `content`——reminder 里的日期/目录只会稀释打分。

## 值得记住的思想

- **召回进 system 而非 user message**：事实性上下文属于系统层。测试专门有断言验证
  "memory 在 system 里、不在 firstUserText 里"——接线位置本身是被测契约。
- **关键词召回的天花板：中文全灭**。`/\W+/` 分词下 `\w` = `[A-Za-z0-9_]`，中文字符全是 `\W`
  （分隔符），"部署流程是什么" 分词后 queryWords 为空，召回静默失效。
  这正是教材后半段 sideQuery 语义召回的动机：让模型判断相关性，而不是词面重叠。
  生产版还加了异步预取（与首次模型调用并行）、alreadySurfaced 去重、60KB 会话预算、
  freshness warning（>1 天的记忆附"可能过时"警告）——本章均未实现，属选读。
- **死代码教训再现**：memory.ts 写完但 agent.ts 没接线时，mock 立刻暴露——两条断言红，
  其余绿，失败模式精确指向"没人调用"。机制生效 ≠ 函数存在。

## Review 记录

### 施工（2026-09-12）：三轮检视，mock 5 项 ✓，回归 ch1–7 全绿

写对的关键点：早退分支、打分循环（遍历 query 集合查 content 集合，逻辑正确）、
`scored` 数组的 TS 类型标注、最终注入一行。

过程问题（按发现顺序）：

1. **目录名少前导点**：`./mini-memory` vs `.mini-memory`——读的是另一个空目录。
2. **字符串 vs 正则（出现两次）**：`split("/\W+/")` 按字面量切分，整段文本变成一个"词"，
   交集恒 0。第 10 行改了第 15 行没改——同章同坑复发。
3. **裸文件名**：`readFileSync(f)` 漏 `join(MEMORY_DIR, f)`，readdirSync 返回的不是路径。
   第 2 章 tools.ts 同款坑。
4. **字段名对不上**：`push({content})` vs `t.text`——TS "Did you mean 'content'" 当场抓获。
5. **比较器返回布尔**：`sort((a,b) => a.score > b.score)` 被强转 1/0、永无负数，排序失效。
   比较器契约是"负数 → a 排前"，数值用 `b.score - a.score`。
6. **代码被包进模板字符串**：整条 sort/slice/map/join 链写进了反引号里，变成原样返回的
   字面文本。模板串里只有 `${}` 是代码。
7. **函数 vs 函数调用**：接线时写 `+ recallMemories`（无括号无传参），函数对象被 toString
   进 system prompt，TS2365 编译报错。且要传 `userText` 原话而非拼过 reminder 的 `content`。

**本轮错误画像**：7 个问题里 4 个（2、6、7、以及 4 的一半）同属一类——
**"字符串和代码的边界"**：该是正则的地方给了字符串、该执行的表达式进了字面串、
该调用的函数只给了引用。JS 动态类型下这类错不一定编译期能拦，靠 mock 的请求断言兜底。

### mock 场景设计（脚手架，run-mock.mjs "8"）

沙箱预置两个记忆文件：`deploy.md`（与 query 共享 deploy/test/changes，score=3）、
`color.md`（favorite color，零重叠）。断言五项：单次调用、相关记忆进 system、
header 存在、**无关记忆被过滤（反向断言）**、**召回在 system 不在 user message（接线位置断言）**。

设计时自己踩了一脚集合精确匹配：初版 deploy.md 写 "Deploys go to..."，query 里是 "deploy"，
复数词形交集为 0——改写记忆文本让词形精确重叠后打分才成立。

最终：`npm run mock -- 8` 5 项 ✓；回归 ch7/6/5/4/3/2/1 全过。第八章完成。
