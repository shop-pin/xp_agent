// Mock-model test driver: runs YOUR Agent against a scripted Anthropic API.
// No API key needed. Usage: npm run mock -- [chapter]   (compiles first, then runs)
//   npm run mock        → chapter 1
//   npm run mock -- 2   → chapter 2
//   npm run mock -- 3   → chapter 3 (asserts on the request the mock actually received)
import { startMock } from "../steps/mock-anthropic.mjs";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync, readdirSync, appendFileSync } from "fs";
import { createHash } from "crypto";
import { tmpdir } from "os";
import { join, dirname } from "path";
import { pathToFileURL, fileURLToPath } from "url";

const HERE = dirname(fileURLToPath(import.meta.url));
const chapter = process.argv[2] || "1";

const scenarios = {
  "1": {
    prompt: "Read the file greeting.txt and tell me what it says.",
    setup: (dir) => writeFileSync(join(dir, "greeting.txt"), "hello from step one."),
    turns: [
      { tools: [{ name: "read_file", input: { file_path: "greeting.txt" } }] },
      { text: "greeting.txt says: hello from step one." },
    ],
  },
  "2": {
    prompt: "Create a file notes.txt containing the text remember-this.",
    // ch19 迁移：新文件写落到 confirm；注入自动 yes 的 confirmFn，场景专注"工具真写了盘"
    autoConfirm: true,
    setup: () => {},
    turns: [
      {
        tools: [
          { name: "write_file", input: { file_path: "notes.txt", content: "remember-this" } },
        ],
      },
      { text: "Created notes.txt." },
    ],
    // chapter 2's real deliverable: the tool actually wrote the file to disk
    verify: (dir) => {
      const p = join(dir, "notes.txt");
      if (existsSync(p) && readFileSync(p, "utf-8").includes("remember-this")) {
        console.log('  ✓ verified: notes.txt contains "remember-this"');
      } else {
        console.log('  ✗ verified FAILED: notes.txt does not contain "remember-this"');
        process.exitCode = 1;
      }
    },
  },
  "7": {
    // chapter 7 → ch21 迁移：T4 auto-compact 沿用 aux-track 结构（旧 maybeCompact：
    // while 顶按消息条数摘要——已退役）。T4 在 turn 边界触发，门是
    // 0.85 × effectiveWindow（128000-20000 = 108000 → 91800）。单个 goal run 就有
    // 多条 user turn：pursueGoal 循环里每次 chat() 都是一个边界。
    // turn1（t0-t3）读完三个文件，末响应注入 usage input=100000（100500 > 91800）
    // → evaluator 判 NOT_MET 后，第二次 chat() 一进来就该触发摘要请求（compact
    // aux track），重写后的历史 = [summary, ack, feedback]。
    // turn1 恰好 3 条 read 结果：T2 的"保最近 3"严格静默（results.length <= 3），
    // 三个不同文件也不触发同文件去重——本场景只测 T4，不掺 T1/T2。
    needsLog: true,
    setup: (dir) => {
      writeFileSync(join(dir, "a.txt"), "alpha");
      writeFileSync(join(dir, "b.txt"), "beta");
      writeFileSync(join(dir, "c.txt"), "gamma");
    },
    runs: [{ argv: ["--goal", "a.txt, b.txt and c.txt have all been read", "Read a.txt, then b.txt, then c.txt."] }],
    tracks: {
      main: {
        turns: [
          { tools: [{ name: "read_file", input: { file_path: "a.txt" } }] },
          { tools: [{ name: "read_file", input: { file_path: "b.txt" } }] },
          { tools: [{ name: "read_file", input: { file_path: "c.txt" } }] },
          { text: "All three read: alpha, beta, gamma.", usage: { input_tokens: 100000, output_tokens: 500 } },
          { text: "All three files were read before the compaction happened." },
        ],
      },
      // contract anchor: agent.ts compactAnthropic 的 system 提示语，勿改两边
      compact: {
        match: "conversation summarizer",
        turns: [{ text: "Earlier: a.txt=alpha, b.txt=beta, c.txt=gamma." }],
      },
      // ch24 迁移：goal 评估器三态 JSON 契约（锚换 "evaluating a hook condition"）
      goal: {
        match: "evaluating a hook condition",
        turns: [
          { text: '{"ok": false, "reason": "the files have not been read yet."}' },
          { text: '{"ok": true, "reason": "transcript shows all three files read: alpha, beta, gamma."}' },
        ],
      },
    },
    verify: (dir, logPath) => {
      let ok = true;
      const check = (name, pass) => { console.log(`  ${pass ? "✓" : "✗"} ${name}`); if (!pass) ok = false; };
      const events = readFileSync(logPath, "utf-8").trim().split("\n").map((l) => JSON.parse(l));
      const reqs = events.filter((e) => e.type === "request");
      const mainReqs = reqs.filter((e) => e.track === "main");
      const compactReqs = reqs.filter((e) => e.track === "compact");
      check("5 main-loop model calls (4 in turn1 + 1 in turn2)", mainReqs.length === 5);
      check("aux summarize call went out at the turn-2 boundary, non-streamed",
        compactReqs.length === 1 && compactReqs[0]?.stream === false);
      check("summary request carries the full turn-1 history (8 msgs + summary instruction)",
        compactReqs[0]?.messageCount === 9);
      check("summary request carries real tool results (alpha..gamma, not a text transcript)",
        (compactReqs[0]?.toolResults || []).map((t) => t.content).join(" ").includes("alpha")
        && (compactReqs[0]?.toolResults || []).map((t) => t.content).join(" ").includes("gamma"));
      check("turn-2 history shrank to summary + ack + feedback (3 msgs)",
        mainReqs[4]?.messageCount === 3);
      check("summary text landed at history head",
        typeof mainReqs[4]?.firstUserText === "string"
        && mainReqs[4].firstUserText.includes("[Previous conversation summary]")
        && mainReqs[4].firstUserText.includes("a.txt=alpha"));
      if (!ok) process.exitCode = 1;
    },
  },
  "8": {
    // ch22 迁移：memory 重构为"4 类型 + 项目隔离 + 语义召回 + 异步 prefetch 注入"。
    // 旧机制（cwd 下 .mini-memory 关键词打分 → 注入 system）已退役：
    //   ① 记忆挪到 HOME 沙箱 ~/.mini-claude/projects/<sha256(cwd)前16>/memory/
    //     （项目隔离），setup 按运行时同款 hash 预置两条记忆
    //   ② 召回走 sideQuery selector（aux track：非流式 / temperature 0 / 256tok），
    //     JSON 契约 {"selected_memories": [...]}，≤5 条
    //   ③ 注入进最后一条 user 消息（<system-reminder> 包裹），不再进 system；
    //     system 里只留 Memory System 说明 + 索引（name/type/description）
    // t0 是工具轮：给 selector 留出确定的落定窗口——t0 请求发出时的 poll 必然
    // settled=false（回环 RTT >> 微任务间隔），t0 响应 + 工具执行的时间足够
    // selector 回来，t1 的 while 顶 poll 才稳定注入。t0 顺手让模型写一条新记忆，
    // 断言下一请求 system 里索引被自动重建（写时重建 MEMORY.md）。
    prompt: "Where should I deploy my changes to test them?",
    needsLog: true,
    autoConfirm: true,
    setup: (dir) => {
      writeFileSync(join(dir, "dummy.txt"), "just a file to read.");
      const hash = createHash("sha256").update(dir).digest("hex").slice(0, 16);
      const memDir = join(dir, ".mini-claude", "projects", hash, "memory");
      mkdirSync(memDir, { recursive: true });
      writeFileSync(join(memDir, "project_deploy.md"),
        `---\nname: Deploy target\ndescription: Where to deploy changes for testing\ntype: project\n---\nDeploy target: the staging server at staging.example.com. Deploy there to test changes.\n`);
      writeFileSync(join(memDir, "user_color.md"),
        `---\nname: Favorite color\ndescription: User's preferred color\ntype: user\n---\nThe user's favorite color is blue.\n`);
    },
    tracks: (dir) => {
      const hash = createHash("sha256").update(dir).digest("hex").slice(0, 16);
      const memDir = join(dir, ".mini-claude", "projects", hash, "memory");
      return {
        main: {
          turns: [
            {
              tools: [
                {
                  name: "write_file",
                  input: {
                    file_path: join(memDir, "user_editor.md"),
                    content: `---\nname: My favorite editor\ndescription: The editor the user prefers\ntype: user\n---\nThe user's favorite editor is Vim.\n`,
                  },
                },
                { name: "read_file", input: { file_path: "dummy.txt" } },
              ],
            },
            { text: "Deploy to staging.example.com for testing." },
          ],
        },
        memory: {
          match: "selecting memories",
          turns: [{ text: '{"selected_memories": ["project_deploy.md"]}' }],
        },
      };
    },
    verify: (dir, logPath) => {
      let ok = true;
      const check = (name, pass) => { console.log(`  ${pass ? "✓" : "✗"} ${name}`); if (!pass) ok = false; };
      const hash = createHash("sha256").update(dir).digest("hex").slice(0, 16);
      const memDir = join(dir, ".mini-claude", "projects", hash, "memory");
      const events = readFileSync(logPath, "utf-8").trim().split("\n").map((l) => JSON.parse(l));
      const reqs = events.filter((e) => e.type === "request");
      const mainReqs = reqs.filter((e) => e.track === "main");
      const memReqs = reqs.filter((e) => e.track === "memory");
      check("selector side call went out once (non-streaming, single user message)",
        memReqs.length === 1 && memReqs[0]?.stream === false && memReqs[0]?.messageCount === 1);
      check("selector got the manifest (query + both candidate memories)",
        memReqs[0]?.firstUserText.includes("Where should I deploy")
        && memReqs[0]?.firstUserText.includes("project_deploy.md")
        && memReqs[0]?.firstUserText.includes("user_color.md"));
      check("system keeps the memory section (no index yet — MEMORY.md is born on first write)",
        mainReqs[0]?.system.includes("# Memory System")
        && mainReqs[0]?.system.includes("No memories saved yet"));
      check("t0 request has no injection yet (prefetch still in flight)",
        !mainReqs[0]?.lastUserText.includes("Memory (saved today)"));
      check("selected memory injected into the last user message, not the system",
        !mainReqs[1]?.system.includes("staging.example.com")
        && mainReqs[1]?.lastUserText.includes("staging.example.com")
        && mainReqs[1]?.lastUserText.includes("<system-reminder>")
        && mainReqs[1]?.lastUserText.includes("Memory (saved today)"));
      check("unselected memory content never enters context",
        !mainReqs[1]?.lastUserText.includes("favorite color is blue")
        && !mainReqs[1]?.system.includes("favorite color is blue"));
      check("model-written memory file landed in the project memory dir",
        existsSync(join(memDir, "user_editor.md")));
      check("MEMORY.md auto-rebuilt: new entry + pre-existing memories show in next request's system",
        mainReqs[1]?.system.includes("My favorite editor")
        && mainReqs[1]?.system.includes("Deploy target"));
      let indexOnDisk = "";
      try { indexOnDisk = readFileSync(join(memDir, "MEMORY.md"), "utf-8"); } catch {}
      check("MEMORY.md on disk lists the new memory",
        indexOnDisk.includes("**[My favorite editor](user_editor.md)** (user)"));
      if (!ok) process.exitCode = 1;
    },
  },
  "9": {
    // chapter 9 → ch23 迁移：SKILL.md 新结构（.claude/skills/<name>/SKILL.md + frontmatter
    // + $ARGUMENTS 占位符）。模型经 skill 工具 inline 调用：executeSkill 解析模板，
    // tool_result 以 "[Skill activated]" 前缀注入主对话。CLI 的 /<name> 入口由 ch23b
    // 覆盖（对齐 src 后 one-shot 不再解析斜杠命令）。
    needsLog: true,
    setup: (dir) => {
      mkdirSync(join(dir, ".claude", "skills", "commit"), { recursive: true });
      writeFileSync(
        join(dir, ".claude", "skills", "commit", "SKILL.md"),
        "---\nname: commit\ndescription: Create a conventional commit message\n---\nWrite a conventional commit message for: $ARGUMENTS\n"
      );
    },
    prompt: "Invoke the commit skill with args: fix the login bug. Then invoke the nosuch skill.",
    turns: [
      { tools: [{ name: "skill", input: { skill_name: "commit", args: "fix the login bug" } }] },
      { tools: [{ name: "skill", input: { skill_name: "nosuch", args: "" } }] },
      { text: "Done." },
    ],
    verify: (dir, logPath) => {
      let ok = true;
      const check = (name, pass) => { console.log(`  ${pass ? "✓" : "✗"} ${name}`); if (!pass) ok = false; };
      const events = readFileSync(logPath, "utf-8").trim().split("\n").map((l) => JSON.parse(l));
      const reqs = events.filter((e) => e.type === "request");
      check("three model calls (two skill invocations + finish)", reqs.length === 3);
      check("skill tool returns the activated template",
        (reqs[1]?.toolResults || []).some((t) => t.content.includes('[Skill "commit" activated]')
          && t.content.includes("Write a conventional commit message")));
      check("$ARGUMENTS replaced with the args",
        (reqs[1]?.toolResults || []).some((t) => t.content.includes("for: fix the login bug")
          && !t.content.includes("$ARGUMENTS")));
      check("unknown skill reports Unknown skill",
        (reqs[2]?.toolResults || []).some((t) => t.content.includes("Unknown skill: nosuch")));
      if (!ok) process.exitCode = 1;
    },
  },
  "10": {
    // chapter 10 → ch25 迁移：plan 拦截仍是开场戏（阶段②只读契约，非 plan 文件
    // 一律拒），plan 模式里读文件照常放行（只读语义），之后模型经 tool_search
    // 激活 deferred 的 exit_plan_mode 并调用——one-shot 无 REPL 审批回调，走
    // fallback 直接退出恢复 default 模式，随后的 write 成功落盘。setup 预置
    // report.txt：覆盖已存在文件没有 confirm 候选，one-shot 没有 confirmFn 也
    // 不悬在 stdin；预置同时引来 ch18 read-before-write 门——所以恢复后先读再写。
    needsLog: true,
    setup: (dir) => writeFileSync(join(dir, "report.txt"), "old content"),
    runs: [{ argv: ["--plan", "Create a file report.txt with the plan."] }],
    turns: [
      { tools: [{ name: "write_file", input: { file_path: "report.txt", content: "the plan" } }] },
      { tools: [{ name: "read_file", input: { file_path: "report.txt" } }] },
      { tools: [{ name: "tool_search", input: { query: "plan" } }] },
      { tools: [{ name: "exit_plan_mode", input: {} }] },
      { tools: [{ name: "write_file", input: { file_path: "report.txt", content: "the plan" } }] },
      { text: "Plan mode exited, report.txt updated." },
    ],
    verify: (dir, logPath) => {
      let ok = true;
      const check = (name, pass) => { console.log(`  ${pass ? "✓" : "✗"} ${name}`); if (!pass) ok = false; };
      const events = readFileSync(logPath, "utf-8").trim().split("\n").map((l) => JSON.parse(l));
      const reqs = events.filter((e) => e.type === "request");
      check("6 model calls (deny -> read -> search -> exit -> write -> finish)", reqs.length === 6);
      check("the actual task reached the model", reqs[0]?.firstUserText.includes("Create a file report.txt"));
      const denial = (reqs[1]?.toolResults || []).map((t) => t.content).join(" ");
      check("tool_result says Denied", denial.includes("Denied"));
      check("denial names the mode (plan)", denial.includes("plan"));
      check("denial is not the file content", !denial.includes("the plan"));
      check("reads still allowed in plan mode",
        (reqs[2]?.toolResults || []).some((t) => t.content.includes("old content")));
      check("deferred plan tools hidden before tool_search",
        !reqs[2]?.tools.includes("exit_plan_mode") && !reqs[2]?.tools.includes("enter_plan_mode"));
      check("activated by tool_search by the 4th request", reqs[3]?.tools.includes("exit_plan_mode"));
      const exitRes = (reqs[4]?.toolResults || []).map((t) => t.content).join(" ");
      check("fallback exit (no approval fn in one-shot) restored default mode",
        exitRes.includes("Permission mode restored to: default"));
      check("write success fed back after restore",
        (reqs[5]?.toolResults || []).some((t) => t.content.includes("Successfully wrote")));
      check("report.txt overwritten after mode restore",
        existsSync(join(dir, "report.txt")) && readFileSync(join(dir, "report.txt"), "utf-8") === "the plan");
      if (!ok) process.exitCode = 1;
    },
  },
  "25": {
    // ch25 新场景：deferred 激活 + Plan Mode 三种审批去向。三个 run 直调 agent 层
    // （planApprovalFn 脚本化注入——runCli one-shot 不带 REPL 审批，fallback 路径
    // 由 ch10 迁移覆盖）。激活态是模块级全局：run1 tool_search 之后 enter/exit
    // 对后续 run 一直可见，run2/run3 无需再搜。
    // run1 execute：搜索 → enter → exit（审批 choice=execute）→ 模式落 acceptEdits
    //   → 新文件写免确认直接落盘。
    // run2 keep-planning：exit 被打回（feedback 回灌），模式**留在 plan**——
    //   后续 write 仍被拦是"留在 plan"的硬证据。
    // run3 clear-and-execute：审批清空历史，exit 结果以独立 user 消息重建上下文
    //   （首条消息带 CLAUDE.md reminder），断言 messageCount===1。
    // plan 文件路径含随机 sessionId，脚本化 write 够不着——写 plan 文件豁免
    // （checkPermission 全等放行分支）mock 测不到，靠 review + 真机冒烟兜底。
    needsLog: true,
    setup: () => {},
    runs: [
      { prompt: "Plan how to create report.txt, then do it.", planApproval: { choice: "execute" } },
      { prompt: "Plan the refactor.", planApproval: { choice: "keep-planning", feedback: "Add a verification step." } },
      { prompt: "Plan the migration.", planApproval: { choice: "clear-and-execute" } },
    ],
    tracks: {
      main: {
        turns: [
          // run1（t0-t4）
          { tools: [{ name: "tool_search", input: { query: "plan" } }] },
          { tools: [{ name: "enter_plan_mode", input: {} }] },
          { tools: [{ name: "exit_plan_mode", input: {} }] },
          { tools: [{ name: "write_file", input: { file_path: "report.txt", content: "the plan, executed" } }] },
          { text: "Plan approved and executed." },
          // run2（t5-t8）
          { tools: [{ name: "enter_plan_mode", input: {} }] },
          { tools: [{ name: "exit_plan_mode", input: {} }] },
          { tools: [{ name: "write_file", input: { file_path: "evil.txt", content: "should not land" } }] },
          { text: "Still in plan mode after the rejection." },
          // run3（t9-t12）
          { tools: [{ name: "enter_plan_mode", input: {} }] },
          { tools: [{ name: "exit_plan_mode", input: {} }] },
          { tools: [{ name: "write_file", input: { file_path: "fresh.txt", content: "fresh start" } }] },
          { text: "Fresh context, executing." },
        ],
      },
    },
    verify: (dir, logPath) => {
      let ok = true;
      const check = (name, pass) => { console.log(`  ${pass ? "✓" : "✗"} ${name}`); if (!pass) ok = false; };
      const events = readFileSync(logPath, "utf-8").trim().split("\n").map((l) => JSON.parse(l));
      const reqs = events.filter((e) => e.type === "request").filter((e) => e.track === "main");
      const tr = (i) => (reqs[i]?.toolResults || []).map((t) => t.content).join("\n");
      check("13 main-track requests (5 + 4 + 4)", reqs.length === 13);
      check("system lists the deferred tools before activation",
        reqs[0]?.system.includes("deferred tools are available via tool_search: enter_plan_mode, exit_plan_mode"));
      check("deferred plan tools hidden before tool_search (tool_search itself advertised)",
        !reqs[0]?.tools.includes("enter_plan_mode") && !reqs[0]?.tools.includes("exit_plan_mode")
        && reqs[0]?.tools.includes("tool_search"));
      check("tool_search returned the deferred schemas",
        tr(1).includes("enter_plan_mode") && tr(1).includes("input_schema"));
      check("deferred section gone + tools activated after tool_search",
        !reqs[1]?.system.includes("available via tool_search")
        && reqs[1]?.tools.includes("enter_plan_mode") && reqs[1]?.tools.includes("exit_plan_mode"));
      check("enter result announces read-only + plan file",
        tr(2).includes("Entered plan mode") && tr(2).includes("Your plan file"));
      check("execute approval switched to acceptEdits",
        tr(3).includes("User approved the plan") && tr(3).includes("acceptEdits"));
      check("report.txt written under acceptEdits (no confirm fn injected)",
        existsSync(join(dir, "report.txt")) && tr(4).includes("Successfully wrote"));
      check("keep-planning feedback looped back to the model",
        tr(7).includes("User rejected the plan") && tr(7).includes("User feedback: Add a verification step."));
      check("keep-planning left plan mode ON (evil.txt denied)",
        !existsSync(join(dir, "evil.txt")) && tr(8).includes("Blocked in plan mode"));
      check("clear-and-execute rebuilt context as a single user message",
        reqs[11]?.messageCount === 1 && reqs[11]?.firstUserText.includes("User approved the plan"));
      check("rebuilt first message carries the CLAUDE.md reminder",
        reqs[11]?.firstUserText.includes("<system-reminder>"));
      check("fresh.txt written after clear-and-execute (3-msg history by then)",
        existsSync(join(dir, "fresh.txt")) && reqs[12]?.messageCount === 3);
      if (!ok) process.exitCode = 1;
    },
  },
  "11": {
    // chapter 11 → ch23 迁移：fork-return 新架构。父 Agent new 一个子 Agent
    // （customSystemPrompt=EXPLORE_PROMPT、customTools=只读三件套、isSubAgent=true），
    // 子对话独立跑 loop，最终文本作为 tool_result 回父级。对齐 src 后子 agent 与
    // 主循环一样走流式；白名单只管 schema 广告（软约束），硬防线是权限层——
    // 旧版 "Denied: read-only" 执行拦截随 runSubAgent 退役。
    prompt: "Use an explore agent to find out what greeting.txt says.",
    needsLog: true,
    setup: (dir) => writeFileSync(join(dir, "greeting.txt"), "hello from the subagent demo."),
    tracks: {
      main: {
        turns: [
          { tools: [{ name: "agent", input: { description: "Read greeting", prompt: "Read greeting.txt and report its contents.", type: "explore" } }] },
          { text: "The sub-agent reports: hello from the subagent demo." },
        ],
      },
      sub: {
        match: "file search specialist",
        turns: [
          { tools: [{ name: "read_file", input: { file_path: "greeting.txt" } }] },
          { text: "greeting.txt says: hello from the subagent demo." },
        ],
      },
    },
    verify: (dir, logPath) => {
      let ok = true;
      const check = (name, pass) => { console.log(`  ${pass ? "✓" : "✗"} ${name}`); if (!pass) ok = false; };
      const events = readFileSync(logPath, "utf-8").trim().split("\n").map((l) => JSON.parse(l));
      const reqs = events.filter((e) => e.type === "request");
      const mainReqs = reqs.filter((e) => e.track === "main");
      const subReqs = reqs.filter((e) => e.track === "sub");
      check("2 main-loop calls (fork + continue)", mainReqs.length === 2);
      check("sub-agent ran its own 2-call loop", subReqs.length === 2);
      check("explore agent advertises read-only tools only",
        subReqs[0]?.tools.includes("read_file") && subReqs[0]?.tools.includes("list_files")
        && subReqs[0]?.tools.includes("grep_search")
        && !subReqs[0]?.tools.includes("write_file") && !subReqs[0]?.tools.includes("run_shell")
        && !subReqs[0]?.tools.includes("agent"));
      check("sub-agent context is fresh (1 message, not the main history)", subReqs[0]?.messageCount === 1);
      check("sub-agent runs on the explore system prompt",
        subReqs[0]?.system.includes("file search specialist"));
      check("both main and sub stream (aligned with src)",
        mainReqs[0]?.stream === true && subReqs[0]?.stream === true);
      check("sub-agent summary reached main as tool_result",
        (mainReqs[1]?.toolResults || []).some((t) => t.content.includes("hello from the subagent demo")));
      if (!ok) process.exitCode = 1;
    },
  },
  "12": {
    // chapter 12: a real MCP server subprocess (mcp-demo-server.mjs) provides
    // an `add` tool over stdio JSON-RPC. The agent must discover it, advertise
    // it as mcp__demo__add, route the model's call to the server, and feed the
    // result (42) back through the tool loop. Built-in tools stay in the list.
    // ch20 迁移：配置源从 MINI_MCP_SERVER env 迁到 .mcp.json（Manager 三处合并）
    prompt: "Use the add tool to compute 17 + 25.",
    needsLog: true,
    setup: (dir) => {
      writeFileSync(join(dir, ".mcp.json"), JSON.stringify({
        mcpServers: { demo: { command: "node", args: [join(HERE, "mcp-demo-server.mjs")] } },
      }, null, 2));
    },
    turns: [
      { tools: [{ name: "mcp__demo__add", input: { a: 17, b: 25 } }] },
      { text: "17 + 25 = 42." },
    ],
    verify: (dir, logPath) => {
      let ok = true;
      const check = (name, pass) => { console.log(`  ${pass ? "✓" : "✗"} ${name}`); if (!pass) ok = false; };
      const events = readFileSync(logPath, "utf-8").trim().split("\n").map((l) => JSON.parse(l));
      const reqs = events.filter((e) => e.type === "request");
      check("two model calls", reqs.length === 2);
      check("MCP tool advertised to the model", reqs[0]?.tools.includes("mcp__demo__add"));
      check("built-in tools still present alongside MCP", reqs[0]?.tools.includes("read_file"));
      check("MCP result (42) fed back as tool_result",
        (reqs[1]?.toolResults || []).some((t) => t.content.includes("42")));
      if (!ok) process.exitCode = 1;
    },
  },
  "15": {
    // chapter 15 → ch24 迁移：goal 评估器升三态 JSON 契约。系统提示换新
    // （锚 "evaluating a hook condition"），回复从 MET/NOT_MET 文本变为
    // {"ok":...} JSON；请求形状从单 user 消息变为角色分离三消息
    // （framing user / transcript assistant / judge user）——防注入的关键。
    // 语义变化：--goal 后的任务文本不再作为首轮（对齐 src：condition 即指令，
    // goalDirective 承载首轮）。run4 新增 impossible 停机：评估器判
    // {"ok":false,"impossible":true} 后 pursueGoal 直接停，无第二次评估。
    // auto 分类器（ch26 才换 transcript 双段版）保持 <block> 协议不变。
    needsLog: true,
    setup: () => {},
    runs: [
      { argv: ["--goal", "done.txt exists", "--accept-edits", "Create done.txt with ok."] },
      { argv: ["--auto", "Create secret.txt with credentials."] },
      { argv: ["--auto", "Create notes-auto.txt with hello."] },
      { argv: ["--goal", "the moon is made of cheese", "Try to prove the moon is cheese."] },
    ],
    tracks: {
      main: {
        turns: [
          { text: "Working on it." },
          { tools: [{ name: "write_file", input: { file_path: "done.txt", content: "ok" } }] },
          { text: "Created done.txt." },
          { tools: [{ name: "write_file", input: { file_path: "secret.txt", content: "creds" } }] },
          { text: "That write was blocked by the auto-mode monitor." },
          { tools: [{ name: "write_file", input: { file_path: "notes-auto.txt", content: "hello" } }] },
          { text: "Created notes-auto.txt." },
          { text: "The moon is not made of cheese — no evidence can ever change that." },
        ],
      },
      goal: {
        match: "evaluating a hook condition",
        turns: [
          { text: '{"ok": false, "reason": "done.txt has not been created yet."}' },
          { text: '{"ok": true, "reason": "transcript shows a write_file to done.txt succeeded."}' },
          { text: '{"ok": false, "impossible": true, "reason": "no transcript evidence could ever make the moon cheese."}' },
        ],
      },
      auto: {
        match: "security monitor",
        turns: [
          { text: "<block>yes</block> writing credential files is out of scope" },
          { text: "<block>no</block> harmless file creation" },
        ],
      },
    },
    verify: (dir, logPath) => {
      let ok = true;
      const check = (name, pass) => { console.log(`  ${pass ? "✓" : "✗"} ${name}`); if (!pass) ok = false; };
      check("goal run: done.txt actually created", existsSync(join(dir, "done.txt")));
      check("auto run: secret.txt NOT written (classifier blocked it)", !existsSync(join(dir, "secret.txt")));
      check("auto run: allow verdict lets notes-auto.txt through", existsSync(join(dir, "notes-auto.txt")));
      const events = readFileSync(logPath, "utf-8").trim().split("\n").map((l) => JSON.parse(l));
      const reqs = events.filter((e) => e.type === "request");
      const mainReqs = reqs.filter((e) => e.track === "main");
      const goalReqs = reqs.filter((e) => e.track === "goal");
      const autoReqs = reqs.filter((e) => e.track === "auto");
      check("8 main-loop calls (3 goal + 4 auto + 1 impossible-goal)", mainReqs.length === 8);
      check("3 evaluator calls (NOT_MET, MET, impossible)", goalReqs.length === 3);
      check("2 classifier calls (block then allow)", autoReqs.length === 2);
      check("evaluator is a side call: 3 role-separated messages, not streamed",
        goalReqs[0]?.messageCount === 3 && goalReqs[0]?.stream === false);
      check("framing user message marks the transcript as data (anti-smuggling)",
        typeof goalReqs[0]?.firstUserText === "string"
        && goalReqs[0].firstUserText.includes("The next message is the assistant transcript to evaluate"));
      check("judge question + condition ride in the final user message",
        typeof goalReqs[0]?.lastUserText === "string"
        && goalReqs[0].lastUserText.includes("stopping condition")
        && goalReqs[0].lastUserText.includes("done.txt exists"));
      check("reinjection grew history (1 -> 3 msgs by 2nd main call)",
        mainReqs[0]?.messageCount === 1 && mainReqs[1]?.messageCount === 3);
      check("write tool_result fed back before final eval (5 msgs)",
        mainReqs[2]?.messageCount === 5);
      check("impossible run: directive-only first turn (condition is the directive)",
        mainReqs[7]?.messageCount === 1
        && mainReqs[7]?.firstUserText.includes("the moon is made of cheese"));
      check("impossible verdict stopped the pursuit (no 4th evaluator call)",
        goalReqs.length === 3 && mainReqs.length === 8);
      check("classifier is a side call: single message, not streamed",
        autoReqs[0]?.messageCount === 1 && autoReqs[0]?.stream === false);
      check("classifier transcript includes what it judges (secret.txt)",
        typeof autoReqs[0]?.firstUserText === "string"
        && autoReqs[0].firstUserText.includes("secret.txt"));
      check("model saw 'Blocked' tool_result after the block",
        (mainReqs[4]?.toolResults || []).some((t) => t.content.includes("Blocked")));
      if (!ok) process.exitCode = 1;
    },
  },
  "6": {
    // chapter 6: the model tries a destructive command; the gate must stop it
    // BEFORE execution and report the denial back as a normal tool_result.
    // ch19 迁移：危险命令从 deny 升级为 confirm；--dont-ask（CI 语义）让 confirm
    // 候选自动转 deny，保持"拦截且不执行"的原断言不变
    runs: [{ argv: ["--dont-ask", "Delete everything in the demo folder with rm -rf."] }],
    needsLog: true,
    setup: (dir) => {
      mkdirSync(join(dir, "demo"));
      writeFileSync(join(dir, "demo", "precious.txt"), "do not lose me");
    },
    turns: [
      {
        text: "I'll remove it.",
        tools: [{ name: "run_shell", input: { command: "rm -rf demo" } }],
      },
      { text: "That was blocked by the permission system, so nothing was deleted." },
    ],
    verify: (dir, logPath) => {
      let ok = true;
      const check = (name, pass) => { console.log(`  ${pass ? "✓" : "✗"} ${name}`); if (!pass) ok = false; };
      check("nothing was deleted (precious.txt survives)", existsSync(join(dir, "demo", "precious.txt")));
      const events = readFileSync(logPath, "utf-8").trim().split("\n").map((l) => JSON.parse(l));
      const reqs = events.filter((e) => e.type === "request");
      check("two model calls (model saw the denial and recovered)", reqs.length === 2);
      const denial = (reqs[1]?.toolResults || []).map((t) => t.content).join(" ");
      check("tool_result back to the model says Denied", denial.includes("Denied"));
      check("denial is NOT raw shell output", !denial.includes("Command failed"));
      if (!ok) process.exitCode = 1;
    },
  },
  "5": {
    // chapter 5's deliverable: requests go out as streams (SSE), while the
    // final message shape stays identical so the tool loop is unbroken.
    prompt: "Read the file greeting.txt and tell me what it says.",
    needsLog: true,
    setup: (dir) => writeFileSync(join(dir, "greeting.txt"), "hello from step five."),
    turns: [
      { tools: [{ name: "read_file", input: { file_path: "greeting.txt" } }] },
      { text: "greeting.txt says: hello from step five." },
    ],
    verify: (dir, logPath) => {
      let ok = true;
      const check = (name, pass) => { console.log(`  ${pass ? "✓" : "✗"} ${name}`); if (!pass) ok = false; };
      const events = readFileSync(logPath, "utf-8").trim().split("\n").map((l) => JSON.parse(l));
      const reqs = events.filter((e) => e.type === "request");
      check("two model calls (tool loop still intact)", reqs.length === 2);
      check("request 1 was streamed", reqs[0]?.stream === true);
      check("request 2 was streamed", reqs[1]?.stream === true);
      check("finalMessage shape ok (tool_result sent back)", (reqs[1]?.toolResults || []).length === 1);
      if (!ok) process.exitCode = 1;
    },
  },
  "4": {
    // chapter 4 drives the CLI, not the Agent directly: run 1 saves a session,
    // run 2 must restore it via --resume and continue the same conversation.
    runs: [
      { argv: ["Remember that my favorite color is blue."] },
      { argv: ["--resume", "What is my favorite color?"] },
    ],
    needsLog: true,
    setup: () => {},
    turns: [
      { text: "Got it — your favorite color is blue." },
      { text: "Your favorite color is blue." },
    ],
    // ch17 迁移：session 落在 HOME 沙箱的 ~/.mini-claude/sessions/<id>.json，
    // 断言从"单文件+消息数组"升级为"目录+metadata+消息体"，并断言旧文件已消失
    verify: (dir, logPath) => {
      let ok = true;
      const check = (name, pass) => { console.log(`  ${pass ? "✓" : "✗"} ${name}`); if (!pass) ok = false; };
      check("old cwd .mini-session.json is gone", !existsSync(join(dir, ".mini-session.json")));
      const sessionsDir = join(dir, ".mini-claude", "sessions");
      let files = [];
      try { files = readdirSync(sessionsDir).filter((f) => f.endsWith(".json")); } catch {}
      check("two session files under HOME sandbox (one per run)", files.length === 2);
      // run2 留下的那份：2 restored + 1 new user + 1 new assistant = 4 条。
      // resume 坏了的话 run2 只会存 2 条新消息，找不到 messageCount===4 的文件。
      let run2 = null;
      for (const f of files) {
        try {
          const data = JSON.parse(readFileSync(join(sessionsDir, f), "utf-8"));
          if (data.metadata?.messageCount === 4) run2 = data;
        } catch {}
      }
      check("run2 session carries full metadata", !!run2
        && typeof run2.metadata?.id === "string"
        && typeof run2.metadata?.startTime === "string"
        && typeof run2.metadata?.model === "string"
        && run2.metadata?.cwd === dir);
      check("run2 session ends with 4 messages (2 restored + 2 new)",
        Array.isArray(run2?.anthropicMessages) && run2.anthropicMessages.length === 4);
      check("run2's first user msg is run 1's text",
        typeof run2?.anthropicMessages?.[0]?.content === "string"
        && run2.anthropicMessages[0].content.includes("Remember that my favorite color is blue."));
      const events = readFileSync(logPath, "utf-8").trim().split("\n").map((l) => JSON.parse(l));
      const reqs = events.filter((e) => e.type === "request");
      check("two model calls total (one per run)", reqs.length === 2);
      check("run 1 sent only its own message (1 msg)", reqs[0]?.messageCount === 1);
      check("run 2 restored the history (3 msgs, not 1)", reqs[1]?.messageCount === 3);
      check("run 2's request first msg is run 1's text", typeof reqs[1]?.firstUserText === "string"
        && reqs[1].firstUserText.includes("Remember that my favorite color is blue."));
      if (!ok) process.exitCode = 1;
    },
  },
  "3": {
    prompt: "Read the file greeting.txt and tell me what it says.",
    needsLog: true,
    setup: (dir) => {
      writeFileSync(join(dir, "greeting.txt"), "hello from step one.");
      writeFileSync(
        join(dir, "CLAUDE.md"),
        "Project marker: MINI-CLAUDE-MD-MARKER.\n@./.claude/rules/test-rule.md\n"
      );
      mkdirSync(join(dir, ".claude", "rules"), { recursive: true });
      writeFileSync(join(dir, ".claude", "rules", "test-rule.md"), "Rule marker: MINI-RULE-MARKER.\n");
    },
    turns: [
      { tools: [{ name: "read_file", input: { file_path: "greeting.txt" } }] },
      { text: "greeting.txt says: hello from step one." },
    ],
    // chapter 3's deliverable is prompt assembly — assert on the request itself
    verify: (dir, logPath) => {
      const events = readFileSync(logPath, "utf-8").trim().split("\n").map((l) => JSON.parse(l));
      const req = events.find((e) => e.type === "request");
      const today = new Date().toISOString().split("T")[0];
      const checks = [
        ["static core is in system", req.system.includes("Mini Claude Code")],
        ["# Environment block in system", req.system.includes("# Environment")],
        ["working directory in system", req.system.includes("Working directory: " + dir)],
        ["platform + shell in system", req.system.includes("Platform: ") && req.system.includes("Shell: ")],
        ["CLAUDE.md is NOT in system", !req.system.includes("MINI-CLAUDE-MD-MARKER")],
        ["<system-reminder> in first user msg", req.firstUserText.includes("<system-reminder>")],
        ["CLAUDE.md content in reminder", req.firstUserText.includes("MINI-CLAUDE-MD-MARKER")],
        ["@include resolved (rules loaded)", req.firstUserText.includes("MINI-RULE-MARKER")],
        ["today's date in reminder", req.firstUserText.includes("Today's date is " + today)],
      ];
      let ok = true;
      for (const [name, pass] of checks) {
        console.log(`  ${pass ? "✓" : "✗"} ${name}`);
        if (!pass) ok = false;
      }
      if (!ok) process.exitCode = 1;
    },
  },
  "18": {
    // chapter 18: read-before-edit。断言锚 = 请求日志里的 toolResults 文本 + 磁盘落盘内容。
    // 拦截文案的锚定为 "must read this file before editing"（与 src 一致）。
    // 六个工具打包进一个 assistant 回合：每回合只净增 2 条消息（峰值 4 < COMPACT_THRESHOLD 6），
    // 不会触发压缩；agent 顺序执行，同批内"先拦 → read 记录 → edit 成功 → 立即再 edit"的时序正好是本章语义。
    // 用户动手前 1、2 号断言红（未读编辑畅通无阻）；3 号防自伤是回归护栏（漏回写 mtime 时变红）。
    prompt: "Fix target.txt (alpha to beta, then unique body to edited body) and try to fix dup.txt.",
    needsLog: true,
    setup: (dir) => {
      writeFileSync(join(dir, "target.txt"), "alpha\nunique body\n");
      writeFileSync(join(dir, "dup.txt"), "same line\nsame line\n");
    },
    turns: [
      {
        tools: [
          // 1. 未读先 edit —— 期待被拦
          { name: "edit_file", input: { file_path: "target.txt", old_string: "alpha", new_string: "beta" } },
          // 2. read 记录 mtime
          { name: "read_file", input: { file_path: "target.txt" } },
          // 3. 同样的 edit —— 期待成功
          { name: "edit_file", input: { file_path: "target.txt", old_string: "alpha", new_string: "beta" } },
          // 4. 立即再 edit —— 漏了"写后回写"的话这里会误报 modified externally
          { name: "edit_file", input: { file_path: "target.txt", old_string: "unique body", new_string: "edited body" } },
          // 5. read dup（两行相同）
          { name: "read_file", input: { file_path: "dup.txt" } },
          // 6. 非唯一 old_string —— 期待报错且落盘不变
          { name: "edit_file", input: { file_path: "dup.txt", old_string: "same line", new_string: "x" } },
        ],
      },
      { text: "Done." },
    ],
    verify: (dir, logPath) => {
      let ok = true;
      const check = (name, pass) => { console.log(`  ${pass ? "✓" : "✗"} ${name}`); if (!pass) ok = false; };
      const events = readFileSync(logPath, "utf-8").trim().split("\n").map((l) => JSON.parse(l));
      const reqs = events.filter((e) => e.type === "request");
      // 第二个请求携带全部六个工具结果，按脚本顺序拼接
      const all = (reqs[1]?.toolResults || []).map((t) => t.content).join("\n");
      const successCount = (all.match(/Successfully edited target\.txt/g) || []).length;
      check("edit without read is blocked (must read first)", all.includes("must read this file before editing"));
      check("edit succeeds after read", successCount >= 1);
      check("immediate second edit NOT flagged as external modification (mtime written back)",
        successCount === 2 && !all.includes("modified externally"));
      check("non-unique old_string rejected", all.includes("found 2 times"));
      check("target.txt on disk shows both edits", readFileSync(join(dir, "target.txt"), "utf-8") === "beta\nedited body\n");
      check("dup.txt untouched by non-unique edit", readFileSync(join(dir, "dup.txt"), "utf-8") === "same line\nsame line\n");
      if (!ok) process.exitCode = 1;
    },
  },
  "20": {
    // chapter 20: Agent 骨架 I —— 双 server MCP、withRetry 重试、max-cost 截停，一场景三 run。
    // run 顺序有讲究：retry 必须排在 max-cost 之前。共享 main track 的轮次计数器
    // 不会"跳过"turn——run2 的检查点正确地不消费收尾 turn 时，那个 turn 会被
    // 下一个 run 捡走。把 failWith 轮放在 max-cost 轮之前，三个 run 的轮次区间
    // 就互不越界：run1 消费 t0-t1，run2 消费 t2-t4，run3 消费 t5-t6（t7 是截停断言）。
    // run1 双 server：.mcp.json 声明 demo + demo2（同一 server 脚本起两个进程），
    //   两个前缀都要广告，mcp__demo2__add 要路由到 demo2 的连接。
    // run2 重试：t2 注入 429；envSdkRetries=0 封 SDK 自带重试层，
    //   用户的 withRetry 接住后退避、重试、拿 t3/t4。
    // run3 max-cost：每轮 usage 压到 input=100000/out=500（每轮 $0.3075），
    //   --max-cost 0.5 → 第二轮响应后累计 $0.615 超限。检查点必须在"执行工具前"停：
    //   t7（预算超限后的收尾文本）永远不该被请求。
    needsLog: true,
    envSdkRetries: 0,
    setup: (dir) => {
      writeFileSync(join(dir, "greeting.txt"), "hello from step twenty.");
      writeFileSync(join(dir, ".mcp.json"), JSON.stringify({
        mcpServers: {
          demo: { command: "node", args: [join(HERE, "mcp-demo-server.mjs")] },
          demo2: { command: "node", args: [join(HERE, "mcp-demo-server.mjs")] },
        },
      }, null, 2));
    },
    runs: [
      { argv: ["Use the demo2 add tool to compute 20 + 22."] },
      { argv: ["Read greeting.txt and tell me what it says."] },
      { argv: ["--max-cost", "0.5", "Read greeting.txt twice, then tell me what it says."] },
    ],
    turns: [
      { tools: [{ name: "mcp__demo2__add", input: { a: 20, b: 22 } }] },
      { text: "20 + 22 = 42 (routed via demo2)." },
      { failWith: { status: 429 } },
      { tools: [{ name: "read_file", input: { file_path: "greeting.txt" } }] },
      { text: "recovered after retry." },
      { tools: [{ name: "read_file", input: { file_path: "greeting.txt" } }], usage: { input_tokens: 100000, output_tokens: 500 } },
      { tools: [{ name: "read_file", input: { file_path: "greeting.txt" } }], usage: { input_tokens: 100000, output_tokens: 500 } },
      { text: "never reached: budget must stop before this turn." },
    ],
    verify: (dir, logPath) => {
      let ok = true;
      const check = (name, pass) => { console.log(`  ${pass ? "✓" : "✗"} ${name}`); if (!pass) ok = false; };
      const events = readFileSync(logPath, "utf-8").trim().split("\n").map((l) => JSON.parse(l));
      const reqs = events.filter((e) => e.type === "request");
      const fails = events.filter((e) => e.type === "response" && e.failWith);
      const crashes = events.filter((e) => e.type === "run_crashed");
      const res = (i) => (reqs[i]?.toolResults || []).map((t) => t.content).join("\n");
      check("both MCP servers advertised (demo + demo2)",
        reqs[0]?.tools.includes("mcp__demo__add") && reqs[0]?.tools.includes("mcp__demo2__add"));
      check("call routed to demo2, result fed back", res(1).includes("42"));
      check("429 injected exactly once", fails.length === 1 && fails[0].failWith === 429);
      check("no run crashed (withRetry caught the 429)", crashes.length === 0);
      check("retry executed the read after backoff", res(4).includes("hello from step twenty"));
      check("max-cost stop: turn 7 never requested", !reqs.some((e) => e.turnIndex === 7));
      check("first read executed before the budget stop", res(6).includes("hello from step twenty"));
      check("7 main-track requests total (2 + 3 + 2)", reqs.length === 7);
      if (!ok) process.exitCode = 1;
    },
  },
  "19": {
    // chapter 19: permission rules. setup 写项目级 settings.json：
    //   deny  ["run_shell(rm *)"]        —— 阶段①在一切模式快捷方式之前，--yolo 也拦
    //   allow ["write_file(allowed.txt)"] —— allow 规则的核心价值：新文件写免确认直接落盘
    // 三 run 共享全局轮次：每 run 消费 2 turns（工具轮 + 文本轮）。
    // 红基线：1、2 号断言红（stub 全放行，rm 真执行了，tmp 被删）。
    needsLog: true,
    setup: (dir) => {
      mkdirSync(join(dir, ".claude"), { recursive: true });
      writeFileSync(join(dir, ".claude", "settings.json"), JSON.stringify({
        permissions: {
          deny: ["run_shell(rm *)"],
          allow: ["write_file(allowed.txt)"],
        },
      }, null, 2));
      mkdirSync(join(dir, "tmp"));
      writeFileSync(join(dir, "tmp", "keepme.txt"), "survive the rm");
    },
    runs: [
      { argv: ["--yolo", "Clean up the tmp folder with rm -rf."] },
      { argv: ["Clean up the tmp folder with rm -rf."] },
      { argv: ["Create allowed.txt with ok."] },
    ],
    turns: [
      { tools: [{ name: "run_shell", input: { command: "rm -rf tmp" } }] },
      { text: "Blocked even in yolo mode by a deny rule." },
      { tools: [{ name: "run_shell", input: { command: "rm -rf tmp" } }] },
      { text: "Blocked by the deny rule in default mode too." },
      { tools: [{ name: "write_file", input: { file_path: "allowed.txt", content: "ok" } }] },
      { text: "allowed.txt created via allow rule." },
    ],
    verify: (dir, logPath) => {
      let ok = true;
      const check = (name, pass) => { console.log(`  ${pass ? "✓" : "✗"} ${name}`); if (!pass) ok = false; };
      const events = readFileSync(logPath, "utf-8").trim().split("\n").map((l) => JSON.parse(l));
      const reqs = events.filter((e) => e.type === "request");
      // req[1] = run1 的工具结果（--yolo + rm）；req[3] = run2（默认 + rm）；req[5] = run3（写盘）
      const res = (i) => (reqs[i]?.toolResults || []).map((t) => t.content).join("\n");
      check("deny rule blocks rm even with --yolo", res(1).includes("permission rule"));
      check("deny rule blocks rm in default mode too", res(3).includes("permission rule"));
      check("tmp/keepme.txt survives both rm attempts", existsSync(join(dir, "tmp", "keepme.txt")));
      check("allow rule lets allowed.txt write through (no confirm needed)",
        res(5).includes("Successfully wrote") && existsSync(join(dir, "allowed.txt")));
      if (!ok) process.exitCode = 1;
    },
  },
  "21": {
    // chapter 21: T1 budget + T2 snip（大 usage 驱动）+ persistLargeResult。
    // 两 run 共享 main track，轮次区间互不越界（ch20 教训：条件性消费的 turn
    // 会泄漏给后续 run；本场景两 run 都无条件消费，排位仍按区间注释）。
    // run1（t0-t4）T1+T2：bigfile ~20K 读两次 + other/other2 两个小文件各一次。
    //   t0-t3 响应全部注入 usage input=100000（util = 100500/108000 ≈ 0.93 >
    //   0.75 热覆盖线——mock 请求间隔毫秒级缓存恒热，T2 只有越过 SNIP_HOT_OVERRIDE
    //   才肯动改写）。关键：T2 在 results.length <= KEEP_RECENT_RESULTS(3) 时
    //   提前 return——前 3 条结果期间同文件去重也不跑（src 语义）。所以必须凑到
    //   第 4 次读，t4 请求才同时触发"保 3 剪最老"和"同文件旧读去重"（都指向 r0）：
    //   t1 请求：T1 先跑 → r0 被 budget 化（T2 只有 1 条结果，不剪）
    //   t2 请求：r1 也被 budget 化；T2 仍只有 2 条，不剪
    //   t4 请求：r0 整条换成 placeholder；r1（同文件最新读）存活；小结果原样
    // run2（t5-t6）persist：huge ~45KB、1000 行（预览 200 行 << 全量——单行超长
    //   文件会把"预览"变"全文"，夹具必须多行）；usage 默认 → 压缩门全关，
    //   纯测 persist：>30KB 落盘 HOME 沙箱 tool-results/，上下文只剩预览。
    // T3 microcompact 在 mock 里无法自然触发（要求缓存冷 5 分钟），靠 review 兜底。
    needsLog: true,
    setup: (dir) => {
      writeFileSync(join(dir, "bigfile.txt"), "BIGDATA-0\n" + "x".repeat(20000));
      writeFileSync(join(dir, "other.txt"), "other-alpha-content");
      writeFileSync(join(dir, "other2.txt"), "other-beta-content");
      const lines = Array.from({ length: 1000 }, (_, i) => `HUGELINE-${String(i).padStart(4, "0")}-abcdefghijklmnopqrstuvwxyz`);
      writeFileSync(join(dir, "huge.txt"), lines.join("\n"));
    },
    runs: [
      { argv: ["Read bigfile.txt, then bigfile.txt again, then other.txt, then other2.txt, then tell me bigfile's first line."] },
      { argv: ["Read huge.txt and tell me its first line."] },
    ],
    tracks: {
      main: {
        turns: [
          { tools: [{ name: "read_file", input: { file_path: "bigfile.txt" } }], usage: { input_tokens: 100000, output_tokens: 500 } },
          { tools: [{ name: "read_file", input: { file_path: "bigfile.txt" } }], usage: { input_tokens: 100000, output_tokens: 500 } },
          { tools: [{ name: "read_file", input: { file_path: "other.txt" } }], usage: { input_tokens: 100000, output_tokens: 500 } },
          { tools: [{ name: "read_file", input: { file_path: "other2.txt" } }], usage: { input_tokens: 100000, output_tokens: 500 } },
          { text: "The first line of bigfile.txt is BIGDATA-0." },
          { tools: [{ name: "read_file", input: { file_path: "huge.txt" } }] },
          { text: "The first line of huge.txt is HUGELINE-0000." },
        ],
      },
    },
    verify: (dir, logPath) => {
      let ok = true;
      const check = (name, pass) => { console.log(`  ${pass ? "✓" : "✗"} ${name}`); if (!pass) ok = false; };
      const SNIP = "[Content snipped - re-read if needed]";
      const events = readFileSync(logPath, "utf-8").trim().split("\n").map((l) => JSON.parse(l));
      const reqs = events.filter((e) => e.type === "request").filter((e) => e.track === "main");
      const tr = (i) => (reqs[i]?.toolResults || []);
      check("run1: T1 budgeted the first big result already by the 2nd request",
        tr(1).length >= 1 && tr(1)[0].content.includes("[... budgeted:"));
      check("run1: both bigfile reads budgeted by the 3rd request (T1 runs every loop)",
        tr(2).length >= 2 && tr(2)[0].content.includes("[... budgeted:") && tr(2)[1].content.includes("[... budgeted:"));
      check("run1: T2 stayed silent while results <= KEEP_RECENT (3rd request intact)",
        tr(2).length >= 2 && tr(2).every((t) => t.content !== SNIP));
      check("run1: T2 snipped the stale same-file read at the 5th request",
        tr(4).length >= 4 && tr(4)[0].content === SNIP);
      check("run1: the latest same-file read survived (kept as recent)",
        tr(4)[1].content.includes("[... budgeted:"));
      check("run1: small fresh results stayed real content",
        tr(4)[2].content.includes("other-alpha") && tr(4)[3].content.includes("other-beta"));
      check("run2: context does NOT carry the full 45KB result",
        tr(6).length >= 1 && !tr(6)[0].content.includes("HUGELINE-0999"));
      check("run2: context carries the persisted preview instead",
        tr(6).length >= 1 && tr(6)[0].content.includes("[Result too large (")
        && tr(6)[0].content.includes("Preview (first 200 lines):")
        && tr(6)[0].content.includes("HUGELINE-0000"));
      let persisted = [];
      try {
        persisted = readdirSync(join(dir, ".mini-claude", "tool-results")).filter((f) => f.endsWith(".txt"));
      } catch {}
      check("run2: full output landed in HOME-sandbox tool-results/", persisted.length >= 1);
      if (persisted.length >= 1) {
        const saved = readFileSync(join(dir, ".mini-claude", "tool-results", persisted[0]), "utf-8");
        check("run2: saved file holds the FULL output (no loss, incl. the tail)",
          saved.includes("HUGELINE-0000") && saved.includes("HUGELINE-0999"));
      }
      if (!ok) process.exitCode = 1;
    },
  },
  "23": {
    // ch23 新场景：自定义 agent 类型。project 层 .claude/agents/researcher.md
    // （frontmatter name/description/allowed-tools，body=system prompt）→
    // getSubAgentConfig custom 优先 + 白名单过滤（toolDefinitions 里只留白名单工具）。
    // 注意 agent 工具 schema 的 type enum 只列内置三类型——自定义名靠宽容兜底，
    // schema enum 不含它们是 src 的已知粗糙点（见 my_docs/23 思考题）
    prompt: "Use a researcher agent to read docs.txt and report.",
    needsLog: true,
    setup: (dir) => {
      mkdirSync(join(dir, ".claude", "agents"), { recursive: true });
      writeFileSync(
        join(dir, ".claude", "agents", "researcher.md"),
        "---\nname: researcher\ndescription: Deep research assistant\nallowed-tools: read_file, grep_search\n---\nYou are a research specialist. Dig deep and cite sources.\n"
      );
    },
    tracks: {
      main: {
        turns: [
          { tools: [{ name: "agent", input: { description: "Read docs", prompt: "Read docs.txt and report.", type: "researcher" } }] },
          { text: "Researcher reports: docs.txt says hello." },
        ],
      },
      sub: {
        match: "research specialist",
        turns: [{ text: "docs.txt says hello." }],
      },
    },
    verify: (dir, logPath) => {
      let ok = true;
      const check = (name, pass) => { console.log(`  ${pass ? "✓" : "✗"} ${name}`); if (!pass) ok = false; };
      const events = readFileSync(logPath, "utf-8").trim().split("\n").map((l) => JSON.parse(l));
      const reqs = events.filter((e) => e.type === "request");
      const mainReqs = reqs.filter((e) => e.track === "main");
      const subReqs = reqs.filter((e) => e.track === "sub");
      check("2 main-loop calls (fork + continue)", mainReqs.length === 2);
      check("custom agent ran on its own loop", subReqs.length === 1);
      check("custom body became the sub-agent system prompt (not a built-in prompt)",
        subReqs[0]?.system.includes("research specialist")
        && !subReqs[0]?.system.includes("file search specialist"));
      check("allowed-tools whitelist enforced (exactly read_file + grep_search)",
        subReqs[0]?.tools.includes("read_file") && subReqs[0]?.tools.includes("grep_search")
        && subReqs[0]?.tools.length === 2);
      check("sub-agent context is fresh", subReqs[0]?.messageCount === 1);
      check("custom agent report reached main as tool_result",
        (mainReqs[1]?.toolResults || []).some((t) => t.content.includes("docs.txt says hello")));
      if (!ok) process.exitCode = 1;
    },
  },
  "23b": {
    // ch23 新场景：skill 的 fork 模式。context: fork 的 SKILL.md → executeSkillTool
    // 派发隔离子 agent（system=解析后模板含 $ARGUMENTS 替换，tools=allowed-tools 白名单
    // 过滤父工具集）。inline 路径由 ch9 覆盖；CLI 的 /<name> 斜杠入口走 REPL（mock
    // 驱动只测 agent 层），靠真机冒烟验证。
    prompt: "Invoke the heavytask skill with args: audit the repo.",
    needsLog: true,
    setup: (dir) => {
      mkdirSync(join(dir, ".claude", "skills", "heavytask"), { recursive: true });
      writeFileSync(
        join(dir, ".claude", "skills", "heavytask", "SKILL.md"),
        "---\nname: heavytask\ndescription: Run a heavy audit\ncontext: fork\nallowed-tools: read_file, grep_search\n---\nAudit task: $ARGUMENTS. Report findings concisely.\n"
      );
    },
    tracks: {
      main: {
        turns: [
          { tools: [{ name: "skill", input: { skill_name: "heavytask", args: "audit the repo" } }] },
          { text: "Audit complete: no issues found." },
        ],
      },
      fork: {
        match: "Audit task",
        turns: [{ text: "Findings: everything looks fine." }],
      },
    },
    verify: (dir, logPath) => {
      let ok = true;
      const check = (name, pass) => { console.log(`  ${pass ? "✓" : "✗"} ${name}`); if (!pass) ok = false; };
      const events = readFileSync(logPath, "utf-8").trim().split("\n").map((l) => JSON.parse(l));
      const reqs = events.filter((e) => e.type === "request");
      const mainReqs = reqs.filter((e) => e.track === "main");
      const forkReqs = reqs.filter((e) => e.track === "fork");
      check("2 main-loop calls (fork + continue)", mainReqs.length === 2);
      check("fork skill ran in an isolated sub-agent", forkReqs.length === 1);
      check("resolved template became the fork system prompt ($ARGUMENTS substituted)",
        forkReqs[0]?.system.includes("Audit task: audit the repo")
        && !forkReqs[0]?.system.includes("$ARGUMENTS"));
      check("fork tools limited to the skill whitelist",
        forkReqs[0]?.tools.includes("read_file") && forkReqs[0]?.tools.includes("grep_search")
        && forkReqs[0]?.tools.length === 2);
      check("fork result returned to main as tool_result",
        (mainReqs[1]?.toolResults || []).some((t) => t.content.includes("everything looks fine")));
      if (!ok) process.exitCode = 1;
    },
  },
  "24": {
    // ch24 新场景：/loop 两模式，三个 run 直调 agent.runLoop（/loop 是 REPL 命令，
    // 对齐 src 后 one-shot 不解析斜杠命令，mock 只能驱动 agent 层）。
    // run1 interval（"1s report the clock"）：前导 token 是间隔 → 剥掉后跑 prompt，
    //   2 tick 后 --max-turns 上限停（tick 序列断言靠"run2 的首个请求不含 clock"）。
    // run2 dynamic：模型调 schedule_wakeup（delaySeconds 5 → clamp 到 60），
    //   工具结果回显 "Wakeup scheduled in 60s"；随后 60s 睡眠被驱动器 400ms 时的
    //   stopLoop 提前打断（interruptibleSleep 语义）——没有第二个 tick。
    // run3 dynamic 收敛：模型不调 schedule_wakeup → "converged after 1 tick"。
    // schedule_wakeup 广告门控：interval run 不广告；dynamic run（含 tick1）广告。
    needsLog: true,
    setup: () => {},
    runs: [
      { loop: "1s report the clock", maxTurns: 2 },
      { loop: "check the deploy", stopLoopAfterMs: 400 },
      { loop: "check the window" },
    ],
    tracks: {
      main: {
        turns: [
          { text: "tick 1: clock reported." },
          { text: "tick 2: clock reported again." },
          { tools: [{ name: "schedule_wakeup", input: { delaySeconds: 5, reason: "wait for rollout", prompt: "check the deploy again" } }] },
          { text: "deploy check done; wakeup scheduled." },
          { text: "window checked; nothing to schedule." },
        ],
      },
    },
    verify: (dir, logPath) => {
      let ok = true;
      const check = (name, pass) => { console.log(`  ${pass ? "✓" : "✗"} ${name}`); if (!pass) ok = false; };
      const events = readFileSync(logPath, "utf-8").trim().split("\n").map((l) => JSON.parse(l));
      const reqs = events.filter((e) => e.type === "request").filter((e) => e.track === "main");
      const firstText = (i) => (typeof reqs[i]?.firstUserText === "string" ? reqs[i].firstUserText : "");
      const tr = (i) => (reqs[i]?.toolResults || []).map((t) => t.content).join("\n");
      check("5 main-track requests total (2 + 2 + 1)", reqs.length === 5);
      check("run1 interval: leading 1s token stripped, prompt passed through",
        firstText(0).includes("report the clock") && !firstText(0).includes("1s "));
      check("run1 interval: schedule_wakeup NOT advertised",
        !reqs[0]?.tools.includes("schedule_wakeup"));
      check("run1 stopped at the 2-tick limit (3rd request belongs to run2)",
        firstText(2).includes("check the deploy"));
      check("run2 dynamic: schedule_wakeup advertised during the loop",
        reqs[2]?.tools.includes("schedule_wakeup"));
      check("run2: wakeup tool_result echoes the clamped delay (5s -> 60s)",
        tr(3).includes("Wakeup scheduled in 60s"));
      check("run2: interrupted sleep prevented tick 2 (4th request belongs to run3)",
        firstText(4).includes("check the window"));
      check("run3 converged: dynamic mode still advertises schedule_wakeup on its tick",
        reqs[4]?.tools.includes("schedule_wakeup"));
      if (!ok) process.exitCode = 1;
    },
  },
};

