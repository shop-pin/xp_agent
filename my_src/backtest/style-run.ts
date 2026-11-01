// backtest/style-run.ts——风格状态 CLI（研究面，零 LLM）。
//
// 用法：node dist/backtest/style-run.js
// 数据流：新浪今日快照（静态 floatCap，口径①）+ hist-k 缓存（腾讯 qfq，
// 缓存优先——要补新日先跑 `node dist/backtest/run.js --refresh` 或周末协议
// 的缓存刷新）→ 微盘/大盘等权两腿 → buildStyleState 全序列 → 全量重写
// <dataRoot>/style-state.jsonl + stdout 摘要（闸位一眼读）。
// 消费方：digest-run 的"风格状态"注记（只读最新行）；择时层的观察面。

import { readdirSync, writeFileSync } from "fs";
import { join } from "path";
import { parseSinaList, type Quote } from "../plugins/market-data.js";
import { dataRootPath, schemaHeader } from "../plugins/data-store.js";
import { readSchemaJsonl } from "../plugins/data-store.js";
import { SCHEMA } from "./schema.js";
import { buildStyleState, STYLE_WINDOWS, type StyleDayInput } from "./style.js";
import type { KBar } from "./kline.js";

const SLIDE_EM = "https://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/Market_Center.getHQNodeData";

async function fetchSinaList(): Promise<Quote[]> {
    const out: Quote[] = [];
    for (let start = 1; start <= 200; start += 8) {
        const group: number[] = [];
        for (let p = start; p < start + 8; p++) group.push(p);
        const results = await Promise.all(group.map(async (page) => {
            const res = await fetch(`${SLIDE_EM}?page=${page}&num=100&sort=symbol&asc=1&node=hs_a`, {
                headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)", Referer: "https://vip.stock.finance.sina.com.cn/" },
                signal: AbortSignal.timeout(10_000),
            });
            if (!res.ok) throw new Error(`sina page ${page}: HTTP ${res.status}`);
            const rows = JSON.parse(await res.text()) as Record<string, unknown>[];
            return Array.isArray(rows) ? parseSinaList(rows) : [];
        }));
        let done = false;
        for (const rows of results) {
            out.push(...rows);
            if (rows.length < 100) { done = true; break; }
        }
        if (done) break;
    }
    return out;
}

async function main(): Promise<void> {
    const root = dataRootPath();
    const histDir = join(root, "hist-k");
    console.log(`[1/3] 读 hist-k 缓存 ${histDir}`);
    const cache = new Map<string, KBar[]>();
    for (const f of readdirSync(histDir).filter((f) => f.endsWith(".jsonl"))) {
        try {
            const { rows } = readSchemaJsonl<KBar>(join(histDir, f), SCHEMA.HIST_K);
            if (rows.length) cache.set(f.slice(0, -6), rows);
        } catch { /* schema 不符跳过——缓存纪律 */ }
    }
    console.log(`  ${cache.size} 只`);

    console.log("[2/3] 新浪快照（静态 floatCap，口径①）…");
    const quotes = (await fetchSinaList()).filter((q) => q.price > 0 && q.floatCap > 0 && !q.code.startsWith("bj"));
    const sorted = [...quotes].sort((a, b) => a.floatCap - b.floatCap);
    const q1 = new Set(sorted.slice(0, Math.floor(sorted.length * 0.2)).map((q) => q.code));
    const q5 = new Set(sorted.slice(-Math.floor(sorted.length * 0.2)).map((q) => q.code));
    console.log(`  ${quotes.length} 只（沪深，剔除北交所/停牌/零市值）；微盘腿 ${q1.size} / 大盘腿 ${q5.size}`);

    const microR = new Map<string, number[]>();
    const macroR = new Map<string, number[]>();
    for (const [code, bars] of cache) {
        const isMicro = q1.has(code), isMacro = q5.has(code);
        if (!isMicro && !isMacro) continue;
        for (let i = 1; i < bars.length; i++) {
            const r = bars[i]!.close / bars[i - 1]!.close - 1;
            if (!Number.isFinite(r)) continue;
            const m = isMicro ? microR : macroR;
            const arr = m.get(bars[i]!.day);
            if (arr) arr.push(r);
            else m.set(bars[i]!.day, [r]);
        }
    }
    const avg = (a: number[] | undefined) => (a && a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
    const daily: StyleDayInput[] = [...new Set([...microR.keys(), ...macroR.keys()])].sort()
        .map((day) => ({ day, micro: avg(microR.get(day)), macro: avg(macroR.get(day)), coverage: microR.get(day)?.length ?? 0 }));

    console.log("[3/3] 构建状态序列并落盘…");
    const rows = buildStyleState(daily);
    if (rows.length === 0) {
        console.error("无有效日K——检查 hist-k 缓存");
        process.exit(1);
    }
    const outPath = join(root, "style-state.jsonl");
    const text = schemaHeader(SCHEMA.STYLE_STATE, { windows: [...STYLE_WINDOWS], writtenAt: Date.now() }) + "\n"
        + rows.map((r) => JSON.stringify(r)).join("\n") + "\n";
    writeFileSync(outPath, text);
    const last = rows[rows.length - 1]!;
    const gate = (w: number) => (last.ma[String(w)] ? "开" : "关");
    console.log(`  ${rows.length} 个交易日（${rows[0]!.day} → ${last.day}）→ ${outPath}`);
    console.log(`最新状态 ${last.day}：微盘 ${last.micro.toFixed(4)} / 大盘 ${last.macro.toFixed(4)}`
        + ` | 当日 spread ${(last.daySpread * 100).toFixed(2)}% | 近 5 日合计 ${(last.spread5 * 100).toFixed(2)}%`);
    console.log(`闸位（微盘>MAw）：${STYLE_WINDOWS.map((w) => `MA${w} ${gate(w)}`).join(" / ")} | 微盘腿覆盖 ${last.coverage} 只`);
    console.log("—— 研究面观察数据，不驱动下单（S13 纪律）。");
}

void main().catch((e) => {
    console.error(`style-run 失败：${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
});
