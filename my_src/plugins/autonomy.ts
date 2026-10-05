// plugins/autonomy.ts——C5：自主性插件（goal + loop 监听器化，三段合流）。
// 参照物：runtime-types.ts 的 'agent/turn-stopping'（"a listener that objects
// steers and the machine re-reads its inbox"）与 'agent/turn-end'。
//
// 所有权三分（与 goal 同律）：**服务持状态、监听器做决策、入口管生命周期**——
// pursueGoal/runLoop（Agent）负责首 turn 与 finally 收尾；abort 绕过事件监听器，
// 清状态必须由发起方兜底。
//
// loop 的驱动形状：while 消亡，化进"turn-end 监听器（检查+定时）→ wake 注入
// inbox → 排空循环跑下一个 tick"。interval 用裸 setTimeout 雏形；dynamic 的
// schedule_wakeup 字段协议保留——D6 统一换 ctx.schedule 服务。
//
// C6 缝：AutonomyBridge 是 Agent 借来的桥（evaluate 仍 SDK 直调）——
// llm.sideCall 落地后收窄。

import { Service } from "../cordis/service.js";
import type { Context } from "../cordis/context.js";
import {
    GOAL_MAX_ITERATIONS, LOOP_MAX_ITERATIONS, dynamicLoopDirective,
    type GoalVerdict, type LoopSpec,
} from "../autonomy.js";
import { printInfo, printError } from "../ui.js";
import type { TurnStoppingState } from "../services/agents.js";

function isAbortLike(e: unknown): boolean {
    const err = e as { name?: string; message?: string };
    return err?.name === "AbortError" || String(err?.message ?? "").includes("aborted");
}

// ---------- goal ----------

export interface GoalState {
    condition: string;
    iterations: number;
    startedAt: number;
    lastReason?: string;
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

// ---------- loop ----------

export interface LoopState {
    spec: LoopSpec;
    iterations: number;
    /** dynamic：当前 tick 的 prompt（wakeup 可回传新值顶替）。 */
    prompt: string;
    timer: ReturnType<typeof setTimeout> | null;
    done: (() => void) | null;
}

export class LoopService extends Service {
    state: LoopState | null = null;
    stopFlag = false;
    /** schedule_wakeup 工具的写入点；turn-end 监听器读走并清空。 */
    pendingWakeup: { delaySeconds: number; reason: string; prompt: string } | null = null;

    /** runLoop 的 await 锚：整条 tick 链收敛时 resolve。 */
    start(spec: LoopSpec): Promise<void> {
        this.stopFlag = false;
        this.pendingWakeup = null;
        return new Promise((resolve) => {
            this.state = { spec, iterations: 1, prompt: spec.prompt, timer: null, done: resolve };
        });
    }

    /** schedule_wakeup 的执行守卫：仅 dynamic loop 活跃期有效。 */
    get wakeupEnabled(): boolean {
        return this.state?.spec.mode === "dynamic";
    }

    recordWakeup(w: { delaySeconds: number; reason: string; prompt: string }): void {
        this.pendingWakeup = w;
    }

    takeWakeup(): { delaySeconds: number; reason: string; prompt: string } | null {
        const w = this.pendingWakeup;
        this.pendingWakeup = null;
        return w;
    }

    /** SIGINT：定时器等待期立即收尾；turn 进行中交给 turn-end 监听器。 */
    stop(): void {
        this.stopFlag = true;
        if (this.state?.timer) {
            printInfo("Loop stopped.");
            this.finish();
        }
    }

    finish(): void {
        if (this.state?.timer) clearTimeout(this.state.timer);
        this.state?.done?.();
        this.state = null;
        this.pendingWakeup = null;
    }
}

// ---------- 插件 ----------

/** Agent 借给插件的桥（C6 收窄点，见文件头注释）。 */
export interface AutonomyBridge {
    evaluate(condition: string): Promise<GoalVerdict>;
    getBudget(): { exceeded: boolean; reason: string };
    getMaxTurns(): number | null;
    /** 排 next-turn 并唤醒驱动（tick 注入）。返回 settle promise，错误由调用方收。 */
    wake(text: string): Promise<void>;
}

export const autonomyPlugin = {
    name: "autonomy",
    apply(ctx: Context, bridge: AutonomyBridge) {
        const goal = new GoalService(ctx, "goal");
        const loop = new LoopService(ctx, "loop");

        // goal：turn 收敛点评估——met 清状态 / impossible block / 未达 steer 续命
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

        // loop：tick 收敛点决策——收敛/预算/上限停机，否则定时唤醒下一个 tick
        ctx.on("agent/turn-end", () => {
            const s = loop.state;
            if (!s) return;
            if (loop.stopFlag) {
                // stop 落在 turn 进行中（定时器期由 stop() 自己收尾）
                printInfo("Loop stopped.");
                loop.finish();
                return;
            }
            const dynamic = s.spec.mode === "dynamic";
            const wakeup = loop.takeWakeup();
            if (dynamic && !wakeup) {
                printInfo(`⟳ Loop converged after ${s.iterations} tick${s.iterations === 1 ? "" : "s"} (model scheduled no wakeup).`);
                loop.finish();
                return;
            }
            const budget = bridge.getBudget();
            if (budget.exceeded) {
                printInfo(`Loop stopped: ${budget.reason}`);
                loop.finish();
                return;
            }
            const maxTurns = bridge.getMaxTurns();
            if (maxTurns !== null && s.iterations >= maxTurns) {
                printInfo(`Loop stopped: tick limit reached (${s.iterations} >= ${maxTurns}).`);
                loop.finish();
                return;
            }
            if (s.iterations >= LOOP_MAX_ITERATIONS) {
                printInfo(`Loop stopped: reached ${LOOP_MAX_ITERATIONS} ticks.`);
                loop.finish();
                return;
            }
            if (dynamic) {
                printInfo(`⟳ next run in ${wakeup!.delaySeconds}s — ${wakeup!.reason}`);
                s.prompt = wakeup!.prompt || s.prompt;
                scheduleTick(s, wakeup!.delaySeconds * 1000);
            } else {
                scheduleTick(s, s.spec.intervalSeconds! * 1000);
            }
        });

        function scheduleTick(s: LoopState, ms: number): void {
            s.timer = setTimeout(() => {
                s.timer = null;
                if (loop.state !== s || loop.stopFlag) return;
                s.iterations++;
                if (s.spec.mode === "interval") printInfo(`⟳ loop tick ${s.iterations}`);
                const directive = s.spec.mode === "dynamic" ? dynamicLoopDirective(s.prompt) : s.prompt;
                void bridge.wake(directive).catch((e) => {
                    // tick 的驱动失败（abort/异常）——loop 收尾，runLoop 的 await 不悬挂
                    if (!isAbortLike(e)) printError(`Loop tick failed: ${e instanceof Error ? e.message : String(e)}`);
                    loop.finish();
                });
            }, ms);
        }
    },
};

declare module "../cordis/context.js" {
    interface Context {
        goal?: GoalService;
        loop?: LoopService;
    }
}