const s = scenarios[chapter];
if (!s) {
  console.error(`Unknown chapter: ${chapter} (available: ${Object.keys(scenarios).join(", ")})`);
  process.exit(1);
}

const workdir = mkdtempSync(join(tmpdir(), `my-ch${chapter}-`));
s.setup(workdir);

const logPath = s.needsLog ? join(tmpdir(), `my-ch${chapter}-log-${process.pid}.jsonl`) : undefined;
// tracks 支持函数形式 (dir) => tracks——ch22 记忆目录含 sha256(cwd) 动态段，
// 脚本化的 write_file 路径必须等 workdir 生成后才能算出来
const tracks = typeof s.tracks === "function" ? s.tracks(workdir) : s.tracks;
const scenario = tracks
  ? { id: `ch${chapter}`, tracks }
  : { id: `ch${chapter}`, turns: s.turns };
const mock = await startMock({ scenario, logPath });
process.env.ANTHROPIC_BASE_URL = mock.url;
process.env.ANTHROPIC_API_KEY = "test";
// ch17 HOME 沙箱：~/.mini-claude/... 必须落进临时目录。
// Windows 的 homedir() 读 USERPROFILE，POSIX 读 HOME——两个都设（homedir 实测不缓存）。
// 必须在动态 import dist/cli.js 之前设置。
process.env.HOME = workdir;
process.env.USERPROFILE = workdir;
// ch20：封 SDK 自带重试层（默认 2），否则它先吞掉注入的 429，withRetry 永远等不到失败。
// 必须在动态 import dist 之前设置（Agent 构造时读取）
if (s.envSdkRetries !== undefined) process.env.MINI_CLAUDE_SDK_MAX_RETRIES = String(s.envSdkRetries);
process.chdir(workdir);

