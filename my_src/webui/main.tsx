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

    const narrateError = (e: unknown): void => {
        store.actions.pushNarrative("error", e instanceof Error ? e.message : String(e));
    };

    const conn = new Connection(
        { baseUrl: endpoint },
        {
            setBaseline: (events, lastSeq) => store.actions.setBaseline(events, lastSeq),
            appendEvent: (seq, event) => store.actions.appendEvent(seq, event),
            setStatus: ({ phase, generation }) => store.actions.setStreamPhase(phase, generation),
            narrative: (kind, text) => store.actions.pushNarrative(kind, text),
            announceApproval: (request) => store.actions.announceApproval(request),
            resolveApproval: (id) => store.actions.resolveApproval(id),
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
        // F5：裁决回传 = 审批瀑布的远程 answerer 在客户端的半边。乐观摘卡
        // （resolved 帧随后幂等兜底）；迟到作答（超时已 deny）的信封错误
        // 落叙事面——用户看得见"为什么卡没了"。
        decideApproval: (id, verdict) => {
            store.actions.resolveApproval(id);
            conn.call("approval.decide", { id, verdict }).catch(narrateError);
        },
        decidePlan: (id, choice, feedback) => {
            store.actions.resolveApproval(id);
            conn.call("plan.decide", { id, choice, feedback }).catch(narrateError);
        },
        // 终端同款分流：注册表（静态命令/技能）认领 → fire-and-forget 分发，
        // 输出走叙事面帧；没人认 → 原文透传给模型。
        dispatchCommand: (text: string) => {
            void (async () => {
                try {
                    const r = await conn.call("commands.dispatch", { input: text });
                    if (!r?.handled) actions.sendText(text);
                } catch (e) {
                    narrateError(e);
                }
            })();
        },
    };

    createRoot(document.getElementById("root")!).render(<App store={store} actions={actions} />);
    void refreshSession();
    void (async () => {
        try {
            const { commands } = await conn.call("commands.list");
            store.actions.setCommands(commands);
        } catch (e) {
            console.warn("[commands.list]", e);
        }
    })();
}

void boot();
