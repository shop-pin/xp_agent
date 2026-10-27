// 跟踪期单测：digest 纯函数手算对拍——T+N 收益窗（停牌跳过/窗口未满）、
// 裁决与规则聚合（信心档拆分/胜率/排序）、账本持仓重建（含费成本、比例结转、
// 卖超跳过）、市场概览（中位数）。每个数字在注释里推。运行：npm run cordis
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
    windowReturns, gradeVerdicts, aggregateVerdicts, gradeSignals, aggregateRules,
    positionsFromFills, marketOverview, type Series, type VerdictGrade, type SignalGrade,
} from '../backtest/digest.js'

// ---------- 收益窗 ----------

test('windowReturns：手算 T+1/T+3，停牌跳过与窗口未满', () => {
    // d2 停牌（不在序列）——T+1 按该票自己的日历数：d1 的 T+1 = d3
    const s: Series = new Map([
        ["2026-10-20", 10], ["2026-10-21", 11], ["2026-10-22", 9.9], ["2026-10-23", 12],
    ])
    const [r1, r3] = windowReturns(s, "2026-10-20", [1, 3])
    assert.ok(Math.abs(r1! - 0.1) < 1e-9, '11/10 − 1')
    assert.ok(Math.abs(r3! - 0.2) < 1e-9, '12/10 − 1（d2 停牌跳过，第 3 根是 d4）')
    // d3 起只有 1 根后续——T+1 有、T+3 未满 null
    const [a, b] = windowReturns(s, "2026-10-22", [1, 3])
    assert.ok(Math.abs(a! - (12 / 9.9 - 1)) < 1e-9)
    assert.equal(b, null)
    // 当日起算日不在序列 / 收盘 0（停牌残行）：全 null
    assert.deepEqual(windowReturns(s, "2026-10-19", [1]), [null])
    assert.deepEqual(windowReturns(new Map([["2026-10-20", 0], ["2026-10-21", 5]]), "2026-10-20", [1]), [null])
})

// ---------- 裁决打分与聚合 ----------

const SERIES_OF = new Map<string, Series>([
    ["sh600001", new Map([["2026-10-20", 10], ["2026-10-21", 11]])],
])

test('gradeVerdicts：有码打分、无码 null（缺序列不炸）', () => {
    const gs = gradeVerdicts([
        { day: "2026-10-20", code: "sh600001", action: "buy-candidate", confidence: 0.8 },
        { day: "2026-10-20", code: "sz000009", action: "avoid", confidence: 0.3 },
    ], (c) => SERIES_OF.get(c))
    assert.ok(Math.abs(gs[0]!.ret1! - 0.1) < 1e-9)
    assert.equal(gs[0]!.ret3, null, '窗口未满')
    assert.equal(gs[1]!.ret1, null)
})

test('aggregateVerdicts：action × 信心档拆分，n/均值/胜率手算', () => {
    const g = (action: string, tierConf: number, ret1: number | null, ret3: number | null = null): VerdictGrade =>
        ({ day: "2026-10-20", code: "sh600001", action, confidence: tierConf, ret1, ret3 })
    const rows = aggregateVerdicts([
        // buy-candidate/high：T+1 = [10%, −2%] → n2 均 +4% 胜率 0.5；T+3 = [null, 6%] → n1 均 6% 胜率 1
        g("buy-candidate", 0.8, 0.10, null),
        g("buy-candidate", 0.9, -0.02, 0.06),
        // avoid/normal：T+1 = [−5%] → n1 均 −5% 胜率 0
        g("avoid", 0.3, -0.05),
        // watch/normal + avoid/high（0.8 恰在高档界上）
        g("watch", 0.5, null),
        g("avoid", 0.8, 0.01),
    ])
    const find = (action: string, tier: string) => rows.find((r) => r.action === action && r.tier === tier)!
    const bh = find("buy-candidate", "high")
    assert.equal(bh.ret1.n, 2)
    assert.ok(Math.abs(bh.ret1.avg! - 0.04) < 1e-9)
    assert.equal(bh.ret1.win, 0.5)
    assert.equal(bh.ret3.n, 1)
    assert.ok(Math.abs(bh.ret3.avg! - 0.06) < 1e-9)
    assert.equal(find("avoid", "normal").ret1.avg, -0.05)
    assert.equal(find("avoid", "high").ret1.n, 1, 'confidence 0.8 记高档（≥ 界）')
    assert.equal(find("watch", "normal").ret1.n, 0, 'null 窗口不进 n——样本量与均值分开说')
})

