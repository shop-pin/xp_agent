# dsh-F6 投影与收官——会话投影、侧栏、resume 重现

> 对应规格：`dsh-00-ui-plan.md` §3 F6。参照物：dsh session-projection fold + `session.projections` + control stream baseline。
> 一句话：**UI 的第二个 fold——conversation 折出"说了什么"，projection 折出"跑到哪了"；数据源只有一条日志流。**

## 1. 产物与边界

| 文件 | 层 | 变化 |
|---|---|---|
| `plugins/autonomy.ts` | 插件 | loop 起止落 `meta/note(key:loop)`、goal 未达评估落 `meta/note(key:goal-progress)`——goal set/clear（C8 已有）之外的最后一公里，goal/loop 状态全量入日志 |
| `webui/projection.ts` | 装配（新） | React-free 纯 fold：事件流 → `SessionProjection`（lastSeq/mode/turns/compactions/tokens+cost/goal/loop） |
| `webui/app.tsx` | 壳 | 侧栏投影面板（seq/模式/turns/压缩/tokens/~$/goal/loop 行）+ goal/loop 活跃期 composer 锁死（终端 REPL 同款） |
| `cli.ts` | 入口 | `--web --resume`：JSONL 重放进 Host 日志，浏览器 baseline 即全量历史 |
| `agent.ts` | 引擎（1 行卫生修） | resume 的 goal 对账加幂等守卫（详见决策 4） |
| `cordis-tests/f6-projection.test.ts` | 测试（新） | fold 单元 ×3 + http 驱动 ×3（真 turn 投影 / goal 生命周期 live / loop 起止）+ resume 重现 ×1 |

## 2. 设计决策记档

1. **投影不加 RPC、不加帧——baseline 即快照，live 即增量（`session.projections` 的 mini 裁决）**：客户端已从流里拿到全量日志（baseline 原生带 lastSeq——"快照反映到的最后 seq"免费成立；live/补洞帧就是增量）。投影 = 同一事件流上的第二个 fold（conversation 是第一个），帧到场即重折，天然 live。dsh 需要 server-side fold + 专用 RPC，是因为它的 control stream 与 journal 分离、feature 包不直接消费 journal；mini 没有这层隔离，重复建设记档不抄（进 final 差异清单）。
2. **状态入日志走完最后一公里**：goal set/clear 自 C8 起就是 meta/note；本次补齐 goal-progress（评估未达时）与 loop start/finish——从此 goal/loop 的会话事实全在日志里，侧栏 live 更新与 resume 重现是同一个 fold 的两次运行，不需要两套数据源。位置在 autonomy 插件（服务持状态、监听器做决策的既有文件），引擎核心零改。
3. **composer 门控 = 终端 REPL 同款锁死（F5 已知限的兑现）**：goal/loop 活跃期服务器会拒 prompt（`bridge.isBusy`），但 busy 快照不推送——门控信号不从传输来，从投影 fold 来（goal/loop 注记是事实推导，断线重连后 fold 重算自动恢复）。侧栏同时给出"为什么锁"（◎ 条件 / ⟳ 模式行）。
4. **resume 幂等守卫（本章唯一的引擎行）**：C8 的 resume 对无 goal 会话也无条件 `goal.clear()` → 落一条假 `goal:null` 注记。注记不落盘（持久化惰性挂载在 resume 之后），快照从来看不见它——**F6 的逐事件流对比第一次照出了这条只污染 in-memory 流/baseline 的老疣**。修为幂等守卫（有 goal 才 set/才 clear），快照零涟漪（28/28 不动）。
5. **cost 公式第三份拷贝**：终端 `ui.printCost`（直印拿不到串）、Host narrative 帧 `costLine`、客户端 `costUsd`——三份同式，注释互认"改一处改三处"。三条拷贝比一个跨层共享工具干净：终端/Host/客户端是三个发布面，公式是它们之间有意的口径契约。

