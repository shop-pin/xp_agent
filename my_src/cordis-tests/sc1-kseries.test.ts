// SC1 单测：K 序列仓库合并口径 + 周/月重采样手算对拍。
// 手算样例逐根落笔（总纲 SC1 验收线：跨除权周/不完整周/停牌周）。
// 运行：npm run cordis
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { loadMarketDaily, resampleWeekly, resampleMonthly, weekKey } from '../backtest/kseries.js'
import { schemaHeader } from '../plugins/data-store.js'

const bar = (day: string, o: number, h: number, l: number, c: number, vol = 1000, amt = 100_000) =>
    ({ day, open: o, high: h, low: l, close: c, volume: vol, amount: amt })

// ---------- 重采样：周线 ----------

test('resampleWeekly：整周聚合 + 不完整半周 + 停牌周跳过，标签=组内最后交易日', () => {
    // 2026-01：5-9 完整周；12-16 只有 4 根（16 日起停牌）；19-23 停牌无根；
    // 26-30 完整周。
    const bars = [
        bar('2026-01-05', 10, 10.5, 9.9, 10.2),
        bar('2026-01-06', 10.2, 10.8, 10.1, 10.6),
        bar('2026-01-07', 10.6, 10.7, 10.3, 10.4),
        bar('2026-01-08', 10.4, 10.9, 10.4, 10.8),
        bar('2026-01-09', 10.8, 11.0, 10.7, 10.9),
        bar('2026-01-12', 10.9, 11.0, 10.6, 10.7),
        bar('2026-01-13', 10.7, 10.8, 10.5, 10.6),
        bar('2026-01-14', 10.6, 10.7, 10.4, 10.5),
        bar('2026-01-15', 10.5, 10.6, 10.3, 10.4),
        // 01-16~23 停牌（无根）
        bar('2026-01-26', 10.0, 10.2, 9.8, 10.1),
        bar('2026-01-30', 10.1, 10.6, 10.1, 10.5),
    ]
    const wk = resampleWeekly(bars)
    assert.equal(wk.length, 3, '停牌周不成 bar')
    // 周1（01-05~09）：开=周一开，收=周五收，高=周高，低=周低，量额=合计
    assert.deepEqual(
        { day: wk[0]!.day, open: wk[0]!.open, close: wk[0]!.close, high: wk[0]!.high, low: wk[0]!.low },
        { day: '2026-01-09', open: 10, close: 10.9, high: 11.0, low: 9.9 })
    assert.equal(wk[0]!.volume, 5000)
    assert.equal(wk[0]!.amount, 500_000)
    // 周2（01-12~15 不完整）：标签=最后有根的交易日（01-15，不是周五 01-16）
    assert.equal(wk[1]!.day, '2026-01-15')
    assert.deepEqual(
        { open: wk[1]!.open, close: wk[1]!.close, high: wk[1]!.high, low: wk[1]!.low },
        { open: 10.9, close: 10.4, high: 11.0, low: 10.3 })
    // 周3（01-26~30）
    assert.equal(wk[2]!.day, '2026-01-30')
    assert.equal(wk[2]!.high, 10.6)
    assert.equal(wk[2]!.low, 9.8)
})

test('resampleWeekly：跨年周归组（12-29~12-31 与 01-01-02 同周）+ qfq 除权连续', () => {
    const bars = [
        bar('2026-12-28', 10, 10.1, 9.9, 10.0),
        bar('2026-12-29', 10.0, 10.2, 10.0, 10.1),
        bar('2026-12-30', 10.1, 10.3, 10.0, 10.2),
        bar('2026-12-31', 10.2, 10.4, 10.1, 10.3),
        bar('2027-01-04', 9.5, 9.7, 9.4, 9.6),   // qfq 除权：价格跳变照收
        bar('2027-01-05', 9.6, 9.8, 9.5, 9.7),
    ]
    const wk = resampleWeekly(bars)
    assert.equal(wk.length, 2, '12-28~12-31（2026 末周）与 01-04~05（2027-W1）属不同 ISO 周')
    assert.equal(weekKey('2026-12-28'), weekKey('2026-12-31'), '同周同键')
    assert.notEqual(weekKey('2026-12-31'), weekKey('2027-01-04'), '跨年不同键')
    assert.equal(wk[0]!.close, 10.3)
    assert.equal(wk[1]!.open, 9.5, '除权跳变后新周以新价开盘——qfq 序列直接聚合')
})

