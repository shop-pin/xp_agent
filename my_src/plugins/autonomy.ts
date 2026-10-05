// plugins/autonomy.ts——C5 第二段：goal 迁移（autonomy 第一版）。
// 参照物：runtime-types.ts 的 'agent/turn-stopping' 注释——"a listener that
// objects steers (agent.steer(...)) and the machine re-reads its inbox"。
//
// 旧机制：pursueGoal 在 Agent 里包一层 while（chat → 评估 → 未达则再 chat）。
// 新机制：goal 状态进 ctx.goal 服务；turn-stopping 监听器在每个 turn 收敛点
// 评估——未达 steer 回灌 reason 续命（排空循环开新 turn），impossible 走
// block（turn/end 注记 blocked）。pursueGoal 收缩为"首 turn + 收尾"。
//
// 所有权三分：**服务持状态、监听器做决策、pursueGoal 管生命周期**——abort
// （SIGINT）绕过 turn-stopping，所以清状态必须由发起方在 finally 里兜底。
//
// C6 缝：evaluate/getBudget 是 Agent 借来的桥（评估器仍用 SDK 直调 + 读
// messages）；llm.sideCall 服务落地后此桥收窄为配置一行。

import { Service } from "../cordis/service.js";
import type { Context } from "../cordis/context.js";
import { GOAL_MAX_ITERATIONS, type GoalVerdict } from "../autonomy.js";
import { printInfo } from "../ui.js";
import type { TurnStoppingState } from "../services/agents.js";

export interface GoalState {
    condition: string;
    iterations: number;
    startedAt: number;
    lastReason?: string;
}

/** Agent 借给插件的桥（C6 收窄点，见文件头注释）。 */
export interface GoalBridge {
    evaluate(condition: string): Promise<GoalVerdict>;
    getBudget(): { exceeded: boolean; reason: string };
}

export class GoalService extends Service {
    active: GoalState | null = null;
    /** SIGINT 标志（cancel → stopGoal）：监听器见到它不再续命。 */
    stopped = false;

    set(condition: string): GoalState {
        this.active = { condition, iterations: 0, startedAt: Date.now() };
        this.stopped = false;
        return this.active;
    }

    stop(): void {
        this.stopped = true;
    }

    clear(): void {
        this.active = null;
    }
}

export const goalPlugin = {
    name: "goal-pursuit",
    apply(ctx: Context, bridge: GoalBridge) {
        const goal = new GoalService(ctx, "goal");
        ctx.on("agent/turn-stopping", async (state: TurnStoppingState) => {
            const g = goal.active;
            if (!g || goal.stopped) return;
            const verdict = await bridge.evaluate(g.condition);
            if (verdict.ok) {
                const turns = g.iterations + 1;
                const secs = ((Date.now() - g.startedAt) / 1000).toFixed(1);
                printInfo(`✓ Goal achieved (${turns} turn${turns === 1 ? "" : "s"}, ${secs}s): ${verdict.reason}`);
                goal.clear();
                return;
            }
            if (verdict.impossible) {
                printInfo(`Hooks: Prompt hook condition judged impossible: ${verdict.reason}`);
                goal.clear();
                state.block(verdict.reason);
                return;
            }
            // 未达：记录并决定是否还允许下一轮
            g.iterations++;
            g.lastReason = verdict.reason;
            printInfo(`Hooks: Prompt hook condition was not met: ${verdict.reason}`);

            const budget = bridge.getBudget();
            if (budget.exceeded) {
                printInfo(`Goal stopped: ${budget.reason}`);
                goal.clear();
                return;
            }
            if (g.iterations >= GOAL_MAX_ITERATIONS) {
                printInfo(`Goal stopped: reached ${GOAL_MAX_ITERATIONS} iterations without meeting the condition.`);
                goal.clear();
                return;
            }
            if (goal.stopped) return;
            state.steer(`Hooks: Prompt hook condition was not met: ${verdict.reason}\n\nKeep working toward the goal.`);
        });
    },
};

declare module "../cordis/context.js" {
    interface Context {
        goal?: GoalService;
    }
}
