// FLZT 边缘票诊断（零 LLM）：选股公式五条腿拆开逐票判定，
// 列出"整体未命中但只差一条腿"的票——通达信选了而我们漏的候选就在里面。
// 用法：node flzt-diag.mjs [--day YYYY-MM-DD]
import { readdirSync, readFileSync } from "fs";
import { join } from "path";
import { loadScreeners } from "./dist/backtest/screener-config.js";
import { FormulaLibrary } from "./dist/backtest/library.js";
import { loadFormula, runFormula, baseFromBars } from "./dist/backtest/formula.js";
import { loadMarketDaily } from "./dist/backtest/kseries.js";
import { dataRootPath, readSchemaJsonl, SCHEMA_DAILY_K } from "./dist/plugins/data-store.js";
import { loadStrategy } from "./dist/plugins/strategy.js";

const argDay = (() => {
    const i = process.argv.indexOf("--day");
    return i >= 0 ? process.argv[i + 1] : undefined;
})();

const root = dataRootPath();
const kDir = join(root, "daily-k");
const kDays = readdirSync(kDir).filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).map((f) => f.slice(0, 10)).sort();
const day = argDay ?? kDays[kDays.length - 1];

const user = readFileSync(join(process.env.MINI_FORMULAS_DIR
    ?? join(process.env.USERPROFILE ?? process.env.HOME, ".mini-claude", "stocks", "formulas"),
    "screeners", "FLZT_xuanguqi.txt"), "utf-8");
// 诊断版：XG 行前插各腿输出（公式体一字不改，只是多几行观察口）
const diag = user.replace("XG:X1", "D1:X1; D3:X3; D4:X4; D5:X5; D6:X6; XS1B:XS1; XS2B:XS2; XG:X1");

const loaded = loadScreeners();
const strategy = loadStrategy();
const universe = { ...loaded.universe, ...(strategy.screener.universe ?? {}), ...loaded.universeExplicit };
const names = new Map();
for (const r of readSchemaJsonl(join(kDir, `${day}.jsonl`), SCHEMA_DAILY_K).rows) names.set(r.code, r.name);

const lib = FormulaLibrary.build(loaded.indicators,
    [{ id: "diag", name: "diag", enabled: true, params: {}, formula: diag }]);
const compiled = lib.screeners[0].compiled; // 经真实链编译——MACD.DIF 跨引用面正确

const market = loadMarketDaily(root);
const near = [];
const missCount = new Map();
let universeCount = 0, hit = 0;
for (const [code, bars] of market) {
    const trimmed = bars.filter((b) => b.day <= day);
    const name = names.get(code) ?? code;
    if (universe.excludeBJ && code.startsWith("bj")) continue;
    if (universe.excludeST && (/ST/i.test(name) || name.includes("退"))) continue;
    if (trimmed.length === 0 || trimmed[trimmed.length - 1].day !== day) continue;
    const last = trimmed[trimmed.length - 1];
    if (!(last.close > 0)) continue;
    if (last.amount < universe.amountMin) continue;
    universeCount++;
    const win = trimmed.slice(-320);
    const base = baseFromBars(win);
    const produced = lib.runIndicatorValues(base); // 与 runStock 同缝：指标产出注入（MACD.DIF 跨引用真值）
    const out = runFormula(compiled, base, produced);
    const legVal = (k) => {
        const v = out.values.get(k);
        return v && v[v.length - 1] === true;
    };
    const xg = out.xg ? out.xg[out.xg.length - 1] === true : false;
    if (xg) { hit++; continue; }
    const legs = ["D1", "D3", "D4", "D5", "D6"];
    const missing = legs.filter((k) => !legVal(k));
    for (const m of missing) missCount.set(m, (missCount.get(m) ?? 0) + 1);
    if (missing.length === 1) {
        // 数值腿给“距离”（离过线差多少）；信号腿 D1 给半腿状态
        const detail = missing[0] === "D3" ? `收 ${last.close.toFixed(2)}（界 3~50）`
            : missing[0] === "D4" ? `量 ${last.volume} vs 6日峰 ${Math.max(...win.slice(-6).map((b) => b.volume))}`
            : missing[0] === "D5" ? `换手 ${(last.turnover ?? 0).toFixed(2)}%（界 3%）`
            : missing[0] === "D6" ? `额 ${(last.amount / 1e8).toFixed(2)} 亿（界 1 亿）`
            : `XS1=${legVal("XS1B") ? "真" : "假"} XS2=${legVal("XS2B") ? "真" : "假"}`;
        near.push({ code, name, missing: missing[0], detail, chg: last.close / (last.close - (last.close * 0 + (last.close - (win[win.length - 2]?.close ?? last.close)))) - 1 });
        void last;
    }
}
console.log(`目标日 ${day}：宇宙 ${universeCount}，命中 ${hit}（差一条腿 ${near.length} 只）`);
console.log(`缺腿分布：${[...missCount.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k}×${n}`).join("  ")}`);
console.log(`\n—— 数值腿边缘票（距离最近优先，可能被通达信数据差翻过线）——`);
const numNear = near.filter((n) => n.missing !== "D1");
for (const n of numNear) console.log(`  ${n.code} ${n.name} —— 缺 ${n.missing}：${n.detail}`);
console.log(`\n—— 信号腿 D1 单缺 ${near.length - numNear.length} 只（信号未触发，前 15 只）——`);
for (const n of near.filter((n) => n.missing === "D1").slice(0, 15)) console.log(`  ${n.code} ${n.name} —— ${n.detail}`);
