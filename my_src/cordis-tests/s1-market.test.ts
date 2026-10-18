// S1 单测：行情快照插件——解析（fixture 回放）、时段判定、筛选纯函数、
// 服务缓存行为（MockSource 注入）、工具接线（read hint + 输出形态）。
// fixture 是 2026-10-16（周五）收盘后录的真实响应——非官方接口改版时，
// 这里先红，解析函数跟上即可（接口口径记档在 plugins/market-data.ts 头注）。
// 运行：npm run cordis（tsc && node --test "dist/cordis-tests/*.test.js"）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { Context } from '../cordis/context.js'
import { ToolsService } from '../services/tools.js'
import {
    marketDataPlugin, marketPhase, screenQuotes,
    parseEastmoneyDiff, parseSinaList, parseSinaResponse,
    type Quote, type QuoteSource,
} from '../plugins/market-data.js'

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'fixtures')

function loadEmFixture(): Record<string, unknown>[] {
    const json = JSON.parse(readFileSync(join(fixturesDir, 'em-clist-p1.json'), 'utf8'))
    return json.data.diff as Record<string, unknown>[]
}

// ---------- 解析：东财 fixture 回放 ----------

test('parseEastmoneyDiff：字段映射/前缀推断/停牌容错（fixture=真实收盘页）', () => {
    const diff = loadEmFixture()
    const quotes = parseEastmoneyDiff(diff)
    assert.equal(quotes.length, diff.length)
    // 首行 N南乳 920196：f13=0 且 92 开头 → bj 前缀；量比 "-" → 0
    const first = quotes[0]
    assert.equal(first.code, 'bj920196')
    assert.equal(first.name, 'N南乳')
    assert.equal(first.price, 22.56)
    assert.equal(first.changePercent, 58.76)
    assert.equal(first.volume, 230359)   // 手（东财原生单位）
    assert.equal(first.volumeRatio, 0)   // "-" 容错
    assert.ok(first.amount > 5.9e8)
    // 与新浪 fixture 交叉验证同一只票（两源对拍）
    const sinaRaw = new TextDecoder('gbk').decode(readFileSync(join(fixturesDir, 'sina-hq-raw.bin')))
    const sinaNanru = parseSinaResponse(sinaRaw).find(q => q.code === 'bj920196')!
    assert.equal(sinaNanru.price, first.price)
    assert.equal(Math.round(sinaNanru.volume), first.volume) // 新浪股→手换算后对齐
})

test('parseEastmoneyDiff：沪/深前缀推断（f13 1=sh, 0=sz）', () => {
    const quotes = parseEastmoneyDiff([
        { f12: '600000', f13: 1, f14: '浦发银行' },
        { f12: '000001', f13: 0, f14: '平安银行' },
        { f12: '300750', f13: 0, f14: '宁德时代' },
        { f12: '920006', f13: 0, f14: '晟楠科技' },
    ])
    assert.deepEqual(quotes.map(q => q.code), ['sh600000', 'sz000001', 'sz300750', 'bj920006'])
})

// ---------- 解析：新浪列表 fixture 回放（主源） ----------

test('parseSinaList：主源字段映射（symbol 带前缀/turnoverratio 原生/万元市值）+ 两源对拍', () => {
    const rows = JSON.parse(readFileSync(join(fixturesDir, 'sina-list-p1.json'), 'utf8'))
    const quotes = parseSinaList(rows)
    assert.equal(quotes.length, rows.length)
    const first = quotes[0]
    assert.equal(first.code, 'bj920000')
    assert.equal(first.name, '安徽凤凰')
    assert.equal(first.price, 13.1)
    assert.equal(first.preClose, 12.98)
    assert.equal(first.volume, 3259)             // 325892 股 → 手
    assert.ok(Math.abs(first.turnoverRate - 0.56584) < 1e-9)
    assert.equal(first.volumeRatio, 0)           // 主源无量比（S5 历史序列补，记档）
    assert.ok(Math.abs(first.floatCap - 75448.04175 * 1e4) < 1)
    // 两源对拍：bj920006 同日收盘，价/涨幅/换手/市净率一致（量的尾差=东财取整）
    const emDiff = loadEmFixture()
    const emRow = emDiff.find(d => d.f12 === '920006')!
    const sjRow = quotes.find(q => q.code === 'bj920006')!
    assert.equal(sjRow.price, num(emRow.f2))
    assert.ok(Math.abs(sjRow.changePercent - num(emRow.f3)) < 0.01)
    assert.ok(Math.abs(sjRow.volume * 100 - num(emRow.f5) * 100) <= 100)
    assert.ok(Math.abs(sjRow.turnoverRate - num(emRow.f8)) < 0.01)
    assert.ok(Math.abs(sjRow.pb - num(emRow.f23)) < 0.01)
})

