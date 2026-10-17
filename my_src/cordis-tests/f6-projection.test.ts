// F6 单测：投影与收官。三层验证面：
//   1. projection fold 单元（React-free——合成事件流 → SessionProjection）：
//      mode/turns/tokens+cost/compactions/goal 生命周期（set→progress→clear，
//      clear 后 progress 不复活）/loop 生命周期
//   2. http 驱动真链：真实 turn 的投影从流里折出来；goal 未达→progress 注记
//      live 到场→budget 停机 clear；loop 起止注记（interval 1s + maxTurns 停机）
//   3. resume 重现：重启 Host（新 Agent）+ JSONL 重放 → baseline 逐事件重现，
//      投影数字一致——"重启后打开旧会话=回放重现"的验收线
// 运行：npm run cordis
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import WebSocket from 'ws'
import { Agent } from '../agent.js'
import { getLatestSessionId } from '../plugins/session-jsonl.js'
import { projectSession } from '../webui/projection.js'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const { startMock } = await import(
    new URL('../../mock-anthropic.mjs', import.meta.url).href
) as any

// ── 1. fold 单元 ─────────────────────────────────────────────────────────────

function fold(eventList: any[]) {
    return projectSession(eventList.map((event, seq) => ({ seq, event })))
}

test('fold：mode/turns/tokens+cost/compactions 从事件流折出，lastSeq 收口', () => {
    const p = fold([
        { type: 'meta/note', key: 'mode', value: 'plan' },
        { type: 'turn/start' },
        { type: 'assistant/message', content: [{ type: 'text', text: 'a' }], usage: { input: 100, output: 20, cacheRead: 50, cacheCreation: 10 } },
        { type: 'tool/call', id: 't', name: 'x', input: {} },
        { type: 'tool/result', callId: 't', content: 'ok' },
        { type: 'turn/end', reason: 'tool-use' },
        { type: 'history/truncate', reason: 'compact' },
        { type: 'turn/start' },
        { type: 'assistant/message', content: [{ type: 'text', text: 'b' }], usage: { input: 10, output: 2, cacheRead: 0, cacheCreation: 0 } },
        { type: 'turn/end', reason: 'end-turn' },
    ])
    assert.equal(p.lastSeq, 9)
    assert.equal(p.mode, 'plan')
    assert.equal(p.turns, 2)
    assert.equal(p.compactions, 1)
    assert.deepEqual(p.tokens, { input: 110, output: 22, cacheRead: 50, cacheCreation: 10 })
    // 110/1M*3 + 50/1M*0.3 + 10/1M*3.75 + 22/1M*15 = 0.0007125
    assert.ok(Math.abs(p.costUsd - 0.0007125) < 1e-12)
})

test('fold：goal 生命周期（set 重置进度→progress 递增→clear 归零），clear 后 progress 不复活', () => {
    const p = fold([
        { type: 'meta/note', key: 'goal', value: { condition: 'tests pass' } },
        { type: 'meta/note', key: 'goal-progress', value: { iterations: 1, lastReason: 'not yet' } },
        { type: 'meta/note', key: 'goal-progress', value: { iterations: 2, lastReason: 'closer' } },
    ])
    assert.deepEqual(p.goal, { condition: 'tests pass', iterations: 2, lastReason: 'closer' })

    const cleared = fold([
        { type: 'meta/note', key: 'goal', value: { condition: 'tests pass' } },
        { type: 'meta/note', key: 'goal-progress', value: { iterations: 1, lastReason: 'not yet' } },
        { type: 'meta/note', key: 'goal', value: null },
        { type: 'meta/note', key: 'goal-progress', value: { iterations: 9, lastReason: 'stale' } },
    ])
    assert.equal(cleared.goal, null, 'clear 后迟到的 progress 不复活 goal')

    const reset = fold([
        { type: 'meta/note', key: 'goal', value: { condition: 'a' } },
        { type: 'meta/note', key: 'goal-progress', value: { iterations: 3, lastReason: 'x' } },
        { type: 'meta/note', key: 'goal', value: { condition: 'b' } },
    ])
    assert.deepEqual(reset.goal, { condition: 'b', iterations: 0 }, '重新 set 重置进度')
})

test('fold：loop 生命周期（start 注记 → finish null）', () => {
    const running = fold([{ type: 'meta/note', key: 'loop', value: { mode: 'interval', intervalSeconds: 5, prompt: 'report' } }])
    assert.deepEqual(running.loop, { mode: 'interval', intervalSeconds: 5, prompt: 'report' })
    const stopped = fold([
        { type: 'meta/note', key: 'loop', value: { mode: 'interval', intervalSeconds: 5, prompt: 'report' } },
        { type: 'meta/note', key: 'loop', value: null },
    ])
    assert.equal(stopped.loop, null)
})

