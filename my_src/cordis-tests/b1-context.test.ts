// B1 单测：服务容器 Context 与 Service 基类。
// 运行：npm run cordis（tsc && node --test dist/cordis-tests/）
// 这些"玩具插件"同时是类型断言：declaration merging 失效时 tsc 直接编不过。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '../cordis/context.js'
import { Service } from '../cordis/service.js'

// ---------- 玩具插件（B2 之前，插件就是普通函数/类） ----------

export class GreeterService extends Service {
  constructor(ctx: Context, private greeting: string = 'hello') {
    super(ctx, 'greeter')
  }
  greet(name: string): string {
    return `${this.greeting}, ${name}`
  }
}
declare module '../cordis/context.js' {
  interface Context {
    greeter: GreeterService
  }
}

export class CounterService extends Service {
  private n = 0
  constructor(ctx: Context) {
    super(ctx, 'counter')
  }
  next(): number {
    return ++this.n
  }
}
declare module '../cordis/context.js' {
  interface Context {
    counter: CounterService
  }
}

// ---------- 测试 ----------

test('ctx.<name> 读取已提供服务，方法 this 正常', () => {
  const ctx = new Context()
  const greeter = new GreeterService(ctx)
  assert.equal(ctx.greeter, greeter)
  assert.equal(ctx.greeter.greet('world'), 'hello, world')
})

test('声明合并生效：ctx.greeter 有完整类型（编译期断言）', () => {
  const ctx = new Context()
  new GreeterService(ctx)
  const s: string = ctx.greeter.greet('merge')
  assert.equal(s, 'hello, merge')
})

test('读取未提供服务 → 抛错，错误信息含服务名', () => {
  const ctx = new Context()
  assert.throws(
    () => (ctx as unknown as Record<string, unknown>).missing,
    /service "missing" is not provided/,
  )
})

test('ctx.get 可空读取；ctx.require 严格读取', () => {
  const ctx = new Context()
  const greeter = new GreeterService(ctx)
  assert.equal(ctx.get('greeter'), greeter)
  assert.equal(ctx.get('nope'), undefined)
  assert.equal(ctx.require('greeter'), greeter)
  assert.throws(() => ctx.require('nope'), /"nope" is not provided/)
})

test('ctx.has 报告可解析性（含父链）', () => {
  const parent = new Context()
  new GreeterService(parent)
  const child = new Context(parent)
  assert.equal(parent.has('greeter'), true)
  assert.equal(child.has('greeter'), true)
  assert.equal(child.has('counter'), false)
})

test('子上下文继承父服务（同一实例）', () => {
  const parent = new Context()
  const counter = new CounterService(parent)
  const child = new Context(parent)
  assert.equal(child.counter, counter)
  assert.equal(child.counter.next(), 1)
  assert.equal(parent.counter.next(), 2) // 状态共享：就是同一个实例
})

test('B2 语义修正：共享服务表，子层同名 provide 是冲突抛错（隔离要等 isolate）', () => {
  const parent = new Context()
  new CounterService(parent)
  const child = new Context(parent)
  assert.equal(child.counter, parent.counter) // 同一张表：父子看到同一实例
  assert.throws(
    () => new CounterService(child),
    /service "counter" has been registered already/,
  )
})

test('provide 同名冲突抛错；disposer 释放后可重新提供；disposer 幂等且不误删新值', () => {
  const ctx = new Context()
  const disposeFirst = ctx.provide('x', 'first')
  assert.throws(() => ctx.provide('x', 'second'), /has been registered already/)
  disposeFirst()
  ctx.provide('x', 'second') // 槽位已释放
  disposeFirst() // 二次调用安全，且不得删掉新提供者
  assert.equal(ctx.get('x'), 'second')
})

test('provide 落表触发通知：等待中的插件自动激活（B2 hooks 机制）', () => {
  const ctx = new Context()
  const fiber = ctx.plugin({ inject: ['counter'], apply: () => {} })
  assert.equal(fiber.state, 'pending')
  new CounterService(ctx)
  assert.equal(fiber.state, 'active')
})

test('Context 自有方法优先于服务查找（同名服务换名，已知限制）', () => {
  const ctx = new Context()
  ctx.provide('get', '被方法遮蔽的值')
  assert.equal(typeof ctx.get, 'function')
})

test('thenable 安全：ctx.then 为 undefined，await ctx 不抛错', async () => {
  const ctx = new Context()
  assert.equal((ctx as unknown as Record<string, unknown>).then, undefined)
  assert.equal(await ctx, ctx)
})