console.log(`▶ mock model at ${mock.url}   sandbox: ${workdir}   chapter: ${chapter}`);

if (s.runs) {
  // CLI chapters: drive runCli(argv) once per run, in-process.
  // 单 run crash（如 ch20 红基线里 stub 放行 429）不中断后续 verify——
  // 记进日志让断言看到；crash 后 MCP 子进程可能悬着，最后显式退进程
  const mod = await import(pathToFileURL(join(HERE, "dist", "cli.js")).href);
  let crashed = false;
  for (const r of s.runs) {
    const label = r.argv ? r.argv.join(" ") : r.loop !== undefined ? `(loop) ${r.loop}` : r.prompt;
    console.log(`  you: ${label}\n`);
    try {
      if (r.loop !== undefined) {
        // ch24：/loop 是 REPL 命令（对齐 src 后 one-shot 不解析斜杠命令），
        // mock 直接驱动 agent 层。stopLoopAfterMs 模拟 Ctrl+C 中断——
        // dynamic 唤醒延迟钳到 60s 起，真等不现实，靠 loopStop 提前退出睡眠
        const agentMod = await import(pathToFileURL(join(HERE, "dist", "agent.js")).href);
        const a = new agentMod.Agent();
        if (r.maxTurns) a.setMaxTurns(r.maxTurns);
        if (r.stopLoopAfterMs) setTimeout(() => a.stopLoop(), r.stopLoopAfterMs);
        await a.runLoop(r.loop);
        if (a.close) await a.close();
      } else if (r.planApproval !== undefined) {
        // ch25：审批回调脚本化注入（one-shot 无 REPL）。confirmFn 注入"自动否"——
        // 若模式切换逻辑坏了，走 confirm 路径会干净失败而不是悬在 stdin
        const agentMod = await import(pathToFileURL(join(HERE, "dist", "agent.js")).href);
        const a = new agentMod.Agent();
        a.setConfirmFn(async () => false);
        a.setPlanApprovalFn(async () => r.planApproval);
        await a.chat(r.prompt);
        if (a.close) await a.close();
      } else {
        await mod.runCli(r.argv);
      }
    } catch (e) {
      console.log(`  run crashed: ${e?.message ?? e}`);
      crashed = true;
      if (logPath) appendFileSync(logPath, JSON.stringify({ type: "run_crashed", error: String(e?.message ?? e) }) + "\n");
    }
    console.log();
  }
  await mock.close();
  if (s.verify) s.verify(workdir, logPath);
  if (crashed) process.exit(process.exitCode ?? 0);
} else {
  console.log(`  you: ${s.prompt}\n`);
  const mod = await import(pathToFileURL(join(HERE, "dist", "agent.js")).href);
  const agent = new mod.Agent();
  if (s.autoConfirm) agent.setConfirmFn(async () => true);
  await agent.chat(s.prompt);
  if (agent.close) await agent.close(); // kill the MCP children so the event loop can drain
  await mock.close();
  if (s.verify) s.verify(workdir, logPath);
}
