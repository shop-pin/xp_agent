// webui/views.tsx——F4：presentation（双注册表的第二张：node kind → 组件）。
// 另含 ui-tool 的 wire 名注册表：具名工具可换专属卡，未注册一律走通用卡
// （dsh ui-tool 的"wire 名注册、Runtime 配对"分工）。F4 只立通用卡——
// 注册表空着但结构在，registerToolView 是后续 feature 包的扩展缝。
// F5 叠 ui-approval：待决交互卡（工具审批双选项 / plan 四选项）——dsh
// ui-approval 的 $on 接管在 mini 的对应物：composer 上方一张卡，作答经
// decide 回传（瀑布的 answerer 半边），本组件只认 request 数据 + 回调 props。
//
// 红线：本文件只认 ConversationNode / ApprovalRequest 数据与 props，
// 看不见 store 与 transport。

import { useState, type ReactElement } from "react";
import type { ConversationNode } from "./conversation.js";
import type { ApprovalRequest, PlanChoice } from "./app-state.js";

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

// ── F5：ui-approval（待决交互卡） ──────────────────────────────────────────

const PLAN_OPTIONS: Array<{ choice: PlanChoice; label: string; hint: string }> = [
    { choice: "clear-and-execute", label: "1 清空上下文并执行", hint: "fresh start with auto-accept edits" },
    { choice: "execute", label: "2 批准执行", hint: "keep context, auto-accept edits" },
    { choice: "manual-execute", label: "3 手动确认执行", hint: "keep context, confirm each edit" },
    { choice: "keep-planning", label: "4 继续规划", hint: "provide feedback to revise" },
];

/** plan 四选项卡：选项文案与终端 printPlanApprovalOptions 同义；选项 4 展开
 *  反馈输入（空反馈与终端同款归 undefined）。 */
function PlanApprovalCard({ request, onPlanDecide }: {
    request: Extract<ApprovalRequest, { kind: "plan" }>;
    onPlanDecide: (id: string, choice: PlanChoice, feedback?: string) => void;
}) {
    const [feedbackMode, setFeedbackMode] = useState(false);
    const [feedback, setFeedback] = useState("");
    return (
        <div className="approval-card" data-kind="plan">
            <div className="approval-title">Plan 待审批</div>
            <pre className="mono plan-body">{request.planContent}</pre>
            {feedbackMode ? (
                <div className="approval-feedback">
                    <textarea
                        autoFocus
                        value={feedback}
                        placeholder="要修改什么？（回车发送，留空则不带反馈）"
                        onChange={(e) => setFeedback(e.target.value)}
                        onKeyDown={(e) => {
                            if (e.key === "Enter" && !e.shiftKey) {
                                e.preventDefault();
                                onPlanDecide(request.id, "keep-planning", feedback || undefined);
                            }
                        }}
                    />
                    <div className="approval-actions">
                        <button onClick={() => onPlanDecide(request.id, "keep-planning", feedback || undefined)}>发送反馈</button>
                        <button className="secondary" onClick={() => setFeedbackMode(false)}>返回选项</button>
                    </div>
                </div>
            ) : (
                <div className="approval-actions">
                    {PLAN_OPTIONS.map((opt) => (
                        <button
                            key={opt.choice}
                            className={opt.choice === "keep-planning" ? "secondary" : ""}
                            title={opt.hint}
                            onClick={() => {
                                if (opt.choice === "keep-planning") setFeedbackMode(true);
                                else onPlanDecide(request.id, opt.choice);
                            }}
                        >
                            {opt.label}
                        </button>
                    ))}
                </div>
            )}
        </div>
    );
}

export function ApprovalCard({ request, onDecide, onPlanDecide }: {
    request: ApprovalRequest;
    onDecide: (id: string, verdict: "allow-once" | "deny") => void;
    onPlanDecide: (id: string, choice: PlanChoice, feedback?: string) => void;
}): ReactElement {
    if (request.kind === "plan") {
        return <PlanApprovalCard request={request} onPlanDecide={onPlanDecide} />;
    }
    return (
        <div className="approval-card" data-kind="tool">
            <div className="approval-title">审批请求</div>
            <div className="approval-message">{request.message}</div>
            <details className="approval-detail">
                <summary className="muted mono">{request.tool}</summary>
                <pre className="mono">{JSON.stringify(request.input, null, 2)}</pre>
            </details>
            <div className="approval-actions">
                <button onClick={() => onDecide(request.id, "allow-once")}>允许一次</button>
                <button className="secondary" onClick={() => onDecide(request.id, "deny")}>拒绝</button>
            </div>
        </div>
    );
}
