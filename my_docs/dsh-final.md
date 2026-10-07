# dsh 收官：mini-cordis vs 真 Cordis 差异清单 · 场景终态 · 源码导读地图

> E3 收官文档（`dsh-00-chapters.md` §E3 指定交付）。配套：本章 snapshot 机制见 `dsh-E3.md`（若拆章）或 §3。
> 一句话总结：**24 章（A0 + B1–B6 + C1–C8 + D1–D6 + E1–E3）走完，my_src 从单文件 agent 演进为 mini-cordis 插件树——框架 131 行为断言 + 业务 140 测试全绿，mock 28 场景 + snapshot 28 章全绿。**

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
| 框架行为（cordis-tests） | 140 断言 / 19 文件 | ✅ 全绿 | B 阶段框架语义 + C/D 每章服务级行为 + E2 装配 8 条 |
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

三轮学习（ch1–15 复现 → ch16–26 进阶 → dsh 24 章重构）的最终形态：**同一个 mini agent，三次架构**——if 链脚本 → 模块化单文件（`agent.ts` 1095 行，仍是 bootstrap+宿主）→ mini-cordis 插件树（框架 800 行与业务解耦，agent.ts 收缩为 bootstrap）。dsh 课程的核心兑现："换 provider 即换产品"不再是口号——`cordis.config.ts` 一份清单、两条 profile、一个 `--patch`，同一份代码装出全功能与无 auto-mode 两个 agent（场景 33 的裁决路径差是行为证据）。

遗留（不阻塞收官）：E1 REPL 手测清单待终端过一遍；快照首跑 flaky 记档在案；思考题回补按队列并入后续。
