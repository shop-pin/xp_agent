// plugins/prompt-sections.ts——C7：system prompt 的分节拼装。
// 参照物：packages/core/system-prompt/src/index.ts 的 section 注册段。
//
// 七节 + plan（Agent 自注册，读自身 mode 状态）：
//   identity（静态主体，吃缓存）→ env → git → memory → skills → agents →
//   deferred-tools（目录页）→ plan（模式后缀）
// 各动态节自带前导分隔符（\n\n 或 \n）——与旧 buildDynamicSystemContext 的
// 字符串拼接逐字节一致（连接串为空 join，trim 收尾）。
//
// 与 dsh 的两处口径差（记 dsh-C7.md）：
//   - 工具 schema 走请求 tools 参数（Anthropic 线格式），system 侧只汇入
//     deferred 目录；dsh 的 schema 是 system 里的 surface 节点
//   - CLAUDE.md 留在首条 user 消息（untrusted 内容不进 system——mini ch22 的
//     既定设计），roadmap 设想的 claude-md section 与现状冲突，现状优先

import { execSync } from "child_process";
import * as os from "os";
import type { Context } from "../cordis/context.js";
import type { SystemPromptService } from "../services/system-prompt.js";
import { buildStaticSystemPrompt } from "../prompt.js";
import { buildMemoryPromptSection } from "../memory.js";
import { buildAgentDescriptions } from "../subagent.js";
import { getDeferredToolNames } from "../services/tools.js";

/** 中央 order 表：节间相对位置的唯一权威（同组内 order 升序拼装）。 */
export const SECTION_ORDERS = {
    identity: 100,
    env: 200,
    git: 300,
    memory: 400,
    skills: 500,
    agents: 600,
    deferredTools: 700,
    /** plan 节由 Agent 注册（读 mode/planFilePath 私有状态），order 在此定锚。 */
    plan: 800,
} as const;

function getGitContext(): string {
    const opts = {
        encoding: "utf-8" as const,
        timeout: 3000,
    };
    try {
        const branch = execSync("git rev-parse --abbrev-ref HEAD", opts);
        const log = execSync("git log --oneline -5", opts);
        const status = execSync("git status --short", opts);
        return `# Git context\nbranch: ${branch}\nlog: ${log}\nstatus: ${status}`;
    } catch {
        return "";
    }
}

export interface PromptSectionsConfig {
    /** 静态主体：主对话 = STATIC_CORE，子 agent = 自定义 system。 */
    staticPrompt?: string;
    /** 子 agent 关闭动态节（env/git/memory/... 是主对话的环境噪音）。 */
    dynamicEnabled?: boolean;
}

export const promptSectionsPlugin = {
    name: "prompt-sections",
    inject: ["system-prompt"],
    apply(ctx: Context, config: PromptSectionsConfig = {}) {
        const sp = ctx.require<SystemPromptService>("system-prompt");
        sp.registerSection({
            id: "identity",
            order: SECTION_ORDERS.identity,
            group: "static",
            render: () => config.staticPrompt ?? buildStaticSystemPrompt(),
        });
        if (config.dynamicEnabled === false) return;

        // 环境变量：{{var}} 模板通道（assemble 严格插值，未知变量抛错）
        sp.registerVariable("cwd", () => process.cwd());
        sp.registerVariable("platform", () => os.platform());
        sp.registerVariable("arch", () => os.arch());
        sp.registerVariable("shell", () =>
            process.platform === "win32" ? (process.env.ComSpec || "cmd.exe") : (process.env.SHELL || "/bin/sh"));
        sp.registerSection({
            id: "env",
            order: SECTION_ORDERS.env,
            group: "dynamic",
            render: () => "# Environment\nWorking directory: {{cwd}}\nPlatform: {{platform}} {{arch}}\nShell: {{shell}}\n",
        });
        sp.registerSection({
            id: "git",
            order: SECTION_ORDERS.git,
            group: "dynamic",
            render: () => getGitContext() || null,
        });
        sp.registerSection({
            id: "memory",
            order: SECTION_ORDERS.memory,
            group: "dynamic",
            render: () => buildMemoryPromptSection() || null,
        });
        // D1：skills 目录节消亡——catalog 改 user message（skills 插件的 pre-step
        // 注入），system 不再含技能清单
        sp.registerSection({
            id: "agents",
            order: SECTION_ORDERS.agents,
            group: "dynamic",
            render: () => buildAgentDescriptions() || null,
        });
        sp.registerSection({
            // deferred 工具的"目录页"：schema 不广告，但名字要说。逐请求现算——
            // tool_search 激活一个，它就从名单里消失
            id: "deferred-tools",
            order: SECTION_ORDERS.deferredTools,
            group: "dynamic",
            render: () => {
                const names = getDeferredToolNames();
                return names.length > 0
                    ? `\n\nThe following deferred tools are available via tool_search: ${names.join(", ")}. Use tool_search to fetch their full schemas when needed.`
                    : null;
            },
        });
    },
};
