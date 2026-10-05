import Anthropic from "@anthropic-ai/sdk";
import { toolDefinitions, type ToolDef } from "./tools.js";
import { ToolsService, getActiveToolDefinitions, truncateResult, type ToolDefinition, type TurnConclusion } from "./services/tools.js";
import type { ApprovalService } from "./services/approval.js";
import { SessionLog, type TokenUsage } from "./services/session-log.js";
import { Inbox, type AgentHandle, type AgentStatus, type PreStepDecision } from "./services/agents.js";
import { Context } from "./cordis/context.js";
import { coreFsTools } from "./plugins/core-fs-tools.js";
import { coreExecTools } from "./plugins/core-exec-tools.js";
import { coreMetaTools } from "./plugins/core-meta-tools.js";
import { approvalPlugin } from "./plugins/approval.js";
import { autoApprovalPlugin } from "./plugins/auto-approval.js";
import { goalPlugin, GoalService } from "./plugins/autonomy.js";
import { buildStaticSystemPrompt, buildDynamicSystemContext, buildUserContextReminder, loadClaudeMd } from "./prompt.js";
import { type PermissionMode } from "./permissions.js";
import { startMemoryPrefetch, formatMemoriesForInjection, type MemoryPrefetch, type SideQueryFn } from "./memory.js";
import { getSubAgentConfig, type SubAgentType } from "./subagent.js";
import { McpManager } from "./mcp.js";
import { withRetry } from "./retry.js";
import {
    goalDirective, GOAL_EVALUATOR_SYSTEM, GOAL_TRANSCRIPT_FRAMING, goalJudgeUserMessage,
    parseGoalVerdict, type GoalVerdict,
    parseLoopInput, isDailyWording, OFFER_CLOUD_THRESHOLD_SECONDS,
    SCHEDULE_WAKEUP_TOOL, clampWakeupDelay, dynamicLoopDirective, LOOP_MAX_ITERATIONS, type LoopSpec,
    loadAutoModeRules, buildClassifierSystem, buildClassifierTranscript, classifierUserMessage,
    parseBlockVerdict, AUTO_MODE_FAST_PATH_TOOLS, DENIAL_LIMITS,
} from "./autonomy.js";
import { saveSession } from "./session.js";
import { randomUUID } from "crypto";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { printToolCall, printAssistantText, printInfo, printError, printConfirmation, printCost, printSubAgentStart, printSubAgentEnd, startSpinner, stopSpinner } from "./ui.js";

const MODEL = process.env.ANTHROPIC_MODEL_ID || "glm-4.7-flash";

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

function isAbortLike(e: unknown): boolean {
    const err = e as { name?: string; message?: string };
    return err?.name === "AbortError" || String(err?.message ?? "").includes("aborted");
}

export interface AgentOptions {
    permissionMode?: PermissionMode;
    // 子 agent 三件套：整个 system 视为静态块（跳过 dynamic 段与首条消息 reminder）、
    // 裁剪过的工具集、行为开关（不连 MCP、不 autoSave、不打 spinner/cost）
    customSystemPrompt?: string;
    customTools?: ToolDef[];
    isSubAgent?: boolean;
}

export class Agent implements AgentHandle {
    private client: Anthropic;
    private messages: Anthropic.MessageParam[] = [];
    private mode: PermissionMode = "default";
    private tools: ToolDef[];
    // C1：每个 Agent 一棵 mini-cordis 树，工具注册表长在上面；
    // 后续 C 阶段服务（session-log/llm/approval）逐章挂进同一棵树
    private cordis: Context;
    // C3：会话事件日志——追加镜像 + 纯投影。线上工作集 this.messages 仍是请求
    // 体来源（压缩 T1–T4 原地改写它），日志与工作集的发散点即 D5 投影 replace 的缝
    private sessionLog: SessionLog;
    // C4：handle 面与 inbox 驱动——输入是数据，认领发生在循环边界
    readonly inbox: Inbox = new Inbox();
    private statusValue: AgentStatus = "idle";
    private driverPromise: Promise<void> | null = null;
    private idleWaiters: Array<() => void> = [];
    private staticSystemPrompt: string;
    private hasCustomPrompt: boolean;
    private isSubAgent: boolean;
    // 子 agent 的最终文本收进 buffer 而非打印，runOnce 拼出来回传父级
    private outputBuffer: string[] | null = null;
    private mcpManager = new McpManager();
    private readFileState: Map<string, number> = new Map();
    private confirmFn?: (message: string) => Promise<boolean>;

    // prePlanMode 记住进入前的模式——退出时精确恢复（acceptEdits 进 plan，
    // 出来还是 acceptEdits，而不是掉回 default）
    private prePlanMode: PermissionMode | null = null;
    private planFilePath: string | null = null;
    // 审批回调由 CLI/测试注入——Agent 类不依赖具体 UI（readline/对话框/测试桩）。
    // 子 agent 没有回调，exit 走 fallback 直接恢复原模式
    private planApprovalFn?: (planContent: string) => Promise<{
        choice: "clear-and-execute" | "execute" | "manual-execute" | "keep-planning";
        feedback?: string;
    }>;
    private sessionId: string = randomUUID().slice(0, 8);
    private sessionStartTime: string = new Date().toISOString();

    // token 四计数：缓存读/写单列——input_tokens 只算未命中前缀，
    // cache_read 按 0.1x、cache_creation 按 1.25x 计费，混在一起费用就是错的
    private totalInputTokens = 0;
    private totalOutputTokens = 0;
    private totalCacheReadTokens = 0;
    private totalCacheCreationTokens = 0;
    // 下一次请求的上下文体量预估（本次 prompt 全量 + 本次输出），压缩仪表的原料
    private lastInputTokenCount = 0;
    private currentTurns = 0;
    private maxCostUsd: number | null = null;
    private maxTurns: number | null = null;
    // 压缩仪表：最近一次 API 调用时刻——T2/T3 用它判断缓存冷热
    private lastApiCallTime = 0;

    // transcript 分类器的 DENIAL_LIMITS 追踪：连拦 3 次或累计 20 次 → 分类器
    // 可能卡死在拒绝循环，降级回人工确认（或无人值守拒绝）
    private autoConsecutiveDenials = 0;
    private autoTotalDenials = 0;
    // 中断支持：SIGINT 处理器经 cancel() 收口（busy 判忙），abort 在途 API 请求
    private abortController: AbortController | null = null;
    // 有效窗口 = 上下文窗口 - 20000 安全边际（给摘要请求本身和系统块留余量）
    private effectiveWindow: number;
    // 语义召回：prefetch 句柄 + 防重复注入簿记（按记忆文件绝对路径）
    private memoryPrefetch: MemoryPrefetch | null = null;
    private alreadySurfacedMemories: Set<string> = new Set();
    private sessionMemoryBytes = 0;

