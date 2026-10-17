// F5 单测：交互跨端。三层验证面：
//   1. store 单元：待决审批卡的挂/摘与新代 baseline 重置、叙事面有界囤积
//   2. http 驱动真链：审批瀑布 allow/deny 双闭环（deny 话术 = 引擎侧统一产物，
//      与终端逐字节同款）、fail-closed 三连（无客户端/超时/断线）、迟到作答、
//      重连重宣告、commands.list + /cost /plan 分发、未知斜杠不认领
//   3. plan 四选项：keep-planning 反馈回灌 + clear-and-execute 清史重执行
// 危险点验证：C2 瀑布语义不在传输层翻案——作答只经 decide RPC 回到
// ApprovalService 的 interactive provider，九段流水线照旧（deny 文案出自
// tools 服务，不经 Host 之手）。
// 运行：npm run cordis
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import WebSocket from 'ws'
import { Agent } from '../agent.js'
import { webUiStore } from '../webui/app-state.js'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const { startMock } = await import(
    new URL('../../mock-anthropic.mjs', import.meta.url).href
) as any

// ── 1. store 单元 ────────────────────────────────────────────────────────────

test('store：审批卡挂/摘、异 id 不误摘、baseline 新代清空瞬态', () => {
    const store = webUiStore.create()
    const request = { id: 'a1', kind: 'tool' as const, tool: 'write_file', input: {}, message: 'write new file: x' }

    store.actions.announceApproval(request)
    assert.deepEqual(store.getSnapshot().pendingApproval, request)
    store.actions.resolveApproval('other')
    assert.ok(store.getSnapshot().pendingApproval, '异 id 不摘卡')
    store.actions.resolveApproval('a1')
    assert.equal(store.getSnapshot().pendingApproval, null)

    store.actions.announceApproval(request)
    store.actions.pushNarrative('info', 'hello')
    // 新代 baseline：瞬态（卡/旁白）清空——服务端 baseline 后重宣告仍 pending 的卡
    store.actions.setBaseline([{ seq: 0, event: { type: 'turn/end' } }], 0)
    assert.equal(store.getSnapshot().pendingApproval, null)
    assert.equal(store.getSnapshot().narrative.length, 0)
})

