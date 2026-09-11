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
const mock = await startMock({ scenario: { id: `ch${chapter}`, turns: s.turns }, logPath });
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
