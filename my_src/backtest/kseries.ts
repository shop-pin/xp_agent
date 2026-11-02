// backtest/kseries.ts——SC1：选股器 K 序列仓库 + 周/月重采样（研究面）。
//
// 通达信机制同构（总纲 §二）：本地只存基础周期（≙ hist-k 缓存 + daily-k
// 收口），高周期在内存聚合，指标现算不落盘。
// 合并口径：hist-k（腾讯 qfq，历史深度）打底，daily-k 收口（当日之后的新
// 收盘）覆盖同日与补尾——daily-k 是盯盘真相源，同日冲突以它为准。
// 重采样口径：TDX 周 = 交易日周（周一~周五；K 线只在交易日存在，天然无
// 周末歧义）；周/月 bar 的 day 标签 = 组内最后一个交易日（TDX 同款）；
// 停牌周/月无根不成 bar；聚合在 qfq 序列上进行（除权平滑，量额为原始合计）。

import { readdirSync } from "fs";
import { join } from "path";
import { dataRootPath, readSchemaJsonl, SCHEMA_DAILY_K, type DailyKRow } from "../plugins/data-store.js";
import { readKlineCache, type KBar } from "./kline.js";

// ---------- K 序列仓库 ----------

/** 全市场日线序列：hist-k 打底 + daily-k 覆盖（同日以 daily-k 为准、补尾）。
 *  两个根目录都缺失的票不出现；序列按日升序。 */
export function loadMarketDaily(root: string = dataRootPath()): Map<string, KBar[]> {
    const out = new Map<string, KBar[]>();
    // hist-k 全量（readdir 直读——单票 readKlineCache 的批量版）
    let histDir: string;
    try {
        histDir = join(root, "hist-k");
        for (const f of readdirSync(histDir).filter((f) => f.endsWith(".jsonl"))) {
            try {
                const { rows } = readSchemaJsonl<KBar>(join(histDir, f), "backtest.hist-k");
                if (rows.length > 0) out.set(f.slice(0, -6), rows);
            } catch { /* 坏文件跳过——缓存纪律 */ }
        }
    } catch { /* 无 hist-k 目录：只用 daily-k */ }
    // daily-k 覆盖/补尾
    const kDir = join(root, "daily-k");
    let kDays: string[] = [];
    try {
        kDays = readdirSync(kDir).filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).map((f) => f.slice(0, 10)).sort();
    } catch { /* 无 daily-k 目录 */ }
    for (const d of kDays) {
        let rows: DailyKRow[];
        try {
            rows = readSchemaJsonl<DailyKRow>(join(kDir, `${d}.jsonl`), SCHEMA_DAILY_K).rows;
        } catch { continue; }
        for (const r of rows) {
            const bar: KBar = {
                day: d, open: r.o, close: r.c, high: r.h, low: r.l, volume: r.vol, amount: r.amt,
                ...(r.to !== undefined ? { turnover: r.to } : {}),
            };
            const arr = out.get(r.code);
            if (!arr) { out.set(r.code, [bar]); continue; }
            const last = arr[arr.length - 1]!;
            if (last.day === d) arr[arr.length - 1] = bar;          // 同日覆盖（daily-k 为准）
            else if (last.day < d) arr.push(bar);                    // 补尾
            // last.day > d：hist-k 有更靠后的数据（不该发生）——保序跳过
        }
    }
    // 升序防御（hist-k 应已升序；合并后统一校验一次）
    for (const arr of out.values()) arr.sort((a, b) => (a.day < b.day ? -1 : 1));
    return out;
}

// ---------- 重采样（纯函数，手算对拍面） ----------

/** ISO 周键：YYYY-Www（周一为一周之始）。跨年周（如 12-29~01-04）按周四
 *  所在年份+周号归组；周号锚定该年 1 月 1 日所在周的周一数周格——键唯一
 *  且单调即可，不追求与任何外部周编号方案一致。 */
export function weekKey(day: string): string {
    const t = new Date(day + "T00:00:00Z");
    const dow = t.getUTCDay() || 7;             // 周日=7
    t.setUTCDate(t.getUTCDate() - (dow - 1));   // 回到周一
    const thursday = new Date(t);
    thursday.setUTCDate(thursday.getUTCDate() + 3); // ISO 周归属看周四所在年
    const year = thursday.getUTCFullYear();
    const anchor = new Date(Date.UTC(year, 0, 1));
    const adow = anchor.getUTCDay() || 7;
    anchor.setUTCDate(anchor.getUTCDate() - (adow - 1)); // 1/1 所在周的周一
    const week = Math.floor((thursday.getTime() - anchor.getTime()) / 86_400_000 / 7) + 1;
    return `${year}-W${String(week).padStart(2, "0")}`;
}

function aggregate(bars: KBar[]): KBar {
    let high = -Infinity, low = Infinity, volume = 0, amount = 0;
    for (const b of bars) {
        if (b.high > high) high = b.high;
        if (b.low < low) low = b.low;
        volume += b.volume;
        amount += b.amount;
    }
    return {
        day: bars[bars.length - 1]!.day,        // TDX 同款：标签=组内最后交易日
        open: bars[0]!.open,
        close: bars[bars.length - 1]!.close,
        high, low, volume, amount,
    };
}

/** 通用分组重采样：keyOf(day) 相同的连续根合成一根（停牌期无根不成 bar）。
 *  输入须升序；非连续同键（理论不可能：日历键连续）按出现顺序归并。 */
export function resample(bars: readonly KBar[], keyOf: (day: string) => string): KBar[] {
    const out: KBar[] = [];
    let group: KBar[] = [];
    let cur = "";
    for (const b of bars) {
        const k = keyOf(b.day);
        if (k !== cur) {
            if (group.length > 0) out.push(aggregate(group));
            group = [];
            cur = k;
        }
        group.push(b);
    }
    if (group.length > 0) out.push(aggregate(group));
    return out;
}

/** 周线重采样：交易日周（周一~周五）。不完整周（节假日缺根、序列首尾半周）
 *  按实有根聚合——TDX 同款。 */
export function resampleWeekly(bars: readonly KBar[]): KBar[] {
    return resample(bars, weekKey);
}

/** 月线重采样：day 前 7 位（YYYY-MM）分组。 */
export function resampleMonthly(bars: readonly KBar[]): KBar[] {
    return resample(bars, (day) => day.slice(0, 7));
}