## 3. 实现与验证记录

**验证**：cordis **188/188**（f6 新增 7 条）；mock **28 场景全绿**（零断言变更）；snapshot **28/28**（重录 ch7/ch15/ch24——goal-progress/loop 注记进事件流，逐字节锚随之更新；ch29 依旧行——impossible 路径不落 progress 注记）；vite build 245.9KB / gzip 77.6KB。

**重录的纪律坑**：`run-snapshot --record` 判绿用的是 replay 的 `✓ snapshot` 文案，record 成功打的是 `⚑`——**record 模式恒 exit 1**。`record 7 && record 15 && record 24` 被 `&&` 短路成只录了 ch7，replay 才发现 ch15/ch24 假重录。重录后必须跑 replay 验证，不能信 record 的退出码。

**已知观察（非本章引入）**：ch8 snapshot 偶发红（memory selector 侧调的请求内容在两轮间漂移）——三轮一红两绿，E3 记档的"录后首轮不稳"实锤一例，嫌疑 memory prefetch 时序；与 F6 改动无关（goal/loop 注记不进 memory 侧调的请求体）。

**`--profile web` 冒烟手测清单**（收官清单，用户跑）：
`npm run webui && node dist/cli.js --web --port 3080`（echo 冒烟加 `MINI_CLAUDE_LLM_ROUTE=echo`；真模型需 ANTHROPIC_API_KEY）→ `http://127.0.0.1:3080`：
1. 侧栏投影面板在场：seq 随事件增长、模式 default、turns/tokens/~$ 随对话增长；
2. `/goal make 2+2 equal 5` → 侧栏黄色 ◎ 行 + "第 N 次评估未达"递增（评估旁白同步在叙事条滚动）；`/goal` 追加到上限自行停机后 ◎ 行消失、composer 解锁；
3. `/goal list the files` 真模型下达观后 → 达成自动 clear（绿 ✓ 旁白 + ◎ 行消失）；
4. `/loop 3s report the clock` → ⟳ loop interval 3s 行出现、composer 锁死；Ctrl+C → 行消失、解锁；
5. goal/loop 活跃期发消息被禁（占位符"goal/loop 进行中…"）——与终端 REPL 阻塞同款；
6. 关掉 Host 重启 `node dist/cli.js --web --resume --port 3080` → 浏览器打开 → 历史逐条重现 + 侧栏投影数字与关机前一致（turns/tokens/goal 条件）；
7. F3/F4/F5 手测清单（各自章文档 §3）全部仍可通过——尤其 F5 的审批卡在 goal/loop 共存时的表现。

## 4. 翻车记档

1. **`currentTurns` 只在 tool_use 轮计数（位置 B），纯文本 turn 永不超 maxTurns 预算**：goal 测试设 `setMaxTurns(1)` 想一轮停机，结果 goal 一路迭代到 mock 轨道耗尽（500 → fail-closed NOT_MET → 继续迭代）。预算闸门的计数点决定它拦得住什么——纯对话型循环（无工具轮）不归这个闸门管。测试改用评估器序列（NOT_MET → MET）做确定性收束。
2. **settle 续延 vs socket 帧投递的微任务竞态**：`await settled` 的续延是微任务，ws 帧的客户端处理是 socket 宏任务——settle 先跑，读投影时最后一条注记帧还没折进去（loop 测试的 `end.loop` 恒为活跃态）。**await 一个进程内 promise ≠ 对端已收到它顺带广播的帧**；有界轮询到期望状态再断言。
3. **record 恒 exit 1 × `&&` 链 = 假重录**（见 §3）：`--record` 的退出码语义没有按模式区分，管道组合时第一个假失败把后面的全短路。教训：**组合命令里每个环节的退出码语义都要核对过，"成功了但退出非 0"的工具必须隔离跑。**
4. **resume 老疣是"新观察面"照出来的，不是新代码写出来的**：goal:null 假注记自 C8 就在，快照（文件面）看不见它，F6 的流逐事件对比是第一个看见它的测试。新测试形式的价值不只是护住新代码——**换一个观察角度，旧代码的隐性假设会显形**。
5. **ch8 偶发红**（§3 已述）：既有时序抖动的实锤。处理方式是记档 + 多轮观察，不为它改锚——快照的公信力来自"红了必须能解释"。

