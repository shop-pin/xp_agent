// SC5 单测：收口链组合（digest→选股，DI spawn）、watchlist 并入（去重/注记）、
// digest 第八节渲染、strategy.screener 节零漂移。运行：npm run cordis
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { defaultCloseOut } from '../plugins/market-watch.js'
import { loadStrategy, DEFAULT_STRATEGY } from '../plugins/strategy.js'
import { renderScreenerSection, type ScreenerSummaryRow } from '../backtest/digest.js'

test('defaultCloseOut：digest 恒跑；autoRun 开才追加选股；顺序 digest→选股', async () => {
    const calls: string[] = []
    const digest = async (day: string) => { calls.push(`digest:${day}`) }
    const screener = async (day: string) => { calls.push(`screener:${day}`) }
    const on = defaultCloseOut({ ...DEFAULT_STRATEGY, screener: { autoRun: true } }, digest, screener)
    await on('2026-11-03')
    assert.deepEqual(calls, ['digest:2026-11-03', 'screener:2026-11-03'], '顺序：digest 先')
    calls.length = 0
    const off = defaultCloseOut(DEFAULT_STRATEGY, digest, screener)   // 缺省 autoRun=false
    await off('2026-11-03')
    assert.deepEqual(calls, ['digest:2026-11-03'], 'autoRun 关：只 digest（零漂移生命线）')
})

test('defaultCloseOut：选股失败向上 reject（收口链 catch 喊出声、不静默吞）', async () => {
    const screener = async () => { throw new Error('screener exit 1') }
    const chain = defaultCloseOut({ ...DEFAULT_STRATEGY, screener: { autoRun: true } },
        async () => {}, screener)
    await assert.rejects(chain('2026-11-03'), /screener exit 1/)
})

test('strategy：screener 节缺省 autoRun=false，用户覆盖合并生效', () => {
    assert.equal(DEFAULT_STRATEGY.screener.autoRun, false)
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
