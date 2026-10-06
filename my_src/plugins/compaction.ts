// plugins/compaction.ts——D5：四层压缩插件化（"日志即真相"的兑现章）。
// 参照物：dsh 的 surface 替换投影（packages/core/session 的 replace 语义）。
//
// C3 立的规矩在此兑现：T1–T4 从"原地改 this.messages"改为"追加投影事件"——
//   T1 budget / T2 snip / T3 microcompact → message/replace（按 seq 定位、
//   链式换血——后续层看到前一层的投影，与旧原地顺序语义一致）
//   T4 compact → history/truncate + 重建消息事件
// 日志本体只增不改（终极验收断言钉死）；请求组装自 D5 起走 derive()，
// agent 的 this.messages 工作集退役。
//
// 压缩仪表（lastInputTokenCount / lastApiCallTime / effectiveWindow）自 agent
// 迁入本服务——它们只服务压缩决策，跟层走。

import type Anthropic from "@anthropic-ai/sdk";
import { Service } from "../cordis/service.js";
import type { Context } from "../cordis/context.js";
import type { SessionLog, FoldedNode } from "../services/session-log.js";
import type { TokenUsage } from "../services/session-log.js";
import type { ToolsService } from "../services/tools.js";
import type { LlmRuntime } from "../services/llm.js";
import { MODEL } from "../services/llm.js";
import { printInfo } from "../ui.js";

const MODEL_CONTEXT: Record<string, number> = {
    "glm-4.7-flash": 128000,
    "glm-5.3-flash": 128000,
    "claude-sonnet-4-6": 200000,
};
function getContextWindow(model: string): number {
    return MODEL_CONTEXT[model] || 200000;
}

const SNIP_PLACEHOLDER = "[Content snipped - re-read if needed]";
const SNIP_THRESHOLD = 0.60;
// 热缓存覆盖线：utilization 超过它，就算缓存还热也允许改写老结果——
// 溢出风险比重建一次缓存更贵（0.60 < 0.75 < 0.85 三线各管一层）
const SNIP_HOT_OVERRIDE = 0.75;
const MICROCOMPACT_IDLE_MS = 5 * 60 * 1000; // 缓存 5 分钟没用就算冷
const KEEP_RECENT_RESULTS = 3;

export class CompactionService extends Service {
    // 下一次请求的上下文体量预估（本次 prompt 全量 + 本次输出），压缩仪表的原料
    lastInputTokenCount = 0;
    // 压缩仪表：最近一次 API 调用时刻——T2/T3 用它判断缓存冷热
    lastApiCallTime = 0;
    // 有效窗口 = 上下文窗口 - 20000 安全边际（给摘要请求本身和系统块留余量）
    readonly effectiveWindow: number;

    constructor(ctx: Context, name: string) {
        super(ctx, name);
        this.effectiveWindow = getContextWindow(MODEL) - 20000;
    }

    private log(): SessionLog {
        return this.ctx.require<SessionLog>("session-log");
    }

    /** 每个 assistant 结算后记账（agent 循环调用）。 */
    recordUsage(usage: TokenUsage): void {
        this.lastInputTokenCount = usage.input + usage.cacheRead + usage.cacheCreation + usage.output;
        this.lastApiCallTime = Date.now();
    }

    // ── 组装层：顺序即语义（budget → snip → microcompact） ──

    runPipeline(): void {
        this.budgetToolResults();
        this.snipStaleResults();
        this.microcompact();
    }

    /** T4 门：唯一要花 API 的一层。0.85 线，turn 边界才检查。 */
    async checkAndCompact(): Promise<void> {
        if (this.lastInputTokenCount > this.effectiveWindow * 0.85) {
            printInfo("Context window filling up, compacting conversation...");
            const compacted = await this.compact();
            if (compacted) printInfo("Conversation compacted.");
        }
    }

