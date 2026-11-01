// backtest/style.ts——风格状态（研究面，零 LLM）：微盘/大盘等权指数 + spread
// + MAN 趋势闸位置。择时前置②（2026-11-01 周末分析观测面的落地半边）。
//
// 口径①（同 backtest/run 头注）：静态市值五分位——微盘=流通市值最小 20%、
// 大盘=最大 20%，成员集由调用侧给定（今日 floatCap 锚，历史按价格缩放近似）。
// 指数 = 成员日均收益逐日复利（起点 1）；闸位 = 当日微盘指数收盘 > MAw
// （含当日的近 w 日水平均值）——t 收盘定 t+1 仓的观察面等价形。
//
// 状态落 <dataRoot>/style-state.jsonl（schema 头 + 逐日行，全量重写——派生
// 数据可再生），digest 只读最新行打注记：生成与消费分离，digest 保持零网络。

/** 单日风格输入：day + 两腿当日等权均收益 + 微盘腿覆盖只数。 */
export interface StyleDayInput {
    day: string;
    micro: number;
    macro: number;
    coverage: number;
}

/** 单日风格状态行（style-state.jsonl 的数据行）。 */
export interface StyleStateRow {
    day: string;
    /** 微盘/大盘等权指数水平（起点 1，逐日复利）。 */
    micro: number;
    macro: number;
    /** 当日 spread = 微盘日均收益 − 大盘日均收益。 */
    daySpread: number;
    /** 近 5 个交易日 daySpread 之和（含当日；不足 5 日按实有数）——近端方向感。 */
    spread5: number;
    /** w（字符串键）→ 闸位：micro > MAw（含当日）。 */
    ma: Record<string, boolean>;
    /** 当日微盘腿样本数——覆盖过薄的日子读数不可信（2023 年教训）。 */
    coverage: number;
}

export const STYLE_WINDOWS = [100, 150, 200, 250] as const;

/** 全序列构建（纯函数）：输入按日升序；每日一行状态（含指数、spread、闸位）。
 *  覆盖为 0 的日子照样成行（micro/macro 记 0 收益、闸位沿用上一日）——数据断供
 *  与"风格平静"必须可区分。 */
export function buildStyleState(
    daily: readonly StyleDayInput[],
    windows: readonly number[] = STYLE_WINDOWS,
): StyleStateRow[] {
    const rows: StyleStateRow[] = [];
    const levels: number[] = [];
    let micro = 1;
    let macro = 1;
    const spreads: number[] = [];
    let prevMa: Record<string, boolean> = {};
    for (const d of daily) {
        micro *= 1 + d.micro;
        macro *= 1 + d.macro;
        levels.push(micro);
        const daySpread = d.micro - d.macro;
        spreads.push(daySpread);
        const ma: Record<string, boolean> = {};
        for (const w of windows) {
            const n = Math.min(w, levels.length);
            let maSum = 0;
            for (let k = levels.length - n; k < levels.length; k++) maSum += levels[k]!;
            ma[String(w)] = micro > maSum / n;
        }
        const tail = spreads.slice(-5);
        const spread5 = tail.reduce((a, b) => a + b, 0);
        const row: StyleStateRow = {
            day: d.day,
            micro, macro,
            daySpread,
            spread5,
            ma: d.coverage > 0 ? ma : { ...prevMa },
            coverage: d.coverage,
        };
        rows.push(row);
        prevMa = row.ma;
    }
    return rows;
}
