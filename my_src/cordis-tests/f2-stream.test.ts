// F2 单测：/api/stream WebSocket 事件流——走真实装配链（profile web 全链）。
// echo 路由跑真 turn；baseline/live、turn 中连接、kill 重连无洞无重、resume
// 补洞、多客户端广播、心跳、坏帧逐条断言。运行：npm run cordis
import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import WebSocket from 'ws'
import { Agent } from '../agent.js'

let sandbox: string
let staticDir: string
let agent: Agent
let base: string
let clients: WsClient[] = []

async function api(method: 'POST' | 'GET', path: string, body?: unknown): Promise<{ status: number; body: any }> {
    const res = await fetch(`${base}${path}`, {
        method,
        headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
        body: body !== undefined ? JSON.stringify(body) : undefined,
    })
    return { status: res.status, body: await res.json() }
}

type Frame = { type: string; [k: string]: any }

/** ws 测试客户端：收帧入队 + 按谓词等帧（已收帧里找，找不到等新帧）。 */
class WsClient {
    frames: Frame[] = []
    private waiters: Array<{ pred: (f: Frame) => boolean; resolve: (f: Frame) => void; timer: NodeJS.Timeout }> = []

    private constructor(private ws: WebSocket) {
        ws.on('message', (data) => {
            const frame = JSON.parse(String(data)) as Frame
            this.frames.push(frame)
            for (const w of [...this.waiters]) {
                if (w.pred(frame)) {
                    this.waiters = this.waiters.filter((x) => x !== w)
                    clearTimeout(w.timer)
                    w.resolve(frame)
                }
            }
        })
    }

    static connect(httpBase: string): Promise<WsClient> {
        return new Promise((resolvePromise, reject) => {
            const ws = new WebSocket(httpBase.replace(/^http/, 'ws') + '/api/stream')
            const client = new WsClient(ws)
            ws.on('open', () => resolvePromise(client))
            ws.on('error', reject)
        })
    }

    waitFor(pred: (f: Frame) => boolean, timeoutMs = 5000): Promise<Frame> {
        const hit = this.frames.find(pred)
        if (hit) return Promise.resolve(hit)
        return new Promise((resolvePromise, reject) => {
            const timer = setTimeout(() => {
                this.waiters = this.waiters.filter((w) => w.timer !== timer)
                reject(new Error(`waitFor timeout; frames so far: ${this.frames.map((f) => f.type).join(',')}`))
            }, timeoutMs)
            this.waiters.push({ pred, resolve: resolvePromise, timer })
        })
    }

    send(raw: string): void {
        this.ws.send(raw)
    }

    kill(): void {
        // 硬杀：不发 close 帧（模拟进程崩溃，服务端靠 TCP 层感知）
        this.ws.terminate()
    }

    eventSeqs(): number[] {
        return this.frames.filter((f) => f.type === 'event').map((f) => f.seq as number)
    }
}

function contiguous(seqs: number[]): boolean {
    for (let i = 1; i < seqs.length; i++) {
        if (seqs[i] !== seqs[i - 1] + 1) return false
    }
    return seqs.length === 0 || seqs[0] >= 0
}

async function waitForEvents(min: number): Promise<void> {
    for (let i = 0; i < 200; i++) {
        const e = await api('GET', '/api/session.events')
        if (e.body.value.events.length >= min) return
        await new Promise((resolve) => setTimeout(resolve, 5))
    }
    throw new Error(`events never reached ${min}`)
}

beforeEach(async () => {
    sandbox = mkdtempSync(join(tmpdir(), 'f2-stream-'))
    staticDir = join(sandbox, 'static')
    mkdirSync(staticDir, { recursive: true })
    writeFileSync(join(staticDir, 'index.html'), '<h1>mini host</h1>')
    process.env.HOME = sandbox
    process.env.USERPROFILE = sandbox
    process.env.MINI_CLAUDE_LLM_ROUTE = 'echo'
    process.env.MINI_WEB_PORT = '0'
    process.env.MINI_WEB_STATIC = staticDir
    process.env.MINI_WEB_HEARTBEAT_MS = '80'
    agent = new Agent({ profile: 'web' })
    await agent.webHost!.ready
    base = agent.webHost!.endpoint!.url
})

afterEach(async () => {
    for (const c of clients) c.kill()
    clients = []
    await agent.close()
    for (const key of ['HOME', 'USERPROFILE', 'MINI_CLAUDE_LLM_ROUTE', 'MINI_WEB_PORT', 'MINI_WEB_STATIC', 'MINI_WEB_HEARTBEAT_MS']) {
        delete process.env[key]
    }
    rmSync(sandbox, { recursive: true, force: true })
})

test('连上先收 baseline（全量回填），live 增量接续无洞', async () => {
    await api('POST', '/api/session.prompt', { text: 'turn one' })
    const c = await WsClient.connect(base)
    clients.push(c)

    const baseline = await c.waitFor((f) => f.type === 'baseline')
    const all = (await api('GET', '/api/session.events')).body.value.events
    assert.equal(baseline.lastSeq, all.length - 1)
    const seqs = baseline.events.map((e: any) => e.seq)
    assert.equal(seqs[0], 0)
    assert.ok(contiguous(seqs), `baseline seq 应连续：${seqs}`)

    await api('POST', '/api/session.prompt', { text: 'turn two' })
    await c.waitFor((f) => f.type === 'event' && f.event.type === 'turn/end')
    const live = c.eventSeqs()
    assert.ok(live.length > 0, '第二个 turn 应有 live 帧推来')
    assert.ok(contiguous([...seqs, ...live]), 'baseline + live 拼起来无洞')
})

