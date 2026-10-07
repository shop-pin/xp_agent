# dsh-E2 bundle/profile 简版——同一份代码，两条清单组装出两个 agent

> 对应规格：`dsh-00-chapters.md` §E2。参照物：dsh 的 cordis loader（行模型 + 分层 patch，B6 已立地基）。
> 章旨：E1 之前"装什么"的答案散在 Agent 构造函数的 22 个语句里，清单（cordis.config.ts）还是 B6 的玩具。本章把它变成真实产品的总装配点：**base 层（全能力）+ app 层（CLI 装配）+ profile 层（产品形态）+ `--patch`（用户），同 id 整行替换**。

## 1. 迁移前的三个"装配不可见"

1. **服务在清单之外**——`new ToolsService(ctx, "tools")` 等 7 个基础设施在构造函数里直接起，dump/patch/分层都够不着它们。真 cordis 里服务也是插件提供的，容器只是表。
2. **桥/选项以字面量散在构造函数**——subagent/memory/autonomy/commands 四个桥、isSubAgent 开关、customSystemPrompt，全是内联对象字面量。清单知道有这些插件，不知道它们怎么被喂。
3. **产品形态没有表达**——"全功能版"与"无 auto-mode 版"应当是**两条配置**组装同一份代码（dsh 的 bundle/profile 思想），而不是两份代码。

## 2. 新机制：四层行表

```
buildRows({ host, profile, extraRows }) = mergeRows([
  baseRows,        // 全能力：行序 = 激活序（三组生命线钉在注释里）
  appRows(host),   // CLI 装配：桥/选项接到同 id 行上（整行替换）
  profiles[name],  // 'full'（空）/ 'no-auto'（auto-approval 行 → disabled 占位）
  extraRows,       // --patch / 测试：最后落笔，赢过一切
])
```

- **行模型（B6 立的规矩，本章兑现）**：`{ id, name, config?, disabled? }`。id 是配置身份（去重键），name 是实现入口（查插件表）。同 id 后写胜是**整行替换**——想改 config 必须连 name 一起写全，只写 config 会把 name 顶掉，resolve 时以 `no plugin named "undefined"` fail-loud。
- **服务行化**（`plugins/services.ts` 新文件）：7 个 Service 各包成零依赖插件行。`Service` 基类构造即同步 provide，所以**行序 = 服务可用序 = 后续能力行的依赖就绪序**。唯一带 inject 的是 svc-ui（消费 session-log 的日志面）——就算被 patch 挪到 session-log 之前也能等就绪再激活，这正是 B2 provide 通知的红利。
- **AppHost 接口**（config 侧声明，Agent 实现）：parentMode/isSubAgent/customSystemPrompt/commands 桥/inject/wake/getBudget/getMaxTurns/addTokens。**接线知识归 config，能力归 agent**——Agent 构造函数从"装载者"收缩为"宿主能力提供者"。parentMode 必须是活取（`() => this.mode`）：plan 切换后子 agent 要看到新模式，快照值会让子 agent 拿着过期模式跑完整个任务。
- **三组生命线顺序**（钉在 baseRows 注释里，分层/patch 都不许打乱）：服务行在前；core-fs → core-exec → core-meta = 工具广告序（请求体 tools 数组顺序，C1 立的规矩）；approval → auto-approval = 审批瀑布从外到内（C2 立的规矩）。

## 3. 设计决策记档

1. **桥仍走 row config，不收拢成 host 服务**。真 dsh 的插件 inject 服务而不是从 config 收闭包；mini 版保守处理——收拢要动 4 个插件 + 回归面全开，超出行分层本章的靶心。**记为思考题 3**。
2. **profile 层次序：base < app < profile < extra**。profile 是产品形态选择器，必须赢过 app 装配（否则 app 层给 auto-approval 行补 config 时会把 disabled 行"复活"——整行替换语义下，后写连 disabled 一起换掉）。
3. **C8 的惰性持久化保留直调**，不进清单——"首个 turn 才挂载"是运行时行为（resume 防自复制），不是装配差异。清单管"装什么"，不管"何时激活"。
4. **plan 节仍由 Agent 自注册**，不进清单——它读本类 mode/planFilePath 私有状态，是本类的私有视角，不是可装配能力。
5. **`--dump-config` 打最终行表**（formatRows，纯数据、函数折叠 `<fn>`），运行态 fiber 树另给 `agent.dumpTree()`（loader 的 dumpTree）。一个答"装了什么"，一个答"活了没有"。

## 4. 翻车记档：no-auto profile 抓出一个真洞

