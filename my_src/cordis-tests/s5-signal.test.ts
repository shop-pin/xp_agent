// S5 单测：信号引擎——指标手算对拍（纯函数钉死口径）、分板涨停位、默认规则
// 触发、market/snapshot→评估→market/signal 事件接线、冷却、get_signals 工具。
// 手算数字全部在注释里给出推导——改实现不改注释先红这里。
// 运行：npm run cordis
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '../cordis/context.js'
import { ToolsService } from '../services/tools.js'
import { marketDataPlugin, type Quote, type QuoteSource } from '../plugins/market-data.js'
import {
    signalEnginePlugin, seriesFor, windowChange, volumeSurge, vwapDeviation,
    breakout, limitTier, defaultRules, type Point, type Signal,
} from '../plugins/signal-engine.js'
import { DEFAULT_STRATEGY } from '../plugins/strategy.js'

const P = (at: number, price: number, volume = 0, amount = 0): Point => ({ at, price, volume, amount })
const MIN = 60_000
const T0 = Date.UTC(2026, 9, 19, 2, 0, 0) // 周一 10:00 CST（固定基准）

// ---------- 指标：手算对拍 ----------

test('windowChange：5 分钟窗口涨速（(末-基)/基×100）', () => {
    // t=0..240s，价 10 → 10.5：5min 窗覆盖全序列 → 基=首点 10 → +5%
    const s = [P(0, 10), P(MIN, 10.05), P(2 * MIN, 10.2), P(3 * MIN, 10.4), P(4 * MIN, 10.5)]
    assert.ok(Math.abs(windowChange(s, 5 * MIN)! - 5) < 1e-9)
    // 观测窗短于窗口：用可得的首点近似（口径记档）
    assert.ok(Math.abs(windowChange([P(0, 10), P(MIN, 10.2)], 5 * MIN)! - 2) < 1e-9)
    // 不足两点 / 基价为 0 → null
    assert.equal(windowChange([P(0, 10)], 5 * MIN), null)
    assert.equal(windowChange([P(0, 0), P(MIN, 10)], 5 * MIN), null)
})

test('volumeSurge：日内量比近似 = 近段量率 / 增量平均量率', () => {
    // 10 个安静轮（每 60s +60 手）后 1 个放量轮（+960 手）：
    //   增量平均 = (2500-1000)/600s = 2.5/s；probe = (2500-1540)/60 = 16/s
    //   surge = 16/2.5 = 6.4（基线用末-首增量：观测前存量不计——章内记档）
    const s: Point[] = []
    let v = 1000
    for (let i = 0; i < 10; i++) { s.push(P(i * MIN, 10, v)); v += 60 }
    s.push(P(10 * MIN, 10.15, 2500))
    assert.ok(Math.abs(volumeSurge(s, MIN)! - 6.4) < 0.01)
    // 平量：surge ≈ 1
    const flat = [P(0, 10, 1000), P(MIN, 10, 1060), P(2 * MIN, 10, 1120)]
    assert.ok(Math.abs(volumeSurge(flat, MIN)! - 1) < 0.01)
    // 不足 3 点 → null
    assert.equal(volumeSurge([P(0, 10, 1), P(MIN, 10, 2)], MIN), null)
})

test('vwapDeviation：价 vs 当日均价（元/(手×100)）', () => {
    // volume=1000 手=10 万股，amount=103 万 → vwap=10.3；价 10.5 → +1.9417%
    const q = { volume: 1000, amount: 1_030_000, price: 10.5 } as Quote
    assert.ok(Math.abs(vwapDeviation(q)! - (0.2 / 10.3 * 100)) < 1e-9)
    assert.equal(vwapDeviation({ volume: 0, amount: 0, price: 10 } as Quote), null)
})

