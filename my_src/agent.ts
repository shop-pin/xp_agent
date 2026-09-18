import Anthropic from "@anthropic-ai/sdk";
import * as readline from "readline";
import { executeTool, toolDefinitions } from "./tools.js";
import { buildSystemPrompt, buildUserContextReminder } from "./prompt.js";
import { checkPermission, type PermissionMode } from "./permissions.js";
import { maybeCompact } from "./context.js";
import { recallMemories } from "./memory.js";
import { runSubAgent } from "./subagent.js";
import { McpManager } from "./mcp.js";
import { withRetry } from "./retry.js";
import { evaluateGoal, classifyAction } from "./autonomy.js";
import { saveSession } from "./session.js";
import { randomUUID } from "crypto";
import { printToolCall, printAssistantText, printInfo, printConfirmation, printCost, startSpinner, stopSpinner } from "./ui.js";

const MODEL = process.env.ANTHROPIC_MODEL_ID || "glm-4.7-flash";

export class Agent {
    private client: Anthropic;
    private messages: Anthropic.MessageParam[] = [];
    private mode: PermissionMode = "default";
    private mcpManager = new McpManager();
    private readFileState: Map<string, number> = new Map();
    private confirmedPaths: Set<string> = new Set();
    private confirmFn?: (message: string) => Promise<boolean>;
    private sessionId: string = randomUUID().slice(0, 8);
    private sessionStartTime: string = new Date().toISOString();

    // ch20 token 四计数：缓存读/写单列——input_tokens 只算未命中前缀，
    // cache_read 按 0.1x、cache_creation 按 1.25x 计费，混在一起费用就是错的
    private totalInputTokens = 0;
    private totalOutputTokens = 0;
    private totalCacheReadTokens = 0;
    private totalCacheCreationTokens = 0;
    // 下一次请求的上下文体量预估（本次 prompt 全量 + 本次输出），ch21 压缩仪表的原料
    private lastInputTokenCount = 0;
    private currentTurns = 0;
    private maxCostUsd: number | null = null;
    private maxTurns: number | null = null;

