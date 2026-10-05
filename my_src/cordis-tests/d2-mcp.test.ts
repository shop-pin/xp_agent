// D2 单测：publicToolName 规范化（短名零变化/非法字符/超长哈希/确定性）、
// syncTools 两代切换（换代替换/冲突回滚恢复旧代/重复公共名构建期抛错）。
// 真实连接链路由场景 18/19（demo server）背书。
// 运行：npm run cordis（tsc && node --test "dist/cordis-tests/*.test.js"）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '../cordis/context.js'
import { ToolsService } from '../services/tools.js'
import { publicToolName, McpBridge, type McpToolInfo } from '../plugins/mcp-bridge.js'

function raw(serverName: string, name: string): McpToolInfo {
  return { name, description: `tool ${name}`, inputSchema: { type: 'object', properties: {} }, serverName }
}

test('publicToolName：短净名零变化（广告字节等价的锚）', () => {
  assert.equal(publicToolName('demo', 'add'), 'mcp__demo__add')
  assert.equal(publicToolName('demo2', 'search_files'), 'mcp__demo2__search_files')
})

test('publicToolName：非法字符规范化 + 超长截断都缀 12 位哈希（确定性、可区分）', () => {
  const dirty = publicToolName('srv', 'a b/c')
  assert.ok(dirty.startsWith('mcp__srv__a_b_c_'), dirty)
  // 短而脏：前缀全保 + _ + 12 位哈希（只有截断才顶满 64）
  assert.equal(dirty.length, 'mcp__srv__a_b_c'.length + 1 + 12)
  assert.match(dirty.slice(-13), /_[0-9a-f]{12}$/)

  const long = publicToolName('srv', 'x'.repeat(100))
  assert.equal(long.length, 64)
  assert.match(long, /_[0-9a-f]{12}$/)

  // 确定性 + 可区分：同名同输入同哈希；不同输入不同哈希
  assert.equal(publicToolName('srv', 'a b/c'), dirty)
  assert.notEqual(publicToolName('srv', 'a b/d'), dirty)
  // 两个同截断前缀的长名靠哈希区分
  const l1 = publicToolName('srv', 'x'.repeat(100))
  const l2 = publicToolName('srv', 'x'.repeat(99) + 'y')
  assert.notEqual(l1, l2)
})

test('syncTools：注册进注册表；换代替换（旧代名消失）；广告清单一致', () => {
  const ctx = new Context()
  const tools = new ToolsService(ctx, 'tools')
  const bridge = new McpBridge(ctx, 'mcp')
  bridge.syncTools([raw('demo', 'add'), raw('demo', 'mul')])
  assert.deepEqual(tools.list().map((d) => d.name), ['mcp__demo__add', 'mcp__demo__mul'])
  assert.deepEqual(
    bridge.listToolDefinitions().map((t) => t.name),
    ['mcp__demo__add', 'mcp__demo__mul'],
  )

  bridge.syncTools([raw('demo', 'add'), raw('demo2', 'echo')])
  assert.deepEqual(tools.list().map((d) => d.name), ['mcp__demo__add', 'mcp__demo2__echo'])
})

test('syncTools：构建期重复公共名抛错且不动注册表', () => {
  const ctx = new Context()
  const tools = new ToolsService(ctx, 'tools')
  const bridge = new McpBridge(ctx, 'mcp')
  bridge.syncTools([raw('demo', 'add')])
  // 同 server 同名工具两次出现 → 构建期即炸，旧代原样
  assert.throws(() => bridge.syncTools([raw('demo', 'add'), raw('demo', 'add')]), /duplicate public tool name/)
  assert.deepEqual(tools.list().map((d) => d.name), ['mcp__demo__add'])
})

test('syncTools：外部 squat 冲突 → 新代回滚、旧代恢复（不重复不丢失）', () => {
  const ctx = new Context()
  const tools = new ToolsService(ctx, 'tools')
  const bridge = new McpBridge(ctx, 'mcp')
  bridge.syncTools([raw('demo', 'add')])
  // 外部注册占住了 mcp__demo__mul（squat 本命名空间）
  tools.register({
    name: 'mcp__demo__mul',
    description: 'squatter',
    parameters: { type: 'object', properties: {} },
    execute: () => 'squatted',
  })
  // 新代含 mul → 换代冲突 → 回滚：旧代 add 恢复（恰一个），新代全部缺席
  bridge.syncTools([raw('demo', 'add'), raw('demo', 'mul')])
  const names = tools.list().map((d) => d.name)
  assert.equal(names.filter((n) => n === 'mcp__demo__add').length, 1)
  assert.ok(names.includes('mcp__demo__mul')) // squatter 仍在（它是外部注册，不归我们撤）
  assert.equal(names.length, 2) // 没有新代残留
})

test('disabled bridge：ensure 是 no-op（不读配置不连接）', async () => {
  const ctx = new Context()
  new ToolsService(ctx, 'tools')
  const bridge = new McpBridge(ctx, 'mcp')
  bridge.disable()
  await bridge.ensure()
  assert.deepEqual(bridge.listToolDefinitions(), [])
})
