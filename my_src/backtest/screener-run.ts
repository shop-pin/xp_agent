// backtest/screener-run.ts——SC4：选股引擎 + CLI（研究面，零 LLM）。
//
// 用法：node dist/backtest/screener-run.js [--day YYYY-MM-DD] [--formula id]
// 数据流：loadScreeners（内置+用户覆盖，按条拒装）→ FormulaLibrary →
// loadMarketDaily（hist-k+daily-k 合并）→ 宇宙闸（红线剔+流动性）→
// 逐票求值（回看 lookback 根）→ 命中清单 → <dataRoot>/screener/<day>.{jsonl,md}
// 语义：目标日无 bar（停牌）= 不参跑；"选出" = 该票命中该公式（XG 当日为真）。
// 研究面纪律：结果只进报告文件，不驱动下单（S13 同款）。

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { dataRootPath, schemaHeader, SCHEMA_DAILY_K, readSchemaJsonl, type DailyKRow } from "../plugins/data-store.js";
import { parseWatchlist, watchlistPath } from "../plugins/market-data.js";
import { SCHEMA } from "./schema.js";
import { loadMarketDaily } from "./kseries.js";
import { baseFromBars } from "./formula.js";
import { FormulaLibrary } from "./library.js";
import { loadScreeners, screenerConfigPath, type ScreenerUniverse } from "./screener-config.js";
import { loadSectorAttribution, type SectorInfo } from "./sector.js";
import { loadStrategy } from "../plugins/strategy.js";
import type { KBar } from "./kline.js";

/** 股本表（TDX finance_batch）：code → 流通股本（手）。文件缺席 = 空表
 *  （CAPITAL 走换手率反推兜底）。 */
function loadSharesLots(root: string): Map<string, number> {
    const out = new Map<string, number>();
    const path = join(root, "shares.jsonl");
    if (!existsSync(path)) return out;
    try {
        const rows = readSchemaJsonl<{ code: string; floatShares: number }>(path, SCHEMA.SHARES).rows;
        for (const r of rows) {
            if (r.floatShares > 0) out.set(r.code, r.floatShares / 100); // 股 → 手
        }
    } catch {
        // 坏表当缺席——反推兜底照常
    }
    return out;
}

export interface ScreenerRunOptions {
    day?: string;
    formulaId?: string;
    root?: string;
    configPath?: string;
    /** 回看根数（指标窗口深度；缺省 320 ≥ MA250+缓冲）。 */
    lookback?: number;
    /** 板块归属表注入（测试密封）；缺省读当日 sector 缓存（缺席=不分组）。 */
    sector?: Map<string, SectorInfo>;
}

export interface ScreenerHit {
    code: string; name: string; close: number; formulas: string[];
    /** 板块归属（2026-11-04 用户需求）：今天上涨跟的板块 + 板块当日涨幅%。 */
    sector?: string;
    sectorChg?: number;
}

export interface ScreenerRunResult {
    day: string;
    universe: number;
    hits: ScreenerHit[];
    perFormula: Array<{ id: string; name: string; count: number }>;
    rejected: Array<{ id: string; error: string }>;
    disabled: string[];
    jsonlPath: string;
    mdPath: string;
    /** 数据防线告警（换手率全零等）——非空 = 命中清单不可信。 */
    warnings: string[];
    elapsedMs: number;
}

/** 宇宙闸：红线剔（ST/退/北交所/创科可选）+ 目标日有 bar + 流动性下限。 */
function universeGate(
    bars: KBar[], code: string, name: string, day: string,
    u: { excludeST: boolean; excludeBJ: boolean; excludeCK: boolean; amountMin: number },
): KBar[] | null {
    if (u.excludeBJ && code.startsWith("bj")) return null;
    if (u.excludeCK && (code.startsWith("sz30") || code.startsWith("sh68"))) return null;
    if (u.excludeST && (/ST/i.test(name) || name.includes("退"))) return null;
    if (bars.length === 0 || bars[bars.length - 1]!.day !== day) return null; // 目标日停牌/无数据
    const last = bars[bars.length - 1]!;
    if (!(last.close > 0)) return null;
    if (last.amount < u.amountMin) return null;
    return bars;
}

const fmtChg = (chg: number): string => `${chg >= 0 ? "+" : ""}${chg.toFixed(2)}%`;

