// S9 单测：盯盘编排——tick 状态机（开盘巡检/收盘复盘/跨日重置/周末静默）、
// 信号唤醒（节流/熔断静默）、启停语义；memory 写口（save_memory 门控与落盘）；
// broker 的 get_trades 与 get_portfolio 当日盈亏行。手算数字在注释落笔。
// 运行：npm run cordis
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'fs'
import { tmpdir, homedir } from 'os'
import { join, dirname } from 'path'
import { Context } from '../cordis/context.js'
import { ToolsService } from '../services/tools.js'
import { SessionLog } from '../services/session-log.js'
import { CommandService } from '../services/commands.js'
import { ScheduleService } from '../services/schedule.js'
import { marketDataPlugin, type Quote, type QuoteSource } from '../plugins/market-data.js'
import { paperBrokerPlugin, type Fill } from '../plugins/paper-broker.js'
import { tradeGuardPlugin } from '../plugins/trade-guard.js'
import { marketWatchPlugin, type WatchService } from '../plugins/market-watch.js'
import { memoryPlugin } from '../plugins/memory.js'
import { getMemoryDir } from '../memory.js'
import type { Signal } from '../plugins/signal-engine.js'

// 2026-10-19 周一：10:00 CST 开盘中；15:30 CST 已收盘；周六 10:00 休市
const MON_OPEN = Date.UTC(2026, 9, 19, 2, 0, 0)
const MON_CLOSED = Date.UTC(2026, 9, 19, 7, 30, 0)
const TUE_OPEN = MON_OPEN + 86_400_000
const SAT_OPEN = Date.UTC(2026, 9, 24, 2, 0, 0)

const QUOTES: Quote[] = [
    { code: 'sh600000', name: '浦发银行', price: 10, change: 0, changePercent: 0, open: 10, high: 10, low: 10, preClose: 10, volume: 1000, amount: 1e7, turnoverRate: 0.3, volumeRatio: 1, marketCap: 0, floatCap: 0, pb: 0 },
]

const SIG: Signal = {
    code: 'sh600000', name: '浦发银行', rule: 'rapid-move', direction: 'up',
    strength: 3.5, note: '5分钟涨 3.5%', at: MON_OPEN,
}

function mkSignal(ts: number): Signal {
    return { ...SIG, at: ts }
}

interface Mount {
    ctx: Context; watch: WatchService; wakes: string[]; tick: (ms: number) => void;
    schedule: ScheduleService; cleanup: () => void;
}

function mountWatch(cooldownMs = 180_000, at = MON_OPEN): Mount {
    const ctx = new Context()
    new ToolsService(ctx, 'tools')
    new SessionLog(ctx, 'session-log')
    new CommandService(ctx, 'commands')
    const schedule = new ScheduleService(ctx, 'schedule')
    const src: QuoteSource = {
        async fetchMarketSnapshot() { return QUOTES },
        async fetchQuotes() { return [] },
    }
    let clock = at
    ctx.plugin(marketDataPlugin, { source: src, now: () => new Date(clock), pollIntervalMs: 60_000 })
    ctx.plugin(tradeGuardPlugin, { now: () => new Date(clock) })
    const wakes: string[] = []
    ctx.plugin(marketWatchPlugin, {
        wake: async (text: string) => { wakes.push(text) },
        signalCooldownMs: cooldownMs,
    })
    return {
        ctx, watch: ctx.watch!, wakes, schedule,
        tick: (ms) => { clock += ms },
        cleanup: () => { ctx.watch?.stop() },
    }
}

function notes(ctx: Context): any[] {
    return ctx.get<SessionLog>('session-log')!.events
        .filter((e: any) => e.type === 'meta/note' && e.key === 'watch') as any[]
}

// ---------- tick 状态机 ----------

test('开盘巡检：盘中启动立即唤醒一次；重复 evaluate 不重复', async () => {
    const m = mountWatch()
    m.watch.start()
    assert.equal(m.wakes.length, 1)
    assert.match(m.wakes[0], /开盘巡检/)
    assert.match(m.wakes[0], /2026-10-19/)
    m.watch.evaluate()
    assert.equal(m.wakes.length, 1, '同日巡检只一次')
    assert.ok(notes(m.ctx).some((n) => n.value?.kind === 'open'), '巡检注记进 SessionLog')
    m.cleanup()
})

test('收盘复盘：当日巡检过 + 转 closed 唤醒一次；周末启动不巡检也不复盘', async () => {
    const m = mountWatch()
    m.watch.start() // 开盘巡检 #1
    m.tick(MON_CLOSED - MON_OPEN)
    m.watch.evaluate()
    assert.equal(m.wakes.length, 2)
    assert.match(m.wakes[1], /收盘.*\/review/)
    m.watch.evaluate()
    assert.equal(m.wakes.length, 2, '复盘同日只一次')
    m.cleanup()

    const sat = mountWatch(180_000, SAT_OPEN)
    sat.watch.start()
    sat.watch.evaluate()
    sat.watch.evaluate()
    assert.equal(sat.wakes.length, 0, '周六休市：无巡检无复盘')
    sat.cleanup()
})

