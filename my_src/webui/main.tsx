// webui/main.tsx——F3：装配层（SPA 唯一知道 transport 的地方）。
// store 实例 + Connection + StreamSink→actions 接线 + actions 闭包全部在这里
// 拼装；组件树只认 props。

import { createRoot } from "react-dom/client";
import { Connection, type StreamSink } from "./connection.js";
import { webUiStore, type WebUiState } from "./app-state.js";
import { App, type AppActions } from "./app.js";

async function boot(): Promise<void> {
    const store = webUiStore.create();
    const endpoint = location.origin;
    store.actions.setEndpoint(endpoint);

    const conn = new Connection(
        { baseUrl: endpoint },
        {
            setBaseline: (events, lastSeq) => store.actions.setBaseline(events, lastSeq),
            appendEvent: (seq, event) => store.actions.appendEvent(seq, event),
            setStatus: ({ phase, generation }) => store.actions.setStreamPhase(phase, generation),
        } satisfies StreamSink,
    );
    conn.connectStream();

    const refreshSession = async (): Promise<void> => {
        try {
            const list = (await conn.call("session.list")) as Array<WebUiState["session"]>;
            store.actions.setSession(list[0] ?? null);
        } catch (e) {
            console.warn("[session.list]", e);
        }
    };

    const actions: AppActions = {
        createSession: () => {
            void (async () => {
                try {
                    store.actions.setSession(await conn.call("session.create", {}));
                    await refreshSession();
                } catch (e) {
                    console.warn("[session.create]", e);
                }
            })();
        },
        refreshSession: () => {
            void refreshSession();
        },
        // F4 accepted 语义：accept 落地即挂 busy，结算看流（turn/end /
        // prompt-error 界碑在 app-state 写集里解除）——HTTP 请求不等 turn
        sendText: (text: string) => {
            void (async () => {
                store.actions.beginPrompt();
                try {
                    await conn.call("session.prompt", { text });
                } catch (e) {
                    store.actions.failPrompt(e instanceof Error ? e.message : String(e));
                }
            })();
        },
    };

    createRoot(document.getElementById("root")!).render(<App store={store} actions={actions} />);
    void refreshSession();
}

void boot();
