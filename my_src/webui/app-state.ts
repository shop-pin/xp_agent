// webui/app-state.ts——F3：应用状态表（Client model）；F4 叠会话装配语义。
// 这是 store 的完整写集（审计面）：stream 帧经装配层落到 setBaseline /
// appendEvent / setStreamPhase；用户动作落到 setSession / setBusy /
// beginPrompt。events 原样囤积——conversation 装配器从它投影出 Nodes。
// actions 表不写注解——A 由 defineStore 从字面量推断（draft 参数经
// ActionsDecl 约束上下文定型）。
//
// F4 的忙闲语义（F1 accepted 记档的落地）：session.prompt 立即回 accepted，
// busy = 服务器侧 session.busy || pendingPrompt。pendingPrompt 从 accept 起
// 挂起，两个界碑解除——turn/end（正常结算 + abort 补注）与 meta/note
// prompt-error（桥拒绝，turn 没跑起来）。断线重连后 setBaseline 对账：
// 末事件已是界碑则解除。

import type { Draft } from "immer";
import { defineStore } from "./store.js";

export interface StreamState {
    phase: "idle" | "connecting" | "live" | "reconnecting";
    generation: number;
    lastSeq: number;
}

export interface WebUiState {
    endpoint: string;
    session: { id: string; busy: boolean; messageCount: number } | null;
    events: Array<{ seq: number; event: any }>;
    stream: StreamState;
    /** 已 accepted 尚未结算的 prompt（turn/end 或 prompt-error 解除）。 */
    pendingPrompt: boolean;
    lastError: string | null;
}

export const webUiStore = defineStore({
    init: (): WebUiState => ({
        endpoint: "",
        session: null,
        events: [],
        stream: { phase: "idle", generation: 0, lastSeq: -1 },
        pendingPrompt: false,
        lastError: null,
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
