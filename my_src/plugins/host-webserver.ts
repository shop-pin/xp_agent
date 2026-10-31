// plugins/host-webserver.ts——F1：web Host 最小面（一元 RPC + 信封）；
// F2 叠 /api/stream WebSocket 事件流（follow-first + seq 补洞 + 多客户端广播）。
// 参照物：dsh packages/api 的一元调用（HTTP POST，信封 {ok,value}|{ok,error}，
// 不抛异常）+ packages/host 的 webserver 座位；apps/cli 的 profile 启动拓扑
// （agent 同进程——Host 是清单上的一行，不是独立守护进程）；事件流对照
// session-controller 的 follow 流（先开 live 推送，再回填历史）+ 重连
// "尾页补洞 + 每代 baseline"。
//
// 方法面：
//   POST /api/session.create   幂等返回本树唯一会话（mini Host 单会话——
//                              multi-session 的 SessionRegistry 记档不抄）
//   POST /api/session.prompt   { text } → { accepted: true }（F4：send 不
//                              await；结算看流——turn/end / prompt-error 界碑）
//   GET  /api/session.list
//   GET  /api/session.events?since=<seq>   拉取版兜底（调试/F6 回放对照）
//   POST /api/approval.decide  { id, verdict } — 浏览器作答工具审批（首个生效）
//   POST /api/plan.decide      { id, choice, feedback? } — 浏览器作答 plan 审批
//   GET  /api/commands.list    静态命令 + 可调用技能（composer 的 / 补全数据源）
//   POST /api/commands.dispatch { input: "/cost" } — 斜杠分发（fire-and-forget，
//                              handled 同步回；输出走叙事面帧）
//   WS   /api/stream           事件流：连上即 baseline（全量回填 + lastSeq），
//                              之后 live 逐事件推送；帧表见 StreamFrame。
// seq = 事件下标（D5 投影同款身份）。语义错误走信封 ok:false；未知方法
// 404 + 信封；静态目录服务给 F3 的 SPA dist。
//
// F5 交互跨端：C2 审批瀑布的 web answerer。本插件构造时把 ApprovalService 的
// interactive provider 换成远程转发器——九段流水线一行不动，只换"谁作答"
// （dsh interaction 三端同缝的同款分工）；请求经 approval 帧推给浏览器，
// 第一个 decide RPC 获胜，无客户端/断线/超时一律 fail-closed deny。裁决事实
// 经 meta/note(key:approval) 落日志（F6 回放可考）。plan 审批在 Agent 宿主层
// （setPlanApprovalFn 不在树内），由 cli --web 分支接线到 requestPlanApproval。
//
// 安全默认：只绑 127.0.0.1（agent 能执行任意命令，绝不暴露到网络面）；
// 静态目录做前缀守卫防路径穿越；请求体 1MB 上限；upgrade 只认 /api/stream。

import { createServer, type IncomingMessage, type ServerResponse, type Server } from "http";
import { randomUUID } from "crypto";
import { fileURLToPath } from "url";
import { WebSocketServer, WebSocket } from "ws";
import { existsSync, readFileSync, statSync } from "fs";
import { extname, join, resolve, sep } from "path";
import { Service } from "../cordis/service.js";
import type { Context } from "../cordis/context.js";
import type { SessionLog } from "../services/session-log.js";
import { UiService, consoleRenderer } from "../services/ui-service.js";
import { ApprovalService, type ApprovalProvider } from "../services/approval.js";
import { CommandService } from "../services/commands.js";
import type { PreExecCall } from "../services/tools.js";
import { SkillRegistry } from "./skills-registry.js";
import type { SkillDefinition } from "../skills.js";

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
    /** /api/stream 心跳间隔 ms；缺省 env MINI_WEB_HEARTBEAT_MS，缺省 30s，0 关闭。 */
    heartbeatMs?: number;
    /** 审批等待上限 ms；缺省 env MINI_WEB_APPROVAL_TIMEOUT_MS，缺省 120s，0 = 不超时。
     *  超时即 fail-closed deny——挂着等比拒绝更危险。 */
    approvalTimeoutMs?: number;
    bridge: HostBridge;
}

