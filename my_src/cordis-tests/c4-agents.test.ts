// C4 单测：inbox 双队列与 claim 语义、AgentRegistry、handle 面的免 API 部分。
// driver 的行为验收（mid-turn 注入 / cancel / followup 自动续 turn）在
// run-mock 场景 27——它需要 mock API 与 delayMs 探针，走场景驱动而非 node:test。
// 运行：npm run cordis（tsc && node --test "dist/cordis-tests/*.test.js"）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '../cordis/context.js'
import { Inbox, AgentRegistry, type AgentHandle } from '../services/agents.js'

test('Inbox：claimTurn = 全部 next-step + 恰一条 next-turn（steer 在前）', () => {
  const ib = new Inbox()
  ib.append('next-turn', 'turn-one')
  ib.append('next-step', 'steer-a')
  ib.append('next-turn', 'turn-two')
  ib.append('next-step', 'steer-b')
  assert.deepEqual(ib.claimTurn(), ['steer-a', 'steer-b', 'turn-one'])
  // 恰一条：第二条 followup 留给下一个 turn
  assert.deepEqual(ib.claimTurn(), ['turn-two'])
  assert.equal(ib.hasPending, false)
})

test('Inbox：claimStep 只取 next-step，next-turn 不动', () => {
  const ib = new Inbox()
  ib.append('next-turn', 'queued-turn')
  ib.append('next-step', 'steer-a')
  ib.append('next-step', 'steer-b')
  assert.deepEqual(ib.claimStep(), ['steer-a', 'steer-b'])
  assert.deepEqual(ib.claimStep(), [])
  assert.equal(ib.hasPending, true) // next-turn 仍在
  assert.deepEqual(ib.claimTurn(), ['queued-turn'])
})

test('Inbox：clear 先清 next-step 再清 next-turn；空态 hasPending', () => {
  const ib = new Inbox()
  assert.equal(ib.hasPending, false)
  ib.append('next-step', 's')
  ib.append('next-turn', 't')
  ib.clear()
  assert.equal(ib.hasPending, false)
  assert.deepEqual(ib.claimTurn(), [])
  assert.deepEqual(ib.claimStep(), [])
})

test('Agent 出厂即 handle：idle 状态、空 inbox、whenIdle 立即 resolve', async () => {
  // 注意：此处不发起任何 API 请求——只验证 handle 面的静态部分
  const { Agent } = await import('../agent.js')
  const a = new Agent({ customSystemPrompt: 'test-only' })
  assert.equal(a.status, 'idle')
  assert.equal(a.busy, false)
  assert.equal(a.inbox.hasPending, false)
  assert.ok(typeof a.id === 'string' && a.id.length > 0)
  await a.whenIdle() // idle 时立即 resolve（不挂起）
})

test('AgentRegistry：create/get/list，id 为注册键', async () => {
  const { Agent } = await import('../agent.js')
  const ctx = new Context()
  const reg = new AgentRegistry(ctx, 'agents')
  const a1: AgentHandle = reg.create({ customSystemPrompt: 'one' })
  const a2: AgentHandle = reg.create({ customSystemPrompt: 'two' })
  assert.equal(reg.get(a1.id), a1)
  assert.equal(reg.get('nope'), undefined)
  assert.deepEqual(reg.list(), [a1, a2])
  assert.ok(Agent !== undefined)
})
