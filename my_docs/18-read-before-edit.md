# 第十八章：read-before-edit 与 edit 质量（进阶轮第 3 章）

## 为什么需要 readFileState

现在的 edit_file 是**盲写**：模型基于它上次读到的内容构造 old_string，但磁盘上的文件随时可能已经变了——用户改的、别的进程改的、甚至模型自己上一轮改的。盲写的两种事故：

- **错位替换**：old_string 恰好还在，但上下文已经不对，改完语义错；
- **静默覆盖**：write_file 直接把外部修改全部冲掉，谁都不知道丢了什么。

src 的模型（tools.ts:746-799 + agent.ts:247）：

- Agent 实例持有 `Map<string, number>`：键 = **绝对路径**，值 = 上次见到内容时的 `statSync().mtimeMs`
- `executeTool` 加第三参 `readFileState?`，三个动词各司其职：
  - **记**：read_file 成功后，把当前 mtime 存进 map
  - **比**：write_file / edit_file 执行**前**，文件存在时查 map——没读过 → 拒绝；mtime 对不上 → 拒绝
  - **更新**：写成功**后**，把新 mtime 回写进 map（防自伤，见设计点 3）

顺带：edit 成功后输出 diff（`@@ -行,几行 +行,几行 @@` + `-`/`+` 行），generateDiff 已由 Claude 代填，思路在下方"代填讲解"。

## 设计点（写之前想清楚）

**1. 键用什么？**
模型可能 read `a.txt` 然后 edit `./a.txt`——同一文件、两个不同字符串。若拿原始 `input.file_path` 当键，第二次直接绕过检查。结论只能有一个：`resolve(input.file_path)` 后再当键。想一下反例还有哪些形式（`a/../a.txt`、Windows 大小写）。

**2. 检查放哪层？**
候选 A：executeTool 的 switch 里（src 的选择）——"这次调用是 read 还是 edit"是**编排**知识，helper 保持无状态纯函数，map 只活在一个地方。候选 B：塞进 readFile/writeFile/editFile 内部——helper 得把 map 加进签名，四个 helper 都沾上状态。两种都写得出理由，你选一个，口答时说清取舍。

**3. 写后回写防自伤（本章最核心的坑）**
第一次成功 edit 后，文件的 mtime 已经变了。若不把新 mtime 回写进 map，第二次 edit 一进来就"mtime 对不上"→ 被误判外部修改 → **这个文件永远只能编辑一次**。回写动作 = 成功后重新 `statSync(absPath).mtimeMs` 存回 map（不能拿执行前 stat 的旧值）。ch18 mock 的"立即再 edit"断言就是验证这条。

**4. 新文件门控 + map 的真正语义**
write 一个不存在的文件，不该被"必须先读"拦住——没东西可读，src 用 `existsSync` 门控。写成功后 map 里有了这个文件，后续 edit 直接放行。把两件事放一起看，map 的语义不是"读过的文件"，而是**"模型最后一次亲眼见到该文件内容的时刻"**——read 是见到，亲手写也是见到。想通这个语义，第 3、4 点都是它的推论。

**5. statSync 的两个边角**
- 判定"read 成功"的判据：src 用 `!result.startsWith("Error")`——错误消息一换措辞就失效。更稳的做法是让 helper 返回结构化状态，但改动面大。你抄 src 的判据还是改 helper 签名？说清理由即可。
- **比**处的 `statSync` 若抛（existsSync 判断和 stat 之间文件被删，TOCTOU）会裸奔到 Agent 循环里炸掉整轮。src 这里没包 try/catch，是个粗糙点。你的选择：失败按"外部修改"拒绝（保守），还是放行（可用性）？口答说理由。**记**/更新两处 src 用 `try{}catch{}` 静默跳过——簿记是尽力而为，不该因为记账失败毁掉一次成功的读写。

