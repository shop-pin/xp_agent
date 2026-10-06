// plugins/autonomy.ts——C5：自主性插件（goal + loop 监听器化，三段合流）。
// 参照物：runtime-types.ts 的 'agent/turn-stopping'（"a listener that objects
// steers and the machine re-reads its inbox"）与 'agent/turn-end'。
//
// 所有权三分（与 goal 同律）：**服务持状态、监听器做决策、入口管生命周期**——
// pursueGoal/runLoop（Agent）负责首 turn 与 finally 收尾；abort 绕过事件监听器，
// 清状态必须由发起方兜底。
//
// loop 的驱动形状：while 消亡，化进"turn-end 监听器（检查+定时）→ wake 注入
// inbox → 排空循环跑下一个 tick"。D6 起定时与唤醒意图都在 ctx.schedule 服务
// （键控 after/cancel + wakeup 槽），本插件只剩决策；schedule_wakeup 工具亦为
// 注册表公民（最后一个魔法名消亡）。
//
// C6 缝：AutonomyBridge 是 Agent 借来的桥（evaluate 仍 SDK 直调）——
// llm.sideCall 落地后收窄。

import { Service } from "../cordis/service.js";
import type { Context } from "../cordis/context.js";
import {
    GOAL_MAX_ITERATIONS, LOOP_MAX_ITERATIONS, dynamicLoopDirective,
    GOAL_EVALUATOR_SYSTEM, GOAL_TRANSCRIPT_FRAMING, goalJudgeUserMessage,
    parseGoalVerdict, clampWakeupDelay, SCHEDULE_WAKEUP_TOOL,
    type GoalVerdict, type LoopSpec,
} from "../autonomy.js";
import { UiService } from "../services/ui-service.js";
import type { TurnStoppingState } from "../services/agents.js";
import type { SessionLog } from "../services/session-log.js";
import { MODEL, LlmRuntime } from "../services/llm.js";
import { ToolsService } from "../services/tools.js";
import { ScheduleService } from "../services/schedule.js";

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
        // C8：goal 状态进会话日志（meta/note）——resume 重放后 showGoal 可见
        this.ctx.get<SessionLog>("session-log")?.append({
            type: "meta/note", key: "goal", value: { condition },
        });
        return this.active;
    }

    stop(): void {
        this.stopped = true;
    }

    clear(): void {
        this.active = null;
        this.ctx.get<SessionLog>("session-log")?.append({ type: "meta/note", key: "goal", value: null });
    }
}

// ---------- loop ----------

export interface LoopState {
    spec: LoopSpec;
    iterations: number;
    /** dynamic：当前 tick 的 prompt（wakeup 可回传新值顶替）。 */
    prompt: string;
    done: (() => void) | null;
}

export class LoopService extends Service {
    state: LoopState | null = null;
    stopFlag = false;
    // （D6：timer 与 pendingWakeup 迁 ctx.schedule 服务——定时与唤醒意图
    // 都是"未来才发生的事"，归同一个家；本服务退役为纯状态 + 收尾纪律）

    /** runLoop 的 await 锚：整条 tick 链收敛时 resolve。 */
    start(spec: LoopSpec): Promise<void> {
        this.stopFlag = false;
        this.ctx.get<ScheduleService>("schedule")?.cancel("loop-tick");
        return new Promise((resolve) => {
            this.state = { spec, iterations: 1, prompt: spec.prompt, done: resolve };
        });
    }

    /** schedule_wakeup 的执行守卫：仅 dynamic loop 活跃期有效。 */
    get wakeupEnabled(): boolean {
        return this.state?.spec.mode === "dynamic";
    }

    /** SIGINT：定时器等待期立即收尾；turn 进行中交给 turn-end 监听器。 */
    stop(): void {
        this.stopFlag = true;
        if (this.ctx.get<ScheduleService>("schedule")?.has("loop-tick")) {
            this.ui.info("Loop stopped.");
            this.finish();
        }
    }

