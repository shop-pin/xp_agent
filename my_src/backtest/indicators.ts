// backtest/indicators.ts——SC2：TDX 指标原语库（研究面，纯函数）。
//
// 语义对齐通达信公式系统：
//   * Series = (number|null)[]——头部空窗为 null（窗口不满/引用越界），K 线
//     本体无内部空窗（停牌日没有 bar，天然连续）。
//   * 条件（比较/CROSS）产出 boolean[]——null 参与 = false（选股语义：
//     无效不选出，保守方向）。
//   * MA/HHV 等 N 窗口函数在凑满 N 根前返回 null（TDX 同款画不出）。
//   * EMA/SMA 是全序列递推（首根播种），TDX 同款。
//
// 除零语义：TDX 中 X/0 产生无效值——这里除数为 0 时该位 null（不炸）。

export type Series = (number | null)[];

/** 逐元素二元运算（null 传播：任一侧 null → 该位 null）。 */
export function zip2(a: Series, b: Series, op: (x: number, y: number) => number): Series {
    const n = Math.max(a.length, b.length);
    const out: Series = new Array(n).fill(null);
    for (let i = 0; i < n; i++) {
        const x = a[i], y = b[i];
        if (x === null || x === undefined || y === null || y === undefined) continue;
        const v = op(x, y);
        if (Number.isFinite(v)) out[i] = v;
    }
    return out;
}

const lift = (a: Series, f: (x: number) => number): Series =>
    a.map((x) => (x === null || x === undefined ? null : Number.isFinite(f(x)) ? f(x) : null));

// ---------- 均线族 ----------

export function ma(x: Series, n: number): Series {
    const out: Series = new Array(x.length).fill(null);
    let sum = 0;
    let run = 0; // 以 i 结尾的连续有效长度（遇 null 归零——窗口含无效=无效，TDX 同款）
    for (let i = 0; i < x.length; i++) {
        const v = x[i];
        if (v === null || v === undefined) { run = 0; sum = 0; continue; }
        sum += v;
        run++;
        if (run > n) { sum -= x[i - n] as number; run = n; } // x[i-n] 必非 null（连续性保证）
        if (run === n) out[i] = sum / n;
    }
    return out;
}

export function ema(x: Series, n: number): Series {
    const out: Series = new Array(x.length).fill(null);
    const k = 2 / (n + 1);
    let prev: number | null = null;
    for (let i = 0; i < x.length; i++) {
        const v = x[i];
        if (v === null || v === undefined) { prev = null; continue; }
        prev = prev === null ? v : (2 * v + (n - 1) * prev) / (n + 1);
        out[i] = prev;
    }
    return out;
}

/** TDX 特有 SMA(X,N,M)：Y = (M*X + (N-M)*Y') / N，首根播种。 */
export function sma(x: Series, n: number, m: number): Series {
    const out: Series = new Array(x.length).fill(null);
    let prev: number | null = null;
    for (let i = 0; i < x.length; i++) {
        const v = x[i];
        if (v === null || v === undefined) { prev = null; continue; }
        prev = prev === null ? v : (m * v + (n - m) * prev) / n;
        out[i] = prev;
    }
    return out;
}

// ---------- 时序引用与窗口统计 ----------

export function ref(x: Series, n: number): Series {
    const out: Series = new Array(x.length).fill(null);
    for (let i = n; i < x.length; i++) out[i] = x[i - n] ?? null;
    return out;
}

function windowStat(x: Series, n: number, better: (a: number, b: number) => number): Series {
    const out: Series = new Array(x.length).fill(null);
    for (let i = 0; i < x.length; i++) {
        if (i < n - 1) continue;
        let acc: number | null = null;
        for (let j = i - n + 1; j <= i; j++) {
            const v = x[j]!;
            if (v === null || v === undefined) { acc = null; break; }
            acc = acc === null ? v : better(acc, v);
        }
        out[i] = acc;
    }
    return out;
}

export const hhv = (x: Series, n: number): Series => windowStat(x, n, Math.max);
export const llv = (x: Series, n: number): Series => windowStat(x, n, Math.min);

/** HHVBARS(X,N)：N 窗内最高值距今天的 bar 数（0=今天就是最高）。 */
export function hhvBars(x: Series, n: number): Series {
    const hi = hhv(x, n);
    const out: Series = new Array(x.length).fill(null);
    for (let i = 0; i < x.length; i++) {
        const h = hi[i];
        if (h === null) continue;
        for (let j = i; j >= i - n + 1; j--) {
            if (x[j] === h) { out[i] = i - j; break; }
        }
    }
    return out;
}
export const llvBars = (x: Series, n: number): Series => {
    const lo = llv(x, n);
    const out: Series = new Array(x.length).fill(null);
    for (let i = 0; i < x.length; i++) {
        const l = lo[i];
        if (l === null) continue;
        for (let j = i; j >= i - n + 1; j--) {
            if (x[j] === l) { out[i] = i - j; break; }
        }
    }
    return out;
};

export function sum(x: Series, n: number): Series {
    const out: Series = new Array(x.length).fill(null);
    for (let i = 0; i < x.length; i++) {
        if (i < n - 1) continue;
        let acc = 0;
        let hasNull = false;
        for (let j = i - n + 1; j <= i; j++) {
            const v = x[j]!;
            if (v === null || v === undefined) { hasNull = true; break; }
            acc += v;
        }
        out[i] = hasNull ? null : acc;
    }
    return out;
}

