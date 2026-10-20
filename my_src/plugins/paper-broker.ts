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
//   - 成交价 = 委托价（无订单簿建模——纸面撮合的诚实简化）
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

// ---------- 服务 ----------

interface PositionState {
    code: string;
    qty: number;
    boughtToday: number;
    day: string;
    cost: number;
}

export interface PaperConfig {
    startingCash?: number;
    ledgerPath?: string;
    now?: () => Date;
}

export function paperLedgerPath(): string {
    return join(homedir(), ".mini-claude", "stocks", "paper-ledger.jsonl");
}

export class PaperBroker extends Service {
    private market: MarketDataService | null = null;
    private now: () => Date;
    private ledgerPath: string;
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

    private snapshotPosition(p: PositionState, today: string): Position {
        this.rollDay(p, today);
        return { code: p.code, qty: p.qty, availQty: p.qty - p.boughtToday, cost: round2(p.cost) };
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
        const [lo, hi] = priceBand(order.code, quote.name, quote.preClose);
        if (order.price < lo || order.price > hi) {
            return { reason: `委托价 ${order.price} 超出 ${quote.name} 当日价带 [${lo}, ${hi}]（昨收 ${quote.preClose}）` };
        }

        const amount = round2(order.price * qty);
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
                p = { code: order.code, qty: 0, boughtToday: 0, day: today, cost: 0 };
                this.positions.set(order.code, p);
            }
            this.rollDay(p, today);
            p.qty += qty;
            p.boughtToday += qty;
            p.cost = round2(p.cost + amount + fee);
            return this.settle({ orderId: this.nextOrderId(), code: order.code, side: "buy", price: order.price, qty, fee, realizedPnl: null, at });
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
        return this.settle({ orderId: this.nextOrderId(), code: order.code, side: "sell", price: order.price, qty, fee, realizedPnl: pnl, at });
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
                p = { code: f.code, qty: 0, boughtToday: 0, day: today, cost: 0 };
                this.positions.set(f.code, p);
            }
            this.rollDay(p, today);
            p.qty += f.qty;
            p.boughtToday += f.qty;
            p.cost = round2(p.cost + amount + f.fee);
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
            description: "模拟盘下单（限价单，整手 100 股，纸面即时成交）。"
                + "费用按 A 股口径（佣金万2.5 最低5元/过户费/印花税卖出0.05%）；T+1 当日买入不可卖；"
                + "委托价超涨跌停价带拒单。reason 填裁决/信号依据（留痕）。",
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
            description: "模拟盘账户：现金、持仓（可卖/成本/市值/浮盈）、总资产、累计与当日已实现盈亏。市值按最新快照价估。",
            parameters: { type: "object", properties: {} },
            permissionHint: "read",
            execute: () => {
                const positions = this.getPositions();
                const rows = positions.map((pos) => {
                    const q = this.market?.latest?.byCode.get(pos.code);
                    const price = q?.price ?? 0;
                    const value = round2(price * pos.qty);
                    const pnl = pos.cost > 0 ? round2(((value - pos.cost) / pos.cost) * 100) : 0;
                    return `${pos.code}  ${q?.name ?? ""}  持${pos.qty}股 可卖${pos.availQty}  成本${pos.cost}  市值${value}  浮盈${pnl >= 0 ? "+" : ""}${pnl}%`;
                });
                const totalValue = round2(positions.reduce((s, pos) => {
                    const price = this.market?.latest?.byCode.get(pos.code)?.price ?? 0;
                    return s + price * pos.qty;
                }, 0));
                const day = this.todayPnl();
                const header = `现金 ${round2(this.cash)} 元 | 持仓市值 ${totalValue} 元 | 总资产 ${round2(this.cash + totalValue)} 元`
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
                const fills: any[] = [];
                try {
                    if (existsSync(this.ledgerPath)) {
                        for (const line of readFileSync(this.ledgerPath, "utf-8").split("\n").filter(Boolean)) {
                            try {
                                const e = JSON.parse(line);
                                if (e.type === "fill" && cnDay(e.at) === day) fills.push(e);
                            } catch { /* 跳过坏行——账本以可解析行为准 */ }
                        }
                    }
                } catch { /* 读不了当空账处理 */ }
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
        const broker = new PaperBroker(ctx, "broker", config);
        broker.attach(market);
        broker.attachTools();
    },
};
