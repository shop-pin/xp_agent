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

// ---------- TDX 移植高频件（2026-11-02 用户公式验收轮） ----------

test('金例9：IF 条件选择 + DRAWNULL 作 else=不画（null 传播）', () => {
    const f = loadFormula('A:IF(C>2,100,DRAWNULL); B:IF(C>2,C,0*C);')
    const out = runFormula(f, baseFromBars(bars([1, 2, 3, 4])))
    assert.deepEqual(out.values.get('A'), [null, null, 100, 100])
    assert.deepEqual(out.values.get('B'), [0, 0, 3, 4])
    // DRAWNULL 参与 XG 比较 = null → false（保守：不画出即不命中）
    const xg = evalXg('A:IF(C>3,1,DRAWNULL); XG:A=1;', bars([1, 2, 3, 4]))
    assert.deepEqual(xg, [false, false, false, true])
})

test('金例10：FILTER 信号静默窗——发出后 N 根内不再发', () => {
    // C=[5,1,5,5,1,5]，cond=C>3 → [T,F,T,T,F,T]；N=2：
    // idx0 发出；idx2 距 0=2 不>2 屏蔽；idx3 距 0=3>2 发出；idx5 距 3=2 屏蔽
    const xg = evalXg('XG:FILTER(C>3,2);', bars([5, 1, 5, 5, 1, 5]))
    assert.deepEqual(xg, [true, false, false, true, false, false])
})

test('金例11：BETWEEN 区间判定含边界 + null 传播', () => {
    const xg = evalXg('XG:BETWEEN(C,2,3);', bars([1, 2, 3, 4]))
    assert.deepEqual(xg, [false, true, true, false])
})

test('金例12：TO 换手率基础名（百分数口径）——有值判定 / hist-k 缺失=null→false', () => {
    const withTo: KBar[] = bars([10, 10]).map((b, i) => ({ ...b, turnover: [1.5, 3.5][i] }))
    const xg = evalXg('XG:TO>3;', withTo)
    assert.deepEqual(xg, [false, true])
    const noTo = evalXg('XG:TO>0;', bars([10, 10]))
    assert.deepEqual(noTo, [false, false])
})

test('金例13：REF 动态窗口 BARSLAST——取上次条件成立时的值', () => {
    // C=[3,1,1,4,5]，cond=C>2 → [T,F,F,T,T]；BARSLAST 距上次成立=[0,1,2,0,0]
    // REF(C,BARSLAST(C>2))：逐点回看 n 根——idx0 n=0 取自身 3、idx1 n=1 取 C[0]=3、
    // idx2 n=2 取 C[0]=3、idx3 n=0 取自身 4、idx4 取自身 5
    const f = loadFormula('R:REF(C,BARSLAST(C>2));')
    const out = runFormula(f, baseFromBars(bars([3, 1, 1, 4, 5])))
    assert.deepEqual(out.values.get('R'), [3, 3, 3, 4, 5])
    // 编译期：BARSLAST 只放行 REF 第二参，其他位置仍拒
    expectError('A:HHV(C,BARSLAST(C>2));', 'BARSLAST 仅 REF 第二参支持动态')
})

// ---------- TDX 原版公式直读适配（2026-11-02 用户公式逐字轮） ----------

test('金例16：|| 与 && 词法（TDX 原版惯用）', () => {
    const xg = evalXg('XG:(C>3||C<1)&&(C<10);', bars([5]))
    assert.deepEqual(xg, [true])
})

test('金例17：画线属性剥离 + 绘图语句忽略——TDX 指标原样可编译', () => {
    const f = loadFormula(
        'LONG:IF(C>2,100,DRAWNULL),STICK,COLORRED,LINETHICK9; MIMI:=FILTER(C>2,3)*100,COLORYELLOW,LINETHICK3;'
        + 'STICKLINE(C>2,0,100,2,0),COLORMAGENTA;'
        + "DRAWTEXT(C>2,90,'   主升启动'),COLORYELLOW;")
    assert.deepEqual([...f.outputs], ['LONG'])
})

test('金例18：CONST 取末值 + FORCAST 线性回归外推手算', () => {
    const f = loadFormula('K:CONST(C);')
    const out = runFormula(f, baseFromBars(bars([1, 2, 3])))
    assert.deepEqual(out.values.get('K'), [3, 3, 3])
    // FORCAST(C,4) 窗口 [1,2,3,4]：斜率 1、截距 0 → 当前位（t=3）拟合值=4
    const g = loadFormula('F:FORCAST(C,4);')
    const r = runFormula(g, baseFromBars(bars([1, 2, 3, 4, 9])))
    assert.equal(r.values.get('F')![3], 4)
    assert.equal(r.values.get('F')![2], null, '窗口未满=null')
})

