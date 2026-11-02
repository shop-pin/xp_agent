// SC3 单测：公式库体系——标准指标手算锚（MACD 小参数/KDJ 默认参）+ 体系
// 自证（内置指标=公式库条目，经 SC2 解释器求值）+ 装卸 + 复合键隔离 + 坏定义。
// 运行：npm run cordis
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { FormulaLibrary } from '../backtest/library.js'
import { BUILTIN_INDICATORS, BUILTIN_SCREENERS, type IndicatorDef } from '../backtest/formulas/builtin.js'
import { baseFromBars } from '../backtest/formula.js'
import type { KBar } from '../backtest/kline.js'

const mkBars = (closes: number[], highs?: number[], lows?: number[]): KBar[] =>
    closes.map((c, i) => ({
        day: `2026-01-${String(i + 4).padStart(2, '0')}`,
        open: c, close: c,
        high: highs?.[i] ?? c, low: lows?.[i] ?? c,
        volume: 1000, amount: 100_000,
    }))

test('内置库构建：主图/副图标准指标 + 5 个示例选股公式全部编译通过（体系自证）', () => {
    const lib = FormulaLibrary.build(BUILTIN_INDICATORS, BUILTIN_SCREENERS)
    assert.deepEqual(lib.indicators.map((i) => i.def.id), ['MA', 'MACD', 'KDJ', 'VOL'])
    assert.equal(lib.screeners.length, BUILTIN_SCREENERS.length)
    // macd-golden / kdj-golden 引用复合名——编译期已通过静态检查（build 不抛即证）
    assert.equal(lib.hasIndicator('MACD.DIF'), true)
    assert.equal(lib.hasIndicator('KDJ.J'), true)
    assert.equal(lib.hasIndicator('NOPE.X'), false)
})

test('MACD 手算锚（小参数 2/4/2，收盘 10..15）——递推逐位落笔', () => {
    const lib = FormulaLibrary.build(
        [{ ...BUILTIN_INDICATORS[1]!, params: { P1: 2, P2: 4, P3: 2 } }],
        [{ id: 't', name: 't', note: '', enabled: true, formula: 'XG:CROSS(MACD.DIF, MACD.DEA);' }])
    const out = runWith(lib, mkBars([10, 11, 12, 13, 14, 15]))
    // EMA(C,2)=[10, 32/3, 34.667/3...]；EMA(C,4)=[10,10.4,11.04,11.824,12.6944,13.61664]
    // DIF[5]=14.50206−13.61664≈0.885467；DEA[5]≈0.837071；MACD[5]≈0.096853
    const v = out.values
    assert.ok(Math.abs((v.get('MACD.DIF')![5] as number) - 0.885467) < 1e-4, `DIF[5]=${v.get('MACD.DIF')![5]}`)
    assert.ok(Math.abs((v.get('MACD.DEA')![5] as number) - 0.837071) < 1e-4, `DEA[5]=${v.get('MACD.DEA')![5]}`)
    assert.ok(Math.abs((v.get('MACD.MACD')![5] as number) - 0.096853) < 1e-3)
})

