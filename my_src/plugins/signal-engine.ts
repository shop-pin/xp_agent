// plugins/signal-engine.ts——S5：信号引擎（stock profile 专用，base 默认 disabled）。
//
// 总纲 §一思想 2 的落地：**信号 = 规则引擎，不是 LLM**。指标计算在代码里
// 做——便宜、确定、可对拍；引擎吃 market/snapshot 事件，逐轮评估规则注册表，
// 产出 Signal 广播 market/signal（S6 裁决/S9 编排的消费面）+ get_signals 工具。
//
// 指标口径（记档）：
//   - 窗口类指标基于环形缓冲（默认 60 轮 × 轮询间隔 ≈ 5 分钟视野）——
//     "5 分钟涨速"是**观测窗内**的 5 分钟，不是交易所对齐的
//   - volumeSurge 是**日内量比近似**：近段量率 / 自观测起点平均量率。
//     真·量比（对过去 5 日）需要日线数据，本源没有——记档 deferred
//     （引入日 K 源后升级，接口不变）
//   - 涨停位分板：主板 10% / 创业板科创板(sz30|sh68) 20% / 北交所 30% /
//     ST（名称含 ST）5%——跌停对称
//
// 冷却（cooldown）：同 code+规则 在冷却窗内不重发——5s 一轮的快照流里，
// 同一个异动会被连续评估出几十次，信号面只留第一次。

import type { Context } from "../cordis/context.js";
import type { Plugin } from "../cordis/fiber.js";
import { Service } from "../cordis/service.js";
import type { ToolsService } from "../services/tools.js";
import type { MarketDataService, HistoryRound, Quote } from "./market-data.js";

// ---------- 序列提取（纯函数） ----------

export interface Point {
    at: number;
    price: number;
    /** 当日累计成交量（手）——差分出区间量。 */
    volume: number;
    /** 当日累计成交额（元）。 */
    amount: number;
}

/** 从环形缓冲抽一码的点序列（老→新）。 */
export function seriesFor(history: HistoryRound[], code: string): Point[] {
    const out: Point[] = [];
    for (const round of history) {
        const row = round.rows.get(code);
        if (row) out.push({ at: round.at, price: row.p, volume: row.v, amount: row.a });
    }
    return out;
}

// ---------- 指标（纯函数，手算对拍钉死） ----------

/** 窗口涨跌幅 %：最新价 vs 窗口起点价。序列不足以覆盖窗口 → null。 */
export function windowChange(series: Point[], windowMs: number): number | null {
    if (series.length < 2) return null;
    const last = series[series.length - 1];
    const from = last.at - windowMs;
    let base: Point | null = null;
    for (const p of series) {
        if (p.at >= from) { base = p; break; }
    }
    if (!base || base === last || base.price <= 0) return null;
    return ((last.price - base.price) / base.price) * 100;
}

/** 日内量比近似：近 probeMs 量率 / 自观测起点平均量率（倍）。
 *  量是当日累计值，区间增量 = 差分。**基线分母用 (末-首) 增量**——观测起点
 *  之前已积累的当日存量不是我们观测到的流量（盘中启动时若不剔除，平均量率
 *  被存量摊薄，surge 系统性偏低——S5 翻车记档）。序列 <3 点或跨零 → null。 */
export function volumeSurge(series: Point[], probeMs: number): number | null {
    if (series.length < 3) return null;
    const first = series[0];
    const last = series[series.length - 1];
    let probe = series[series.length - 1];
    const from = last.at - probeMs;
    for (let i = series.length - 1; i >= 0; i--) {
        if (series[i].at <= from) { probe = series[i]; break; }
        probe = series[i];
    }
    const totalSpan = last.at - first.at;
    const probeSpan = last.at - probe.at;
    if (totalSpan <= 0 || probeSpan <= 0) return null;
    const avgRate = (last.volume - first.volume) / totalSpan;
    const probeRate = (last.volume - probe.volume) / probeSpan;
    if (avgRate <= 0) return null;
    return probeRate / avgRate;
}

/** 价格对当日均价（VWAP）的偏离 %。amount/volume 是累计值 → VWAP 只需末点：
 *  元 / (手×100股) = 每股价。 */
export function vwapDeviation(quote: Quote): number | null {
    if (quote.volume <= 0 || quote.amount <= 0 || quote.price <= 0) return null;
    const vwap = quote.amount / (quote.volume * 100);
    if (vwap <= 0) return null;
    return ((quote.price - vwap) / vwap) * 100;
}

/** 窗口突破：最新价突破 [now-windowMs, now-probeMs] 区间的极值。
 *  direction up 比 high、down 比 low。未突破/数据不足 → null（返回突破幅度%）。 */
export function breakout(series: Point[], windowMs: number, probeMs: number, direction: "up" | "down"): number | null {
    if (series.length < 3) return null;
    const last = series[series.length - 1];
    const winFrom = last.at - windowMs;
    const probeFrom = last.at - probeMs;
    let ext: number | null = null;
    for (const p of series) {
        if (p.at < winFrom || p.at > probeFrom) continue;
        if (p === last) continue;
        ext = ext === null ? p.price : direction === "up" ? Math.max(ext, p.price) : Math.min(ext, p.price);
    }
    if (ext === null || ext <= 0) return null;
    const pct = ((last.price - ext) / ext) * 100;
    return direction === "up" ? (pct > 0 ? pct : null) : (pct < 0 ? pct : null);
}

