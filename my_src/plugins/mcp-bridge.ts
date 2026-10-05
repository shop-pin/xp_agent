// plugins/mcp-bridge.ts——D2：MCP 桥接插件。
// 参照物：deepseek-harness-master/packages/mcp/mcp-client/src/tools.ts
//（publicToolName 与 syncTools 两阶段换代的语义照抄）。
//
// 三件事：
//   ① publicToolName：mcp__<server>__<tool> 公共名——非法字符规范化 + 64 字符
//      上限，有损变换时缀 12 位 SHA-256（DeepSeek 函数名契约；Anthropic 同宽）
//   ② syncTools 两代切换：整代**先构建后注册**（构建失败不动注册表）；换 代
//      时撤旧注册新，冲突（外部 squat 本命名空间）回滚新代并恢复旧代
//   ③ 连接与配置加载自 mcp.ts 原样迁入（McpManager 消亡；ensure 保持旧惰性
//      时机——turn 开场 maintenance 段，不在插件激活期连接）
//
// 已知裁剪（记 dsh-D2.md）：callTool 只取 text 内容块（projectContent 的图片
// 基础设施略——mini 无多模态通道）；isError 结果原样返回文本（ExecOutcome
// 无 isError 通道）；dispatch 走闭包捕获 server/raw 名——公共名被截断也能路由。

import { spawn, type ChildProcess } from "child_process";
import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { createInterface, type Interface } from "readline";
import { createHash } from "crypto";
import { Service } from "../cordis/service.js";
import type { Context } from "../cordis/context.js";
import type { ToolsService, ToolDefinition, JSONSchema } from "../services/tools.js";

const MAX_PUBLIC_NAME_LENGTH = 64;
const HASH_LENGTH = 12;
const INVALID_NAME_CHARS = /[^A-Za-z0-9_-]/g;

/** 公共工具名：server/raw 原名可逆的前提是"无损"——任何有损变换（非法字符
 *  替换、超长截断）都缀 SHA 短哈希保唯一。简单名（mcp__demo__add）零变化。 */
export function publicToolName(serverName: string, rawName: string): string {
    const joined = `mcp__${serverName}__${rawName}`;
    const normalized = joined.replace(INVALID_NAME_CHARS, "_");
    if (normalized === joined && normalized.length <= MAX_PUBLIC_NAME_LENGTH) return normalized;
    const hash = createHash("sha256").update(`${serverName}\0${rawName}`).digest("hex").slice(0, HASH_LENGTH);
    return `${normalized.slice(0, MAX_PUBLIC_NAME_LENGTH - HASH_LENGTH - 1)}_${hash}`;
}

// ---------- 连接层（自 mcp.ts 原样迁入） ----------

export interface McpServerConfig {
    command: string;
    args?: string[];
    env?: Record<string, string>;
}

export interface McpToolInfo {
    name: string;
    description: string;
    inputSchema: any;
    serverName: string;
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([
            promise,
            new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error("timeout")), ms); }),
        ]);
    } finally {
        clearTimeout(timer);
    }
}

class McpConnection {
    private process: ChildProcess | null = null;
    private nextId = 1;
    // 每个 id 挂 {resolve, reject}：回应来了挑出 resolve；进程死了要能
    // 逐个 reject（否则挂起的调用永远悬着）
    private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
    private rl: Interface | null = null;

    constructor(private serverName: string, private config: McpServerConfig) { }

    async connect(): Promise<void> {
        const env = { ...process.env, ...(this.config.env || {}) };
        this.process = spawn(this.config.command, this.config.args || [], {
            stdio: ["pipe", "pipe", "pipe"], // stderr 收进管道吞掉，避免 server 日志污染 UI
            env,
        });

        this.rl = createInterface({ input: this.process.stdout! });
        this.rl.on("line", (line: string) => {
            try {
                const msg = JSON.parse(line);
                if (msg.id !== undefined && this.pending.has(msg.id)) {
                    const { resolve, reject } = this.pending.get(msg.id)!;
                    this.pending.delete(msg.id);
                    if (msg.error) {
                        reject(new Error(`MCP error ${msg.error.code}: ${msg.error.message}`));
                    } else {
                        resolve(msg.result);
                    }
                }
            } catch {
                // 非 JSON 行（server 日志）忽略
            }
        });

        this.process.stderr?.on("data", () => { });
        this.process.on("error", (err) => {
            console.error(`[mcp:${this.serverName}] process error: ${err.message}`);
        });
        this.process.on("exit", (code) => {
            // 进程死亡 = 所有挂起请求注定无回应，逐个 reject 防悬挂
            for (const [, { reject }] of this.pending) {
                reject(new Error(`MCP server '${this.serverName}' exited with code ${code}`));
            }
            this.pending.clear();
        });
    }

