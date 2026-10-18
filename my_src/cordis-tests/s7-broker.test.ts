// S7 单测：模拟盘——费用/价带/整手/T+1/资金/成本盈亏的确定性边界，每条一个用例；
// 账本重放（重启=同账）；broker/fill 事件与 SessionLog trade 注记；工具输出。
// 手算数字全部在注释里给出推导（S5 的纪律：期望值逐项落笔）。
// 运行：npm run cordis
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join, dirname } from 'path'
import { Context } from '../cordis/context.js'
import { ToolsService } from '../services/tools.js'
import { SessionLog } from '../services/session-log.js'
import { marketDataPlugin, type Quote, type QuoteSource } from '../plugins/market-data.js'
import { paperBrokerPlugin, computeFee, priceBand, cnDay, type Fill } from '../plugins/paper-broker.js'
import { projectSession } from '../webui/projection.js'

const T0 = Date.UTC(2026, 9, 19, 2, 0, 0) // 周一 10:00 CST
const QUOTES: Quote[] = [
    { code: 'sh600000', name: '浦发银行', price: 10, change: 0, changePercent: 0, open: 10, high: 10, low: 10, preClose: 10, volume: 1000, amount: 1e7, turnoverRate: 0.3, volumeRatio: 1, marketCap: 0, floatCap: 0, pb: 0 },
    { code: 'sz300750', name: '宁德时代', price: 100, change: 0, changePercent: 0, open: 100, high: 100, low: 100, preClose: 100, volume: 2000, amount: 2e7, turnoverRate: 0.5, volumeRatio: 1, marketCap: 0, floatCap: 0, pb: 0 },
]

// ---------- 纯函数：手算对拍 ----------

test('computeFee：佣金/过户/印花税口径（手算）', () => {
    // 买入 10 万：佣金 max(5, 25)=25 + 过户 1 + 印花 0 = 26
    assert.equal(computeFee('buy', 100_000), 26)
    // 卖出 11 万：佣金 27.5 + 过户 1.1 + 印花 55 = 83.6
    assert.equal(computeFee('sell', 110_000), 83.6)
    // 最低佣金：5000 元 → max(5, 1.25)=5 + 0.05 = 5.05
    assert.equal(computeFee('buy', 5_000), 5.05)
})

test('priceBand：分板价带（round2 到分）', () => {
    assert.deepEqual(priceBand('sh600000', '浦发银行', 10), [9, 11])       // 主板 ±10%
    assert.deepEqual(priceBand('sz300750', '宁德时代', 100), [80, 120])    // 创业板 ±20%
    // 10.03 × 1.1 = 11.033 → 11.03；× 0.9 = 9.027 → 9.03
    assert.deepEqual(priceBand('sh600000', '浦发银行', 10.03), [9.03, 11.03])
})

test('cnDay：北京时间日切', () => {
    assert.equal(cnDay(Date.UTC(2026, 9, 19, 15, 0, 0)), '2026-10-19') // 23:00 CST 同日
    assert.equal(cnDay(Date.UTC(2026, 9, 19, 16, 0, 0)), '2026-10-20') // 次日 00:00 CST
})

// ---------- 服务：边界用例 ----------

function mountBroker(over: { startingCash?: number } = {}) {
    const ctx = new Context()
    new ToolsService(ctx, 'tools')
    new SessionLog(ctx, 'session-log')
    const src: QuoteSource = {
        async fetchMarketSnapshot() { return QUOTES },
        async fetchQuotes() { return [] },
    }
    ctx.plugin(marketDataPlugin, { source: src, now: () => new Date(T0), pollIntervalMs: 60_000 })
    let clock = T0
    const ledger = join(mkdtempSync(join(tmpdir(), 's7-ledger-')), 'paper.jsonl')
    const fiber = ctx.plugin(paperBrokerPlugin, {
        ledgerPath: ledger, startingCash: over.startingCash ?? 1_000_000,
        now: () => new Date(clock),
    })
    const fills: Fill[] = []
    ctx.on('broker/fill', (f) => { fills.push(f) })
    return {
        ctx, fiber, ledger, fills,
        broker: ctx.broker!,
        tick: (ms: number) => { clock += ms },
        cleanup: async () => { await fiber.dispose(); rmSync(dirname(ledger), { recursive: true, force: true }) },
    }
}