    // /loop dynamic——模型调 schedule_wakeup 时写入，loop 驱动在 turn 收敛后读取并清空
    private pendingWakeup: { delaySeconds: number; reason: string; prompt: string } | null = null;
    private loopStop = false; // 中断时置位，跳出运行中的 loop
    // schedule_wakeup 只在 dynamic loop 活跃期间路由到内部执行器——
    // 防止裸调或同名外部工具
    private scheduleWakeupEnabled = false;

    constructor(options: AgentOptions = {}) {
        this.mode = options.permissionMode || "default";
        this.isSubAgent = options.isSubAgent || false;
        // C1：起容器树 → ToolsService 先行（三插件依赖它）→ 按序加载工具插件
        //（注册序 = 旧 toolDefinitions 数组序，请求体 tools 数组顺序的生命线）
        this.cordis = new Context();
        new ToolsService(this.cordis, "tools");
        this.sessionLog = new SessionLog(this.cordis, "session-log");
        this.cordis.plugin(coreFsTools);
        this.cordis.plugin(coreExecTools);
        this.cordis.plugin(coreMetaTools);
        // C2：权限策略插件化。注册序 = waterfall 优先级：approval 在外层
        // （deny 规则硬底线 + 九段静态流水线），auto 在内层（veto 链表达"auto 优先"）
        this.cordis.plugin(approvalPlugin);
        this.cordis.plugin(autoApprovalPlugin);
        // C5 第二段：goal 追逐迁 turn-stopping 监听器（plugins/autonomy.ts）。
        // 桥 = 评估器与预算检查（C6 llm 服务落地后收窄）
        this.cordis.plugin(goalPlugin, {
            evaluate: (condition: string) => this.evaluateGoal(condition),
            getBudget: () => this.checkBudget(),
        });
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
        // --plan 启动即规划：plan 文件路径在此生成，提示注入走请求时的
        // buildAnthropicSystem() planSuffix（本类没有常驻 systemPrompt 字段）
        if (this.mode === "plan") {
            this.planFilePath = this.generatePlanFilePath();
        }
    }

    history(): Anthropic.MessageParam[] {
        return this.messages;
    }

    loadHistory(messages: Anthropic.MessageParam[]): void {
        this.messages = messages;
        this.sessionLog.load(messages); // 回放：消息数组 → 事件流
    }

    clearHistory(): void {
        this.messages = [];
        this.sessionLog.clear();
    }

    // ---------- C3：消息操作统一入口（工作集 + 日志双写） ----------

    /**
     * user 消息入栈。连续 user 合并的双侧镜像：日志侧在 SessionLog.append 入口，
     * 工作集侧在这里——两边用同一套合并语义（字符串拼接 / tool_result 批次追加
     * text 块），与迁移前 chat() 的行为逐字节一致。
     */
    private pushUser(content: string | Anthropic.ToolResultBlockParam[]): void {
        const last = this.messages[this.messages.length - 1];
        if (last && last.role === "user") {
            if (typeof last.content === "string" || last.content == null) {
                last.content = last.content ? `${last.content}\n\n${content}` : content;
            } else {
                (last.content as any[]).push({ type: "text", text: content });
            }
            this.sessionLog.append({ type: "user/message", content });
        } else {
            this.messages.push({ role: "user", content } as Anthropic.MessageParam);
            this.sessionLog.append({ type: "user/message", content });
        }
    }

    private pushAssistant(content: Anthropic.ContentBlockParam[], usage?: TokenUsage): void {
        this.messages.push({ role: "assistant", content });
        this.sessionLog.append({ type: "assistant/message", content, usage });
    }

    /** 日志投影（C5+ 与测试消费；D5 压缩投影 replace 接管请求组装的入口）。 */
    deriveSession(): { system: Anthropic.TextBlockParam[]; messages: Anthropic.MessageParam[] } {
        return this.sessionLog.derive();
    }

    setMode(mode: PermissionMode): void {
        this.mode = mode;
        this.sessionLog.append({ type: "meta/note", key: "mode", value: mode });
    }

    setPlanApprovalFn(fn: (planContent: string) => Promise<{
        choice: "clear-and-execute" | "execute" | "manual-execute" | "keep-planning";
        feedback?: string;
    }>): void {
        this.planApprovalFn = fn;
    }

    // REPL /plan 入口：对称的进出切换。进入时生成 plan 文件；plan 提示不在这里
    // 拼——请求时 buildAnthropicSystem() 按 mode 现算，省掉一份常驻 systemPrompt
    togglePlanMode(): string {
        if (this.mode === "plan") {
            this.mode = this.prePlanMode || "default";
            this.prePlanMode = null;
            this.planFilePath = null;
            printInfo(`Exited plan mode → ${this.mode} mode`);
            return this.mode;
        }
        this.prePlanMode = this.mode;
        this.mode = "plan";
        this.planFilePath = this.generatePlanFilePath();
        printInfo(`Entered plan mode. Plan file: ${this.planFilePath}`);
        return "plan";
    }

    // plan 文件按会话 ID 落盘（clear-and-execute 清掉历史后，磁盘上还有底稿可读；
    // 也方便用户跨会话翻看历史方案）。目录用 my_src 自己的 ~/.mini-claude 命名空间
    private generatePlanFilePath(): string {
        const dir = join(homedir(), ".mini-claude", "plans");
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
        return join(dir, `plan-${this.sessionId}.md`);
    }

