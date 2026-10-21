// S13 单测：回测引擎——东财 kline 解析 fixture 对拍、10 交易日重放手算对拍
// （费用复用 computeFee：佣金 max(5, 万2.5)+过户十万分之一+印花卖出万五，
// 滑点买 ×1.002 / 卖 ×0.998——每个数字在注释里推）、绩效手算、文本曲线。
// 运行：npm run cordis
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseTencentKlines } from '../backtest/kline.js'
import { replayRotation, type ReplayStock } from '../backtest/replay.js'
import { computeMetrics, textCurve } from '../backtest/metrics.js'

test('parseTencentKlines：fixture 对拍（2026-10-21 真响应录样，amount=近似④）', () => {
    // 2026-10-21 真响应节选（浦发银行 sh600000，量=手）
    const text = JSON.stringify({
        code: 0, msg: "", data: {
            sh600000: { qfqday: [
                ["2026-10-14", "9.600", "9.650", "9.710", "9.570", "595398.000"],
                ["2026-10-15", "9.650", "9.640", "9.700", "9.530", "685743.000"],
            ] },
        },
    })
    const bars = parseTencentKlines(text, "sh600000")
    assert.equal(bars.length, 2)
    // amount ≈ close × volume(手) × 100（近似④）：9.65 × 595398 × 100
    assert.deepEqual(bars[0], {
        day: "2026-10-14", open: 9.6, close: 9.65, high: 9.71, low: 9.57,
        volume: 595398, amount: 574559070,
    })
    // 坏行跳过（残行 close="" 会 Number 成 0——日期形状守卫）
    const broken = parseTencentKlines('{"data":{"sh600000":{"qfqday":[["bad,,,,"]]}}}', "sh600000")
    assert.equal(broken.length, 0)
})

// ---------- 10 交易日重放手算 ----------

const bar = (day: string, close: number, amount = 5e7) => ({
    day, open: close, close, high: close, low: close, volume: 1000, amount,
})
const D = (i: number): string => `2026-09-${String(i).padStart(2, "0")}`
const days10 = Array.from({ length: 10 }, (_, i) => D(i + 1))

const STOCKS: ReplayStock[] = [
    { code: "sh600010", name: "甲", floatCap: 5e8, pe: 30, pb: 2, bars: days10.map((d) => bar(d, 10)) },
    { code: "sh600011", name: "乙", floatCap: 7e8, pe: 30, pb: 2, bars: days10.map((d) => bar(d, 20)) },
    // 丙：d1-d5 收盘 30 → d6 起翻倍 60。口径①价格缩放：d1 流通 = 9e8×30/60 = 4.5e8
    // （池内），d6 = 9e8（出池）——翻倍被"持有到 d6"完整吃到（+48,000 市值）。
    { code: "sh600012", name: "丙", floatCap: 9e8, pe: 30, pb: 2, bars: days10.map((d) => bar(d, d <= D(5) ? 30 : 60)) },
    // 丁：d1-d5 收盘 25（缩放流通 20e8）→ d6 起腰斩 10（8e8）——全程排第三，
    // 是"缩放名次算错就会买错"的诱饵票（乙 7e8 恒在池内，真正出池的是丙）
    { code: "sh600013", name: "丁", floatCap: 8e8, pe: 30, pb: 2, bars: days10.map((d) => bar(d, d <= D(5) ? 25 : 10)) },
]

test('重放手算对拍：10 交易日 4 笔调仓，净值逐日到分', () => {
    const r = replayRotation(STOCKS, { topN: 2, cash: 100_000 })
    assert.equal(r.days.length, 10)

    // 手算（滑点买 ×1.002 / 卖 ×0.998；费用 = max(5, 万2.5)+过户十万分之一+卖出印花万五，round2）：
    // d1 缩放流通：丙 4.5e8 < 甲 5e8 < 乙 7e8 < 丁 20e8 → 池={丙, 甲}，各分 50,000：
    //   丙 qty=floor(50000/30.06/100)×100=1600，额 48,096，费 max(5,12.024)+0.481=12.5 → 现金 51,891.5
    //   甲 qty=floor(50000/10.02/100)×100=4900，额 49,098，费 12.27+0.49=12.77 → 现金 2,780.73
    //   净值 = 2,780.73 + 1600×30 + 4900×10 = 99,780.73
    // d2-d5 池不变无调仓，净值恒 99,780.73
    // d6 收盘：丙翻倍缩放 9e8 出池；乙 7e8 仍在、丁 8e8 排第三 → 池={甲, 乙}
    //   卖丙 1600@59.88（=60×0.998）：额 95,808，费 23.95+0.96+47.9=72.81 → 现金 98,515.92
    //   买乙 spend=全额：qty=floor(98515.92/20.04/100)×100=4900，额 98,196，费 25.53 → 现金 294.39
    //   净值 = 294.39 + 4900×10 + 4900×20 = 147,294.39（丙翻倍全程吃到）
    // d7-d10 池不变，净值恒 147,294.39
    assert.equal(r.equity[0], 99_780.73)
    assert.equal(r.equity[4], 99_780.73)
    assert.equal(r.equity[5], 147_294.39)
    assert.equal(r.equity[9], 147_294.39)

    assert.equal(r.trades.length, 4)
    assert.deepEqual(
        r.trades.map((t) => [t.side, t.code, t.price, t.qty, t.fee]),
        [
            ["buy", "sh600012", 30.06, 1600, 12.5],
            ["buy", "sh600010", 10.02, 4900, 12.77],
            ["sell", "sh600012", 59.88, 1600, 72.81],
            ["buy", "sh600011", 20.04, 4900, 25.53],
        ],
    )
})

// ---------- 绩效手算 ----------

test('computeMetrics：总收益/最大回撤/持续与修复/按年分层（手算）', () => {
    const days = ["2026-01-05", "2026-01-06", "2026-01-07", "2026-01-08", "2026-01-09"]
    const m = computeMetrics(days, [100, 120, 90, 100, 140])
    assert.ok(Math.abs(m.totalReturn - 0.4) < 1e-9)
    assert.ok(Math.abs(m.maxDrawdown - (-0.25)) < 1e-9, '谷 90 / 峰 120 = −25%')
    assert.equal(m.ddDays, 1, '峰 idx1 → 谷 idx2')
    assert.equal(m.recoveryDays, 2, '谷 idx2 → idx4 净值 140 ≥ 峰 120')
    assert.equal(m.yearly.length, 1)
    assert.equal(m.yearly[0]!.year, "2026")
    assert.ok(Math.abs(m.yearly[0]!.ret - 0.4) < 1e-9)
    assert.ok(m.annualized > 10, '4 日 +40% 年化爆表（252/4 次方）——数字本身无意义，公式对即可')

    // 尾部未修复：recoveryDays = null
    const m2 = computeMetrics(["2026-01-05", "2026-01-06", "2026-01-07"], [100, 120, 90])
    assert.equal(m2.recoveryDays, null)
    assert.equal(m2.ddDays, 1)
})

test('textCurve：确定性输出（行数/块字符域/标签）', () => {
    const days = ["2026-01-05", "2026-01-06", "2026-01-07", "2026-01-08", "2026-01-09"]
    const out = textCurve(days, [100, 120, 90, 100, 140])
    const lines = out.split("\n")
    assert.equal(lines.length, 4)
    assert.match(lines[0]!, /净值 2026-01-05 → 2026-01-09/)
    assert.equal(lines[1]!.length, 5)
    for (const ch of lines[1]!) assert.match("▁▂▃▄▅▆▇█", new RegExp(`[${ch}]`))
})
