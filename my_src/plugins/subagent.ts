// plugins/subagent.ts——D3：subagent 插件化。
// 参照物：dsh 的 agent 工具 + registry 分工（packages/core/agent 与 tool 层）。
//
// 三件事：
//   ① agent 工具从魔法名链迁入注册表（execute = 查 preset → ctx.agents.create
//      → runOnce → token 回滚），executeToolCall 的 agent 分支消亡
//   ② preset 数据化：剥工具防递归从散落的 `!== "agent"` 过滤变成一张排除表
//      （DEFAULT_EXCLUDES：agent 防递归失控 + schedule_wakeup 防驱动内部工具外流）
//   ③ 防洗白检查迁到 preset 构造（childModeOf：plan/auto 穿透，否则 bypass）
//
// mini 的 B2 语义（全树共享服务表）挡住了"子树共享父服务 + isolate 过滤派发"
// 的完整 per-agent scope（B5 已记档"真框架有、我们略"）——子 agent 仍是独立
// 树，隔离靠"子树不加载本插件 + preset 排除表"双层实现，记入 dsh-D3.md 差距表。

import type { Context } from "../cordis/context.js";
import type { ToolsService, ToolDefinition, JSONSchema } from "../services/tools.js";
import type { AgentRegistry } from "../services/agents.js";
import type { AgentHandle } from "../services/agents.js";
import type { PermissionMode } from "../permissions.js";
import type { ToolDef } from "../tools.js";
import { toolDefinitions } from "../tools.js";
import { getSubAgentConfig, type SubAgentType } from "../subagent.js";
import { printSubAgentStart, printSubAgentEnd } from "../ui.js";

/** 排除表（数据即文档）：agent 防递归失控；schedule_wakeup 是 loop 驱动内部工具。 */
export const DEFAULT_EXCLUDES: ReadonlySet<string> = new Set(["agent", "schedule_wakeup"]);

/** 防洗白（自 agent.ts 的 childPermissionMode 迁入）：plan/auto 必须穿透——
 *  否则主对话被拦的操作可以借 bypass 子 agent 绕过闸门。 */
export function childModeOf(parentMode: PermissionMode): PermissionMode {
    if (parentMode === "plan") return "plan";
    if (parentMode === "auto") return "auto";
    return "bypassPermissions";
}

export interface AgentPreset {
    systemPrompt: string;
    tools: ToolDef[];
    permissionMode: PermissionMode;
    /** 实际应用的排除表（诊断/断言用）。 */
    excludes: string[];
}

function applyExcludes(tools: ToolDef[], excludes: ReadonlySet<string>): ToolDef[] {
    return tools.filter((t) => !excludes.has(t.name));
}

/** 按类型构造 preset（内建 explore/plan/general + .claude/agents 自定义）。 */
export function buildPresetFromType(type: SubAgentType, parentMode: PermissionMode): AgentPreset {
    const config = getSubAgentConfig(type);
    return {
        systemPrompt: config.systemPrompt,
        tools: applyExcludes(config.tools, DEFAULT_EXCLUDES),
        permissionMode: childModeOf(parentMode),
        excludes: [...DEFAULT_EXCLUDES],
    };
}

/** skill fork 的 preset：白名单在父工具集上解析（缺省全量），排除表同上。 */
export function buildPresetFromSkill(
    skill: { allowedTools?: string[] },
    parentMode: PermissionMode,
    base: ToolDef[] = toolDefinitions,
): AgentPreset {
    const tools = skill.allowedTools
        ? base.filter((t) => skill.allowedTools!.includes(t.name))
        : base;
    return {
        systemPrompt: "",
        tools: applyExcludes(tools, DEFAULT_EXCLUDES),
        permissionMode: childModeOf(parentMode),
        excludes: [...DEFAULT_EXCLUDES],
    };
}

/** Agent 借给插件的桥：父模式（防洗白）与 token 回滚。 */
export interface SubagentBridge {
    parentMode(): PermissionMode;
    addTokens(input: number, output: number): void;
}

export const subagentPlugin = {
    name: "subagent",
    inject: ["tools", "agents"],
    apply(ctx: Context, config: { bridge: SubagentBridge; enabled?: boolean }) {
        if (config.enabled === false) return;
        const agents = ctx.require<AgentRegistry>("agents");
        const tools = ctx.require<ToolsService>("tools");
        const def = toolDefinitions.find((t) => t.name === "agent")!;
        tools.register({
            name: "agent",
            description: def.description ?? "",
            parameters: def.input_schema as unknown as JSONSchema,
            permissionHint: "meta",
            execute: async (input: Record<string, any>) => {
                const type = (input.type || "general") as SubAgentType;
                const description = input.description || "sub-agent task";
                const prompt = input.prompt || "";

                printSubAgentStart(type, description);
                const preset = buildPresetFromType(type, config.bridge.parentMode());
                const child: AgentHandle = agents.create({
                    customSystemPrompt: preset.systemPrompt,
                    customTools: preset.tools,
                    isSubAgent: true,
                    permissionMode: preset.permissionMode,
                });
                try {
                    const result = await child.runOnce(prompt);
                    // 子对话的消耗也是真实成本：token 增量记回父级，费用统计才完整
                    config.bridge.addTokens(result.tokens.input, result.tokens.output);
                    printSubAgentEnd(type, description);
                    return result.text || "(Sub-agent produced no output)";
                } catch (e: any) {
                    printSubAgentEnd(type, description);
                    return `Sub-agent error: ${e.message}`;
                }
            },
        });
    },
};
