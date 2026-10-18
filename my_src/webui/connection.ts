// webui/connection.ts——F3：client 传输面（unary RPC + 事件流消费）。
// 参照物：dsh packages/client/connection（gateway 一元调用 + follow 流 +
// generation 重连）+ packages/api/gateway journal-stream 的游标语义。
// 分层红线（docs/subsystems/web-client.zh.md）：传输在 client model 之下——
// 本文件不 import store，状态落地经 StreamSink 注入的回调；帧表类型从 host
// 侧 import type 共享（类型即文档，声明擦除后零运行时耦合）。
//
// 补洞与重连的对账身份是 seq（F2 的不变量在客户端的镜像）：
//   - event 帧只接受 seq === lastSeq + 1；跳号 → 主动 resume(since=lastSeq)
//   - heartbeat 播报的 lastSeq 落后于本地为正常；领先 → 有洞，resume
//   - 断线重连 = generation++ → 新代连接必得全量 baseline（F2 保证），
//     本地状态被整体替换收敛——resume 只做代内带宽优化，不做跨代对账

import type { ServerStreamFrame, ApprovalRequest } from "../plugins/host-webserver.js";

/** 浏览器 WebSocket / node 'ws' 客户端的最小结构面（node:test 经 wsFactory 注入）。 */
export interface WsLike {
    send(data: string): void;
    close(): void;
    addEventListener(type: string, fn: (ev: any) => void): void;
    removeEventListener(type: string, fn: (ev: any) => void): void;
}

export type WsFactory = (url: string) => WsLike;

export interface StreamStatus {
    phase: "connecting" | "live" | "reconnecting";
    generation: number;
}

/** connection 的状态出口：传输层把帧翻译成语义动作，落地由装配层定。
 *  日志帧（baseline/event）与瞬态帧（narrative/approval）分道——后者不进
 *  事件囤积，store 另有落点。 */
export interface StreamSink {
    /** 新代连接的全量回填（整体替换，不做 merge）。 */
    setBaseline(events: Array<{ seq: number; event: unknown }>, lastSeq: number): void;
    /** live/补洞增量（调用方保证按 seq 顺序、无洞无重）。 */
    appendEvent(seq: number, event: unknown): void;
    setStatus(status: StreamStatus): void;
    /** 叙事面旁白（瞬态，不回放）。 */
    narrative(kind: "info" | "error" | "cost", text: string): void;
    /** 待决交互卡到场（ask 现场推送 / baseline 后重宣告）。 */
    announceApproval(request: ApprovalRequest): void;
    /** 待决交互落定（任一来源：首个 decide / 超时 / 断线 fail-closed）。 */
    resolveApproval(id: string, by: string): void;
}

export interface ConnectionOptions {
    baseUrl: string;
    wsFactory?: WsFactory;
    /** 重连退避基数 ms（指数退避到 reconnectMaxMs）。 */
    reconnectBaseMs?: number;
    reconnectMaxMs?: number;
}

export class RpcError extends Error {
    constructor(readonly method: string, message: string) {
        super(`[${method}] ${message}`);
        this.name = "RpcError";
    }
}

export class Connection {
    private readonly wsFactory: WsFactory;
    private readonly baseMs: number;
    private readonly maxMs: number;
    private ws: WsLike | null = null;
    private generation = 0;
    private lastSeq = -1;
    private manualClosed = false;
    private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    private attempts = 0;

    constructor(private options: ConnectionOptions, private sink: StreamSink) {
        // 浏览器默认 globalThis.WebSocket；node:test 注入 'ws' 客户端
        this.wsFactory = options.wsFactory ?? ((url) => new (globalThis as any).WebSocket(url));
        this.baseMs = options.reconnectBaseMs ?? 500;
        this.maxMs = options.reconnectMaxMs ?? 8000;
    }

