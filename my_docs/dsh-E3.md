# dsh-E3 snapshot 回归——从"点状锚"到"全量锚"

> 对应规格：`dsh-00-chapters.md` §E3。收官总文档（差异清单/场景终态/导读地图）在 `dsh-final.md`，本章只记 snapshot 机制本身。

## 1. 原理：dsh 的三模式与 mini 的对应

dsh `test:snapshot` 的核心思想（`vitest.snapshot.config.ts` 头注释）：
**replay 是无 key 默认**——用录制的模型响应启动真实管线，diff 组装出的请求、规范化后的协议/转录输出、落盘日志期望值；`record` 调真 API 更新 fixture；`refresh` 用已提交脚本重放并重写期望输出（代码有意变更后 harvest 新期望）。

mini 的结构对应与偏差（诚实记档）：

| 维度 | dsh | mini | 说明 |
|---|---|---|---|
| 录制响应的供应者 | `llm-replay` 适配器（快照内嵌响应脚本） | mock-anthropic 的场景脚本 | mini 的 mock ≙ "已录响应"——录制不必存响应，**存的是请求与事件** |
| 锚粒度 | 请求 + 协议输出 + 落盘日志 | **完整请求体 + 会话事件流逐字节** | 既有 28 场景手写 verify 是点状锚（每章挑几个字段），快照是全量锚 |
| 断言方式 | vitest 快照断言 | 行级 diff（首个差异 + 上下文截断） | 不引测试框架，复用 mock 驱动 |
| 隔离 | vitest worker/并发预算 | 每章一个子进程 | HOME 沙箱/MCP 子进程/进程状态隔离 |
| 刷新 | `DSH_SNAPSHOT=refresh`（保留脚本重写期望） | `--record` 重录 | mini 的"脚本"与"期望"合一（都在场景定义里），无需独立 refresh |

**价值命题**：点状锚防"断言点到的地方坏"；全量锚防"任何没点到的地方坏"。重构型项目的回归雷区（请求组装顺序、事件序、广告序）恰恰都在点与点之间。

## 2. 机制（三层）

1. **捕获**：`mock-anthropic.mjs` 加 `capturePath` 通道——每个请求的完整 body 逐字节落盘（与 logPath 摘要通道互不影响）。
2. **规范化**（`snapshot-lib.mjs`）：`normalizeText` 把易变值换成占位符；`buildSnapshotPayload` 收请求（深度规范化 JSON 树）+ 会话事件流（`~/.mini-claude/sessions/*.jsonl` 按 mtime 排序重命名 `session-<n>.jsonl`）。
3. **diff 与驱动**：`diffSnapshot` 先比行数再逐行比，首个差异给上下文；`run-snapshot.mjs` 枚举 `snapshots/ch*` 逐章子进程回放，退出码汇总是验收线。`npm run snapshot` / `snapshot:record`。

## 3. 翻车记档：规范化的三个坑（危险点"时间戳/随机 id"的实账）

1. **JSON 转义形态路径**：事件 content 是**二次 JSON 字符串化**（system 数组 stringify 进字符串），行内路径是 `C:\\tmp\\x` 双反斜杠；对整行做字符串替换永远打不中 vars 的单反斜杠。修法：事件行先 `JSON.parse` → `normalizeJsonDeep` → 再 stringify；`normalizeText` 同时备原始/转义/正斜杠三种形态的替换针。
2. **场景数据里的时间与随机**：三个独立源——memory 索引的文件 mtime（ISO 戳）、plan 文件名的随机 sessionId、truncate 落盘名的 `毫秒-8hex`。各自占位符（`{{iso}}`/`plan-{{session}}`/`{{resultfile}}`），后两个从 record 时实际值/正则捕获。
3. **快照锚不了非法字节**：ch32 故意写入半行 `{"type":"user/mes`（崩溃修复的测试数据）——`JSON.parse` 直接炸。修法：解析失败的行跳过，记档"该行为由手写 verify 断言"。

**教训**：录制的第一反应是"猜模式写正则"，实际顺序应该是**先录一遍、diff 红了再补占位符**——每个红都是一个具体的易变源，比穷举想象可靠。本章三个坑全是这么抓到的。

