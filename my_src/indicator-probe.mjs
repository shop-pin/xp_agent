// 指标值探针（周末验收工具）：任意个股任意日的指标输出值。
// 用法：node indicator-probe.mjs <code> [day] [ID.输出 ...]
//   code 如 sz002242；day 缺省=最新 daily-k 收口日；输出缺省=全部指标产出。
import { loadScreeners } from "./dist/backtest/screener-config.js";
import { FormulaLibrary } from "./dist/backtest/library.js";
import { baseFromBars } from "./dist/backtest/formula.js";
import { loadMarketDaily } from "./dist/backtest/kseries.js";
import { latestKDay } from "./dist/backtest/screener-run.js";

const [code, dayArg, ...outs] = process.argv.slice(2);
if (!code) {
    console.error("用法：node indicator-probe.mjs <code> [day] [ID.输出 ...]");
    process.exit(1);
}
const day = dayArg ?? latestKDay();
const loaded = loadScreeners();
const lib = FormulaLibrary.build(loaded.indicators, []);
const bars = loadMarketDaily().get(code);
if (!bars) { console.error(`${code} 不在市场数据内`); process.exit(1); }
const window = bars.filter((b) => b.day <= day);
if (window.length === 0 || window[window.length - 1].day !== day) {
    console.error(`${code} 在 ${day} 无 bar（最新可得 ${window[window.length - 1]?.day ?? "无"}）`);
    process.exit(1);
}
const produced = lib.runIndicatorValues(baseFromBars(window));
const names = outs.length > 0 ? outs.map((o) => o.toUpperCase()) : [...produced.keys()];
console.log(`${code} @ ${day}（窗口 ${window.length} 根）`);
for (const name of names) {
    const val = produced.get(name);
    if (!val) { console.log(`  ${name}: (未注册——可用：${[...produced.keys()].join(", ")})`); continue; }
    const last = val[val.length - 1];
    const shown = last === null || last === undefined ? "(null)"
        : typeof last === "boolean" ? last : Number(last.toFixed(4));
    console.log(`  ${name}: ${shown}`);
}