    private buildPlanModePrompt(): string {
        return `

# Plan Mode Active

Plan mode is active. You MUST NOT make any edits (except the plan file below), run non-readonly tools, or make any changes to the system.

## Plan File: ${this.planFilePath}
Write your plan incrementally to this file using write_file or edit_file. This is the ONLY file you are allowed to edit.

## Workflow
1. **Explore**: Read code to understand the task. Use read_file, list_files, grep_search.
2. **Design**: Design your implementation approach. Use the agent tool with type="plan" if the task is complex.
3. **Write Plan**: Write a structured plan to the plan file including:
   - **Context**: Why this change is needed
   - **Steps**: Implementation steps with critical file paths
   - **Verification**: How to test the changes
4. **Exit**: Call exit_plan_mode when your plan is ready for user review.

IMPORTANT: When your plan is complete, you MUST call exit_plan_mode. Do NOT ask the user to approve — exit_plan_mode handles that.`;
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

    /** REPL /cost 入口：token 四计数 + 估算费用 + 预算余量 + 缓存命中率。 */
    showCost(): void {
        const total = this.getCurrentCostUsd();
        const budgetInfo = this.maxCostUsd !== null ? ` / $${this.maxCostUsd} budget` : "";
        const turnInfo = this.maxTurns !== null ? ` | Turns: ${this.currentTurns}/${this.maxTurns}` : "";
        const cached = this.totalCacheReadTokens;
        const billedInput = this.totalInputTokens + this.totalCacheCreationTokens + cached;
        const hitRate = billedInput > 0 ? Math.round((cached / billedInput) * 100) : 0;
        const cacheInfo = (cached || this.totalCacheCreationTokens)
            ? `\n  Cache: ${cached} read / ${this.totalCacheCreationTokens} write (${hitRate}% of input from cache)`
            : "";
        printInfo(
            `Tokens: ${this.totalInputTokens} in / ${this.totalOutputTokens} out${cacheInfo}\n  Estimated cost: $${total.toFixed(4)}${budgetInfo}${turnInfo}`
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

    // 仪表：utilization = lastInputTokenCount / effectiveWindow
    // 调用点已接好：T1–T3 走 runCompressionPipeline()（每次发请求前），
    // T4 走 checkAndCompact()（turn 边界：用户消息刚 push、循环未开始）。

    // 组装层：顺序即语义。
    runCompressionPipeline(): void {
        this.budgetToolResults();
        this.snipStaleResults();
        this.microcompact();
    }

    // ── T1 budget：把超大 tool_result 掐头去尾缩进预算。零 API 成本，无缓存门控
    //    （它只处理大块头——那种结果留着必溢出，缩了顶多重建一次缓存）。
    private budgetToolResults(): void {
        const utilization = this.lastInputTokenCount / this.effectiveWindow;
        if (utilization < 0.5) return; // 上下文过半才开始管
        const budget = utilization > 0.7 ? 15000 : 30000; // 越满预算越紧

        for (const msg of this.messages) {
            if (msg.role !== "user" || !Array.isArray(msg.content)) continue;
            for (let i = 0; i < msg.content.length; i++) {
                const block = msg.content[i] as any;
                if (block.type === "tool_result" && typeof block.content === "string" && block.content.length > budget) {
                    const keepEach = Math.floor((budget - 80) / 2); // 减 80：给中间的截断提示文案留位
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
            const compacted = await this.compactAnthropic();
            if (compacted) printInfo("Conversation compacted.");
        }
    }

    // user/assistant 交替 + tool_use/tool_result 配对，摘要请求的形状随末条消息的形态分三种边界：
    // ① 纯文本 user（T4 turn 边界的正常形态）→ 摘出末条，摘要指令顶替它，重建时塞回；
    // ② 无 tool_use 的 assistant（REPL /compact 的正常形态——turn 收敛时末条 assistant
    //    必无 tool_use）→ 摘要指令直接追加，合法且配对完整；
    // ③ 带 tool_result 的 user（budget 超限截停态）→ 非法边界：slice 会孤儿化前面的
    //    tool_use（400），追加又造出连续 user（400）——跳过，宁少压一次再等下轮
    async compactAnthropic(): Promise<boolean> {
        if (this.messages.length < 4) return false; // 太短的对话不值得摘要
        const tail = this.messages[this.messages.length - 1];
        const tailHasToolUse = Array.isArray(tail.content) &&
            (tail.content as any[]).some((b: any) => b.type === "tool_use");
        const SUMMARIZE_INSTRUCTION = "Summarize the conversation so far in a concise paragraph, preserving key decisions, file paths, and context needed to continue the work.";
        let requestMessages: Anthropic.MessageParam[];
        let carryTail: boolean;
        if (tail.role === "user" && typeof tail.content === "string") {
            requestMessages = [...this.messages.slice(0, -1), { role: "user", content: SUMMARIZE_INSTRUCTION }];
            carryTail = true;
        } else if (tail.role === "assistant" && !tailHasToolUse) {
            requestMessages = [...this.messages, { role: "user", content: SUMMARIZE_INSTRUCTION }];
            carryTail = false;
        } else {
            // ③ 或未知形态——fail-closed：不发注定非法的摘要请求
            printInfo("Cannot compact here: history ends mid-tool-batch. Try again after the next exchange.");
            return false;
        }
        const summaryResp = await this.client.messages.create({
            model: MODEL,
            max_tokens: 2048,
            system: "You are a conversation summarizer. Be concise but preserve important details.",
            messages: requestMessages,
        });
        const summaryText =
            summaryResp.content[0]?.type === "text"
                ? summaryResp.content[0].text
                : "No summary available.";
        this.messages = [
            { role: "user", content: `[Previous conversation summary]\n${summaryText}` },
            { role: "assistant", content: "Understood. I have the context from our previous conversation. How can I continue helping?" },
        ];
        if (carryTail) this.messages.push(tail);
        this.lastInputTokenCount = 0;
        return true;
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

    // REPL 注入复用已有 readline 的确认回调。双写：confirmFn 留在本类供
    // autoFallback 的 headless 判定；同时包装成审批服务的 interactive provider
    //（展示职责在 provider 里——问什么先打出来，回调只收 y/n）
    setConfirmFn(fn: (message: string) => Promise<boolean>): void {
        this.confirmFn = fn;
        const approval = this.cordis.get<ApprovalService>("approval");
        approval?.setInteractiveProvider(async (_call, message) => {
            printConfirmation(message);
            return (await fn(message)) ? "allow-once" : "deny";
        });
    }

    restoreSession(data: { anthropicMessages?: any[] }): void {
        if (data.anthropicMessages) this.loadHistory(data.anthropicMessages);
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
        } catch { }
    }

    private async ensureMcp(): Promise<void> {
        // loadAndConnect 幂等：已连/无配置时是 no-op
        await this.mcpManager.loadAndConnect();
    }

    // MCP 子进程 stdio 会挂住事件循环，one-shot/测试结束必须显式关闭
    async close(): Promise<void> {
        await this.mcpManager.disconnectAll();
    }

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

    // system 拆成两个块：静态主体打 cache_control 断点（断点前的所有内容，
    // 含工具 schema，命中服务端前缀缓存）；动态上下文（环境 + memory 索引）
    // 放断点之后——模型写一条记忆索引就变，进了静态块等于每次写记忆都作废缓存
    private buildAnthropicSystem(): Anthropic.TextBlockParam[] {
        // plan 提示进动态尾巴：进出 plan 模式它就变，混进静态块等于每次进出
        // plan 都作废一次前缀缓存
        const planSuffix = this.mode === "plan" ? this.buildPlanModePrompt() : "";
        // 子 agent（customSystemPrompt）：整个 system 当静态块，dynamic 段是主对话的环境噪音
        const dynamicText = ((this.hasCustomPrompt ? "" : buildDynamicSystemContext()) + planSuffix).trim();
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

    /** 设定活跃 goal 并返回首轮指令（设定 goal 本身就开启一个 turn）。
     *  状态在 ctx.goal 服务；追逐决策在 goal 插件的 turn-stopping 监听器。 */
    setGoal(condition: string): string {
        this.cordis.require<GoalService>("goal").set(condition);
        printInfo(`◎ /goal active — Stop hook condition: "${condition}"`);
        return goalDirective(condition);
    }

    /** /goal 无参数：打印当前 goal 状态。 */
    showGoal(): void {
        const goal = this.cordis.get<GoalService>("goal")?.active;
        if (!goal) {
            printInfo("No active goal. Set one with /goal <condition>.");
            return;
        }
        const secs = ((Date.now() - goal.startedAt) / 1000).toFixed(1);
        const last = goal.lastReason ? `\n  last reason: ${goal.lastReason}` : "";
        printInfo(
            `◎ /goal active\n  condition: ${goal.condition}\n  iterations: ${goal.iterations}\n  elapsed: ${secs}s${last}`
        );
    }

    /** goal 入口：首 turn + 收尾（C5 第二段起）。追逐逻辑在 goal 插件的
     *  turn-stopping 监听器——未达 steer 回灌续命、met/impossible/预算/迭代
     *  上限停机。abort（SIGINT）绕过 turn-stopping，finally 统一清状态——
     *  stale goal 不能留着（旧版同一纪律）。 */
    async pursueGoal(directive: string): Promise<void> {
        const goal = this.cordis.require<GoalService>("goal");
        if (!goal.active) return;
        try {
            await this.chat(directive);
            if (goal.stopped) printInfo("Goal pursuit interrupted.");
        } finally {
            goal.clear();
        }
    }

    /** 对刚结束的 turn 做一次评估。transcript 以独立 assistant 消息发送
     *  （前置 framing user 消息把它定性为数据）——被评审的 turn 无法伪造
     *  user/judge 文本混进评估上下文，这是防注入的关键。 */
    private async evaluateGoal(condition: string): Promise<GoalVerdict> {
        const transcript = this.extractLastAssistantText();
        const messages = [
            { role: "user" as const, content: GOAL_TRANSCRIPT_FRAMING },
            { role: "assistant" as const, content: transcript || "(no assistant output)" },
            { role: "user" as const, content: goalJudgeUserMessage(condition) },
        ];
        try {
            const raw = await this.runEvaluatorQuery(GOAL_EVALUATOR_SYSTEM, messages);
            return parseGoalVerdict(raw);
        } catch (e: any) {
            // 评估器出错 → 按未达处理（fail-closed，绝不能误清 goal）
            return { ok: false, reason: `evaluator error: ${e?.message ?? e}` };
        }
    }

    /** 角色分离的评估器查询，返回模型文本。与 buildSideQuery 的差别：收完整
     *  messages 数组（buildSideQuery 是单 user 消息，供 memory 召回用）。 */
    private async runEvaluatorQuery(
        system: string,
        messages: { role: "user" | "assistant"; content: string }[],
    ): Promise<string> {
        const resp = await this.client.messages.create({
            model: MODEL, max_tokens: 512, system, temperature: 0, messages,
        });
        return resp.content
            .filter((b): b is Anthropic.TextBlock => b.type === "text")
            .map((b) => b.text).join("");
    }

    /** 最近一条 assistant turn 的文本，供评审。 */
    private extractLastAssistantText(): string {
        for (let i = this.messages.length - 1; i >= 0; i--) {
            const m: any = this.messages[i];
            if (m.role !== "assistant") continue;
            if (typeof m.content === "string") return m.content;
            if (Array.isArray(m.content)) {
                return m.content
                    .filter((b: any) => b.type === "text")
                    .map((b: any) => b.text)
                    .join("");
            }
        }
        return "";
    }

    // /goal 是被动闸门（每轮评估），/loop 相反：主动自排程。/goal 决定
    // *要不要*继续，/loop 决定*何时*开下一轮——固定间隔，或主模型经
    // schedule_wakeup 自选节奏。

    /** /loop 入口：解析输入，然后驱动对应模式。输入非法时直接返回。 */
    async runLoop(rawInput: string): Promise<void> {
        const spec = parseLoopInput(rawInput);
        if ("error" in spec) {
            printInfo(spec.error);
            return;
        }
        // 云排程决策点（间隔 ≥60min 或 daily 措辞）——教学版只提示不实现
        const wantsCloud =
            (spec.mode === "interval" && spec.intervalSeconds! >= OFFER_CLOUD_THRESHOLD_SECONDS) ||
            isDailyWording(rawInput);
        if (wantsCloud) {
            printInfo("(Real Claude Code would offer to convert this to a persistent cloud schedule that keeps running after the session ends. This teaching build has no cloud backend — continuing in-session.)");
        }

        this.loopStop = false;
        if (spec.mode === "interval") {
            await this.runLoopInterval(spec);
        } else {
            await this.runLoopDynamic(spec);
        }
    }

    /** interval 模式：每 N 秒重跑 prompt，直到中断或迭代上限。 */
    private async runLoopInterval(spec: LoopSpec): Promise<void> {
        printInfo(`⟳ /loop scheduled every ${spec.intervalLabel} (session-only, not persisted — dies when this process exits). Ctrl+C to stop.`);
        let iterations = 0;
        while (!this.loopStop) {
            iterations++;
            printInfo(`⟳ loop tick ${iterations}`);
            await this.chat(spec.prompt);

            const budget = this.checkBudget();
            if (budget.exceeded) { printInfo(`Loop stopped: ${budget.reason}`); break; }
            // --max-turns 同时约束 loop tick：checkBudget 的轮计数只在工具轮增长，
            // 纯文本循环永远撞不到它——这里把 --max-turns 当 tick 上限用
            if (this.maxTurns !== null && iterations >= this.maxTurns) {
                printInfo(`Loop stopped: tick limit reached (${iterations} >= ${this.maxTurns}).`);
                break;
            }
            if (iterations >= LOOP_MAX_ITERATIONS) {
                printInfo(`Loop stopped: reached ${LOOP_MAX_ITERATIONS} ticks.`);
                break;
            }
            if (await this.interruptibleSleep(spec.intervalSeconds! * 1000)) { printInfo("Loop stopped."); break; }
        }
    }

    /** dynamic 模式：跑一轮 tick，然后主模型经 schedule_wakeup 自排。
     *  排了唤醒→等（钳过的）延迟，用它回传的 prompt 再跑；没排→收敛。
     *  schedule_wakeup 只在 loop 期间暴露，退出时摘掉。 */
    private async runLoopDynamic(spec: LoopSpec): Promise<void> {
        printInfo("⟳ /loop dynamic (self-paced) — the model schedules its own next run, or ends the loop. Ctrl+C to stop.");
        const hadTool = this.tools.some(t => t.name === "schedule_wakeup");
        if (!hadTool) this.tools = [...this.tools, SCHEDULE_WAKEUP_TOOL];
        this.scheduleWakeupEnabled = true;
        let prompt = spec.prompt;
        let iterations = 0;
        try {
            while (!this.loopStop) {
                iterations++;
                this.pendingWakeup = null;
                await this.chat(dynamicLoopDirective(prompt));

                if (!this.pendingWakeup) {
                    printInfo(`⟳ Loop converged after ${iterations} tick${iterations === 1 ? "" : "s"} (model scheduled no wakeup).`);
                    break;
                }
                const budget = this.checkBudget();
                if (budget.exceeded) { printInfo(`Loop stopped: ${budget.reason}`); break; }
                if (this.maxTurns !== null && iterations >= this.maxTurns) {
                    printInfo(`Loop stopped: tick limit reached (${iterations} >= ${this.maxTurns}).`);
                    break;
                }
                if (iterations >= LOOP_MAX_ITERATIONS) {
                    printInfo(`Loop stopped: reached ${LOOP_MAX_ITERATIONS} ticks.`);
                    break;
                }
                const { delaySeconds, reason, prompt: nextPrompt } = this.pendingWakeup;
                printInfo(`⟳ next run in ${delaySeconds}s — ${reason}`);
                prompt = nextPrompt || prompt;
                if (await this.interruptibleSleep(delaySeconds * 1000)) { printInfo("Loop stopped."); break; }
            }
        } finally {
            // schedule_wakeup 摘掉，别在 loop 之外继续暴露
            if (!hadTool) this.tools = this.tools.filter(t => t.name !== "schedule_wakeup");
            this.scheduleWakeupEnabled = false;
            this.pendingWakeup = null;
        }
    }

    /** schedule_wakeup 执行器：把请求的唤醒记下来，loop 驱动在 turn 收敛后读取。
     *  延迟钳到 [60, 3600]。 */
    private executeScheduleWakeup(input: Record<string, any>): string {
        const delaySeconds = clampWakeupDelay(Number(input.delaySeconds));
        const reason = typeof input.reason === "string" ? input.reason : "";
        const prompt = typeof input.prompt === "string" ? input.prompt : "";
        this.pendingWakeup = { delaySeconds, reason, prompt };
        return `Wakeup scheduled in ${delaySeconds}s. The loop will resume then; end your turn now.`;
    }

    /** 可中断睡眠：loopStop 置位时提前返回 true，避免中断后还干等长间隔。 */
    private interruptibleSleep(ms: number): Promise<boolean> {
        return new Promise((resolve) => {
            const start = Date.now();
            const tick = () => {
                if (this.loopStop) return resolve(true);
                if (Date.now() - start >= ms) return resolve(false);
                setTimeout(tick, Math.min(200, ms));
            };
            tick();
        });
    }

    /** 停止运行中的 /loop（REPL 中断处理调用）。 */
    stopLoop(): void {
        this.loopStop = true;
    }

    /** 停止运行中的 /goal（REPL 中断处理经 cancel 调用；监听器见到标志不再续命）。 */
    stopGoal(): void {
        this.cordis.get<GoalService>("goal")?.stop();
    }

    // ---------- C4：handle 面与 inbox 驱动 ----------

    /** handle 身份：注册表 key（AgentRegistry.create 用）。 */
    get id(): string {
        return this.sessionId;
    }

    get status(): AgentStatus {
        return this.statusValue;
    }

    /** REPL SIGINT 判忙（含 maintenance 相位——比旧 isProcessing 覆盖更早的窗口）。 */
    get busy(): boolean {
        return this.statusValue !== "idle";
    }

    async send(text: string): Promise<void> {
        if (this.statusValue === "idle") return this.followup(text);
        this.inbox.append("next-step", text);
        return this.ensureDriver();
    }

    async followup(text: string): Promise<void> {
        this.inbox.append("next-turn", text);
        return this.ensureDriver();
    }

    steer(text: string): void {
        this.inbox.append("next-step", text);
        if (this.statusValue === "idle") {
            // 无 awaiter 的驱动：错误在此兜底（abort 静默——SIGINT 语义，不刷屏）
            void this.ensureDriver().catch((e) => {
                if (!isAbortLike(e)) printError(`Agent driver error: ${e instanceof Error ? e.message : String(e)}`);
            });
        }
    }

    whenIdle(): Promise<void> {
        if (this.statusValue === "idle") return Promise.resolve();
        return new Promise((resolve) => this.idleWaiters.push(resolve));
    }

    /** SIGINT 收口：停 loop/goal 标志、清 inbox（dsh 默认——打断后的下一条输入
     *  获得干净上下文，旧插话不再暗处生效）、abort 在途请求。settle 以 abort
     *  错误 reject 给 awaiter（保持旧 chat() 的抛错语义）。 */
    cancel(_cause?: unknown): void {
        this.stopLoop();
        this.stopGoal();
        this.inbox.clear();
        this.abortController?.abort();
    }

    /** 兼容入口（goal/loop/subagent/one-shot 沿用）：followup + await settle。 */
    async chat(userText: string): Promise<void> {
        await this.followup(userText);
    }

    private setStatus(s: AgentStatus): void {
        this.statusValue = s;
        if (s === "idle") {
            const waiters = this.idleWaiters;
            this.idleWaiters = [];
            for (const w of waiters) w();
        }
    }

    /** turn 真实收敛的统一出口：注记 + cordis 事件（tool-use 是 step 级标记，
     *  只进注记不走这里）。 */
    private endTurn(reason: string): void {
        this.sessionLog.append({ type: "turn/end", reason });
        this.cordis.emit("agent/turn-end", { reason });
    }

    private ensureDriver(): Promise<void> {
        if (!this.driverPromise) {
            this.setStatus("running");
            this.driverPromise = this.runDriver().finally(() => {
                this.driverPromise = null;
            });
        }
        return this.driverPromise;
    }

    /** 唤醒循环：排空 inbox 即收敛（drain-at-convergence——dsh 用 wake/latch，
     *  等价性论证见 dsh-C4.md 第 3 节）。abort：补 turn/end 注记（C8 重放的
     *  start/end 配对）后向上抛，settle 的 awaiter 拿到与旧 chat() 相同的语义。 */
    private async runDriver(): Promise<void> {
        try {
            while (this.inbox.hasPending) {
                const batch = this.inbox.claimTurn();
                if (batch.length === 0) break;
                await this.runOneTurn(batch);
            }
            this.setStatus("idle");
        } catch (e) {
            if (isAbortLike(e)) this.endTurn("aborted");
            this.setStatus("idle");
            throw e;
        }
    }

    /** 一个 turn：旧 chat() 的开场（maintenance 相位）+ step 循环（running 相位）。 */
    private async runOneTurn(batch: string[]): Promise<void> {
        // pre-step（turn 首步形态）：组装前可改写/拒绝。拒绝 → 本 turn 不消耗
        // 模型调用直接收敛（dsh：blocked；输入已 claim，不回队列不进消息）
        const decision = await this.cordis.waterfall(
            "agent/pre-step",
            { input: batch },
            (): PreStepDecision => ({ input: batch }),
        );
        if (decision.reject !== undefined) {
            this.endTurn("blocked");
            return;
        }
        for (const text of decision.input ?? batch) {
            // 环境 reminder 只进主对话首条消息——子 agent 有自己的 system，不掺和。
            // 连续 user 的合并在 pushUser（工作集）与 SessionLog.append（日志）双侧镜像
            const content = this.messages.length === 0 && !this.hasCustomPrompt
                ? `${text}\n\n${buildUserContextReminder()}`
                : text;
            this.pushUser(content);
        }
        this.setStatus("maintenance");
        // T4 在 turn 边界检查：此刻最后一条消息是纯 user 文本，compactAnthropic 的
        // slice 不变式才成立。放进 step 循环顶的话，工具轮的末尾是 tool_result——
        // 既会切坏配对，也会在任何 2+ 工具轮的对话里反复触发
        await this.checkAndCompact();
        // 语义召回：turn 边界发起异步 prefetch，不挡主循环；每轮请求前轮询一次，
        // selector 一落定立刻注入，模型尽早看到记忆
        await this.startMemoryPrefetchForTurn(batch.join("\n\n"), this.messages);
        if (!this.isSubAgent) await this.ensureMcp();
        const mcpTools: Anthropic.Tool[] = this.isSubAgent ? [] : this.mcpManager.getToolDefinitions();
        this.setStatus("running");
        // abort 生命周期覆盖整个 turn（请求 + 工具执行）
        this.abortController = new AbortController();
        try {
            await this.runStepLoop(mcpTools);
        } finally {
            this.abortController = null;
        }
    }

    /** step 循环（旧 runAgentLoop）：一次请求为一个 step，直到模型不再调用工具。
     *  step 边界认领 next-step 插话，经 pushUser 以 text 块并进 tool_result 批次
     *  （C3 合并器语义——此刻新开 user 消息即连续同角色 400）。 */
    private async runStepLoop(mcpTools: Anthropic.Tool[]): Promise<void> {
        let firstStep = true;
        while (true) {
            if (!firstStep) {
                const steers = this.inbox.claimStep();
                if (steers.length > 0) {
                    // pre-step（step 边界形态）：拒绝只丢插话、step 照常（与 turn
                    // 首步的"整 turn 收敛"不同——mini 简化，偏差记 dsh-C5.md §2）
                    const steerDecision = await this.cordis.waterfall(
                        "agent/pre-step",
                        { input: steers },
                        (): PreStepDecision => ({ input: steers }),
                    );
                    if (steerDecision.reject === undefined) {
                        for (const steerText of steerDecision.input ?? steers) this.pushUser(steerText);
                    }
                }
            }
            firstStep = false;
            this.sessionLog.append({ type: "turn/start" });
            // T1–T3 零成本层：每次发请求前过一遍（原地改写 this.messages）
            this.runCompressionPipeline();
            await this.consumeMemoryPrefetchIfReady(this.messages);
            if (!this.isSubAgent) startSpinner();
            let firstText = true;
            let response: Anthropic.Message;
            // C3：system 进日志（对比去重——动态段未变不重复 append）。
            // 日志里可能有历史 system 事件，derive 只取最新
            const systemBlocks = this.buildAnthropicSystem();
            const encodedSystem = JSON.stringify(systemBlocks);
            if (this.sessionLog.peekLastSystem() !== encodedSystem) {
                this.sessionLog.append({ type: "system/message", content: encodedSystem });
            }
            try {
                // withRetry 包住"建流 + 等完整消息"：重试时旧流已死，必须重建整个流，
                // 所以 fn 每次调用都 new 一个 stream，不能只包 finalMessage()
                response = await withRetry(async () => {
                    const stream = this.client.messages.stream({
                        model: MODEL,
                        max_tokens: 4096,
                        system: systemBlocks,
                        tools: [...getActiveToolDefinitions(this.tools), ...mcpTools],
                        messages: this.withCacheBreakpoints(this.messages),
                    }, { signal: this.abortController?.signal });
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
            // （输出会成为下一次请求的一部分），压缩仪表读它
            const u: any = response.usage;
            const cacheRead = u.cache_read_input_tokens || 0;
            const cacheCreation = u.cache_creation_input_tokens || 0;
            this.totalInputTokens += u.input_tokens;
            this.totalCacheReadTokens += cacheRead;
            this.totalCacheCreationTokens += cacheCreation;
            this.totalOutputTokens += u.output_tokens;
            this.lastInputTokenCount = u.input_tokens + cacheRead + cacheCreation + u.output_tokens;
            this.lastApiCallTime = Date.now();
            const usage: TokenUsage = {
                input: u.input_tokens,
                output: u.output_tokens,
                cacheRead,
                cacheCreation,
            };
            this.pushAssistant(response.content, usage);

            const toolUses: Anthropic.ToolUseBlock[] = response.content.filter((b) => b.type === "tool_use");

            if (toolUses.length === 0) {
                // turn-stopping：收敛前最后一个口——监听器可 steer 挽留（文本排
                // next-step，排空循环开新 turn 消费；请求体同形见 dsh-C4.md §3），
                // 或 block 把收敛注记改为 blocked（goal 判 impossible 时）
                let stopReason = "end-turn";
                await this.cordis.serial("agent/turn-stopping", {
                    steer: (text: string) => this.steer(text),
                    block: () => { stopReason = "blocked"; },
                });
                this.endTurn(stopReason);
                if (!this.isSubAgent) {
                    printCost(this.totalInputTokens, this.totalOutputTokens, this.totalCacheReadTokens, this.totalCacheCreationTokens);
                    this.autoSave();
                }
                break;
            }

            // budget 检查点（位置 B）：响应已结算、工具未执行。超限时每个 tool_use
            // 都要补一条拒绝 tool_result 再停——否则历史里挂着无回应的 tool_use，
            // 下次 chat() 把它发回 API 直接 400（session 存档同样被污染）
            this.currentTurns++;
            const budget = this.checkBudget();
            if (budget.exceeded) {
                printInfo(`Budget exceeded: ${budget.reason}`);
                this.endTurn("budget");
                this.pushUser(toolUses.map((tu) => {
                    this.sessionLog.append({ type: "tool/result", callId: tu.id, content: `Tool call not executed: ${budget.reason}`, isError: true });
                    return {
                        type: "tool_result" as const,
                        tool_use_id: tu.id,
                        content: `Tool call not executed: ${budget.reason}`,
                    };
                }));
                this.autoSave();
                break;
            }
            // step 级标记（turn 继续）：只进注记，不发 agent/turn-end 事件
            this.sessionLog.append({ type: "turn/end", reason: "tool-use" });

            let toolResult: Anthropic.ToolResultBlockParam[] = [];
            let conclusion: TurnConclusion | null = null;
            for (const tu of toolUses) {
                // 单工具全包 try/catch：任何意外抛错（畸形 input 打崩 UI 渲染、落盘
                // 失败等）都转成 error tool_result 回灌。否则异常逃出循环时历史里
                // 挂着无回应的 tool_use，之后每个请求都 400（历史永久污染）
                let output: string;
                try {
                    printToolCall(tu.name, tu.input as Record<string, any>);
                    this.sessionLog.append({ type: "tool/call", id: tu.id, name: tu.name, input: tu.input as Record<string, any> });
                    // C2：权限决策与执行整体下沉 executeCall 管线（pre-execute 瀑布
                    // → 审批 → dispatch → post-execute）。auto 的分类器机制仍在
                    // 本类，经 autoAdjudicate 句柄被 auto 监听器调用
                    const outcome = await this.cordis.require<ToolsService>("tools").executeCall(
                        { name: tu.name, input: tu.input as Record<string, any>, mode: this.mode, planFilePath: this.planFilePath || undefined },
                        {
                            readFileState: this.readFileState,
                            dispatch: (n, i) => this.executeToolCall(n, i),
                            autoAdjudicate: (n, i) => this.classifyToolCall(n, i),
                        },
                    );
                    if (outcome.kind === "denied") {
                        if (outcome.announce) printInfo(`Denied: ${outcome.announce}`);
                        toolResult.push({ type: "tool_result", tool_use_id: tu.id, content: outcome.content });
                        this.sessionLog.append({ type: "tool/result", callId: tu.id, content: outcome.content, isError: true });
                        continue;
                    }
                    // C5：工具自结 turn（plan 的 clear-and-execute 是第一个签发者）。
                    // 工具输出不进 tool_result 批次（dropBatch：历史已清，批次会
                    // 孤儿化 → 400），注入文本排 next-turn，drain 循环开新 turn——
                    // 首条消息的 reminder 待遇由 runOneTurn 统一给
                    if (outcome.conclusion) {
                        conclusion = outcome.conclusion;
                        break;
                    }
                    output = this.persistLargeResult(tu.name, outcome.output);
                } catch (e: any) {
                    output = `Tool execution failed: ${e?.message ?? e}`;
                    this.sessionLog.append({ type: "tool/result", callId: tu.id, content: output, isError: true });
                }
                toolResult.push({ type: "tool_result", tool_use_id: tu.id, content: output });
                this.sessionLog.append({ type: "tool/result", callId: tu.id, content: output });
            }
            if (conclusion) {
                if (!conclusion.dropBatch && toolResult.length > 0) {
                    this.pushUser(toolResult);
                }
                if (conclusion.nextTurnInput !== undefined) {
                    this.inbox.append("next-turn", conclusion.nextTurnInput);
                }
                this.endTurn("concluded");
                break;
            }
            if (toolResult.length > 0) {
                this.pushUser(toolResult);
            }
        }
    }

    private async executeToolCall(name: string, input: Record<string, any>): Promise<string | TurnConclusion> {
        if (name === "enter_plan_mode" || name === "exit_plan_mode") return await this.executePlanModeTool(name);
        if (name === "agent") return this.executeAgentTool(input);
        if (name === "skill") return this.executeSkillTool(input);
        if (name === "schedule_wakeup") {
            // 只有 dynamic loop 驱动才路由到这里；loop 之外工具不广告，
            // 这道守卫挡住模型裸调或同名外部工具
            if (!this.scheduleWakeupEnabled) return "schedule_wakeup is only available during /loop dynamic mode.";
            return this.executeScheduleWakeup(input);
        }
        if (name.startsWith("mcp__")) {
            // server 掉线/名字拆错等——作为 tool_result 回给模型自行处置，不在主循环里炸
            try {
                return await this.mcpManager.callTool(name, input);
            } catch (e: any) {
                return `Error: ${e.message ?? e}`;
            }
        }
        // C1：switch 改查注册表。魔法名链（plan/agent/skill/schedule_wakeup/mcp__）
        // 在上方已拦截；走到这里的都是注册表工具，未知名与旧 switch 的 default 同话术
        const def: ToolDefinition | undefined = this.cordis.require<ToolsService>("tools").get(name);
        if (!def) return `Unknown tool: ${name}`;
        return await def.execute(input, { readFileState: this.readFileState });
    }

    private async executePlanModeTool(name: string): Promise<string | TurnConclusion> {
        if (name === "enter_plan_mode") {
            if (this.mode === "plan") return "Already in plan mode.";
            this.prePlanMode = this.mode;
            this.mode = "plan";
            this.planFilePath = this.generatePlanFilePath();
            printInfo("Entered plan mode (read-only). Plan file: " + this.planFilePath);
            return `Entered plan mode. You are now in read-only mode.\n\nYour plan file: ${this.planFilePath}\nWrite your plan to this file. This is the only file you can edit.\n\nWhen your plan is complete, call exit_plan_mode.`;
        }

        if (name === "exit_plan_mode") {
            if (this.mode !== "plan") return "Not in plan mode.";
            // plan 内容从磁盘读而非内存——clear-and-execute 之后历史没了，底稿还在
            let planContent = "(No plan file found)";
            if (this.planFilePath && existsSync(this.planFilePath)) {
                planContent = readFileSync(this.planFilePath, "utf-8");
            }

            if (this.planApprovalFn) {
                const result = await this.planApprovalFn(planContent);

                if (result.choice === "keep-planning") {
                    // 打回重做：不退出 plan 模式，反馈作为 tool_result 回灌——
                    // 模型留在只读态改方案
                    const feedback = result.feedback || "Please revise the plan.";
                    return `User rejected the plan and wants to keep planning.\n\nUser feedback: ${feedback}\n\nPlease revise your plan based on this feedback. When done, call exit_plan_mode again.`;
                }

                // 批准：选项 1/2 → acceptEdits（自动接受编辑，执行效率最高）；
                // 选项 3（manual-execute）→ 恢复进入前的模式
                let targetMode: PermissionMode;
                if (result.choice === "clear-and-execute") {
                    targetMode = "acceptEdits";
                } else if (result.choice === "execute") {
                    targetMode = "acceptEdits";
                } else {
                    targetMode = this.prePlanMode || "default";
                }

                this.mode = targetMode;
                this.prePlanMode = null;
                const savedPlanPath = this.planFilePath;
                this.planFilePath = null;

                if (result.choice === "clear-and-execute") {
                    this.clearHistoryKeepSystem();
                    printInfo(`Plan approved. Context cleared, executing in ${targetMode} mode.`);
                    // C5：签发 TurnConclusion 而非私有信号位——循环按结论收束本
                    // turn，注入文本经 inbox 开新 turn（旧 contextCleared 改道消亡）
                    return {
                        concludeTurn: true,
                        dropBatch: true,
                        nextTurnInput: `User approved the plan. Context was cleared. Permission mode: ${targetMode}\n\nPlan file: ${savedPlanPath}\n\n## Approved Plan:\n${planContent}\n\nProceed with implementation.`,
                    };
                }

                printInfo(`Plan approved. Executing in ${targetMode} mode.`);
                return `User approved the plan. Permission mode: ${targetMode}\n\n## Approved Plan:\n${planContent}\n\nProceed with implementation.`;
            }

            // 无审批回调（one-shot/子 agent）：直接退出恢复原模式
            this.mode = this.prePlanMode || "default";
            this.prePlanMode = null;
            this.planFilePath = null;
            printInfo("Exited plan mode. Restored to " + this.mode + " mode.");
            return `Exited plan mode. Permission mode restored to: ${this.mode}\n\n## Your Plan:\n${planContent}`;
        }

        return `Unknown plan mode tool: ${name}`;
    }

    /** 审批选项 1 的清历史：system 在请求时现算，无需保留；token 仪表归零。 */
    private clearHistoryKeepSystem() {
        this.messages = [];
        this.sessionLog.clear();
        this.lastInputTokenCount = 0;
    }

    // auto 模式下分类器取代人工确认框：deny 规则照旧硬拦，只读工具走
    // fast-path，其余交给读"推理盲"transcript 投影的 LLM 裁决。

    /** Auto Mode 下的工具裁决。返回 allow/deny（与 checkPermission 同形）或
     *  confirm——拒绝上限触发时交还人工。
     *
     *  两段式（对齐真实 Claude Code 的 both 模式）：stage 1 是激进的廉价闸
     *  （不看用户意图、不认 ALLOW 例外——任一规则**可能**命中就拦）；stage 1
     *  放行即完成（一次调用）。stage 1 拦了才进 stage 2 的审慎裁决——这一段
     *  权衡 transcript 里的用户意图、能解除拦截，它的结论是最终结论。 */
    private async classifyToolCall(
        toolName: string,
        input: Record<string, any>,
    ): Promise<{ action: "allow" | "deny" | "confirm"; message?: string }> {
        // 硬底线（deny 规则）已由 approval 监听器在外层先行（C2）：走到这里的
        // 调用都过了 deny 规则，本函数专注 fast-path 与分类器两段裁决
        if (AUTO_MODE_FAST_PATH_TOOLS.has(toolName)) return { action: "allow" };

        if (!this.client) {
            // 没有可用评估器 → fail-closed。有人在（交互模式）交人工，否则直接拒
            return this.autoFallback(`${toolName} (auto-mode classifier unavailable)`);
        }
        let verdict: { block: boolean; reason: string };
        try {
            const rules = loadAutoModeRules();
            const transcript = buildClassifierTranscript(this.messages as any, { toolName, input });
            const system = buildClassifierSystem(rules);
            // CLAUDE.md 走 user 消息，不进 system——它是不可信的仓库内容
            const claudeMd = loadClaudeMd();
            // stage 1 — 廉价闸：token 预算只够输出 <block>…
            const s1raw = await this.runClassifierQuery(system, classifierUserMessage(rules, transcript, rules.suffix_stage1, claudeMd), 256);
            const s1 = parseBlockVerdict(s1raw);
            if (!s1.block) {
                verdict = s1;
            } else {
                // stage 2 — 审慎裁决：token 更宽裕，允许裁决前先输出 <thinking> 块
                const s2raw = await this.runClassifierQuery(system, classifierUserMessage(rules, transcript, rules.suffix_stage2, claudeMd), 1024);
                verdict = parseBlockVerdict(s2raw);
            }
        } catch (e: any) {
            // 任何装配或分类器错误 → fail-closed（拦），与真 CC 的铁闸一致。
            // 把资产加载也包进来：规则文件缺失/损坏不能炸掉整轮、孤儿化 tool_use
            verdict = { block: true, reason: `classifier error: ${e?.message ?? e}` };
        }

        if (!verdict.block) {
            this.autoConsecutiveDenials = 0;
            return { action: "allow" };
        }

        this.autoConsecutiveDenials++;
        this.autoTotalDenials++;
        if (
            this.autoConsecutiveDenials >= DENIAL_LIMITS.maxConsecutive ||
            this.autoTotalDenials >= DENIAL_LIMITS.maxTotal
        ) {
            // 拒绝太多——分类器可能卡死了。交互模式交还人工；无人值守拒绝
            // （真 CC 在这里直接中止 agent）
            printInfo(`Auto Mode: denial limit reached — handing back to manual confirmation.`);
            return this.autoFallback(`[Auto Mode blocked] ${verdict.reason}`);
        }
        return { action: "deny", message: `[Auto Mode] ${verdict.reason}` };
    }

    /** Auto Mode 兜底：有人就转人工确认，无人（headless）直接拒。绝不返回
     *  "allow"——意义就在于不让未裁决的动作跑掉。auto 的 confirm 带的是
     *  单次动作摘要而非路径，一次批准不能给后续同类动作开白名单。 */
    private autoFallback(message: string): { action: "deny" | "confirm"; message: string } {
        if (this.confirmFn) return { action: "confirm", message };
        return { action: "deny", message: `${message} (headless — denied)` };
    }

    /** 单消息分类器查询，max_tokens 由调用方给定——两段各自定预算
     *  （stage 1 小闸，stage 2 有思考空间）。temperature 0 保证裁决确定性。 */
    private async runClassifierQuery(system: string, user: string, maxTokens: number): Promise<string> {
        const resp = await this.client.messages.create({
            model: MODEL, max_tokens: maxTokens, system, temperature: 0,
            messages: [{ role: "user", content: user }],
        }, { signal: this.abortController?.signal });
        return resp.content
            .filter((b): b is Anthropic.TextBlock => b.type === "text")
            .map((b) => b.text).join("");
    }

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
            // fork 不许继承 schedule_wakeup——它是本 agent dynamic loop 的驱动内部工具；
            // agent 同理，白名单里写了也不给（子 agent 不许再派生子 agent，递归失控）
            const tools = (result.allowedTools
                ? this.tools.filter(t => result.allowedTools!.includes(t.name) && t.name !== "agent")
                : this.tools.filter(t => t.name !== "agent"))
                .filter(t => t.name !== "schedule_wakeup");

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