## 5. 自测三题（答案在文末）

1. 投影为什么放客户端 fold 而不是 Host 里折好推帧？两种做法各自把"状态推导"放在了哪一层，出错时分别怎么查？
2. goal-progress 为什么落日志而不是走 F5 的 narrative 帧？如果走帧，resume 后侧栏会得什么病？
3. composer 门控用投影 fold 推导而不用服务器推 busy 状态，代价是什么？

> **答案**：
> 1. 客户端 fold：状态推导在消费层，Host 只供货（日志流）——好处是推导逻辑与 conversation 装配同层演化、baseline 即快照零新协议；代价是每个客户端重复折叠（mini 单会话少数客户端，可忽略）。Host 推投影（dsh 路线）：推导在生产层，客户端拿现成状态——好处是跨进程/弱客户端（ACP automation 只传语义更新）时必然如此；代价是多一套快照+增量协议（"反映到的最后 seq"要自己维护）。查 bug：客户端 fold 出错看事件流→fold 纯函数（可单测重放）；生产层 fold 出错要同时看 fold 逻辑与推送管道（帧丢失/顺序）——mini 选前者因为它的分层里"Host 是哑管道"是既有红线（F2 起如此）。
> 2. 尺子还是"settled 的事实 vs 瞬态旁白"（F5 同款）：第 N 次评估未达是会话事实（改变 goal 的迭代状态、影响后续决策），走日志 → resume 重放后侧栏的 iterations 原样重现。若走 narrative 帧：瞬态、不回放——resume 后侧栏 goal 行只剩 condition（set 注记在日志里），iterations 归零显示 0，用户看到"评估了 0 次但 goal 还挂着"的自相矛盾；且"评估过"这件事在任何重放视角都不可考。
> 3. 代价一：门控是**最终一致**——注记帧在途的那几百毫秒里 composer 是开的，此时发消息会被服务器信封拒绝（RpcError 落错误行，无害但体验毛糙）。代价二：fold 只认日志事件，"服务器忙但日志无注记"的窗口（如 prompt 已 accept 尚无 turn/start）靠 pendingPrompt 这套既有界碑补——两套判据并存。换 busy 推送则要新增"投影外状态"的传输语义（F4 已裁决 busy 快照不推送），且断线重连后 busy 无法从 baseline 重建。mini 权衡：毛刺窗口换"状态永远可从日志重建"这条不变量。

## 6. F 阶段收官（F1–F6）

| 章 | 一句话 |
|---|---|
| F1 | Host = 清单上的一行：一元 RPC 信封 + session 方法面 + `--web` |
| F2 | `/api/stream`：follow-first + seq 补洞 + 心跳 + 多客户端广播 |
| F3 | webui 七文件基座：React-free store + connection + 唯一 uSES 绑定 |
| F4 | 会话装配：日志 → Nodes 双注册表 + accepted 语义 + prompt-error 界碑 |
| F5 | 交互跨端：审批瀑布换 answerer 不换瀑布 + fail-closed + 叙事面转发 + 斜杠面（顺手抓出清史×seq 去重冻结 bug） |
| F6 | 投影：goal/loop 状态入日志 + 客户端第二 fold + 侧栏 + `--web --resume` 重现 |

**剩余尾巴**：①E1 REPL 手测清单；②F3–F6 浏览器手测清单（`--profile web` 冒烟清单在本章 §3）；③思考题回补开放；④npm audit（glob→brace-expansion ReDoS）已记档未修；⑤ch8 snapshot 偶发红观察中。