test('store：叙事面有界囤积（100 条封顶，序号单调）', () => {
    const store = webUiStore.create()
    for (let i = 0; i < 105; i++) store.actions.pushNarrative('info', `line ${i}`)
    const lines = store.getSnapshot().narrative
    assert.equal(lines.length, 100)
    assert.equal(lines[0].text, 'line 5')
    assert.equal(lines[99].text, 'line 104')
    assert.ok(lines.every((l, i) => i === 0 || l.id > lines[i - 1].id))
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
    /** 拉取版读日志（无流客户端也可用）。 */
    events(): Promise<Array<{ seq: number; event: any }>>
    rpc(method: string, input?: any): Promise<{ ok: boolean; value: any; error?: string }>
    waitTurnEnds(n: number, timeoutMs?: number): Promise<void>
    close(): Promise<void>
}

async function boot(
    turns: any[] | ((sandbox: string) => any[]),
    opts: { connectClient?: boolean; timeoutMs?: string } = {},
): Promise<Boot> {
    const sandbox = mkdtempSync(join(tmpdir(), 'f5-approval-'))
    mkdirSync(join(sandbox, '.claude', 'skills', 'commit'), { recursive: true })
    writeFileSync(
        join(sandbox, '.claude', 'skills', 'commit', 'SKILL.md'),
        '---\nname: commit\ndescription: Create a conventional commit message\n---\nWrite a conventional commit message for: $ARGUMENTS\n',
    )
    process.env.HOME = sandbox
    process.env.USERPROFILE = sandbox
    process.env.ANTHROPIC_API_KEY = 'test'
    process.env.MINI_CLAUDE_SDK_MAX_RETRIES = '0'
    process.env.MINI_WEB_PORT = '0'
    if (opts.timeoutMs !== undefined) process.env.MINI_WEB_APPROVAL_TIMEOUT_MS = opts.timeoutMs

    const mock = await startMock({ scenario: { turns: typeof turns === 'function' ? turns(sandbox) : turns } })
    process.env.ANTHROPIC_BASE_URL = mock.url

    const agent = new Agent({ profile: 'web' })
    // cli --web 分支的镜像接线：plan 审批的远程 answerer（工具审批由 Host
    // 插件在构造期自注册 interactive provider，无需宿主接线）
    agent.setPlanApprovalFn((planContent) => agent.webHost!.requestPlanApproval(planContent))
    await agent.webHost!.ready
    const base = agent.webHost!.endpoint!.url
    const client = opts.connectClient === false ? (null as unknown as WsClient) : await WsClient.connect(base)

    return {
        agent,
        base,
        sandbox,
        client,
        events: async () => {
            const res = await fetch(`${base}/api/session.events?since=-1`)
            const body = await res.json()
            return body.value.events
        },
        rpc: async (method, input) => {
            const res = await fetch(`${base}/api/${method}`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(input ?? {}),
            })
            const body = await res.json()
            return { ok: body.ok, value: body.value, error: body.error }
        },
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
            client?.close()
            await agent.close()
            await mock.close()
            for (const key of ['HOME', 'USERPROFILE', 'ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL', 'MINI_CLAUDE_SDK_MAX_RETRIES', 'MINI_WEB_PORT', 'MINI_WEB_APPROVAL_TIMEOUT_MS']) {
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

const WRITE_TURNS = (filePath: string) => [
    { tools: [{ name: 'write_file', input: { file_path: filePath, content: 'from web approval' } }] },
    { text: 'written.' },
]

test('审批瀑布 allow 闭环：decide allow-once → 工具执行', async () => {
    const boot1 = await boot((sandbox) => WRITE_TURNS(join(sandbox, 'fresh.txt')))
    try {
        const p = await prompt(boot1.base, 'write the file please')
        assert.equal(p.ok, true)

        const approval = await boot1.client.waitFor((f) => f.type === 'approval')
        assert.equal(approval.request.kind, 'tool')
        assert.equal(approval.request.tool, 'write_file')
        assert.ok(approval.request.message.includes('write new file'))
        assert.equal(approval.request.input.file_path, join(boot1.sandbox, 'fresh.txt'))

        const decided = await boot1.rpc('approval.decide', { id: approval.request.id, verdict: 'allow-once' })
        assert.equal(decided.ok, true)

        const resolved = await boot1.client.waitFor((f) => f.type === 'approval-resolved')
        assert.equal(resolved.id, approval.request.id)
        assert.equal(resolved.by, 'browser')

        await boot1.waitTurnEnds(2)
        const events = await boot1.events()
        const notes = events.filter((e) => e.event.type === 'meta/note' && e.event.key === 'approval')
        assert.equal(notes.length, 1)
        assert.equal(notes[0].event.value.verdict, 'allow-once')
        assert.equal(notes[0].event.value.by, 'browser')
        const results = events.filter((e) => e.event.type === 'tool/result')
        assert.equal(results.length, 1)
        assert.notEqual(results[0].event.content, 'User denied this action.')
    } finally {
        await boot1.close()
    }
})

test('审批瀑布 deny 闭环：拒绝话术出自引擎（User denied this action.），传输层不改写', async () => {
    const boot1 = await boot((sandbox) => WRITE_TURNS(join(sandbox, 'refused.txt')))
    try {
        await prompt(boot1.base, 'write the file please')
        const approval = await boot1.client.waitFor((f) => f.type === 'approval')
        const decided = await boot1.rpc('approval.decide', { id: approval.request.id, verdict: 'deny' })
        assert.equal(decided.ok, true)

        await boot1.waitTurnEnds(2)
        const events = await boot1.events()
        const results = events.filter((e) => e.event.type === 'tool/result')
        assert.equal(results.length, 1)
        // 逐字节：这段文案由 tools 服务的 ask 分支统一产出——终端与 web 同源
        assert.equal(results[0].event.content, 'User denied this action.')
        const notes = events.filter((e) => e.event.type === 'meta/note' && e.event.key === 'approval')
        assert.equal(notes[0].event.value.verdict, 'deny')
        assert.equal(notes[0].event.value.by, 'browser')
    } finally {
        await boot1.close()
    }
})

test('fail-closed 无客户端：ask 即 deny，裁决事实仍落日志', async () => {
    const boot1 = await boot((sandbox) => WRITE_TURNS(join(sandbox, 'nobody.txt')), { connectClient: false })
    try {
        await prompt(boot1.base, 'write the file please')
        // 无流客户端可等——轮询拉取版日志直到 turn/end
        for (let i = 0; i < 400; i++) {
            const events = await boot1.events()
            if (events.some((e) => e.event.type === 'turn/end')) break
            await new Promise((resolve) => setTimeout(resolve, 5))
            if (i === 399) throw new Error('turn never ended')
        }
        const events = await boot1.events()
        const results = events.filter((e) => e.event.type === 'tool/result')
        assert.equal(results[0].event.content, 'User denied this action.')
        const notes = events.filter((e) => e.event.type === 'meta/note' && e.event.key === 'approval')
        assert.equal(notes[0].event.value.by, 'no-client')
        assert.equal(notes[0].event.value.verdict, 'deny')
    } finally {
        await boot1.close()
    }
})

test('fail-closed 超时：无人作答 80ms 后自动 deny，迟到作答被信封拒绝', async () => {
    const boot1 = await boot((sandbox) => WRITE_TURNS(join(sandbox, 'late.txt')), { timeoutMs: '80' })
    try {
        await prompt(boot1.base, 'write the file please')
        const approval = await boot1.client.waitFor((f) => f.type === 'approval')
        const resolved = await boot1.client.waitFor((f) => f.type === 'approval-resolved')
        assert.equal(resolved.by, 'timeout')

        await boot1.waitTurnEnds(2)
        // 迟到的作答：pending 已摘除 → 信封 ok:false
        const late = await boot1.rpc('approval.decide', { id: approval.request.id, verdict: 'allow-once' })
        assert.equal(late.ok, false)
        assert.ok(late.error!.includes('no pending'))

        const events = await boot1.events()
        const results = events.filter((e) => e.event.type === 'tool/result')
        assert.equal(results[0].event.content, 'User denied this action.')
        const notes = events.filter((e) => e.event.type === 'meta/note' && e.event.key === 'approval')
        assert.equal(notes[0].event.value.by, 'timeout')
    } finally {
        await boot1.close()
    }
})

test('fail-closed 断线：最后一位浏览器离开，在途审批立刻 deny', async () => {
    const boot1 = await boot((sandbox) => WRITE_TURNS(join(sandbox, 'gone.txt')))
    try {
        await prompt(boot1.base, 'write the file please')
        await boot1.client.waitFor((f) => f.type === 'approval')
        boot1.client.close()
        for (let i = 0; i < 400; i++) {
            const events = await boot1.events()
            if (events.some((e) => e.event.type === 'meta/note' && e.event.key === 'approval')) break
            await new Promise((resolve) => setTimeout(resolve, 5))
            if (i === 399) throw new Error('approval never resolved on disconnect')
        }
        const events = await boot1.events()
        const notes = events.filter((e) => e.event.type === 'meta/note' && e.event.key === 'approval')
        assert.equal(notes[0].event.value.by, 'disconnect')
        const results = events.filter((e) => e.event.type === 'tool/result')
        assert.equal(results[0].event.content, 'User denied this action.')
    } finally {
        await boot1.close()
    }
})

test('重连重宣告：审批挂起期间新连接在 baseline 后收到 approval 帧，照样可作答', async () => {
    const boot1 = await boot((sandbox) => WRITE_TURNS(join(sandbox, 'latecomer.txt')))
    try {
        await prompt(boot1.base, 'write the file please')
        await boot1.client.waitFor((f) => f.type === 'approval')

        const latecomer = await WsClient.connect(boot1.base)
        try {
            const reannounced = await latecomer.waitFor((f) => f.type === 'approval')
            assert.equal(reannounced.request.kind, 'tool')
            const decided = await boot1.rpc('approval.decide', { id: reannounced.request.id, verdict: 'allow-once' })
            assert.equal(decided.ok, true)
            const resolved = await latecomer.waitFor((f) => f.type === 'approval-resolved')
            assert.equal(resolved.by, 'browser')
            await boot1.waitTurnEnds(2)
        } finally {
            latecomer.close()
        }
    } finally {
        await boot1.close()
    }
})

test('commands.list：静态命令 + 可调用技能（kind 标记来源）', async () => {
    const boot1 = await boot([{ text: 'hi' }])
    try {
        const res = await fetch(`${boot1.base}/api/commands.list`)
        const body = await res.json()
        assert.equal(body.ok, true)
        const names = new Map((body.value.commands as Array<any>).map((c) => [c.name, c]))
        assert.equal(names.get('cost')?.kind, 'command')
        assert.equal(names.get('plan')?.kind, 'command')
        assert.equal(names.get('goal')?.kind, 'command')
        assert.equal(names.get('commit')?.kind, 'skill')
        assert.ok(names.get('commit')!.description.includes('conventional commit'))
    } finally {
        await boot1.close()
    }
})

test('commands.dispatch：/cost 出叙事帧（口径 = 引擎 usage 的 cost 帧 + 命令的 info 帧）', async () => {
    const boot1 = await boot([{ text: 'hi' }])
    try {
        // 先跑一个 turn：引擎每轮的 usage 旁白走 ui.cost → kind=cost 帧
        await prompt(boot1.base, 'say hi')
        await boot1.waitTurnEnds(1)
        const costFrame = await boot1.client.waitFor((f) => f.type === 'narrative' && f.kind === 'cost')
        assert.ok(costFrame.text.includes('Tokens:'))

        // /cost 命令本身走 ui.info（"Estimated cost: ..."）
        const cost = await boot1.rpc('commands.dispatch', { input: '/cost' })
        assert.equal(cost.ok, true)
        assert.equal(cost.value.handled, true)
        const summary = await boot1.client.waitFor((f) => f.type === 'narrative' && f.kind === 'info' && String(f.text).includes('Estimated cost:'))
        assert.ok(summary)
    } finally {
        await boot1.close()
    }
})

test('commands.dispatch：/plan 切模式（叙事 + 日志双证）', async () => {
    const boot1 = await boot([{ text: 'hi' }])
    try {
        const plan = await boot1.rpc('commands.dispatch', { input: '/plan' })
        assert.equal(plan.ok, true)
        assert.equal(plan.value.handled, true)
        const infoFrame = await boot1.client.waitFor((f) => f.type === 'narrative' && f.kind === 'info' && String(f.text).includes('Entered plan mode'))
        assert.ok(infoFrame)
        for (let i = 0; i < 400; i++) {
            const events = await boot1.events()
            if (events.some((e) => e.event.type === 'meta/note' && e.event.key === 'mode' && e.event.value === 'plan')) break
            await new Promise((resolve) => setTimeout(resolve, 5))
            if (i === 399) throw new Error('mode=plan never logged')
        }

        const back = await boot1.rpc('commands.dispatch', { input: '/plan' })
        assert.equal(back.value.handled, true)
        await boot1.client.waitFor((f) => f.type === 'narrative' && f.kind === 'info' && String(f.text).includes('Exited plan mode'))
    } finally {
        await boot1.close()
    }
})

test('commands.dispatch：未知斜杠不认领（handled:false，不启动 turn）', async () => {
    const boot1 = await boot([{ text: 'hi' }])
    try {
        const r = await boot1.rpc('commands.dispatch', { input: '/definitely-not-a-thing' })
        assert.equal(r.ok, true)
        assert.equal(r.value.handled, false)
        await new Promise((resolve) => setTimeout(resolve, 50))
        const events = await boot1.events()
        assert.ok(!events.some((e) => e.event.type === 'turn/start'), '未认领的斜杠不应在服务端启动 turn')
    } finally {
        await boot1.close()
    }
})

// ── 3. plan 四选项 ───────────────────────────────────────────────────────────

// mock 响应在同一引擎 turn 内连续消耗：r1 exit（keep-planning 打回）→ r2 再 exit
//（clear-and-execute 自结 turn + 注入重建输入）→ r3 纯文本（重建后的新 turn 收尾）。
// 两次审批都发生在同一个 turn 里——第二张卡不等 turn/end，决定权在作答人手里。
const PLAN_TURNS = [
    { tools: [{ name: 'exit_plan_mode', input: {} }] },
    { tools: [{ name: 'exit_plan_mode', input: {} }] },
    { text: 'executing now.' },
]

test('plan 四选项：keep-planning 反馈回灌（模式留在 plan），clear-and-execute 清史重执行', async () => {
    const boot1 = await boot(PLAN_TURNS)
    try {
        // 进 plan 模式走产品路径：/plan 命令（叙事面 + 日志双证）
        const toggle = await boot1.rpc('commands.dispatch', { input: '/plan' })
        assert.equal(toggle.value.handled, true)
        await boot1.client.waitFor((f) => f.type === 'narrative' && String(f.text).includes('Entered plan mode'))

        await prompt(boot1.base, 'plan the refactor')

        // 第 1 张卡：keep-planning + 反馈 → 打回重做（模式留在 plan）
        const card1 = await boot1.client.waitFor((f) => f.type === 'approval' && f.request.kind === 'plan')
        assert.ok(card1.request.planContent.includes('(No plan file found)'))
        const decided1 = await boot1.rpc('plan.decide', { id: card1.request.id, choice: 'keep-planning', feedback: 'Add a verification step.' })
        assert.equal(decided1.ok, true)
        const resolved1 = await boot1.client.waitFor((f) => f.type === 'approval-resolved' && f.id === card1.request.id)
        assert.equal(resolved1.by, 'browser')

        // keep-planning 的 tool_result 要在 clear 之前断言——clear-and-execute 是
        // C5 的物理清史（sessionLog.clear），第一轮的事实会从日志里消失
        for (let i = 0; i < 400; i++) {
            const events = await boot1.events()
            const fb = events.find((e) => e.event.type === 'tool/result')
            if (fb && String(fb.event.content).includes('User rejected the plan')) {
                assert.ok(String(fb.event.content).includes('User feedback: Add a verification step.'))
                const modes = events.filter((e) => e.event.type === 'meta/note' && e.event.key === 'mode').map((e) => e.event.value)
                assert.equal(modes[modes.length - 1], 'plan', 'keep-planning 后模式留在 plan')
                break
            }
            await new Promise((resolve) => setTimeout(resolve, 5))
            if (i === 399) throw new Error('keep-planning feedback never logged')
        }

        // 第 2 张卡（同一 turn 内的第二次 exit）：clear-and-execute → 清史 +
        // acceptEdits + turn 自结。谓词必须排除第 1 张卡——waitFor 从帧序头扫，
        // 不带排除条件会命中旧帧（F4 翻车 #1 的同款坑）
        const card2 = await boot1.client.waitFor((f) => f.type === 'approval' && f.request.kind === 'plan' && f.request.id !== card1.request.id)
        const decided2 = await boot1.rpc('plan.decide', { id: card2.request.id, choice: 'clear-and-execute' })
        assert.equal(decided2.ok, true)

        // 清史点是 seq 不连续点：Host 重开基线，客户端收到第二个 baseline 帧
        // （没有这个重置，清史后的事件全部 ≤ 旧 lastSent，直连客户端永久冻结）
        for (let i = 0; i < 400; i++) {
            if (boot1.client.frames.filter((f) => f.type === 'baseline').length >= 2) break
            await new Promise((resolve) => setTimeout(resolve, 5))
            if (i === 399) throw new Error('rebaseline after clear never sent')
        }
        const baselines = boot1.client.frames.filter((f) => f.type === 'baseline')
        assert.ok(baselines[1].lastSeq < baselines[0].lastSeq || baselines[0].lastSeq === -1,
            '清史后基线的 lastSeq 应从零域重启')

        // 重建 turn 执行完：拉取版日志（清史后的零域）有重建输入 + 新回复。
        // mode 注记不在此列——setMode 先于 clearHistoryKeepSystem 落笔，跟着
        // 一起被清（目标模式记载在重建输入文本里）
        for (let i = 0; i < 400; i++) {
            const events = await boot1.events()
            const assistant = events.filter((e) => e.event.type === 'assistant/message')
            if (assistant.length >= 1) {
                assert.ok(JSON.stringify(assistant[0].event.content).includes('executing now.'), 'clear-and-execute 后重建 turn 照常执行')
                const rebuilt = events.find((e) => e.event.type === 'user/message')
                assert.ok(rebuilt, '重建输入应作为零域首条 user 消息')
                assert.ok(JSON.stringify(rebuilt.event.content).includes('Permission mode: acceptEdits'))
                break
            }
            await new Promise((resolve) => setTimeout(resolve, 5))
            if (i === 399) throw new Error('rebuilt turn never completed')
        }
    } finally {
        await boot1.close()
    }
})
