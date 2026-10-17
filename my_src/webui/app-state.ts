// webui/app-state.ts——F3：应用状态表（Client model）；F4 叠会话装配语义；
// F5 叠交互跨端（待决审批卡 / 叙事面 / 斜杠补全数据源）。
// 这是 store 的完整写集（审计面）：stream 帧经装配层落到 setBaseline /
// appendEvent / setStreamPhase / pushNarrative / announceApproval /
// resolveApproval；用户动作落到 setSession / setBusy / beginPrompt。
// events 原样囤积——conversation 装配器从它投影出 Nodes；瞬态帧
// （narrative/approval）不进囤积，各有落点。
// actions 表不写注解——A 由 defineStore 从字面量推断（draft 参数经
// ActionsDecl 约束上下文定型）。
//
// F4 的忙闲语义（F1 accepted 记档的落地）：session.prompt 立即回 accepted，
// busy = 服务器侧 session.busy || pendingPrompt。pendingPrompt 从 accept 起
// 挂起，两个界碑解除——turn/end（正常结算 + abort 补注）与 meta/note
// prompt-error（桥拒绝，turn 没跑起来）。断线重连后 setBaseline 对账：
// 末事件已是界碑则解除。
//
// F5 的交互语义：pendingApproval 是 Host 活状态的镜像（approval 帧到场挂卡，
// approval-resolved 或 decide RPC 后摘卡）；新代 baseline 整体替换时一并
// 清空——服务端会在 baseline 后重宣告仍 pending 的卡，客户端不猜。

import type { Draft } from "immer";
import { defineStore } from "./store.js";

/** 客户端自有类型（WireEvent 同款结构副本）：待决交互卡。wire 定义在 host
 *  插件、connection 经 import type 消费；本层只认这个副本——分层红线靠
 *  import 图（webui 里只有 connection 许可看插件类型）。 */
export type ApprovalRequest =
    | { id: string; kind: "tool"; tool: string; input: Record<string, unknown>; message: string }
    | { id: string; kind: "plan"; planContent: string };

/** plan 审批四选项（host 侧 PlanChoice 的客户端副本，同形同词表）。 */
export type PlanChoice = "clear-and-execute" | "execute" | "manual-execute" | "keep-planning";

export interface StreamState {
    phase: "idle" | "connecting" | "live" | "reconnecting";
    generation: number;
    lastSeq: number;
}

export interface NarrativeLine {
    id: number;
    kind: "info" | "error" | "cost";
    text: string;
}

export interface CommandInfo {
    name: string;
    description: string;
    kind: "command" | "skill";
}

export interface WebUiState {
    endpoint: string;
    session: { id: string; busy: boolean; messageCount: number } | null;
    events: Array<{ seq: number; event: any }>;
    stream: StreamState;
    /** 已 accepted 尚未结算的 prompt（turn/end 或 prompt-error 解除）。 */
    pendingPrompt: boolean;
    lastError: string | null;
    /** 在途待决交互（F5）：approval 帧挂卡，resolved/decide 摘卡。 */
    pendingApproval: ApprovalRequest | null;
    /** 叙事面旁白（F5，瞬态——新代 baseline 清空）。 */
    narrative: NarrativeLine[];
    narrativeSeq: number;
    /** / 补全数据源（F5）：静态命令 + 可调用技能。 */
    commands: CommandInfo[];
}

export const webUiStore = defineStore({
    init: (): WebUiState => ({
        endpoint: "",
        session: null,
        events: [],
        stream: { phase: "idle", generation: 0, lastSeq: -1 },
        pendingPrompt: false,
        lastError: null,
        pendingApproval: null,
        narrative: [],
        narrativeSeq: 0,
        commands: [],
    }),
    actions: {
        setEndpoint(draft, endpoint: string) {
            draft.endpoint = endpoint;
        },
        setSession(draft, session: WebUiState["session"]) {
            draft.session = session;
        },
        setBusy(draft, busy: boolean) {
            if (draft.session) draft.session.busy = busy;
        },
        beginPrompt(draft) {
            draft.pendingPrompt = true;
            draft.lastError = null;
        },
        /** accept 本身被拒（busy/坏参数）——没挂起就不等界碑。 */
        failPrompt(draft, message: string) {
            draft.pendingPrompt = false;
            draft.lastError = message;
        },
        setBaseline(draft, events: Array<{ seq: number; event: unknown }>, lastSeq: number) {
            draft.events = events as WebUiState["events"];
            draft.stream.lastSeq = lastSeq;
            // 新代 = 新世界：瞬态（旁白/待决卡）不作跨代存活——服务端会在
            // baseline 后重宣告仍 pending 的卡，这里清空防串代残影
            draft.pendingApproval = null;
            draft.narrative = [];
            reconcilePending(draft, events[events.length - 1]?.event);
        },
        appendEvent(draft, seq: number, event: unknown) {
            draft.events.push({ seq, event });
            draft.stream.lastSeq = seq;
            reconcilePending(draft, event);
        },
        setStreamPhase(draft, phase: StreamState["phase"], generation: number) {
            draft.stream.phase = phase;
            draft.stream.generation = generation;
        },
        pushNarrative(draft, kind: NarrativeLine["kind"], text: string) {
            draft.narrativeSeq += 1;
            draft.narrative.push({ id: draft.narrativeSeq, kind, text });
            if (draft.narrative.length > 100) draft.narrative.splice(0, draft.narrative.length - 100);
        },
        announceApproval(draft, request: ApprovalRequest) {
            draft.pendingApproval = request;
        },
        resolveApproval(draft, id: string) {
            if (draft.pendingApproval?.id === id) draft.pendingApproval = null;
        },
        setCommands(draft, commands: CommandInfo[]) {
            draft.commands = commands;
        },
    },
});

/** 界碑检查：turn/end / prompt-error 到场则解除挂起（重连对账与 live 共用）。 */
function reconcilePending(draft: Draft<WebUiState>, event: unknown): void {
    if (!draft.pendingPrompt || event == null) return;
    const type = (event as { type?: string }).type;
    if (type === "turn/end") {
        draft.pendingPrompt = false;
    } else if (type === "meta/note" && (event as { key?: string }).key === "prompt-error") {
        draft.pendingPrompt = false;
        draft.lastError = String((event as { value?: unknown }).value ?? "");
    }
}