/** 分板涨停幅度 %：ST 5 / 主板 10 / 创业板科创板 20 / 北交所 30。 */
export function limitTier(code: string, name: string): number {
    if (/ST/i.test(name)) return 5;
    if (code.startsWith("bj")) return 30;
    if (code.startsWith("sz30") || code.startsWith("sh68")) return 20;
    return 10;
}

// ---------- 规则注册表 ----------

export interface Signal {
    code: string;
    name: string;
    rule: string;
    direction: "up" | "down";
    /** 规则主指标值（涨速%/突破幅度%/量率倍数/距板 %）。 */
    strength: number;
    note: string;
    at: number;
}

export interface RuleContext {
    quote: Quote;
    series: Point[];
}

export interface SignalRule {
    name: string;
    evaluate(ctx: RuleContext): Signal | null;
}

/** 默认规则四件（参数在闭包里，注册时可被同名规则覆盖）。 */
export function defaultRules(): SignalRule[] {
    return [
        {
            name: "rapid-move",
            evaluate({ quote, series }) {
                const chg = windowChange(series, 5 * 60_000);
                if (chg === null || Math.abs(chg) < 3) return null;
                return {
                    code: quote.code, name: quote.name, rule: "rapid-move",
                    direction: chg > 0 ? "up" : "down", strength: Math.round(chg * 100) / 100,
                    note: `5分钟${chg > 0 ? "涨" : "跌"} ${Math.abs(Math.round(chg * 100) / 100)}%`,
                    at: series[series.length - 1].at,
                };
            },
        },
        {
            name: "volume-surge",
            evaluate({ quote, series }) {
                const surge = volumeSurge(series, 60_000);
                const chg = windowChange(series, 5 * 60_000);
                if (surge === null || surge < 2.5 || chg === null || Math.abs(chg) < 1) return null;
                return {
                    code: quote.code, name: quote.name, rule: "volume-surge",
                    direction: chg > 0 ? "up" : "down",
                    strength: Math.round(surge * 100) / 100,
                    note: `量率${surge.toFixed(1)}倍 + 5分钟${chg > 0 ? "涨" : "跌"}${Math.abs(chg).toFixed(1)}%`,
                    at: series[series.length - 1].at,
                };
            },
        },
        {
            name: "breakout",
            evaluate({ quote, series }) {
                const surge = volumeSurge(series, 60_000);
                for (const direction of ["up", "down"] as const) {
                    const pct = breakout(series, 5 * 60_000, 30_000, direction);
                    if (pct === null) continue;
                    // 量能确认是硬门槛：无量数据（surge null）同样不认——
                    // 否则零量序列的形态突破会裸奔（S5 翻车记档）
                    if (surge === null || surge < 1.5) continue;
                    return {
                        code: quote.code, name: quote.name, rule: "breakout",
                        direction, strength: Math.round(pct * 100) / 100,
                        note: `${direction === "up" ? "突破" : "跌破"}5分钟${direction === "up" ? "高" : "低"}点 ${Math.abs(pct).toFixed(2)}%${surge !== null ? `（量率${surge.toFixed(1)}倍）` : ""}`,
                        at: series[series.length - 1].at,
                    };
                }
                return null;
            },
        },
        {
            name: "limit-approach",
            evaluate({ quote, series }) {
                if (quote.price <= 0 || quote.preClose <= 0) return null;
                const tier = limitTier(quote.code, quote.name);
                const toLimit = tier - quote.changePercent;
                const toLimitDown = -tier - quote.changePercent;
                const at = series.length > 0 ? series[series.length - 1].at : Date.now();
                if (toLimit <= 0.5) {
                    return {
                        code: quote.code, name: quote.name, rule: "limit-approach",
                        direction: "up", strength: Math.round(toLimit * 100) / 100,
                        note: `距涨停(${tier}%)仅 ${Math.max(toLimit, 0).toFixed(2)}%`,
                        at,
                    };
                }
                if (toLimitDown >= -0.5) {
                    return {
                        code: quote.code, name: quote.name, rule: "limit-approach",
                        direction: "down", strength: Math.round(toLimitDown * 100) / 100,
                        note: `距跌停(${tier}%)仅 ${Math.abs(Math.min(toLimitDown, 0)).toFixed(2)}%`,
                        at,
                    };
                }
                return null;
            },
        },
    ];
}

// ---------- 服务 ----------

export interface SignalConfig {
    /** 同 code+规则 的重发冷却 ms（默认 300,000 = 5 分钟）。 */
    cooldownMs?: number;
    /** 信号内存环容量（默认 200，新→旧）。 */
    keepSignals?: number;
    /** 追加规则（同名后写胜——覆盖默认规则即自定义）。 */
    rules?: SignalRule[];
}

