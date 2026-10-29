// M7 单测：TdxQuoteSource——网关 RPC 桥（fixture 回放，fetchImpl 注入零网络）、
// TDX 行投影（A股过滤/停牌跳过/changePercent 派生/估值字段 0）、名称表合并、
// 短页终止、rpc 错误路径。fixture = 2026-10-27 真机照录节选。运行：npm run cordis
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isAShare, projectTdxRecord, TdxQuoteSource } from '../plugins/market-data-tdx.js'
import type { QuoteSource } from '../plugins/market-data.js'

// ---------- 投影纯函数 ----------

const REC = {
    exchange: 'sh', code: '600000', last_price: 9.82, pre_close_price: 9.62,
    open_price: 9.56, high_price: 9.87, low_price: 9.53,
    total_hand: 807_530, amount: 789_322_240.0,
}

test('projectTdxRecord：字段映射 + changePercent 派生（手算）', () => {
    const q = projectTdxRecord(REC, '浦发银行')!
    assert.equal(q.code, 'sh600000')
    assert.equal(q.name, '浦发银行')
    assert.equal(q.price, 9.82)
    assert.equal(q.preClose, 9.62)
    assert.ok(Math.abs(q.change - 0.2) < 1e-9)
    assert.ok(Math.abs(q.changePercent - 2.079) < 1e-9,
        '派生 last/pre−1 后 round4：(9.82/9.62−1)×100 = 2.0790…→2.079')
    assert.equal(q.volume, 807_530, '手')
    assert.equal(q.amount, 789_322_240.0, '元')
    assert.equal(q.turnoverRate, 0, '估值缺口填 0=未知（与新浪明细同约定）')
    assert.equal(q.floatCap, 0)
})

test('projectTdxRecord：A股过滤与停牌跳过', () => {
    assert.equal(projectTdxRecord({ ...REC, exchange: 'sh', code: '900901' }, 'B股'), null,
        'sh900 B股出列')
    assert.equal(projectTdxRecord({ ...REC, exchange: 'sz', code: '300750' }, '创业板')?.code,
        'sz300750', 'sz3 在列')
    assert.equal(projectTdxRecord({ ...REC, last_price: 0 }, '停牌'), null, '停牌价 0 跳过')
    assert.ok(isAShare('bj', '430047') && isAShare('bj', '832000'))
    assert.ok(!isAShare('sh', '500001'), '基金出列')
})

// ---------- 网关桥（fetchImpl 注入回放） ----------

/** 按 method 分发的假网关：/rpc POST → {ok, result}。 */
function fakeGateway(routes: Record<string, (params: any) => unknown>) {
    const calls: Array<{ method: string; params: any }> = []
    const fetchImpl = (async (url: any, init?: any) => {
        const body = JSON.parse(init.body)
        calls.push({ method: body.method, params: body.params })
        const handler = routes[body.method]
        const payload = handler
            ? { ok: true, result: handler(body.params) }
            : { ok: false, error: `no route: ${body.method}` }
        return { ok: true, status: 200, json: async () => payload } as any
    }) as typeof fetch
    return { fetchImpl, calls }
}

const NAMES = [
    { exchange: 'sh', code: '600000', name: '浦发银行', category: 'a_share' },
    { exchange: 'sh', code: '900901', name: 'B股', category: 'b_share' },
]
const PAGE1 = { records: [REC, { ...REC, code: '600009' }] }
const PAGE2 = { records: [{ ...REC, exchange: 'sz', code: '000001', last_price: 11.47, pre_close_price: 11.3 }] }

function makeSource(routes: Record<string, (p: any) => unknown>) {
    const gw = fakeGateway(routes)
    const src: QuoteSource = new TdxQuoteSource({
        fetchImpl: gw.fetchImpl, now: () => 1_000_000,
    })
    return { src, calls: gw.calls }
}

test('fetchQuotes：快照映射 + 名称合并 + rpc 错误路径', async () => {
    const { src, calls } = makeSource({
        'codes.latest_stock_list': () => NAMES,
        'quotes.get_snapshots': () => [REC],  // get_snapshots 的 result 是裸数组
    })
    const out = await src.fetchQuotes(['sh600000'])
    assert.equal(out.length, 1)
    assert.equal(out[0]!.name, '浦发银行', '名称表合并')
    assert.equal(calls[0]!.method, 'codes.latest_stock_list', '先拉名称表')
    assert.deepEqual(calls[1]!.params, { codes: ['sh600000'] })

    const bad = makeSource({}) // 无路由 → ok:false
    await assert.rejects(() => bad.src.fetchQuotes(['sh600000']), /no route/)
})

test('fetchMarketSnapshot：分页短页即止 + B股过滤 + 全失败才炸', async () => {
    // pageSize=2：PAGE1（2 只，满页续拉）→ PAGE2（1 只，短页终止）
    const routes = {
        'codes.latest_stock_list': () => NAMES,
        'quotes.list_by_category': (p: any) =>
            p.category === '沪深A股' ? (p.start === 0 ? PAGE1 : PAGE2) : { records: [] },
    }
    const gw = fakeGateway(routes)
    const src = new TdxQuoteSource({ fetchImpl: gw.fetchImpl, now: () => 1_000_000, pageSize: 2 })
    const quotes = await src.fetchMarketSnapshot()
    assert.equal(quotes.length, 3, 'PAGE1 两只 + PAGE2 一只')
    assert.ok(!quotes.some((q) => q.code === 'sh900901'), 'A股过滤在投影层')
    const pageCalls = gw.calls.filter((c) => c.method === 'quotes.list_by_category')
    assert.equal(pageCalls.length, 2, '满页续拉 + 短页终止')
    assert.deepEqual(pageCalls[0]!.params, { category: '沪深A股', start: 0, count: 2 })

    // 失败两态：rpc 报错原样上浮（带方法名，好排障）；源返回空 = fail-closed 明示
    const dead = makeSource({ 'codes.latest_stock_list': () => NAMES })
    await assert.rejects(() => dead.src.fetchMarketSnapshot(), /rpc quotes.list_by_category 失败/)
    const empty = makeSource({
        'codes.latest_stock_list': () => NAMES,
        'quotes.list_by_category': () => ({ records: [] }),
    })
    await assert.rejects(() => empty.src.fetchMarketSnapshot(), /全市场快照为空/)

    // 名称表 TTL 内复用：第二次快照不再拉名称表
    const { src: src2, calls: calls2 } = makeSource(routes)
    await src2.fetchMarketSnapshot()
    const n1 = calls2.filter((c) => c.method === 'codes.latest_stock_list').length
    await src2.fetchMarketSnapshot()
    const n2 = calls2.filter((c) => c.method === 'codes.latest_stock_list').length
    assert.equal(n1, 1)
    assert.equal(n2, 1, 'TTL 内名称表只拉一次')
})
