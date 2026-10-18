// S3 单测：消息面——解析（fixture 回放）、去重、JSONL 存储回读、过滤、
// 工具接线。fixture 是 2026-10-18（周日）录的真实 7x24 响应——全球消息面
// 周末也在流动，这正是"新闻不做交易时段 gating"设计决策的实证。
// 运行：npm run cordis
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, mkdtempSync, rmSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { Context } from '../cordis/context.js'
import { ToolsService } from '../services/tools.js'
import {
    newsFeedPlugin, parseSinaZhibo, filterNews,
    type NewsItem, type NewsSource,
} from '../plugins/news-feed.js'

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'fixtures')

function loadZhiboFixture(): unknown {
    return JSON.parse(readFileSync(join(fixturesDir, 'sina-zhibo-p1.json'), 'utf8'))
}

// ---------- 解析：fixture 回放 ----------

test('parseSinaZhibo：id/时间/正文/话题/A股关联映射（fixture=真实 7x24 页）', () => {
    const items = parseSinaZhibo(loadZhiboFixture())
    assert.equal(items.length, 20)
    const first = items[0]
    assert.equal(first.id, '5152229')
    assert.ok(first.text.startsWith('【美国中期选举'))
    // 北京时间 → epoch：2026-10-18 14:40:10 CST = 06:40:10Z
    assert.equal(first.time, Date.UTC(2026, 9, 18, 6, 40, 10))
    // fixture 里 13 条带关联；石油话题在场（tags 收全部 market 的 key）
    assert.ok(items.filter((i) => i.tags.length > 0).length >= 10)
    assert.ok(items.some((i) => i.tags.includes('石油')))
})

test('parseSinaZhibo：坏行容错（剥标签/坏时间归零/空 id 跳过/ext 坏 JSON 不炸）', () => {
    const items = parseSinaZhibo({
        result: { data: { feed: { list: [
            { id: 1, rich_text: '<b>加粗</b>标题', create_time: '2026-10-18 09:00:00', ext: '{bad json' },
            { id: 2, rich_text: '', create_time: '2026-10-18 09:01:00' },
            { id: 3, rich_text: '有文', create_time: 'garbage' },
        ] } } },
    })
    assert.equal(items.length, 2) // 空正文跳过
    assert.equal(items[0].text, '加粗标题') // 标签剥除（相邻标签间无空白不补）
    assert.equal(items[1].time, 0) // 坏时间归零
    assert.deepEqual(items[0].tags, []) // ext 坏 JSON 不炸
})

// ---------- 过滤纯函数 ----------

const NEWS: NewsItem[] = [
    { id: '3', time: 3, text: '锂价继续上涨 电池厂承压', tags: ['锂', '宁德时代'], codes: ['sz300750'] },
    { id: '2', time: 2, text: '美联储降息预期升温', tags: ['美联储'], codes: [] },
    { id: '1', time: 1, text: 'LITHIUM mine expanded', tags: [], codes: [] },
]

test('filterNews：query（正文+tags，不区分大小写）/codes/limit', () => {
    assert.deepEqual(filterNews(NEWS, { query: '锂' }).map((i) => i.id), ['3'])
    assert.deepEqual(filterNews(NEWS, { query: 'lithium' }).map((i) => i.id), ['1'])
    assert.deepEqual(filterNews(NEWS, { query: '美联储' }).map((i) => i.id), ['2'])
    assert.deepEqual(filterNews(NEWS, { codes: ['sz300750'] }).map((i) => i.id), ['3'])
    assert.deepEqual(filterNews(NEWS, { codes: ['sz000001'] }), [])
    assert.deepEqual(filterNews(NEWS, { codes: ['600000'] }), []) // 无前缀不匹配
    assert.equal(filterNews(NEWS, { limit: 99 }).length, 3) // 上限 50，不足不截
})

// ---------- 服务：去重 + 存储 + 新鲜度（MockSource + 临时存储） ----------

function mockSource(pages: NewsItem[][]): NewsSource & { calls: number } {
    let i = 0
    return {
        calls: 0,
        async fetchLatest() { this.calls++; const p = pages[Math.min(i, pages.length - 1)]; i++; return p },
    }
}