**6. 为什么放 Agent 实例字段，不放模块级？**
subagent.ts:28 也直接调 executeTool。模块级 Map 会让主 agent 和子 agent 共享簿记——子 agent 读过的文件"豁免"主 agent 的检查，语义混乱。实例字段 + 显式传参，数据流向看得见（同 ch17 惰性求值：别把状态做成全局耦合）。

## 分工

| 部分 | 谁做 |
|------|------|
| readFileState 判定策略：记/比/更新三处逻辑（位置你定，executeTool case 或 helper 内均可） | **你写** |
| executeTool 加第三参 `readFileState?` + agent.ts 持有 Map 并传入 | Claude（已完成） |
| generateDiff + editFile 接线 | Claude（已完成，讲解见下） |
| run-mock ch18 场景 | Claude（已写好） |

## 代填讲解：generateDiff

src/tools.ts:355-371。输入不需要新文件全文——editFile 里 `content.split(actual).join(new_string)` 之前，`content.split(actual)[0]` 就是匹配点之前的全部文本，数一遍换行符即得行号。输出 = 一行 hunk 头 + old_string 按行拆 `- ` + new_string 按行拆 `+ `。这是**语义 diff**（只描述这次替换），不是逐字符 diff——足够让模型（和用户）核对改动，token 又省。注意传给它的 oldString 是 `actual`（文件里的原始子串），不是模型输入的 old_string，否则弯引号场景下 diff 和实际改动对不上。

## mock 场景说明（ch18）

**六个工具打包进一个 assistant 回合**（真实模型也常这么干），agent 顺序执行。断言锚 `toolResults` 文本 + 磁盘内容：

1. 未读先 edit target.txt → 期待 "must read this file before editing"（拦截文案锚定这句，与 src 一致——写你的错误消息时带上）
2. read target.txt（记）
3. edit alpha→beta → 期待 Successfully edited
4. **立即再 edit**（unique body→edited body）→ 期待再次 Successfully edited——若你漏了回写，这里会报 "modified externally"（防自伤断言）
5. read dup.txt（内容有两行一样的）
6. edit 非唯一 old_string → 期待 "found 2 times"，且 dup.txt 落盘不变

为什么打包成一个回合而不是六轮脚本？my_src 的 `COMPACT_THRESHOLD = 6`（context.ts:3），六轮工具每轮净增 2 条消息，第三轮就会触发 ch7 的压缩——aux summarize 请求混进 main track 吃掉脚本轮次（实测踩过）。单回合批量峰值只有 4 条消息，永不触发压缩。

**注意：你动手前 ch18 的 1 号断言就是红的（未读编辑畅通无阻）——预期基线，写完转绿。** 2 号断言基线也绿（第一次编辑直接成功了），它的真正意义是实现后防"过度拦截"——把合法编辑拦了它才会红。

**ch21 迁移警示**：ch21 计划给并发安全工具加"提前执行"。届时同一批里的 read_file 可能跳到 edit 前面执行，1 号断言会假红——到时重审本场景（把 read 和被拦的 edit 拆到不同批次，或断言只锚磁盘副作用）。

另外两点说明：
- mtime 对不上（外部修改）分支没有进 mock——mock 驱动无法在两轮之间碰磁盘，这条留给真机冒烟
- readFileState **不进 session 持久化**：--resume 后 map 为空，恢复的会话首次 edit 会要求先 read。src 就这样——多读一次的成本，换来不引入跨进程状态的复杂度，可接受

## 分步提示

1. 先把三个口答题的答案想出来：①键为什么必须 resolve？②不回写 mtime 会发生什么？③比处 statSync 抛异常你按哪种处理？
2. 决定放哪层（设计点 2），然后三处逻辑一次想完再动手：记（成功后 set）、比（执行前 has + mtime 相等）、更新（成功后重新 stat set）
3. 判定"成功"用 src 的 startsWith("Error") 还是改 helper 签名——先定这个再写
4. `npm run build && node run-mock.mjs 18` 看红转绿 → 全量回归 14 场景
5. 写完自查一遍设计点 5 的边角：read 一个不存在的文件（报错）→ map 里有没有它？→ 再 edit 它会怎样？两条路径都想一遍