test('breakout：窗口内（去近端）极值突破幅度', () => {
    // 窗 5min 去 30s：入窗 t=0..240s（t=300s 是末点），窗内高点 = 10.3（t=240s）
    const s = [P(0, 10), P(MIN, 10.1), P(2 * MIN, 10.2), P(3 * MIN, 10.15), P(4 * MIN, 10.3), P(5 * MIN, 10.45)]
    assert.ok(Math.abs(breakout(s, 5 * MIN, 30_000, 'up')! - (0.15 / 10.3 * 100)) < 1e-9)
    assert.equal(breakout(s, 5 * MIN, 30_000, 'down'), null) // 未跌破窗内低点
    // 近端点不入窗：高点移到 t=280s（>270s 被排除）→ 窗内高点回落 10.2
    const s2 = [P(0, 10), P(MIN, 10.1), P(2 * MIN, 10.2), P(3 * MIN, 10.15), P(4 * MIN + 40_000, 10.3), P(5 * MIN, 10.45)]
    assert.ok(Math.abs(breakout(s2, 5 * MIN, 30_000, 'up')! - (0.25 / 10.2 * 100)) < 1e-9)
})

test('limitTier：分板涨停位（ST 5 / 主板 10 / 双创 20 / 北交 30）', () => {
    assert.equal(limitTier('sh600000', '浦发银行'), 10)
    assert.equal(limitTier('sz000001', '平安银行'), 10)
    assert.equal(limitTier('sz300750', '宁德时代'), 20)
    assert.equal(limitTier('sh688981', '中芯国际'), 20)
    assert.equal(limitTier('bj920196', 'N南乳'), 30)
    assert.equal(limitTier('sz000002', 'ST 麻烦'), 5)
})

// ---------- 默认规则 ----------

const quote = (over: Partial<Quote>): Quote => ({
    code: 'sh600000', name: '测试股', price: 10, change: 0, changePercent: 0,
    open: 10, high: 10, low: 10, preClose: 10, volume: 0, amount: 0,
    turnoverRate: 0, volumeRatio: 0, marketCap: 0, floatCap: 0, pb: 0, ...over,
})

test('rapid-move：|5min 涨速|≥3 触发，方向随符号', () => {
    const rule = defaultRules().find((r) => r.name === 'rapid-move')!
    const s = [P(T0, 10), P(T0 + MIN, 10), P(T0 + 2 * MIN, 10), P(T0 + 3 * MIN, 10), P(T0 + 4 * MIN, 10.31)]
    const up = rule.evaluate({ quote: quote({}), series: s })
    assert.equal(up?.rule, 'rapid-move')
    assert.equal(up?.direction, 'up')
    assert.equal(up?.strength, 3.1)
    const down = rule.evaluate({ quote: quote({}), series: s.map((p) => ({ ...p, price: 20 - p.price + 0.31 })) })
    assert.equal(down?.direction, 'down')
    assert.equal(rule.evaluate({ quote: quote({}), series: [P(T0, 10), P(T0 + MIN, 10.1)] }), null)
})

test('limit-approach：距板 ≤0.5% 触发（分板 + 双向）', () => {
    const rule = defaultRules().find((r) => r.name === 'limit-approach')!
    assert.equal(rule.evaluate({ quote: quote({ changePercent: 9.7 }), series: [] })?.direction, 'up')
    assert.equal(rule.evaluate({ quote: quote({ code: 'sz300750', changePercent: 19.9 }), series: [] })?.direction, 'up')
    assert.equal(rule.evaluate({ quote: quote({ name: 'ST 测', changePercent: 4.9 }), series: [] })?.direction, 'up')
    assert.equal(rule.evaluate({ quote: quote({ changePercent: -9.8 }), series: [] })?.direction, 'down')
    assert.equal(rule.evaluate({ quote: quote({ changePercent: 9.2 }), series: [] }), null)
    // N 前缀首日无板位（Day 1：N文峰 +267% 被按 30% 算出"距涨停 −237%"）
    assert.equal(rule.evaluate({ quote: quote({ name: 'N文峰', changePercent: 267 }), series: [] }), null)
})

