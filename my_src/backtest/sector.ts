// backtest/sector.ts——板块归属（2026-11-04 用户需求：每只命中要知道"今天上涨
// 跟的什么板块"，报告按板块分组）。
//
// 数据源纪律（2026-11-04 用户拍板）：一律 mcp-tdx（eltdx 网关/TDX 协议），不取
// mcp-tdx 之外的源。本模块**只读缓存**：<dataRoot>/screener/sector-<day>.jsonl
// （stocks.sector），缓存的写入方 = TDX 题材面刷新（tdx_stock_topics/
// tdx_topic_stocks，7615 通道）——改造落地前板块分组空着（报告走"未归类"降级，
// 不挡选股）。初版的东财 push2 抓取层已按上述指令整体移除（git 史保留）。
//
// 缓存行格式（写入方契约）：
//   {"type":"board","code":"BK...","name":"半导体","chg":10.64,"kind":"industry"|"concept"}
//   {"type":"stock","code":"sh688418","industry":"通信设备"}
//   {"type":"member","board":"BK...","code":"sh688418"}
// 归属规则：一只票全部已知板块（行业 ∪ 题材成员）中取当日涨幅最高者——
//   "跟的什么板块"的直白口径。

import { existsSync } from "fs";
import { join } from "path";
import { dataRootPath, readSchemaJsonl } from "../plugins/data-store.js";
import { SCHEMA } from "./schema.js";

/** 归属结果：板块名 + 该板块当日涨幅%（百分数，如 15.22）。 */
export interface SectorInfo { board: string; chg: number }

type SectorRow =
    | { type: "stock"; code: string; industry: string }
    | { type: "board"; code: string; name: string; chg: number; kind: "industry" | "concept" }
    | { type: "member"; board: string; code: string };

export function sectorPath(day: string, root?: string): string {
    return join(root ?? dataRootPath(), "screener", `sector-${day}.jsonl`);
}

// ---------- 归属（同步，只读缓存） ----------

interface SectorRaw {
    /** 板块码 → { 名, 涨幅 }；板名 → 涨幅（行业归属给的是名字）。 */
    boardByCode: Map<string, { name: string; chg: number }>;
    boardByName: Map<string, number>;
    industry: Map<string, string>;
    members: Map<string, Set<string>>;
}

function loadSectorRaw(day: string, root?: string): SectorRaw | null {
    const path = sectorPath(day, root);
    if (!existsSync(path)) return null;
    let rows: SectorRow[];
    try {
        rows = readSchemaJsonl<SectorRow>(path, SCHEMA.SECTOR).rows;
    } catch {
        return null; // 坏缓存当缺席（报告走无分组降级）
    }
    const raw: SectorRaw = { boardByCode: new Map(), boardByName: new Map(), industry: new Map(), members: new Map() };
    for (const r of rows) {
        if (r.type === "board") {
            raw.boardByCode.set(r.code, { name: r.name, chg: r.chg });
            raw.boardByName.set(r.name, r.chg);
        } else if (r.type === "stock") raw.industry.set(r.code, r.industry);
        else if (r.type === "member") {
            if (!raw.members.has(r.code)) raw.members.set(r.code, new Set());
            raw.members.get(r.code)!.add(r.board);
        }
    }
    return raw;
}

/** 当日板块归属表：code → { board 板块名, chg 板块当日涨幅% }。
 *  候选 = 行业板块 ∪ 题材成员，取当日涨幅最高者；缓存缺席/坏文件 = 空表
 *  （报告归"未归类"）。 */
export function loadSectorAttribution(day: string, root?: string): Map<string, SectorInfo> {
    const raw = loadSectorRaw(day, root);
    const out = new Map<string, SectorInfo>();
    if (!raw) return out;
    const codes = new Set([...raw.industry.keys(), ...raw.members.keys()]);
    for (const code of codes) {
        const cand = new Map<string, number>();
        const indName = raw.industry.get(code);
        if (indName !== undefined) {
            const chg = raw.boardByName.get(indName);
            if (chg !== undefined) cand.set(indName, chg);
        }
        for (const bCode of raw.members.get(code) ?? []) {
            const b = raw.boardByCode.get(bCode);
            if (b) cand.set(b.name, b.chg);
        }
        if (cand.size === 0) continue;
        let best: { name: string; chg: number } | null = null;
        for (const [name, chg] of cand) {
            if (!best || chg > best.chg || (chg === best.chg && name < best.name)) best = { name, chg };
        }
        if (best) out.set(code, { board: best.name, chg: best.chg });
    }
    return out;
}
