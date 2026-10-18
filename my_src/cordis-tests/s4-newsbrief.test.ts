// S4 单测：/news-brief 技能与 news.jsonl 折叠（rotation）。
// - 技能在场 + 模板携带 token 硬预算条款（"limit 不超过 15"）——预算契约
//   钉在发货文件上，改模板的人会先红这里
// - 折叠：超 maxStorageBytes 保半重写（丢最旧）；上限内不动；折叠后去重集
//   不受影响（同页重拉零新增）
// 运行：npm run cordis
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join, dirname } from 'path'
import { Context } from '../cordis/context.js'
import { ToolsService } from '../services/tools.js'
import { skillsPlugin } from '../plugins/skills-registry.js'
import { newsFeedPlugin, type NewsItem, type NewsSource } from '../plugins/news-feed.js'

// ---------- 技能在场 + token 预算条款 ----------

test('product 技能层随产品发货 news-brief，模板带 limit≤15 硬预算与三段产出', () => {
    const ctx = new Context()
    ctx.plugin(skillsPlugin, { productSkills: true })
    const skill = ctx.skills!.getByName('news-brief')
    assert.ok(skill, 'news-brief 应随 my_src/skills/ 发货')
    assert.equal(skill!.source, 'product')
    assert.equal(skill!.context, 'inline')
    assert.ok(skill!.promptTemplate.includes('limit 不超过 15'), 'token 硬预算条款在场')
    for (const section of ['要闻速览', '个股关联', '整体情绪']) {
        assert.ok(skill!.promptTemplate.includes(section), `产出段「${section}」在场`)
    }
    assert.ok(skill!.allowedTools?.includes('latest_news'))
})

// ---------- 折叠 ----------

/** 造一批消息。注意 fetchLatest 契约：返回序 = 新→旧（time 降序）——
 *  生成后反转，别让测试数据自己违反源契约（本章翻车记档）。 */
function items(n: number): NewsItem[] {
    const out: NewsItem[] = []
    for (let i = 0; i < n; i++) {
        out.push({ id: `id${i}`, time: 1_000 + i, text: `第${i}条消息-加长正文`.repeat(6), tags: [], codes: [] })
    }
    return out.reverse();
}

function mockSource(page: NewsItem[]): NewsSource {
    return { async fetchLatest() { return page } }
}

function tempStorage(): string {
    return join(mkdtempSync(join(tmpdir(), 's4-news-')), 'news.jsonl')
}

test('折叠：超阈值保半重写（丢最旧），上限内不动', async () => {
    const storage = tempStorage()
    const ctx = new Context()
    new ToolsService(ctx, 'tools')
    // 阈值给小：30 条 ≈ 数 KB，阈值 2KB → 追加后即触发折叠
    const fiber = ctx.plugin(newsFeedPlugin, {
        source: mockSource(items(30)), storagePath: storage, maxStorageBytes: 2_000, pollIntervalMs: 60_000,
    })
    const news = ctx.news!
    await news.ensureFresh(0)
    const lines = readFileSync(storage, 'utf-8').trim().split('\n').filter(Boolean)
    assert.ok(lines.length < 30, `应已折叠（实际 ${lines.length} 行）`)
    assert.equal(lines.length, 15, '保半：30 → 15')
    assert.equal(JSON.parse(lines[lines.length - 1]).id, 'id29', '最新的保住了')
    assert.ok(!lines.some((l) => JSON.parse(l).id === 'id0'), '最旧的被折掉')
    // 折叠不清去重集：同页重拉零新增
    await news.ensureFresh(-1)
    assert.equal(news.addedCount, 30, '去重集仍认得全部 30 条')
    await fiber.dispose()
    rmSync(dirname(storage), { recursive: true, force: true })
})

test('折叠不误伤：上限内追加原样保留', async () => {
    const storage = tempStorage()
    const ctx = new Context()
    new ToolsService(ctx, 'tools')
    const fiber = ctx.plugin(newsFeedPlugin, {
        source: mockSource(items(5)), storagePath: storage, maxStorageBytes: 1_000_000, pollIntervalMs: 60_000,
    })
    await ctx.news!.ensureFresh(0)
    assert.equal(readFileSync(storage, 'utf-8').trim().split('\n').length, 5)
    await fiber.dispose()
    rmSync(dirname(storage), { recursive: true, force: true })
})