test('跨日重置：次日开盘再巡检（一个会话连盯多日）', async () => {
    const m = mountWatch()
    m.watch.start()               // 周一巡检
    m.tick(MON_CLOSED - MON_OPEN)
    m.watch.evaluate()            // 周一复盘
    m.tick(TUE_OPEN - MON_CLOSED)
    m.watch.evaluate()            // 周二再巡检
    assert.equal(m.wakes.length, 3)
    assert.match(m.wakes[2], /2026-10-20/)
    m.cleanup()
})

test('stop 解除：不再评估唤醒；/watch 命令注册进命令表', async () => {
    const m = mountWatch()
    const commands = m.ctx.require<CommandService>('commands')
    assert.equal(commands.get('watch')!.name, 'watch')
    await commands.dispatch('/watch')
    assert.equal(m.watch.armed, true)
    await commands.dispatch('/watch off')
    assert.equal(m.watch.armed, false)
    assert.equal(m.schedule.has('watch-tick'), false, '停盯撤 tick')
    m.tick(MON_CLOSED - MON_OPEN)
    m.watch.evaluate()
    assert.equal(m.wakes.length, 1, '解除后收盘不再唤醒')
    m.cleanup()
})

// ---------- 信号唤醒 ----------

test('信号唤醒：开盘中触发一次；冷却窗内静默；冷却过了再触发', async () => {
    const m = mountWatch(180_000)
    m.watch.start() // 巡检 #0
    m.watch.onSignal(mkSignal(MON_OPEN))
    assert.equal(m.wakes.length, 2)
    assert.match(m.wakes[1], /盘中信号/)
    assert.match(m.wakes[1], /sh600000 浦发银行：5分钟涨 3\.5%/)
    m.watch.onSignal(mkSignal(MON_OPEN + 60_000))
    assert.equal(m.wakes.length, 2, '冷却窗（180s）内第二发信号静默')
    m.tick(180_000) // 市场钟推进出冷却窗
    m.watch.onSignal(mkSignal(MON_OPEN + 240_000))
    assert.equal(m.wakes.length, 3)
    m.cleanup()
})

test('信号唤醒的静默条件：休市信号不响；熔断时不叫醒裁决', async () => {
    const m = mountWatch()
    try {
        m.watch.start()
        m.tick(MON_CLOSED - MON_OPEN)
        m.watch.onSignal(mkSignal(MON_CLOSED)) // 休市时刻的迟到信号
        assert.equal(m.wakes.filter((w) => w.includes('盘中信号')).length, 0)
        m.tick(TUE_OPEN - MON_CLOSED) // 回到开盘
        const commands = m.ctx.require<CommandService>('commands')
        await commands.dispatch('/halt 演练')
        m.watch.onSignal(mkSignal(TUE_OPEN))
        assert.equal(m.wakes.filter((w) => w.includes('盘中信号')).length, 0, '熔断中：信号不叫醒')
        await commands.dispatch('/halt off')
        m.watch.onSignal(mkSignal(TUE_OPEN + 60_000))
        assert.equal(m.wakes.filter((w) => w.includes('盘中信号')).length, 1)
    } finally {
        m.cleanup()
    }
})

test('未武装（/watch 前）信号与评估都不唤醒；唤醒桥缺失只留注记不炸', async () => {
    const m = mountWatch()
    try {
        m.watch.onSignal(mkSignal(MON_OPEN))
        m.watch.evaluate()
        assert.equal(m.wakes.length, 0)
    } finally {
        m.cleanup()
    }

    // 无桥树：market-data inject ["tools"]——ToolsService 必须在，否则 market
    // 不激活、watch 拿不到时钟源（本用例首跑翻车点）
    const ctx2 = new Context()
    new ToolsService(ctx2, 'tools')
    new SessionLog(ctx2, 'session-log')
    new CommandService(ctx2, 'commands')
    const src: QuoteSource = { async fetchMarketSnapshot() { return QUOTES }, async fetchQuotes() { return [] } }
    ctx2.plugin(marketDataPlugin, { source: src, now: () => new Date(MON_OPEN), pollIntervalMs: 60_000 })
    ctx2.plugin(marketWatchPlugin, {}) // 无 wake 桥
    ctx2.watch!.start()
    try {
        assert.ok(notes(ctx2).some((n) => n.value?.kind === 'open'), '无桥：注记照写')
    } finally {
        ctx2.watch!.stop()
    }
})

// ---------- 真定时器链（env 旋钮加速） ----------

