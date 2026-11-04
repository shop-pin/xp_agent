// backtest/formula.ts——SC2：TDX 选股公式解释器（研究面）。
//
// 三层：词法 → 语法（AST 预编译一次）→ 逐票求值（向量化， Series/Cond）。
// 语法（TDX 子集，总纲 §四）：
//   program  := statement*
//   statement:= IDENT ":=" expr ";"   中间变量（不显示）
//             | IDENT ":"  expr ";"   输出（选股公式必须恰有一个 XG:）
//   expr  := or; or := and ("OR" and)*; and := not ("AND" not)*;
//   not   := "NOT" not | cmp; cmp := add ((">="|"="|"=="|"<"|">"|"<="|"<>"|"!=") add)?
//   add/mul/unary/primary 标准优先级；primary := num | IDENT | IDENT "(" args ")" | "(" expr ")"
// 语义：标识符不区分大小写；{} 为注释；中文名可用；"指标名.输出名"（如
// MACD.DIF）引用公式库指标产出——SC3 起。
// 求值：标量（数字/参数）广播成常量序列；算术对条件按 0/1 收缩（TDX 同款）；
//   条件产出 boolean[]（null 参与=false——选股语义：无效不选出，保守方向）；
//   除零=无效（null），不炸。
// 窗口函数第二参（N）必须为数字字面量或参数名——静态检查，非常量拒装。

import {
    ma, ema, sma, ref, hhv, llv, hhvBars, llvBars, sum, std, stdp,
    gt, lt, gte, lte, eq, ne, and, or, not, cross, count, every, exist,
    barsLast, barsCount, add, sub, mul, div, abs, forcast, type Series, type Cond,
} from "./indicators.js";
import type { KBar } from "./kline.js";

// ---------- 词法 ----------

type Tok =
    | { kind: "num"; v: number }
    | { kind: "ident"; name: string }
    | { kind: "op"; op: string }
    | { kind: "str"; v: string };

const IDENT_RE = /^[A-Za-z_一-龥][A-Za-z0-9_一-龥.]*/;
const NUM_RE = /^[0-9]+(\.[0-9]+)?/;

export class FormulaError extends Error {
    constructor(message: string, readonly pos: number) {
        super(message);
    }
}

function lex(text: string): Tok[] {
    const toks: Tok[] = [];
    let i = 0;
    while (i < text.length) {
        const ch = text[i]!;
        if (ch === " " || ch === "\t" || ch === "\r" || ch === "\n") { i++; continue; }
        if (ch === "{") {  // TDX 注释
            const end = text.indexOf("}", i);
            if (end < 0) throw new FormulaError("注释 { 未闭合", i);
            i = end + 1;
            continue;
        }
        if (ch === "'") {  // TDX 字符串（NAMELIKE('ST') 等）——值不参与语义，仅为可解析
            const end = text.indexOf("'", i + 1);
            if (end < 0) throw new FormulaError("字符串 ' 未闭合", i);
            toks.push({ kind: "str", v: text.slice(i + 1, end) });
            i = end + 1;
            continue;
        }
        const rest = text.slice(i);
        const num = NUM_RE.exec(rest);
        if (num) { toks.push({ kind: "num", v: Number(num[0]) }); i += num[0].length; continue; }
        const ident = IDENT_RE.exec(rest);
        if (ident) { toks.push({ kind: "ident", name: ident[0] }); i += ident[0].length; continue; }
        const two = rest.slice(0, 2);
        if (two === ":=" || two === "<=" || two === ">=" || two === "<>" || two === "!=" || two === "=="
            || two === "||" || two === "&&") {
            toks.push({ kind: "op", op: two === "==" ? "=" : two === "<>" ? "!="
                : two === "||" ? "OR" : two === "&&" ? "AND" : two });
            i += 2;
            continue;
        }
        if ("+-*/(),;:<>=".includes(ch)) { toks.push({ kind: "op", op: ch }); i++; continue; }
        throw new FormulaError(`无法识别的字符 "${ch}"`, i);
    }
    return toks;
}

// ---------- 语法 ----------

