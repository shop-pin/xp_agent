// plugins/auto-approval.ts——C2：auto 模式的裁决监听器。
// 注册在 approval 插件之后 = waterfall 内层：外层（approval）先做 deny 规则
// 硬底线再 next() 进来，"auto 优先"由 veto 链自然表达——auto 监听器可以直接
// 返回裁决（否决后续），也可以透传 next()。
//
// 分类器机制（两段式 LLM 裁决、拒绝上限、transcript 装配）留在 Agent
// （需要 client/messages/计数器），经 call.autoAdjudicate 句柄调用——本章迁的
// 是"裁决路由"，不是"裁决机制"（见 dsh-C2.md 第 2 节）。

import type { Context } from "../cordis/context.js";
import { monotonic, type PreExecCall, type PreExecDecision, type AutoVerdict } from "../services/tools.js";
import { AUTO_MODE_FAST_PATH_TOOLS } from "../autonomy.js";

type AutoAdjudicateFn = NonNullable<PreExecCall["autoAdjudicate"]>;

function verdictToDecision(verdict: AutoVerdict): PreExecDecision {
    if (verdict.action === "deny") return { type: "deny", reason: verdict.message ?? "denied by auto mode" };
    if (verdict.action === "confirm") return { type: "ask", message: verdict.message ?? "" };
    return { type: "allow" };
}

async function autoPipeline(call: PreExecCall, adjudicate: AutoAdjudicateFn): Promise<PreExecDecision> {
    // fast-path：只读/无副作用工具跳过分类器（集合语义：web_fetch 刻意排除——
    // URL 拉取可能带数据出境，分类器必须看到；不能用 permissionHint 取代）
    if (AUTO_MODE_FAST_PATH_TOOLS.has(call.name)) return { type: "allow" };
    if (!adjudicate) {
        // 没有裁决句柄 = 无人值守且无分类器 → fail-closed（对齐旧 autoFallback headless）
        return { type: "deny", reason: `${call.name} (auto-mode classifier unavailable) (headless — denied)` };
    }
    return verdictToDecision(await adjudicate(call.name, call.input));
}

export const autoApprovalPlugin = {
    name: "auto-approval",
    apply(ctx: Context) {
        ctx.on(
            "tools/pre-execute",
            monotonic((call, next) => {
                if (call.mode !== "auto") return next();
                return autoPipeline(call, call.autoAdjudicate as AutoAdjudicateFn);
            }),
        );
    },
};
