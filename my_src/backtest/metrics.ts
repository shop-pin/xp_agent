// backtest/metrics.ts——S13：绩效计算（年化/最大回撤/回撤持续与修复/按年分层）
// + 净值/回撤文本曲线（研究面输出，验收的"文本曲线"项）。

export interface Metrics {
    totalReturn: number;
    annualized: number;
    maxDrawdown: number;
    /** 峰→谷 天数。 */
    ddDays: number;
    /** 谷→修复（净值重回峰值）天数；未修复 null。 */
    recoveryDays: number | null;
    yearly: { year: string; ret: number }[];
}

const YEAR_DAYS = 252;

export function computeMetrics(days: string[], equity: number[]): Metrics {
    if (equity.length < 2) throw new Error("净值序列太短（<2 点）");
    const totalReturn = equity[equity.length - 1]! / equity[0]! - 1;
    const annualized = Math.pow(1 + totalReturn, YEAR_DAYS / (equity.length - 1)) - 1;

    // 最大回撤 + 持续/修复
    let peak = equity[0]!;
    let peakIdx = 0;
    let maxDD = 0;
    let ddDays = 0;
    let recoveryDays: number | null = null;
    let troughIdx = 0;
    for (let i = 1; i < equity.length; i++) {
        if (equity[i]! >= peak) {
            if (maxDD < 0 && recoveryDays === null) recoveryDays = i - troughIdx;
            peak = equity[i]!;
            peakIdx = i;
        } else {
            const dd = equity[i]! / peak - 1;
            if (dd < maxDD) {
                maxDD = dd;
                ddDays = i - peakIdx;
                troughIdx = i;
            }
        }
    }
    if (maxDD < 0 && recoveryDays === null) {
        // 尾部未修复：保持 null（未修复是重要事实，不藏）
        recoveryDays = null;
    }

    // 按年分层：年内收益 = 年末最后一值 / 年初首值 − 1（年与年之间用前一年末值衔接）
    const yearly: { year: string; ret: number }[] = [];
    let prev = equity[0]!;
    let curYear = days[0]!.slice(0, 4);
    let yearStart = equity[0]!;
    for (let i = 0; i < days.length; i++) {
        const y = days[i]!.slice(0, 4);
        if (y !== curYear) {
            yearly.push({ year: curYear, ret: prev / yearStart - 1 });
            curYear = y;
            yearStart = prev;
        }
        prev = equity[i]!;
    }
    yearly.push({ year: curYear, ret: prev / yearStart - 1 });

    return { totalReturn, annualized, maxDrawdown: maxDD, ddDays, recoveryDays, yearly };
}

const BLOCKS = "▁▂▃▄▅▆▇█";

/** 净值文本曲线（等距采样映射到 8 级块字符）+ 回撤百分比曲线。 */
export function textCurve(days: string[], equity: number[], width = 60): string {
    const sample = (arr: number[]): number[] => {
        if (arr.length <= width) return arr;
        const out: number[] = [];
        for (let i = 0; i < width; i++) {
            out.push(arr[Math.floor((i * (arr.length - 1)) / (width - 1))]!);
        }
        return out;
    };
    const eq = sample(equity);
    const lo = Math.min(...eq);
    const hi = Math.max(...eq);
    const span = hi - lo || 1;
    const eqLine = [...eq].reverse().map((v) => BLOCKS[Math.min(7, Math.floor(((v - lo) / span) * 8))]).join("");

    let peak = equity[0]!;
    const dd = equity.map((v) => {
        peak = Math.max(peak, v);
        return (v / peak - 1) * 100;
    });
    const dds = sample(dd);
    const ddLine = [...dds].reverse().map((v) => BLOCKS[Math.min(7, Math.floor((Math.abs(v) / 30) * 8))]).join("");

    const head = days.length > 0 ? days[0]! : "";
    const tail = days.length > 0 ? days[days.length - 1]! : "";
    return [`净值 ${head} → ${tail}（左=起点）`, eqLine, `回撤%`, ddLine].join("\n");
}
