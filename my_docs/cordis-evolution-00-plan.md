# cordis 框架向 dsh 演进规划（总纲）

- 拍板：2026-11-10（用户）：股票代码剥离 → 干净框架上演进 → 再适配股票；演进分两提交（①结构对齐 dsh ②功能补齐）；红线=每步回归全绿，现有功能不破。
- 上游基点：`E:\deepseek-harness` master@fcc0ad4621（2026-11-04，dsh 0.2.2-rc.1，vendor cordis 4.1.0）；上一同步基点 ce7073d5（10-30）。
- 参照文档：`my_docs/dsh-sync-20261101.md`（搬运队列底稿）、`my_docs/dsh-final.md` §4 导读地图、`E:\deepseek-harness\docs\upgrade-guide\`。

## §0 现状盘点（2026-11-10 调查）

**框架侧**：cordis/ 地基八件（context/fiber/events/hooks/loader/registry/scope/service）+ agent.ts 主循环 + 16 通用插件（approval/auto-approval/autonomy/commands/compaction/core-fs/exec/meta-tools/host-webserver/llm-anthropic/mcp-bridge/memory/prompt-sections/services/session-jsonl/skills-registry/subagent/adapter-echo）+ services/ 九服务 + webui/ + 测试三层（cordis-tests b/c/d/e/f 章 + snapshots ch1–45 中框架章 + mock）。

**股票侧**：backtest/ 17 文件（K线仓库/公式引擎/选股器/digest）+ plugins/ 10 个股票插件（market-data、market-data-tdx、news-feed、signal-engine、paper-broker、trade-guard、market-watch、data-store、strategy、mcp-pack-server.mjs）+ skills/ 4 个产品技能（adjudicate/brief/news-brief/review）+ 根目录 13 个 py/mjs 维护脚本 + fixtures/ + 测试章 s1–s14、sc1–sc5、m7、style-state、tracking-digest + my_docs/stock-*.md。

**接入缝现状**（cordis.config.ts，四层叠加 baseRows→appRows→profiles→extraRows）：股票以 `disabled:true` 行留在 baseRows + 29 插件静态 import 表 + profiles.stock/stock-tdx/web-stock。缝是有的，但股票与框架在同一 import 图里——剥离的核心就是把这层搬出去。

**上游增量**（ce7073d5..fcc0ad4621，622 提交）：core agent loop 与 compaction **零变化**——搬运队列全部仍有效。新东西：Team 包（subagent 树内命名寻址）、wait_agent、PTC 每分钟预算、llm 全 deferred 时 placeholder 锚定（做条件工具时的配套行为）、session descriptor v1 迁移。其余为 UI/维护。

## §1 阶段一：股票代码剥离（演进先决条件）

### 1.1 归拢布局（mcp-tdx 范式：代码+文档同目录，目录不提交）

```
my_src/
  stock/                  ← 新增，进根 .gitignore 白名单排除（现状机制天然支持）
    plugins/              ← 10 个股票插件
    backtest/             ← backtest/ 整域 17 文件
    skills/               ← adjudicate/brief/news-brief/review 四 SKILL
    scripts/              ← kclose-tdx.py、hist-refresh-tdx.py、capital-refresh-tdx.py、
                             hist-refresh.mjs、closeout-repair.mjs、flzt-diag.mjs、
                             formula-probe.mjs、indicator-probe.mjs、sc1-*-probe.*、
                             weekend-*.mjs、tdx-duel.ts、docx-extract.py
    fixtures/             ← 行情 JSON
    tests/                ← s1–s14、sc1–sc5、m7、style-state、tracking-digest
    snapshots/            ← 股票场景快照章（挂股票插件的章，执行时按内容划）
    docs/                 ← my_docs/stock-*.md 全部（教学+事故+总纲）
    cordis.stock.config.ts← 股票补丁：plugins/profiles 两件套（§1.2 第 2 条）
  （框架文件原位，§2 再重排目录）
