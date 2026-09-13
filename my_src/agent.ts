import Anthropic from "@anthropic-ai/sdk";
import { executeTool, toolDefinitions } from "./tools.js";
import { buildSystemPrompt, buildUserContextReminder } from "./prompt.js";
import { checkPermission } from "./permissions.js";
import { maybeCompact } from "./context.js";
import { recallMemories } from "./memory.js";
import { runSubAgent } from "./subagent.js";
import { connectMcp, type McpConnection } from "./mcp.js";
import { evaluateGoal, classifyAction } from "./autonomy.js";

const MODEL = process.env.ANTHROPIC_MODEL_ID || "glm-4.7-flash";

export class Agent {
    private client: Anthropic;
    private messages: Anthropic.MessageParam[] = [];
    private mode: string = "default";
    private mcp: McpConnection | null = null;

    constructor() {
        this.client = new Anthropic({
            apiKey: process.env.ANTHROPIC_API_KEY,
            baseURL: process.env.ANTHROPIC_BASE_URL,
        });
    }

    history(): Anthropic.MessageParam[] {
        return this.messages;
    }

    loadHistory(messages: Anthropic.MessageParam[]): void {
        this.messages = messages;
    }

    clearHistory(): void {
        this.messages = [];
    }

    setMode(mode: string): void {
        this.mode = mode;
    }

    private async ensureMcp(): Promise<void> {
        if (this.mcp || !process.env.MINI_MCP_SERVER) return;
        this.mcp = await connectMcp("node", [process.env.MINI_MCP_SERVER]);
    }

    closeMcp(): void {
        this.mcp?.close();
        this.mcp = null;
    }

    private transcriptText(): string {
        return this.messages
            .map((m) => `${m.role}: ${typeof m.content === "string" ? m.content : "[tool call / result]"}`)
            .join("\n");
    }

    async pursueGoal(condition: string, prompt: string): Promise<void> {
        await this.chat(prompt);
        for (let i = 0; i < 5; i++) {
            const verdict = await evaluateGoal(condition, this.transcriptText(), this.client, MODEL);
            if (verdict.met) {
                console.log(`✓ goal met: ${condition}`);
                return;
            }
            console.log(`  (goal not met — ${verdict.reason}; continuing)`);
            await this.chat(`The goal "${condition}" is not met yet: ${verdict.reason}. Keep working toward it.`);
        }
        console.log(`  (gave up after 5 iterations without meeting: ${condition})`);
    }

    async chat(userText: string): Promise<void> {
        const content = this.messages.length === 0
            ? `${userText}\n\n${buildUserContextReminder()}`
            : userText;
        this.messages.push({ role: "user", content: content });
        await this.ensureMcp();
        const mcpTools: Anthropic.Tool[] = (this.mcp?.tools || []).map((t) => ({
            name: `mcp__demo__${t.name}`,
            description: t.description,
            input_schema: t.input_schema as any,
        }));
        while (true) {
            this.messages = await maybeCompact(this.messages, this.client, MODEL);
            const stream = this.client.messages.stream({
                model: MODEL,
                max_tokens: 4096,
                system: buildSystemPrompt() + recallMemories(userText),
                tools: [...toolDefinitions, ...mcpTools],
                messages: this.messages,
            });
            stream.on("text", (t) => process.stdout.write(t));
            const response = await stream.finalMessage();
            process.stdout.write("\n");
            this.messages.push({ role: "assistant", content: response.content });
            
            const toolUses: Anthropic.ToolUseBlock[] = response.content.filter((b) => b.type === "tool_use");

            if (toolUses.length === 0) return;

            let toolResult: Anthropic.ToolResultBlockParam[] = [];
            for (const tu of toolUses) {
                console.log(`  ->${tu.name}(${JSON.stringify(tu.input)})`);
                if (tu.name === "agent") {
                    const summary = await runSubAgent(String((tu.input as any).task || ""), this.client, MODEL);
                    toolResult.push({ type: "tool_result", tool_use_id: tu.id, content: summary });
                    continue;
                }
                if (tu.name.startsWith("mcp__")) {
                    const toolName = tu.name.split("__").slice(2).join("__");
                    const output = this.mcp
                        ? await this.mcp.callTool(toolName, tu.input as Record<string, any>)
                        : "Denied: no MCP server connected.";
                    toolResult.push({ type: "tool_result", tool_use_id: tu.id, content: output });
                    continue;
                }
                if (this.mode === "auto" && ["write_file", "edit_file", "run_shell"].includes(tu.name)) {
                    const verdict = await classifyAction(tu.name, tu.input as Record<string, any>, this.transcriptText(), this.client, MODEL);
                    if (!verdict.allow) {
                        toolResult.push({type: "tool_result", tool_use_id:tu.id, content: `Blocked by auto-mode monitor: ${verdict.reason}`});
                        continue;
                    }
                }
                const blocked = checkPermission(tu.name, tu.input as Record<string, any>) === "deny"
                    || (this.mode === "plan" && ["write_file", "edit_file", "run_shell"].includes(tu.name));
                const output = blocked
                    ? `Denied: ${tu.name} was blocked (${this.mode} mode).`
                    : await executeTool(tu.name, tu.input as Record<string, any>);
                toolResult.push({ type: "tool_result", tool_use_id: tu.id, content: output });
            }
            this.messages.push({ role: "user", content: toolResult });
        }
    }
}