/** STD(X,N)=样本标准差（n-1，TDX 估算标准差）；STDP=总体（n）。 */
function stdImpl(x: Series, n: number, ddof: number): Series {
    const out: Series = new Array(x.length).fill(null);
    for (let i = 0; i < x.length; i++) {
        if (i < n - 1) continue;
        let s = 0;
        let hasNull = false;
        for (let j = i - n + 1; j <= i; j++) {
            const v = x[j]!;
            if (v === null || v === undefined) { hasNull = true; break; }
            s += v;
        }
        if (hasNull) continue;
        const mean = s / n;
        let ss = 0;
        for (let j = i - n + 1; j <= i; j++) { const v = x[j]!; ss += (v - mean) * (v - mean); }
        const d = n - ddof;
        out[i] = d > 0 ? Math.sqrt(ss / d) : null;
    }
    return out;
}
export const std = (x: Series, n: number): Series => stdImpl(x, n, 1);
export const stdp = (x: Series, n: number): Series => stdImpl(x, n, 0);

// ---------- 条件面（boolean[]，null 参与 = false） ----------

export type Cond = boolean[];

const num = (s: Series | Cond, i: number): number | null => {
    const v = (s as (number | boolean | null)[])[i];
    return typeof v === "boolean" ? null : (v ?? null);
};

function cmp(a: Series | Cond, b: Series | Cond, ok: (x: number, y: number) => boolean): Cond {
    const n = Math.max(a.length, b.length);
    const out: Cond = new Array(n).fill(false);
    for (let i = 0; i < n; i++) {
        const x = num(a, i), y = num(b, i);
        if (x === null || y === null) continue;
        out[i] = ok(x, y);
    }
    return out;
}

export const gt = (a: Series | Cond, b: Series | Cond): Cond => cmp(a, b, (x, y) => x > y);
export const lt = (a: Series | Cond, b: Series | Cond): Cond => cmp(a, b, (x, y) => x < y);
export const gte = (a: Series | Cond, b: Series | Cond): Cond => cmp(a, b, (x, y) => x >= y);
export const lte = (a: Series | Cond, b: Series | Cond): Cond => cmp(a, b, (x, y) => x <= y);
export const eq = (a: Series | Cond, b: Series | Cond): Cond => cmp(a, b, (x, y) => x === y);
export const ne = (a: Series | Cond, b: Series | Cond): Cond => cmp(a, b, (x, y) => x !== y);

export function and(a: Cond, b: Cond): Cond {
    const n = Math.max(a.length, b.length);
    return Array.from({ length: n }, (_, i) => !!(a[i] && b[i]));
}
export function or(a: Cond, b: Cond): Cond {
    const n = Math.max(a.length, b.length);
    return Array.from({ length: n }, (_, i) => !!(a[i] || b[i]));
}
export function not(a: Cond): Cond {
    return a.map((v) => !v);
}

/** CROSS(A,B)：A 上穿 B——今 A>B 且昨 A≤B（任一侧无效=false）。 */
export function cross(a: Series | Cond, b: Series | Cond): Cond {
    const n = Math.max(a.length, b.length);
    const out: Cond = new Array(n).fill(false);
    for (let i = 1; i < n; i++) {
        const ax = num(a, i), bx = num(b, i), ay = num(a, i - 1), by = num(b, i - 1);
        if (ax === null || bx === null || ay === null || by === null) continue;
        out[i] = ax > bx && ay <= by;
    }
    return out;
}

// ---------- 条件统计族 ----------

export function count(c: Cond, n: number): Series {
    const out: Series = new Array(c.length).fill(null);
    for (let i = 0; i < c.length; i++) {
        if (i < n - 1) continue;
        let s = 0;
        for (let j = i - n + 1; j <= i; j++) s += c[j] ? 1 : 0;
        out[i] = s;
    }
    return out;
}
export const every = (c: Cond, n: number): Cond => {
    const s = count(c, n);
    return s.map((v, i) => (i < n - 1 ? false : v === n));
};
export const exist = (c: Cond, n: number): Cond => {
    const s = count(c, n);
    return s.map((v, i) => (i < n - 1 ? false : (v ?? 0) > 0));
};

/** BARSLAST(COND)：上一次条件成立到当前的 bar 数（从未成立=null）。 */
export function barsLast(c: Cond): Series {
    const out: Series = new Array(c.length).fill(null);
    let last: number | null = null;
    for (let i = 0; i < c.length; i++) {
        if (c[i]) last = i;
        out[i] = last === null ? null : i - last;
    }
    return out;
}

/** BARSCOUNT(X)：有效值计数（首个有效值起累计）——新股/停牌长度探测。 */
export function barsCount(x: Series): Series {
    const out: Series = new Array(x.length).fill(null);
    let started = false;
    let k = 0;
    for (let i = 0; i < x.length; i++) {
        if (!started && x[i] !== null && x[i] !== undefined) started = true;
        if (started) out[i] = ++k;
    }
    return out;
}

// ---------- 算术辅助（解释器二元/一元运算复用） ----------

export const add = (a: Series, b: Series): Series => zip2(a, b, (x, y) => x + y);
export const sub = (a: Series, b: Series): Series => zip2(a, b, (x, y) => x - y);
export const mul = (a: Series, b: Series): Series => zip2(a, b, (x, y) => x * y);
export const div = (a: Series, b: Series): Series => zip2(a, b, (x, y) => (y === 0 ? NaN : x / y));
export const abs = (a: Series): Series => lift(a, Math.abs);
