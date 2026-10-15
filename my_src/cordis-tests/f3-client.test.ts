// F3 单测：webui 客户端基座——store 引擎（React-free 直测）、connection
// 传输面（真实 Host 全链 + 合成帧驱动的补洞逻辑）。
// 运行：npm run cordis
import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import WebSocket from 'ws'
import { defineStore } from '../webui/store.js'
import { Connection, RpcError, type StreamSink, type WsLike } from '../webui/connection.js'
import { webUiStore } from '../webui/app-state.js'
import { Agent } from '../agent.js'

// ── store 引擎（React-free，直测契约） ─────────────────────────────────

test('store：快照稳定——等值 update 不换引用不通知，改动才换', () => {
    const store = defineStore({
        init: () => ({ n: 1, label: 'a' }),
        actions: {
            setN(draft, n: number) {
                draft.n = n
            },
            setLabel(draft, label: string) {
                draft.label = label
            },
        },
    }).create()

    let notifications = 0
    store.subscribe(() => {
        notifications += 1
    })

    const before = store.getSnapshot()
    store.actions.setN(1) // 等值写：produce 无变更
    assert.equal(notifications, 0, '等值 update 不该通知')
    assert.equal(store.getSnapshot(), before, '引用不该变')

    store.actions.setN(2)
    assert.equal(notifications, 1)
    assert.notEqual(store.getSnapshot(), before)
    assert.equal(store.getSnapshot().n, 2)
    assert.equal(store.getSnapshot().label, 'a', '未触碰字段保留')
})

test('store：select 切片订阅——选中值不变则不通知，变才通知', () => {
    const store = defineStore({
        init: () => ({ n: 1, label: 'a' }),
        actions: {
            setLabel(draft, label: string) {
                draft.label = label
            },
        },
    }).create()

    let notifications = 0
    store.select(
        (s) => ({ n: s.n, shout: s.label.toUpperCase() }),
        (a, b) => a.n === b.n && a.shout === b.shout,
        () => {
            notifications += 1
        },
    )

    store.actions.setLabel('b') // 切片里 shout 变了
    assert.equal(notifications, 1)
    store.actions.setLabel('B') // toUpperCase 后等值
    assert.equal(notifications, 1, '等值切片不通知')
})

test('store：baked actions 不见 draft 参数（审计面），写集就是声明表', () => {
    const store = defineStore({
        init: () => ({ items: [] as string[] }),
        actions: {
            push(draft, item: string) {
                draft.items.push(item)
            },
        },
    }).create()

    // draft 是声明参数，baked 后调用方只传业务参数
    store.actions.push('x')
    store.actions.push('y')
    assert.deepEqual(store.getSnapshot().items, ['x', 'y'])
    assert.equal(typeof (store.actions as any).nope, 'undefined', '声明表之外没有写入口')
})

// ── connection（真实 Host 全链） ──────────────────────────────────────

let sandbox: string
let staticDir: string
let agent: Agent
let base: string
const openConns: Array<{ close(): void }> = []

async function api(method: 'POST' | 'GET', path: string, body?: unknown): Promise<{ status: number; body: any }> {
    const res = await fetch(`${base}${path}`, {
        method,
        headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
        body: body !== undefined ? JSON.stringify(body) : undefined,
    })
    return { status: res.status, body: await res.json() }
}

/** 测试用 ws 工厂：记住最后一条连接供用例硬杀，模拟崩溃断线。 */
function wsFactoryCapture(): { factory: (url: string) => WsLike; last(): WebSocket } {
    let last: WebSocket | null = null
    return {
        factory: (url: string) => {
            last = new WebSocket(url) as unknown as WebSocket
            return last as unknown as WsLike
        },
        last: () => last!,
    }
}

function storeSink(store: ReturnType<typeof webUiStore.create>): StreamSink {
    return {
        setBaseline: (events, lastSeq) => store.actions.setBaseline(events, lastSeq),
        appendEvent: (seq, event) => store.actions.appendEvent(seq, event),
        setStatus: ({ phase, generation }) => store.actions.setStreamPhase(phase as any, generation),
    }
}

beforeEach(async () => {
    sandbox = mkdtempSync(join(tmpdir(), 'f3-client-'))
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
    for (const c of openConns) c.close()
    openConns.length = 0
    await agent.close()
    for (const key of ['HOME', 'USERPROFILE', 'MINI_CLAUDE_LLM_ROUTE', 'MINI_WEB_PORT', 'MINI_WEB_STATIC', 'MINI_WEB_HEARTBEAT_MS']) {
        delete process.env[key]
    }
    rmSync(sandbox, { recursive: true, force: true })
})

test('connection.call：信封 ok→value；业务失败与未知方法 → RpcError', async () => {
    const conn = new Connection({ baseUrl: base }, { setBaseline: () => {}, appendEvent: () => {}, setStatus: () => {} })
    openConns.push(conn)

    const list = await conn.call('session.list')
    assert.equal(list.length, 1)

    const created = await conn.call('session.create', {})
    assert.equal(created.id, agent.id)

    await assert.rejects(() => conn.call('session.prompt', { text: '   ' }), (e: unknown) => {
        assert.ok(e instanceof RpcError)
        assert.ok(String(e).includes('requires { text'))
        return true
    })

    await assert.rejects(() => conn.call('session.frobnicate'), (e: unknown) => {
        assert.ok(e instanceof RpcError)
        assert.ok(String(e).includes('session.frobnicate'))
        return true
    })
})