    private sendRequest(method: string, params: any = {}): Promise<any> {
        return new Promise((resolve, reject) => {
            if (!this.process?.stdin?.writable) {
                return reject(new Error(`MCP server '${this.serverName}' is not connected`));
            }
            const id = this.nextId++;
            this.pending.set(id, { resolve, reject });
            this.process!.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
        });
    }

    private sendNotification(method: string, params: any = {}): void {
        if (!this.process?.stdin?.writable) return;
        this.process!.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
    }

    async initialize(): Promise<void> {
        await this.sendRequest("initialize", {
            protocolVersion: "2024-11-05",
            capabilities: {},
            clientInfo: { name: "mini-claude", version: "1.0" },
        });
        this.sendNotification("notifications/initialized");
    }

    async listTools(): Promise<McpToolInfo[]> {
        const result = await this.sendRequest("tools/list");
        if (!result?.tools || !Array.isArray(result.tools)) return [];
        return result.tools.map((t: any) => ({
            name: t.name,
            description: t.description || "",
            inputSchema: t.inputSchema,
            serverName: this.serverName,
        }));
    }

    async callTool(name: string, args: any): Promise<string> {
        const result = await this.sendRequest("tools/call", { name, arguments: args });
        if (result?.content && Array.isArray(result.content)) {
            return result.content
                .filter((c: any) => c.type === "text")
                .map((c: any) => c.text)
                .join("\n");
        }
        return JSON.stringify(result);
    }

    close(): void {
        this.rl?.close();
        this.process?.kill();
        this.process = null;
    }
}

// 配置三处合并（后者覆盖前者，同名 server 以最后声明为准）：
//   1. ~/.claude/settings.json（用户级）  2. .claude/settings.json（项目级）
//   3. .mcp.json（项目根）
function loadMcpConfigs(): Record<string, McpServerConfig> {
    const merged: Record<string, McpServerConfig> = {};
    for (const filePath of [
        join(homedir(), ".claude", "settings.json"),
        join(process.cwd(), ".claude", "settings.json"),
        join(process.cwd(), ".mcp.json"),
    ]) {
        mergeConfigFile(filePath, merged);
    }
    return merged;
}

function mergeConfigFile(filePath: string, target: Record<string, McpServerConfig>): void {
    if (!existsSync(filePath)) return;
    try {
        const raw = JSON.parse(readFileSync(filePath, "utf-8"));
        const servers = raw.mcpServers || raw;
        for (const [name, config] of Object.entries(servers)) {
            if (config && typeof config === "object" && typeof (config as McpServerConfig).command === "string") {
                target[name] = config as McpServerConfig;
            }
        }
    } catch {
        // 坏配置文件静默跳过——一个坏文件不该让 agent 起不来
    }
}

// ---------- 桥接服务 ----------

export class McpBridge extends Service {
    private connections = new Map<string, McpConnection>();
    private rawTools: McpToolInfo[] = [];
    private connected = false;
    private disabled = false;
    /** 当前代的 disposer 集 + 定义集（回滚时要恢复的旧代数据）。 */
    private generation: Array<() => void> = [];
    private generationDefs: ToolDefinition[] = [];

    /** 子 agent 关闭连接（服务仍在——close() 不炸）。 */
    disable(): void {
        this.disabled = true;
    }