test('tick 链：env 旋钮加速下，真实定时器走完 开盘→收盘 全日', async () => {
    process.env.MINI_WATCH_TICK_MS = '10'
    try {
        const m = mountWatch()
        m.tick(-30 * 60_000) // 9:30 开盘瞬间起步
        m.watch.start()      // 巡检（进入 open 的第一眼）
        m.tick(5.5 * 3_600_000) // 一把推到 15:00 收盘
        await new Promise((r) => setTimeout(r, 60))
        assert.ok(m.wakes.some((w) => w.includes('开盘巡检')))
        assert.ok(m.wakes.some((w) => w.includes('收盘')))
        m.cleanup()
    } finally {
        delete process.env.MINI_WATCH_TICK_MS
    }
})

// ---------- memory 写口 ----------

test('save_memory：writeTool 装配可见、落盘 + 索引更新；默认装配不见', async () => {
    const home = mkdtempSync(join(tmpdir(), 's9-home-'))
    const prevHome = process.env.HOME
    const prevProfile = process.env.USERPROFILE
    process.env.HOME = home
    process.env.USERPROFILE = home
    try {
        const ctx = new Context()
        new ToolsService(ctx, 'tools')
        new SessionLog(ctx, 'session-log')
        const { Service } = await import('../cordis/service.js')
        class FakeLlm extends Service { sideCall = async () => ({ text: '' }) }
        new FakeLlm(ctx, 'llm')
        ctx.plugin(memoryPlugin, { bridge: { inject: () => {} }, writeTool: true } as any)

        const tools = ctx.require<ToolsService>('tools')
        const out = await tools.get('save_memory')!.execute({
            type: 'project', name: '模拟盘持仓 2026-10-19',
            description: '收盘持仓快照', content: '持 sh600000 10000 股，现金 90 万。',
        }, {})
        assert.match(out, /Memory saved: project_.+\.md/)
        const index = readFileSync(join(getMemoryDir(), 'MEMORY.md'), 'utf-8')
        assert.match(index, /模拟盘持仓 2026-10-19/)

        const ctx2 = new Context()
        new ToolsService(ctx2, 'tools')
        new SessionLog(ctx2, 'session-log')
        class FakeLlm2 extends Service { sideCall = async () => ({ text: '' }) }
        new FakeLlm2(ctx2, 'llm')
        ctx2.plugin(memoryPlugin, { bridge: { inject: () => {} } } as any)
        assert.equal(ctx2.require<ToolsService>('tools').get('save_memory'), undefined, '默认装配不见写口')
    } finally {
        process.env.HOME = prevHome
        process.env.USERPROFILE = prevProfile
        rmSync(home, { recursive: true, force: true })
    }
})

// ---------- broker 复盘视图 ----------

test('get_trades 按日过滤 + get_portfolio 当日盈亏行（手算）', async () => {
    const ctx = new Context()
    new ToolsService(ctx, 'tools')
    new SessionLog(ctx, 'session-log')
    const src: QuoteSource = { async fetchMarketSnapshot() { return QUOTES }, async fetchQuotes() { return [] } }
    let clock = MON_OPEN
    ctx.plugin(marketDataPlugin, { source: src, now: () => new Date(clock), pollIntervalMs: 60_000 })
    const ledger = join(mkdtempSync(join(tmpdir(), 's9-ledger-')), 'paper.jsonl')
    ctx.plugin(paperBrokerPlugin, { ledgerPath: ledger, now: () => new Date(clock) })
    await ctx.market!.refresh()
    const broker = ctx.broker!

    // 周一买 10000@10（fee 26）；周二卖 10000@9.5（fee 72.2，pnl -5098.2）
    await broker.submitOrder({ code: 'sh600000', side: 'buy', price: 10, qty: 10_000 })
    clock += 86_400_000
    const sell = await broker.submitOrder({ code: 'sh600000', side: 'sell', price: 9.5, qty: 10_000 })
    assert.ok('orderId' in sell)
    const tools = ctx.require<ToolsService>('tools')

    const today = await tools.get('get_trades')!.execute({}, {})
    assert.match(today, /2026-10-20 成交 1 笔 \| 费用合计 72\.2 元 \| 已实现合计 -5098\.2 元/)
    assert.match(today, /P0002 卖 sh600000 10000股 @9\.5 费72\.2，已实现 -5098\.2/)
    const yesterday = await tools.get('get_trades')!.execute({ day: '2026-10-19' }, {})
    assert.match(yesterday, /2026-10-19 成交 1 笔/)
    assert.match(yesterday, /P0001 买 sh600000 10000股 @10 费26/)

    const port = await tools.get('get_portfolio')!.execute({}, {})
    assert.match(port, /已实现盈亏 -5098\.2 元 \| 当日已实现 -5098\.2 元/)
    assert.equal(broker.todayPnl(), -5098.2)
    rmSync(dirname(ledger), { recursive: true, force: true })
})
