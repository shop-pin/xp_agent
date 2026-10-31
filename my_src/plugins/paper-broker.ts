// plugins/paper-broker.ts——S7：模拟盘（stock profile 专用，base 默认 disabled）。
//
// BrokerAdapter 缝的第一次落地（总纲 §一思想 2："换 adapter 即换盘"的
// 第二次兑现——第一次是 C6 LlmAdapter）：PaperBroker 实现订单→成交→持仓→
// 账本的全链；S10 的 QmtBroker 将实现同一接口接真券商通道。
//
// 建模口径（记档，与真 A 股对齐）：
//   - 费用：佣金 max(5, 万2.5) 双边 + 过户费 0.001‰ 双边 + 印花税 0.05‰ 卖出单边
//   - 整手：股数向下取整到 100；不足一手拒单（零股卖出场景简化略）
//   - 涨跌停：委托价超 [round(昨收×(1±板%),2)] 拒单（往窄倒——对齐交易所
//     拒单行为，不做钳制成交）
//   - T+1：当日买入不可卖；交易日按北京时间日历日判定（boughtToday 随日切清零）
//   - 成交价 = 最新快照价 ± 滑点（挂账#1 补丁①，2026-10-31），委托价为限价
//     保护（更优一侧不越过）；委托价偏离最新价 >1% 拒单（补丁②，stale 挂单
//     fail-closed）——无订单簿建模的纸面撮合，但不再按委托价乐观成交
//   - 留痕双轨：账本 JSONL（跨会话真账，可重放对账）+ SessionLog meta/note
//     （会话内成交流，F6 投影侧栏消费）——账本是真相，注记是视图
//
// 现金默认 100 万起步（config.startingCash）。place_order 的 permissionHint
// 是 "exec"——S8 审批风控落地前，订单先走既有 confirm 摩擦。

