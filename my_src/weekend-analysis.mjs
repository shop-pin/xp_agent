// 周末历史分析一次性脚本（挂账 #9(c)，研究面——周末协议工具，缓存刷新后复跑）：
//   W1 复现微盘轮动净值 + 回撤分段 + 风格月表（微盘/大盘等权五分位）
//   W2 止损击穿统计：固定 -5% / 移动止盈 5%（20 日持有窗，逐票逐入场日）
//   W3 日K规则代理（20 日新高突破 / 放量急涨）前瞻收益 × 风格分层
// 数据：hist-k 缓存（~2024-03 → 2026-10-21）+ 新浪今日快照（静态属性，口径①同 S13）。
// 运行：cd my_src && node weekend-analysis.mjs
import { readdirSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir, homedir } from "os";
import { dataRootPath, readSchemaJsonl } from "./dist/plugins/data-store.js";
import { parseSinaList } from "./dist/plugins/market-data.js";
import { replayRotation, } from "./dist/backtest/replay.js";
import { computeMetrics } from "./dist/backtest/metrics.js";

const pct = (x) => `${(x * 100).toFixed(1)}%`;
const pct2 = (x) => `${(x * 100).toFixed(2)}%`;
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN);
const median = (a) => { if (!a.length) return NaN; const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };

// ---------- 数据装载 ----------
const root = dataRootPath();
const histDir = join(root, "hist-k");
console.log(`[1] 读 hist-k 缓存 ${histDir}`);
const files = readdirSync(histDir).filter((f) => f.endsWith(".jsonl"));
const cache = new Map(); // code → KBar[]
let badFiles = 0;
for (const f of files) {
    try {
        const { rows } = readSchemaJsonl(join(histDir, f), "backtest.hist-k");
        if (rows.length) cache.set(f.slice(0, -6), rows);
    } catch { badFiles++; }
}
console.log(`  ${cache.size} 只有日K（schema 异常跳过 ${badFiles}）`);

console.log(`[2] 新浪全市场快照（静态属性）…`);
const SLIDE = "https://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/Market_Center.getHQNodeData";
async function fetchSinaList() {
    const out = [];
    for (let start = 1; start <= 200; start += 8) {
        const group = [];
        for (let p = start; p < start + 8; p++) group.push(p);
        const results = await Promise.all(group.map(async (page) => {
            const res = await fetch(`${SLIDE}?page=${page}&num=100&sort=symbol&asc=1&node=hs_a`, {
                headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)", Referer: "https://vip.stock.finance.sina.com.cn/" },
                signal: AbortSignal.timeout(10_000),
            });
            if (!res.ok) throw new Error(`sina page ${page}: HTTP ${res.status}`);
            const rows = JSON.parse(await res.text());
            return Array.isArray(rows) ? parseSinaList(rows) : [];
        }));
        let done = false;
        for (const rows of results) { out.push(...rows); if (rows.length < 100) { done = true; break; } }
        if (done) break;
    }
    return out;
}
const quotes = (await fetchSinaList()).filter((q) => q.price > 0 && q.floatCap > 0 && !q.code.startsWith("bj"));
console.log(`  ${quotes.length} 只（沪深，剔除北交所/停牌/零市值）`);

const stocks = [];
for (const q of quotes) {
    const bars = cache.get(q.code);
    if (!bars || bars.length < 60) continue;
    stocks.push({ code: q.code, name: q.name, floatCap: q.floatCap, pe: q.pe ?? 0, pb: q.pb, bars });
}
console.log(`  有效 ${stocks.length} 只（bars≥60）`);

// ---------- W1：净值复现 + 回撤分段 + 风格月表 ----------
console.log(`\n===== W1 微盘轮动净值复现（topN=20） =====`);
const t0 = Date.now();
const rep = replayRotation(stocks, { topN: 20, cash: 1_000_000, slippage: 0.002 });
console.log(`  ${rep.days.length} 交易日 / ${rep.trades.length} 笔调仓 / ${Date.now() - t0}ms（区间 ${rep.days[0]} → ${rep.days[rep.days.length - 1]}）`);
const m = computeMetrics(rep.days, rep.equity);
console.log(`  总收益 ${pct(m.totalReturn)} | 最大回撤 ${pct(m.maxDrawdown)} | 按年：${m.yearly.map((y) => `${y.year} ${pct(y.ret)}`).join(" | ")}`);