/** 命中清单 md 渲染（2026-11-04 板块分组需求）：同一板块放一起，板块内个股
 *  多的组在上、少的在下；组序并列看板块当日涨幅；未归类永远垫底。组内保持
 *  命中原序。每行自带"跟 <板块>"标签——行被单独摘出去时归属信息不丢。 */
export function groupedHits(rows: ScreenerHit[]): string[] {
    if (rows.length === 0) return ["- 无命中"];
    const groups = new Map<string, ScreenerHit[]>();
    for (const h of rows) {
        const key = h.sector ?? "未归类";
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key)!.push(h);
    }
    const chgOf = (name: string): number => {
        if (name === "未归类") return Number.NEGATIVE_INFINITY;
        return groups.get(name)!.find((h) => h.sectorChg !== undefined)?.sectorChg ?? 0;
    };
    const keys = [...groups.keys()].sort((a, b) => {
        // 未归类永远垫底（缺数据组不掺排序——它是"没归出来"不是一支板块）
        if (a === "未归类") return 1;
        if (b === "未归类") return -1;
        const na = groups.get(a)!.length, nb = groups.get(b)!.length;
        if (na !== nb) return nb - na;
        const ca = chgOf(a), cb = chgOf(b);
        if (ca !== cb) return cb - ca;
        return a < b ? -1 : a > b ? 1 : 0;
    });
    const out: string[] = [];
    for (const k of keys) {
        const members = groups.get(k)!;
        out.push(k === "未归类"
            ? `### 未归类（${members.length}）`
            : `### ${k} ${fmtChg(chgOf(k))}（${members.length}）`);
        for (const h of members) {
            out.push(h.sector !== undefined
                ? `- ${h.code} ${h.name} 收 ${h.close.toFixed(2)}（跟 ${h.sector} ${fmtChg(h.sectorChg ?? 0)}）`
                : `- ${h.code} ${h.name} 收 ${h.close.toFixed(2)}`);
        }
        out.push("");
    }
    return out;
}

/** daily-k 收口日清单（升序）。 */
function listKDays(root: string): string[] {
    const kDir = join(root, "daily-k");
    if (!existsSync(kDir)) throw new Error(`无 daily-k 目录（${kDir}）——先跑盯盘会话收口`);
    const kDays = readdirSync(kDir).filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).map((f) => f.slice(0, 10)).sort();
    if (kDays.length === 0) throw new Error("daily-k 目录为空——还没有收口数据");
    return kDays;
}

/** 最新 daily-k 收口日（CLI 与引擎共用的缺省日口径，与 digest 一致）。 */
export function latestKDay(root: string): string {
    const kDays = listKDays(root);
    return kDays[kDays.length - 1]!;
}

