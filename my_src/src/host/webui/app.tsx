// webui/app.tsx——F3：SPA 壳；F4 起是真会话面（conversation 装配 + composer）。
// 红线落法：App 只收 store 实例与 actions 闭包——transport（Connection）
// 留在装配层（main.tsx），组件树里看不见（dsh："presentation component
// 绝不接收 transport object"，用户操作经 callback 反向进入注入面）。
//
// busy = 服务器侧 session.busy || pendingPrompt（accepted→settle 界碑在
// app-state 的写集里维护）。节点装配用 useMemo 挂在 events 引用上——immer
// 无变更不换引用，装配器不会空转（F3 自测题 2 的等值红利）。

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useStoreSelector } from "./renderer.js";
import { assembleConversation } from "./conversation.js";
import { projectSession } from "./projection.js";
import { ConversationView, ApprovalCard } from "./views.js";
import type { StoreInstance } from "./store.js";
import type { WebUiState, PlanChoice } from "./app-state.js";

export interface AppActions {
    createSession(): void;
    refreshSession(): void;
    sendText(text: string): void;
    decideApproval(id: string, verdict: "allow-once" | "deny"): void;
    decidePlan(id: string, choice: PlanChoice, feedback?: string): void;
    dispatchCommand(text: string): void;
}

const selSession = (s: WebUiState) => s.session;
const selPhase = (s: WebUiState) => s.stream.phase;
const selLastSeq = (s: WebUiState) => s.stream.lastSeq;
const selEvents = (s: WebUiState) => s.events;
const selEndpoint = (s: WebUiState) => s.endpoint;
const selPending = (s: WebUiState) => s.pendingPrompt;
const selError = (s: WebUiState) => s.lastError;
const selApproval = (s: WebUiState) => s.pendingApproval;
const selNarrative = (s: WebUiState) => s.narrative;
const selCommands = (s: WebUiState) => s.commands;

// 主题（presentation 层状态，不进 store）：初值由 index.html 内联脚本在
// 首帧前写好 data-theme（localStorage → 系统偏好 → dark），这里只做切换。
function useTheme(): { theme: "dark" | "light"; toggle: () => void } {
    const [theme, setTheme] = useState<"dark" | "light">(
        () => (document.documentElement.dataset.theme === "light" ? "light" : "dark"),
    );
    const toggle = useCallback(() => {
        setTheme((t) => {
            const next = t === "dark" ? "light" : "dark";
            document.documentElement.dataset.theme = next;
            try { localStorage.setItem("mini-theme", next); } catch { /* 存储不可写，主题本次会话仍生效 */ }
            return next;
        });
    }, []);
    return { theme, toggle };
}