// ---------- 解析：新浪明细 fixture 回放 ----------

test('parseSinaResponse：GBK 头字段映射 + 涨跌幅派生 + quotedAt', () => {
    const raw = new TextDecoder('gbk').decode(readFileSync(join(fixturesDir, 'sina-hq-raw.bin')))
    const quotes = parseSinaResponse(raw)
    assert.equal(quotes.length, 5)
    const pufa = quotes.find(q => q.code === 'sh600000')!
    assert.equal(pufa.name, '浦发银行')
    assert.equal(pufa.open, 9.6)
    assert.equal(pufa.preClose, 9.64)
    assert.equal(pufa.price, 9.73)
    assert.ok(Math.abs(pufa.changePercent - ((9.73 / 9.64) - 1) * 100) < 1e-9)
    assert.equal(pufa.volume, 922942)  // 92294209 股 → 手
    assert.equal(pufa.quotedAt, '2026-10-16 15:34:59')
})

test('parseSinaResponse：坏行/空行容错（非 var 行跳过，不炸整批）', () => {
    const quotes = parseSinaResponse('garbage\n\nvar hq_str_sh600000="";\n')
    assert.equal(quotes.length, 0) // 空主体 f[0] 为空 → 跳过
})

// ---------- 时段判定（UTC 构造 → Asia/Shanghai 断言） ----------

test('marketPhase：北京时间边界（周五的四个时段 + 周末休市）', () => {
    // 2026-10-16 是周五。UTC+8：01:10Z=09:10 closed, 01:20Z=09:20 auction,
    // 01:30Z=09:30 open, 03:45Z=11:45 lunch, 05:00Z=13:00 open, 07:00Z=15:00 closed
    const fri = (h: number, m: number) => new Date(Date.UTC(2026, 9, 16, h, m))
    assert.equal(marketPhase(fri(1, 10)), 'closed')
    assert.equal(marketPhase(fri(1, 20)), 'auction')
    assert.equal(marketPhase(fri(1, 30)), 'open')
    assert.equal(marketPhase(fri(3, 45)), 'lunch')
    assert.equal(marketPhase(fri(5, 0)), 'open')
    assert.equal(marketPhase(fri(7, 0)), 'closed')
    // 2026-10-18 是周日
    assert.equal(marketPhase(new Date(Date.UTC(2026, 9, 18, 3, 0))), 'closed')
})

// ---------- 筛选纯函数 ----------

const SAMPLE: Quote[] = [
    { code: 'sh600001', name: '正常股', price: 10, change: 0.5, changePercent: 5.2, open: 9.6, high: 10.2, low: 9.5, preClose: 9.5, volume: 30000, amount: 5e8, turnoverRate: 3.1, volumeRatio: 2.5, marketCap: 1e10, floatCap: 8e9, pb: 1.2 },
    { code: 'sz000002', name: 'ST 麻烦', price: 5, change: 0.25, changePercent: 5.3, open: 4.8, high: 5.1, low: 4.7, preClose: 4.75, volume: 10000, amount: 2e8, turnoverRate: 1.0, volumeRatio: 1.5, marketCap: 5e9, floatCap: 3e9, pb: 0.9 },
    { code: 'bj920003', name: '北交小票', price: 20, change: 5, changePercent: 33.3, open: 15, high: 20, low: 15, preClose: 15, volume: 5000, amount: 1e8, turnoverRate: 8.0, volumeRatio: 4.0, marketCap: 2e9, floatCap: 1e9, pb: 3.3 },
    { code: 'sz300004', name: '停牌股', price: 0, change: 0, changePercent: 0, open: 0, high: 0, low: 0, preClose: 8, volume: 0, amount: 0, turnoverRate: 0, volumeRatio: 0, marketCap: 0, floatCap: 0, pb: 0 },
]

test('screenQuotes：默认项（排除 ST/bj、price>0、changePercent 降序、limit）', () => {
    const rows = screenQuotes(SAMPLE, {})
    assert.deepEqual(rows.map(r => r.code), ['sh600001']) // ST/bj/停牌全被默认挡掉
})

