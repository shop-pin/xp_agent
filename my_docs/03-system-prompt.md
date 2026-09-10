# 第 3 章：System Prompt 工程 — 告诉模型它是谁（学习笔记）

> 教材：docs/03-system-prompt.md

## 核心原理

System Prompt 是每次调模型前的第一段话，本章把它拆成**三块**，切分逻辑只有一个：
**按"变的频率"切**——为第 7 章的前缀缓存让路。

| 块 | 内容 | 变化频率 | 去哪 |
|----|------|---------|------|
| 静态核心 | 身份、规则、工具偏好、语气 | 所有会话逐字节不变 | system 参数（将来打 cache_control 的块） |
| 动态环境块 | cwd、平台、shell、git 状态 | 会话内稳定，因机器/项目而异 | system 参数，跟在静态块后 |
| CLAUDE.md + 日期 | 项目指令 + 今天几号 | 每个项目不同 | `<system-reminder>` 包起来注入**第一条 user 消息** |

为什么 CLAUDE.md 不放进 system：它因项目而异，放进 system 会污染静态前缀、破坏缓存命中；
包成 reminder 塞进对话流，既让模型看得见，又不碰缓存前缀。

## 文件规格（新建 prompt.ts）

### 1. STATIC_CORE 常量（纯模板，零插值）

身份行固定为 `You are Mini Claude Code, a small coding assistant CLI.`（验收断言找 "Mini Claude Code"）。
正文分四段（参考教材写英文）：

- `# Doing tasks`——**反模式接种**：三条"不要"（没读过不改、非必要不建文件、不过度工程）。
  负面指令比正面指令有效：正面说 "be concise" 模型会自我合理化，负面说 "don't..." 消除解释空间
- `# Executing actions with care`——**爆炸半径框架**：不穷举禁止清单，教可逆性×影响范围的
  二维判断（force push / 删表 = 不可逆+共享环境 → 先确认；编辑本地文件 = 可逆 → 直接做）
- `# Using your tools`——**工具偏好映射表**：read_file/edit_file/list_files/grep_search 代替
  shell 的 cat/sed/ls/grep。没有这张表，模型默认用训练数据里最常见的 bash 方式
- `# Tone and style`——简短、先给答案、引用代码用 file_path:line_number

### 2. 三个构建函数

- `buildSystemPrompt(): string` = STATIC_CORE + `"\n\n"` + buildDynamicSystemContext()
- `buildDynamicSystemContext(): string`：`# Environment` 段——Working directory（process.cwd()）、
  Platform（`${os.platform()} ${os.arch()}`）、Shell（Windows 取 `process.env.ComSpec || "cmd.exe"`，
  其他取 `process.env.SHELL || "/bin/sh"`），后面拼 getGitContext()
- `getGitContext(): string`：execSync 三条命令（`git rev-parse --abbrev-ref HEAD`、
  `git log --oneline -5`、`git status --short`），encoding utf-8、**timeout 3000**；
  整体 try/catch，任何失败返回 `""`（不在 git 仓库时静默跳过——环境事实收集器的通用模式：
  环境信息拿不到不算错误）

### 3. CLAUDE.md 加载（进阶，第三步做）

- `loadClaudeMd(): string`：从 cwd **向上遍历**目录树收集每层的 CLAUDE.md，
  `parts.unshift(content)`——越靠近 cwd 的越后拼入，利用近因效应让子目录覆盖父目录；
  每个 CLAUDE.md 都过一遍 resolveIncludes；最后拼 `.claude/rules/*.md`（readdirSync +
  filter .md + sort），每条规则前缀 `<!-- rule: 文件名 -->`，整体挂在 `## Rules` 标题下
- `resolveIncludes(content, basePath, visited, depth)`：`@` 开头独立行引用外部文件，
  三种路径（`@./` 相对当前 CLAUDE.md 所在目录、`@~/` home、`@/` 绝对）；
  防护：visited Set 防循环、深度上限 5、找不到留 `<!-- not found: ... -->` 不报错
- `buildUserContextReminder(): string`：`<system-reminder>` 包住 loadClaudeMd() +
  `# currentDate\nToday's date is ${new Date().toISOString().split("T")[0]}.`（**ISO 格式**，验收按这个找）

### 4. agent.ts 两处改动

1. `import { buildSystemPrompt, buildUserContextReminder } from "./prompt.js";`
   删掉写死的 `SYSTEM_PROMPT` 常量
2. `system: SYSTEM_PROMPT` → `system: buildSystemPrompt()`
3. 第一条 user 消息注入 reminder：push 前判断 `this.messages.length === 0`，
   是则 content 拼成 `${userText}\n\n${buildUserContextReminder()}`（只注入一次，后续轮次不带）

## 验收标准

`npm run mock -- 3` —— mock 这次会**抓请求本身**来断言（system、第一条 user 消息），
9 个 ✓ 全亮才算过：

- 静态核心在 system（找 "Mini Claude Code"）
- `# Environment` / Working directory / Platform / Shell 在 system
- **CLAUDE.md 内容不在 system**（放错位置立刻暴露）
- `<system-reminder>`、CLAUDE.md 内容、@include 解析出的规则内容、今天的日期 都在第一条 user 消息

