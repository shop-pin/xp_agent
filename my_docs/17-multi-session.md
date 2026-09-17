# 第十七章：多会话 + mock HOME 沙箱（进阶轮第 2 章）

## 为什么是多会话

现在 my_src 的 session 是"一个 cwd 一份"：`.mini-session.json` 单文件，只存消息数组，没有元数据。它能撑起 --resume，但答不了三个问题：**这是什么时候的会话？用的什么模型？除了它还有别的会话吗？**

src 的模型（63 行）：

- 每个会话一个文件：`~/.mini-claude/sessions/<id>.json`（id = randomUUID 截前 8 位）
- 文件结构 = `metadata`（id/model/cwd/startTime/messageCount）+ `anthropicMessages`（消息体）
- 四个函数：`saveSession` / `loadSession` / `listSessions` / `getLatestSessionId`——`--resume` 的语义升级为"恢复**最近一次**会话"

这也是后续章节的地基：22 章 memory 将住 `~/.mini-claude/projects/<hash>/memory`——家目录布局从这章开始成型。

## 跨平台与 mock 沙箱（工程事实）

- `os.homedir()`：Windows 读 `USERPROFILE`，POSIX 读 `$HOME`。run-mock 沙箱**两个都设**，双平台行为一致。
- **实测（2026-09-17）**：`os.homedir()` **不缓存**，env 改完下一次调用立刻生效——所以"设 env → 动态 import dist/cli.js"的时序是可靠的。

## my_src 不照抄 src 的第二个决策

src/session.ts:5 是模块级 `const SESSION_DIR = join(homedir(), ...)`。my_src 改成**惰性求值**（`sessionDir()` 私有函数，每次调用现场算）：

- 今天 mock 在 import 前设 env，模块级 const 其实也能对——但那把正确性押在 import 时序上；
- 将来任何模块在 import 期碰 homedir、任何场景想换沙箱，模块级 const 全线出错且难查；
- 惰性多两行，买的是"读 env 的时机 = 读写文件的时机"，与模块加载顺序彻底解耦。22 章 memory 复用同一模式。

## 设计点（写之前想清楚）

**1. 容错放哪层？**
`loadSession` / `listSessions` 读的是磁盘上可能损坏的文件（手删一半、写坏）——模块内 try/catch，坏 → null / 跳过，绝不让 --resume 崩。`saveSession` 的写失败（磁盘满、权限）——src 让它**裸奔**，由调用方 `agent.autoSave()` 的 try/catch 兜。为什么读错要就地消化、写错可以上抛？--resume 是"要不要恢复"的用户决策，崩了没得用；写盘是尽力而为的后台动作，为它打断对话不值得。

**2. getLatestSessionId 的排序键**
候选 A：ISO 字符串直接字典序比较（startTime 是 ISO 8601 UTC，同长度时字典序==时间序）。候选 B：`new Date(b.startTime).getTime() - new Date(a.startTime).getTime()`（src 用 B）。想两个问题：A 在什么输入下会翻车？B 在 startTime 非法时得 NaN，比较结果恒 false，排序会怎样？两个都写得出理由就行——你选一个，口答时说清取舍。

**3. listSessions 的坏文件**
readdir → filter `.json` → 逐个 parse。一个坏文件不能毁掉整个列表：单文件 try/catch，失败跳过；最后 `.filter(Boolean)` 收尾。

## 分工

| 部分 | 谁做 |
|------|------|
| session.ts 四个函数体（骨架已留 TODO；类型契约按规格已给，可 review） | **你写** |
| agent/cli 接线：sessionId/startTime 字段、autoSave、restoreSession、--resume 三段式 | Claude |
| 职责搬家：持久化从 cli 收进 agent（每轮 chat 结束自动落盘） | Claude（讲解） |
| run-mock：HOME/USERPROFILE 沙箱 + ch4 场景迁移 | Claude |

## 接线后的行为变化（Claude 代填部分，你 review）

