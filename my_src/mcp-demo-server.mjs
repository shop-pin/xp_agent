// A minimal MCP server for chapter 12 testing: speaks JSON-RPC over stdio,
// exposes a single `add` tool. This is the *external service* side of the
// exercise (scaffold, like mock-anthropic.mjs) — NOT part of the learning code.
import { createInterface } from "readline";

const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.id === undefined || msg.id === null) return; // notification: nothing to answer
  switch (msg.method) {
    case "initialize":
      respond(msg.id, {
        protocolVersion: "2024-11-05",
        capabilities: {},
        serverInfo: { name: "demo", version: "1.0" },
      });
      break;
    case "tools/list":
      respond(msg.id, {
        tools: [{
          name: "add",
          description: "Add two numbers together",
          inputSchema: {
            type: "object",
            properties: { a: { type: "number" }, b: { type: "number" } },
            required: ["a", "b"],
          },
        }],
      });
      break;
    case "tools/call": {
      const { a, b } = msg.params?.arguments || {};
      if (typeof a !== "number" || typeof b !== "number") {
        respond(msg.id, { content: [{ type: "text", text: "error: a and b must be numbers" }] });
      } else {
        respond(msg.id, { content: [{ type: "text", text: String(a + b) }] });
      }
      break;
    }
    default:
      process.stdout.write(JSON.stringify({
        jsonrpc: "2.0", id: msg.id,
        error: { code: -32601, message: `method not found: ${msg.method}` },
      }) + "\n");
  }
});

function respond(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
}
