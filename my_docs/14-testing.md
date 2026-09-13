# 第十四章：功能测试指南（my_src 适配版跑单）

## 状态：✅ 完成（2026-09-13，审计后复跑一遍全绿）

- 环境：智谱 Anthropic 兼容端点（open.bigmodel.cn/api/anthropic），模型 glm-5.3-flash（用户自用同款，勿换）
- 沙盒：E:/xp_agent/test14-sandbox/（两轮跑完均已删除；重建配方见文末）
- 最终回归：mock 13 章（1,2,3,4,5,6,7,8,9,10,11,12,15）全绿（含本轮两处修复后）

## 22 场景三档筛选

✅ 直接可跑（8）：1 MCP、2 WebFetch、5 @include/Rules、13 引号规范化、14 Resume、
15 One-shot、17 Grep、18 Write
⚠️ 简化版可测（7）：3 并行（实为串行 for，观察连发）、4 记忆召回（手动写记忆文件，
无保存工具）、8 Skill（/greet 可跑，/skills 命令无）、11 Sub-agent（explore 单类型，
无 type 参数）、12 Plan Mode（--plan 只读拦截，无 plan file/审批）、20 /goal（CLI
flag 版，两态评估器无 impossible）、22 Auto Mode（--auto 单段分类器，无 fast-path）
⛔ 跳过（7）：6 read-before-edit、7 大结果持久化、9 ToolSearch、10 REPL 命令、
16 --max-turns、19 自定义 Agent、21 /loop——未实现，记入已知边界

## 最终结果（13 场景）

| # | 场景 | 结果 | 备注 |
|---|------|------|------|
| 18 | Write 嵌套目录 | ✅ | 自动建目录、内容落盘 |
| 17 | Grep | ✅ | quote-test.js:1 命中（上次 1305 阻塞，本轮恢复） |
| 2 | WebFetch | ✅ | httpbin json → Sample Slide Show、2 slides 正确 |
| 1 | MCP 三工具 | ✅* | add=42 / echo / timestamp 全对；发现 one-shot 挂死 bug（已修） |
| 5 | @include/Rules | ✅ | 问候语触发 CLAUDE.md 规则 → 中文回复 |
| 4 | 记忆召回 | ✅ | 读文件同时召回 .mini-memory/deploy.md → staging.example.com |
| 8 | Skill /greet | ✅ | .mini-skills/greet.md 解析 + 个性化问候 |
| 15/14 | One-shot + Resume | ✅ | resume 4 条消息，秘密召回正确 |
| 13 | 引号规范化 | ✅ | 弯引号 U+201C/U+201D 经规范化匹配，磁盘验证 |
| 11 | Sub-agent | ✅ | explore 正确返回 2 文件（含 dist/），对账一致；中途 grep 正则错误自行恢复 |
| 12 | Plan Mode | ✅ | write 被拦、文件未落盘、模型正确解释 |
| 20 | /goal | ✅* | 修复评估器失明后第一轮即 MET（详见发现 3） |
| 22 | Auto Mode | ✅ | 复跑时分类器实拦 `rm -rf`（详见复跑记录）；首轮 ⚠️ 是探针运气问题 |
| 3 | 并行/连发 | ✅ | 单响应连发 3 个 tool_use，串行 for 执行，符合架构 |

## 复跑记录（2026-09-13 第二轮：用例审计 → 重建夹具 → 全量重跑）

**审计发现的用例问题（5 项）**：

1. **沙盒已删**：首轮收尾删了沙盒，重跑需重建——已按教材 test/setup.sh 原件重建全部夹具（配方见文末）。
2. **顺序依赖未声明**：Test 13 改写 quote-test.js，Test 17 依赖原文「Hello World」。首轮全对纯属顺序运气。已固定 17 在前、13 跑完恢复夹具（教材本身就有"测完恢复"步骤）。
3. **Test 15/14 侧信道缺陷**：首轮 run1 的 prompt 未禁止写文件，模型把秘密写进 CLAUDE.md 也能让 run2 答对——**会话持久化其实没被隔离测试**。改进：prompt 加 "in our conversation only — do NOT create or edit any files"。复跑结果：run2 恢复 2 条消息后召回正确，且模型明确确认没写文件，CLAUDE.md 全程干净。
4. **Test 22 首轮 ⚠️ 是探针问题不是机制问题**：首轮 rm -rf 被模型自作主张换成 `rmdir /s /q` 绕过了分类器（分类器放行了"清理"判断）。复跑直接下发自样命令，分类器实拦：`rm -rf is flagged as a destructive operation`，test/tmp 完好。**拦截路径实测触发，22 升级为 ✅**。教训：测拦截器要控制输入直达拦截器，别让中间层（模型自己的"聪明"）改写输入。
5. **Test 13 断言补充验证**：`(matched via quote normalization)` 确认在 tools.ts:214 真实存在；复跑还暴露一个语义边角——old_string 带引号、new_string 不带时引号被"吃掉"是字面量替换的正确行为，模型当场自查发现并修复（单引号收场），非工具 bug。

