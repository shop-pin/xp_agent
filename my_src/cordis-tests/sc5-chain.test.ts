// SC5 单测：收口链组合（digest→选股，DI spawn）、watchlist 并入（去重/注记）、
// digest 第八节渲染、strategy.screener 节零漂移。运行：npm run cordis
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { defaultCloseOut, screenerSummary, spawnCli } from '../plugins/market-watch.js'
import { loadStrategy, DEFAULT_STRATEGY } from '../plugins/strategy.js'
import { renderScreenerSection, type ScreenerSummaryRow } from '../backtest/digest.js'

test('defaultCloseOut：digest 恒跑；autoRun 开才追加选股；顺序 kclose→选股→digest（§八要吃当日行）', async () => {
    const calls: string[] = []
    const digest = async (day: string) => { calls.push(`digest:${day}`) }
    const screener = async (day: string) => { calls.push(`screener:${day}`) }
    const kclose = async (day: string) => { calls.push(`kclose:${day}`) }
    const on = defaultCloseOut({ ...DEFAULT_STRATEGY, screener: { autoRun: true } }, digest, screener, kclose)
    await on('2026-11-03')
    assert.deepEqual(calls, ['kclose:2026-11-03', 'screener:2026-11-03', 'digest:2026-11-03'],
        '顺序：盘后日K收口（15:01 TDX 已收K）→ 选股先（digest §八读当日 screener 文件）')
    calls.length = 0
    const off = defaultCloseOut(DEFAULT_STRATEGY, digest, screener, kclose)   // 缺省 autoRun=false
    await off('2026-11-03')
    assert.deepEqual(calls, ['kclose:2026-11-03', 'digest:2026-11-03'], 'autoRun 关：kclose+digest（盘后K对 digest 同样受益）')
})

test('defaultCloseOut：kclose/选股失败 digest 仍跑，错误最后向上 reject（catch 喊出声、不静默吞）', async () => {
    const calls: string[] = []
    const digest = async (day: string) => { calls.push(`digest:${day}`) }
    const screener = async () => { throw new Error('screener exit 1') }
    const chain = defaultCloseOut({ ...DEFAULT_STRATEGY, screener: { autoRun: true } },
        digest, screener)
    await assert.rejects(chain('2026-11-03'), /screener exit 1/)
    assert.deepEqual(calls, ['digest:2026-11-03'], '选股挂了 digest 照跑（复盘基础产物保住）')

    calls.length = 0
    const digest2 = async (day: string) => { calls.push(`digest:${day}`) }
    const kcloseBoom = async () => { throw new Error('kclose-tdx exit 1') }
    const chain2 = defaultCloseOut(DEFAULT_STRATEGY, digest2, async () => {}, kcloseBoom)
    await assert.rejects(chain2('2026-11-03'), /kclose-tdx exit 1/)
    assert.deepEqual(calls, ['digest:2026-11-03'], 'kclose 挂了 digest 照跑（选股退回快照口径）')
})

test('strategy：screener 节缺省 autoRun=false，用户覆盖合并生效', () => {
    assert.equal(DEFAULT_STRATEGY.screener.autoRun, false)
    assert.equal(DEFAULT_STRATEGY.watch.postCloseRefine, false, '盘后精选默认关（零漂移生命线）')
    const dir = mkdtempSync(join(tmpdir(), 'sc5-'))
    try {
        const path = join(dir, 'strategy.json')
        writeFileSync(path, JSON.stringify({ screener: { autoRun: true } }))
        assert.equal(loadStrategy(path).screener.autoRun, true)
        assert.equal(loadStrategy(path).watch.closeOutAfterReview, false, '未提节沿用缺省')
    } finally {
        rmSync(dir, { recursive: true, force: true })
    }
})

test('renderScreenerSection：按公式归组、空清单、点名截断 8', () => {
    assert.deepEqual(renderScreenerSection([]), ['- 空清单'])
    const rows: ScreenerSummaryRow[] = [
        { code: 'sh600089', name: '特变电工', formulas: ['ma-golden', 'macd-golden'] },
        { code: 'sh600094', name: '大名城', formulas: ['ma-golden'] },
    ]
    const lines = renderScreenerSection(rows)
    assert.ok(lines[0]!.includes('命中 2 票 · 2 条公式'))
    assert.ok(lines.some((l) => l.startsWith('- ma-golden（2）：sh600089 特变电工、sh600094 大名城')))
    const many: ScreenerSummaryRow[] = Array.from({ length: 12 }, (_, i) =>
        ({ code: `sz00${String(i).padStart(4, '0')}`, name: `票${i}`, formulas: ['x'] }))
    const truncated = renderScreenerSection(many)
    assert.ok(truncated.some((l) => l.includes('…')), '超 8 只点名截断')
})