test('volume-surge / breakout：量能确认门槛', () => {
    const surgeRule = defaultRules().find((r) => r.name === 'volume-surge')!
    const brkRule = defaultRules().find((r) => r.name === 'breakout')!
    // 放量上涨序列：surge 6.4 + 5min +1.5% → volume-surge 触发
    // （amount = 手×100股×价：probe 窗口分钟成交额 96 万 ≥ 30 万，绝对量检验过）
    const s: Point[] = []
    let v = 1000
    for (let i = 0; i < 10; i++) { s.push(P(T0 + i * MIN, 10 + i * 0.001, v, v * 1000)); v += 60 }
    s.push(P(T0 + 10 * MIN, 10.15, 2500, 2_500_000))
    assert.equal(surgeRule.evaluate({ quote: quote({}), series: s })?.rule, 'volume-surge')
    // 绝对量检验（Day 1 P1）：同型序列但分钟成交额 9,600 元 < 30 万且无换手
    // → 假比率（surge 依旧 6.4）在源头拦下
    const thin = s.map((p) => ({ ...p, amount: p.amount / 100 }))
    assert.equal(surgeRule.evaluate({ quote: quote({}), series: thin }), null)
    // 换手腿兜底：同地量但当日累计换手 ≥ 0.5% → 放行
    assert.equal(surgeRule.evaluate({ quote: quote({ turnoverRate: 0.6 }), series: thin })?.rule, 'volume-surge')
    // 零量 + 突破形态 → breakout 被量能硬门槛拦下（surge null 不放行）
    const flatBrk = [P(T0, 10), P(T0 + MIN, 10.1), P(T0 + 2 * MIN, 10.2), P(T0 + 3 * MIN, 10.15), P(T0 + 4 * MIN, 10.3), P(T0 + 5 * MIN, 10.45)]
    assert.equal(brkRule.evaluate({ quote: quote({}), series: flatBrk }), null)
    // 放量突破：同一形态 + 末轮量能跳升（surge≈3.8）→ up
    const volBrk = flatBrk.map((p, i) => ({
        ...p,
        volume: [1000, 1060, 1120, 1180, 1240, 2000][i],
        amount: p.price * [1000, 1060, 1120, 1180, 1240, 2000][i] * 100,
    }))
    assert.equal(brkRule.evaluate({ quote: quote({}), series: volBrk })?.direction, 'up')
})

test('breakout 双门槛 + 幅度腿 tick 归一（Day 1 P1）', () => {
    const brk = defaultRules().find((r) => r.name === 'breakout')!
    // 形态：窗内高点 10 → 末价 10.072（+0.72% tick 级）；量 surge ≈ 1.875（1.5–2.5 之间）
    const series = [10, 9.95, 10, 9.98, 10, 10.072].map(
        (p, i) => P(T0 + i * MIN, p, [1000, 1333, 1666, 2000, 2000, 2600][i]),
    )
    // 普价股：0.72% ≥ 幅度下限 0.5% → 幅度腿过线，发
    assert.equal(brk.evaluate({ quote: quote({ price: 10.072 }), series })?.direction, 'up')
    // 低价股：幅度下限 = 2tick/价 = 0.02/1.40 = 1.43%——同一个 0.72% 只是两个 tick
    // （*ST田野 1.38 元一跳 0.72% 的 Day 1 样本）
    const penny = [1.39, 1.38, 1.39, 1.385, 1.39, 1.4].map(
        (p, i) => P(T0 + i * MIN, p, [1000, 1333, 1666, 2000, 2000, 2600][i]),
    )
    assert.equal(brk.evaluate({ quote: quote({ price: 1.4 }), series: penny }), null)
    // 双门槛 OR：幅度 0.3% 不足但 surge 5.0 ≥ 2.5 → 量率腿单独放行
    const surgey = [10, 9.95, 10, 9.98, 10, 10.03].map(
        (p, i) => P(T0 + i * MIN, p, [1000, 1000, 1000, 1000, 1000, 3000][i]),
    )
    assert.equal(brk.evaluate({ quote: quote({ price: 10.03 }), series: surgey })?.direction, 'up')
    // 两头都不沾（Day 1 主噪音形态）：0.29% + surge 1.875 → 拦
    const weak = [10, 9.95, 10, 9.98, 10, 10.029].map(
        (p, i) => P(T0 + i * MIN, p, [1000, 1333, 1666, 2000, 2000, 2600][i]),
    )
    assert.equal(brk.evaluate({ quote: quote({ price: 10.029 }), series: weak }), null)
})

// ---------- 引擎接线：事件驱动 + 冷却 + 工具 ----------

