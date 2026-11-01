// SC1 对账探针（研究面，一次性跑；产物 = fixtures/sc1/）：
//   ① 重采样正确性：TDX 日线（qfq）喂 resampleWeekly/Monthly vs TDX 原生周/月
//     ——同源同复权，差异只归因于重采样器（验收断言主体，回放测试复跑）
//   ② 语料一致性：hist-k 缓存日线重采样 vs Tencent 原生周线（同 qfq 族，
//     缓存截止日 2026-10-21 之后的周不在对比窗）
// 运行：cd my_src && node sc1-corpus-probe.mjs
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { readKlineCache, parseTencentKlines } from "./dist/backtest/kline.js";
import { resampleWeekly, resampleMonthly } from "./dist/backtest/kseries.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIX = join(HERE, "fixtures", "sc1");
const CODES = ["sh600000", "sz000001", "sz300750"];
const CUTOFF = "2026-10-21"; // hist-k 缓存截止

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64)";
async function fetchTencent(code, period, count) {
    const url = `https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${code},${period},,,${count},qfq`;
    const res = await fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`tencent ${code} ${period}: HTTP ${res.status}`);
    const json = JSON.parse(await res.text());
    const node = json.data?.[code] ?? {};
    const rows = node[`qfq${period}`] ?? node[period] ?? [];
    return rows.map((r) => {
        const [day, , close, high, low, volume] = r;
        return { day, open: Number(r[1]), close: Number(close), high: Number(high), low: Number(low), volume: Number(volume), amount: 0 };
    });
}

function diffReport(ours, native, tol) {
    const byDay = new Map(ours.map((b) => [b.day, b]));
    let checked = 0, maxDiff = 0, missing = 0;
    const bad = [];
    for (const n of native) {
        const o = byDay.get(n.day);
        if (!o) { missing++; continue; }
        checked++;
        for (const k of ["open", "high", "low", "close"]) {
            const d = Math.abs(o[k] - n[k]);
            if (d > maxDiff) maxDiff = d;
            if (d > tol) bad.push(`${n.day} ${k}: ours ${o[k]} vs native ${n[k]}`);
        }
    }
    return { checked, missing, maxDiff, bad };
}

mkdirSync(FIX, { recursive: true });
const report = {};
let worst = 0;
for (const code of CODES) {
    const tdxPath = join(FIX, `tdx-${code}.json`);
    if (!existsSync(tdxPath)) throw new Error(`缺 TDX fixture ${tdxPath}——先跑 sc1-tdx-probe.py`);
    const tdx = JSON.parse(readFileSync(tdxPath, "utf-8"));

    // ① 重采样正确性（TDX 日线 → 我们的重采样器 vs TDX 原生周/月）
    // 头部残根剔除：dayFront 窗口起点（第 500 根回溯处）所在周/月为半根，
    // 聚合窗口不完整——两侧数据集不同源完整度，跳过该根（窗口边界效应，
    // 不是重采样错误；语料侧 ② 同理由 cutoff 过滤天然规避）。
    const wkSelf = diffReport(resampleWeekly(tdx.dayFront).slice(1), tdx.weekFront, 1e-6);
    const moSelf = diffReport(resampleMonthly(tdx.dayFront).slice(1), tdx.monthFront, 1e-6);
    // ② 语料一致性（hist-k → 重采样 vs Tencent 原生周）
    const cache = readKlineCache(code) ?? [];
    const ours = resampleWeekly(cache.filter((b) => b.day <= CUTOFF)).filter((b) => b.day <= CUTOFF);
    const tc = (await fetchTencent(code, "week", 60)).filter((b) => b.day <= CUTOFF);
    const wkCorpus = diffReport(ours, tc, 0.011);
    const tcMonth = (await fetchTencent(code, "month", 24)).filter((b) => b.day <= CUTOFF);
    const moCorpus = diffReport(resampleMonthly(cache.filter((b) => b.day <= CUTOFF)).filter((b) => b.day <= CUTOFF), tcMonth, 0.011);

    report[code] = { wkSelf, moSelf, wkCorpus, moCorpus, corpusBars: cache.length, cutoff: CUTOFF };
    worst = Math.max(worst, wkSelf.maxDiff, moSelf.maxDiff);
    writeFileSync(join(FIX, `tencent-${code}.json`), JSON.stringify({ code, cutoff: CUTOFF, week: tc, month: tcMonth }));
    console.log(`${code}: 重采样自检 周 maxΔ=${wkSelf.maxDiff.toExponential(2)} (${wkSelf.checked} 根) 月 maxΔ=${moSelf.maxDiff.toExponential(2)} (${moSelf.checked} 根)`
        + ` | 语料 周 maxΔ=${wkCorpus.maxDiff.toFixed(4)} (${wkCorpus.checked} 根, 缺 ${wkCorpus.missing}) 月 maxΔ=${moCorpus.maxDiff.toFixed(4)} (${moCorpus.checked} 根)`);
    if (wkSelf.bad.length || moSelf.bad.length) console.log(`  自检超差: ${[...wkSelf.bad, ...moSelf.bad].slice(0, 5).join("; ")}`);
    if (wkCorpus.bad.length || moCorpus.bad.length) console.log(`  语料超差: ${[...wkCorpus.bad, ...moCorpus.bad].slice(0, 5).join("; ")}`);
}
writeFileSync(join(FIX, "probe-report.json"), JSON.stringify(report, null, 2));
console.log(`\n探针完成——自检最差 maxΔ=${worst.toExponential(2)}；fixture → ${FIX}`);
console.log("预期：自检（①）应为机器精度级；语料（②）≤0.01（同源 qfq 族）。超差先查口径再谈实现。");
