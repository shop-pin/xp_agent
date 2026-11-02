// hist-k 缓存全量刷新（维护脚本，零 LLM）：腾讯前复权源拉最新 N 根。
// 用法：node hist-refresh.mjs [--limit 320] [--workers 4]
// 背景（2026-11-02）：缓存截止 10-21，中间交易日靠 daily-k 补只有 4 天——
// K 序列有洞，窗口函数（HHV(V,6) 类）跨洞错位，选股结果与通达信对不上。
import { readdirSync, readFileSync } from "fs";
import { join } from "path";
import { dataRootPath } from "./dist/plugins/data-store.js";
import { loadKlines } from "./dist/backtest/kline.js";

const arg = (name, def) => {
    const i = process.argv.indexOf(`--${name}`);
    return i >= 0 && process.argv[i + 1] !== undefined ? Number(process.argv[i + 1]) : def;
};
const limit = arg("limit", 320);
const workers = arg("workers", 4);

const root = dataRootPath();
// 范围：hist-k 已有文件 ∪ daily-k 最新收口里的 sh/sz 票（后者覆盖 10-21 后
// 上市的新股——它们没有 hist-k 文件，只刷已有文件会永远漏掉）
const kDir = join(root, "daily-k");
const kDays = readdirSync(kDir).filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).sort();
const latest = join(kDir, kDays[kDays.length - 1]);
const dailyCodes = readFileSync(latest, "utf-8").split("\n").filter(Boolean)
    .map((line) => { try { return JSON.parse(line).code; } catch { return undefined; } })
    .filter((c) => !!c && /^(sh|sz)/.test(c));
const histCodes = readdirSync(join(root, "hist-k"))
    .filter((f) => /^(sh|sz)/.test(f) && f.endsWith(".jsonl"))
    .map((f) => f.slice(0, -6));
const codes = [...new Set([...histCodes, ...dailyCodes])].sort();
const fresh = codes.filter((c) => !histCodes.includes(c)).length;
console.log(`刷新 ${codes.length} 只沪深票 × ${limit} 根（${workers} 路并发；其中新增 ${fresh} 只）…`);

let ok = 0, fail = 0, empty = 0;
const failed = [];
const queue = [...codes];
const t0 = Date.now();

async function worker(id) {
    for (;;) {
        const code = queue.shift();
        if (code === undefined) return;
        try {
            const bars = await loadKlines(code, limit, root, true);
            if (bars.length === 0) { empty++; failed.push(code); }
            else ok++;
        } catch (e) {
            fail++;
            failed.push(code);
        }
    }
}

await Promise.all(Array.from({ length: workers }, (_, i) => worker(i)));
console.log(`完成：ok ${ok} / empty ${empty} / fail ${fail}，耗时 ${((Date.now() - t0) / 1000).toFixed(0)}s`);
if (failed.length > 0 && failed.length <= 30) console.log(`失败清单：${failed.join(", ")}`);
else if (failed.length > 30) console.log(`失败 ${failed.length} 只（前 30）：${failed.slice(0, 30).join(", ")}`);
