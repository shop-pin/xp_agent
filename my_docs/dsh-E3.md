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

## 4. 自测两题（答案在文末）

1. 为什么 mini 不需要像 dsh 那样在快照里存"录制的模型响应"？
2. 规范化为什么优先"按实际值全局替换"而不是"全部用正则猜模式"？

---

### 自测答案

1. dsh 的 replay 要在**无 mock 服务**的形态下跑真实管线，所以响应必须随快照走（llm-replay 适配器消费）；mini 的 mock-anthropic 本身就是确定性响应供应者（脚本 ≙ 录制），快照只需锚**请求侧 + 事件侧**——响应是输入不是被测物。代价是 mini 的回放仍依赖 mock 服务进程（"无 key"而非"无服务"），这是诚实记档的结构差异。
2. 实际值替换是**精确**的（拿到什么换什么，零误伤）；正则猜模式有误伤面（`\d{13}-[0-9a-f]{8}` 若出现在场景数据里会被误折叠）。本章的纪律：具体值（workdir/HOME/sid）一律实际值替换；只有拿不到实际值的（git 段、mtime、毫秒戳）才用正则，且正则尽量带上下文锚（`tool-results` 前缀、`# Git context` 段界）。
