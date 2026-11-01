// backtest/schema.ts——S13：回测面的 schema 词汇表（留存层 §五纪律的回测侧）。

export const SCHEMA = {
    HIST_K: "backtest.hist-k",
    /** 风格状态派生面（style-run 全量重写，digest 只读）。 */
    STYLE_STATE: "stocks.style-state",
} as const;
