// C5 第二段单测：goal 插件的 turn-stopping 决策表。
// 桩挂在评估器的真实缝上（D6 起评估器住插件，sideCall 走 ctx.llm）——假适配器
// 回脚本化 verdict JSON，parseGoalVerdict 真解析；全链路（请求序列）由场景 15
// （三态）与场景 29（blocked 注记断言）背书。
// 运行：npm run cordis（tsc && node --test "dist/cordis-tests/*.test.js"）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '../cordis/context.js'
import { autonomyPlugin, GoalService, type AutonomyBridge } from '../plugins/autonomy.js'
import { LlmRuntime } from '../services/llm.js'
import { SessionLog } from '../services/session-log.js'
import { ToolsService } from '../services/tools.js'
import { UiService } from '../services/ui-service.js'
import type { GoalVerdict } from '../autonomy.js'

const ZERO_USAGE = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 }

function rig(verdicts: GoalVerdict[], budget = { exceeded: false, reason: '' }) {
  const ctx = new Context()
  let i = 0
  // agent 树的保底公民：评估器读投影、goal.set 落 meta/note 都要它；
  // autonomy 插件还要求 tools（schedule_wakeup 注册）与 ui（叙事面）
  new ToolsService(ctx, 'tools')
  new UiService(ctx, 'ui')
  new SessionLog(ctx, 'session-log')
  const llm = new LlmRuntime(ctx, 'llm')
  llm.registerAdapter('anthropic', {
    async *stream() {},
    async sideCall() {
      const v = verdicts[Math.min(i++, verdicts.length - 1)]
      return { text: JSON.stringify(v), usage: ZERO_USAGE }
    },
  })
  const steered: string[] = []
  const blocks: (string | undefined)[] = []
  const bridge: AutonomyBridge = {
    getBudget: () => budget,
    getMaxTurns: () => null,
    wake: async () => {},
  }
  ctx.plugin(autonomyPlugin, bridge)
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
