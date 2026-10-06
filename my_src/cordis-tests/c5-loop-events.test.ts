// C5 单测：TurnConclusion 经 executeCall 的透传、agent 域 Events 的注册与派发。
// 循环行为验收（pre-step 改写/拒绝、turn-stopping 挽留、conclusion 全链路）在
// run-mock 场景 28 与既有 plan 场景（10/25 的 clear-and-execute 路径）。
// 运行：npm run cordis（tsc && node --test "dist/cordis-tests/*.test.js"）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '../cordis/context.js'
import { ToolsService, type TurnConclusion } from '../services/tools.js'

test('executeCall：dispatch 返回 TurnConclusion → 结论原样上浮，output 即注入文本', async () => {
  const ctx = new Context()
  const tools = new ToolsService(ctx, 'tools')
  const conclusion: TurnConclusion = {
    concludeTurn: true,
    dropBatch: true,
    nextTurnInput: 'User approved the plan. Context was cleared.',
  }
  const outcome = await tools.executeCall(
    { name: 'exit_plan_mode', input: {}, mode: 'default' },
    { dispatch: async () => conclusion },
  )
  assert.deepEqual(outcome, { kind: 'result', output: conclusion.nextTurnInput, conclusion })
})

test('executeCall：dispatch 返回 string → 行为不变（无 conclusion 字段）', async () => {
  const ctx = new Context()
  const tools = new ToolsService(ctx, 'tools')
  const outcome = await tools.executeCall(
    { name: 'echo', input: {}, mode: 'default' },
    { dispatch: async () => 'plain output' },
  )
  assert.deepEqual(outcome, { kind: 'result', output: 'plain output' })
})

test('agent 域 Events：pre-step waterfall 改写 / turn-stopping steer / turn-end emit', async () => {
  const ctx = new Context()
  const seen: string[] = []
  ctx.on('agent/turn-end', (e) => seen.push(e.reason))
  // next() 是 0 参委托（B4 语义）：调它取 inner 默认，自己的裁决用返回值表达
  ctx.on('agent/pre-step', (payload, next) => {
    next()
    return { input: payload.input.map((t) => `R:${t}`) }
  })
  const decision = await ctx.waterfall('agent/pre-step', { input: ['a'], historyEmpty: false, boundary: 'step' }, () => ({ input: ['a'] }))
  assert.deepEqual(decision, { input: ['R:a'] })

  let captured = ''
  ctx.on('agent/turn-stopping', (state) => { state.steer('KEEP') })
  await ctx.serial('agent/turn-stopping', {
    steer: (t: string) => { captured = t },
    block: () => { captured = 'BLOCKED' },
  })
  assert.equal(captured, 'KEEP')

  ctx.emit('agent/turn-end', { reason: 'blocked' })
  assert.deepEqual(seen, ['blocked'])
})
