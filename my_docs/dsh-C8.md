# dsh-C8 会话持久化 JSONL（C 阶段收官）

> 本章产物：`plugins/session-jsonl.ts`（逐事件落盘 + readSessionLines + getLatestSessionId + repairUnclosedTurn）；SessionLog 加 onAppend/onClear 钩子；Agent.resume（重放 + 派生恢复）；`session.ts`（旧 JSON 快照版）删除；autoSave/restoreSession 消亡；场景 32。
> 一句话：**落盘的不是消息快照，是事件日志本身**——resume = 逐行重放，请求历史 derive 出来，非消息状态（mode/cost/轮数/激活工具/goal）从注记与 assistant 事件**派生**恢复。
> 参照物：`packages/core/session/src/` 持久化段。

---

## 1. 旧快照的三个天花板

旧 `saveSession` 在 turn 收敛时把 `this.messages` 数组 JSON 快照进 `<id>.json`：

1. **丢一切非消息状态**——mode、cost 四计数、激活的 deferred 工具、goal，resume 后全部归零；
2. **快照与日志两本账**——C3 之后会话已有事件日志，快照是并行维护的第二份状态（还是压缩改写后的失真版）；
3. **崩溃即丢一个 turn**——两次 autoSave 之间的一切都蒸发，连"死到哪了"都不知道。

JSONL 方案三个天花板全拆：每事件即落盘（崩溃最多丢半行，半行丢弃兜底）；resume 是重放（日志是唯一账本）；派生恢复（不是"存了才能恢复"，是"日志里本来就有的都能恢复"）。

## 2. 设计要点

**onAppend 拿到的是合并前的原始事件**。SessionLog.append 会合并连续 user/message——订阅钩子在合并前触发，JSONL 存原始流；重放再走 append，合并语义自动复现（cordis 测试钉死：往返 derive 逐字节一致）。这是"钩子挂哪一层"的典型抉择：挂合并后，重放就需要知道合并规则；挂合并前，重放**复用**合并规则。

**/clear 是一条标记行，不是截断文件**。append-only 的世界里没有"删掉前半文件"——`log/clear` 标记行落盘，重放遇到即 clear（注记层完整性交给事件流自己维护）。

**持久化惰性挂载（ensurePersistence）**，三个理由：resume 必须在挂载前重放，否则重放的事件被写回文件（自复制爆炸）；单测构造 Agent 不跑 turn，也就不写任何文件（不用环境变量开关，结构性地杜绝了测试污染真实 HOME）；sessionId 在 resume 时才改指向，挂载时烘焙文件路径正好。

**崩溃修复（简版）**：读文件逐行 parse，半行（写到一半的尾巴）静默丢弃；turn/start 无配对 turn/end 时补一条合成 `turn/end(recovered)`——注记层的完整性对齐 dsh 的恢复思想。

**派生恢复的账**：

| 状态 | 来源 | 备注 |
|---|---|---|
| 请求历史（messages） | derive() | system 不落地——每请求现算（旧 resume 同语义） |
| mode | meta/note（本章补齐：toggle/plan 工具原直赋值处全部改走 setMode） | C3 只记了 setMode 一处 |
| cost 四计数 / currentTurns / lastInputTokenCount | assistant 事件 usage 求和；含 tool_use 的 assistant 计轮 | **零新增事件**——日志即真相的直接红利 |
| 激活 deferred 工具 | meta/note（tool_search 命中时新增记注） | 超越旧版 |
| goal | meta/note（GoalService.set/clear 新增记注） | 恢复可见性；跨重启的追逐续跑不支持（记差距） |

## 3. 断言变更说明（场景 4）

场景 4 的**请求级**断言（两调用、messageCount 1→3、firstUserText 续接）原样通过——行为等价。**文件级**断言按新格式重写：`.json` 快照 + metadata 块 → 单个 `.jsonl`（run2 的 --resume 续写 run1 的文件——"两个文件变一个"是每事件落盘的语义后果，不是丢数据）；消息数/内容改从事件流断言。

## 4. 与真框架的差距清单（C8 后）

| 能力 | 真 dsh | mini | 备注 |
|---|---|---|---|
| generation（写代际） | ✅ 日志分代，重放按代 | ❌ 单文件追加 | 崩溃修复半行兜底 |
| 独占写句柄 + fsync 策略 | ✅ | ❌ appendFileSync 每事件 | 进程崩丢 OS 缓冲尾部 |
| migration（旧代升级） | ✅ | ❌ 重启即弃 | |
| 压缩 vs 日志发散 | ✅ surface 替换天然一致 | ❌ resume 恢复**压缩前**原始历史 | C3 双记口径，D5 投影 replace 后消失；恢复的历史更大但语义正确 |
| goal 跨重启续跑 | — | ❌ 仅恢复可见性 | pursueGoal 的驱动语义不进日志 |
| 大 tool result | ✅ | ✅ 无需特判 | 30KB 落盘机制产出的"预览+路径"文本已内嵌在 tool_result 事件里，重放原样恢复 |