**flaky 记档**：录后首轮回放 27/28（红章未定位，输出截断），随后连续四轮 28/28。嫌疑：ch24（loop 定时）/ch27（midturn 探针）时序敏感。若再现，diff 报告自带请求序号。

**2026-10-17 增补（检视轮定案，两个偶发红的根因与修法）**：

4. **ch10 mock 计数闪断 = Windows PID 撞名污染日志**：`logPath`/`capturePath` 以 `process.pid` 命名，Windows 上 PID 高速复用——快速连跑多章时两次跑撞同一文件名，append 模式把上一轮的行带进来（现场：ch10 数出 12 个请求 = 6×2，日志文件恰为两倍大小）。修法：`run-mock.mjs` 开跑前 `rmSync` 清场。教训：**用 PID 当临时文件名在 Windows 上不是唯一性保证**——要么随机后缀，要么用前先清。
5. **ch8 snapshot 闪断 = 跨轨请求到达序竞态**：memory 侧调（memory 轨）与主轨请求并行在飞，谁先到 mock 是回环 TCP 竞态——基线录的是 [memory, main, main]，偶发变 [main, memory, main] → 首行 diff 红。修法：capture 行带 `track`（路由名），规范层按轨名**稳定排序**（跨轨到达序不锚，轨内到达序 = 轮次序仍锚；主轨严格串行，轨内序天然确定）。格式变更 → 全量 28 章重录 + 两轮 replay 全绿。教训：**字节锚的前提是被锚的序是确定性的**；并行度引入的那一刻，"到达序"就不再属于可锚集合，要么消并行要么把序规范化。

## 4. 自测两题（答案在文末）

1. 为什么 mini 不需要像 dsh 那样在快照里存"录制的模型响应"？
2. 规范化为什么优先"按实际值全局替换"而不是"全部用正则猜模式"？

---

### 自测答案

1. dsh 的 replay 要在**无 mock 服务**的形态下跑真实管线，所以响应必须随快照走（llm-replay 适配器消费）；mini 的 mock-anthropic 本身就是确定性响应供应者（脚本 ≙ 录制），快照只需锚**请求侧 + 事件侧**——响应是输入不是被测物。代价是 mini 的回放仍依赖 mock 服务进程（"无 key"而非"无服务"），这是诚实记档的结构差异。
2. 实际值替换是**精确**的（拿到什么换什么，零误伤）；正则猜模式有误伤面（`\d{13}-[0-9a-f]{8}` 若出现在场景数据里会被误折叠）。本章的纪律：具体值（workdir/HOME/sid）一律实际值替换；只有拿不到实际值的（git 段、mtime、毫秒戳）才用正则，且正则尽量带上下文锚（`tool-results` 前缀、`# Git context` 段界）。

## 5. 代码执行流程图

> 对应提交 `9f59277`。四条主线：三模式对应（record/replay ≙ record/refresh）→ 捕获与规范化（易变值登记表）→ diff 与子进程驱动 → 完整走查（ch9 录→放一轮）。

### 5.1 三模式：锚什么、不锚什么

```
dsh test:snapshot                    mini 对应
─────────────────────────────────────────────────────────────────
record  调真 API 更新 fixture   ≙   --snapshot-record（mock 脚本响应≙录制，
                                     快照存的是【请求 + 事件】，不存响应）
replay  无 key 重放 + diff      ≙   默认模式（重跑场景 → 逐字节 diff 已存快照）
refresh 保留脚本重写期望        ≙   --record 重录（脚本与期望合一，无需独立模式）

锚粒度：
  既有手写 verify   点状锚——每章挑几个字段断言（防"点到的地方坏"）
  快照 diff         全量锚——完整请求体 + 会话事件流逐字节（防"没点到的坏"：
                    请求组装顺序、事件序、广告序——重构雷区恰在点与点之间）

双保险：回放时手写 verify 照跑（场景级断言不退休），快照红/绿是第二道线
```

### 5.2 捕获与规范化：把易变值折进占位符