function makeQuote(code: string, name: string, price: number, changePercent: number): Quote {
    // amount 给足 2,000 万：引擎宇宙闸默认日成交额下限 1,000 万（Day 1 复盘 P0），
    // 地量样本在用例里单独覆盖
    return quote({ code, name, price, changePercent, preClose: price / (1 + changePercent / 100), amount: 2e7 })
}

test('引擎：snapshot 事件驱动评估 → market/signal 广播 → 冷却压重复', async () => {
    const ctx = new Context()
    new ToolsService(ctx, 'tools')
    const baseline = [makeQuote('sh600000', '平平稳稳', 10, 1.0), makeQuote('sz000001', '安安稳稳', 20, -0.5)]
    const spiked = [
        makeQuote('sh600000', '平平稳稳', 10.35, 4.5), // 5min +3.5% → rapid-move up
        makeQuote('sz000001', '安安稳稳', 20, -0.5),
    ]
    let fetchCount = 0
    const src: QuoteSource = {
        async fetchMarketSnapshot() { fetchCount++; return fetchCount === 1 ? baseline : spiked },
        async fetchQuotes(codes) { return [] },
    }
    const fixedNow = () => new Date(T0)
    ctx.plugin(marketDataPlugin, { source: src, now: fixedNow, pollIntervalMs: 60_000 })
    // 监听器先挂（Events 类型面经模块 declaration merging 全局可见）
    const fired: Signal[] = []
    ctx.on('market/signal', (s) => { fired.push(s) })
    let snapCount = 0
    ctx.on('market/snapshot', () => { snapCount++ })
    ctx.plugin(signalEnginePlugin, { strategy: DEFAULT_STRATEGY })
    const eng = ctx.signals!

    const market = ctx.market!
    await market.refresh() // 第 1 轮：平静 → 无信号
    assert.equal(eng.recent.length, 0)
    await market.refresh() // 第 2 轮：spike → rapid-move
    assert.equal(eng.recent.length, 1)
    assert.equal(eng.recent[0].rule, 'rapid-move')
    assert.equal(eng.recent[0].direction, 'up')
    assert.equal(snapCount, 2)
    await market.refresh() // 第 3 轮：同 spike → 冷却压重复
    assert.equal(eng.recent.length, 1)
    assert.ok(eng.suppressCount >= 1)
    assert.equal(fired.length, 1, 'market/signal 恰广播一次')
    // 工具：live 强刷（fetchCount 已 >2，恒返 spiked）+ 方向过滤
    const tool = ctx.require<ToolsService>('tools').get('get_signals')!
    assert.equal(tool.permissionHint, 'read')
    const out = await tool.execute({ direction: 'up' }, {})
    assert.match(out, /信号 1 条/)
    assert.match(out, /sh600000 平平稳稳 rapid-move ↑ 强度3\.5/)
    const down = await tool.execute({ direction: 'down' }, {})
    assert.match(down, /信号 0 条/)
    assert.match(out, /\[10:00\]/) // 固定 UTC+8 格式化
})

// ---------- 宇宙闸 + 重发纪律（2026-10-21 跟踪 Day 1 复盘 P0） ----------

test('引擎：宇宙闸——bj 前缀/ST 名称/成交额下限三道排除（默认开）', async () => {
    const ctx = new Context()
    new ToolsService(ctx, 'tools')
    // 四只同形态异动：干净 sh / bj 前缀 / ST 名称 / sh 地量（amount 100 万 < 闸 1,000 万）
    const calm = [
        makeQuote('sh600000', '平平稳稳', 10, 1.0),
        makeQuote('bj920001', '北交噪', 10, 1.0),
        makeQuote('sh600999', 'ST麻烦', 10, 1.0),
        { ...makeQuote('sh600001', '地量票', 10, 1.0), amount: 1e6 },
    ]
    const spike = [
        makeQuote('sh600000', '平平稳稳', 10.35, 4.5),
        makeQuote('bj920001', '北交噪', 10.35, 4.5),
        makeQuote('sh600999', 'ST麻烦', 10.35, 4.5),
        { ...makeQuote('sh600001', '地量票', 10.35, 4.5), amount: 1e6 },
    ]
    let n = 0
    const src: QuoteSource = {
        async fetchMarketSnapshot() { n++; return n === 1 ? calm : spike },
        async fetchQuotes() { return [] },
    }
    ctx.plugin(marketDataPlugin, { source: src, now: () => new Date(T0), pollIntervalMs: 60_000 })
    const fired: Signal[] = []
    ctx.on('market/signal', (s) => { fired.push(s) })
    ctx.plugin(signalEnginePlugin, { strategy: DEFAULT_STRATEGY })
    const market = ctx.market!
    await market.refresh()
    await market.refresh()
    // Day 1 那类 *ST田野 / BJ 僵尸信号在源头死掉，不烧裁决 turn
    assert.equal(fired.length, 1)
    assert.equal(fired[0].code, 'sh600000')
})

