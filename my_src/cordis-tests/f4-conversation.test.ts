// F4 单测：会话装配。三层验证面：
//   1. conversation fold 单元（React-free——合成事件流 → Nodes）
//   2. store 忙闲界碑（accepted → turn/end / prompt-error 解除 + baseline 对账）
//   3. http 驱动真链：场景 9 同款脚本（catalog 注入 / skill 激活卡 / Unknown
//      skill 报错卡）+ busy 竞态 + prompt-error 兜底——mock 驱动从"直调 agent"
//      升级出"http 驱动"一条（startMock 进程内起，ANTHROPIC_BASE_URL 指过去）。
// 运行：npm run cordis
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import WebSocket from 'ws'
import { Agent } from '../agent.js'
import { assembleConversation, type ConversationNode } from '../webui/conversation.js'
import { webUiStore } from '../webui/app-state.js'

// mock-anthropic.mjs 不进 tsc 产物——运行时从 dist 上溯回源码根引（URL 不经
// 编译改写，动态 import 变量说明符也绕开 TS 的模块解析）
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const { startMock } = await import(
    new URL('../../mock-anthropic.mjs', import.meta.url).href
) as any

// ── 1. conversation fold 单元 ──────────────────────────────────────────────

function assemble(eventList: any[]): ConversationNode[] {
    return assembleConversation(eventList.map((event, seq) => ({ seq, event })))
}

test('fold：user 文本与 system-reminder 拆分、连续 user 不合并（原始日志视图）', () => {
    const nodes = assemble([
        { type: 'user/message', content: 'hello\n\n<system-reminder>\n# Available Skills\n- **/commit**: x\n</system-reminder>' },
        { type: 'user/message', content: 'second thought' },
        { type: 'user/message', content: [{ type: 'text', text: 'block form' }] },
        { type: 'user/message', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'result body' }] },
    ])
    assert.deepEqual(nodes.map((n) => n.kind), ['user', 'injection', 'user', 'user'])
    const [u1, inj, u2, u3] = nodes as Extract<ConversationNode, { kind: 'user' | 'injection' }>[]
    assert.equal(u1.text, 'hello')
    assert.ok(inj.text.includes('# Available Skills'))
    assert.equal(u2.text, 'second thought')
    assert.equal(u3.text, 'block form')
})

test('fold：tool 卡按 id 配对、纯工具轮 assistant 不出气泡、孤儿结果独立成行', () => {
    const nodes = assemble([
        { type: 'turn/start' },
        { type: 'assistant/message', content: [{ type: 'tool_use', id: 't1', name: 'write_file', input: {} }], usage: { input: 10, output: 5, cacheRead: 0, cacheCreation: 0 } },
        { type: 'tool/call', id: 't1', name: 'write_file', input: { file_path: 'a.txt' } },
        { type: 'tool/result', callId: 't1', content: 'ok' },
        { type: 'turn/end', reason: 'tool_use' },
        { type: 'tool/result', callId: 'ghost', content: 'Tool call not executed', isError: true },
    ])
    const card = nodes.find((n) => n.kind === 'tool') as Extract<ConversationNode, { kind: 'tool' }>
    assert.equal(card.name, 'write_file')
    assert.deepEqual(card.input, { file_path: 'a.txt' })
    assert.deepEqual(card.result, { content: 'ok', isError: false })
    // 纯工具轮：assistant/message 只有 tool_use 块 → 不出气泡（卡片讲完了故事）
    assert.ok(!nodes.some((n) => n.kind === 'assistant'))
    const orphan = nodes.find((n) => n.kind === 'orphan-result') as Extract<ConversationNode, { kind: 'orphan-result' }>
    assert.equal(orphan.callId, 'ghost')
    assert.equal(orphan.isError, true)
    // turn/end 回填到最近的 turn 节点
    const turn = nodes.find((n) => n.kind === 'turn') as Extract<ConversationNode, { kind: 'turn' }>
    assert.equal(turn.endReason, 'tool_use')
})

test('fold：assistant 文本带 usage、prompt-error 成 error 节点、投影事件不渲染', () => {
    const nodes = assemble([
        { type: 'system/message', content: '[]' },
        { type: 'message/replace', target: 0, content: 'rewritten' },
        { type: 'history/truncate', reason: 'compact' },
        { type: 'meta/note', key: 'mode', value: 'plan' },
        { type: 'meta/note', key: 'prompt-error', value: 'boom 500' },
        { type: 'turn/start' },
        { type: 'assistant/message', content: [{ type: 'text', text: 'hi there' }], usage: { input: 100, output: 20, cacheRead: 3, cacheCreation: 4 } },
    ])
    assert.deepEqual(nodes.map((n) => n.kind), ['error', 'turn', 'assistant'])
    const err = nodes[0] as Extract<ConversationNode, { kind: 'error' }>
    assert.equal(err.message, 'boom 500')
    const asst = nodes[2] as Extract<ConversationNode, { kind: 'assistant' }>
    assert.equal(asst.text, 'hi there')
    assert.equal(asst.usage?.input, 100)
})