    constructor() {
        // 可选：封 SDK 自带的重试层（默认 2）。MINI_CLAUDE_SDK_MAX_RETRIES=0
        // 用于在测试里隔离我们自己的 withRetry——否则 SDK 先吞掉失败，
        // mock 注入的 429 永远到不了用户代码
        const sdkRetries =
            process.env.MINI_CLAUDE_SDK_MAX_RETRIES != null && process.env.MINI_CLAUDE_SDK_MAX_RETRIES !== "" &&
            !Number.isNaN(Number(process.env.MINI_CLAUDE_SDK_MAX_RETRIES))
                ? { maxRetries: Number(process.env.MINI_CLAUDE_SDK_MAX_RETRIES) }
                : {};
        this.client = new Anthropic({
            apiKey: process.env.ANTHROPIC_API_KEY,
            baseURL: process.env.ANTHROPIC_BASE_URL,
            ...sdkRetries,
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

    setMode(mode: PermissionMode): void {
        this.mode = mode;
    }

    setMaxCost(usd: number): void {
        this.maxCostUsd = usd;
    }

    setMaxTurns(n: number): void {
        this.maxTurns = n;
    }

    // 累计费用（美元）：$3/M 输入、$0.3/M 缓存读、$3.75/M 缓存写、$15/M 输出
    getCurrentCostUsd(): number {
        return (
            (this.totalInputTokens / 1_000_000) * 3 +
            (this.totalCacheReadTokens / 1_000_000) * 0.3 +
            (this.totalCacheCreationTokens / 1_000_000) * 3.75 +
            (this.totalOutputTokens / 1_000_000) * 15
        );
    }

    // 预算检查：maxTurns 先看（便宜的整数比较），maxCost 后看。
    // 返回 {exceeded, reason}——reason 既要打给用户看，也要作为拒绝理由回灌给模型
    checkBudget(): { exceeded: boolean; reason: string } {
        if (this.maxTurns !== null && this.currentTurns >= this.maxTurns) {
            return { exceeded: true, reason: `turn limit reached (${this.maxTurns})` };
        }
        if (this.maxCostUsd !== null && this.getCurrentCostUsd() > this.maxCostUsd) {
            return { exceeded: true, reason: `cost $${this.getCurrentCostUsd().toFixed(2)} exceeds max-cost $${this.maxCostUsd}` };
        }
        return { exceeded: false, reason: "" };
    }

    // REPL 注入复用已有 readline 的确认回调；未注入时（one-shot）confirmDangerous 临时开一个
    setConfirmFn(fn: (message: string) => Promise<boolean>): void {
        this.confirmFn = fn;
    }

    private async confirmDangerous(message: string): Promise<boolean> {
        // 问什么先打出来（src 同款）：回调只收 y/n，展示是 agent 层的职责——
        // 这样 REPL 注入的回调和 one-shot 的 fallback 都不漏"在批准什么"
        printConfirmation(message);
        if (this.confirmFn) return this.confirmFn(message);
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        return new Promise((resolve) => {
            rl.question("  Allow? (y/n): ", (answer) => {
                rl.close();
                resolve(answer.toLowerCase().startsWith("y"));
            });
        });
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
        // loadAndConnect 幂等：已连/无配置时是 no-op
        await this.mcpManager.loadAndConnect();
    }

    // MCP 子进程 stdio 会挂住事件循环，one-shot/测试结束必须显式关闭
    async close(): Promise<void> {
        await this.mcpManager.disconnectAll();
    }

    // ─── Prefix caching（Anthropic）────────────────────────────
    // system 拆成块数组：静态主体（指令+环境）打 cache_control 断点，
    // 动态尾巴（memory 召回）放断点之后。断点前的所有内容（含工具 schema，
    // 它们在 system 之前渲染）命中服务端前缀缓存
    private buildAnthropicSystem(userText: string): Anthropic.TextBlockParam[] {
        const blocks: Anthropic.TextBlockParam[] = [
            { type: "text", text: buildSystemPrompt(), cache_control: { type: "ephemeral" } },
        ];
        const mem = recallMemories(userText).trim();
        if (mem) blocks.push({ type: "text", text: mem });
        return blocks;
    }

    // 返回消息列表的**拷贝**，最后一条消息的最后一个 content block 打断点：
    // 之前所有轮次留在缓存前缀里，只有最新消息按全价处理。纯函数——
    // 持久历史（session 存档/compact）不能被掺进 cache_control 元数据
    private withCacheBreakpoints(messages: Anthropic.MessageParam[]): Anthropic.MessageParam[] {
        if (messages.length === 0) return messages;
        const out = messages.slice();
        const idx = out.length - 1;
        const last = out[idx];
        const content = typeof last.content === "string"
            ? [{ type: "text", text: last.content } as any]
            : (last.content as any[]).slice();
        const tail = content[content.length - 1] as any;
        // thinking 块内容不稳定，标记它会伤缓存命中，跳过
        if (tail && tail.type !== "thinking" && tail.type !== "redacted_thinking") {
            content[content.length - 1] = { ...tail, cache_control: { type: "ephemeral" } };
            out[idx] = { ...last, content } as Anthropic.MessageParam;
        }
        return out;
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
        const mcpTools: Anthropic.Tool[] = this.mcpManager.getToolDefinitions();
        while (true) {
            this.messages = await maybeCompact(this.messages, this.client, MODEL);
            startSpinner();
            let firstText = true;
            let response: Anthropic.Message;
            try {
                // withRetry 包住"建流 + 等完整消息"：重试时旧流已死，必须重建整个流，
                // 所以 fn 每次调用都 new 一个 stream，不能只包 finalMessage()
                response = await withRetry(async () => {
                    const stream = this.client.messages.stream({
                        model: MODEL,
                        max_tokens: 4096,
                        system: this.buildAnthropicSystem(userText),
                        tools: [...toolDefinitions, ...mcpTools],
                        messages: this.withCacheBreakpoints(this.messages),
                    });
                    // src 同款协调：首个 text 事件先停 spinner 再打印，避免 \r 重画吃掉流式输出；
                    // 纯工具调用响应没有 text 事件，靠 finally 兜底
                    stream.on("text", (t) => {
                        if (firstText) { stopSpinner(); firstText = false; }
                        printAssistantText(t);
                    });
                    return await stream.finalMessage();
                });
            } finally {
                stopSpinner();
            }
            printAssistantText("\n");
            // 四计数：缓存读/写分开累计；lastInputTokenCount = 本次 prompt 全量 + 输出
            // （输出会成为下一次请求的一部分），ch21 压缩仪表读它
            const u: any = response.usage;
            const cacheRead = u.cache_read_input_tokens || 0;
            const cacheCreation = u.cache_creation_input_tokens || 0;
            this.totalInputTokens += u.input_tokens;
            this.totalCacheReadTokens += cacheRead;
            this.totalCacheCreationTokens += cacheCreation;
            this.totalOutputTokens += u.output_tokens;
            this.lastInputTokenCount = u.input_tokens + cacheRead + cacheCreation + u.output_tokens;
            this.messages.push({ role: "assistant", content: response.content });
            
            const toolUses: Anthropic.ToolUseBlock[] = response.content.filter((b) => b.type === "tool_use");

            if (toolUses.length === 0) {
                printCost(this.totalInputTokens, this.totalOutputTokens, this.totalCacheReadTokens, this.totalCacheCreationTokens);
                this.autoSave();
                return;
            }

            // budget 检查点（位置 B）：响应已结算、工具未执行。超限时每个 tool_use
            // 都要补一条拒绝 tool_result 再停——否则历史里挂着无回应的 tool_use，
            // 下次 chat() 把它发回 API 直接 400（session 存档同样被污染）
            this.currentTurns++;
            const budget = this.checkBudget();
            if (budget.exceeded) {
                printInfo(`Budget exceeded: ${budget.reason}`);
                this.messages.push({
                    role: "user",
                    content: toolUses.map((tu) => ({
                        type: "tool_result" as const,
                        tool_use_id: tu.id,
                        content: `Tool call not executed: ${budget.reason}`,
                    })),
                });
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
                    let output: string;
                    try {
                        output = await this.mcpManager.callTool(tu.name, tu.input as Record<string, any>);
                    } catch (e: any) {
                        // server 掉线/名字拆错等——作为 tool_result 回给模型自行处置，不在主循环里炸
                        output = `Error: ${e.message ?? e}`;
                    }
                    toolResult.push({ type: "tool_result", tool_use_id: tu.id, content: output });
                    continue;
                }
                if (this.mode === "auto" && ["write_file", "edit_file", "run_shell"].includes(tu.name)) {
                    // auto 的闸门只有分类器，静态流水线不再叠加（对齐 src）
                    const verdict = await classifyAction(tu.name, tu.input as Record<string, any>, this.transcriptText(), this.client, MODEL);
                    if (!verdict.allow) {
                        toolResult.push({type: "tool_result", tool_use_id:tu.id, content: `Blocked by auto-mode monitor: ${verdict.reason}`});
                        continue;
                    }
                    const output = await executeTool(tu.name, tu.input as Record<string, any>, this.readFileState);
                    toolResult.push({ type: "tool_result", tool_use_id: tu.id, content: output });
                    continue;
                }
                const perm = checkPermission(tu.name, tu.input as Record<string, any>, this.mode);
                if (perm.action === "deny") {
                    printInfo(`Denied: ${perm.message}`);
                    toolResult.push({ type: "tool_result", tool_use_id: tu.id, content: `Denied: ${perm.message}` });
                    continue;
                }
                if (perm.action === "confirm" && perm.message) {
                    // 同一 message 确认一次后缓存；auto 的 confirm 是 reason 不是 path，绝不能缓存（ch26 的坑）
                    if (!this.confirmedPaths.has(perm.message)) {
                        const confirmed = await this.confirmDangerous(perm.message);
                        if (!confirmed) {
                            toolResult.push({ type: "tool_result", tool_use_id: tu.id, content: "User denied this action." });
                            continue;
                        }
                        this.confirmedPaths.add(perm.message);
                    }
                }
                const output = await executeTool(tu.name, tu.input as Record<string, any>, this.readFileState);
                toolResult.push({ type: "tool_result", tool_use_id: tu.id, content: output });
            }
            this.messages.push({ role: "user", content: toolResult });
        }
    }
}