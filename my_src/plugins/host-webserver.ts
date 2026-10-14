// plugins/host-webserver.ts——F1：web Host 最小面（一元 RPC + 信封）。
// 参照物：dsh packages/api 的一元调用（HTTP POST，信封 {ok,value}|{ok,error}，
// 不抛异常）+ packages/host 的 webserver 座位；apps/cli 的 profile 启动拓扑
// （agent 同进程——Host 是清单上的一行，不是独立守护进程）。
//
// 方法面（F1 过渡期拉取，F2 换事件流）：
//   POST /api/session.create   幂等返回本树唯一会话（mini Host 单会话——
//                              multi-session 的 SessionRegistry 记档不抄）
//   POST /api/session.prompt   { text } → await agent.send（整 turn 结算才回）
//   GET  /api/session.list
//   GET  /api/session.events?since=<seq>   seq = 事件下标（D5 投影同款身份）
// 语义错误走信封 ok:false；未知方法 404 + 信封；静态目录服务给 F3 的 SPA dist。
//
// 安全默认：只绑 127.0.0.1（agent 能执行任意命令，绝不暴露到网络面）；
// 静态目录做前缀守卫防路径穿越；请求体 1MB 上限。

import { createServer, type IncomingMessage, type ServerResponse, type Server } from "http";
import { existsSync, readFileSync, statSync } from "fs";
import { extname, join, resolve, sep } from "path";
import { Service } from "../cordis/service.js";
import type { Context } from "../cordis/context.js";
import type { SessionLog } from "../services/session-log.js";
import { UiService } from "../services/ui-service.js";

/** Agent 借给 Host 的桥：会话身份/忙闲/驱动入口（E2 AppHost 的闭包桥同款）。 */
export interface HostBridge {
    agentId(): string;
    isBusy(): boolean;
    sendText(text: string): Promise<void>;
}

export interface HostConfig {
    port?: number;
    /** SPA dist 目录；缺省 env MINI_WEB_STATIC，目录不存在则静态面关闭。 */
    staticDir?: string;
    bridge: HostBridge;
}

const MAX_BODY_BYTES = 1024 * 1024;
const CONTENT_TYPES: Record<string, string> = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".ico": "image/x-icon",
    ".map": "application/json",
    ".txt": "text/plain; charset=utf-8",
};

type MethodHandler = {
    verb: "POST" | "GET";
    run: (input: any, url: URL) => unknown | Promise<unknown>;
};

export class HostService extends Service {
    private server: Server;
    private endpointUrl: string | null = null;
    private readyPromise: Promise<void>;

    constructor(ctx: Context, name: string, private config: HostConfig) {
        super(ctx, name);

        const methods: Record<string, MethodHandler> = {
            "session.create": { verb: "POST", run: () => this.sessionInfo() },
            "session.list": { verb: "GET", run: () => [this.sessionInfo()] },
            "session.prompt": { verb: "POST", run: (input) => this.prompt(input) },
            "session.events": { verb: "GET", run: (_input, url) => this.events(url) },
        };

        const server = createServer((req, res) => {
            void this.handle(req, res, methods);
        });
        this.server = server;

        const port = config.port ?? parsePort(process.env.MINI_WEB_PORT) ?? 3080;
        // listen 是异步的——endpoint（含 port 0 的真实端口）在绑定回调才可知，
        // ready 供调用方等就绪（cli --web 与测试的端口发现都走它）
        this.readyPromise = new Promise<void>((resolveReady) => {
            server.listen(port, "127.0.0.1", () => {
                const addr = server.address();
                const realPort = typeof addr === "object" && addr ? addr.port : port;
                this.endpointUrl = `http://127.0.0.1:${realPort}`;
                this.ui.info(`Host listening on ${this.endpointUrl}`);
                resolveReady();
            });
        });
        server.on("error", (err) => this.ui.error(`[host] ${err.message}`));
        // 卸载即收口（cordis effect：dispose 时执行）——keep-alive 连接一并断，
        // 否则测试/one-shot 结束后事件循环被悬挂连接吊住
        ctx.effect(() => () => {
            server.close();
            server.closeAllConnections();
        });
    }

    /** CLI 侧句柄用：--web 打印端口、测试发现随机端口。 */
    get endpoint(): { url: string } | null {
        return this.endpointUrl ? { url: this.endpointUrl } : null;
    }

    /** 等监听绑定完成（之后 endpoint 才非空）。 */
    get ready(): Promise<void> {
        return this.readyPromise;
    }

    /** 进程级收口（Agent.close 调用）。与 effect 的 fiber 卸载路径并存——
     *  server.close 幂等，两处都调安全。keep-alive 连接一并断，否则测试
     *  进程的 fetch 连接会吊住事件循环。 */
    shutdown(): void {
        this.server.close();
        this.server.closeAllConnections();
        this.endpointUrl = null;
    }

    private get ui(): UiService {
        return this.ctx.require<UiService>("ui");
    }

    private sessionInfo(): { id: string; busy: boolean; messageCount: number } {
        const log = this.ctx.require<SessionLog>("session-log");
        return {
            id: this.config.bridge.agentId(),
            busy: this.config.bridge.isBusy(),
            messageCount: log.derive().messages.length,
        };
    }

