// services/approval.ts——C2：审批服务。ask 裁决的落点：谁被问、问过什么、
// 缓存谁能免问，全部收在这里。
//
// 两个 provider 槽位的区分（对齐旧行为的关键）：
//   interactive —— cli 经 agent.setConfirmFn 注入（REPL 复用回调 / mock 注入
//                  脚本化答复）。auto 模式的 autoFallback 只认它：没有 = headless 直接拒。
//   fallback    —— 一次性 REPL 问答（旧 confirmDangerous 的 readline 兜底），
//                  静态模式的 one-shot 场景靠它阻塞询问。
//
// 缓存语义（旧 confirmedPaths 迁居）：同一 message 确认一次后免问——但 auto
// 模式的 confirm 带的是动作摘要不是路径，一次批准绝不能给同类动作开白名单，
// 所以 cacheable = mode !== 'auto'（在 request 里按调用判定，provider 无感知）。

import { Service } from "../cordis/service.js";
import type { PreExecCall } from "./tools.js";

export type ApprovalVerdict = "allow-once" | "deny" | "allow-always";

export type ApprovalProvider = (call: PreExecCall, message: string) => Promise<"allow-once" | "deny">;

export class ApprovalService extends Service {
    private interactive: ApprovalProvider | null = null;
    private fallback: ApprovalProvider | null = null;
    private confirmed = new Set<string>();
    /** 无人值守（挂机 armed）：ask 一律立即拒绝，绝不挂 readline 等键。
     *  2026-11-06 实录：default 模式挂机，巡检写新 memory 文件撞上确认门，
     *  readline 等键 8 小时，收盘收口链全灭——REPL 在场 ≠ 有人在键盘前，
     *  "有没有人"的权威信号是 watch armed，不是 provider 是否存在。 */
    private unattended = false;

    setInteractiveProvider(provider: ApprovalProvider): void {
        this.interactive = provider;
    }

    /** watch armed（无人值守）置 true，/watch off 恢复交互。 */
    setUnattended(v: boolean): void {
        this.unattended = v;
    }

    isUnattended(): boolean {
        return this.unattended;
    }

    /** 审批插件的 apply 里设置（REPL 问答兜底）。 */
    setFallbackProvider(provider: ApprovalProvider): void {
        this.fallback = provider;
    }

    /** auto 模式的 headless 判定依据（对齐旧 autoFallback 的 confirmFn 检查）。 */
    hasInteractiveProvider(): boolean {
        return this.interactive !== null;
    }

    async request(call: PreExecCall, message: string): Promise<ApprovalVerdict> {
        // 无人值守闸压在 provider 选择之前：三条 ask 来路（静态九段 confirm /
        // 分类器 autoFallback / trade-guard 下单卡）全在此收敛，一处拦截全覆盖
        if (this.unattended) return "deny";
        const cacheable = call.mode !== "auto";
        if (cacheable && this.confirmed.has(message)) return "allow-always";
        const provider = this.interactive ?? this.fallback;
        if (!provider) return "deny"; // fail-closed：无人可问 = 拒绝
        const verdict = await provider(call, message);
        if (verdict === "allow-once" && cacheable) {
            this.confirmed.add(message);
            return "allow-always";
        }
        return verdict;
    }
}

declare module "../cordis/context.js" {
    interface Context {
        approval?: ApprovalService;
    }
}