沙箱里埋了 CLAUDE.md（引用 `./.claude/rules/test-rule.md`）和规则文件，
所以 @include 解析错了会直接 ✗。

## 分步施工指南（每步有检查点）

**第 1 步：静态核心先跑通**
- 新建 `prompt.ts`：STATIC_CORE 常量（照四段结构自己写）+ `buildSystemPrompt()`
  （动态块先返回空串）+ `export`
- agent.ts 三处：import、删 SYSTEM_PROMPT、system 行换掉
- **检查点**：`npm run mock -- 3` → 第 1 个 ✓，其余 ✗（正常）

**第 2 步：动态环境块**
- `getGitContext()` + `buildDynamicSystemContext()`，buildSystemPrompt 拼接两者
- **检查点**：`npm run mock -- 3` → 前 5 个 ✓（注意第 5 个是"NOT in system"，靠"还没写 CLAUDE.md 注入"意外先过，第 3 步后依然要保持）

**第 3 步：CLAUDE.md + @include + reminder 注入**
- `resolveIncludes` / `loadRulesDir` / `loadClaudeMd` / `buildUserContextReminder`
- agent.ts 第一条 user 消息注入
- **检查点**：9 个 ✓ 全亮

**第 4 步：回归**
- `npm run mock -- 2 && npm run mock` 不能坏 → 叫我 review

卡在 Node API（os 模块、正则、路径遍历）随时说，实现层我代填。

## Review 记录

### 第 1 步（2026-09-10）：一次通过

检查点符合预期：第 1 项 ✓、第 5 项预期性 ✓，其余 7 项待第 2/3 步。

- 问题 1（格式）：prompt.ts 开头两行空行、`export function` 前多余空格——无 lint 环境，整洁靠自己。
- 问题 2（措辞）：`git push` 与 `rm -rf` 并列进"破坏性动作"——普通 push 高频且可逆，按爆炸半径框架应属"直接做"，危险的其实是 force push。可选修正。
- 观察题：`buildSystemPrompt()` 在 while 循环内每轮重算。功能正确（system 每次请求都要带），但内容全会话不变，惯用做法是 `chat()` 开头算一次存变量；第 7 章前缀缓存时该位置意识很关键。

### 第 2 步（2026-09-10）：修复后通过前 5 项

用户自修对：嵌套 `${}`、反引号位置、git context 输出结构、`# Environment` / `Working directory` / `Platform` 格式。

Claude 代修三处（用户授权"直接帮我修改"）：
1. 三元缺 `: else` 分支（非 Windows 取 `SHELL || "/bin/sh"`）+ `Comspec` → `ComSpec`（env 键大小写敏感）。
2. 模板里 `\n` 后接了真实换行 + 缩进——模板字面量里**换行和空格都是字面内容**，会被打进输出串。
3. `encoding: "utf-8" as const`——**TS 字面量拓宽**：对象属性里的 `"utf-8"` 推断成 `string`，execSync 按 `BufferEncoding` 字面量类型区分重载，拓宽后三个重载都匹配失败；`as const` 保持字面量类型。此错误之前被行 41 的语法错误掩盖，语法修好后才浮出。

验证点：沙箱是非 git 目录，`fatal: not a git repository` stderr 被 try/catch 静默吞掉返回 ""——容错路径真实生效。

### 第 3 步（2026-09-10）：9 项全亮，通过

用户写对的关键点：`resolveIncludes` 的 replace+回调形态、递归时传新路径作 basePath（相对引用跟着被引用文件走）、遍历 unshift 顺序、`new Set([candidate])` 种子防自引用、agent.ts 注入用 `messages.length === 0` 判断。

review 发现的问题：
1. `REGEXP` 写成了反引号字符串——`replace` 收到字符串会按**字面子串**查找，永不匹配，函数静默变恒等变换。正则要用字面量（无引号）。
2. `StartWith` → `startsWith`（大小写敏感，同 `ComSpec` 一个坑）。
3. depth 检查放在了 replace 回调里并 `return content`——回调返回值替换的是**单个匹配行**，等于把整份文档塞进一个 @ 行（文档自我复制）。应放函数顶部，超深时整次调用原样返回。
4. rules 块（Claude 代修，用户授权）：`readFileSync` 因括号错位被拖出 `map` 回调；`(join(...), "utf-8")` 是**逗号表达式**（返回最后一个操作数）导致把 "utf-8" 当路径；`<! --` 注释格式坏；漏了 `parts.push("## Rules\n\n" + ...)` 落盘一步。

**测试盲区教训**：rules 自动扫描那条通路就算全坏，第 8 项断言也会 ✓——沙箱 CLAUDE.md 显式 `@` 引用了规则文件，marker 经 @include 通路照样进来。**测试绿 ≠ 功能对**，mock 测不到的分支靠人肉 review 补位。

### 第 4 步（2026-09-10）：回归通过

`npm run mock -- 2` ✓、`npm run mock`（第 1 章）正常。第三章完成。
