// plugins/data-store.ts——S10：数据留存与历史落地（stock profile 专用）。
//
// 三层留存（plan §三决策 #8）——回测与复盘消费同一格式，回测器（S13）是
// 留存层的第一个消费者：
//   daily-k/<day>.jsonl        日 K 收口——观察转入 closed 后从最新快照一次写
//                              全市场（收盘快照即日 K；晚间重启由 10s 巡检补写）
//   watch-detail/<day>.jsonl   关注面明细——watchlist + 持仓 + 信号股的盘中
//                              快照逐轮追加（盘口是 S11 的事，先留字段位）
//   events/signals.jsonl       事件层——信号与裁决独立成档，脱离 SessionLog
//   events/verdicts.jsonl        可独立消费（复盘/规则晋升的原料面）
//
// 账本纪律（沿用 paper-broker）：JSONL 追加；读回坏行跳过；落盘失败吞不炸
// 进程（内存态为准，下轮再试）。Schema 版本头：每文件首行声明
// {"v":1,"schema":...}——读侧 schema 不符明确拒读，不许静默错解（§五）。
// 根目录：config.rootDir > env MINI_STOCKS_DATA_DIR > 缺省 ~/.mini-claude/stocks/data
// ——可迁移 = 拷目录（决策 #8）。

import type { Context } from "../cordis/context.js";
import type { Plugin } from "../cordis/fiber.js";
import { Service } from "../cordis/service.js";
import type { ToolsService } from "../services/tools.js";
import type { UiService } from "../services/ui-service.js";
import { existsSync, mkdirSync, readFileSync, appendFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { marketPhase, parseWatchlist, watchlistPath, type MarketDataService, type Quote, type Snapshot } from "./market-data.js";
import { cnDay, type PaperBroker } from "./paper-broker.js";
import type { Signal } from "./signal-engine.js";

// ---------- Schema 词汇表 ----------

export const SCHEMA_DAILY_K = "stocks.daily-k";
export const SCHEMA_DETAIL = "stocks.watch-detail";
export const SCHEMA_SIGNALS = "stocks.signals";
export const SCHEMA_VERDICTS = "stocks.verdicts";

/** 数据根目录（决策 #8：env 可配，缺省 ~/.mini-claude/stocks/data）。 */
export function dataRootPath(): string {
    return process.env.MINI_STOCKS_DATA_DIR ?? join(homedir(), ".mini-claude", "stocks", "data");
}

export function dailyKPath(root: string, day: string): string {
    return join(root, "daily-k", `${day}.jsonl`);
}
export function detailPath(root: string, day: string): string {
    return join(root, "watch-detail", `${day}.jsonl`);
}
export function signalsPath(root: string): string {
    return join(root, "events", "signals.jsonl");
}
export function verdictsPath(root: string): string {
    return join(root, "events", "verdicts.jsonl");
}

/** schema 头行（各文件首行）。 */
export function schemaHeader(schema: string, extra: Record<string, unknown> = {}): string {
    return JSON.stringify({ v: 1, schema, ...extra });
}

// ---------- 读侧（回测/复盘的公共入口，坏行跳过 + schema 明确拒读） ----------

export interface ReadResult<T> { rows: T[]; bad: number }

/** 读一个带 schema 头的 JSONL：首行不符 schema 直接抛（不许静默错解），
 *  数据行坏行跳过计数——账本以可解析行为准的纪律。 */
export function readSchemaJsonl<T>(path: string, schema: string): ReadResult<T> {
    if (!existsSync(path)) return { rows: [], bad: 0 };
    const lines = readFileSync(path, "utf-8").split("\n").filter(Boolean);
    let head: { schema?: string };
    try {
        head = JSON.parse(lines[0]!) as { schema?: string };
    } catch {
        throw new Error(`schema 头不可读：${path}`);
    }
    if (head?.schema !== schema) {
        throw new Error(`schema 不符：${path} 是 ${head?.schema ?? "无"}，期望 ${schema}——不静默错解`);
    }
    const rows: T[] = [];
    let bad = 0;
    for (const line of lines.slice(1)) {
        try {
            rows.push(JSON.parse(line) as T);
        } catch { bad++; }
    }
    return { rows, bad };
}

/** 日 K 行（读侧视图）。 */
export interface DailyKRow {
    code: string; name: string;
    o: number; h: number; l: number; c: number;
    chg: number; vol: number; amt: number; to: number;
}

// ---------- 服务 ----------

export interface DataStoreConfig {
    /** 数据根目录覆盖（测试/多账户；缺省走 env/缺省路径）。 */
    rootDir?: string;
    /** 关注面明细的码数上限（默认 100——微盘轮动池量级，防失控）。 */
    universeCap?: number;
}

const VERDICT_ACTIONS = ["watch", "buy-candidate", "avoid", "no-opinion"] as const;

export class DataStoreService extends Service {
    private root: string;
    private universeCap: number;
    private timer: NodeJS.Timeout | null = null;
    private dailyWrittenDay = "";
    /** 当日出现过信号的码——关注面宇宙的第三只腿（S11 盘口轮询共用口径）。 */
    private signalCodes = new Set<string>();

    constructor(ctx: Context, name: string, config: DataStoreConfig = {}) {
        super(ctx, name);
        this.root = config.rootDir ?? dataRootPath();
        this.universeCap = config.universeCap ?? 100;
    }

    get rootDir(): string {
        return this.root;
    }

    /** 挂事件面：快照 → 关注面明细；信号 → 事件层。 */
    attach(): void {
        this.ctx.on("market/snapshot", (snap) => this.onSnapshot(snap));
        this.ctx.on("market/signal", (sig) => this.onSignal(sig));
    }

    /** 10s 小步巡检 phase——收盘是"观察到的迁移"不是"算出来的时刻"（watch 同款）。 */
    start(): void {
        if (this.timer) return;
        this.timer = setInterval(() => {
            try { this.checkClose(); } catch { /* 收口失败下轮再试，不炸 */ }
        }, 10_000);
        this.timer.unref?.();
        this.checkClose(); // 晚间/收盘重启：首轮快照已落 → 立即补收口
    }

    dispose(): void {
        if (this.timer) clearInterval(this.timer);
        this.timer = null;
    }

    private market(): MarketDataService | undefined {
        return this.ctx.get<MarketDataService>("market");
    }

    /** 日 K 收口：closed + 最新快照与同日 + 未写过 → 一次写全市场（公共：测试与
     *  晚间重启补写走同一条路径，不等 10s 定时器）。 */
    checkClose(): void {
        const market = this.market();
        if (!market || marketPhase(market.clock()) !== "closed") return;
        const latest = market.latest;
        if (!latest) return;
        const day = cnDay(latest.at);
        if (this.dailyWrittenDay === day) return;
        this.dailyWrittenDay = day;
        this.writeDailyK(day, latest);
    }

    private writeDailyK(day: string, snap: Snapshot): void {
        const path = dailyKPath(this.root, day);
        if (existsSync(path)) return; // 断电重启幂等：已有昨日文件 = 无感续转
        const lines = [
            schemaHeader(SCHEMA_DAILY_K, { day, writtenAt: snap.at, count: snap.quotes.length }),
            ...snap.quotes.map((q) => JSON.stringify(dailyKRow(q))),
        ];
        this.appendLines(path, lines);
        this.ctx.get<UiService>("ui")?.info(`📁 日K收口：${day} 全市场 ${snap.quotes.length} 只 → ${path}`);
    }

    private onSnapshot(snap: Snapshot): void {
        if (marketPhase(this.market()?.clock() ?? new Date(snap.at)) !== "open") return;
        const codes = new Set(this.universeCodes());
        const rows = snap.quotes
            .filter((q) => codes.has(q.code))
            .map((q) => JSON.stringify({
                at: snap.at, code: q.code, p: q.price, chg: q.changePercent,
                vol: q.volume, amt: q.amount, to: q.turnoverRate,
            }));
        if (rows.length === 0) return;
        const day = cnDay(snap.at);
        this.appendWithHeader(detailPath(this.root, day), SCHEMA_DETAIL, { day, startedAt: snap.at }, rows);
    }

    private onSignal(sig: Signal): void {
        this.signalCodes.add(sig.code);
        this.appendWithHeader(signalsPath(this.root), SCHEMA_SIGNALS, {}, [
            JSON.stringify({ day: cnDay(sig.at), ...sig }),
        ]);
    }

    /** 裁决入档（record_verdicts 工具的实现面）：非法行跳过，返回 [收下, 跳过]。 */
    recordVerdicts(verdicts: unknown): [number, number] {
        const list = Array.isArray(verdicts) ? verdicts : [];
        const good: string[] = [];
        let skipped = 0;
        const market = this.market();
        const day = cnDay((market?.clock() ?? new Date()).getTime());
        for (const v of list) {
            const row = v as { code?: unknown; action?: unknown; confidence?: unknown };
            const ok = typeof row?.code === "string" && /^(sh|sz|bj)\d{6}$/.test(row.code)
                && typeof row.action === "string" && (VERDICT_ACTIONS as readonly string[]).includes(row.action)
                && typeof row.confidence === "number" && row.confidence >= 0 && row.confidence <= 1;
            if (!ok) { skipped++; continue; }
            good.push(JSON.stringify({ day, at: (market?.clock() ?? new Date()).getTime(), ...row as object }));
        }
        if (good.length > 0) {
            this.appendWithHeader(verdictsPath(this.root), SCHEMA_VERDICTS, {}, good);
        }
        return [good.length, skipped];
    }

    /** 关注面宇宙 = watchlist ∪ 持仓 ∪ 信号股（上限 universeCap）。 */
    private universeCodes(): string[] {
        const codes = new Set<string>();
        try {
            for (const e of parseWatchlist(readFileSync(watchlistPath(), "utf-8"))) codes.add(e.code);
        } catch { /* 无清单/读不了：另两条腿照走 */ }
        for (const p of this.ctx.get<PaperBroker>("broker")?.getPositions() ?? []) codes.add(p.code);
        for (const c of this.signalCodes) codes.add(c);
        return [...codes].slice(0, this.universeCap);
    }

    private appendWithHeader(path: string, schema: string, headerExtra: Record<string, unknown>, rows: string[]): void {
        this.appendLines(path, [
            ...(existsSync(path) ? [] : [schemaHeader(schema, headerExtra)]),
            ...rows,
        ]);
    }

    /** 账本纪律：落盘失败吞不炸——留存是尽力而为面，内存态与实时链路不依赖它。 */
    private appendLines(path: string, lines: string[]): void {
        try {
            mkdirSync(dirName(path), { recursive: true });
            appendFileSync(path, lines.join("\n") + "\n");
        } catch { /* 下轮再试 */ }
    }

    /** 注册模型面工具：record_verdicts（裁决入档）+ get_trades_csv（账本导出）。 */
    attachTools(): void {
        const tools = this.ctx.require<ToolsService>("tools");
        tools.register({
            name: "record_verdicts",
            description: "把 /adjudicate 的裁决结果批量入档到事件层（events/verdicts.jsonl）——"
                + "独立于会话日志的机器可读面，复盘与规则晋升的原料。每轮裁决调用一次。",
            parameters: {
                type: "object",
                properties: {
                    verdicts: {
                        type: "array",
                        description: "裁决对象数组，每个含 code（sh/sz/bj+6位）、action（watch/buy-candidate/avoid/no-opinion）、confidence（0-1）、reasons/risks（可选）",
                        items: { type: "object" },
                    },
                },
                required: ["verdicts"],
            },
            permissionHint: "exec",
            execute: async (input) => {
                const [kept, skipped] = this.recordVerdicts(input.verdicts);
                return kept === 0 && skipped === 0
                    ? "没有可入档的裁决（空数组）"
                    : `已入档 ${kept} 条裁决记录${skipped > 0 ? `，跳过 ${skipped} 条非法行` : ""} → ${verdictsPath(this.root)}`;
            },
        });
        tools.register({
            name: "get_trades_csv",
            description: "账本成交流水导出为 CSV（Excel 可开）：orderId,day,time,code,side,price,qty,fee,realizedPnl。"
                + "day 缺省导全部日子。挂账 #3 的顺手件。",
            parameters: {
                type: "object",
                properties: { day: { type: "string", description: "YYYY-MM-DD；缺省全部" } },
            },
            permissionHint: "read",
            execute: (input) => {
                const broker = this.ctx.get<PaperBroker>("broker");
                if (!broker) return "Error: paper-broker 未装配";
                const dayFilter = typeof input.day === "string" && /^\d{4}-\d{2}-\d{2}$/.test(input.day)
                    ? input.day : undefined;
                const fills = broker.allFills().filter((f) => !dayFilter || cnDay(f.at) === dayFilter);
                if (fills.length === 0) return `${dayFilter ?? "全部日子"} 无成交记录`;
                const rows = fills.map((f) => [
                    f.orderId, cnDay(f.at), cnHm(f.at), f.code, f.side,
                    f.price, f.qty, f.fee, f.realizedPnl ?? "",
                ].join(","));
                return ["orderId,day,time,code,side,price,qty,fee,realizedPnl", ...rows].join("\n");
            },
        });
    }
}

/** 日 K 行（写侧投影——快照报价的最小日 K 形）。 */
function dailyKRow(q: Quote): DailyKRow {
    return {
        code: q.code, name: q.name, o: q.open, h: q.high, l: q.low, c: q.price,
        chg: q.changePercent, vol: q.volume, amt: q.amount, to: q.turnoverRate,
    };
}

/** 固定 UTC+8 的 HH:mm（输出进文件必须确定，不经本机时区）。 */
function cnHm(ts: number): string {
    const d = new Date(ts + 8 * 3600_000);
    return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
}

function dirName(p: string): string {
    const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
    return i <= 0 ? "." : p.slice(0, i);
}

declare module "../cordis/context.js" {
    interface Context {
        dataStore?: DataStoreService;
    }
}

export const dataStorePlugin: Plugin = {
    name: "data-store",
    inject: ["tools"],
    apply(ctx: Context, config: DataStoreConfig = {}) {
        // 服务名 = ctx.dataStore 严格读键（market/watch/signals 同款纪律）
        const store = new DataStoreService(ctx, "dataStore", config);
        store.attach();
        store.attachTools();
        store.start();
        ctx.effect(() => () => store.dispose());
    },
};