// ── 2. http 驱动真链 ─────────────────────────────────────────────────────────

type Frame = { type: string; [k: string]: any }

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

    waitFor(pred: (f: Frame) => boolean, timeoutMs = 10000): Promise<Frame> {
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

    close(): void {
        this.ws.close()
    }
}

interface Boot {
    agent: Agent
    base: string
    sandbox: string
    client: WsClient
    /** baseline + live 按 seq 去重后的全量事件（fold 输入）。 */
    entries(): Array<{ seq: number; event: any }>
    projection(): ReturnType<typeof projectSession>
    rpc(method: string, input?: any): Promise<{ ok: boolean; value: any; error?: string }>
    close(): Promise<void>
}

async function boot(scenario: { turns?: any[]; tracks?: any }, opts: { connectClient?: boolean } = {}): Promise<Boot> {
    const sandbox = mkdtempSync(join(tmpdir(), 'f6-proj-'))
    process.env.HOME = sandbox
    process.env.USERPROFILE = sandbox
    process.env.ANTHROPIC_API_KEY = 'test'
    process.env.MINI_CLAUDE_SDK_MAX_RETRIES = '0'
    process.env.MINI_WEB_PORT = '0'

    const mock = await startMock({ scenario })
    process.env.ANTHROPIC_BASE_URL = mock.url

    const agent = new Agent({ profile: 'web' })
    await agent.webHost!.ready
    const base = agent.webHost!.endpoint!.url
    const client = opts.connectClient === false ? (null as unknown as WsClient) : await WsClient.connect(base)

    const bySeq = new Map<number, any>()
    if (client) {
        const pump = (frame: Frame): void => {
            if (frame.type === 'baseline') for (const e of frame.events as Array<{ seq: number; event: any }>) bySeq.set(e.seq, e.event)
            else if (frame.type === 'event') bySeq.set(frame.seq as number, frame.event)
        }
        for (const frame of client.frames) pump(frame)
        const ws: WebSocket = (client as any).ws
        ws.on('message', (data: Buffer) => pump(JSON.parse(String(data))))
    }

    return {
        agent,
        base,
        sandbox,
        client,
        entries: () => [...bySeq.entries()].sort((a, b) => a[0] - b[0]).map(([seq, event]) => ({ seq, event })),
        projection: () => projectSession([...bySeq.entries()].sort((a, b) => a[0] - b[0]).map(([seq, event]) => ({ seq, event }))),
        rpc: async (method, input) => {
            const res = await fetch(`${base}/api/${method}`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(input ?? {}),
            })
            const body = await res.json()
            return { ok: body.ok, value: body.value, error: body.error }
        },
        async close(): Promise<void> {
            client?.close()
            await agent.close()
            await mock.close()
            for (const key of ['HOME', 'USERPROFILE', 'ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL', 'MINI_CLAUDE_SDK_MAX_RETRIES', 'MINI_WEB_PORT']) {
                delete process.env[key]
            }
            rmSync(sandbox, { recursive: true, force: true })
        },
    }
}

async function prompt(base: string, text: string): Promise<{ ok: boolean; value: any; error?: string }> {
    const res = await fetch(`${base}/api/session.prompt`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text }),
    })
    const body = await res.json()
    return { ok: body.ok, value: body.value, error: body.error }
}

async function waitTurnEnds(client: WsClient, n: number, timeoutMs = 15000): Promise<void> {
    const count = (): number => client.frames.filter((f) => f.type === 'event' && f.event?.type === 'turn/end').length
    if (count() >= n) return
    await new Promise<void>((resolve, reject) => {
        const ws = (client as any).ws
        const onMsg = (data: Buffer): void => {
            const f = JSON.parse(String(data))
            if (f.type === 'event' && f.event?.type === 'turn/end' && count() >= n) {
                clearTimeout(timer)
                ws.off('message', onMsg)
                resolve()
            }
        }
        const timer = setTimeout(() => {
            ws.off('message', onMsg)
            reject(new Error(`waitTurnEnds(${n}) timeout, got ${count()}`))
        }, timeoutMs)
        ws.on('message', onMsg)
    })
}

