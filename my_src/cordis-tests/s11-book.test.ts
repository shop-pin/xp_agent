// S11 单测：盘口——hq 五档解析对拍（手拼真实格式行）、买卖压力手算、
// book-pressure / volume-divergence 规则用例（机械门槛两腿：压力值+价格同向 /
// 背离幅度+量率）、关注面盘口轮询集成（market/book 广播 → 引擎缓存 → 规则吃到
// 盘口 + 明细层盘口行落盘）+ get_quote 盘口行。
// 运行：npm run cordis
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { Context } from '../cordis/context.js'
import { ToolsService } from '../services/tools.js'
import { SessionLog } from '../services/session-log.js'
import { CommandService } from '../services/commands.js'
import { marketDataPlugin, parseSinaResponse, type Book, type MarketDataService, type Quote, type QuoteSource } from '../plugins/market-data.js'
import { signalEnginePlugin, bookPressure, defaultRules, type Point } from '../plugins/signal-engine.js'
import { dataStorePlugin, readSchemaJsonl, detailPath, SCHEMA_DETAIL, type DataStoreService } from '../plugins/data-store.js'

// 2026-10-19 周一 10:00 CST 开盘中
const T0 = Date.UTC(2026, 9, 19, 2, 0, 0)
const MIN = 60_000

const P = (at: number, price: number, volume = 0, amount = 0): Point => ({ at, price, volume, amount })

// fixture 风格手拼 hq 行（真实响应格式：GBK 解码后文本；量=股）
// f[0..9] 头部 → f[10..19] 买五档(量,价) → f[20..29] 卖五档(量,价) → f[30..31] 日期时间
const HQ_LINE = 'var hq_str_sh600000="浦发银行,9.80,9.90,10.00,10.20,9.70,9.99,10.01,100000,10000000,'
    + '1200,9.99,800,9.98,600,9.97,400,9.96,200,9.95,'
    + '300,10.01,500,10.02,700,10.03,900,10.04,1100,10.05,'
    + '2026-10-19,10:00:00";'

test('hq 五档解析对拍：bids/asks 逐档钉死（量=股）', () => {
    const q = parseSinaResponse(HQ_LINE)[0]!
    assert.equal(q.code, 'sh600000')
    assert.deepEqual(q.book, {
        bids: [
            { v: 1200, p: 9.99 }, { v: 800, p: 9.98 }, { v: 600, p: 9.97 },
            { v: 400, p: 9.96 }, { v: 200, p: 9.95 },
        ],
        asks: [
            { v: 300, p: 10.01 }, { v: 500, p: 10.02 }, { v: 700, p: 10.03 },
            { v: 900, p: 10.04 }, { v: 1100, p: 10.05 },
        ],
    })
})

test('bookPressure 手算：(Σ买−Σ卖)/(Σ买+Σ卖)，零盘口 null', () => {
    assert.ok(Math.abs(bookPressure({
        bids: [{ p: 10, v: 300 }, { p: 9.99, v: 300 }],
        asks: [{ p: 10.01, v: 200 }, { p: 10.02, v: 0 }],
    })! - 0.5) < 1e-9)
    assert.equal(bookPressure({ bids: [{ p: 10, v: 100 }], asks: [{ p: 10.01, v: 100 }] }), 0)
    assert.equal(bookPressure(undefined), null)
    assert.equal(bookPressure({ bids: [], asks: [] }), null)
    assert.equal(bookPressure({ bids: [{ p: 10, v: 0 }], asks: [{ p: 10.01, v: 0 }] }), null)
})

test('book-pressure 规则：|压力|≥0.6 + 与 5min 涨速同向 + |chg|≥1；反向/弱压力不响', () => {
    const rule = defaultRules().find((r) => r.name === 'book-pressure')!
    const series = [P(T0, 10), P(T0 + MIN, 10.05), P(T0 + 2 * MIN, 10.1), P(T0 + 3 * MIN, 10.15), P(T0 + 4 * MIN, 10.2)]
    const quote = { code: 'sh600000', name: '浦发银行', price: 10.2 } as Quote
    // 买方强 0.75 + 涨 2% 同向 → up
    const bull: Book = { bids: [{ p: 10.19, v: 700 }], asks: [{ p: 10.21, v: 100 }] }
    const up = rule.evaluate({ quote, series, book: bull })
    assert.equal(up?.direction, 'up')
    assert.equal(up?.strength, 0.75)
    // 卖方强但价格在涨：反向 → 托压把戏不认
    const bear: Book = { bids: [{ p: 10.19, v: 100 }], asks: [{ p: 10.21, v: 700 }] }
    assert.equal(rule.evaluate({ quote, series, book: bear }), null)
    // 压力 0：不响
    assert.equal(rule.evaluate({ quote, series, book: { bids: [{ p: 10, v: 300 }], asks: [{ p: 10.01, v: 300 }] } }), null)
    // 无盘口（非关注面码）：null 让路
    assert.equal(rule.evaluate({ quote, series }), null)
})

