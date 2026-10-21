// backtest/replay.ts——S13：按日重放引擎（微盘轮动口径：成员制、等权买入、
// 整手、费用复用 paper-broker computeFee、滑点 ±0.2%）。
//
// 回测口径三条近似（记档——S14 调参时记得偏差方向）：
//   ① 静态属性价格缩放：floatCap/pe 用今日值 × close_t/该股末根收盘（流通股本
//      与盈利不变假设——送转与业绩会漂移，漂移方向不定）
//   ② 收盘决策收盘成交：t 日收盘选池并按 t 日收盘调仓（轮动口径惯例；t 日数据
//      选 t 日池有一瞬前视，滑点对冲部分乐观）
//   ③ 滑点：买入 ×1.002 / 卖出 ×0.998（挂账#1 的回测侧口径；paper-broker 实盘
//      侧"按快照价成交+漂移拒单"双补丁仍在挂账，避免本章动两处成交语义）
// 成员制轮动：不做存量再平衡——池成员变化才交易（新进等权分现金买入、剔出全清）。

import { pickPool, type Quote } from "../plugins/market-data.js";
import { computeFee, round2 } from "../plugins/paper-broker.js";
import type { KBar } from "./kline.js";

export interface ReplayStock {
    code: string;
    name: string;
    /** 今日流通市值（元）——历史值按价格缩放近似（口径①）。 */
    floatCap: number;
    /** 今日 PE——历史值按价格缩放近似（口径①）。 */
    pe: number;
    pb: number;
    /** 日 K（升序）。 */
    bars: KBar[];
}

export interface ReplayTrade {
    day: string; code: string; side: "buy" | "sell"; price: number; qty: number; fee: number;
}

export interface ReplayResult {
    days: string[];
    /** 每日收盘净值 = 现金 + Σ 持股 × 当日收盘（估值不用滑点价）。 */
    equity: number[];
    trades: ReplayTrade[];
}

const SLIPPAGE = 0.002;

export interface ReplayOptions {
    topN?: number;
    cash?: number;
    ipoDays?: Map<string, string>;
    recentDays?: number;
}

/** 逐日重放：每日用该日伪快照跑 pickPool（同一选股函数——回测与盯盘产出
 *  一致行为的 S14 前置），成员变化即调仓。 */
export function replayRotation(stocks: ReplayStock[], opts: ReplayOptions = {}): ReplayResult {
    const topN = opts.topN ?? 20;
    let cash = opts.cash ?? 1_000_000;
    if (!Number.isFinite(cash) || cash <= 0) throw new Error(`初始资金非法：${cash}`);
    // 参考日历 = 所有股票 bar 日的并集升序；每股 day→bar 索引
    const daySet = new Set<string>();
    const byDay = new Map<string, Map<string, KBar>>();
    const lastClose = new Map<string, number>();
    for (const s of stocks) {
        if (s.bars.length === 0) continue;
        lastClose.set(s.code, s.bars[s.bars.length - 1]!.close);
        for (const b of s.bars) {
            daySet.add(b.day);
            if (!byDay.has(b.day)) byDay.set(b.day, new Map());
            byDay.get(b.day)!.set(s.code, b);
        }
    }
    const days = [...daySet].sort();
    const info = new Map(stocks.map((s) => [s.code, s]));

    const held = new Map<string, number>(); // code → qty
    const equity: number[] = [];
    const trades: ReplayTrade[] = [];

    for (const day of days) {
        const bars = byDay.get(day)!;
        // 伪快照（口径①）：价格缩放的 floatCap/pe + 当日真实量额
        const quotes: Quote[] = [];
        for (const [code, bar] of bars) {
            const s = info.get(code)!;
            const last = lastClose.get(code)!;
            if (last <= 0) continue;
            quotes.push({
                code, name: s.name, price: bar.close, change: 0, changePercent: 0,
                open: bar.open, high: bar.high, low: bar.low, preClose: bar.close,
                volume: bar.volume, amount: bar.amount, turnoverRate: 0, volumeRatio: 0,
                marketCap: 0, floatCap: s.floatCap * (bar.close / last),
                pb: s.pb, pe: s.pe * (bar.close / last),
            });
        }
        const pool = pickPool(quotes, { topN, ipoDays: opts.ipoDays, recentDays: opts.recentDays, today: day });
        const poolCodes = new Set(pool.map((p) => p.code));

        // 调仓一：剔出全清（卖出价 = 收盘 ×(1−滑点)）
        for (const [code, qty] of held) {
            if (poolCodes.has(code) || !bars.has(code)) continue; // 缺价日不动（停牌）
            const price = round2(bars.get(code)!.close * (1 - SLIPPAGE));
            const amount = round2(price * qty);
            const fee = computeFee("sell", amount);
            cash = round2(cash + amount - fee);
            held.delete(code);
            trades.push({ day, code, side: "sell", price, qty, fee });
        }
        // 调仓二：新进等权分现金买入（买入价 = 收盘 ×(1+滑点)；整手，零头不足一手放弃）
        const entrants = pool.map((p) => p.code).filter((c) => !held.has(c));
        if (entrants.length > 0) {
            const spend = cash / entrants.length;
            for (const code of entrants) {
                const price = round2(bars.get(code)!.close * (1 + SLIPPAGE));
                const qty = Math.floor(spend / price / 100) * 100;
                if (qty <= 0) continue;
                const amount = round2(price * qty);
                const fee = computeFee("buy", amount);
                if (amount + fee > cash) continue;
                cash = round2(cash - amount - fee);
                held.set(code, qty);
                trades.push({ day, code, side: "buy", price, qty, fee });
            }
        }
        // 收盘估值
        let value = cash;
        for (const [code, qty] of held) {
            const bar = bars.get(code);
            const s = info.get(code)!;
            const last = lastClose.get(code) ?? 1;
            const price = bar ? bar.close : (s.bars.length > 0 ? s.bars[s.bars.length - 1]!.close : 0);
            value += qty * (price || (s.floatCap / last || 0));
        }
        equity.push(round2(value));
    }
    return { days, equity, trades };
}
