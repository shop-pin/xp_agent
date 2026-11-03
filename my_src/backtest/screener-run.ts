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
import { loadStrategy } from "../plugins/strategy.js";
import type { KBar } from "./kline.js";

export interface ScreenerRunOptions {
    day?: string;
    formulaId?: string;
    root?: string;
    configPath?: string;
    /** 回看根数（指标窗口深度；缺省 320 ≥ MA250+缓冲）。 */
    lookback?: number;
}

export interface ScreenerHit { code: string; name: string; close: number; formulas: string[] }

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
    const kDir = join(root, "daily-k");
    if (!existsSync(kDir)) throw new Error(`无 daily-k 目录（${kDir}）——先跑盯盘会话收口`);
    const kDays = readdirSync(kDir).filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).map((f) => f.slice(0, 10)).sort();
    if (kDays.length === 0) throw new Error("daily-k 目录为空——还没有收口数据");
    const day = opts.day ?? kDays[kDays.length - 1]!;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error(`--day 格式应为 YYYY-MM-DD：${day}`);
    if (opts.day !== undefined && !kDays.includes(day)) {
        throw new Error(`指定日 ${day} 无 daily-k 收口——不静默改跑旧日（补数据后重跑，或去掉 --day）`);
    }
    // 名称表：优先目标日收口文件（最新命名），退化逐个回看
    const names = new Map<string, string>();
    for (let i = kDays.length - 1; i >= 0; i--) {
        const rows = readSchemaJsonl<DailyKRow>(join(kDir, `${kDays[i]}.jsonl`), SCHEMA_DAILY_K).rows;
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
    for (const [code, bars] of market) {
        const trimmed = bars.filter((b) => b.day <= day);
        const name = names.get(code) ?? code;
        const gated = universeGate(trimmed, code, name, day, universe);
        if (!gated) continue;
        universeCount++;
        const lastBar = gated[gated.length - 1]!;
        if (!((lastBar.turnover ?? 0) > 0) && lastBar.volume > 0) zeroTo++;
        const window = gated.slice(-lookback);
        const hitIds = [...lib.runStock(baseFromBars(window)).keys()];
        if (hitIds.length === 0) continue;
        hits.push({ code, name, close: window[window.length - 1]!.close, formulas: hitIds });
        for (const id of hitIds) perFormula.set(id, (perFormula.get(id) ?? 0) + 1);
    }
    // 数据防线（2026-11-03 实录）：TDX 源收盘的 daily-k 无换手率（全 0）——
    // CAPITAL/FINANCE 市值股本反推闸会整条静默失效（FLZT 当日 0 命中）。
    // 不拦跑，但在报告与 stdout 喊出声，免得拿"公式失效"当"行情没戏"。
    const warnings: string[] = [];
    if (universeCount > 0 && zeroTo / universeCount > 0.9) {
        warnings.push(`目标日 ${day} 的 daily-k 换手率全零（疑似 TDX 源收盘写盘）——`
            + `市值/股本类闸（CAPITAL/FINANCE）失效，命中清单不可信；`
            + `盘后用 sina 收盘快照重写当日 daily-k 后重跑`);
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
        for (const h of rows) lines.push(`- ${h.code} ${h.name} 收 ${h.close.toFixed(2)}`);
        if (rows.length === 0) lines.push("- 无命中");
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

function main(): void {
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
        const result = runScreener({ day: arg("day"), formulaId: arg("formula") });
        console.log(readFileSync(result.mdPath, "utf-8"));
        for (const w of result.warnings) console.error(`⚠ ${w}`);
        console.error(`选股完成：宇宙 ${result.universe}，命中 ${result.hits.length} 票 → ${result.jsonlPath}`);
    } catch (e) {
        console.error(`选股失败：${e instanceof Error ? e.message : String(e)}`);
        process.exit(1);
    }
}

if (process.argv[1]?.endsWith("screener-run.js")) main();
