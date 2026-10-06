// D4 单测：inject() 的排队语义（next-step、不唤醒、可 claim）、memory 插件的
// turn 边界触发与落定注入（沙箱 HOME + 假 llm 适配器）。
// 注入位置与入日志的全链路由场景 8 背书（tool 批次 text 块、<system-reminder>）。
// 运行：npm run cordis（tsc && node --test "dist/cordis-tests/*.test.js"）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createHash } from 'crypto'
import { Context } from '../cordis/context.js'
import { LlmRuntime, type LlmAdapter } from '../services/llm.js'
import { memoryPlugin } from '../plugins/memory.js'
import { Agent } from '../agent.js'

test('inject：排 next-step、不唤醒驱动、claimStep 可取走', async () => {
  const a = new Agent({ customSystemPrompt: 'test-only' })
  assert.equal(a.status, 'idle')
  a.inject('CTX-MARKER')
  // 不唤醒：状态仍 idle（对比 steer 的 idle 唤醒语义）
  assert.equal(a.status, 'idle')
  await a.whenIdle() // 立即 resolve（没有驱动被拉起）
  // 排进了 next-step 队列
  assert.deepEqual(a.inbox.claimStep(), ['CTX-MARKER'])
  assert.equal(a.inbox.hasPending, false)
})

test('memory 插件：turn 边界触发 selector，落定经 bridge.inject 注入', async () => {
  const home = mkdtempSync(join(tmpdir(), 'd4-home-'))
  const prevHome = process.env.HOME
  const prevProfile = process.env.USERPROFILE
  process.env.HOME = home
  process.env.USERPROFILE = home

  const hash = createHash('sha256').update(process.cwd()).digest('hex').slice(0, 16)
  const memDir = join(home, '.mini-claude', 'projects', hash, 'memory')
  mkdirSync(memDir, { recursive: true })
  writeFileSync(join(memDir, 'deploy_target.md'),
    '---\nname: Deploy target\ndescription: Where to deploy\ntype: project\n---\nDeploy to staging.example.com.\n')

  try {
    const ctx = new Context()
    const llm = new LlmRuntime(ctx, 'llm')
    const fake: LlmAdapter = {
      async *stream() {
        yield { t: 'block-start', kind: 'text' } as const
        yield { t: 'text-delta', text: '{"selected_memories": ["deploy_target.md"]}' } as const
        yield { t: 'block-end' } as const
        yield { t: 'usage', usage: { input: 1, output: 1, cacheRead: 0, cacheCreation: 0 } } as const
        yield { t: 'finish', reason: 'end_turn' } as const
      },
    }
    llm.registerAdapter('anthropic', fake)

    const injected: string[] = []
    ctx.plugin(memoryPlugin, { bridge: { inject: (t: string) => injected.push(t) } })

    // step 边界不触发；turn 边界触发（waterfall 观察者语义）
    await ctx.waterfall('agent/pre-step', { input: ['a substantial step steer'], historyEmpty: false, boundary: 'step' }, () => ({ input: [] }))
    const p = new Promise<void>((resolve) => {
      const timer = setInterval(() => { if (injected.length > 0) { clearInterval(timer); resolve() } }, 10)
      setTimeout(() => { clearInterval(timer); resolve() }, 2000)
    })
    await ctx.waterfall('agent/pre-step', { input: ['where should we deploy it today'], historyEmpty: true, boundary: 'turn' }, () => ({ input: [] }))
    await p

    assert.equal(injected.length, 1)
    assert.ok(injected[0].includes('<system-reminder>'), injected[0])
    assert.ok(injected[0].includes('staging.example.com'), injected[0])
  } finally {
    process.env.HOME = prevHome
    process.env.USERPROFILE = prevProfile
  }
})

test('memory 插件：寒暄类输入三道门直接跳过（selector 零调用）', async () => {
  const home = mkdtempSync(join(tmpdir(), 'd4-home2-'))
  const prevHome = process.env.HOME
  const prevProfile = process.env.USERPROFILE
  process.env.HOME = home
  process.env.USERPROFILE = home
  try {
    const ctx = new Context()
    const llm = new LlmRuntime(ctx, 'llm')
    let calls = 0
    llm.registerAdapter('anthropic', {
      async *stream() { calls++; yield { t: 'finish', reason: 'end_turn' } as const },
    })
    const injected: string[] = []
    ctx.plugin(memoryPlugin, { bridge: { inject: (t: string) => injected.push(t) } })
    await ctx.waterfall('agent/pre-step', { input: ['hi'], historyEmpty: true, boundary: 'turn' }, () => ({ input: [] }))
    await new Promise((r) => setTimeout(r, 50))
    assert.equal(calls, 0)
    assert.equal(injected.length, 0)
  } finally {
    process.env.HOME = prevHome
    process.env.USERPROFILE = prevProfile
  }
})
