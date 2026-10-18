// S3 真机冒烟（一次性脚本）：真接口走完整装配——Context + ToolsService +
// news-feed 插件（真实新浪 7x24 源）→ latest_news 工具 execute。
// 运行：node s3-smoke.mjs（my_src 下）
import { Context } from "./dist/cordis/context.js";
import { ToolsService } from "./dist/services/tools.js";
import { newsFeedPlugin, filterNews, sinaZhiboSource, parseSinaZhibo } from "./dist/plugins/news-feed.js";

const t0 = Date.now();
const page = await sinaZhiboSource.fetchLatest();
console.log(`[1] 实时拉取：${page.length} 条，耗时 ${Date.now() - t0}ms，最新一条：`);
console.log(`    [${new Date(page[0].time).toLocaleTimeString("zh-CN")}] ${page[0].text.slice(0, 60)}…`);

const ctx = new Context();
new ToolsService(ctx, "tools");
ctx.plugin(newsFeedPlugin, {});
await new Promise((r) => setTimeout(r, 1500)); // 等 start() 首轮
const out = await ctx.require("tools").get("latest_news").execute({ limit: 5 }, {});
console.log(`\n[2] latest_news（全流 top5）：\n${out.split("\n").slice(0, 7).join("\n")}`);

const matched = filterNews(page, { query: "美" });
console.log(`\n[3] 关键词过滤（"美"）：命中 ${matched.length} 条`);
process.exit(0); // timer unref 也会退，这里显式收口
