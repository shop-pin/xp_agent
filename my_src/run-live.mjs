// Live driver: run YOUR Agent against a real model.
// Usage:  npm run live -- "your prompt"
// Needs ANTHROPIC_API_KEY (and optionally ANTHROPIC_BASE_URL / ANTHROPIC_MODEL_ID),
// read from repo-root .env if present.
import { existsSync, readFileSync } from "fs";
import { join, dirname } from "path";
import { pathToFileURL, fileURLToPath } from "url";

const HERE = dirname(fileURLToPath(import.meta.url));
const envFile = join(HERE, "..", ".env");
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, "utf-8").split("\n")) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}

const prompt = process.argv.slice(2).join(" ");
if (!prompt) { console.log('usage: npm run live -- "your prompt"'); process.exit(1); }

const mod = await import(pathToFileURL(join(HERE, "dist", "agent.js")).href);
await new mod.Agent().chat(prompt);