    private async prompt(input: any): Promise<{ settled: boolean }> {
        const text = typeof input?.text === "string" ? input.text.trim() : "";
        if (!text) throw new Error("session.prompt requires { text: string }");
        if (this.config.bridge.isBusy()) throw new Error("agent is busy — retry after the current turn settles");
        await this.config.bridge.sendText(text);
        return { settled: true };
    }

    /** since = 已见过的最大 seq；返回 (since, now] 的事件。seq 是事件下标
     *  （append-only 稳定身份，与 D5 fold 的 seq 同一语义）。 */
    private events(url: URL): { events: Array<{ seq: number; event: unknown }> } {
        const sinceParam = url.searchParams.get("since");
        const since = sinceParam === null ? -1 : Number(sinceParam);
        if (!Number.isInteger(since) || since < -1) throw new Error(`bad since: ${sinceParam}`);
        const log = this.ctx.require<SessionLog>("session-log");
        const all = log.events;
        const out: Array<{ seq: number; event: unknown }> = [];
        for (let seq = since + 1; seq < all.length; seq++) out.push({ seq, event: all[seq] });
        return { events: out };
    }

    private async handle(req: IncomingMessage, res: ServerResponse, methods: Record<string, MethodHandler>): Promise<void> {
        const url = new URL(req.url ?? "/", "http://127.0.0.1");
        try {
            if (url.pathname.startsWith("/api/")) {
                const name = url.pathname.slice("/api/".length);
                const method = methods[name];
                if (!method) return sendEnvelope(res, 404, { ok: false, error: `unknown method: ${name}` });
                if (req.method !== method.verb) {
                    return sendEnvelope(res, 405, { ok: false, error: `${name} expects ${method.verb}, got ${req.method}` });
                }
                let value: unknown;
                if (method.verb === "POST") {
                    const body = await readBody(req);
                    let input: any = {};
                    if (body.length > 0) {
                        try {
                            input = JSON.parse(body.toString("utf-8"));
                        } catch {
                            return sendEnvelope(res, 200, { ok: false, error: "request body is not valid JSON" });
                        }
                    }
                    value = await method.run(input, url);
                } else {
                    value = await method.run(undefined, url);
                }
                return sendEnvelope(res, 200, { ok: true, value });
            }
            if (req.method === "GET") return this.serveStatic(url, res);
            return sendEnvelope(res, 404, { ok: false, error: `not found: ${req.method} ${url.pathname}` });
        } catch (e: any) {
            // 语义错误（busy/坏参数/桥抛错）→ 信封 ok:false，HTTP 200——
            // 客户端按信封分支，不在传输层分支（dsh 一元调用的同款约定）
            sendEnvelope(res, 200, { ok: false, error: String(e?.message ?? e) });
        }
    }

    private serveStatic(url: URL, res: ServerResponse): void {
        const root = this.config.staticDir ?? process.env.MINI_WEB_STATIC;
        if (!root || !existsSync(root)) {
            res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
            res.end("static dir not configured (set staticDir or MINI_WEB_STATIC)");
            return;
        }
        const pathname = decodeURIComponent(url.pathname);
        const relative = pathname === "/" ? "index.html" : pathname.slice(1);
        const file = resolve(root, relative);
        // 前缀守卫：../ 穿越出的路径必然离开 staticDir
        if (file !== resolve(root) && !file.startsWith(resolve(root) + sep)) {
            res.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
            res.end("forbidden");
            return;
        }
        if (!existsSync(file) || !statSync(file).isFile()) {
            res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
            res.end("not found");
            return;
        }
        res.writeHead(200, { "content-type": CONTENT_TYPES[extname(file)] ?? "application/octet-stream" });
        res.end(readFileSync(file));
    }
}

function parsePort(raw: string | undefined): number | undefined {
    if (raw === undefined) return undefined;
    const n = Number(raw);
    return Number.isInteger(n) && n >= 0 && n <= 65535 ? n : undefined;
}

function sendEnvelope(res: ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(body));
}

function readBody(req: IncomingMessage): Promise<Buffer> {
    return new Promise((resolvePromise, reject) => {
        const chunks: Buffer[] = [];
        let total = 0;
        req.on("data", (chunk: Buffer) => {
            total += chunk.length;
            if (total > MAX_BODY_BYTES) {
                reject(new Error("request body too large (1MB limit)"));
                req.destroy();
                return;
            }
            chunks.push(chunk);
        });
        req.on("end", () => resolvePromise(Buffer.concat(chunks)));
        req.on("error", reject);
    });
}

export const hostWebserverPlugin = {
    name: "host-webserver",
    inject: ["session-log", "ui"],
    apply(ctx: Context, config: HostConfig) {
        if (!config?.bridge) {
            // fail-loud：桥是 Host 的驱动入口，缺了它 HTTP 面就是空壳——
            // 正常路径只有 web profile（工厂从宿主取桥）会启用本行
            throw new Error('[host-webserver] row enabled without a bridge — enable via the "web" profile or pass bridge in the row config');
        }
        new HostService(ctx, "host", config);
    },
};

declare module "../cordis/context.js" {
    interface Context {
        host?: HostService;
    }
}
