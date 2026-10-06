// plugins/auto-approval.ts——C2 裁决路由 + D6 分类器机制合流。
// 注册在 approval 插件之后 = waterfall 内层：外层（approval）先做 deny 规则
// 硬底线再 next() 进来，"auto 优先"由 veto 链自然表达——auto 监听器可以直接
// 返回裁决（否决后续），也可以透传 next()。
//
// D6 起 C2 留的"裁决机制"也搬进来了（原先经 call.autoAdjudicate 句柄回调
// Agent 私有方法）：两段式 LLM 裁决、拒绝上限降级、headless 判定。机制需要的
// 一切都是注册表公民——transcript 读 session-log 投影，旁调走 ctx.llm，
// "有没有人在键盘前"问审批服务（hasInteractiveProvider ≙ 旧 confirmFn 判定），
// 中断信号随 PreExecCall.signal 进来。agent 侧不再持有分类器的任何状态：
// DENIAL_LIMITS 双计数器随之迁入本插件闭包（每棵 agent 树一份，粒度不变）。

import type { Context } from "../cordis/context.js";
import { monotonic, type PreExecCall, type PreExecDecision } from "../services/tools.js";
import type { SessionLog } from "../services/session-log.js";
import { MODEL, LlmRuntime } from "../services/llm.js";
import { ApprovalService } from "../services/approval.js";
import { loadClaudeMd } from "../prompt.js";
import {
    AUTO_MODE_FAST_PATH_TOOLS, DENIAL_LIMITS,
    loadAutoModeRules, buildClassifierSystem, buildClassifierTranscript, classifierUserMessage,
    parseBlockVerdict,
} from "../autonomy.js";
import { printInfo } from "../ui.js";

/** auto 模式分类器的裁决形状（与旧 checkPermission 同形）。 */
export interface AutoVerdict {
    action: "allow" | "deny" | "confirm";
    message?: string;
}

function verdictToDecision(verdict: AutoVerdict): PreExecDecision {
    if (verdict.action === "deny") return { type: "deny", reason: verdict.message ?? "denied by auto mode" };
    if (verdict.action === "confirm") return { type: "ask", message: verdict.message ?? "" };
    return { type: "allow" };
}

// ---------- 分类器机制（D6 自 agent.ts 迁入，逐字节同语义） ----------

/** Auto Mode 兜底：有人就转人工确认，无人（headless）直接拒。绝不返回
 *  "allow"——意义就在于不让未裁决的动作跑掉。auto 的 confirm 带的是
 *  单次动作摘要而非路径，一次批准不能给后续同类动作开白名单。 */
function autoFallback(ctx: Context, message: string): AutoVerdict {
    if (ctx.get<ApprovalService>("approval")?.hasInteractiveProvider()) return { action: "confirm", message };
    return { action: "deny", message: `${message} (headless — denied)` };
}

/** 单消息分类器查询，max_tokens 由调用方给定——两段各自定预算
 *  （stage 1 小闸，stage 2 有思考空间）。temperature 0 保证裁决确定性。 */
async function runClassifierQuery(llm: LlmRuntime, call: PreExecCall, system: string, user: string, maxTokens: number): Promise<string> {
    const { text } = await llm.sideCall({
        route: llm.defaultRoute,
        model: MODEL,
        maxTokens,
        system,
        temperature: 0,
        messages: [{ role: "user", content: user }],
    }, call.signal);
    return text;
}

async function classify(ctx: Context, call: PreExecCall, denials: { consecutive: number; total: number }): Promise<AutoVerdict> {
    const toolName = call.name;
    const llm = ctx.get<LlmRuntime>("llm");
    if (!llm?.hasRoute(llm.defaultRoute)) {
        // 没有可用评估器 → fail-closed。有人在（交互模式）交人工，否则直接拒
        return autoFallback(ctx, `${toolName} (auto-mode classifier unavailable)`);
    }
    let verdict: { block: boolean; reason: string };
    try {
        const rules = loadAutoModeRules();
        const transcript = buildClassifierTranscript(
            ctx.require<SessionLog>("session-log").derive().messages as any,
            { toolName, input: call.input },
        );
        const system = buildClassifierSystem(rules);
        // CLAUDE.md 走 user 消息，不进 system——它是不可信的仓库内容
        const claudeMd = loadClaudeMd();
        // stage 1 — 廉价闸：token 预算只够输出 <block>…
        const s1raw = await runClassifierQuery(llm, call, system, classifierUserMessage(rules, transcript, rules.suffix_stage1, claudeMd), 256);
        const s1 = parseBlockVerdict(s1raw);
        if (!s1.block) {
            verdict = s1;
        } else {
            // stage 2 — 审慎裁决：token 更宽裕，允许裁决前先输出 <thinking> 块
            const s2raw = await runClassifierQuery(llm, call, system, classifierUserMessage(rules, transcript, rules.suffix_stage2, claudeMd), 1024);
            verdict = parseBlockVerdict(s2raw);
        }
    } catch (e: any) {
        // 任何装配或分类器错误 → fail-closed（拦），与真 CC 的铁闸一致。
        // 把资产加载也包进来：规则文件缺失/损坏不能炸掉整轮、孤儿化 tool_use
        verdict = { block: true, reason: `classifier error: ${e?.message ?? e}` };
    }

    if (!verdict.block) {
        denials.consecutive = 0;
        return { action: "allow" };
    }

    denials.consecutive++;
    denials.total++;
    if (denials.consecutive >= DENIAL_LIMITS.maxConsecutive || denials.total >= DENIAL_LIMITS.maxTotal) {
        // 拒绝太多——分类器可能卡死了。交互模式交还人工；无人值守拒绝
        // （真 CC 在这里直接中止 agent）
        printInfo(`Auto Mode: denial limit reached — handing back to manual confirmation.`);
        return autoFallback(ctx, `[Auto Mode blocked] ${verdict.reason}`);
    }
    return { action: "deny", message: `[Auto Mode] ${verdict.reason}` };
}

export const autoApprovalPlugin = {
    name: "auto-approval",
    apply(ctx: Context) {
        const denials = { consecutive: 0, total: 0 };
        ctx.on(
            "tools/pre-execute",
            monotonic(async (call, next) => {
                if (call.mode !== "auto") return next();
                // fast-path：只读/无副作用工具跳过分类器（集合语义：web_fetch 刻意
                // 排除——URL 拉取可能带数据出境，分类器必须看到；不能用
                // permissionHint 取代）
                if (AUTO_MODE_FAST_PATH_TOOLS.has(call.name)) return { type: "allow" as const };
                return verdictToDecision(await classify(ctx, call, denials));
            }),
        );
    },
};