export type Expr =
    | { kind: "num"; v: number }
    | { kind: "name"; n: string }
    | { kind: "str"; v: string }
    | { kind: "bin"; op: string; l: Expr; r: Expr }
    | { kind: "un"; op: string; x: Expr }
    | { kind: "call"; fn: string; args: Expr[] };

/** TDX 绘图语句（STICKLINE/DRAWTEXT 等）——选股语义无操作，解析期整条忽略。 */
const DRAW_FUNCS = new Set([
    "STICKLINE", "DRAWTEXT", "DRAWICON", "DRAWNUMBER", "DRAWLINE", "DRAWKLINE",
    "POLYLINE", "VERTLINE", "STICKLINE1", "DRAWTEXT_FIX", "DRAWNUMBER_FIX", "DRAWICON_FIX",
]);

export interface Statement { name: string; isOutput: boolean; expr: Expr }
export interface Program {
    statements: Statement[];
    outputs: string[];
    /** 全部窗口函数常量参（静态提取）——SC4 一致行为锚与文档化用。 */
    params: Set<string>;
}

class Parser {
    private i = 0;
    constructor(private toks: Tok[]) {}

    private peek(): Tok | undefined { return this.toks[this.i]; }
    private eatOp(op: string): void {
        const t = this.peek();
        if (!t || t.kind !== "op" || t.op !== op) {
            const got = t === undefined ? "EOF" : t.kind === "op" ? t.op
                : t.kind === "num" ? String(t.v) : t.kind === "str" ? `'${t.v}'` : t.name;
            throw new FormulaError(`期望 "${op}"，实际 "${got}"`, this.i);
        }
        this.i++;
    }
    private isOp(op: string): boolean {
        const t = this.peek();
        return !!t && t.kind === "op" && t.op === op;
    }
    private ident(): string {
        const t = this.peek();
        if (!t || t.kind !== "ident") throw new FormulaError("期望标识符", this.i);
        this.i++;
        return t.name;
    }

    parseProgram(): Program {
        const statements: Statement[] = [];
        const outputs: string[] = [];
        while (this.peek()) {
            const head = this.peek()!;
            // 绘图语句（STICKLINE(...),COLOR;）整条忽略——选股语义无操作
            if (head.kind === "ident" && DRAW_FUNCS.has(head.name.toUpperCase())) {
                const nxt = this.toks[this.i + 1];
                if (nxt && nxt.kind === "op" && nxt.op === "(") {
                    this.i++;
                    this.skipDrawStatement(head.name.toUpperCase());
                    continue;
                }
            }
            const name = this.ident();
            let isOutput: boolean;
            if (this.isOp(":=")) { isOutput = false; this.i++; }
            else if (this.isOp(":")) { isOutput = true; this.i++; }
            else throw new FormulaError(`期望 ":=" 或 ":"（变量 ${name}）`, this.i);
            const expr = this.parseExpr();
            // TDX 画线属性剥离：,STICK,COLORRED,LINETHICK9 —— 属性=逗号+单记号
            while (this.isOp(",")) { this.i++; this.i++; }
            this.eatOp(";");
            statements.push({ name: name.toUpperCase(), isOutput, expr });
            if (isOutput) outputs.push(name.toUpperCase());
        }
        if (statements.length === 0) throw new FormulaError("空公式", 0);
        return { statements, outputs, params: new Set() };
    }

    /** 绘图语句跳过：括号深度扫描到配对 )（参数是任意表达式，不解析），再剥属性到 ;。 */
    private skipDrawStatement(name: string): void {
        let depth = 0;
        for (;;) {
            const t = this.peek();
            if (!t) throw new FormulaError(`绘图语句 ${name} 未闭合`, this.i);
            this.i++;
            if (t.kind === "op" && t.op === "(") depth++;
            else if (t.kind === "op" && t.op === ")") { depth--; if (depth === 0) break; }
        }
        while (this.isOp(",")) { this.i++; this.i++; }
        this.eatOp(";");
    }

