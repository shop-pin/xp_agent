import Anthropic from "@anthropic-ai/sdk";
import { executeTool, toolDefinitions } from "./tools.js";
import { buildSystemPrompt, buildUserContextReminder } from "./prompt.js";
import { checkPermission } from "./permissions.js";
import { maybeCompact } from "./context.js";
import { recallMemories } from "./memory.js";
import { runSubAgent } from "./subagent.js";
import { connectMcp, type McpConnection } from "./mcp.js";
import { evaluateGoal, classifyAction } from "./autonomy.js";
import { saveSession } from "./session.js";
import { randomUUID } from "crypto";
import { printToolCall, printAssistantText, printInfo, startSpinner, stopSpinner } from "./ui.js";

const MODEL = process.env.ANTHROPIC_MODEL_ID || "glm-4.7-flash";

export class Agent {
    private client: Anthropic;
    private messages: Anthropic.MessageParam[] = [];
    private mode: string = "default";
    private mcp: McpConnection | null = null;
    private sessionId: string = randomUUID().slice(0, 8);
    private sessionStartTime: string = new Date().toISOString();

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

    restoreSession(data: { anthropicMessages?: any[] }): void {
        if (data.anthropicMessages) this.messages = data.anthropicMessages;
        printInfo(`Session restored (${this.messages.length} messages).`);
    }

    private autoSave(): void {
        try {
            saveSession(this.sessionId, {
                metadata: {
                    id: this.sessionId,
                    model: MODEL,
                    cwd: process.cwd(),
                    startTime: this.sessionStartTime,
                    messageCount: this.messages.length,
                },
                anthropicMessages: this.messages,
            });
        } catch {} // 写盘失败不打断对话——容错分层的取舍见 my_docs/17-multi-session.md
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
        // 评估器/分类器需要看到工具证据；裸渲染会把 tool_use/tool_result 全变占位符，
        // 导致 "done.txt exists" 这类目标永远判不通过（ch14 实测发现）
        const blockText = (b: any): string => {
            if (b.type === "tool_use") return `[tool_use ${b.name}: ${JSON.stringify(b.input)}]`;
            if (b.type === "tool_result") {
                const c = typeof b.content === "string"
                    ? b.content
                    : Array.isArray(b.content)
                        ? b.content.map((x: any) => x?.text ?? "").join(" ")
                        : "";
                return `[tool_result: ${String(c).slice(0, 300)}]`;
            }
            return `[${b.type}]`;
        };
        return this.messages
            .map((m) => `${m.role}: ${typeof m.content === "string"
                ? m.content
                : Array.isArray(m.content) ? m.content.map(blockText).join(" ") : "[content]"}`)
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
            startSpinner();
            let firstText = true;
            let response: Anthropic.Message;
            const stream = this.client.messages.stream({
                model: MODEL,
                max_tokens: 4096,
                system: buildSystemPrompt() + recallMemories(userText),
                tools: [...toolDefinitions, ...mcpTools],
                messages: this.messages,
            });
            try {
                // src 同款协调：首个 text 事件先停 spinner 再打印，避免 \r 重画吃掉流式输出；
                // 纯工具调用响应没有 text 事件，靠 finally 兜底
                stream.on("text", (t) => {
                    if (firstText) { stopSpinner(); firstText = false; }
                    printAssistantText(t);
                });
                response = await stream.finalMessage();
            } finally {
                stopSpinner();
            }
            printAssistantText("\n");
            this.messages.push({ role: "assistant", content: response.content });
            
            const toolUses: Anthropic.ToolUseBlock[] = response.content.filter((b) => b.type === "tool_use");

            if (toolUses.length === 0) {
                this.autoSave();
                return;
            }

            let toolResult: Anthropic.ToolResultBlockParam[] = [];
            for (const tu of toolUses) {
                printToolCall(tu.name, tu.input as Record<string, any>);
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