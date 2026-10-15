// webui/app.tsx——F3：SPA 壳（会话列表 + 新会话入口 + 空对话 + 流状态）。
// 红线落法：App 只收 store 实例与 actions 闭包——transport（Connection）
// 留在装配层（main.tsx），组件树里看不见（dsh："presentation component
// 绝不接收 transport object"，用户操作经 callback 反向进入注入面）。

import { useStoreSelector } from "./renderer.js";
import type { StoreInstance } from "./store.js";
import type { WebUiState } from "./app-state.js";

export interface AppActions {
    createSession(): void;
    refreshSession(): void;
}

const selSession = (s: WebUiState) => s.session;
const selPhase = (s: WebUiState) => s.stream.phase;
const selLastSeq = (s: WebUiState) => s.stream.lastSeq;
const selEventCount = (s: WebUiState) => s.events.length;
const selEndpoint = (s: WebUiState) => s.endpoint;

export function App({ store, actions }: { store: StoreInstance<WebUiState, any>; actions: AppActions }) {
    const session = useStoreSelector(store, selSession);
    const phase = useStoreSelector(store, selPhase);
    const lastSeq = useStoreSelector(store, selLastSeq);
    const eventCount = useStoreSelector(store, selEventCount);
    const endpoint = useStoreSelector(store, selEndpoint);

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
                            {session.busy ? "busy" : "idle"} · {session.messageCount} 条消息
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
                <div className="conversation-empty">
                    <p>空对话壳——会话装配在 F4。</p>
                    <p className="muted">
                        已收到 {eventCount} 个事件。终端发一条 prompt 这行会动——流活着。
                    </p>
                </div>
                <div className="composer">
                    <input disabled placeholder="composer 在 F4 接线" />
                </div>
            </main>
        </div>
    );
}
