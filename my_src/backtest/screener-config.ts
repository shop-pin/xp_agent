// backtest/screener-config.ts——SC4：选股器配置面（S14 策略即配置的姊妹篇）。
//
// 真身：~/.mini-claude/stocks/screeners.json（用户覆盖层）+ 内置公式库
// （product 层，formulas/builtin.ts）。合并语义：
//   * 按 id 覆盖——用户同名条目替换内置定义（note/name/enabled/formula
//     整字段覆盖），params 按键深合并（改一个窗参不用抄全表）
//   * 坏配置（非 JSON / 非对象 / 条目缺 id·formula）明确拒读——抛错不静默
//   * 坏公式（编译失败）按条拒装并点名——不让一个坏公式毒全场
// 装载产物直接喂 FormulaLibrary.build（内置库的坏定义仍 fail-fast——产品 bug）。

import { existsSync, readFileSync, readdirSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { loadFormula, FormulaError } from "./formula.js";
import { BUILTIN_INDICATORS, BUILTIN_SCREENERS, type IndicatorDef, type ScreenerDef } from "./formulas/builtin.js";

export interface ScreenerUniverse {
    excludeST?: boolean;
    excludeBJ?: boolean;
    excludeCK?: boolean;
    amountMin?: number;
    /** 前复权口径声明（2026-11-02 用户选项）：数据面当前固定前复权，
     *  此标记进报告注记（与通达信选股界面的 checkbox 对齐）。 */
    qfq?: boolean;
}

export interface UserScreenerConfig {
    indicators?: Array<Partial<IndicatorDef> & { id: string; formula: string }>;
    screeners?: Array<Partial<ScreenerDef> & { id: string; formula: string }>;
    universe?: ScreenerUniverse;
}

export interface LoadedScreeners {
    indicators: IndicatorDef[];
    screeners: ScreenerDef[];
    universe: Required<ScreenerUniverse>;
    /** json 层显式写的 universe 裸值（没写的字段不在内）——strategy.screener.universe
     *  的优先级分层用：显式配置 > 用户常设(strategy) > 缺省（2026-11-02）。 */
    universeExplicit: ScreenerUniverse;
    /** 编译失败的条目（按条拒装，点名报错——报告面可见）。 */
    rejected: Array<{ id: string; error: string }>;
}

export function screenerConfigPath(): string {
    return join(homedir(), ".mini-claude", "stocks", "screeners.json");
}

/** 公式目录（2026-11-02 用户拍板的公式文件形态）：indicators/*.txt + screeners/*.txt，
 *  文件名（去后缀）= 公式 id，内容=原样通达信公式文本（{} 注释 lexer 已支持）。
 *  装卸语义：放进去=装、删掉=卸、"X.off.txt"=停用（screeners 层映射 enabled:false
 *  进停用清单；indicators 层直接跳过装载——指标没有停用清单概念）。 */
export function formulasDir(): string {
    return process.env.MINI_FORMULAS_DIR ?? join(homedir(), ".mini-claude", "stocks", "formulas");
}

interface DirFormula { id: string; formula: string; off: boolean }

function readFormulaSubdir(kind: "indicators" | "screeners"): DirFormula[] {
    const dir = join(formulasDir(), kind);
    let files: string[];
    try {
        files = readdirSync(dir).filter((f) => f.toLowerCase().endsWith(".txt"));
    } catch {
        return []; // 无目录 = 用户还没建公式目录——零公式，不报错
    }
    const out: DirFormula[] = [];
    for (const f of files.sort()) {
        const off = f.toLowerCase().endsWith(".off.txt");
        const id = f.slice(0, -(off ? 8 : 4)).trim(); // ".off.txt"=8 ".txt"=4
        if (id === "") continue;
        try {
            out.push({ id, formula: readFileSync(join(dir, f), "utf-8"), off });
        } catch { /* 单文件不可读跳过——装载纪律同族 */ }
    }
    return out;
}

export const DEFAULT_UNIVERSE: Required<ScreenerUniverse> = {
    excludeST: true,
    excludeBJ: true,
    excludeCK: false,
    amountMin: 30_000_000,
    qfq: true,
};

function readUserConfig(path: string): UserScreenerConfig {
    if (!existsSync(path)) return {};
    let parsed: unknown;
    try {
        parsed = JSON.parse(readFileSync(path, "utf-8"));
    } catch (e) {
        throw new Error(`选股器配置不可读（${path}）：${e instanceof Error ? e.message : String(e)}`);
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error(`选股器配置须为对象（${path}）——明确拒读`);
    }
    const cfg = parsed as UserScreenerConfig;
    for (const [key, entries] of [["indicators", cfg.indicators], ["screeners", cfg.screeners]] as const) {
        if (entries === undefined) continue;
        if (!Array.isArray(entries)) throw new Error(`选股器配置 ${key} 须为数组（${path}）——明确拒读`);
        for (const e of entries) {
            if (typeof e !== "object" || e === null || typeof (e as { id?: unknown }).id !== "string") {
                throw new Error(`选股器配置 ${key} 条目须含字符串 id（${path}）——明确拒读`);
            }
            const f = (e as { formula?: unknown }).formula;
            if (f !== undefined && typeof f !== "string") {
                throw new Error(`选股器配置 ${key} 条目的 formula 须为字符串（${path}）——明确拒读`);
            }
        }
    }
    if (cfg.universe !== undefined && (typeof cfg.universe !== "object" || cfg.universe === null || Array.isArray(cfg.universe))) {
        throw new Error(`选股器配置 universe 须为对象（${path}）——明确拒读`);
    }
    return cfg;
}

/** 编译校验一条公式（坏则返回错误文本，好则 null）。 */
function validateFormula(formula: string, params: Record<string, number> | undefined, requireXg: boolean,
    indicatorNames?: Set<string>): string | null {
    try {
        const indicators = indicatorNames
            ? new Map([...indicatorNames].map((n) => [n, []]))
            : undefined;
        loadFormula(formula, { params: params ?? {}, requireXg, indicators });
        return null;
    } catch (e) {
        return e instanceof Error ? e.message : String(e);
    }
}

export function loadScreeners(path: string = screenerConfigPath()): LoadedScreeners {
    const user = readUserConfig(path);
    // 合并顺序：内置 ← screeners.json ← formulas/ 目录（后覆盖前，同 id 整字段替换）。
    // 目录层（2026-11-02 用户拍板形态）：文件名=id、内容=原样公式、.off.txt=停用。
    const dirIndicators: Array<Partial<IndicatorDef> & { id: string; formula: string }> =
        readFormulaSubdir("indicators").filter((f) => !f.off)
            .map((f) => ({ id: f.id, formula: f.formula }));
    const dirScreeners: Array<Partial<ScreenerDef> & { id: string; formula: string }> =
        readFormulaSubdir("screeners")
            .map((f) => ({ id: f.id, formula: f.formula, ...(f.off ? { enabled: false } : {}) }));
    const userIndicators = [...(user.indicators ?? []), ...dirIndicators];
    const userScreeners = [...(user.screeners ?? []), ...dirScreeners];
    // 指标合并：按 id 覆盖（字段整覆盖），params 键级深合并
    const indById = new Map<string, IndicatorDef>(BUILTIN_INDICATORS.map((d) => [d.id, { ...d }]));
    for (const u of userIndicators) {
        const base = indById.get(u.id);
        indById.set(u.id, {
            id: u.id,
            name: u.name ?? base?.name ?? u.id,
            kind: u.kind ?? base?.kind ?? "sub",
            note: u.note ?? base?.note ?? "",
            params: { ...(base?.params ?? {}), ...(u.params ?? {}) },
            formula: u.formula,
        });
    }
    const scById = new Map<string, ScreenerDef>(BUILTIN_SCREENERS.map((d) => [d.id, { ...d }]));
    for (const u of userScreeners) {
        const base = scById.get(u.id);
        scById.set(u.id, {
            id: u.id,
            name: u.name ?? base?.name ?? u.id,
            note: u.note ?? base?.note ?? "",
            enabled: u.enabled ?? base?.enabled ?? true,
            params: { ...(base?.params ?? {}), ...(u.params ?? {}) },
            formula: u.formula ?? base?.formula ?? "", // spread 后 undefined 会顶掉内置——S14 教训同族
        });
    }
    // 编译校验（按条拒装）：先指标后选股（选股公式引用指标名在引擎侧动态
    // 解析，此处不校验跨引用——FormulaLibrary.build 编译期会兜住）
    const rejected: LoadedScreeners["rejected"] = [];
    // 新增条目既无 formula 又无内置可沿用 → 按条拒装（不是整份拒读——覆盖
    // 语义下这是单条缺料，点名即可）
    for (const u of userScreeners) {
        if (u.formula === undefined && !scById.has(u.id)) {
            rejected.push({ id: u.id, error: "新条目缺 formula（内置库无同名可沿用）" });
            scById.delete(u.id);
        }
    }
    const indicators: IndicatorDef[] = [];
    const indicatorNames = new Set<string>();
    for (const def of indById.values()) {
        // 前序指标输出可见（与 library.build 顺序编译同缝）：SRC 可引用内置 MACD.DIF
        const available = new Set(indicatorNames);
        const err = validateFormula(def.formula, def.params, false, available);
        if (err) rejected.push({ id: `indicator:${def.id}`, error: err });
        else {
            indicators.push(def);
            for (const out of loadFormula(def.formula, { params: def.params, indicators: new Map([...available].map((n) => [n, []])) }).outputs) {
                indicatorNames.add(`${def.id.toUpperCase()}.${out.toUpperCase()}`);
            }
        }
    }
    const screeners: ScreenerDef[] = [];
    for (const def of scById.values()) {
        const err = validateFormula(def.formula, def.params, true, indicatorNames);
        if (err) rejected.push({ id: def.id, error: err });
        else screeners.push(def);
    }
    return {
        indicators,
        screeners,
        universe: { ...DEFAULT_UNIVERSE, ...(user.universe ?? {}) },
        universeExplicit: user.universe ?? {},
        rejected,
    };
}
