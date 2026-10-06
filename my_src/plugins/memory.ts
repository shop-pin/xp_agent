// plugins/memory.ts——D4：memory 语义召回插件化。
//
// 旧机制（agent.ts 字段 + 循环内轮询）：turn 开场发 prefetch，每个 step 顶
// poll 一次 settled，settled 就地改写最后一条 user 消息——**日志盲区**：注入
// 内容从不进 SessionLog（C3 的发散点之一）。
// 新机制：turn 边界（pre-step 的 turn 形态）发起召回；落定即 bridge.inject()
// ——注入排 inbox next-step，最近的 step/turn 边界 claim 后经 pushUser 进消息
// 与日志（model-visible ⟺ logged，盲区闭合）。轮询消失：落定是**推**
// （settle → inject），不是拉（step 顶 poll）。
//
// 晚归的 prefetch 不需要"排掉"（旧 startMemoryPrefetchForTurn 的 consume-first）：
// 它的 continuation 照样 inject，由下一个 claim 点消费；alreadySurfaced 去重
// 防同一记忆一个会话注两次。

import type { Context } from "../cordis/context.js";
import type { LlmRuntime } from "../services/llm.js";
import { MODEL } from "../services/llm.js";
import { startMemoryPrefetch, formatMemoriesForInjection, type SideQueryFn } from "../memory.js";

export interface MemoryBridge {
    /** 下一请求注入（AgentHandle.inject：next-step 排队，不唤醒）。 */
    inject(text: string): void;
}

export const memoryPlugin = {
    name: "memory-prefetch",
    inject: ["llm"],
    apply(ctx: Context, config: { bridge: MemoryBridge; enabled?: boolean }) {
        if (config.enabled === false) return;
        const llm = ctx.require<LlmRuntime>("llm");
        // 会话级簿记（旧 Agent 字段迁插件闭包）
        const surfaced = new Set<string>();
        let surfacedBytes = 0;
        const sideQuery: SideQueryFn = async (system, userMessage) => {
            const { text } = await llm.sideCall({
                model: MODEL,
                maxTokens: 256,
                system,
                temperature: 0,
                messages: [{ role: "user", content: userMessage }],
            });
            return text;
        };
        ctx.on("agent/pre-step", (payload, next) => {
            // 观察者礼仪（D1 教训）：先委托，next() 的裁决原样返回——本插件不改写输入
            const decision = next();
            if (payload.boundary === "turn" && payload.input.length > 0) {
                const pf = startMemoryPrefetch(payload.input.join("\n\n"), sideQuery, surfaced, surfacedBytes);
                if (pf) {
                    pf.promise.then((memories) => {
                        if (memories.length === 0) return;
                        for (const m of memories) {
                            surfaced.add(m.path);
                            surfacedBytes += Buffer.byteLength(m.content);
                        }
                        config.bridge.inject(formatMemoriesForInjection(memories));
                    }).catch(() => { /* selector 失败静默——召回是尽力而为 */ });
                }
            }
            return decision;
        });
    },
};
