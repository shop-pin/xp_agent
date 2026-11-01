// backtest/formulas/builtin.ts——SC3：内置公式库（product 层随产品发货，同
// skills 先例）。标准指标（主图/副图）与示例选股公式都是公式库条目——由
// SC2 解释器求值，解释器能算标准指标 = 体系自证。
//
// 参数：公式体引用参数名，值在 def.params（TDX 界面调参的对应物）。
// 口径：TDX 同参——MACD(12,26,9)、KDJ(9,3,3)；MA 族含五日/十日/月线(MA20)/
// 半年线(MA120)/年线(MA250)。周线/月线均线 = 重采样 K 上的同名公式
// （kseries 重采样 → 同一公式跑，周期切换在调用侧，不在公式内）。

export interface IndicatorDef {
    id: string;
    name: string;
    /** 主图（叠加价格）/ 副图（独立窗格）——展示语义，SC4 报告引用。 */
    kind: "main" | "sub";
    note: string;
    params?: Record<string, number>;
    formula: string;
}

export interface ScreenerDef {
    id: string;
    name: string;
    note: string;
    /** 装卸开关：false = 注册但不参跑。 */
    enabled: boolean;
    params?: Record<string, number>;
    formula: string;
}

export const BUILTIN_INDICATORS: IndicatorDef[] = [
    {
        id: "MA", name: "均线族", kind: "main",
        note: "五日/十日/月线(MA20)/季线(MA60)/半年线(MA120)/年线(MA250)；周线月线均线=重采样K上同名公式",
        formula: "MA5:MA(C,5); MA10:MA(C,10); MA20:MA(C,20); MA60:MA(C,60); MA120:MA(C,120); MA250:MA(C,250);",
    },
    {
        id: "MACD", name: "指数平滑异同均线", kind: "sub", params: { P1: 12, P2: 26, P3: 9 },
        note: "TDX 同参：DIF=EMA(C,P1)-EMA(C,P2)；DEA=EMA(DIF,P3)；MACD=(DIF-DEA)*2",
        formula: "DIF:EMA(C,P1)-EMA(C,P2); DEA:EMA(DIF,P3); MACD:(DIF-DEA)*2;",
    },
    {
        id: "KDJ", name: "随机指标", kind: "sub", params: { P1: 9, P2: 3, P3: 3 },
        note: "TDX 同参：RSV=(C-LLV(L,P1))/(HHV(H,P1)-LLV(L,P1))*100；K=SMA(RSV,P2,1)；D=SMA(K,P3,1)；J=3K-2D",
        formula: "RSV:=(C-LLV(L,P1))/(HHV(H,P1)-LLV(L,P1))*100; K:SMA(RSV,P2,1); D:SMA(K,P3,1); J:3*K-2*D;",
    },
    {
        id: "VOL", name: "量能族", kind: "sub",
        note: "5/10 日量均线 + 量比（V/MA(V,5)）——放量语义的副图读数",
        formula: "V5:MA(V,5); V10:MA(V,10); VR:V/MA(V,5);",
    },
];

export const BUILTIN_SCREENERS: ScreenerDef[] = [
    {
        id: "ma-golden", name: "均线金叉", enabled: true,
        note: "MA(C,N) 上穿 MA(C,M)（N<M）——趋势起点的原型公式",
        params: { N: 5, M: 10 },
        formula: "MA1:MA(C,N); MA2:MA(C,M); XG:CROSS(MA1,MA2);",
    },
    {
        id: "macd-golden", name: "MACD 金叉", enabled: true,
        note: "DIF 上穿 DEA（零轴下金叉=超跌反弹、零轴上=趋势延续，报告注记不区分）",
        formula: "XG:CROSS(MACD.DIF, MACD.DEA);",
    },
    {
        id: "kdj-golden", name: "KDJ 金叉（超卖区）", enabled: true,
        note: "K 上穿 D 且当日 K<50——低位共振才选出，高位钝化不选",
        formula: "XG:CROSS(KDJ.K, KDJ.D) AND KDJ.K < 50;",
    },
    {
        id: "vol-surge", name: "放量上攻", enabled: true,
        note: "量比≥P1 且收阳——量价共振的原型",
        params: { P1: 2 },
        formula: "XG:V >= MA(V,5)*P1 AND C > REF(C,1);",
    },
    {
        id: "breakout-high", name: "创 N 日新高", enabled: true,
        note: "收盘价创 P1 日新高（含当日）",
        params: { P1: 20 },
        formula: "XG:C >= HHV(H,P1);",
    },
];
