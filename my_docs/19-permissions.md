# 第十九章：权限流水线（进阶轮第 4 章）

## 为什么是流水线

现状：my_src 的 checkPermission 只有一个 DANGEROUS 正则表 → deny，两态。它答不了三个问题：

- `--yolo` 到底该跳过什么？（危险命令也放行吗？deny 规则呢？）
- allow 规则怎么做到"免确认"？
- plan 模式的只读契约，凭什么不能被 --yolo 买断？

src 的模型（tools.ts:546-715 + agent.ts:1757-1779 + cli.ts:34-41）：

- **规则文件**：`~/.claude/settings.json`（用户级）+ `.claude/settings.json`（项目级），`permissions.allow` / `permissions.deny` 字符串数组。语法：`"run_shell(rm *)"` = 管这个工具且 command 以 `rm ` 开头；`"read_file"` = 管这个工具的一切调用
- **三态决策**：`checkPermission → { action: "allow" | "deny" | "confirm", message? }`。deny = 机器拒绝；confirm = 交给人（Agent 的 confirmFn）；allow = 放行。**三态的意义**：rm -rf 在 REPL 里该问人，在 CI 里该拒绝（dontAsk 转 deny），在 --yolo 里该放行——同一份清单在三种上下文各有正确行为，旧的两态做不到
- **5+1 模式**：default / plan / acceptEdits / bypassPermissions（--yolo）/ dontAsk（CI）+ auto（走分类器，不进本流水线，ch26 收口）
- **八阶段流水线**：顺序本身就是安全语义（本章你要写的核心）

## 八阶段：原料在这里，顺序你来定

checkPermission 收到 `(toolName, input, mode)` 后，下面这些检查**全都要做**，但你决定先后（每阶段一个 return，顺序短路，不要 if-else 嵌套）：

- deny 规则命中（checkPermissionRules，已给：deny 先于 allow 扫）
- allow 规则命中
- plan 模式只读契约：EDIT_TOOLS 拒绝、run_shell 拒绝（文案须含 "plan"——ch10 断言锚它；plan 文件可写豁免留 ch25）
- bypassPermissions：全放行
- READ_TOOLS：放行
- acceptEdits + EDIT_TOOLS：放行
- confirm 候选：isDangerous(run_shell 命令) / write 不存在的新文件 / edit 不存在的文件
- dontAsk 模式：confirm 候选直接转 deny（"Auto-denied (dontAsk mode): ..."）
- 兜底 allow

（src 还有 enter/exit_plan_mode 工具放行阶段——那两个工具 ch25 才有，暂缺。）

## 设计点（写之前想清楚）

**1. deny 规则为什么在一切之前，连 --yolo 都拦？**
--yolo 跳过的是"确认"——人对可商量事务的把关；它跳不过**用户在配置文件里写下的显式禁令**。deny 规则是配置里的意志，优先级高于任何运行时快捷方式。想反例：如果 --yolo 能拦过 deny 规则，`settings.json` 里写 `deny: ["run_shell(rm *)"]` 就成了摆设。

**2. plan 为什么在 bypass 之前？**
plan 模式的存在意义就是只读契约。`--plan --yolo` 若让写操作通过，组合就自相矛盾。排序直觉：**显式禁令 > 模式契约 > 便捷快捷方式 > 默认行为**。

**3. allow 规则的核心价值 = 免确认**
新文件写本来会落到 confirm 阶段；allow 规则命中后直接放行。对比 READ_TOOLS（反正放行）——**allow 规则对读工具没有增量价值**。想清楚这一点，你才能判断 allow 阶段该放在 READ_TOOLS 之前还是之后（对结果无差，但想明白为什么无差）。

**4. matchesRule 的值提取（你写）**
run_shell 匹配 `input.command`，其余匹配 `input.file_path`，都没有时"工具名命中即匹配"。通配语义：pattern 以 `*` 结尾 → 前缀匹配；否则全等。边界：`grep_search(path)` 这类带 path 的工具，src 只认 file_path——值提取的覆盖面是有意收窄的，想想为什么这样够用。

**5. confirm 的缓存（confirmedPaths）**
同一 message 确认一次后存进 Agent 的 `Set<string>`，同会话内同路径不再问。为什么按 message 缓存够用：confirm message 里含路径（"write new file: X"），同路径第二次写时文件已存在，走的分支都不同了。**auto 模式的 confirm 带的是 reason 不是 path，绝不能缓存**——一次放行会洗白之后所有同理由的操作（ch26 的坑，先记住结论）。

**6. 语义迁移：危险命令从 deny 升级为 confirm**
旧版：DANGEROUS 正则 → 机器直接拒。新版：isDangerous → confirm 交给人。为什么升级：旧两态下 rm -rf 在任何上下文都只能拒绝，但 REPL 里用户可能就想删（问一下即可）；deny 只该留给**配置禁令**这种无商量余地的东西。ch6 场景随之迁移 --dont-ask（CI 语义：confirm 候选自动转 deny）。

## 分工

| 部分 | 谁做 |
|------|------|
| parseRule（规则解析）、matchesRule（通配语义）、checkPermission 八阶段顺序 | **你写** |
| 类型/常量/READ_TOOLS/EDIT_TOOLS/isDangerous（src 清单全量移植，含 Windows）/loadSettings/loadPermissionRules | Claude（已完成） |
| agent 接线：三态消费、confirmedPaths、confirmFn + setConfirmFn、fallback readline、auto 分流 | Claude（已完成） |
| cli 接线：--yolo/-y、--accept-edits、--dont-ask、REPL setConfirmFn 复用 readline | Claude（已完成） |
| mock ch19 + ch2/ch6/ch15 迁移 | Claude（已完成） |

