// Mock-model test driver: runs YOUR Agent against a scripted Anthropic API.
// No API key needed. Usage: npm run mock  (compiles first, then runs)
import { startMock } from "../steps/mock-anthropic.mjs";
import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, dirname } from "path";
import { pathToFileURL, fileURLToPath } from "url";

const HERE = dirname(fileURLToPath(import.meta.url));

// Chapter 1 scenario: model asks to read greeting.txt, gets the result, then answers.
const scenario = {
  id: "ch1",
  turns: [
    { tools: [{ name: "read_file", input: { file_path: "greeting.txt" } }] },
    { text: "greeting.txt says: hello from step one." },
  ],
};

const workdir = mkdtempSync(join(tmpdir(), "my-ch1-"));
writeFileSync(join(workdir, "greeting.txt"), "hello from step one.");

const mock = await startMock({ scenario });
process.env.ANTHROPIC_BASE_URL = mock.url;
process.env.ANTHROPIC_API_KEY = "test";
process.chdir(workdir);

console.log(`▶ mock model at ${mock.url}   sandbox: ${workdir}`);
console.log("  you: Read the file greeting.txt and tell me what it says.\n");

const mod = await import(pathToFileURL(join(HERE, "dist", "agent.js")).href);
await new mod.Agent().chat("Read the file greeting.txt and tell me what it says.");

await mock.close();
