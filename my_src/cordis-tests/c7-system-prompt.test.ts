// C7 单测：section 注册表、{{var}} 严格插值、assemble 两块结构、
// prompt-sections 插件的字节等价形状（静态块断点/动态块 trim/null 跳过）。
// Agent 全链路的 system 字段等价由 mock 场景背书（ch22 memory、ch23 子 agent
// system、ch26 分类器的 system 匹配全走新拼装路径）。
// 运行：npm run cordis（tsc && node --test "dist/cordis-tests/*.test.js"）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '../cordis/context.js'
import { SystemPromptService } from '../services/system-prompt.js'
import { promptSectionsPlugin } from '../plugins/prompt-sections.js'
import { buildStaticSystemPrompt } from '../prompt.js'

function makeService(): { ctx: Context; sp: SystemPromptService } {
  const ctx = new Context()
  const sp = new SystemPromptService(ctx, 'system-prompt')
  return { ctx, sp }
}

test('assemble：order 排序、null 跳过、静态块断点、动态块 trim 后空则不出现', () => {
  const { sp } = makeService()
  sp.registerSection({ id: 'b', order: 200, group: 'dynamic', render: () => '  second  ' })
  sp.registerSection({ id: 'a', order: 100, group: 'static', render: () => 'STATIC' })
  sp.registerSection({ id: 'c', order: 300, group: 'dynamic', render: () => null })
  const { system } = sp.assemble()
  assert.equal(system.length, 2)
  assert.deepEqual(system[0], { type: 'text', text: 'STATIC', cache_control: { type: 'ephemeral' } })
  assert.deepEqual(system[1], { type: 'text', text: 'second' })

  const { sp: sp2 } = makeService()
  sp2.registerSection({ id: 's', order: 1, group: 'static', render: () => 'S' })
  sp2.registerSection({ id: 'd', order: 2, group: 'dynamic', render: () => '   ' })
  assert.equal(sp2.assemble().system.length, 1) // 纯空白动态块不出现
})

test('{{var}} 严格插值：已知替换、未知抛错、同名变量冲突', () => {
  const { sp } = makeService()
  sp.registerVariable('name', () => 'mini')
  sp.registerSection({ id: 't', order: 1, group: 'static', render: () => 'hello {{name}}' })
  assert.equal(sp.assemble().system[0].text, 'hello mini')

  sp.registerSection({ id: 'bad', order: 2, group: 'dynamic', render: () => '{{typo_var}}' })
  assert.throws(() => sp.assemble(), /unknown prompt variable/)
  assert.throws(() => sp.registerVariable('name', () => 'x'), /already registered/)
})

test('section 同 id 冲突；disposer 摘除', () => {
  const { sp } = makeService()
  sp.registerSection({ id: 'x', order: 1, group: 'static', render: () => '1' })
  assert.throws(() => sp.registerSection({ id: 'x', order: 2, group: 'static', render: () => '2' }), /already registered/)
  const dispose = sp.registerSection({ id: 'y', order: 2, group: 'static', render: () => '2' })
  dispose()
  assert.equal(sp.assemble().system[0].text, '1')
})

test('prompt-sections 插件：默认配置的字节等价形状', () => {
  const { ctx, sp } = makeService()
  ctx.plugin(promptSectionsPlugin)
  const { system } = sp.assemble()
  assert.equal(system.length, 2)
  // 静态主体与旧 buildStaticSystemPrompt 完全一致，断点在静态块尾
  assert.equal(system[0].text, buildStaticSystemPrompt())
  assert.deepEqual((system[0] as any).cache_control, { type: 'ephemeral' })
  assert.equal((system[1] as any).cache_control, undefined)
  // 动态块以 env 节开头（order 最小），{{cwd}} 已插值
  const dyn = system[1].text
  assert.ok(dyn.startsWith('# Environment\nWorking directory: '), dyn.slice(0, 60))
  assert.ok(dyn.includes(`Platform: ${process.platform}`))
})

test('prompt-sections 插件：dynamicEnabled=false 只剩静态块；自定义 staticPrompt 生效', () => {
  const { ctx, sp } = makeService()
  ctx.plugin(promptSectionsPlugin, { staticPrompt: 'CUSTOM', dynamicEnabled: false })
  const { system } = sp.assemble()
  assert.equal(system.length, 1)
  assert.equal(system[0].text, 'CUSTOM')
  assert.deepEqual((system[0] as any).cache_control, { type: 'ephemeral' })
})
