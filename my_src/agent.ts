import Anthropic from "@anthropic-ai/sdk";
import * as readline from "readline";
import { executeTool, toolDefinitions, truncateResult } from "./tools.js";
import { buildStaticSystemPrompt, buildDynamicSystemContext, buildUserContextReminder } from "./prompt.js";
import { checkPermission, type PermissionMode } from "./permissions.js";
import { startMemoryPrefetch, formatMemoriesForInjection, type MemoryPrefetch, type SideQueryFn } from "./memory.js";
import { getSubAgentConfig, type SubAgentType } from "./subagent.js";
import { McpManager } from "./mcp.js";
import { withRetry } from "./retry.js";
import { evaluateGoal, classifyAction } from "./autonomy.js";
import { saveSession } from "./session.js";
import { randomUUID } from "crypto";
import { mkdirSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { printToolCall, printAssistantText, printInfo, printConfirmation, printCost, printSubAgentStart, printSubAgentEnd, startSpinner, stopSpinner } from "./ui.js";

const MODEL = process.env.ANTHROPIC_MODEL_ID || "glm-4.7-flash";

// ─── ch21：四层压缩常量 ──────────────────────────────────────
// T1 budget → T2 snip → T3 microcompact → T4 auto-compact。
// T1–T3 零 API 成本（原地改 this.messages），T4 是唯一花一次摘要请求的层。
const SNIPPABLE_TOOLS = new Set(["read_file", "grep_search", "list_files", "run_shell"]);
const SNIP_PLACEHOLDER = "[Content snipped - re-read if needed]";
const SNIP_THRESHOLD = 0.60;
// 热缓存覆盖线：utilization 超过它，就算缓存还热也允许改写老结果——
// 溢出风险比重建一次缓存更贵（0.60 < 0.75 < 0.85 三线各管一层）
const SNIP_HOT_OVERRIDE = 0.75;
const MICROCOMPACT_IDLE_MS = 5 * 60 * 1000; // 缓存 5 分钟没用就算冷
const KEEP_RECENT_RESULTS = 3;

const MODEL_CONTEXT: Record<string, number> = {
    "glm-4.7-flash": 128000,
    "glm-5.3-flash": 128000,
    "claude-sonnet-4-6": 200000,
};
function getContextWindow(model: string): number {
    return MODEL_CONTEXT[model] || 200000;
}

export interface AgentOptions {
    permissionMode?: PermissionMode;
    // 子 agent 三件套：整个 system 视为静态块（跳过 dynamic 段与首条消息 reminder）、
    // 裁剪过的工具集、行为开关（不连 MCP、不 autoSave、不打 spinner/cost）
    customSystemPrompt?: string;
    customTools?: Anthropic.Tool[];
    isSubAgent?: boolean;
}

export class Agent {
    private client: Anthropic;
    private messages: Anthropic.MessageParam[] = [];
    private mode: PermissionMode = "default";
    private tools: Anthropic.Tool[];
    private staticSystemPrompt: string;
    private hasCustomPrompt: boolean;
    private isSubAgent: boolean;
    // 子 agent 的最终文本收进 buffer 而非打印，runOnce 拼出来回传父级
    private outputBuffer: string[] | null = null;
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
    // ch21 压缩仪表：最近一次 API 调用时刻——T2/T3 用它判断缓存冷热
    private lastApiCallTime = 0;
    // 有效窗口 = 上下文窗口 - 20000 安全边际（给摘要请求本身和系统块留余量）
    private effectiveWindow: number;
    // ch22 语义召回：prefetch 句柄 + 防重复注入簿记（按记忆文件绝对路径）
    private memoryPrefetch: MemoryPrefetch | null = null;
    private alreadySurfacedMemories: Set<string> = new Set();
    private sessionMemoryBytes = 0;

    constructor(options: AgentOptions = {}) {
        this.mode = options.permissionMode || "default";
        this.isSubAgent = options.isSubAgent || false;
        this.tools = options.customTools || toolDefinitions;
        this.hasCustomPrompt = !!options.customSystemPrompt;
        this.staticSystemPrompt = options.customSystemPrompt || buildStaticSystemPrompt();
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
        this.effectiveWindow = getContextWindow(MODEL) - 20000;
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

    // ═══ ch21：四层压缩（本章由你写）═════════════════════════════
    // 仪表：utilization = lastInputTokenCount / effectiveWindow
    // 调用点已接好：T1–T3 走 runCompressionPipeline()（每次发请求前），
    // T4 走 checkAndCompact()（turn 边界：用户消息刚 push、循环未开始）。

    // 组装层：顺序即语义，各一行。
    runCompressionPipeline(): void {
        this.budgetToolResults();
        this.snipStaleResults();
        this.microcompact();
    }

    // ── T1 budget：把超大 tool_result 掐头去尾缩进预算。零 API 成本，无缓存门控
    //    （它只处理大块头——那种结果留着必溢出，缩了顶多重建一次缓存）。
    private budgetToolResults(): void {
        const utilization = this.lastInputTokenCount / this.effectiveWindow;
        if (utilization < 0.5) return;
        const budget = utilization > 0.7 ? 15000 : 30000;

        for (const msg of this.messages) {
            if (msg.role !== "user" || !Array.isArray(msg.content)) continue;
            for (let i = 0; i < msg.content.length; i++) {
                const block = msg.content[i] as any;
                if (block.type === "tool_result" && typeof block.content === "string" && block.content.length > budget) {
                    const keepEach = Math.floor((budget - 80) / 2);
                    block.content = block.content.slice(0, keepEach) +
                        `\n\n[... budgeted: ${block.content.length - keepEach * 2} chars truncated ...]\n\n` +
                        block.content.slice(-keepEach);
                }
            }
        }
    }

    // ── T2 snip：同文件旧读去重 + 只保最近 N 条，被剪的整个 tool_result 换成
    //    SNIP_PLACEHOLDER。双门控是本层灵魂：缓存热且 utilization 未越覆盖线 → 忍住。
    private snipStaleResults(): void {
        const utilization = this.lastInputTokenCount / this.effectiveWindow;
        const cacheHot = this.lastApiCallTime > 0 && (Date.now() - this.lastApiCallTime) < MICROCOMPACT_IDLE_MS;
        if (cacheHot && utilization < SNIP_HOT_OVERRIDE) return;
        if (utilization < SNIP_THRESHOLD) return;

        // 收集所有可剪结果（已剪过的 placeholder 不再收），带定位与反查元数据
        const results: { msgIdx: number; blockIdx: number; toolName: string; filePath?: string }[] = [];
        for (let mi = 0; mi < this.messages.length; mi++) {
            const msg = this.messages[mi];
            if (msg.role !== "user" || !Array.isArray(msg.content)) continue;
            for (let bi = 0; bi < msg.content.length; bi++) {
                const block = msg.content[bi] as any;
                if (block.type === "tool_result" && typeof block.content === "string" && block.content !== SNIP_PLACEHOLDER) {
                    const toolInfo = this.findToolUseById(block.tool_use_id);
                    if (toolInfo && SNIPPABLE_TOOLS.has(toolInfo.name)) {
                        results.push({ msgIdx: mi, blockIdx: bi, toolName: toolInfo.name, filePath: toolInfo.input?.file_path });
                    }
                }
            }
        }

        if (results.length <= KEEP_RECENT_RESULTS) return;

        // 两个剪枝下标集合，最后统一替换（别边遍历边改）
        const toSnip = new Set<number>();
        const seenFiles = new Map<string, number[]>(); // file_path → 出现下标

        for (let i = 0; i < results.length; i++) {
            const r = results[i];
            if (r.toolName === "read_file" && r.filePath) {
                const existing = seenFiles.get(r.filePath) || [];
                existing.push(i);
                seenFiles.set(r.filePath, existing);
            }
        }
        // ① 同文件旧读：同一 file_path 只留最后一次
        for (const indices of seenFiles.values()) {
            if (indices.length > 1) {
                for (let j = 0; j < indices.length - 1; j++) toSnip.add(indices[j]);
            }
        }
        // ② 保最近：最老的 results.length - KEEP_RECENT_RESULTS 条剪掉
        const snipBefore = results.length - KEEP_RECENT_RESULTS;
        for (let i = 0; i < snipBefore; i++) toSnip.add(i);

        for (const idx of toSnip) {
            const r = results[idx];
            const block = (this.messages[r.msgIdx].content as any[])[r.blockIdx];
            block.content = SNIP_PLACEHOLDER;
        }
    }

    // ── T3 microcompact：缓存已冷才允许的"大扫除"——所有 tool_result 只保最近
    //    KEEP_RECENT_RESULTS 条，其余换成 "[Old result cleared]"。
    private microcompact(): void {
        if (!this.lastApiCallTime || (Date.now() - this.lastApiCallTime) < MICROCOMPACT_IDLE_MS) return;

        const allResults: { msgIdx: number; blockIdx: number }[] = [];
        for (let mi = 0; mi < this.messages.length; mi++) {
            const msg = this.messages[mi];
            if (msg.role !== "user" || !Array.isArray(msg.content)) continue;
            for (let bi = 0; bi < msg.content.length; bi++) {
                const block = msg.content[bi] as any;
                if (block.type === "tool_result" && typeof block.content === "string" &&
                    block.content !== SNIP_PLACEHOLDER && block.content !== "[Old result cleared]") {
                    allResults.push({ msgIdx: mi, blockIdx: bi });
                }
            }
        }

        const clearCount = allResults.length - KEEP_RECENT_RESULTS;
        for (let i = 0; i < clearCount && i < allResults.length; i++) {
            const r = allResults[i];
            (this.messages[r.msgIdx].content as any[])[r.blockIdx].content = "[Old result cleared]";
        }
    }

    // ── T4 门：唯一要花 API 的一层。0.85 线，turn 边界才检查（见调用点注释）。
    async checkAndCompact(): Promise<void> {
        if (this.lastInputTokenCount > this.effectiveWindow * 0.85) {
            printInfo("Context window filling up, compacting conversation...");
            await this.compactAnthropic();
            printInfo("Conversation compacted.");
        }
    }

    // 摘要重写（T4 主体）。硬不变式：调用时最后一条必须是纯 user 文本消息——
    // 它会被 slice(0,-1) 摘出来最后塞回去；如果它是 tool_result，前面的 tool_use
    // 就孤儿化了，摘要请求直接 400（与 ch20 refusal 配对同源：历史必须自洽）。
    async compactAnthropic(): Promise<void> {
        if (this.messages.length < 4) return;
        const lastUserMsg = this.messages[this.messages.length - 1];
        const summaryResp = await this.client.messages.create({
            model: MODEL,
            max_tokens: 2048,
            system: "You are a conversation summarizer. Be concise but preserve important details.",
            messages: [
                ...this.messages.slice(0, -1),
                {
                    role: "user",
                    content: "Summarize the conversation so far in a concise paragraph, preserving key decisions, file paths, and context needed to continue the work.",
                },
            ],
        });
        const summaryText =
            summaryResp.content[0]?.type === "text"
                ? summaryResp.content[0].text
                : "No summary available.";
        this.messages = [
            { role: "user", content: `[Previous conversation summary]\n${summaryText}` },
            { role: "assistant", content: "Understood. I have the context from our previous conversation. How can I continue helping?" },
        ];
        if (lastUserMsg.role === "user") this.messages.push(lastUserMsg);
        this.lastInputTokenCount = 0;
    }

    // ── 大结果持久化：>30KB 的工具结果落盘 ~/.mini-claude/tool-results/，
    //    上下文里只留预览 + 文件路径。顺序是灵魂：先落盘，再生成预览。
    private persistLargeResult(toolName: string, result: string): string {
        const THRESHOLD = 30 * 1024;
        if (Buffer.byteLength(result) <= THRESHOLD) return result;

        const dir = join(homedir(), ".mini-claude", "tool-results");
        mkdirSync(dir, { recursive: true });
        // uuid 后缀：并行工具同一毫秒落盘时，纯时间戳文件名会让第二次写覆盖第一次
        const filename = `${Date.now()}-${randomUUID().slice(0, 8)}-${toolName}.txt`;
        const filepath = join(dir, filename);
        writeFileSync(filepath, result);

        const lines = result.split("\n");
        const preview = lines.slice(0, 200).join("\n");
        const sizeKB = (Buffer.byteLength(result) / 1024).toFixed(1);

        // 截断在落盘之后：全量已安全在磁盘上，这里只是防病态预览（单行几百 KB 的文件）
        return truncateResult(`[Result too large (${sizeKB} KB, ${lines.length} lines). Full output saved to ${filepath}. You can use read_file to see the full result.]\n\nPreview (first 200 lines):\n${preview}`);
    }

    // 机械反查：tool_use_id → { name, input }。给 T2 判定"这条结果出自哪个工具"用。
    private findToolUseById(toolUseId: string): { name: string; input: any } | null {
        for (const msg of this.messages) {
            if (msg.role !== "assistant" || !Array.isArray(msg.content)) continue;
            for (const block of msg.content as any[]) {
                if (block.type === "tool_use" && block.id === toolUseId) {
                    return { name: block.name, input: block.input };
                }
            }
        }
        return null;
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

    // ─── Memory prefetch 生命周期（ch22）────────────────────────

    // 旁路查询：独立小请求（非流式、temperature 0、256 token 上限），
    // 给 memory selector 这类"让模型做决策"的辅助调用用，主对话历史不掺和
    private buildSideQuery(): SideQueryFn {
        const client = this.client;
        const model = MODEL;
        return async (system, userMessage) => {
            const resp = await client.messages.create({
                model, max_tokens: 256, system, temperature: 0,
                messages: [{ role: "user", content: userMessage }],
            });
            return resp.content
                .filter((b): b is Anthropic.TextBlock => b.type === "text")
                .map((b) => b.text).join("");
        };
    }

    // 消费已落定的 prefetch：把召回的记忆追加进最后一条 user 消息（保持
    // user/assistant 交替不变式），并记入已曝光集合——同一条记忆一个会话只注入一次
    private async consumeMemoryPrefetchIfReady(messages: Anthropic.MessageParam[]): Promise<void> {
        const pf = this.memoryPrefetch;
        if (!pf || !pf.settled || pf.consumed) return;
        pf.consumed = true;
        const memories = await pf.promise;
        if (memories.length === 0) return;
        const injectionText = formatMemoriesForInjection(memories);
        const last = messages[messages.length - 1];
        if (last && last.role === "user") {
            if (typeof last.content === "string" || last.content == null) {
                last.content = (last.content || "") + "\n\n" + injectionText;
            } else if (Array.isArray(last.content)) {
                (last.content as any[]).push({ type: "text", text: injectionText });
            }
        } else {
            messages.push({ role: "user", content: injectionText });
        }
        for (const m of memories) {
            this.alreadySurfacedMemories.add(m.path);
            this.sessionMemoryBytes += Buffer.byteLength(m.content);
        }
    }

    // turn 边界调用（chat() 开头）：先排掉上一轮遗留的 prefetch——若它在上一轮
    // 最后一次 API 调用之后才落定，不排走就永久丢失；再为本轮发起新的召回。
    // 子 agent 跳过：记忆召回是主对话的机制，隔离子任务不该触发旁路查询
    private async startMemoryPrefetchForTurn(userMessage: string, messages: Anthropic.MessageParam[]): Promise<void> {
        if (this.isSubAgent) return;
        await this.consumeMemoryPrefetchIfReady(messages);
        const sq = this.buildSideQuery();
        this.memoryPrefetch = startMemoryPrefetch(
            userMessage, sq,
            this.alreadySurfacedMemories, this.sessionMemoryBytes,
        );
    }

    // ─── Prefix caching（Anthropic）────────────────────────────
    // system 拆成两个块：静态主体打 cache_control 断点（断点前的所有内容，
    // 含工具 schema，命中服务端前缀缓存）；动态上下文（环境 + memory 索引）
    // 放断点之后——模型写一条记忆索引就变，进了静态块等于每次写记忆都作废缓存
    private buildAnthropicSystem(): Anthropic.TextBlockParam[] {
        // 子 agent（customSystemPrompt）：整个 system 当静态块，dynamic 段是主对话的环境噪音
        const dynamicText = this.hasCustomPrompt ? "" : buildDynamicSystemContext().trim();
        const blocks: Anthropic.TextBlockParam[] = [
            { type: "text", text: this.staticSystemPrompt, cache_control: { type: "ephemeral" } },
        ];
        if (dynamicText) blocks.push({ type: "text", text: dynamicText });
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
        const content = this.messages.length === 0 && !this.hasCustomPrompt
            ? `${userText}\n\n${buildUserContextReminder()}`
            : userText;
        this.messages.push({ role: "user", content: content });
        // T4 在 turn 边界检查：此刻最后一条消息是纯 user 文本，compactAnthropic 的
        // slice 不变式才成立。放进 while 顶的话，工具轮的末尾是 tool_result——
        // 既会切坏配对，也会在任何 2+ 工具轮的对话里反复触发（ch14 真机发现 5）
        await this.checkAndCompact();
        // 语义召回：turn 边界发起异步 prefetch，不挡主循环；每轮请求前轮询一次，
        // selector 一落定立刻注入，模型尽早看到记忆
        await this.startMemoryPrefetchForTurn(userText, this.messages);
        if (!this.isSubAgent) await this.ensureMcp();
        const mcpTools: Anthropic.Tool[] = this.isSubAgent ? [] : this.mcpManager.getToolDefinitions();
        while (true) {
            // T1–T3 零成本层：每次发请求前过一遍（原地改写 this.messages）
            this.runCompressionPipeline();
            await this.consumeMemoryPrefetchIfReady(this.messages);
            if (!this.isSubAgent) startSpinner();
            let firstText = true;
            let response: Anthropic.Message;
            try {
                // withRetry 包住"建流 + 等完整消息"：重试时旧流已死，必须重建整个流，
                // 所以 fn 每次调用都 new 一个 stream，不能只包 finalMessage()
                response = await withRetry(async () => {
                    const stream = this.client.messages.stream({
                        model: MODEL,
                        max_tokens: 4096,
                        system: this.buildAnthropicSystem(),
                        tools: [...this.tools, ...mcpTools],
                        messages: this.withCacheBreakpoints(this.messages),
                    });
                    // src 同款协调：首个 text 事件先停 spinner 再打印，避免 \r 重画吃掉流式输出；
                    // 纯工具调用响应没有 text 事件，靠 finally 兜底
                    stream.on("text", (t) => {
                        if (!this.isSubAgent && firstText) { stopSpinner(); firstText = false; }
                        this.emitText(t);
                    });
                    return await stream.finalMessage();
                });
            } finally {
                if (!this.isSubAgent) stopSpinner();
            }
            this.emitText("\n");
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
            this.lastApiCallTime = Date.now();
            this.messages.push({ role: "assistant", content: response.content });
            
            const toolUses: Anthropic.ToolUseBlock[] = response.content.filter((b) => b.type === "tool_use");

            if (toolUses.length === 0) {
                if (!this.isSubAgent) {
                    printCost(this.totalInputTokens, this.totalOutputTokens, this.totalCacheReadTokens, this.totalCacheCreationTokens);
                    this.autoSave();
                }
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
                if (this.mode === "auto" && ["write_file", "edit_file", "run_shell"].includes(tu.name)) {
                    // auto 的闸门只有分类器，静态流水线不再叠加（对齐 src）
                    const verdict = await classifyAction(tu.name, tu.input as Record<string, any>, this.transcriptText(), this.client, MODEL);
                    if (!verdict.allow) {
                        toolResult.push({type: "tool_result", tool_use_id:tu.id, content: `Blocked by auto-mode monitor: ${verdict.reason}`});
                        continue;
                    }
                    const output = this.persistLargeResult(tu.name, await this.executeToolCall(tu.name, tu.input as Record<string, any>));
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
                const output = this.persistLargeResult(tu.name, await this.executeToolCall(tu.name, tu.input as Record<string, any>));
                toolResult.push({ type: "tool_result", tool_use_id: tu.id, content: output });
            }
            this.messages.push({ role: "user", content: toolResult });
        }
    }

    // ─── 工具分发（ch23 重构）：普通工具落 executeTool；agent/skill/mcp 走各自通道 ───

    private async executeToolCall(name: string, input: Record<string, any>): Promise<string> {
        if (name === "agent") return this.executeAgentTool(input);
        if (name === "skill") return this.executeSkillTool(input);
        if (name.startsWith("mcp__")) {
            // server 掉线/名字拆错等——作为 tool_result 回给模型自行处置，不在主循环里炸
            try {
                return await this.mcpManager.callTool(name, input);
            } catch (e: any) {
                return `Error: ${e.message ?? e}`;
            }
        }
        return executeTool(name, input, this.readFileState);
    }

    // ─── Sub-agent fork（ch23）────────────────────────────────

    // 权限模式子 agent 继承规则：plan/auto 必须穿透——否则主对话里被拦的操作可以
    // 借 agent(prompt="rm -rf /") 让 bypassPermissions 的子 agent 绕过闸门（权限洗白）。
    // 其余模式落 bypassPermissions：子 agent 的危险动作由父层工具集与白名单约束
    private childPermissionMode(): PermissionMode {
        if (this.mode === "plan") return "plan";
        if (this.mode === "auto") return "auto";
        return "bypassPermissions";
    }

    private async executeAgentTool(input: Record<string, any>): Promise<string> {
        const type = (input.type || "general") as SubAgentType;
        const description = input.description || "sub-agent task";
        const prompt = input.prompt || "";

        printSubAgentStart(type, description);

        const config = getSubAgentConfig(type);
        const subAgent = new Agent({
            customSystemPrompt: config.systemPrompt,
            customTools: config.tools,
            isSubAgent: true,
            permissionMode: this.childPermissionMode(),
        });

        try {
            const result = await subAgent.runOnce(prompt);
            // 子对话的消耗也是真实成本：token 增量记回父级，费用统计才完整
            this.totalInputTokens += result.tokens.input;
            this.totalOutputTokens += result.tokens.output;
            printSubAgentEnd(type, description);
            return result.text || "(Sub-agent produced no output)";
        } catch (e: any) {
            printSubAgentEnd(type, description);
            return `Sub-agent error: ${e.message}`;
        }
    }

    // skill 的双入口分流：fork 派给隔离子 agent（system=解析后模板，tools=白名单过滤
    // 父工具集）；inline 把解析后文本作为 tool_result 注入主对话，模型看到后照做
    private async executeSkillTool(input: Record<string, any>): Promise<string> {
        const { executeSkill } = await import("./skills.js");
        const result = executeSkill(input.skill_name, input.args || "");
        if (!result) return `Unknown skill: ${input.skill_name}`;

        if (result.context === "fork") {
            const tools = result.allowedTools
                ? this.tools.filter(t => result.allowedTools!.includes(t.name))
                : this.tools.filter(t => t.name !== "agent");

            printSubAgentStart("skill-fork", input.skill_name);
            const subAgent = new Agent({
                customSystemPrompt: result.prompt,
                customTools: tools,
                isSubAgent: true,
                permissionMode: this.childPermissionMode(),
            });

            try {
                const subResult = await subAgent.runOnce(input.args || "Execute this skill task.");
                this.totalInputTokens += subResult.tokens.input;
                this.totalOutputTokens += subResult.tokens.output;
                printSubAgentEnd("skill-fork", input.skill_name);
                return subResult.text || "(Skill produced no output)";
            } catch (e: any) {
                printSubAgentEnd("skill-fork", input.skill_name);
                return `Skill fork error: ${e.message}`;
            }
        }

        return `[Skill "${input.skill_name}" activated]\n\n${result.prompt}`;
    }

    // ─── 子 agent 入口：跑一次完整任务，回传最终文本 + token 增量（差值法）───

    async runOnce(prompt: string): Promise<{ text: string; tokens: { input: number; output: number } }> {
        this.outputBuffer = [];
        const prevInput = this.totalInputTokens;
        const prevOutput = this.totalOutputTokens;
        await this.chat(prompt);
        const text = this.outputBuffer.join("");
        this.outputBuffer = null;
        return {
            text,
            tokens: {
                input: this.totalInputTokens - prevInput,
                output: this.totalOutputTokens - prevOutput,
            },
        };
    }

    // 输出统一出口：主对话打印，子 agent 收进 buffer
    private emitText(text: string): void {
        if (this.outputBuffer) {
            this.outputBuffer.push(text);
        } else {
            printAssistantText(text);
        }
    }
}