test('流消费全链：connecting→live、baseline 落 store、prompt 的 live 增量按序进 store', async () => {
    const store = webUiStore.create()
    const conn = new Connection({ baseUrl: base }, storeSink(store))
    openConns.push(conn)
    conn.connectStream()

    await waitFor(() => store.getSnapshot().stream.phase === 'live')
    assert.equal(store.getSnapshot().stream.generation, 1)

    const baselineLen = store.getSnapshot().events.length
    await conn.call('session.prompt', { text: 'stream me' })
    await waitFor(() =>
        store.getSnapshot().events.some((e: any) => e.event.type === 'turn/end' && e.seq > baselineLen - 1),
    )

    const seqs = store.getSnapshot().events.map((e) => e.seq as number)
    assert.ok(seqs.length > baselineLen, 'live 增量已进 store')
    for (let i = 1; i < seqs.length; i++) {
        assert.equal(seqs[i], seqs[i - 1] + 1, `seq 无洞无重：${seqs}`)
    }
    assert.equal(store.getSnapshot().stream.lastSeq, seqs[seqs.length - 1])
})

test('kill 重连：generation 递增、新 baseline 收敛、断连期间增量不丢', async () => {
    const store = webUiStore.create()
    const { factory, last } = wsFactoryCapture()
    const conn = new Connection({ baseUrl: base, reconnectBaseMs: 20, wsFactory: factory }, storeSink(store))
    openConns.push(conn)
    conn.connectStream()
    await waitFor(() => store.getSnapshot().stream.phase === 'live')

    await conn.call('session.prompt', { text: 'before kill' })
    const afterFirst = store.getSnapshot().events.length
    assert.ok(afterFirst > 0)

    // 硬杀当前代连接（不发 close 帧语义的优雅收口走 ws.close 的 TCP 断开）
    last().close()
    // reconnecting 是毫秒级瞬态（新代 baseline 随即置回 live）——等最终态
    await waitFor(() => store.getSnapshot().stream.phase === 'live' && store.getSnapshot().stream.generation === 2)
    assert.equal(store.getSnapshot().stream.generation, 2, 'generation 已换代')

    // 断连期间的事件由新代 baseline 补齐——store 收敛后仍无洞无重
    await conn.call('session.prompt', { text: 'after kill' })
    await waitFor(() =>
        store.getSnapshot().events.some((e: any) => e.event.type === 'turn/end' && e.seq >= afterFirst),
    )
    const seqs = store.getSnapshot().events.map((e) => e.seq as number)
    assert.equal(new Set(seqs).size, seqs.length, '无重')
    for (let i = 1; i < seqs.length; i++) {
        assert.equal(seqs[i], seqs[i - 1] + 1, `无洞：${seqs}`)
    }
})

// ── connection（合成帧驱动的协议逻辑，不依赖真机） ─────────────────────

interface FakeWs {
    ws: WsLike
    sent: string[]
    open(): void
    frame(f: unknown): void
    closeFromRemote(): void
}

function fakeWs(): FakeWs {
    const sent: string[] = []
    const listeners = new Map<string, Array<(ev: any) => void>>()
    const ws: WsLike = {
        send: (d) => sent.push(d),
        close: () => {},
        addEventListener: (t, fn) => {
            if (!listeners.has(t)) listeners.set(t, [])
            listeners.get(t)!.push(fn)
        },
        removeEventListener: () => {},
    }
    const fire = (type: string, ev: any) => {
        for (const fn of listeners.get(type) ?? []) fn(ev)
    }
    return {
        ws,
        sent,
        open: () => fire('open', {}),
        frame: (f) => fire('message', { data: JSON.stringify(f) }),
        closeFromRemote: () => fire('close', {}),
    }
}

test('合成帧：跳号触发 resume 补洞、重复 seq 丢弃、心跳揭示洞也补', () => {
    const fake = fakeWs()
    const events: Array<{ seq: number; event: any }> = []
    const conn = new Connection(
        { baseUrl: 'http://x', wsFactory: () => fake.ws },
        {
            setBaseline: (baseline) => events.push(...(baseline as any)),
            appendEvent: (seq, event) => events.push({ seq, event }),
            setStatus: () => {},
        },
    )
    conn.connectStream()
    fake.open()

    fake.frame({ type: 'baseline', lastSeq: 1, events: [{ seq: 0, event: { t: 0 } }, { seq: 1, event: { t: 1 } }] })
    fake.frame({ type: 'event', seq: 2, event: { t: 2 } })
    fake.frame({ type: 'event', seq: 4, event: { t: 4 } }) // 跳号——丢弃，等补洞
    fake.frame({ type: 'event', seq: 2, event: { t: 2 } }) // 重复——丢弃

    // 服务端按 since=2 回放（模拟）
    fake.frame({ type: 'event', seq: 3, event: { t: 3 } })
    fake.frame({ type: 'event', seq: 4, event: { t: 4 } })
    fake.frame({ type: 'resumed', lastSeq: 4 })

    fake.frame({ type: 'heartbeat', lastSeq: 6 }) // 心跳揭示还有洞
    fake.frame({ type: 'event', seq: 5, event: { t: 5 } })
    fake.frame({ type: 'event', seq: 6, event: { t: 6 } })

    const resumptions = fake.sent
        .filter((raw) => JSON.parse(raw).type === 'resume')
        .map((raw) => JSON.parse(raw).since as number)
    assert.deepEqual(resumptions, [2, 4], '跳号与心跳各触发一次 resume，since=本地 lastSeq')

    assert.deepEqual(
        events.map((e) => e.seq),
        [0, 1, 2, 3, 4, 5, 6],
        '最终落地无洞无重',
    )
    conn.close()
})

// ── 工具 ─────────────────────────────────────────────────────────────

async function waitFor(pred: () => boolean, timeoutMs = 5000): Promise<void> {
    const start = Date.now()
    while (!pred()) {
        if (Date.now() - start > timeoutMs) throw new Error('waitFor timeout')
        await new Promise((resolve) => setTimeout(resolve, 10))
    }
}
