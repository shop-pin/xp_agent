# 第十六章：UI 外观层与 frontmatter 地基（进阶轮第 1 章）

## 为什么是这两块开章

进阶轮要把 my_src 对齐 src（5558 行）。第一个障碍不是功能而是**地基**：

- `ui.ts`：现在 agent.ts / cli.ts 里散落着 `console.log`、`process.stdout.write`。后面 10 章每章都要新增输出（重试提示、费用、审批框、子代理框……）——没有一个统一出口，每章都会把 printf 式调试越堆越乱。src 把所有终端输出收进一个 215 行的模块。
- `frontmatter.ts`：后面 memory（22 章）、skills（23 章）、自定义 agents（23 章）三种文件都用 `---` YAML 前置块。解析器写三遍不如共用一个。

两者都不碰 agent 循环、无状态、回归风险最低——热身章。

## 本章不照抄 src 的一个决策

src 的 `printToolCall` 输出 `  📖 read_file /path`（图标+摘要）；my_src 现在是 `  ->read_file({...})`。
我们核对过 run-mock 的全部断言：**锚定的是请求体内容（system、messages、工具名），不锚定 stdout 格式**——所以可以安全换成 src 风格。
（工程判断：断言锚在协议上而不是装饰上，是测试写得好的标志。）

## chalk 与 ANSI 最小知识

- chalk 5 是纯 ESM——my_src 的 package.json 是 `"type": "module"`，直接可用。
- 终端色的本质是 ANSI 转义序列：`\x1b[31m` 红、`\x1b[2m` 暗、`\x1b[K` 清除光标到行尾。chalk 只是把这些封装成 `chalk.red("...")`。
- 两个本章会用到的控制字符：
  - `\r`（回车不换行）：把光标移回行首——spinner 靠它原地重画
  - `\r\x1b[K`：回行首 + 清到行尾——spinner 停止时擦掉自己

## Spinner 的生命周期陷阱（本章你的设计点 1）

单例 spinner 的三个经典坑：

1. **重复启动**：REPL 一轮没停干净又开新一轮 → 两个 setInterval 同时改一个 frame 计数 → 画面抽搐。守卫：start 时发现已在跑就 no-op。
2. **定时器泄漏**：`setInterval` 会让 node 进程永远不退出（和 ch14 的 MCP 子进程挂死同根源！）。stop 必须 `clearInterval` 且把句柄置 null，两者缺一不可——只 clear 不置 null，"已在跑"守卫就永远判断不出真实状态。
3. **擦除时机**：stop 后流式文本要接着打印，先 `\r\x1b[K` 擦掉 spinner 行，否则残留半帧。

对照 ch14 的发现：**「任何 setInterval / 子进程 / 未关闭的流都会挂住事件循环」是同一条原理的第三次出现**（第一次：MCP 挂死；第二次：mock 里忘了清 timer 测试卡住）。

## Diff 着色的分类决策（本章你的设计点 2）

edit/write 的结果里混着四类行：diff 头（`@@`）、删除行（`- ` 前缀）、新增行（`+ ` 前缀）、普通预览行。着色前要想清楚：

- **前缀判断的顺序**：`startsWith("@@")`、`startsWith("- ")`、`startsWith("+ ")`、默认 dim。注意 `- ` 和 `+ ` 带空格——不带空格的 `-`/`+` 是内容本身，不能误判（判断优先级你来定）。
- **空行**：跳过还是照打？src 选择跳过（`!line.trim()` continue）。
- **截断策略**：预览行上限 40，超出打 `... (N more lines)`。上限放循环外判断还是循环内 break？（提示：slice 先截，再数剩余——两次遍历换可读性。）

## frontmatter 规格（我代填，你 review）

src 版只有 41 行，刻意不引 YAML 库：

- `parseFrontmatter(content)`：首行 `---` 才算有 frontmatter；找下一个 `---` 作结束；之间每行取**第一个**冒号切 key/value（value 里可以有冒号）；无前置块返回 `{ meta: {}, body: 原文 }`（容错优先——memory/skills 文件大多是手写的，格式歪了不能崩）
- `formatFrontmatter(meta, body)`：反向拼装，用于 22 章 memory 保存

## 分工与流程

| 部分 | 谁做 |
|------|------|
| frontmatter.ts 全部、ui.ts 其余打印函数、agent/cli 接线、回归验证 | Claude 代填 |
| **spinner 生命周期**（startSpinner/stopSpinner 两个函数体） | **你写**（骨架已留 TODO） |
| **printFileChangeResult 逐行分类循环** | **你写**（骨架已留 TODO） |

## 分步提示

1. 先读 my_src/ui.ts 里两处 `TODO(你来写)` 块，对照上面两节的要点
2. 写 spinner：start 三步（守卫→首帧打印→setInterval 记句柄），stop 两步（clear+置 null→擦行）
3. 写 diff 循环：`for (const line of displayLines)` 里四分类，空行 continue，循环后补截断提示
4. 写完口头复述两个问题：①为什么 stop 里"置 null"不能省？②`- ` 判断为什么要放在默认 dim 之前、和 `@@` 的先后有关系吗？
5. `npm run build && node run-mock.mjs` 全量回归

## 收尾记录（2026-09-17）

- 交付：ui.ts 全部完成（用户手写 diff 逐行分类循环、startSpinner/stopSpinner，review 两轮）；frontmatter.ts 代填示范；回归 13/13 绿
- 复习题记录：
  - 置 null 题：首答方向反了（以为 spinner 会继续打印）。正解：clearInterval 已当场停打印；漏置 null 的真实 bug 是旧句柄残留 truthy → startSpinner 守卫误判"已在跑"→ 之后所有 API 调用 spinner 永远不再出现
  - if/else-if 顺序题：初看没懂题意，讲解后三行口算全对（`@@`行→cyan、`- `行→red、`---`→else，因 `- ` 带空格不匹配）
- 本轮出现的两个 JS 基础坑（记录供后续章节参考）：
  1. `spinnerTimer.setInterval(...)` 与 `spinnerTimer = setInterval(...)` 混淆——定时器句柄是 setInterval 的**返回值**，要赋值存起来
  2. `% spinnerFrame.length`——数字没有 length，编译器直接报错（类型系统的价值）
- 两类 bug 的对照样本：编译器抓得住的（number.length）vs 只有人眼抓得住的（重画输出混入 `\n`，类型对、mock 也测不到）——显示层 bug 的典型特征
- 22 章复习点：frontmatter.ts 为何缺结尾 `---` 时整个当正文（丢元数据好过丢正文——正文才是用户数据）
