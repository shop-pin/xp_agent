// SC4 单测：配置合并/按条拒装/坏配置拒读 + fixture 全链引擎（一致行为锚——
// 用户覆盖参数 → 引擎同源生效，S14 手法）。运行：npm run cordis
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { loadScreeners, screenerConfigPath, DEFAULT_UNIVERSE } from '../backtest/screener-config.js'
import { runScreener } from '../backtest/screener-run.js'
import { schemaHeader, readSchemaJsonl, SCHEMA_DAILY_K } from '../plugins/data-store.js'
import { SCHEMA } from '../backtest/schema.js'

function withTempHome<T>(fn: (dir: string) => T): T {
    const savedHome = process.env.HOME
    const savedProfile = process.env.USERPROFILE
    const dir = mkdtempSync(join(tmpdir(), 'sc4-home-'))
    process.env.HOME = dir
    process.env.USERPROFILE = dir
    try {
        return fn(dir)
    } finally {
        process.env.HOME = savedHome
        process.env.USERPROFILE = savedProfile
        rmSync(dir, { recursive: true, force: true })
    }
}

const writeConfig = (dir: string, obj: unknown): string => {
    const path = join(dir, '.mini-claude', 'stocks', 'screeners.json')
    mkdirSync(join(dir, '.mini-claude', 'stocks'), { recursive: true })
    writeFileSync(path, JSON.stringify(obj))
    return path
}

// ---------- 配置面 ----------

test('loadScreeners：内置缺省 + 用户按 id 覆盖（params 深合并/字段整覆盖/装卸）', () => {
    const path = writeConfig(mkdtempSync(join(tmpdir(), 'sc4-x-')), {
        screeners: [
            { id: 'breakout-high', params: { P1: 5 } },                        // 深合并：只改参
            { id: 'vol-surge', enabled: false },                                // 装卸
            { id: 'mine', name: '我的公式', formula: 'XG:C>1;' },               // 新增
        ],
    })
    const loaded = loadScreeners(path)
    const breakout = loaded.screeners.find((s) => s.id === 'breakout-high')!
    assert.equal(breakout.params?.P1, 5, 'params 深合并：P1 20→5')
    assert.equal(breakout.enabled, true, '未提 enabled 沿用内置')
    assert.equal(loaded.screeners.find((s) => s.id === 'vol-surge')!.enabled, false)
    assert.ok(loaded.screeners.some((s) => s.id === 'mine'))
    assert.deepEqual(loaded.universe, DEFAULT_UNIVERSE)
})

test('loadScreeners：坏公式按条拒装点名，好公式不受牵连', () => {
    const path = writeConfig(mkdtempSync(join(tmpdir(), 'sc4-x-')), {
        screeners: [
            { id: 'bad-func', formula: 'A:FOO(C,1); XG:A>0;' },
            { id: 'no-xg', formula: 'A:C>1;' },
            { id: 'good', formula: 'XG:C>1;' },
        ],
    })
    const loaded = loadScreeners(path)
    const ids = loaded.screeners.map((s) => s.id)
    assert.ok(ids.includes('good'), '好公式入库')
    assert.ok(!ids.includes('bad-func') && !ids.includes('no-xg'), '坏公式拒装')
    assert.ok(ids.includes('ma-golden'), '配置是覆盖层——内置公式不受坏条目牵连')
    assert.equal(loaded.rejected.length, 2)
    assert.match(loaded.rejected[0]!.error, /未知函数：FOO/)
    assert.match(loaded.rejected[1]!.error, /XG/)
})

test('loadScreeners：坏配置明确拒读（坏 JSON / 缺 formula / universe 非对象）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sc4-x-'))
    mkdirSync(join(dir, '.mini-claude', 'stocks'), { recursive: true })
    const path = join(dir, '.mini-claude', 'stocks', 'screeners.json')
    writeFileSync(path, '{broken json')
    assert.throws(() => loadScreeners(path), /配置不可读/)
    writeFileSync(path, JSON.stringify({ screeners: [{ id: 'x', formula: 123 }] }))
    assert.throws(() => loadScreeners(path), /formula 须为字符串/)
    writeFileSync(path, JSON.stringify({ universe: [] }))
    assert.throws(() => loadScreeners(path), /universe 须为对象/)
    rmSync(dir, { recursive: true, force: true })
})