// 回撤分段：交替峰谷（深度 ≥5% 的段落全列，按深度降序）
const eq = rep.equity, days = rep.days;
let peakV = eq[0], peakI = 0;
const episodes = [];
for (let i = 1; i < eq.length; i++) {
    if (eq[i] >= peakV) { peakV = eq[i]; peakI = i; continue; }
    const dd = eq[i] / peakV - 1;
    const last = episodes[episodes.length - 1];
    if (last && last.peakI === peakI) { if (dd < last.dd) { last.dd = dd; last.troughI = i; } }
    else episodes.push({ peakI, troughI: i, dd });
}
const segs = episodes.filter((e) => e.dd <= -0.05).map((e) => ({
    peakDay: days[e.peakI], troughDay: days[e.troughI], depth: e.dd,
    fallDays: e.troughI - e.peakI,
})).sort((a, b) => a.depth - b.depth).slice(0, 6);
console.log("  主要回撤段（深度降序）:");
for (const s of segs) console.log(`    ${s.peakDay} → ${s.troughDay}  ${pct(s.depth)}（下跌 ${s.fallDays} 日）`);

// 风格五分位（今日 floatCap 静态近似，口径①）：每日等权收益 → 月度复利
const sorted = [...stocks].sort((a, b) => a.floatCap - b.floatCap);
const q1set = new Set(sorted.slice(0, Math.floor(sorted.length * 0.2)).map((s) => s.code));
const q5set = new Set(sorted.slice(-Math.floor(sorted.length * 0.2)).map((s) => s.code));
const byDay = new Map();
for (const s of stocks) {
    const inQ1 = q1set.has(s.code), inQ5 = q5set.has(s.code);
    if (!inQ1 && !inQ5) continue;
    for (let i = 1; i < s.bars.length; i++) {
        const r = s.bars[i].close / s.bars[i - 1].close - 1;
        if (!Number.isFinite(r)) continue;
        const d = s.bars[i].day;
        if (!byDay.has(d)) byDay.set(d, { micro: [], macro: [] });
        (inQ1 ? byDay.get(d).micro : byDay.get(d).macro).push(r);
    }
}
const allDays = [...byDay.keys()].sort();
const monthAgg = new Map();
for (const d of allDays) {
    const mo = d.slice(0, 7);
    if (!monthAgg.has(mo)) monthAgg.set(mo, { micro: 0, macro: 0, n: 0 });
    const a = monthAgg.get(mo);
    a.micro += mean(byDay.get(d).micro);
    a.macro += mean(byDay.get(d).macro);
    a.n++;
}
console.log("  风格月表（微盘=流通市值后 20% 等权 / 大盘=前 20% 等权，月度累计日均收益）:");
console.log("  月      | 微盘    | 大盘    | 微盘-大盘");
const monthRows = [];
for (const [mo, a] of monthAgg) {
    if (a.n < 10) continue;
    const mi = a.micro / a.n * 21, ma = a.macro / a.n * 21; // 月化（日均×21 粗口径，比方向够用）
    monthRows.push({ mo, micro: mi, macro: ma });
    console.log(`  ${mo} | ${pct2(mi).padStart(7)} | ${pct2(ma).padStart(7)} | ${pct2(mi - ma).padStart(7)}`);
}

