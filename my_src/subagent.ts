import Anthropic from "@anthropic-ai/sdk";
import { toolDefinitions, executeTool } from "./tools.js";

const EXPLORE_TOOLS = ["read_file", "list_files", "grep_search"];

export async function runSubAgent(task: string, client: Anthropic, model: string): Promise<string> {
    const messages: Anthropic.MessageParam[] = [{ role: "user", content: task }];
    const tools = toolDefinitions.filter((t) => EXPLORE_TOOLS.includes(t.name));

    while (true) {
        const reply = await client.messages.create({
            model,
            max_tokens: 4096,
            system: "You are an explore sub-agent. Investigate read-only and report back a concise summary.",
            tools,
            messages,
        });
        messages.push({ role: "assistant", content: reply.content });

        const toolUses: Anthropic.ToolUseBlock[] = reply.content.filter((b) => b.type === "tool_use");
        if (toolUses.length === 0) {
            return reply.content.filter((b) => b.type === "text").map((b: any) => b.text).join("");
        }

        const results: Anthropic.ToolResultBlockParam[] = [];
        for (const tu of toolUses) {
            const output = EXPLORE_TOOLS.includes(tu.name)
                ? await executeTool(tu.name, tu.input as Record<string, any>)
                : `Denied: the sub-agent is read-only.`;
            results.push({ type: "tool_result", tool_use_id: tu.id, content: output });
        }
        messages.push({ role: "user", content: results });
    }
}