    parseExpr(): Expr { return this.parseOr(); }
    private parseOr(): Expr {
        let l = this.parseAnd();
        for (;;) {
            if (this.isKeyword("OR") || this.isOp("OR")) { this.i++; l = { kind: "bin", op: "OR", l, r: this.parseAnd() }; }
            else break;
        }
        return l;
    }
    private parseAnd(): Expr {
        let l = this.parseNot();
        for (;;) {
            if (this.isKeyword("AND") || this.isOp("AND")) { this.i++; l = { kind: "bin", op: "AND", l, r: this.parseNot() }; }
            else break;
        }
        return l;
    }
    private isKeyword(kw: string): boolean {
        const t = this.peek();
        return !!t && t.kind === "ident" && t.name.toUpperCase() === kw;
    }
    private parseNot(): Expr {
        if (this.isKeyword("NOT")) { this.i++; return { kind: "un", op: "NOT", x: this.parseNot() }; }
        return this.parseCmp();
    }
    private parseCmp(): Expr {
        let l = this.parseAdd();
        const t = this.peek();
        if (t && t.kind === "op" && ["<", ">", "<=", ">=", "=", "!="].includes(t.op)) {
            this.i++;
            l = { kind: "bin", op: t.op, l, r: this.parseAdd() };
        }
        return l;
    }
    private parseAdd(): Expr {
        let l = this.parseMul();
        for (;;) {
            if (this.isOp("+")) { this.i++; l = { kind: "bin", op: "+", l, r: this.parseMul() }; }
            else if (this.isOp("-")) { this.i++; l = { kind: "bin", op: "-", l, r: this.parseMul() }; }
            else return l;
        }
    }
    private parseMul(): Expr {
        let l = this.parseUnary();
        for (;;) {
            if (this.isOp("*")) { this.i++; l = { kind: "bin", op: "*", l, r: this.parseUnary() }; }
            else if (this.isOp("/")) { this.i++; l = { kind: "bin", op: "/", l, r: this.parseUnary() }; }
            else return l;
        }
    }
    private parseUnary(): Expr {
        if (this.isOp("-")) { this.i++; return { kind: "un", op: "-", x: this.parseUnary() }; }
        return this.parsePrimary();
    }
    private parsePrimary(): Expr {
        const t = this.peek();
        if (!t) throw new FormulaError("表达式意外结束", this.i);
        if (t.kind === "num") { this.i++; return { kind: "num", v: t.v }; }
        if (t.kind === "str") { this.i++; return { kind: "str", v: t.v }; }
        if (t.kind === "ident") {
            this.i++;
            if (this.isOp("(")) {
                this.i++;
                const args: Expr[] = [];
                if (!this.isOp(")")) {
                    args.push(this.parseExpr());
                    while (this.isOp(",")) { this.i++; args.push(this.parseExpr()); }
                }
                this.eatOp(")");
                return { kind: "call", fn: t.name.toUpperCase(), args };
            }
            return { kind: "name", n: t.name };
        }
        if (t.kind === "op" && t.op === "(") {
            this.i++;
            const e = this.parseExpr();
            this.eatOp(")");
            return e;
        }
        throw new FormulaError(`意外记号 "${t.op}"`, this.i);
    }
}

// ---------- 内置函数注册表 ----------

export type Val = Series | Cond;
type FnDef = {
    /** 窗口类函数在编译期需要的常量参位置（如 MA 第 2 参）。 */
    constArgs?: number[];
    /** ctx = 基础行情绑定（FINANCE/CAPITAL 反推换手率用）。 */
    eval: (args: Val[], consts: number[], ctx?: Record<string, Series>) => Val;
};

const s = (v: Val): Series => (typeof v[0] === "boolean" ? (v as Cond).map((b) => (b ? 1 : 0)) : v as Series);
const c = (v: Val): Cond => (typeof v[0] === "boolean" ? v as Cond : (v as Series).map((x) => x !== null && x !== undefined && x > 0));

/** 流通股本（手）序列：TO% = VOL(手)/股本(手)×100 → 股本 = VOL×100/TO。
 *  缺 to（或 0）的 bar 回填"最近一根带 to 的 bar"的反推值（2026-11-03 挂账
 *  销账：TDX 源收盘快照无 to → 当日反推全废、FINANCE/HSL 闸整条失效；股本
 *  短窗内近似常量，TDX 的 CAPITAL 本就是当前值口径）。开局就无 to → null
 *  （保守，比较=false 与旧口径一致）。FINANCE(7)/CAPITAL 同源。 */
