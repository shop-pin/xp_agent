// 周末历史分析脚本 2（挂账 #9(c)，研究面）：
//   D1 两段回撤的逐周分解（策略/微盘/大盘周收益 + 微盘上涨家数占比 + 调仓笔数）
//   D2 择时闸回测：A 风格相对强弱（spread20 / MA200）× B 自回撤闸（分级+滞回）
// 近似：闸以"缩放日收益"实现（同持仓按比例缩放，%口径精确；未计减仓/回补摩擦）。
// 运行：cd my_src && node weekend-decompose.mjs
import { readdirSync } from "fs";
import { join } from "path";
import { dataRootPath, readSchemaJsonl } from "./dist/plugins/data-store.js";
import { parseSinaList } from "./dist/plugins/market-data.js";
import { replayRotation } from "./dist/backtest/replay.js";
import { computeMetrics } from "./dist/backtest/metrics.js";

const pct = (x) => `${(x * 100).toFixed(1)}%`;
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN);

const root = dataRootPath();
const histDir = join(root, "hist-k");
const cache = new Map();
for (const f of readdirSync(histDir).filter((f) => f.endsWith(".jsonl"))) {
    try {
        const { rows } = readSchemaJsonl(join(histDir, f), "backtest.hist-k");
        if (rows.length) cache.set(f.slice(0, -6), rows);
    } catch { /* 跳过 */ }
}
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
console.log("装载…");
const quotes = (await fetchSinaList()).filter((q) => q.price > 0 && q.floatCap > 0 && !q.code.startsWith("bj"));
const stocks = [];
for (const q of quotes) {
    const bars = cache.get(q.code);
    if (!bars || bars.length < 60) continue;
    stocks.push({ code: q.code, name: q.name, floatCap: q.floatCap, pe: q.pe ?? 0, pb: q.pb, bars });
}
const rep = replayRotation(stocks, { topN: 20, cash: 1_000_000, slippage: 0.002 });
const { days, equity } = rep;

// 微盘/大盘日收益（静态五分位，口径①）
const sorted = [...stocks].sort((a, b) => a.floatCap - b.floatCap);
const q1 = new Set(sorted.slice(0, Math.floor(sorted.length * 0.2)).map((s) => s.code));
const q5 = new Set(sorted.slice(-Math.floor(sorted.length * 0.2)).map((s) => s.code));
const microR = new Map(), macroR = new Map(); // day → 当日等权均收益
const dayMicro = new Map(); // day → 上涨家数占比
for (const s of stocks) {
    const inQ1 = q1.has(s.code), inQ5 = q5.has(s.code);
    if (!inQ1 && !inQ5) continue;
    for (let i = 1; i < s.bars.length; i++) {
        const r = s.bars[i].close / s.bars[i - 1].close - 1;
        if (!Number.isFinite(r)) continue;
        const d = s.bars[i].day;
        if (!microR.has(d)) { microR.set(d, []); macroR.set(d, []); dayMicro.set(d, [0, 0]); }
        (inQ1 ? microR : macroR).get(d).push(r);
        const bm = dayMicro.get(d);
        bm[0] += r > 0 ? 1 : 0; bm[1]++;
    }
}
const mAvg = (m, d) => { const a = m.get(d); return a && a.length ? mean(a) : 0; };

// ---------- D1 逐周分解 ----------
function weeklyWalk(from, to) {
    console.log(`\n===== 逐周分解 ${from} → ${to} =====`);
    console.log("周截止    | 策略    | 微盘    | 大盘    | 微盘上涨占比 | 覆盖 | 调仓");
    const tradesByWeek = new Map();
    for (const t of rep.trades) {
        const w = weekEnd(t.day);
        tradesByWeek.set(w, (tradesByWeek.get(w) ?? 0) + 1);
    }
    let week = null, acc = null;
    const flush = () => {
        if (!acc || acc.n === 0) return;
        const stratR = equity[acc.eqEndI] / equity[acc.eqStartI] - 1;
        const w = week;
        console.log(`${w} | ${pct(stratR).padStart(7)} | ${pct(acc.micro).padStart(7)} | ${pct(acc.macro).padStart(7)} | ${((acc.breadth / acc.n) * 100).toFixed(0).padStart(8)}% | ${String(Math.round(acc.cov / acc.n)).padStart(4)} | ${(tradesByWeek.get(w) ?? 0)}`);
    };
    for (let i = 0; i < days.length; i++) {
        const d = days[i];
        if (d < from || d > to) continue;
        const w = weekEnd(d);
        if (w !== week) { flush(); week = w; acc = { n: 0, micro: 0, macro: 0, breadth: 0, cov: 0, eqStartI: Math.max(i - 1, 0), eqEndI: i }; }
        acc.micro += mAvg(microR, d); acc.macro += mAvg(macroR, d);
        const bm = dayMicro.get(d);
        acc.breadth += bm[1] ? bm[0] / bm[1] : 0;
        acc.cov += bm[1];
        acc.n++; acc.eqEndI = i;
    }
    flush();
}
function weekEnd(d) {
    const t = new Date(d + "T00:00:00Z");
    const dow = t.getUTCDay() || 7; // 周一=1…周五=5
    t.setUTCDate(t.getUTCDate() + (7 - dow));
    return t.toISOString().slice(0, 10);
}
weeklyWalk("2023-04-01", "2024-03-31"); // 段①：峰→谷→V 反转
weeklyWalk("2026-01-01", "2026-08-31"); // 段②：峰→谷→反弹

