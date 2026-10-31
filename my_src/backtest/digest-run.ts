// backtest/digest-run.ts——跟踪期 CLI：每日 digest（研究面，零 LLM）。
//
// 用法：node dist/backtest/digest-run.js [--day YYYY-MM-DD] [--fetch]
//   --day D  目标日（缺省 = 最新日K收口日）
//   --fetch  用 hist-k（腾讯 qfq）补全 daily-k 覆盖前的老窗口（联网按需，
//            只补序列断尾的票；缺省零网络）
// 输入：<dataRoot>/events/{signals,verdicts}.jsonl + daily-k/<day>.jsonl +
//       paper-ledger.jsonl（paperLedgerPath——与 broker 同一路径）
// 输出：stdout + <dataRoot>/digest/<day>.md——复盘与 my_docs/stock-learnings
//        的口粮（零 LLM 编译，LLM 只在"读 digest 下判断"时进场）。

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { cnDay, paperLedgerPath, type Fill } from "../plugins/paper-broker.js";
import {
    dailyKPath, dataRootPath, readSchemaJsonl, SCHEMA_DAILY_K, SCHEMA_SIGNALS, SCHEMA_VERDICTS,
    signalsPath, verdictsPath, type DailyKRow,
} from "../plugins/data-store.js";
import { loadStrategy } from "../plugins/strategy.js";
import { loadKlines } from "./kline.js";
import {
    aggregateRules, aggregateVerdicts, gradeSignals, gradeVerdicts, marketOverview,
    positionsFromFills, type Series, type SignalRow, type VerdictRow,
} from "./digest.js";

function arg(name: string, def: string): string {
    const i = process.argv.indexOf(`--${name}`);
    return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1]! : def;
}

function readLedger(): Fill[] {
    const path = paperLedgerPath();
    if (!existsSync(path)) return [];
    const fills: Fill[] = [];
    for (const line of readFileSync(path, "utf-8").split("\n").filter(Boolean)) {
        try {
            const e = JSON.parse(line) as { type?: string };
            if (e.type === "fill") fills.push(e as unknown as Fill);
        } catch { /* 坏行跳过——账本纪律 */ }
    }
    return fills;
}

/** 需要的码的 close 序列：daily-k 全量打底（真实收盘）；--fetch 时对断尾票
 *  补 hist-k（qfq）——只动序列末尾早于最新收口日的票。 */
async function buildSeries(
    needed: Set<string>, kDays: readonly string[], root: string, fetchHist: boolean,
): Promise<(code: string) => Series | undefined> {
    const map = new Map<string, Series>();
    for (const code of needed) map.set(code, new Map());
    for (const d of kDays) {
        const { rows } = readSchemaJsonl<DailyKRow>(dailyKPath(root, d), SCHEMA_DAILY_K);
        for (const r of rows) {
            const s = map.get(r.code);
            if (s) s.set(d, r.c);
        }
    }
    if (fetchHist) {
        const lastK = kDays[kDays.length - 1]!;
        for (const code of needed) {
            const s = map.get(code)!;
            const seen = [...s.keys()].sort();
            if (seen.length > 0 && seen[seen.length - 1]! >= lastK) continue;
            try {
                for (const b of await loadKlines(code, 120, root)) s.set(b.day, b.close);
            } catch { /* 源失败：daily-k 部分照用，窗口可能不满 */ }
        }
    }
    return (code) => map.get(code);
}

const pct = (x: number | null): string => x === null ? "—" : `${(x * 100).toFixed(2)}%`;
/** chg/涨速类字段本身已是百分数（-2.44 = -2.44%）——只补符号不乘 100。 */
const pctRaw = (x: number | null): string => x === null ? "—" : `${x.toFixed(2)}%`;