function capitalSeries(vols: Series, tos: Series): Series {
    const out: Series = new Array(vols.length).fill(null);
    let last: number | null = null;
    for (let i = 0; i < vols.length; i++) {
        const v = vols[i], t = tos[i];
        if (v !== null && v !== undefined && t !== null && t !== undefined && t > 0) {
            last = (v * 100) / t;
        }
        out[i] = last;
    }
    return out;
}

function capitalFrom(ctx: Record<string, Series>): Series {
    // 股本表注入（2026-11-04 TDX 纯化）：base 已带 CAPITAL（TDX finance_batch
    // 的流通股本，手）时直读——反推链（to 依赖）只作无注入时的兜底。
    const injected = ctx.CAPITAL;
    if (injected && injected.length > 0) return injected;
    return capitalSeries(ctx.V ?? [], ctx.TO ?? []);
}

export const BUILTIN_FUNCS: Record<string, FnDef> = {
    MA: { constArgs: [1], eval: (a, k) => ma(s(a[0]!), k[0]!) },
    EMA: { constArgs: [1], eval: (a, k) => ema(s(a[0]!), k[0]!) },
    SMA: { constArgs: [1, 2], eval: (a, k) => sma(s(a[0]!), k[0]!, k[1]!) },
    REF: {
        constArgs: [1],
        // 统一动态位移：第二参求值后总是序列（数字字面量/params=常数序列，
        // BARSLAST(cond)=真动态——取上次条件成立时的值）。j<0=窗口不足 null。
        eval: (a) => {
            const x = s(a[0]!); const win = s(a[1]!);
            return x.map((v, i) => {
                const n = win[i];
                if (n === null || n === undefined || n < 0) return null;
                const j = i - n;
                return j < 0 ? null : (x[j] ?? null);
            });
        },
    },
    HHV: { constArgs: [1], eval: (a, k) => hhv(s(a[0]!), k[0]!) },
    LLV: { constArgs: [1], eval: (a, k) => llv(s(a[0]!), k[0]!) },
    HHVBARS: { constArgs: [1], eval: (a, k) => hhvBars(s(a[0]!), k[0]!) },
    LLVBARS: { constArgs: [1], eval: (a, k) => llvBars(s(a[0]!), k[0]!) },
    SUM: { constArgs: [1], eval: (a, k) => sum(s(a[0]!), k[0]!) },
    STD: { constArgs: [1], eval: (a, k) => std(s(a[0]!), k[0]!) },
    STDP: { constArgs: [1], eval: (a, k) => stdp(s(a[0]!), k[0]!) },
    ABS: { eval: (a) => abs(s(a[0]!)) },
    MAX: { eval: (a) => { const [x, y] = [s(a[0]!), s(a[1]!)]; return x.map((v, i) => (v === null || y[i] === null ? null : Math.max(v, y[i]!))); } },
    MIN: { eval: (a) => { const [x, y] = [s(a[0]!), s(a[1]!)]; return x.map((v, i) => (v === null || y[i] === null ? null : Math.min(v, y[i]!))); } },
    COUNT: { constArgs: [1], eval: (a, k) => count(c(a[0]!), k[0]!) },
    EVERY: { constArgs: [1], eval: (a, k) => every(c(a[0]!), k[0]!) },
    EXIST: { constArgs: [1], eval: (a, k) => exist(c(a[0]!), k[0]!) },
    BARSLAST: { eval: (a) => barsLast(c(a[0]!)) },
    BARSCOUNT: { eval: (a) => barsCount(s(a[0]!)) },
    CROSS: { eval: (a) => cross(a[0]!, a[1]!) },
    // TDX 移植高频三件（2026-11-02 用户公式验收轮）：IF 条件选择（DRAWNULL
    // 作 else 分支=不画→null 传播）、FILTER 信号静默窗（发出后 N 根内不再发）、
    // BETWEEN 区间判定。FORCAST/FINANCE/NAMELIKE/CODELIKE/SETCODE 不做——
    // 前者语义重（线性回归）改写用 MA 近似，后者数据面不存在（universe 闸替代）。
    IF: {
        eval: (a) => {
            const cond = c(a[0]!); const x = s(a[1]!); const y = s(a[2]!);
            return cond.map((b, i) => (b ? x[i] : y[i]));
        },
    },
    FILTER: {
        constArgs: [1],
        eval: (a, k) => {
            const cond = c(a[0]!); const n = k[0]!;
            const out: Cond = new Array(cond.length).fill(false);
            let last = Number.NEGATIVE_INFINITY;
            for (let i = 0; i < cond.length; i++) {
                if (cond[i] === true && i - last > n) { out[i] = true; last = i; }
            }
            return out;
        },
    },
    BETWEEN: {
        eval: (a) => {
            const x = s(a[0]!); const lo = s(a[1]!); const hi = s(a[2]!);
            return x.map((v, i) => (v !== null && lo[i] !== null && hi[i] !== null && v >= lo[i]! && v <= hi[i]!));
        },
    },
    // TDX 原版公式直读补件（2026-11-02 用户公式逐字适配轮）：
    //   CONST 取末值常量；FORCAST 线性回归外推；NAMELIKE/CODELIKE 恒 false
    //   （ST/板块过滤由 universe 闸承担——净效果一致）；SETCODE 恒 0（A 股
    //   沪深分支恒真）；FINANCE/CAPITAL 从换手率反推流通股本（TO%=VOL/股本
    //   → 股本(手)=VOL×100/TO；42=流通市值=C×股本×100），缺 to 的 bar 回填
    //   最近一根带 to 的 bar 反推值（capitalSeries——TDX 收盘日 to 断供面）。
    CONST: {
        eval: (a) => {
            const x = s(a[0]!);
            let last: number | null = null;
            for (let i = x.length - 1; i >= 0; i--) {
                if (x[i] !== null && x[i] !== undefined) { last = x[i]!; break; }
            }
            return x.map(() => last);
        },
    },
    FORCAST: { constArgs: [1], eval: (a, k) => forcast(s(a[0]!), k[0]!) },
    NAMELIKE: { eval: (a) => new Array((a[0] as Series).length).fill(false) },
    CODELIKE: { eval: (a) => new Array((a[0] as Series).length).fill(false) },
    FINANCE: {
        constArgs: [0],
        eval: (a, k, ctx) => {
            const which = k[0] ?? Number.NaN;
            const cap = capitalFrom(ctx ?? {}); // 手
            if (which === 7) return cap.map((v) => (v === null ? null : v * 100)); // TDX 单位=股
            if (which === 42) { // 流通市值（元）=C×股本（股）
                const c = (ctx?.C ?? []);
                return cap.map((v, i) => (v === null ? null : (c[i] ?? 0) * v * 100));
            }
            return cap.map(() => null); // 其余财务字段无数据面——null（比较=false，保守）
        },
    },
    CAPITAL: { eval: (_a, _k, ctx) => capitalFrom(ctx ?? {}) },
};

