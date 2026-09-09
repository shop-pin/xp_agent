# 第 2 章：工具系统 — 给 Agent 装上手（学习笔记）

> 教材：docs/02-tools.md ｜ 最小参考实现：steps/canonical/ts/tools.ts

## 核心原理

一个工具 = 三样东西：**名字、给模型看的说明、真正干活的函数**。
前两样放进静态数组（格式就是发给 API 的 `tools` 参数，零转换），第三样是普通函数，
用 switch 按名字分发。

关键认知：**本章 agent.ts 一行都不用改**。第一章的循环（有 tool_use 就执行并喂回，
没有就停）是通用的——能力增长只发生在 tools.ts 的两个位置：

```
toolDefinitions 数组加一项   ← 模型才知道有这个工具
executeTool  switch 加一个 case ← 请求真的来了能接住
```

定义和执行各加一处，缺一不可：只加定义不加 case，模型调了会返回
`Unknown tool`；只加 case 不加定义，模型根本不知道可以调。

## 文件规格（tools.ts，5 个新工具）

### 1. write_file

- 入参 `file_path` + `content`，都必填
- **自动创建父目录**（dirname 不存在就 `mkdirSync recursive`），省得模型再发一条 shell 命令
- 返回成功信息，建议带行数（`(${n} lines)`），模型能自查写没写对

### 2. edit_file —— 本章唯一有坑的工具

- 入参 `file_path` + `old_string` + `new_string`，语义是精确字符串替换
- 三道检查，顺序有讲究：
  1. `old_string` 出现 **0 次** → 返回错误（模型对文件内容的记忆是幻觉，让它重读）
  2. 出现 **>1 次** → 返回错误（改错地方比失败更危险，逼模型给更多上下文）
  3. 恰好 1 次 → 替换并写回
- 坑：替换用 `split(old).join(new)`，别用 `String.replace`——
  `new_string` 里的 `$&`、`$1` 会被 replace 当替换模式展开
- "宁可失败也不猜测"是这里的设计哲学

### 3. list_files

- 入参 `pattern`（glob）+ 可选 `path`（默认 cwd）
- **必须忽略** `node_modules/**` 和 `.git/**`，否则结果全被噪音淹没
- 结果截断到 200 行，空结果返回明确文案（不要返回空字符串）

### 4. grep_search

- 入参 `pattern`（正则）+ 可选 `path`
- 优先调系统 grep：注意 `--line-number --color=never`（输出给模型看，不要 ANSI 颜色）
- **退出码 1 = 无匹配，不是错误**；2+ 才是 grep 自己出错
- 结果截断 100 条
- 系统 grep 不在（比如 Windows 上没装）→ 退回 JS 版：手动递归遍历目录逐行 `re.test`
  ——这个 fallback 在 Windows 上不是摆设，是真实路径

### 5. run_shell

- 入参 `command`
- `execSync` 带 timeout（30s）和 maxBuffer，防止单条命令卡死/撑爆整个循环
- 失败时**同时**返回 stdout 和 stderr（很多编译器 stdout 有部分产出）
- 成功但无输出（`mkdir`、`touch`）返回 `"(no output)"`，别让模型困惑
- 注意：我们的 shell 用 execSync 默认值即可（Windows 上是 cmd），**不要**照抄教材的
  `shell: "/bin/sh"`——那是给 macOS/Linux 的

### 通用约定（沿用第一章）

- 所有错误 catch 后**返回字符串**，不 throw —— 错误是数据，模型靠错误详情自我纠正
- 错误信息必须带 `e.message`（第一章教训：拼错成 `e.messages` 编译器不报）

## 选做进阶（本章有余力再做，不阻塞验收）

- `truncateResult`：结果 >50K 字符时**保留头尾**、砍中间（编译错误摘要、测试统计常在末尾），
  并在截断处插一行明确提示，让模型知道被截了、可以改用 grep/read 拿细节
- 引号容错：LLM tokenization 会把直引号变弯引号（`"` → `"`），edit_file 匹配前做归一化，
  替换时回写文件原始字符
- read-before-edit + mtime：executeTool 加一个 `Map<绝对路径, mtimeMs>`，
  改已存在的文件前必须先读过、mtime 变了报"外部修改"——防覆盖用户手动编辑（真 Claude Code 同款机制）

## 暂不做（后面章节再补）

web_fetch（本章教材末尾有雏形）、tool_search / deferred 延迟加载、skill、agent —— 工具多了才需要。

## 运行方式

- `npm run mock -- 2` —— 第二章验收：模型调 `write_file` 建 notes.txt，
  循环收尾后驱动脚本**直接读盘**验证文件内容真的写进去了（工具有没有副作用，看磁盘不看输出）
- `npm run mock`（或 `-- 1`）—— 第一章回归：改完 tools.ts 后确认没把 read_file 改坏

## 验收标准

`npm run mock -- 2` 输出三样齐全：

```
  → write_file({"file_path":"notes.txt","content":"remember-this"})
Created notes.txt.
  ✓ verified: notes.txt contains "remember-this"
```

第三行是关键：工具调用是真实的磁盘副作用，不是演给 mock 看的。

## Review 记录

### Review 第 1 轮 + 实现代填（2026-09-09）

