// webui/app.tsx——F3：SPA 壳；F4 起是真会话面（conversation 装配 + composer）。
// 红线落法：App 只收 store 实例与 actions 闭包——transport（Connection）
// 留在装配层（main.tsx），组件树里看不见（dsh："presentation component
// 绝不接收 transport object"，用户操作经 callback 反向进入注入面）。
//
// busy = 服务器侧 session.busy || pendingPrompt（accepted→settle 界碑在
// app-state 的写集里维护）。节点装配用 useMemo 挂在 events 引用上——immer
// 无变更不换引用，装配器不会空转（F3 自测题 2 的等值红利）。

import { useEffect, useMemo, useRef, useState } from "react";
import { useStoreSelector } from "./renderer.js";
import { assembleConversation } from "./conversation.js";
import { ConversationView } from "./views.js";
import type { StoreInstance } from "./store.js";
import type { WebUiState } from "./app-state.js";

export interface AppActions {
    createSession(): void;
    refreshSession(): void;
    sendText(text: string): void;
}

const selSession = (s: WebUiState) => s.session;
const selPhase = (s: WebUiState) => s.stream.phase;
const selLastSeq = (s: WebUiState) => s.stream.lastSeq;
const selEvents = (s: WebUiState) => s.events;
const selEndpoint = (s: WebUiState) => s.endpoint;
const selPending = (s: WebUiState) => s.pendingPrompt;
const selError = (s: WebUiState) => s.lastError;

export function App({ store, actions }: { store: StoreInstance<WebUiState, any>; actions: AppActions }) {
    const session = useStoreSelector(store, selSession);
    const phase = useStoreSelector(store, selPhase);
    const lastSeq = useStoreSelector(store, selLastSeq);
    const events = useStoreSelector(store, selEvents);
    const endpoint = useStoreSelector(store, selEndpoint);
    const pending = useStoreSelector(store, selPending);
    const lastError = useStoreSelector(store, selError);

    const nodes = useMemo(() => assembleConversation(events), [events]);

    const busy = (session?.busy ?? false) || pending;
    const [draft, setDraft] = useState("");

    // 新事件落地滚到底部（增量渲染的观感线）
    const scroller = useRef<HTMLDivElement | null>(null);
    useEffect(() => {
        const el = scroller.current;
        if (el) el.scrollTop = el.scrollHeight;
    }, [events.length]);

    const submit = (): void => {
        const text = draft.trim();
        if (!text || busy) return;
        setDraft("");
        actions.sendText(text);
    };

    return (
        <div className="app">
            <header>
                <span className="dot" data-phase={phase} />
                <span className="title">mini dsh</span>
                <span className="muted">{endpoint} · {phase} · lastSeq {lastSeq}</span>
            </header>
            <aside>
                <h2>会话</h2>
                {session ? (
                    <div className="session-card">
                        <div className="mono">{session.id}</div>
                        <div className="muted">
                            {busy ? "busy" : "idle"} · {session.messageCount} 条消息
                        </div>
                    </div>
                ) : (
                    <div className="muted">尚未连接会话</div>
                )}
                <div className="toolbar">
                    <button onClick={() => actions.createSession()}>新会话</button>
                    <button onClick={() => actions.refreshSession()}>刷新</button>
                </div>
            </aside>
            <main>
                <div className="conversation-scroll" ref={scroller}>
                    {nodes.length === 0 ? (
                        <div className="conversation-empty">
                            <p>发一条消息开始会话。</p>
                            <p className="muted">已收到 {events.length} 个事件。</p>
                        </div>
                    ) : (
                        <ConversationView nodes={nodes} />
                    )}
                </div>
                {lastError && <div className="error-line composer-error">{lastError}</div>}
                <div className="composer">
                    <input
                        value={draft}
                        disabled={!session || busy}
                        placeholder={busy ? "turn 进行中…" : session ? "发消息（Enter 发送）" : "先连接会话"}
                        onChange={(e) => setDraft(e.target.value)}
                        onKeyDown={(e) => {
                            if (e.key === "Enter") submit();
                        }}
                    />
                    <button disabled={!session || busy} onClick={submit}>发送</button>
                </div>
            </main>
        </div>
    );
}