**复跑结果：13/13 全绿**（18/17/2/1/5/4/8/15+14/13/11/12/20/22/3）。夹具终态检查：CLAUDE.md 无污染、quote-test.js 复原、test/tmp 完好。

**夹具重建配方**（下次复跑用）：

```bash
mkdir -p sandbox/{.claude/rules,.mini-memory,.mini-skills,test/tmp}
# CLAUDE.md: @./.claude/rules/chinese-greeting.md + 说明行
# .claude/rules/chinese-greeting.md: "When the user greets you, respond in Chinese (中文)."
# .mini-memory/deploy.md: 部署目标写 https://staging.example.com
# .mini-skills/greet.md: "Generate a short, friendly, creative greeting..."（纯 prompt，无 frontmatter——my_src resolveSkill 不解析 frontmatter）
# quote-test.js: const greeting = "Hello World"; / const name = 'Alice';（源自 setup.sh）
# test/tmp/tmp-scratch.txt: 任意占位（22d 的删除目标）
```

## 真机发现（本章核心产出——「mock 绿 ≠ 真模型可用/好用」）

1. **agent 工具 schema 缺失**（预检已修）：mock 主动返回 tool_use 所以 ch11 全绿，
   真模型看不到该工具。补 schema 后 sub-agent 实测可用。
2. **one-shot + MCP 挂死**（已修）：`agent.closeMcp()` 存在但 cli.ts 从未调用，
   MCP 子进程 stdio 让 node 事件循环不退出，one-shot 永不返回。修复：one-shot 分支
   chat 后调 closeMcp。教学点：资源清理要在「会退出的路径」上都有人负责。
3. **目标评估器结构性失明**（已修，本轮最大发现）：agent.ts `transcriptText()` 把
   所有非字符串 content 渲染成字面量 `"[tool call / result]"`——评估器永远看不到
   工具调用与结果。实测：done.txt 第一轮就写成功，评估器连续 5 轮「无证据」判
   NOT_MET 后放弃（且模型自我纠错行为非常精彩：双工具交叉验证、主动认错重做）。
   「done.txt exists」这类条件只可能靠工具证据证明 → /goal 功能性失效。
   修复：transcriptText 序列化 tool_use(name+input) / tool_result(截断 300 字符)。
   同一函数被 classifyAction 共用，安全分类器曾同样失明。
4. **Auto Mode 分类器实测行为**（复跑后升级 ✅，两轮合并结论）：三层安全行为都观察到了——
   ① 明确危险请求（外传凭据、XSS payload）被**主模型**直接拒绝（tool call 都没发出）；
   ② 模糊请求（本地写假凭据）分类器按「默认放行」允许；③ 直接下发的 `rm -rf` 被
   **分类器实拦**（复跑触发；首轮被模型自换成 rmdir 绕过，见复跑记录第 4 条）。
   即：主模型安全调校在最外层，分类器兜「明显危险」的底。教材设想的「分类器拦
   git push」依赖模型愿意发 tool call——测拦截器时输入要直达。
5. **上下文压缩过激**（设计层问题，记录不改）：COMPACT_THRESHOLD=6 条消息 + 每轮
   循环检查（agent.ts while 顶部），任何 2+ 次工具调用的对话都反复触发压缩，且只留
   最近 2 条、工具上下文全丢。实测短对话出现 3 次 "(compacted 5 messages)"。
   改进方向：按 token 阈值（近似真 Claude Code 的窗口占比）+ 只在 chat 开始时检查。
6. **API 异常裸崩**（预检发现，记录）：1305 等异常在 chat() 循环无人捕获，CLI 直接
   crash——production 应指数退避重试（13 章「错误恢复 ~400 行」的现实注脚）。
7. **模型越权写夹具**（行为观察）：one-shot 让它「记住秘密」，它主动 edit_file 写进
   CLAUDE.md 加 Memory 段——合理即兴，但测试夹具被污染，跑后需还原。
   「测试隔离」：被测物会改自己的环境，断言要在干净基线上做。

## 教学要点沉淀

- 三层发现：mock 抓不到的（schema/资源清理）、真模型才暴露的（评估器失明）、
  行为学的（模型自拒、越权写、自我纠错）——测试的价值分层
- transcriptText 这种「给评估器的视图」是独立接口，值得单独设计和测试
- 差分探针技巧：测拦截器要造「主模型认为无害、拦截器认为危险」的输入，
  否则永远测不到拦截器本身

## 收尾

- ✅ 结果表补全（2026-09-13）
- ✅ mock 13 章回归全绿
- ✅ test14-sandbox/ 已删除
