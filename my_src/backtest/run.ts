// backtest/run.ts——S13 CLI：微盘 20 轮动近三年回测（研究面——**回测结果只进
// 研究面，不直接驱动下单**，plan §四 S13 纪律原文）。
//
// 用法：node dist/backtest/run.js [--topN 20] [--years 3] [--cash 1000000]
//          [--limit 850] [--max 0] [--refresh]
//   --max N  只拉前 N 只股票的日K（冒烟用；0=全市场）
// 数据流：新浪今日快照（静态属性）+ 东财 IPO 表（封锁窗时退化 N/C 前缀）+
// 腾讯前复权日K（磁盘缓存 hist-k/，首跑 ~5,000 请求，之后秒级）→
// replayRotation → metrics + 文本曲线。
// 参数源：strategy = loadStrategy()（S14 策略即配置——CLI 与盯盘系统同一份）。

import { parseSinaList, eastmoneySource, type Quote } from "../plugins/market-data.js";
import { loadStrategy } from "../plugins/strategy.js";
import { loadKlines } from "./kline.js";
import { replayRotation, type ReplayStock } from "./replay.js";
import { computeMetrics, textCurve } from "./metrics.js";

function arg(name: string, def: string): string {
    const i = process.argv.indexOf(`--${name}`);
    return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1]! : def;
}

/** 简单重试（指数退避）——免费接口的瞬时抖动不该炸全程。 */
async function retry<T>(fn: () => Promise<T>, times = 3, backoffMs = 800): Promise<T> {
    let lastErr: unknown;
    for (let a = 0; a < times; a++) {
        try {
            return await fn();
        } catch (e) {
            lastErr = e;
            await new Promise((r) => setTimeout(r, backoffMs * (a + 1)));
        }
    }
    throw lastErr;
}

const SLIDE_EM = "https://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/Market_Center.getHQNodeData";

async function fetchSinaList(): Promise<Quote[]> {
    const out: Quote[] = [];
    for (let start = 1; start <= 200; start += 8) {
        const group: number[] = [];
        for (let p = start; p < start + 8; p++) group.push(p);
        const results = await Promise.all(group.map(async (page) => {
            const url = `${SLIDE_EM}?page=${page}&num=100&sort=symbol&asc=1&node=hs_a`;
            const res = await fetch(url, {
                headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)", Referer: "https://vip.stock.finance.sina.com.cn/" },
                signal: AbortSignal.timeout(10_000),
            });
            if (!res.ok) throw new Error(`sina page ${page}: HTTP ${res.status}`);
            const rows = JSON.parse(await res.text()) as Record<string, unknown>[];
            return Array.isArray(rows) ? parseSinaList(rows) : [];
        }));
        let done = false;
        for (const rows of results) {
            out.push(...rows);
            if (rows.length < 100) { done = true; break; }
        }
        if (done) break;
    }
    return out;
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>, onDone: (done: number, total: number) => void): Promise<R[]> {
    const out: R[] = new Array(items.length);
    let next = 0;
    let done = 0;
    const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
        for (;;) {
            const i = next++;
            if (i >= items.length) return;
            out[i] = await fn(items[i]!);
            done++;
            if (done % 500 === 0 || done === items.length) onDone(done, items.length);
        }
    });
    await Promise.all(workers);
    return out;
}

async function main(): Promise<void> {
    const strategy = loadStrategy();
    const topN = Number(arg("topN", String(strategy.pool.topN)));
    const years = Number(arg("years", "3"));
    const cash = Number(arg("cash", String(strategy.backtest.initialCash)));
    const limit = Number(arg("limit", String(Math.ceil(years * 252) + 100)));
    const max = Number(arg("max", "0"));
    const refresh = process.argv.includes("--refresh");

    console.log(`[1/4] 新浪全市场快照…`);
    const quotes = await fetchSinaList();
    console.log(`  ${quotes.length} 只`);
    console.log(`[2/4] 东财 IPO 日期表…`);
    let ipoDays = new Map<string, string>();
    try {
        ipoDays = (await retry(() => eastmoneySource.fetchIpoDays?.() ?? Promise.resolve(new Map<string, string>()), 2)) ?? new Map();
    } catch { /* 东财封锁窗——次新退化 N/C 前缀（bars<60 天然再剔一层） */ }
    console.log(`  ${ipoDays.size} 只${ipoDays.size === 0 ? "（源不可用——次新退化 N/C 前缀）" : ""}`);

    const universe = quotes.filter((q) => q.price > 0 && q.floatCap > 0).slice(0, max > 0 ? max : undefined);
    console.log(`[3/4] 东财后复权日K ×${universe.length}（缓存 hist-k/，${refresh ? "强制重拉" : "缓存优先"}）…`);
    let failed = 0;
    const barsList = await mapLimit(universe, 12, async (q) => {
        try {
            return await retry(() => loadKlines(q.code, limit, undefined, refresh), 2);
        } catch {
            failed++;
            return [];
        }
    }, (done, total) => console.log(`  ${done}/${total}`));

    const stocks: ReplayStock[] = [];
    universe.forEach((q, i) => {
        const bars = barsList[i]!;
        if (bars.length < 60) return; // 数据不足（新股/长停/拉取失败）——次新腿在池内也会剔
        stocks.push({ code: q.code, name: q.name, floatCap: q.floatCap, pe: q.pe ?? 0, pb: q.pb, bars });
    });
    console.log(`  有效 ${stocks.length} 只（不足/失败跳过 ${universe.length - stocks.length}，其中拉取失败 ${failed}）`);

    console.log(`[4/4] 逐日重放：topN=${topN} 初始资金=${cash} 滑点=${strategy.backtest.slippage}`);
    const t0 = Date.now();
    const result = replayRotation(stocks, { topN, cash, ipoDays, slippage: strategy.backtest.slippage });
    console.log(`  ${result.days.length} 个交易日 / ${result.trades.length} 笔调仓 / ${Date.now() - t0}ms`);

    if (result.days.length < 2) {
        console.log("净值序列太短——检查日K缓存（--refresh 重拉）");
        return;
    }
    const m = computeMetrics(result.days, result.equity);
    const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
    console.log("\n===== 微盘轮动回测（研究面） =====");
    console.log(`区间 ${result.days[0]} → ${result.days[result.days.length - 1]}（${result.days.length} 交易日，topN=${topN}）`);
    console.log(`总收益 ${pct(m.totalReturn)} | 年化 ${pct(m.annualized)}`);
    console.log(`最大回撤 ${pct(m.maxDrawdown)}（峰→谷 ${m.ddDays} 日，${m.recoveryDays === null ? "未修复" : `修复 ${m.recoveryDays} 日`}）`);
    console.log(`按年分层：${m.yearly.map((y) => `${y.year} ${pct(y.ret)}`).join(" | ")}`);
    console.log(`调仓 ${result.trades.length} 笔`);
    console.log();
    console.log(textCurve(result.days, result.equity));
    console.log("\n—— 回测结果只进研究面，不直接驱动下单（S13 纪律）。口径近似见 backtest/replay.ts 头注。");
}

void main().catch((e) => {
    console.error(`回测失败：${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
});