## 5. 实现与验证记录

**文件**：`plugins/session-jsonl.ts`（新增）；`services/session-log.ts`（onAppend/onClear）；`agent.ts`（resume/ensurePersistence，autoSave/restoreSession 删除，mode 记注补齐三处，saveSession import 移除）；`plugins/autonomy.ts`（goal 记注）；`plugins/core-meta-tools.ts`（激活记注）；`cli.ts`（--resume 走 resume）；`session.ts` **删除**；`cordis-tests/c8-session-jsonl.test.ts`（新增 5 条）；`run-mock.mjs`（场景 4 断言变更 + 场景 32 + persist runner）。

**验证**：
- `npm run cordis`：**112/112 绿**（C8 新增 5 条：原始事件订阅、JSONL 往返 derive 等价、clear 标记、崩溃修复三态、mtime 最新）
- 全量 mock 回归：**28 场景全绿**。场景 32 三阶段：resume 续接（messageCount 5、首条 user 含 reminder、工具结果存活、**system 跨恢复边界逐字节一致**、cost 派生非零）+ 崩溃修复（半行丢弃 + recovered 注记 + 消息数不受污染）；场景 4（CLI --resume 全链路）请求级断言零改动通过。

**翻车记档**：
1. **场景 32 的计数错觉**：崩溃阶段的期望消息数写成 5——忘了 phase 2 的续跑已经把历史推到 6 条。mock 日志在手的场景里，数消息应该**从日志数**而不是从脑内剧本数。修一行即绿。
2. **场景 4 揭示的语义后果**："两个会话文件变一个"不是 bug 是设计——run2 resume 后续写 run1 的文件，中间那个随机 sessionId 从未落盘。断言变更说明顺手把这件事记成文档（快照思维才会期待"每次运行一个文件"）。
3. **（险情）require 混进 ESM 测试**：utimesSync 一时手滑写成 `require('fs')`——ESM 里直接 ReferenceError，写完扫一眼 import 块就换掉了。TS 文件的依赖只走 import 语句，这条肌肉记忆在 .mjs 场景文件里也要保持。

## 6. 自测三题（答案在文末）

1. onAppend 为什么挂在合并**前**而不是合并后？两种挂法各自把什么复杂度推给了重放方？
2. resume 为什么必须在持久化挂载之前执行？如果反过来，观察到的现象是什么（不是报错，是文件内容）？
3. cost 恢复没有新增任何记账事件，凭什么敢从日志"派生"？这个选择对"日志即真相"的边界说明了什么？

> **答案**：
> 1. 挂合并前：JSONL 是原始流，重放复用 append 的合并规则（一份规则两处受益）；挂合并后：文件里是合并结果，重放方必须自己实现"直接置入"的第二套入口——合并规则从此有两个实现，等价性要双向论证。
> 2. 自复制：重放的每个事件都会触发 onAppend 写回文件——文件长度指数式翻倍（每次 resume 翻一倍），且 clear 标记的语义被污染。惰性挂载让"重放"与"续写"在时间上天然分离。
> 3. 凭 assistant/message 事件自带 usage 四计数（C3 落的规矩）——凡是已经进日志的事实，恢复就是求和/扫描，不需要为恢复而记第二次账。边界说明：**派生只能恢复日志记过的东西**——lastApiCallTime 这类纯内存工作集状态不在日志里，也就不恢复（缓存冷热判定重启后从头来，语义无害）。

## 7. C 阶段收官对照

| 章 | 交付 | 场景 |
|---|---|---|
| C1 | ctx.tools 注册表，switch 消亡 | echo 注册/摘除 |
| C2 | pre-execute 瀑布 + 单调 guard | 六模式对拍 |
| C3 | SessionLog + derive 双写 | 8 条 |
| C4 | inbox/claim 驱动 + handle 面 | 27（mid-turn）|
| C5 | 三事件 + TurnConclusion + goal/loop 监听器化 + 失败补全 | 28/29/30 |
| C6 | llm seam + 适配器 + echo 后端 | 31 |
| C7 | section 注册表 + 严格插值 | —（等价锚） |
| C8 | JSONL 持久化 + 派生恢复 | 32 |

单体的 god class 拆完：agent.ts 只剩驱动循环与状态桥，一切能力长在服务与插件上。D 阶段（能力插件化）从 D1 skills 开始。

## 8. 下章预告（D1 skills 插件化）

provider registry（同名按 rank 竞争）/ 文件扫描迁入插件 / 目录注入改 user message（catalog 从 system 挪走——**断言变更说明必写**）/ skill 工具走 registry。验收：inline/fork 场景绿 + rank 覆盖测试。
