# dsh 收官：mini-cordis vs 真 Cordis 差异清单 · 场景终态 · 源码导读地图

> E3 收官文档（`dsh-00-chapters.md` §E3 指定交付）。配套：本章 snapshot 机制见 `dsh-E3.md`（若拆章）或 §3。
> 一句话总结：**24 章（A0 + B1–B6 + C1–C8 + D1–D6 + E1–E3）走完，my_src 从单文件 agent 演进为 mini-cordis 插件树——cordis 140 断言全绿，mock 28 场景（run-mock 29 键含 23b 探针，口径=不含探针 28）+ snapshot 28 章全绿。**

## 1. mini-cordis vs 真 Cordis 差异清单

汇总各章"对照表"里标 **明确放弃 / 有意差异 / 标注略** 的项。按层分组，每项给"真框架怎么做 → mini 怎么做 → 为什么"。

### 1.1 容器与服务层（B1/B2）

| 机制 | 真 Cordis | mini-cordis | 裁决 |
|---|---|---|---|
| inject 未声明就读服务 | get 陷阱校验，抛 `cannot get property without inject` | 不校验（ctx 严格读取抛"未提供"） | 明确放弃——需按 ctx 层追踪提供者归属，纪律靠 inject 声明 + 评审 |
| epoch/按树归队 | 全局 pending 集按树分槽，精确失效 | 全局单集（假设单树） | 明确放弃——mini 单树单会话 |
| config schema | schemastery 校验 | unknown 透传 | 明确放弃——教学路径 fail-loud 靠冲突检测 |
| 服务表作用域 | isolate 按槽位 key 分实例 | 全树同名同槽，冲突抛错 | B2 语义修正后定死；多实例需求记 isolate 原理（B5） |

### 1.2 生命周期与事件（B3/B4）

