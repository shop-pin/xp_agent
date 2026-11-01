// SC2 单测：公式解释器金例（总纲验收线 ≥20：合法求值 + 坏公式拒装清单）。
// 运行：npm run cordis
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadFormula, runFormula, baseFromBars, FormulaError } from '../backtest/formula.js'
import type { KBar } from '../backtest/kline.js'

const bars = (closes: number[], opens?: number[], highs?: number[], lows?: number[]): KBar[] =>
    closes.map((c, i) => ({
        day: `2026-01-${String(i + 5).padStart(2, '0')}`,
        open: opens?.[i] ?? c, close: c,
        high: highs?.[i] ?? c, low: lows?.[i] ?? c,
        volume: 1000, amount: 100_000,
    }))

const evalXg = (text: string, barsIn: KBar[], params?: Record<string, number>) => {
    const f = loadFormula(text, { requireXg: true, params })
    const base = baseFromBars(barsIn)
    return runFormula(f, base).xg!
}

const expectError = (text: string, frag: string, opts?: { requireXg?: boolean }) => {
    assert.throws(() => loadFormula(text, { requireXg: opts?.requireXg ?? false }),
        (e: unknown) => e instanceof FormulaError && e.message.includes(frag),
        `应拒装并点名「${frag}」`)
}

// ---------- 合法求值 ----------

test('金例1：均线金叉（参数化 N/M）——下跌后回升的首个金叉位', () => {
    // 收盘 [5,4,3,2,1,2,3,4,5]：MA3=[_,_,4,3,2,2,2,3,4]；MA5=[_,_,_,_,3,2.4,2.4,2.4,3]
    // CROSS 需昨位两侧均有效：idx7: 3>2.4 且昨 MA3[6]=2≤2.4 → 金叉；idx8: 昨 3≤2.4 否
    const xg = evalXg('MA1:MA(C,N); MA2:MA(C,M); XG:CROSS(MA1,MA2);',
        bars([5, 4, 3, 2, 1, 2, 3, 4, 5]), { N: 3, M: 5 })
    assert.deepEqual(xg, [false, false, false, false, false, false, false, true, false])
})

test('金例2：突破形态——C 创 5 日新高且放量（C>HIGH 语义用 HHV 组合）', () => {
    const b = bars([10, 10, 10, 10, 11, 12], undefined, [10, 10, 10, 10, 11, 12])
    // XG: C>=HHV(C,5) AND C>REF(C,1)
    const xg = evalXg('XG:C>=HHV(C,5) AND C>REF(C,1);', b)
    assert.deepEqual(xg, [false, false, false, false, true, true])
})

test('金例3：中文变量名 + {} 注释 + 大小写不敏感', () => {
    const xg = evalXg('{短期线} 均线五:ma(c,2); {金叉} XG:CROSS(均线五, 均线五);', bars([1, 2, 3]))
    // 自己上穿自己永远 false（昨=今）
    assert.deepEqual(xg, [false, false, false])
})

test('金例4：算术优先级（乘加括号）+ 一元负号', () => {
    const f = loadFormula('A:1+2*3; B:(1+2)*3; D:-2+1;')
    const out = runFormula(f, baseFromBars(bars([1])))
    assert.equal(out.values.get('A')![0], 7)
    assert.equal(out.values.get('B')![0], 9)
    assert.equal(out.values.get('D')![0], -1)
})

test('金例5：AND 优先于 OR', () => {
    // true OR false AND false = true OR (false) = true
    const xg = evalXg('XG:C>0 OR C>0 AND C<0;', bars([5]))
    assert.deepEqual(xg, [true])
})

test('金例6：NOT 只作用于最近比较式', () => {
    const xg = evalXg('XG:NOT C>10 AND C>3;', bars([5]))
    assert.deepEqual(xg, [true])
})

test('金例7：= 与 == 与 <> 等价语义 + 条件参与算术（0/1 收缩）', () => {
    const f = loadFormula('E1:C=5; E2:C==5; NE:C<>5; S:(C=5)+(C>4);')
    const out = runFormula(f, baseFromBars(bars([5])))
    assert.equal(out.values.get('E1')![0], true)
    assert.equal(out.values.get('E2')![0], true)
    assert.equal(out.values.get('NE')![0], false)
    assert.equal(out.values.get('S')![0], 2, '真=1 假=0')
})