// ---------- W2：止损击穿统计（固定 -5% / 移动 5%，20 日窗） ----------
console.log(`\n===== W2 止损击穿统计（20 日持有窗，bars≥250，入场=次日开盘近似为当日收盘） =====`);
const H = 20;
const agg = { n: 0, fixedHit: 0, trailHit: 0, fixedRet: [], trailRet: [], holdRet: [] };
const aggUp = { n: 0, fixedHit: 0, trailHit: 0, fixedRet: [], trailRet: [], holdRet: [] };
const aggDn = { n: 0, fixedHit: 0, trailHit: 0, fixedRet: [], trailRet: [], holdRet: [] };
const microMonth = new Map(monthRows.map((r) => [r.mo, r.micro - r.macro]));
function bucket(mo) { const s = microMonth.get(mo); return s === undefined ? null : s >= 0 ? aggUp : aggDn; }
for (const s of stocks) {
    const bars = s.bars;
    if (bars.length < 250) continue;
    for (let t = 0; t + H < bars.length; t++) {
        const entry = bars[t].close;
        if (!(entry > 0)) continue;
        const fixedStop = entry * 0.95;
        let peak = entry;
        let fHit = null, tHit = null;
        for (let i = t + 1; i <= t + H; i++) {
            const b = bars[i];
            if (fHit === null && b.low <= fixedStop) fHit = b;
            if (tHit === null && b.low <= peak * 0.95) tHit = b;
            peak = Math.max(peak, b.close);
        }
        const hold = bars[t + H].close / entry - 1;
        const mo = bars[t].day.slice(0, 7);
        for (const a of [agg, bucket(mo)].filter(Boolean)) {
            a.n++;
            if (fHit) { a.fixedHit++; a.fixedRet.push(fHit.close / entry - 1); }
            if (tHit) { a.trailHit++; a.trailRet.push(tHit.close / entry - 1); }
            a.holdRet.push(hold);
        }
    }
}
function show(name, a) {
    console.log(`  ${name}: 样本 ${a.n} | 固定-5% 击穿 ${pct(a.fixedHit / a.n)}（击穿时均收益 ${pct2(mean(a.fixedRet))}） | 移动5% 触发 ${pct(a.trailHit / a.n)}（触发时均收益 ${pct2(mean(a.trailRet))}） | 无止损 20 日均收益 ${pct2(mean(a.holdRet))}`);
}
show("全样本", agg);
show("微盘强势月", aggUp);
show("微盘弱势月", aggDn);

// ---------- W3：日K规则代理 × 风格分层 ----------
console.log(`\n===== W3 规则代理前瞻收益（信号后 +5/+10/+20 日，按微盘强/弱月分层） =====`);
const rules = {
    breakout20: (bars, i) => {
        if (i < 20) return false;
        let hi = -Infinity, vSum = 0;
        for (let j = i - 20; j < i; j++) { hi = Math.max(hi, bars[j].close); vSum += bars[j].volume; }
        return bars[i].close > hi && bars[i].volume > 1.5 * (vSum / 20);
    },
    surge: (bars, i) => {
        if (i < 20) return false;
        let vSum = 0;
        for (let j = i - 20; j < i; j++) vSum += bars[j].volume;
        return bars[i].volume > 2 * (vSum / 20) && bars[i].close / bars[i - 1].close - 1 >= 0.02;
    },
};
for (const [rule, fn] of Object.entries(rules)) {
    const res = { all: mk(), up: mk(), dn: mk() };
    function mk() { return { n: 0, f5: [], f10: [], f20: [] }; }
    for (const s of stocks) {
        const bars = s.bars;
        if (bars.length < 250) continue;
        for (let i = 21; i + 20 < bars.length; i++) {
            if (!fn(bars, i)) continue;
            const mo = bars[i].day.slice(0, 7);
            for (const [k, a] of Object.entries(res)) {
                if (k === "up" && (microMonth.get(mo) ?? 0) < 0) continue;
                if (k === "dn" && (microMonth.get(mo) ?? 0) >= 0) continue;
                a.n++;
                a.f5.push(bars[i + 5].close / bars[i].close - 1);
                a.f10.push(bars[i + 10].close / bars[i].close - 1);
                a.f20.push(bars[i + 20].close / bars[i].close - 1);
            }
        }
    }
    for (const [k, a] of Object.entries(res)) {
        if (!a.n) continue;
        console.log(`  ${rule} [${k}]: ${a.n} 次 | 均值 ${pct2(mean(a.f5))}/${pct2(mean(a.f10))}/${pct2(mean(a.f20))} | 中位 ${pct2(median(a.f5))}/${pct2(median(a.f10))}/${pct2(median(a.f20))}`);
    }
}

// 净值序列落盘（拆解用）
const dump = join(tmpdir(), "weekend-equity.json");
writeFileSync(dump, JSON.stringify({ days, equity: eq }));
console.log(`\n净值序列 → ${dump}`);
console.log("—— 研究面输出，不驱动下单（S13 纪律）。");
