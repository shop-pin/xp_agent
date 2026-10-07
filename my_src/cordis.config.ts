// cordis.config.ts——E2：产品的插件清单（总装配点）。
// B6 的玩具清单（core/greeter/clock）原样迁进 cordis-tests/b6-loader.test.ts——
// 那是 loader 的教学夹具，这里从本章起换成真实清单。
//
// 框架（cordis/）不认识任何具体插件：清单声明"装什么、什么配置"，
// 插件表提供"名字 → 实现"的解析（真框架是动态 import + 包清单校验，mini 用
// 静态表，标注"略"）。换 provider 即换产品从这里开始。
//
// 四层叠加，同 id 后写胜（整行替换，不做字段合并——B6 定死的语义）：
//   baseRows     全能力清单：行序 = 激活序，工具广告序/审批瀑布序的生命线
//   appRows(host) CLI 装配层：Agent 宿主能力（桥/选项）作为整行 config 覆盖
//   profiles     命名补丁层：'full'（空 = 原样）/ 'no-auto'（注释掉 auto 行）
//   extraRows    调用方追加（--patch 文件 / 测试），最后落笔、赢过一切
//
// 危险点（E2 章规格）：patch 的覆盖粒度是整行替换——想改 config 必须连
// name 一起写全，只写 config 会把 name 顶掉（resolve 直接 fail）。

import type { Row } from "./cordis/loader.js";
import type { Plugin } from "./cordis/fiber.js";

// 再导出行类型：patch 文件 / cli / agent 都从清单这里拿（清单是装配语义的家）
export type { Row };
import type { PermissionMode } from "./permissions.js";
import type { CommandsBridge } from "./plugins/commands.js";
import { buildStaticSystemPrompt } from "./prompt.js";

import {
    serviceTools, serviceSessionLog, serviceUi, serviceCommands,
    serviceLlm, serviceSystemPrompt, serviceAgents,
} from "./plugins/services.js";
import { llmAnthropicPlugin } from "./plugins/llm-anthropic.js";
import { adapterEchoPlugin } from "./plugins/adapter-echo.js";
import { promptSectionsPlugin } from "./plugins/prompt-sections.js";
import { skillsPlugin } from "./plugins/skills-registry.js";
import { commandsPlugin } from "./plugins/commands.js";
import { mcpBridgePlugin } from "./plugins/mcp-bridge.js";
import { subagentPlugin } from "./plugins/subagent.js";
import { memoryPlugin } from "./plugins/memory.js";
import { compactionPlugin } from "./plugins/compaction.js";
import { coreFsTools } from "./plugins/core-fs-tools.js";
import { coreExecTools } from "./plugins/core-exec-tools.js";
import { coreMetaTools } from "./plugins/core-meta-tools.js";
import { approvalPlugin } from "./plugins/approval.js";
import { autoApprovalPlugin } from "./plugins/auto-approval.js";
import { autonomyPlugin } from "./plugins/autonomy.js";

/** 插件表：resolve(name) 的静态映射。 */
export const plugins: Record<string, Plugin> = {
    "service-tools": serviceTools,
    "service-session-log": serviceSessionLog,
    "service-ui": serviceUi,
    "service-commands": serviceCommands,
    "service-llm": serviceLlm,
    "service-system-prompt": serviceSystemPrompt,
    "service-agents": serviceAgents,
    "llm-anthropic": llmAnthropicPlugin,
    "adapter-echo": adapterEchoPlugin,
    "prompt-sections": promptSectionsPlugin,
    "skills-registry": skillsPlugin,
    "commands": commandsPlugin,
    "mcp-bridge": mcpBridgePlugin,
    "subagent": subagentPlugin,
    "memory-prefetch": memoryPlugin,
    "compaction": compactionPlugin,
    "core-fs-tools": coreFsTools,
    "core-exec-tools": coreExecTools,
    "core-meta-tools": coreMetaTools,
    "approval": approvalPlugin,
    "auto-approval": autoApprovalPlugin,
    "autonomy": autonomyPlugin,
};

export function resolvePlugin(name: string): Plugin {
    const plugin = plugins[name]
    if (!plugin) throw new Error(`[mini-cordis] no plugin named "${name}"`)
    return plugin
}

/**
 * base 层：随产品发布的全能力清单。
 * 行序即激活序——三组顺序是生命线，分层/patch 都不许打乱：
 *   服务行在前（后续能力行的依赖）；core-* 三行 = 工具广告序（请求体 tools
 *   数组顺序）；approval → auto-approval = 审批瀑布从外到内。
 * 带桥/带选项的行这里不带 config——app 层用同 id 行覆盖补上。
 */
export const baseRows: Row[] = [
    { id: "svc-tools", name: "service-tools" },
    { id: "svc-session-log", name: "service-session-log" },
    { id: "svc-ui", name: "service-ui" },
    { id: "svc-commands", name: "service-commands" },
    { id: "svc-llm", name: "service-llm" },
    { id: "llm-anthropic", name: "llm-anthropic" },
    { id: "adapter-echo", name: "adapter-echo" },
    { id: "svc-system-prompt", name: "service-system-prompt" },
    { id: "prompt-sections", name: "prompt-sections" },
    { id: "skills", name: "skills-registry" },
    { id: "commands", name: "commands" },
    { id: "mcp", name: "mcp-bridge" },
    { id: "svc-agents", name: "service-agents" },
    { id: "subagent", name: "subagent" },
    { id: "memory", name: "memory-prefetch" },
    { id: "compaction", name: "compaction" },
    { id: "core-fs", name: "core-fs-tools" },
    { id: "core-exec", name: "core-exec-tools" },
    { id: "core-meta", name: "core-meta-tools" },
    { id: "approval", name: "approval" },
    { id: "auto-approval", name: "auto-approval" },
    { id: "autonomy", name: "autonomy" },
]

