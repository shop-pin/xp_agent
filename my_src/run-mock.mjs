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
console.log(`  you: ${s.prompt}\n`);

const mod = await import(pathToFileURL(join(HERE, "dist", "agent.js")).href);
await new mod.Agent().chat(s.prompt);

await mock.close();
if (s.verify) s.verify(workdir, logPath);
