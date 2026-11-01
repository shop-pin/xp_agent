// 风格状态纯函数手算对拍（择时前置②，2026-11-01）：
// 复利/spread/MA 闸位/覆盖为零时的行——逐日数字落笔，跑偏先红这里。
// 运行：npm run cordis
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildStyleState, STYLE_WINDOWS } from '../backtest/style.js'

test('buildStyleState：复利、daySpread、spread5 手算对拍（3 日小样本）', () => {
    const rows = buildStyleState([
        { day: '2026-01-05', micro: 0.01, macro: 0.0, coverage: 100 },   // 微盘 +1%，大盘平
        { day: '2026-01-06', micro: -0.01, macro: 0.0, coverage: 100 },  // 微盘 −1%
        { day: '2026-01-07', micro: 0.0, macro: 0.02, coverage: 98 },    // 微盘平，大盘 +2%
    ])
    assert.equal(rows.length, 3)
    const [r1, r2, r3] = rows
    assert.equal(r1!.micro, 1.01)
    assert.equal(r1!.macro, 1)
    assert.equal(r2!.micro, 1.01 * 0.99)
    assert.equal(r3!.macro, 1.02)
    assert.ok(Math.abs(r1!.daySpread - 0.01) < 1e-12)
    assert.ok(Math.abs(r2!.daySpread - (-0.01)) < 1e-12)
    assert.ok(Math.abs(r3!.daySpread - (-0.02)) < 1e-12)
    // spread5：不足 5 日按实有数——d3 = +1 −1 −2 = −2%
    assert.ok(Math.abs(r3!.spread5 - (-0.02)) < 1e-12)
    assert.ok(Math.abs(r2!.spread5 - 0) < 1e-12)
})

test('buildStyleState：MA 闸位手算——窗口大于序列长按实有数，阈值边界收紧', () => {
    // 单调下跌序列：微盘指数 1.1 → 1.05（−4.55%）→ 1.0（−4.76%）
    const rows = buildStyleState([
        { day: '2026-01-05', micro: 0.1, macro: 0, coverage: 50 },
        { day: '2026-01-06', micro: -0.045454545454545456, macro: 0, coverage: 50 },
        { day: '2026-01-07', micro: -0.047619047619047616, macro: 0, coverage: 50 },
    ], [2])
    // d1：levels=[1.1]，MA2 按实有 1 日=1.1，1.1>1.1 为 false（严格大于）
    assert.equal(rows[0]!.ma['2'], false)
    // d2：levels=[1.1,1.05]，MA2=(1.1+1.05)/2=1.075，1.05<1.075 → 关
    assert.equal(rows[1]!.ma['2'], false)
    // d3：levels=[1.1,1.05,1.0]，MA2=(1.05+1.0)/2=1.025，1.0<1.025 → 关
    assert.equal(rows[2]!.ma['2'], false)
    // 上升序列对照：连续 +1% 三日，每日收盘都在均值之上 → 开
    const up = buildStyleState([
        { day: '2026-02-02', micro: 0.01, macro: 0, coverage: 10 },
        { day: '2026-02-03', micro: 0.01, macro: 0, coverage: 10 },
        { day: '2026-02-04', micro: 0.01, macro: 0, coverage: 10 },
    ], [2])
    assert.equal(up[2]!.ma['2'], true)
})

test('buildStyleState：覆盖为零的日子闸位沿用上一日、spread 照记——断供与平静可区分', () => {
    const rows = buildStyleState([
        { day: '2026-03-02', micro: 0.01, macro: -0.01, coverage: 90 },
        { day: '2026-03-03', micro: 0, macro: 0, coverage: 0 },
    ], [100, 150, 200, 250])
    assert.equal(rows[1]!.coverage, 0)
    assert.ok(Math.abs(rows[1]!.daySpread - 0) < 1e-12)
    // 缺省窗口全在：闸位对象键完整（沿用 prevMa 的浅拷贝，非引用共享）
    for (const w of STYLE_WINDOWS) {
        assert.equal(rows[0]!.ma[String(w)], rows[1]!.ma[String(w)])
        assert.notEqual(rows[0]!.ma, rows[1]!.ma)
    }
})
