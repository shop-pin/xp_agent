// webui/conversation.ts——F4：会话装配（dsh ui-conversation 双注册表的
// 第一张：事件注册表）。事件流 → ConversationNode[] 的纯 fold，React-free、
// 零依赖（node:test 直接吃，浏览器 bundle 不拖 SDK）。
//
// 事件类型是 SessionEvent（services/session-log.ts）的结构副本——客户端自有
// 类型，wire 是 JSON（dsh client 同款：类型自有，不 import 引擎）。
//
// 三个装配规则：
//   1. UI = 原始日志视图：message/replace、history/truncate 是请求投影的
//      改写事件（D5），UI 不跟随——压缩不改写已发生的历史，用户看到的是
//      真相（dsh surface 折叠出投影视图，口径差异记档）。
//   2. tool 卡自注记事件（tool/call + tool/result 按 id 配对）装配，user
//      消息里的 tool_result 宿主块跳过——双记事件只渲染一份（E1 终端同款）。
//   3. user 文本里的 <system-reminder> 拆成独立 injection 节点——目录注入
//      （D1）/记忆注入（D4）是机制事实，不冒充用户的话。

export interface UsageInfo {
    input: number;
    output: number;
    cacheRead: number;
    cacheCreation: number;
}

export interface ToolResult {
    content: string;
    isError: boolean;
}

export type ConversationNode =
    | { kind: "turn"; seq: number; index: number; endReason?: string }
    | { kind: "user"; seq: number; text: string }
    | { kind: "injection"; seq: number; text: string }
    | { kind: "assistant"; seq: number; text: string; usage?: UsageInfo }
    | { kind: "tool"; seq: number; callId: string; name: string; input: unknown; result?: ToolResult }
    | { kind: "orphan-result"; seq: number; callId: string; content: string; isError: boolean }
    | { kind: "error"; seq: number; message: string };

/** SessionEvent 的结构副本（只取装配消费的字段；wire 形状以 JSON 为准）。 */
type WireEvent =
    | { type: "turn/start" }
    | { type: "turn/end"; reason: string }
    | { type: "user/message"; content: string | Array<{ type: string; text?: string }> }
    | { type: "assistant/message"; content: Array<{ type: string; text?: string }>; usage?: UsageInfo }
    | { type: "tool/call"; id: string; name: string; input: unknown }
    | { type: "tool/result"; callId: string; content: string; isError?: boolean }
    | { type: "meta/note"; key: string; value: unknown }
    | { type: "system/message" | "message/replace" | "history/truncate"; [k: string]: unknown };

export function assembleConversation(entries: Array<{ seq: number; event: unknown }>): ConversationNode[] {
    const nodes: ConversationNode[] = [];
    const toolByCallId = new Map<string, Extract<ConversationNode, { kind: "tool" }>>();
    let turnIndex = 0;

    for (const { seq, event } of entries) {
        const evt = event as WireEvent;
        switch (evt?.type) {
            case "turn/start":
                nodes.push({ kind: "turn", seq, index: ++turnIndex });
                break;
            case "turn/end": {
                for (let i = nodes.length - 1; i >= 0; i--) {
                    const node = nodes[i];
                    if (node.kind === "turn") {
                        node.endReason = evt.reason;
                        break;
                    }
                }
                break;
            }
            case "user/message":
                pushUserContent(nodes, seq, evt.content);
                break;
            case "assistant/message": {
                // tool_use 块不在这里渲染——tool/call 注记 owns 卡片（双记只渲染一份）
                const text = evt.content
                    .filter((b) => b.type === "text")
                    .map((b) => b.text ?? "")
                    .join("\n\n");
                // 纯工具轮（无文本）不出气泡：卡片已讲完故事（usage 跟随有文本的消息）
                if (text) nodes.push({ kind: "assistant", seq, text, usage: evt.usage });
                break;
            }
            case "tool/call": {
                const node: Extract<ConversationNode, { kind: "tool" }> = {
                    kind: "tool", seq, callId: evt.id, name: evt.name, input: evt.input,
                };
                nodes.push(node);
                toolByCallId.set(evt.id, node);
                break;
            }
            case "tool/result": {
                // 预算/崩溃路径的孤儿结果（无主 callId）——独立错误行，不静默丢
                const card = toolByCallId.get(evt.callId);
                if (card) card.result = { content: evt.content, isError: !!evt.isError };
                else nodes.push({ kind: "orphan-result", seq, callId: evt.callId, content: evt.content, isError: !!evt.isError });
                break;
            }
            case "meta/note":
                // prompt-error：host 桥拒绝（turn 没跑起来，turn/end 不会来）——
                // 客户端 busy 的另一个解除界碑
                if (evt.key === "prompt-error") {
                    nodes.push({ kind: "error", seq, message: String(evt.value ?? "") });
                }
                break;
            default:
                break; // system/message | message/replace | history/truncate | 其余 meta
        }
    }
    return nodes;
}

function pushUserContent(
    nodes: ConversationNode[],
    seq: number,
    content: string | Array<{ type: string; text?: string }>,
): void {
    if (typeof content === "string") {
        splitReminders(nodes, seq, content);
        return;
    }
    // tool_result 宿主消息（D5 批次）不渲染——结果已在卡片上
    const texts = content.filter((b) => b.type === "text").map((b) => b.text ?? "");
    if (texts.length > 0) splitReminders(nodes, seq, texts.join("\n\n"));
}

/** <system-reminder> 体拆成 injection 节点；之间的正文是 user 节点。 */
function splitReminders(nodes: ConversationNode[], seq: number, text: string): void {
    const re = /<system-reminder>([\s\S]*?)<\/system-reminder>/g;
    let cursor = 0;
    for (const match of text.matchAll(re)) {
        const before = text.slice(cursor, match.index);
        if (before.trim()) nodes.push({ kind: "user", seq, text: before.trim() });
        nodes.push({ kind: "injection", seq, text: match[1].trim() });
        cursor = match.index + match[0].length;
    }
    const tail = text.slice(cursor);
    if (tail.trim()) nodes.push({ kind: "user", seq, text: tail.trim() });
}