用户写了 6 个定义 + read/write/edit 三个实现——设计层全对：edit_file 的 0/1/多次检查、
write_file 的 mkdir -p 都是按规格自己落地的。卡在 list/grep/shell 的 Node API 上，按要求代填。

#### 用户已写代码里的问题（review 价值在这）

| 位置（原文件） | 问题 | 教训 |
|------|------|------|
| 第 2 行 | `import { dirname } from "os"` | dirname 在 "path" 模块，os 里没有——tsc 会报 TS2305，编译器直接抓住 |
| editFile | `content.split(...).join(...)` 的返回值被丢弃，writeFileSync 没调 | 算了结果没写回，工具却返回 "success"——文件永远不变。这是合法的表达式语句，**编译器抓不到**，只能靠运行验证（和第一章"漏 await"同族） |
| writeFile/editFile | 没有 try/catch | 规格约定所有错误 catch 返回字符串，readFile 有，保持一致 |
| grep/run_shell 定义 | `properties` 空着 | 模型看不到参数 schema 就不知道该传什么，调了也拿不到 command/pattern |

#### 代填部分的讲解要点

- `listFiles`：`glob(pattern, { cwd, nodir: true, ignore: ["node_modules/**", ".git/**"] })`，
  nodir = 只要文件不要目录；结果截 200 行、空结果给明确文案
- `grepSearch`：`execFileSync("grep", [...])` 三个细节——`--color=never`（输出给模型，不要
  ANSI 颜色码）、`--` 分隔符（防 pattern 以 `-` 开头被当成选项）、**退出码 1 = 无匹配不是错误**；
  其他异常退回 `grepJS` 递归遍历（Windows 上系统 grep 可能不在 PATH，这条 fallback 是真实路径）
- `runShell`：`execSync` + `timeout: 30000` + `maxBuffer`；失败时 stdout/stderr 都拼回（编译器
  的 stdout 常有部分产出）；成功无输出返回 `"(no output)"`；没写 `shell: "/bin/sh"`（Windows 用默认 shell）
- 5 个 description 重写成完整英文句：description 是模型决定用不用、怎么用这个工具的**唯一依据**，
  "edit a file." 这种太弱，模型用不好

#### 运行结果（2026-09-09）

`npm run mock -- 2` 与 `npm run mock`（第一章回归）全过：

```
  ->write_file({"file_path":"notes.txt","content":"remember-this"})
Created notes.txt.
  ✓ verified: notes.txt contains "remember-this"
```

### 补全轮（2026-09-09 第二轮）：本章剩余机制 + description 校对

#### 新增三件（都是本章教材内容）

1. **web_fetch 工具**：`AbortController` 30 秒超时（防慢 URL 卡死整个循环）；HTML 先删
   script/style 再去标签 + 实体还原；50KB 上限。教材同款。mock 剧本没有网络场景，
   只能 `npm run live` 实测
2. **truncateResult（50K 保留头尾）**：executeTool 重构成 switch 赋值 + 统一出口
   `return truncateResult(result)`。为什么头尾都保：编译错误摘要、测试结果统计在**末尾**，
   只保头会丢最关键的信息；截断提示明说被截，模型可改用 grep/read 拿细节
3. **edit_file 引号容错**：`normalizeQuotes`（弯引号→直引号）+ `findActualString`。
   两个关键细节：匹配成功返回**文件里的原始子串**（不是标准化后的），替换保持文件原有字符
   风格；成功信息带 `(matched via quote normalization)` 让模型知道发生了什么

#### description 校对

| 原文 | 改为 | 原因 |
|------|------|------|
| read_file: "Read the content of a file." | "…Returns the file content with line numbers." | 模型要知道输出带行号——且行号不是文件内容，edit_file 匹配的是原始字符串 |
| write_file 参数 "the content to be wrote" | "The content to write" | 拼写错误 + 大小写混乱 |
| edit_file 参数 "old string to be edited" | "The exact string to find" | 原描述没传达"必须精确匹配且唯一"这个契约 |
| write/edit 参数 "the path to the file to be edited" | "The path to the file to edit" | 统一风格 |

原则：**description 是模型唯一的决策依据**——要写清楚行为（"Creates it if missing, overwrites if it exists"）和约束（"must match exactly and be unique"），一句话的工具描述模型用不好。

#### 直调验证（绕过 mock，直接调 executeTool）

| # | 场景 | 结果 |
|---|------|------|
| 1 | 弯引号 old_string 编辑直引号文件 | 成功 + "(matched via quote normalization)"，文件保持直引号 |
| 2 | old_string 出现 2 次 | 报错带次数，拒绝执行 |
| 3 | old_string 不存在 | 报 not found |
| 4 | run_shell 输出 60000 字符 | 截到 49975 + 截断标记 |
| 5 | 幻觉工具名 | `Unknown tool: no_such_tool`（错误是数据，模型可自我纠正） |

#### 仍未做（有明确归属）

- read-before-edit + mtime：需要 agent.ts 把 `readFileState: Map<绝对路径, mtimeMs>` 传进
  executeTool——动 agent.ts 时一起做（可在第 2.5 章 / 第 6 章前补）
- tool_search / deferred：没有 deferred 工具，机制空转，等第 10 章_plan mode_ 一起
- skill（第 9 章）、agent（第 11 章）
