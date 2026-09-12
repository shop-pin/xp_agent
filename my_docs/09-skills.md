# 第九章：技能系统（skills.ts）

## 原理

技能 = **存成文件的 prompt 模板**，`/name` 一声调起来，像 shell 脚本。最小闭环：

```
发现：输入以 / 开头 → 解析出名字 → 精确查 .mini-skills/{name}.md
调用：resolveSkill(x) ?? x —— 是技能就用展开后的 prompt，不是就当普通消息
```

- **`resolveSkill` 返回 `null` 而非抛错/返回原文**是有意设计：回退策略（`?? input`）留给
  调用方，函数只管解析。cli.ts 两处接线（oneshot 分支 + REPL 分支）因此各只有一行。
- **参数约定**：`/commit fix the bug` 中 `fix the bug` 追加在 prompt 后（`\n\n` 分隔）。
  最小版不做 `$ARGUMENTS` 模板替换。
- `SKILL_DIR = .mini-skills`，与 `.mini-memory`、`.mini-session.json` 同风格。

**本章未实现的扩展**（教材后半段，选读）：frontmatter 元信息解析、`$ARGUMENTS` /
`${CLAUDE_SKILL_DIR}` 模板替换、**模型自动调用**（skill 工具——本质是元工具，返回值是
指令不是数据）、fork 子 agent 执行模式、user/project 双来源覆盖、token 预算控制。

## 思考题：frontmatter 局限

最小版把**整个文件内容**当 prompt——若技能文件带 frontmatter，`---\nname: commit\n---`
会被原样发给模型，元数据成了噪音。解法是 frontmatter 解析器（教材第 8 章扩展里的
`parseFrontmatter`）：meta 给"发现层"用（name/description/when_to_use），body 才是
prompt。第 8 章记忆文件和第 9 章技能文件都用 frontmatter——教材把它抽成共享模块
`frontmatter.ts` 正是这个原因。

## Review 记录

### 施工（2026-09-12）：三轮检视 + 一处代填，mock 5 项 ✓，回归 ch1–8 全绿

一次写对的：cli.ts 两处接线（`resolveSkill(oneshot) ?? oneshot`），`??` 空值合并用法无误。

过程问题：

1. **第一版方向反了**：`for (f of readdirSync(dir)) if (f.startsWith(input))` ——拿**整个
   输入串**（含斜杠含参数）当文件名前缀去扫目录，永远匹配不上。根因是跳过了"解析"这步
   概念：技能名要从输入里切出来（`slice(1).split(" ")`），然后**精确查找**，
   根本不需要遍历目录。
2. **第二版解析对了但收尾缺半截**：`rest` 解析出来后没使用——参数追加（规格第 5 步）缺失；
   无 `.trim()`；`readdirSync` 成了死导入。用户自己补了 trim，args 追加由我代填。
3. ENOENT 守卫（`existsSync(file)`）第二版已自己写对。

**值得记的模式**：`rest` 未使用这个"死代码信号"恰好标记了缺失的规格步骤——
解析出但没用上的变量，往往说明链条断在它手上。tsconfig 开 `noUnusedLocals`
能把这类信号提前变成编译错误。

### mock 场景设计（脚手架，run-mock.mjs "9"）

三个 run 驱动 CLI oneshot 模式：`/commit fix the login bug`（技能+参数）、
`/nosuchskill hello there`（未知技能透传）、`just a plain message`（非斜杠透传）。
断言五项：三次调用、**替换而非追加**（system 里含技能 prompt 且**不含** `/commit` 字样）、
参数在 prompt 尾部、两个透传负向保护。透传断言是防" resolveSkill 吞消息"回归的关键。

最终：`npm run mock -- 9` 5 项 ✓；回归 ch8/7/6/5/4/3/2/1 全过。第九章完成。
