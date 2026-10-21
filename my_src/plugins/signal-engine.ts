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
//
// 宇宙闸 + 重发纪律（2026-10-21 跟踪 Day 1 复盘，参数权威 = my_docs/trading-rules.md）：
//   - 宇宙闸：北交所前缀 / ST·退市名称 / 日成交额下限——评估入口直接跳过
//     （Day 1：80 信号里 ~30 笔 BJ 僵尸票 + *ST田野 + 地量票全从裸跑进来，
//     每个裁决 turn 都白烧）
//   - 重发纪律：冷却只是节流，上限在日维度——同 code+规则 每日最多
//     dailyFireCap 次，且重发须强度创新值（同向 |strength| > 上次×refireGrowth，
//     方向翻转 ×flipGrowth）——蘅东光×5、万达轴承×4 那类零新信息重发

import type { Context } from "../cordis/context.js";
import type { Plugin } from "../cordis/fiber.js";
import { Service } from "../cordis/service.js";
import type { ToolsService } from "../services/tools.js";
import { isExcludedStock, type MarketDataService, type HistoryRound, type Quote, type Book } from "./market-data.js";
import { cnDay } from "./paper-broker.js";
import { DEFAULT_STRATEGY, loadStrategy, type SignalsConfig, type StrategyConfig } from "./strategy.js";

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

/** probe 窗口基准点（volumeSurge 与绝对量检验共用同一选点口径）——序列 <3 点
 *  返回 null。 */
function probePoint(series: Point[], probeMs: number): Point | null {
    if (series.length < 3) return null;
    const last = series[series.length - 1];
    const from = last.at - probeMs;
    let probe = series[series.length - 1];
    for (let i = series.length - 1; i >= 0; i--) {
        if (series[i].at <= from) { probe = series[i]; break; }
        probe = series[i];
    }
    return probe;
}

/** 日内量比近似：近 probeMs 量率 / 自观测起点平均量率（倍）。
 *  量是当日累计值，区间增量 = 差分。**基线分母用 (末-首) 增量**——观测起点
 *  之前已积累的当日存量不是我们观测到的流量（盘中启动时若不剔除，平均量率
 *  被存量摊薄，surge 系统性偏低——S5 翻车记档）。序列 <3 点或跨零 → null。 */
export function volumeSurge(series: Point[], probeMs: number): number | null {
    if (series.length < 3) return null;
    const first = series[0];
    const last = series[series.length - 1];
    const probe = probePoint(series, probeMs);
    if (!probe) return null;
    const totalSpan = last.at - first.at;
    const probeSpan = last.at - probe.at;
    if (totalSpan <= 0 || probeSpan <= 0) return null;
    const avgRate = (last.volume - first.volume) / totalSpan;
    const probeRate = (last.volume - probe.volume) / probeSpan;
    if (avgRate <= 0) return null;
    return probeRate / avgRate;
}

/** probe 窗口内的分钟成交额（元/分钟）——量率腿的绝对量检验（Day 1：4.9-6.6
 *  倍的假比率全建立在每分钟几十手上，分母趋零时比率必然爆表）。序列不足/零窗 → null。 */