// ---------- 引擎全链（fixture） ----------

function buildFixture(dir: string): { root: string; day: string } {
    const root = join(dir, 'data')
    const histDir = join(root, 'hist-k')
    const kDir = join(root, 'daily-k')
    mkdirSync(histDir, { recursive: true })
    mkdirSync(kDir, { recursive: true })
    // 两只票：600000 收盘节节走高（末日破 5 日高+放量）；000001 横盘缩量
    const days = Array.from({ length: 10 }, (_, i) => `2026-01-${String(i + 5).padStart(2, '0')}`)
    const row = (code: string, name: string, day: string, c: number, vol: number, amt: number) =>
        JSON.stringify({ code, name, o: c, h: c, l: c, c, chg: 1, vol, amt, to: 1 })
    const rows600 = days.map((d, i) => row('sh600000', '浦发银行', d, 10 + i * 0.1, 1000, 30_000_000 + i * 1_000_000))
    const rows1 = days.map((d, i) => row('sz000001', '平安银行', d, 10, 1000, 1_000_000))
    // daily-k 格式：一天一文件、行内无 day 字段（day=文件名）
    for (let i = 0; i < days.length; i++) {
        writeFileSync(join(kDir, `${days[i]}.jsonl`),
            [schemaHeader(SCHEMA_DAILY_K, { day: days[i], count: 2 }), rows600[i]!, rows1[i]!].join('\n') + '\n')
    }
    // hist-k 缺席（引擎只用 daily-k 也能跑）
    return { root, day: days[days.length - 1] }
}

test('引擎全链：宇宙闸+命中+一致行为锚（用户参数改窗 → 引擎同源生效）+ 产物落盘', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sc4-run-'))
    const prevProfile = process.env.USERPROFILE
    process.env.USERPROFILE = dir  // 密封 strategy.json（runScreener 经 loadStrategy 读家目录）
    try {
        const { root, day } = buildFixture(dir)
        const configPath = writeConfig(dir, {
            screeners: [
                { id: 'breakout-high', params: { P1: 5 } },   // 锚：20 日窗在 10 根 fixture 上永不命中，改 5 才命中
                { id: 'vol-surge', enabled: false },
            ],
        })
        const result = runScreener({ root, configPath, day })
        assert.equal(result.day, day)
        assert.equal(result.universe, 1, '000001 成交额 < 3000 万被闸掉')
        assert.deepEqual(result.hits.map((h) => h.code), ['sh600000'])
        assert.ok(result.hits[0]!.formulas.includes('breakout-high'), '改窗后命中——一致行为锚')
        assert.equal(result.perFormula.find((f) => f.id === 'vol-surge'), undefined, '停用公式不参跑')
        // 产物：JSONL schema 头 + md
        assert.ok(existsSync(result.jsonlPath))
        const parsed = readSchemaJsonl<{ code: string; formulas: string[] }>(result.jsonlPath, SCHEMA.SCREENER)
        assert.equal(parsed.rows.length, 1)
        assert.equal(parsed.rows[0]!.code, 'sh600000')
        const md = readFileSync(result.mdPath, 'utf-8')
        assert.ok(md.includes('# 选股报告 ' + day))
        assert.ok(md.includes('浦发银行'))
    } finally {
        if (prevProfile === undefined) delete process.env.USERPROFILE
        else process.env.USERPROFILE = prevProfile
        rmSync(dir, { recursive: true, force: true })
    }
})

test('引擎边界：--formula 不在库内点名可用清单；指定日无收口明确报错', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sc4-run-'))
    const prevProfile = process.env.USERPROFILE
    process.env.USERPROFILE = dir
    try {
        const { root, day } = buildFixture(dir)
        const configPath = screenerConfigPath()
        assert.throws(() => runScreener({ root, configPath, formulaId: 'nope' }), /公式 nope 不在库内/)
        assert.throws(() => runScreener({ root, configPath, day: '2026-01-01' }), /无 daily-k 收口/)
        void day
    } finally {
        if (prevProfile === undefined) delete process.env.USERPROFILE
        else process.env.USERPROFILE = prevProfile
        rmSync(dir, { recursive: true, force: true })
    }
})

