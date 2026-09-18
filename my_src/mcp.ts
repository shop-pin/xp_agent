// MCP Client —— 连接 stdio 型 MCP server，发现工具并转发调用（裸 JSON-RPC，无 SDK 依赖）。
//
// 配置三处合并（后者覆盖前者，同名 server 以最后声明为准）：
//   1. ~/.claude/settings.json  （用户级，mcpServers 字段）
//   2. .claude/settings.json    （项目级，mcpServers 字段）
//   3. .mcp.json                （项目根，Claude Code 惯例，mcpServers 字段）
//
// 每个工具以 mcp__<serverName>__<toolName> 前缀暴露，避免与内置工具/其他 server 撞名。

import { spawn, type ChildProcess } from "child_process";
import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { createInterface, type Interface } from "readline";

export interface McpServerConfig {
    command: string;
    args?: string[];
    env?: Record<string, string>;
}

interface McpToolInfo {
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

// ─── 单条连接（每 server 一条）────────────────────────────────

class McpConnection {
    private process: ChildProcess | null = null;
    private nextId = 1;
    // 每个 id 挂 {resolve, reject}：回应来了挑出 resolve；进程死了要能
    // 逐个 reject（否则挂起的调用永远悬着）——这是对 ch12 版本的核心升级
    private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
    private rl: Interface | null = null;

    constructor(private serverName: string, private config: McpServerConfig) {}

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

        this.process.stderr?.on("data", () => {});
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

// ─── Manager（管理全部连接）──────────────────────────────────

export class McpManager {
    private connections = new Map<string, McpConnection>();
    private tools: McpToolInfo[] = [];
    private connected = false;

    // 读配置 → 逐个连接 → 握手+发现工具（各 15s 超时）。幂等：第二次调用是 no-op。
    // 单个 server 失败不拖垮整体：报错并 close，其余照连
    async loadAndConnect(): Promise<void> {
        if (this.connected) return;
        this.connected = true;

        const configs = this.loadConfigs();
        if (Object.keys(configs).length === 0) return;

        const TIMEOUT_MS = 15_000;
        for (const [name, config] of Object.entries(configs)) {
            const conn = new McpConnection(name, config);
            try {
                await conn.connect();
                await withTimeout(conn.initialize(), TIMEOUT_MS);
                const serverTools = await withTimeout(conn.listTools(), TIMEOUT_MS);
                this.connections.set(name, conn);
                this.tools.push(...serverTools);
                console.error(`[mcp] Connected to '${name}' — ${serverTools.length} tools`);
            } catch (err: any) {
                console.error(`[mcp] Failed to connect to '${name}': ${err.message}`);
                conn.close();
            }
        }
    }

    // Anthropic API 形状的工具定义，带 mcp__server__tool 前缀
    getToolDefinitions(): Array<{ name: string; description: string; input_schema: any }> {
        return this.tools.map((t) => ({
            name: `mcp__${t.serverName}__${t.name}`,
            description: t.description || `MCP tool ${t.name} from ${t.serverName}`,
            input_schema: t.inputSchema || { type: "object", properties: {} },
        }));
    }

    // mcp__serverName__toolName → 拆出 server 与 tool。tool 名自身可能含 __，
    // 所以用 slice(2).join("__") 而不是 parts[2]
    async callTool(prefixedName: string, args: any): Promise<string> {
        const parts = prefixedName.split("__");
        if (parts.length < 3) throw new Error(`Invalid MCP tool name: ${prefixedName}`);
        const serverName = parts[1];
        const toolName = parts.slice(2).join("__");
        const conn = this.connections.get(serverName);
        if (!conn) throw new Error(`MCP server '${serverName}' not connected`);
        return conn.callTool(toolName, args);
    }

    async disconnectAll(): Promise<void> {
        for (const [, conn] of this.connections) {
            conn.close();
        }
        this.connections.clear();
        this.tools = [];
        this.connected = false;
    }

    // ─── 配置加载 ────────────────────────────────────────────

    // 三处合并，后者覆盖：用户级 → 项目级 settings.json → .mcp.json。
    // 与 ch19 权限规则同一个读取套路，但这里不缓存——MCP 配置虽然也只读，
    // loadAndConnect 幂等已保证只读一次，无需再垫模块级缓存
    private loadConfigs(): Record<string, McpServerConfig> {
        const merged: Record<string, McpServerConfig> = {};
        this.mergeConfigFile(join(homedir(), ".claude", "settings.json"), merged);
        this.mergeConfigFile(join(process.cwd(), ".claude", "settings.json"), merged);
        this.mergeConfigFile(join(process.cwd(), ".mcp.json"), merged);
        return merged;
    }

    private mergeConfigFile(filePath: string, target: Record<string, McpServerConfig>): void {
        if (!existsSync(filePath)) return;
        try {
            const raw = JSON.parse(readFileSync(filePath, "utf-8"));
            const servers = raw.mcpServers || raw;
            for (const [name, config] of Object.entries(servers)) {
                if (this.isValidConfig(config)) {
                    target[name] = config as McpServerConfig;
                }
            }
        } catch {
            // 坏配置文件静默跳过——一个坏文件不该让 agent 起不来
        }
    }

    private isValidConfig(config: any): boolean {
        return config && typeof config === "object" && typeof config.command === "string";
    }
}