// ---------- 编译（一次）与求值（逐票） ----------

export interface FormulaLoadOptions {
    /** 选股公式：必须恰有一个名为 XG 的输出。 */
    requireXg?: boolean;
    /** 公式引用的参数值（窗口参等）；缺省空。 */
    params?: Record<string, number>;
    /** SC3 起：可引用的指标公式输出（名称大写 → 产出物）。 */
    indicators?: Map<string, Val>;
}

export interface CompiledFormula {
    program: Program;
    params: Record<string, number>;
    indicators?: Map<string, Val>;
    outputs: string[];
}

export function loadFormula(text: string, opts: FormulaLoadOptions = {}): CompiledFormula {
    const program = new Parser(lex(text)).parseProgram();
    const seen = new Set<string>();
    for (const st of program.statements) {
        if (seen.has(st.name)) throw new FormulaError(`变量重复定义：${st.name}`, 0);
        seen.add(st.name);
    }
    const params = opts.params ?? {};
    const indicators = opts.indicators;
    // 静态检查：未知函数 / 未知名字 / 窗口参常量性
    const locals = new Set(program.statements.map((st) => st.name));
    const bases = new Set(["C", "O", "H", "L", "V", "VOL", "CLOSE", "OPEN", "HIGH", "LOW", "VOLUME", "AMOUNT",
        "TO", "TURNOVER", "DRAWNULL", "AMO", "SETCODE", "CAPITAL"]);
    const walk = (e: Expr): void => {
        switch (e.kind) {
            case "num": return;
            case "str": return; // 字符串字面量（NAMELIKE 参数）——无名字可查
            case "name": {
                const n = e.n.toUpperCase();
                if (!locals.has(n) && !bases.has(n) && !(n in params)
                    && !(indicators?.has(n))) {
                    throw new FormulaError(`未知名字：${e.n}（非变量/输出/基础行情/参数${indicators ? "/指标" : ""}）`, 0);
                }
                return;
            }
            case "un": return walk(e.x);
            case "bin": walk(e.l); walk(e.r); return;
            case "call": {
                const fn = BUILTIN_FUNCS[e.fn];
                if (!fn) throw new FormulaError(`未知函数：${e.fn}`, 0);
                const want = fn.constArgs?.length ?? 0;
                const fixed = fn.constArgs === undefined ? e.args.length : e.args.length - want;
                for (let i = 0; i < fixed; i++) walk(e.args[i]!);
                for (let i = fixed; i < e.args.length; i++) {
                    const a = e.args[i]!;
                    if (a.kind === "num") { program.params.add(String(a.v)); continue; }
                    if (a.kind === "name" && a.n.toUpperCase() in params) { program.params.add(a.n.toUpperCase()); continue; }
                    // 本地变量窗口（TDX 网文公式惯用 LLV(X,X) 类写法）：编译期放行，
                    // 运行期取该变量末值当窗口常量（consts 提取处回退链）
                    if (a.kind === "name" && locals.has(a.n.toUpperCase())) { continue; }
                    // 动态窗口特例（2026-11-02 用户公式移植）：REF(X, BARSLAST(cond))
                    // ——窗口参运行期逐点，其余窗口函数仍严静态（SC2 原则的受控破口）
                    if (a.kind === "call" && e.fn === "REF" && a.fn === "BARSLAST") { walk(a); continue; }
                    const got = a.kind === "name" ? `名字 "${a.n}"（未在 params 提供）`
                        : a.kind === "call" ? `表达式（BARSLAST 仅 REF 第二参支持动态）` : "表达式（不支持）";
                    throw new FormulaError(`${e.fn} 窗口参须为数字字面量或参数名——${got}`, 0);
                }
                return;
            }
        }
    };
    for (const st of program.statements) walk(st.expr);
    if (opts.requireXg) {
        const xg = program.outputs.filter((o) => o === "XG");
        if (xg.length === 0) throw new FormulaError("选股公式必须恰有一个 XG: 输出行", 0);
    }
    return { program, params, indicators, outputs: program.outputs };
}