test('http 驱动：真实 turn 的投影从流里折出（turns/tokens/cost）', async () => {
    const boot1 = await boot({ turns: [{ text: 'hello there' }] })
    try {
        const p = await prompt(boot1.base, 'say hi')
        assert.equal(p.ok, true)
        await waitTurnEnds(boot1.client, 1)

        const proj = boot1.projection()
        assert.equal(proj.turns, 1)
        assert.ok(proj.tokens.output > 0, 'usage 应从 assistant 事件折出')
        assert.ok(proj.costUsd > 0)
        assert.equal(proj.goal, null)
        assert.equal(proj.loop, null)
        assert.equal(proj.compactions, 0)
        // 初始 mode 不落注记（setMode 才落）——投影为 null，显示层兜底 default
        assert.equal(proj.mode, null)
    } finally {
        await boot1.close()
    }
})

test('http 驱动：goal 未达 → progress 注记 live 到场 → 评估达观 clear', async () => {
    const boot1 = await boot({
        tracks: {
            main: { turns: [{ text: 'still working on it.' }, { text: 'now it is done.' }] },
            goal: {
                match: 'evaluating a hook condition',
                turns: [
                    { text: '{"ok": false, "reason": "the files have not been read yet."}' },
                    { text: '{"ok": true, "reason": "all done."}' },
                ],
            },
        },
    })
    try {
        // 确定性收束：评估器序列 NOT_MET → MET（不能用 maxTurns 停——currentTurns
        // 只在 tool_use 轮计数，纯文本 turn 永远不超预算，goal 会跑到 mock 耗尽）
        const directive = boot1.agent.setGoal('all tests pass')
        const settled = boot1.agent.pursueGoal(directive)

        // live：progress 注记帧到场时投影已见 iterations（goal 仍活跃）
        await boot1.client.waitFor((f) => f.type === 'event' && f.event?.type === 'meta/note' && f.event?.key === 'goal-progress')
        const mid = boot1.projection()
        assert.ok(mid.goal, '评估未达时 goal 应活跃')
        assert.equal(mid.goal!.condition, 'all tests pass')
        assert.ok(mid.goal!.iterations >= 1)
        assert.ok(mid.goal!.lastReason!.includes('not been read'))

        await settled
        // ws 帧投递是独立宏任务——settle 的续延可能先于帧处理跑（微任务优先），
        // 轮询等 clear 注记帧折进投影
        for (let i = 0; i < 400; i++) {
            if (boot1.projection().goal === null) break
            await new Promise((resolve) => setTimeout(resolve, 5))
            if (i === 399) throw new Error('goal clear note never folded')
        }
        const end = boot1.projection()
        assert.equal(end.goal, null)
        const notes = boot1.entries().filter((e) => e.event.type === 'meta/note' && e.event.key === 'goal')
        // set + met 清 + pursueGoal finally 再清（clear 无条件落注记）
        assert.ok(notes.length >= 2)
        assert.equal(notes[notes.length - 1].event.value, null)
    } finally {
        await boot1.close()
    }
})

test('http 驱动：loop 起止注记（interval 1s + maxTurns 停机）', async () => {
    const boot1 = await boot({ turns: [{ text: 'tick one' }, { text: 'spare' }] })
    try {
        boot1.agent.setMaxTurns(1)
        const settled = boot1.agent.runLoop('1s report the clock')

        // live：loop start 注记到场 → 投影见活跃 loop
        await boot1.client.waitFor((f) => f.type === 'event' && f.event?.type === 'meta/note' && f.event?.key === 'loop' && f.event?.value !== null)
        assert.deepEqual(boot1.projection().loop, { mode: 'interval', intervalSeconds: 1, prompt: 'report the clock' })

        await settled
        // 同 goal 测试：settle 续延可能先于 null 注记帧的投递（微任务 vs socket 宏任务）
        for (let i = 0; i < 400; i++) {
            if (boot1.projection().loop === null) break
            await new Promise((resolve) => setTimeout(resolve, 5))
            if (i === 399) throw new Error('loop finish note never folded')
        }
        const end = boot1.projection()
        assert.equal(end.loop, null, 'tick 上限停机后 loop 清零')
        const notes = boot1.entries().filter((e) => e.event.type === 'meta/note' && e.event.key === 'loop')
        assert.equal(notes.length, 2, 'start + finish 两条 loop 注记')
    } finally {
        await boot1.close()
    }
})

// ── 3. resume 重现 ───────────────────────────────────────────────────────────

