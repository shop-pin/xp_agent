// plugins/adapter-echo.ts——C6：教学用最小适配器（二十行上下）。
// 复读最后一条 user 消息——验证"换后端 = 换一行路由配置"：route 指到 echo，
// 整个 agent 循环零改动跑在假后端上（场景 31，mock 不应收到任何请求）。
// sideCall 不覆写：runtime 用流聚合兜底，顺便验证接缝的可推导性。

import type { Context } from "../cordis/context.js";
import type { LlmRuntime, NormalizedRequest, StreamChunk } from "../services/llm.js";

function lastUserText(req: NormalizedRequest): string {
    for (let i = req.messages.length - 1; i >= 0; i--) {
        const m = req.messages[i];
        if (m.role !== "user") continue;
        const c = m.content as unknown;
        if (typeof c === "string") return c;
        if (Array.isArray(c)) {
            const joined = (c as Array<{ type?: string; text?: string }>)
                .filter((b) => b.type === "text").map((b) => b.text ?? "").join("\n");
            if (joined) return joined;
        }
    }
    return "(no user message)";
}

export const adapterEchoPlugin = {
    name: "adapter-echo",
    inject: ["llm"],
    apply(ctx: Context, config: { route?: string } = {}) {
        ctx.require<LlmRuntime>("llm").registerAdapter(config.route ?? "echo", {
            async *stream(req: NormalizedRequest): AsyncIterable<StreamChunk> {
                yield { t: "block-start", kind: "text" };
                yield { t: "text-delta", text: `[echo] ${lastUserText(req)}` };
                yield { t: "block-end" };
                yield { t: "usage", usage: { input: 1, output: 1, cacheRead: 0, cacheCreation: 0 } };
                yield { t: "finish", reason: "end_turn" };
            },
        });
    },
};
