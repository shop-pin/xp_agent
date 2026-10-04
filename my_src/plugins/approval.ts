// plugins/approval.ts——C2：permissions.ts 九段流水线的监听器化。
// 逐段对照旧 checkPermission（顺序即安全语义，保序！）：
//   ① deny 规则（连 bypass 也拦） ② plan 只读契约（唯一豁免 = plan 文件全等）
//   ③ bypass 全放行 ④ allow 规则 ⑤ READ_TOOLS（→ permissionHint 'read'）
//   ⑥ plan 工具本身 ⑦ acceptEdits+EDIT_TOOLS（→ permissionHint 'edit'）
//   ⑧ confirm 候选（dontAsk 转 deny） ⑨ 兜底 allow
// 全部变成一个 pre-execute 监听器内部的判定序列。规则解析/危险命令匹配仍从
// permissions.ts 导入——本章只迁"决策路由"，规则引擎原样复用。
//
// 本插件还负责：提供 ApprovalService（含一次性 REPL 问答的 fallback provider，
// 自旧 confirmDangerous 迁入）。注册顺序必须先于 auto-approval 插件——
// waterfall 注册序 = 优先级，先注册者在外层（最先裁决、final say）。

import * as readline from "readline";
import { existsSync } from "fs";
import { Service, } from "../cordis/service.js";
import type { Context } from "../cordis/context.js";
import { checkPermissionRules, isDangerous } from "../permissions.js";
import { monotonic, type PreExecCall, type PreExecDecision } from "../services/tools.js";
import { ApprovalService, type ApprovalProvider } from "../services/approval.js";
import { printConfirmation } from "../ui.js";

export { ApprovalService };

// 旧 confirmDangerous 的展示职责留在这里：问什么先打出来，回调只收 y/n
const replFallbackProvider: ApprovalProvider = async (_call, message) => {
    printConfirmation(message);
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    return new Promise<"allow-once" | "deny">((resolve) => {
        rl.question("  Allow? (y/n): ", (answer) => {
            rl.close();
            resolve(answer.toLowerCase().startsWith("y") ? "allow-once" : "deny");
        });
    });
};

/** 九段判定序列。call.def.permissionHint 取代旧 READ_TOOLS/EDIT_TOOLS 集合。
 *  allow 段一律 return next()（弃权式放行）：guard 负责对内层结果做单调收紧，
 *  内层策略监听器因此有机会加严；deny/ask/bypass-allow 是否决式终局。 */
async function staticPipeline(call: PreExecCall, next: () => PreExecDecision | Promise<PreExecDecision>): Promise<PreExecDecision> {
    // 只扫一次规则表，①④ 共用同一个结果
    const ruleResult = checkPermissionRules(call.name, call.input);
    if (ruleResult === "deny") {
        return { type: "deny", reason: `Denied by permission rule for ${call.name}` };
    }
    // auto 模式：硬底线只到 deny 规则——其余裁决权让给内层的 auto 监听器
    //（对齐旧路径：auto 走 classifyToolCall，其 base 只以 default 模式扫 deny）
    if (call.mode === "auto") return next();
    // plan 只读契约压在 allow 规则和 bypass 之上："只读"是代码强制，不是提示词恳求
    if (call.mode === "plan") {
        if (call.def?.permissionHint === "edit") {
            const filePath = call.input.file_path || call.input.path;
            if (call.planFilePath && filePath === call.planFilePath) {
                return next(); // 豁免 ≠ 终局：内层策略仍可加严
            }
            return { type: "deny", reason: `Blocked in plan mode: ${call.name}` };
        }
        if (call.name === "run_shell") {
            return { type: "deny", reason: "Shell commands blocked in plan mode" };
        }
    }
    // bypass 是用户明示的主权让渡：终局 allow，不受内层策略约束
    if (call.mode === "bypassPermissions") return { type: "allow" };
    if (ruleResult === "allow") return next();
    if (call.def?.permissionHint === "read") return next();
    if (call.name === "enter_plan_mode" || call.name === "exit_plan_mode") {
        return next();
    }
    if (call.mode === "acceptEdits" && call.def?.permissionHint === "edit") return next();

    let confirmMessage = "";
    if (call.name === "run_shell" && isDangerous(String(call.input.command || ""))) {
        confirmMessage = String(call.input.command || "");
    } else if (call.name === "write_file" && !existsSync(call.input.file_path)) {
        confirmMessage = `write new file: ${call.input.file_path}`;
    } else if (call.name === "edit_file" && !existsSync(call.input.file_path)) {
        confirmMessage = `edit non-existent file: ${call.input.file_path}`;
    }
    if (confirmMessage) {
        if (call.mode === "dontAsk") {
            return { type: "deny", reason: `Auto-denied (dontAsk mode): ${confirmMessage}` };
        }
        return { type: "ask", message: confirmMessage };
    }
    return next(); // ⑨ 兜底放行同样弃权给内层
}

export const approvalPlugin = {
    name: "approval",
    apply(ctx: Context) {
        const approval = new ApprovalService(ctx, "approval");
        approval.setFallbackProvider(replFallbackProvider);
        ctx.on("tools/pre-execute", monotonic(staticPipeline));
    },
};
