// services/session-log.ts——C3：会话事件日志（本轮最核心）。
// 参照物：deepseek-harness-master/packages/core/session/src/index.ts 的 derive 段
// 与 surface.ts。
//
// 世界观：会话 = 事件日志。model-visible ⟺ logged——请求参数是日志的投影，
// 不是平行记账的另一份状态。
//
// mini 的 C3 边界（诚实记档，详见 dsh-C3.md）：
//   - 线上工作集（agent.messages）仍是请求体来源：压缩层 T1–T4 会原地改写它，
//     而日志是 append-only 的——两者的发散点就是 D5"压缩投影 replace"要接管
//     的缝，derive 在 user/tool_result 事件 → MessageParam 的映射处留了挂点
//   - tool/call 与 tool/result 是注记事件（derive 不消费）：线格式已完整保存在
//     user/assistant 事件里，注记供 D5 按块定位改写与 C5 循环事件使用。
//     真 dsh 从 tool 事件重组消息（surface.ts），mini 双记，口径差异记档
//   - system/message 的 content 是 JSON 编码的 system 块数组（含 cache_control），
//     而非裸文本——derive 只取最新一条，解析后与请求体逐字节等价

import type Anthropic from "@anthropic-ai/sdk";
import { Service } from "../cordis/service.js";

export interface TokenUsage {
    input: number;
    output: number;
    cacheRead: number;
    cacheCreation: number;
}

export type SessionEvent =
    | { type: "system/message"; content: string; cacheBreakpoint?: boolean }
    | { type: "user/message"; content: string | Anthropic.ContentBlockParam[] }
    | { type: "assistant/message"; content: Anthropic.ContentBlockParam[]; usage?: TokenUsage }
    | { type: "tool/call"; id: string; name: string; input: Record<string, any> }
    | { type: "tool/result"; callId: string; content: string; isError?: boolean }
    | { type: "turn/start" }
    | { type: "turn/end"; reason: string }
    | { type: "meta/note"; key: string; value: unknown };

export class SessionLog extends Service {
    private log: SessionEvent[] = [];
    // C8：持久化订阅——onAppend 拿到的是**进入合并前的原始事件**（重放再走
    // append 会得到同样的合并结果，JSONL 因此可以存原始流）
    private appendListeners: Array<(evt: SessionEvent) => void> = [];
    private clearListeners: Array<() => void> = [];

    get events(): readonly SessionEvent[] {
        return this.log;
    }

    onAppend(fn: (evt: SessionEvent) => void): () => void {
        this.appendListeners.push(fn);
        let active = true;
        return () => {
            if (!active) return;
            active = false;
            this.appendListeners = this.appendListeners.filter((f) => f !== fn);
        };
    }

    onClear(fn: () => void): () => void {
        this.clearListeners.push(fn);
        let active = true;
        return () => {
            if (!active) return;
            active = false;
            this.clearListeners = this.clearListeners.filter((f) => f !== fn);
        };
    }

    /**
     * 追加事件。连续 user/message 在入口合并（防 API 400：roles must alternate），
     * 语义与迁移前 chat() 的合并完全一致：字符串拼进字符串（\n\n 分隔）；
 * tool_result 批次（数组）追加 text 块。C4 起 WHO/WHEN 的裁决迁给 inbox。
     */
    append(evt: SessionEvent): void {
        for (const fn of [...this.appendListeners]) fn(evt);
        if (evt.type === "user/message") {
            const last = this.log[this.log.length - 1];
            if (last && last.type === "user/message") {
                if (typeof last.content === "string" && typeof evt.content === "string") {
                    last.content = last.content ? `${last.content}\n\n${evt.content}` : evt.content;
                } else {
                    const blocks = (Array.isArray(last.content) ? last.content : []) as Anthropic.ContentBlockParam[];
                    blocks.push({ type: "text", text: typeof evt.content === "string" ? evt.content : "" });
                    last.content = blocks;
                }
                return;
            }
        }
        this.log.push(evt);
    }

    /** 最近一条 system 事件的编码内容（对比去重用），没有则 undefined。 */
    peekLastSystem(): string | undefined {
        for (let i = this.log.length - 1; i >= 0; i--) {
            const evt = this.log[i];
            if (evt.type === "system/message") return evt.content;
        }
        return undefined;
    }

    /**
     * 纯投影：事件流 → 请求参数。同一事件流重放任意次结果一致；返回深拷贝，
     * 调用方改写不影响日志。只取最新一条 system（动态段会变，旧的不进请求）；
     * tool/turn/meta 注记不进请求。
     * D5 缝：压缩投影 replace 将挂在 user 事件 → MessageParam 的映射处
     *（按事件序号查投影表，被压缩改写的 tool_result 在此换皮）。
     */
    derive(): { system: Anthropic.TextBlockParam[]; messages: Anthropic.MessageParam[] } {
        let system: Anthropic.TextBlockParam[] = [];
        const messages: Anthropic.MessageParam[] = [];
        for (const evt of this.log) {
            switch (evt.type) {
                case "system/message":
                    try {
                        system = JSON.parse(evt.content);
                    } catch { /* D5 缝：投影层接管前的防御空转 */ }
                    break;
                case "user/message":
                    messages.push({ role: "user", content: clone(evt.content) } as Anthropic.MessageParam);
                    break;
                case "assistant/message":
                    messages.push({ role: "assistant", content: clone(evt.content) } as Anthropic.MessageParam);
                    break;
                default:
                    break; // tool/call | tool/result | turn/* | meta/note：注记
            }
        }
        return { system, messages };
    }

    /** 回放：消息数组 → 事件流（session 恢复路径）。usage 不可考，不带。 */
    load(messages: Anthropic.MessageParam[]): void {
        this.log = [];
        for (const msg of messages) {
            if (msg.role === "user") {
                this.append({ type: "user/message", content: clone(msg.content) as Anthropic.ContentBlockParam[] });
            } else if (msg.role === "assistant") {
                this.append({
                    type: "assistant/message",
                    content: clone(msg.content) as Anthropic.ContentBlockParam[],
                });
            }
        }
    }

    /** 截断（clearHistory 路径）。真 append-only 的不可变会话在 D 阶段持久化时再立。 */
    clear(): void {
        for (const fn of [...this.clearListeners]) fn();
        this.log = [];
    }
}

function clone<T>(value: T): T {
    return value === undefined ? value : JSON.parse(JSON.stringify(value));
}

declare module "../cordis/context.js" {
    interface Context {
        "session-log"?: SessionLog;
    }
}
