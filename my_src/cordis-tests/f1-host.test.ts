// F1 单测：web Host 最小面——走真实装配链（profile web 全链，非裸树）。
// echo 路由跑真 turn（ANTHROPIC 不被打），HTTP 信封/方法面/since 增量/静态
// 目录/路径穿越守卫逐条断言。运行：npm run cordis
import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { Agent } from '../agent.js'

let sandbox: string
let staticDir: string
let agent: Agent
let base: string

async function api(method: 'POST' | 'GET', path: string, body?: unknown): Promise<{ status: number; body: any }> {
    const res = await fetch(`${base}${path}`, {
        method,
        headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
        body: body !== undefined ? JSON.stringify(body) : undefined,
    })
    return { status: res.status, body: await res.json() }
}

beforeEach(async () => {
    sandbox = mkdtempSync(join(tmpdir(), 'f1-host-'))
    staticDir = join(sandbox, 'static')
    mkdirSync(staticDir, { recursive: true })
    writeFileSync(join(staticDir, 'index.html'), '<h1>mini host</h1>')
    // Agent 构造期读取（llmRoute 字段初始化）；homedir() 动态读——都在 new 之前设
    process.env.HOME = sandbox
    process.env.USERPROFILE = sandbox
    process.env.MINI_CLAUDE_LLM_ROUTE = 'echo'
    process.env.MINI_WEB_PORT = '0'
    process.env.MINI_WEB_STATIC = staticDir
    agent = new Agent({ profile: 'web' })
    assert.ok(agent.webHost, 'web profile should mount the host row')
    await agent.webHost!.ready
    const endpoint = agent.webHost!.endpoint
    assert.ok(endpoint, 'host should be listening after ready')
    base = endpoint.url
})

afterEach(async () => {
    await agent.close()
    for (const key of ['HOME', 'USERPROFILE', 'MINI_CLAUDE_LLM_ROUTE', 'MINI_WEB_PORT', 'MINI_WEB_STATIC']) {
        delete process.env[key]
    }
    rmSync(sandbox, { recursive: true, force: true })
})

test('session.create 幂等返回本树会话（id/busy/messageCount）', async () => {
    const r1 = await api('POST', '/api/session.create')
    assert.equal(r1.status, 200)
    assert.equal(r1.body.ok, true)
    assert.equal(r1.body.value.id, agent.id)
    assert.equal(r1.body.value.busy, false)
    assert.equal(r1.body.value.messageCount, 0)
    const r2 = await api('POST', '/api/session.create')
    assert.equal(r2.body.value.id, r1.body.value.id)
})

test('session.prompt 跑完整 turn（echo 路由），事件流可见', async () => {
    const p = await api('POST', '/api/session.prompt', { text: 'hello host' })
    assert.equal(p.body.ok, true)
    assert.equal(p.body.value.settled, true)

    const e = await api('GET', '/api/session.events')
    assert.equal(e.body.ok, true)
    const events = e.body.value.events as Array<{ seq: number; event: { type: string } }>
    // seq 连续从 0 起（事件下标 = D5 投影同款身份）
    events.forEach((entry, i) => assert.equal(entry.seq, i))
    const flat = JSON.stringify(events)
    assert.ok(flat.includes('hello host'), 'user message should be logged')
    assert.ok(flat.includes('[echo] hello host'), 'assistant reply should be logged')
})

test('session.events?since= 只回增量', async () => {
    await api('POST', '/api/session.prompt', { text: 'turn one' })
    const all = (await api('GET', '/api/session.events')).body.value.events
    assert.ok(all.length >= 4)

    // since = 倒数第二个 seq → 恰回最后一条；since = 最后一个 seq → 空增量
    const tail = await api('GET', `/api/session.events?since=${all.length - 2}`)
    assert.equal(tail.body.value.events.length, 1)
    assert.equal(tail.body.value.events[0].seq, all.length - 1)

    const none = await api('GET', `/api/session.events?since=${all.length - 1}`)
    assert.equal(none.body.value.events.length, 0)

    const bad = await api('GET', '/api/session.events?since=abc')
    assert.equal(bad.body.ok, false)
    assert.ok(String(bad.body.error).includes('bad since'))
})

test('session.list 返回单会话条目', async () => {
    await api('POST', '/api/session.prompt', { text: 'list me' })
    const l = await api('GET', '/api/session.list')
    assert.equal(l.body.ok, true)
    assert.equal(l.body.value.length, 1)
    assert.equal(l.body.value[0].id, agent.id)
    assert.ok(l.body.value[0].messageCount >= 2)
})

test('信封错误路径：未知方法 404、坏动词 405、坏 JSON 与坏参数 ok:false', async () => {
    const unknown = await api('POST', '/api/session.frobnicate')
    assert.equal(unknown.status, 404)
    assert.equal(unknown.body.ok, false)

    const wrongVerb = await api('POST', '/api/session.list')
    assert.equal(wrongVerb.status, 405)
    assert.ok(String(wrongVerb.body.error).includes('expects GET'))

    const res = await fetch(`${base}/api/session.prompt`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{not json',
    })
    assert.equal((res.status === 200), true)
    assert.equal((await res.json()).ok, false)

    const empty = await api('POST', '/api/session.prompt', { text: '   ' })
    assert.equal(empty.body.ok, false)
    assert.ok(String(empty.body.error).includes('requires { text'))
})

test('静态目录：index 兜底、404、路径穿越守卫', async () => {
    const home = await fetch(`${base}/`)
    assert.equal(home.status, 200)
    assert.ok((await home.text()).includes('mini host'))

    assert.equal((await fetch(`${base}/nope.css`)).status, 404)

    // %2e%2e 会被 WHATWG URL 归一化掉（fetch/浏览器同款，本身就是防线）→ 404；
    // 反斜杠形态（%5c%2e%2e）不被归一化，Windows 上真到达前缀守卫 → 403
    const dots = await fetch(`${base}/%2e%2e/${encodeURIComponent('f1-escape-probe')}`)
    assert.equal(dots.status, 404)
    const backslash = await fetch(`${base}/..%5c${encodeURIComponent('f1-escape-probe')}`)
    assert.equal(backslash.status, 403)
})

test('宿主未启 host 行时 agent.webHost 为空（默认 profile 不绑端口）', () => {
    const plain = new Agent({})
    assert.equal(plain.webHost, undefined)
})
