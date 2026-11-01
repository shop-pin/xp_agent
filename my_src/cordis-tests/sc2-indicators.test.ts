// SC2 单测：指标原语手算锚（总纲验收线：每原语手算对拍）。
// 数字全部落笔——跑偏先红这里。运行：npm run cordis
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
    ma, ema, sma, ref, hhv, llv, hhvBars, llvBars, sum, std, stdp,
    gt, lt, cross, and, or, not, count, every, exist, barsLast, barsCount,
    add, sub, mul, div, abs, type Series, type Cond,
} from '../backtest/indicators.js'

const S = (a: (number | null)[]): Series => a
const C = (a: boolean[]): Cond => a
const head = (s: Series | Cond, i: number) => s[i]

test('MA：3 窗手算 + 头部空窗 + null 重置', () => {
    const out = ma(S([1, 2, 3, 4, 5]), 3)
    assert.deepEqual(out, [null, null, 2, 3, 4])
    // 中途 null：窗口含无效=无效（TDX 画不出），恢复需重新凑满
    const gapped = ma(S([1, 2, null, 4, 5, 6]), 2)
    assert.deepEqual(gapped, [null, 1.5, null, null, 4.5, 5.5])
})

test('EMA：递推手算（k=2/(N+1)）+ 首根播种', () => {
    const out = ema(S([10, 11, 12]), 4) // k=0.4
    assert.equal(out[0], 10)
    assert.ok(Math.abs((out[1] as number) - 10.4) < 1e-12)
    assert.ok(Math.abs((out[2] as number) - 11.04) < 1e-12)
    // EMA(C,2)：ema = (2x + prevY)/3
    const e2 = ema(S([9, 12]), 2)
    assert.ok(Math.abs((e2[1] as number) - (2 * 12 + 9) / 3) < 1e-12)
})

test('SMA：TDX 特有递推 Y=(M*X+(N-M)*prevY)/N，首根播种', () => {
    // KDJ 用 SMA(X,3,1)：y1=x1; y2=(1*x2+2*y1)/3
    const out = sma(S([50, 80]), 3, 1)
    assert.equal(out[0], 50)
    assert.equal(out[1], (80 + 2 * 50) / 3)
})

test('REF：右移 N 位，头部 null', () => {
    const out = ref(S([5, 6, 7, 8]), 2)
    assert.deepEqual(out, [null, null, 5, 6])
})

test('HHV/LLV：3 窗手算 + 头部空窗', () => {
    assert.deepEqual(hhv(S([3, 1, 4, 1, 5]), 3), [null, null, 4, 4, 5])
    assert.deepEqual(llv(S([3, 1, 4, 1, 5]), 3), [null, null, 1, 1, 1])
})

test('HHVBARS/LLVBARS：距最高/最低的 bar 数（0=今天，取最近一次）', () => {
    assert.deepEqual(hhvBars(S([3, 1, 4, 1, 5]), 3), [null, null, 0, 1, 0])
    // i=2 窗[3,1,4] 最低在 1 处 → 2-1=1；i=3 当天即最低 → 0；i=4 窗[4,1,5] 最低在 3 → 1
    assert.deepEqual(llvBars(S([3, 1, 4, 1, 5]), 3), [null, null, 1, 0, 1])
})

test('SUM：3 窗手算', () => {
    assert.deepEqual(sum(S([1, 2, 3, 4]), 3), [null, null, 6, 9])
})

test('STD（n-1）/STDP（n）：3 窗手算 [1,2,3] → std=1, stdp=√(2/3)', () => {
    const out = std(S([1, 2, 3]), 3)
    assert.ok(Math.abs((out[2] as number) - 1) < 1e-12)
    const outp = stdp(S([1, 2, 3]), 3)
    assert.ok(Math.abs((outp[2] as number) - Math.sqrt(2 / 3)) < 1e-12)
})

test('比较族：null 参与=false；数值=数值比较（布尔输入在逻辑族处理）', () => {
    const c = gt(S([1, 3, null, 5]), S([2, 2, 2, 2]))
    assert.deepEqual(c, [false, true, false, true])
    assert.deepEqual(lt(S([1, 3]), S([2, 2])), [true, false])
})

test('CROSS：上穿=今>且昨≤；首根=false；无效=false', () => {
    // A: 1,3,2,4  B: 2,2,2,2 → 第 1 根上穿（3>2 且 1≤2），第 3 根再穿（4>2 且 2≤2）
    assert.deepEqual(cross(S([1, 3, 2, 4]), S([2, 2, 2, 2])), [false, true, false, true])
    assert.deepEqual(cross(S([5, 6]), S([1, 2])), [false, false], '首根无昨位=false')
})

test('AND/OR/NOT：布尔代数', () => {
    assert.deepEqual(and(C([true, true, false]), C([true, false, false])), [true, false, false])
    assert.deepEqual(or(C([true, false]), C([false, false])), [true, false])
    assert.deepEqual(not(C([true, false])), [false, true])
})

test('COUNT/EVERY/EXIST：3 窗统计', () => {
    const c = C([true, false, true, true, true])
    assert.deepEqual(count(c, 3), [null, null, 2, 2, 3])
    assert.deepEqual(every(c, 3), [false, false, false, false, true])
    assert.deepEqual(exist(c, 2), [false, true, true, true, true])
})

test('BARSLAST：距上次成立 bar 数（从未成立=null）', () => {
    const out = barsLast(C([true, false, false, true, false]))
    assert.deepEqual(out, [0, 1, 2, 0, 1])
    assert.equal(barsLast(C([false, false]))[1], null)
})

test('BARSCOUNT：有效值起累计（头部空窗不计）', () => {
    assert.deepEqual(barsCount(S([null, null, 5, 6, 7])), [null, null, 1, 2, 3])
})

test('算术族：null 传播 + 除零=null', () => {
    assert.deepEqual(add(S([1, 2, null]), S([10, 20, 30])), [11, 22, null])
    assert.deepEqual(sub(S([5]), S([2])), [3])
    assert.deepEqual(mul(S([3, 4]), S([2, null])), [6, null])
    assert.deepEqual(div(S([1, 1, 8]), S([2, 0, 4])), [0.5, null, 2])
    assert.deepEqual(abs(S([-3, 3, null])), [3, 3, null])
})