// ── 2. store 忙闲界碑 ──────────────────────────────────────────────────────

test('store：accepted 挂起，turn/end / prompt-error / baseline 对账解除', () => {
    const store = webUiStore.create()
    const pending = () => store.getSnapshot().pendingPrompt

    store.actions.beginPrompt()
    assert.ok(pending())
    store.actions.appendEvent(0, { type: 'turn/start' })
    assert.ok(pending(), '非界碑事件不解挂')
    store.actions.appendEvent(1, { type: 'turn/end', reason: 'end_turn' })
    assert.ok(!pending())

    store.actions.beginPrompt()
    store.actions.appendEvent(2, { type: 'meta/note', key: 'prompt-error', value: 'boom' })
    assert.ok(!pending())
    assert.equal(store.getSnapshot().lastError, 'boom')

    // 重连对账：baseline 末事件已是界碑 → 解挂；turn 仍在跑 → 保持挂起
    store.actions.beginPrompt()
    store.actions.setBaseline([{ seq: 0, event: { type: 'turn/end', reason: 'end_turn' } }], 0)
    assert.ok(!pending())
    store.actions.beginPrompt()
    store.actions.setBaseline([{ seq: 0, event: { type: 'tool/call', id: 't', name: 'x', input: {} } }], 0)
    assert.ok(pending(), 'turn 未结算时重连不误解挂')
})

// ── 3. http 驱动真链（场景 9 同款） ─────────────────────────────────────────

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

    /** 额外观察者：connect 已收的帧回放 + 后续新帧喂给 fn。 */
    observe(fn: (frame: Frame) => void): void {
        for (const frame of this.frames) fn(frame)
        this.ws.on('message', (data: Buffer) => fn(JSON.parse(String(data))))
    }

    close(): void {
        this.ws.close()
    }
}

interface Boot {
    agent: Agent
    base: string
    client: WsClient
    /** baseline + live 按 seq 去重后的全量事件（流视角，与 fold 输入同形）。 */
    entries(): Array<{ seq: number; event: any }>
    waitTurnEnds(n: number): Promise<void>
    close(): Promise<void>
}

