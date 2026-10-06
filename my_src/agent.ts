import Anthropic from "@anthropic-ai/sdk";
import { toolDefinitions, type ToolDef } from "./tools.js";
import { ToolsService, getActiveToolDefinitions, truncateResult, activateTools, type ToolDefinition, type TurnConclusion } from "./services/tools.js";
import type { ApprovalService } from "./services/approval.js";
import { SessionLog, type TokenUsage, type SessionEvent } from "./services/session-log.js";
import { LlmRuntime, assembleStream, MODEL, type Settlement } from "./services/llm.js";
import { Inbox, type AgentHandle, type AgentStatus, type PreStepDecision } from "./services/agents.js";
import { Context } from "./cordis/context.js";
import { coreFsTools } from "./plugins/core-fs-tools.js";
import { coreExecTools } from "./plugins/core-exec-tools.js";
import { coreMetaTools } from "./plugins/core-meta-tools.js";
import { approvalPlugin } from "./plugins/approval.js";
import { autoApprovalPlugin } from "./plugins/auto-approval.js";
import { autonomyPlugin, GoalService, LoopService } from "./plugins/autonomy.js";
import { llmAnthropicPlugin } from "./plugins/llm-anthropic.js";
import { adapterEchoPlugin } from "./plugins/adapter-echo.js";
import { sessionJsonlPlugin, readSessionLines, repairUnclosedTurn } from "./plugins/session-jsonl.js";
import { skillsPlugin, SkillRegistry } from "./plugins/skills-registry.js";
import { subagentPlugin, buildPresetFromSkill, childModeOf } from "./plugins/subagent.js";
import { memoryPlugin } from "./plugins/memory.js";
import { compactionPlugin, CompactionService } from "./plugins/compaction.js";
import { AgentRegistry } from "./services/agents.js";
import { resolveSkillPrompt } from "./skills.js";
import { buildStaticSystemPrompt, buildUserContextReminder, loadClaudeMd } from "./prompt.js";
import { SystemPromptService } from "./services/system-prompt.js";
import { promptSectionsPlugin, SECTION_ORDERS } from "./plugins/prompt-sections.js";
import { type PermissionMode } from "./permissions.js";
import { getSubAgentConfig, type SubAgentType } from "./subagent.js";
import { mcpBridgePlugin, McpBridge } from "./plugins/mcp-bridge.js";
import { withRetry } from "./retry.js";
import {
    goalDirective, GOAL_EVALUATOR_SYSTEM, GOAL_TRANSCRIPT_FRAMING, goalJudgeUserMessage,
    parseGoalVerdict, type GoalVerdict,
    parseLoopInput, isDailyWording, OFFER_CLOUD_THRESHOLD_SECONDS,
    SCHEDULE_WAKEUP_TOOL, clampWakeupDelay, dynamicLoopDirective,
    loadAutoModeRules, buildClassifierSystem, buildClassifierTranscript, classifierUserMessage,
    parseBlockVerdict, AUTO_MODE_FAST_PATH_TOOLS, DENIAL_LIMITS,
} from "./autonomy.js";
import { randomUUID } from "crypto";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { printToolCall, printAssistantText, printInfo, printError, printConfirmation, printCost, printSubAgentStart, printSubAgentEnd, startSpinner, stopSpinner } from "./ui.js";