test('mergeIntoWatchlist：去重、来源注记、非法码剔除（HOME 沙箱）', async () => {
    const savedHome = process.env.HOME
    const savedProfile = process.env.USERPROFILE
    const dir = mkdtempSync(join(tmpdir(), 'sc5-home-'))
    process.env.HOME = dir
    process.env.USERPROFILE = dir
    try {
        // 动态 import 保证读沙箱 homedir（模块顶层不缓存路径——watchlistPath 每次现算）
        const { mergeIntoWatchlist } = await import('../backtest/screener-run.js')
        mkdirSync(join(dir, '.mini-claude', 'stocks'), { recursive: true })
        const wlPath = join(dir, '.mini-claude', 'stocks', 'watchlist.txt')
        writeFileSync(wlPath, 'sh600000  # 浦发银行\n')
        const r1 = mergeIntoWatchlist(['sh600089', 'sh600000', 'bad-code', 'sz300750'], '2026-11-01')
        assert.deepEqual(r1.added, ['sh600089', 'sz300750'])
        assert.deepEqual(r1.skipped, ['sh600000', 'bad-code'])
        const text = readFileSync(wlPath, 'utf-8')
        assert.ok(text.includes('sh600089  # 选股 2026-11-01'), '来源注记')
        assert.ok(text.includes('sh600000  # 浦发银行'), '既有行不动')
        const r2 = mergeIntoWatchlist(['sh600089'], '2026-11-01')
        assert.deepEqual(r2.added, [], '重复并入跳过')
    } finally {
        process.env.HOME = savedHome
        process.env.USERPROFILE = savedProfile
        rmSync(dir, { recursive: true, force: true })
    }
})

test('screenerSummary：一行完成提示（结果不打 terminal，只指报告文件；2026-11-04 需求变更）', () => {
    const prevData = process.env.MINI_STOCKS_DATA_DIR
    const dir = mkdtempSync(join(tmpdir(), 'sc5-summary-'))
    process.env.MINI_STOCKS_DATA_DIR = dir  // dataRootPath 密封（env 优先）
    try {
        const scDir = join(dir, 'screener')
        mkdirSync(scDir, { recursive: true })
        const head = JSON.stringify({ v: 1, schema: 'stocks.screener', day: '2026-11-02', universe: 5025, formulas: ['FLZT_xuanguqi', 'kdj-golden'] })
        const rows = [
            JSON.stringify({ code: 'sh600020', name: '中原高速', close: 4.32, formulas: ['FLZT_xuanguqi'] }),
            JSON.stringify({ code: 'sh600754', name: '锦江酒店', close: 20.57, formulas: ['FLZT_xuanguqi'] }),
            JSON.stringify({ code: 'sz000001', name: '平安银行', close: 10.5, formulas: ['kdj-golden'] }),
        ]
        writeFileSync(join(scDir, '2026-11-02.jsonl'), [head, ...rows].join('\n') + '\n')
        const text = screenerSummary('2026-11-02')
        assert.ok(text.includes('🎯 选股完成 2026-11-02'), '头行带日期')
        assert.ok(text.includes('FLZT_xuanguqi 2') && text.includes('kdj-golden 1'), '各公式计数')
        assert.ok(text.includes('screener/2026-11-02.md'), '指到报告文件')
        assert.ok(!text.includes('中原高速'), '不打明细——命中清单只进文件')
        assert.equal(text.split('\n').length, 1, '就一行')
        assert.equal(screenerSummary('1999-01-01'), '', '无产物日返回空串')
    } finally {
        if (prevData === undefined) delete process.env.MINI_STOCKS_DATA_DIR
        else process.env.MINI_STOCKS_DATA_DIR = prevData
        rmSync(dir, { recursive: true, force: true })
    }
})

test('spawnCli：挂死子进程被墙钟超时树杀并 reject——收口链不永挂、自退保底（2026-11-05 execSync 挂死同族）', async () => {
    const t0 = Date.now()
    await assert.rejects(
        spawnCli(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], 'hang-probe', 400),
        /hang-probe 超时/,
    )
    assert.ok(Date.now() - t0 < 5000, '超时在预算附近触发，不是永挂')
    // 正常退出路径不受影响：exit 0 resolve
    await assert.doesNotReject(spawnCli(process.execPath, ['-e', 'process.exit(0)'], 'ok-probe', 5000))
})