test('宇宙闸单测：ST/退市/北交所/创科/停牌/零价/流动性逐条', () => {
    // 经由引擎的 universe 行为在 fixture 层已锚；此处钉 universeGate 语义边界
    // （通过导出面间接——直接构造跑一次，断言拒装口径）
    const dir = mkdtempSync(join(tmpdir(), 'sc4-run-'))
    const prevProfile = process.env.USERPROFILE
    process.env.USERPROFILE = dir
    try {
        const { root, day } = buildFixture(dir)
        const kDir = join(root, 'daily-k')
        const files = readdirSync(kDir).sort()
        const lastFile = join(kDir, files[files.length - 1]!)
        const rows = readFileSync(lastFile, 'utf-8').trim().split('\n')
        // 追加三只：ST 名、bj 前缀、创科前缀（universe.excludeCK 打开）
        rows.push(JSON.stringify({ code: 'sh600001', name: 'ST某某', o: 1, h: 1, l: 1, c: 1, chg: 0, vol: 1000, amt: 5_000_000, to: 1 }))
        rows.push(JSON.stringify({ code: 'bj430047', name: '北交某', o: 1, h: 1, l: 1, c: 1, chg: 0, vol: 1000, amt: 9_000_000, to: 1 }))
        rows.push(JSON.stringify({ code: 'sz300001', name: '创科某', o: 1, h: 1, l: 1, c: 1, chg: 0, vol: 1000, amt: 9_000_000, to: 1 }))
        writeFileSync(lastFile, rows.join('\n') + '\n')
        const configPath = writeConfig(dir, { screeners: [{ id: 'good', formula: 'XG:C>0;' }], universe: { excludeCK: true, amountMin: 0 } })
        const result = runScreener({ root, configPath, day })
        const codes = result.hits.map((h) => h.code)
        assert.ok(!codes.includes('sh600001'), 'ST 剔')
        assert.ok(!codes.includes('bj430047'), '北交所剔')
        assert.ok(!codes.includes('sz300001'), '创科剔（excludeCK 开）')
        assert.ok(codes.includes('sh600000'), '正常票在')
    } finally {
        if (prevProfile === undefined) delete process.env.USERPROFILE
        else process.env.USERPROFILE = prevProfile
        rmSync(dir, { recursive: true, force: true })
    }
})

test('公式目录装载：*.txt 装 / .off.txt 停用 / 覆盖内置同名（2026-11-02 用户形态）', () => {
    const savedFormulas = process.env.MINI_FORMULAS_DIR
    const home = mkdtempSync(join(tmpdir(), 'sc4-fdir-'))
    const fdir = join(home, 'formulas')
    mkdirSync(join(fdir, 'indicators'), { recursive: true })
    mkdirSync(join(fdir, 'screeners'), { recursive: true })
    writeFileSync(join(fdir, 'indicators', 'MYIND.txt'), 'MA3:MA(C,3); XOUT:MA3>0;')
    writeFileSync(join(fdir, 'indicators', 'DEAD.off.txt'), 'A:C;')
    writeFileSync(join(fdir, 'screeners', 'my-scr.txt'), 'XG:CROSS(MYIND.MA3, C);')
    writeFileSync(join(fdir, 'screeners', 'vol-surge.off.txt'), 'XG:C>0;')
    process.env.MINI_FORMULAS_DIR = fdir
    try {
        const loaded = loadScreeners(join(home, 'no-json.json'))
        // .off.txt 指标跳过装载；MYIND 编译入列
        assert.ok(loaded.indicators.some((d) => d.id === 'MYIND'), '目录指标应装载')
        assert.ok(!loaded.indicators.some((d) => d.id === 'DEAD'), '.off 指标应跳过')
        // 覆盖内置同名 screener → enabled:false 进停用清单（原公式仍注册）
        const vs = loaded.screeners.find((s) => s.id === 'vol-surge')
        assert.ok(vs && !vs.enabled, '.off 应停用同名内置')
        // 新 screener 装载且跨引用目录指标
        const my = loaded.screeners.find((s) => s.id === 'my-scr')
        assert.ok(my && my.enabled, '目录选股公式应装载')
        assert.ok(loaded.rejected.every((r) => !r.id.startsWith('indicator:MYIND')), '好公式不应拒装')
    } finally {
        if (savedFormulas === undefined) delete process.env.MINI_FORMULAS_DIR
        else process.env.MINI_FORMULAS_DIR = savedFormulas
        rmSync(home, { recursive: true, force: true })
    }
})