    /** 惰性连接（幂等）：读配置 → 逐个连接/握手/发现（各 15s 超时）→ 同步注册表。
     *  时机与旧 ensureMcp 一致：turn 开场 maintenance 段，不在插件激活期。 */
    async ensure(): Promise<void> {
        if (this.connected || this.disabled) return;
        this.connected = true;

        const configs = loadMcpConfigs();
        if (Object.keys(configs).length === 0) return;

        const TIMEOUT_MS = 15_000;
        for (const [name, config] of Object.entries(configs)) {
            const conn = new McpConnection(name, config);
            try {
                await conn.connect();
                await withTimeout(conn.initialize(), TIMEOUT_MS);
                const serverTools = await withTimeout(conn.listTools(), TIMEOUT_MS);
                this.connections.set(name, conn);
                this.rawTools.push(...serverTools);
                console.error(`[mcp] Connected to '${name}' — ${serverTools.length} tools`);
            } catch (err: any) {
                // 单个 server 失败不拖垮整体：报错并 close，其余照连
                console.error(`[mcp] Failed to connect to '${name}': ${err.message}`);
                conn.close();
            }
        }
        this.syncTools();
    }

    /**
     * 两代切换（照 dsh syncTools 语义）：
     * ① 整代构建——纯数据，未注册；重复公共名/坏 schema 在此暴露，失败不动注册表
     * ② 撤旧代 → 注册新代；冲突（外部 squat 本命名空间）→ 回滚新代 + 恢复旧代
     * raw 可注入（测试/未来重连场景）；缺省用已发现的工具集。
     */
    syncTools(raw: McpToolInfo[] = this.rawTools): void {
        const tools = this.ctx.require<ToolsService>("tools");
        const seen = new Set<string>();
        const nextDefs: ToolDefinition[] = raw.map((t) => {
            const publicName = publicToolName(t.serverName, t.name);
            if (seen.has(publicName)) throw new Error(`[mcp] duplicate public tool name "${publicName}"`);
            seen.add(publicName);
            return {
                name: publicName,
                description: t.description || `MCP tool ${t.name} from ${t.serverName}`,
                parameters: (t.inputSchema || { type: "object", properties: {} }) as unknown as JSONSchema,
                permissionHint: "meta" as const,
                // dispatch 用闭包捕获 server/raw 名——公共名被截断/规范化也能路由
                execute: (input: Record<string, any>) => this.callRaw(t.serverName, t.name, input),
            };
        });

        const oldGen = this.generation;
        const oldDefs = this.generationDefs;
        for (const d of oldGen) d();
        const fresh: Array<() => void> = [];
        try {
            for (const def of nextDefs) fresh.push(tools.register(def));
        } catch (e) {
            for (const d of fresh) d();
            const restored: Array<() => void> = [];
            try {
                for (const def of oldDefs) restored.push(tools.register(def));
            } catch { /* 恢复失败只能记录——旧代定义已被撤，注册表回到无 MCP 态 */ }
            this.generation = restored;
            this.generationDefs = oldDefs;
            console.error(`[mcp] tool sync rolled back: ${(e as Error).message}`);
            return;
        }
        this.generation = fresh;
        this.generationDefs = nextDefs;
        this.rawTools = raw;
    }

    private async callRaw(serverName: string, toolName: string, input: Record<string, any>): Promise<string> {
        const conn = this.connections.get(serverName);
        if (!conn) throw new Error(`MCP server '${serverName}' not connected`);
        return conn.callTool(toolName, input);
    }

    /** 广告清单（字节对齐旧 McpManager.getToolDefinitions）。 */
    listToolDefinitions(): Array<{ name: string; description: string; input_schema: any }> {
        return this.rawTools.map((t) => ({
            name: publicToolName(t.serverName, t.name),
            description: t.description || `MCP tool ${t.name} from ${t.serverName}`,
            input_schema: t.inputSchema || { type: "object", properties: {} },
        }));
    }

    async disconnectAll(): Promise<void> {
        for (const [, conn] of this.connections) conn.close();
        this.connections.clear();
        this.rawTools = [];
        this.connected = false;
    }
}

export const mcpBridgePlugin = {
    name: "mcp-bridge",
    inject: ["tools"],
    apply(ctx: Context, config: { enabled?: boolean } = {}) {
        const bridge = new McpBridge(ctx, "mcp");
        if (config.enabled === false) bridge.disable();
    },
};

declare module "../cordis/context.js" {
    interface Context {
        mcp?: McpBridge;
    }
}
