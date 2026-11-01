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
    barsLast, barsCount, add, sub, mul, div, abs, type Series, type Cond,
} from "./indicators.js";
import type { KBar } from "./kline.js";

// ---------- 词法 ----------

type Tok =
    | { kind: "num"; v: number }
    | { kind: "ident"; name: string }
    | { kind: "op"; op: string };

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
        const rest = text.slice(i);
        const num = NUM_RE.exec(rest);
        if (num) { toks.push({ kind: "num", v: Number(num[0]) }); i += num[0].length; continue; }
        const ident = IDENT_RE.exec(rest);
        if (ident) { toks.push({ kind: "ident", name: ident[0] }); i += ident[0].length; continue; }
        const two = rest.slice(0, 2);
        if (two === ":=" || two === "<=" || two === ">=" || two === "<>" || two === "!=" || two === "==") {
            toks.push({ kind: "op", op: two === "==" ? "=" : two === "<>" ? "!=" : two });
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
    | { kind: "bin"; op: string; l: Expr; r: Expr }
    | { kind: "un"; op: string; x: Expr }
    | { kind: "call"; fn: string; args: Expr[] };

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
            const got = t === undefined ? "EOF" : t.kind === "op" ? t.op : t.kind === "num" ? String(t.v) : t.name;
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
            const name = this.ident();
            let isOutput: boolean;
            if (this.isOp(":=")) { isOutput = false; this.i++; }
            else if (this.isOp(":")) { isOutput = true; this.i++; }
            else throw new FormulaError(`期望 ":=" 或 ":"（变量 ${name}）`, this.i);
            const expr = this.parseExpr();
            this.eatOp(";");
            statements.push({ name: name.toUpperCase(), isOutput, expr });
            if (isOutput) outputs.push(name.toUpperCase());
        }
        if (statements.length === 0) throw new FormulaError("空公式", 0);
        return { statements, outputs, params: new Set() };
    }

    parseExpr(): Expr { return this.parseOr(); }
    private parseOr(): Expr {
        let l = this.parseAnd();
        while (this.isKeyword("OR")) { this.i++; l = { kind: "bin", op: "OR", l, r: this.parseAnd() }; }
        return l;
    }
    private parseAnd(): Expr {
        let l = this.parseNot();
        while (this.isKeyword("AND")) { this.i++; l = { kind: "bin", op: "AND", l, r: this.parseNot() }; }
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
    eval: (args: Val[], consts: number[]) => Val;
};

const s = (v: Val): Series => (typeof v[0] === "boolean" ? (v as Cond).map((b) => (b ? 1 : 0)) : v as Series);
const c = (v: Val): Cond => (typeof v[0] === "boolean" ? v as Cond : (v as Series).map((x) => x !== null && x !== undefined && x > 0));

export const BUILTIN_FUNCS: Record<string, FnDef> = {
    MA: { constArgs: [1], eval: (a, k) => ma(s(a[0]!), k[0]!) },
    EMA: { constArgs: [1], eval: (a, k) => ema(s(a[0]!), k[0]!) },
    SMA: { constArgs: [1, 2], eval: (a, k) => sma(s(a[0]!), k[0]!, k[1]!) },
    REF: { constArgs: [1], eval: (a, k) => ref(s(a[0]!), k[0]!) },
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
    const bases = new Set(["C", "O", "H", "L", "V", "VOL", "CLOSE", "OPEN", "HIGH", "LOW", "VOLUME", "AMOUNT"]);
    const walk = (e: Expr): void => {
        switch (e.kind) {
            case "num": return;
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
                    const got = a.kind === "name" ? `名字 "${a.n}"（未在 params 提供）` : "表达式（不支持）";
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

/** 基础行情绑定（C/O/H/L/V/AMOUNT 全别名 → 同一序列）。 */
export function baseFromBars(bars: readonly KBar[]): Record<string, Series> {
    return {
        C: bars.map((b) => b.close), CLOSE: bars.map((b) => b.close),
        O: bars.map((b) => b.open), OPEN: bars.map((b) => b.open),
        H: bars.map((b) => b.high), HIGH: bars.map((b) => b.high),
        L: bars.map((b) => b.low), LOW: bars.map((b) => b.low),
        V: bars.map((b) => b.volume), VOL: bars.map((b) => b.volume), VOLUME: bars.map((b) => b.volume),
        AMOUNT: bars.map((b) => b.amount),
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
                    case ">": return gt(l, r);
                    case "<": return lt(l, r);
                    case ">=": return gte(l, r);
                    case "<=": return lte(l, r);
                    case "=": return eq(l, r);
                    case "!=": return ne(l, r);
                    default: throw new FormulaError(`未知运算符 ${e.op}`, 0);
                }
            }
            case "call": {
                const fn = BUILTIN_FUNCS[e.fn]!;
                const consts = (fn.constArgs ?? []).map((idx) => {
                    const a = e.args[idx]!;
                    if (a.kind === "num") return a.v;
                    const p = f.params[(a as { kind: "name"; n: string }).n.toUpperCase()];
                    if (p !== undefined) return p;
                    throw new FormulaError(`${e.fn} 第 ${idx + 1} 参须为常量`, 0);
                });
                return fn.eval(e.args.map((a) => evalExpr(a)), consts);
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
