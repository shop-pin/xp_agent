// C5 第二段单测：goal 插件的 turn-stopping 决策表。
// 桥（evaluate/getBudget）注入脚本化桩——不需要 API；全链路（真实评估器 +
// 请求序列）由场景 15（三态）与场景 29（blocked 注记断言）背书。
// 运行：npm run cordis（tsc && node --test "dist/cordis-tests/*.test.js"）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '../cordis/context.js'
import { goalPlugin, GoalService, type GoalBridge } from '../plugins/autonomy.js'
import type { GoalVerdict } from '../autonomy.js'

function rig(verdicts: GoalVerdict[], budget = { exceeded: false, reason: '' }) {
  const ctx = new Context()
  let i = 0
  const steered: string[] = []
  const blocks: (string | undefined)[] = []
  const bridge: GoalBridge = {
    evaluate: async () => verdicts[Math.min(i++, verdicts.length - 1)],
    getBudget: () => budget,
  }
  ctx.plugin(goalPlugin, bridge)
  const goal = ctx.get<GoalService>('goal')!
  const fire = () => ctx.serial('agent/turn-stopping', {
    steer: (t: string) => steered.push(t),
    block: (r?: string) => blocks.push(r),
  })
  return { ctx, goal, fire, steered, blocks }
}

const NOT_MET: GoalVerdict = { ok: false, impossible: false, reason: 'not yet' }

test('未达 → steer 回灌 reason 续命；iterations 累计', async () => {
  const r = rig([NOT_MET])
  r.goal.set('done.txt exists')
  await r.fire()
  assert.equal(r.steered.length, 1)
  assert.match(r.steered[0], /Hooks: Prompt hook condition was not met: not yet\n\nKeep working toward the goal\./)
  assert.equal(r.blocks.length, 0)
  assert.equal(r.goal.active?.iterations, 1)
  assert.equal(r.goal.active?.lastReason, 'not yet')
})

test('met → 清状态、不 steer、不 block', async () => {
  const r = rig([{ ok: true, reason: 'file exists' }])
  r.goal.set('done.txt exists')
  await r.fire()
  assert.equal(r.goal.active, null)
  assert.equal(r.steered.length, 0)
  assert.equal(r.blocks.length, 0)
})

test('impossible → block + 清状态（turn 以 blocked 收敛的唯一来源）', async () => {
  const r = rig([{ ok: false, impossible: true, reason: 'cannot ever' }])
  r.goal.set('the moon is cheese')
  await r.fire()
  assert.equal(r.goal.active, null)
  assert.equal(r.blocks.length, 1)
  assert.equal(r.steered.length, 0)
})

test('预算超限 → 停止追求：不 steer 不 block，状态清空', async () => {
  const r = rig([NOT_MET], { exceeded: true, reason: 'turn limit reached (1)' })
  r.goal.set('anything')
  await r.fire()
  assert.equal(r.goal.active, null)
  assert.equal(r.steered.length, 0)
  assert.equal(r.blocks.length, 0)
})

test('stop 标志（SIGINT）→ 监听器不再续命；无 goal 时 no-op', async () => {
  const r = rig([NOT_MET])
  r.goal.set('x')
  r.goal.stop()
  await r.fire()
  assert.equal(r.steered.length, 0)
  assert.equal(r.goal.active?.condition, 'x') // stop 不清状态：pursueGoal 的 finally 才清
  // 无 goal：fire 是 no-op
  r.goal.clear()
  await r.fire()
  assert.equal(r.steered.length, 0)
})
