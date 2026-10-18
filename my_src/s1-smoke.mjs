// S1 真机冒烟（一次性脚本，验收线：全量 >5000 只且 <5s + 异动筛选 + 新浪明细）。
// 运行：node s1-smoke.mjs（my_src 下）
import { sinaSource, screenQuotes } from "./dist/plugins/market-data.js";

const t0 = Date.now();
const quotes = await sinaSource.fetchMarketSnapshot();
const elapsed = Date.now() - t0;
console.log(`[1] 全市场快照：${quotes.length} 只，耗时 ${elapsed}ms（验收：>5000 只且 <5000ms）`);
if (quotes.length <= 5000 || elapsed >= 5000) {
    console.error("FAIL: 全量拉取未达验收线");
    process.exit(1);
}

const movers = screenQuotes(quotes, { changePercentMin: 3, amountMin: 2e8, limit: 10 });
console.log(`\n[2] 涨幅异动 top10（涨>3%、成交额>2亿、排除 ST/bj）：`);
for (const q of movers) console.log(`  ${q.code}  ${q.name}  ${q.price}  +${q.changePercent.toFixed(2)}%  额${(q.amount / 1e8).toFixed(2)}亿  量比${q.volumeRatio || "-"}  换手${q.turnoverRate.toFixed(2)}%`);

const losers = screenQuotes(quotes, { changePercentMax: -3, amountMin: 2e8, order: "asc", limit: 5 });
console.log(`\n[3] 跌幅异动 top5（跌>3%、成交额>2亿）：`);
for (const q of losers) console.log(`  ${q.code}  ${q.name}  ${q.price}  ${q.changePercent.toFixed(2)}%  额${(q.amount / 1e8).toFixed(2)}亿`);

const sh = quotes.filter(q => q.code.startsWith("sh")).length;
const sz = quotes.filter(q => q.code.startsWith("sz")).length;
const bj = quotes.filter(q => q.code.startsWith("bj")).length;
console.log(`\n[4] 市场分布：sh=${sh} sz=${sz} bj=${bj}`);

const detail = await sinaSource.fetchQuotes(["sh600000", "sz300750", "sh688981"]);
console.log(`\n[5] 新浪单票明细：`);
for (const q of detail) console.log(`  ${q.code}  ${q.name}  ${q.price}  ${q.changePercent >= 0 ? "+" : ""}${q.changePercent.toFixed(2)}%  vol${q.volume}手  [${q.quotedAt}]`);
if (detail.length !== 3) {
    console.error("FAIL: 新浪明细应返回 3 只");
    process.exit(1);
}
console.log("\nSMOKE OK");