test('resampleMonthly：月界 + 月标签=月内最后交易日 + 年界', () => {
    const bars = [
        bar('2026-01-30', 10, 10.5, 9.9, 10.2),
        bar('2026-02-02', 10.2, 10.6, 10.1, 10.5),
        bar('2026-02-27', 10.5, 10.8, 10.4, 10.7),
        bar('2026-03-02', 10.7, 11.0, 10.6, 10.9),
    ]
    const mo = resampleMonthly(bars)
    assert.equal(mo.length, 3)
    assert.deepEqual(mo.map((m) => m.day), ['2026-01-30', '2026-02-27', '2026-03-02'])
    assert.equal(mo[1]!.open, 10.2, '2 月开=月内首个交易日（02-02）的开')
    assert.equal(mo[1]!.high, 10.8)
})

// ---------- K 序列仓库：合并口径 ----------

test('loadMarketDaily：hist-k 打底 + daily-k 同日覆盖/补尾，序列升序', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sc1-'))
    try {
        const histDir = join(dir, 'hist-k')
        const kDir = join(dir, 'daily-k')
        mkdirSync(histDir); mkdirSync(kDir)
        // sh600000：hist-k 有 01-05/06；daily-k 覆盖 01-06、补 01-07
        writeFileSync(join(histDir, 'sh600000.jsonl'), [
            schemaHeader('backtest.hist-k', { code: 'sh600000', count: 2 }),
            JSON.stringify(bar('2026-01-05', 10, 10.5, 9.9, 10.2)),
            JSON.stringify(bar('2026-01-06', 10.2, 10.8, 10.1, 10.6)),
        ].join('\n') + '\n')
        // sz000001：只有 daily-k（hist-k 缺失的票照收）
        writeFileSync(join(kDir, '2026-01-06.jsonl'), [
            schemaHeader('stocks.daily-k', { day: '2026-01-06', count: 2 }),
            JSON.stringify({ code: 'sh600000', name: '浦发银行', o: 10.2, h: 10.9, l: 10.0, c: 10.7, chg: 4.9, vol: 2000, amt: 210_000, to: 1 }),
            JSON.stringify({ code: 'sz000001', name: '平安银行', o: 11, h: 11.2, l: 10.9, c: 11.1, chg: 1, vol: 3000, amt: 330_000, to: 1 }),
        ].join('\n') + '\n')
        writeFileSync(join(kDir, '2026-01-07.jsonl'), [
            schemaHeader('stocks.daily-k', { day: '2026-01-07', count: 1 }),
            JSON.stringify({ code: 'sh600000', name: '浦发银行', o: 10.7, h: 10.8, l: 10.5, c: 10.6, chg: -0.9, vol: 1500, amt: 160_000, to: 1 }),
        ].join('\n') + '\n')
        const m = loadMarketDaily(dir)
        const pufa = m.get('sh600000')!
        assert.equal(pufa.length, 3)
        assert.deepEqual(pufa.map((b) => b.day), ['2026-01-05', '2026-01-06', '2026-01-07'])
        assert.equal(pufa[1]!.close, 10.7, '同日（01-06）daily-k 覆盖 hist-k')
        assert.equal(pufa[1]!.volume, 2000)
        const pa = m.get('sz000001')!
        assert.equal(pa.length, 1)
        assert.equal(pa[0]!.close, 11.1)
        assert.equal(m.get('sz999999'), undefined, '无数据的票不出现')
    } finally {
        rmSync(dir, { recursive: true, force: true })
    }
})