export function runScreener(opts: ScreenerRunOptions = {}): ScreenerRunResult {
    const t0 = Date.now();
    const root = opts.root ?? dataRootPath();
    const lookback = opts.lookback ?? 320;

    const loaded = loadScreeners(opts.configPath ?? screenerConfigPath());
    let screeners = loaded.screeners;
    if (opts.formulaId !== undefined) {
        screeners = screeners.filter((s) => s.id === opts.formulaId);
        if (screeners.length === 0) {
            const known = loaded.screeners.map((s) => s.id).join(", ");
            throw new Error(`公式 ${opts.formulaId} 不在库内（可用：${known || "无"}）`);
        }
    }
    const disabled = loaded.screeners.filter((s) => !s.enabled).map((s) => s.id);
    const lib = FormulaLibrary.build(loaded.indicators, screeners);

    // 目标日 = 显式指定或最新 daily-k 收口日（缺省口径与 digest 一致）
    const kDays = listKDays(root);
    const day = opts.day ?? kDays[kDays.length - 1]!;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error(`--day 格式应为 YYYY-MM-DD：${day}`);
    if (opts.day !== undefined && !kDays.includes(day)) {
        throw new Error(`指定日 ${day} 无 daily-k 收口——不静默改跑旧日（补数据后重跑，或去掉 --day）`);
    }
    // 名称表：优先目标日收口文件（最新命名），退化逐个回看
    const names = new Map<string, string>();
    for (let i = kDays.length - 1; i >= 0; i--) {
        const rows = readSchemaJsonl<DailyKRow>(join(root, "daily-k", `${kDays[i]}.jsonl`), SCHEMA_DAILY_K).rows;
        for (const r of rows) if (!names.has(r.code)) names.set(r.code, r.name);
        if (names.size > 4000) break; // 覆盖足够（全市场量级）
    }

    const market = loadMarketDaily(root);
    // 票池分层（2026-11-02）：缺省 ← strategy.screener.universe（用户常设）←
    // configPath json 层显式值（本次调用显式配置最优先）
    const strategy = loadStrategy();
    const universe = {
        ...loaded.universe, ...(strategy.screener.universe ?? {}), ...loaded.universeExplicit,
    } as Required<ScreenerUniverse>;
    let universeCount = 0;
    const hits: ScreenerHit[] = [];
    const perFormula = new Map<string, number>();
    let zeroTo = 0;
    const sector = opts.sector ?? loadSectorAttribution(day, root);
    const shares = loadSharesLots(root);
    for (const [code, bars] of market) {
        const trimmed = bars.filter((b) => b.day <= day);
        const name = names.get(code) ?? code;
        const gated = universeGate(trimmed, code, name, day, universe);
        if (!gated) continue;
        universeCount++;
        const lastBar = gated[gated.length - 1]!;
        if (!((lastBar.turnover ?? 0) > 0) && lastBar.volume > 0) zeroTo++;
        const window = gated.slice(-lookback);
        const hitIds = [...lib.runStock(baseFromBars(window, { floatSharesLots: shares.get(code) })).keys()];
        if (hitIds.length === 0) continue;
        const sec = sector.get(code);
        hits.push({
            code, name, close: window[window.length - 1]!.close, formulas: hitIds,
            sector: sec?.board, sectorChg: sec?.chg,
        });
        for (const id of hitIds) perFormula.set(id, (perFormula.get(id) ?? 0) + 1);
    }
    // 数据防线（2026-11-03 实录）：TDX 源收盘的 daily-k 无换手率（全 0）——
    // CAPITAL/FINANCE 市值股本反推闸会整条静默失效（FLZT 当日 0 命中）。
    // 不拦跑，但在报告与 stdout 喊出声，免得拿"公式失效"当"行情没戏"。
    const warnings: string[] = [];
    if (universeCount > 0 && zeroTo / universeCount > 0.9) {
        // 股本表在手时 CAPITAL/FINANCE/HSL 不吃换手率——只在无表可注时才不可信
        if (shares.size === 0) {
            warnings.push(`目标日 ${day} 的 daily-k 换手率全零（疑似 TDX 源收盘写盘）且无股本表`
                + `（shares.jsonl 缺席）——市值/股本类闸（CAPITAL/FINANCE）失效，命中清单不可信；`
                + `跑 capital-refresh-tdx.py 建股本表后重跑`);
        }
    }
    if (hits.length > 0 && sector.size === 0 && opts.sector === undefined) {
        warnings.push("板块归属数据缺席（screener/sector-<day>.jsonl 未生成）——报告不做板块分组");
    }

    const perFormulaList = screeners
        .filter((s) => s.enabled)
        .map((s) => ({ id: s.id, name: s.name, count: perFormula.get(s.id) ?? 0 }));

    // 落盘：JSONL（对账原料）+ md（报告面）
    const outDir = join(root, "screener");
    mkdirSync(outDir, { recursive: true });
    const jsonlPath = join(outDir, `${day}.jsonl`);
    const header = schemaHeader(SCHEMA.SCREENER, {
        day, universe: universeCount, formulas: perFormulaList.map((f) => f.id),
        universeRules: universe, generatedAt: Date.now(),
    });
    const jsonl = [header, ...hits.map((h) => JSON.stringify(h))].join("\n") + "\n";
    writeFileSync(jsonlPath, jsonl);

    const lines: string[] = [];
    lines.push(`# 选股报告 ${day}`);
    lines.push("");
    const rulesText = [
        universe.excludeST ? "剔ST/退市" : null,
        universe.excludeBJ ? "剔北交所" : null,
        universe.excludeCK ? "剔创科" : null,
        `成交额≥${(universe.amountMin / 1e4).toFixed(0)}万`,
        universe.qfq ? "前复权" : null,
    ].filter(Boolean).join(" + ");
    lines.push(`- 宇宙 ${universeCount} 只（${rulesText}）· 公式 ${perFormulaList.length} 条`
        + ` · 停用 ${disabled.length} 条 · 拒装 ${loaded.rejected.length} 条 · 耗时 ${Date.now() - t0}ms`);
    if (sector.size > 0) lines.push(`- 板块归属 ${sector.size} 只（行业+题材，取当日涨幅最高板块）`);
    if (shares.size > 0) lines.push(`- 股本：TDX 股本表 ${shares.size} 只（HSL/FINANCE 用真股本，不依赖换手率反推）`);
    for (const w of warnings) lines.push(`- ⚠ ${w}`);
    for (const r of loaded.rejected) lines.push(`- ⚠ 拒装 ${r.id}：${r.error.split("\n")[0]}`);
    for (const id of disabled) lines.push(`- 停用：${id}`);
    lines.push("");
    lines.push("| 公式 | 名称 | 命中 |");
    lines.push("|---|---|---|");
    for (const f of perFormulaList) lines.push(`| ${f.id} | ${f.name} | ${f.count} |`);
    lines.push("");
    for (const f of perFormulaList) {
        const rows = hits.filter((h) => h.formulas.includes(f.id));
        lines.push(`## ${f.id} ${f.name}（${rows.length}）`);
        lines.push(...groupedHits(rows));
        lines.push("");
    }
    const mdPath = join(outDir, `${day}.md`);
    writeFileSync(mdPath, lines.join("\n") + "\n");

    return {
        day, universe: universeCount, hits, perFormula: perFormulaList,
        rejected: loaded.rejected, disabled, jsonlPath, mdPath,
        warnings, elapsedMs: Date.now() - t0,
    };
}