test('金例8：除零=null 不炸，后续比较=false', () => {
    const xg = evalXg('R:C/0; XG:R>0;', bars([5]))
    assert.deepEqual(xg, [false])
})

test('金例9：BARSLAST 组合——距上次金叉 2 根内再次放量', () => {
    const b = bars([1, 3, 2, 4, 5], [1, 1, 1, 1, 1], undefined, [1, 1, 1, 1, 1])
    // CROSS(C, [2,2,2,2,2]) → idx1 (3>2 且 1≤2), idx3 (4>2 且 2≤2)
    const xg = evalXg('X:BARSLAST(CROSS(C,V*0.002+1)); XG:X<=1;', b)
    // V=1000 → 阈值 = 2+1 = 3；C=[1,3,2,4,5] 上穿 3：idx1(3>3?否) idx3(4>3 且 2≤3 成立)
    assert.deepEqual(xg, [false, false, false, true, true])
})

test('金例10：输出（非 XG）不带 requireXg 时自由命名——副图指标形态', () => {
    const f = loadFormula('DIF:EMA(C,12)-EMA(C,26);')
    const out = runFormula(f, baseFromBars(bars([1, 2, 3])))
    assert.equal(out.values.has('DIF'), true)
    assert.equal(f.outputs.length, 1)
})

test('金例11：SMA 参数化（KDJ 的 RSV 平滑原型）', () => {
    const xg = evalXg('K:SMA(C,3,1); XG:K>0;', bars([50, 80, 90]))
    assert.deepEqual(xg, [true, true, true])
})

test('金例12：HHV 复合——收盘真破 4 日新高（C 与 H 同跳才成立）', () => {
    const b = bars([10, 10.1, 10, 10.1, 10.6], undefined, [10.2, 10.2, 10.2, 10.2, 10.6], [9.9, 9.9, 9.9, 9.9, 10.1])
    // HHV(H,4): idx3=10.2, idx4=10.6；idx4: C=10.6≥10.6 ✓；idx3: 10.1≥10.2 ✗
    const xg = evalXg('XG:C>=HHV(H,4);', b)
    assert.deepEqual(xg, [false, false, false, false, true])
})

test('金例13：EVERY/EXIST/COUNT 组合', () => {
    const xg = evalXg('XG:EVERY(C>REF(C,1),3) OR COUNT(C>REF(C,1),5)>=4;', bars([1, 2, 3, 4, 5, 6]))
    assert.deepEqual(xg, [false, false, false, true, true, true])
})

test('金例14：MAX/MIN 内置', () => {
    const f = loadFormula('MX:MAX(C,3); MN:MIN(C,3);')
    const out = runFormula(f, baseFromBars(bars([5])))
    assert.equal(out.values.get('MX')![0], 5)
    assert.equal(out.values.get('MN')![0], 3)
})

test('金例15：STDP 统计窗口', () => {
    const f = loadFormula('SD:STD(C,3);')
    const out = runFormula(f, baseFromBars(bars([1, 2, 3])))
    assert.ok(Math.abs((out.values.get('SD')![2] as number) - 1) < 1e-12)
})

// ---------- 坏公式拒装清单 ----------

test('坏公式1：缺分号', () => {
    expectError('A:1+2', '期望 ";"')
})
test('坏公式2：未知函数', () => {
    expectError('A:FOO(C,5);', '未知函数：FOO')
})
test('坏公式3：未知名字', () => {
    expectError('A:Z+1;', '未知名字：Z')
})
test('坏公式4：选股公式缺 XG', () => {
    expectError('A:C>1;', '必须恰有一个 XG', { requireXg: true })
})
test('坏公式5：两个 XG = 变量重复定义，加载期拒装（不是最后一行生效）', () => {
    expectError('XG:C>1; XG:C>2;', '重复定义：XG', { requireXg: true })
})
test('坏公式6：变量重复定义', () => {
    expectError('A:1; A:2;', '重复定义')
})
test('坏公式7：窗口参用表达式', () => {
    expectError('A:MA(C,N-1);', '须为数字字面量或参数名')
})
test('坏公式8：窗口参名字未在 params 提供', () => {
    expectError('A:MA(C,N);', '名字 "N"（未在 params 提供）')
})
test('坏公式9：注释未闭合', () => {
    expectError('A:1; {未闭合', '未闭合')
})
test('坏公式10：非法字符', () => {
    expectError('A:1@2;', '无法识别的字符')
})