test('金例19：FINANCE(7)/CAPITAL 反推——HSL 公式语义=真换手百分数（单位锚）', () => {
    // VOL=1000 手、TO=2.5% → 股本=1000×100/2.5=40000 手=400 万股
    const withTo: KBar[] = bars([10]).map((b) => ({ ...b, turnover: 2.5 }))
    const f = loadFormula('CAP:CAPITAL; F7:FINANCE(7); HSL:IF((SETCODE==0||SETCODE==1),100*VOL,VOL)/(FINANCE(7)/100);')
    const out = runFormula(f, baseFromBars(withTo))
    assert.equal(out.values.get('CAP')![0], 40000, 'CAPITAL=手')
    assert.equal(out.values.get('F7')![0], 4_000_000, 'FINANCE(7)=股（TDX 单位）')
    assert.equal(out.values.get('HSL')![0], 2.5, 'HSL=真换手%（用户公式 X5 闸语义）')
    // 无换手率（hist-k 形态）→ null → X5 闸=false 保守
    const noTo = evalXg('XG:FINANCE(7)>0;', bars([10]))
    assert.deepEqual(noTo, [false])
})

test('金例19b：CAPITAL 缺 to 回填最近一根带 to 的 bar（2026-11-03 挂账：TDX 收盘日 to=0 反推全废）', () => {
    // 三根：to=2.5 → 股本=1000×100/2.5=40000 手；to=5 → 20000 手；末根无 to（TDX 收盘形态）→ 回填 20000
    const b = bars([10])[0]!
    const three: KBar[] = [{ ...b, turnover: 2.5 }, { ...b, turnover: 5 }, { ...b }]
    const f = loadFormula('CAP:CAPITAL;')
    const out = runFormula(f, baseFromBars(three))
    assert.deepEqual(out.values.get('CAP'), [40000, 20000, 20000], '缺 to 的 bar 回填最近带 to bar 的反推股本')
    assert.deepEqual(evalXg('XG:FINANCE(7)>0;', three), [true, true, true], 'TDX 收盘日 FINANCE/HSL 闸不再整条失效')
    // 开局就无 to（纯 hist-k 形态）→ 仍全 null，与旧口径一致（保守）
    assert.deepEqual(evalXg('XG:FINANCE(7)>0;', bars([10, 10])), [false, false])
})

test('金例19c：股本表注入 CAPITAL——HSL/FINANCE 脱离换手率（2026-11-04 TDX 纯化：to=0 日可用）', () => {
    const f = loadFormula('CAP:CAPITAL; F7:FINANCE(7); HSL:IF((SETCODE==0||SETCODE==1),100*VOL,VOL)/(FINANCE(7)/100);')
    // bar 无 to + 注入流通股本 4 万手（=400 万股，capital-refresh-tdx.py 股→手换算后）
    const out = runFormula(f, baseFromBars(bars([10]), { floatSharesLots: 40000 }))
    assert.equal(out.values.get('CAP')![0], 40000, 'CAPITAL=股本表常量（手）')
    assert.equal(out.values.get('F7')![0], 4_000_000, 'FINANCE(7)=股本表×100（股）')
    assert.equal(out.values.get('HSL')![0], 2.5, 'HSL=100×1000/40000=2.5%（与 to 无关）')
})

test('金例20：NAMELIKE/CODELIKE 恒 false（universe 闸承担）+ 本地变量窗口 LLV(X,X)', () => {
    const xg = evalXg("X2:=NOT(NAMELIKE('ST') OR NAMELIKE('*ST') OR NAMELIKE('S')); XG:X2 AND NOT(CODELIKE(1));", bars([5]))
    assert.deepEqual(xg, [true], '两者恒 false → NOT 恒 true')
    // LLV(X_52,X_52)：窗口参=本地变量 → 运行期取末值常量（X_52=[F,T] 末值 true=1）
    const f = loadFormula('X_52:=C>1; L:LLV(X_52,X_52);')
    const out = runFormula(f, baseFromBars(bars([1, 2])))
    assert.deepEqual(out.values.get('L'), [0, 1], '窗口=末值 1 → 逐位取自身收缩')
})

test('金例21：布尔序列参与数值比较=0/1 收缩（X_36>0 恒等自身——漏票追凶修复锚）', () => {
    // EXIST(X_36>0,36)：X_36 是 Cond——修复前 cmp 把 boolean 当 null → 全 false
    const xg = evalXg('X36:C>2; B:EXIST(X36>0,3); XG:B;', bars([1, 2, 3, 4]))
    assert.deepEqual(xg, [false, false, true, true])
    // 布尔与数值直接比较：真(1)>0 真、假(0)>0 假
    const xg2 = evalXg('XG:(C>2)>0 AND (C>2)==(C>1);', bars([3]))
    assert.deepEqual(xg2, [true])
})
