// plugins/services.ts——E2：服务行化。
// E2 之前 Agent 构造函数直接 `new ToolsService(ctx, "tools")` 起——服务在清单
// 之外，dump/patch/分层都够不着它们。真 cordis 里服务也是插件提供的（容器
// 只是表），这里把 E1 前硬编码的那批基础设施逐个包成零依赖插件行：
// 进清单后服务与能力插件同权——同一套行模型管"装什么"。
//
// Service 基类构造即同步 provide（cordis/service.ts），零 inject 的行挂载即
// 激活——所以行序 = 服务可用序 = 后续能力行的依赖就绪序。

import type { Context } from "../cordis/context.js";
import type { Plugin } from "../cordis/fiber.js";
import { ToolsService } from "../services/tools.js";
import { SessionLog } from "../services/session-log.js";
import { UiService } from "../services/ui-service.js";
import { CommandService } from "../services/commands.js";
import { LlmRuntime } from "../services/llm.js";
import { SystemPromptService } from "../services/system-prompt.js";
import { AgentRegistry } from "../services/agents.js";

export const serviceTools: Plugin = {
    name: "service-tools",
    apply(ctx: Context) {
        new ToolsService(ctx, "tools");
    },
};

export const serviceSessionLog: Plugin = {
    name: "service-session-log",
    apply(ctx: Context) {
        new SessionLog(ctx, "session-log");
    },
};

// ui 消费 session-log 的日志面（E1：tool/call 渲染靠订阅），用 inject 表达
// 这条依赖——即便清单把它排到 session-log 之前也能等到就绪再激活。
export const serviceUi: Plugin = {
    name: "service-ui",
    inject: ["session-log"],
    apply(ctx: Context) {
        new UiService(ctx, "ui").attachSessionLog();
    },
};

export const serviceCommands: Plugin = {
    name: "service-commands",
    apply(ctx: Context) {
        new CommandService(ctx, "commands");
    },
};

export const serviceLlm: Plugin = {
    name: "service-llm",
    apply(ctx: Context) {
        new LlmRuntime(ctx, "llm");
    },
};

export const serviceSystemPrompt: Plugin = {
    name: "service-system-prompt",
    apply(ctx: Context) {
        new SystemPromptService(ctx, "system-prompt");
    },
};

export const serviceAgents: Plugin = {
    name: "service-agents",
    apply(ctx: Context) {
        new AgentRegistry(ctx, "agents");
    },
};
