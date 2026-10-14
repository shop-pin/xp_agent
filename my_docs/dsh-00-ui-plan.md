# dsh UI 调研与 F 阶段计划——mini 的 web UI 三层

> 调研对象：`deepseek-harness-master/`（下称 dsh）的 UI 全景：`apps/{cli,web,desktop}`、`packages/client/`（约 50 个 ui-* 模块）、`packages/{api,host,acp,interaction,terminal}`、`snapshots/acp/`、`docs/subsystems/web-client.md`。本文件 = 事实盘点 + mini 的 F1–F6 章计划。

## 1. dsh 的事实盘点（先纠预期）

**没有终端 TUI。** 全仓 grep 无 Ink/readline UI；`dsh` 命令（apps/cli）只是 launcher——commander 解析自有 flags 后透传给 profile 内插件（`apps/cli/src/{bin,args,profile-boot}.ts`）。交互 UI 是 React Web；`packages/terminal/` 是给工具用的持久 shell 会话服务（`ctx.terminals`），与渲染无关。

**三层拓扑**（同进程组合，`dsh web` 单 Node 进程起全套）：

```
引擎面（cordis 插件树：agent/session/tools/interaction，与 mini 同构）
   │ session 日志（durable JSONL）+ 投影（surfaceOp fold）
   ▼
Host 面（packages/api + packages/host）——协议层
   一元 RPC：HTTP POST /api，信封 {ok,value}|{ok,error}（不抛异常）
   流：/api/remote.mux WebSocket 多路复用（open/item/end/cancel 帧 + 心跳）
   事件：follow-first（先开 live 推送，再回填 Turn 对齐的历史尾页）；
         重连 = 尾页补 seq 空洞 + 每代连接发完整投影 baseline（带最后 seq）
   交互：approval/request 作 Agent-scoped Remote 瀑布转发给浏览器，
         浏览器 $on 接管作答回传；fail-closed；asked/decided 入日志
   ▼
Client 面（packages/client）——React 层
   connection（RPC + $events + generation 重连）→ store（React-free
   observable snapshot + selector；zustand+immer 封装，唯一 React 绑定
   useSyncExternalStore）→ ui-slots（single/list/keyed/chain 槽位体系）
   → ui-renderer（挂 React 根，renderSlot('root')）
   → ui-conversation（target 中立装配器：事件/视图双注册表 → Nodes）
   → ui-chat / ui-tool / ui-approval / ui-plan / ui-commands / …50 个 feature 包
```

**客户端模块约定**：每个 ui-* 包 `package.json` 带 `dsh.client:{platform:'web',inject:[...]}`，双入口（host 面 + `./client` 浏览器懒加载 bundle），`client/modules/` 编译成 boot graph 按需物化。desktop = Electron 壳 + RunAsNode 子进程跑同一 Host，窗口加载同一 SPA（`apps/desktop/README.md`）。ACP = stdio JSON-RPC **server**（automation-only，只传语义更新；`packages/acp/`，`snapshots/acp/` 是录制夹具）。

**交互三端同缝**：审批/提问是通道中立的瀑布（`packages/interaction/user-approval`）——终端注册本地 listener、web 经 Gateway `$on` 远程作答、ACP 经 `session/request_permission` 作答，**只有 answerer 不同**。这条对 mini 最有启发：C2 的审批瀑布已经长这样了。

## 2. mini 已有的地基（F 阶段直接消费）

| mini 侧 | 对应 dsh | 状态 |
|---|---|---|
| session-log 事件 + derive 投影 + onAppend | session durable log + projection fold | C3/D5/E3 |
| UiService（消息面 onAppend 驱动 + 叙事面 + setRenderer 可替换） | ui-renderer 的进程内前身 | E1 |
| CommandService（dispatch + list + 技能回退） | interaction/commands + ui-commands | E1 |
| approval 瀑布（request → 监听器作答，fail-closed） | user-approval（终端/web 同缝） | C2 |
| 行模型清单（baseRows/appRows/profiles/patch） | profile/bundle/patch 栈 | B6/E2 |
| snapshot 录制回放 | vitest.snapshot + snapshots/acp | E3 |

## 3. F 阶段章表（F1–F6，对照物 → mini 做法）

> 总原则：**引擎一行不改**——Host/Client 都是 cordis 插件与新顶层目录；E1 的 UiService 降级为"终端渲染器"继续用，web 渲染器是它的平级替身。技术栈跟 dsh：React + vite + 自研 React-free store。测试面：F1/F2 用 node:test + WS 客户端断言；UI 组件层不引框架（手测清单 + http 层快照，沿用项目纪律）。

### F1 Host 最小面：一元 RPC
- **做什么**：`plugins/host-webserver.ts`（node:http，静态目录 + `/api` 路由）；信封 `{ok,value}|{ok,error}`；方法 `session.create / session.list / session.prompt / session.events?since=`（过渡期拉取）；agent 同进程（Host 是插件，经 ctx 拿 session/agent 服务）。进 cordis.config 清单（`--profile web` 形态）。
- **对照**：packages/api 一元调用 + packages/host webserver；apps/cli 的 profile 启动。
- **验收**：`curl` 创建会话、发 prompt（ANTHROPIC_BASE_URL 指 mock）、`session.events` 拉到完整事件序列；断言走 node:test。

