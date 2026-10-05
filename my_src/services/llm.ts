// services/llm.ts——C6：LLM 适配 seam。
// 参照物：deepseek-harness-master/packages/llm/llm/src/{index,types,assembler}.ts、
// llm-deepseek/src/adapter.ts。
//
// 世界观：agent 不认识任何 SDK。它说 StreamChunk 方言，把请求交给 ctx.llm 按
// 路由分发——换后端 = 注册另一个适配器（plugins/adapter-echo.ts 二十行验证）。
//
// mini 的中立面只在**响应侧**：请求保持 Anthropic 线格式（mock 断言与请求体
// 等价验收都锚它）。真 dsh 连请求词汇表都中立（translate/serialize 双向翻译），
// 差距记 dsh-C6.md。usage 四计数：input/output/cacheRead/cacheCreation。

import type Anthropic from "@anthropic-ai/sdk";
import { Service } from "../cordis/service.js";
import type { Context } from "../cordis/context.js";
import type { TokenUsage } from "./session-log.js";

/** 流式词汇表（中立面的全部）。block-start 携带 tool_use 的 id/name——聚合器
 *  建块必需，词汇表为必要信息让路（C3 同款裁决：验收 > 规格字面）。 */
export type StreamChunk =
    | { t: "text-delta"; text: string }
    | { t: "tool-call-delta"; partialJson: string }
    | { t: "block-start"; kind: "text" | "tool"; id?: string; name?: string }
    | { t: "block-end" }
    | { t: "usage"; usage: TokenUsage }
    | { t: "finish"; reason: string };

/** 请求侧（Anthropic 线格式直通）：sideCall 类调用 system 是字符串、主循环是
 *  块数组——SDK 两种都收，各自字节形态原样上线路。 */
export interface NormalizedRequest {
    /** 适配器路由，缺省 "anthropic"。 */
    route?: string;
    model: string;
    maxTokens: number;
    system: string | Anthropic.TextBlockParam[];
    tools?: Anthropic.Tool[];
    messages: Anthropic.MessageParam[];
    temperature?: number;
}

/** 一次模型调用的结算：content 与旧 finalMessage().content 同构。 */
export interface Settlement {
    content: Anthropic.ContentBlockParam[];
    usage: TokenUsage;
    finishReason: string;
}

/** 旁路调用的结果（全部消费方都只要文本）。 */
export interface SideResult {
    text: string;
    usage: TokenUsage;
}

export interface LlmAdapter {
    stream(req: NormalizedRequest, signal?: AbortSignal): AsyncIterable<StreamChunk>;
    /** 可选非流式旁路：anthropic 覆写以保住 side call 的线格式（mock 断言锚了
     *  stream:false）；未覆写的适配器由 runtime 用流聚合兜底——sideCall 语义上
     *  可从 stream 推导，这正是接缝存在的证明。 */
    sideCall?(req: NormalizedRequest, signal?: AbortSignal): Promise<SideResult>;
}

export class LlmRuntime extends Service {
    private adapters = new Map<string, LlmAdapter>();

    registerAdapter(route: string, adapter: LlmAdapter): () => void {
        if (this.adapters.has(route)) {
            throw new Error(`[mini-cordis] llm route "${route}" already registered`);
        }
        this.adapters.set(route, adapter);
        let active = true;
        return () => {
            if (!active) return;
            active = false;
            this.adapters.delete(route);
        };
    }

    hasRoute(route: string): boolean {
        return this.adapters.has(route);
    }

    /** 按路由分发；llm/stream 瀑布挂点（监听器可换实现，C6 先立管道）。 */
    stream(req: NormalizedRequest, signal?: AbortSignal): AsyncIterable<StreamChunk> {
        const adapter = this.adapters.get(req.route ?? "anthropic");
        if (!adapter) {
            throw new Error(`[mini-cordis] no llm adapter registered for route "${req.route ?? "anthropic"}"`);
        }
        return this.ctx.waterfall("llm/stream", { req }, () => adapter.stream(req, signal));
    }

    /** 旁路便利层：T4 摘要 / memory selector / goal 评估器 / auto 分类器共用。 */
    async sideCall(req: NormalizedRequest, signal?: AbortSignal): Promise<SideResult> {
        const adapter = this.adapters.get(req.route ?? "anthropic");
        if (!adapter) {
            throw new Error(`[mini-cordis] no llm adapter registered for route "${req.route ?? "anthropic"}"`);
        }
        if (adapter.sideCall) return adapter.sideCall(req, signal);
        const settlement = await assembleStream(this.stream(req, signal));
        return {
            text: settlement.content
                .filter((b): b is Anthropic.TextBlock => b.type === "text")
                .map((b) => b.text).join(""),
            usage: settlement.usage,
        };
    }
}

/** 聚合器（dsh assembler.ts 的 mini 版）：chunk 流 → 结算。onText 挂 text-delta
 *  （主循环的流式打印口）。工具入参在 block-end 时 JSON.parse——空串视作 {}
 *  （无参工具的合法形态，finalMessage 同义）。 */
export async function assembleStream(
    chunks: AsyncIterable<StreamChunk>,
    onText?: (text: string) => void,
): Promise<Settlement> {
    const content: Anthropic.ContentBlockParam[] = [];
    let usage: TokenUsage = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };
    let finishReason = "";
    let current: { kind: "text"; text: string } | { kind: "tool"; id: string; name: string; json: string } | null = null;
    for await (const chunk of chunks) {
        switch (chunk.t) {
            case "block-start":
                current = chunk.kind === "text"
                    ? { kind: "text", text: "" }
                    : { kind: "tool", id: chunk.id ?? "", name: chunk.name ?? "", json: "" };
                break;
            case "text-delta":
                if (current?.kind === "text") current.text += chunk.text;
                onText?.(chunk.text);
                break;
            case "tool-call-delta":
                if (current?.kind === "tool") current.json += chunk.partialJson;
                break;
            case "block-end":
                if (current?.kind === "text") {
                    content.push({ type: "text", text: current.text });
                } else if (current?.kind === "tool") {
                    const json = current.json.trim();
                    content.push({
                        type: "tool_use",
                        id: current.id,
                        name: current.name,
                        input: json ? JSON.parse(json) : {},
                    } as Anthropic.ContentBlockParam);
                }
                current = null;
                break;
            case "usage":
                usage = chunk.usage;
                break;
            case "finish":
                finishReason = chunk.reason;
                break;
        }
    }
    return { content, usage, finishReason };
}

declare module "../cordis/context.js" {
    interface Context {
        llm?: LlmRuntime;
    }
}

declare module "../cordis/events.js" {
    interface Events {
        /** 模型调用分发口：监听器可换流实现（重试/遥测/路由改写的挂点）。 */
        "llm/stream"(payload: { req: NormalizedRequest }, next: () => AsyncIterable<StreamChunk>): AsyncIterable<StreamChunk>;
    }
}