test('resume 重现：重启 Host + JSONL 重放 → baseline 逐事件重现、投影一致', async () => {
    const sandbox = mkdtempSync(join(tmpdir(), 'f6-resume-'))
    const oldHome = process.env.HOME
    const oldUserProfile = process.env.USERPROFILE
    const oldBaseUrl = process.env.ANTHROPIC_BASE_URL
    const oldKey = process.env.ANTHROPIC_API_KEY
    try {
        process.env.HOME = sandbox
        process.env.USERPROFILE = sandbox
        process.env.ANTHROPIC_API_KEY = 'test'
        process.env.MINI_CLAUDE_SDK_MAX_RETRIES = '0'
        process.env.MINI_WEB_PORT = '0'
        const mock = await startMock({ scenario: { turns: [{ text: 'first answer' }] } })
        process.env.ANTHROPIC_BASE_URL = mock.url

        // 第一段生命周期：跑一个 turn，收口（≙ Host 进程结束）。
        // 连接可能落在 turn 中途——baseline + live 一并收，等到 turn/end 才算收齐
        const agent1 = new Agent({ profile: 'web' })
        await agent1.webHost!.ready
        const p = await prompt(agent1.webHost!.endpoint!.url, 'remember this')
        assert.equal(p.ok, true)
        const ws1 = new WebSocket(agent1.webHost!.endpoint!.url.replace(/^http/, 'ws') + '/api/stream')
        const seen1 = new Map<number, any>()
        ws1.on('message', (d) => {
            const f = JSON.parse(String(d))
            if (f.type === 'baseline') for (const e of f.events as Array<{ seq: number; event: any }>) seen1.set(e.seq, e.event)
            else if (f.type === 'event') seen1.set(f.seq as number, f.event)
        })
        await new Promise((r) => ws1.on('open', r))
        for (let i = 0; i < 400; i++) {
            if ([...seen1.values()].some((e) => e.type === 'turn/end')) break
            await new Promise((r) => setTimeout(r, 5))
            if (i === 399) throw new Error('first life never settled')
        }
        ws1.close()
        await agent1.close()
        const first = [...seen1.entries()].sort((a, b) => a[0] - b[0]).map(([seq, event]) => ({ seq, event }))

        // 第二段生命周期：新 Agent + resume（JSONL 重放）→ baseline 重现
        const sessionId = getLatestSessionId()
        assert.ok(sessionId, '第一段应落了 JSONL 会话文件')
        const agent2 = new Agent({ profile: 'web' })
        assert.equal(agent2.resume(sessionId!), true)
        await agent2.webHost!.ready
        const base2 = agent2.webHost!.endpoint!.url
        const ws2 = new WebSocket(base2.replace(/^http/, 'ws') + '/api/stream')
        const reborn: Array<{ seq: number; event: any }> = []
        ws2.on('message', (d) => {
            const f = JSON.parse(String(d))
            if (f.type === 'baseline') for (const e of f.events as Array<{ seq: number; event: any }>) reborn.push(e)
        })
        await new Promise((r) => ws2.on('open', r))
        for (let i = 0; i < 400; i++) {
            if (reborn.length >= first.length && reborn.length > 0) break
            await new Promise((r) => setTimeout(r, 5))
            if (i === 399) throw new Error(`baseline never full: ${reborn.length} vs ${first.length}`)
        }
        ws2.close()

        // 逐事件重现 + 投影数字一致（resume 的幂等守卫保证无 goal 会话不多出注记）
        assert.equal(reborn.length, first.length)
        assert.deepEqual(JSON.stringify(reborn), JSON.stringify(first))
        const proj1 = projectSession(first)
        const proj2 = projectSession(reborn)
        assert.equal(proj2.turns, proj1.turns)
        assert.deepEqual(proj2.tokens, proj1.tokens)
        assert.ok(proj2.tokens.output > 0)

        if (reborn.length !== first.length) {
            console.error('DEBUG first:', JSON.stringify(first))
            console.error('DEBUG reborn:', JSON.stringify(reborn))
        }
        await agent2.close()
        await mock.close()
    } finally {
        for (const [k, v] of [['HOME', oldHome], ['USERPROFILE', oldUserProfile], ['ANTHROPIC_BASE_URL', oldBaseUrl], ['ANTHROPIC_API_KEY', oldKey], ['MINI_CLAUDE_SDK_MAX_RETRIES', undefined], ['MINI_WEB_PORT', undefined]] as Array<[string, string | undefined]>) {
            if (v === undefined) delete process.env[k]
            else process.env[k] = v
        }
        rmSync(sandbox, { recursive: true, force: true })
    }
})