## 收尾记录（2026-09-18）

- 交付：readFileState 三动词（用户首写 → review 发现多层坑 → Claude 代填收尾）、executeTool 第三参接线、generateDiff、mock ch18 六断言全绿、回归 13/13
- 用户首写正确部分：**选了 helper 层**（设计点 2 的 B 选项，合法）✓、**键用 resolve 的意识**（设计点 1 答对）✓、readFile 里"记"的位置 ✓
- 用户原稿的坑（按教学价值排序）：
  1. **幽灵 readFileState**：switch 里 `readFile(input as { ...; readFileState: Map })` 是在**声明** input 有这个属性——但 map 在 executeTool 的第三参里，从未流入 helper；helper 里又裸写 `readFileState` 标识符（作用域里根本没有）。两处同源：**状态的所有权和传递路径没想清楚，靠 cast 说谎让编译器闭嘴**。就算编译过，运行时 `undefined.set()` 抛错还会被自己的 try/catch 吞掉——ch17"容错把崩溃变静默失败"的教训原样重演
  2. **Map 方括号访问**：`readFileState[key]` 在 Map 上永远 undefined（不报错），必须 `.has()/.get()`——正是 ch17 文档预警的"parse 错对象"类 API 语义坑
  3. **`=== 0` 值语义错**：map 的值是"上次见到的 mtime"，不是计数器/布尔，永远不会是 0
  4. **`stat.mtime` 是 Date 不是 number**：类型契约要 `mtimeMs`
  5. **"比"只有一条分支且恒假**：未读（`!has`）与过期（mtime 不等）是两个分支、两种文案
  6. **editFile 三动词零实现**、三处全缺"更新"（写后回写）
  7. 拦截文案没带锚定句 "must read this file before editing"（mock 断言锚它）
  8. statSync 与 readFileSync 同一个大 try：stat 一炸，成功的读被报成错——簿记拖累本体
- 代填时的两个决策（讲解）：
  1. map 以**第二个参数**流入 helper（`readFileState?: Map<...>`，可选）——subagent.ts:28 调 executeTool 不传 map，可选性不是摆设：不传 = 不启用检查，helper 内 `if (readFileState)` 门控
  2. "比"处 statSync 抛（TOCTOU）**由外层 catch 收成一次普通失败**（"Error writing/editing file: ..."），不炸循环——src 这里是裸奔（已知粗糙点），折中改良；严格保守派可以特判成拒绝，说出理由即可
- 三道口答题答案（用户未口答，代填讲解覆盖）：
  1. 键 resolve：模型可能 read `a.txt` 后 edit `./a.txt`——同文件不同字符串，拿原始路径当键检查形同虚设
  2. 不回写 mtime：第一次成功 edit 后 mtime 已变，第二次 edit 被误判"外部修改"→ 文件永远只能编辑一次；ch18 断言 3（同批内立即再 edit）专门验证它
  3. 比处 statSync 抛：见上——本次实现选了"外层 catch 收成普通失败"，取舍是可用性与保守性的折中
- map 的真正语义（本章最值钱的一句话）：**"模型最后一次亲眼见到该文件内容的时刻"**——read 是见到，亲手写也是见到（所以新文件写完后续 edit 直接放行）；--resume 后 map 为空，首次 edit 要求重新 read，可接受
- ch21 迁移警示：并发安全工具提前执行落地时，同批内 read 可能跳到 edit 前面，ch18 的 1 号断言会假红——迁移时把 read 与被拦 edit 拆批或只锚磁盘副作用
- ch19 预告：权限流水线（settings.json 规则、checkPermission 8 阶段、5 权限模式）——注意本章"比"的两分支文案风格（Error 拦 vs Warning 拦）到时会被结构化成 {action, message}