    private get ui(): UiService {
        return this.ctx.require<UiService>("ui");
    }

    finish(): void {
        const schedule = this.ctx.get<ScheduleService>("schedule");
        schedule?.cancel("loop-tick");
        schedule?.clearWakeup();
        this.state?.done?.();
        this.state = null;
    }
}

// ---------- goal 评估器（D6 自 agent 迁入——评估是"决策的一部分"，跟着监听器走） ----------

/** 最近一条 assistant turn 的文本，供评审。 */
function extractLastAssistantText(ctx: Context): string {
    const view = ctx.require<SessionLog>("session-log").derive().messages;
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

/** 三态评估：met / NOT_MET / impossible。评估器出错按未达处理
 *  （fail-closed，绝不能误清 goal）。 */
async function evaluateGoal(ctx: Context, condition: string): Promise<GoalVerdict> {
    const transcript = extractLastAssistantText(ctx);
    const messages = [
        { role: "user" as const, content: GOAL_TRANSCRIPT_FRAMING },
        { role: "assistant" as const, content: transcript || "(no assistant output)" },
        { role: "user" as const, content: goalJudgeUserMessage(condition) },
    ];
    try {
        const llm = ctx.require<LlmRuntime>("llm");
        const { text: raw } = await llm.sideCall({
            route: llm.defaultRoute,
            model: MODEL,
            maxTokens: 512,
            system: GOAL_EVALUATOR_SYSTEM,
            temperature: 0,
            messages,
        });
        return parseGoalVerdict(raw);
    } catch (e: any) {
        return { ok: false, reason: `evaluator error: ${e?.message ?? e}` };
    }
}

// ---------- 插件 ----------

/** Agent 借给插件的桥：预算/轮数仪表仍住在 agent（E 阶段再议），tick 注入
 *  走 handle——评估器（D6 起）与分类器（D6 起）都已是注册表公民，不再借道。 */
export interface AutonomyBridge {
    getBudget(): { exceeded: boolean; reason: string };
    getMaxTurns(): number | null;
    /** 排 next-turn 并唤醒驱动（tick 注入）。返回 settle promise，错误由调用方收。 */
    wake(text: string): Promise<void>;
}

export const autonomyPlugin = {
    name: "autonomy",
    apply(ctx: Context, bridge: AutonomyBridge) {
        // schedule 先行（loop 的 stop/finish 运行时要查它），goal/loop 随后
        const schedule = new ScheduleService(ctx, "schedule");
        const goal = new GoalService(ctx, "goal");
        const loop = new LoopService(ctx, "loop");
        // 叙事面出口（E1）——goal/loop 的状态旁白经 ui 渲染器出
        const ui = ctx.require<UiService>("ui");

        // D6：schedule_wakeup 收口为注册表公民——B5 的最后一个魔法名在此消亡。
        // schema 仍由 agent 广播（this.tools 数组是广告线，只在 dynamic loop 期
        // splice 进出，场景 24 的门控锚）；这里的执行体带同款守卫，防裸调。
        ctx.require<ToolsService>("tools").register({
            name: SCHEDULE_WAKEUP_TOOL.name,
            description: SCHEDULE_WAKEUP_TOOL.description,
            parameters: SCHEDULE_WAKEUP_TOOL.input_schema,
            execute: (input) => {
                if (!loop.wakeupEnabled) return "schedule_wakeup is only available during /loop dynamic mode.";
                const delaySeconds = clampWakeupDelay(Number(input.delaySeconds));
                const reason = typeof input.reason === "string" ? input.reason : "";
                const prompt = typeof input.prompt === "string" ? input.prompt : "";
                schedule.requestWakeup({ delaySeconds, reason, prompt });
                return `Wakeup scheduled in ${delaySeconds}s. The loop will resume then; end your turn now.`;
            },
        });

        // goal：turn 收敛点评估——met 清状态 / impossible block / 未达 steer 续命
        ctx.on("agent/turn-stopping", async (state: TurnStoppingState) => {
            const g = goal.active;
            if (!g || goal.stopped) return;
            const verdict = await evaluateGoal(ctx, g.condition);
            if (verdict.ok) {
                const turns = g.iterations + 1;
                const secs = ((Date.now() - g.startedAt) / 1000).toFixed(1);
                ui.info(`✓ Goal achieved (${turns} turn${turns === 1 ? "" : "s"}, ${secs}s): ${verdict.reason}`);
                goal.clear();
                return;
            }
            if (verdict.impossible) {
                ui.info(`Hooks: Prompt hook condition judged impossible: ${verdict.reason}`);
                goal.clear();
                state.block(verdict.reason);
                return;
            }
            // 未达：记录并决定是否还允许下一轮
            g.iterations++;
            g.lastReason = verdict.reason;
            ui.info(`Hooks: Prompt hook condition was not met: ${verdict.reason}`);

            const budget = bridge.getBudget();
            if (budget.exceeded) {
                ui.info(`Goal stopped: ${budget.reason}`);
                goal.clear();
                return;
            }
            if (g.iterations >= GOAL_MAX_ITERATIONS) {
                ui.info(`Goal stopped: reached ${GOAL_MAX_ITERATIONS} iterations without meeting the condition.`);
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
                ui.info("Loop stopped.");
                loop.finish();
                return;
            }
            const dynamic = s.spec.mode === "dynamic";
            const wakeup = schedule.takeWakeup();
            if (dynamic && !wakeup) {
                ui.info(`⟳ Loop converged after ${s.iterations} tick${s.iterations === 1 ? "" : "s"} (model scheduled no wakeup).`);
                loop.finish();
                return;
            }
            const budget = bridge.getBudget();
            if (budget.exceeded) {
                ui.info(`Loop stopped: ${budget.reason}`);
                loop.finish();
                return;
            }
            const maxTurns = bridge.getMaxTurns();
            if (maxTurns !== null && s.iterations >= maxTurns) {
                ui.info(`Loop stopped: tick limit reached (${s.iterations} >= ${maxTurns}).`);
                loop.finish();
                return;
            }
            if (s.iterations >= LOOP_MAX_ITERATIONS) {
                ui.info(`Loop stopped: reached ${LOOP_MAX_ITERATIONS} ticks.`);
                loop.finish();
                return;
            }
            if (dynamic) {
                ui.info(`⟳ next run in ${wakeup!.delaySeconds}s — ${wakeup!.reason}`);
                s.prompt = wakeup!.prompt || s.prompt;
                schedule.after("loop-tick", wakeup!.delaySeconds * 1000, () => fireTick(s));
            } else {
                schedule.after("loop-tick", s.spec.intervalSeconds! * 1000, () => fireTick(s));
            }
        });

        // 定时回调（D6：timer 从 LoopState 迁 schedule.after——键控顶替 +
        // finish/stop 的 cancel 纪律保证到点的回调必然有效，这里只留轻防御）
        function fireTick(s: LoopState): void {
            if (!loop.state || loop.stopFlag) return;
            s.iterations++;
            if (s.spec.mode === "interval") ui.info(`⟳ loop tick ${s.iterations}`);
            const directive = s.spec.mode === "dynamic" ? dynamicLoopDirective(s.prompt) : s.prompt;
            void bridge.wake(directive).catch((e) => {
                // tick 的驱动失败（abort/异常）——loop 收尾，runLoop 的 await 不悬挂
                if (!isAbortLike(e)) ui.error(`Loop tick failed: ${e instanceof Error ? e.message : String(e)}`);
                loop.finish();
            });
        }
    },
};

declare module "../cordis/context.js" {
    interface Context {
        goal?: GoalService;
        loop?: LoopService;
    }
}
