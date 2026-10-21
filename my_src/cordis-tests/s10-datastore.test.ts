// S10 单测：数据留存三层（日K收口/关注面明细/事件层）——schema 版本头、
// 断电重启续写（同根新实例不重写日K、事件层续追加）、坏行跳过与 schema 拒读、
// record_verdicts 入档校验、get_trades_csv 手算（数字沿用 s9：fee 26/72.2，pnl -5098.2）。
// 运行：npm run cordis
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { Context } from '../cordis/context.js'
import { ToolsService } from '../services/tools.js'
import { SessionLog } from '../services/session-log.js'
import { CommandService } from '../services/commands.js'
import { marketDataPlugin, type MarketDataService, type Quote, type QuoteSource } from '../plugins/market-data.js'
import { paperBrokerPlugin, type PaperBroker } from '../plugins/paper-broker.js'
import {
    dataStorePlugin, readSchemaJsonl, schemaHeader, type DataStoreService,
    dailyKPath, detailPath, signalsPath, verdictsPath,
    SCHEMA_DAILY_K, SCHEMA_DETAIL, SCHEMA_SIGNALS, SCHEMA_VERDICTS,
} from '../plugins/data-store.js'

// 2026-10-19 周一：10:00 CST 开盘中；15:30 CST 已收盘
const MON_OPEN = Date.UTC(2026, 9, 19, 2, 0, 0)
const MON_CLOSED = Date.UTC(2026, 9, 19, 7, 30, 0)

const QUOTES: Quote[] = [
    { code: 'sh600000', name: '浦发银行', price: 10, change: 0.1, changePercent: 1.01, open: 9.8, high: 10.2, low: 9.7, preClose: 9.9, volume: 1000, amount: 1e7, turnoverRate: 0.3, volumeRatio: 1, marketCap: 0, floatCap: 0, pb: 0 },
]

const SIGNAL = {
    code: 'sh600000', name: '浦发银行', rule: 'rapid-move', direction: 'up' as const,
    strength: 3.5, note: '5分钟涨 3.5%', at: MON_OPEN,
}

interface Mount {
    ctx: Context; store: DataStoreService; market: MarketDataService; broker: PaperBroker;
    tools: ToolsService; tick: (ms: number) => void; root: string; home: string; cleanup: () => void;
}

/** HOME 沙箱（watchlist 读 temp home，不碰真实清单）+ 数据根目录在 temp。 */
function mountStore(): Mount {
    const home = mkdtempSync(join(tmpdir(), 's10-home-'))
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
    let clock = MON_OPEN
    const src: QuoteSource = { async fetchMarketSnapshot() { return QUOTES }, async fetchQuotes() { return [] } }
    const now = () => new Date(clock)
    ctx.plugin(marketDataPlugin, { source: src, now, pollIntervalMs: 60_000 })
    ctx.plugin(paperBrokerPlugin, { ledgerPath: join(home, 'paper.jsonl'), now })
    ctx.plugin(dataStorePlugin, { rootDir: root })
    return {
        ctx, store: ctx.dataStore!, market: ctx.market!, broker: ctx.broker!, tools,
        tick: (ms) => { clock += ms }, root, home,
        cleanup: () => {
            ctx.dataStore?.dispose()
            process.env.HOME = prevHome
            process.env.USERPROFILE = prevProfile
            rmSync(home, { recursive: true, force: true })
        },
    }
}

const readText = (p: string): string[] => readFileSync(p, 'utf-8').split('\n').filter(Boolean)

// ---------- 三层写入 ----------

test('三层留存：收盘日K收口 + 关注面明细逐轮追加 + 信号事件层，schema 头就位', async () => {
    const m = mountStore()
    try {
        await m.market.refresh()
        m.ctx.emit('market/signal', { ...SIGNAL })
        await m.market.refresh()
        m.tick(MON_CLOSED - MON_OPEN)
        m.store.checkClose()

        const daily = readSchemaJsonl(dailyKPath(m.root, '2026-10-19'), SCHEMA_DAILY_K)
        assert.equal(daily.rows.length, 1)
        assert.deepEqual(daily.rows[0], {
            code: 'sh600000', name: '浦发银行', o: 9.8, h: 10.2, l: 9.7, c: 10,
            chg: 1.01, vol: 1000, amt: 1e7, to: 0.3,
        })

        const detail = readSchemaJsonl(detailPath(m.root, '2026-10-19'), SCHEMA_DETAIL)
        assert.equal(detail.rows.length, 2, '两轮快照 × 关注面 1 码')
        assert.equal((detail.rows[0] as any).p, 10)

        const sig = readSchemaJsonl(signalsPath(m.root), SCHEMA_SIGNALS)
        assert.equal(sig.rows.length, 1)
        assert.equal((sig.rows[0] as any).day, '2026-10-19')

        // 收口幂等：再 checkClose 不重写
        m.store.checkClose()
        assert.equal(readText(dailyKPath(m.root, '2026-10-19')).length, 2, '头 + 1 行，无重复')
    } finally {
        m.cleanup()
    }
})