async function boot(turns: any[]): Promise<Boot> {
    const sandbox = mkdtempSync(join(tmpdir(), 'f4-conv-'))
    mkdirSync(join(sandbox, '.claude', 'skills', 'commit'), { recursive: true })
    writeFileSync(
        join(sandbox, '.claude', 'skills', 'commit', 'SKILL.md'),
        '---\nname: commit\ndescription: Create a conventional commit message\n---\nWrite a conventional commit message for: $ARGUMENTS\n',
    )
    // Agent 构造期/homedir() 动态读都在 new 之前设；SDK 重试关掉（prompt-error 用例要 fail-fast）
    process.env.HOME = sandbox
    process.env.USERPROFILE = sandbox
    process.env.ANTHROPIC_API_KEY = 'test'
    process.env.MINI_CLAUDE_SDK_MAX_RETRIES = '0'
    process.env.MINI_WEB_PORT = '0'

    const mock = await startMock({ scenario: { turns } })
    process.env.ANTHROPIC_BASE_URL = mock.url

    const agent = new Agent({ profile: 'web' })
    await agent.webHost!.ready
    const base = agent.webHost!.endpoint!.url
    const client = await WsClient.connect(base)

    const bySeq = new Map<number, any>()
    client.observe((frame) => {
        if (frame.type === 'baseline') for (const e of frame.events as Array<{ seq: number; event: any }>) bySeq.set(e.seq, e.event)
        else if (frame.type === 'event') bySeq.set(frame.seq as number, frame.event)
    })

    return {
        agent,
        base,
        client,
        entries: () => [...bySeq.entries()].sort((a, b) => a[0] - b[0]).map(([seq, event]) => ({ seq, event })),
        // 订阅式计数（不能 waitFor 循环——waitFor 每次从帧序头找，第 2 轮起
        // 永远命中同一帧旧 turn/end，微任务死循环把事件循环饿死）
        waitTurnEnds(n: number, timeoutMs = 15000): Promise<void> {
            const count = (): number => client.frames.filter((f) => f.type === 'event' && f.event?.type === 'turn/end').length
            if (count() >= n) return Promise.resolve()
            return new Promise((resolve, reject) => {
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
        },
        async close(): Promise<void> {
            client.close()
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

const SCENARIO9_TURNS = [
    { tools: [{ name: 'skill', input: { skill_name: 'commit', args: 'fix the login bug' } }] },
    { tools: [{ name: 'skill', input: { skill_name: 'nosuch', args: '' } }] },
    { text: 'Done.' },
]

test('http 驱动场景 9：catalog 注入、skill 激活卡、Unknown skill 报错卡', async () => {
    const boot1 = await boot(SCENARIO9_TURNS)
    try {
        const p = await prompt(boot1.base, 'Invoke the commit skill with args: fix the login bug. Then invoke the nosuch skill.')
        assert.equal(p.ok, true)
        assert.equal(p.value.accepted, true)
        await boot1.waitTurnEnds(3)

        const nodes = assembleConversation(boot1.entries())
        const byKind = (k: ConversationNode['kind']) => nodes.filter((n) => n.kind === k)

        // 目录注入：首条 user 消息里的 <system-reminder> 拆成 injection 节点
        // （两条：环境 reminder（CLAUDE.md/日期）+ D1 技能目录）
        const inj = byKind('injection') as Extract<ConversationNode, { kind: 'injection' }>[]
        assert.equal(inj.length, 2)
        const catalog = inj.find((n) => n.text.includes('# Available Skills'))
        assert.ok(catalog, 'catalog reminder should be assembled')
        assert.ok(catalog.text.includes('- **/commit**: Create a conventional commit message'))

        // user 气泡不吞 reminder 也不含 tool_result 宿主消息
        const users = byKind('user') as Extract<ConversationNode, { kind: 'user' }>[]
        assert.equal(users.length, 1)
        assert.ok(users[0].text.startsWith('Invoke the commit skill'))

        // skill 激活卡：模板正文进 result，$ARGUMENTS 已替换
        const cards = byKind('tool') as Extract<ConversationNode, { kind: 'tool' }>[]
        assert.equal(cards.length, 2)
        assert.equal(cards[0].name, 'skill')
        assert.deepEqual(cards[0].input, { skill_name: 'commit', args: 'fix the login bug' })
        assert.equal(cards[0].result?.isError, false)
        assert.ok(cards[0].result!.content.includes('[Skill "commit" activated]'))
        assert.ok(cards[0].result!.content.includes('for: fix the login bug'))
        assert.ok(!cards[0].result!.content.includes('$ARGUMENTS'))

        // Unknown skill 报错卡（引擎语义：未知技能是正常 tool_result——模型读到
        // 自行纠正，不是 throw，故 isError=false；与 mock 场景 9 断言同口径）
        assert.deepEqual(cards[1].input, { skill_name: 'nosuch', args: '' })
        assert.equal(cards[1].result?.isError, false)
        assert.ok(cards[1].result!.content.includes('Unknown skill: nosuch'))

        // 收尾气泡与 turn 结构（tool_use × 2 + end_turn）
        const dones = byKind('assistant') as Extract<ConversationNode, { kind: 'assistant' }>[]
        assert.equal(dones.length, 1)
        assert.equal(dones[0].text, 'Done.')
        const turns = byKind('turn') as Extract<ConversationNode, { kind: 'turn' }>[]
        assert.deepEqual(turns.map((t) => t.endReason), ['tool-use', 'tool-use', 'end-turn'])
        assert.ok(!nodes.some((n) => n.kind === 'orphan-result' || n.kind === 'error'))
    } finally {
        await boot1.close()
    }
})

test('busy 竞态：turn 进行中第二 prompt 被信封拒绝', async () => {
    const boot1 = await boot([{ delayMs: 500, text: 'slow one' }, { text: 'second' }])
    try {
        const first = await prompt(boot1.base, 'start the slow turn')
        assert.equal(first.ok, true)
        const second = await prompt(boot1.base, 'too eager')
        assert.equal(second.ok, false)
        assert.ok(second.error!.includes('busy'))

        await boot1.waitTurnEnds(1)
        const nodes = assembleConversation(boot1.entries())
        const texts = nodes.filter((n): n is Extract<ConversationNode, { kind: 'assistant' }> => n.kind === 'assistant').map((n) => n.text)
        assert.deepEqual(texts, ['slow one'], '被拒的 prompt 不应产生第二个 turn')
    } finally {
        await boot1.close()
    }
})

test('prompt-error 界碑：turn 起不来时无 turn/end，error 节点兜底', async () => {
    const boot1 = await boot([{ failWith: { status: 500 } }, { text: 'never reached' }])
    try {
        const p = await prompt(boot1.base, 'break it')
        assert.equal(p.ok, true)

        // 等 meta/note prompt-error 落日志（busy 的第二个解除界碑）
        for (let i = 0; i < 400; i++) {
            const events = boot1.entries()
            if (events.length > 0 && events[events.length - 1].event.type === 'meta/note'
                && events[events.length - 1].event.key === 'prompt-error') break
            await new Promise((resolve) => setTimeout(resolve, 5))
            if (i === 399) throw new Error('prompt-error never logged')
        }

        const entries = boot1.entries()
        assert.ok(!entries.some((e) => e.event.type === 'turn/end'), 'turn 没跑起来不该有 turn/end')
        const nodes = assembleConversation(entries)
        const err = nodes.find((n): n is Extract<ConversationNode, { kind: 'error' }> => n.kind === 'error')
        assert.ok(err, 'prompt-error 应装配成 error 节点')
        assert.ok(err.message.includes('500'))
    } finally {
        await boot1.close()
    }
})
