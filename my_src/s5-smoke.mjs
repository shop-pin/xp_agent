// S5 真机冒烟（一次性脚本）：真接口 + 信号引擎全链——一轮真实快照上评估
// 默认规则（休市=收盘口径：limit-approach 应有真命中——周五 20cm 领涨榜
// 距板极近；窗口类指标需多轮观测，冒烟只验管线与单轮规则）。
// 运行：node s5-smoke.mjs（my_src 下）
import { Context } from "./dist/cordis/context.js";
import { ToolsService } from "./dist/services/tools.js";
import { marketDataPlugin } from "./dist/plugins/market-data.js";
import { signalEnginePlugin } from "./dist/plugins/signal-engine.js";

const t0 = Date.now();
const ctx = new Context();
new ToolsService(ctx, "tools");
ctx.plugin(marketDataPlugin, {});
ctx.plugin(signalEnginePlugin, {});
const market = ctx.market;
await market.refresh();
console.log(`[1] 真实快照：${market.latest.quotes.length} 只，耗时 ${Date.now() - t0}ms`);

const eng = ctx.signals;
console.log(`[2] 单轮评估：${eng.evaluateCount} 轮，信号 ${eng.recent.length} 条`);
const byRule = {};
for (const s of eng.recent) byRule[s.rule] = (byRule[s.rule] || 0) + 1;
console.log(`    按规则分布：${JSON.stringify(byRule)}`);

const out = await ctx.require("tools").get("get_signals").execute({ limit: 8 }, {});
console.log(`\n[3] get_signals top8：\n${out}`);

const la = eng.recent.filter((s) => s.rule === "limit-approach");
console.log(`\n[4] limit-approach 真命中：${la.length} 条（收盘口径下分板判定 × 全市场扫描的验证面）`);
process.exit(0);
