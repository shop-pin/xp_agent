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
import type { PermissionMode } from "../permissions.js";
import type { ApprovalService } from "./approval.js";

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
    /** agent 的完整分发链（魔法名 → 注册表）——管线管权限，分发归 agent。 */
    dispatch?: (name: string, input: Record<string, any>) => Promise<string>;
    /** auto 模式的分类器裁决（C2 起由监听器调用；机制留在 Agent）。 */
    autoAdjudicate?: (name: string, input: Record<string, any>) => Promise<AutoVerdict>;
}

/** auto 模式分类器的裁决形状（与旧 checkPermission 同形）。 */
export interface AutoVerdict {
    action: "allow" | "deny" | "confirm";
    message?: string;
}

// ---------- C2：执行管线——pre-execute 瀑布 + 审批 + 执行 + post-execute 瀑布 ----------

/** pre-execute 监听器的裁决。allow 放行；deny 硬拒；ask 交审批服务。 */
export type PreExecDecision =
    | { type: "allow" }
    | { type: "deny"; reason: string }
    | { type: "ask"; message: string };

/** 传给 pre-execute 监听器的调用快照。 */
export interface PreExecCall {
    name: string;
    input: Record<string, any>;
    mode: PermissionMode;
    planFilePath?: string;
    /** 注册表定义（permissionHint 元数据在这里）；mcp__/未知名为 undefined。 */
    def?: ToolDefinition;
    /** auto 模式的分类器句柄（逐调用传入；机制留在 Agent）。 */
    autoAdjudicate?: (name: string, input: Record<string, any>) => Promise<AutoVerdict>;
}

/** executeCall 的结果：正常输出，或被拒（announce = 需要打印的拒绝原因）。 */
export type ExecOutcome =
    | { kind: "result"; output: string }
    | { kind: "denied"; content: string; announce?: string };

const DECISION_RANK: Record<PreExecDecision["type"], number> = { allow: 0, ask: 1, deny: 2 };

/** 单调收紧：取两个裁决中更严的那个（同级保留 inner 的 payload——外层只能加严，不能改写）。 */
function tightenDecisions(inner: PreExecDecision, own: PreExecDecision): PreExecDecision {
    return DECISION_RANK[own.type] > DECISION_RANK[inner.type] ? own : inner;
}

/**
 * 单调守卫：包一层监听器，保证它只能收紧 inner（next()）的裁决。
 * listener 不调 next = 否决，自己的裁决即为终局（短路保持——inner 不执行）；
 * 调了 next，返回值比 inner 松 → 丢弃，维持 inner（deny 之后无人能翻案）。
 */
export function monotonic(
    listener: (call: PreExecCall, next: () => PreExecDecision | Promise<PreExecDecision>) => PreExecDecision | Promise<PreExecDecision>,
): (call: PreExecCall, next: () => PreExecDecision | Promise<PreExecDecision>) => Promise<PreExecDecision> {
    return async (call, next) => {
        let inner: PreExecDecision | Promise<PreExecDecision> | undefined;
        const guardedNext = () => {
            inner = next();
            return inner;
        };
        const own = await listener(call, guardedNext);
        if (inner === undefined) return own;
        return tightenDecisions(await inner, own);
    };
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

    /**
     * C2 执行管线：snapshotArgs → waterfall('tools/pre-execute')（监听器经
     * monotonic 只能收紧）→ ask 交审批服务（无服务 = fail-closed deny）→
     * 执行（dispatch 优先：agent 的魔法名链；否则注册表 execute）→
     * truncateResult → waterfall('tools/post-execute')（block/accept）。
     * 权限决策与执行从 agent 循环整体迁入这里，行为与旧 checkPermission
     * 九段流水线逐段等价（对拍见 dsh-C2.md）。
     */
    async executeCall(
        call: { name: string; input: Record<string, any>; mode: PermissionMode; planFilePath?: string },
        exec: ToolExec,
    ): Promise<ExecOutcome> {
        // 快照：监听器与审批记录看到的是同一份不可变视图，执行用原始 input
        const snapshot = structuredClone(call.input);
        const preCall: PreExecCall = {
            name: call.name,
            input: snapshot,
            mode: call.mode,
            planFilePath: call.planFilePath,
            def: this.get(call.name),
            autoAdjudicate: exec.autoAdjudicate,
        };
        // 无监听器的裸树 → inner 默认 allow；策略由插件提供
        const decision = await this.ctx.waterfall("tools/pre-execute", preCall, (): PreExecDecision => ({ type: "allow" }));

        if (decision.type === "deny") {
            return { kind: "denied", content: `Denied: ${decision.reason}`, announce: decision.reason };
        }
        if (decision.type === "ask") {
            const approval = this.ctx.get<ApprovalService>("approval");
            const verdict = approval
                ? await approval.request(preCall, decision.message)
                : "deny"; // fail-closed：没有审批服务的树不执行任何 ask
            if (verdict === "deny") {
                return { kind: "denied", content: "User denied this action." };
            }
        }

        let output: string;
        if (exec.dispatch) {
            output = await exec.dispatch(call.name, call.input);
        } else if (preCall.def) {
            output = await preCall.def.execute(call.input, exec);
        } else {
            output = `Unknown tool: ${call.name}`;
        }
        output = truncateResult(output);
        // post-execute：监听器可改写输出（block 带反馈）；无监听器 = 原样
        output = await this.ctx.waterfall("tools/post-execute", { name: call.name, output }, () => output);
        return { kind: "result", output };
    }
}

declare module "../cordis/context.js" {
    interface Context {
        tools?: ToolsService;
    }
}

// 管线事件进全局 Events 表（框架自有事件与 vendor 的 internal/* 同一手法，
// 用户可再 merge 自己的监听器类型）：
declare module "../cordis/events.js" {
    interface Events {
        "tools/pre-execute"(
            call: PreExecCall,
            next: () => PreExecDecision | Promise<PreExecDecision>,
        ): PreExecDecision | Promise<PreExecDecision>;
        "tools/post-execute"(result: { name: string; output: string }, next: () => string): string | Promise<string>;
    }
}
