// backtest/digest.ts——跟踪期：每日 digest 与裁决/信号打分（研究面，零 LLM）。
//
// 学习环的证据底座：事件层（signals/verdicts）× 日K收口 → 每笔信号/裁决
// "之后 T+N 收盘涨跌"的客观对账。聚合表回答一个问题——哪类信号、哪档
// 信心真的带信息（何时买、何时卖的证据面，不靠印象；S14 反馈环的研究半边）。
//
// 口径：基准 = 信号/裁决当日收盘（近似事发时刻；收盘 14:57 集合竞价可成交、
// T+1 可卖——T+1 约束下最贴近可实现情况的口径），收益 = T+N 收盘/基准 − 1。
// 窗口未满（当日裁决等次日收盘）记 null，明天重跑自动补上。
// 序列来源由调用侧决定（CLI 缺省只用 daily-k 收口 = 零网络；--fetch 时补
// hist-k 的 qfq 收盘——qfq 与未复权收盘在除权日附近有差，跨源拼接属近似④同族）。

import type { Signal } from "../plugins/signal-engine.js";
import type { Fill } from "../plugins/paper-broker.js";

// ---------- 收益窗 ----------

/** 单票 close 序列：day("YYYY-MM-DD") → 收盘。字典序即时间序。 */
export type Series = Map<string, number>;

/** T+N 收盘收益：day 起 h 个交易日后的收盘/当日收盘 − 1；窗口未满 null。
 *  停牌日不在序列里 = 天然跳过（按该票自己的交易日历数 h 根）。 */
export function windowReturns(series: Series, day: string, horizons: readonly number[]): (number | null)[] {
    const days = [...series.keys()].sort();
    const i = days.indexOf(day);
    const base = series.get(day);
    if (i < 0 || base === undefined || base <= 0) return horizons.map(() => null);
    return horizons.map((h) => {
        const d = days[i + h];
        const c = d === undefined ? undefined : series.get(d);
        return c === undefined || c <= 0 ? null : c / base - 1;
    });
}

// ---------- 裁决打分与聚合 ----------

/** events/verdicts.jsonl 行的打分所需字段（reasons/risks/at 打分不用）。 */
export interface VerdictRow { day: string; code: string; action: string; confidence: number }

export interface VerdictGrade extends VerdictRow { ret1: number | null; ret3: number | null }

/** S6 裁决信心保守阶梯的顶档——高档是否真更准是校准的第一问。 */
export const HIGH_CONFIDENCE = 0.8;

export function gradeVerdicts(rows: VerdictRow[], seriesOf: (code: string) => Series | undefined): VerdictGrade[] {
    return rows.map((v) => {
        const s = seriesOf(v.code);
        const [ret1, ret3] = s ? windowReturns(s, v.day, [1, 3]) : [null, null];
        return { ...v, ret1, ret3 };
    });
}

export interface RetStats { n: number; avg: number | null; win: number | null }

/** 收益组统计：n 只数已闭环窗口——样本量与均值分开说，不拿 1 笔下结论。 */
export function retStats(rets: (number | null)[]): RetStats {
    const xs = rets.filter((r): r is number => r !== null);
    if (xs.length === 0) return { n: 0, avg: null, win: null };
    return {
        n: xs.length,
        avg: xs.reduce((a, b) => a + b, 0) / xs.length,
        win: xs.filter((r) => r > 0).length / xs.length,
    };
}

export interface ActionStats { action: string; tier: "high" | "normal"; ret1: RetStats; ret3: RetStats }

/** 裁决按 action × 信心档聚合——"高信心买点真的更准吗"的校准面。 */
export function aggregateVerdicts(grades: VerdictGrade[]): ActionStats[] {
    const buckets = new Map<string, VerdictGrade[]>();
    for (const g of grades) {
        const tier = g.confidence >= HIGH_CONFIDENCE ? "high" : "normal";
        const key = `${g.action}|${tier}`;
        const list = buckets.get(key);
        if (list) list.push(g); else buckets.set(key, [g]);
    }
    return [...buckets.entries()]
        .map(([key, gs]) => ({
            action: key.split("|")[0]!,
            tier: key.split("|")[1] as "high" | "normal",
            ret1: retStats(gs.map((g) => g.ret1)),
            ret3: retStats(gs.map((g) => g.ret3)),
        }))
        .sort((a, b) => a.action.localeCompare(b.action) || a.tier.localeCompare(b.tier));
}

// ---------- 信号规则打分与聚合 ----------

export type SignalRow = Signal & { day: string };

export interface SignalGrade { code: string; rule: string; direction: "up" | "down"; day: string; ret1: number | null }

export function gradeSignals(rows: SignalRow[], seriesOf: (code: string) => Series | undefined): SignalGrade[] {
    return rows.map((sig) => {
        const s = seriesOf(sig.code);
        const [ret1] = s ? windowReturns(s, sig.day, [1]) : [null];
        return { code: sig.code, rule: sig.rule, direction: sig.direction, day: sig.day, ret1 };
    });
}

export interface RuleStats { rule: string; direction: "up" | "down"; ret1: RetStats }

/** 规则 × 方向聚合，n 大者在前——哪条规则带信息一目了然。 */
export function aggregateRules(grades: SignalGrade[]): RuleStats[] {
    const buckets = new Map<string, SignalGrade[]>();
    for (const g of grades) {
        const key = `${g.rule}|${g.direction}`;
        const list = buckets.get(key);
        if (list) list.push(g); else buckets.set(key, [g]);
    }
    return [...buckets.entries()]
        .map(([key, gs]) => ({
            rule: key.split("|")[0]!,
            direction: key.split("|")[1] as "up" | "down",
            ret1: retStats(gs.map((g) => g.ret1)),
        }))
        .sort((a, b) => b.ret1.n - a.ret1.n || a.rule.localeCompare(b.rule));
}

// ---------- 持仓重建与市场概览 ----------

export interface PositionRow { code: string; qty: number; cost: number }

/** fill 流水 → 持仓（含费成本；卖出按比例结转——paper-broker 同口径；
 *  重放重建与 broker 内存态允许分级舍入差）。坏序账本的卖超笔跳过不炸。 */
export function positionsFromFills(fills: Fill[]): PositionRow[] {
    const pos = new Map<string, { qty: number; cost: number }>();
    for (const f of [...fills].sort((a, b) => a.at - b.at)) {
        const p = pos.get(f.code) ?? { qty: 0, cost: 0 };
        if (f.side === "buy") {
            p.qty += f.qty;
            p.cost += f.price * f.qty + f.fee;
        } else if (p.qty > 0) {
            const share = Math.min(1, f.qty / p.qty);
            p.cost *= 1 - share;
            p.qty -= f.qty;
        }
        if (p.qty > 1e-9) pos.set(f.code, p); else pos.delete(f.code);
    }
    return [...pos.entries()]
        .map(([code, p]) => ({ code, qty: p.qty, cost: p.cost }))
        .sort((a, b) => a.code.localeCompare(b.code));
}

export interface MarketOverview { up: number; down: number; flat: number; medianChg: number | null }

/** 全市场概览（日K收口行的 chg）：涨/跌/平家数 + 涨幅中位数。 */
export function marketOverview(rows: readonly { chg: number }[]): MarketOverview {
    const chgs = rows.map((r) => r.chg).filter((c) => Number.isFinite(c));
    const sorted = [...chgs].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    const median = sorted.length === 0 ? null
        : sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
    return {
        up: chgs.filter((c) => c > 0).length,
        down: chgs.filter((c) => c < 0).length,
        flat: chgs.filter((c) => c === 0).length,
        medianChg: median,
    };
}