test('turn 进行中连接：baseline 拿前缀、live 补后缀，不重不漏', async () => {
    const pending = api('POST', '/api/session.prompt', { text: 'race me' })
    // 先确认前缀已落日志再连（HTTP 请求与 WS 握手的 I/O 次序不定，直连会赢竞态）
    await waitForEvents(1)
    const c = await WsClient.connect(base)
    clients.push(c)
    const baseline = await c.waitFor((f) => f.type === 'baseline')
    assert.ok(baseline.events.length >= 1, '连接时 turn 已开跑，baseline 应含前缀')

    await pending
    // turn/end 可能已随 baseline 到达，也可能还在 live 管道里——两种形态都等
    await c.waitFor(
        (f) =>
            (f.type === 'event' && f.event.type === 'turn/end') ||
            (f.type === 'baseline' && f.events.some((e: any) => e.event.type === 'turn/end')),
    )

    const total = (await api('GET', '/api/session.events')).body.value.events.length
    const live = c.eventSeqs()
    assert.ok(live.every((s) => s > baseline.lastSeq), 'live 帧 seq 必须晚于 baseline（去重）')
    const seen = new Set<number>([...baseline.events.map((e: any) => e.seq), ...live])
    assert.equal(seen.size, total, '并集恰为全量（不重）')
    assert.ok(contiguous([...seen].sort((a, b) => a - b)), '并集连续（不漏）')
})

test('kill 后重连：baseline 补齐断连增量，resume 精确补洞', async () => {
    const a = await WsClient.connect(base)
    clients.push(a)
    const empty = await a.waitFor((f) => f.type === 'baseline')
    assert.equal(empty.lastSeq, -1, '空会话 baseline：lastSeq = -1、events 空')
    assert.equal(empty.events.length, 0)

    const pending = api('POST', '/api/session.prompt', { text: 'kill me mid-turn' })
    await a.waitFor((f) => f.type === 'event')
    a.kill()
    await pending

    const b = await WsClient.connect(base)
    clients.push(b)
    const baseline = await b.waitFor((f) => f.type === 'baseline')
    const total = (await api('GET', '/api/session.events')).body.value.events.length
    assert.equal(baseline.lastSeq, total - 1)
    const bSeqs = baseline.events.map((e: any) => e.seq)
    assert.ok(contiguous(bSeqs), '重连 baseline 无洞')
    assert.ok(contiguous(a.eventSeqs()), '被杀客户端生前收到的是无洞前缀')
    assert.ok(a.eventSeqs().every((s) => s <= baseline.lastSeq), '断连期间增量全部由 baseline 补齐')

    b.send(JSON.stringify({ type: 'resume', since: 1 }))
    const resumed = await b.waitFor((f) => f.type === 'resumed')
    assert.equal(resumed.lastSeq, total - 1)
    // b 此前没有任何 event 帧——replay 应恰为 (1, now]，每 seq 恰一次
    assert.deepEqual(b.eventSeqs(), Array.from({ length: total - 2 }, (_, i) => i + 2))
})

test('多客户端广播：同一 turn 的 live 帧按一致 seq 送达各端', async () => {
    const a = await WsClient.connect(base)
    const b = await WsClient.connect(base)
    clients.push(a, b)
    await a.waitFor((f) => f.type === 'baseline')
    await b.waitFor((f) => f.type === 'baseline')

    await api('POST', '/api/session.prompt', { text: 'broadcast me' })
    await a.waitFor((f) => f.type === 'event' && f.event.type === 'turn/end')
    await b.waitFor((f) => f.type === 'event' && f.event.type === 'turn/end')

    assert.ok(a.eventSeqs().length > 0)
    assert.deepEqual(a.eventSeqs(), b.eventSeqs(), '两个客户端收到的 live seq 序列一致')
})

test('心跳按配置间隔广播，携带当前 lastSeq', async () => {
    const c = await WsClient.connect(base)
    clients.push(c)
    const hb = await c.waitFor((f) => f.type === 'heartbeat', 3000)
    assert.equal(typeof hb.lastSeq, 'number')
    assert.ok(hb.lastSeq >= -1)
})

test('坏帧容错：垃圾 JSON/未知类型/坏 since 回 error，连接存活可继续 resume', async () => {
    const c = await WsClient.connect(base)
    clients.push(c)
    await c.waitFor((f) => f.type === 'baseline')

    c.send('not json')
    const e1 = await c.waitFor((f) => f.type === 'error')
    assert.ok(String(e1.error).includes('not valid JSON'))

    c.send(JSON.stringify({ type: 'frobnicate' }))
    const e2 = await c.waitFor((f) => f.type === 'error' && f !== e1)
    assert.ok(String(e2.error).includes('frobnicate'))

    c.send(JSON.stringify({ type: 'resume', since: 'x' }))
    const e3 = await c.waitFor((f) => f.type === 'error' && f !== e1 && f !== e2)
    assert.ok(String(e3.error).includes('since'))

    c.send(JSON.stringify({ type: 'resume', since: -1 }))
    const ack = await c.waitFor((f) => f.type === 'resumed')
    assert.equal(ack.lastSeq, -1, '连接未被坏帧打死，resume 正常回执')
})

test('非 /api/stream 的 upgrade 被拒（socket 直接销毁）', async () => {
    const outcome = await new Promise<string>((resolvePromise) => {
        const ws = new WebSocket(base.replace(/^http/, 'ws') + '/api/other')
        ws.on('open', () => {
            ws.terminate()
            resolvePromise('open')
        })
        ws.on('error', () => resolvePromise('error'))
    })
    assert.equal(outcome, 'error')
})
