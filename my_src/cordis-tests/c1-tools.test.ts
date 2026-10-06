// C1 单测：工具注册表——业务代码长在 B 阶段地基上的第一个样板。
// 覆盖：注册序 = 旧 toolDefinitions 数组序（请求体字节等价的生命线）、
// 请求数组逐字节等价、echo 插件注册可见/dispose 消失、同名冲突 fail-loud、
// tool_search 激活语义不变、ToolExec 簿记线程、魔法名兜底。
// D3 断言变更：agent 工具迁 plugins/subagent.ts（注册表序不再镜像广告序——
// 广告走 this.tools 数组，字节等价由 mock 场景锚定；这里改比集合 + 按名映射）。
// 运行：npm run cordis（tsc && node --test "dist/cordis-tests/*.test.js"）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { Context } from '../cordis/context.js'
import {
  ToolsService, getActiveToolDefinitions, getDeferredToolNames,
  resetActivatedTools, activateTools, isActivated, type ToolDefinition,
} from '../services/tools.js'
import { toolDefinitions } from '../tools.js'
import { coreFsTools } from '../plugins/core-fs-tools.js'
import { coreExecTools } from '../plugins/core-exec-tools.js'
import { coreMetaTools } from '../plugins/core-meta-tools.js'
import { subagentPlugin } from '../plugins/subagent.js'
import { AgentRegistry } from '../services/agents.js'
import { UiService } from '../services/ui-service.js'

function buildTree(): { ctx: Context; tools: ToolsService } {
  const ctx = new Context()
  const tools = new ToolsService(ctx, 'tools')
  new UiService(ctx, 'ui') // subagent 插件 apply 时 require（E1：树的保底公民）
  new AgentRegistry(ctx, 'agents')
  ctx.plugin(coreFsTools)
  ctx.plugin(coreExecTools)
  ctx.plugin(coreMetaTools)
  // D3：agent 工具的真身在 subagent 插件（加载序在末尾——注册表按名查，
  // 广告序不依赖它）
  ctx.plugin(subagentPlugin, {
    bridge: { parentMode: () => 'default', addTokens: () => {} },
  })
  return { ctx, tools }
}

test('注册表覆盖旧 toolDefinitions 全集（12 个工具一个不差；D3 起比集合不比序）', () => {
  resetActivatedTools()
  const { tools } = buildTree()
  assert.deepEqual(
    [...tools.list().map((d) => d.name)].sort(),
    [...toolDefinitions.map((t) => t.name)].sort(),
  )
})

test('注册表重组出的请求 tools 条目与旧路径逐项一致（激活前后两种状态；按名映射比）', () => {
  resetActivatedTools()
  const { tools } = buildTree()
  const asMap = (rows: Array<{ name: string; description?: string; input_schema?: unknown }>) =>
    Object.fromEntries(rows.map((r) => [r.name, { name: r.name, description: r.description ?? '', input_schema: r.input_schema }]))
  const activeView = () => asMap(tools
    .list()
    .filter((d) => !d.deferred || isActivated(d.name))
    .map((d) => ({ name: d.name, description: d.description, input_schema: d.parameters })))
  // 未激活：两条路径都只有非 deferred 的 10 个
  assert.deepEqual(activeView(), asMap(getActiveToolDefinitions()))
  // 激活一个 deferred 后：两条路径同步多出它
  activateTools(['enter_plan_mode'])
  assert.deepEqual(activeView(), asMap(getActiveToolDefinitions()))
  resetActivatedTools()
})

test('echo 插件：注册即可被 get，dispose 后从注册表消失', () => {
  resetActivatedTools()
  const { tools } = buildTree()
  const echo: ToolDefinition = {
    name: 'echo',
    description: 'echo back',
    parameters: { type: 'object', properties: {} },
    execute: (input) => String(input.text ?? ''),
  }
  const dispose = tools.register(echo)
  assert.equal(tools.get('echo')?.execute({ text: 'hi' }, {}), 'hi')
  dispose()
  assert.equal(tools.get('echo'), undefined)
})

test('同名工具重复注册 fail-loud（服务表冲突语义在注册表层的同款）', () => {
  resetActivatedTools()
  const { tools } = buildTree()
  const mk = (): ToolDefinition => ({
    name: 'dup', description: '', parameters: { type: 'object' }, execute: () => '',
  })
  tools.register(mk())
  assert.throws(() => tools.register(mk()), /tool "dup" has been registered already/)
})

test('tool_search：命中即激活 deferred 工具，名单与请求数组随之变化（语义与迁移前一致）', () => {
  resetActivatedTools()
  const { tools } = buildTree()
  assert.ok(getDeferredToolNames().includes('enter_plan_mode'))
  const def = tools.get('tool_search')!
  const out = def.execute({ query: 'plan' }, {}) as string
  assert.ok(out.includes('enter_plan_mode'))
  assert.ok(!getDeferredToolNames().includes('enter_plan_mode')) // 激活后从名单消失
  const active = getActiveToolDefinitions().map((t) => t.name)
  assert.ok(active.includes('enter_plan_mode')) // 激活后进请求数组
  resetActivatedTools()
})

test('read_file 经注册表执行，ToolExec.readFileState 簿记照常线程', () => {
  resetActivatedTools()
  const dir = mkdtempSync(join(tmpdir(), 'c1-tools-'))
  try {
    const file = join(dir, 'note.txt')
    writeFileSync(file, 'alpha\nbeta')
    const { tools } = buildTree()
    const state = new Map<string, number>()
    const out = tools.get('read_file')!.execute({ file_path: file }, { readFileState: state }) as string
    assert.ok(out.includes('alpha'))
    assert.equal(state.size, 1) // 簿记已写入（read-before-edit 的依据）
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('魔法名工具的注册表兜底：执行被 agent 循环拦截，真跑到这里会自报路由异常（D3：agent 除外——它有真身）', async () => {
  resetActivatedTools()
  const { tools } = buildTree()
  for (const name of ['enter_plan_mode', 'exit_plan_mode', 'skill']) {
    const out = await tools.get(name)!.execute({}, {})
    assert.match(out, /routed by the agent loop/)
  }
  // agent 自 D3 起由 subagent 插件注册真 execute（不再是兜底占位）
  const agentDef = tools.get('agent')!
  assert.equal(agentDef.deferred, undefined)
  assert.doesNotMatch(String(agentDef.execute).slice(0, 200), /routed by the agent loop/)
})
