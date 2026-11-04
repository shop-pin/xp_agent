// backtest/schema.ts——S13：回测面的 schema 词汇表（留存层 §五纪律的回测侧）。

export const SCHEMA = {
    HIST_K: "backtest.hist-k",
    /** 风格状态派生面（style-run 全量重写，digest 只读）。 */
    STYLE_STATE: "stocks.style-state",
    /** 选股结果（screener-run 全量重写，复盘/并入 watchlist 的原料面）。 */
    SCREENER: "stocks.screener",
    /** 板块归属面（TDX 题材面刷新全量重写，选股分组/盘后精选只读）。 */
    SECTOR: "stocks.sector",
    /** 流通股本面（capital-refresh-tdx.py 刷新，选股 CAPITAL 注入只读）。 */
    SHARES: "stocks.shares",
} as const;
