// plugins/strategy.ts——S14：策略即配置（交易系统成型的收敛点）。
//
// 全系统的策略参数住在这里一处：TS 字面量 DEFAULT 是唯一权威（类型化、零
// 漂移搬家自各插件的历史硬编码值）；用户覆盖文件 ~/.mini-claude/stocks/
// strategy.json 做**节级深合并**——调试期调参 = 改一份文件，回测器与盯盘系统
// 消费同一份（S14 验收：同一策略配置产出一致行为）。坏配置**明确拒读**不静默
// 回退（§五"不许静默错解"）。
//
// 一页纸文档：my_docs/strategy-one-pager.md（入场/离场/仓位/风控四节，规则 →
// 配置键映射 + 现状缺口）。改动纪律：先改 one-pager，再改 DEFAULT，最后改代码。

import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

export interface UniverseConfig {
    /** 日累计成交额下限（元）——引擎宇宙闸。 */
    amountMin: number;
    excludeBJ: boolean;
    excludeST: boolean;
}

export interface SignalsConfig {
    /** rapid-move：5min 涨速门槛 %。 */
    rapidMovePct: number;
    /** volume-surge：量率倍数 / 5min 变动 % / probe 分钟成交额（元）/ 累计换手 %。 */
    volumeSurgeX: number;
    volumeSurgeChgPct: number;
    volumeSurgeAmountPerMin: number;
    volumeSurgeTurnover: number;
    /** breakout：量能硬门槛倍数 / 幅度下限 % / 幅度腿 tick 数 / 量率腿倍数。 */
    breakoutBaseSurgeX: number;
    breakoutMinPct: number;
    breakoutTicks: number;
    breakoutSurgeX: number;
    /** book-pressure：压力阈值 / 同向 5min 变动 %。 */
    bookPressure: number;
    bookPressureChgPct: number;
    /** volume-divergence：背离段变动 % / 量率上限倍数。 */
    divergenceChgPct: number;
    divergenceSurgeX: number;
    /** 重发纪律。 */
    cooldownMs: number;
    dailyFireCap: number;
    refireGrowth: number;
    flipGrowth: number;
}

export interface WatchConfig {
    /** 信号唤醒最小间隔 ms。 */
    signalCooldownMs: number;
    /** 信箱最大待醒年龄 ms。 */
    maxSignalAgeMs: number;
    /** 同 code 每日唤醒上限。 */
    perCodeWakeCap: number;
    /** 收盘收口链（2026-10-29 方案 C）：复盘 turn 结束后跑 digest-run 编译
     *  + 宿主自退——挂机模式无人值守（早开会话、收盘自动收尾）。交互默认关。 */
    closeOutAfterReview: boolean;
}

export interface RiskConfig {
    /** 单票市值占净资产上限（guard ⑤）。 */
    maxPositionPct: number;
    /** 单日已实现亏损上限（元，guard ④）——15,000 = 300k 账户的 5%/日（挂账 #2 已收紧）。 */
    maxDailyLoss: number;
}

export interface ExitConfig {
    /** 止损线（2026-10-22 用户定 −5%）：相对含费成本，只对 T+1 可卖部分生效；
     *  触发 = watch 持仓风控唤醒裁决，不自动卖。0 = 关。 */
    stopLossPct: number;
    /** 移动止盈（2026-10-31 用户定 −5%）：现价 ≤ 持有期峰值×(1−5%) 且回撤线
     *  高于止损线（锁利位有效才接管）→ 同一风控唤醒裁决。0 = 关。 */
    trailingStopPct: number;
}

export interface PoolConfig {
    topN: number;
    amountMin: number;
    priceMin: number;
    peMin: number;
    peMax: number;
    /** 剔创业板+科创板（挂账#8 开关，2026-10-31；默认 false 行为零漂移）。 */
    excludeCK: boolean;
    pbMin: number;
    recentDays: number;
}

export interface BacktestConfig {
    /** 单边滑点（0.002 = ±0.2%）。 */
    slippage: number;
    initialCash: number;
}

export interface StrategyConfig {
    universe: UniverseConfig;
    signals: SignalsConfig;
    watch: WatchConfig;
    risk: RiskConfig;
    exit: ExitConfig;
    pool: PoolConfig;
    backtest: BacktestConfig;
}

/** 默认策略（唯一权威——值 = 各插件历史硬编码的零漂移搬家）。 */
export const DEFAULT_STRATEGY: StrategyConfig = {
    universe: { amountMin: 1e7, excludeBJ: true, excludeST: true },
    signals: {
        rapidMovePct: 3,
        volumeSurgeX: 2.5, volumeSurgeChgPct: 1, volumeSurgeAmountPerMin: 3e5, volumeSurgeTurnover: 0.5,
        breakoutBaseSurgeX: 1.5, breakoutMinPct: 0.5, breakoutTicks: 2, breakoutSurgeX: 2.5,
        bookPressure: 0.6, bookPressureChgPct: 1,
        divergenceChgPct: 1.5, divergenceSurgeX: 0.8,
        cooldownMs: 300_000, dailyFireCap: 2, refireGrowth: 1.5, flipGrowth: 2,
    },
    watch: { signalCooldownMs: 180_000, maxSignalAgeMs: 360_000, perCodeWakeCap: 2, closeOutAfterReview: false },
    risk: { maxPositionPct: 0.2, maxDailyLoss: 15_000 },
    exit: { stopLossPct: 0.05, trailingStopPct: 0.05 },
    pool: { topN: 20, amountMin: 3e7, priceMin: 2, peMin: 0, peMax: 300, excludeCK: false, pbMin: 0, recentDays: 365 },
    backtest: { slippage: 0.002, initialCash: 1_000_000 },
};

export function userStrategyPath(): string {
    return join(homedir(), ".mini-claude", "stocks", "strategy.json");
}

/** 加载策略：DEFAULT < 用户覆盖（节级深合并）。覆盖文件不可解析 → 抛错
 *  （明确拒读，不静默回退默认——错配的策略比启动失败危险）。 */
export function loadStrategy(userPath?: string): StrategyConfig {
    const path = userPath ?? userStrategyPath();
    if (!existsSync(path)) return DEFAULT_STRATEGY;
    let user: Partial<StrategyConfig>;
    try {
        user = JSON.parse(readFileSync(path, "utf-8")) as Partial<StrategyConfig>;
    } catch (e) {
        throw new Error(`strategy.json 不可解析（${path}）：${e instanceof Error ? e.message : String(e)}`);
    }
    return {
        universe: { ...DEFAULT_STRATEGY.universe, ...user.universe },
        signals: { ...DEFAULT_STRATEGY.signals, ...user.signals },
        watch: { ...DEFAULT_STRATEGY.watch, ...user.watch },
        risk: { ...DEFAULT_STRATEGY.risk, ...user.risk },
        exit: { ...DEFAULT_STRATEGY.exit, ...user.exit },
        pool: { ...DEFAULT_STRATEGY.pool, ...user.pool },
        backtest: { ...DEFAULT_STRATEGY.backtest, ...user.backtest },
    };
}