/** 基础行情绑定（C/O/H/L/V/AMOUNT 全别名 → 同一序列；TO=换手率百分数，
 *  hist-k 路径的 bar 无此字段 → null 序列；DRAWNULL=全 null，TDX 画线占位；
 *  AMO=AMOUNT 别名（TDX 惯用）；SETCODE 恒 0（A 股沪深分支恒真）。
 *  opts.floatSharesLots：TDX 股本表的流通股本（手）——注入则 CAPITAL=常量
 *  序列（TDX 财务口径本就是当前值），HSL/FINANCE 不再依赖换手率反推。 */
export function baseFromBars(bars: readonly KBar[], opts?: { floatSharesLots?: number }): Record<string, Series> {
    const toArr: Series = bars.map((b) => b.turnover ?? null);
    const capital = opts?.floatSharesLots !== undefined && opts.floatSharesLots > 0
        ? bars.map(() => opts.floatSharesLots!)
        : capitalSeries(bars.map((b) => b.volume), toArr);
    return {
        C: bars.map((b) => b.close), CLOSE: bars.map((b) => b.close),
        O: bars.map((b) => b.open), OPEN: bars.map((b) => b.open),
        H: bars.map((b) => b.high), HIGH: bars.map((b) => b.high),
        L: bars.map((b) => b.low), LOW: bars.map((b) => b.low),
        V: bars.map((b) => b.volume), VOL: bars.map((b) => b.volume), VOLUME: bars.map((b) => b.volume),
        AMOUNT: bars.map((b) => b.amount), AMO: bars.map((b) => b.amount),
        TO: toArr, TURNOVER: toArr,
        DRAWNULL: bars.map(() => null),
        SETCODE: bars.map(() => 0),
        CAPITAL: capital,
    };
}