```

**章域划分（11-11 执行时按内容定案）**：快照章 ch1–33 = 框架（教学 01–26 + dsh C4–E2），ch34–45 = 股票（S2–S12 + M8/mcp-pack，共 12 章）；mock 场景键与快照章一一对应，股票场景连同其 11 个专用探针处理段（stockProbe/newsProbe/newsBriefProbe/signalProbe/adjudicateProbe/paperProbe/guardProbe/watchProbe/datastoreProbe/bookProbe/poolProbe）整体住 `stock/mock-scenarios.mjs`（runner 动态发现，同缝模式：scenarios + runHandler + snapshotDir 三出口）。cordis-tests 股票 24 文件（m7+s1–s14+sc1–sc5+style-state+tracking-digest）→ stock/tests/。维护脚本 16+1（tdx-duel.ts）→ stock/scripts/。

### 1.2 接入缝契约（本次立规矩，管未来所有演进）

1. **框架零反向依赖**：框架代码不 import `stock/` 任何文件。唯一接触点 = cordis.config.ts 按约定路径动态发现编译产物 `dist/stock/cordis.stock.config.js`（`existsSync` 守卫 + `import()`；发现点放在两张表初始化之后）：文件存在→`Object.assign` 并入其 plugins/profiles 两件套；缺席→纯框架启动（新机器克隆框架仓即可全绿）；存在但损坏→import 抛错裸奔（fail-loud）。
2. **补丁形态**：`{ plugins?, profiles? }` 两件套。baseRows 的 7 行 disabled 股票占位行留在框架（loader 对 disabled 行 resolve 前跳过——占位不需要插件实现，瀑布序/dump-config 快照零扰动）；stock profile 系三件（stock/stock-tdx/web-stock）整体住在补丁里。
3. **运行时零回引（ESM 环红线）**：补丁对框架 config **只取类型（import type）不取值**——config 顶层 await 补丁，补丁若静态回引 config 即成环 + 顶层 await 死锁（11-11 实录：unsettled top-level await 全套件挂死）。代价：web-stock 的 host 行在补丁内内联（与框架 web profile 逐字段一致，webPort 本地副本）。
4. **股票正向依赖收口**：stock/ 只允许 import 框架的稳定面——cordis 地基（context/plugin API/service 行/事件）、框架插件实现（skills-registry/memory/core-exec-tools 等）、webui/projection。不摸框架内部私有。落地时用 tsc 依赖审计收敛，此后每次框架演进跑一遍审计核对。
5. **缝的向后兼容义务**：框架演进不得悄悄改 plugin API/service 行签名；要改就在演进提交里列明"缝变更清单"，同提交内修好 stock/ 侧适配（stock 在同一工作区，tsc 全量编译天然把关）。
6. **命令分层**：框架 = `npm run cordis / snapshot / mock / live`；股票 = `npm run stock`（tsc && node --test dist/stock/tests）。snapshot/mock runner 扫描双根（snapshots/ + stock/snapshots/），框架单独跑时天然跳过股票章。
7. **产品能力路径显式化**：skills-registry 的 productSkills 从布尔+硬编码路径改为**字符串路径参数**（stock 补丁的 skills 行传 `stock/skills/`）——框架不知道产品技能在哪，路径由补丁给。
8. **spawn 路径跟随 dist 结构**：股票域 spawn 编译产物/维护脚本一律带 `stock/` 段（dist/stock/backtest/...、stock/scripts/kclose-tdx.py，cwd 基准 my_src 不变）。

### 1.3 验收线（M1）

- 在 stock/ 目录临时改名（模拟缺席）的条件下：框架 cordis+snapshot（框架章）+mock 全绿、live 装配可起。
- stock/ 恢复后：`npm run stock` 全绿 + 全量 snapshot 40/40 章数不变。
- 根 .gitignore 生效：`git status` 看不到 stock/。

### 1.4 M1 完成记录（2026-11-11）

三项验收全过，缺席模拟矩阵：snapshot 框架章 28/28 + cordis 0 fail + mock ✓ + `--dump-config` 纯框架渲染；恢复后 snapshot 40/40（28 框架 + 12 股票）+ `npm run stock` 219 全绿。提交节奏=每步一提交，message 统一 `abstract stock`（用户拍板）。

执行期钉进契约的坑（§1.2 已收编）：①补丁回引 config 致 ESM 环 + 顶层 await 死锁（unsettled top-level await）——运行时零回引红线；②tsc 不清孤儿产物，stale dist 混进测试 glob 报假红——重排目录后必须清 dist 重建；③抽取式搬家 `node --check` 只保语法不保标识符（readdirSync 漏 import 被 ch41 行为断言抓出）——搬完必跑行为回归；④spawn/fixture/productSkills 路径语义随迁。

## §2 阶段二＝提交一：文件结构整改（向 dsh 看齐）

**原则**：语义对齐 dsh 包名，不引入 pnpm workspace 工程化（单 tsconfig 单 dist，重排是目录迁移+import 改写，tsc 驱动闭环）。文件名尽量不动，只动目录。

| 目标目录（dsh 语义） | 现状来源 | dsh 参照包 |
|---|---|---|
| src/core/ | cordis/ 八件 + agent.ts + autonomy.ts | core、goal |
| src/llm/ | plugins/llm-anthropic + retry.ts + mock-anthropic.mjs | llm |
| src/session/ | plugins/session-jsonl + services/session-log | session |
| src/tools/ | tools.ts + services/tools.ts + plugins/core-fs/exec/meta-tools | fs、shell、subprocess、core/tools |
| src/approval/ | permissions.ts + services/approval.ts + plugins/approval + auto-approval | guard、interaction |
| src/interaction/ | ui.ts + services/ui-service.ts + plugins/prompt-sections | terminal、interaction |
| src/skill/ | skills.ts + plugins/skills-registry + skills/(框架侧若有) | skill |
| src/memory/ | memory.ts + plugins/memory | spill/memory |
| src/mcp/ | plugins/mcp-bridge | mcp |
| src/subagent/ | subagent.ts + plugins/subagent | subagent、team |
| src/compaction/ | plugins/compaction | compaction |
| src/host/ | plugins/host-webserver + webui/ | host、web、client |
| src/schedule/ | services/schedule.ts | schedule |
| src/util/ | frontmatter.ts 等零碎 | util、typert |
| src/plugins/ | services.ts 聚合行 + adapter-echo 等无主插件 | extensions |
| tests/ | cordis-tests b/c/d/e/f 章 | 各包 test/ |
| snapshots/ | 框架场景章 | snapshots/ |
| stock/ | §1 产物 | （dsh 无对应——私有域） |

- cordis.config.ts 留根：四层叠加机制不动，只是 baseRows 行指向新路径；stock 补丁文件契约不变。
- 执行手法：先 `npx tsc --noEmit` 拿全量 import 错误清单→批量改路径→emit→三层回归。分两批（地基批/插件批），每批全绿再下一批。
- **验收线（M2）**：全量回归绿；目录树与上表一致；`docs/` 结构照 dsh 习惯给每目录一行 README（后续补）。
- **提交一内容** = §1 剥离 + 本节重排（一个提交讲完"结构与分离"）。

## §3 阶段三＝提交二：功能补齐（搬运队列执行版）

顺序按依赖与体量排，每项独立可回归：

| # | 项 | 体量 | 说明 |
|---|---|---|---|
| 1 | durable checkpoint | 小 | 模型请求/顶层工具执行前等 JSONL flush 成功，失败即停——resume 正确性地基 |
| 2 | 语义小规则三合一 | 小 | 工具取消=ABORTED 非失败；重放遇异源 thinking 省略；辅助请求 purpose 声明 |
| 3 | apply_patch | 中 | dsh fs-patch 照抄（parse/applyHunks 纯函数 + LF 归一 + 四轮宽松匹配）+ 工具壳默认 opt-in + 快照场景 |
| 4 | compaction 缺口对齐 | 中-大 | 现有 D5 对照 compaction-basic 四核心（tokenMeter 单一/bracket 事务/warm-prefix 重放/summarize 钩子）补缺；pruner 不足部分先行 |
| 5 | 条件工具 when | 中 | ctx.tools.register(def,{when}) + 每 step resolve ResolvedToolSet + llm 全 deferred placeholder 锚定（新窗口配套行为）——省 token 直接受益盯盘 |
| 6 | subagent 命名寻址 | 小-中 | 树内名字寻址 + send_message({agent})（新窗口 Team 的入门件；任务板/广播不急） |
| 7 | 零成本记录 | 零 | series-start 前缀规则进 snapshot 纪律；PTC 每分钟预算思想（mini 无 PTC，留设计结论）；session descriptor v1 注意项 |

- 每项完成后：tsc→cordis→snapshot 全绿再下一项；行为变化导致 snapshot 重录时在提交说明里写明原因。
- **验收线（M3）**：队列 1–6 全落地，回归全绿，盯盘挂机一天实跑无恙。

## §4 新 git 仓收口（时机与方式，执行时需用户再次确认）

- 时机：M2（提交一落定）之后、M3 开工之前。
- 方式（建议）：`git bundle` 备份现仓库全历史 → 工作区原地将 `.git` 归档（改名保留）→ `git init` 新仓 → 首提交=干净框架（stock/ 已被白名单机制排除，天然不入库）→ 提交二落在新仓。单人单树，无双维护。
- 备选：新目录克隆式重建（路径变更成本高，不推荐）。
- 旧仓 bundle 与归档 .git 保留本地，永不外推。

## §5 里程碑总览

| 里程碑 | 内容 | 验收 |
|---|---|---|
| **M1 ✅ 2026-11-11** | 股票剥离 + 缝契约（§1.4 完成记录） | stock/ 缺席时框架全绿；恢复后 npm run stock 全绿 |
| M2＝提交一 | 结构对齐 dsh 语义目录 | 全量回归绿 + 目录树达标 |
| M— | 新 git 仓初始化（bundle 备份先行） | git log 无股票历史；stock/ 不入库 |
| M3＝提交二 | 功能补齐队列 1–6 | 全量回归绿 + 挂机实跑一天 |
| 之后 | 股票域在 stock/ 内继续演进 | 每次框架演进跑依赖审计 + 双侧回归 |

## §6 明日（11-11）安排

- 不盯盘（用户拍板，tokens 全投框架）。挂账：11-12 恢复盯盘时先起 eltdx 网关（runbook 照旧）。
- 11-10 选股修正后的清单（16 只）不受影响；11-10 精选第三"固高科技"仍作废、观察"新炬网络"剔除（快照毒 bar 事故余波，详见 stock-debugging-20261110）。