### F2 事件流：follow-first + 补洞
- **做什么**：`/api/stream` WebSocket——连上先发历史回填帧（Turn 对齐可简化为全量/尾 N 条），再推 live（onAppend 出）；每事件带 seq；心跳 + resume(sinceSeq) 尾页补洞；多客户端广播。
- **对照**：session-controller follow 流 + RemoteJournalStream；重连"尾页补洞 + 每代 baseline"。
- **验收**：两个 WS 客户端同看一会话；中途 kill 客户端重连后 seq 无洞无重（node:test 断言）。

### F3 client 基座：connection / store / renderer
- **做什么**：新顶层 `webui/`（或 `packages/client/`）：`connection.ts`（unary fetch + WS + generation 重连）、`store.ts`（ObservableSnapshot + selector + Immer draft action，React-free；唯一 React 绑定 useSyncExternalStore）、`renderer.tsx`（createRoot + root slot，slot 简版只做 single/list）；vite 起 SPA 壳，Host serve 其 dist。
- **对照**：packages/client/{connection,store,ui-renderer,ui-slots}；`docs/subsystems/web-client.md` 的分层红线（feature 包间只靠 inject 服务 + Slots）。
- **验收**：浏览器连 Host 渲染出会话列表与"新会话"入口（空对话壳）。

### F4 会话装配：conversation nodes + tool 卡 + composer
- **做什么**：`ui-conversation` 简版——事件注册表（user/assistant/tool_call/tool_result → Node 类型）+ `ui-tool` 通用卡（input/result 折叠展开，未注册工具走通用卡）+ composer（输入框 → session.prompt）+ assistant 流式增量渲染（live 帧）。
- **对照**：ui-conversation 双注册表 + ui-tool 的"wire 名注册、Runtime 配对"分工。
- **验收**：浏览器跑通 mock 场景 9 同款脚本（catalog 注入可见、skill 激活卡、Unknown skill 报错卡）——mock 驱动从"直调 agent"升级出"http 驱动"一条。

### F5 交互跨端：审批/命令/plan
- **做什么**：approval/request 作 Remote 瀑布转发（Host 事件 → 浏览器 `$on` 接管 composer 出卡片 → 决策回传作答；超时/断线 fail-closed）；`commands.list` RPC + `/` 模糊补全；plan 四选项审批卡片。
- **对照**：ui-approval 的 `ctx.remote.$on('approval/request')`；ui-commands 四种 dispatch；ui-plan。
- **验收**：write_file 在浏览器出确认卡，允许/拒绝双闭环（拒绝时引擎侧行为与终端版逐字节同话术）；`/cost`、`/plan` 在 web 可用。
- **危险点**：C2 的瀑布语义不能在传输层翻案——远程作答 = 注册一个 answerer listener，不是绕过瀑布。

### F6 投影与收官
- **做什么**：`session.projections`（goal/loop/compaction 统计的快照 + 增量帧，快照带"反映到的最后 seq"）；侧栏（会话列表 + 历史回放：follow 帧重放进 UI）；`--profile web` 冒烟手测清单；差异记档收官文档 `dsh-final.md` 增补 UI 章。
- **对照**：session-projection fold + `session.projections` + control stream baseline。
- **验收**：重启 Host 后浏览器打开旧会话，从 JSONL 回放完整重现；goal 评估进度侧栏 live 更新。

## 4. 明确不抄（记档）

| dsh | mini 裁决 |
|---|---|
| Typert 代码生成 RPC 类型 | 手写 TS 类型（接口即文档） |
| remote.mux 多路复用帧协议 | 单流 WS 简版（帧类型 open/item/end 保留语义） |
| client/modules combo 懒加载路由 | vite 全量打包 |
| ui-slots 四类槽位全家 | 只做 single/list 两类 |
| 50 个 ui-* feature 包 | 只做 conversation/tool/approval/commands/plan 五个 |
| Electron desktop 壳 | 可选 F7（同一 SPA，性价比低） |
| ACP stdio server | 记档可选（snapshots/acp 夹具已在仓库可读） |
| permission presets / settings 全家 | 不做 |

## 5. 进度与提交纪律

- 章文档：`my_docs/dsh-F1.md` … `dsh-F6.md`（沿用翻车记档 + 自测题格式）；总纲 `dsh-00-plan.md` 进度表追加 F 段。
- 每章完成给 commit message（add X 风格）；mock/cordis 全绿是每章底线，UI 章额外新增 http/ws 测试文件（node:test）。
- 起步前置：`npm i react react-dom immer` + dev 依赖 `vite @vitejs/plugin-react @types/react @types/react-dom`——store 自研（对照读物：dsh `packages/client/store/src/contract.ts`），zustand 不引入，保持"React-free store + 唯一 useSyncExternalStore 绑定"的教学距离。