test('买入：整手取整 + 费用入成本 + T+1 当日不可卖（手算）', async () => {
    const m = mountBroker()
    // 委托 150 股 @10 → 成交 100 股；amount 1000，fee max(5,0.25)+0.01=5.01
    const r = await m.broker.submitOrder({ code: 'sh600000', side: 'buy', price: 10, qty: 150 })
    assert.ok('orderId' in r, `应成交（实际 ${JSON.stringify(r)}）`)
    assert.equal((r as Fill).qty, 100)
    assert.equal((r as Fill).fee, 5.01)
    assert.equal(m.broker.cash, 1_000_000 - 1005.01)
    const pos = m.broker.getPositions()[0]
    assert.equal(pos.qty, 100)
    assert.equal(pos.availQty, 0, 'T+1：当日买入不可卖')
    assert.equal(pos.cost, 1005.01)
    assert.equal(m.fills.length, 1)
    await m.cleanup()
})

test('拒单三连：不足一手 / 超价带 / 无行情代码', async () => {
    const m = mountBroker()
    const r1 = await m.broker.submitOrder({ code: 'sh600000', side: 'buy', price: 10, qty: 50 })
    assert.match((r1 as { reason: string }).reason, /不足一手/)
    const r2 = await m.broker.submitOrder({ code: 'sh600000', side: 'buy', price: 11.5, qty: 100 })
    assert.match((r2 as { reason: string }).reason, /价带/)
    const r3 = await m.broker.submitOrder({ code: 'sh688777', side: 'buy', price: 10, qty: 100 })
    assert.match((r3 as { reason: string }).reason, /无.*行情/)
    await m.cleanup()
})

test('T+1 日切 + 卖出已实现盈亏（手算）', async () => {
    const m = mountBroker()
    // 买 10000@10：cost 100026；次日卖 10000@11：proceeds 110000-83.6=109916.4
    // pnl = 109916.4 - 100026 = 9890.4；现金回到 100 万 + 9890.4
    await m.broker.submitOrder({ code: 'sh600000', side: 'buy', price: 10, qty: 10_000 })
    const sameDay = await m.broker.submitOrder({ code: 'sh600000', side: 'sell', price: 11, qty: 10_000 })
    assert.match((sameDay as { reason: string }).reason, /可卖不足/)
    m.tick(86_400_000) // 次日同刻
    assert.equal(m.broker.getPositions()[0].availQty, 10_000, '日切后全部可卖')
    const sell = await m.broker.submitOrder({ code: 'sh600000', side: 'sell', price: 11, qty: 10_000 })
    assert.ok('orderId' in sell)
    assert.equal((sell as Fill).fee, 83.6)
    assert.equal((sell as Fill).realizedPnl, 9890.4)
    assert.equal(m.broker.cash, 1_000_000 + 9890.4)
    assert.equal(m.broker.getPositions().length, 0, '清仓后持仓移除')
    assert.equal(m.broker.realizedPnl, 9890.4)
    await m.cleanup()
})

test('资金不足拒单（含费口径）', async () => {
    const m = mountBroker({ startingCash: 1000 })
    // 宁德时代 100 股@100 = 10000 + fee 5.01 > 1000
    const r = await m.broker.submitOrder({ code: 'sz300750', side: 'buy', price: 100, qty: 100 })
    assert.match((r as { reason: string }).reason, /资金不足/)
    await m.cleanup()
})

test('分批建仓的加权成本与部分卖出（手算）', async () => {
    const m = mountBroker()
    // 第一笔 100@10 fee 5.01 → cost 1005.01；第二笔 100@11 fee 5.01+0.01? amount1100 → 佣金 max(5,0.275)=5 过户 0.011 → 5.01
    await m.broker.submitOrder({ code: 'sh600000', side: 'buy', price: 10, qty: 100 })
    await m.broker.submitOrder({ code: 'sh600000', side: 'buy', price: 11, qty: 100 })
    assert.equal(m.broker.getPositions()[0].cost, 1005.01 + 1105.01)
    m.tick(86_400_000)
    // 卖 100@11：amount 1100，fee = 佣金5 + 过户0.011 + 印花0.55 = 5.56；
    // basis = 2110.02 × 100/200 = 1055.01 → pnl = 1100 - 5.56 - 1055.01 = 39.43
    const sell = await m.broker.submitOrder({ code: 'sh600000', side: 'sell', price: 11, qty: 100 })
    assert.equal((sell as Fill).realizedPnl, 39.43)
    assert.equal(m.broker.getPositions()[0].cost, 1055.01)
    await m.cleanup()
})

