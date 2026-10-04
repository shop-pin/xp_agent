// B5 单测：子上下文与作用域。
// 覆盖：createScope 形态（匿名 fiber + 标签 + 父链服务继承）、scope 内注册随
// dispose 全回滚且不影响父、双 scope 同名不同实现互不可见、scope 遮蔽 global、
// 嵌套 scope 链 nearest wins、同层冲突/跨层遮蔽的区分、服务表语义不放宽。
// 运行：npm run cordis（tsc && node --test "dist/cordis-tests/*.test.js"）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '../cordis/context.js'
import { createScope, scopeOf, scopeChainOf, ScopeLayers } from '../cordis/scope.js'

declare module '../cordis/events.js' {
  interface Events {
    'demo/text'(s: string): void
  }
}

test('createScope 形态：子上下文继承父链服务，标签沿 scope ctx 可读', () => {
  const root = new Context()
  root.provide('base', 'root-value')
  const key = { id: 'agent-a' }
  const scope = createScope(root, key)
  assert.equal(scopeOf(scope.ctx), key)
  assert.equal(scopeOf(root), undefined)
  assert.equal(scope.ctx.require<string>('base'), 'root-value') // 原型继承：父链服务穿透
})

test('scope 内注册随 dispose 全回滚：注册表条目与事件监听器一起消失', async () => {
  const root = new Context()
  const registry = new ScopeLayers<string>()
  const scope = createScope(root, { id: 'a' })
  registry.register(scope.ctx, 'tool/a', 'a-impl') // 归属 scope 层
  const seen: string[] = []
  scope.ctx.on('demo/text', s => { seen.push(s) }) // 归属 scope fiber（B4 effect）
  assert.equal(registry.get(scope.key, 'tool/a'), 'a-impl')
  root.emit('demo/text', 'live')
  assert.deepEqual(seen, ['live'])
  await scope.dispose()
  assert.equal(registry.get(scope.key, 'tool/a'), undefined)
  root.emit('demo/text', 'after')
  assert.deepEqual(seen, ['live']) // 监听器已随 scope 摘除
})

test('scope dispose 不影响父层：global 条目与 root 监听器原样健在', async () => {
  const root = new Context()
  const registry = new ScopeLayers<string>()
  registry.register(root, 'tool/base', 'base-impl') // root ctx 无标签 → global 层
  const seen: string[] = []
  root.on('demo/text', s => { seen.push(`root:${s}`) })
  const scope = createScope(root, { id: 'a' })
  await scope.dispose()
  assert.equal(registry.get(undefined, 'tool/base'), 'base-impl')
  root.emit('demo/text', 'x')
  assert.deepEqual(seen, ['root:x'])
})

test('双 scope 同名不同实现：互不可见，root 视图两者都看不见', () => {
  const root = new Context()
  const registry = new ScopeLayers<string>()
  const a = createScope(root, { id: 'a' })
  const b = createScope(root, { id: 'b' })
  registry.register(a.ctx, 'shell', 'shell-A')
  registry.register(b.ctx, 'shell', 'shell-B') // 跨层同名不冲突——隔离就发生在这里
  assert.equal(registry.get(a.key, 'shell'), 'shell-A')
  assert.equal(registry.get(b.key, 'shell'), 'shell-B')
  assert.equal(registry.get(undefined, 'shell'), undefined)
})

test('scope 遮蔽 global：scope 视图里 scope 版胜，root 视图仍是 global 版', () => {
  const root = new Context()
  const registry = new ScopeLayers<string>()
  registry.register(root, 'shell', 'global-shell')
  const scope = createScope(root, { id: 'a' })
  registry.register(scope.ctx, 'shell', 'scoped-shell') // 同名落在 scope 层 = 遮蔽
  assert.equal(registry.get(scope.key, 'shell'), 'scoped-shell')
  assert.equal(registry.get(undefined, 'shell'), 'global-shell')
})

test('嵌套 scope：解析沿 key 链 nearest wins（child > parent > global）', () => {
  const root = new Context()
  const registry = new ScopeLayers<string>()
  const kP = { id: 'parent-scope' }
  const kC = { id: 'child-scope' }
  const parent = createScope(root, kP)
  const child = createScope(parent.ctx, kC, { parent: kP })
  registry.register(root, 'tool', 'G')
  registry.register(parent.ctx, 'tool', 'P')
  registry.register(child.ctx, 'tool', 'C')
  assert.equal(registry.get(undefined, 'tool'), 'G')
  assert.equal(registry.get(kP, 'tool'), 'P')
  assert.equal(registry.get(kC, 'tool'), 'C')
  assert.deepEqual(scopeChainOf(kC), [kC, kP]) // key 链：nearest-first
})

test('同层同名冲突抛错，且错误信息区分 global 与 scope 层', () => {
  const root = new Context()
  const registry = new ScopeLayers<string>()
  assert.throws(() => {
    registry.register(root, 'dup', '1')
    registry.register(root, 'dup', '2')
  }, /registered globally already/)
  const scope = createScope(root, { id: 'a' })
  assert.throws(() => {
    registry.register(scope.ctx, 'dup', '1')
    registry.register(scope.ctx, 'dup', '2')
  }, /registered in this scope already/)
})

test('服务表语义不放宽：scope 内 provide 与 root 同名服务 → 冲突抛错', () => {
  const root = new Context()
  root.provide('base', 1)
  const scope = createScope(root, { id: 'a' })
  // 隔离不在服务表：共享表 + 同名冲突（B2 语义）在 scope 下原样成立
  assert.throws(() => scope.ctx.provide('base', 2), /has been registered already/)
  assert.equal(scope.ctx.require<number>('base'), 1)
})

test('dispose 幂等：重复调用安全，回滚结果稳定', async () => {
  const root = new Context()
  const registry = new ScopeLayers<string>()
  const scope = createScope(root, { id: 'a' })
  registry.register(scope.ctx, 'tool/a', 'a-impl')
  const p1 = scope.dispose()
  const p2 = scope.dispose()
  await p1
  await p2
  assert.equal(registry.get(scope.key, 'tool/a'), undefined)
  assert.equal(registry.get(scope.key, 'tool/a'), undefined) // 再查仍空，不复活
})
