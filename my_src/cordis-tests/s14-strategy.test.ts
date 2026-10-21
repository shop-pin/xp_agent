// S14 单测：策略即配置——loadStrategy 默认权威/用户覆盖节级深合并/坏配置明确
// 拒读（不静默回默认）；规则阈值吃策略（阈值 9 时 +5% 不触发）；一致行为锚：
// 池工具消费用户覆盖的 pool.topN（回测 CLI 与盯盘系统同一份配置）。
// 运行：npm run cordis
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { Context } from '../cordis/context.js'
import { ToolsService } from '../services/tools.js'
import { DEFAULT_STRATEGY, loadStrategy, userStrategyPath } from '../plugins/strategy.js'
import { defaultRules, type Point } from '../plugins/signal-engine.js'
import { marketDataPlugin, type Quote, type QuoteSource } from '../plugins/market-data.js'

const T0 = Date.UTC(2026, 9, 19, 2, 0, 0)
const P = (at: number, price: number): Point => ({ at, price, volume: 0, amount: 0 })

/** HOME 沙箱（strategy.json 覆盖文件读写隔离真实家目录）。 */
function sandbox(): { home: string; restore: () => void } {
    const home = mkdtempSync(join(tmpdir(), 's14-home-'))
    const prevHome = process.env.HOME
    const prevProfile = process.env.USERPROFILE
    process.env.HOME = home
    process.env.USERPROFILE = home
    return { home, restore: () => { process.env.HOME = prevHome; process.env.USERPROFILE = prevProfile; rmSync(home, { recursive: true, force: true }) } }
}

test('loadStrategy：无覆盖 = 权威默认；覆盖节级深合并（节内部分覆盖保留其余键）', () => {
    const { home, restore } = sandbox()
    try {
        assert.equal(loadStrategy(), DEFAULT_STRATEGY, '无覆盖文件 → 同一引用（零漂移权威）')
        mkdirSync(join(home, '.mini-claude', 'stocks'), { recursive: true })
        writeFileSync(userStrategyPath(), JSON.stringify({
            signals: { rapidMovePct: 9 },
            risk: { maxDailyLoss: 100 },
        }))
        const s = loadStrategy()
        assert.equal(s.signals.rapidMovePct, 9, '覆盖键生效')
        assert.equal(s.signals.cooldownMs, DEFAULT_STRATEGY.signals.cooldownMs, '同节未覆盖键回落默认')
        assert.equal(s.risk.maxDailyLoss, 100)
        assert.equal(s.risk.maxPositionPct, DEFAULT_STRATEGY.risk.maxPositionPct, '其他节不受影响')
    } finally {
        restore()
    }
})

test('loadStrategy：坏配置明确拒读（错配的策略比启动失败危险）', () => {
    const { home, restore } = sandbox()
    try {
        mkdirSync(join(home, '.mini-claude', 'stocks'), { recursive: true })
        writeFileSync(userStrategyPath(), '{broken')
        assert.throws(() => loadStrategy(), /不可解析/)
    } finally {
        restore()
    }
})

test('规则阈值接线：defaultRules 吃策略——阈值提到 9% 时 +5% 不再触发', () => {
    const series = [P(T0, 10), P(T0 + 60_000, 10), P(T0 + 120_000, 10), P(T0 + 180_000, 10), P(T0 + 240_000, 10.5)]
    const quote = { code: 'sh600000', name: '测试', price: 10.5 } as Quote
    const on = defaultRules().find((r) => r.name === 'rapid-move')!.evaluate({ quote, series })
    assert.equal(on?.direction, 'up', '默认阈值 3%：+5% 触发')
    const strict = defaultRules({ ...DEFAULT_STRATEGY.signals, rapidMovePct: 9 })
        .find((r) => r.name === 'rapid-move')!.evaluate({ quote, series })
    assert.equal(strict, null, '阈值 9%：+5% 不触发——规则参数确实来自策略')
})

test('一致行为锚：池工具消费用户覆盖的 pool.topN（回测 CLI 与盯盘同源）', async () => {
    const { home, restore } = sandbox()
    try {
        mkdirSync(join(home, '.mini-claude', 'stocks'), { recursive: true })
        writeFileSync(userStrategyPath(), JSON.stringify({ pool: { topN: 1 } }))
        const ctx = new Context()
        new ToolsService(ctx, 'tools')
        const FIX: Quote[] = [
            { code: 'sh600010', name: '甲', price: 10, change: 0, changePercent: 1, open: 10, high: 10, low: 10, preClose: 10, volume: 1000, amount: 5e7, turnoverRate: 2, volumeRatio: 0, marketCap: 0, floatCap: 5e8, pb: 2, pe: 30 },
            { code: 'sh600011', name: '乙', price: 10, change: 0, changePercent: 1, open: 10, high: 10, low: 10, preClose: 10, volume: 1000, amount: 5e7, turnoverRate: 2, volumeRatio: 0, marketCap: 0, floatCap: 6e8, pb: 2, pe: 30 },
        ]
        const src: QuoteSource = {
            async fetchMarketSnapshot() { return FIX },
            async fetchQuotes() { return [] },
        }
        ctx.plugin(marketDataPlugin, { source: src }) // 不传 strategy → 走 loadStrategy() 读用户覆盖
        const out = await ctx.require<ToolsService>('tools').get('get_stock_pool')!.execute({}, {})
        assert.match(out as string, /候选 1 只/)
        assert.match(out as string, /sh600010  甲/)
        assert.doesNotMatch(out as string, /乙/)
    } finally {
        restore()
    }
})
