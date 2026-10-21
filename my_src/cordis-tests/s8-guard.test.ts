// S8 单测：交易风控五件套——每条硬限制一个用例（时段/ST 与涨跌停/日亏上限/
// 单票仓位上限——含"LLM 全仓指令被拦"/halt 熔断），外加两条位置语义：
// deny 短路（guard 在审批外圈，拒单时 ask 层不发问）与通过路径（放行直落成交）。
// 手算数字全部在注释里给出推导（S5 的纪律：期望值逐项落笔）。
// 运行：npm run cordis
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join, dirname } from 'path'
import { Context } from '../cordis/context.js'
import { ToolsService } from '../services/tools.js'
import type { PermissionMode } from '../permissions.js'
import { SessionLog } from '../services/session-log.js'
import { CommandService } from '../services/commands.js'
import { marketDataPlugin, type Quote, type QuoteSource } from '../plugins/market-data.js'
import { paperBrokerPlugin, type PaperBroker } from '../plugins/paper-broker.js'
import { tradeGuardPlugin, type GuardConfig, type TradeGuardService } from '../plugins/trade-guard.js'
import { DEFAULT_STRATEGY } from '../plugins/strategy.js'

// 周一 10:00 CST = open；12:00 CST = lunch（时段闸门用例的两口钟）
const T_OPEN = Date.UTC(2026, 9, 19, 2, 0, 0)
const T_LUNCH = Date.UTC(2026, 9, 19, 4, 0, 0)

const QUOTES: Quote[] = [
    { code: 'sh600000', name: '浦发银行', price: 10, change: 0, changePercent: 0, open: 10, high: 10, low: 10, preClose: 10, volume: 1000, amount: 1e7, turnoverRate: 0.3, volumeRatio: 1, marketCap: 0, floatCap: 0, pb: 0 },
    { code: 'sh600999', name: 'ST贵人', price: 5, change: 0, changePercent: 0, open: 5, high: 5, low: 5, preClose: 5, volume: 1000, amount: 5e6, turnoverRate: 0.2, volumeRatio: 1, marketCap: 0, floatCap: 0, pb: 0 },
    { code: 'sz000999', name: '退市海润', price: 2, change: 0, changePercent: 0, open: 2, high: 2, low: 2, preClose: 2, volume: 1000, amount: 2e6, turnoverRate: 0.1, volumeRatio: 1, marketCap: 0, floatCap: 0, pb: 0 },
    { code: 'bj920999', name: '北交样本', price: 3, change: 0, changePercent: 0, open: 3, high: 3, low: 3, preClose: 3, volume: 1000, amount: 3e6, turnoverRate: 0.1, volumeRatio: 1, marketCap: 0, floatCap: 0, pb: 0 },
]

interface Mount { ctx: Context; guard: TradeGuardService; broker: PaperBroker; tick: (ms: number) => void; cleanup: () => void }

async function mountGuard(config: GuardConfig = {}, at: number = T_OPEN): Promise<Mount> {
    const ctx = new Context()
    new ToolsService(ctx, 'tools')
    new SessionLog(ctx, 'session-log')
    new CommandService(ctx, 'commands')
    const src: QuoteSource = {
        async fetchMarketSnapshot() { return QUOTES },
        async fetchQuotes() { return [] },
    }
    let clock = at
    const now = () => new Date(clock)
    ctx.plugin(marketDataPlugin, { source: src, now, pollIntervalMs: 60_000 })
    const ledger = join(mkdtempSync(join(tmpdir(), 's8-ledger-')), 'paper.jsonl')
    ctx.plugin(paperBrokerPlugin, { ledgerPath: ledger, now })
    ctx.plugin(tradeGuardPlugin, { ...config, now, strategy: DEFAULT_STRATEGY })
    await ctx.market!.refresh() // 首轮快照落进 latest（guard 的 fail-closed 需要）
    return {
        ctx, guard: ctx.guard!, broker: ctx.broker!,
        tick: (ms) => { clock += ms },
        cleanup: () => rmSync(dirname(ledger), { recursive: true, force: true }),
    }
}

async function place(m: Mount, input: Record<string, any>, mode: PermissionMode = 'default') {
    return m.ctx.require<ToolsService>('tools').executeCall(
        { name: 'place_order', input, mode },
        {},
    )
}

const BUY_PUFA = { code: 'sh600000', side: 'buy', price: 10, qty: 100, reason: 'test' }

// ---------- 五件套①：/halt 熔断 ----------

