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
import { marketDataPlugin, parseWatchlist, watchlistPath, learningsPath, parseLearnings, establishedLearnings, type Quote, type QuoteSource } from '../plugins/market-data.js'

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

// ---------- 教训库（挂账 #9(b)：裁决吃确立条目） ----------

test('parseLearnings：条目行拆日期/状态/原行，非条目行跳过，半全角冒号都认', () => {
    const entries = parseLearnings([
        '# 标题与 prose 不认',
        '',
        '- [2026-10-20] GLM 烧穿 | 证据：Day1 | 状态：确立（永久纪律）| 失效：无',
        '- [2026-10-19] 逼近止损 | 证据：digest | 状态: 候选 | 失效：回升', // 半角冒号也认
        '- 没有日期的行不认',
        '普通缩进 prose',
    ].join('\n'))
    assert.deepEqual(entries, [
        { date: '2026-10-20', status: '确立（永久纪律）', line: '- [2026-10-20] GLM 烧穿 | 证据：Day1 | 状态：确立（永久纪律）| 失效：无' },
        { date: '2026-10-19', status: '候选', line: '- [2026-10-19] 逼近止损 | 证据：digest | 状态: 候选 | 失效：回升' },
    ])
})

test('establishedLearnings：只吃确立、判死/候选/试用/观察中排除、新→旧、cap 截断', () => {
    const text = [
        '- [2026-10-18] 旧确立 | 证据：a | 状态：确立 | 失效：x',
        '- [2026-10-19] 判死条目 | 证据：b | 状态：判死 | 失效：防复发留库',
        '- [2026-10-20] 新确立 | 证据：c | 状态：确立（永久纪律）| 失效：无',
        '- [2026-10-21] 试用中 | 证据：d | 状态：试用 | 失效：y',
        '- [2026-10-17] 观察中 | 证据：e | 状态：观察中 | 失效：z',
    ].join('\n')
    const picked = establishedLearnings(text)
    assert.equal(picked.length, 2)
    assert.ok(picked[0].includes('新确立'), '日期新→旧：2026-10-20 在前')
    assert.ok(picked[1].includes('旧确立'))
    assert.ok(!picked.some((l) => l.includes('判死') || l.includes('试用中') || l.includes('观察中')))
    // cap：12 条确立只留最新的 10 条（token 预算代码钉，不靠模型自觉）
    const many = Array.from({ length: 12 }, (_, i) =>
        `- [2026-01-${String(i + 1).padStart(2, '0')}] 第${i}条 | 证据：x | 状态：确立 | 失效：y`).join('\n')
    assert.equal(establishedLearnings(many).length, 10)
    assert.equal(establishedLearnings(many, 3).length, 3, 'cap 可调')
})

test('get_learnings 工具：确立条目原行返回，无确立/无文件给指引', async () => {
    const casePresent = await withTempHome(async () => {
        mkdirSync(join(process.env.HOME!, '.mini-claude', 'stocks'), { recursive: true })
        writeFileSync(learningsPath(), '- [2026-10-20] 新确立 | 证据：c | 状态：确立 | 失效：无\n- [2026-10-19] 仍候选 | 证据：d | 状态：候选 | 失效：x\n')
        const ctx = new Context()
        new ToolsService(ctx, 'tools')
        const fiber = ctx.plugin(marketDataPlugin, { source: mockSource(QUOTES), pollIntervalMs: 60_000 })
        const out = await ctx.require<ToolsService>('tools').get('get_learnings')!.execute({}, {})
        await fiber.dispose()
        return out
    })
    assert.match(casePresent, /established learnings \(1, cap 10\)/)
    assert.match(casePresent, /新确立/)
    assert.ok(!casePresent.includes('仍候选'), '候选条目不进裁决上下文')

    const caseEmpty = await withTempHome(async () => {
        mkdirSync(join(process.env.HOME!, '.mini-claude', 'stocks'), { recursive: true })
        writeFileSync(learningsPath(), '- [2026-10-19] 只有候选 | 证据：d | 状态：候选 | 失效：x\n')
        const ctx = new Context()
        new ToolsService(ctx, 'tools')
        const fiber = ctx.plugin(marketDataPlugin, { source: mockSource(QUOTES), pollIntervalMs: 60_000 })
        const out = await ctx.require<ToolsService>('tools').get('get_learnings')!.execute({}, {})
        await fiber.dispose()
        return out
    })
    assert.match(caseEmpty, /No established learnings yet/)

    const caseMissing = await withTempHome(async () => {
        const ctx = new Context()
        new ToolsService(ctx, 'tools')
        const fiber = ctx.plugin(marketDataPlugin, { source: mockSource(QUOTES), pollIntervalMs: 60_000 })
        const out = await ctx.require<ToolsService>('tools').get('get_learnings')!.execute({}, {})
        await fiber.dispose()
        return out
    })
    assert.match(caseMissing, /No learnings file yet/)
    assert.match(caseMissing, /learnings\.md/)
})
