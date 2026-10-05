// plugins/llm-anthropic.ts——C6：Anthropic 适配器。
// 参照物：packages/llm/llm-deepseek/src/{adapter,serialize,translate}.ts。
// 流：SDK MessageStream 的原始 SSE 事件 → StreamChunk（for-await 异步迭代）；
// 旁路：messages.create 非流式——side call 的线格式 stream:false 被 mock 断言
// 锚定（场景 7/15），必须原样保留。

import Anthropic from "@anthropic-ai/sdk";
import type { Context } from "../cordis/context.js";
import type { LlmAdapter, LlmRuntime, NormalizedRequest, SideResult, StreamChunk } from "../services/llm.js";
import type { TokenUsage } from "../services/session-log.js";

/** NormalizedRequest → 线参数：undefined 字段全部省略（键不出现在请求体里，
 *  字节等价的细节之一）。 */
function toParams(req: NormalizedRequest) {
    return {
        model: req.model,
        max_tokens: req.maxTokens,
        system: req.system,
        ...(req.tools !== undefined ? { tools: req.tools } : {}),
        messages: req.messages,
        ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
    };
}

export class AnthropicAdapter implements LlmAdapter {
    private client: Anthropic;

    constructor() {
        // 可选：封 SDK 自带的重试层（默认 2）。MINI_CLAUDE_SDK_MAX_RETRIES=0
        // 用于在测试里隔离我们自己的 withRetry——否则 SDK 先吞掉失败，
        // mock 注入的 429 永远到不了用户代码
        const sdkRetries =
            process.env.MINI_CLAUDE_SDK_MAX_RETRIES != null && process.env.MINI_CLAUDE_SDK_MAX_RETRIES !== "" &&
                !Number.isNaN(Number(process.env.MINI_CLAUDE_SDK_MAX_RETRIES))
                ? { maxRetries: Number(process.env.MINI_CLAUDE_SDK_MAX_RETRIES) }
                : {};
        this.client = new Anthropic({
            apiKey: process.env.ANTHROPIC_API_KEY,
            baseURL: process.env.ANTHROPIC_BASE_URL,
            ...sdkRetries,
        });
    }

    async *stream(req: NormalizedRequest, signal?: AbortSignal): AsyncIterable<StreamChunk> {
        const stream = this.client.messages.stream(toParams(req), { signal });
        // 四计数的线位置：input/cache 在 message_start，output 在 message_delta
        // ——与 SDK finalMessage 的合并口径一致
        const usage: TokenUsage = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };
        let finishReason = "";
        for await (const ev of stream) {
            switch (ev.type) {
                case "content_block_start": {
                    const block = ev.content_block;
                    if (block.type === "tool_use") {
                        yield { t: "block-start", kind: "tool", id: block.id, name: block.name };
                    } else if (block.type === "text") {
                        yield { t: "block-start", kind: "text" };
                    }
                    break;
                }
                case "content_block_delta": {
                    const delta = ev.delta as { type: string; text?: string; partial_json?: string };
                    if (delta.type === "text_delta") {
                        yield { t: "text-delta", text: delta.text ?? "" };
                    } else if (delta.type === "input_json_delta") {
                        yield { t: "tool-call-delta", partialJson: delta.partial_json ?? "" };
                    }
                    break;
                }
                case "content_block_stop":
                    yield { t: "block-end" };
                    break;
                case "message_start": {
                    const u = ev.message.usage as Anthropic.Usage & {
                        cache_read_input_tokens?: number;
                        cache_creation_input_tokens?: number;
                    };
                    usage.input = u.input_tokens ?? 0;
                    usage.cacheRead = u.cache_read_input_tokens ?? 0;
                    usage.cacheCreation = u.cache_creation_input_tokens ?? 0;
                    break;
                }
                case "message_delta":
                    usage.output = ev.usage.output_tokens ?? 0;
                    finishReason = ev.delta.stop_reason ?? "";
                    break;
                case "message_stop":
                    yield { t: "usage", usage: { ...usage } };
                    yield { t: "finish", reason: finishReason };
                    break;
            }
        }
    }

    async sideCall(req: NormalizedRequest, signal?: AbortSignal): Promise<SideResult> {
        const resp = await this.client.messages.create(toParams(req), { signal });
        const u = resp.usage as Anthropic.Usage & {
            cache_read_input_tokens?: number;
            cache_creation_input_tokens?: number;
        };
        return {
            text: resp.content
                .filter((b): b is Anthropic.TextBlock => b.type === "text")
                .map((b) => b.text).join(""),
            usage: {
                input: u?.input_tokens ?? 0,
                output: u?.output_tokens ?? 0,
                cacheRead: u?.cache_read_input_tokens ?? 0,
                cacheCreation: u?.cache_creation_input_tokens ?? 0,
            },
        };
    }
}

export const llmAnthropicPlugin = {
    name: "llm-anthropic",
    inject: ["llm"],
    apply(ctx: Context) {
        ctx.require<LlmRuntime>("llm").registerAdapter("anthropic", new AnthropicAdapter());
    },
};