**现象**：场景 33 里 no-auto agent 在 auto 模式下写文件**直接落盘**——approval 外层在 auto 模式对内层"盲弃权"（`if (call.mode === "auto") return next()`），auto-approval 行被注释掉后 `next()` 直通兜底放行。非 deny 动作全部裸奔。

**这个洞 E2 前不可达**（auto-approval 恒在），是 no-auto 产品形态第一次让它可见——profile 的验收价值在此：**组装断言不只是"行在不在"，行为差异要拿真实裁决路径验**。

**修法**（保持"外层硬底线、内层策略"的瀑布分工不变）：
- auto-approval 插件挂监听器前 `ctx.provide("auto-adjudicator", { ownedBy: "auto-approval" })`——在场标记；
- approval 外层改为 `if (call.mode === "auto" && ctx.get("auto-adjudicator")) return next()`——**弃权前确认内层有人接手**，没人就按 default 流程走完（落到 ⑧ confirm 候选段：有人就问，headless 由 fallback 走 REPL）。

**代价核对**：`auto-adjudicator` 恒在的老装配下行为逐字节不变（mock 28 场景零断言变更）；新分支只在"auto 模式且无内层监听器"这一新组合生效。

**教训**：分层清单的 disabled 不是"删代码"，是"换产品"——每条 profile 都要回答"被注释掉的能力，原来的协作方怎么办"。这里 approval/auto-approval 是显式协作对（外层弃权 → 内层接手），协作对一单，补位责任就落在留存方。

## 5. 实现与验证记录

- 代码：`cordis.config.ts` 重写（插件表 22 项 + baseRows + AppHost/appRows + profiles + mergeRows/formatRows/buildRows）；`plugins/services.ts` 新增（7 个服务行）；`plugins/approval.ts` 弃权前查在场标记；`plugins/auto-approval.ts` 提供标记；`agent.ts` 构造函数换 `loadRows`（+dumpConfig/dumpTree 方法，sessionLog/commands 转 getter）；`cli.ts` 加 `--profile`/`--patch`/`--dump-config`。
- B6 玩具清单（core/greeter/clock）原样内联回 `cordis-tests/b6-loader.test.ts`——loader 的教学夹具归测试，清单归产品。
- 新测试：`cordis-tests/e2-bundle.test.ts` 8 条（服务先行/广告序/瀑布序、app 层接线、isSubAgent 开关、full ≙ base 原样且 no-auto 只动一行、未知 profile fail-loud、extra 赢过 profile、整行替换不合并、formatRows 形状）。
- 新场景 33（profileProbe）：双 agent 直调，dump 双视图断言（运行态树一含一不含该行、行表 disabled 占位）+ 裁决路径差断言（full 走分类器 1 次后落盘；no-auto 零分类器调用、写被 confirm 否掉）。**全量 mock 28/28 全绿，既有场景零断言变更**；cordis 140/140；CLI 三旗标冒烟通过（dump 行表/patch 覆盖）。

## 6. 自测三题（答案在文末）

1. 为什么 `--patch` 想给 compaction 行加 config 时必须把 `name: "compaction"` 也写全？
2. profile 层为什么必须排在 app 层（host 装配）之后、extraRows 之前？
3. approval 外层的 auto 段如果不查 `auto-adjudicator` 直接 `next()`，在老装配（auto-approval 恒在）下会不会出事？为什么这个洞拖到 E2 才暴露？

## 7. 遗留与下章（E3）

- E1 的 REPL 手测清单（`dsh-E1.md` §4）仍待终端过一遍，可顺手加 `--dump-config` 两条冒烟。
- E3 snapshot 回归与收官：录制/回放（对齐 dsh `test:snapshot`）、mini-cordis vs 真 Cordis 差异清单、dsh 源码导读地图。

---

### 自测答案

1. 同 id 后写胜是**整行替换**不是字段合并（B6 定死的语义，防"半新半旧行"这种说不清的状态）：只写 config 的行会把 name 顶成 undefined，resolve 以 `no plugin named "undefined"` fail-loud——炸在挂载点，不静默丢能力。
2. profile 赢过 app：app 层用同 id 行给 base 的 config-less 行补桥/选项，若 profile 排在 app 之前，no-auto 的 disabled 行会被 app 的 config 行整行替换回去——"注释掉"被装配层无意复活。extraRows 最后落笔，用户 patch 赢过一切。
3. 不会——老装配下 `next()` 后面恒有内层 auto 监听器接手，弃权即转交。洞的暴露条件是"auto 模式 + 无内层监听器"这个新组合，而能造出这个组合的第一个机制就是 no-auto profile。所以不是洞潜伏了 4 章，是**让洞可达的配置今天才存在**——验收双 profile 时用真实裁决路径断言，抓的正是这类"清单对了、协作断了"。