test('账本重放：重启同账（现金/持仓/盈亏/序列号），日切后可卖恢复', async () => {
    const m = mountBroker()
    await m.broker.submitOrder({ code: 'sh600000', side: 'buy', price: 10, qty: 10_000 })
    const ledger = m.ledger
    await m.fiber.dispose() // 只卸载不删账本——重放要读它

    // 新 ctx/新 broker、同账本、时钟推进到次日
    const ctx2 = new Context()
    new ToolsService(ctx2, 'tools')
    const src: QuoteSource = { async fetchMarketSnapshot() { return QUOTES }, async fetchQuotes() { return [] } }
    ctx2.plugin(marketDataPlugin, { source: src, now: () => new Date(T0), pollIntervalMs: 60_000 })
    const day2 = T0 + 86_400_000
    const f2 = ctx2.plugin(paperBrokerPlugin, { ledgerPath: ledger, now: () => new Date(day2) })
    const b2 = ctx2.broker!
    assert.equal(b2.cash, 1_000_000 - 100_026)
    assert.equal(b2.getPositions()[0].qty, 10_000)
    assert.equal(b2.getPositions()[0].availQty, 10_000, '重放日切：历史买入可卖')
    assert.equal(b2.realizedPnl, 0)
    const sell = await b2.submitOrder({ code: 'sh600000', side: 'sell', price: 11, qty: 10_000 })
    assert.ok('orderId' in sell)
    assert.equal((sell as Fill).orderId, 'P0002', '序列号从账本恢复')
    const lines = readFileSync(ledger, 'utf-8').trim().split('\n')
    assert.equal(lines.length, 2, '账本两笔成交')
    await f2.dispose()
    rmSync(dirname(ledger), { recursive: true, force: true })
})

test('注记与工具：trade 注记进 SessionLog；place_order/get_portfolio 输出形态', async () => {
    const m = mountBroker()
    const tools = m.ctx.require<ToolsService>('tools')
    assert.equal(tools.get('place_order')!.permissionHint, 'exec')
    assert.equal(tools.get('get_portfolio')!.permissionHint, 'read')
    const out = await tools.get('place_order')!.execute(
        { code: 'sh600000', side: 'buy', price: 10, qty: 100, reason: 'test' }, {})
    assert.match(out, /Filled P0001: 买入 sh600000 100 股 @ 10，费用 5\.01 元/)
    assert.match(out, /现金余额 998994\.99 元/)
    const rej = await tools.get('place_order')!.execute(
        { code: 'sh600000', side: 'sell', price: 10, qty: 100 }, {})
    assert.match(rej, /Rejected: 可卖不足/)
    const port = await tools.get('get_portfolio')!.execute({}, {})
    assert.match(port, /现金 998994\.99 元/)
    assert.match(port, /持100股 可卖0/)
    assert.match(port, /已实现盈亏 \+0 元/)
    // SessionLog 的 trade 注记（F6 投影的口粮）
    const notes = m.ctx.get<SessionLog>('session-log')!.events
        .filter((e: any) => e.type === 'meta/note' && e.key === 'trade') as any[]
    assert.equal(notes.length, 1)
    assert.equal(notes[0].value.code, 'sh600000')
    assert.equal(notes[0].value.cash, 998_994.99)
    await m.cleanup()
})

test('F6 投影 trade fold：笔数/费用/已实现/现金余额（末笔为准）', () => {
    const entries = [
        { seq: 1, event: { type: 'meta/note', key: 'trade', value: { code: 'sh600000', side: 'buy', price: 10, qty: 100, fee: 5.01, realizedPnl: null, cash: 998_994.99 } } },
        { seq: 2, event: { type: 'meta/note', key: 'trade', value: { code: 'sh600000', side: 'sell', price: 11, qty: 100, fee: 5.56, realizedPnl: 89.43, cash: 999_099.42 } } },
    ]
    const p = projectSession(entries)
    assert.equal(p.trades.fills, 2)
    assert.ok(Math.abs(p.trades.fees - 10.57) < 1e-9)
    assert.ok(Math.abs(p.trades.realizedPnl - 89.43) < 1e-9)
    assert.equal(p.trades.cash, 999_099.42)
    assert.equal(p.trades.last, '卖出 sh600000 100@11')
})