| 机制 | 真 Cordis | mini-cordis | 裁决 |
|---|---|---|---|
| dispose 执行模型 | 链式串行 await | 逆序启动并发结算 | 有意差异——顺序敏感放同一 effect（真源码同款纪律，测试固化） |
| epoch/inertia/setupBarrier | 重入保护窗口 | 单线程同步模型无此窗口 | 明确放弃 |
| 事件按 fiber 域过滤 | Hook 记录注册 ctx，dispatch 按 Context.filter 过滤 | 整树广播 | 有意裁剪——单树语义无损；thisArg 首参探测启发式随之不抄 |
| internal/* 框架自事件 | ✅ | ❌ | 明确放弃 |

### 1.3 作用域与配置（B5/B6/E2）

| 机制 | 真 Cordis/dsh | mini-cordis | 裁决 |
|---|---|---|---|
| isolate / intercept | 槽位 key 寻址，子树换实例 | 不实现，原理记档 | 明确放弃——改动面覆盖 B1–B4 全路径，C/D 用不到 |
| scopeTarget 事件向上收容 | 祖先监听器收子孙事件（filter 载体） | 链与环检测实现，收容标注略 | 依赖被裁的 filter |
| rebind / quiesce | blank-session recompose / inertia 等待 | ❌ | 明确放弃 |
| 行 patch 合并粒度 | 字段级 deep-patch（schemastery） | 整行替换 | 有意差异——语义一目了然；代价是 patch 要重抄整行 config（E2 实测痛感可控） |
| name→实现解析 | 动态 import + 包清单校验 | 静态映射表 | 标注略 |
| dump 结构 | 按树嵌套 | 平铺行表 + 运行态树两视图 | 有意差异 |

### 1.4 业务层口径差异（C/D 阶段）

| 机制 | 真 dsh | mini | 裁决 |
|---|---|---|---|
| derive 投影口径 | 从 tool/call+result **重组**消息 | user/assistant 事件携带线格式原样内容 + 注记平行双记 | 有意差异——请求体逐字节等价的最短路径；双记的定位价值在 D5 按块改写时兑现 |
| inbox claim | `claim(target, turn)` + latch | 排空循环等价替代 | 口径差异——对齐的是消息流不是源码逐行 |
| LLM 中立面 | 请求+响应双侧中立（translate 层） | 只在响应侧（chunk 词汇表），请求保持 Anthropic 线格式 | 有意差异——mock 锚请求体，翻译层每多一个方向就多一类等价论证 |
| subagent 隔离 | 完整 scope（插件不加载） | 双层简化：enabled 开关 + preset 排除表 | 被 B2 共享表语义挡住（D3 记档） |
| initiator 归属 | AsyncLocalStorage 隐式传播 | 显式传参 | 简化——原理记档（D3） |
| MCP projectContent 图片 | base64 基建 | 文本 only | roadmap 明示简化 |
| memory 晚归注入 | — | idle 时注入在用户文本之前（claimTurn 序） | 已知语义微调（D4，无场景锚定） |

**总评**：放弃集中在对正确性无影响的"多树/多实例/重入"维度；保住的是**语义主干**——生命周期三态、级联卸载、provide 通知、五派发、waterfall 单调 guard、行模型分层。所有差异都在当章文档有"为什么"，无一笔带过。

## 2. 场景终态（2026-10-07）

| 测试面 | 规模 | 状态 | 说明 |
|---|---|---|---|
| 框架行为（cordis-tests） | 140 断言 / 20 文件 | ✅ 全绿 | B 阶段框架语义 + C/D 每章服务级行为 + E2 装配 9 条 |
| mock 回归（run-mock） | 28 场景 | ✅ 全绿 | 22 个旧场景锚点存活 + C4/C5/C6/C8/D 阶段新增；手写 verify 点状锚 |
| snapshot 回放（run-snapshot） | 28 章 / 135 请求 / 44 会话文件 | ✅ 28/28 × 4 轮 | 全量逐字节锚（规范化后），任何请求组装/事件序改动即红 |
| 真机 | glm-5.3-flash | ✅ 可用 | 沿用 ch14 纪律（--accept-edits、日志直写文件）；E1 REPL 手测清单仍待过 |

**snapshot 已知不稳定源记档**：录后首轮回放曾 27/28（红章未定位，输出截断），随后连续四轮全绿。若再现，diff 报告的请求序号+上下文可直接定位；候选嫌疑是 ch24（loop 定时）/ch27（midturn 探针）两个时序敏感场景。
**快照不锚定**：ch32 的半行崩溃尾巴（字节非法，修复行为由手写 verify 断言）；git 段/日期/临时路径/随机 id/mtime/truncate 落盘文件名（规范化占位符清单见 `snapshot-lib.mjs` normalizeText）。

## 3. E3 交付物：snapshot 机制（mini 版）

- **三模式对齐 dsh**：`npm run snapshot`（replay，无 key 默认）/ `npm run snapshot:record`（重录 ≙ refresh）/ 单章 `node run-mock.mjs <ch> --snapshot-record`。
- **与 dsh 的结构差异**：dsh 在 llm 适配器层回放录制响应（`llm-replay`，快照含 profile/composition 清单）；mini 的 mock-anthropic 本身就是"录制响应供应者"（脚本响应 ≙ 录下的响应），快照锚**完整请求体 + 会话事件流**的逐字节 diff——mock 手写 verify 是点状锚，快照是全量锚，两者叠加（replay 时 verify 照跑）。
- **规范化**（危险点兑现）：已知易变值（workdir/HOME/随机 sessionId）按实际值全局替换成占位符（含 JSON 转义/正斜杠三形态）；只能猜模式的（git 段、日期、mtime、truncate 落盘名、Shell/Platform 行）正则折叠。
- **文件**：`snapshot-lib.mjs`（normalize/diff/存取）、`run-snapshot.mjs`（总驱动，每章子进程隔离）、`snapshots/ch<n>/{requests,events}.jsonl + meta.json`（可入库，代码变更的回归雷区）。

## 4. dsh 源码导读地图（下一轮的路标）

读过（mini 有对应物，读的时候有锚）：

| dsh 包 | 对应 mini | 章 |
|---|---|---|
| `vendor/cordis/src/{context,service,fiber,events,registry,scope}.ts` | `my_src/cordis/*` | B1–B5 |
| dsh loader 行模型 | `cordis/loader.ts` + `cordis.config.ts` | B6/E2 |
| `packages/core/agent-loop/src/{agent,inbox,tool-calls}.ts` | `agent.ts` + `services/agents.ts` | C4/C5 |
| `packages/core/tools/src/index.ts` | `services/tools.ts` + `plugins/core-*-tools.ts` | C1/C2 |
| `packages/core/session/src/{index,surface}.ts` | `services/session-log.ts` + `plugins/session-jsonl.ts` | C3/C8 |
| `packages/llm/llm/src/{index,types,assembler}.ts`、`llm-deepseek/src/*` | `services/llm.ts` + `plugins/llm-anthropic.ts` | C6 |
| `packages/core/system-prompt/src/index.ts` | `services/system-prompt.ts` + `plugins/prompt-sections.ts` | C7 |
| `packages/skill/`、`packages/mcp/mcp-client/`、`packages/subagent/` | `plugins/{skills-registry,mcp-bridge,subagent}.ts` | D1–D3 |
| `packages/goal/`、`packages/schedule/` | `plugins/autonomy.ts` + `services/schedule.ts` | D6 |
| `packages/compaction/`、`packages/todo/tool-todo/`（最佳插件样本） | `plugins/compaction.ts` | D5 |
| snapshot 体系（`vitest.snapshot.config.ts`、`snapshots/`） | `snapshot-lib.mjs` + `run-snapshot.mjs` | E3 |

没读、值得第二轮（按性价比排序）：

1. **`packages/core/scope/` + vendor 的 isolate 实现**——B5 只讲了原理；真把槽位 key 寻址读透，mini 的"双层隔离简化"（D3 记档）才能升级。
2. **`packages/llm/llm-retry/` + `llm-deepseek-account/`**——重试与账号池是生产 agent 的真实复杂度，my_src 的 `retry.ts` 是玩具级。
3. **`packages/guard/` + `packages/sandbox/`**——审批瀑布之上的硬隔离层（沙箱/守卫），mini 的九段流水线只有软件裁决。
4. **`packages/client/`（ui-chat/ui-conversation）+ `packages/api/`**——E1 的 UiService 是进程内消费者；真产品是跨进程协议（ACP/JSON-RPC），`snapshots/acp/` 是入口。
5. **`packages/context/` + `packages/spill/`**——上下文工程与外溢（spill）机制，compaction 之外的另一条路。
6. **`packages/workflow/` + `packages/jobs/`**——D6 的 goal/loop 之上的结构化自动化。

## 5. 课程终点回望

三轮学习（ch1–15 复现 → ch16–26 进阶 → dsh 24 章重构）的最终形态：**同一个 mini agent，三次架构**——if 链脚本 → 模块化单文件（`agent.ts` 峰值 1311 行，bootstrap+宿主一体）→ mini-cordis 插件树（框架 800 行与业务解耦，agent.ts 收缩为纯 bootstrap）。dsh 课程的核心兑现："换 provider 即换产品"不再是口号——`cordis.config.ts` 一份清单、两条 profile、一个 `--patch`，同一份代码装出全功能与无 auto-mode 两个 agent（场景 33 的裁决路径差是行为证据）。

遗留（不阻塞收官）：E1 REPL 手测清单待终端过一遍；思考题回补按队列并入后续；三章留了"后章再议"最终无人接单（2026-10-17 检视轮收录在此）：C4 §4 的独立维护相位（dsh runMaintenance 从 idle 起维护任务，mini 的 compact 仍内联 turn 开场）、C5 §9 的 turn 注记粒度（mini 是 per-request，dsh 是 turn/step 分层）、D6 §6 的预算/轮数仪表服务（仍在 agent 字段上，bridge getBudget/getMaxTurns 是最后的缝）。

## 6. F 阶段（web UI）收官增补（2026-10-17）

F1–F6 交付了 mini 的第三张脸：**引擎一行语义不改，Host/Client 都是清单上的行与新顶层目录**——`--web` 起 HTTP 面（127.0.0.1、一元信封 + WS 流），浏览器拿到与终端同缝的会话（装配/审批/命令/plan/投影），`--profile web` 成为与 full/no-auto 并列的第三种产品形态。章文档：`dsh-F1.md`…`dsh-F6.md`（总纲 `dsh-00-ui-plan.md`）。

### 6.1 UI 层差异清单（vs `packages/client` + `packages/host` + `packages/interaction`）

| 机制 | 真 dsh | mini | 裁决 |
|---|---|---|---|
| 投影面 | server fold（session-projection）+ `session.projections` RPC + control stream baseline | 客户端第二 fold（webui/projection.ts）；baseline 即快照、live 即增量 | 不抄——mini 的 Host 是哑管道、journal 单流（F6 决策 1） |
| 交互跨端 | Agent-scoped Remote 瀑布转发 + `$on` 接管 | ApprovalService 换 interactive provider（Host 构造期自注册） | 语义同构：**只换 answerer 不换瀑布**；fail-closed 三连 + 裁决事实落日志为 mini 补充 |
| 审批通道 | journal / control 双流分离 | 单 WS 三类帧（journal 事件 / approval 瞬态 / narrative 旁白） | 简化——帧类型即语义分层，seq 连续性只对 journal 帧（F5 rebaseline 是这条红线的执法者） |
| 客户端模块 | 50 个 ui-* 包 + boot graph 懒加载 | webui 七文件 + 五 feature（conversation/tool/approval/commands/plan） | 记档裁剪（ui-plan §4） |
| 状态推导位置 | 消费层拿语义更新 | 消费层 fold 原始日志 | 有意差异——"UI 是日志的投影"在客户端走到底 |
| 叙事面 | surfaceOp 全面事件化（可回放） | narrative 瞬态帧（不回放） | 已知差距记档（F5 决策 5） |

### 6.2 终态数字（2026-10-17 增补）

cordis **188/188**（26 测试文件）；mock **28 场景**全绿；snapshot **28/28**（F5/F6 重录 ch7/ch15/ch24：goal-progress/loop 注记进事件流锚）；vite build 245.9KB / gzip 77.6KB。`--profile web` 冒烟手测清单在 `dsh-F6.md` §3。

### 6.4 全面检视修复轮（2026-10-17，F6 之后）

收官后的一天集中检视轮，修了两类问题（详记 `dsh-E3.md` §3 增补、`dsh-F5.md` §4 增补、`dsh-F3.md` §4 增补）：

- **两个偶发红根因修复**：① ch10 mock 计数闪断 = Windows PID 高速复用撞日志/捕获文件名（append 把上一轮的行带进来数出 12 个请求）——`run-mock.mjs` 开跑前 `rmSync` 清场；② ch8 snapshot 闪断 = memory 侧调与主轨请求的**到达顺序**是回环 TCP 竞态——capture 行带 `track`，规范层按轨名稳定排序（跨轨到达序不锚，轨内到达序=轮次序仍锚），全量 28 章重录 + 两轮 replay 全绿。
- **审批与跨站安全收口**：plan 模式下未声明 read/meta hint 的工具一律拒（旧路径只拦 edit/run_shell，MCP 等未知写入面靠⑨兜底放行）；MCP 工具不再冒充 hint "meta"；带 pattern 的权限规则取不到值时不再"值无关命中"（`web_fetch(domain*)` 恒全量放行的洞）；host-webserver 校验 Origin/Host（恶意页面跨站连 WS / DNS rebinding 被拒，Node/curl 不发 Origin 不受影响）；MCP `tools/call` 60s 超时（挂死 server 不再吊死 turn）；配置只认 `mcpServers` 键（statusLine 等带 command 的对象不再被当 server spawn）。
- **webui 修复**：换代关旧 ws（僵尸连接不再令 fail-closed 判定失真）；坏帧 JSON.parse 不再炸整代连接；槽位 disposer 按条目身份摘除（不再连带抹掉后加入项）；memory 目录前缀吃到分隔符（`\mem` 不再命中 `\memories`）。
- snapshot 格式变更（请求行 `{track, body}`）→ 全量重录一次；`agent.ts` 死方法 `childPermissionMode` 删除。

**终态复核**：cordis 188/188、mock 21/21（13/14/16/17/22 n/a）、snapshot 28/28 × 2 轮。

### 6.3 导读地图增补（F 阶段读过的 dsh 面）

| dsh 包/文档 | 对应 mini | 章 |
|---|---|---|
| `docs/subsystems/web-client.md`（分层红线） | webui/ 全目录的 import 图 | F3 |
| `packages/client/{store,connection,ui-renderer,ui-slots}` | `webui/{store,connection,renderer,slots}.ts` | F3 |
| `packages/client/ui-conversation` + `ui-tool` | `webui/{conversation,views}.ts` | F4 |
| `packages/interaction/{user-approval,commands}` + `ui-approval/ui-plan` | Host 审批面 + `webui/views.tsx` ApprovalCard + `services/commands.ts` | F5 |
| `packages/host/` + `packages/api/`（一元调用 + webserver + remote.mux） | `plugins/host-webserver.ts` | F1/F2/F5 |

`packages/client` 的 feature 包内部（ui-chat 等 50 包的实现细节）仍留第二轮——mini 五 feature 的粒度已够教学对照。
