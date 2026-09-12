// Mock-model test driver: runs YOUR Agent against a scripted Anthropic API.
// No API key needed. Usage: npm run mock -- [chapter]   (compiles first, then runs)
//   npm run mock        → chapter 1
//   npm run mock -- 2   → chapter 2
//   npm run mock -- 3   → chapter 3 (asserts on the request the mock actually received)
import { startMock } from "../steps/mock-anthropic.mjs";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync } from "fs";
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
    // chapter 7: read 3 files (4 main-loop requests) — by the final request the
    // history exceeds the threshold, an aux summarize call fires, and the last
    // request must carry [summary, ...recent] instead of the full history.
    prompt: "Read a.txt, then b.txt, then c.txt, then summarize.",
    needsLog: true,
    setup: (dir) => {
      writeFileSync(join(dir, "a.txt"), "alpha");
      writeFileSync(join(dir, "b.txt"), "beta");
      writeFileSync(join(dir, "c.txt"), "gamma");
    },
    tracks: {
      main: {
        turns: [
          { tools: [{ name: "read_file", input: { file_path: "a.txt" } }] },
          { tools: [{ name: "read_file", input: { file_path: "b.txt" } }] },
          { tools: [{ name: "read_file", input: { file_path: "c.txt" } }] },
          { text: "All three read: alpha, beta, gamma." },
        ],
      },
      // the aux summarize call is recognized by its system prompt
      compact: {
        match: "Summarize the conversation",
        turns: [{ text: "Earlier: a.txt=alpha, b.txt=beta, c.txt=gamma." }],
      },
    },
    verify: (dir, logPath) => {
      let ok = true;
      const check = (name, pass) => { console.log(`  ${pass ? "✓" : "✗"} ${name}`); if (!pass) ok = false; };
      const events = readFileSync(logPath, "utf-8").trim().split("\n").map((l) => JSON.parse(l));
      const reqs = events.filter((e) => e.type === "request");
      const mainReqs = reqs.filter((e) => e.track === "main");
      const compactReqs = reqs.filter((e) => e.track === "compact");
      check("4 main-loop model calls", mainReqs.length === 4);
      check("aux summarize call went out", compactReqs.length === 1);
      check("transcript is plain text (tool pairs rendered, not split)",
        typeof compactReqs[0]?.firstUserText === "string"
        && compactReqs[0].firstUserText.includes("[tool call / result]")
        && compactReqs[0].firstUserText.includes("user: "));
      check("history shrank to summary + recent (3 msgs, was 7)", mainReqs[3]?.messageCount === 3);
      check("summary from aux call landed at history head",
        typeof mainReqs[3]?.firstUserText === "string"
        && mainReqs[3].firstUserText.includes("[Summary of earlier conversation]")
        && mainReqs[3].firstUserText.includes("a.txt=alpha"));
      if (!ok) process.exitCode = 1;
    },
  },
  "8": {
    // chapter 8: a memory dir on disk holds two files; the user asks about
    // deployment. recallMemories() must score the deploy memory above zero and
    // inject it into the SYSTEM prompt — while the irrelevant one stays out.
    prompt: "Where should I deploy my changes to test them?",
    needsLog: true,
    setup: (dir) => {
      mkdirSync(join(dir, ".mini-memory"));
      writeFileSync(
        join(dir, ".mini-memory", "deploy.md"),
        "Deploy target: the staging server at staging.example.com. Deploy there to test changes.\n"
      );
      writeFileSync(
        join(dir, ".mini-memory", "color.md"),
        "The user's favorite color is blue.\n"
      );
    },
    turns: [{ text: "Deploy to staging.example.com." }],
    verify: (dir, logPath) => {
      let ok = true;
      const check = (name, pass) => { console.log(`  ${pass ? "✓" : "✗"} ${name}`); if (!pass) ok = false; };
      const events = readFileSync(logPath, "utf-8").trim().split("\n").map((l) => JSON.parse(l));
      const reqs = events.filter((e) => e.type === "request");
      check("one model call", reqs.length === 1);
      check("relevant memory recalled into system", reqs[0]?.system.includes("staging.example.com"));
      check("memory section header present", reqs[0]?.system.includes("# Memory"));
      check("irrelevant memory filtered out", !reqs[0]?.system.includes("favorite color"));
      check("recall lands in system, not the user message",
        !reqs[0]?.firstUserText.includes("staging.example.com"));
      if (!ok) process.exitCode = 1;
    },
  },
  "9": {
    // chapter 9: a skill file in .mini-skills/. "/commit <args>" resolves to the
    // file's prompt with args appended; an unknown /name falls through as a
    // plain message; a non-slash message is untouched.
    needsLog: true,
    setup: (dir) => {
      mkdirSync(join(dir, ".mini-skills"));
      writeFileSync(
        join(dir, ".mini-skills", "commit.md"),
        "Write a conventional commit message for the current diff.\n"
      );
    },
    runs: [
      { argv: ["/commit fix the login bug"] },
      { argv: ["/nosuchskill hello there"] },
      { argv: ["just a plain message"] },
    ],
    turns: [
      { text: "feat: fix the login bug" },
      { text: "I don't know that skill." },
      { text: "Plain message received." },
    ],
    verify: (dir, logPath) => {
      let ok = true;
      const check = (name, pass) => { console.log(`  ${pass ? "✓" : "✗"} ${name}`); if (!pass) ok = false; };
      const events = readFileSync(logPath, "utf-8").trim().split("\n").map((l) => JSON.parse(l));
      const reqs = events.filter((e) => e.type === "request");
      check("three model calls (one per run)", reqs.length === 3);
      check("skill prompt replaces the /command",
        reqs[0]?.firstUserText.includes("Write a conventional commit message")
        && !reqs[0]?.firstUserText.includes("/commit"));
      check("args appended to skill prompt", reqs[0]?.firstUserText.includes("fix the login bug"));
      check("unknown /name passes through as plain text",
        reqs[1]?.firstUserText.includes("/nosuchskill hello there"));
      check("non-slash message untouched", reqs[2]?.firstUserText.includes("just a plain message"));
      if (!ok) process.exitCode = 1;
    },
  },
  "10": {
    // chapter 10: --plan starts the CLI in read-only mode. The model tries to
    // write a file, the gate denies it naming plan mode, nothing lands on disk,
    // and the model recovers with a text-only reply.
    needsLog: true,
    setup: () => {},
    runs: [{ argv: ["--plan", "Create a file report.txt with the plan."] }],
    turns: [
      { tools: [{ name: "write_file", input: { file_path: "report.txt", content: "the plan" } }] },
      { text: "That was blocked because we're in plan (read-only) mode." },
    ],
    verify: (dir, logPath) => {
      let ok = true;
      const check = (name, pass) => { console.log(`  ${pass ? "✓" : "✗"} ${name}`); if (!pass) ok = false; };
      check("nothing was written in plan mode", !existsSync(join(dir, "report.txt")));
      const events = readFileSync(logPath, "utf-8").trim().split("\n").map((l) => JSON.parse(l));
      const reqs = events.filter((e) => e.type === "request");
      check("two model calls (model saw the denial and recovered)", reqs.length === 2);
      check("the actual task reached the model", reqs[0]?.firstUserText.includes("Create a file report.txt"));
      const denial = (reqs[1]?.toolResults || []).map((t) => t.content).join(" ");
      check("tool_result says Denied", denial.includes("Denied"));
      check("denial names the mode (plan)", denial.includes("plan"));
      check("denial is not the file content", !denial.includes("the plan"));
      if (!ok) process.exitCode = 1;
    },
  },
  "6": {
    // chapter 6: the model tries a destructive command; the gate must stop it
    // BEFORE execution and report the denial back as a normal tool_result.
    prompt: "Delete everything in the demo folder with rm -rf.",
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
    verify: (dir, logPath) => {
      let ok = true;
      const check = (name, pass) => { console.log(`  ${pass ? "✓" : "✗"} ${name}`); if (!pass) ok = false; };
      const sessionPath = join(dir, ".mini-session.json");
      check("session file saved to disk", existsSync(sessionPath));
      let saved = null;
      try { saved = JSON.parse(readFileSync(sessionPath, "utf-8")); } catch {}
      // checked after BOTH runs: 2 restored + 1 new user + 1 new assistant.
      // A broken resume would overwrite the file with just 2 fresh messages.
      check("session ends with 4 messages (2 restored + 2 new)", Array.isArray(saved) && saved.length === 4);
      const events = readFileSync(logPath, "utf-8").trim().split("\n").map((l) => JSON.parse(l));
      const reqs = events.filter((e) => e.type === "request");
      check("two model calls total (one per run)", reqs.length === 2);
      check("run 1 sent only its own message (1 msg)", reqs[0]?.messageCount === 1);
      check("run 2 restored the history (3 msgs, not 1)", reqs[1]?.messageCount === 3);
      check("run 2's first user msg is run 1's text", typeof reqs[1]?.firstUserText === "string"
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
};

const s = scenarios[chapter];
if (!s) {
  console.error(`Unknown chapter: ${chapter} (available: ${Object.keys(scenarios).join(", ")})`);
  process.exit(1);
}

const workdir = mkdtempSync(join(tmpdir(), `my-ch${chapter}-`));
s.setup(workdir);

const logPath = s.needsLog ? join(tmpdir(), `my-ch${chapter}-log-${process.pid}.jsonl`) : undefined;
const scenario = s.tracks
  ? { id: `ch${chapter}`, tracks: s.tracks }
  : { id: `ch${chapter}`, turns: s.turns };
const mock = await startMock({ scenario, logPath });
process.env.ANTHROPIC_BASE_URL = mock.url;
process.env.ANTHROPIC_API_KEY = "test";
process.chdir(workdir);

console.log(`▶ mock model at ${mock.url}   sandbox: ${workdir}   chapter: ${chapter}`);

if (s.runs) {
  // CLI chapters: drive runCli(argv) once per run, in-process.
  const mod = await import(pathToFileURL(join(HERE, "dist", "cli.js")).href);
  for (const r of s.runs) {
    console.log(`  you: ${r.argv.join(" ")}\n`);
    await mod.runCli(r.argv);
    console.log();
  }
} else {
  console.log(`  you: ${s.prompt}\n`);
  const mod = await import(pathToFileURL(join(HERE, "dist", "agent.js")).href);
  await new mod.Agent().chat(s.prompt);
}

await mock.close();
if (s.verify) s.verify(workdir, logPath);