export function probeAmountPerMin(series: Point[], probeMs: number): number | null {
    if (series.length < 3) return null;
    const last = series[series.length - 1];
    const probe = probePoint(series, probeMs);
    if (!probe || probe === last) return null;
    const span = last.at - probe.at;
    if (span <= 0) return null;
    return Math.max(0, ((last.amount - probe.amount) / span) * 60_000);
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

/** 买卖压力（S11）：(买五量−卖五量)/(买五量+卖五量) ∈ [−1,1]，>0 买方强。
 *  无盘口/总量为零 → null（比值量纲自消，挂单量单位不影响）。 */
export function bookPressure(book?: Book): number | null {
    if (!book || book.bids.length === 0 || book.asks.length === 0) return null;
    const bid = book.bids.reduce((s, l) => s + l.v, 0);
    const ask = book.asks.reduce((s, l) => s + l.v, 0);
    const total = bid + ask;
    return total > 0 ? (bid - ask) / total : null;
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
    /** 五档盘口（关注面轮询才有的码才有——盘口类规则判 null 自行让路）。 */
    book?: Book;
}

export interface SignalRule {
    name: string;
    evaluate(ctx: RuleContext): Signal | null;
}

/** 默认规则集（阈值来自策略配置——S14 策略即配置；默认 = DEFAULT_STRATEGY，
 *  注册时可被同名规则覆盖）。 */
export function defaultRules(s: SignalsConfig = DEFAULT_STRATEGY.signals): SignalRule[] {
    return [
        {
            name: "rapid-move",
            evaluate({ quote, series }) {
                const chg = windowChange(series, 5 * 60_000);
                if (chg === null || Math.abs(chg) < s.rapidMovePct) return null;
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
                if (surge === null || surge < s.volumeSurgeX || chg === null || Math.abs(chg) < s.volumeSurgeChgPct) return null;
                // 绝对量检验（Day 1）：量率腿必须建立在真流量上——probe 窗口
                // 分钟成交额或当日累计换手；两者皆无 = 零基线假比率
                // （方正阀门 6.6 倍 = 4 分钟零基线 ÷ 20 手）
                const perMin = probeAmountPerMin(series, 60_000);
                if ((perMin === null || perMin < s.volumeSurgeAmountPerMin) && quote.turnoverRate < s.volumeSurgeTurnover) return null;
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
                // 幅度腿按 tick 归一（Day 1）：低价股一个 tick 就冒充突破
                // （*ST田野 1.38 元一跳 0.72%）——幅度下限 = max(下限%, Ntick/价)
                const minPct = Math.max(s.breakoutMinPct, ((s.breakoutTicks * 0.01) / quote.price) * 100);
                for (const direction of ["up", "down"] as const) {
                    const pct = breakout(series, 5 * 60_000, 30_000, direction);
                    if (pct === null) continue;
                    // 量能确认是硬门槛：无量数据（surge null）同样不认——
                    // 否则零量序列的形态突破会裸奔（S5 翻车记档）
                    if (surge === null || surge < s.breakoutBaseSurgeX) continue;
                    // 双门槛（Day 1）：幅度或量率至少一项过线
                    if (Math.abs(pct) < minPct && surge < s.breakoutSurgeX) continue;
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
                // N 前缀首日无涨跌幅限制（Day 1：N文峰 +267% 被按 30% 板位
                // 算出"距涨停 −237%"）——板位规则整条跳过
                if (/^N/.test(quote.name)) return null;
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
        {
            name: "book-pressure",
            evaluate({ quote, series, book }) {
                const pr = bookPressure(book);
                if (pr === null || Math.abs(pr) < s.bookPressure) return null;
                const chg = windowChange(series, 5 * 60_000);
                if (chg === null || Math.abs(chg) < s.bookPressureChgPct) return null;
                // 压力与价格同向才算数：价格没动/反向的挂单墙是托单压单把戏，
                // 单看比值会被主动做出来（Day 1 纪律：机械门槛两条腿）
                if (Math.sign(chg) !== Math.sign(pr)) return null;
                return {
                    code: quote.code, name: quote.name, rule: "book-pressure",
                    direction: pr > 0 ? "up" : "down", strength: Math.round(pr * 100) / 100,
                    note: `买卖压力 ${pr.toFixed(2)} + 5分钟${chg > 0 ? "涨" : "跌"}${Math.abs(chg).toFixed(1)}%`,
                    at: series[series.length - 1].at,
                };
            },
        },
        {
            name: "volume-divergence",
            evaluate({ quote, series }) {
                const chg = windowChange(series, 5 * 60_000);
                const surge = volumeSurge(series, 60_000);
                if (chg === null || surge === null) return null;
                // 量价背离：价走出阈值+ 而量率趴在上限倍数以下——上涨无量=顶背离，
                // 下跌无量=底背离（方向取背离语义）。strength = 背离段涨速（带符号，
                // 与 rapid-move/breakout down 同约定）。
                if (chg >= s.divergenceChgPct && surge < s.divergenceSurgeX) {
                    return {
                        code: quote.code, name: quote.name, rule: "volume-divergence",
                        direction: "down", strength: Math.round(chg * 100) / 100,
                        note: `顶背离：5分钟涨${chg.toFixed(1)}% 而量率仅 ${surge.toFixed(1)} 倍`,
                        at: series[series.length - 1].at,
                    };
                }
                if (chg <= -s.divergenceChgPct && surge < s.divergenceSurgeX) {
                    return {
                        code: quote.code, name: quote.name, rule: "volume-divergence",
                        direction: "up", strength: Math.round(chg * 100) / 100,
                        note: `底背离：5分钟跌${Math.abs(chg).toFixed(1)}% 而量率仅 ${surge.toFixed(1)} 倍`,
                        at: series[series.length - 1].at,
                    };
                }
                return null;
            },
        },
    ];
}

// ---------- 服务 ----------

export interface SignalConfig {
    /** 策略配置（缺省 loadStrategy()——用户覆盖文件 > DEFAULT_STRATEGY）。 */
    strategy?: StrategyConfig;
    /** 同 code+规则 的重发冷却 ms（缺省走策略 signals.cooldownMs）。 */
    cooldownMs?: number;
    /** 信号内存环容量（默认 200，新→旧）。 */
    keepSignals?: number;
    /** 追加规则（同名后写胜——覆盖默认规则即自定义）。 */
    rules?: SignalRule[];
    /** 北交所排除（缺省走策略 universe.excludeBJ）。 */
    excludeBJ?: boolean;
    /** ST/退市名称排除（缺省走策略 universe.excludeST）。 */
    excludeST?: boolean;
    /** 日累计成交额下限（缺省走策略 universe.amountMin）。 */
    amountMin?: number;
    /** 同 code+规则 每日最大发射次数（缺省走策略 signals.dailyFireCap）。 */
    dailyFireCap?: number;
    /** 同向重发强度增长门槛（缺省走策略 signals.refireGrowth）。 */
    refireGrowth?: number;
    /** 方向翻转强度增长门槛（缺省走策略 signals.flipGrowth）。 */
    flipGrowth?: number;
}

export class SignalEngine extends Service {
    private market: MarketDataService | null = null;
    private cooldownMs: number;
    private keepSignals: number;
    private rules = new Map<string, SignalRule>();
    private lastFired = new Map<string, number>();
    private excludeBJ: boolean;
    private excludeST: boolean;
    private amountMin: number;
    private dailyFireCap: number;
    private refireGrowth: number;
    private flipGrowth: number;
    /** 重发纪律账本：key -> { 日键, 当日发射数, 末次强度/方向 }——跨日惰性重置。 */
    private fireStats = new Map<string, { day: string; count: number; strength: number; direction: string }>();
    /** 关注面盘口缓存（market/book 事件喂——data-store 轮询，决策 #9 只进关注面）。 */
    private books = new Map<string, Book>();

    /** 新→旧。 */
    recent: Signal[] = [];
    /** 测试可见：评估轮次计数。 */
    evaluateCount = 0;
    /** 测试可见：广播计数（含被冷却压掉的尝试）。 */
    suppressCount = 0;

    constructor(ctx: Context, name: string, config: SignalConfig = {}) {
        super(ctx, name);
        const strategy = config.strategy ?? loadStrategy();
        this.cooldownMs = config.cooldownMs ?? strategy.signals.cooldownMs;
        this.keepSignals = config.keepSignals ?? 200;
        this.excludeBJ = config.excludeBJ ?? strategy.universe.excludeBJ;
        this.excludeST = config.excludeST ?? strategy.universe.excludeST;
        this.amountMin = config.amountMin ?? strategy.universe.amountMin;
        this.dailyFireCap = config.dailyFireCap ?? strategy.signals.dailyFireCap;
        this.refireGrowth = config.refireGrowth ?? strategy.signals.refireGrowth;
        this.flipGrowth = config.flipGrowth ?? strategy.signals.flipGrowth;
        for (const rule of [...defaultRules(strategy.signals), ...(config.rules ?? [])]) {
            this.rules.set(rule.name, rule); // 同名后写胜
        }
    }

    /** 挂到行情面：订阅 market/snapshot 逐轮评估 + market/book 盘口缓存。 */
    attach(market: MarketDataService): void {
        this.market = market;
        this.ctx.on("market/snapshot", (snap) => this.evaluateSnapshot(snap));
        this.ctx.on("market/book", (b) => {
            for (const [code, book] of b.books) this.books.set(code, book);
        });
    }

    /** 单轮评估：宇宙闸过滤后逐码跑规则注册表（纯函数，同步完成）。 */
    evaluateSnapshot(snap: { at: number; quotes: Quote[] }): void {
        this.evaluateCount++;
        const rules = [...this.rules.values()];
        const day = cnDay(snap.at);
        for (const quote of snap.quotes) {
            if (quote.price <= 0) continue;
            // 宇宙闸：北交所/ST/退市名称（与 screen_market 共用谓词）+ 流动性下限
            if (isExcludedStock(quote, this.excludeST, this.excludeBJ)) continue;
            if (quote.amount < this.amountMin) continue;
            const series = seriesFor(this.market?.history ?? [], quote.code);
            for (const rule of rules) {
                let signal: Signal | null = null;
                try {
                    signal = rule.evaluate({ quote, series, book: this.books.get(quote.code) });
                } catch { /* 单规则单码抛错不炸整轮 */ }
                if (!signal) continue;
                const key = `${signal.code}#${rule.name}`;
                const last = this.lastFired.get(key);
                if (last !== undefined && signal.at - last < this.cooldownMs) {
                    this.suppressCount++;
                    continue;
                }
                // 重发纪律：冷却只是节流，上限在日维度。强度检验在前（内沿）、
                // 日上限在后（外沿）；跨日惰性重置——日键来自快照时刻，不引新钟。
                const prev = this.fireStats.get(key);
                const stats = prev && prev.day === day
                    ? prev
                    : { day, count: 0, strength: 0, direction: signal.direction };
                if (stats.count > 0) {
                    const growth = stats.direction === signal.direction ? this.refireGrowth : this.flipGrowth;
                    if (Math.abs(signal.strength) <= Math.abs(stats.strength) * growth) {
                        this.suppressCount++;
                        continue;
                    }
                }
                if (stats.count >= this.dailyFireCap) {
                    this.suppressCount++;
                    continue;
                }
                stats.count++;
                stats.strength = signal.strength;
                stats.direction = signal.direction;
                this.fireStats.set(key, stats);
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
        const strategy = config.strategy ?? loadStrategy();
        const engine = new SignalEngine(ctx, "signals", {
            ...config,
            cooldownMs: config.cooldownMs ?? strategy.signals.cooldownMs,
            dailyFireCap: config.dailyFireCap ?? strategy.signals.dailyFireCap,
            refireGrowth: config.refireGrowth ?? strategy.signals.refireGrowth,
            flipGrowth: config.flipGrowth ?? strategy.signals.flipGrowth,
            amountMin: config.amountMin ?? strategy.universe.amountMin,
            excludeBJ: config.excludeBJ ?? strategy.universe.excludeBJ,
            excludeST: config.excludeST ?? strategy.universe.excludeST,
            strategy,
        });
        engine.attach(market);
        engine.attachTools();
        // 卸载清冷却表（监听器经 B3 effect 自动摘除，无需手动）
    },
};
