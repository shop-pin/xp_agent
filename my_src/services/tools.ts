// services/tools.ts——C1：工具注册表。第一个长在 B 阶段地基上的业务服务。
// 参照物：deepseek-harness-master/packages/core/tools/src/index.ts（ToolDefinition
// 接口段）与 docs/cookbook/adding-a-tool.md。
//
// 职责边界（C1）：
//   - 注册表本体：register（返回 disposer，走插件 fiber 的 effect 自动回滚）/
//     get / list（顺序 = 注册序，必须与旧 toolDefinitions 数组序一致——请求体
//     tools 数组逐字节等价的生命线）
//   - 激活态：tool_search 的"一次搜索，终身有效"仍是模块级全局（对齐 src：
//     主对话激活对后续所有请求含子 agent 生效），收编进本模块
//   - truncateResult：工具输出截断的归属也在这里，行为不变
//
// 真框架有、mini 略（记入当章文档差距清单）：output.schema/render、
// isConcurrencySafe、timeoutMs、presentCall/Result、mcp 动态工具的类型面。

import type Anthropic from "@anthropic-ai/sdk";
import { Service } from "../cordis/service.js";
import { toolDefinitions, type ToolDef } from "../tools.js";

/** 工具参数的 JSON Schema（即 Anthropic.Tool 的 input_schema）。 */
export interface JSONSchema {
    type: "object";
    properties?: Record<string, unknown>;
    required?: string[];
}

/** 权限提示：C2 权限瀑布用，C1 只挂上不消费。 */
export type PermissionHint = "read" | "edit" | "exec" | "meta";

/** 工具执行上下文：agent 循环借给工具的运行时资源（随章节扩充）。 */
export interface ToolExec {
    /** read-before-edit 簿记：路径 → 上次读取的 mtime。 */
    readFileState?: Map<string, number>;
}

export interface ToolDefinition {
    name: string;
    description: string;
    parameters: JSONSchema;
    permissionHint?: PermissionHint;
    /** deferred 工具不随 schema 广告，tool_search 命中后激活。 */
    deferred?: boolean;
    /** execute 函数体自 tools.ts 的 switch 原样迁出；多数工具是同步的。 */
    execute(input: Record<string, any>, exec: ToolExec): string | Promise<string>;
}

// 激活态模块级全局（语义对齐迁移前的 tools.ts）：跨 Agent 实例共享
const activatedTools = new Set<string>();

export function resetActivatedTools(): void {
    activatedTools.clear();
}

export function activateTools(names: string[]): void {
    for (const name of names) activatedTools.add(name);
}

export function isActivated(name: string): boolean {
    return activatedTools.has(name);
}

/** 发请求用的工具清单：非 deferred 全量，deferred 只给已激活的；deferred 标记剥掉。 */
export function getActiveToolDefinitions(allTools?: ToolDef[]): Anthropic.Tool[] {
    const tools = allTools || toolDefinitions;
    return tools
        .filter((t) => !t.deferred || activatedTools.has(t.name))
        .map(({ deferred, ...rest }) => rest);
}

/** 还没激活的 deferred 工具名单——拼进 system 提示，模型才知道去搜什么。 */
export function getDeferredToolNames(allTools?: ToolDef[]): string[] {
    const tools = allTools || toolDefinitions;
    return tools
        .filter((t) => t.deferred && !activatedTools.has(t.name))
        .map((t) => t.name);
}

const MAX_RESULT_CHARS = 50000;

/** 保留头尾、砍中间：编译错误摘要、测试结果统计这类关键信息往往在输出末尾。 */
export function truncateResult(result: string): string {
    if (result.length <= MAX_RESULT_CHARS) return result;
    const keepEach = Math.floor((MAX_RESULT_CHARS - 60) / 2);
    return (
        result.slice(0, keepEach) +
        `\n\n[... truncated ${result.length - keepEach * 2} chars ...]\n\n` +
        result.slice(-keepEach)
    );
}

export class ToolsService extends Service {
    private defs: ToolDefinition[] = [];

    /**
     * 注册工具，返回 disposer（只删自己的注册，幂等）。插件内调用时经 B3
     * effect 自动收集——插件卸载，工具从模型视野消失。
     * 同名重复注册 fail-loud：服务表冲突语义（B2）在注册表层的同款。
     */
    register(def: ToolDefinition): () => void {
        if (this.defs.some((d) => d.name === def.name)) {
            throw new Error(`[mini-cordis] tool "${def.name}" has been registered already`);
        }
        this.defs.push(def);
        let active = true;
        return () => {
            if (!active) return;
            active = false;
            this.defs = this.defs.filter((d) => d !== def);
        };
    }

    /** 按名取工具定义；mcp__ 动态名的占位逻辑仍在 agent 侧，不在这里。 */
    get(name: string): ToolDefinition | undefined {
        return this.defs.find((d) => d.name === name);
    }

    /** 全量定义，注册序。返回快照：外部排序/增删不影响注册表。 */
    list(): ToolDefinition[] {
        return [...this.defs];
    }
}

declare module "../cordis/context.js" {
    interface Context {
        tools?: ToolsService;
    }
}