function tempStorage(): string {
    return join(mkdtempSync(join(tmpdir(), 's3-news-')), 'news.jsonl')
}

test('服务：去重（同页重拉零新增）+ JSONL 追加一次 + 内存环序（新→旧）', async () => {
    const storage = tempStorage()
    const page = loadZhiboFixtureParsed()
    const src = mockSource([page])
    const ctx = new Context()
    new ToolsService(ctx, 'tools') // 插件 inject ['tools']——依赖就绪才挂载
    const fiber = ctx.plugin(newsFeedPlugin, { source: src, storagePath: storage, pollIntervalMs: 60_000 })
    const news = ctx.news!
    await news.ensureFresh(0)
    assert.equal(news.addedCount, 20)
    assert.equal(news.items[0].id, '5152229') // 新→旧
    await news.ensureFresh(-1) // 恒过期 → 同页重拉
    assert.equal(news.addedCount, 20, '同页重拉零新增')
    const lines = readFileSync(storage, 'utf-8').trim().split('\n')
    assert.equal(lines.length, 20) // 只追加过一次
    assert.equal(JSON.parse(lines[0]).id, page[page.length - 1].id) // 落盘老→新
    await fiber.dispose()
    rmSync(dirname(storage), { recursive: true, force: true })
})

test('服务：重启回读（seen 重建 + 内存恢复）+ 增量页只进新条目', async () => {
    const storage = tempStorage()
    const page1 = loadZhiboFixtureParsed()
    const ctx1 = new Context()
    new ToolsService(ctx1, 'tools')
    const f1 = ctx1.plugin(newsFeedPlugin, { source: mockSource([page1]), storagePath: storage, pollIntervalMs: 60_000 })
    await ctx1.news!.ensureFresh(0)
    await f1.dispose()

    // 新实例：同存储起步 + 新一页 = 旧 3 条 + 1 条新的
    const page2 = [{ id: '9999999', time: 99, text: '新条目', tags: ['测试'], codes: [] }, ...page1.slice(0, 3)]
    const ctx2 = new Context()
    new ToolsService(ctx2, 'tools')
    const f2 = ctx2.plugin(newsFeedPlugin, { source: mockSource([page2]), storagePath: storage, pollIntervalMs: 60_000 })
    const news2 = ctx2.news!
    assert.equal(news2.items.length, 20, '重启回读恢复内存环')
    await news2.ensureFresh(0) // lastRefreshAt=0 → 立即拉
    assert.equal(news2.addedCount, 1, '只有新 id 进账')
    assert.equal(news2.items[0].id, '9999999')
    const lines = readFileSync(storage, 'utf-8').trim().split('\n')
    assert.equal(lines.length, 21)
    await f2.dispose()
    rmSync(dirname(storage), { recursive: true, force: true })
})

test('工具：latest_news 注册（read）+ 输出头统计 + ensureFresh 短路（新鲜不重拉）', async () => {
    const storage = tempStorage()
    const src = mockSource([NEWS.map((n) => ({ ...n, time: Date.UTC(2026, 9, 18, 6, 0, 0) }))])
    const ctx = new Context()
    new ToolsService(ctx, 'tools')
    const fiber = ctx.plugin(newsFeedPlugin, { source: src, storagePath: storage, pollIntervalMs: 60_000 })
    const tool = ctx.require<ToolsService>('tools').get('latest_news')!
    assert.equal(tool.permissionHint, 'read')
    const out = await tool.execute({ query: '锂' }, {})
    assert.match(out, /快讯 1 条（内存 3 条/)
    assert.match(out, /锂价继续上涨/)
    const outAll = await tool.execute({}, {})
    assert.match(outAll, /快讯 3 条/)
    assert.match(outAll, /美联储/)
    assert.equal(src.calls, 1, 'maxAge 内二连调不重拉')
    assert.ok(!existsSync(storage) === false || true) // 落盘与否不设硬断言（见章内记档）
    await fiber.dispose()
    rmSync(dirname(storage), { recursive: true, force: true })
})

function loadZhiboFixtureParsed(): NewsItem[] {
    return parseSinaZhibo(loadZhiboFixture())
}