/** 人工把关后的并入动作：把报告里挑中的票追加进 watchlist.txt（去重、
 *  带来源注记）。非法码静默剔除（watchlist 解析纪律同族）。 */
export function mergeIntoWatchlist(codes: string[], day: string): { added: string[]; skipped: string[] } {
    const path = watchlistPath();
    const existing = new Set(existsSync(path)
        ? parseWatchlist(readFileSync(path, "utf-8")).map((e) => e.code)
        : []);
    const added: string[] = [];
    const skipped: string[] = [];
    const lines: string[] = [];
    for (const c of codes) {
        if (!/^(sh|sz|bj)\d{6}$/.test(c) || existing.has(c)) { skipped.push(c); continue; }
        lines.push(`${c}  # 选股 ${day}`);
        added.push(c);
        existing.add(c);
    }
    if (lines.length > 0) {
        const orig = existsSync(path) ? readFileSync(path, "utf-8") : "";
        const sep = orig === "" ? "" : orig.endsWith("\n") ? "" : "\n";
        writeFileSync(path, orig + sep + lines.join("\n") + "\n");
    }
    return { added, skipped };
}

async function main(): Promise<void> {
    const arg = (name: string): string | undefined => {
        const i = process.argv.indexOf(`--${name}`);
        return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : undefined;
    };
    const merge = arg("merge");
    if (merge !== undefined) {
        // 并入模式：--merge sh600089,sh600094 [--day 2026-10-29]——不跑选股
        const day = arg("day") ?? "manual";
        const { added, skipped } = mergeIntoWatchlist(merge.split(",").map((s) => s.trim()).filter(Boolean), day);
        console.log(`并入 ${added.length} 只：${added.join(", ") || "—"}`);
        if (skipped.length > 0) console.log(`跳过 ${skipped.length} 只（已在清单或码非法）：${skipped.join(", ")}`);
        console.error(`→ ${watchlistPath()}`);
        return;
    }
    try {
        const day = arg("day") ?? latestKDay(dataRootPath());
        const result = runScreener({ day, formulaId: arg("formula") });
        // 结果只进文件（2026-11-04 用户需求：terminal 不再打明细）
        console.log(`🎯 选股完成 ${result.day}：宇宙 ${result.universe}，命中 ${result.hits.length} 票`
            + `（${result.perFormula.map((f) => `${f.id} ${f.count}`).join(" / ")}）`);
        console.error(`报告（按板块分组）→ ${result.mdPath}`);
        console.error(`明细（对账原料）→ ${result.jsonlPath}`);
        for (const w of result.warnings) console.error(`⚠ ${w}`);
    } catch (e) {
        console.error(`选股失败：${e instanceof Error ? e.message : String(e)}`);
        process.exit(1);
    }
}

if (process.argv[1]?.endsWith("screener-run.js")) void main();