test('volume-divergence 规则：价走 1.5%+ 而量率 <0.8 → 顶背离 down / 底背离 up', () => {
    const rule = defaultRules().find((r) => r.name === 'volume-divergence')!
    // 10 轮温和量（每轮 +60 手）后价格 +2% 但量率趴着：avg = 580/600s ≈ 0.97 手/s，
    // probe（末 60s）= 40/60s ≈ 0.67 手/s → surge ≈ 0.69 < 0.8
    const mkSeries = (lastPrice: number): Point[] => {
        const s: Point[] = []
        let v = 1000
        for (let i = 0; i < 10; i++) { s.push(P(T0 + i * MIN, 10, v)); v += 60 }
        s.push(P(T0 + 10 * MIN, lastPrice, 1580))
        return s
    }
    const top = rule.evaluate({ quote: { code: 'sh600000' } as Quote, series: mkSeries(10.2) })
    assert.equal(top?.direction, 'down')
    assert.equal(top?.strength, 2)
    assert.match(top?.note ?? '', /顶背离/)
    const bottom = rule.evaluate({ quote: { code: 'sh600000' } as Quote, series: mkSeries(9.8) })
    assert.equal(bottom?.direction, 'up')
    assert.equal(bottom?.strength, -2)
    assert.match(bottom?.note ?? '', /底背离/)
    // 量能跟得上（surge 大）→ 无背离
    const loud: Point[] = []
    let v = 1000
    for (let i = 0; i < 10; i++) { loud.push(P(T0 + i * MIN, 10, v)); v += 60 }
    loud.push(P(T0 + 10 * MIN, 10.2, 2560))
    assert.equal(rule.evaluate({ quote: { code: 'sh600000' } as Quote, series: loud }), null)
})

// ---------- 集成：轮询 → 事件 → 引擎缓存 → 规则 + 明细层盘口行 ----------

const BOOK: Book = { bids: [{ p: 10.19, v: 700 }], asks: [{ p: 10.21, v: 100 }] }

function mountBook(): {
    ctx: Context; store: DataStoreService; market: MarketDataService; tools: ToolsService;
    root: string; cleanup: () => void;
} {
    const home = mkdtempSync(join(tmpdir(), 's11-home-'))
    const prevHome = process.env.HOME
    const prevProfile = process.env.USERPROFILE
    process.env.HOME = home
    process.env.USERPROFILE = home
    mkdirSync(join(home, '.mini-claude', 'stocks'), { recursive: true })
    writeFileSync(join(home, '.mini-claude', 'stocks', 'watchlist.txt'), 'sh600000  # 测试清单\n')
    const root = join(home, 'data-root')
    const ctx = new Context()
    const tools = new ToolsService(ctx, 'tools')
    new SessionLog(ctx, 'session-log')
    new CommandService(ctx, 'commands')
    let clock = T0
    let n = 0
    const src: QuoteSource = {
        async fetchMarketSnapshot() {
            n++
            return [{ code: 'sh600000', name: '浦发银行', price: n === 1 ? 10 : 10.2, change: 0, changePercent: n === 1 ? 0 : 2, open: 10, high: 10.2, low: 10, preClose: 10, volume: 1000, amount: 1e7, turnoverRate: 0.3, volumeRatio: 0, marketCap: 0, floatCap: 0, pb: 0 }]
        },
        async fetchQuotes() {
            return [{ code: 'sh600000', name: '浦发银行', price: 10.2, change: 0.2, changePercent: 2, open: 10, high: 10.2, low: 10, preClose: 10, volume: 1000, amount: 1e7, turnoverRate: 0.3, volumeRatio: 0, marketCap: 0, floatCap: 0, pb: 0, book: BOOK }]
        },
    }
    const now = () => new Date(clock)
    ctx.plugin(marketDataPlugin, { source: src, now, pollIntervalMs: 60_000 })
    ctx.plugin(signalEnginePlugin, {})
    ctx.plugin(dataStorePlugin, { rootDir: root })
    return {
        ctx, store: ctx.dataStore!, market: ctx.market!, tools, root,
        cleanup: () => {
            ctx.dataStore?.dispose()
            process.env.HOME = prevHome
            process.env.USERPROFILE = prevProfile
            rmSync(home, { recursive: true, force: true })
        },
    }
}

test('盘口轮询集成：market/book 广播 → 引擎缓存 → book-pressure 真发 + 明细层盘口行 + get_quote 五档', async () => {
    const m = mountBook()
    try {
        let bookCodes = ''
        m.ctx.on('market/book', (b) => { bookCodes = [...b.books.keys()].join(',') })
        const fired: any[] = []
        m.ctx.on('market/signal', (s) => { fired.push(s) })
        await m.market.refresh()          // 第 1 轮：平静
        await m.store.pollBooks()         // 关注面盘口轮询 → 事件 + 明细层
        assert.equal(bookCodes, 'sh600000', 'market/book 广播到引擎')

        // 第 2 轮 +2%：引擎经缓存盘口发 book-pressure（压力 0.75 与涨速同向）
        await m.market.refresh()
        const bp = fired.find((s) => s.rule === 'book-pressure')
        assert.ok(bp, '引擎吃到缓存盘口，book-pressure 发出')
        assert.equal(bp.direction, 'up')
        assert.equal(bp.strength, 0.75)

        const detail = readSchemaJsonl<any>(detailPath(m.root, '2026-10-19'), SCHEMA_DETAIL)
        const bookRow = detail.rows.find((r: any) => r.bid !== undefined)
        assert.ok(bookRow, '盘口行进关注面明细层')
        assert.deepEqual(bookRow.bid, BOOK.bids)

        // get_quote 五档行
        const out = await m.tools.get('get_quote')!.execute({ codes: ['sh600000'] }, {})
        assert.match(out as string, /盘口 买\[10\.19×700\] 卖\[10\.21×100\]（量=股）/)
    } finally {
        m.cleanup()
    }
})
