# S2：/brief 速览技能 + 自选股清单（技能面开张）

> stock 课程第二章。总纲见 `stock-00-plan.md` §四（P1 阶段）。
> 交付：产品内置技能层（skills-registry 增 product provider）+ `my_src/skills/brief/SKILL.md` + `get_watchlist` 工具 + `--profile stock` 补全 + mock 场景 34（stock 首个进快照体系的场景）。
> 验收线：cordis 203/203（+4）/ mock 29 场景全绿（+34）/ snapshot 29/29 ×2（ch34 新录）/ base 目录注入零变化。

---

## 1. 本章要解决的问题

S1 之后模型有行情工具，但用户说"看看我的自选股"时它不知道**哪些是你的自选股**、也不知道你想要什么格式。S2 把这件事变成一个技能：`/brief`——读自选股清单，出一页纸速览。

拆开是三个子问题：

1. **技能文件放哪？** 产品要随代码发货一个技能——现有两层（user=HOME、project=cwd）都不合适（§2.1）。
2. **自选股清单放哪、谁读？** 路径知识该在代码里还是提示词里（§2.2）。
3. **怎么进 mock/快照体系？** stock 面必须确定性（§2.3）。

## 2. 设计讲解

### 2.1 产品内置技能层（product provider，rank 5）

真 CC 有 built-in skills——产品自带的技能不依赖用户目录。mini 对齐这个分层：

```
product (5)  my_src/skills/        ← 本章新增，随产品发货
user    (10) ~/.claude/skills/     ← 用户自己的
project (20) <cwd>/.claude/skills/ ← 仓库提供的
```

同名高 rank 后写胜——**用户/项目可以覆盖产品技能**（改 /brief 的行为不用动产品代码）。

为什么不能放现有两层（三个候选方案的取舍，记档）：

| 方案 | 否决理由 |
|---|---|
| 仓库根 `.claude/skills/` | 真 CC 也读它（本会话的 harness 会被污染）；且 mock 的 cwd 是 my_src，扫不到 |
| `my_src/.claude/skills/` | mock 场景 cwd=my_src → **所有 28 个存量场景的目录注入都会多出 /brief** → 快照全爆 |
| `my_src/skills/` + profile 开关 ✅ | base 零感知；stock profile 经 `productSkills: true` 打开 |

productSkills 默认关——这是"base 目录注入不增行"的生命线（s2 测试钉住：默认关时 `getByName('brief') === null`）。

### 2.2 watchlist：路径归属代码，不归属提示词

清单路径 `~/.mini-claude/stocks/watchlist.txt`（HOME 沙箱、跨项目、与 sessions/memory 同区）。技能模板里写死路径有两个坑：`~` 不会被 read_file 展开、Windows/POSIX 路径形态不一。所以**路径知识进代码**——新增 `get_watchlist` 只读工具：

- 文件在：返回 `watchlist (N) — 绝对路径` + 代码行（含备注）
- 文件不在：返回创建指引（路径 + 格式样例 + "或直接 /brief 传参"）——模型转告用户即可，不会卡死
- 解析容错：`#` 后是备注、空行跳过、非法行丢弃不炸整份

清单格式一行一只：`sh600000  # 浦发银行`。人和模型都能写（write_file 直改）。

### 2.3 场景确定性：extraRows 换源

场景 34 的关键设计：`new Agent({ profile: "stock", extraRows: [market 行 config.source=MockQuoteSource] })`——extraRows 同 id 后写胜、赢过 profile 层，把行情源换成内存字面量。**网络零依赖 + 数据字面量 = 快照逐字节可重放**。这个模式就是 S3+ 每章的样板：真实插件 + mock 数据面。

### 2.4 stock profile 升级为工厂形态

skills 行的 `catalogInjection` 要跟宿主走（子 agent 不注入目录——D1 语义），而 profile 行是**整行替换**、不能只补一个字段。照 web profile 的先例改成 `(host) => Row[]` 工厂：有宿主时 `catalogInjection: !host.isSubAgent`，无宿主（--dump-config 预览）给 productSkills 常态。

## 3. 实现走查

| 文件 | 内容 |
|---|---|
| `my_src/skills.ts` | SkillDefinition.source 联合类型 +product；parseSkillFile 签名放宽 |
| `my_src/plugins/skills-registry.ts` | product provider（config.productSkills，rank 5，扫 `my_src/skills/`——编译后 dist/plugins 的 `../../skills`） |
| `my_src/skills/brief/SKILL.md` | 技能本体：frontmatter（inline、allowed-tools=[get_watchlist, get_quote]）+ 模板（$ARGUMENTS 优先、清单兜底、输出格式、**只报事实不给建议**的边界条款） |
| `my_src/plugins/market-data.ts` | watchlistPath / parseWatchlist 纯函数 + get_watchlist 工具 |
| `my_src/cordis.config.ts` | profiles.stock 工厂化：skills 行（productSkills）+ market 行 |
| `my_src/cordis-tests/s2-skills.test.ts` | 4 测试：product 开关 / user 盖 product（rank）/ 清单解析 / 工具两态 |
| `my_src/run-mock.mjs` | 场景 34 + stockProbe 分支 |

技能的边界条款值得记一笔：模板里明写"买卖判断、仓位建议一概不给——那是信号与裁决环节的职责"。**S2 的速览和 S6 的裁决之间用提示词先立了防火墙**，后面 S8 的代码风控是第二道。

## 4. 翻车记档