test('断电重启：同根新实例续写事件层不重发 schema 头；日K已有文件不重写', async () => {
    const m = mountStore()
    try {
        await m.market.refresh()
        m.ctx.emit('market/signal', { ...SIGNAL })
        m.tick(MON_CLOSED - MON_OPEN)
        m.store.checkClose()
        m.ctx.dataStore?.dispose()

        // "断电"后新 Context 同根重装（home 沙箱保持）
        const ctx2 = new Context()
        new ToolsService(ctx2, 'tools')
        new SessionLog(ctx2, 'session-log')
        new CommandService(ctx2, 'commands')
        let clock = MON_CLOSED
        const src: QuoteSource = { async fetchMarketSnapshot() { return QUOTES }, async fetchQuotes() { return [] } }
        ctx2.plugin(marketDataPlugin, { source: src, now: () => new Date(clock), pollIntervalMs: 60_000 })
        ctx2.plugin(paperBrokerPlugin, { ledgerPath: join(m.home, 'paper.jsonl'), now: () => new Date(clock) })
        ctx2.plugin(dataStorePlugin, { rootDir: m.root })
        await ctx2.market!.refresh()
        ctx2.emit('market/signal', { ...SIGNAL, strength: 5.5 })
        ctx2.dataStore!.checkClose()

        const lines = readText(signalsPath(m.root))
        assert.equal(lines.length, 3, 'schema 头 1 行 + 两天会话各 1 条')
        assert.match(lines[0]!, /"schema":"stocks\.signals"/)
        assert.match(lines[1]!, /"strength":3\.5/)
        assert.match(lines[2]!, /"strength":5\.5/)

        // 日K：文件已在（实例 A 收口）→ 晚间重启补写命中幂等闸
        assert.equal(readText(dailyKPath(m.root, '2026-10-19')).length, 2)
        ctx2.dataStore!.dispose()
    } finally {
        m.cleanup()
    }
})

// ---------- 读侧纪律 ----------

test('读侧：坏行跳过计数；schema 不符明确拒读（不静默错解）', () => {
    const m = mountStore()
    try {
        const p = signalsPath(m.root)
        mkdirSync(join(m.root, 'events'), { recursive: true })
        writeFileSync(p, [
            schemaHeader(SCHEMA_SIGNALS),
            JSON.stringify({ day: '2026-10-19', code: 'sh600000', strength: 3.5 }),
            '{broken json',
            JSON.stringify({ day: '2026-10-19', code: 'sz000001', strength: 2 }),
        ].join('\n') + '\n')
        const r = readSchemaJsonl<any>(p, SCHEMA_SIGNALS)
        assert.equal(r.rows.length, 2)
        assert.equal(r.bad, 1)

        const bad = detailPath(m.root, '2026-10-19')
        mkdirSync(join(m.root, 'watch-detail'), { recursive: true })
        writeFileSync(bad, schemaHeader(SCHEMA_SIGNALS) + '\n')
        assert.throws(() => readSchemaJsonl(bad, SCHEMA_DAILY_K), /schema 不符/)
    } finally {
        m.cleanup()
    }
})

// ---------- 工具面 ----------

test('record_verdicts：合法入档 + 非法跳过 + day/at 自动补', async () => {
    const m = mountStore()
    try {
        const out = await m.tools.get('record_verdicts')!.execute({
            verdicts: [
                { code: 'sh600000', action: 'watch', confidence: 0.4, reasons: ['纯技术形态'] },
                { code: 'bogus', action: 'avoid', confidence: 0.5 },
                { code: 'sz000001', action: 'all-in', confidence: 0.5 },
            ],
        }, {})
        assert.match(out, /已入档 1 条裁决记录，跳过 2 条非法行/)
        const r = readSchemaJsonl<any>(verdictsPath(m.root), SCHEMA_VERDICTS)
        assert.equal(r.rows.length, 1)
        assert.equal(r.rows[0].code, 'sh600000')
        assert.equal(r.rows[0].day, '2026-10-19')
        assert.equal(r.rows[0].confidence, 0.4)
    } finally {
        m.cleanup()
    }
})

test('get_trades_csv：账本流水导出（数字沿用 s9 手算：fee 26/72.2，pnl -5098.2）', async () => {
    const m = mountStore()
    try {
        await m.broker.submitOrder({ code: 'sh600000', side: 'buy', price: 10, qty: 10_000 })
        m.tick(86_400_000)
        const sell = await m.broker.submitOrder({ code: 'sh600000', side: 'sell', price: 9.5, qty: 10_000 })
        assert.ok('orderId' in sell)
        const csv = await m.tools.get('get_trades_csv')!.execute({}, {})
        assert.equal(csv, [
            'orderId,day,time,code,side,price,qty,fee,realizedPnl',
            'P0001,2026-10-19,10:00,sh600000,buy,10,10000,26,',
            'P0002,2026-10-20,10:00,sh600000,sell,9.5,10000,72.2,-5098.2',
        ].join('\n'))
        const one = String(await m.tools.get('get_trades_csv')!.execute({ day: '2026-10-19' }, {}))
        assert.match(one.split('\n')[1]!, /P0001/)
        assert.doesNotMatch(one, /P0002/)
    } finally {
        m.cleanup()
    }
})