test('halt：注册进命令表；一键拦一切单；off 解除；注记进 SessionLog', async () => {
    const m = await mountGuard()
    const commands = m.ctx.require<CommandService>('commands')
    assert.equal(commands.get('halt')!.name, 'halt')

    assert.equal(await commands.dispatch('/halt 测试熔断'), true)
    assert.equal(m.guard.isHalted(), true)
    const denied = await place(m, BUY_PUFA)
    assert.equal(denied.kind, 'denied')
    assert.match(denied.kind === 'denied' && denied.content || '', /熔断：测试熔断/)

    const notes = m.ctx.get<SessionLog>('session-log')!.events
        .filter((e: any) => e.type === 'meta/note' && e.key === 'trade-halt') as any[]
    assert.equal(notes.length, 1)
    assert.deepEqual(notes[0].value, { halted: true, reason: '测试熔断' })

    await commands.dispatch('/halt off')
    assert.equal(m.guard.isHalted(), false)
    const ok = await place(m, BUY_PUFA, 'auto')
    assert.equal(ok.kind, 'result')
    assert.match(ok.kind === 'result' && ok.output || '', /Filled P0001/)
    m.cleanup()
})

// ---------- 五件套②：时段闸门 ----------

test('时段闸门：午间休市拒单；tradingHours:false 放行（手测/回放通道）', async () => {
    const m = await mountGuard({}, T_LUNCH)
    const denied = await place(m, BUY_PUFA)
    assert.equal(denied.kind, 'denied')
    assert.match(denied.kind === 'denied' && denied.content || '', /非交易时段（当前 lunch）/)
    m.cleanup()

    const m2 = await mountGuard({ tradingHours: false }, T_LUNCH)
    const ok = await place(m2, BUY_PUFA, 'auto')
    assert.equal(ok.kind, 'result')
    assert.match(ok.kind === 'result' && ok.output || '', /Filled P0001/)
    m2.cleanup()
})

// ---------- 五件套③：标的排除（ST/退市 + 涨跌停触板） ----------

test('标的排除：ST 与退市名称拒单', async () => {
    const m = await mountGuard()
    const st = await place(m, { code: 'sh600999', side: 'buy', price: 5, qty: 100 })
    assert.match(st.kind === 'denied' && st.content || '', /风控排除标的：ST贵人/)
    const delisted = await place(m, { code: 'sz000999', side: 'buy', price: 2, qty: 100 })
    assert.match(delisted.kind === 'denied' && delisted.content || '', /风控排除标的：退市海润/)
    m.cleanup()
})

test('标的排除：北交所前缀拒单（规则 1-2 的交易面兜底——引擎不产信号 ≠ 不交易）', async () => {
    const m = await mountGuard()
    const bj = await place(m, { code: 'bj920999', side: 'buy', price: 3, qty: 100 })
    assert.match(bj.kind === 'denied' && bj.content || '', /北交所 北交样本（bj920999）不在交易范围/)
    m.cleanup()

    // excludeBJ:false = 手册放开北交所时的通道（ Day 1 复盘 P0 配套）
    const m2 = await mountGuard({ excludeBJ: false })
    const ok = await place(m2, { code: 'bj920999', side: 'buy', price: 3, qty: 100 }, 'auto')
    assert.equal(ok.kind, 'result')
    m2.cleanup()
})

test('涨跌停触板拒单：guard 拒触板（>=hi/<=lo），比 broker 的出界拒更严', async () => {
    const m = await mountGuard()
    // 浦发银行 preClose 10 → 主板 ±10% → [9, 11]。11.0 未出界（broker 会收）
    // 但已触板——追板单在 guard 拦死；9.0 同理杀跌单。
    const direct = await m.broker.submitOrder({ code: 'sh600000', side: 'buy', price: 11, qty: 100 })
    assert.ok('orderId' in direct, 'broker 只拒出界：11.0 直单可成交')
    const chase = await place(m, { code: 'sh600000', side: 'buy', price: 11, qty: 100 })
    assert.match(chase.kind === 'denied' && chase.content || '', /委托价 11 触及涨跌停板 \[9, 11\]/)
    const kill = await place(m, { code: 'sh600000', side: 'buy', price: 9, qty: 100 })
    assert.match(kill.kind === 'denied' && kill.content || '', /委托价 9 触及涨跌停板/)
    m.cleanup()
})

// ---------- 五件套④：单日亏损上限 ----------

