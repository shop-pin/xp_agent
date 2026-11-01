// SC1 探针回放测试（零网络）：真机探针录下的 TDX 原生 K fixture 钉住重采样器。
// 探针设计与首跑记录见 my_docs/stock-SC1.md；fixture = 2026-11-01 真机
// （EltdxSource 直连，adjust=qfq；三票：sh600000/sz000001/sz300750）。
// 头部残根语义：dayFront 500 根窗口起点所在周/月为半根，双侧剔除后对拍。
// 运行：npm run cordis
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { resampleWeekly, resampleMonthly } from '../backtest/kseries.js'

const FIX = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'fixtures', 'sc1')
const CODES = ['sh600000', 'sz000001', 'sz300750']
const TOL = 1e-6

for (const code of CODES) {
    test(`SC1 探针回放 ${code}：重采样器 vs TDX 原生周/月逐根对拍（qfq）`, () => {
        const path = join(FIX, `tdx-${code}.json`)
        assert.ok(existsSync(path), `缺 fixture ${path}——重跑 sc1-tdx-probe.py`)
        const tdx = JSON.parse(readFileSync(path, 'utf-8'))
        for (const [period, ours, native] of [
            ['周', resampleWeekly(tdx.dayFront).slice(1), tdx.weekFront],
            ['月', resampleMonthly(tdx.dayFront).slice(1), tdx.monthFront],
        ] as const) {
            const byDay = new Map(ours.map((b) => [b.day, b]))
            let checked = 0
            for (const n of native) {
                const o = byDay.get(n.day)
                if (!o) continue   // 窗口边界（native 比 dayFront 更老 3 根）——探针已验证
                checked++
                for (const k of ['open', 'high', 'low', 'close'] as const) {
                    assert.ok(Math.abs(o[k] - n[k]) <= TOL,
                        `${period} ${n.day} ${k}: ours ${o[k]} vs native ${n[k]}`)
                }
            }
            assert.ok(checked >= 20, `${period} 对拍根数过少：${checked}`)
        }
    })
}