test('screenQuotes：条件组合 + includeBJ + 排序字段与方向 + limit 上限', () => {
    const rows = screenQuotes(SAMPLE, { changePercentMin: 5, excludeBJ: false, excludeST: false })
    assert.deepEqual(rows.map(r => r.code), ['bj920003', 'sz000002', 'sh600001'])
    const cheap = screenQuotes(SAMPLE, { priceMax: 10, order: 'asc', excludeST: false })
    // sortBy 默认 changePercent：asc = 涨幅小者在前（5.2 < 5.3）
    assert.deepEqual(cheap.map(r => r.code), ['sh600001', 'sz000002'])
    const byAmount = screenQuotes(SAMPLE, { excludeST: false, excludeBJ: false, sortBy: 'amount' })
    assert.deepEqual(byAmount.map(r => r.code), ['sh600001', 'sz000002', 'bj920003', 'sz300004'].slice(0, 3))
    assert.equal(screenQuotes(SAMPLE, { limit: 99 }).length <= 50, true)
})

// ---------- 服务行为 + 工具接线（MockSource 注入真插件） ----------

function mockSource(quotes: Quote[]): QuoteSource & { snapshotCalls: number } {
    return {
        snapshotCalls: 0,
        async fetchMarketSnapshot() { this.snapshotCalls++; return quotes },
        async fetchQuotes(codes) { return quotes.filter(q => codes.includes(q.code)) },
    }
}

function mountMarket(quotes: Quote[], config: Record<string, unknown> = {}) {
    const ctx = new Context()
    new ToolsService(ctx, 'tools')
    const source = mockSource(quotes)
    const fiber = ctx.plugin(marketDataPlugin, { source, ...config })
    return { ctx, fiber, source, market: ctx.market! }
}

test('服务：启动首轮拉取 + 交易时段内轮询 + 休市停摆（时钟注入）', async () => {
    let fakeNow = new Date(Date.UTC(2026, 9, 16, 1, 30)) // 周五 09:30 CST = open
    const { fiber, source, market } = mountMarket(SAMPLE, {
        pollIntervalMs: 5,
        now: () => fakeNow,
    })
    await new Promise(r => setTimeout(r, 20))
    const openCalls = source.snapshotCalls
    assert.ok(openCalls >= 2, `open 阶段应持续轮询（实际 ${openCalls}）`)
    fakeNow = new Date(Date.UTC(2026, 9, 18, 3, 0)) // 周日 = closed
    const frozen = source.snapshotCalls
    await new Promise(r => setTimeout(r, 20))
    assert.equal(source.snapshotCalls, frozen, '休市阶段不应刷新')
    assert.equal(market.latest!.quotes.length, SAMPLE.length)
    await fiber.dispose()
})

test('服务：ensureFresh 缓存语义（新鲜不重拉，过期重拉）+ 环形缓冲封顶', async () => {
    const { fiber, source, market } = mountMarket(SAMPLE, { pollIntervalMs: 60_000, historyRounds: 3 })
    await market.ensureFresh(60_000)
    const afterFirst = source.snapshotCalls
    await market.ensureFresh(60_000) // 新鲜 → 不重拉
    assert.equal(source.snapshotCalls, afterFirst)
    await market.ensureFresh(-1)     // 恒过期 → 重拉
    assert.equal(source.snapshotCalls, afterFirst + 1)
    assert.ok(market.history.length <= 3)
    await fiber.dispose()
})

test('工具：注册/权限/read hint + screen_market 输出含统计头与命中行', async () => {
    const { ctx, fiber, market } = mountMarket(SAMPLE)
    const tools = ctx.require<ToolsService>('tools')
    const screen = tools.get('screen_market')!
    const quote = tools.get('get_quote')!
    assert.equal(screen.permissionHint, 'read')
    assert.equal(quote.permissionHint, 'read')
    const out = await screen.execute({ changePercentMin: 5 }, {})
    assert.match(out, /全市场 4 只，命中 1 条/)
    assert.match(out, /sh600001/)
    assert.match(out, /当前时段 (open|closed|auction|lunch)/) // 时段头存在（值随真实时钟，不锚死）
    const detail = await quote.execute({ codes: ['sh600001'] }, {})
    assert.match(detail, /浦发银行|正常股/)
    const badCodes = await quote.execute({ codes: ['600000'] }, {}) // 无前缀 → 校验拒绝
    assert.match(badCodes, /Error: no valid codes/)
    await fiber.dispose()
})