/** plan 审批的四个选项（结构与 Agent.setPlanApprovalFn 的内联类型逐字段同形
 *  ——宿主类型不外导，桥接靠结构兼容，两处词表不许漂移）。 */
export type PlanChoice = "clear-and-execute" | "execute" | "manual-execute" | "keep-planning";

export interface PlanApprovalAnswer {
    choice: PlanChoice;
    feedback?: string;
}

/** 推给浏览器的待决交互（一个 id 一张卡；tool = 审批瀑布转发，plan = 四选项）。 */
export type ApprovalRequest =
    | { id: string; kind: "tool"; tool: string; input: Record<string, unknown>; message: string }
    | { id: string; kind: "plan"; planContent: string };

/** 裁决来源：browser = decide RPC 首个生效；其余为 fail-closed 的自动 deny。 */
export type ResolutionSource = "browser" | "timeout" | "no-client" | "disconnect";

/** 单流帧表（dsh remote.mux 的 open/item/end 语义简版）：
 *  s→c baseline = open（每代连接的完整投影 baseline，带 lastSeq）；
 *  s→c event    = item；heartbeat 代替 mux 心跳并顺带播报 lastSeq；
 *  c→s resume(since) = 重连补洞原语——客户端报自己已见 seq，服务端回放
 *  (since, now]（fresh 连接已有全量 baseline，resume 用于客户端本地状态
 *  对账/带宽优化，不替换 baseline）。
 *  F5 增：approval / approval-resolved（瞬态交互，不进日志，pending 的
 *  重宣告在 baseline 后逐条补发）；narrative（叙事面转发——info/error/cost
 *  这类旁白不是会话事实，同样不回放）。 */
export type ServerStreamFrame =
    | { type: "baseline"; lastSeq: number; events: Array<{ seq: number; event: unknown }> }
    | { type: "event"; seq: number; event: unknown }
    | { type: "heartbeat"; lastSeq: number }
    | { type: "resumed"; lastSeq: number }
    | { type: "narrative"; kind: "info" | "error" | "cost"; text: string }
    | { type: "approval"; request: ApprovalRequest }
    | { type: "approval-resolved"; id: string; by: ResolutionSource }
    | { type: "error"; error: string };

/** 在途待决交互：id → 卡片与裁决出口（resolve 只许成功一次）。 */
interface PendingInteraction {
    request: ApprovalRequest;
    resolve: (answer: "allow-once" | "deny" | PlanApprovalAnswer, by: ResolutionSource) => void;
    timer: NodeJS.Timeout | null;
}

/** 每连接一份的 live 管道状态：订阅期间快照尚未覆盖的增量先落 pending，
 *  baseline 发出后按 seq 去重补发（follow-first 的防缝缓冲）。 */
interface StreamClient {
    /** 已确认推给该客户端的最大 seq（-1 = 还没发过任何事件）。 */
    lastSent: number;
    pending: Array<{ seq: number; event: unknown }>;
    unsubscribe: () => void;
}

const MAX_BODY_BYTES = 1024 * 1024;

/** SPA dist 缺省位（F3 起静态面的第三优先级）：config.staticDir > env
 *  MINI_WEB_STATIC > 编译产物相对的 webui/dist。后者让 `--web` 开箱即服务
 *  SPA——相对本模块（dist/plugins/）上溯两级到包根。 */
