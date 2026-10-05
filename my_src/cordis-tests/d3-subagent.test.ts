// D3 单测：childModeOf 防洗白映射、preset 排除表（agent/schedule_wakeup 不外流）、
// 插件注册 agent 工具（真 execute）、enabled=false 不注册、registry 生命周期、
// 子 agent 工具隔离（子树注册表无 agent——插件不加载）。
// 全链路由场景 12/23/23b（agent 工具与 skill fork）背书。
// 运行：npm run cordis（tsc && node --test "dist/cordis-tests/*.test.js"）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '../cordis/context.js'
import { ToolsService } from '../services/tools.js'
import { AgentRegistry } from '../services/agents.js'
import {
  subagentPlugin, buildPresetFromType, buildPresetFromSkill,
  childModeOf, DEFAULT_EXCLUDES, type SubagentBridge,
} from '../plugins/subagent.js'
import { toolDefinitions } from '../tools.js'

const bridge: SubagentBridge = { parentMode: () => 'default', addTokens: () => {} }

test('childModeOf：plan/auto 穿透（防洗白），其余 bypass', () => {
  assert.equal(childModeOf('plan'), 'plan')
  assert.equal(childModeOf('auto'), 'auto')
  assert.equal(childModeOf('default'), 'bypassPermissions')
  assert.equal(childModeOf('acceptEdits'), 'bypassPermissions')
})

test('preset 排除表：general 剥 agent（广告字节等价的锚）；explore 只读', () => {
  const general = buildPresetFromType('general', 'plan')
  assert.equal(general.permissionMode, 'plan') // 防洗白穿透
  assert.equal(general.tools.some((t) => t.name === 'agent'), false)
  assert.deepEqual(general.excludes, [...DEFAULT_EXCLUDES])

  const oldGeneral = toolDefinitions.filter((t) => t.name !== 'agent')
  assert.deepEqual(general.tools, oldGeneral) // 与旧硬过滤逐项一致

  const explore = buildPresetFromType('explore', 'default')
  assert.deepEqual(explore.tools.map((t) => t.name).sort(), ['grep_search', 'list_files', 'read_file'])
  assert.equal(explore.permissionMode, 'bypassPermissions')
})

test('buildPresetFromSkill：白名单在父工具集上解析 + 排除表兜底', () => {
  const preset = buildPresetFromSkill({ allowedTools: ['read_file', 'agent', 'grep_search'] }, 'auto')
  assert.deepEqual(preset.tools.map((t) => t.name), ['read_file', 'grep_search'])
  assert.equal(preset.permissionMode, 'auto')
  const all = buildPresetFromSkill({}, 'default')
  assert.equal(all.tools.some((t) => t.name === 'agent'), false)
})

test('插件注册 agent 工具（真 execute）；enabled=false 不注册', () => {
  const ctx = new Context()
  new ToolsService(ctx, 'tools')
  new AgentRegistry(ctx, 'agents')
  ctx.plugin(subagentPlugin, { bridge })
  const def = ctx.require<ToolsService>('tools').get('agent')
  assert.ok(def && typeof def.execute === 'function')

  const childCtx = new Context()
  new ToolsService(childCtx, 'tools')
  new AgentRegistry(childCtx, 'agents')
  ctx.plugin
  childCtx.plugin(subagentPlugin, { bridge, enabled: false })
  assert.equal(childCtx.require<ToolsService>('tools').get('agent'), undefined)
})

test('registry：create 登记、disposeAll 清空；子 agent 树内无 agent 工具（隔离）', async () => {
  const ctx = new Context()
  new ToolsService(ctx, 'tools')
  const reg = new AgentRegistry(ctx, 'agents')
  const preset = buildPresetFromType('general', 'default')
  const child = reg.create({
    customSystemPrompt: preset.systemPrompt,
    customTools: preset.tools,
    isSubAgent: true,
    permissionMode: preset.permissionMode,
  })
  assert.equal(reg.get(child.id), child)
  assert.equal(reg.list().length, 1)

  // 隔离第一层：广告集（customTools）无 agent
  const advertised = (child as unknown as { tools: Array<{ name: string }> }).tools
  assert.equal(advertised.some((t) => t.name === 'agent'), false)
  // 隔离第二层：子树自己的注册表也没有（插件 enabled=false，不加载）
  const childCtx = (child as unknown as { cordis: Context }).cordis
  assert.equal(childCtx.require<ToolsService>('tools').get('agent'), undefined)

  await reg.disposeAll()
  assert.equal(reg.list().length, 0)
})