- Agent 构造时生成 `sessionId` + `sessionStartTime`；chat 正常结束自动 `autoSave()`（含 metadata）
- cli 里四处手动 `saveSession` 全拆（/clear、one-shot、REPL、goal）——持久化是 Agent 的本职（只有它知道 id 和消息），cli 只管 --resume
- --resume 升级为三段式：`getLatestSessionId()` → `loadSession()` → `agent.restoreSession()`，每段都有"没有"的出路（printInfo 提示，不崩）
- run-mock 所有场景 HOME/USERPROFILE → 沙箱；ch4 断言改锚：新目录 + metadata 字段 + 旧 `.mini-session.json` 已消失

## 分步提示

1. 读 my_src/session.ts 四处 `TODO(你来写)`，对照上面三个设计点
2. 建议顺序：sessionDir + saveSession → loadSession → listSessions → getLatestSessionId（前两个是后两个的地基）
3. 每写完一个自问：输入畸形（目录不存在 / 文件缺失 / JSON 坏 / startTime 乱写）时这个函数的行为？
4. 写完口答三题：①sessionDir() 为什么不能模块级 const？②你排序选了哪个方案、它的翻车场景是什么？③listSessions 遇到坏文件会怎样？
5. `npm run build && node run-mock.mjs 4` 单看 ch4 → 全量 13 场景回归

**注意：你动手前 ch4 就是红的（函数体是空桩）——这是预期基线，写完应当转绿。**

## 收尾记录（2026-09-17）

- 交付：session.ts 四函数完成（用户首写 → review 发现多处坑 → Claude 代填收尾）、agent/cli 接线、mock HOME 沙箱、ch4 迁移九断言全绿、回归 13/13
- 用户首写正确部分：**sessionDir() 惰性求值**（本章核心设计点）✓、saveSession 结构 ✓、loadSession 的 existsSync→try/catch 骨架 ✓；review 后自己修好了 loadSession 的 readFileSync
- 用户原稿的坑（按教学价值排序）：
  1. **`JSON.parse(路径字符串)` 而非文件内容**（loadSession/listSessions 各一次）——loadSession 从此永远返回 null，**且被自己的 try/catch 掩盖**。核心教训：容错代码会把崩溃变成静默失败，这正是必须有 mock 的原因
  2. **`filter().map()` 结果丢弃**——两个方法都返回新数组不改原数组，没接住就等于没调用，函数永远 `return []`
  3. **sort 比较器返回布尔**——`(a,b) JSON.parse(a).startTime > ...` 一行三错：缺 `=>`（语法错）、布尔强转排序不稳定（反例 `["10","9"].sort((a,b)=>a>b)`）、比较对象是文件名。比较器契约：返回负数/零/正数
  4. **返回值带 `.json` 后缀**——readdir 给的是文件名，调用方要裸 id，否则 loadSession 拼出 `xxx.json.json`
  5. `import { setFips } from "crypto"`——IDE 自动导入事故，没用到的 import 要扫一眼
- 三道口答题答案（用户未口答，代填讲解覆盖）：
  1. sessionDir() 惰性：把"读 env 的时机"推迟到"读写文件的时机"，与模块加载顺序解耦——正确性不押在 import 时序上
  2. 排序键选了 B（Date.getTime，对齐 src）：A（ISO 字典序）在 startTime 不是等长 UTC 格式时翻车（时区偏移、格式漂移）；B 容忍任何可解析日期，非法值得 NaN 时该行顺序不定但不崩
  3. listSessions：单文件 try/catch 跳过 + `.filter(Boolean)`；目录不存在时外层 catch 返回 []（读操作不该有建目录的副作用，故选 catch 而非 src 的 ensureDir）
- 结构教训：getLatestSessionId 复用 listSessions 而不是自己再 readdir+parse 一遍——解析和容错写一次，排序决策独立出来
- ch18 预告：readFileState 判定策略（记/比/更新时机）由用户写，注意 ch17 的"parse 错对象"类 API 语义坑