async function main(): Promise<void> {
    const root = dataRootPath();
    const kDir = join(root, "daily-k");
    if (!existsSync(kDir)) {
        console.error(`无 daily-k 目录（${kDir}）——先跑盯盘会话让 data-store 收口`);
        process.exit(1);
    }
    const kDays = readdirSync(kDir)
        .filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f))
        .map((f) => f.slice(0, 10))
        .sort();
    if (kDays.length === 0) {
        console.error("daily-k 目录为空——还没有收口数据");
        process.exit(1);
    }
    const dayGiven = process.argv.includes("--day");
    const day = arg("day", kDays[kDays.length - 1]!);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
        console.error(`--day 格式应为 YYYY-MM-DD：${day}`);
        process.exit(1);
    }
    // 显式指日的诚实语义（2026-10-30 缺陷③）：该日无收口 = 数据面当日断供，
    // 明确报错不静默编旧日（缺省不带 --day 的手动补跑路径行为不变）。
    if (dayGiven && !kDays.includes(day)) {
        console.error(`指定日 ${day} 无 daily-k 收口（当日数据面断供？最新收口 ${kDays[kDays.length - 1]}）`
            + "——不静默重算旧日；补数据后重跑，或去掉 --day 编译最新收口日");
        process.exit(1);
    }
    const fetchHist = process.argv.includes("--fetch");

    const sigRead = readSchemaJsonl<SignalRow>(signalsPath(root), SCHEMA_SIGNALS);
    const verRead = readSchemaJsonl<VerdictRow>(verdictsPath(root), SCHEMA_VERDICTS);
    const fills = readLedger();
    const positions = positionsFromFills(fills);

    const needed = new Set<string>();
    for (const s of sigRead.rows) needed.add(s.code);
    for (const v of verRead.rows) needed.add(v.code);
    for (const p of positions) needed.add(p.code);
    const seriesOf = await buildSeries(needed, kDays, root, fetchHist);

    const vGrades = gradeVerdicts(verRead.rows, seriesOf);
    const sGrades = gradeSignals(sigRead.rows, seriesOf);
    const actionStats = aggregateVerdicts(vGrades);
    const ruleStats = aggregateRules(sGrades);

    const stopPct = loadStrategy().exit.stopLossPct;
    const rows = positions.map((p) => {
        const s = seriesOf(p.code);
        let price: number | undefined;
        if (s) for (const d of [...s.keys()].sort()) if (d <= day) price = s.get(d);
        const value = price !== undefined ? price * p.qty : null;
        const dd = value !== null && p.cost > 0 ? value / p.cost - 1 : null;
        return { ...p, price, drawdown: dd, breach: dd !== null && dd <= -stopPct };
    });

    const todaySigs = sigRead.rows.filter((s) => s.day === day);
    const byRule = new Map<string, number>();
    for (const s of todaySigs) {
        const k = `${s.rule}|${s.direction}`;
        byRule.set(k, (byRule.get(k) ?? 0) + 1);
    }
    const topSigs = [...todaySigs].sort((a, b) => b.strength - a.strength).slice(0, 5);
    const dayFills = fills.filter((f) => cnDay(f.at) === day);
    const realized = dayFills.reduce((a, f) => a + (f.realizedPnl ?? 0), 0);
    const overview = marketOverview(
        readSchemaJsonl<DailyKRow>(dailyKPath(root, day), SCHEMA_DAILY_K).rows);

    // 自动旗标：样本量底线之上的显著偏离——learnings 的候选，不自动定论
    const flags: string[] = [];
    for (const r of ruleStats) {
        if (r.ret1.n >= 5 && r.ret1.avg !== null && Math.abs(r.ret1.avg) >= 0.01) {
            flags.push(`规则 ${r.rule}(${r.direction}) n=${r.ret1.n} T+1 均 ${pct(r.ret1.avg)}`
                + ` 胜率 ${pct(r.ret1.win)}——信息面，进 learnings 候选`);
        }
    }
    for (const a of actionStats) {
        if (a.ret1.n >= 3 && a.ret1.avg !== null && Math.abs(a.ret1.avg) >= 0.01) {
            flags.push(`裁决 ${a.action}/${a.tier} n=${a.ret1.n} T+1 均 ${pct(a.ret1.avg)}`
                + ` 胜率 ${pct(a.ret1.win)}——校准面观察项`);
        }
    }

    const out: string[] = [];
    out.push(`# 盯盘 digest ${day}`);
    out.push("");
    out.push(`- 数据：signals ${sigRead.rows.length} 条（坏 ${sigRead.bad}）/ verdicts ${verRead.rows.length} 条`
        + `（坏 ${verRead.bad}）/ 账本 fill ${fills.length} 笔 / 日K ${kDays.length} 个交易日`);
    out.push(`- 口径：打分基准 = 当日收盘，T+N = 之后第 N 个交易日收盘；窗口未满记 —。`
        + `${fetchHist ? "序列含 hist-k(qfq) 补段（近似④同族）。" : "序列仅 daily-k（零网络）。"}`);
    out.push("");
    out.push("## 一、市场概览");
    out.push(`涨 ${overview.up} / 跌 ${overview.down} / 平 ${overview.flat}；中位涨幅 ${pctRaw(overview.medianChg)}`);
    out.push("");
    out.push(`## 二、今日信号（${todaySigs.length} 笔）`);
    for (const [k, n] of [...byRule.entries()].sort((a, b) => b[1] - a[1])) {
        out.push(`- ${k.replace("|", " ")}：${n} 笔`);
    }
    if (byRule.size === 0) out.push("- 无");
    if (topSigs.length > 0) {
        out.push("");
        out.push("最强 5 笔：");
        for (const s of topSigs) {
            out.push(`- ${s.code} ${s.name}：${s.note}（${s.rule}/${s.direction}，strength ${s.strength}）`);
        }
    }
    out.push("");
    out.push("## 三、裁决对账（全历史，按 action × 信心档）");
    out.push("");
    out.push("| action | 档 | n | T+1 均 | T+1 胜率 | T+3 n | T+3 均 |");
    out.push("|---|---|---|---|---|---|---|");
    for (const a of actionStats) {
        out.push(`| ${a.action} | ${a.tier} | ${a.ret1.n} | ${pct(a.ret1.avg)} | ${pct(a.ret1.win)}`
            + ` | ${a.ret3.n} | ${pct(a.ret3.avg)} |`);
    }
    if (actionStats.length === 0) out.push("（事件层还没有裁决——/adjudicate 后 record_verdicts 入档）");
    out.push("");
    out.push("## 四、信号规则对账（全历史，n 降序）");
    out.push("");
    out.push("| 规则 | 方向 | n | T+1 均 | 胜率 |");
    out.push("|---|---|---|---|---|");
    for (const r of ruleStats) {
        out.push(`| ${r.rule} | ${r.direction} | ${r.ret1.n} | ${pct(r.ret1.avg)} | ${pct(r.ret1.win)} |`);
    }
    if (ruleStats.length === 0) out.push("（事件层还没有信号）");
    out.push("");
    out.push(`## 五、持仓与风控（止损线 ${pct(-stopPct)}）`);
    for (const p of rows) {
        out.push(`- ${p.code} 持 ${p.qty} 股，含费成本 ${p.cost.toFixed(2)}，现价 ${p.price ?? "—"}，`
            + `浮盈 ${pct(p.drawdown)}${p.breach ? " ⚠破止损线" : ""}`);
    }
    if (rows.length === 0) out.push("- 空仓");
    out.push(`今日成交 ${dayFills.length} 笔，已实现 ${realized >= 0 ? "+" : ""}${realized.toFixed(2)} 元`);
    out.push("");
    out.push("## 六、值得记录的观察（自动旗标）");
    for (const f of flags) out.push(`- ${f}`);
    if (flags.length === 0) out.push("- 今日无新旗标");

    const text = out.join("\n") + "\n";
    console.log(text);
    const digestDir = join(root, "digest");
    mkdirSync(digestDir, { recursive: true });
    const outPath = join(digestDir, `${day}.md`);
    writeFileSync(outPath, text);
    console.error(`digest → ${outPath}`);
}

void main().catch((e) => {
    console.error(`digest 失败：${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
});