const DEFAULT_WEBUI_DIST = fileURLToPath(new URL("../../webui/dist", import.meta.url));
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
    private wss: WebSocketServer;
    /** 活跃事件流客户端——广播（心跳）与收口都从这里走。 */
    private streams = new Map<WebSocket, StreamClient>();
    /** 在途待决交互（F5）——裁决落定即摘除；重连客户端靠 baseline 后的
     *  重宣告看到它们。 */
    private pending = new Map<string, PendingInteraction>();
    private heartbeat: NodeJS.Timeout | null = null;
    private endpointUrl: string | null = null;
    private boundPort = 0;
    private readyPromise: Promise<void>;

    constructor(ctx: Context, name: string, private config: HostConfig) {
        super(ctx, name);

        const methods: Record<string, MethodHandler> = {
            "session.create": { verb: "POST", run: () => this.sessionInfo() },
            "session.list": { verb: "GET", run: () => [this.sessionInfo()] },
            "session.prompt": { verb: "POST", run: (input) => this.prompt(input) },
            "session.events": { verb: "GET", run: (_input, url) => this.events(url) },
            "approval.decide": { verb: "POST", run: (input) => this.decideApproval(input) },
            "plan.decide": { verb: "POST", run: (input) => this.decidePlan(input) },
            "commands.list": { verb: "GET", run: () => this.commandList() },
            "commands.dispatch": { verb: "POST", run: (input) => this.dispatchCommand(input) },
        };

        const server = createServer((req, res) => {
            void this.handle(req, res, methods);
        });
        this.server = server;

        // F2 事件流：同一 server 的 upgrade 通道，路径只认 /api/stream——
        // 其余 upgrade 一律 destroy（loopback 也不给陌生协议开口子）
        const wss = new WebSocketServer({ noServer: true });
        this.wss = wss;
        server.on("upgrade", (req, socket, head) => {
            const url = new URL(req.url ?? "/", "http://127.0.0.1");
            if (url.pathname !== "/api/stream" || this.crossSiteBlocked(req)) {
                socket.destroy();
                return;
            }
            wss.handleUpgrade(req, socket, head, (ws) => this.attachStream(ws));
        });

        const heartbeatMs = config.heartbeatMs ?? parseHeartbeat(process.env.MINI_WEB_HEARTBEAT_MS) ?? 30_000;
        if (heartbeatMs > 0) {
            // 单 interval 广播而不是每连接一个——多客户端共享同一心跳源；
            // unref：心跳不该是进程存活的理由（server socket 才是）
            this.heartbeat = setInterval(() => this.broadcastHeartbeat(), heartbeatMs);
            this.heartbeat.unref();
        }

        // F5 交互跨端的接线（web 档启用本行 = 浏览器是审批 answerer）：
        // 工具审批——把 ApprovalService 的 interactive provider 换成远程转发器。
        // 九段流水线（approval 插件）一行不动：ask 裁决照旧上浮，只是"谁作答"
        // 变成浏览器。REPL 若在（--profile web 不带 --web 的混合形态），cli 稍后
        // 的 setConfirmFn 会覆盖这里——最后接线者生效，与 fallback 的次序同款。
        // best-effort：无 approval 行的树 ask 本来就 fail-closed，这里不炸。
        const remoteAnswerer: ApprovalProvider = (call, message) => this.requestApproval(call, message);
        ctx.get<ApprovalService>("approval")?.setInteractiveProvider(remoteAnswerer);
        // 叙事面——控制台照旧 + info/error/cost 转发成 narrative 帧（web composer
        // 的 /cost、/plan 输出全靠它；toolCall/text 是消息面事实，浏览器从日志
        // 装配，转发会双份；spinner/横幅是终端形态，不转发）
        this.installNarrativeRenderer();

        const port = config.port ?? parsePort(process.env.MINI_WEB_PORT) ?? 3080;
        // listen 是异步的——endpoint（含 port 0 的真实端口）在绑定回调才可知，
        // ready 供调用方等就绪（cli --web 与测试的端口发现都走它）
        this.readyPromise = new Promise<void>((resolveReady) => {
            server.listen(port, "127.0.0.1", () => {
                const addr = server.address();
                const realPort = typeof addr === "object" && addr ? addr.port : port;
                this.boundPort = realPort;
                this.endpointUrl = `http://127.0.0.1:${realPort}`;
                this.ui.info(`Host listening on ${this.endpointUrl}`);
                resolveReady();
            });
        });
        server.on("error", (err) => this.ui.error(`[host] ${err.message}`));
        // 卸载即收口（cordis effect：dispose 时执行）——keep-alive 连接一并断，
        // 否则测试/one-shot 结束后事件循环被悬挂连接吊住
        ctx.effect(() => () => this.disposeServer());
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
        this.disposeServer();
        this.endpointUrl = null;
    }

    private disposeServer(): void {
        if (this.heartbeat) {
            clearInterval(this.heartbeat);
            this.heartbeat = null;
        }
        // 收口即 fail-closed：挂着未决审批关机，等待方的 turn fiber 会被吊死
        for (const pending of [...this.pending.values()]) pending.resolve("deny", "disconnect");
        for (const ws of this.streams.keys()) ws.terminate();
        this.streams.clear();
        this.wss.close();
        this.server.close();
        this.server.closeAllConnections();
    }

    // ── F2：/api/stream 事件流 ────────────────────────────────────────────

    /** follow-first（dsh follow 流同款次序）：先挂 live 管道、再拍历史快照。
     *  mini 两条路都同步、窗口为零，但 F6 回放改成异步读盘后这个次序就是
     *  唯一防线——订阅之前的增量落在缓冲里，baseline 之后按 seq 去重补发。 */
    private attachStream(ws: WebSocket): void {
        const log = this.ctx.require<SessionLog>("session-log");
        const client: StreamClient = { lastSent: -1, pending: [], unsubscribe: () => {} };
        client.unsubscribe = log.onAppend((evt) => {
            // append 先调监听器后 push（C8 时序）——此刻 log.length 即本事件的 seq
            const seq = log.events.length;
            if (seq <= client.lastSent) {
                // seq 回落 = 物理清史（C5 clear-and-execute 的 sessionLog.clear）。
                // 连续性在此断裂：若照常走 seq 去重，清史后的所有事件都会被当作
                // 重复帧丢弃，直连客户端永久冻结。重开基线（dsh"每代连接发完整
                // 投影 baseline"的同款语义）——对客户端这是一次代内重置。
                this.rebaseline(ws, client, seq, evt);
                return;
            }
            client.pending.push({ seq, event: evt });
            this.flushStream(ws, client);
        });
        this.streams.set(ws, client);

        const all = log.events;
        const snapshot = all.map((event, seq) => ({ seq, event }));
        client.lastSent = all.length - 1;
        this.sendFrame(ws, { type: "baseline", lastSeq: client.lastSent, events: snapshot });
        this.flushStream(ws, client);
        // baseline 后重宣告在途待决交互——审批卡片是 Host 活状态不进日志，
        // 断线重连的客户端靠这一步重新看到卡（asked 不落日志的代价与补偿）
        for (const pending of this.pending.values()) {
            this.sendFrame(ws, { type: "approval", request: pending.request });
        }

        ws.on("message", (data) => this.onStreamFrame(ws, client, String(data)));
        ws.on("close", () => {
            client.unsubscribe();
            this.streams.delete(ws);
            // 最后一个浏览器走了，没人能作答——在途审批立刻 fail-closed，
            // 不等超时器（挂着等比拒绝更危险）
            if (this.streams.size === 0) this.failClosedAll("disconnect");
        });
        ws.on("error", () => ws.terminate());
    }

    /** 把 pending 里快照/上次发送未覆盖的增量按序补发。ws 未 OPEN 时缓冲
     *  保留不丢（重开由握手后 baseline 兜底，这里不猜）。 */
    private flushStream(ws: WebSocket, client: StreamClient): void {
        if (ws.readyState !== WebSocket.OPEN) return;
        for (const entry of client.pending) {
            if (entry.seq <= client.lastSent) continue;
            this.sendFrame(ws, { type: "event", seq: entry.seq, event: entry.event });
            client.lastSent = entry.seq;
        }
        client.pending = client.pending.filter((e) => e.seq > client.lastSent);
    }

    /** 清史点的代内重置：全量快照（含触发事件本身——监听器时点它还没 push）
     *  重发 baseline，lastSent 归位。客户端收到 baseline 即整体替换本地状态，
     *  瞬态（旁白/待决卡）一并清空——与服务端"清史 = 新世界"对齐。 */
    private rebaseline(ws: WebSocket, client: StreamClient, seq: number, evt: unknown): void {
        const snapshot = [
            ...this.ctx.require<SessionLog>("session-log").events.map((event, s) => ({ seq: s, event })),
            { seq, event: evt },
        ];
        client.lastSent = seq;
        client.pending = [];
        this.sendFrame(ws, { type: "baseline", lastSeq: seq, events: snapshot });
    }

    /** 客户端帧：目前只认 resume(since)——回放 (since, now] 做尾页补洞。
     *  回放与 live 管道并发时由 lastSent/seq 去重兜住不重不漏。 */
    private onStreamFrame(ws: WebSocket, client: StreamClient, raw: string): void {
        let msg: any;
        try {
            msg = JSON.parse(raw);
        } catch {
            return this.sendFrame(ws, { type: "error", error: "frame is not valid JSON" });
        }
        if (msg?.type !== "resume") {
            return this.sendFrame(ws, { type: "error", error: `unknown frame type: ${String(msg?.type)}` });
        }
        const since = Number(msg.since);
        if (!Number.isInteger(since) || since < -1) {
            return this.sendFrame(ws, { type: "error", error: `resume requires integer since >= -1, got ${msg.since}` });
        }
        const log = this.ctx.require<SessionLog>("session-log");
        const all = log.events;
        for (let seq = since + 1; seq < all.length; seq++) {
            this.sendFrame(ws, { type: "event", seq, event: all[seq] });
        }
        client.lastSent = Math.max(client.lastSent, all.length - 1);
        client.pending = [];
        this.sendFrame(ws, { type: "resumed", lastSeq: all.length - 1 });
    }

    private broadcastHeartbeat(): void {
        if (this.streams.size === 0) return;
        const lastSeq = this.ctx.require<SessionLog>("session-log").events.length - 1;
        for (const ws of this.streams.keys()) {
            this.sendFrame(ws, { type: "heartbeat", lastSeq });
        }
    }

    private sendFrame(ws: WebSocket, frame: ServerStreamFrame): void {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(frame));
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

    /** F4：accepted 语义（F1 记档的脚手架退役）——send 不 await，立即回
     *  accepted；结算由客户端看流观察（turn/end 界碑）。非 abort 失败会从
     *  send 直接抛出、不落 turn/end（runDriver 的 catch 只给 abort 补注记），
     *  这里补 meta/note prompt-error 进日志：失败的 prompt 是会话事实，也是
     *  客户端 busy 的第二个解除界碑（引擎外插件追加事件在 D5 有先例）。 */
    private prompt(input: any): { accepted: boolean } {
        const text = typeof input?.text === "string" ? input.text.trim() : "";
        if (!text) throw new Error("session.prompt requires { text: string }");
        if (this.config.bridge.isBusy()) throw new Error("agent is busy — retry after the current turn settles");
        void this.config.bridge.sendText(text).catch((e) => {
            const message = String(e?.message ?? e);
            this.ui.error(`[host] prompt failed: ${message}`);
            this.ctx.require<SessionLog>("session-log").append({
                type: "meta/note", key: "prompt-error", value: message,
            });
        });
        return { accepted: true };
    }

    // ── F5：交互跨端（审批瀑布的 web answerer + 叙事面转发 + 命令面） ──────

    /** 审批瀑布的远程 answerer（ApprovalService interactive provider）。只换
     *  作答人，不动九段流水线：deny 从这里回与从终端回，引擎侧产物逐字节同款
     *  （"User denied this action." 由 tools 服务的 ask 分支统一产出）。 */
    private requestApproval(call: PreExecCall, message: string): Promise<"allow-once" | "deny"> {
        const request: ApprovalRequest = {
            id: randomUUID(), kind: "tool", tool: call.name, input: call.input, message,
        };
        return this.askBrowser(request, message) as Promise<"allow-once" | "deny">;
    }

    /** plan 四选项的远程 answerer——Agent 宿主层入口（cli --web 分支把
     *  setPlanApprovalFn 接到这里），与工具审批共享同一条转发/裁决管线。 */
    requestPlanApproval(planContent: string): Promise<PlanApprovalAnswer> {
        return this.askBrowser({ id: randomUUID(), kind: "plan", planContent }, "plan approval") as Promise<PlanApprovalAnswer>;
    }

    /** 转发核心：广播 approval 帧，等第一个 decide；无客户端立即 deny，
     *  超时 deny，最后一位浏览器断线 deny——全部 fail-closed。 */
    private askBrowser(request: ApprovalRequest, hint: string): Promise<"allow-once" | "deny" | PlanApprovalAnswer> {
        if (this.streams.size === 0) {
            this.ui.info(`[host] approval auto-denied (no client connected): ${hint}`);
            this.noteResolved(request, "no-client", "deny");
            return Promise.resolve("deny");
        }
        return new Promise((resolveAsk) => {
            const pending: PendingInteraction = {
                request,
                timer: null,
                resolve: (answer, by) => {
                    if (pending.timer) clearTimeout(pending.timer);
                    this.pending.delete(request.id);
                    this.broadcast({ type: "approval-resolved", id: request.id, by });
                    this.noteResolved(request, by, answer);
                    resolveAsk(answer);
                },
            };
            const timeoutMs = this.config.approvalTimeoutMs
                ?? parseTimeout(process.env.MINI_WEB_APPROVAL_TIMEOUT_MS)
                ?? 120_000;
            if (timeoutMs > 0) {
                pending.timer = setTimeout(() => {
                    if (this.pending.get(request.id) === pending) {
                        this.ui.info(`[host] approval timed out (auto-denied): ${hint}`);
                        pending.resolve("deny", "timeout");
                    }
                }, timeoutMs);
                pending.timer.unref();
            }
            this.pending.set(request.id, pending);
            this.broadcast({ type: "approval", request });
        });
    }

    /** 裁决 RPC（工具审批）：首个生效，迟到者信封报错——pending 已摘除。 */
    private decideApproval(input: any): { resolved: boolean } {
        const id = input?.id;
        const verdict = input?.verdict;
        if (typeof id !== "string" || (verdict !== "allow-once" && verdict !== "deny")) {
            throw new Error("approval.decide requires { id, verdict: 'allow-once' | 'deny' }");
        }
        const pending = this.pending.get(id);
        if (!pending || pending.request.kind !== "tool") throw new Error(`no pending tool approval: ${id}`);
        pending.resolve(verdict, "browser");
        return { resolved: true };
    }

    /** 裁决 RPC（plan 四选项）：choice 词表校验 + feedback 收口（空串归 undefined，
     *  与终端 keep-planning 分支同款）。 */
    private decidePlan(input: any): { resolved: boolean } {
        const { id, choice, feedback } = input ?? {};
        const choices: PlanChoice[] = ["clear-and-execute", "execute", "manual-execute", "keep-planning"];
        if (typeof id !== "string" || !choices.includes(choice)) {
            throw new Error(`plan.decide requires { id, choice: one of ${choices.join(" | ")}, feedback? }`);
        }
        const pending = this.pending.get(id);
        if (!pending || pending.request.kind !== "plan") throw new Error(`no pending plan approval: ${id}`);
        const answer: PlanApprovalAnswer = {
            choice,
            feedback: typeof feedback === "string" && feedback.trim() ? feedback.trim() : undefined,
        };
        pending.resolve(answer, "browser");
        return { resolved: true };
    }

    /** 最后一个浏览器断线（或收口）——所有在途审批 fail-closed。 */
    private failClosedAll(by: ResolutionSource): void {
        for (const pending of [...this.pending.values()]) pending.resolve("deny", by);
    }

    /** 裁决事实落日志（dsh "asked/decided 入日志"的 mini 裁剪：只记 decided
     *  ——asked 是瞬态交互，重宣告覆盖重连可见性；decided 是会话事实，
     *  F6 回放可考谁在哪端怎么裁的）。 */
    private noteResolved(request: ApprovalRequest, by: ResolutionSource, answer: unknown): void {
        this.ctx.require<SessionLog>("session-log").append({
            type: "meta/note",
            key: "approval",
            value: {
                id: request.id,
                kind: request.kind,
                tool: request.kind === "tool" ? request.tool : undefined,
                verdict: answer,
                by,
            },
        });
    }

    /** 叙事面转发：控制台渲染照旧，info/error/cost 加播 narrative 帧。
     *  叙事是旁白不是会话事实——不进日志、不回放（dsh surfaceOp 的全面
     *  事件化差距记档）。 */
    private installNarrativeRenderer(): void {
        const ui = this.ctx.require<UiService>("ui");
        ui.setRenderer({
            info: (m) => { consoleRenderer.info(m); this.broadcastNarrative("info", m); },
            error: (m) => { consoleRenderer.error(m); this.broadcastNarrative("error", m); },
            toolCall: (name, input) => consoleRenderer.toolCall(name, input),
            text: (text) => consoleRenderer.text(text),
            cost: (input, output, cacheRead, cacheCreation) => {
                consoleRenderer.cost(input, output, cacheRead, cacheCreation);
                this.broadcastNarrative("cost", costLine(input, output, cacheRead, cacheCreation));
            },
            spinnerStart: (label) => consoleRenderer.spinnerStart(label),
            spinnerStop: () => consoleRenderer.spinnerStop(),
            confirmation: (message) => consoleRenderer.confirmation(message),
            subAgentStart: (type, description) => consoleRenderer.subAgentStart(type, description),
            subAgentEnd: (type, description) => consoleRenderer.subAgentEnd(type, description),
        });
    }

    private broadcastNarrative(kind: "info" | "error" | "cost", text: string): void {
        if (this.streams.size === 0) return;
        this.broadcast({ type: "narrative", kind, text });
    }

    private broadcast(frame: ServerStreamFrame): void {
        for (const ws of this.streams.keys()) this.sendFrame(ws, frame);
    }

    /** composer 的 / 补全数据源：静态命令 + 可调用技能（kind 标记来源）。 */
    private commandList(): { commands: Array<{ name: string; description: string; kind: "command" | "skill" }> } {
        const commands = this.ctx.get<CommandService>("commands");
        const skills = this.ctx.get<SkillRegistry>("skills");
        const out: Array<{ name: string; description: string; kind: "command" | "skill" }> = (commands?.list() ?? [])
            .map((c) => ({ name: c.name, description: c.description, kind: "command" as const }));
        const pick = (s: SkillDefinition): void => {
            if (s.userInvocable) out.push({ name: s.name, description: s.description, kind: "skill" });
        };
        skills?.list().forEach(pick);
        return { commands: out };
    }

    /** 斜杠分发：handled 同步回（CommandService.handles 可同步判定），run
     *  fire-and-forget——/goal /loop 长驻命令不能吊死一元调用；命令的输出
     *  与错误都走叙事面（runGuarded / 这里的 catch → ui.error → 帧）。 */
    private dispatchCommand(input: any): { handled: boolean } {
        const text = typeof input?.input === "string" ? input.input.trim() : "";
        if (!text) throw new Error("commands.dispatch requires { input: string }");
        const commands = this.ctx.get<CommandService>("commands");
        if (!commands || !commands.handles(text)) return { handled: false };
        void commands.dispatch(text).catch((e) => this.ui.error(`[host] command failed: ${String(e?.message ?? e)}`));
        return { handled: true };
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

    /** 跨站防护（F5 收口补）：服务只绑回环，但用户浏览器里的恶意页面仍可
     *  向 127.0.0.1:port 发请求（跨站 POST 带 Origin；DNS rebinding 带 attacker
     *  域的 Host）。规则：带 Origin 的请求必须同源；Host 必须是本机回环域名
     *  + 实际端口。非浏览器客户端（Node/curl）不发 Origin——不受影响。 */
    private crossSiteBlocked(req: IncomingMessage): boolean {
        const p = this.boundPort;
        const origin = req.headers.origin;
        if (origin !== undefined) {
            const allowed = [`http://127.0.0.1:${p}`, `http://localhost:${p}`, `http://[::1]:${p}`];
            if (!allowed.includes(String(origin).toLowerCase())) return true;
        }
        const host = String(req.headers.host || "").toLowerCase();
        const hostOk = [`127.0.0.1:${p}`, `localhost:${p}`, `[::1]:${p}`];
        return !hostOk.includes(host);
    }

    private async handle(req: IncomingMessage, res: ServerResponse, methods: Record<string, MethodHandler>): Promise<void> {
        const url = new URL(req.url ?? "/", "http://127.0.0.1");
        try {
            if (url.pathname.startsWith("/api/")) {
                if (this.crossSiteBlocked(req)) {
                    return sendEnvelope(res, 403, { ok: false, error: "cross-origin request blocked" });
                }
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
            if (req.method === "GET" || req.method === "HEAD") return this.serveStatic(url, res, req.method === "HEAD");
            return sendEnvelope(res, 404, { ok: false, error: `not found: ${req.method} ${url.pathname}` });
        } catch (e: any) {
            // 语义错误（busy/坏参数/桥抛错）→ 信封 ok:false，HTTP 200——
            // 客户端按信封分支，不在传输层分支（dsh 一元调用的同款约定）
            sendEnvelope(res, 200, { ok: false, error: String(e?.message ?? e) });
        }
    }

    private serveStatic(url: URL, res: ServerResponse, headOnly = false): void {
        const root = this.config.staticDir ?? process.env.MINI_WEB_STATIC ?? DEFAULT_WEBUI_DIST;
        if (!existsSync(root)) {
            res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
            res.end(headOnly ? undefined : "static dir not found (set staticDir, MINI_WEB_STATIC, or build webui: npm run webui)");
            return;
        }
        const pathname = decodeURIComponent(url.pathname);
        const relative = pathname === "/" ? "index.html" : pathname.slice(1);
        const file = resolve(root, relative);
        // 前缀守卫：../ 穿越出的路径必然离开 staticDir
        if (file !== resolve(root) && !file.startsWith(resolve(root) + sep)) {
            res.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
            res.end(headOnly ? undefined : "forbidden");
            return;
        }
        if (!existsSync(file) || !statSync(file).isFile()) {
            res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
            res.end(headOnly ? undefined : "not found");
            return;
        }
        // HEAD：头照发（含 content-length 语义由 Node 按 body 推导），不写 body
        res.writeHead(200, { "content-type": CONTENT_TYPES[extname(file)] ?? "application/octet-stream" });
        res.end(headOnly ? undefined : readFileSync(file));
    }
}

function parsePort(raw: string | undefined): number | undefined {
    if (raw === undefined) return undefined;
    const n = Number(raw);
    return Number.isInteger(n) && n >= 0 && n <= 65535 ? n : undefined;
}

function parseHeartbeat(raw: string | undefined): number | undefined {
    if (raw === undefined) return undefined;
    const n = Number(raw);
    return Number.isInteger(n) && n >= 0 ? n : undefined;
}

function parseTimeout(raw: string | undefined): number | undefined {
    if (raw === undefined) return undefined;
    const n = Number(raw);
    return Number.isInteger(n) && n >= 0 ? n : undefined;
}

/** narrative cost 帧的文本口径（数字与措辞同 ui.printCost，去掉 chalk）——
 *  printCost 直印控制台拿不到串，公式在此复制一份，两处词表不许漂移。 */
function costLine(inputTokens: number, outputTokens: number, cacheRead: number, cacheCreation: number): string {
    const total =
        (inputTokens / 1_000_000) * 3 +
        (cacheRead / 1_000_000) * 0.3 +
        (cacheCreation / 1_000_000) * 3.75 +
        (outputTokens / 1_000_000) * 15;
    const cacheStr = cacheRead ? `, ${cacheRead} cached` : "";
    return `Tokens: ${inputTokens} in / ${outputTokens} out${cacheStr} (~$${total.toFixed(4)})`;
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
    // inject = 硬依赖（缺了 fiber 静默 pending）——只列 require 的两个。
    // approval/commands/skills 是 best-effort ctx.get：缺行的树各自降级
    //（无 approval → 引擎侧 ask 本就 fail-closed；无 commands → 斜杠面关闭）
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
