# dsh-F1 web Host 最小面——一元 RPC 与信封

> 对应规格：`dsh-00-ui-plan.md` §3 F1。参照物：dsh `packages/api` 的一元调用（HTTP POST + 信封 `{ok,value}|{ok,error}`，不抛异常）+ `packages/host` 的 webserver 座位 + `apps/cli` 的 profile 启动拓扑。
> 一句话：**引擎一行不改——Host 是清单上的一行插件，agent 同进程；HTTP 只绑 loopback，语义错误走信封不走状态码。**

## 1. 产物与边界

**文件**：`plugins/host-webserver.ts`（新增：HostService + hostWebserverPlugin）；`cordis.config.ts`（AppHost 增 `agentId/isBusy/sendText` 三桥方法；baseRows 尾部加默认 disabled 的 host 行；profiles 支持 `(host) => Row[]` 工厂 + `web` profile；插件表 +1）；`agent.ts`（host() 桥补三闭包；`get webHost()` 句柄；close() 收口 Host）；`cli.ts`（`--web`/`--port` 旗标 + web 模式挂起 + SIGINT 收口）；`cordis-tests/f1-host.test.ts`（新增 7 条）。

**方法面**（F1 过渡期拉取，F2 换事件流）：

| 方法 | 动词 | 语义 |
|---|---|---|
| `/api/session.create` | POST | 幂等返回本树唯一会话 `{id, busy, messageCount}`——mini Host 单会话，multi-session 的 SessionRegistry 记档不抄（dsh 的 session.create/list 语义对齐留 F6 侧栏） |
| `/api/session.prompt` | POST | `{text}` → `await agent.send(text)`，**整 turn 结算才回**；busy 时信封报错（不排队——排队语义归 F2 后的客户端重试） |
| `/api/session.list` | GET | 单条数组 |
| `/api/session.events?since=<seq>` | GET | seq = 事件下标（D5 fold 同款稳定身份），返回 `(since, now]` 增量 |

**安全默认**：只绑 `127.0.0.1`（agent 能执行任意命令，绝不暴露网络面）；静态目录前缀守卫防穿越；请求体 1MB 上限。

## 2. 设计决策记档

1. **profile 工厂化**：web profile 需要 AppHost 的桥（agentId/isBusy/sendText），静态 `Row[]` 拿不到——profiles 值放宽为 `Row[] | ((host?) => Row[])`。"产品形态选择器本来就有权看装配宿主"，E2 的层次序（base < app < profile < extra）不变，整行替换语义不变。
2. **桥在工厂里拼，不走 appRows**：appRows 若带 host 行会把 base 的 disabled 行整行替换成 enabled（E2 no-auto 翻车的镜像）——所以 base 行保持 disabled、app 层不碰 host、只有 web profile 工厂（赢过 base）启用并接桥。`--dump-config --profile web` 无宿主时工厂返回 disabled 占位——预览不装配。
3. **语义错误走信封（HTTP 200），路由错误走状态码**：未知方法 404 + 信封、坏动词 405 + 信封、busy/坏参数/坏 JSON → 200 + `{ok:false,error}`——客户端按信封分支，不在传输层分支（dsh 一元调用同款约定）。
4. **shutdown 与 effect 双保险**：`ctx.effect` 管 fiber 卸载路径，`Agent.close()` 显式调 `shutdown()`（与 disposeAll/disconnectAll 同一条进程级收口缝）——B3 的 effect 在 mini 没有进程级 dispose 入口，close() 就是那个缝。`closeAllConnections()` 必须调：fetch 的 keep-alive 连接会吊住测试进程。

## 3. 实现与验证记录

**验证**：cordis **147/147**（F1 新增 7 条：create 幂等/真 turn 事件流/since 增量/list/四条错误路径/静态+穿越守卫/默认 profile 不绑端口——测试走 **profile web 全装配链** 而非裸树，echo 路由跑真 turn）；mock **28 场景全绿**（host 行默认 disabled，零影响）；CLI 冒烟：`--dump-config --profile web` 行表带桥、`--web` + curl 三方法（create/prompt/events）全通。

## 4. 翻车记档

1. **endpoint 的异步性**：`listen` 回调没跑完时 `endpoint` 是 null——单测和 cli `--web` 先后栽在同一处（测试断言 null、cli 报 "did not enable the host row"）。修法：HostService 加 `ready` promise，等待就绪再读端点。**port 0 的真实端口只存在于绑定回调里——"服务已挂上"和"服务已知自己的地址"是两件事。**
2. **getter 与工厂方法撞名**：`get host()` 撞上 E2 的私有 `host()`（宿主能力面工厂）——TS2300。改叫 `webHost`，不改 E2 时代的代码。**同名词在不同层指不同的东西时，改名比消歧义便宜。**
3. **%2e%2e 穿越打不到守卫**：WHATWG URL 在 parse 阶段就把百分号编码的点段归一化了（fetch/浏览器同款行为，本身是一层防线）→ 404。真正能到达前缀守卫的是反斜杠形态（`..%5c`，Windows 路径分隔符不被 URL 归一化）→ 403。测试两条都锚。
4. **（记档，不改）`--dump-config --profile web` 会瞬时绑端口**：预览与真实装配共用一条 buildRows 路径，不为预览做特判——端口冲突只留 error 行，不影响退出码。
5. **（重演确认）sed 事故纪律**：本章全程用 Edit 工具；一处误删 `--goal` 判断行的编辑立刻在下一步读回修复——"每步编辑后看一眼上下文"避免了 D4/D6 式的手滑进构建。

## 5. 自测三题（答案在文末）

1. 为什么 session.prompt 选择"整 turn 结算才返回"而不是立即返回排队？F2 之后这个选择要怎么改？
2. host 桥为什么不走 appRows 接线（像 autonomy/commands 那样），而走 profiles.web 工厂？
3. 信封错误（ok:false, HTTP 200）与路由错误（404/405）的分工依据是什么？如果全部用 4xx 状态码会失去什么？

> **答案**：
> 1. 整 turn 结算让 F1 的 curl 验收天然同步（发完 prompt 拉事件必见完整序列），且 busy 竞态最小；代价是长 turn 占住连接。F2 客户端有了事件流后应改成"立即返回 accepted + 靠流观察 settle"——阻塞语义是拉取期的脚手架。
> 2. appRows 用同 id 整行替换会给 base 的 disabled host 行"补 config"的同时把它复活（E2 no-auto 翻车的镜像：后写连 disabled 一起换掉）。工厂放在 profile 层（赢过 base）一处启用 + 桥在手；dump-config 无宿主时工厂返回 disabled 占位，预览不装配。
> 3. 分工 = **语义 vs 寻址**：信封管"这个请求在业务上失败了"（客户端在会话语义层重试/提示），状态码管"这个请求没有到达合法的处理者"（404 没这方法/405 动词错——代理、缓存、curl -f 这些 HTTP 生态工具按状态码工作）。全 4xx 会把可重试的业务失败变成传输层错误，客户端的分支逻辑被迫解析状态码字符串。

## 6. 下章预告（F2 事件流）

`/api/stream` WebSocket：follow-first（连上先发历史回填再推 live）+ seq 连续性 + 心跳 + resume(sinceSeq) 补洞；多客户端广播。验收：两个 WS 客户端同看一会话、中途断连重连后无洞无重（node:test）。
