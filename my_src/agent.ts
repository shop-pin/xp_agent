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
    goalDirective,
    parseLoopInput, isDailyWording, OFFER_CLOUD_THRESHOLD_SECONDS,
    SCHEDULE_WAKEUP_TOOL, dynamicLoopDirective,
} from "./autonomy.js";
import { randomUUID } from "crypto";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { UiService } from "./services/ui-service.js";
import { CommandService } from "./services/commands.js";
import { commandsPlugin, type CommandsBridge } from "./plugins/commands.js";

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
    // E1：REPL 命令注册表（cli 只消费 dispatch；注册在 commands 插件）
    readonly commands: CommandService;
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

    // 中断支持：SIGINT 处理器经 cancel() 收口（busy 判忙），abort 在途 API 请求
    private abortController: AbortController | null = null;

    // （D6：loop 定时与 schedule_wakeup 意图都归 ctx.schedule 服务——
    // LoopService 退役为纯状态，本类不再有任何回传字段）

    constructor(options: AgentOptions = {}) {
        this.mode = options.permissionMode || "default";
        this.isSubAgent = options.isSubAgent || false;
        // C1：起容器树 → ToolsService 先行（三插件依赖它）→ 按序加载工具插件
        //（注册序 = 旧 toolDefinitions 数组序，请求体 tools 数组顺序的生命线）
        this.cordis = new Context();
        new ToolsService(this.cordis, "tools");
        this.sessionLog = new SessionLog(this.cordis, "session-log");
        // E1：UI 消费者化——消息面（tool/call）由本服务订阅日志渲染，引擎不直印；
        // 叙事面经 ctx.ui.* 出（渲染器可替换）。命令注册表同批落地（cli 只消费）。
        const uiService = new UiService(this.cordis, "ui");
        uiService.attachSessionLog();
        this.commands = new CommandService(this.cordis, "commands");
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
        // E1：REPL slash 命令 = 插件注册（cli 只剩 dispatch 消费）。依赖 skills
        // 注册表（技能回退），故随其后
        this.cordis.plugin(commandsPlugin, this.commandsBridge());
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
        // 桥 = 预算/tick 上限/wake（D6 起评估器随监听器住插件，llm 走注册表）
        this.cordis.plugin(autonomyPlugin, {
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

    /** E1：叙事面出口（渲染器可替换；输出与旧 print* 逐字节一致）。 */
    private get ui(): UiService {
        return this.cordis.require<UiService>("ui");
    }

    /** E1：REPL 动词 → agent 能力（命令插件经它注册 slash 命令）。 */
    private commandsBridge(): CommandsBridge {
        return {
            clearHistory: () => this.clearHistory(),
            togglePlanMode: () => this.togglePlanMode(),
            showCost: () => this.showCost(),
            compact: () => this.compactAnthropic(),
            showGoal: () => this.showGoal(),
            startGoal: async (condition: string) => {
                const directive = this.setGoal(condition);
                await this.pursueGoal(directive);
            },
            runLoop: (rest: string) => this.runLoop(rest),
            send: (text: string) => this.send(text),
        };
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
            this.ui.info(`Exited plan mode → ${this.mode} mode`);
            return this.mode;
        }
        this.prePlanMode = this.mode;
        this.setMode("plan");
        this.planFilePath = this.generatePlanFilePath();
        this.ui.info(`Entered plan mode. Plan file: ${this.planFilePath}`);
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
        this.ui.info(
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

    // REPL 注入复用已有 readline 的确认回调。包装成审批服务的 interactive
    // provider（展示职责在 provider 里——问什么先打出来，回调只收 y/n）；
    // D6 起 auto 分类器的 headless 判定也问审批服务（hasInteractiveProvider）
    setConfirmFn(fn: (message: string) => Promise<boolean>): void {
        const approval = this.cordis.get<ApprovalService>("approval");
        approval?.setInteractiveProvider(async (_call, message) => {
            this.ui.confirmation(message);
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
        this.ui.info(`Session restored (${this.sessionLog.derive().messages.length} messages).`);
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
        this.ui.info(`◎ /goal active — Stop hook condition: "${condition}"`);
        return goalDirective(condition);
    }

    /** /goal 无参数：打印当前 goal 状态。 */
    showGoal(): void {
        const goal = this.cordis.get<GoalService>("goal")?.active;
        if (!goal) {
            this.ui.info("No active goal. Set one with /goal <condition>.");
            return;
        }
        const secs = ((Date.now() - goal.startedAt) / 1000).toFixed(1);
        const last = goal.lastReason ? `\n  last reason: ${goal.lastReason}` : "";
        this.ui.info(
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
            if (goal.stopped) this.ui.info("Goal pursuit interrupted.");
        } finally {
            goal.clear();
        }
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
            this.ui.info(spec.error);
            return;
        }
        // 云排程决策点（间隔 ≥60min 或 daily 措辞）——教学版只提示不实现
        const wantsCloud =
            (spec.mode === "interval" && spec.intervalSeconds! >= OFFER_CLOUD_THRESHOLD_SECONDS) ||
            isDailyWording(rawInput);
        if (wantsCloud) {
            this.ui.info("(Real Claude Code would offer to convert this to a persistent cloud schedule that keeps running after the session ends. This teaching build has no cloud backend — continuing in-session.)");
        }

        const loop = this.cordis.require<LoopService>("loop");
        const done = loop.start(spec);
        if (spec.mode === "interval") {
            this.ui.info(`⟳ /loop scheduled every ${spec.intervalLabel} (session-only, not persisted — dies when this process exits). Ctrl+C to stop.`);
            this.ui.info(`⟳ loop tick 1`);
        } else {
            // schedule_wakeup 只在 dynamic loop 期间广告（场景 24 的门控锚）
            this.setScheduleWakeupToolVisible(true);
            this.ui.info("⟳ /loop dynamic (self-paced) — the model schedules its own next run, or ends the loop. Ctrl+C to stop.");
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
                if (!isAbortLike(e)) this.ui.error(`Agent driver error: ${e instanceof Error ? e.message : String(e)}`);
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
     *  错误 reject 给 awaiter（保持旧 chat() 的抛错语义）。E1：busy 时经 ui
     *  报告 cause——CLI 不再需要判忙和打印，中断的知识收口在这里。 */
    cancel(cause?: unknown): void {
        const busy = this.busy;
        this.stopLoop();
        this.stopGoal();
        this.inbox.clear();
        this.abortController?.abort();
        if (busy && cause != null) this.ui.info(String(cause));
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
            if (!this.isSubAgent) this.ui.spinnerStart();
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
                        if (!this.isSubAgent && firstText) { this.ui.spinnerStop(); firstText = false; }
                        this.emitText(t);
                    },
                ));
            } finally {
                if (!this.isSubAgent) this.ui.spinnerStop();
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
                    this.ui.cost(this.totalInputTokens, this.totalOutputTokens, this.totalCacheReadTokens, this.totalCacheCreationTokens);
                }
                break;
            }

            // budget 检查点（位置 B）：响应已结算、工具未执行。超限时每个 tool_use
            // 都要补一条拒绝 tool_result 再停——否则历史里挂着无回应的 tool_use，
            // 下次 chat() 把它发回 API 直接 400（session 存档同样被污染）
            this.currentTurns++;
            const budget = this.checkBudget();
            if (budget.exceeded) {
                this.ui.info(`Budget exceeded: ${budget.reason}`);
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
                        // 工具调用直印已消亡（E1）——UI 服务订阅日志，tool/call 事件驱动渲染
                        this.sessionLog.append({ type: "tool/call", id: tu.id, name: tu.name, input: tu.input as Record<string, any> });
                        // C2：权限决策与执行整体下沉 executeCall 管线（pre-execute 瀑布
                        // → 审批 → dispatch → post-execute）。D6 起 auto 分类器机制
                        // 也在 auto-approval 插件里（句柄消亡，管线只借中断信号）
                        const outcome = await this.cordis.require<ToolsService>("tools").executeCall(
                            { name: tu.name, input: tu.input as Record<string, any>, mode: this.mode, planFilePath: this.planFilePath || undefined },
                            {
                                readFileState: this.readFileState,
                                dispatch: (n, i) => this.executeToolCall(n, i),
                                signal: this.abortController?.signal,
                            },
                        );
                        if (outcome.kind === "denied") {
                            if (outcome.announce) this.ui.info(`Denied: ${outcome.announce}`);
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
        // C1：switch 改查注册表。魔法名只剩 plan/skill（B 阶段语义，非注册表
        // 工具）；D6 起 schedule_wakeup 也是注册表公民（autonomy 插件注册），
        // mcp__ 自 D2 起同——未知名与旧 switch 的 default 同话术
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
            this.ui.info("Entered plan mode (read-only). Plan file: " + this.planFilePath);
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
                    this.ui.info(`Plan approved. Context cleared, executing in ${targetMode} mode.`);
                    // C5：签发 TurnConclusion 而非私有信号位——循环按结论收束本
                    // turn，注入文本经 inbox 开新 turn（旧 contextCleared 改道消亡）
                    return {
                        concludeTurn: true,
                        dropBatch: true,
                        nextTurnInput: `User approved the plan. Context was cleared. Permission mode: ${targetMode}\n\nPlan file: ${savedPlanPath}\n\n## Approved Plan:\n${planContent}\n\nProceed with implementation.`,
                    };
                }

                this.ui.info(`Plan approved. Executing in ${targetMode} mode.`);
                return `User approved the plan. Permission mode: ${targetMode}\n\n## Approved Plan:\n${planContent}\n\nProceed with implementation.`;
            }

            // 无审批回调（one-shot/子 agent）：直接退出恢复原模式
            this.setMode(this.prePlanMode || "default");
            this.prePlanMode = null;
            this.planFilePath = null;
            this.ui.info("Exited plan mode. Restored to " + this.mode + " mode.");
            return `Exited plan mode. Permission mode restored to: ${this.mode}\n\n## Your Plan:\n${planContent}`;
        }

        return `Unknown plan mode tool: ${name}`;
    }

    /** 审批选项 1 的清历史：system 在请求时现算，无需保留；token 仪表归零。 */
    private clearHistoryKeepSystem() {
        this.sessionLog.clear();
        this.cordis.require<CompactionService>("compaction").lastInputTokenCount = 0;
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

            this.ui.subAgentStart("skill-fork", input.skill_name);
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
                this.ui.subAgentEnd("skill-fork", input.skill_name);
                return subResult.text || "(Skill produced no output)";
            } catch (e: any) {
                this.ui.subAgentEnd("skill-fork", input.skill_name);
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
            this.ui.text(text);
        }
    }
}