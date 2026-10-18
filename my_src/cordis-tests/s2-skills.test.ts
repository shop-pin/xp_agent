// S2 单测：产品内置技能层（product provider）+ 自选股清单（解析与工具）。
// product 层扫的是真实发货目录 my_src/skills/——本测试顺带钉住"brief 技能
// 随产品存在"；用户/项目同名覆盖语义用临时 HOME 沙箱验证（rank 5 < 10 < 20）。
// 运行：npm run cordis
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { Context } from '../cordis/context.js'
import { ToolsService } from '../services/tools.js'
import { skillsPlugin } from '../plugins/skills-registry.js'
import { marketDataPlugin, parseWatchlist, watchlistPath, type Quote, type QuoteSource } from '../plugins/market-data.js'

// HOME 沙箱：homedir() 实测不缓存（ch17 记档），双变量都设（Windows 读 USERPROFILE）
function withTempHome<T>(fn: () => T): T {
    const savedHome = process.env.HOME
    const savedProfile = process.env.USERPROFILE
    const dir = mkdtempSync(join(tmpdir(), 's2-home-'))
    process.env.HOME = dir
    process.env.USERPROFILE = dir
    try {
        return fn()
    } finally {
        process.env.HOME = savedHome
        process.env.USERPROFILE = savedProfile
        rmSync(dir, { recursive: true, force: true })
    }
}

// ---------- product 技能层 ----------

test('productSkills 开关：开=产品目录进注册表，关=不进（base 目录零变化的生命线）', () => {
    const ctxOn = new Context()
    ctxOn.plugin(skillsPlugin, { productSkills: true })
    const names = ctxOn.skills!.list().map((s) => s.name)
    assert.ok(names.includes('brief'), `产品技能 brief 应在场（实际：${names}）`)
    assert.equal(ctxOn.skills!.getByName('brief')!.source, 'product')

    const ctxOff = new Context()
    ctxOff.plugin(skillsPlugin, {})
    assert.equal(ctxOff.skills!.getByName('brief'), null, '默认关——base 装配看不见产品技能')
})

test('rank 覆盖语义：user 同名技能盖过 product（5 < 10，高 rank 后写胜）', () => {
    withTempHome(() => {
        const dir = join(process.env.HOME!, '.claude', 'skills', 'brief')
        mkdirSync(dir, { recursive: true })
        writeFileSync(join(dir, 'SKILL.md'),
            '---\nname: brief\ndescription: 用户自定义速览\n---\nuser version\n')
        const ctx = new Context()
        ctx.plugin(skillsPlugin, { productSkills: true })
        const skill = ctx.skills!.getByName('brief')!
        assert.equal(skill.source, 'user')
        assert.equal(skill.description, '用户自定义速览')
        assert.equal(skill.promptTemplate, 'user version')
    })
})

// ---------- 自选股清单 ----------

test('parseWatchlist：# 备注/空行/非法行容错，代码与备注分离', () => {
    const entries = parseWatchlist('# 注释行\n\nsh600000  # 浦发银行\nsz300750\nbadline 123\nbj920196\t# 北交\n')
    assert.deepEqual(entries, [
        { code: 'sh600000', remark: '浦发银行' },
        { code: 'sz300750', remark: '' },
        { code: 'bj920196', remark: '北交' },
    ])
})

function mockSource(quotes: Quote[]): QuoteSource {
    return {
        async fetchMarketSnapshot() { return quotes },
        async fetchQuotes(codes) { return quotes.filter((q) => codes.includes(q.code)) },
    }
}

const QUOTES: Quote[] = [
    { code: 'sh600000', name: '浦发银行', price: 9.73, change: 0.09, changePercent: 0.93, open: 9.6, high: 9.79, low: 9.53, preClose: 9.64, volume: 922942, amount: 8.96e8, turnoverRate: 3.1, volumeRatio: 0.9, marketCap: 2.8e11, floatCap: 2.6e11, pb: 0.5 },
]

test('get_watchlist 工具：有清单返回代码+路径，无清单返回创建指引', async () => {
    const casePresent = await withTempHome(async () => {
        mkdirSync(join(process.env.HOME!, '.mini-claude', 'stocks'), { recursive: true })
        writeFileSync(watchlistPath(), 'sh600000  # 浦发\nsz300750\n')
        const ctx = new Context()
        new ToolsService(ctx, 'tools')
        const fiber = ctx.plugin(marketDataPlugin, { source: mockSource(QUOTES), pollIntervalMs: 60_000 })
        const out = await ctx.require<ToolsService>('tools').get('get_watchlist')!.execute({}, {})
        await fiber.dispose()
        return out
    })
    assert.match(casePresent, /watchlist \(2\)/)
    assert.match(casePresent, /sh600000  # 浦发/)
    assert.match(casePresent, /sz300750/)

    const caseMissing = await withTempHome(async () => {
        const ctx = new Context()
        new ToolsService(ctx, 'tools')
        const fiber = ctx.plugin(marketDataPlugin, { source: mockSource(QUOTES), pollIntervalMs: 60_000 })
        const out = await ctx.require<ToolsService>('tools').get('get_watchlist')!.execute({}, {})
        await fiber.dispose()
        return out
    })
    assert.match(caseMissing, /No watchlist yet/)
    assert.match(caseMissing, /watchlist\.txt/)
    assert.match(caseMissing, /\/brief sh600000/)
})