import type { Context } from "../cordis/context.js";
import type { Plugin } from "../cordis/fiber.js";
import { Service } from "../cordis/service.js";
import type { ToolsService } from "../services/tools.js";
import type { SessionLog } from "../services/session-log.js";
import { existsSync, mkdirSync, readFileSync, appendFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import type { MarketDataService } from "./market-data.js";
import { limitTier } from "./signal-engine.js";
import { loadStrategy } from "./strategy.js";

// ---------- 词汇表 ----------

export interface Order {
    code: string;
    side: "buy" | "sell";
    /** 限价委托价（元）。 */
    price: number;
    /** 委托股数（成交前取整到 100 股手）。 */
    qty: number;
    /** 留痕引用（信号/裁决理由）。 */
    reason?: string;
}

export interface Fill {
    orderId: string;
    code: string;
    side: "buy" | "sell";
    price: number;
    qty: number;
    /** 总费用（佣金+过户+印花税，元）。 */
    fee: number;
    /** 卖出成交的已实现盈亏（买入为 null）。 */
    realizedPnl: number | null;
    at: number;
}

export interface Rejection {
    reason: string;
}

export interface Position {
    code: string;
    /** 总持仓（股）。 */
    qty: number;
    /** 可卖（T+1：当日买入不可卖）。 */
    availQty: number;
    /** 持仓总成本（含买入费用摊入，元）。 */
    cost: number;
    /** 持有期最高快照价（元）——移动止盈的回撤基准。买入成交价起步，
     *  watch 盘中喂价上抬；进程重启后回落为买入成交价（盘中峰值不留账，
     *  保守方向：线变低不易误触发）。 */
    peak: number;
}

// ---------- 费用与价格纯函数（手算对拍钉死） ----------

export const FEE = {
    commissionRate: 0.00025,
    minCommission: 5,
    transferRate: 0.00001,
    stampRate: 0.0005, // 卖出单边
} as const;

/** 交易费用（元）。买入 10 万 = 25+1 = 26；卖出 11 万 = 27.5+1.1+55 = 83.6。 */
export function computeFee(side: "buy" | "sell", amount: number): number {
    const commission = Math.max(FEE.minCommission, amount * FEE.commissionRate);
    const transfer = amount * FEE.transferRate;
    const stamp = side === "sell" ? amount * FEE.stampRate : 0;
    return round2(commission + transfer + stamp);
}

export function round2(n: number): number {
    return Math.round(n * 100) / 100;
}

/** 涨跌停价带 [下限, 上限]（板位分档来自 signal-engine 的 limitTier 单源）。 */
export function priceBand(code: string, name: string, preClose: number): [number, number] {
    const tier = limitTier(code, name);
    return [round2(preClose * (1 - tier / 100)), round2(preClose * (1 + tier / 100))];
}

/** 北京时间日历日 "YYYY-MM-DD"（T+1 的日切判定）。 */
export function cnDay(at: number): string {
    return new Date(at + 8 * 3600_000).toISOString().slice(0, 10);
}

/** 北京时间时:分 "HH:MM"（字典序即时间序——日K收口的 09:30 盘前门槛用）。 */
export function cnHm(at: number): string {
    return new Date(at + 8 * 3600_000).toISOString().slice(11, 16);
}

// ---------- 服务 ----------

interface PositionState {
    code: string;
    qty: number;
    boughtToday: number;
    day: string;
    cost: number;
    /** 持有期最高快照价（0 = 尚未定价，首笔买入成交价起步）。 */
    peak: number;
}

export interface PaperConfig {
    startingCash?: number;
    ledgerPath?: string;
    /** 单边滑点（0.002 = ±0.2%）——缺省走策略 backtest.slippage（插件层接线：
     *  同一配置值驱动回测与模拟盘，S14 一致行为锚的延伸）。 */
    slippage?: number;
    now?: () => Date;
}

export function paperLedgerPath(): string {
    return join(homedir(), ".mini-claude", "stocks", "paper-ledger.jsonl");
}

export class PaperBroker extends Service {
    private market: MarketDataService | null = null;
    private now: () => Date;
    private ledgerPath: string;
    /** 单边滑点（±0.2% 缺省）——成交建模见 submitOrder。 */
    private slippage: number;
    cash: number;
    /** 累计已实现盈亏（元）。 */
    realizedPnl = 0;
    /** 当日已实现盈亏（S8 日亏上限的口粮；日切清零）。 */
    dayPnl = 0;
    private dayPnlDate = "";
    private positions = new Map<string, PositionState>();
    private orderSeq = 0;

    constructor(ctx: Context, name: string, config: PaperConfig = {}) {
        super(ctx, name);
        this.now = config.now ?? (() => new Date());
        this.ledgerPath = config.ledgerPath ?? paperLedgerPath();
        this.slippage = Math.max(config.slippage ?? 0, 0);
        this.cash = config.startingCash ?? 1_000_000;
        this.loadLedger();
    }

    attach(market: MarketDataService): void {
        this.market = market;
    }

    getPositions(): Position[] {
        const today = cnDay(this.now().getTime());
        return [...this.positions.values()].map((p) => this.snapshotPosition(p, today));
    }

    /** 持有期峰值喂价（移动止盈的回撤基准）：peak 只上抬不下压。
     *  无持仓 no-op；清仓后重买 = 新持有期（peak 随持仓删除重置）。 */
    notePrice(code: string, price: number): void {
        if (!(price > 0)) return;
        const p = this.positions.get(code);
        if (!p) return;
        p.peak = Math.max(p.peak, price);
    }

    /** 全账本成交（坏行跳过——S10 get_trades_csv 的数据面）。 */
    allFills(): Fill[] {
        const fills: Fill[] = [];
        try {
            if (existsSync(this.ledgerPath)) {
                for (const line of readFileSync(this.ledgerPath, "utf-8").split("\n").filter(Boolean)) {
                    try {
                        const e = JSON.parse(line);
                        if (e.type === "fill") fills.push(e as Fill);
                    } catch { /* 跳过坏行——账本以可解析行为准 */ }
                }
            }
        } catch { /* 读不了当空账处理 */ }
        return fills;
    }

    private snapshotPosition(p: PositionState, today: string): Position {
        this.rollDay(p, today);
        return { code: p.code, qty: p.qty, availQty: p.qty - p.boughtToday, cost: round2(p.cost), peak: p.peak };
    }

    private rollDay(p: PositionState, today: string): void {
        if (p.day !== today) {
            p.day = today;
            p.boughtToday = 0;
        }
    }

    private rollPnlDay(today: string): void {
        if (this.dayPnlDate !== today) {
            this.dayPnlDate = today;
            this.dayPnl = 0;
        }
    }

    /** 当日已实现盈亏（惰性日切——读取即对齐今天）。 */
    todayPnl(): number {
        this.rollPnlDay(cnDay(this.now().getTime()));
        return this.dayPnl;
    }

    /** 下单：校验（码/整手/价带/资金/持仓）→ 纸面成交 → 账本+注记+事件。 */
    async submitOrder(order: Order): Promise<Fill | Rejection> {
        if (!/^(sh|sz|bj)\d{6}$/.test(order.code)) return { reason: `非法代码：${order.code}（需 sh/sz/bj 前缀）` };
        if (!(order.price > 0)) return { reason: "委托价必须为正数" };
        if (!Number.isInteger(order.qty) || order.qty < 100) return { reason: `委托量 ${order.qty} 股不足一手（100 股）` };
        const qty = Math.floor(order.qty / 100) * 100;

        const quote = await this.quoteFor(order.code);
        if (!quote) return { reason: `无 ${order.code} 行情，无法校验价带` };
        if (!(quote.price > 0)) return { reason: `无 ${order.code} 有效最新价（停牌/快照缺）——fail-closed 拒单` };
        const [lo, hi] = priceBand(order.code, quote.name, quote.preClose);
        if (order.price < lo || order.price > hi) {
            return { reason: `委托价 ${order.price} 超出 ${quote.name} 当日价带 [${lo}, ${hi}]（昨收 ${quote.preClose}）` };
        }

        // 挂账#1 补丁②（价格漂移拒单）：委托价与下单时刻最新快照偏离 >1% = stale
        // 挂单（旧行情下的想当然价），fail-closed 拒——先看最新行情再下单。
        const drift = Math.abs(order.price / quote.price - 1);
        if (drift > 0.01) {
            return { reason: `委托价 ${order.price} 与最新价 ${quote.price} 偏离 ${(drift * 100).toFixed(1)}% 超 1%（stale 挂单拒单）——刷新行情后按最新价附近重新委托` };
        }
        // 挂账#1 补丁①（滑点成交）：限价单不成交在劣于市价±冲击成本的价格——
        // buy = min(委托价, 最新价×(1+slip)) / sell = max(委托价, 最新价×(1−slip))。
        // 委托价仍是限价保护（更优一侧不越过），治"挂高价按高价成交"的乐观偏差。
        const slipped = quote.price * (1 + (order.side === "buy" ? this.slippage : -this.slippage));
        // 成交价到分（A 股价格步长 0.01）——滑点价先 round2 再与限价取边界
        const fillPrice = order.side === "buy"
            ? Math.min(order.price, round2(slipped))
            : Math.max(order.price, round2(slipped));

        const amount = round2(fillPrice * qty);
        const fee = computeFee(order.side, amount);
        const at = this.now().getTime();
        const today = cnDay(at);

        if (order.side === "buy") {
            if (this.cash < amount + fee) {
                return { reason: `资金不足：需 ${round2(amount + fee)} 元（含费），可用 ${round2(this.cash)} 元` };
            }
            this.cash = round2(this.cash - amount - fee);
            let p = this.positions.get(order.code);
            if (!p) {
                p = { code: order.code, qty: 0, boughtToday: 0, day: today, cost: 0, peak: 0 };
                this.positions.set(order.code, p);
            }
            this.rollDay(p, today);
            p.qty += qty;
            p.boughtToday += qty;
            p.cost = round2(p.cost + amount + fee);
            if (p.peak === 0) p.peak = fillPrice; // 新持有期：峰值从成交价起步（加仓不压低历史峰）
            return this.settle({ orderId: this.nextOrderId(), code: order.code, side: "buy", price: fillPrice, qty, fee, realizedPnl: null, at });
        }

        // sell
        const p = this.positions.get(order.code);
        if (!p) return { reason: `无持仓：${order.code}` };
        this.rollDay(p, today);
        const avail = p.qty - p.boughtToday;
        if (qty > avail) {
            return { reason: `可卖不足：委托 ${qty} 股，可卖 ${avail} 股（T+1：当日买入 ${p.boughtToday} 股不可卖）` };
        }
        const basis = round2(p.cost * (qty / p.qty));
        const pnl = round2(amount - fee - basis);
        this.cash = round2(this.cash + amount - fee);
        this.realizedPnl = round2(this.realizedPnl + pnl);
        this.rollPnlDay(today);
        this.dayPnl = round2(this.dayPnl + pnl);
        p.qty -= qty;
        p.cost = round2(p.cost - basis);
        if (p.qty === 0) this.positions.delete(order.code);
        return this.settle({ orderId: this.nextOrderId(), code: order.code, side: "sell", price: fillPrice, qty, fee, realizedPnl: pnl, at });
    }

    private nextOrderId(): string {
        this.orderSeq += 1;
        return `P${String(this.orderSeq).padStart(4, "0")}`;
    }

    /** 成交结算：账本追加 + SessionLog 注记（F6 投影消费）+ broker/fill 事件。 */
    private settle(fill: Fill): Fill {
        const line = JSON.stringify({ type: "fill", ...fill });
        try {
            mkdirSync(dirname(this.ledgerPath), { recursive: true });
            appendFileSync(this.ledgerPath, line + "\n");
        } catch { /* 账本落盘失败不炸交易——内存态为准，下次成交再试 */ }
        this.ctx.get<SessionLog>("session-log")?.append({
            type: "meta/note",
            key: "trade",
            value: {
                orderId: fill.orderId, code: fill.code, side: fill.side,
                price: fill.price, qty: fill.qty, fee: fill.fee,
                realizedPnl: fill.realizedPnl, cash: round2(this.cash),
            },
        });
        this.ctx.emit("broker/fill", fill);
        return fill;
    }

    private async quoteFor(code: string) {
        if (!this.market) return null;
        await this.market.ensureFresh(15_000);
        return this.market.latest?.byCode.get(code) ?? null;
    }

    /** 账本重放：首行 account 定起始资金，fill 行重建现金/持仓/序列号。 */
    private loadLedger(): void {
        try {
            if (!existsSync(this.ledgerPath)) return;
            const lines = readFileSync(this.ledgerPath, "utf-8").split("\n").filter(Boolean);
            for (const line of lines) {
                let e: any;
                try { e = JSON.parse(line); } catch { continue; }
                if (e.type === "account") {
                    this.cash = Number(e.startingCash) || this.cash;
                } else if (e.type === "fill") {
                    this.replayFill(e);
                }
            }
        } catch { /* 账本读失败 = 空账起步（资金用 config 缺省） */ }
    }

    private replayFill(f: Fill): void {
        const at = Number(f.at);
        const today = cnDay(at);
        const amount = round2(f.price * f.qty);
        let p = this.positions.get(f.code);
        if (f.side === "buy") {
            this.cash = round2(this.cash - amount - f.fee);
            if (!p) {
                p = { code: f.code, qty: 0, boughtToday: 0, day: today, cost: 0, peak: 0 };
                this.positions.set(f.code, p);
            }
            this.rollDay(p, today);
            p.qty += f.qty;
            p.boughtToday += f.qty;
            p.cost = round2(p.cost + amount + f.fee);
            if (p.peak === 0) p.peak = f.price;
        } else {
            this.cash = round2(this.cash + amount - f.fee);
            this.realizedPnl = round2(this.realizedPnl + (f.realizedPnl ?? 0));
            this.rollPnlDay(today);
            this.dayPnl = round2(this.dayPnl + (f.realizedPnl ?? 0));
            if (p) {
                this.rollDay(p, today);
                const basis = round2(p.cost * (f.qty / p.qty));
                p.qty -= f.qty;
                p.cost = round2(p.cost - basis);
                if (p.qty === 0) this.positions.delete(f.code);
            }
        }
        const seq = Number(String(f.orderId ?? "P0").slice(1));
        if (Number.isInteger(seq)) this.orderSeq = Math.max(this.orderSeq, seq);
    }

    /** 注册模型面工具：place_order（exec——S8 前的既有摩擦）+ get_portfolio（read）。 */
    attachTools(): void {
        const tools = this.ctx.require<ToolsService>("tools");
        tools.register({
            name: "place_order",
            description: "模拟盘下单（限价单，整手 100 股，按下单时最新价±滑点成交，委托价为限价保护）。"
                + "费用按 A 股口径（佣金万2.5 最低5元/过户费/印花税卖出0.05%）；T+1 当日买入不可卖；"
                + "委托价超涨跌停价带、或偏离最新价 1% 以上拒单。reason 填裁决/信号依据（留痕）。",
            parameters: {
                type: "object",
                properties: {
                    code: { type: "string", description: "sh600000 形式" },
                    side: { type: "string", enum: ["buy", "sell"] },
                    price: { type: "number", description: "限价（元）" },
                    qty: { type: "number", description: "股数（自动取整到 100）" },
                    reason: { type: "string", description: "下单依据（信号/裁决引用）" },
                },
                required: ["code", "side", "price", "qty"],
            },
            permissionHint: "exec",
            execute: async (input) => {
                const result = await this.submitOrder({
                    code: String(input.code ?? ""),
                    side: input.side === "sell" ? "sell" : "buy",
                    price: Number(input.price),
                    qty: Number(input.qty),
                    reason: input.reason ? String(input.reason) : undefined,
                });
                if ("reason" in result) return `Rejected: ${result.reason}`;
                const f = result;
                const pnl = f.realizedPnl !== null ? `，已实现盈亏 ${f.realizedPnl >= 0 ? "+" : ""}${f.realizedPnl} 元` : "";
                return `Filled ${f.orderId}: ${f.side === "buy" ? "买入" : "卖出"} ${f.code} ${f.qty} 股 @ ${f.price}，`
                    + `费用 ${f.fee} 元${pnl}，现金余额 ${round2(this.cash)} 元`;
            },
        });
        tools.register({
            name: "get_portfolio",
            description: "模拟盘账户：现金、持仓（可卖/成本/市值/浮盈）、总资产、累计与当日已实现盈亏。"
                + "市值按最新快照价估；无行情快照的持仓标「未计值」不按 0 元算。",
            parameters: { type: "object", properties: {} },
            permissionHint: "read",
            execute: () => {
                const positions = this.getPositions();
                // 无行情不按 0 元估（2026-10-30 缺陷②：缓存空 → "市值 0 盈亏
                // -100%" 幽灵污染复盘）——该行标注未计值，总市值只累有行情部分。
                let missing = 0;
                const rows = positions.map((pos) => {
                    const q = this.market?.latest?.byCode.get(pos.code);
                    if (!q || !(q.price > 0)) {
                        missing++;
                        return `${pos.code}  持${pos.qty}股 可卖${pos.availQty}  成本${pos.cost}  市值—（无行情，未计值）`;
                    }
                    const value = round2(q.price * pos.qty);
                    const pnl = pos.cost > 0 ? round2(((value - pos.cost) / pos.cost) * 100) : 0;
                    return `${pos.code}  ${q.name}  持${pos.qty}股 可卖${pos.availQty}  成本${pos.cost}  市值${value}  浮盈${pnl >= 0 ? "+" : ""}${pnl}%`;
                });
                const totalValue = round2(positions.reduce((s, pos) => {
                    const price = this.market?.latest?.byCode.get(pos.code)?.price ?? 0;
                    return price > 0 ? s + price * pos.qty : s;
                }, 0));
                const day = this.todayPnl();
                const header = `现金 ${round2(this.cash)} 元 | 持仓市值 ${totalValue} 元`
                    + `${missing > 0 ? `（${missing} 只无行情未计值）` : ""}`
                    + ` | 总资产 ${round2(this.cash + totalValue)} 元`
                    + ` | 已实现盈亏 ${this.realizedPnl >= 0 ? "+" : ""}${this.realizedPnl} 元`
                    + ` | 当日已实现 ${day >= 0 ? "+" : ""}${day} 元`;
                return [header, ...(rows.length > 0 ? rows : ["（无持仓）"])].join("\n");
            },
        });
        tools.register({
            name: "get_trades",
            description: "当日（或指定日）成交流水——复盘的账本视图。day 格式 YYYY-MM-DD（北京时间），缺省今天。",
            parameters: {
                type: "object",
                properties: { day: { type: "string", description: "YYYY-MM-DD；缺省今天" } },
            },
            permissionHint: "read",
            execute: (input) => {
                const day = typeof input.day === "string" && /^\d{4}-\d{2}-\d{2}$/.test(input.day)
                    ? input.day
                    : cnDay(this.now().getTime());
                const fills: any[] = this.allFills().filter((f) => cnDay(f.at) === day);
                if (fills.length === 0) return `${day} 无成交记录`;
                const rows = fills.map((f) => {
                    const pnl = f.realizedPnl !== null && f.realizedPnl !== undefined
                        ? `，已实现 ${f.realizedPnl >= 0 ? "+" : ""}${f.realizedPnl}` : "";
                    return `${f.orderId} ${f.side === "buy" ? "买" : "卖"} ${f.code} ${f.qty}股 @${f.price}`
                        + ` 费${f.fee}${pnl}`;
                });
                const feeSum = round2(fills.reduce((s, f) => s + (f.fee ?? 0), 0));
                const pnlSum = round2(fills.reduce((s, f) => s + (f.realizedPnl ?? 0), 0));
                return [`${day} 成交 ${fills.length} 笔 | 费用合计 ${feeSum} 元 | 已实现合计 ${pnlSum} 元`, ...rows].join("\n");
            },
        });
    }
}

function dirname(p: string): string {
    const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
    return i <= 0 ? "." : p.slice(0, i);
}

declare module "../cordis/context.js" {
    interface Context {
        broker?: PaperBroker;
    }
}

declare module "../cordis/events.js" {
    interface Events {
        /** 每笔纸面成交（S8 审计/S9 编排的消费面）。 */
        "broker/fill"(fill: Fill): void;
    }
}

export const paperBrokerPlugin: Plugin = {
    name: "paper-broker",
    inject: ["tools", "market"],
    apply(ctx: Context, config: PaperConfig = {}) {
        const market = ctx.require<MarketDataService>("market");
        // 滑点缺省走策略 backtest.slippage——同一配置值驱动回测与模拟盘（S14 锚）
        const full: PaperConfig = config.slippage === undefined
            ? { ...config, slippage: loadStrategy().backtest.slippage }
            : config;
        const broker = new PaperBroker(ctx, "broker", full);
        broker.attach(market);
        broker.attachTools();
    },
};
