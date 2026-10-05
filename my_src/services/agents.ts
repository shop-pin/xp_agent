// services/agents.ts——C4：Agent handle 与 inbox。
// 参照物：deepseek-harness-master/packages/core/agent/src/runtime-types.ts（Agent
// 接口段）、agent-loop/src/inbox.ts（claim 语义）、agent.ts 的 wakeDriver 段。
//
// 世界观：输入是数据。send/followup/steer 只往 inbox 排队；认领发生在循环的
// 边界上——turn 边界 = 全部 next-step + 恰一条 next-turn，step 边界 = 只取
// next-step。与 dsh 的差异（排空循环取代 wake/latch）见 dsh-C4.md 第 3 节。

import { Service } from "../cordis/service.js";
import type { Context } from "../cordis/context.js";
// 值导入 Agent 但只在 create 调用时 new——与 agent.ts（导入 Inbox）构成运行期
// 才求值的环，模块求值期无环序问题
import { Agent, type AgentOptions } from "../agent.js";

/** mini 的 Agent 状态：maintenance = turn 开场段（T4/prefetch/MCP），没有 step 在跑。
 *  dsh 的 maintenance 是可独立起任务的相位（runMaintenance），mini 只在 turn 开场
 *  内部经过——差距记 dsh-C4.md 第 4 节。 */
export type AgentStatus = "idle" | "running" | "maintenance";

export type InboxTarget = "next-turn" | "next-step";

/** C5 pre-step 监听器的裁决：reject = 本 turn 不消耗模型调用直接收敛（输入
 *  已 claim，不回队列不进消息——对齐 dsh "认领即所有权"）；input = 改写后
 *  进入消息的文本。 */
export interface PreStepDecision {
    reject?: string;
    input?: string[];
}

/** turn-stopping 监听器手里的两个动作：steer 挽留（文本排 next-step，排空
 *  循环开新 turn 续跑）；block 把本 turn 的收敛注记从 end-turn 改成 blocked
 *  （mini 扩展——dsh 的 turn end reason 由机器独占，见 dsh-C5.md 第二段）。 */
export interface TurnStoppingState {
    steer: (text: string) => void;
    block: (reason?: string) => void;
}

/** 内存版双队列 inbox。dsh 的 ReactLoopInbox 把队列变更持久化为 session 投影
 *  （agent/inbox/spliced 事件，重启不丢），mini 的持久化在 C8 一并考虑。 */
export class Inbox {
    private nextTurnQueue: string[] = [];
    private nextStepQueue: string[] = [];

    get hasPending(): boolean {
        return this.nextTurnQueue.length > 0 || this.nextStepQueue.length > 0;
    }

    append(target: InboxTarget, text: string): void {
        (target === "next-turn" ? this.nextTurnQueue : this.nextStepQueue).push(text);
    }

    /** step 边界：取走全部 next-step（插话注入点）。next-turn 不动。 */
    claimStep(): string[] {
        return this.nextStepQueue.splice(0);
    }

    /** turn 边界：全部 next-step + 恰一条 next-turn（steer 在前、turn 输入在后，
     *  与 dsh claim 的返回顺序同形）。两条 followup 各开各的 turn——turn 的所有权
     *  不混。 */
    claimTurn(): string[] {
        const claimed = this.nextStepQueue.splice(0);
        claimed.push(...this.nextTurnQueue.splice(0, 1));
        return claimed;
    }

    /** 全清：先 next-step 后 next-turn（对齐 dsh Inbox.clear 的清理顺序）。 */
    clear(): void {
        this.nextStepQueue.splice(0);
        this.nextTurnQueue.splice(0);
    }
}

/** mini 的 Agent handle 面（Agent 类实现）。dsh 还有 inject（D4 加）与
 *  runMaintenance（独立维护相位，略），差距表见 dsh-C4.md 第 4 节。 */
export interface AgentHandle {
    readonly id: string;
    readonly status: AgentStatus;
    readonly inbox: Inbox;
    /** idle → 开新 turn；running → 排 next-step，由最近 step 边界认领。 */
    send(text: string): Promise<void>;
    /** 排 next-turn：每个条目独占一个 turn。 */
    followup(text: string): Promise<void>;
    /** 插话：next-step；idle 时也开 turn（对齐 dsh "An idle driver starts a turn"）。 */
    steer(text: string): void;
    /** 停止驱动（loop/goal 标志 + 清 inbox + abort 在途请求）。 */
    cancel(cause?: unknown): void;
    /** 收敛到静默后 resolve（含排空循环里的后续 turn）。 */
    whenIdle(): Promise<void>;
    /** 释放资源（MCP 子进程等）。 */
    close(): Promise<void>;
    /** 子 agent 的一次性结算（D3：subagent 插件消费）。 */
    runOnce(prompt: string): Promise<{ text: string; tokens: { input: number; output: number } }>;
}

export class AgentRegistry extends Service {
    private agents = new Map<string, AgentHandle>();

    /** opts 透传 AgentOptions。D3 子 agent 接管时在此挂 per-agent scope。 */
    create(opts: AgentOptions = {}): AgentHandle {
        const agent = new Agent(opts);
        this.agents.set(agent.id, agent);
        return agent;
    }

    get(id: string): AgentHandle | undefined {
        return this.agents.get(id);
    }

    list(): AgentHandle[] {
        return [...this.agents.values()];
    }

    /** 关闭全部子 agent（父 close 时收口——MCP 子进程等资源不悬挂）。 */
    async disposeAll(): Promise<void> {
        await Promise.all(this.list().map((a) => a.close()));
        this.agents.clear();
    }
}

declare module "../cordis/context.js" {
    interface Context {
        agents?: AgentRegistry;
    }
}

// C5：循环扩展点进全局 Events 表（与 tools/* 管线事件同一手法）。
// payload 是 dsh 的子集（无 turn/step/signal——mini 的循环没有独立 phase 对象）。
declare module "../cordis/events.js" {
    interface Events {
        /** 组装前：可改写/拒绝本 step 的输入（waterfall，不调 next = 否决）。
         *  historyEmpty：会话首批输入（目录/reminder 类一次性注入的锚点）。 */
        "agent/pre-step"(
            payload: { input: string[]; historyEmpty: boolean },
            next: () => PreStepDecision | Promise<PreStepDecision>,
        ): PreStepDecision | Promise<PreStepDecision>;
        /** 收敛前：监听器可 steer 文本挽留（serial 无 next；返回非空值会 bail 后继）。 */
        "agent/turn-stopping"(state: TurnStoppingState): void | Promise<void>;
        /** turn 真实收敛（end-turn/budget/aborted/blocked/concluded；tool-use 是
         *  step 级注记不发事件）。 */
        "agent/turn-end"(payload: { reason: string }): void;
    }
}