// ---------- D2 择时闸回测 ----------
console.log("\n===== D2 择时闸回测（t 收盘定仓、t+1 生效；缩放日收益近似） =====");
// 策略日收益序列
const stratR = days.map((_, i) => (i === 0 ? 0 : equity[i] / equity[i - 1] - 1));
const mIdx = [], MIdx = []; // 微盘/大盘指数累计
let mi = 1, Ma = 1;
const idxDay = [];
for (const d of days) {
    mi *= 1 + mAvg(microR, d); Ma *= 1 + mAvg(macroR, d);
    idxDay.push(d); mIdx.push(mi); MIdx.push(Ma);
}
function applyGate(name, exposureAt) {
    // exposureAt(i) = 第 i 天应使用的仓位（用截至 i-1 日信息）
    const eq2 = [];
    let v = 1_000_000;
    for (let i = 0; i < days.length; i++) {
        const expo = i === 0 ? 1 : exposureAt(i);
        v *= 1 + stratR[i] * expo;
        eq2.push(v);
    }
    const m = computeMetrics(days, eq2);
    const expoDays = days.filter((_, i) => i > 0 && exposureAt(i) > 0.99).length;
    console.log(`  ${name.padEnd(28)} 总收益 ${pct(m.totalReturn).padStart(7)} | 最大回撤 ${pct(m.maxDrawdown).padStart(7)} | 满仓日占比 ${pct(expoDays / (days.length - 1))} | 按年 ${m.yearly.map((y) => `${y.year} ${pct(y.ret)}`).join(" ")}`);
    return { days, equity: eq2 };
}
console.log(`  ${"基线（无闸）".padEnd(28)} 总收益 ${pct(computeMetrics(days, equity).totalReturn).padStart(7)} | 最大回撤 ${pct(computeMetrics(days, equity).maxDrawdown).padStart(7)} | 满仓日占比 100.0%`);

// A1：微盘-大盘 20 日相对强弱 > 0 → 满仓
const spread20 = (i) => { let s = 0; for (let j = Math.max(0, i - 20); j < i; j++) s += mAvg(microR, days[j]) - mAvg(macroR, days[j]); return s; };
applyGate("A1 spread20>0（空仓）", (i) => (spread20(i) > 0 ? 1 : 0));
applyGate("A1 spread20>0（半仓）", (i) => (spread20(i) > 0 ? 1 : 0.5));
// A2：微盘指数 > MA200
const ma200 = (i) => { const from = Math.max(0, i - 200); let s = 0; for (let j = from; j < i; j++) s += mIdx[j]; return s / (i - from || 1); };
applyGate("A2 微盘>MA200（空仓）", (i) => (mIdx[i - 1] > ma200(i - 1) ? 1 : 0));
applyGate("A2 微盘>MA200（半仓）", (i) => (mIdx[i - 1] > ma200(i - 1) ? 1 : 0.5));
// B：自回撤闸（FULL/HALF/FLAT 状态机，滞回 −5% 恢复；FLAT 10 日后探针回半仓——
// 否则净值冻结、回撤永不修复，闸死锁在空仓）
function gateB() {
    let state = "FULL";
    let flatDays = 0;
    const states = [];
    for (let i = 0; i < days.length; i++) {
        states.push(state === "FULL" ? 1 : state === "HALF" ? 0.5 : 0);
        if (i === 0) continue;
        const prev = states[i - 1];
        const v = 1 + stratR[i] * prev;
        eqB *= v;
        peakB = Math.max(peakB, eqB);
        const dd = eqB / peakB - 1;
        if (state === "FLAT") {
            if (++flatDays >= 10) { state = "HALF"; flatDays = 0; }
        } else {
            flatDays = 0;
            if (dd <= -0.20) state = "FLAT";
            else if (dd <= -0.10) state = "HALF";
            else if (dd >= -0.05) state = "FULL";
        }
    }
    return states;
}
let eqB = 1_000_000, peakB = 1_000_000;
const bStates = gateB();
applyGate("B 自回撤闸（10/20 分级）", (i) => bStates[i]);
console.log("\n—— 闸为缩放近似（未计减仓/回补交易摩擦与最小整手约束）；风格指数用今日市值五分位（口径①）。研究面，不驱动下单。");