export class SignalEngine extends Service {
    private market: MarketDataService | null = null;
    private cooldownMs: number;
    private keepSignals: number;
    private rules = new Map<string, SignalRule>();
    private lastFired = new Map<string, number>();

    /** 新→旧。 */
    recent: Signal[] = [];
    /** 测试可见：评估轮次计数。 */
    evaluateCount = 0;
    /** 测试可见：广播计数（含被冷却压掉的尝试）。 */
    suppressCount = 0;

    constructor(ctx: Context, name: string, config: SignalConfig = {}) {
        super(ctx, name);
        this.cooldownMs = config.cooldownMs ?? 300_000;
        this.keepSignals = config.keepSignals ?? 200;
        for (const rule of [...defaultRules(), ...(config.rules ?? [])]) {
            this.rules.set(rule.name, rule); // 同名后写胜
        }
    }

    /** 挂到行情面：订阅 market/snapshot，逐轮评估。 */
    attach(market: MarketDataService): void {
        this.market = market;
        this.ctx.on("market/snapshot", (snap) => this.evaluateSnapshot(snap));
    }

    /** 单轮评估：全市场逐码跑规则注册表（纯函数，同步完成）。 */
    evaluateSnapshot(snap: { at: number; quotes: Quote[] }): void {
        this.evaluateCount++;
        const rules = [...this.rules.values()];
        for (const quote of snap.quotes) {
            if (quote.price <= 0) continue;
            const series = seriesFor(this.market?.history ?? [], quote.code);
            for (const rule of rules) {
                let signal: Signal | null = null;
                try {
                    signal = rule.evaluate({ quote, series });
                } catch { /* 单规则单码抛错不炸整轮 */ }
                if (!signal) continue;
                const key = `${signal.code}#${rule.name}`;
                const last = this.lastFired.get(key);
                if (last !== undefined && signal.at - last < this.cooldownMs) {
                    this.suppressCount++;
                    continue;
                }
                this.lastFired.set(key, signal.at);
                this.recent = [signal, ...this.recent].slice(0, this.keepSignals);
                this.ctx.emit("market/signal", signal);
            }
        }
    }

    /** 注册模型面的只读工具。 */
    attachTools(): void {
        const tools = this.ctx.require<ToolsService>("tools");
        tools.register({
            name: "get_signals",
            description: "最近的市场信号（规则引擎产出：急涨急跌/放量/突破/涨跌停逼近）。"
                + "live=true 时先强制刷新一轮全市场快照再评估。信号是新→旧时间线，"
                + "每条带方向、强度与说明——这是 S6 裁决的输入面。",
            parameters: {
                type: "object",
                properties: {
                    direction: { type: "string", enum: ["up", "down"], description: "只看某方向" },
                    rule: { type: "string", description: "只看某规则（rapid-move/volume-surge/breakout/limit-approach）" },
                    limit: { type: "number", description: "返回条数（默认 20，上限 50）" },
                    live: { type: "boolean", description: "先强制刷新快照再评估（默认 false：读最近一轮结果）" },
                },
            },
            permissionHint: "read",
            execute: async (input) => {
                if (input.live === true && this.market) await this.market.refresh();
                const lim = Math.min(Math.max(Number(input.limit ?? 20), 1), 50);
                const rows = this.recent.filter((s) =>
                    (input.direction ? s.direction === input.direction : true)
                    && (input.rule ? s.rule === input.rule : true),
                ).slice(0, lim);
                const header = `信号 ${rows.length} 条（规则 ${[...this.rules.keys()].join("/")}，冷却 ${Math.round(this.cooldownMs / 1000)}s）`;
                if (rows.length === 0) return header + "\n（无命中——live: true 刷新一轮试试）";
                return [header, ...rows.map((s) => {
                    const hhmm = fmtTime(s.at);
                    return `[${hhmm}] ${s.code} ${s.name} ${s.rule} ${s.direction === "up" ? "↑" : "↓"} 强度${s.strength} ${s.note}`;
                })].join("\n");
            },
        });
    }
}

/** 固定 UTC+8 格式化 HH:mm（不经本机时区/locale——输出进快照必须确定）。 */
function fmtTime(at: number): string {
    const d = new Date(at + 8 * 3600_000);
    const hh = String(d.getUTCHours()).padStart(2, "0");
    const mm = String(d.getUTCMinutes()).padStart(2, "0");
    return `${hh}:${mm}`;
}

declare module "../cordis/context.js" {
    interface Context {
        signals?: SignalEngine;
    }
}

declare module "../cordis/events.js" {
    interface Events {
        /** 每个通过冷却的新信号（S6 裁决/S9 编排的消费面）。 */
        "market/signal"(signal: Signal): void;
    }
}

export const signalEnginePlugin: Plugin = {
    name: "signal-engine",
    inject: ["tools", "market"],
    apply(ctx: Context, config: SignalConfig = {}) {
        const market = ctx.require<MarketDataService>("market");
        const engine = new SignalEngine(ctx, "signals", config);
        engine.attach(market);
        engine.attachTools();
        // 卸载清冷却表（监听器经 B3 effect 自动摘除，无需手动）
    },
};
