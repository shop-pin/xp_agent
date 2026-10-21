// backtest/kline.ts——S13：历史日K数据源（腾讯 ifzq 前复权）+ 磁盘缓存。
//
// 源探测记档（2026-10-21，三源逐一探测 + 当日实况）：
//   ① 腾讯 web.ifzq.gtimg.cn fqkline qfq = **主源**——腾讯系（qt/ifzq）全天候
//     稳定（裁决会话同源使用数月无事故）；qfq 收益比率口径正确，远端保持正值
//   ② 东财 push2his fqt=2（后复权）= 数据最全（dktotal 6410 天、f26 IPO 表同源）
//     但 **IP 级间歇封锁**：2026-10-21 当天上午 Node/curl 双通、午后全线 000
//     （UND_ERR_SOCKET）——2026-10-18 的 WAF 记档本质成立：东财对依赖不可靠，
//     可用性按时段漂移，重试救不了封锁窗。保留 fetchIpoDays（plugins/market-data）
//     供封锁窗开时使用，调用侧已带退化路径
//   ③ 新浪 getKLineData = 未复权，除权跳空污染收益，不用于回测
// 近似④：腾讯 qfqday 无成交额字段——amount ≈ close × volume(手) × 100
// （当日均价 vs 收盘价的个位数百分比误差，对 3e7 量级闸足够）。
// 缓存：<dataRoot>/hist-k/<code>.jsonl（schema 头 + 逐日行）——首跑落盘，之后
// 秒级重跑；--refresh 强制重拉。缓存截止 = 首跑日（staleness 记档在章文档）。

import { existsSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { dataRootPath, readSchemaJsonl } from "../plugins/data-store.js";
import { SCHEMA } from "./schema.js";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64)";

export interface KBar {
    day: string; open: number; close: number; high: number; low: number;
    /** 成交量（手）。 */
    volume: number;
    /** 成交额（元；腾讯 qfqday 无此字段——近似 close×volume×100，见头注近似④）。 */
    amount: number;
}

/** 腾讯 fqkline 响应 → KBar[]（纯函数，fixture 钉格式：
 *  data.<code>.qfqday = [["YYYY-MM-DD",open,close,high,low,volume(手)],…]）。
 *  qfq 缺失时回退 data.<code>.day（非复权键）。 */
export function parseTencentKlines(text: string, code: string): KBar[] {
    let json: { data?: Record<string, { qfqday?: string[][]; day?: string[][] }> };
    try {
        json = JSON.parse(text) as { data?: Record<string, { qfqday?: string[][]; day?: string[][] }> };
    } catch {
        throw new Error("kline 响应非 JSON");
    }
    const node = json.data?.[code];
    const rows = node?.qfqday ?? node?.day ?? [];
    const out: KBar[] = [];
    for (const row of rows) {
        const [day, open, close, high, low, volume] = row;
        const c = Number(close);
        if (!day || !/^\d{4}-\d{2}-\d{2}$/.test(day) || !Number.isFinite(c)) continue;
        const vol = Number(volume);
        out.push({
            day, open: Number(open), close: c, high: Number(high), low: Number(low),
            volume: vol, amount: Math.round(c * vol * 100), // 近似④
        });
    }
    return out;
}

export async function fetchKlines(code: string, limit: number): Promise<KBar[]> {
    const url = "https://web.ifzq.gtimg.cn/appstock/app/fqkline/get"
        + `?param=${code},day,,,${limit},qfq`;
    const res = await fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`kline ${code}: HTTP ${res.status}`);
    return parseTencentKlines(await res.text(), code);
}

/** 读缓存（带回测读侧纪律：坏行跳过、schema 拒读）。 */
export function readKlineCache(code: string, root: string = dataRootPath()): KBar[] | null {
    const path = join(root, "hist-k", `${code}.jsonl`);
    if (!existsSync(path)) return null;
    return readSchemaJsonl<KBar>(path, SCHEMA.HIST_K).rows;
}

function writeKlineCache(code: string, bars: KBar[], root: string): void {
    const path = join(root, "hist-k", `${code}.jsonl`);
    mkdirSync(join(root, "hist-k"), { recursive: true });
    const lines = [JSON.stringify({ v: 1, schema: SCHEMA.HIST_K, code, count: bars.length }),
        ...bars.map((b) => JSON.stringify(b))];
    writeFileSync(path, lines.join("\n") + "\n");
}

/** loadKlines：缓存优先（--refresh 重拉），未中则拉源并落盘。 */
export async function loadKlines(code: string, limit: number, root: string = dataRootPath(), refresh = false): Promise<KBar[]> {
    if (!refresh) {
        const cached = readKlineCache(code, root);
        if (cached && cached.length > 0) return cached;
    }
    const bars = await fetchKlines(code, limit);
    if (bars.length > 0) writeKlineCache(code, bars, root);
    return bars;
}