test('单日亏损上限：当日已实现亏够即拦一切新单；次日日切恢复', async () => {
    const m = await mountGuard({ maxDailyLoss: 5000 })
    // 建仓 10000@10：fee 26 → cost 100026。次日卖 10000@9.5：
    // amount 95000，fee = 佣金23.75 + 过户0.95 + 印花47.5 = 72.2 →
    // proceeds 94927.8，pnl = 94927.8 - 100026 = -5098.2 ≤ -5000
    await m.broker.submitOrder({ code: 'sh600000', side: 'buy', price: 10, qty: 10_000 })
    m.tick(86_400_000)
    const sell = await m.broker.submitOrder({ code: 'sh600000', side: 'sell', price: 9.5, qty: 10_000 })
    assert.ok('orderId' in sell, `卖出应成交（实际 ${JSON.stringify(sell)}）`)
    assert.equal((sell as any).realizedPnl, -5098.2)
    assert.equal(m.broker.todayPnl(), -5098.2)

    const denied = await place(m, BUY_PUFA)
    assert.match(denied.kind === 'denied' && denied.content || '',
        /当日已实现亏损 -5098\.2 元触及上限 5000 元/)

    m.tick(86_400_000) // 再日切：dayPnl 清零，闸门解除
    const ok = await place(m, BUY_PUFA, 'auto')
    assert.equal(ok.kind, 'result')
    m.cleanup()
})

// ---------- 五件套⑤：单票仓位上限（"全仓"指令被拦） ----------

test('单票仓位上限：买入后占比超限拒单——"全仓"指令在这里拦死', async () => {
    const m = await mountGuard() // 默认 maxPositionPct 0.2，净资产 = 现金 100 万
    const allIn = await place(m, { code: 'sh600000', side: 'buy', price: 10, qty: 25_000, reason: '梭哈全仓' })
    assert.equal(allIn.kind, 'denied')
    assert.match(allIn.kind === 'denied' && allIn.content || '',
        /单票仓位上限：买入后 25\.0% > 20%（净资产 1000000 元）——"全仓"类指令在这里拦死/)

    const fine = await place(m, { code: 'sh600000', side: 'buy', price: 10, qty: 19_000 }, 'auto')
    assert.equal(fine.kind, 'result', '19% ≤ 20%：放行')
    m.cleanup()
})

test('仓位上限按整手折算：250 股委托按 200 股核算占比', async () => {
    const m = await mountGuard({ maxPositionPct: 0.0001 }) // 100 万 × 0.0001 = 100 元
    // 250 股 → floor 200 股 × 10 = 2000 元 > 100 元 → 拒；理由里的占比按整手算
    const denied = await place(m, { code: 'sh600000', side: 'buy', price: 10, qty: 250 })
    assert.match(denied.kind === 'denied' && denied.content || '', /买入后 0\.2% > 0%/)
    m.cleanup()
})

// ---------- 位置语义：deny 短路审批 + 审批卡 + 通过路径 ----------

test('deny 短路 + 审批卡：拒单不惊动内圈；通过后 default 模式由 guard 发 ask（外圈 ask 即终局）', async () => {
    const m = await mountGuard()
    let asks = 0
    // 挂在 guard 之后 = 瀑布内圈——审批层的替身（真正的 approval 插件行位更靠后）
    m.ctx.on('tools/pre-execute', (call, next) => {
        if (call.name === 'place_order') { asks += 1; return { type: 'ask' as const, message: '确认下单？' } }
        return next()
    })
    await m.ctx.require<CommandService>('commands').dispatch('/halt 演练')
    const denied = await place(m, BUY_PUFA)
    assert.equal(denied.kind, 'denied')
    assert.match(denied.kind === 'denied' && denied.content || '', /熔断/)
    assert.equal(asks, 0, 'guard deny 短路：审批不发问')

    await m.ctx.require<CommandService>('commands').dispatch('/halt off')
    const ask = await place(m, BUY_PUFA)
    assert.equal(asks, 0, 'guard 的 ask 在外圈即终局：内圈审批层不被咨询')
    assert.equal(ask.kind, 'denied', 'ask + 无审批服务 = fail-closed')
    assert.match(ask.kind === 'denied' && ask.content || '', /User denied/)
    m.cleanup()
})

test('通过路径：非 place_order 原样放行；auto 模式弃权内层直落成交', async () => {
    const m = await mountGuard()
    const port = await m.ctx.require<ToolsService>('tools').executeCall(
        { name: 'get_portfolio', input: {}, mode: 'default' },
        {},
    )
    assert.equal(port.kind, 'result', '只读工具不过 guard（next() 原样交下层）')
    assert.match(port.kind === 'result' && port.output || '', /现金 1000000 元/)

    // auto 模式 guard 不发问（弃权给内层分类器）——裸树无内层 = 允许，直落成交
    const ok = await m.ctx.require<ToolsService>('tools').executeCall(
        { name: 'place_order', input: BUY_PUFA, mode: 'auto' },
        {},
    )
    assert.equal(ok.kind, 'result')
    assert.match(ok.kind === 'result' && ok.output || '', /Filled P0001: 买入 sh600000 100 股 @ 10/)
    m.cleanup()
})
