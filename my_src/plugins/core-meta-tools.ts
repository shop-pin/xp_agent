// plugins/core-meta-tools.ts——C1：元工具（tool_search）+ 魔法名的 schema 占位。
// tool_search 的 execute 自 tools.ts 原样迁出（激活态经 services/tools 的模块
// 级共享集合，行为不变）。enter/exit_plan_mode、skill 三个工具的执行
// 被 agent 循环的魔法名链在更早处拦截，注册它们只为保住广告顺序：
// 注册序 = 旧 toolDefinitions 数组序 = 请求体 tools 数组序的生命线。
// （agent 工具自 D3 起由 plugins/subagent.ts 注册真身，不再是占位。）

import type { Context } from "../cordis/context.js";
import { activateTools, type ToolsService, type ToolDefinition, type JSONSchema } from "../services/tools.js";
import type { SessionLog } from "../services/session-log.js";
import { toolDefinitions } from "../tools.js";

function schemaOf(name: string): Pick<ToolDefinition, "description" | "parameters" | "deferred"> {
    const def = toolDefinitions.find((t) => t.name === name)!;
    return {
        description: def.description ?? "",
        parameters: def.input_schema as unknown as JSONSchema,
        deferred: def.deferred,
    };
}

/** 魔法名工具的注册表兜底：执行被 agent 循环拦截，真跑到这里是路由异常。 */
function magicFallback(name: string) {
    return async () => `Error: tool "${name}" is routed by the agent loop's dispatch chain, not the registry.`;
}

export const coreMetaTools = {
    name: "core-meta-tools",
    apply(ctx: Context) {
        const tools = ctx.require<ToolsService>("tools");
        // 注册序 = 旧 toolDefinitions 数组序（enter/exit/skill/agent 在前，tool_search 收尾）
        tools.register({
            name: "enter_plan_mode",
            ...schemaOf("enter_plan_mode"),
            permissionHint: "meta",
            execute: magicFallback("enter_plan_mode"),
        });
        tools.register({
            name: "exit_plan_mode",
            ...schemaOf("exit_plan_mode"),
            permissionHint: "meta",
            execute: magicFallback("exit_plan_mode"),
        });
        tools.register({
            name: "skill",
            ...schemaOf("skill"),
            permissionHint: "meta",
            execute: magicFallback("skill"),
        });
        tools.register({
            name: "tool_search",
            ...schemaOf("tool_search"),
            permissionHint: "meta",
            execute: (input) => {
                const query = ((input.query as string) || "").toLowerCase();
                const deferred = tools.list().filter((t) => t.deferred);
                const matches = deferred.filter((t) =>
                    t.name.toLowerCase().includes(query) ||
                    ((t.description as string) || "").toLowerCase().includes(query)
                );
                if (matches.length === 0) return "No matching deferred tools found.";
                const names = matches.map((m) => m.name);
                activateTools(names);
                // C8：激活态进会话日志（meta/note）——resume 重放后仍广告
                ctx.get<SessionLog>("session-log")?.append({
                    type: "meta/note", key: "activated-tools", value: names,
                });
                // 直接 return：命中即激活，返回完整 schema 让模型立刻会用
                return JSON.stringify(matches.map((t) => ({
                    name: t.name,
                    description: t.description,
                    input_schema: t.parameters,
                })), null, 2);
            },
        });
    },
};