    // ── T1 budget：把超大 tool_result 掐头去尾缩进预算。零 API 成本，无缓存
    //    门控（它只处理大块头——那种结果留着必溢出，缩了顶多重建一次缓存）。
    private budgetToolResults(): void {
        const utilization = this.lastInputTokenCount / this.effectiveWindow;
        if (utilization < 0.5) return; // 上下文过半才开始管
        const budget = utilization > 0.7 ? 15000 : 30000; // 越满预算越紧

        for (const node of this.log().nodes()) {
            const content = node.message.content;
            if (!Array.isArray(content)) continue;
            let changed = false;
            const next = content.map((block) => {
                const b = block as Anthropic.ToolResultBlockParam;
                if (b.type === "tool_result" && typeof b.content === "string" && b.content.length > budget) {
                    changed = true;
                    const keepEach = Math.floor((budget - 80) / 2); // 减 80：给截断提示文案留位
                    return {
                        ...b,
                        content: b.content.slice(0, keepEach) +
                            `\n\n[... budgeted: ${b.content.length - keepEach * 2} chars truncated ...]\n\n` +
                            b.content.slice(-keepEach),
                    };
                }
                return block;
            });
            if (changed) this.appendReplace(node, next);
        }
    }

    // ── T2 snip：同文件旧读去重 + 只保最近 N 条，被剪的整个 tool_result 换
    //    SNIP_PLACEHOLDER。双门控是本层灵魂：缓存热且 utilization 未越覆盖
    //    线 → 忍住。剪谁由工具元数据（snippable）判——D5 起不再有硬编码集合。
    private snipStaleResults(): void {
        const utilization = this.lastInputTokenCount / this.effectiveWindow;
        const cacheHot = this.lastApiCallTime > 0 && (Date.now() - this.lastApiCallTime) < MICROCOMPACT_IDLE_MS;
        if (cacheHot && utilization < SNIP_HOT_OVERRIDE) return;
        if (utilization < SNIP_THRESHOLD) return;

        const tools = this.ctx.get<ToolsService>("tools");
        const nodes = this.log().nodes();
        const messages = nodes.map((n) => n.message);

        // 收集所有可剪结果（已剪过的 placeholder 不再收），带定位与反查元数据
        const results: { node: FoldedNode; blockIdx: number; toolName: string; filePath?: string }[] = [];
        for (const node of nodes) {
            const content = node.message.content;
            if (node.message.role !== "user" || !Array.isArray(content)) continue;
            content.forEach((block, blockIdx) => {
                const b = block as Anthropic.ToolResultBlockParam;
                if (b.type === "tool_result" && typeof b.content === "string" && b.content !== SNIP_PLACEHOLDER) {
                    const toolInfo = this.findToolUseById(messages, b.tool_use_id);
                    if (toolInfo && tools?.get(toolInfo.name)?.snippable) {
                        results.push({ node, blockIdx, toolName: toolInfo.name, filePath: toolInfo.input?.file_path });
                    }
                }
            });
        }

        if (results.length <= KEEP_RECENT_RESULTS) return;

        // 两个剪枝下标集合，最后按受影响节点分组换血（别边遍历边改）
        const toSnip = new Set<{ node: FoldedNode; blockIdx: number }>();
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
                for (let j = 0; j < indices.length - 1; j++) toSnip.add(results[indices[j]]);
            }
        }
        // ② 保最近：最老的 results.length - KEEP_RECENT_RESULTS 条剪掉
        const snipBefore = results.length - KEEP_RECENT_RESULTS;
        for (let i = 0; i < snipBefore; i++) toSnip.add(results[i]);

        const byNode = new Map<FoldedNode, Set<number>>();
        for (const r of toSnip) {
            const set = byNode.get(r.node) ?? new Set<number>();
            set.add(r.blockIdx);
            byNode.set(r.node, set);
        }
        for (const [node, blocks] of byNode) {
            const next = (node.message.content as Anthropic.ToolResultBlockParam[]).map((b, i) =>
                blocks.has(i) ? { ...b, content: SNIP_PLACEHOLDER } : b,
            );
            this.appendReplace(node, next);
        }
    }

    // ── T3 microcompact：缓存已冷才允许的"大扫除"——所有 tool_result 只保
    //    最近 KEEP_RECENT_RESULTS 条，其余换成 "[Old result cleared]"。
    private microcompact(): void {
        if (!this.lastApiCallTime || (Date.now() - this.lastApiCallTime) < MICROCOMPACT_IDLE_MS) return;

        const nodes = this.log().nodes();
        const allResults: { node: FoldedNode; blockIdx: number }[] = [];
        for (const node of nodes) {
            const content = node.message.content;
            if (node.message.role !== "user" || !Array.isArray(content)) continue;
            content.forEach((block, blockIdx) => {
                const b = block as Anthropic.ToolResultBlockParam;
                if (b.type === "tool_result" && typeof b.content === "string" &&
                    b.content !== SNIP_PLACEHOLDER && b.content !== "[Old result cleared]") {
                    allResults.push({ node, blockIdx });
                }
            });
        }

        const clearCount = allResults.length - KEEP_RECENT_RESULTS;
        if (clearCount <= 0) return;
        const byNode = new Map<FoldedNode, Set<number>>();
        for (let i = 0; i < clearCount && i < allResults.length; i++) {
            const set = byNode.get(allResults[i].node) ?? new Set<number>();
            set.add(allResults[i].blockIdx);
            byNode.set(allResults[i].node, set);
        }
        for (const [node, blocks] of byNode) {
            const next = (node.message.content as Anthropic.ToolResultBlockParam[]).map((b, i) =>
                blocks.has(i) ? { ...b, content: "[Old result cleared]" } : b,
            );
            this.appendReplace(node, next);
        }
    }

    /** T4：唯一花 API 的层。user/assistant 交替 + tool_use/tool_result 配对的
     *  边界三分（纯文本 user / 无工具 assistant / tool 批次 user）保持不变；
     *  重建 = truncate 事件 + 新消息事件（日志只增不改）。 */
    async compact(): Promise<boolean> {
        const log = this.log();
        const nodes = log.nodes();
        if (nodes.length < 4) return false; // 太短的对话不值得摘要
        const messages = nodes.map((n) => n.message);
        const tail = messages[messages.length - 1];
        const tailHasToolUse = Array.isArray(tail.content) &&
            (tail.content as any[]).some((b: any) => b.type === "tool_use");
        const SUMMARIZE_INSTRUCTION = "Summarize the conversation so far in a concise paragraph, preserving key decisions, file paths, and context needed to continue the work.";
        let requestMessages: Anthropic.MessageParam[];
        let carryTail: boolean;
        if (tail.role === "user" && typeof tail.content === "string") {
            requestMessages = [...messages.slice(0, -1), { role: "user", content: SUMMARIZE_INSTRUCTION }];
            carryTail = true;
        } else if (tail.role === "assistant" && !tailHasToolUse) {
            requestMessages = [...messages, { role: "user", content: SUMMARIZE_INSTRUCTION }];
            carryTail = false;
        } else {
            // ③ 或未知形态——fail-closed：不发注定非法的摘要请求
            printInfo("Cannot compact here: history ends mid-tool-batch. Try again after the next exchange.");
            return false;
        }
        const llm = this.ctx.get<LlmRuntime>("llm");
        if (!llm) return false;
        const { text: rawSummary } = await llm.sideCall({
            model: MODEL,
            maxTokens: 2048,
            system: "You are a conversation summarizer. Be concise but preserve important details.",
            messages: requestMessages,
        });
        const summaryText = rawSummary || "No summary available.";
        log.append({ type: "history/truncate", reason: "compact" });
        log.append({ type: "user/message", content: `[Previous conversation summary]\n${summaryText}` });
        log.append({
            type: "assistant/message",
            content: [{
                type: "text",
                text: "Understood. I have the context from our previous conversation. How can I continue helping?",
            }],
        });
        if (carryTail) {
            log.append({
                type: "user/message",
                content: JSON.parse(JSON.stringify(tail.content)) as string | Anthropic.ContentBlockParam[],
            });
        }
        this.lastInputTokenCount = 0;
        return true;
    }

    private appendReplace(node: FoldedNode, content: string | Anthropic.ContentBlockParam[]): void {
        this.log().append({ type: "message/replace", target: node.seq, content: JSON.parse(JSON.stringify(content)) });
    }

    /** 机械反查：tool_use_id → { name, input }。给 T2 判"这条结果出自哪个工具"用。 */
    private findToolUseById(messages: Anthropic.MessageParam[], toolUseId: string): { name: string; input: any } | null {
        for (const msg of messages) {
            if (msg.role !== "assistant" || !Array.isArray(msg.content)) continue;
            for (const block of msg.content as any[]) {
                if (block.type === "tool_use" && block.id === toolUseId) {
                    return { name: block.name, input: block.input };
                }
            }
        }
        return null;
    }
}

export const compactionPlugin = {
    name: "compaction",
    inject: ["session-log", "llm"],
    apply(ctx: Context) {
        new CompactionService(ctx, "compaction");
    },
};

declare module "../cordis/context.js" {
    interface Context {
        compaction?: CompactionService;
    }
}
