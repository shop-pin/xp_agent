// A minimal MCP server for chapter 45 testing: serves a canned "adjudication
// context pack" (quote/depth/money_flow/topics sections) over stdio JSON-RPC.
// Scaffold for offline mock runs — canned data only, NOT part of the learning
// code (same standing as mcp-demo-server.mjs).
import { createInterface } from "readline";

const PACK = {
  symbol: "sh600000",
  quote: { last_price: 9.82, pre_close_price: 9.62, open_price: 9.56, amount: 789322240.0 },
  depth: {
    bids: [{ price: 9.81, volume: 456 }, { price: 9.8, volume: 1473 }],
    asks: [{ price: 9.82, volume: 135 }, { price: 9.83, volume: 1436 }],
  },
  money_flow: [{ date: "2026-10-27", main_net: -15344424.35, main_ratio: -1.944 }],
  topics: [{ topic_id: "2817", topic_name: "示例题材", relation_level: 3.0, reason: "夹具数据" }],
  errors: [],
};

const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.id === undefined || msg.id === null) return;
  switch (msg.method) {
    case "initialize":
      respond(msg.id, {
        protocolVersion: "2024-11-05",
        capabilities: {},
        serverInfo: { name: "pack", version: "1.0" },
      });
      break;
    case "tools/list":
      respond(msg.id, {
        tools: [{
          name: "adjudicate_pack",
          description: "canned adjudication context pack (quote/depth/money_flow/topics)",
          inputSchema: {
            type: "object",
            properties: { code: { type: "string" } },
            required: ["code"],
          },
        }],
      });
      break;
    case "tools/call":
      respond(msg.id, {
        content: [{ type: "text", text: JSON.stringify(PACK) }],
      });
      break;
    default:
      respond(msg.id, { error: { code: -32601, message: `no method ${msg.method}` } });
  }
});

function respond(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
}