## mock 场景说明（ch19）

三 run，setup 写项目级 `.claude/settings.json`：deny `["run_shell(rm *)"]` + allow `["write_file(allowed.txt)"]`：

1. `--yolo` + rm -rf tmp → **规则拦截**（阶段①在 bypass 之前；tmp 里的文件必须存活）
2. 默认模式 + rm -rf tmp → 同样被规则拦（对照：没有 --yolo 也拦，原因相同）
3. 写 allowed.txt（新文件）→ **allow 规则免确认**直接落盘（若没有这条规则，新文件写会落到 confirm，mock 里无人应答）

旧场景迁移（语义变化的必然代价）：
- **ch6**：Agent 直跑 → runs + `--dont-ask`（rm -rf 走 confirm → dontAsk 转 deny，"Denied" 锚定保持）
- **ch2**：Agent 直跑新文件写会挂等确认 → 驱动加 `autoConfirm` 注入 confirmFn=true
- **ch15 goal run**：done.txt 是新文件写 → argv 加 `--accept-edits`（阶段⑥放行）

**红基线**：你动手前 ch19 的 1、2、3 号断言红（stub 全放行，rm 真执行了，tmp 被删）+ **ch10 红**（plan 阶段②未实现，report.txt 被写出）+ **ch6 红**（dontAsk 阶段⑦未实现，rm 执行了）——写完全绿，其余 12 个场景全程保持绿。

## 分步提示

1. 先别看 src——只凭上面原料清单自己排一个顺序，写下理由；然后对照 src/tools.ts:641-715 校验，每处不同说出谁对
2. parseRule：一个正则（src 用 `/^([a-z_]+)\(.+\)$/`）；想想 pattern 里不含嵌套括号为什么够用
3. matchesRule：工具名判断 → pattern null 判断 → 值提取 → 通配/全等，四步
4. checkPermission：每个阶段一行 return；写完自问"每条规则/每种模式在这一排里各自卡在哪一站"
5. `npm run build && node run-mock.mjs 19` → `node run-mock.mjs 10` → 全量回归 15 场景
6. 口答三题：①--yolo 跳过了什么、没跳过什么？②allow 规则对 read_file 有没有价值，为什么？③ch6 的 rm -rf 为什么从 deny 变成 confirm，deny 现在留给谁？

## 收尾记录（2026-09-18）

- 交付：parseRule/matchesRule/checkPermission 八阶段（用户首写两处 → review 发现多处方向性坑 → Claude 代填收尾）、agent/cli 接线、REPL confirmFn、mock ch19 + ch2/ch6/ch15 迁移、回归 15/15
- 用户首写的坑（按教学价值排序）：
  1. **parseRule 特判数据而非解析语法**：硬编码 `rule === "run_shell"` 返回 `"rm *"`——把 ch19 mock 的两条具体规则写死进了"解析器"。后果：`"write_file(allowed.txt)"` 会被解析成 `{tool, pattern: null}` → 单文件 allow 规则放大成放行一切写操作。**解析错误在 allow 方向是 fail-open**，权限系统最不能犯的错。正解：一个锚定正则面向语法 `/^([a-z_]+)\((.+)\)$/`
  2. **matchesRule 第一条判断方向反了**：`tool != toolName && pattern === null → true` = "工具不匹配也算命中" → deny 裸 `"read_file"` 会拦掉除 read_file 之外的一切工具。"命中"= 规则适用于本次调用，工具名相等才可能命中
  3. **`input.filePath` 属性名不存在**（模型传 snake_case `file_path`）→ 恒 undefined、分支静默失效——"parse 错对象"类 API 坑第三次出现（ch17 JSON.parse 路径、ch18 Map 方括号、这次属性拼错），特征都是不报错
  4. **命中返回 false**：pattern 匹配成功应 return true，方向又反
  5. 小点：`!=` 应 `!==`；"read_file" 分支与 fallback 重复；特判 "run_shell" 应泛化为取值链
- 代填讲解：
  1. **parseRule 用锚定正则**：语法只有两种形态（`tool(pattern)` / `tool`），一个正则全覆盖；`(.+)\)$` 贪婪取到最后一个右括号，pattern 里再含括号也能正确截住
  2. **matchesRule 四步各一个 return**：工具名最先排除（最便宜、最排他）→ pattern null 视为管一切 → 取值链（run_shell→command，其余→file_path，都没有视为"值无关"命中）→ `*` 前缀或全等
  3. **checkPermission 的两个实现决策**：①规则表只扫一次（`ruleResult` 变量），①④共用——两次调用间规则不会变，省一半扫描；②dontAsk 的 deny 放在 confirm 候选**内部**——只有"本来要问人的"才转拒绝，读工具和普通写不受影响（dontAsk 的语义是"别问，能拒绝的拒绝"，不是"全拒绝"）
  4. confirm 消息的构造：shell 给命令原文，写/编辑给 "write new file: X"——**message 是 confirm 的全部上下文**（用户就靠它决定 y/n，见 REPL 修复：agent 层 printConfirmation 先打出来）
- ch19 场景的教育点回顾：allow 规则 `write_file(allowed.txt)` 若没有阶段④，新文件写会落到阶段⑦ confirm——mock 里无人应答。allow 规则的核心价值 = 免确认，这条断言就是它的存在证明
- 下一章 ch20 预告：MCP 多 server + withRetry 指数退避 + token 预算——withRetry 的重试判定与退避、budget 检查点选位引导自写；注意 MINI_CLAUDE_SDK_MAX_RETRIES=0 隔离 SDK 内置重试
