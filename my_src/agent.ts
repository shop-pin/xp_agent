import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import Anthropic from "@anthropic-ai/sdk";
import { executeTool, toolDefinitions } from "./tools.js";
import { buildSystemPrompt, buildUserContextReminder } from "./prompt.js";

const MODEL = process.env.ANTHROPIC_MODEL_ID || "glm-4.7-flash";

export class Agent {
    private client: Anthropic;
    private messages: Anthropic.MessageParam[] = [];

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

    async chat(userText: string): Promise<void> {
        const content = this.messages.length === 0
            ? `${userText}\n\n${buildUserContextReminder()}`
            : userText;
        this.messages.push({ role: "user", content: content });
        while (true) {
            const response = await this.client.messages.create({
                model: MODEL,
                max_tokens: 4096,
                system: buildSystemPrompt(),
                tools: toolDefinitions,
                messages: this.messages,
            })
            this.messages.push({ role: "assistant", content: response.content });
            for (const block of response.content) {
                if (block.type === "text") {
                    console.log(`block.text: ${block.text}`);
                }
            }

            const toolUses: Anthropic.ToolUseBlock[] = response.content.filter((b) => b.type === "tool_use");

            if (toolUses.length === 0) return;

            let toolResult: Anthropic.ToolResultBlockParam[] = [];
            for (const tu of toolUses) {
                console.log(`  ->${tu.name}(${JSON.stringify(tu.input)})`);
                const result = await executeTool(tu.name, tu.input as Record<string, any>);
                toolResult.push({ type: "tool_result", tool_use_id: tu.id, content: result });
            }
            this.messages.push({ role: "user", content: toolResult });
        }
    }
}