export function App({ store, actions }: { store: StoreInstance<WebUiState, any>; actions: AppActions }) {
    const session = useStoreSelector(store, selSession);
    const phase = useStoreSelector(store, selPhase);
    const lastSeq = useStoreSelector(store, selLastSeq);
    const events = useStoreSelector(store, selEvents);
    const endpoint = useStoreSelector(store, selEndpoint);
    const pending = useStoreSelector(store, selPending);
    const lastError = useStoreSelector(store, selError);
    const approval = useStoreSelector(store, selApproval);
    const narrative = useStoreSelector(store, selNarrative);
    const commands = useStoreSelector(store, selCommands);

    const nodes = useMemo(() => assembleConversation(events), [events]);
    // 侧栏投影：conversation 之后的第二个 fold——同一份 events，各折各的视图
    const projection = useMemo(() => projectSession(events), [events]);

    const busy = (session?.busy ?? false) || pending;
    // F5 已知限的兑现：goal/loop 活跃期服务器会拒 prompt（bridge.isBusy），
    // 侧栏投影让这件事在 UI 可见——composer 与终端 REPL 同款锁死
    const autonomyActive = projection.goal !== null || projection.loop !== null;
    const [draft, setDraft] = useState("");

    // 新事件落地滚到底部（增量渲染的观感线）
    const scroller = useRef<HTMLDivElement | null>(null);
    useEffect(() => {
        const el = scroller.current;
        if (el) el.scrollTop = el.scrollHeight;
    }, [events.length]);

    // "/" 补全：首词以斜杠开头时列候选（子串模糊命中，前缀命中排前——
    // 与终端技能回退同一张表：静态命令 + 可调用技能）
    const completing = draft.startsWith("/") && !draft.includes(" ");
    const query = completing ? draft.slice(1).toLowerCase() : "";
    const matches = useMemo(() => {
        if (!completing) return [];
        const scored = commands
            .filter((c) => c.name.toLowerCase().includes(query))
            .sort((a, b) => {
                const ap = a.name.toLowerCase().startsWith(query) ? 0 : 1;
                const bp = b.name.toLowerCase().startsWith(query) ? 0 : 1;
                return ap - bp || a.name.localeCompare(b.name);
            });
        return scored.slice(0, 8);
    }, [completing, query, commands]);

    const submit = (): void => {
        const text = draft.trim();
        if (!text || busy) return;
        setDraft("");
        if (text.startsWith("/")) actions.dispatchCommand(text);
        else actions.sendText(text);
    };

    const { theme, toggle } = useTheme();

    return (
        <div className="app">
            <header>
                <span className="dot" data-phase={phase} />
                <span className="title">mini dsh</span>
                <span className="muted">{endpoint} · {phase} · lastSeq {lastSeq}</span>
                <button className="theme-toggle" onClick={toggle}>
                    {theme === "dark" ? "浅色" : "深色"}
                </button>
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
                <div className="projection">
                    <h2>投影 <span className="muted">seq {projection.lastSeq}</span></h2>
                    <div className="projection-row">
                        <span className="mono">{projection.mode ?? "default"}</span>
                        <span className="muted">{projection.turns} turns · {projection.compactions} 次压缩</span>
                    </div>
                    <div className="projection-row muted">
                        in {projection.tokens.input} · out {projection.tokens.output}
                        {projection.tokens.cacheRead > 0 ? ` · cache ${projection.tokens.cacheRead}` : ""}
                        {` · ~$${projection.costUsd.toFixed(4)}`}
                    </div>
                    <div className="projection-row" data-active={projection.goal !== null}>
                        {projection.goal
                            ? <>◎ {projection.goal.condition}{projection.goal.iterations > 0 ? `（第 ${projection.goal.iterations} 次评估未达）` : ""}</>
                            : <span className="muted">goal：无</span>}
                    </div>
                    <div className="projection-row" data-active={projection.loop !== null}>
                        {projection.loop
                            ? <>⟳ loop {projection.loop.mode === "dynamic" ? "dynamic" : `${projection.loop.intervalSeconds}s`}</>
                            : <span className="muted">loop：无</span>}
                    </div>
                    <div className="projection-row" data-active={projection.trades.fills > 0}>
                        {projection.trades.fills > 0
                            ? <>¥ {projection.trades.fills} 笔 · 费 {projection.trades.fees.toFixed(2)}
                                {" "}· 已实现 {(projection.trades.realizedPnl >= 0 ? "+" : "") + projection.trades.realizedPnl.toFixed(2)}
                                {projection.trades.cash !== null ? ` · 现金 ${Math.round(projection.trades.cash)}` : ""}
                                <div className="muted">↳ {projection.trades.last}</div></>
                            : <span className="muted">trade：无</span>}
                    </div>
                </div>
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
                {narrative.length > 0 && (
                    <div className="narrative-strip">
                        {narrative.map((line) => (
                            <div key={line.id} className="narrative-line" data-kind={line.kind}>{line.text}</div>
                        ))}
                    </div>
                )}
                {lastError && <div className="error-line composer-error">{lastError}</div>}
                {approval && (
                    <ApprovalCard
                        request={approval}
                        onDecide={(id, verdict) => actions.decideApproval(id, verdict)}
                        onPlanDecide={(id, choice, feedback) => actions.decidePlan(id, choice, feedback)}
                    />
                )}
                <div className="composer">
                    {completing && matches.length > 0 && (
                        <div className="completion">
                            {matches.map((c) => (
                                <button
                                    key={`${c.kind}:${c.name}`}
                                    className="completion-item"
                                    onClick={() => setDraft(`/${c.name} `)}
                                >
                                    <span className="mono">/{c.name}</span>
                                    <span className="muted">{c.description}</span>
                                    <span className="completion-kind" data-kind={c.kind}>{c.kind}</span>
                                </button>
                            ))}
                        </div>
                    )}
                    <input
                        value={draft}
                        disabled={!session || busy || autonomyActive}
                        placeholder={
                            autonomyActive ? "goal/loop 进行中…"
                            : busy ? "turn 进行中…"
                            : session ? "发消息（Enter 发送，/ 唤出命令）"
                            : "先连接会话"
                        }
                        onChange={(e) => setDraft(e.target.value)}
                        onKeyDown={(e) => {
                            if (e.key === "Enter") submit();
                            else if (e.key === "Tab" && completing && matches.length > 0) {
                                e.preventDefault();
                                setDraft(`/${matches[0].name} `);
                            }
                        }}
                    />
                    <button disabled={!session || busy || autonomyActive} onClick={submit}>发送</button>
                </div>
            </main>
        </div>
    );
}