// ---------- 信号规则打分与聚合 ----------

test('aggregateRules：规则 × 方向聚合，n 降序排序', () => {
    const gs: SignalGrade[] = [
        { code: "sh600001", rule: "breakout", direction: "up", day: "d", ret1: 0.02 },
        { code: "sh600002", rule: "breakout", direction: "up", day: "d", ret1: -0.01 },
        { code: "sh600003", rule: "book-pressure", direction: "down", day: "d", ret1: null },
    ]
    const rows = aggregateRules(gradeSignals(
        [
            { code: "sh600001", name: "甲", rule: "breakout", direction: "up", strength: 1, note: "", at: 0, day: "2026-10-20" },
            { code: "sh600002", name: "乙", rule: "breakout", direction: "up", strength: 1, note: "", at: 0, day: "2026-10-20" },
            { code: "sh600003", name: "丙", rule: "book-pressure", direction: "down", strength: 1, note: "", at: 0, day: "2026-10-20" },
        ],
        (c) => SERIES_OF.get(c),
    ))
    // 甲有序列（d20→d21 = 10→11）→ ret1 = 0.1；乙丙无序列 → null
    assert.equal(rows.length, 2)
    assert.equal(rows[0]!.rule, "breakout", 'n 降序：breakout n1 在前')
    assert.ok(Math.abs(rows[0]!.ret1.avg! - 0.1) < 1e-9)
    assert.equal(rows[1]!.rule, "book-pressure")
    assert.equal(rows[1]!.ret1.n, 0)
    // 手算路径：直接给 grades——breakout/up n2 均 +0.5% 胜率 0.5
    const rows2 = aggregateRules(gs)
    assert.equal(rows2[0]!.rule, "breakout")
    assert.equal(rows2[0]!.ret1.n, 2)
    assert.ok(Math.abs(rows2[0]!.ret1.avg! - 0.005) < 1e-9)
    assert.equal(rows2[0]!.ret1.win, 0.5)
    assert.equal(rows2[1]!.ret1.n, 0)
})

// ---------- 持仓重建 ----------

test('positionsFromFills：含费成本、卖出比例结转、乱序输入、卖超跳过', () => {
    const f = (at: number, code: string, side: "buy" | "sell", price: number, qty: number, fee: number) =>
        ({ orderId: `o${at}`, at, code, side, price, qty, fee, realizedPnl: null })
    // 乱序输入（at5 在 at1 前）——内部按 at 排序重建
    const rows = positionsFromFills([
        f(5, "sh600001", "sell", 25, 100, 7),
        f(2, "sh600001", "buy", 10, 100, 5),   // qty100 cost 1005
        f(1, "sz000002", "buy", 3, 200, 5),    // qty200 cost 605
        f(3, "sh600001", "buy", 20, 100, 6),   // qty200 cost 3011
        f(6, "sh600003", "sell", 9, 100, 5),   // 卖超（无持仓）——跳过
    ])
    assert.deepEqual(rows, [
        { code: "sh600001", qty: 100, cost: 1505.5 },  // 3011 × (1 − 100/200)
        { code: "sz000002", qty: 200, cost: 605 },
    ])
})

// ---------- 市场概览 ----------

test('marketOverview：涨跌平家数 + 中位涨幅（奇偶两算）', () => {
    const o = marketOverview([{ chg: 0.5 }, { chg: -1.2 }, { chg: 0 }, { chg: 3.1 }, { chg: -0.2 }])
    assert.deepEqual([o.up, o.down, o.flat], [2, 2, 1])
    assert.ok(Math.abs(o.medianChg! - 0) < 1e-9, '排序 [−1.2,−0.2,0,0.5,3.1] 中位 = 0')
    const o2 = marketOverview([{ chg: 1 }, { chg: 2 }, { chg: 3 }, { chg: 4 }])
    assert.ok(Math.abs(o2.medianChg! - 2.5) < 1e-9, '偶数取中间两数均值')
    const o3 = marketOverview([])
    assert.equal(o3.medianChg, null)
})
