# dsh-F3 client 基座——connection / store / renderer 三层与分层红线

> 对应规格：`dsh-00-ui-plan.md` §3 F3。参照物：dsh `packages/client/{connection,store,ui-renderer,ui-slots}`；红线读物 `docs/subsystems/web-client.zh.md`——**依赖方向 Host 状态 → Remote 传输 → Client model → UI adapter → presentation → Slots → React；ui-renderer 是唯一 useSyncExternalStore 绑定点；presentation 组件绝不接收 transport**。
> 一句话：**store 引擎 React-free、connection 不认识 store、组件树里看不见 Connection——三层靠两条窄接口（StreamSink / actions 闭包）拼接。**

## 1. 产物与边界

**webui/**（新顶层，7 个文件）：

| 文件 | 层 | 职责 |
|---|---|---|
| `store.ts` | 引擎 | `defineStore`：ObservableSnapshot + immer actions 审计面 + `select` 切片订阅；不 import react |
| `connection.ts` | 传输 | 一元 call（信封 ok→value、ok:false→RpcError）+ 流消费（帧表→StreamSink 三动作）+ generation 重连 + 跳号/心跳揭示洞→resume；不 import store |
| `app-state.ts` | model | WebUiState + 写集六动作（setBaseline/appendEvent/setStreamPhase/setSession/setBusy/setEndpoint） |
| `slots.ts` | 组合 | 具名槽 registry（single 同 id 替换 / list 追加），F3 只立骨架 |
| `renderer.tsx` | 渲染 | **全仓唯一 React 绑定**：`useStoreSelector`（useSyncExternalStore + 两级缓存） |
| `app.tsx` | 壳 | 会话卡片 + 新会话/刷新 + 空对话占位 + 流状态点；只收 store 与 actions 闭包 |
| `main.tsx` | 装配 | store 实例 + Connection + Sink→actions 接线 + mount；**唯一知道 transport 的地方** |

**基建**：`package.json`（+react/react-dom/immer，dev+vite/@vitejs/plugin-react/@types/react*；script `webui`）；`vite.config.ts` + `index.html`（build 出 `webui/dist`）；`tsconfig.json`（include +webui，`jsx: react-jsx`，lib +DOM）；`plugins/host-webserver.ts`（静态目录第三优先级：config > env > `webui/dist`——`--web` 开箱即服务 SPA）；`cordis-tests/f3-client.test.ts`（新增 7 条）。

**验证面**：store/connection 走 node:test（React-free 正好全程可测）；UI 组件层沿用项目纪律——vite build + 手测清单（文末），不引测试框架。

## 2. 设计决策记档

1. **三层各立一条窄接口，红线靠结构不靠自觉**：connection 向下输出 `StreamSink`（setBaseline/appendEvent/setStatus 三动作——传输层把帧翻译成语义，落地由装配层定）；组件向上只拿 `store + actions 闭包`（main.tsx 造好），Connection 在组件树里不存在。dsh 红线"presentation 不接收 transport"在 mini 的落法就是：**transport 只活在 boot 函数里**。
2. **store 契约保三根柱子**（dsh contract.ts 的教学裁剪，persist/scopeKey/插件注册不抄）：①快照稳定——immer produce 无变更不换引用不通知（uSES 的 getSnapshot 契约）；②审计面——写集=声明表，draft 参数被 baked 掉，组件没有暗门；③框架中立——引擎不 import react。
3. **`useStoreSelector` 两级缓存**：uSES 用 Object.is 比较 getSnapshot 结果，selector 每次造新对象会让 React 空转——按"状态引用 → 等值"两级缓存，等值时交还旧引用。sel/eq 约定传模块级函数（app.tsx 的 selXxx 就是示范）。
4. **重连 = generation 换代，resume 只做代内带宽优化**：每代连接必得全量 baseline（F2 保证），本地状态整体替换收敛——跨代对账不存在。代内补洞两个触发器：event 跳号、heartbeat 的 lastSeq 领先本地；重复 seq 一律丢弃。收 baseline 才重置退避计数（"一代站住"的判据）。
5. **静态目录三优先级**：config.staticDir > env MINI_WEB_STATIC > 编译产物相对的 `webui/dist`（`import.meta.url` 上溯，不依赖 cwd）。F1 测试的 env 用法不受影响，`--web` 拿到开箱即用的 SPA。
6. **call 的动词约定**：input 缺省 → GET（读），传 `{}` → POST（写）——session.create 这类空参写必须显式 `{}`，约定写在 jsdoc。

## 3. 实现与验证记录

**验证**：cordis **161/161**（F3 新增 7 条：store 快照稳定/切片订阅过滤/baked 审计面；connection 信封与 RpcError/真机流消费全链/kill 重连 generation 收敛无洞无重/合成帧驱动的补洞协议逻辑）；mock **28 场景全绿**；vite build 成功（234KB / gzip 74KB）；`--web` 冒烟：`GET /` 返回构建后的 index（内联样式 + asset 引用）、asset 200。

**手测清单**（浏览器面，用户跑）：`npm run webui && node dist/cli.js --web --port 3080` → 开 `http://127.0.0.1:3080`：①头部署名 mini dsh + 绿点 live；②侧栏出现会话卡片（id/busy/消息数）；③点"新会话"卡片不消失（幂等）；④终端 `curl -X POST :3080/api/session.prompt -d '{"text":"hi"}'` → 头部 lastSeq 前跳、"已收到 N 个事件"增加——流活着；⑤断 Host（Ctrl+C）→ 黄点 reconnecting，重启 Host → 绿点回来、事件无洞。

## 4. 翻车记档

1. **测试忘了把工厂接进被测对象**：kill 重连用例造了 `wsFactoryCapture()` 却没传 `wsFactory: factory`——Connection 走了 Node 24 原生 WebSocket（居然也能通！），捕获变量自然 null。**"搭了观察仪器"和"仪器接进被测对象"是两件事——传参清单要对着构造选项逐项核。**
2. **瞬态断言等不到**：`reconnecting` 相位从重连发出到 baseline 落地只有毫秒级，10ms 轮询天然错过 → 5s 超时。改成等最终态（live + generation 2）。**断言相位迁移要断言"迁移发生过的证据"（generation），不是去追瞬态本身。**
3. **Connection 构造第二参忘了**：纯 call 测试 `new Connection({baseUrl})` 编译报错——sink 是必选。顺手确认了"构造时强制注入 sink"比"可选 sink 后判空"更能逼出分层（传输层没有 sink 就不该存在）。
4. **DOM lib 与 @types/node 共存**：担心的全局冲突没有发生（fetch/Response 双方兼容），`jsx: react-jsx` + lib DOM 一次过——根 tsconfig 直接收编 webui 全部源码，vite 用 esbuild 只做转译不查类型，类型检查全靠这条 tsc 路径，**不要为了"干净"把 webui 拆出独立 tsconfig**。

## 5. 自测三题（答案在文末）

1. connection 为什么不 import store？如果让它直接持有 store 引用，省掉 StreamSink，会破坏什么？
2. `useStoreSelector` 的两级缓存各防什么？如果 selector 返回原始值（数字/字符串），缓存还必要吗？
3. 重连后为什么不发 `resume(since=lastSeq)` 而是让新代 baseline 整体替换？什么时候 resume 才是跨断线的对账原语？

> **答案**：
> 1. 分层红线：传输在 model 之下，依赖必须单向。直接持有 store 会让 connection 知道状态形状——换 store 形状要改传输层，且传输层逻辑（补洞/重连）无法脱离具体 store 单测（本章合成帧测试就是靠 StreamSink 才做到不依赖真机不依赖 store）。dsh 的对应物是 Remote namespace 与 Client model 分包，靠注入面拼装。
> 2. 第一级（状态引用）防"没变化也重算"——immer 无变更时引用不动，直接返回缓存；第二级（等值比较）防"变了但选中切片没变"——换新引用但 sel 输出 Object.is 相等时交还旧引用，否则 uSES 认为 getSnapshot 结果变了、组件重渲染空转。selector 返回原始值时 Object.is 天然稳定，两级缓存都退化为透传——所以原始值 selector 不需要 eq 参数；缓存真正服务的是对象/数组切片。
> 3. 断线期间服务端日志只会增长，新代 baseline = 全量回填，天然覆盖一切增量——resume(since) 的回放在新连接上只是 baseline 的子集，发了也是重复帧。resume 的对账语义要在"**客户端本地有状态且连接保持**"的前提下才有意义：代内丢帧（本章的跳号/心跳揭示）、或未来 F6 服务端只回放尾页的带宽优化。跨断线对账 = 换代全量，这是 F2"每代 baseline"设计在客户端的红利。

## 6. 下章预告（F4 会话装配）

`ui-conversation` 简版：事件注册表（user/assistant/tool_call/tool_result → Node 类型）+ `ui-tool` 通用卡（input/result 折叠，未注册工具走通用卡）+ composer 接线（session.prompt；busy 时禁用——F1 记档的 accepted+看流语义在这里落地）+ assistant 增量渲染（live 帧驱动）。验收：浏览器跑通 mock 场景 9 同款脚本。
