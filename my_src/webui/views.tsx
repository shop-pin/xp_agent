// webui/views.tsx——F4：presentation（双注册表的第二张：node kind → 组件）。
// 另含 ui-tool 的 wire 名注册表：具名工具可换专属卡，未注册一律走通用卡
// （dsh ui-tool 的"wire 名注册、Runtime 配对"分工）。F4 只立通用卡——
// 注册表空着但结构在，registerToolView 是后续 feature 包的扩展缝。
//
// 红线：本文件只认 ConversationNode 数据与 props，看不见 store 与 transport。

import { useState, type ReactElement } from "react";
import type { ConversationNode } from "./conversation.js";

type ToolNode = Extract<ConversationNode, { kind: "tool" }>;

/** wire 名 → 专属卡组件（未注册的工具走 GenericToolCard）。 */
const toolViews = new Map<string, (props: { node: ToolNode }) => ReactElement>();

export function registerToolView(name: string, view: (props: { node: ToolNode }) => ReactElement): () => void {
    toolViews.set(name, view);
    return () => {
        if (toolViews.get(name) === view) toolViews.delete(name);
    };
}

/** 通用工具卡：名字 + 状态点，input/result 折叠（出错自动展开）。 */
function GenericToolCard({ node }: { node: ToolNode }) {
    const hasError = node.result?.isError === true;
    const [open, setOpen] = useState(hasError);
    const status = node.result ? (hasError ? "error" : "ok") : "running";
    return (
        <div className="tool-card" data-status={status}>
            <button className="tool-head" onClick={() => setOpen(!open)}>
                <span className="tool-status" data-status={status} />
                <span className="mono">{node.name}</span>
                <span className="muted">{status === "running" ? "运行中…" : hasError ? "出错" : "完成"}</span>
            </button>
            {open && (
                <div className="tool-body">
                    <div className="muted">input</div>
                    <pre className="mono">{JSON.stringify(node.input, null, 2)}</pre>
                    {node.result && (
                        <>
                            <div className="muted">result</div>
                            <pre className="mono" data-error={hasError}>{node.result.content}</pre>
                        </>
                    )}
                </div>
            )}
        </div>
    );
}

function NodeView({ node }: { node: ConversationNode }): ReactElement {
    switch (node.kind) {
        case "turn":
            return (
                <div className="turn-divider">
                    <span className="muted">turn {node.index}{node.endReason ? ` · ${node.endReason}` : ""}</span>
                </div>
            );
        case "user":
            return <div className="bubble user">{node.text}</div>;
        case "injection":
            return (
                <details className="injection">
                    <summary className="muted">system 注入</summary>
                    <pre className="mono">{node.text}</pre>
                </details>
            );
        case "assistant":
            return (
                <div className="bubble assistant">
                    <div className="prewrap">{node.text}</div>
                    {node.usage && (
                        <div className="muted usage">
                            in {node.usage.input} · out {node.usage.output}
                            {node.usage.cacheRead > 0 ? ` · cache read ${node.usage.cacheRead}` : ""}
                        </div>
                    )}
                </div>
            );
        case "tool": {
            const Custom = toolViews.get(node.name);
            return Custom ? <Custom node={node} /> : <GenericToolCard node={node} />;
        }
        case "orphan-result":
            return <div className="error-line mono">无主工具结果（{node.callId}）：{node.content}</div>;
        case "error":
            return <div className="error-line">{node.message}</div>;
    }
}

export function ConversationView({ nodes }: { nodes: ConversationNode[] }): ReactElement {
    return (
        <div className="conversation">
            {nodes.map((node) => (
                <NodeView key={node.seq} node={node} />
            ))}
        </div>
    );
}