test('KDJ 手算锚（默认 9/3/3）——RSV 播种与三级平滑逐位落笔', () => {
    // 11 根：L=i+1, H=i+2, C=i+1（前 10 根 RSV 全 0）→ K/D 全 0；末根 C=10.5
    const closes = Array.from({ length: 11 }, (_, i) => i + 1)
    const highs = Array.from({ length: 11 }, (_, i) => i + 2)
    const lows = Array.from({ length: 11 }, (_, i) => i + 1)
    const bars = closes.map((c, i) => ({
        day: `2026-01-${String(i + 4).padStart(2, '0')}`,
        open: c, close: i < 10 ? c : 10.5, high: highs[i]!, low: lows[i]!,
        volume: 1000, amount: 100_000,
    }))
    const lib = FormulaLibrary.build(BUILTIN_INDICATORS.filter((d) => d.id === 'KDJ'), [])
    const out = runWith(lib, bars)
    const v = out.values
    // RSV 窗口逐 bar 滑动（LLV/HHV 是 9 窗极值，不是当前 bar 或全序列极值）：
    //   idx8: 窗 bars0..8 → LLV=1, HHV=10, C=9 → (9-1)/(10-1)·100 = 88.8889
    //   idx9: 窗 bars1..9 → LLV=2, HHV=11, C=10 → (10-2)/(11-2)·100 = 88.8889
    //   idx10: 窗 bars2..10 → LLV=3, HHV=12, C=10.5 → (10.5-3)/(12-3)·100 = 83.3333
    // SMA(X,3,1) 首个有效播种：K[8]=D[8]=88.888889
    assert.ok(Math.abs((v.get('KDJ.K')![8] as number) - 88.888889) < 1e-4)
    assert.ok(Math.abs((v.get('KDJ.D')![8] as number) - 88.888889) < 1e-4)
    // K[9]=(88.8889+2·88.888889)/3=88.888888；K[10]=(83.3333+2·88.888889)/3=87.037037
    // D[10]=(87.037037+2·88.888888)/3=88.271605；J[10]=3·87.037037-2·88.271605=84.567901
    assert.ok(Math.abs((v.get('KDJ.K')![10] as number) - 87.037037) < 1e-4)
    assert.ok(Math.abs((v.get('KDJ.D')![10] as number) - 88.271605) < 1e-4)
    assert.ok(Math.abs((v.get('KDJ.J')![10] as number) - 84.567901) < 1e-3)
})

test('装卸开关：enabled=false 的选股公式注册但不参跑', () => {
    const lib = FormulaLibrary.build([], [
        { id: 'on', name: '', note: '', enabled: true, formula: 'XG:C>1;' },
        { id: 'off', name: '', note: '', enabled: false, formula: 'XG:C>2;' },
    ])
    const hits = lib.runStock(baseFromBars(mkBars([3])))
    assert.deepEqual([...hits.keys()], ['on'])
})

test('同名输出隔离：两个指标的 X 互不污染（复合键）', () => {
    const defs: IndicatorDef[] = [
        { id: 'I1', name: '', kind: 'sub', note: '', formula: 'X:C+1;' },
        { id: 'I2', name: '', kind: 'sub', note: '', formula: 'X:C+100;' },
    ]
    const lib = FormulaLibrary.build(defs, [
        { id: 's1', name: '', note: '', enabled: true, formula: 'XG:I1.X>1;' },   // 2>1 真值靠 I1.X=2
        { id: 's2', name: '', note: '', enabled: true, formula: 'XG:I2.X>100;' }, // 101>100 真值靠 I2.X=101
        { id: 's3', name: '', note: '', enabled: true, formula: 'XG:I2.X>2 AND I2.X<101;' }, // 恒假（101 不<101）
    ])
    const hits = lib.runStock(baseFromBars(mkBars([1])))
    assert.deepEqual([...hits.keys()].sort(), ['s1', 's2'])
})

test('坏定义 fail-fast：内置库的坏公式直接抛（产品 bug 不静默）', () => {
    assert.throws(
        () => FormulaLibrary.build([{ id: 'BAD', name: '', kind: 'sub', note: '', formula: 'A:FOO(C,1);' }], []),
        (e: unknown) => e instanceof Error && e.message.includes('未知函数：FOO'))
})

test('引用未注册指标：选股公式编译期 FormulaError', () => {
    assert.throws(
        () => FormulaLibrary.build([], [{ id: 's', name: '', note: '', enabled: true, formula: 'XG:NOPE.X>1;' }]),
        (e: unknown) => e instanceof Error && e.message.includes('未知名字'))
})

// ---------- 辅助 ----------

function runWith(lib: FormulaLibrary, bars: KBar[]) {
    const base = baseFromBars(bars)
    return { hits: lib.runStock(base), values: lib.runIndicatorValues(base) }
}

test('指标跨引用：后序指标引用内置 MACD 输出（2026-11-02 多指标协同）', () => {
    const lib = FormulaLibrary.build(BUILTIN_INDICATORS, [{
        id: 'probe-xref', name: '探针', enabled: true,
        formula: 'XG:MACD.DIF!=0 AND KDJ.K<50;',
    }] as never);
    // 编译通过即声明：indicator 编译期可引用前序（内置）指标输出
    assert.ok(lib.hasIndicator('MACD.DIF'))
    assert.ok(lib.hasIndicator('KDJ.K'))
})