1. **parseWatchlist 自相矛盾**（测试抓获）：初版 `raw.replace(/#.*$/, "")` 先把 `#` 整段剥掉、再想从剩余部分取备注——备注本来就在 `#` 后面，永远取到空串。修：`#` 前是代码段、`#` 后是备注（无 `#` 时代码后余词也收作备注）。教训：**写"格式解析"前先用一条真实样例走一遍数据流**。
2. **frontmatter 剥尾换行**：断言 `promptTemplate === 'user version\n'` 红——parseFrontmatter 会去尾。小坑，但同款"凭想象写预期"的病，和上一条是同一个教训。
3. **技能放置方案的三连否决**（§2.1 表）：第三个方案（profile 开关）才同时满足"不污染真 CC / 不破坏存量快照 / 随产品发货"。设计层多画两张表，实现层少返工三轮。

## 5. 验证记录（终态）

| 线 | 结果 |
|---|---|
| cordis | **203/203**（199 + 本章 4） |
| mock | 29 场景全绿（28 + 场景 34） |
| snapshot | **29/29 × 2 轮**（ch34 新录：4 请求 + 1 会话文件） |
| base 零变化 | 场景 9 目录断言原样绿；s2 测试钉 productSkills 默认关 |
| dump-config | stock：skills 行 `{catalogInjection: true, productSkills: true}` + market 行 |

## 6. 代码执行流程图

### 6.1 装配（--profile stock）

```
buildRows({host, profile:'stock'})
  baseRows  [skills(disabled? 否，base 原行) ... market(disabled)]
  appRows   [skills ← {catalogInjection: !isSubAgent} ...]
  profile   (host) => [skills ← {catalogInjection, productSkills:true},
                       market  ← 启用]        ← 同 id 后写胜
  └─ loadRows → ctx.plugin(skillsPlugin, {productSkills:true})
        └─ registerProvider(product rank5 → my_src/skills)
                 + user(10) + project(20)     ← 三层进注册表
       ctx.plugin(marketDataPlugin) → get_watchlist/get_quote/screen_market
```

### 6.2 /brief 调用链（REPL 斜杠直调或 skill 工具）

```
用户: /brief            （或模型按目录自主调 skill 工具）
  └─ resolveSkillPrompt(brief, args="")
       模板 $ARGUMENTS←"" 
  └─ inline 注入主对话（tool_result 载模板正文）
       模型读模板 → 调 get_watchlist
         ├─ 文件在 → codes+备注
         └─ 文件不在 → 创建指引（转告用户）
  └─ 模型调 get_quote(codes) → 新浪明细（盘中秒级新鲜）
  └─ 模型按模板格式产出一页纸 + "快照口径数据，非投资建议"
```

### 6.3 完整时序走查（mock 场景 34）

```
setup: 沙箱写 ~/.mini-claude/stocks/watchlist.txt
       （sh600000 # 浦发银行 / sz300750 / not-a-code）
agent = Agent({profile:'stock',
               extraRows:[market ← MockQuoteSource(3 只字面量)]})
chat("Invoke the brief skill with no args.")
 req1  user+catalog(含 **/brief**) ──► 模型: skill{brief}
        tool_result: [Skill "brief" activated] + 模板正文
 req2  ──► 模型: get_watchlist{}
        tool_result: watchlist (2) — <沙箱路径>
                    sh600000  # 浦发银行
                    sz300750           （not-a-code 被丢弃）
 req3  ──► 模型: get_quote{codes:[sh600000,sz300750]}
        tool_result: 浦发银行 9.73 +0.93% …  [2026-10-16 15:00:00]
                    宁德时代 277.00 -0.54% … （mock 源，零网络）
 req4  ──► 模型: "brief delivered."
snapshot: 4 请求 + 会话文件逐字节锚定 ✓
```

## 7. 交付与 commit

- 建议 commit：`add product skill layer with brief skill and watchlist`
- 手测清单（用户终端，随时可测——休市口径）：
  1. `node dist/cli.js --profile stock` 进 REPL；
  2. 先建清单：让模型"帮我把浦发银行和宁德时代加进自选股"（它会 write_file 到 `~/.mini-claude/stocks/watchlist.txt`），或自己手写；
  3. 输入 `/brief`——期望一页纸速览 + 盘面速读 + 非投资建议收尾；
  4. 输入 `/brief sz300750,sh688981`——期望参数优先、跳过清单；
  5. 删掉清单文件再 `/brief`——期望返回创建指引而非报错。

## 8. 自测题

1. product 层为什么放 rank 5（低于 user）而不是 rank 30（高于 project）？如果把产品技能设为最高优先级，用户"关掉/改掉"一个产品技能还有哪些途径、各有什么代价？
2. §2.1 的三个放置方案里，`my_src/.claude/skills/` 方案会"快照全爆"——具体是哪个断言面炸掉？（提示：场景 9 的 firstUserText）
3. `get_watchlist` 不存在时返回"创建指引"而不是报错——这个设计的用户体验论据是什么？什么情况下"报错"反而是更好的选择？
4. stock profile 为什么必须用工厂形态而 full/no-auto 可以用行数组？（提示：整行替换 + catalogInjection 的宿主相关性）
5. 场景 34 用 extraRows 换掉数据源而不是给 market-data 加"mock 模式"配置项——两种做法的测试隔离性差异在哪？（提示：产品代码里有多少东西是"只为测试存在"的）
6. /brief 模板里"只报事实不给建议"的边界条款，到 S8 风控落地时是冗余还是防线？提示词层防火墙和代码层风控各拦什么？
