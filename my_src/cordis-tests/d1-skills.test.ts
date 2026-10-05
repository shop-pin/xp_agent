// D1 单测：skill provider registry 的 rank 竞争与回退、目录注入监听器的
// 改写规则（historyEmpty 才注、无 skills 原样过、追加在末项）。
// 全链路（catalog 进 user message、fork/inline）由场景 9/23b 背书。
// 运行：npm run cordis（tsc && node --test "dist/cordis-tests/*.test.js"）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '../cordis/context.js'
import { skillsPlugin, SkillRegistry } from '../plugins/skills-registry.js'
import { buildSkillDescriptions, type SkillDefinition } from '../skills.js'

function fake(name: string, description: string, overrides: Partial<SkillDefinition> = {}): SkillDefinition {
  return {
    name, description,
    userInvocable: true,
    context: 'inline',
    promptTemplate: `run ${name}`,
    source: 'project',
    skillDir: '/fake',
    ...overrides,
  }
}

test('rank 竞争：同名高 rank 胜；disposer 摘除高层后回退到低层', () => {
  const ctx = new Context()
  const reg = new SkillRegistry(ctx, 'skills')
  reg.registerProvider({ source: 'user', rank: 10, list: () => [fake('deploy', 'user version')] })
  const offProject = reg.registerProvider({ source: 'project', rank: 20, list: () => [fake('deploy', 'project version')] })
  assert.equal(reg.getByName('deploy')?.description, 'project version')
  offProject()
  assert.equal(reg.getByName('deploy')?.description, 'user version')
})

test('同 source 二次注册抛错；不同名不竞争', () => {
  const reg = new SkillRegistry(new Context(), 'skills')
  reg.registerProvider({ source: 'a', rank: 1, list: () => [fake('x', 'ax')] })
  assert.throws(() => reg.registerProvider({ source: 'a', rank: 2, list: () => [] }), /already registered/)
  reg.registerProvider({ source: 'b', rank: 2, list: () => [fake('y', 'by')] })
  assert.deepEqual(reg.list().map((s) => s.name).sort(), ['x', 'y'])
})

test('目录注入（真实 provider）：catalog 追加在末项、reminder 包裹、非首批不注；无 skills 原样过', async () => {
  const empty = new Context()
  empty.plugin(skillsPlugin)
  const passthrough = await empty.waterfall('agent/pre-step', { input: ['hello'], historyEmpty: true }, () => ({ input: ['hello'] }))
  assert.deepEqual((passthrough as { input: string[] }).input, ['hello'])

  const ctx = new Context()
  ctx.plugin(skillsPlugin)
  ctx.get<SkillRegistry>('skills')!.registerProvider({
    source: 'test', rank: 99, list: () => [fake('commit', 'Create commits')],
  })
  const fire = (input: string[], historyEmpty: boolean) =>
    ctx.waterfall('agent/pre-step', { input, historyEmpty }, () => ({ input }))

  const first = (await fire(['do work'], true)) as { input: string[] }
  assert.equal(first.input.length, 1)
  assert.ok(first.input[0].startsWith('do work\n\n<system-reminder>\n# Available Skills'), first.input[0].slice(0, 60))
  assert.ok(first.input[0].includes('- **/commit**: Create commits'))
  assert.ok(first.input[0].endsWith('</system-reminder>'))

  const later = (await fire(['steer text'], false)) as { input: string[] }
  assert.deepEqual(later.input, ['steer text'])

  const batch = (await fire(['a', 'b'], true)) as { input: string[] }
  assert.equal(batch.input[0], 'a')
  assert.ok(batch.input[1].startsWith('b\n\n<system-reminder>'))
})

test('catalogInjection=false（子 agent）：监听器不改写', async () => {
  const ctx = new Context()
  ctx.plugin(skillsPlugin, { catalogInjection: false })
  const decision = await ctx.waterfall('agent/pre-step', { input: ['sub task'], historyEmpty: true }, () => ({ input: ['sub task'] }))
  assert.deepEqual((decision as { input: string[] }).input, ['sub task'])
})

test('buildSkillDescriptions 收参数化列表（D1 起不再自扫）', () => {
  const text = buildSkillDescriptions([fake('a', 'desc a'), fake('b', 'desc b', { userInvocable: false })])
  assert.ok(text.includes('- **/a**: desc a'))
  assert.ok(text.includes('- **b**: desc b'))
  assert.equal(buildSkillDescriptions([]), '')
})