    /** 一元调用：input 缺省 → GET（读方法），传 `{}` 等 → POST（写方法，
     *  session.create 这类空参写也传 {}）；信封 ok→value、ok:false → RpcError
     *  （业务失败在客户端是异常，与 F2 服务端"语义走信封不走状态码"互为镜像）。 */
    async call(method: string, input?: unknown): Promise<any> {
        const isRead = input === undefined;
        const res = await fetch(`${this.options.baseUrl}/api/${method}`, {
            method: isRead ? "GET" : "POST",
            headers: isRead ? undefined : { "content-type": "application/json" },
            body: isRead ? undefined : JSON.stringify(input ?? {}),
        });
        const envelope = await res.json();
        if (!envelope?.ok) throw new RpcError(method, String(envelope?.error ?? `http ${res.status}`));
        return envelope.value;
    }

    streamUrl(): string {
        return `${this.options.baseUrl.replace(/^http/, "ws")}/api/stream`;
    }

    connectStream(): void {
        this.manualClosed = false;
        this.openGeneration();
    }

    close(): void {
        this.manualClosed = true;
        if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
        this.ws?.close();
        this.ws = null;
    }

    private openGeneration(): void {
        this.generation += 1;
        this.sink.setStatus({ phase: this.generation === 1 ? "connecting" : "reconnecting", generation: this.generation });
        const generation = this.generation;
        // 换代先关旧连接——僵尸 ws 会一直挂在服务端 streams 里，令"无客户端
        // 即拒"的 fail-closed 判定失真。旧代 close 事件被代数守卫拦下，不会
        // 触发重连。
        this.ws?.close();
        const ws = this.wsFactory(this.streamUrl());
        this.ws = ws;

        ws.addEventListener("open", () => {
            if (generation !== this.generation) return; // 旧代残帧——直接丢
        });
        ws.addEventListener("message", (ev: any) => {
            if (generation !== this.generation) return;
            let frame: ServerStreamFrame | null = null;
            try {
                frame = JSON.parse(String(ev.data)) as ServerStreamFrame;
            } catch {
                return; // 坏帧丢弃——不让一条畸形数据炸掉整代连接
            }
            if (frame) this.onFrame(frame);
        });
        ws.addEventListener("close", () => {
            if (generation !== this.generation || this.manualClosed) return;
            this.scheduleReconnect();
        });
        ws.addEventListener("error", () => {
            // close 必随 error 而来——这里只吞日志，重连交给 close
        });
    }

    private scheduleReconnect(): void {
        const delay = Math.min(this.baseMs * 2 ** this.attempts, this.maxMs);
        this.attempts += 1;
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            if (!this.manualClosed) this.openGeneration();
        }, delay);
    }

    private onFrame(frame: ServerStreamFrame): void {
        switch (frame.type) {
            case "baseline": {
                this.lastSeq = frame.lastSeq;
                this.attempts = 0; // 收到 baseline 才算一代真正站住
                this.sink.setBaseline(frame.events, frame.lastSeq);
                this.sink.setStatus({ phase: "live", generation: this.generation });
                break;
            }
            case "event": {
                if (frame.seq <= this.lastSeq) return; // 补洞回放与 live 的重叠——seq 去重
                if (frame.seq > this.lastSeq + 1) {
                    this.requestResume(); // 跳号：先补洞，这帧等回放带来
                    return;
                }
                this.lastSeq = frame.seq;
                this.sink.appendEvent(frame.seq, frame.event);
                break;
            }
            case "heartbeat": {
                if (frame.lastSeq > this.lastSeq) this.requestResume(); // 心跳揭示有洞
                break;
            }
            case "resumed":
                break; // 回放帧已按 event 逐条落地，界碑无状态
            case "narrative":
                this.sink.narrative(frame.kind, frame.text);
                break;
            case "approval":
                this.sink.announceApproval(frame.request);
                break;
            case "approval-resolved":
                this.sink.resolveApproval(frame.id, frame.by);
                break;
            case "error":
                console.warn(`[stream] server rejected a frame: ${frame.error}`);
                break;
        }
    }

    private requestResume(): void {
        this.ws?.send(JSON.stringify({ type: "resume", since: this.lastSeq }));
    }
}
