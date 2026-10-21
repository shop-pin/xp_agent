// S12 单测：微盘候选池——七道过滤手算用例（八类违规样本逐一钉）、topN 裁剪
// 与流通市值升序、ipoDays 缺表退化（N/C 前缀仍剔、有表才硬过滤次新）、
// parseSinaList per→pe、get_stock_pool 工具（过滤前后计数 + IPO 源注记）。
// 运行：npm run cordis
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '../cordis/context.js'
import { ToolsService } from '../services/tools.js'
import { marketDataPlugin, parseSinaList, pickPool, type Quote, type QuoteSource } from '../plugins/market-data.js'
import { DEFAULT_STRATEGY } from '../plugins/strategy.js'

const q = (over: Partial<Quote>): Quote => ({
    code: 'sh600000', name: '测试股', price: 10, change: 0, changePercent: 1,
    open: 10, high: 10, low: 10, preClose: 10, volume: 1000, amount: 5e7,
    turnoverRate: 2, volumeRatio: 0, marketCap: 0, floatCap: 10e8, pb: 2, pe: 30, ...over,
})

test('pickPool 七道过滤：八类违规样本逐一剔除（手算）', () => {
    const quotes = [
        q({ code: 'sh600001', name: '停牌票', price: 0 }),        // ① 停牌/无效行
        q({ code: 'sh600002', name: 'ST麻烦' }),                  // ② ST（红线）
        q({ code: 'bj920001', name: '北交票' }),                  // ③ 板块（北交所红线）
        q({ code: 'sh600004', name: '地量票', amount: 1e7 }),     // ④ 流动性（< 3e7）
        q({ code: 'sh600005', name: '低价票', price: 1.5 }),      // ⑤ 低价（< 2 元）
        q({ code: 'sh600006', name: '亏损票', pe: -12 }),         // ⑥ PE 负
        q({ code: 'sh600007', name: '爆表票', pe: 999 }),         // ⑦ PE 超上限
        q({ code: 'sh600008', name: '负资产', pb: 0 }),           // ⑧ PB>0
        q({ code: 'sh600009', name: 'N新股' }),                   // 次新退化腿（无表也剔）
        q({ code: 'sh600010', name: '合法最小', floatCap: 5e8 }),
        q({ code: 'sh600011', name: '合法次小', floatCap: 8e8 }),
        q({ code: 'sh600012', name: '合法大', floatCap: 50e8 }),
    ]
    const pool = pickPool(quotes, {
        today: '2026-10-19',
        ipoDays: new Map([['sh600011', '2026-06-01']]), // 上市 140 天 < 365 → 次新剔
    })
    assert.deepEqual(pool.map((x) => x.code), ['sh600010', 'sh600012'])
})

test('pickPool：topN 裁剪按流通市值升序；缺表只剔 N/C 前缀', () => {
    const quotes = [
        q({ code: 'sh600001', floatCap: 30e8 }),
        q({ code: 'sz000002', floatCap: 10e8, name: 'C次新' }),   // C 前缀：上市 2-5 日
        q({ code: 'sh600003', floatCap: 20e8 }),
        q({ code: 'sh600004', floatCap: 15e8 }),
    ]
    const pool = pickPool(quotes, { topN: 2, today: '2026-10-19' })
    assert.deepEqual(pool.map((x) => x.code), ['sh600004', 'sh600003'])
    assert.ok(pool[0]!.floatCap <= pool[1]!.floatCap, '升序')
})

test('parseSinaList：per 字段 → pe（第五批判定的"差一行解析"兑现）', () => {
    const rows = [{
        symbol: 'sh600000', name: '浦发银行', trade: '10', pricechange: '0.1',
        changepercent: '1.01', open: '9.8', high: '10.2', low: '9.7', settlement: '9.9',
        volume: '100000', amount: '10000000', turnoverratio: '0.3',
        mktcap: '3000', nmc: '2500', pb: '0.5', per: '6.2',
    }]
    const q = parseSinaList(rows)[0]!
    assert.equal(q.pe, 6.2)
    assert.equal(q.floatCap, 2500 * 1e4)
})

test('get_stock_pool 工具：候选名单 + 过滤前后计数 + IPO 源注记', async () => {
    const ctx = new Context()
    new ToolsService(ctx, 'tools')
    const FIX: Quote[] = [
        q({ code: 'sh600001', name: 'ST麻烦' }),
        q({ code: 'sh600002', name: '地量票', amount: 1e6 }),
        q({ code: 'sh600010', name: '甲', floatCap: 5e8 }),
        q({ code: 'sh600011', name: '乙', floatCap: 9e8 }),
        q({ code: 'sh600012', name: '丙', floatCap: 7e8 }),
    ]
    const src: QuoteSource = {
        async fetchMarketSnapshot() { return FIX },
        async fetchQuotes() { return [] },
        async fetchIpoDays() { return new Map([['sh600011', '2026-09-01']]) }, // 乙次新
    }
    ctx.plugin(marketDataPlugin, { source: src, strategy: DEFAULT_STRATEGY })
    const out = await ctx.require<ToolsService>('tools').get('get_stock_pool')!.execute({}, {})
    const text = out as string
    assert.match(text, /候选 2 只（全市场 5，IPO源东财f26 1 只/)
    assert.match(text, /sh600010  甲/)
    assert.match(text, /sh600012  丙/)
    assert.doesNotMatch(text, /ST麻烦/)
    assert.doesNotMatch(text, /sh600011/)

    // IPO 源失败 → 退化注记
    const src2: QuoteSource = {
        async fetchMarketSnapshot() { return FIX },
        async fetchQuotes() { return [] },
        async fetchIpoDays() { throw new Error('EM down') },
    }
    const ctx2 = new Context()
    new ToolsService(ctx2, 'tools')
    ctx2.plugin(marketDataPlugin, { source: src2, strategy: DEFAULT_STRATEGY })
    const out2 = await ctx2.require<ToolsService>('tools').get('get_stock_pool')!.execute({}, {})
    assert.match(out2 as string, /退化N\/C前缀/)
    assert.match(out2 as string, /sh600010  甲/)
})
