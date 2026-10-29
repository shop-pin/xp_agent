// scripts/tdx-duel.ts——M7 双源对拍（真机）：新浪 vs TDX 同码对比 + 全市场
// 家数/耗时对比。收盘后跑最公平（价格冻结，非同刻误差归零）。
// 前置：mcp-tdx venv 网关已起（python -m eltdx.http_server --port 7727）。
// 运行：node dist/scripts/tdx-duel.js
import { sinaSource } from "../plugins/market-data.js";
import { TdxQuoteSource } from "../plugins/market-data-tdx.js";

const CODES = ["sh600000", "sz000001", "sh600036"];
const TOL_PCT = 0.005; // 0.5%
const TOL_ABS = 0.02;

async function main(): Promise<void> {
    const tdx = new TdxQuoteSource();

    console.log("== 明细对拍（3 码） ==");
    const sina = await sinaSource.fetchQuotes(CODES);
    const tdxQ = await tdx.fetchQuotes(CODES);
    let bad = 0;
    for (const code of CODES) {
        const a = sina.find((q) => q.code === code);
        const b = tdxQ.find((q) => q.code === code);
        if (!a || !b) {
            console.log(`${code}: 新浪=${a?.price ?? "缺"} TDX=${b?.price ?? "缺"} ❌缺数据`);
            bad++;
            continue;
        }
        const diff = Math.abs(a.price - b.price);
        const ok = diff <= TOL_ABS || diff / a.price <= TOL_PCT;
        if (!ok) bad++;
        console.log(`${code} ${a.name || b.name}: 新浪=${a.price} TDX=${b.price}`
            + ` Δ=${diff.toFixed(3)} (${((diff / a.price) * 100).toFixed(3)}%) ${ok ? "✓" : "❌"}`);
        if (a.changePercent !== undefined && b.changePercent !== undefined) {
            console.log(`   chgPct: 新浪=${a.changePercent} TDX=${b.changePercent}`
                + ` vol(手): 新浪=${a.volume} TDX=${b.volume}`);
        }
    }

    console.log("\n== 全市场快照（家数/耗时） ==");
    const t0 = Date.now();
    const sSnap = await sinaSource.fetchMarketSnapshot();
    const t1 = Date.now();
    const tSnap = await tdx.fetchMarketSnapshot();
    const t2 = Date.now();
    console.log(`新浪: ${sSnap.length} 只 / ${t1 - t0}ms`);
    console.log(`TDX : ${tSnap.length} 只 / ${t2 - t1}ms`);

    // 收盘价冻结——抽 5 只同码对比收盘口径
    const sample = sSnap.filter((q) => tSnap.some((t) => t.code === q.code)).slice(0, 5);
    let sampleBad = 0;
    for (const s of sample) {
        const t = tSnap.find((q) => q.code === s.code)!;
        const diff = Math.abs(s.price - t.price);
        const ok = diff <= TOL_ABS || diff / s.price <= TOL_PCT;
        if (!ok) sampleBad++;
        console.log(`  ${s.code}: 新浪=${s.price} TDX=${t.price} ${ok ? "✓" : "❌"}`);
    }

    console.log(`\n结论：明细坏 ${bad}/3，抽样坏 ${sampleBad}/${sample.length}`
        + ` —— ${bad === 0 && sampleBad === 0 ? "对拍通过" : "对拍存在分歧，先查口径"}`);
    if (bad > 0 || sampleBad > 0) process.exit(1);
}

void main().catch((e) => {
    console.error(`对拍失败：${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
});
