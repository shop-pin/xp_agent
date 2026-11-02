// 收盘链补跑（一次性修复脚本，零 LLM）：挂机进程死亡后手动补 daily-k 收口。
// 用法：node closeout-repair.mjs [--day YYYY-MM-DD]
//   盘后拉一轮收盘快照（market start 语义：休市也拉）→ data-store checkClose
//   → 校验落盘文件。digest 编译仍走 digest-run.js（--day 显式指日）。
// 诚实边界：快照 at=拉取时刻（盘后=收盘状态口径），与本日盘中快照同族。
import { existsSync, readFileSync, statSync } from "fs";
import { Context } from "./dist/cordis/context.js";
import { ToolsService } from "./dist/services/tools.js";
import { marketDataPlugin } from "./dist/plugins/market-data.js";
import { dataStorePlugin, dailyKPath, dataRootPath } from "./dist/plugins/data-store.js";
import { cnDay } from "./dist/plugins/paper-broker.js";

const dayArg = (() => {
    const i = process.argv.indexOf("--day");
    return i >= 0 ? process.argv[i + 1] : undefined;
})();

const t0 = Date.now();
const ctx = new Context();
new ToolsService(ctx, "tools");
ctx.plugin(marketDataPlugin, {});

const market = ctx.market;
await market.refresh();
const snapDay = cnDay(market.latest.at);
const targetDay = dayArg ?? snapDay;
if (targetDay !== snapDay) {
    console.error(`快照日 ${snapDay} ≠ 目标日 ${targetDay}（非交易日或跨日）——不写错日文件`);
    process.exit(1);
}
console.log(`[1] 收盘快照：${market.latest.quotes.length} 只，at=${new Date(market.latest.at).toISOString()}，耗时 ${Date.now() - t0}ms`);

ctx.plugin(dataStorePlugin, {});
ctx.dataStore.checkClose();

const path = dailyKPath(dataRootPath(), targetDay);
if (!existsSync(path)) {
    console.error(`[2] 收口失败：${path} 未落盘`);
    process.exit(1);
}
const lines = readFileSync(path, "utf-8").split("\n").filter(Boolean);
const head = JSON.parse(lines[0]);
console.log(`[2] 日K收口落盘：${path}`);
console.log(`    ${JSON.stringify(head)}`);
console.log(`    数据行 ${lines.length - 1}，文件 ${(statSync(path).size / 1024).toFixed(0)}KB`);
console.log(`[3] 下一步：node dist/backtest/digest-run.js --day ${targetDay}`);
process.exit(0);