```
① 捕获（mock-anthropic 加 capturePath 通道）：
   每个请求的完整 body → appendFileSync(capturePath, { body })
   ★ 与 logPath 摘要通道互不影响——录制是追加通道

② 载荷（buildSnapshotPayload）：
   requests = capture 每行 JSON.parse → normalizeJsonDeep(body, vars)
   events   = ~/.mini-claude/sessions/*.jsonl 按 mtime 排序 → 重命名 session-<n>.jsonl
              每行 JSON.parse → 失败跳过（ch32 崩溃半行——快照锚不了非法字节，
              该行为由手写 verify 断言）→ 规范化 → stringify
   vars 登记表：cwd / home（实际值）、sessionIds（从文件名捕获——plan 文件路径共用）

③ normalizeText（顺序敏感）：
   实际值替换：home/cwd 各备三形态——原始 C:\tmp\x、JSON 转义 C:\\tmp\\x、
     正斜杠 C:/tmp/x；长针优先排序（home 是 cwd 前缀时不被短替换截断）
     ★ 整行替换吃不到二次字符串化里的转义路径——事件行必须先 parse 再换
   正则折叠（拿不到实际值的）：# Git context 段、Today's date、Shell/Platform
     行、projects\<16hex>、ISO 时间戳、tool-results\<毫秒>-<8hex>、plan-<sid>
```

### 5.3 diff 与驱动：每章一个子进程

```
diffSnapshot(expected, actual)：
  cmp("requests")：先比行数 → 逐行比（JSON.stringify 后的规范形）
    有差 → 收敛：首个差异行 + expected/actual 各截 300 字符
  requests 绿 → cmp("events")（flatMap 文件名分组后同款比较）
  返回 { ok, report }——报告自带行号与类型，先分清"新行为 or 规范化漏网"

run-snapshot.mjs：
  枚举 snapshots/ch*（无快照 → 提示先 record，exit 1）
  for dir of targets：spawnSync(run-mock.mjs, [ch, --snapshot-record|replay])
    ★ 每章一个子进程——HOME 沙箱 / MCP 子进程 / 进程状态互相隔离
  尾行含 "✓ snapshot" 且 exit 0 → 绿；退出码汇总是验收线
  npm run snapshot / snapshot:record（tsc 前置）
```

### 5.4 完整时序走查：ch9 录制 → 回放一轮

```
录制（node run-snapshot.mjs --record 9）：
  spawnSync run-mock.mjs 9 --snapshot-record
    snapshotMode="record"；capturePath = 临时 my-ch9-capture-<pid>.jsonl
    mock 起 → 场景 9 三请求（catalog 注入 / skill 激活 / Unknown skill）
    每请求：body 落 capture；user/message 等事件落 sessions/<sid>.jsonl
    verify 照跑（点状锚全绿）→ snapshotStep：
      payload = build：requests[3] 规范化（C:\Users\...\my-ch9-xxx → {{cwd}}
        三形态替换）、events = session-1.jsonl（分组带名）
      writeSnapshot → snapshots/ch9/{requests,events}.jsonl + meta.json
      ✓ "snapshot recorded → snapshots/ch9 (3 requests, 1 session file(s))"

回放（node run-snapshot.mjs）：
  spawnSync run-mock.mjs 9 --snapshot-replay
    ★ 新 workdir（随机名）、新 sessionId——对旧快照而言全是易变值
    同一脚本同响应 → 新一轮请求/事件 → 同款规范化：
      新 workdir → {{cwd}}、新 sid → plan-{{session}}——两次 run 的产物
      落进同一个占位符空间，逐字节可比
    verify 照跑 → snapshotStep：readSnapshot(ch9) → diffSnapshot
      ✓ "snapshot replay: 3 requests + 1 session file(s) byte-identical"
  尾行采样回总驱动 → "ch9 ✓" → 退出码 0

红的时候长什么样：
  改一行请求组装（如给 system 添节）→ replay 的 requests 行数或首行内容变
  → "requests: first diff at line N + expected/actual 上下文截断"
  → exit 1 → 总驱动 "ch9 ✗"——重构雷区在点状锚没点到的地方，全量锚兜住
```