export interface FormulaResult {
    /** 中间变量与输出（大写名 → 序列/条件）。 */
    values: Map<string, Val>;
    /** XG 条件（requireXg 公式专用）。 */
    xg?: Cond;
}

export function runFormula(f: CompiledFormula, base: Record<string, Series>,
    indicatorValues?: Map<string, Val>): FormulaResult {
    const values = new Map<string, Val>();
    const resolve = (n: string): Val => {
        const k = n.toUpperCase();
        const local = values.get(k);
        if (local !== undefined) return local;
        const b = base[k];
        if (b !== undefined) return b;
        const p = f.params[k];
        if (p !== undefined) return new Array(base.C!.length).fill(p);
        const ind = (indicatorValues ?? f.indicators)?.get(k);
        if (ind !== undefined) return ind;
        throw new FormulaError(`求值期未知名字：${n}`, 0);
    };
    const evalExpr = (e: Expr): Val => {
        switch (e.kind) {
            case "num": return new Array(base.C!.length).fill(e.v);
            case "str": return new Array(base.C!.length).fill(0); // 字符串参数占位（NAMELIKE 等不消费值）
            case "name": return resolve(e.n);
            case "un": {
                if (e.op === "NOT") return not(c(evalExpr(e.x)));
                return (v => v.map((x) => (x === null ? null : -x)))(s(evalExpr(e.x)));
            }
            case "bin": {
                if (e.op === "AND") return and(c(evalExpr(e.l)), c(evalExpr(e.r)));
                if (e.op === "OR") return or(c(evalExpr(e.l)), c(evalExpr(e.r)));
                const l = evalExpr(e.l), r = evalExpr(e.r);
                switch (e.op) {
                    case "+": return add(s(l), s(r));
                    case "-": return sub(s(l), s(r));
                    case "*": return mul(s(l), s(r));
                    case "/": return div(s(l), s(r));
                    // 数值比较同算术收缩（TDX 语义：条件=0/1 参与比较，X_36>0 恒等
                    // X_36——2026-11-02 漏票追凶：布尔直入 cmp 被当 null 致 X_37 假 false）
                    case ">": return gt(s(l), s(r));
                    case "<": return lt(s(l), s(r));
                    case ">=": return gte(s(l), s(r));
                    case "<=": return lte(s(l), s(r));
                    case "=": return eq(s(l), s(r));
                    case "!=": return ne(s(l), s(r));
                    default: throw new FormulaError(`未知运算符 ${e.op}`, 0);
                }
            }
            case "call": {
                const fn = BUILTIN_FUNCS[e.fn]!;
                const consts = (fn.constArgs ?? []).map((idx) => {
                    const a = e.args[idx]!;
                    if (a.kind === "num") return a.v;
                    if (a.kind === "name") {
                        const p = f.params[a.n.toUpperCase()];
                        if (p !== undefined) return p;
                        // 本地变量窗口：取该变量末有效值当窗口常量（顺序求值保证已入 values）
                        const lv = values.get(a.n.toUpperCase());
                        if (lv !== undefined) {
                            const sv = (typeof lv[0] === "boolean" ? (lv as Cond).map((b) => (b ? 1 : 0)) : lv as Series);
                            for (let i = sv.length - 1; i >= 0; i--) if (sv[i] !== null && sv[i] !== undefined) return sv[i]!;
                        }
                    }
                    // 动态窗口（BARSLAST call）：eval 侧自取序列，常量位给 NaN 占位
                    return Number.NaN;
                });
                return fn.eval(e.args.map((a) => evalExpr(a)), consts, base);
            }
        }
    };
    let xg: Cond | undefined;
    for (const st of f.program.statements) {
        const v = evalExpr(st.expr);
        values.set(st.name, v);
        if (st.isOutput && st.name === "XG") xg = c(v);
    }
    return { values, xg };
}