// D5：四层压缩（T1 budget → T2 snip → T3 microcompact → T4 compact）整体迁
// plugins/compaction.ts——事件化（message/replace + history/truncate），
// this.messages 工作集与压缩仪表字段在此消亡，请求组装走 derive()。

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
    // C6：LLM 路由——换后端 = 换环境变量（MINI_CLAUDE_LLM_ROUTE=echo 跑假后端）
    private readonly llmRoute: string = process.env.MINI_CLAUDE_LLM_ROUTE || "anthropic";
    // （D5：this.messages 工作集消亡——请求组装与一切读取走 sessionLog.derive()）
    private mode: PermissionMode = "default";
    private tools: ToolDef[];
    // C1：每个 Agent 一棵 mini-cordis 树，工具注册表长在上面；
    // 后续 C 阶段服务（session-log/llm/approval）逐章挂进同一棵树
    private cordis: Context;
    // 会话事件日志——唯一存储（D5：请求组装走 derive，C3 的双写/发散点闭合）
    private sessionLog: SessionLog;
    // C4：handle 面与 inbox 驱动——输入是数据，认领发生在循环边界
    readonly inbox: Inbox = new Inbox();
    private statusValue: AgentStatus = "idle";
    private driverPromise: Promise<void> | null = null;
    private idleWaiters: Array<() => void> = [];
    // C8：JSONL 持久化惰性挂载标记（见 ensurePersistence）
    private persistenceAttached = false;
    private hasCustomPrompt: boolean;
    private isSubAgent: boolean;
    // 子 agent 的最终文本收进 buffer 而非打印，runOnce 拼出来回传父级
    private outputBuffer: string[] | null = null;
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
    private currentTurns = 0;
    private maxCostUsd: number | null = null;
    private maxTurns: number | null = null;
    // （D5：lastInputTokenCount / lastApiCallTime / effectiveWindow 迁
    // CompactionService——压缩仪表跟层走）

    // transcript 分类器的 DENIAL_LIMITS 追踪：连拦 3 次或累计 20 次 → 分类器
    // 可能卡死在拒绝循环，降级回人工确认（或无人值守拒绝）
    private autoConsecutiveDenials = 0;
    private autoTotalDenials = 0;
    // 中断支持：SIGINT 处理器经 cancel() 收口（busy 判忙），abort 在途 API 请求
    private abortController: AbortController | null = null;

    // /loop dynamic——模型调 schedule_wakeup 时写入，loop 驱动在 turn 收敛后读取并清空
    // （C5 第三段：状态迁 ctx.loop 服务，字段消亡）

    constructor(options: AgentOptions = {}) {
        this.mode = options.permissionMode || "default";
        this.isSubAgent = options.isSubAgent || false;
        // C1：起容器树 → ToolsService 先行（三插件依赖它）→ 按序加载工具插件
        //（注册序 = 旧 toolDefinitions 数组序，请求体 tools 数组顺序的生命线）
        this.cordis = new Context();
        new ToolsService(this.cordis, "tools");
        this.sessionLog = new SessionLog(this.cordis, "session-log");
        // C6：LLM seam 先立服务，适配器插件经 inject 等它（首个业务级 inject 依赖）
        new LlmRuntime(this.cordis, "llm");
        this.cordis.plugin(llmAnthropicPlugin);
        this.cordis.plugin(adapterEchoPlugin);
        // C7：system prompt 服务 + 分节插件（子 agent 关动态节——env/memory/...
        // 是主对话的环境噪音）。plan 节读本类 mode/planFilePath 私有状态，自注册
        new SystemPromptService(this.cordis, "system-prompt");
        this.cordis.plugin(promptSectionsPlugin, {
            staticPrompt: options.customSystemPrompt || buildStaticSystemPrompt(),
            dynamicEnabled: !options.customSystemPrompt,
        });
        this.cordis.require<SystemPromptService>("system-prompt").registerSection({
            id: "plan",
            order: SECTION_ORDERS.plan,
            group: "dynamic",
            render: () => (this.mode === "plan" ? this.buildPlanModePrompt() : null),
        });
        // D1：skills provider registry。目录注入走 pre-step 监听器（子 agent 不注
        // ——system/白名单已定界），工具与 slash 直调都查这个 registry
        this.cordis.plugin(skillsPlugin, { catalogInjection: !this.isSubAgent });
        // D2：MCP 桥接（子 agent 不连接；ensure 保持 turn 开场的惰性时机）
        this.cordis.plugin(mcpBridgePlugin, { enabled: !this.isSubAgent });
        // D3：子 agent 走 registry + preset（agent 工具的 execute 在插件里；
        // 子 agent 不加载本插件——工具隔离的第一层，第二层是 preset 排除表）
        new AgentRegistry(this.cordis, "agents");
        this.cordis.plugin(subagentPlugin, {
            bridge: {
                parentMode: () => this.mode,
                addTokens: (input: number, output: number) => {
                    this.totalInputTokens += input;
                    this.totalOutputTokens += output;
                },
            },
            enabled: !this.isSubAgent,
        });
        // D4：memory 召回——turn 边界发 prefetch，落定经 inject() 排队，
        // 由最近 claim 点进消息与日志（循环内轮询与日志盲区一并消亡）
        this.cordis.plugin(memoryPlugin, {
            bridge: { inject: (text: string) => this.inject(text) },
            enabled: !this.isSubAgent,
        });
        // D5：四层压缩事件化（T1–T3 replace 投影 / T4 truncate 重建），
        // 压缩仪表（lastInputTokenCount 等）随之迁服务
        this.cordis.plugin(compactionPlugin);
        this.cordis.plugin(coreFsTools);
        this.cordis.plugin(coreExecTools);
        this.cordis.plugin(coreMetaTools);
        // C2：权限策略插件化。注册序 = waterfall 优先级：approval 在外层
        // （deny 规则硬底线 + 九段静态流水线），auto 在内层（veto 链表达"auto 优先"）
        this.cordis.plugin(approvalPlugin);
        this.cordis.plugin(autoApprovalPlugin);
        // C5：autonomy 插件（goal 的 turn-stopping 挽留 + loop 的 turn-end 调度）。
        // 桥 = 评估器/预算/tick 上限/wake（C6 llm 服务落地后收窄）
        this.cordis.plugin(autonomyPlugin, {
            evaluate: (condition: string) => this.evaluateGoal(condition),
            getBudget: () => this.checkBudget(),
            getMaxTurns: () => this.maxTurns,
            wake: (text: string) => {
                this.inbox.append("next-turn", text);
                return this.ensureDriver();
            },
        });
        this.tools = options.customTools || toolDefinitions;
        this.hasCustomPrompt = !!options.customSystemPrompt;
        // --plan 启动即规划：plan 文件路径在此生成，提示注入走请求时的
        // buildAnthropicSystem() planSuffix（本类没有常驻 systemPrompt 字段）
        if (this.mode === "plan") {
            this.planFilePath = this.generatePlanFilePath();
        }
    }

    /** D5：消息视图 = 日志投影（工作集消亡；每次现 derive，深拷贝安全）。 */
    history(): Anthropic.MessageParam[] {
        return this.sessionLog.derive().messages;
    }

    loadHistory(messages: Anthropic.MessageParam[]): void {
        this.sessionLog.load(messages); // 回放：消息数组 → 事件流（唯一存储是日志）
    }

    clearHistory(): void {
        this.sessionLog.clear();
    }

    // ---------- 消息操作统一入口（D5：日志单侧——合并语义在 SessionLog.append） ----------

    private pushUser(content: string | Anthropic.ToolResultBlockParam[]): void {
        this.sessionLog.append({ type: "user/message", content });
    }

    private pushAssistant(content: Anthropic.ContentBlockParam[], usage?: TokenUsage): void {
        this.sessionLog.append({ type: "assistant/message", content, usage });
    }

    /** 日志投影（测试与 C8 resume 消费；D5 起也是请求组装的来源）。 */
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
            this.setMode(this.prePlanMode || "default");
            this.prePlanMode = null;
            this.planFilePath = null;
            printInfo(`Exited plan mode → ${this.mode} mode`);
            return this.mode;
        }
        this.prePlanMode = this.mode;
        this.setMode("plan");
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

    // ---------- D5：压缩整体迁 plugins/compaction.ts（事件化） ----------

    /** /compact 与 T4 门共用的入口：委托压缩服务（truncate + 重建事件）。 */
    async compactAnthropic(): Promise<boolean> {
        return this.cordis.require<CompactionService>("compaction").compact();
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

    /**
     * C8：从 JSONL 会话日志恢复（重放即恢复）。持久化在首个 turn 才挂载——
     * 此刻重放的事件不会被写回文件（防自复制），续跑的 append 自然接在同一
     * 文件尾。半行丢弃 + 未闭合 turn/start 补合成 end（崩溃修复）；非消息
     * 状态从注记与 assistant 事件**派生**恢复（mode/cost/currentTurns/
     * lastInputTokenCount/激活工具/goal——超越旧版 JSON 快照 resume 的地方）。
     */
    resume(sessionId: string): boolean {
        const lines = readSessionLines(sessionId);
        if (lines === null) return false;
        for (const line of lines) {
            if ((line as { type: string }).type === "log/clear") {
                this.sessionLog.clear();
            } else {
                this.sessionLog.append(line as SessionEvent);
            }
        }
        repairUnclosedTurn(this.sessionLog);
        this.sessionId = sessionId;

        let activated: string[] | null = null;
        let goalCondition: string | null = null;
        for (const evt of this.sessionLog.events) {
            if (evt.type === "meta/note" && evt.key === "mode") {
                this.mode = evt.value as PermissionMode;
            } else if (evt.type === "meta/note" && evt.key === "activated-tools") {
                activated = evt.value as string[];
            } else if (evt.type === "meta/note" && evt.key === "goal") {
                goalCondition = (evt.value as { condition?: string } | null)?.condition ?? null;
            }
        }
        // cost 四计数与轮数从 assistant 事件求和（不用额外记账事件——日志即真相）
        let lastUsage: TokenUsage | null = null;
        for (const evt of this.sessionLog.events) {
            if (evt.type !== "assistant/message" || !evt.usage) continue;
            this.totalInputTokens += evt.usage.input;
            this.totalOutputTokens += evt.usage.output;
            this.totalCacheReadTokens += evt.usage.cacheRead;
            this.totalCacheCreationTokens += evt.usage.cacheCreation;
            if (evt.content.some((b) => (b as { type?: string }).type === "tool_use")) this.currentTurns++;
            lastUsage = evt.usage;
        }
        this.cordis.require<CompactionService>("compaction").lastInputTokenCount = lastUsage
            ? lastUsage.input + lastUsage.cacheRead + lastUsage.cacheCreation + lastUsage.output
            : 0;
        if (activated) activateTools(activated);
        const goal = this.cordis.get<GoalService>("goal");
        if (goal) {
            if (goalCondition) goal.set(goalCondition);
            else goal.clear();
        }
        printInfo(`Session restored (${this.sessionLog.derive().messages.length} messages).`);
        return true;
    }

    /**
     * C8：惰性挂载持久化——首个 turn 才落文件。resume 在挂载前重放（不自复制）；
     * 单测构造 Agent 不跑 turn，也就不写任何文件。子 agent 不持久化
     * （对齐旧 autoSave 的 isSubAgent 语义）。
     */
    private ensurePersistence(): void {
        if (this.isSubAgent || this.persistenceAttached) return;
        this.persistenceAttached = true;
        this.cordis.plugin(sessionJsonlPlugin, { sessionId: this.sessionId });
    }

    // MCP 子进程 stdio 会挂住事件循环，one-shot/测试结束必须显式关闭。
    // D3：经 registry 创建的子 agent 先收口（它们的 close 是 no-op 级，但
    // 生命周期所有权在 registry——不显式收就是悬挂句柄）
    async close(): Promise<void> {
        await this.cordis.get<AgentRegistry>("agents")?.disposeAll();
        await this.cordis.get<McpBridge>("mcp")?.disconnectAll();
    }

    // （D4：buildSideQuery/consumeMemoryPrefetchIfReady/startMemoryPrefetchForTurn
    // 迁 plugins/memory.ts——selector 旁调、落定注入、簿记全在插件闭包）

    // system 拆成两个块：静态主体打 cache_control 断点（断点前的所有内容，
    // 含工具 schema，命中服务端前缀缓存）；动态上下文（环境 + memory 索引）
    // 放断点之后——模型写一条记忆索引就变，进了静态块等于每次写记忆都作废缓存。
    // C7：拼装收进 SystemPromptService.assemble（两块结构/断点/trim 语义不变）
    private buildAnthropicSystem(): Anthropic.TextBlockParam[] {
        return this.cordis.require<SystemPromptService>("system-prompt").assemble().system;
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
        const { text } = await this.cordis.require<LlmRuntime>("llm").sideCall({
            route: this.llmRoute,
            model: MODEL,
            maxTokens: 512,
            system,
            temperature: 0,
            messages,
        });
        return text;
    }

    /** 最近一条 assistant turn 的文本，供评审。 */
    private extractLastAssistantText(): string {
        const view = this.history();
        for (let i = view.length - 1; i >= 0; i--) {
            const m: any = view[i];
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

    /** /loop 入口：解析 + 首 tick + 等整条 tick 链收敛。tick 间调度在 autonomy
     *  插件的 turn-end 监听器（检查 → 定时 → wake 注入 inbox，排空循环跑下一个
     *  tick）——C5 第三段起 while 驱动消亡。输入非法时直接返回。 */
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

        const loop = this.cordis.require<LoopService>("loop");
        const done = loop.start(spec);
        if (spec.mode === "interval") {
            printInfo(`⟳ /loop scheduled every ${spec.intervalLabel} (session-only, not persisted — dies when this process exits). Ctrl+C to stop.`);
            printInfo(`⟳ loop tick 1`);
        } else {
            // schedule_wakeup 只在 dynamic loop 期间广告（场景 24 的门控锚）
            this.setScheduleWakeupToolVisible(true);
            printInfo("⟳ /loop dynamic (self-paced) — the model schedules its own next run, or ends the loop. Ctrl+C to stop.");
        }
        try {
            // tick 1 走 chat（followup 语义）；后续 tick 由监听器定时 wake 注入
            await this.chat(spec.mode === "dynamic" ? dynamicLoopDirective(spec.prompt) : spec.prompt);
            await done;
        } finally {
            // 任何出口（收敛/上限/中断/异常）摘工具清状态——旧版同一纪律
            if (spec.mode === "dynamic") this.setScheduleWakeupToolVisible(false);
            loop.finish();
        }
    }

    /** dynamic loop 的 schedule_wakeup 广告开关（幂等）。 */
    private setScheduleWakeupToolVisible(on: boolean): void {
        const has = this.tools.some((t) => t.name === "schedule_wakeup");
        if (on && !has) this.tools = [...this.tools, SCHEDULE_WAKEUP_TOOL];
        if (!on && has) this.tools = this.tools.filter((t) => t.name !== "schedule_wakeup");
    }

    /** 停止运行中的 /loop（REPL 中断处理经 cancel 调用）：定时器等待期立即
     *  收尾；turn 进行中由 turn-end 监听器见到标志收尾。 */
    stopLoop(): void {
        this.cordis.get<LoopService>("loop")?.stop();
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

    /** D1：skills registry 的 CLI 侧句柄（/skills 列表与 /<name> 直调都走它）。 */
    get skills(): SkillRegistry {
        return this.cordis.require<SkillRegistry>("skills");
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

    /** D4：下一请求注入——排 next-step 但**不唤醒**（对齐 dsh inject()：idle 时
     *  挂起等 followup/steer 唤醒；running 时最近 step 边界认领）。注入经 claim →
     *  pushUser 进消息与日志——model-visible ⟺ logged，注入不再是日志盲区。 */
    inject(text: string): void {
        this.inbox.append("next-step", text);
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
        this.ensurePersistence();
        // pre-step（turn 首步形态）：组装前可改写/拒绝。拒绝 → 本 turn 不消耗
        // 模型调用直接收敛（dsh：blocked；输入已 claim，不回队列不进消息）
        const decision = await this.cordis.waterfall(
            "agent/pre-step",
            { input: batch, historyEmpty: this.history().length === 0, boundary: "turn" },
            (): PreStepDecision => ({ input: batch }),
        );
        if (decision.reject !== undefined) {
            this.endTurn("blocked");
            return;
        }
        for (const text of decision.input ?? batch) {
            // 环境 reminder 只进主对话首条消息——子 agent 有自己的 system，不掺和。
            // 连续 user 的合并在 pushUser（工作集）与 SessionLog.append（日志）双侧镜像
            const content = this.history().length === 0 && !this.hasCustomPrompt
                ? `${text}\n\n${buildUserContextReminder()}`
                : text;
            this.pushUser(content);
        }
        this.setStatus("maintenance");
        // T4 在 turn 边界检查：此刻最后一条消息是纯 user 文本，compactAnthropic 的
        // slice 不变式才成立。放进 step 循环顶的话，工具轮的末尾是 tool_result——
        // 既会切坏配对，也会在任何 2+ 工具轮的对话里反复触发
        await this.cordis.require<CompactionService>("compaction").checkAndCompact();
        // D4：语义召回在 memory 插件（pre-step 的 turn 边界发起，落定经 inject()
        // 排队——不再有循环内轮询与就地改写）
        // D2：MCP 走桥接服务（ensure 保持惰性时机：turn 开场才连接+同步注册表）
        const mcp = this.cordis.require<McpBridge>("mcp");
        if (!this.isSubAgent) await mcp.ensure();
        const mcpTools: Anthropic.Tool[] = this.isSubAgent ? [] : mcp.listToolDefinitions();
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
                        { input: steers, historyEmpty: false, boundary: "step" },
                        (): PreStepDecision => ({ input: steers }),
                    );
                    if (steerDecision.reject === undefined) {
                        for (const steerText of steerDecision.input ?? steers) this.pushUser(steerText);
                    }
                }
            }
            firstStep = false;
            this.sessionLog.append({ type: "turn/start" });
            // T1–T3 零成本层：每次发请求前过一遍（D5：事件化——追加 replace 投影）
            this.cordis.require<CompactionService>("compaction").runPipeline();
            if (!this.isSubAgent) startSpinner();
            let firstText = true;
            let settlement: Settlement;
            // C3：system 进日志（对比去重——动态段未变不重复 append）。
            // 日志里可能有历史 system 事件，derive 只取最新
            const systemBlocks = this.buildAnthropicSystem();
            const encodedSystem = JSON.stringify(systemBlocks);
            if (this.sessionLog.peekLastSystem() !== encodedSystem) {
                this.sessionLog.append({ type: "system/message", content: encodedSystem });
            }
            try {
                // C6：中立 chunk 流 + 聚合结算。withRetry 包住"建流 + 聚合"：重试时
                // 旧流已死，必须重建整个流（已打印的半截文本不缝合、重打——旧语义）
                settlement = await withRetry(async () => assembleStream(
                    this.cordis.require<LlmRuntime>("llm").stream({
                        route: this.llmRoute,
                        model: MODEL,
                        maxTokens: 4096,
                        system: systemBlocks,
                        tools: [...getActiveToolDefinitions(this.tools), ...mcpTools],
                        messages: this.withCacheBreakpoints(this.sessionLog.derive().messages),
                    }, this.abortController?.signal),
                    (t) => {
                        // src 同款协调：首个 text 先停 spinner 再打印，避免 \r 重画
                        // 吃掉流式输出；纯工具调用响应没有 text，靠 finally 兜底
                        if (!this.isSubAgent && firstText) { stopSpinner(); firstText = false; }
                        this.emitText(t);
                    },
                ));
            } finally {
                if (!this.isSubAgent) stopSpinner();
            }
            this.emitText("\n");
            // 四计数：缓存读/写分开累计；lastInputTokenCount = 本次 prompt 全量 + 输出
            // （输出会成为下一次请求的一部分），压缩仪表读它
            const usage = settlement.usage;
            this.totalInputTokens += usage.input;
            this.totalCacheReadTokens += usage.cacheRead;
            this.totalCacheCreationTokens += usage.cacheCreation;
            this.totalOutputTokens += usage.output;
            this.cordis.require<CompactionService>("compaction").recordUsage(usage);
            this.pushAssistant(settlement.content, usage);

            const toolUses: Anthropic.ToolUseBlock[] = settlement.content.filter((b) => b.type === "tool_use") as Anthropic.ToolUseBlock[];

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
                break;
            }
            // step 级标记（turn 继续）：只进注记，不发 agent/turn-end 事件
            this.sessionLog.append({ type: "turn/end", reason: "tool-use" });

            let toolResult: Anthropic.ToolResultBlockParam[] = [];
            let conclusion: TurnConclusion | null = null;
            try {
                for (const tu of toolUses) {
                    // 单工具全包 try/catch：任何意外抛错（畸形 input 打崩 UI 渲染、
                    // 落盘失败等）都转成 error tool_result 回灌。否则异常逃出循环时
                    // 历史里挂着无回应的 tool_use，之后每个请求都 400（历史永久污染）
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
            } catch (e: any) {
                // 失败补全（dsh ToolCallRecovery 简化版）：批次被非工具错误中断时，
                // 为每个无果 tool_use 补 isError 的 tool_result 再上抛——错误照报，
                // 历史不留孤儿（否则之后每个请求都 400）
                for (const tu of toolUses) {
                    if (!toolResult.some((r) => r.tool_use_id === tu.id)) {
                        const content = `Tool call not executed: step failed (${e?.message ?? e})`;
                        toolResult.push({ type: "tool_result", tool_use_id: tu.id, content });
                        this.sessionLog.append({ type: "tool/result", callId: tu.id, content, isError: true });
                    }
                }
                this.pushUser(toolResult);
                throw e;
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
        if (name === "skill") return this.executeSkillTool(input);
        if (name === "schedule_wakeup") {
            // 只有 dynamic loop 活跃期才路由到这里；loop 之外工具不广告，
            // 这道守卫挡住模型裸调或同名外部工具
            const loop = this.cordis.require<LoopService>("loop");
            if (!loop.wakeupEnabled) return "schedule_wakeup is only available during /loop dynamic mode.";
            const delaySeconds = clampWakeupDelay(Number(input.delaySeconds));
            const reason = typeof input.reason === "string" ? input.reason : "";
            const prompt = typeof input.prompt === "string" ? input.prompt : "";
            loop.recordWakeup({ delaySeconds, reason, prompt });
            return `Wakeup scheduled in ${delaySeconds}s. The loop will resume then; end your turn now.`;
        }
        // C1：switch 改查注册表。魔法名链（plan/agent/skill/schedule_wakeup）在上方
        // 已拦截；mcp__ 自 D2 起也是注册表工具（mcp-bridge 插件两代切换注册），
        // 未知名与旧 switch 的 default 同话术
        const def: ToolDefinition | undefined = this.cordis.require<ToolsService>("tools").get(name);
        if (!def) return `Unknown tool: ${name}`;
        return await def.execute(input, { readFileState: this.readFileState });
    }

    private async executePlanModeTool(name: string): Promise<string | TurnConclusion> {
        if (name === "enter_plan_mode") {
            if (this.mode === "plan") return "Already in plan mode.";
            this.prePlanMode = this.mode;
            this.setMode("plan");
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

                this.setMode(targetMode);
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
            this.setMode(this.prePlanMode || "default");
            this.prePlanMode = null;
            this.planFilePath = null;
            printInfo("Exited plan mode. Restored to " + this.mode + " mode.");
            return `Exited plan mode. Permission mode restored to: ${this.mode}\n\n## Your Plan:\n${planContent}`;
        }

        return `Unknown plan mode tool: ${name}`;
    }

    /** 审批选项 1 的清历史：system 在请求时现算，无需保留；token 仪表归零。 */
    private clearHistoryKeepSystem() {
        this.sessionLog.clear();
        this.cordis.require<CompactionService>("compaction").lastInputTokenCount = 0;
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

        if (!this.cordis.get<LlmRuntime>("llm")?.hasRoute(this.llmRoute)) {
            // 没有可用评估器 → fail-closed。有人在（交互模式）交人工，否则直接拒
            return this.autoFallback(`${toolName} (auto-mode classifier unavailable)`);
        }
        let verdict: { block: boolean; reason: string };
        try {
            const rules = loadAutoModeRules();
            const transcript = buildClassifierTranscript(this.history() as any, { toolName, input });
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
        const { text } = await this.cordis.require<LlmRuntime>("llm").sideCall({
            route: this.llmRoute,
            model: MODEL,
            maxTokens: maxTokens,
            system,
            temperature: 0,
            messages: [{ role: "user", content: user }],
        }, this.abortController?.signal);
        return text;
    }

    // 权限模式子 agent 继承规则（防洗白）：裁决在 plugins/subagent.ts 的
    // childModeOf——agent 工具的 preset 构造与 skill fork 共用同一份
    private childPermissionMode(): PermissionMode {
        return childModeOf(this.mode);
    }

    // skill 的双入口分流：fork 派给隔离子 agent（system=解析后模板，tools=白名单过滤
    // 父工具集）；inline 把解析后文本作为 tool_result 注入主对话，模型看到后照做。
    // D1：查 ctx.skills registry（slash 直调同源——两条路径一个 registry）
    private async executeSkillTool(input: Record<string, any>): Promise<string> {
        const skill = this.cordis.require<SkillRegistry>("skills").getByName(input.skill_name);
        if (!skill) return `Unknown skill: ${input.skill_name}`;
        const prompt = resolveSkillPrompt(skill, input.args || "");

        if (skill.context === "fork") {
            // D3：排除表迁 preset（DEFAULT_EXCLUDES：agent 防递归失控 +
            // schedule_wakeup 防驱动内部工具外流），创建走 ctx.agents
            const preset = buildPresetFromSkill(skill, this.mode, this.tools);

            printSubAgentStart("skill-fork", input.skill_name);
            const subAgent = this.cordis.require<AgentRegistry>("agents").create({
                customSystemPrompt: prompt,
                customTools: preset.tools,
                isSubAgent: true,
                permissionMode: preset.permissionMode,
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

        return `[Skill "${input.skill_name}" activated]\n\n${prompt}`;
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