test('引擎：重发纪律——同向重发须强度×1.5，日上限 2 次，跨日重置', async () => {
    const ctx = new Context()
    new ToolsService(ctx, 'tools')
    // 五轮异动（rapid-move，窗内基点恒为首轮 10 元）：
    //   +3.5 发① → +5.5（>1.5×3.5=5.25）发② → +6.0（≤8.25）强度压 →
    //   +9.0（>8.25 但日限 2）上限压 → 次日首轮 5min 窗只剩单点（隔夜缺口，
    //   窗类指标 null）→ 次日第二轮起窗重建：+3.92 日键翻篇计数清零 → 发③
    const prices = [10, 10.35, 10.55, 10.6, 10.9, 10.2, 10.6]
    let round = 0
    let clock = T0
    const src: QuoteSource = {
        async fetchMarketSnapshot() {
            const p = prices[Math.min(round, prices.length - 1)]
            return [makeQuote('sh600000', '平平稳稳', p, (p / 10 - 1) * 100)]
        },
        async fetchQuotes() { return [] },
    }
    const now = () => new Date(clock)
    ctx.plugin(marketDataPlugin, { source: src, now, pollIntervalMs: 60_000 })
    const fired: Signal[] = []
    ctx.on('market/signal', (s) => { fired.push(s) })
    ctx.plugin(signalEnginePlugin, { cooldownMs: 0 })
    const market = ctx.market!
    for (let i = 0; i < 5; i++) {
        round = i
        clock = T0 + i * MIN
        await market.refresh()
    }
    assert.equal(fired.length, 2, '发①②后 +6.0 与 +9.0 都被压（强度不足 / 日上限）')
    round = 5
    clock = T0 + 24 * 60 * MIN // 跨日：fireStats 惰性重置，不引新钟
    await market.refresh()
    round = 6
    clock = T0 + 24 * 60 * MIN + MIN
    await market.refresh()
    assert.equal(fired.length, 3)
    assert.ok(Math.abs(fired[2].strength - 3.92) < 1e-9,
        `次日首发强度 = (10.6-10.2)/10.2 = 3.92，实际 ${fired[2].strength}`)
})

test('引擎：重发纪律——方向翻转须强度×2', async () => {
    const ctx = new Context()
    new ToolsService(ctx, 'tools')
    // down −3.5 发① → up +3.5 翻转（3.5 ≤ 2×3.5=7）压 → up +8.0（>7）发②
    const prices = [10, 9.65, 10.35, 10.8]
    let round = 0
    let clock = T0
    const src: QuoteSource = {
        async fetchMarketSnapshot() {
            const p = prices[Math.min(round, prices.length - 1)]
            return [makeQuote('sh600000', '平平稳稳', p, (p / 10 - 1) * 100)]
        },
        async fetchQuotes() { return [] },
    }
    const now = () => new Date(clock)
    ctx.plugin(marketDataPlugin, { source: src, now, pollIntervalMs: 60_000 })
    const fired: Signal[] = []
    ctx.on('market/signal', (s) => { fired.push(s) })
    ctx.plugin(signalEnginePlugin, { cooldownMs: 0 })
    const market = ctx.market!
    for (let i = 0; i < 4; i++) {
        round = i
        clock = T0 + i * MIN
        await market.refresh()
    }
    assert.equal(fired.length, 2)
    assert.equal(fired[0].direction, 'down')
    assert.equal(fired[1].direction, 'up')
    assert.equal(fired[1].strength, 8)
})
