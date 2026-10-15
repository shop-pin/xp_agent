// webui/app-state.ts——F3：应用状态表（Client model）。
// 这是 store 的完整写集（审计面）：stream 帧经装配层落到 setBaseline /
// appendEvent / setStreamPhase；用户动作落到 setSession / setBusy。
// events 原样囤积——F4 的 conversation 装配器从它投影出 Nodes，
// F3 的壳只读长度当"流活着"的信号。actions 表不写注解——A 由
// defineStore 从字面量推断（draft 参数经 ActionsDecl 约束上下文定型）。

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
}

export const webUiStore = defineStore({
    init: (): WebUiState => ({
        endpoint: "",
        session: null,
        events: [],
        stream: { phase: "idle", generation: 0, lastSeq: -1 },
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
        setBaseline(draft, events: Array<{ seq: number; event: unknown }>, lastSeq: number) {
            draft.events = events as WebUiState["events"];
            draft.stream.lastSeq = lastSeq;
        },
        appendEvent(draft, seq: number, event: unknown) {
            draft.events.push({ seq, event });
            draft.stream.lastSeq = seq;
        },
        setStreamPhase(draft, phase: StreamState["phase"], generation: number) {
            draft.stream.phase = phase;
            draft.stream.generation = generation;
        },
    },
});