/**
 * CLI 装配层：把 Agent 宿主能力接进清单。E2 之前这些桥/选项以字面量散在
 * Agent 构造函数里，清单对它们不可见；现在收敛为一个 host 接口——
 * config 层知道接线，agent 只提供能力。
 * parentMode 必须是活取（() => host.mode）：plan 切换后子 agent 要看到新模式。
 */
export interface AppHost {
    parentMode(): PermissionMode
    isSubAgent: boolean
    customSystemPrompt?: string
    commands: CommandsBridge
    inject(text: string): void
    wake(text: string): unknown
    getBudget(): { exceeded: boolean; reason: string }
    getMaxTurns(): number | null
    addTokens(input: number, output: number): void
}

export function appRows(host: AppHost): Row[] {
    return [
        {
            id: "prompt-sections",
            name: "prompt-sections",
            config: {
                staticPrompt: host.customSystemPrompt || buildStaticSystemPrompt(),
                dynamicEnabled: !host.customSystemPrompt,
            },
        },
        { id: "skills", name: "skills-registry", config: { catalogInjection: !host.isSubAgent } },
        { id: "commands", name: "commands", config: host.commands },
        { id: "mcp", name: "mcp-bridge", config: { enabled: !host.isSubAgent } },
        {
            id: "subagent",
            name: "subagent",
            config: {
                bridge: { parentMode: host.parentMode, addTokens: host.addTokens },
                enabled: !host.isSubAgent,
            },
        },
        {
            id: "memory",
            name: "memory-prefetch",
            config: { bridge: { inject: host.inject }, enabled: !host.isSubAgent },
        },
        {
            id: "autonomy",
            name: "autonomy",
            config: {
                getBudget: host.getBudget,
                getMaxTurns: host.getMaxTurns,
                wake: host.wake,
            },
        },
    ]
}

/**
 * 命名补丁层：同一份 my_src，不同 profile 组装出不同产品形态。
 * 'full'：全功能（空补丁 = base 原样）。
 * 'no-auto'：无 auto-mode 版——auto-approval 行换成 disabled 行（"注释掉"），
 * 分类器能力整体下线：auto 模式下的危险动作直落人工确认/headless 拒绝，
 * 瀑布里只剩 approval 外层（deny 规则硬底线 + 九段静态流水线）。
 */
export const profiles: Record<string, Row[]> = {
    full: [],
    "no-auto": [
        { id: "auto-approval", name: "auto-approval", disabled: true },
    ],
}

/** 分层铺平：同 id 后写胜（整行替换）。loadRows 内部还有一次同 id 去重，
 *  这里先铺平是为了 dump/patch 场景能在挂载前看到最终行表。 */
export function mergeRows(layers: Row[][]): Row[] {
    const byId = new Map<string, Row>()
    for (const layer of layers) {
        for (const row of layer) byId.set(row.id, row)
    }
    return [...byId.values()]
}

export interface AssembleOptions {
    /** CLI 装配层宿主；不传（--dump-config 纯预览）则跳过 app 层。 */
    host?: AppHost
    /** 命名补丁；undefined ≙ 'full'。未知名字 fail-loud。 */
    profile?: string
    /** 调用方追加层（--patch / 测试），赢过一切。 */
    extraRows?: Row[]
}

export function buildRows(options: AssembleOptions = {}): Row[] {
    const profileName = options.profile ?? "full"
    const profileRows = profiles[profileName]
    if (!profileRows) {
        throw new Error(`[mini-cordis] unknown profile "${profileName}" (known: ${Object.keys(profiles).join(", ")})`)
    }
    return mergeRows([
        baseRows,
        options.host ? appRows(options.host) : [],
        profileRows,
        options.extraRows ?? [],
    ])
}

/** 行表文本视图（--dump-config 的输出）。config 里的函数折叠成 <fn>。 */
export function formatRows(rows: Row[]): string {
    const render = (value: unknown): string => {
        if (typeof value === "function") return "<fn>"
        if (Array.isArray(value)) return `[${value.map(render).join(", ")}]`
        if (value && typeof value === "object") {
            return `{${Object.entries(value).map(([k, v]) => `${k}: ${render(v)}`).join(", ")}}`
        }
        return JSON.stringify(value) ?? "undefined"
    }
    const lines = ["<mini-cordis.config>"]
    rows.forEach((row, index) => {
        const branch = index === rows.length - 1 ? "└─" : "├─"
        const config = row.config === undefined ? "" : ` ${render(row.config)}`
        const disabled = row.disabled ? " (disabled)" : ""
        lines.push(`${branch} [${row.id}] ${row.name}${disabled}${config}`)
    })
    return lines.join("\n")
}
